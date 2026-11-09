import type { InstalledNotes, ReleaseHighlights, ReleaseNote, SummaryLanguage, UpdateNotes, UpdateStatus } from "../../shared/update.ts";
import { ApiError } from "./api.ts";

/**
 * Why this tab should be reloaded: "updated" when the server runs another commit than the one this
 * tab was built from, "incomplete" when a part of the app failed to load here (lib/lazyChunk.ts).
 * The second does not wait on the first: an unmanaged server names no commit, an older one may not
 * answer at all, a build outside Git has none, and a rebuild of the same commit compares equal,
 * yet the part is gone for this page until it is reloaded. Nothing while an update is underway.
 *
 * "restart" is "updated" where a reload cannot help: the server serves the files of a source
 * checkout that was rebuilt under it, and this tab is already that build, so a reload loads the
 * same build again. It ends when the server is restarted and reports the commit the tab was built
 * from. A part of this page that failed to load is still "incomplete": only a reload brings it.
 */
export type ReloadReason = "updated" | "restart" | "incomplete";
export function reloadReason(
  appRevision: string | null,
  status: Pick<UpdateStatus, "current_revision" | "served_revision"> | null,
  busy: boolean,
  chunkFailed: boolean,
): ReloadReason | null {
  if (busy) return null;
  if (appRevision && status?.current_revision && appRevision !== status.current_revision) {
    if (appRevision !== status.served_revision) return "updated";
    return chunkFailed ? "incomplete" : "restart";
  }
  return chunkFailed ? "incomplete" : null;
}

/**
 * The notes to show beside an offered update: those read from the very commit the status
 * offers, until it is installed. Null when there are none to show. A check reports nothing
 * available while it runs, so `available` is not asked: the notes must not leave every five
 * minutes under someone reading them. The commit is compared, not the version: a tag moved to
 * another commit has other notes, and a release with an empty section still brings the
 * sections of the releases skipped before it.
 */
export function offeredNotes(
  status: Pick<UpdateStatus, "current_revision" | "latest_revision"> | null,
  notes: UpdateNotes | null,
): UpdateNotes | null {
  if (!status || !notes || notes.releases.length === 0) return null;
  if (!status.latest_revision || status.latest_revision === status.current_revision) return null;
  return notes.revision === status.latest_revision ? notes : null;
}

/**
 * What the notes of an offer were read from, as one key: null when nothing is offered. The notes
 * are asked for once per key. The server picks the sections between the running version and the
 * release's, out of the release's commit: when any of the three moves (a tag added on the same
 * commit, an older build restored under the same offer), the answer is another.
 */
export function notesOffer(
  status: Pick<UpdateStatus, "current_revision" | "latest_revision" | "current_version" | "latest_version"> | null,
): string | null {
  if (!status?.latest_revision || status.latest_revision === status.current_revision) return null;
  return [status.latest_revision, status.latest_version, status.current_revision, status.current_version].join(" ");
}

const retryDelay = (attempt: number): number => Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4));
/** An answer for another commit, or for none, is asked for again this many times. */
const UNBOUND_RETRIES = 5;

/**
 * How long to wait before asking again after an answer that is not the offered commit's; null
 * when it is left at that. A bridge that just restarted has not heard from its supervisor yet,
 * and a check may be between two releases: both pass within seconds. A supervisor older than
 * the notes never names a commit, so the asking ends, after about a minute.
 */
export function notesUnboundDelay(attempt: number): number | null {
  return attempt < UNBOUND_RETRIES ? retryDelay(attempt) : null;
}

/**
 * How long to wait before asking for the notes again after a failed request; null when asking
 * again changes nothing. A dropped connection or a bridge that restarts passes. A server older
 * than the notes refuses the request itself (405), every time.
 */
export function notesRetryDelay(error: unknown, attempt: number): number | null {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null;
  return retryDelay(attempt);
}

/**
 * A release's highlights in the app's language, else in English; null for a release that wrote
 * none, whose changelog section is then what there is to read.
 */
export function summaryFor(release: Pick<ReleaseNote, "summary">, language: SummaryLanguage): ReleaseHighlights | null {
  return release.summary?.[language] ?? release.summary?.en ?? null;
}

/**
 * What the last update brought, to show once it runs: the answer for the very commit the status
 * reports, from one version to another. Null on a server no update installed.
 */
export function installedUpdate(
  status: Pick<UpdateStatus, "current_revision"> | null,
  installed: InstalledNotes | null,
): InstalledNotes | null {
  if (!status?.current_revision || !installed?.version || !installed.previous_version) return null;
  return installed.revision === status.current_revision ? installed : null;
}

/** How long the app-wide line tells of an update. Settings keeps its notes after that. */
export const ANNOUNCED_FOR_MS = 7 * 24 * 60 * 60_000;

/**
 * Whether the app-wide line still tells of the installed update: until this device has closed
 * it for that version, and for a week. A device that opens the app months later is told
 * nothing, and an update whose time is not known is left to Settings. While a newer release is
 * known the line is that release's, also during a check, which reports nothing available
 * while it runs.
 */
export function announcesUpdate(
  status: Pick<UpdateStatus, "current_revision" | "latest_revision"> | null,
  installed: InstalledNotes | null,
  dismissed: string | null,
  now: number,
): boolean {
  if (!installed?.version || installed.version === dismissed || installed.installed_at === null) return false;
  if (status?.latest_revision && status.latest_revision !== status.current_revision) return false;
  const at = Date.parse(installed.installed_at);
  // an install time in the future is a clock that was set back since: with a day's allowance for
  // skew, such a line is not shown, or it would stay as long as the clock had been ahead
  return Number.isFinite(at) && now - at >= -SKEW_ALLOWANCE_MS && now - at < ANNOUNCED_FOR_MS;
}

/** How far ahead of now an install time may be before it is read as a clock that was set back. */
export const SKEW_ALLOWANCE_MS = 24 * 60 * 60 * 1000;

const ANNOUNCED_KEY = "ovis:update-announced";

/** The version whose line this device closed. */
export function readAnnounced(): string | null {
  try { return window.localStorage.getItem(ANNOUNCED_KEY); } catch { return null; }
}

export function writeAnnounced(version: string): void {
  try { window.localStorage.setItem(ANNOUNCED_KEY, version); } catch { /* storage blocked: closed until the page reloads */ }
}

/** Tells `listener` the version another tab of this device closed the line for; returns the unsubscribe. */
export function watchAnnounced(listener: (version: string | null) => void): () => void {
  return watchKey(ANNOUNCED_KEY, listener);
}

// the line offering a release, closed on this device for that release (G-102): keyed by its revision, since a
// tag moved to another commit is a new offer, and shown again for the next one
const OFFER_CLOSED_KEY = "ovis:update-offer-closed";

/** The revision whose offer line this device closed. */
export function readOfferClosed(): string | null {
  try { return window.localStorage.getItem(OFFER_CLOSED_KEY); } catch { return null; }
}

export function writeOfferClosed(revision: string): void {
  try { window.localStorage.setItem(OFFER_CLOSED_KEY, revision); } catch { /* storage blocked: closed until the page reloads */ }
}

/** Tells `listener` the revision another tab of this device closed the offer for; returns the unsubscribe. */
export function watchOfferClosed(listener: (revision: string | null) => void): () => void {
  return watchKey(OFFER_CLOSED_KEY, listener);
}

function watchKey(key: string, listener: (value: string | null) => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) listener(event.newValue); };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
