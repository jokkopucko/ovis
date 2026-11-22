/**
 * This PC's relay pass (shared/relay-pass.ts; docs/relay.md, "Relay pass"): what Ovis's own relays
 * may ask of a PC before they let it in. The account service signs one for a PC that proves its relay
 * key and that the account it names lists in its directory. The PC asks for it only for Ovis's
 * relays, keeps it in `relay/pass.json` (readable by your user only) so a restart or an account
 * service outage costs nothing while it holds, and asks for the next one after `refresh_in`.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { parseRelayPass, RELAY_PASS_LIFETIME_S, RELAY_PASS_SKEW_S } from "../../shared/relay-pass.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import { isJsonObject } from "../http.ts";
import { writePrivateState } from "../private-state.ts";
import type { RelayIdentity } from "./identity.ts";

export type RelayPassState = "ok" | "no_account" | "not_listed" | "limit" | "unavailable";

const RETRY_MS = 60_000;
const RETRY_CAP_MS = 30 * 60_000;
const WAIT_ACCOUNT_MS = 30 * 60_000;
const RETRY_AFTER_CAP_MS = 24 * 3600_000;
const REQUEST_MS = 15_000;
const MIN_REFRESH_S = 60;
const MAX_REFRESH_S = 24 * 3600;

export interface RelayPassClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): () => void;
}

const systemClock: RelayPassClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
};

export interface RelayPassKeeperOptions {
  readonly stateDir: string;
  readonly identity: () => RelayIdentity | undefined;
  /** The account to name: the account of this PC's members, else the one a signed-in owner named (`relay/account.json`). */
  readonly account: () => string | null;
  readonly service: string | Error;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly clock?: RelayPassClock;
  readonly onPass: (pass: string) => void;
}

/** A Retry-After in ms, seconds or an HTTP date, at most RETRY_AFTER_CAP_MS; 0 when there is none that parses. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (value === null || value.trim() === "") return 0;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, RETRY_AFTER_CAP_MS) : 0;
}

/** A pass as kept, with the account service it came from: one from another service (a staging one) is never sent. */
interface Saved { pass: string; server_id: string; service: string; expires_at: number; refresh_at: number }

function readSaved(path: string): Saved | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isJsonObject(value) || typeof value.pass !== "string" || typeof value.server_id !== "string" || typeof value.service !== "string"
      || typeof value.expires_at !== "number" || typeof value.refresh_at !== "number") return null;
    return { pass: value.pass, server_id: value.server_id, service: value.service, expires_at: value.expires_at, refresh_at: value.refresh_at };
  } catch { return null; }
}

export class RelayPassKeeper {
  private reported: RelayPassState = "unavailable";
  get state(): RelayPassState { return this.reported === "ok" && this.current() === null ? "unavailable" : this.reported; }
  set state(value: RelayPassState) { this.reported = value; }
  private saved: Saved | null;
  refusal: "not_listed" | "limit" | null = null;
  private again = false;
  private inflight: AbortController | undefined;
  private cancel: (() => void) | undefined;
  private failures = 0;
  private asking: Promise<void> | undefined;
  private stopped = true;
  private readonly clock: RelayPassClock;
  private readonly path: string;

  constructor(private readonly options: RelayPassKeeperOptions) {
    this.clock = options.clock ?? systemClock;
    this.path = join(options.stateDir, "relay", "pass.json");
    this.saved = readSaved(this.path);
  }

  /**
   * The pass to send: one for this identity that has not expired, from the account service in use, or null. While that
   * service's address cannot be used, the one saved still holds (it then goes to Ovis's relays only: no staging one).
   */
  current(): string | null { return this.kept(0); }

  /**
   * The pass a relay that took it may still hold this PC to: `current`, and after that the same pass until the relay
   * stops honoring it, RELAY_PASS_SKEW_S past its expiry (`current` stops that long before it, so twice that after).
   * Never sent: read only for what it says of new client sessions (server/relay/link.ts), so a renewal that fails
   * leaves no last minutes in which the PC forgets a limit the relay still holds. Timed from receipt, as `current` is.
   */
  honored(): string | null { return this.kept(2 * RELAY_PASS_SKEW_S * 1000); }

  private kept(past: number): string | null {
    const saved = this.saved;
    const identity = this.options.identity();
    const service = this.options.service;
    if (!saved || !identity || saved.server_id !== identity.server_id || this.clock.now() >= saved.expires_at + past) return null;
    return typeof service === "string" && saved.service !== service ? null : saved.pass;
  }

