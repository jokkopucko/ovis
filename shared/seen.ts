/**
 * A finish some browser of this server presented (src/lib/sidebarActivity.tsx decides when), so
 * every browser of the server draws it as read. POST /api/seen records one; GET /api/seen lists
 * them; each browser gets the list, then every change, as `seen` events on /api/machines/events.
 * Keyed by `(pc, epoch, pane)` as the browser's own record (src/lib/seenFinishes.ts): the greatest
 * finish ID wins, and an equal ID only gains the answer fingerprint it lacked.
 */
export interface SeenFinish { pc: string; epoch: string; pane: string; id: number; answer?: string }

/**
 * Sent beside a finish in POST /api/seen, never stored: whether its pane just came into view (`new`:
 * selected, uncovered, or the page shown again) or was already in front when the finish arrived
 * (`held`). On herdr-core, only a new presentation writes `herdr.seen` again for a turn already
 * written, so a pane left on screen does not overrule a "mark unread" from another Herdr client,
 * while a person coming back to it does. Absent (an older browser) or a word this server does not
 * know counts as `held`.
 */
export type SeenPresentation = "new" | "held";

export const seenPresentationOf = (raw: unknown): SeenPresentation | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const presented = (raw as Record<string, unknown>)["presented"];
  return presented === "new" || presented === "held" ? presented : undefined;
};

/** records the server keeps, oldest first out: one per pane per herdr run, so far more than are ever open */
export const MAX_SEEN = 500;
const MAX_NAME_LENGTH = 300;
/** the completed-answer fingerprint (src/lib/panePresentation.ts answerIdentity): source, history id, time, revision */
const MAX_ANSWER_LENGTH = 2048;
export const MAX_SEEN_BYTES = 8 * 1024;

const name = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH;

/** One record of a body or a stored file, cut to its fields; null when the shape is wrong. */
export function seenFinishBody(raw: unknown): SeenFinish | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { pc, epoch, pane, id, answer } = raw as Record<string, unknown>;
  if (!name(pc) || !name(epoch) || !name(pane) || typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return null;
  if (answer !== undefined && (typeof answer !== "string" || answer.length > MAX_ANSWER_LENGTH)) return null;
  return { pc, epoch, pane, id, ...(answer === undefined ? {} : { answer }) };
}

/** What `incoming` makes of the record held for its key, or null when it changes nothing. */
export function mergeSeen(held: SeenFinish | undefined, incoming: SeenFinish): SeenFinish | null {
  if (!held || incoming.id > held.id) return incoming;
  if (incoming.id === held.id && held.answer === undefined && incoming.answer !== undefined) return { ...held, answer: incoming.answer };
  return null;
}

export const seenFinishKey = (finish: Pick<SeenFinish, "pc" | "epoch" | "pane">): string => JSON.stringify([finish.pc, finish.epoch, finish.pane]);
