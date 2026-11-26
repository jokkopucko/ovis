/**
 * The PC's direct carriers (`ws://<private or Tailscale IPv4>:<port>/v1/ws?v=1`, docs/relay.md "Direct on
 * the same network") through the phone apps' OvisDirect plugin (app/ios/App/App/OvisDirectPlugin.swift,
 * app/android/app/src/main/java/sh/ovis/app/OvisDirectPlugin.java): a page on https cannot open plain
 * `ws://`. Frames cross the bridge in an envelope `{ id, kind, data }`, a binary one as base64, so text
 * and binary stay apart; the plugin delivers them in order and keeps at most 4 MiB or 16,384 messages
 * this page has not acknowledged (the transport's own send queue), closing the socket with 1009 beyond that.
 */
import { arrayBufferToBase64, base64ToArrayBuffer } from "../../../shared/vendor/paseo-e2ee/base64.ts";
import type { RelaySocket } from "../../../shared/relay-channel.ts";
import { isDirectCarrier } from "../../../shared/relay-mux.ts";
import { appShell, type AppShell } from "../appShell.ts";
import { hasNativePlugin } from "../nativeApp.ts";

export const DIRECT_PLUGIN = "OvisDirect";
/** The hosted shell's origin: the plugin answers only a main-frame page of it, or of the app's own copy. */
export const APP_ORIGIN = "https://app.ovis.sh";

/**
 * Whether this page asks the plugin at all: the hosted shell at APP_ORIGIN, or the app's own copy of the client at
 * whatever origin its platform gives it (`capacitor://` on iOS). The plugin's own gate, which answers only the app's
 * main frame, is the one that holds; this only spares a page it would refuse.
 */
export function directPageAllowed(origin: string, app: AppShell | null): boolean {
  return app !== null || origin === APP_ORIGIN;
}

