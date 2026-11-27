import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";

const file = (stateDir: string) => join(stateDir, "codex-consumed.sqlite");
const LIMIT = 4096;
const fingerprint = (pane: string, text: string) => new Bun.CryptoHasher("sha256").update(JSON.stringify([pane, text])).digest("hex");

/** Commit before publishing `consumed`. At capacity keep the warning rather than evict an ID a browser can still replay. */
export function rememberCodexConsumed(stateDir: string, id: string, pane: string, text: string): boolean {
  const db = new Database(file(stateDir), { create: true });
  try {
    db.run("CREATE TABLE IF NOT EXISTS consumed (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) WITHOUT ROWID");
    return db.run("INSERT INTO consumed SELECT ?, ? WHERE (SELECT count(*) FROM consumed) < ?", [id, fingerprint(pane, text), LIMIT]).changes === 1;
  } finally { db.close(); }
}

/** An unknown ID may still be a recoverable held copy. An unreadable database is not evidence of that. */
export function codexConsumedReplay(stateDir: string, id: string, pane: string, text: string): "unknown" | "same" | "different" {
  const path = file(stateDir);
  if (!statSync(path, { throwIfNoEntry: false })) return "unknown";
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query<{ fingerprint: string }, [string]>("SELECT fingerprint FROM consumed WHERE id = ?").get(id);
    return !row ? "unknown" : row.fingerprint === fingerprint(pane, text) ? "same" : "different";
  } finally { db.close(); }
}
