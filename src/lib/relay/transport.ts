import type { MuxClock, WsStream } from "../../../shared/relay-mux-engine.ts";
import { MuxStreamError } from "../../../shared/relay-mux-engine.ts";
import { LIMITS_V1, REQUEST_HEADERS } from "../../../shared/relay-mux.ts";
import { isTailnetCarrier, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { EventSourceLike, Transport, WebSocketLike } from "../transport.ts";
import { openRelayChannel, RelayNewSessionsRefusedError, RelayPcOfflineError, UnsafeRelayDestinationError } from "./channel.ts";
import { DirectCarrierUnusableError, openRelayChannelWithFallback, probeDirect } from "../../../shared/relay-channel.ts";
import type { RelayChannel, RelayChannelOptions, RelayServerInfo, RelaySocket } from "./channel.ts";
import { indexedDeviceStore, ServerIdentityChangedError } from "./device.ts";
import { relayResourceUrl, serveRelayResources } from "./resources.ts";

export interface RelayTransportOptions extends RelayChannelOptions {
  readonly openChannel?: typeof openRelayChannel;
  readonly clock?: MuxClock;
  /** A reconnect the PC refused for good (`isFatalRelayError`): the transport has closed itself, and the shell shows why. */
  readonly onFatal?: (error: Error) => void;
  /**
   * Opens a socket to one of the PC's direct carriers (`ws://<private IPv4>:<port>`, docs/relay.md "Direct on the
   * same network"): the native apps' plugin, as a page on https cannot. Without it the PC is reached through the
   * relay only.
   */
  readonly directSocket?: (url: string) => RelaySocket;
  /** Whether `directSocket` also opens the PC's Tailscale address (100.64.0.0/10), read at each connect: then the PC names that one too. */
  readonly directTailnet?: () => boolean;
}

/** How long a connection tries the PC's direct carriers. */
export const DIRECT_BUDGET_MS = 1_500;
/** How long the direct carriers have alone before the relay is opened too, and the first channel up is kept (happy eyeballs). */
export const DIRECT_HEAD_START_MS = 300;
/** Direct carriers tried at once: the apps' plugins open at most two sockets (OvisDirectPlugin MAX_SOCKETS). */
export const DIRECT_SOCKETS = 2;
/** A probe of the direct carriers at most this often while the relay carries the channel, unless the network changed. */
const DIRECT_PROBE_EVERY_MS = 5 * 60_000;
/** A switch to a direct carrier waits for no request to be under way, checking this often, this many times. */
const DIRECT_IDLE_CHECK_MS = 5_000;
const DIRECT_IDLE_CHECKS = 12;
/** A switch also waits until no WebSocket sent anything for this long: someone may be typing into a terminal. */
const SOCKET_QUIET_MS = 3_000;


function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** `inner`, telling `closed` once its close event came, before whoever listens to it. */
function untilClosed(inner: RelaySocket, closed: () => void): RelaySocket {
  let listener: RelaySocket["onclose"] = null;
  inner.onclose = (event) => { closed(); listener?.(event); };
  return {
    get binaryType() { return inner.binaryType; }, set binaryType(value) { inner.binaryType = value; },
    get readyState() { return inner.readyState; },
    send: (data) => inner.send(data), close: (code, reason) => inner.close(code, reason),
    get onmessage() { return inner.onmessage; }, set onmessage(value) { inner.onmessage = value; },
    get onclose() { return listener; }, set onclose(value) { listener = value; },
    get onerror() { return inner.onerror; }, set onerror(value) { inner.onerror = value; },
  };
}

/** Whether another attempt could only fail the same way: the device was revoked or never paired, the PC's identity or protocol changed, or the offer is unsafe. */
export function isFatalRelayError(error: unknown): error is Error {
  if (error instanceof ServerIdentityChangedError || error instanceof UnsafeRelayDestinationError) return true;
  // the relay takes no new device for this PC while its account is past its limits: only a later try can differ
  if (error instanceof RelayNewSessionsRefusedError) return true;
  return error instanceof MuxProtocolError && (error.code === "auth_revoked" || error.code === "auth_failed"
    || error.code === "unsupported_version" || error.code === "unsupported_extension" || error.code === "unsupported_transport");
}

const clock: MuxClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

const HTTP_QUEUE_LIMIT = 64;
const HTTP_QUEUE_TIMEOUT_MS = 30_000;
/** The mux queues at most 4 MiB of outgoing payload across streams: a socket holds no more than that waiting to reach it. */
const WS_SEND_QUEUE_LIMIT = 4 * 1024 * 1024;

/** Messages a socket holds waiting for the mux, however small: each holds a copy and a callback. */
const WS_SEND_QUEUE_MESSAGES = 16_384;

/** UTF-8 length counted without encoding, so an oversized string is refused before it is copied. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 4; index++; }
    else bytes += 3; // a lone surrogate encodes as U+FFFD
  }
  return bytes;
}

/** A body's size, or for a form the least its encoding can take, when it is known without reading it. */
function knownSize(body: BodyInit | null | undefined): number | undefined {
  if (typeof body === "string") return utf8Length(body);
  if (body instanceof Blob) return body.size;
  if (body instanceof FormData) {
    let size = 0;
    for (const [name, value] of body) size += utf8Length(name) + (typeof value === "string" ? utf8Length(value) : value.size);
    return size;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
  return undefined;
}

function tooLarge(): TypeError {
  return new TypeError(`Relay request body is over ${LIMITS_V1.max_request_body_bytes} bytes`);
}

function target(url: string): string {
  const parsed = new URL(url, "https://relay.ovis.invalid");
  return parsed.pathname + parsed.search;
}

function method(value: string): "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" {
  switch (value) {
    case "GET": case "HEAD": case "POST": case "PUT": case "PATCH": case "DELETE": case "OPTIONS": return value;
    default: throw new TypeError(`Unsupported relay method: ${value}`);
  }
}

/** Property handlers occupy the listener position of their first non-null assignment. */
function eventProperties(target: EventTarget, names: readonly string[]): void {
  for (const name of names) {
    let handler: EventListener | null = null;
    const listener = (event: Event): void => { handler?.call(target, event); };
    Object.defineProperty(target, `on${name}`, {
      configurable: true, enumerable: true,
      get: () => handler,
      set: (value: EventListener | null) => {
        if (value === null) target.removeEventListener(name, listener);
        else if (handler === null) target.addEventListener(name, listener);
        handler = value;
      },
    });
  }
}

/**
 * How long a reconnect waits at the relay for a PC that is away, under the relay's own 30 s hold
 * (relay/core.ts OFFLINE_WAIT_MS): with the one-second pause between such waits, a phone opens
 * about two relay sockets a minute while its PC is away, well under the relay's per-address limit.
 */
export const RECONNECT_PC_ANSWER_MS = 25_000;

/** Establish once before boot installs it. A reconnect replaces only the carrier, never streams. */
export async function openRelayTransport(offer: RelayOffer, options: RelayTransportOptions = {}): Promise<RelayTransport> {
  const transport = new RelayTransport(offer, options);
  try { await transport.connect(); return transport; }
  catch (error) { transport.close(); throw error; }
}

export class RelayTransport implements Transport {
  readonly kind = "relay";
  private channel: RelayChannel | undefined;
  private known: RelayServerInfo | undefined;
  private generation = 0;
  /** The relay the latest connection went through: the offer's, or the global one it falls back to. */
  private relay: string;
  private opening: Promise<void> | undefined;
  private stopped = false;
  private delay = 1000;
  private cancelRetry: (() => void) | undefined;
  private readonly abort = new AbortController();
  private readonly waitingHttp = new Set<{ run: () => boolean; fail: (error: unknown) => void }>();
  /** renews waiting for a carrier: each settles on the first one whose attempt started after it was asked */
  private readonly renewing = new Set<{ after: number; up: () => void }>();
  /** the PC's direct carriers its latest AUTH_OK named; read from the saved pairing before the first one */
  private directCarriers: readonly string[] | undefined;
  /** HTTP requests whose stream is open: a switch to a direct carrier waits until there are none */
  private openHttp = 0;
  /** when one of this transport's WebSockets last sent, on its clock */
  private socketSentAt = -Infinity;
  /** a planned switch came back on the relay: the next probe waits this many times longer */
  private probeBackoff = 1;
  /** requests whose body is still being read before they open (Firefox buffers it) */
  private preparingHttp = 0;
  /** a probe or a wait to switch is under way, and when the latest probe began */
  private upgrading = false;
  private probedAt = -Infinity;
  /** a network change came while a probe ran: probe again once it ends */
  private reprobe = false;
  /** the next periodic probe while the relay carries the channel */
  private cancelProbe: (() => void) | undefined;
  /** ends the probe or idle wait under way when its channel goes */
  private upgradeAbort: AbortController | undefined;
  /** the relay channel is being closed to reconnect on a direct carrier, not lost */
  private switching: RelayChannel | undefined;
  /** the next connection follows a probe that proved a direct carrier: it gives the direct carriers their whole budget before the relay */
  private switchingDirect = false;
  private readonly stopResources: () => void;
  private readonly wake = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    // a carrier left closing while nothing used it is ended now, and its onClose reconnects
    if (!this.stopped && this.channel && !this.channel.carrierOpen) { this.channel.close(); return; }
    // back on a network: the PC may be on this one now
    if (!this.stopped && this.channel && this.channel.direct === undefined) { this.probedAt = -Infinity; this.reprobe = this.upgrading; this.upgrade(this.channel); }
    if (this.stopped || this.channel || this.opening) return;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    void this.connect().catch((error: unknown) => this.failed(error));
  };
  private readonly aborted = (): void => this.close();

  constructor(private readonly offer: RelayOffer, private readonly options: RelayTransportOptions = {}) {
    options.signal?.throwIfAborted();
    this.relay = offer.relay;
    this.stopResources = serveRelayResources(this, offer.server_id, () => !this.stopped && this.channel?.mux.active === true);
    options.signal?.addEventListener("abort", this.aborted, { once: true });
    globalThis.addEventListener?.("online", this.wake);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.wake);
  }

  connect(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.stopped || this.channel) return Promise.resolve();
    this.opening = this.establish().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async establish(): Promise<void> {
    const generation = ++this.generation;
    // A one-use pairing code must never be reused after admission.
    const { code, ...savedOffer } = this.offer;
    const offer = generation === 1 ? this.offer : savedOffer;
    const options: RelayChannelOptions = {
      ...this.options, signal: this.abort.signal,
      // a reconnect runs behind the app, not on a waiting screen: it waits at the relay nearly as long as the relay holds it
      ...(generation === 1 ? {} : { pcAnswerMs: RECONNECT_PC_ANSWER_MS }),
      onClose: (error) => {
        if (generation !== this.generation || this.stopped) return;
        const switching = this.switching !== undefined && this.switching === this.channel;
        this.switching = undefined;
        this.endUpgrade();
        this.channel = undefined;
        this.routeChanged();
        this.failWaitingHttp(new TypeError("Relay carrier is disconnected"));
        // a switch to a direct carrier is no lost carrier: nobody is told of it
        if (!switching) this.options.onClose?.(error);
        // closed on purpose to come back on a direct carrier: at once, with no pause; one that lands on the relay
        // again makes the next switch wait longer (a carrier that answers a probe but cannot carry a session)
        if (switching) this.switchingDirect = true;
        if (switching) void this.connect().then(() => {
          if (this.channel && this.channel.direct === undefined) this.probeBackoff = Math.min(this.probeBackoff * 2, 12);
          else if (this.channel) this.probeBackoff = 1;
        }).catch((failure: unknown) => this.failed(failure));
        else this.failed(error);
      },
    };
    const { channel, relay } = await this.race(generation, offer, options);
    this.relay = relay;
    if (generation !== this.generation || this.stopped) { channel.close(); return; }
    if (!channel.mux.active) throw new TypeError("Relay carrier lost during admission");
    this.channel = channel;
    this.routeChanged();
    channel.mux.onStreamAvailable = () => {
      for (const pending of this.waitingHttp) if (!pending.run()) break;
    };
    this.known = channel.server;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.delay = 1000;
    for (const waiting of this.renewing) {
      if (generation > waiting.after) { this.renewing.delete(waiting); waiting.up(); }
    }
    // a renew asked while this attempt was on its way: it may have signed with the old key, so the next one signs again
    if (this.renewing.size > 0) { channel.close(); return; }
    if (this.options.directSocket) {
      this.directCarriers = channel.directCarriers ?? [];
      if (channel.direct === undefined) this.upgrade(channel);
    }
  }

  /**
   * The channel this connection goes on. Without the app's direct socket, or while pairing with a code, through the
   * relay. Otherwise the PC's direct carriers first; when none is up within DIRECT_HEAD_START_MS, the relay is opened
   * too and the first channel admitted is kept: the other attempt is ended, and a channel it still admits is closed
   * without anyone being told of it. A refusal that cannot change (`isFatalRelayError`) on either ends both; any other
   * failure of one waits for the other.
   */
  private race(generation: number, offer: RelayOffer, options: RelayChannelOptions): Promise<{ channel: RelayChannel; relay: string }> {
    const viaRelay = (signal: AbortSignal, onClose = options.onClose) => openRelayChannelWithFallback(offer,
      { ...options, signal, onClose, offerDirect: this.options.directSocket !== undefined, offerTailnet: this.options.directTailnet?.() === true }, this.options.openChannel ?? openRelayChannel, this.relay);
    if (!this.options.directSocket || (generation === 1 && this.offer.code !== undefined)) return viaRelay(this.abort.signal);
    // a race the relay won by a hair would bring a switch the probe just earned back onto the relay, time after time
    const proven = this.switchingDirect;
    const headStartMs = proven ? undefined : DIRECT_HEAD_START_MS;
    this.switchingDirect = false;
    // only the channel kept may report its loss: one closed for losing the race is no lost carrier
    let winner: "direct" | "relay" | undefined;
    const lost = (side: "direct" | "relay") => (error: Error): void => { if (winner === side) options.onClose?.(error); };
    const directEnd = new AbortController();
    const relayEnd = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      let directDone = false;
      let relayStarted = false;
      let relayFailure: { error: unknown } | undefined;
      let cancelHeadStart: (() => void) | undefined;
      const win = (side: "direct" | "relay", result: { channel: RelayChannel; relay: string }): void => {
        if (settled) { result.channel.close(); return; }
        settled = true;
        winner = side;
        cancelHeadStart?.();
        (side === "direct" ? relayEnd : directEnd).abort();
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cancelHeadStart?.();
        directEnd.abort();
        relayEnd.abort();
        reject(error);
      };
      const startRelay = (): void => {
        if (relayStarted || settled) return;
        relayStarted = true;
        viaRelay(AbortSignal.any([this.abort.signal, relayEnd.signal]), lost("relay")).then((result) => win("relay", result), (error: unknown) => {
          relayFailure = { error };
          if (directDone || isFatalRelayError(error)) fail(error);
        });
      };
      if (headStartMs !== undefined) cancelHeadStart = (this.options.clock ?? clock).setTimeout(startRelay, headStartMs);
      this.openDirect(offer, { ...options, onClose: lost("direct") }, directEnd.signal, proven).then((channel) => {
        directDone = true;
        if (channel) win("direct", { channel, relay: this.relay });
        else if (relayFailure) fail(relayFailure.error);
        else { cancelHeadStart?.(); startRelay(); }
      }, (error: unknown) => { directDone = true; fail(error); });
    });
  }

  /**
   * The channel on one of the PC's direct carriers, DIRECT_SOCKETS at a time within DIRECT_BUDGET_MS; undefined when
   * none answered (off this network, or the PC names none) or `ended` fired (the relay won), and the relay is used.
   * Only a refusal by the PC itself, after Noise proved it is the PC, is final there as it is through the relay.
   */
  private async openDirect(offer: RelayOffer, options: RelayChannelOptions, ended: AbortSignal, proven = false): Promise<RelayChannel | undefined> {
    const socket = this.options.directSocket;
    if (!socket) return undefined;
    if (this.directCarriers === undefined) {
      const saved = (await (this.options.store ?? indexedDeviceStore).get(offer.server_id).catch(() => undefined))?.direct ?? [];
      // a relay channel that won meanwhile may have brought the PC's newer list
      this.directCarriers ??= saved;
    }
    const carriers = [...new Set(this.directCarriers)];
    if (ended.aborted || carriers.length === 0) return undefined;
    // at most DIRECT_SOCKETS at once (the apps' plugins open no more), in two lanes: the PC's Tailscale carriers and
    // its LAN ones. With both, each lane has one socket, so a silent LAN address never keeps the Tailscale one out of
    // the race, and the Tailscale one keeps its whole budget (away from home it is the slow one); a lane alone has both.
    // In a lane, a silent carrier takes only its round's share, so the ones queued behind it still get a turn.
    const lanes = [carriers.filter((carrier) => isTailnetCarrier(carrier)), carriers.filter((carrier) => !isTailnetCarrier(carrier))]
      .map((queue) => ({ queue, running: 0 }));
    const ends = performance.now() + DIRECT_BUDGET_MS;
    let kept: string | undefined;
    let settled = false;
    const attempts = new Map<string, AbortController>();
    // the admitted channel keeps its signal for good (closing the transport ends it): only the others are ended
    const endOthers = (than?: string): void => { for (const [carrier, attempt] of attempts) if (carrier !== than) attempt.abort(); };
    const offerTailnet = this.options.directTailnet?.() === true;
    return new Promise((resolve, reject) => {
      const running = (): number => lanes.reduce((sum, lane) => sum + lane.running, 0);
      const slots = (): number => lanes.every((other) => other.queue.length + other.running > 0) ? 1 : DIRECT_SOCKETS;
      const next = (): void => {
        for (;;) {
          if (settled || ended.aborted || this.stopped || running() >= DIRECT_SOCKETS) return;
          const lane = lanes.find((candidate) => candidate.queue.length > 0 && candidate.running < slots());
          const left = ends - performance.now();
          if (!lane || left <= 0) return;
          const direct = lane.queue.shift()!;
          // the carrier a probe just proved (first in the list) keeps the whole budget: the switch it earned does not race the relay
          const rounds = proven && direct === carriers[0] ? 1 : Math.ceil((lane.queue.length + lane.running + 1) / slots());
          lane.running++;
          const attempt = new AbortController();
          attempts.set(direct, attempt);
          const timer = setTimeout(() => attempt.abort(), left / rounds);
          // closing the transport ends an admitted channel too; the budget only an attempt under way
          const signal = AbortSignal.any([this.abort.signal, attempt.signal, ended]);
          const onClose = (error: Error): void => { if (kept === direct) options.onClose?.(error); };
          // the plugin counts a socket until its close is done (iOS: up to 5 s after asking): the lane's place frees only then
          const freed = deferred();
          let opened = false;
          const counted = (url: string): RelaySocket => { opened = true; return untilClosed(socket(url), freed.resolve); };
          (this.options.openChannel ?? openRelayChannel)(offer, { ...options, onClose, signal, direct, socket: counted, offerDirect: true, offerTailnet }).then((channel) => {
            if (settled || ended.aborted) { channel.close(); return; }
            settled = true;
            kept = direct;
            endOthers(direct);
            resolve(channel);
          }, (error: unknown) => {
            // only a refusal by the PC itself, after Noise proved it is the PC, is final: the relay's own refusal of a
            // new device is no word of a direct carrier's
            if (!settled && (this.stopped || (isFatalRelayError(error) && !(error instanceof DirectCarrierUnusableError) && !(error instanceof RelayNewSessionsRefusedError)))) { settled = true; endOthers(); reject(error); }
          }).finally(async () => {
            clearTimeout(timer);
            // a close that never comes holds the place no longer than the budget
            if (opened && !settled) await Promise.race([freed.promise, new Promise<void>((done) => setTimeout(done, Math.max(0, ends - performance.now())))]);
            lane.running--;
            next();
            if (running() === 0) resolve(undefined);
          });
        }
      };
      next();
      if (running() === 0) resolve(undefined);
    });
  }

  /**
   * While the relay carries `channel`: when one of the PC's direct carriers proves to be the PC (a probe that makes
   * no session), and no request is under way, closes `channel` so the reconnect comes back on that carrier. Never
   * moves a stream: the switch is a reconnect like any other, and nothing typed is sent again by itself.
   */
  private upgrade(channel: RelayChannel): void {
    const socket = this.options.directSocket;
    const carriers = this.directCarriers ?? [];
    const timers = this.options.clock ?? clock;
    if (!socket || carriers.length === 0 || this.upgrading) return;
    const wait = this.probedAt + DIRECT_PROBE_EVERY_MS * this.probeBackoff - timers.now();
    if (wait > 0) {
      // probed a moment ago (before a reconnect, say): the next probe still comes, when its time is up
      if (!this.cancelProbe) this.cancelProbe = timers.setTimeout(() => { this.cancelProbe = undefined; if (this.channel === channel) this.upgrade(channel); }, wait);
      return;
    }
    this.upgrading = true;
    this.reprobe = false;
    this.probedAt = timers.now();
    this.cancelProbe?.();
    this.cancelProbe = undefined;
    const ending = new AbortController();
    this.upgradeAbort = ending;
    const current = (): boolean => !this.stopped && this.channel === channel && !ending.signal.aborted;
    void (async () => {
      let proven = false;
      for (const direct of carriers) {
        if (!current()) return;
        if (await probeDirect(this.offer, direct, socket, DIRECT_BUDGET_MS, ending.signal)) {
          proven = true;
          // the reconnect tries the carrier that just proved to be the PC first
          this.directCarriers = [direct, ...carriers.filter((other) => other !== direct)];
          break;
        }
      }
      if (!proven) return;
      for (let check = 0; check < DIRECT_IDLE_CHECKS; check++) {
        if (!current()) return;
        if (this.openHttp === 0 && this.preparingHttp === 0 && this.waitingHttp.size === 0 && timers.now() - this.socketSentAt >= SOCKET_QUIET_MS) {
          this.switching = channel;
          channel.close();
          return;
        }
        await new Promise<void>((resolve) => {
          const stop = (): void => { cancel(); resolve(); };
          const cancel = timers.setTimeout(() => { ending.signal.removeEventListener("abort", stop); resolve(); }, DIRECT_IDLE_CHECK_MS);
          ending.signal.addEventListener("abort", stop, { once: true });
        });
      }
    })().finally(() => {
      this.upgrading = false;
      if (this.upgradeAbort === ending) this.upgradeAbort = undefined;
      if (!current()) return;
      // still on the relay: try again after a network change that came meanwhile, else in a while
      if (this.reprobe) { this.probedAt = -Infinity; this.upgrade(channel); return; }
      this.cancelProbe = timers.setTimeout(() => { this.cancelProbe = undefined; this.upgrade(channel); }, DIRECT_PROBE_EVERY_MS * this.probeBackoff);
    });
  }

  /** Ends the probe, idle wait and periodic probe of the channel that is going. */
  private endUpgrade(): void {
    this.upgradeAbort?.abort();
    this.upgradeAbort = undefined;
    this.cancelProbe?.();
    this.cancelProbe = undefined;
  }

  /** What the PC said of itself on the latest admission: a reconnect after its update names the new version. */
  get server(): RelayServerInfo | undefined { return this.known; }

  /** How the channel up now reaches the PC: through the relay, or on one of its direct carriers. */
  get route(): "relay" | "direct" | undefined { return this.channel ? this.channel.direct === undefined ? "relay" : "direct" : undefined; }

  private readonly routeListeners = new Set<() => void>();

  /** Called whenever `route` may have changed (a channel came up or went); returns the unsubscribe. */
  onRouteChange(listener: () => void): () => void {
    this.routeListeners.add(listener);
    return () => { this.routeListeners.delete(listener); };
  }

  private routeChanged(): void { for (const listener of [...this.routeListeners]) listener(); }

  /**
   * Ends this carrier and connects again, signing in with the key the saved pairing holds now: after
   * a link swapped it for the account key, the PC takes this device's account actions only from a
   * session that proved that key. Settles once the carrier that signed in again is up (an attempt
   * already on its way may still sign with the old key), and never if the transport closes first.
   */
  renew(): Promise<void> {
    const up = new Promise<void>((resolve) => this.renewing.add({ after: this.generation, up: resolve }));
    this.channel?.close();
    return up;
  }

  /** A reconnect that failed: tried again later, unless no later attempt could succeed. */
  private failed(error: unknown): void {
    if (this.stopped) return;
    if (!isFatalRelayError(error)) {
      // an attempt the relay held for an absent PC was a wait, not a hammering: no growing pause
      // between such waits, so a PC back from a restart is reached within a second
      // (a hidden page keeps the growing pause: showing it again reconnects at once, through wake)
      if (error instanceof RelayPcOfflineError && globalThis.document?.visibilityState !== "hidden") this.delay = 1000;
      this.retry();
      return;
    }
    this.close();
    this.options.onFatal?.(error);
  }

  private retry(): void {
    if (this.stopped || this.cancelRetry) return;
    this.cancelRetry = (this.options.clock ?? clock).setTimeout(() => {
      this.cancelRetry = undefined;
      void this.connect().catch((error: unknown) => this.failed(error));
    }, this.delay);
    this.delay = Math.min(30_000, this.delay * 2);
  }

  /**
   * Whether `channel`, the carrier a socket opened on, is still this transport's and still open. One found closing with no close event yet (closed
   * under the page while the relay has not answered) is ended now: its streams fail and a new one
   * connects, rather than the app reading itself live until the browser gives up on the close.
   */
  private carrierUp(channel: RelayChannel | undefined): boolean {
    // not open on a carrier yet: the stream's own events decide
    if (!channel) return true;
    // a carrier that was ended or replaced never reads as up again, whatever its successor does
    if (this.channel === channel && channel.carrierOpen) return true;
    // ended outside the caller, which may be a render reading the socket's state
    if (this.channel === channel) queueMicrotask(() => { if (this.channel === channel) channel.close(); });
    return false;
  }

  private mux() {
    if (this.stopped || !this.channel?.mux.active) throw new TypeError("Relay carrier is disconnected");
    return this.channel.mux;
  }

  private failWaitingHttp(error: unknown): void {
    for (const pending of this.waitingHttp) pending.fail(error);
  }

  private waitForHttp(open: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
    if (this.waitingHttp.size >= HTTP_QUEUE_LIMIT) throw new TypeError("Relay HTTP request queue is full");
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        this.waitingHttp.delete(pending);
        cancelTimeout();
        signal.removeEventListener("abort", aborted);
      };
      const pending = {
        run: (): boolean => {
          try {
            const response = open();
            cleanup();
            resolve(response);
          } catch (error) {
            if (error instanceof MuxStreamError && error.code === "refused") return false;
            pending.fail(new TypeError("Relay request failed", { cause: error }));
          }
          return true;
        },
        fail: (error: unknown): void => { cleanup(); reject(error); },
      };
      const aborted = (): void => pending.fail(signal.reason);
      const cancelTimeout = (this.options.clock ?? clock).setTimeout(
        () => pending.fail(new TypeError("Relay HTTP request timed out waiting for a stream slot")), HTTP_QUEUE_TIMEOUT_MS);
      this.waitingHttp.add(pending);
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const address = input instanceof Request ? input : new URL(String(input), "https://relay.ovis.invalid").href;
    // The request belongs to the carrier up when it was made: if that one is gone before it is sent, it fails
    // and is never sent on a later one (nothing typed is sent automatically after a disconnect).
    const mux = this.mux();
    const connected = (): void => { if (this.stopped || !mux.active) throw new TypeError("Relay carrier is disconnected"); };
    // Firefox has no Request.body (undefined, where a request without one has null): its body is buffered below,
    // so one over the PC's request limit is refused before Request copies it, when its size is known
    const buffered = new Request("https://relay.ovis.invalid/").body === undefined;
    if (buffered && (knownSize(init?.body) ?? 0) > LIMITS_V1.max_request_body_bytes) throw tooLarge();
    // These are browser networking policies, not properties of an encrypted mux request.
    const request = new Request(address, { ...init, credentials: "omit", mode: "cors" });
    request.signal.throwIfAborted();
    let upload: ReadableStream<Uint8Array> | null;
    if (!buffered) upload = request.body;
    else if (request.method === "GET" || request.method === "HEAD") upload = null;
    else {
      this.preparingHttp++;
      let blob: Blob;
      try { blob = await request.blob(); }
      finally { this.preparingHttp--; }
      request.signal.throwIfAborted();
      connected();
      if (blob.size > LIMITS_V1.max_request_body_bytes) throw tooLarge();
      upload = blob.size > 0 ? blob.stream() : null;
    }
    const open = (): Promise<Response> => {
      const allowed: readonly string[] = REQUEST_HEADERS;
      connected();
      const stream = mux.openHttp({
        target: target(request.url), method: method(request.method),
        headers: [...request.headers].filter(([name]) => allowed.includes(name)),
        body: upload ? "stream" : "none",
      });
      return new Promise<Response>((resolve, reject) => {
        const aborted = (): void => { stream.reset(); reject(request.signal.reason); };
        request.signal.addEventListener("abort", aborted, { once: true });
        // an event stream stays open for good and is reopened after any reconnect: it does not hold a switch back
        const counted = !(init !== undefined && eventStreams.has(init));
        if (counted) this.openHttp++;
        stream.onDispose = (error) => {
          if (counted) this.openHttp--;
          request.signal.removeEventListener("abort", aborted);
          if (error) reject(request.signal.aborted ? request.signal.reason : new TypeError("Relay request failed", { cause: error }));
        };
        stream.onHeaders = ({ status, headers }) => {
          if (status < 200) return;
          // Keep the body streaming; a failed carrier also errors an already returned body.
          const reader = stream.body.getReader();
          const body = stream.noBody ? null : new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) controller.close();
                else controller.enqueue(next.value);
              } catch (error) {
                controller.error(request.signal.aborted ? request.signal.reason : new TypeError("Relay body failed", { cause: error }));
              }
            },
            cancel: (reason) => reader.cancel(reason),
          }, { highWaterMark: 0 });
          resolve(new Response(body, { status, headers: headers.map(([name, value]) => [name, value]) }));
        };
        if (request.signal.aborted) { aborted(); return; }
        if (upload) void stream.sendBody(upload).catch((error: unknown) => {
          if (stream.stopped) return;
          stream.reset("internal_error");
          reject(request.signal.aborted ? request.signal.reason : new TypeError("Relay upload failed", { cause: error }));
        });
      });
    };
    if (this.waitingHttp.size) return this.waitForHttp(open, request.signal);
    try { return open(); }
    catch (error) {
      if (error instanceof MuxStreamError && error.code === "refused") return this.waitForHttp(open, request.signal);
      throw new TypeError("Relay request failed", { cause: error });
    }
  }

  openSocket(url: string): RelayWebSocket {
    // the carrier the stream opened on: the socket is live only while that one is
    let opened: RelayChannel | undefined;
    return new RelayWebSocket(() => {
      const stream = this.mux().openWs({ target: target(url), headers: [], protocols: [] });
      opened = this.channel;
      return stream;
    }, () => this.carrierUp(opened), () => { this.socketSentAt = (this.options.clock ?? clock).now(); });
  }
  openEventSource(url: string): RelayEventSource { return new RelayEventSource(this, url); }
  resourceUrl(path: string, signal?: AbortSignal): Promise<string> { return relayResourceUrl(this, this.offer.server_id, path, signal); }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.failWaitingHttp(new TypeError("Relay transport is closed"));
    this.renewing.clear();
    this.stopResources();
    ++this.generation;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.endUpgrade();
    this.abort.abort();
    this.channel?.close();
    this.channel = undefined;
    this.routeChanged();
    this.options.signal?.removeEventListener("abort", this.aborted);
    globalThis.removeEventListener?.("online", this.wake);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.wake);
  }
}

