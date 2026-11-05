import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";
import {
  exportPublicKey, generateKeyPair, openClientSecureChannel, openDaemonSecureChannel,
} from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import { MuxEngine } from "../../shared/relay-mux-engine.ts";
import type { HttpRequest, MuxClock, SessionFrame } from "../../shared/relay-mux-engine.ts";
import { decodeFrame, FrameType } from "../../shared/relay-mux.ts";
import type { MuxFrame, SessionError } from "../../shared/relay-mux.ts";
import { createServer } from "../index.ts";
import { RelaySession, relayClock } from "./session.ts";
import type { RelaySessionOptions } from "./session.ts";

export function deferred<T>() {
  let resolve = (_value: T): void => { throw new Error("Uninitialized barrier"); };
  let reject = (_error: unknown): void => { throw new Error("Uninitialized barrier"); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Event barriers fail boundedly; no sleeps or polling of mutable state. */
export async function bounded<T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> {
  const failure = deferred<T>();
  const timer = setTimeout(() => failure.reject(new Error("Relay test event timed out")), milliseconds);
  try { return await Promise.race([promise, failure.promise]); }
  finally { clearTimeout(timer); }
}

export class TestClock implements MuxClock {
  private time = 0;
  private next = 0;
  readonly tasks = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): () => void {
    const id = ++this.next;
    this.tasks.set(id, { at: this.time + ms, callback });
    return () => { this.tasks.delete(id); };
  }
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = [...this.tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.tasks.delete(next[0]);
      this.time = next[1].at;
      next[1].callback();
    }
    this.time = target;
  }
}

class DuplexTransport implements Transport {
  onmessage: Transport["onmessage"] = null;
  onclose: Transport["onclose"] = null;
  onerror: Transport["onerror"] = null;
  peer: DuplexTransport | undefined;
  closed = false;
  pendingBytes = 0;
  observe = () => {};
  async send(data: string | ArrayBuffer): Promise<void> {
    if (this.closed || !this.peer) throw new Error("Closed test transport");
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    this.pendingBytes += bytes;
    this.observe();
    try { this.peer.onmessage?.({ data, isBinary: typeof data !== "string" }); }
    finally { this.pendingBytes -= bytes; }
  }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.(code, reason);
    this.peer?.close(code, reason);
  }
}

