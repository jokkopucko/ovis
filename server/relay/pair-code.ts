/**
 * The PC's side of pairing with a typed code (shared/relay-pair-code.ts, docs/relay.md "Pairing
 * with a typed code"). Minting a code starts a fresh six-digit pairing code, holds the code's
 * nameplate on the relay (relay/pair-room.ts) and answers each device that joins with one CPace
 * exchange. A device that knew the code gets the pairing offer the QR code shows, with that
 * six-digit code in it, and pairs with it as a scanned QR code does (DeviceStore.pairRelay): the
 * typed code only delivers the offer, it admits nobody.
 *
 * The tries are counted here, never by the relay: one is taken before M1 goes out and only a
 * correct confirmation ends the code (spent: single use); a wrong one, a malformed answer, a device
 * that leaves after M1 or one that runs out of time keeps the try spent, and the third ends the
 * code. A host socket that drops reopens on the same nameplate with the same tries left. M1 for the
 * next device is worked out ahead of time, so the relay cannot time it against a device's arrival.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { PairCodeHost, PairCodeProtocolError, PAIR_ATTEMPT_BYTES as ATTEMPT_BYTES, PAIR_CLOSE, PAIR_CODE_TRIES, formatPairCode, randomPairCode, splitPairCode } from "../../shared/relay-pair-code.ts";
import { RELAY_PASS_HEADER } from "../../shared/relay-pass.ts";
import type { RelayOffer } from "../../shared/relay-offer.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "./identity.ts";

/** how long one device has, from M1, to answer */
export const PAIR_CODE_ATTEMPT_MS = 20_000;
/** nameplates tried before minting gives up: another PC may hold one */
const NAMEPLATE_TRIES = 5;
const REOPEN_MS = 1000;
/** under the relay's 120 s idle close (relay/core.ts IDLE_MS), so a code nobody tries keeps its nameplate */
const KEEPALIVE_MS = 30_000;
/** how long a nameplate may wait for the relay before its six-digit code is started */
const PAIR_CODE_HOLD_MS = 60_000;
/** the relay's keepalive (relay/core.ts KEEPALIVE_PING), as server/relay/link.ts sends it */
const KEEPALIVE_PING = '{"type":"ping"}';

export class PairCodeUnavailableError extends Error {}

export interface RelayPairCodesOptions {
  /** the relay's wss origin the rendezvous is held on */
  readonly relay: string;
  readonly devices: DeviceStore;
  /** the offer a QR code would show for `code`, the six-digit code this typed code is bound to */
  readonly offer: (code: string) => RelayOffer;
  /** this PC's relay key, which it proves to hold a nameplate (relay/pair-room.ts) */
  readonly identity: () => RelayIdentity;
  /** this PC's relay pass, sent in a header on Ovis's relays only */
  readonly pass?: () => string | null;
  readonly connect?: (url: string, headers?: Record<string, string>) => WebSocket;
  readonly attemptMs?: number;
  readonly keepaliveMs?: number;
}

interface Attempt { id: string; exchange: PairCodeHost; timer: ReturnType<typeof setTimeout> }

interface Current {
  code: string;
  nameplate: string;
  /**
   * the six-digit code the offer carries, and that issuance's expiry: the typed code is dead once it
   * is no longer the pending one, even when a later issuance drew the same six digits
   */
  bound: { code: string; expires_at: string };
  expires: number;
  tries: number;
  socket: WebSocket | null;
  attempt: Attempt | null;
  next: PairCodeHost;
  expiry: ReturnType<typeof setTimeout>;
  reopen: ReturnType<typeof setTimeout> | null;
  keepalive: ReturnType<typeof setInterval> | null;
  done: boolean;
}

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytesOf = (text: string) => Uint8Array.from(text.match(/../g)!, (pair) => Number.parseInt(pair, 16));

export class RelayPairCodes {
  private current: Current | null = null;
  /** bumped by every mint and cancel: a mint still waiting on the relay that is no longer the newest stops there */
  private generation = 0;

  /** set while mint starts the six-digit code its typed code is bound to: that one replaces nothing of its own */
  private binding = false;

  constructor(private readonly options: RelayPairCodesOptions) {
    // a six-digit code started anywhere else (New code, the Devices group) ends the typed code bound to the old one
    options.devices.onPairingStarted(() => { if (!this.binding) this.cancel(); });
  }

