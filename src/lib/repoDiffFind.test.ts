import { describe, expect, it } from "bun:test";
import { trimPatchContext } from "@pierre/diffs";

import { DIFF_FIND_MAX_QUERY, diffFindLines, findInDiff, matchKey, stepMatch } from "./repoDiffFind.ts";

const MONEY = [
  "diff --git a/src/money.ts b/src/money.ts",
  "index 3f1c2aa..9b7d410 100644",
  "--- a/src/money.ts",
  "+++ b/src/money.ts",
  "@@ -1,5 +1,6 @@",
  " export type Cents = number;",
  " ",
  " export function toCents(amount: number): Cents {",
  "-  return amount * 100;",
  "+  const scaled = Math.abs(amount) * 100;",
  "+  return Math.sign(amount) * scaled;",
  " }",
  "",
].join("\n");

const where = (patch: string, query: string) => findInDiff(diffFindLines(patch), query).map((match) => `${match.kind} ${match.side}:${match.line} ${match.start}-${match.end}`);

describe("find in a diff", () => {
  it("context is searched once", () => {
    const matches = findInDiff(diffFindLines(MONEY), "Cents");
    expect(matches.map((match) => [match.kind, match.side, match.line, match.oldLine, match.newLine, match.start])).toEqual([
      ["context", "new", 1, 1, 1, 12],
      ["context", "new", 3, 3, 3, 18],
      ["context", "new", 3, 3, 3, 41],
    ]);
  });

  it("addition and deletion retain logical sides", () => {
    expect(where(MONEY, "amount")).toEqual([
      "context new:3 24-30",
      "deletion old:4 9-15",
      "addition new:4 26-32",
      "addition new:5 19-25",
    ]);
    const [deletion, addition] = findInDiff(diffFindLines(MONEY), "return");
    expect(deletion).toMatchObject({ side: "old", line: 4, oldLine: 4, newLine: null });
    expect(addition).toMatchObject({ side: "new", line: 5, oldLine: null, newLine: 5 });
  });

  it("literal regex punctuation is not a regex", () => {
    expect(where(MONEY, "Math.abs(")).toEqual(["addition new:4 17-26"]);
    expect(where(MONEY, "* 100;")).toEqual(["deletion old:4 16-22", "addition new:4 34-40"]);
    expect(where(MONEY, ".*")).toEqual([]);
    expect(where(MONEY, "[a-z]+")).toEqual([]);
    expect(where(MONEY, "math")).toEqual([]);
  });

  it("multiple matches are ordered", () => {
    const patch = ["@@ -1,2 +1,2 @@", "-aa aa", "+aaa", " aaaa", ""].join("\n");
    expect(where(patch, "aa")).toEqual(["deletion old:1 0-2", "deletion old:1 3-5", "addition new:1 0-2", "context new:2 0-2", "context new:2 2-4"]);
  });

  it("empty query and unavailable patch have none", () => {
    expect(findInDiff(diffFindLines(MONEY), "")).toEqual([]);
    expect(diffFindLines(null)).toEqual([]);
    expect(findInDiff(diffFindLines(null), "amount")).toEqual([]);
    expect(diffFindLines(["diff --git a/a.ts b/b.ts", "similarity index 100%", "rename from a.ts", "rename to b.ts", ""].join("\n"))).toEqual([]);
    const long = "x".repeat(DIFF_FIND_MAX_QUERY + 10);
    const line = `+${long}`;
    expect(findInDiff(diffFindLines(["@@ -0,0 +1 @@", line, ""].join("\n")), long)).toHaveLength(1);
    expect(findInDiff(diffFindLines(["@@ -0,0 +1 @@", line, ""].join("\n")), long)[0]?.end).toBe(DIFF_FIND_MAX_QUERY);
    expect(stepMatch(null, 0, 1)).toBeNull();
  });

  it("CRLF and no-newline markers keep line numbers", () => {
    const patch = ["@@ -1,2 +1,2 @@", " one\r", "-two\r", "\\ No newline at end of file", "+two!\r", "\\ No newline at end of file", ""].join("\n");
    const lines = diffFindLines(patch);
    expect(lines.map((line) => `${line.kind} ${line.side}:${line.line} ${JSON.stringify(line.text)}`)).toEqual([
      "context new:1 \"one\"",
      "deletion old:2 \"two\"",
      "addition new:2 \"two!\"",
    ]);
    expect(where(patch, "No newline")).toEqual([]);
    expect(where(patch, "\r")).toEqual([]);
    const two = ["@@ -1 +1 @@ function first()", "-a", "+b", "@@ -10,1 +10,1 @@", "-c", "+d", ""].join("\n");
    expect(where(two, "first")).toEqual([]);
    expect(diffFindLines(two).map((line) => `${line.side}:${line.line}`)).toEqual(["old:1", "new:1", "old:10", "new:10"]);
  });

  it("rename and repeated text preserve identity", () => {
    const renamed = ["diff --git a/old.ts b/new.ts", "similarity index 80%", "rename from old.ts", "rename to new.ts", "--- a/old.ts", "+++ b/new.ts", "@@ -3,3 +3,3 @@", " same", "-same", "+same", " same", ""].join("\n");
    expect(where(renamed, "old.ts")).toEqual([]);
    const matches = findInDiff(diffFindLines(renamed), "same");
    expect(matches.map((match) => `${match.kind} ${match.side}:${match.line}`)).toEqual(["context new:3", "deletion old:4", "addition new:4", "context new:5"]);
    expect(new Set(matches.map(matchKey)).size).toBe(4);
    expect(matchKey(matches[1]!)).not.toBe(matchKey(matches[2]!));
    // a line starting with `--` inside a hunk is a deletion, not a header
    expect(where(["@@ -1 +0,0 @@", "--- not a header", ""].join("\n"), "not")).toEqual(["deletion old:1 3-6"]);
  });

  it("folding cannot remove model matches", () => {
    const old = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const lines = ["@@ -1,40 +1,40 @@", ...old.map((text, index) => (index === 19 ? `-${text}\n+${text} changed` : ` ${text}`)), ""].join("\n");
    const folded = trimPatchContext(lines, 1);
    expect(diffFindLines(folded).some((line) => line.text === "line 2")).toBe(false);
    expect(diffFindLines(lines).some((line) => line.text === "line 2")).toBe(true);
    expect(where(lines, "line 40")).toEqual(["context new:40 0-7"]);
    expect(where(lines, "changed")).toEqual(["addition new:20 8-15"]);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
  });
});
