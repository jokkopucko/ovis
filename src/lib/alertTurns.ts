import type { AlertSoundKind } from "./alertSound.ts";

const WINDOW_MS = 150;
const LOOKBACK_MS = 1_500;
const RESCUE_MS = 600;
const PLAYING_HOLD_MS = 5_000;
const CHIMED_BEFORE_MS = 400;
const CHANNEL = "ovis:alert-turns";

export interface AlertTurnMessage {
  type: "claim" | "playing" | "chimed" | "withdraw";
  tab: string;
  key: string;
  kind: AlertSoundKind;
}
interface Play { type: "play"; key: string; kind: AlertSoundKind }
interface Pending { kind: AlertSoundKind; due: number; rescue: boolean }

export class AlertTurns {
  private claims = new Map<string, Map<string, number>>();
  private chimed = new Map<string, number>();
  private pending = new Map<string, Pending>();
  private played = new Map<string, number>();
  private announced = new Map<string, number>();
  constructor(private tab: string) {}

  start(key: string, kind: AlertSoundKind, now: number): AlertTurnMessage[] {
    this.prune(now);
    const chimedAt = this.chimed.get(key);
    if (this.pending.has(key) || (chimedAt !== undefined && now - chimedAt <= CHIMED_BEFORE_MS)) return [];
    this.pending.set(key, { kind, due: now + WINDOW_MS, rescue: false });
    return [{ type: "claim", tab: this.tab, key, kind }];
  }

  receive(message: AlertTurnMessage, now: number): Play[] {
    this.prune(now);
    if (message.tab === this.tab) return [];
    switch (message.type) {
      case "claim": {
        const claims = this.claims.get(message.key) ?? new Map<string, number>();
        claims.set(message.tab, now);
        this.claims.set(message.key, claims);
        return [];
      }
      case "playing": {
        this.announced.set(message.key, now);
        const pending = this.pending.get(message.key);
        if (pending?.rescue && Number.isFinite(pending.due)) pending.due = Math.max(pending.due, now + this.hold(message.key));
        return [];
      }
      case "chimed":
        // A tab that heard the alert late chimed it again after this one did. That duplicate
        // tells nothing new, and taking it for a chime could silence the pane's next question.
        // While this tab waits on the pane's next alert, though, a chime is that alert's, or
        // ignoring it would let this tab's rescue chime it a second time.
        if (this.played.has(message.key) && !this.pending.has(message.key)) return [];
        this.chimed.set(message.key, now);
        this.claims.delete(message.key);
        this.announced.delete(message.key);
        // Cancel the actual pending turn, not just its short-lived lookback. A suspended
        // tab may not get its timer back until long after the lookback has expired.
        this.pending.delete(message.key);
        return [];
      case "withdraw": {
        this.claims.get(message.key)?.delete(message.tab);
        this.announced.delete(message.key);
        const pending = this.pending.get(message.key);
        if (pending?.rescue && Number.isFinite(pending.due) && !this.lowerClaim(message.key)) pending.due = now;
        return this.tick(now);
      }
    }
  }

  tick(now: number): Play[] {
    this.prune(now);
    const plays: Play[] = [];
    for (const [key, pending] of this.pending) {
      if (pending.due > now) continue;
      if (!pending.rescue && this.lowerClaim(key)) {
        // Each lower claimant gets its own turn first, so two deferring tabs never rescue together.
        pending.rescue = true;
        pending.due = now + Math.max(RESCUE_MS * this.lowerClaims(key), this.announced.has(key) ? this.hold(key) : 0);
        continue;
      }
      pending.due = Infinity;
      plays.push({ type: "play", key, kind: pending.kind });
    }
    return plays;
  }

  announce(key: string, kind: AlertSoundKind): AlertTurnMessage {
    return { type: "playing", tab: this.tab, key, kind };
  }

  finish(key: string, played: boolean, now: number): AlertTurnMessage[] {
    this.prune(now);
    const pending = this.pending.get(key);
    if (!pending) return [];
    this.pending.delete(key);
    if (played) this.played.set(key, now);
    return [{ type: played ? "chimed" : "withdraw", tab: this.tab, key, kind: pending.kind }];
  }

  clear(): AlertTurnMessage[] {
    const messages: AlertTurnMessage[] = [...this.pending].map(([key, pending]) =>
      ({ type: "withdraw", tab: this.tab, key, kind: pending.kind }));
    this.pending.clear();
    this.claims.clear();
    this.chimed.clear();
    this.played.clear();
    this.announced.clear();
    return messages;
  }