  private url(nameplate: string, identity: RelayIdentity): string {
    const url = new URL("/v1/pair", this.options.relay.replace(/^wss:/, "https:"));
    url.protocol = "wss:";
    // the PC's key, which a relay that binds the nameplate to it asks this socket to prove; an older relay reads neither
    url.search = new URLSearchParams({ nameplate, role: "host", v: "1", server_id: identity.server_id, public_key: bytesToHex(importPublicKey(identity.public_key)) }).toString();
    return url.href;
  }

  /**
   * A new code, replacing any code still showing. It starts a fresh six-digit code (the QR code then
   * shows the same one) and resolves once the relay holds its nameplate.
   */
  async mint(by: string | null = null): Promise<{ code: string; expires_at: string }> {
    this.cancel();
    const generation = this.generation;
    const { devices } = this.options;
    devices.assertRelayPairing();
    for (let tried = 0; tried < NAMEPLATE_TRIES; tried++) {
      const code = randomPairCode();
      // the six-digit code is started only once the relay holds the nameplate, so a code the relay
      // refuses leaves the QR code showing as it was
      const current: Current = {
        code, nameplate: splitPairCode(code).nameplate, bound: { code: "", expires_at: "" }, expires: Date.now() + PAIR_CODE_HOLD_MS, tries: PAIR_CODE_TRIES,
        socket: null, attempt: null, next: new PairCodeHost(code), reopen: null, keepalive: null, done: false,
        expiry: setTimeout(() => this.finish(current), PAIR_CODE_HOLD_MS),
      };
      this.current = current;
      const held = await this.hold(current);
      // hidden, or replaced by a newer code, while the relay answered: this one must not live on
      if (generation !== this.generation || current.done) { this.finish(current); throw new PairCodeUnavailableError("This code was replaced."); }
      if (held !== "held") {
        this.finish(current);
        if (held === "failed") break;
        continue;
      }
      let pairing: { code: string; expires_at: string };
      this.binding = true;
      // `by`: the paired device that asked for the code, which holds the six digits behind it (DeviceStore.revoke)
      try { pairing = devices.startPairing(Date.now(), { remote: false, startedBy: null, memberRequired: false, by }); }
      catch (error) { this.finish(current); throw error; }
      finally { this.binding = false; }
      current.bound = pairing;
      current.expires = Date.parse(pairing.expires_at);
      clearTimeout(current.expiry);
      current.expiry = setTimeout(() => this.finish(current), Math.max(0, current.expires - Date.now()));
      return { code: formatPairCode(code), expires_at: pairing.expires_at };
    }
    throw new PairCodeUnavailableError("The relay did not take a pairing code. Try again, or scan the QR code.");
  }

  /** Ends the code showing, if any: its nameplate leaves the relay, and a device trying it is cut off. */
  cancel(): void {
    this.generation++;
    if (this.current) this.finish(this.current);
  }

  /** the code showing, for tests and status */
  get showing(): { code: string; tries: number } | null {
    return this.current && !this.current.done ? { code: this.current.code, tries: this.current.tries } : null;
  }

