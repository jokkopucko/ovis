/**
 * The PC's direct carriers (`ws://<private IPv4>:<port>/v1/ws?v=1`, docs/relay.md "Direct on the same
 * network") through the phone apps' OvisDirect plugin (app/ios/App/App/OvisDirectPlugin.swift,
 * app/android/app/src/main/java/sh/ovis/app/OvisDirectPlugin.java): a page on https cannot open plain
 * `ws://`. Frames cross the bridge in an envelope `{ id, kind, data }`, a binary one as base64, so text
 * and binary stay apart; the plugin delivers them in order and keeps at most 4 MiB or 16,384 messages
 * this page has not acknowledged (the transport's own send queue), closing the socket with 1009 beyond that.
 */
import { arrayBufferToBase64, base64ToArrayBuffer } from "../../../shared/vendor/paseo-e2ee/base64.ts";
import type { RelaySocket } from "../../../shared/relay-channel.ts";
import { isDirectCarrier } from "../../../shared/relay-mux.ts";
import { hasNativePlugin } from "../nativeApp.ts";

export const DIRECT_PLUGIN = "OvisDirect";
/** The hosted shell's origin: the plugin answers only a main-frame page of it. */
export const APP_ORIGIN = "https://app.ovis.sh";

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

/** The plugin as the adapter uses it; tests hand in a fake. */
export interface DirectBridge {
  open(url: string): Promise<string>;
  send(id: string, frame: DirectFrame): Promise<void>;
  close(id: string, code?: number, reason?: string): Promise<void>;
  /** Tells the plugin the page took `messages` more of the socket's messages off its queue. */
  ack(id: string, messages: number): Promise<void>;
  /** Every event of every socket, in the order the plugin sent them. */
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
  /** sends asked for before the plugin named the socket, in order */
  private early: DirectFrame[] = [];
  private earlyBytes = 0;
  private closeAsked: { code?: number; reason?: string } | undefined;
  private unacked = 0;

  constructor(private readonly bridge: DirectBridge) {}

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
      // the plugin closes the socket once it names it (closeAsked); the page hears of it now
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
    this.readyState = CLOSING;
    if (this.id === undefined) this.closeAsked = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
    else this.closeNative(code, reason);
  }

  event(event: DirectEvent): void {
    switch (event.type) {
      case "message": {
        if (this.readyState === CLOSED) return;
        const data = event.kind === "text" ? event.data : base64ToArrayBuffer(event.data);
        // taken off the plugin's queue once handled; the acks of one turn go as one call. A known limit: the
        // ack follows onmessage, while the relay channel may still have asynchronous work queued for it, so the
        // plugin's cap bounds what waits to reach the page, not that work.
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
    // a send the plugin refuses means its socket is gone: its close event follows
    this.bridge.send(id, frame).catch((error: unknown) => console.warn("Ovis: a direct socket send failed", error));
  }

  private closeNative(code?: number, reason?: string): void {
    this.bridge.close(this.id!, code, reason).catch((error: unknown) => console.warn("Ovis: a direct socket did not close", error));
  }
}

/**
 * A RelaySocket factory over `bridge`: it throws for an address that is not a direct carrier's, before
 * the plugin hears of it. One listener serves every socket; events of a socket the plugin named
 * before its open answered here wait for it.
 */
export function directSocketFactory(bridge: DirectBridge): (url: string) => RelaySocket {
  const sockets = new Map<string, DirectSocket>();
  const waiting = new Map<string, DirectEvent[]>();
  let opening = 0;
  bridge.listen((event) => {
    const socket = sockets.get(event.id);
    if (socket) {
      socket.event(event);
      if (event.type === "close") sockets.delete(event.id);
      return;
    }
    // only while an open is unanswered can an event be for a socket not known yet
    if (opening > 0) waiting.set(event.id, [...(waiting.get(event.id) ?? []), event]);
  });
  return (url) => {
    if (!isDirectSocketUrl(url)) throw new TypeError("Not a direct carrier's address");
    const socket = new DirectSocket(bridge);
    opening++;
    bridge.open(url).then((id) => {
      opening--;
      const early = waiting.get(id) ?? [];
      waiting.delete(id);
      if (opening === 0) waiting.clear();
      sockets.set(id, socket);
      socket.opened(id);
      for (const event of early) {
        socket.event(event);
        if (event.type === "close") sockets.delete(id);
      }
    }, () => {
      opening--;
      if (opening === 0) waiting.clear();
      socket.refused();
    });
    return socket;
  };
}

let shared: ((url: string) => RelaySocket) | undefined;

/**
 * The direct socket factory for the relay transport, or undefined where the PC is reached through
 * the relay only: a browser, an app built before the plugin, or a page that is not the hosted
 * shell's (the plugin refuses those).
 */
export function nativeDirectSocket(): ((url: string) => RelaySocket) | undefined {
  if (typeof window === "undefined" || window.location.origin !== APP_ORIGIN || !hasNativePlugin(DIRECT_PLUGIN)) return undefined;
  if (shared) return shared;
  const bridge = capacitorDirectBridge();
  if (!bridge) return undefined;
  shared = directSocketFactory(bridge);
  return shared;
}