  /** The account service that signed the pass `honored` gives (`current`'s too), which decides the relays it may go to; null with none. */
  issuer(): string | null {
    const saved = this.saved;
    return saved !== null && this.honored() !== null ? saved.service : null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this.current() !== null) this.state = "ok";
    const due = this.current() === null ? 0 : Math.max(0, this.saved!.refresh_at - this.clock.now());
    this.schedule(due);
  }

  stop(): void {
    this.stopped = true;
    this.cancel?.();
    this.cancel = undefined;
    this.inflight?.abort();
  }

  private lastRejected = Number.NEGATIVE_INFINITY;
  private replacement: string | null = null;
  private replacing = false;

  /**
   * The relay refused the pass this PC holds (its key changed, the PC was revoked, a clock is off):
   * drop it and ask for a new one now, at most once a minute (a pass the relay keeps refusing then
   * waits for the usual backoff, so the PC never loops between the two services).
   */
  rejected(): Promise<void> {
    // a fresh pass refused as well (the relay does not trust the service's key yet, say): keep it and back off
    if (this.saved !== null && this.saved.pass === this.replacement) { if (!this.stopped) this.failed(null, false); return Promise.resolve(); }
    this.saved = null;
    try { rmSync(this.path, { force: true }); } catch { /* gone from memory either way */ }
    if (this.stopped) return Promise.resolve();
    const now = this.clock.now();
    if (now - this.lastRejected < RETRY_MS) { this.failed(null, false); return Promise.resolve(); }
    this.lastRejected = now;
    this.replacing = true;
    return this.refresh();
  }

  private notBefore = 0;

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.cancel?.();
    this.cancel = undefined;
    return this.askWhenAllowed();
  }

  private askWhenAllowed(): Promise<void> {
    const wait = this.notBefore - this.clock.now();
    if (wait > 0) { this.schedule(wait); return Promise.resolve(); }
    return this.ask();
  }

  private schedule(ms: number): void {
    this.cancel?.();
    this.cancel = this.clock.setTimeout(() => { void this.askWhenAllowed(); }, ms);
  }

  private ask(): Promise<void> {
    if (this.asking) { this.again = true; return this.asking; }
    this.asking = this.request().finally(() => {
      this.asking = undefined;
      this.replacing = false;
      if (this.again && !this.stopped) { this.again = false; void this.askWhenAllowed(); }
    });
    return this.asking;
  }

  private async request(): Promise<void> {
    const identity = this.options.identity();
    const service = this.options.service;
    const account = this.options.account();
    if (this.stopped) return;
    // with the service's address unusable nothing can be asked; a saved pass that still holds is still the one in use
    if (!identity || service instanceof Error) { this.state = this.current() !== null ? "ok" : "unavailable"; return; }
    if (account === null) {
      this.state = this.current() !== null ? "ok" : "no_account";
      this.schedule(WAIT_ACCOUNT_MS);
      return;
    }
    const fetcher = this.options.fetch ?? ((request: Request) => fetch(request));
    const inflight = new AbortController();
    this.inflight = inflight;
    const signal = AbortSignal.any([inflight.signal, AbortSignal.timeout(REQUEST_MS)]);
    const post = (path: string, body: unknown) => fetcher(new Request(`${service}${path}`, {
      // never followed: a redirect would carry the proof and the account to another origin
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal, redirect: "manual",
    }));
    try {
      const publicKey = bytesToHex(importPublicKey(identity.public_key));
      const challenge = await post("/v1/pc/challenge", { server_id: identity.server_id, public_key: publicKey });
      if (!challenge.ok) return this.failed(challenge);
      const { challenge_id: challengeId, frame } = await challenge.json() as { challenge_id?: unknown; frame?: unknown };
      const answer = answerServerChallenge(frame, importSecretKey(identity.secret_key), { server_id: identity.server_id, role: "account", connection_id: typeof challengeId === "string" ? challengeId : null });
      if (!answer || typeof challengeId !== "string") return this.failed(null);
      // the pass forms this PC reads (shared/relay-pass.ts): the service signs v2 only for a PC that names it
      const response = await post("/v1/pc/relay-pass", { server_id: identity.server_id, challenge_id: challengeId, proof: answer, account, pass_versions: [1, 2] });
      if (this.stopped) return;
      if (response.status === 403 || response.status === 409) {
        const code = ((await response.json().catch(() => null)) as { error?: { code?: unknown } } | null)?.error?.code;
        this.state = code === "relay_limit" ? "limit" : "not_listed";
        this.refusal = this.state;
        if (this.current() !== null) this.state = "ok";
        this.schedule(WAIT_ACCOUNT_MS);
        return;
      }
      if (!response.ok) return this.failed(response);
      const body = await response.json() as { pass?: unknown; expires_in?: unknown; refresh_in?: unknown };
      const parsed = parseRelayPass(body.pass);
      const expiresIn = body.expires_in;
      const refreshRaw = body.refresh_in;
      // a lifetime the relay would honor; the renewal time held to 60 s .. 24 h and before the pass runs out
      if (!parsed || parsed.payload.sid !== identity.server_id || typeof expiresIn !== "number" || typeof refreshRaw !== "number"
        || !Number.isFinite(expiresIn) || !Number.isFinite(refreshRaw) || expiresIn > RELAY_PASS_LIFETIME_S
        || expiresIn - RELAY_PASS_SKEW_S < MIN_REFRESH_S) return this.failed(null);
      const refreshIn = Math.min(Math.max(refreshRaw, MIN_REFRESH_S), MAX_REFRESH_S, expiresIn - RELAY_PASS_SKEW_S);
      const now = this.clock.now();
      // timed from receipt, so this PC's own clock needs to be right only to within the relay's skew
      const saved: Saved = { pass: body.pass as string, server_id: identity.server_id, service,
        expires_at: now + (expiresIn - RELAY_PASS_SKEW_S) * 1000, refresh_at: now + refreshIn * 1000 };
      this.saved = saved;
      try { writePrivateState(this.path, saved); } catch {}
      this.failures = 0;
      this.notBefore = 0;
      this.refusal = null;
      this.replacement = this.replacing ? saved.pass : null;
      this.state = "ok";
      this.options.onPass(saved.pass);
      this.schedule(refreshIn * 1000);
    } catch { this.failed(null); }
    finally { if (this.inflight === inflight) this.inflight = undefined; }
  }

  private failed(response: Response | null, gate = true): void {
    if (this.stopped) return;
    if (gate && this.current() === null) this.state = "unavailable";
    const backoff = Math.min(RETRY_CAP_MS, RETRY_MS * 2 ** this.failures++);
    const delay = Math.max(retryAfterMs(response?.headers.get("retry-after") ?? null), backoff);
    if (gate) this.notBefore = this.clock.now() + delay;
    this.schedule(Math.max(delay, this.notBefore - this.clock.now()));
  }
}
