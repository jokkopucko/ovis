import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { storeAgentVersion, type ByteReader } from "./agent-version.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "skill-invocations");
const WINDOW = 64 * 1024;
const TEN_MB = 10 * 1024 * 1024;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-version-"));
  roots.push(root);
  return root;
}

function counting(): ByteReader & { bytes: number } {
  const reader = {
    bytes: 0,
    size: (path: string) => statSync(path).size,
    read(path: string, position: number, length: number) {
      const fd = openSync(path, "r");
      try {
        const buffer = new Uint8Array(length);
        const read = readSync(fd, buffer, 0, length, position);
        reader.bytes += read;
        return buffer.subarray(0, read);
      } finally { closeSync(fd); }
    },
  };
  return reader;
}

function filler(bytes: number): string {
  const line = `${JSON.stringify({ type: "progress", data: "x".repeat(1000) })}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

describe("storeAgentVersion", () => {
  it("reads the recorded fixtures' versions", () => {
    expect(storeAgentVersion("claude", { path: join(FIXTURES, "claude.jsonl") })).toBe("2.1.301");
    expect(storeAgentVersion("codex", { path: join(FIXTURES, "codex.jsonl") })).toBe("0.162.1");
  });

  it("reads a 10 MB Codex rollout's version from at most its first 64 KiB", () => {
    const path = join(temp(), "rollout.jsonl");
    const meta = readFileSync(join(FIXTURES, "codex.jsonl"), "utf8").split("\n")[0]!;
    writeFileSync(path, `${meta}\n${filler(TEN_MB)}`);
    const reader = counting();
    expect(storeAgentVersion("codex", { path }, reader)).toBe("0.162.1");
    expect(reader.bytes).toBeGreaterThan(0);
    expect(reader.bytes).toBeLessThanOrEqual(WINDOW);
  });

  it("reads the version of a session_meta line longer than the window, within the window", () => {
    const path = join(temp(), "rollout.jsonl");
    const meta = { timestamp: "2026-10-14T15:23:59.850Z", type: "session_meta", payload: { id: "s", cwd: "/w", cli_version: "0.162.1", base_instructions: { text: "x".repeat(200 * 1024) } } };
    writeFileSync(path, `${JSON.stringify(meta)}\n${filler(1024)}`);
    const reader = counting();
    expect(storeAgentVersion("codex", { path }, reader)).toBe("0.162.1");
    expect(reader.bytes).toBeLessThanOrEqual(WINDOW);
    writeFileSync(path, `${JSON.stringify({ type: "turn_context", payload: { cli_version: "0.162.1", text: "x".repeat(WINDOW) } })}\n`);
    expect(storeAgentVersion("codex", { path })).toBeNull();
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { text: "x".repeat(WINDOW), cli_version: "0.162.1" } })}\n`);
    expect(storeAgentVersion("codex", { path })).toBeNull();
  });

  it("reads a 10 MB Claude transcript from at most its last 64 KiB", () => {
    const dir = temp();
    const tail = readFileSync(join(FIXTURES, "claude.jsonl"), "utf8");
    const recent = join(dir, "recent.jsonl");
    writeFileSync(recent, `${filler(TEN_MB)}${tail}`);
    const reader = counting();
    expect(storeAgentVersion("claude", { path: recent }, reader)).toBe("2.1.301");
    expect(reader.bytes).toBeGreaterThan(0);
    expect(reader.bytes).toBeLessThanOrEqual(WINDOW);
    const old = join(dir, "old.jsonl");
    writeFileSync(old, `${JSON.stringify({ type: "user", version: "2.0.1" })}\n${filler(TEN_MB)}`);
    const again = counting();
    expect(storeAgentVersion("claude", { path: old }, again)).toBeNull();
    expect(again.bytes).toBeLessThanOrEqual(WINDOW);
  });

  it("reads each transcript on its own: no version carries over from another file", () => {
    const dir = temp();
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, `${JSON.stringify({ type: "user", version: "2.1.301" })}\n`);
    writeFileSync(b, `${JSON.stringify({ type: "user" })}\n`);
    expect(storeAgentVersion("claude", { path: a })).toBe("2.1.301");
    expect(storeAgentVersion("claude", { path: b })).toBeNull();
    writeFileSync(a, `${JSON.stringify({ type: "user", version: "2.2.0" })}\n`);
    expect(storeAgentVersion("claude", { path: a })).toBe("2.2.0");
  });

  it("returns null for a malformed record, a missing file and an agent without a stored version", () => {
    const dir = temp();
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, '{"type":"session_meta","payload":{"cli_version":"0.1\n');
    expect(storeAgentVersion("codex", { path: bad })).toBeNull();
    expect(storeAgentVersion("claude", { path: bad })).toBeNull();
    const wrong = join(dir, "wrong.jsonl");
    writeFileSync(wrong, `${JSON.stringify({ type: "turn_context", payload: { cli_version: "0.162.1" } })}\n`);
    expect(storeAgentVersion("codex", { path: wrong })).toBeNull();
    writeFileSync(wrong, `${JSON.stringify({ type: "user", version: 2 })}\n`);
    expect(storeAgentVersion("claude", { path: wrong })).toBeNull();
    expect(storeAgentVersion("claude", { path: join(dir, "absent.jsonl") })).toBeNull();
    expect(storeAgentVersion("claude", { path: dir })).toBeNull();
    expect(storeAgentVersion("codex", { path: dir })).toBeNull();
    const failing: ByteReader = { size: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); }, read: () => new Uint8Array() };
    expect(storeAgentVersion("claude", { path: bad }, failing)).toBeNull();
    expect(storeAgentVersion("pi", { path: join(FIXTURES, "claude.jsonl") })).toBeNull();
    expect(storeAgentVersion("claude", null)).toBeNull();
  });

  it("reads the version of the OpenCode session the pane is bound to, and only that one", () => {
    const dir = temp();
    // the reader's tables in server/opencode.ts, 2.x and 1.x (columns it never touches left out)
    const v2 = join(dir, "v2.db");
    const db2 = new Database(v2);
    db2.exec("CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text, version text NOT NULL, revert text, time_created integer NOT NULL, time_updated integer NOT NULL); CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
    db2.query("INSERT INTO session_v2 (id, project_id, slug, directory, version, time_created, time_updated) VALUES (?, 'p', 's', '/tmp', '2.0.24', 1, 1)").run("ses_bound");
    db2.close();
    expect(storeAgentVersion("opencode", { path: v2, sessionId: "ses_bound" })).toBe("2.0.24");
    expect(storeAgentVersion("opencode", { path: v2, sessionId: "ses_other" })).toBeNull();
    expect(storeAgentVersion("opencode", { path: v2 })).toBeNull();

    const v1 = join(dir, "v1.db");
    const db1 = new Database(v1);
    db1.exec("CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, revert text, model text, time_created integer NOT NULL, time_updated integer NOT NULL); CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL); CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
    const recorded = JSON.parse(readFileSync(join(FIXTURES, "opencode.jsonl"), "utf8").split("\n")[0]!) as { row: Record<string, string | number> };
    const row = recorded.row;
    db1.query("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(row.id!, row.project_id!, row.slug!, row.directory!, row.title!, row.version!, row.time_created!, row.time_updated!);
    db1.close();
    expect(storeAgentVersion("opencode", { path: v1, sessionId: String(row.id) })).toBe("1.17.15");
    expect(storeAgentVersion("opencode", { path: v1, sessionId: "ses_other" })).toBeNull();
    expect(storeAgentVersion("opencode", { path: join(dir, "absent.db"), sessionId: "ses_bound" })).toBeNull();
  });
});