export class RelayWebSocket extends EventTarget implements WebSocketLike {
  override addEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options);
  }
  override removeEventListener<K extends keyof WebSocketEventMap>(type: K, listener: (event: WebSocketEventMap[K]) => void, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    super.removeEventListener(type, listener, options);
  }
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  private state: number = this.CONNECTING;
  /**
   * CLOSING as soon as the relay carrier is no longer open, before its close reaches this stream:
   * HerdrSocket reads it as disconnected, so typing stays a draft instead of going into a socket
   * that drops it.
   */
  get readyState(): number { return this.state === this.OPEN && !this.carrier() ? this.CLOSING : this.state; }
  binaryType: BinaryType = "blob";
  declare onopen: WebSocketLike["onopen"];
  declare onmessage: WebSocketLike["onmessage"];
  declare onclose: WebSocketLike["onclose"];
  declare onerror: WebSocketLike["onerror"];
  private stream: WsStream | undefined;
  private pendingBytes = 0;
  private waiting = 0;
  private outgoing = Promise.resolve();
  private events = Promise.resolve();
  get bufferedAmount(): number { return this.pendingBytes + (this.stream?.getBufferedAmount() ?? 0); }

  constructor(private readonly open: () => WsStream, private readonly carrier: () => boolean = () => true, private readonly sent: () => void = () => {}) {
    super();
    eventProperties(this, ["open", "message", "close", "error"]);
    // Browser socket events are asynchronous even when a test carrier answers synchronously.
    queueMicrotask(() => {
      if (this.state !== this.CONNECTING) return;
      try {
        const stream = this.open();
        this.stream = stream;
        stream.onAccept = () => { void this.enqueue(() => {
          if (this.state !== this.CONNECTING) return;
          this.state = this.OPEN;
          this.emit(new Event("open"));
        }); };
        stream.onMessage = (data) => this.enqueue(() => {
          if (this.state !== this.OPEN && this.state !== this.CLOSING) return;
          this.emit(new MessageEvent("message", { data: typeof data === "string" ? data
            : this.binaryType === "blob" ? new Blob([data.slice().buffer]) : data.slice().buffer }));
        });
        stream.onClose = (event) => {
          stream.rejection?.reset();
          void this.enqueue(() => this.finish(event.code, event.reason, event.clean));
        };
      } catch { void this.enqueue(() => this.finish(1006, "", false)); }
    });
  }

  private enqueue(action: () => void): Promise<void> {
    this.events = this.events.then(action);
    return this.events;
  }

  private emit(event: Event): void {
    this.dispatchEvent(event);
  }

  private finish(code: number, reason: string, clean: boolean): void {
    if (this.state === this.CLOSED) return;
    this.state = this.CLOSED;
    // Discarded sends still count after close, even though their payloads are never queued.
    if (code === 1006) this.emit(new Event("error"));
    this.emit(new CloseEvent("close", { code, reason, wasClean: clean }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.state === this.CONNECTING) throw new DOMException("Socket is connecting", "InvalidStateError");
    const size = typeof data === "string" ? utf8Length(data) : data instanceof Blob ? data.size : data.byteLength;
    this.sent();
    if (this.readyState !== this.OPEN) { this.pendingBytes += size; return; }
    const stream = this.stream;
    if (!stream) return;
    this.pendingBytes += size;
    if (this.pendingBytes > WS_SEND_QUEUE_LIMIT || this.waiting >= WS_SEND_QUEUE_MESSAGES) {
      // As a browser's socket whose send buffer is full: it fails, nothing still waiting is sent,
      // and what the mux had not sent yet stays counted once the reset discards it.
      this.state = this.CLOSING;
      this.pendingBytes += stream.getBufferedAmount();
      this.stream = undefined;
      stream.reset("resource_exhausted");
      void this.enqueue(() => this.finish(1006, "", false));
      return;
    }
    this.waiting++;
    // Capture the stream now. Neither Blob conversion nor backpressure can replay on a new mux.
    const message = typeof data === "string" || data instanceof Blob ? data : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() : new Uint8Array(data).slice();
    this.outgoing = this.outgoing.then(async () => {
      const bytes = message instanceof Blob ? new Uint8Array(await message.arrayBuffer()) : message;
      if (stream.live && this.state !== this.CLOSED) {
        this.pendingBytes -= size;
        stream.send(bytes);
      }
    }).catch(() => this.finish(1006, "", false)).finally(() => { this.waiting--; });
  }

  close(code?: number, reason = ""): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException("Invalid close code", "InvalidAccessError");
    if (new TextEncoder().encode(reason).length > 123) throw new DOMException("Close reason is too long", "SyntaxError");
    if (this.state === this.CLOSED || this.state === this.CLOSING) return;
    const connecting = this.state === this.CONNECTING;
    this.state = this.CLOSING;
    if (connecting) {
      this.stream?.reset();
      void this.enqueue(() => this.finish(1006, "", false));
    } else {
      this.outgoing = this.outgoing.then(() => { this.stream?.close(code ?? null, reason); });
    }
  }
}

