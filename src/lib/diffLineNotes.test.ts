import { describe, expect, it } from "bun:test";

import type { RepoDiffFilePatch } from "../../shared/protocol.ts";
import { MAX_COMPOSER_CHARS } from "./compose.ts";
import { codeFence, diffNoteQuote, lineAtRow, noteBlock, noteOverflows, patchIdentity, capturedComparison, type DiffNoteCapture } from "./diffLineNotes.ts";
import { messageWithComments } from "./replyComments.ts";
import { diffFindLines } from "./repoDiffFind.ts";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";

/** A patch of `count` unchanged lines with one removed near the end. */
function largePatch(count: number, removedAt: number): string {
  const body: string[] = [];
  for (let line = 1; line <= count; line++) body.push(line === removedAt ? `-  removed ${line};` : ` line ${line};`);
  return ["diff --git a/src/big.ts b/src/big.ts", "--- a/src/big.ts", "+++ b/src/big.ts", `@@ -1,${count} +1,${count - 1} @@`, ...body, ""].join("\n");
}

function answer(scope: RepoDiffFilePatch["scope"], patch: string, extra: Partial<RepoDiffFilePatch> = {}): RepoDiffFilePatch {
  return {
    repository: { root: "/home/me/shop", branch: "main", head: HEAD, detached: false, unborn: false },
    scope, base: null, head: null, comparison: null,
    file: { path: "src/big.ts", old_path: null, status: "modified", additions: 0, deletions: 1, binary: false },
    patch, unavailable: null, truncated: false, limits: { max_patch_bytes: 1, context_lines: 3 },
    ...extra,
  };
}

function capture(patch: string, at: { side: "old" | "new"; line: number }, scope: RepoDiffFilePatch["scope"] = "workspace"): DiffNoteCapture {
  const line = diffFindLines(patch).find((item) => item.side === at.side && item.line === at.line);
  if (line === undefined) throw new Error("no such line");
  return { machine: "home-server", repository: "/home/me/shop", comparison: capturedComparison(answer(scope, patch), patch), path: "src/big.ts", line };
}

/**
 * The parts of a note's quote an agent reads: the strings it names (JSON, so any path survives), the
 * side, line and kind, the comparison, and the fenced text (a whitespace-only line as a JSON string).
 */
