import { describe, expect, it } from "bun:test";

import { changeTree, changeTreeFolders, type ChangeTreeEntry } from "./changeTree.ts";

const outline = (entries: readonly ChangeTreeEntry[]): unknown[] =>
  entries.map((entry) => (entry.kind === "file" ? entry.name : { [`${entry.name}/`]: outline(entry.entries) }));

describe("changeTree", () => {
  it("lists root files alone at depth 0, in the listing's order", () => {
    const tree = changeTree(["README.md", "package.json"]);
    expect(tree).toEqual([
      { kind: "file", path: "README.md", name: "README.md", depth: 0, index: 0 },
      { kind: "file", path: "package.json", name: "package.json", depth: 0, index: 1 },
    ]);
    expect(changeTree([])).toEqual([]);
  });

  it("puts a folder where its first file was listed and keeps the files' order inside it", () => {
    const tree = changeTree(["assets/pic.bin", "docs/new-name.md", "src/big.ts", "README.md", "src/gone.ts", "docs/other.md"]);
    expect(outline(tree)).toEqual([
      { "assets/": ["pic.bin"] },
      { "docs/": ["new-name.md", "other.md"] },
      { "src/": ["big.ts", "gone.ts"] },
      "README.md",
    ]);
    const files = (entries: readonly ChangeTreeEntry[]): number[] => entries.flatMap((entry) => (entry.kind === "file" ? [entry.index] : files(entry.entries)));
    expect(files(tree)).toEqual([0, 1, 5, 2, 4, 3]);
  });

  it("draws a folder holding one folder and nothing else as one row, and counts the files under each", () => {
    const tree = changeTree(["apps/web/src/components/diffs/Tree.tsx", "apps/web/src/components/diffs/tree.logic.ts", "apps/web/src/main.tsx", "apps/web/README.md"]);
    expect(outline(tree)).toEqual([{ "apps/web/": [{ "src/": [{ "components/diffs/": ["Tree.tsx", "tree.logic.ts"] }, "main.tsx"] }, "README.md"] }]);
    const [apps] = tree;
    if (apps?.kind !== "folder") throw new Error("expected a folder");
    expect(apps).toMatchObject({ path: "apps/web", depth: 0, files: 4 });
    const [src] = apps.entries;
    if (src?.kind !== "folder") throw new Error("expected a folder");
    expect(src).toMatchObject({ path: "apps/web/src", depth: 1, files: 3 });
    const [diffs] = src.entries;
    if (diffs?.kind !== "folder") throw new Error("expected a folder");
    expect(diffs).toMatchObject({ path: "apps/web/src/components/diffs", name: "components/diffs", depth: 2, files: 2 });
    expect(diffs.entries[0]).toEqual({ kind: "file", path: "apps/web/src/components/diffs/Tree.tsx", name: "Tree.tsx", depth: 3, index: 0 });
  });

  it("keeps a chain apart once a file sits at one of its levels", () => {
    expect(outline(changeTree(["a/b/c.ts", "a/d.ts"]))).toEqual([{ "a/": [{ "b/": ["c.ts"] }, "d.ts"] }]);
    expect(outline(changeTree(["a/b/c.ts", "a/b/e/f.ts"]))).toEqual([{ "a/b/": ["c.ts", { "e/": ["f.ts"] }] }]);
  });

  it("names every folder by its path, a parent before what it holds", () => {
    const tree = changeTree(["src/lib/a.ts", "src/b.ts", "docs/guide/intro.md", "README.md"]);
    expect(changeTreeFolders(tree)).toEqual(["src", "src/lib", "docs/guide"]);
    expect(changeTreeFolders(changeTree(["README.md"]))).toEqual([]);
  });
});
