import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conflictMarkers, foldChangelog, FRAGMENTS_DIR, fragmentFiles, linkPr, parseFragment } from "./changelog-fold.ts";
import { releaseNotes } from "./release-notes.ts";

const root = join(import.meta.dir, "..");
const pull = (n: number) => `https://github.com/devswha/ovis/pull/${n}`;
const changelog = [
  "# Changelog", "", "Intro.", "", "## [Unreleased]", "", "### Fixed", "- Old fix.", "  Continued.", "",
  "### Added", "- Old feature. ([#1](" + pull(1) + "))", "", "## [1.2.2] - 2026-01-01", "", "### Fixed", "- Older.", "",
  "[Unreleased]: https://github.com/devswha/ovis/compare/v1.2.2...HEAD",
  "[1.2.2]: https://github.com/devswha/ovis/compare/v1.2.1...v1.2.2", "",
].join("\n");
const fragment = (name: string, text: string) => ({ name, sections: parseFragment(text, name) });

describe("changelog fold", () => {
  test("old Unreleased entries come first, then fragments in the order given, sections in release order", () => {
    const folded = foldChangelog(changelog, [
      fragment("a.md", "### Changed\n- Tweak.\n\n### Fixed\n- New fix.\n  Wrapped.\n"),
      fragment("b.md", "### Fixed\n- Second fix.\n"),
    ], "1.2.3", "2026-02-03");
    expect(folded).toBe([
      "# Changelog", "", "Intro.", "", "## [Unreleased]", "", "## [1.2.3] - 2026-02-03", "",
      "### Added", "- Old feature. ([#1](" + pull(1) + "))", "",
      "### Changed", "- Tweak.", "",
      "### Fixed", "- Old fix.", "  Continued.", "- New fix.", "  Wrapped.", "- Second fix.", "",
      "## [1.2.2] - 2026-01-01", "", "### Fixed", "- Older.", "",
      "[Unreleased]: https://github.com/devswha/ovis/compare/v1.2.3...HEAD",
      "[1.2.3]: https://github.com/devswha/ovis/compare/v1.2.2...v1.2.3",
      "[1.2.2]: https://github.com/devswha/ovis/compare/v1.2.1...v1.2.2", "",
    ].join("\n"));
  });

  test("the folded section is what the release notes read, and nothing of it leaks into Unreleased", () => {
    const folded = foldChangelog(changelog, [fragment("a.md", "### Fixed\n- New fix.\n")], "1.2.3", "2026-02-03");
    const told = { fixed: ["Fix."] };
    const summaries = JSON.stringify({ "1.2.3": { en: told, ko: told, ja: told, zh: told, tr: told } });
    expect(releaseNotes("1.2.3", "1.2.3", 'version = "1.2.3"', folded, summaries)).toEndWith(
      `<details><summary>Full changelog</summary>\n\n### Added\n- Old feature. ([#1](${pull(1)}))\n\n### Fixed\n- Old fix.\n  Continued.\n- New fix.\n\n</details>`);
    expect(folded).toContain("## [Unreleased]\n\n## [1.2.3]");
    // a fragment merged after the fold would ship unnoted, so the pre-tag gate refuses it
    expect(() => releaseNotes("1.2.3", "1.2.3", 'version = "1.2.3"', folded, summaries, ["late.md"])).toThrow("changelog.d/ still holds late.md");
  });

  test("an empty Unreleased with fragments, and Unreleased with no fragments, both release", () => {
    const empty = changelog.replace(/## \[Unreleased\][\s\S]*?(?=## \[1\.2\.2\])/, "## [Unreleased]\n\n");
    expect(foldChangelog(empty, [fragment("a.md", "### Fixed\n- Only.\n")], "1.2.3", "2026-02-03"))
      .toContain("## [Unreleased]\n\n## [1.2.3] - 2026-02-03\n\n### Fixed\n- Only.\n\n## [1.2.2]");
    expect(foldChangelog(changelog, [], "1.2.3", "2026-02-03")).toContain("### Fixed\n- Old fix.\n  Continued.\n\n## [1.2.2]");
    expect(() => foldChangelog(empty, [], "1.2.3", "2026-02-03")).toThrow("Nothing to release");
  });

  test("a heading the old notes used outside the release order is kept, after the known ones", () => {
    const odd = changelog.replace("### Fixed\n- Old fix.", "### Documentation\n- Docs.\n\n### Fixed\n- Old fix.");
    expect(foldChangelog(odd, [], "1.2.3", "2026-02-03")).toContain("### Fixed\n- Old fix.\n  Continued.\n\n### Documentation\n- Docs.\n\n## [1.2.2]");
  });

  test("refuses rather than drops a line it cannot place", () => {
    const cases: [string, string][] = [
      [changelog.replace("## [Unreleased]\n", "## [Unreleased]\nStray text.\n"), "before the first section"],
      [changelog.replace("  Continued.", "\n  Continued."), "neither"],
      [changelog.replace("## [Unreleased]", "## Unreleased"), "exactly one"],
      [changelog.replace("[Unreleased]: https://github.com/devswha/ovis/compare/v1.2.2...HEAD\n", ""), "end its links"],
      [changelog.replace("## [1.2.2] - 2026-01-01", "## [1.2.3] - 2026-01-01"), "already has 1.2.3"],
    ];
    for (const [text, message] of cases) expect(() => foldChangelog(text, [], "1.2.3", "2026-02-03")).toThrow(message);
    expect(() => foldChangelog(changelog.replace("- Old fix.\n", "- Old fix.\nStray.\n"), [], "1.2.3", "2026-02-03")).toThrow("CHANGELOG.md:9: \"Stray.\"");
    expect(() => foldChangelog(changelog, [], "v1.2.3", "2026-02-03")).toThrow("X.Y.Z");
    expect(() => foldChangelog(changelog, [], "1.2.3", "today")).toThrow("YYYY-MM-DD");
  });

  test("a fragment needs a known section with an entry, and a lowercase .md name", () => {
    expect([...parseFragment("### Added\n- One.\n  More.\n- Two.\n\n### Removed\n- Gone.\n", "x.md")])
      .toEqual([["Added", ["- One.\n  More.", "- Two."]], ["Removed", ["- Gone."]]]);
    const bad: [string, string, string][] = [
      ["", "x.md", "empty"],
      ["\n\n", "x.md", "empty"],
      ["- No heading.\n", "x.md", "before the first section"],
      ["### Fixes\n- Typo.\n", "x.md", "is not one of"],
      ["### Fixed\n", "x.md", "has no"],
      ["### Fixed\n-\n", "x.md", "neither"],
      ["## [Unreleased]\n### Fixed\n- A.\n", "x.md", "only ### sections"],
      ["### Fixed\n- A.\n", "Fix.md", "rename"],
      ["### Fixed\n- A.\n", "fix.txt", "rename"],
    ];
    for (const [text, name, message] of bad) expect(() => parseFragment(text, name)).toThrow(message);
    expect([...parseFragment("\uFEFF### Fixed\r\n- A.\r\n", "x.md")]).toEqual([["Fixed", ["- A."]]]);
  });

  test("the release links the PR that merged a fragment, unless an entry already links that PR", () => {
    const linked = linkPr(parseFragment(`### Fixed\n- A.\n  Wrapped.\n- B. ([#9](${pull(9)}) by @x)\n- Follow-up to [#80](${pull(80)}).\n`, "x.md"), 9);
    expect(linked.get("Fixed")).toEqual([`- A.\n  Wrapped.\n  ([#9](${pull(9)}))`, `- B. ([#9](${pull(9)}) by @x)`, `- Follow-up to [#80](${pull(80)}).\n  ([#9](${pull(9)}))`]);
  });

  test("only regular, visible files besides the README are fragments", () => {
    const dir = mkdtempSync(join(tmpdir(), "changelog-d-"));
    try {
      for (const name of ["b.md", "a.md", "README.md", ".a.md.swp", ".DS_Store"]) writeFileSync(join(dir, name), "");
      mkdirSync(join(dir, "sub"));
      expect(fragmentFiles(dir)).toEqual(["a.md", "b.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("conflict markers are found only as whole markers at a line start", () => {
    expect(conflictMarkers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> main\n")).toEqual([2, 4, 6]);
    expect(conflictMarkers("a\n========\n  <<<<<<< x\n>>>>>>>\n")).toEqual([4]);
  });
});

describe("changelog.d", () => {
  test("every fragment is well formed (format: changelog.d/README.md)", () => {
    const problems = fragmentFiles(join(root, FRAGMENTS_DIR)).flatMap((name) => {
      try {
        parseFragment(readFileSync(join(root, FRAGMENTS_DIR, name), "utf8"), name);
        return [];
      } catch (error) {
        return [(error as Error).message];
      }
    });
    expect(problems).toEqual([]);
  });

  test("CHANGELOG.md and the fragments hold no merge conflict markers", () => {
    const files = ["CHANGELOG.md", ...fragmentFiles(join(root, FRAGMENTS_DIR)).map((name) => join(FRAGMENTS_DIR, name))];
    const found = files.flatMap((file) => conflictMarkers(readFileSync(join(root, file), "utf8"))
      .map((line) => `${file}:${line}: conflict marker; resolve the conflict by keeping both sides' entries, then delete the marker lines`));
    expect(found).toEqual([]);
  });

  test("the next release folds today's Unreleased notes and fragments (bun scripts/changelog-fold.ts X.Y.Z)", () => {
    const fragments = fragmentFiles(join(root, FRAGMENTS_DIR)).map((name) => fragment(name, readFileSync(join(root, FRAGMENTS_DIR, name), "utf8")));
    // CRLF only from a Windows checkout's autocrlf; the fold itself writes and wants LF
    const text = readFileSync(join(root, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");
    const folded = foldChangelog(text, [...fragments, fragment("zz-probe.md", "### Fixed\n- Probe.\n")], "999.0.0", "2099-01-01");
    expect(folded).toContain("## [Unreleased]\n\n## [999.0.0] - 2099-01-01\n");
  });
});