/** Whether `url` is the one address the plugin opens: a direct carrier's `/v1/ws?v=1`, nothing more. */
export function isDirectSocketUrl(url: string): boolean {
  const match = /^(ws:\/\/[^/?#]+)\/v1\/ws\?v=1$/.exec(url);
  return match !== null && isDirectCarrier(match[1]!);
}

export type DirectFrame = { readonly kind: "text"; readonly data: string } | { readonly kind: "binary"; readonly data: string };
export type DirectEvent =
  | { readonly type: "message"; readonly id: string; readonly kind: "text" | "binary"; readonly data: string }
  | { readonly type: "close"; readonly id: string; readonly code: number; readonly reason: string }
  | { readonly type: "error"; readonly id: string };

export interface DirectBridge {
  open(url: string): Promise<string>;
  send(id: string, frame: DirectFrame): Promise<void>;
  close(id: string, code?: number, reason?: string): Promise<void>;
  ack(id: string, messages: number): Promise<void>;
  listen(handler: (event: DirectEvent) => void): void;
}

interface CapacitorEvents {
  nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
  addListener?: (plugin: string, event: string, callback: (data: unknown) => void) => unknown;
}

function parseEvent(type: DirectEvent["type"], data: unknown): DirectEvent | null {
  if (typeof data !== "object" || data === null) return null;
  const value = data as Record<string, unknown>;
  if (typeof value.id !== "string") return null;
  switch (type) {
    case "message":
      return (value.kind === "text" || value.kind === "binary") && typeof value.data === "string" ? { type, id: value.id, kind: value.kind, data: value.data } : null;
    case "close":
      return { type, id: value.id, code: typeof value.code === "number" ? value.code : 1006, reason: typeof value.reason === "string" ? value.reason : "" };
    case "error":
      return { type, id: value.id };
  }
}

/** The app's bridge to OvisDirect, through `window.Capacitor` as the app injects it. */
export function capacitorDirectBridge(): DirectBridge | undefined {
  const cap = (globalThis as { Capacitor?: CapacitorEvents }).Capacitor;
  const call = cap?.nativePromise;
  const addListener = cap?.addListener;
  if (!call || !addListener) return undefined;
  return {
    open: async (url) => {
      const answer = await call(DIRECT_PLUGIN, "open", { url }) as { id?: unknown } | null;
      if (typeof answer?.id !== "string") throw new Error("OvisDirect opened no socket");
      return answer.id;
    },
    send: async (id, frame) => { await call(DIRECT_PLUGIN, "send", { id, kind: frame.kind, data: frame.data }); },
    close: async (id, code, reason) => { await call(DIRECT_PLUGIN, "close", { id, ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) }); },
    ack: async (id, messages) => { await call(DIRECT_PLUGIN, "ack", { id, messages }); },
    listen: (handler) => {
      for (const type of ["message", "close", "error"] as const) {
        addListener(DIRECT_PLUGIN, type, (data) => { const event = parseEvent(type, data); if (event) handler(event); });
      }
    },
  };
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
/** At most this much waits here for the plugin to name a socket, as the plugin's own queues: beyond it the socket closes with 1009. */
export const EARLY_SEND_BYTES = 4 * 1024 * 1024;
export const EARLY_SEND_MESSAGES = 16_384;
const encoder = new TextEncoder();

class DirectSocket implements RelaySocket {
  binaryType: BinaryType = "arraybuffer";
  readyState = CONNECTING;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  id: string | undefined;
  private early: DirectFrame[] = [];
  private earlyBytes = 0;
  private closeAsked: { code?: number; reason?: string } | undefined;
  private unacked = 0;

  /** `unqueue` takes it out of the factory's wait for a place, true when it was still waiting there. */
  constructor(private readonly bridge: DirectBridge, private readonly unqueue: () => boolean) {}

  opened(id: string): void {
    this.id = id;
    if (this.readyState === CONNECTING) this.readyState = OPEN;
    for (const frame of this.early) this.forward(frame);
    this.early = [];
    if (this.closeAsked) this.closeNative(this.closeAsked.code, this.closeAsked.reason);
  }

  /** The plugin refused to open it (not the app's page, not a direct carrier, two already open): it fails as a socket that never connected. */
  refused(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.early = [];
    this.onerror?.(new Event("error"));
    this.onclose?.(new CloseEvent("close", { code: 1006, reason: "", wasClean: false }));
  }

  send(data: string | ArrayBuffer): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    const frame: DirectFrame = typeof data === "string" ? { kind: "text", data } : { kind: "binary", data: arrayBufferToBase64(data) };
    if (this.id !== undefined) { this.forward(frame); return; }
    this.earlyBytes += typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
    if (this.early.length + 1 > EARLY_SEND_MESSAGES || this.earlyBytes > EARLY_SEND_BYTES) {
      this.early = [];
      this.readyState = CLOSED;
      this.closeAsked = { code: 1009, reason: "send queue full" };
      queueMicrotask(() => this.onclose?.(new CloseEvent("close", { code: 1009, reason: "send queue full", wasClean: false })));
      return;
    }
    this.early.push(frame);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === CLOSING || this.readyState === CLOSED) return;
    // given up while it waited for a place: it ends here, as a WebSocket closed while connecting
    if (this.id === undefined && this.unqueue()) {
      this.readyState = CLOSED;
      this.early = [];
      queueMicrotask(() => this.onclose?.(new CloseEvent("close", { code: 1006, reason: "", wasClean: false })));
      return;
    }
    this.readyState = CLOSING;
    if (this.id === undefined) this.closeAsked = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    else this.closeNative(code, reason);
  }

  event(event: DirectEvent): void {
    switch (event.type) {
      case "message": {
        if (this.readyState === CLOSED) return;
        const data = event.kind === "text" ? event.data : base64ToArrayBuffer(event.data);
        if (this.unacked++ === 0) queueMicrotask(() => this.flushAck());
        this.onmessage?.(new MessageEvent("message", { data }));
        return;
      }
      case "error":
        if (this.readyState !== CLOSED) this.onerror?.(new Event("error"));
        return;
      case "close":
        if (this.readyState === CLOSED) return;
        this.readyState = CLOSED;
        this.onclose?.(new CloseEvent("close", { code: event.code, reason: event.reason, wasClean: event.code !== 1006 }));
        return;
    }
  }

  private flushAck(): void {
    const messages = this.unacked;
    this.unacked = 0;
    if (messages === 0 || this.id === undefined || this.readyState === CLOSED) return;
    this.bridge.ack(this.id, messages).catch((error: unknown) => console.warn("Ovis: the direct socket's acknowledgement failed", error));
  }

  private forward(frame: DirectFrame): void {
    const id = this.id!;
    this.bridge.send(id, frame).catch((error: unknown) => console.warn("Ovis: a direct socket send failed", error));
  }

  private closeNative(code?: number, reason?: string): void {
    this.bridge.close(this.id!, code, reason).catch((error: unknown) => console.warn("Ovis: a direct socket did not close", error));
  }
}

/** The plugin's refusal while it holds as many sockets as it opens (OvisDirectPlugin `too_many`). */
const isTooMany = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "too_many";

