import type { InstalledNotes, ReleaseHighlights, ReleaseNote, SummaryLanguage, UpdateNotes, UpdateStatus } from "../../shared/update.ts";
import { ApiError } from "./api.ts";

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
 * A check reports nothing available while it runs, so `available` is not asked: the notes must not
 * leave every five minutes under someone reading them.
 */
export function offeredNotes(
  status: Pick<UpdateStatus, "current_revision" | "latest_revision"> | null,
  notes: UpdateNotes | null,
): UpdateNotes | null {
  if (!status || !notes || notes.releases.length === 0) return null;
  if (!status.latest_revision || status.latest_revision === status.current_revision) return null;
  return notes.revision === status.latest_revision ? notes : null;
}

export function notesOffer(
  status: Pick<UpdateStatus, "current_revision" | "latest_revision" | "current_version" | "latest_version"> | null,
): string | null {
  if (!status?.latest_revision || status.latest_revision === status.current_revision) return null;
  return [status.latest_revision, status.latest_version, status.current_revision, status.current_version].join(" ");
}

const retryDelay = (attempt: number): number => Math.min(30_000, 2000 * 2 ** Math.min(attempt, 4));
const UNBOUND_RETRIES = 5;

/**
 * A bridge that just restarted has not heard from its supervisor yet, and a check may be between two
 * releases: both pass within seconds. A supervisor older than the notes never names a commit, so the
 * asking ends, after about a minute.
 */
export function notesUnboundDelay(attempt: number): number | null {
  return attempt < UNBOUND_RETRIES ? retryDelay(attempt) : null;
}

export function notesRetryDelay(error: unknown, attempt: number): number | null {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return null;
  return retryDelay(attempt);
}

export function summaryFor(release: Pick<ReleaseNote, "summary">, language: SummaryLanguage): ReleaseHighlights | null {
  return release.summary?.[language] ?? release.summary?.en ?? null;
}

export function installedUpdate(
  status: Pick<UpdateStatus, "current_revision"> | null,
  installed: InstalledNotes | null,
): InstalledNotes | null {
  if (!status?.current_revision || !installed?.version || !installed.previous_version) return null;
  return installed.revision === status.current_revision ? installed : null;
}

export const ANNOUNCED_FOR_MS = 7 * 24 * 60 * 60_000;

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

export const SKEW_ALLOWANCE_MS = 24 * 60 * 60 * 1000;

const ANNOUNCED_KEY = "ovis:update-announced";

export function readAnnounced(): string | null {
  try { return window.localStorage.getItem(ANNOUNCED_KEY); } catch { return null; }
}

export function writeAnnounced(version: string): void {
  try { window.localStorage.setItem(ANNOUNCED_KEY, version); } catch {}
}

export function watchAnnounced(listener: (version: string | null) => void): () => void {
  return watchKey(ANNOUNCED_KEY, listener);
}

const OFFER_CLOSED_KEY = "ovis:update-offer-closed";

export function readOfferClosed(): string | null {
  try { return window.localStorage.getItem(OFFER_CLOSED_KEY); } catch { return null; }
}

export function writeOfferClosed(revision: string): void {
  try { window.localStorage.setItem(OFFER_CLOSED_KEY, revision); } catch {}
}

export function watchOfferClosed(listener: (revision: string | null) => void): () => void {
  return watchKey(OFFER_CLOSED_KEY, listener);
}

function watchKey(key: string, listener: (value: string | null) => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === key || event.key === null) listener(event.newValue); };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