export function relayFixture(serveOnly = false, options: NonNullable<Parameters<typeof createServer>[0]> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-session-"));
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, tailscaleServeOnly: serveOnly, ...options });
  const closes: (() => void)[] = [];
  return {
    stateDir, app, closes,
    close() {
      for (const close of closes) close();
      app.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

export async function relayDevice(fixture: ReturnType<typeof relayFixture>, role: "drive" | "watch" = "drive") {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const store = fixture.app.context.services.devices;
  const paired = store.pairRelay(store.startPairing().code, "Relay test", publicKey);
  if (!paired) throw new Error("Pairing failed");
  if (role === "watch") store.update(paired.device.id, { role });
  return { keys, publicKey, id: paired.device.id };
}

export async function relayConnection(fixture: ReturnType<typeof relayFixture>,
  options: Partial<Omit<RelaySessionOptions, "channel" | "services">> = {}) {
  const clientTransport = new DuplexTransport();
  const daemonTransport = new DuplexTransport();
  clientTransport.peer = daemonTransport;
  daemonTransport.peer = clientTransport;
  fixture.closes.push(() => clientTransport.close());
  const keys = generateKeyPair();
  let session: RelaySession | undefined;
  let client: MuxEngine | undefined;
  let peakBuffered = 0;
  const observe = () => {
    peakBuffered = Math.max(peakBuffered, (session?.bufferedBytes ?? 0) + (client?.stats.bufferedBytes ?? 0)
      + clientTransport.pendingBytes + daemonTransport.pendingBytes);
  };
  clientTransport.observe = daemonTransport.observe = observe;
  const serverError = deferred<SessionError>();
  const closed = deferred<void>();
  const welcome = deferred<Extract<SessionFrame, { type: typeof FrameType.WELCOME }>>();
  const authenticated = deferred<Extract<SessionFrame, { type: typeof FrameType.AUTH_OK }>>();
  const frames: { type: number; id: number; bytes: number }[] = [];
  let onFrame: ((frame: MuxFrame) => void) | undefined;
  let transform: ((bytes: Uint8Array) => Uint8Array) | undefined;
  const daemonOpening = openDaemonSecureChannel(daemonTransport, {
    daemonKeyPair: keys,
    events: { onmessage: (data) => { session?.receive(data); observe(); } },
  });
  const channel = await openClientSecureChannel(clientTransport, {
    daemonPublicKeyB64: exportPublicKey(keys.publicKey),
    events: {
      onmessage: (data) => {
        if (typeof data === "string") throw new Error("Unexpected plaintext string");
        const bytes = new Uint8Array(data);
        const frame = decodeFrame(bytes);
        frames.push({ type: frame.type, id: frame.stream_id, bytes: bytes.length });
        if (frame.type === FrameType.SESSION_ERROR) serverError.resolve(frame.payload.code);
        onFrame?.(frame);
        client?.receive(bytes);
        observe();
      },
      onclose: () => { client?.carrierLost(); closed.resolve(); },
    },
  });
  const daemon = await daemonOpening;
  session = new RelaySession({
    channel: daemon, services: fixture.app.context.services, port: fixture.app.port,
    serverId: "0123456789abcdef0123456789abcdef", serverVersion: "0.4.20", minSupportedClient: "0.4.20",
    routingOverhead: 0, maxWireMessageBytes: 256 * 1024, ...options,
  });
  client = new MuxEngine({
    role: "client", clock: relayClock, send: (bytes) => channel.send((transform?.(bytes) ?? bytes).slice().buffer),
    close: (code) => channel.close(code), outboundWireByteLength: (bytes) => channel.outboundWireByteLength(bytes.slice().buffer),
    routingOverhead: 0, maxWireMessageBytes: 256 * 1024,
    onSession: (frame) => {
      if (frame.type === FrameType.WELCOME) welcome.resolve(frame);
      if (frame.type === FrameType.AUTH_OK) { client?.authenticate(frame.payload.device_id); authenticated.resolve(frame); }
    },
  });
  const mux = client;
  const beforeClose = <T>(event: Promise<T>): Promise<T> => Promise.race([
    event,
    closed.promise.then(() => { throw new Error("Relay closed before admission"); }),
  ]);
  return {
    session, mux, channel, daemon, frames, serverError: serverError.promise, closed: closed.promise,
    get peakBuffered() { observe(); return peakBuffered; },
    set onFrame(listener: ((frame: MuxFrame) => void) | undefined) { onFrame = listener; },
    set transformClientFrame(change: ((bytes: Uint8Array) => Uint8Array) | undefined) { transform = change; },
    async hello() {
      mux.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0,
        payload: { protocol: "ovis-mux", versions: [1], features: [], required_features: [] } });
      return (await bounded(beforeClose(welcome.promise))).payload;
    },
    async auth(device: Awaited<ReturnType<typeof relayDevice>>) {
      const greeting = await this.hello();
      const signature = Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, device.keys.privateKey,
        Buffer.concat([Buffer.from("ovis-relay-auth/1"), Buffer.from(greeting.nonce, "base64url"),
          Buffer.from(options.serverId ?? "0123456789abcdef0123456789abcdef")]))).toString("base64url");
      mux.sendSession({ type: FrameType.AUTH, flags: 0, stream_id: 0,
        payload: { scheme: "device-key", device_id: device.id, signature } });
      return (await bounded(beforeClose(authenticated.promise))).payload;
    },
    async pair(code: string, publicKey: string) {
      await this.hello();
      mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "New phone", public_key: publicKey } });
      return (await bounded(beforeClose(authenticated.promise))).payload;
    },
    async flush() {
      // Subscribe to idle transitions on both senders, including their receipt replies.
      let budget = 10_000;
      do {
        if (--budget === 0) throw new Error("Relay senders did not quiesce");
        await bounded(Promise.all([mux.flush(), session.mux.flush()]));
      } while (!mux.senderIdle || !session.mux.senderIdle);
    },
    open(target: string, init: Partial<Omit<HttpRequest, "target" | "device_id">> = {}) {
      const stream = mux.openHttp({ target, method: "GET", headers: [], body: "none", ...init });
      const response = deferred<Response>();
      stream.onHeaders = ({ status, headers }) => {
        if (status >= 200) response.resolve(new Response(stream.noBody ? null : stream.body, { status, headers: headers.map(([k, v]) => [k, v]) }));
      };
      stream.onDispose = (error) => { if (error) response.reject(error); };
      return { stream, response: bounded(response.promise) };
    },
    openSocket(target = "/ws") {
      const stream = mux.openWs({ target, headers: [], protocols: [] });
      const opened = deferred<void>();
      const closed = deferred<{ code: number; reason: string; clean: boolean }>();
      const messages: ServerMessage[] = [];
      const listeners = new Set<(message: ServerMessage) => void>();
      stream.onAccept = () => opened.resolve();
      stream.onClose = (event) => { closed.resolve(event); opened.reject(new Error(`Socket closed: ${event.code}`)); };
      stream.onMessage = (raw) => {
        const message: ServerMessage = JSON.parse(String(raw));
        messages.push(message);
        for (const listener of listeners) listener(message);
      };
      return {
        stream, opened: bounded(opened.promise), closed: closed.promise, messages, listeners,
        send(message: ClientMessage) { stream.send(JSON.stringify(message)); },
        async until(check: (message: ServerMessage) => boolean) {
          const previous = messages.find(check);
          if (previous) return previous;
          const found = deferred<ServerMessage>();
          const listener = (message: ServerMessage) => { if (check(message)) found.resolve(message); };
          listeners.add(listener);
          try {
            return await bounded(Promise.race([found.promise, closed.promise.then((event) => {
              throw new Error(`Socket closed before message: ${event.code}`);
            })]));
          } finally { listeners.delete(listener); }
        },
      };
    },
    stop() { clientTransport.close(); },
  };
}
