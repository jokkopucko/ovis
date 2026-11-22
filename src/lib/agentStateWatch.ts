/**
 * A page that was not running (a phone asleep, a laptop's lid shut, a tab the browser froze)
 * or that could not reach its server learns of what it missed all at once, later: stamped then, a
 * wait of an hour would say a minute.
 */
const BEAT_MS = 5_000;
/**
 * A hidden tab's timers run as seldom as once a minute: a longer silence is a page that was not
 * running, and a longer gap in what the page knew is one its times do not bridge. The stamps go by
 * the same measure for a pane missing from a roster (lib/agentStateSince.ts).
 */
export const BLIND_MS = 90_000;
/**
 * How long after a read took a silent stream at its word the stream may still prove to have been
 * dead: its socket probes the connection as the page comes back and drops one that does not answer
 * twice (lib/ws.ts, 3 s each at first).
 */
const VERDICT_MS = 30_000;

export type UnseenLook = "first" | "undated";

let knownAt: number | null = null;
let heardAt: number | null = null;
let beatAt: number | null = null;
let gaps = 0;
let stream: "none" | "opening" | "live" = "none";
let subscribed = false;
let trustedUntil: number | null = null;
let unseen: ((look: UnseenLook) => void) | null = null;

function beat(): number {
  const now = Date.now();
  if (beatAt !== null && now - beatAt > BLIND_MS) {
    gaps++;
    stream = "none";
  } else if (stream === "live") knownAt = now;
  beatAt = now;
  return now;
}

function whole(now: number, by: "read" | "opening" | "stream"): void {
  const look: UnseenLook | null = knownAt !== null && now - knownAt > BLIND_MS ? "first"
    : by !== "stream" && heardAt !== null && now - heardAt > BLIND_MS ? "undated" : null;
  knownAt = now;
  heardAt = now;
  trustedUntil = by !== "read" ? null : look === "undated" ? now + VERDICT_MS : trustedUntil;
  if (look !== null) unseen?.(look);
}

export const stateWatch = {
  asked(): number {
    beat();
    return gaps;
  },
  read(asked: number): void {
    const now = beat();
    if (asked !== gaps) return;
    whole(now, "read");
    if (subscribed && stream === "none") stream = "live";
  },
  subscription(update: "opened" | "lost" | "closed"): void {
    const now = beat();
    if (update !== "opened") {
      if (trustedUntil !== null && now <= trustedUntil) unseen?.("first");
      else if (knownAt !== null && heardAt !== null && heardAt < knownAt) knownAt = heardAt;
    }
    trustedUntil = null;
    subscribed = update === "opened";
    stream = subscribed ? "opening" : "none";
  },
  heard(): void {
    const now = beat();
    if (stream !== "live") return;
    heardAt = now;
    trustedUntil = null;
  },
  pushed(): void {
    const now = beat();
    if (stream === "none") return;
    const by = stream === "opening" ? "opening" : "stream";
    stream = "live";
    whole(now, by);
  },
  blind(): boolean {
    const now = beat();
    return knownAt !== null && now - knownAt > BLIND_MS;
  },
  /**
   * The watch has one keeper at a time: keeping it starts it anew, so a second keeper would take the first one's
   * knowledge with it.
   */
  keep(look: (look: UnseenLook) => void): () => void {
    unseen = look;
    knownAt = null;
    heardAt = null;
    beatAt = null;
    stream = "none";
    subscribed = false;
    trustedUntil = null;
    beat();
    const timer = setInterval(beat, BEAT_MS);
    return () => {
      clearInterval(timer);
      if (unseen === look) unseen = null;
    };
  },
};