  /** Opens the host socket; "taken" when another PC holds the nameplate, "failed" when the relay did not answer. */
  private hold(current: Current): Promise<"held" | "taken" | "failed"> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: "held" | "taken" | "failed") => { if (!settled) { settled = true; resolve(value); } };
      const identity = this.options.identity();
      const pass = this.options.pass?.() ?? null;
      // Bun's WebSocket takes headers (never the URL: a pass is good for hours)
      const connect = this.options.connect ?? ((address, extra) => new WebSocket(address, (extra ? { headers: extra } : undefined) as unknown as string[]));
      const socket = connect(this.url(current.nameplate, identity), pass === null ? undefined : { [RELAY_PASS_HEADER]: pass });
      socket.binaryType = "arraybuffer";
      current.socket = socket;
      socket.addEventListener("message", (event) => {
        if (current.done || current.socket !== socket) return;
        if (typeof event.data === "string") {
          let message: { type?: unknown; attempt?: unknown };
          try { message = JSON.parse(event.data) as typeof message; } catch { return; }
          if (typeof message !== "object" || message === null || Array.isArray(message)) return;
          if (message.type === "server_challenge" && !settled) {
            const answer = answerServerChallenge(event.data, importSecretKey(identity.secret_key), { server_id: identity.server_id, role: "pair-host", connection_id: current.nameplate });
            if (answer !== null) this.send(current, answer);
          }
          else if (message.type === "waiting") {
            settle("held");
            if (current.keepalive) clearInterval(current.keepalive);
            current.keepalive = setInterval(() => { if (current.socket === socket) this.send(current, KEEPALIVE_PING); }, this.options.keepaliveMs ?? KEEPALIVE_MS);
          }
          else if (message.type === "guest" && typeof message.attempt === "string" && /^[0-9a-f]{32}$/.test(message.attempt)) this.guest(current, message.attempt);
          else if (message.type === "gone" && message.attempt === current.attempt?.id) this.endAttempt(current);
          return;
        }
        this.answer(current, new Uint8Array(event.data as ArrayBuffer));
      });
      socket.addEventListener("close", (event) => {
        if (current.socket === socket) {
          current.socket = null;
          if (current.keepalive) { clearInterval(current.keepalive); current.keepalive = null; }
        }
        if (!settled) return settle(event.code === PAIR_CLOSE.TAKEN ? "taken" : "failed");
        if (current.done) return;
        // the relay dropped the nameplate: the same code, with the tries it has left, goes back on it
        if (current.attempt) this.endAttempt(current);
        if (Date.now() + REOPEN_MS < current.expires) current.reopen = setTimeout(() => { current.reopen = null; if (!current.done) void this.hold(current).then((held) => { if (held !== "held") this.finish(current); }); }, REOPEN_MS);
        else this.finish(current);
      });
    });
  }

  private send(current: Current, data: string | Uint8Array<ArrayBuffer>): void {
    try { current.socket?.send(data); } catch { /* the close handler reopens or ends it */ }
  }

  private drop(current: Current, attempt: string): void {
    this.send(current, JSON.stringify({ type: "drop", attempt }));
  }

  /** A device joined: one of the tries is taken now, before anything goes out. */
  private guest(current: Current, id: string): void {
    if (current.attempt !== null || current.tries <= 0 || Date.now() >= current.expires) return this.drop(current, id);
    current.tries -= 1;
    const exchange = current.next;
    current.attempt = { id, exchange, timer: setTimeout(() => { this.drop(current, id); this.endAttempt(current); }, this.options.attemptMs ?? PAIR_CODE_ATTEMPT_MS) };
    const hello = exchange.hello();
    const frame = new Uint8Array(ATTEMPT_BYTES + hello.length);
    frame.set(bytesOf(id));
    frame.set(hello, ATTEMPT_BYTES);
    this.send(current, frame);
    // the next device's M1 is worked out once this one is sent, so the relay cannot time it against an arrival
    current.next = new PairCodeHost(current.code);
  }

  private answer(current: Current, frame: Uint8Array): void {
    const attempt = current.attempt;
    if (!attempt || frame.length < ATTEMPT_BYTES || hexOf(frame.subarray(0, ATTEMPT_BYTES)) !== attempt.id) return;
    const { devices, offer } = this.options;
    // the six-digit code may have been spent, replaced or run out since: then no offer goes out
    const active = devices.activePairing();
    const pending = active?.code === current.bound.code && active.expires_at === current.bound.expires_at;
    let reply: Uint8Array | null;
    try { reply = attempt.exchange.answer(frame.subarray(ATTEMPT_BYTES), pending ? JSON.stringify(offer(current.bound.code)) : null); }
    catch (error) { if (!(error instanceof PairCodeProtocolError)) throw error; reply = null; }
    if (reply === null) {
      this.drop(current, attempt.id);
      this.endAttempt(current);
      return;
    }
    const out = new Uint8Array(ATTEMPT_BYTES + reply.length);
    out.set(bytesOf(attempt.id));
    out.set(reply, ATTEMPT_BYTES);
    this.send(current, out);
    // single use: the device that knew the code has the offer (or was told the code is gone)
    this.finish(current);
  }

  /** The attempt is over; its try stays spent, and the code ends with its last one. */
  private endAttempt(current: Current): void {
    if (current.attempt) clearTimeout(current.attempt.timer);
    current.attempt = null;
    if (current.tries <= 0) this.finish(current);
  }

  private finish(current: Current): void {
    if (current.done) return;
    current.done = true;
    clearTimeout(current.expiry);
    if (current.reopen) clearTimeout(current.reopen);
    if (current.keepalive) clearInterval(current.keepalive);
    if (current.attempt) clearTimeout(current.attempt.timer);
    current.attempt = null;
    const socket = current.socket;
    current.socket = null;
    // the last frame goes out before the close: a WebSocket keeps their order
    try { socket?.close(1000, "done"); } catch { /* already closed */ }
    if (this.current === current) this.current = null;
  }
}