  has(key: string): boolean {
    return this.pending.has(key);
  }

  get deadline(): number {
    return Math.min(...[...this.pending.values()].map((pending) => pending.due));
  }

  private hold(key: string): number {
    return PLAYING_HOLD_MS + RESCUE_MS * Math.max(0, this.lowerClaims(key) - 1);
  }

  private lowerClaim(key: string): boolean {
    return this.lowerClaims(key) > 0;
  }

  private lowerClaims(key: string): number {
    return [...(this.claims.get(key)?.keys() ?? [])].filter((tab) => tab < this.tab).length;
  }

  private prune(now: number): void {
    for (const [key, claims] of this.claims) {
      for (const [tab, at] of claims) if (now - at > LOOKBACK_MS) claims.delete(tab);
      if (claims.size === 0) this.claims.delete(key);
    }
    for (const [key, at] of this.chimed) if (now - at > LOOKBACK_MS) this.chimed.delete(key);
    for (const [key, at] of this.played) if (now - at > LOOKBACK_MS) this.played.delete(key);
    for (const [key, at] of this.announced) if (now - at > PLAYING_HOLD_MS) this.announced.delete(key);
  }
}

function isMessage(value: unknown): value is AlertTurnMessage {
  if (!value || typeof value !== "object") return false;
  return "type" in value && typeof value.type === "string" && ["claim", "playing", "chimed", "withdraw"].includes(value.type)
    && "tab" in value && typeof value.tab === "string"
    && "key" in value && typeof value.key === "string"
    && "kind" in value && (value.kind === "blocked" || value.kind === "done");
}

/** Browser wiring. No Web Locks or secure-context-only UUID API: LAN HTTP works too. */
export function createAlertTurnPlayer(options: {
  play: (kind: AlertSoundKind, key: string) => boolean | Promise<boolean>;
  channel?: BroadcastChannel | null;
}) {
  const turns = new AlertTurns([...crypto.getRandomValues(new Uint32Array(4))].join("-"));
  const open = () => options.channel !== undefined ? options.channel
    : typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
  let channel = open();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  const playing = new Map<string, object>();
  const send = (messages: AlertTurnMessage[]) => {
    for (const message of messages) channel?.postMessage(message);
  };
  const schedule = () => {
    clearTimeout(timer);
    if (Number.isFinite(turns.deadline)) timer = setTimeout(() => run(turns.tick(performance.now())), Math.max(0, turns.deadline - performance.now()));
  };
  const run = (plays: Play[]) => {
    for (const { key, kind } of plays) {
      const attempt = {};
      playing.set(key, attempt);
      send([turns.announce(key, kind)]);
      const finish = (played: boolean) => {
        if (playing.get(key) !== attempt) return;
        playing.delete(key);
        send(turns.finish(key, played, performance.now()));
      };
      const result = options.play(kind, key);
      if (typeof result === "boolean") finish(result);
      else void result.then(finish);
    }
    schedule();
  };
  const listen = () => {
    if (channel) channel.onmessage = (event: MessageEvent<unknown>) => {
      if (!isMessage(event.data)) return;
      const plays = turns.receive(event.data, performance.now());
      // Only a chime that settled the alert ends this tab's attempt. An ignored late duplicate
      // leaves it, or its result could never clear the pending alert and the pane went silent.
      if (event.data.type === "chimed" && !turns.has(event.data.key)) playing.delete(event.data.key);
      run(plays);
    };
  };
  listen();
  const hide = () => {
    active = false;
    clearTimeout(timer);
    playing.clear();
    send(turns.clear());
    channel?.close();
    channel = null;
  };
  const show = () => {
    if (active) return;
    active = true;
    channel = open();
    listen();
  };
  globalThis.addEventListener?.("pagehide", hide);
  globalThis.addEventListener?.("pageshow", show);
  return {
    chime(key: string, kind: AlertSoundKind) {
      if (!active) return;
      if (!channel) { options.play(kind, key); return; }
      send(turns.start(key, kind, performance.now()));
      schedule();
    },
    dispose() {
      hide();
      globalThis.removeEventListener?.("pagehide", hide);
      globalThis.removeEventListener?.("pageshow", show);
    },
  };
}