function parts(quote: string) {
  const lines = quote.split("\n");
  const open = lines.findIndex((line) => /^`{3,}$/.test(line));
  const close = open < 0 ? -1 : lines.indexOf(lines[open]!, open + 1);
  if (close !== lines.length - 1) throw new Error(`no fence closes the quote: ${quote}`);
  // the names are the JSON strings before the fence, in order: path, PC, repository
  const strings = /"(?:[^"\\]|\\.)*"/g;
  const names = [...lines.slice(0, open).join("\n").matchAll(strings)].map((match) => JSON.parse(match[0]) as string);
  // the first line's values once its name is taken out: the side, the kind and the one-based line
  const head = lines[0]!.replace(strings, "");
  const fenced = lines.slice(open + 1, close).join("\n");
  // a whitespace-only line goes as a JSON string
  let text = fenced;
  if (/^".*"$/.test(fenced)) { const parsed = JSON.parse(fenced) as string; if (/^[\s\u0085]*$/.test(parsed)) text = parsed; }
  return {
    path: names[0]!, machine: names[1]!, repository: names[2]!,
    side: /\b(old|new)\b/.exec(head)?.[1], kind: /\b(added|removed|unchanged)\b/.exec(head)?.[1], line: Number(/\d+/.exec(head)?.[0]),
    text,
  };
}

describe("diff line notes", () => {
  it("names the PC, repository, comparison, path, side and line of a removed line near the end of a large diff, its text fenced", () => {
    const patch = largePatch(4000, 3990);
    const quote = diffNoteQuote(capture(patch, { side: "old", line: 3990 }));
    const got = parts(quote);
    expect(got).toEqual({ path: "src/big.ts", side: "old", line: 3990, kind: "removed", machine: "home-server", repository: "/home/me/shop", text: "  removed 3990;" });
    expect(quote).toContain(HEAD);
    expect(quote).toContain(patchIdentity(patch));
  });

  it("names any path whole: two files whose names differ only by a newline or a space are two places", () => {
    const patch = largePatch(10, 4);
    const at = capture(patch, { side: "old", line: 4 });
    const newline = diffNoteQuote({ ...at, path: "a\nb.ts", machine: "pc\r\none", repository: "/r\"x" });
    const space = diffNoteQuote({ ...at, path: "a b.ts" });
    expect(parts(newline)).toMatchObject({ path: "a\nb.ts", machine: "pc\r\none", repository: "/r\"x" });
    expect(parts(space).path).toBe("a b.ts");
    expect(newline).not.toBe(space);
  });

  it("escapes the characters some viewers break a line at, so a name stays on its line", () => {
    const at = capture(largePatch(10, 4), { side: "old", line: 4 });
    const odd = "a\u2028b\u2029c\u0085d";
    const quote = diffNoteQuote({ ...at, path: odd, machine: odd, repository: odd });
    expect(quote).not.toMatch(/[\u2028\u2029\u0085]/);
    expect(parts(quote)).toMatchObject({ path: odd, machine: odd, repository: odd });
  });

  it("keeps a whitespace-only line as it is, through the quote of the message it goes in", () => {
    const patch = ["--- a/x", "+++ b/x", "@@ -0,0 +1,1 @@", "+ \t  ", ""].join("\n");
    const quote = diffNoteQuote({ ...capture(patch, { side: "new", line: 1 }), path: "x" });
    expect(parts(quote).text).toBe(" \t  ");
    const sent = messageWithComments([{ id: "a", quote, comment: "trailing tab" }], "");
    const unquoted = sent.split("\n").slice(0, -1).map((line) => line.replace(/^> ?/, "")).join("\n");
    expect(parts(unquoted).text).toBe(" \t  ");
    // a line of the separators some viewers break at counts as whitespace too, and goes escaped
    for (const odd of ["\u0085", "\u0085\u2028 "]) {
      const patchOdd = ["--- a/x", "+++ b/x", "@@ -0,0 +1,1 @@", `+${odd}`, ""].join("\n");
      const quoteOdd = diffNoteQuote({ ...capture(patchOdd, { side: "new", line: 1 }), path: "x" });
      expect(quoteOdd).not.toMatch(/[\u2028\u2029\u0085]/);
      expect(parts(quoteOdd).text).toBe(odd);
    }
  });

  it("finds the logical line of a hovered or tapped row: a removed row by its old number, the rest by their new one", () => {
    const lines = diffFindLines(largePatch(10, 4));
    expect(lineAtRow(lines, "deletions", 4)).toMatchObject({ kind: "deletion", side: "old", line: 4 });
    // in split, the old column draws an unchanged line by its old number; its logical line is the new side's
    expect(lineAtRow(lines, "deletions", 6)).toMatchObject({ kind: "context", side: "new", line: 5 });
    expect(lineAtRow(lines, "additions", 5)).toMatchObject({ kind: "context", side: "new", line: 5 });
    expect(lineAtRow(lines, "additions", 99)).toBeNull();
  });

  it("fences a line holding backtick runs with a longer run, so it cannot close the fence", () => {
    expect(codeFence("plain")).toBe("```");
    expect(codeFence("a ``` b")).toBe("````");
    expect(codeFence("``````")).toBe("```````");
    const patch = ["--- a/x", "+++ b/x", "@@ -0,0 +1,1 @@", "+````", ""].join("\n");
    const quote = diffNoteQuote({ ...capture(patch, { side: "new", line: 1 }), path: "x" });
    expect(parts(quote).text).toBe("````");
  });

  it("keeps the captured comparison: full commits, the branch's three commits, or HEAD and the patch's identity", () => {
    const patch = largePatch(10, 4);
    expect(capturedComparison(answer("commit", patch, { base: BASE, head: HEAD }), patch)).toBe(`commits ${BASE}..${HEAD}`);
    expect(capturedComparison(answer("branch", patch, { base: "main", head: HEAD, comparison: { repository_root: "/home/me/shop", head_oid: HEAD, base_oid: BASE, merge_base_oid: BASE } }), patch))
      .toBe(`branch since main: HEAD ${HEAD}, base ${BASE}, merge base ${BASE}, patch ${patchIdentity(patch)}`);
    expect(capturedComparison(answer("staged", patch), patch)).toBe(`staged on HEAD ${HEAD}, patch ${patchIdentity(patch)}`);
    expect(capturedComparison(answer("workspace", patch, { repository: { root: "/r", branch: null, head: null, detached: false, unborn: true } }), patch))
      .toBe(`working tree before the first commit, patch ${patchIdentity(patch)}`);
    // another patch is another identity, the same patch the same one
    expect(patchIdentity(patch)).toBe(patchIdentity(largePatch(10, 4)));
    expect(patchIdentity(patch)).not.toBe(patchIdentity(largePatch(10, 5)));
    expect(patchIdentity(patch)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("refuses a note that would take the next message past the composer's limit", () => {
    const waiting = [{ id: "a", quote: "q", comment: "c" }];
    expect(noteOverflows(waiting, "Go ahead", "quote", "note")).toBe(false);
    const draft = "x".repeat(MAX_COMPOSER_CHARS - messageWithComments([...waiting, { id: "", quote: "quote", comment: "note" }], "").length - 2);
    expect(noteOverflows(waiting, draft, "quote", "note")).toBe(false);
    expect(noteOverflows(waiting, `${draft}xyz`, "quote", "note")).toBe(true);
    // a comment a send in flight carries is not in the next message
    expect(noteOverflows([...waiting, { id: "big", quote: "q", comment: "z".repeat(MAX_COMPOSER_CHARS) }], "Go ahead", "quote", "note", new Set(["big"]))).toBe(false);
  });

  it("says why a pane cannot take a note: none, gone, a watching device, or no agent in it", () => {
    const agent = { agent: "codex", agent_status: "done" as const };
    expect(noteBlock({ paneId: "p1", pane: agent, watching: false })).toBeNull();
    expect(noteBlock({ paneId: null, pane: undefined, watching: false })).toBe("no-pane");
    expect(noteBlock({ paneId: "p1", pane: undefined, watching: false })).toBe("pane-gone");
    expect(noteBlock({ paneId: "p1", pane: undefined, watching: false, reachable: false })).toBe("pc-offline");
    expect(noteBlock({ paneId: "p1", pane: agent, watching: true })).toBe("watching");
    expect(noteBlock({ paneId: "p1", pane: agent, watching: false, observing: true })).toBe("observing");
    // a pane this window has not mounted: whether it may type there is not known, so no note
    expect(noteBlock({ paneId: "p1", pane: agent, watching: false, mounted: false })).toBe("pane-not-open");
    expect(noteBlock({ paneId: "p1", pane: { agent: null, agent_status: "unknown" }, watching: false })).toBe("no-agent");
  });
});
