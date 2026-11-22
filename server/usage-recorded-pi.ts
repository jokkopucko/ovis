/**
 * Both grew from pi: each keeps an agent.db that is opened the same way here, and both name Claude's limits alike
 * ("anthropic:5h", "anthropic:7d", "anthropic:7d:<model>").
 */
import { Database, SQLiteError, constants } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { RecordedWindow } from "./usage-recorded.ts";

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86400;
/** A clock a little ahead of this one is no reason to drop a record; a time further ahead is not one the tool read at. */
export const AHEAD_MS = 60_000;
/** A store in use is read through its write-ahead log without waiting; should it still be busy, this long and no longer. */
const BUSY_TIMEOUT_MS = 250;
/** Epoch milliseconds are past this since 2001; epoch seconds stay below it for millennia. */
export const EPOCH_MS_FROM = 1e12;

/**
 * Opens a tool's store for reading. While the tool has it open its write-ahead log lies beside it (`-wal`, `-shm`),
 * and the store is read through that log, so a report written a moment ago is read. Otherwise the file is opened as
 * one that does not change: SQLite then makes no `-wal` and `-shm` of its own, and the folder stays as the tool left it.
 * That holds for a log left without its `-shm` too (a store copied or restored that way): SQLite would make the
 * missing file to read it, so what only that log holds is not seen until the tool opens its store again, as with an
 * agent's history (liveLog in session-history.ts).
 */
function openForReading(path: string): Database {
  if (existsSync(`${path}-wal`) && existsSync(`${path}-shm`)) return new Database(path, { readonly: true, create: false });
  return new Database(`${pathToFileURL(path).href}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
}

export function readStore<T>(path: string, read: (db: Database) => T): T | null {
  // only a regular file is a store: opening a FIFO left at this path would wait for a writer
  try { if (!statSync(path).isFile()) return null; } catch { return null; }
  let db: Database | undefined;
  try {
    db = openForReading(path);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    return read(db);
  } catch (error) {
    if (error instanceof SQLiteError) return null;
    throw error;
  } finally {
    db?.close();
  }
}

export function claudeLimit(id: string, label: string): Pick<RecordedWindow, "kind" | "scope" | "seconds"> | null {
  if (id === "anthropic:5h") return { kind: "session", scope: null, seconds: FIVE_HOURS };
  if (id === "anthropic:7d") return { kind: "week", scope: null, seconds: SEVEN_DAYS };
  const model = /^anthropic:7d:(.+)$/.exec(id)?.[1];
  if (model === undefined) return null;
  // the label names the model as the provider spells it: "Claude 7 Day (Fable)"
  return { kind: "week", scope: /\(([^()]+)\)\s*$/.exec(label)?.[1]?.trim() || model, seconds: SEVEN_DAYS };
}

export function resetOf(reset: number | null, readAt: number, seconds: number): number | null {
  return reset !== null && reset >= EPOCH_MS_FROM && reset <= readAt + seconds * 1000 + AHEAD_MS ? reset : null;
}

export function byLength(a: RecordedWindow, b: RecordedWindow): number {
  return a.seconds - b.seconds || Number(a.scope !== null) - Number(b.scope !== null) || ((a.scope ?? "") < (b.scope ?? "") ? -1 : 1);
}
