import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetAllPiIndexes, piBranchSegments, piEntryIndex, piIndexCacheUsage, PI_INDEX_CACHE_BYTES, MAX_PI_ENTRY_BYTES, MAX_PI_INDEX_ENTRIES } from "./pi-tree.ts";
import { transcriptPage, transcriptToolOutput, piTranscriptImage, piPageCacheUsage, forgetTranscriptState } from "./conversation.ts";
import { withinRetentionBudget } from "./retention-budget.ts";
const dir = mkdtempSync(join(tmpdir(), "pi-bounded-history-"));
afterAll(() => { forgetTranscriptState(); forgetAllPiIndexes(); rmSync(dir, { recursive: true, force: true }); });
// a picture the chat shows is a real raster: the reader checks its leading bytes
const FIXTURE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const textOf = (page: ReturnType<typeof transcriptPage>) => page.turns.flatMap(t => t.parts).flatMap(p => p.kind === "text" ? [p.text] : []);
const message = (id: string, parentId: string | null, role: string, text: string) => ({ id, parentId, type: "message", message: { role, content: [{ type: "text", text }] } });
test("history beyond 64MiB remains paged and complete, stable on append, with bounded index retention", () => {
  const path = join(dir, "large.jsonl"); writeFileSync(path, ""); let parent: string | null = null;
  const add = (record: Record<string, unknown>) => { appendFileSync(path, JSON.stringify({ parentId: parent, ...record }) + "\n"); parent = record.id as string; };
  for (let i = 0; i < 140; i++) {
    add(message("u" + i, parent, "user", "question " + i));
    add({ id: "pad" + i, type: "custom", data: "x".repeat(512 * 1024) });
    add(message("a" + i, parent, "assistant", "answer " + i));
  }
  expect(statSync(path).size).toBeGreaterThan(64 * 1024 * 1024);
  expect(piBranchSegments(path, statSync(path).size)).not.toBeNull();
  let page = transcriptPage("pi-transcript", path); const history = page.history_id;
  expect(textOf(page)).toContain("answer 139"); expect(page.cursor).not.toBeNull(); expect(page.turns.length).toBeLessThan(80);
  const all = new Set<string>(); let pages = 0;
  for (;;) {
    textOf(page).forEach(t => { expect(all.has(t)).toBe(false); all.add(t); });
    if (!page.cursor) break;
    expect(++pages).toBeLessThan(100); page = transcriptPage("pi-transcript", path, { before: page.cursor });
  }
  expect(all.size).toBe(280); expect(all.has("question 0")).toBe(true);
  add(message("u-next", parent, "user", "appended"));
  const newest = transcriptPage("pi-transcript", path); expect(newest.history_id).toBe(history); expect(textOf(newest)).toContain("appended");
  forgetTranscriptState(); expect(textOf(transcriptPage("pi-transcript", path))).toEqual(textOf(newest));
  // the picture is served from a result that answers a call the page draws, as the page names it
  add({ id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "fixture-call", name: "read", arguments: {} }] } });
  add({ id: "tool", type: "message", message: { role: "toolResult", toolCallId: "fixture-call", toolName: "read", content: [{ type: "text", text: "kept output" }, { type: "image", mimeType: "image/png", data: FIXTURE_PNG.toString("base64") }] } });
  expect(transcriptToolOutput("pi-transcript", path, "fixture-call")).toContain("kept output");
  expect(Buffer.from(piTranscriptImage(path, "pi:fixture-call:0")!.bytes).equals(FIXTURE_PNG)).toBe(true);
  // Abandoned records remain inaccessible, even with large preceding history.
  add(message("other-branch", "u0", "assistant", "new branch"));
  expect(transcriptToolOutput("pi-transcript", path, "fixture-call")).toBeNull();
  expect(piTranscriptImage(path, "pi:fixture-call:0")).toBeNull();
  expect(textOf(transcriptPage("pi-transcript", path))).toEqual(["question 0", "new branch"]);
  expect(piIndexCacheUsage().estimatedBytes).toBeLessThanOrEqual(PI_INDEX_CACHE_BYTES);
}, 30000);
test("index discards unused compaction summaries and evicts cached files", () => {
  for (let i = 0; i < 7; i++) {
    const path = join(dir, `cache-${i}.jsonl`);
    writeFileSync(path, JSON.stringify({ id: "c", parentId: null, type: "compaction", summary: "x".repeat(1024 * 1024) }) + "\n");
    const index = piEntryIndex(path)!; expect(index.entries[0]!.summary).toBeNull(); expect(index.retainedBytes).toBeLessThan(1000);
  }
  expect(piIndexCacheUsage().files).toBeLessThanOrEqual(4);
  expect(piIndexCacheUsage().estimatedBytes).toBeLessThanOrEqual(PI_INDEX_CACHE_BYTES);
});
test("oversized individual records and excessive entry counts fail closed without a partial cached graph", () => {
  const path = join(dir, "oversized.jsonl");
  writeFileSync(path, JSON.stringify({ id: "large", type: "custom", data: "x".repeat(MAX_PI_ENTRY_BYTES) }) + "\n");
  expect(piEntryIndex(path)).toBeNull(); expect(piBranchSegments(path, statSync(path).size)).toBeNull();
  writeFileSync(path, JSON.stringify(message("good", null, "user", "restored")) + "\n"); expect(piEntryIndex(path)!.entries).toHaveLength(1);
  const many = join(dir, "many.jsonl"); writeFileSync(many, Array.from({ length: MAX_PI_INDEX_ENTRIES + 1 }, (_, i) => JSON.stringify({ id: String(i), parentId: i ? String(i - 1) : null })).join("\n") + "\n");
  expect(piEntryIndex(many)).toBeNull();
  writeFileSync(path, JSON.stringify({ id: "bad", type: "x".repeat(65) }) + "\n"); expect(piEntryIndex(path)).toBeNull();
  const summary = "s".repeat(9 * 1024 * 1024);
  writeFileSync(path, JSON.stringify({ id: "one", type: "branch_summary", parentId: null, summary }) + "\n");
  expect(piEntryIndex(path)).not.toBeNull();
  appendFileSync(path, JSON.stringify({ id: "two", type: "branch_summary", parentId: "one", summary }) + "\n");
  expect(piEntryIndex(path)).toBeNull();
}, 15000);
test("a valid index above 8 MiB of metadata is cached: an unchanged history is not indexed again, an append extends it", () => {
  forgetAllPiIndexes();
  const path = join(dir, "many-small.jsonl");
  writeFileSync(path, Array.from({ length: 40_000 }, (_, i) => JSON.stringify(message("m" + i, i ? "m" + (i - 1) : null, "user", "q" + i))).join("\n") + "\n");
  const first = piEntryIndex(path)!;
  expect(first.retainedBytes).toBeGreaterThan(8 * 1024 * 1024);
  expect(piEntryIndex(path)).toBe(first);
  appendFileSync(path, JSON.stringify(message("next", "m39999", "user", "appended")) + "\n");
  const extended = piEntryIndex(path)!;
  expect(extended).toBe(first);
  expect(extended.entries).toHaveLength(40_001);
  expect(piIndexCacheUsage().estimatedBytes).toBeLessThanOrEqual(PI_INDEX_CACHE_BYTES);
  for (let i = 0; i < 4; i++) { const other = join(dir, `after-${i}.jsonl`); writeFileSync(other, JSON.stringify(message("u", null, "user", "x")) + "\n"); piEntryIndex(other); }
  expect(piIndexCacheUsage().files).toBe(4);
  expect(piEntryIndex(path)).not.toBe(first);
}, 30000);
test("parsed page caches admit at most four small pages each and still serve oversized pages uncached", () => {
  forgetTranscriptState();
  for (let i = 0; i < 7; i++) {
    const path = join(dir, `page-cache-${i}.jsonl`);
    writeFileSync(path, JSON.stringify(message("u", null, "user", "hello")) + "\n");
    transcriptPage("pi-transcript", path);
  }
  expect(piPageCacheUsage()).toEqual({ pages: 4, settled: 4, withinBudget: true });
  forgetTranscriptState();
  const path = join(dir, "large-page.jsonl"), body = "y".repeat(3 * 1024 * 1024);
  writeFileSync(path, [message("u", null, "user", body), message("a", "u", "assistant", "ok"), message("u2", "a", "user", "next")].map(r => JSON.stringify(r)).join("\n") + "\n");
  expect(textOf(transcriptPage("pi-transcript", path))).toContain(body);
  expect(piPageCacheUsage()).toEqual({ pages: 0, settled: 0, withinBudget: true });
});
test("retention estimator bounds large strings, nested structures and Maps without following cycles forever", () => {
  expect(withinRetentionBudget({ text: "x".repeat(300) }, 100)).toBe(false);
  expect(withinRetentionBudget({ text: "small" }, 1000)).toBe(true);
  expect(withinRetentionBudget(new Map([["title", "x".repeat(300)]]), 100)).toBe(false);
  const cycle: any = {}; cycle.self = cycle; expect(withinRetentionBudget(cycle, 1000)).toBe(true);
});
