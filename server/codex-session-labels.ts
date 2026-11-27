import type { Database } from "bun:sqlite";
import { readSync } from "node:fs";

/** Codex appends name changes; the last entry, including a cleared name, wins. */
export function codexIndexedNames(fd: number, size: number, maxBytes: number): ReadonlyMap<string, string> {
  const offset = Math.max(0, size - maxBytes);
  const boundary = offset > 0 ? 1 : 0;
  const buffer = Buffer.alloc(size - offset + boundary);
  const length = readSync(fd, buffer, 0, buffer.length, offset - boundary);
  const names = new Map<string, string>();
  const lines = buffer.toString("utf8", boundary, length).split("\n");
  // The preceding byte distinguishes a partial record from a line that starts at the boundary.
  for (const line of boundary === 0 || buffer[0] === 0x0a ? lines : lines.slice(1)) {
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch (error) { if (error instanceof SyntaxError) continue; throw error; }
    if (entry && typeof entry === "object" && "id" in entry && "thread_name" in entry
      && typeof entry.id === "string" && typeof entry.thread_name === "string") {
      names.set(entry.id.toLowerCase(), entry.thread_name);
    }
  }
  return names;
}

type Label = { readonly name: string | null; readonly legacyTitle: string | null; readonly firstMessage: string | null };

/** Only read metadata for the bounded set of interactive rollouts already selected. */
export function codexStoredLabels(db: Database, ids: readonly string[], limits: { readonly title: number; readonly message: number }): ReadonlyMap<string, Label> {
  if (ids.length === 0) return new Map();
  const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('threads')").all().map(({ name }) => name));
  if (!columns.has("id")) return new Map();
  // In current Codex schemas, title can be a prompt preview even when no name was saved.
  // substr would turn a number into text: only text values count
  const textOf = (column: string, limit: number) => `CASE WHEN typeof(${column}) = 'text' THEN substr(${column}, 1, ${limit}) END`;
  const name = columns.has("name") ? textOf("name", limits.title) : "NULL";
  const legacyTitle = !columns.has("name") && columns.has("title") ? textOf("title", limits.title) : "NULL";
  const first = columns.has("first_user_message") ? textOf("first_user_message", limits.message) : "NULL";
  const labels = db.query<{ readonly id: unknown; readonly name: unknown; readonly legacyTitle: unknown; readonly firstMessage: unknown }, string[]>(
    `SELECT id, ${name} AS name, ${legacyTitle} AS legacyTitle, ${first} AS firstMessage
     FROM threads WHERE id COLLATE NOCASE IN (${ids.map(() => "?").join(", ")}) LIMIT ${ids.length}`,
  ).all(...ids);
  const text = (value: unknown) => typeof value === "string" ? value : null;
  const byId = new Map<string, Label>();
  for (const { id, name, legacyTitle, firstMessage } of labels) {
    if (typeof id === "string") byId.set(id.toLowerCase(), { name: text(name), legacyTitle: text(legacyTitle), firstMessage: text(firstMessage) });
  }
  return byId;
}
