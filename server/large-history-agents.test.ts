import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetTranscriptState, transcriptPage } from "./conversation.ts";

// Every agent's chat keeps reading past 64 MiB of history: pages bound each read, the file's size
// does not.
const dir = mkdtempSync(join(tmpdir(), "large-history-agents-"));
afterAll(() => { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); });
const pad = "x".repeat(512 * 1024);
const TURNS = 140;
const texts = (page: ReturnType<typeof transcriptPage>) => page.turns.flatMap((turn) => turn.parts).flatMap((part) => part.kind === "text" ? [part.text] : []);

function walk(source: "claude-transcript" | "codex-transcript", path: string, home?: string): Set<string> {
  expect(statSync(path).size).toBeGreaterThan(64 * 1024 * 1024);
  let page = transcriptPage(source, path, {}, home);
  expect(page.source).toBe(source);
  expect(texts(page).some((text) => text.startsWith(`answer ${TURNS - 1}`))).toBe(true);
  const prompts = new Set<string>();
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(200);
    for (const text of texts(page)) if (text.startsWith("prompt ")) prompts.add(text);
    if (!page.cursor) break;
    page = transcriptPage(source, path, { before: page.cursor }, home);
  }
  return prompts;
}

test("a Claude transcript past 64 MiB pages back to its first prompt", () => {
  const path = join(dir, "claude.jsonl");
  writeFileSync(path, "");
  for (let n = 0; n < TURNS; n++) {
    appendFileSync(path, `${JSON.stringify({ type: "user", message: { role: "user", content: `prompt ${n}` } })}\n`);
    appendFileSync(path, `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `answer ${n} ${pad}` }] } })}\n`);
  }
  const prompts = walk("claude-transcript", path);
  expect(prompts.size).toBe(TURNS);
  expect(prompts.has("prompt 0")).toBe(true);
});

test("a Codex rollout past 64 MiB pages back to its first prompt", () => {
  const home = join(dir, "codex");
  mkdirSync(join(home, "sessions", "2026", "10", "08"), { recursive: true });
  const path = join(home, "sessions", "2026", "10", "08", "rollout-2026-10-08T00-00-00-01a0a337-19e8-7712-92f5-aa0883392afd.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } })}\n`);
  for (let n = 0; n < TURNS; n++) {
    appendFileSync(path, [
      { type: "event_msg", timestamp: "2026-10-08T00:00:00.000Z", payload: { type: "task_started" } },
      { type: "response_item", timestamp: "2026-10-08T00:00:00.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `prompt ${n}` }] } },
      { type: "response_item", timestamp: "2026-10-08T00:00:01.000Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `answer ${n} ${pad}` }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  const prompts = walk("codex-transcript", path, home);
  expect(prompts.size).toBe(TURNS);
  expect(prompts.has("prompt 0")).toBe(true);
});