/**
 * A RelaySocket factory over `bridge`: it throws for an address that is not a direct carrier's, before
 * the plugin hears of it. The plugin counts a socket until it reports its close (iOS until the close is done, up to
 * 5 s), whoever asked for it: a race, a probe or a sweep. So a socket it refuses `too_many` waits here, still
 * connecting, and is asked for again once the plugin reports a close, unless `waitForPlace` is false (a background
 * sweep, which must not take a place ahead of a connection the user waits for). It is asked for at once when a close
 * came while the refused ask was on its way.
 */
export function directSocketFactory(bridge: DirectBridge): (url: string, waitForPlace?: boolean) => RelaySocket {
  const sockets = new Map<string, DirectSocket>();
  const waiting = new Map<string, DirectEvent[]>();
  const refused: { readonly socket: DirectSocket; readonly url: string }[] = [];
  let opening = 0;
  let closes = 0;
  const closed = (id: string): void => {
    sockets.delete(id);
    closes++;
    for (let next = refused.shift(); next; next = refused.shift()) {
      if (next.socket.readyState !== CONNECTING) continue;
      start(next.socket, next.url, true);
      return;
    }
  };
  const deliver = (socket: DirectSocket, id: string, event: DirectEvent): void => {
    try { socket.event(event); } finally { if (event.type === "close") closed(id); }
  };
  bridge.listen((event) => {
    const socket = sockets.get(event.id);
    if (socket) {
      deliver(socket, event.id, event);
      return;
    }
    if (opening > 0) waiting.set(event.id, [...(waiting.get(event.id) ?? []), event]);
  });
  const start = (socket: DirectSocket, url: string, waitForPlace: boolean): void => {
    opening++;
    const closesBefore = closes;
    bridge.open(url).then((id) => {
      opening--;
      const early = waiting.get(id) ?? [];
      waiting.delete(id);
      if (opening === 0) waiting.clear();
      sockets.set(id, socket);
      socket.opened(id);
      for (const event of early) deliver(socket, id, event);
    }, (error: unknown) => {
      opening--;
      if (opening === 0) waiting.clear();
      if (waitForPlace && isTooMany(error) && socket.readyState === CONNECTING) {
        if (closes !== closesBefore) start(socket, url, true);
        else refused.push({ socket, url });
        return;
      }
      socket.refused();
    });
  };
  return (url, waitForPlace = true) => {
    if (!isDirectSocketUrl(url)) throw new TypeError("Not a direct carrier's address");
    const socket: DirectSocket = new DirectSocket(bridge, () => {
      const at = refused.findIndex((entry) => entry.socket === socket);
      if (at < 0) return false;
      refused.splice(at, 1);
      return true;
    });
    start(socket, url, waitForPlace);
    return socket;
  };
}

let shared: ((url: string, waitForPlace?: boolean) => RelaySocket) | undefined;
let tailnet: (() => boolean) | undefined;

/**
 * Whether the plugin behind `call` also opens a carrier on the PC's Tailscale address (100.64.0.0/10): false
 * until its `features` answers `tailnet: true`, so nobody waits on it. Asked once; an app built before that
 * has no `features` and may never answer, which leaves it false.
 */
export function directTailnetSupport(call: (plugin: string, method: string) => Promise<unknown>): () => boolean {
  let supported = false;
  call(DIRECT_PLUGIN, "features").then(
    (answer) => { supported = (answer as { tailnet?: unknown } | null)?.tailnet === true; },
    () => {},
  );
  return () => supported;
}

export function nativeDirectTailnet(): () => boolean {
  const call = (globalThis as { Capacitor?: CapacitorEvents }).Capacitor?.nativePromise;
  if (!call) return () => false;
  tailnet ??= directTailnetSupport(call);
  return tailnet;
}

/**
 * The direct socket factory for the relay transport, or undefined where the PC is reached through
 * the relay only: a browser, an app built before the plugin, or a page that is not the hosted
 * shell's (the plugin refuses those).
 */
export function nativeDirectSocket(): ((url: string, waitForPlace?: boolean) => RelaySocket) | undefined {
  if (typeof window === "undefined" || !directPageAllowed(window.location.origin, appShell()) || !hasNativePlugin(DIRECT_PLUGIN)) return undefined;
  if (shared) return shared;
  const bridge = capacitorDirectBridge();
  if (!bridge) return undefined;
  shared = directSocketFactory(bridge);
  return shared;
}