/** SSE's line and unfinished-event storage are jointly bounded, including ignored fields. */
export const SSE_BUFFER_LIMIT = 1024 * 1024;

/** The requests of a RelayEventSource: reopened after any reconnect, so they never hold a switch to a direct carrier back. */
const eventStreams = new WeakSet<RequestInit>();

export class RelayEventSource extends EventTarget implements EventSourceLike {
  override addEventListener<K extends keyof EventSourceEventMap>(type: K, listener: (event: EventSourceEventMap[K]) => void, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    super.addEventListener(type, listener, options);
  }
  readyState = 0;
  declare onopen: EventSourceLike["onopen"];
  declare onmessage: EventSourceLike["onmessage"];
  declare onerror: EventSourceLike["onerror"];
  private readonly abort = new AbortController();

  constructor(transport: Transport, url: string) {
    super();
    eventProperties(this, ["open", "message", "error"]);
    void this.read(transport, url).catch(() => {
      if (this.readyState === 2) return;
      this.readyState = 2;
      this.abort.abort();
      this.emit(new Event("error"));
    });
  }

  private emit(event: Event): void {
    this.dispatchEvent(event);
  }

  private async read(transport: Transport, url: string): Promise<void> {
    const init: RequestInit = { signal: this.abort.signal, headers: { accept: "text/event-stream" } };
    eventStreams.add(init);
    const response = await transport.fetch(url, init);
    if (this.readyState === 2) { await response.body?.cancel(); return; }
    if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream" || !response.body) {
      await response.body?.cancel();
      throw new TypeError("Invalid relay event stream");
    }
    this.readyState = 1;
    this.emit(new Event("open"));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let line = "";
    let data = "";
    let type = "";
    let id = "";
    let skipLf = false;
    const consume = (): void => {
      if (!line) {
        if (data) this.emit(new MessageEvent(type || "message", { data: data.slice(0, -1), lastEventId: id, origin: new URL(url, "https://relay.ovis.invalid").origin }));
        data = ""; type = "";
      } else {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data += value + "\n";
        else if (field === "event") type = value;
        else if (field === "id" && !value.includes("\0")) id = value;
      }
      line = "";
    };
    try {
      while (this.readyState === 1) {
        const next = await reader.read();
        if (next.done) throw new TypeError("Relay event stream ended");
        for (const character of decoder.decode(next.value, { stream: true })) {
          if (this.readyState !== 1) return;
          if (skipLf) { skipLf = false; if (character === "\n") continue; }
          if (character === "\r" || character === "\n") { consume(); skipLf = character === "\r"; }
          else line += character;
          if (line.length + data.length + type.length + id.length > SSE_BUFFER_LIMIT) throw new TypeError("Relay event exceeds buffer limit");
        }
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }

  close(): void { this.readyState = 2; this.abort.abort(); }
}
