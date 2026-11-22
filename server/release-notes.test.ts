import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HIGHLIGHT_LIMIT, HIGHLIGHTS_PER_GROUP, RELEASES_LIMIT, SUMMARY_GROUPS, SUMMARY_LANGUAGES } from "../shared/update.ts";
import { compareVersions, releaseNotes, releaseSummaries, SUMMARIES_FILE } from "./release-notes.ts";

const CHANGELOG = `# Changelog

Each release is a \`vX.Y.Z\` Git tag.

## [Unreleased]

### Added
- Not in any release yet.

## [0.4.0] - 2026-10-07

### Added
- A wrapped entry that goes on
  to a second line. ([#9](https://example.invalid/pull/9))

### Fixed
- A fix.

## [0.3.10] - 2026-10-06

### Changed
- Ten comes after nine.

## [0.3.9] - 2026-10-05

### Fixed
- Nine.

## [0.3.8]

## [0.3.7] - 2026-10-03

First of the line.

[Unreleased]: https://example.invalid/compare/v0.4.0...HEAD
[0.4.0]: https://example.invalid/compare/v0.3.10...v0.4.0
`;

describe("release notes of an update", () => {
  it("tells the one release an update brings, without its heading", () => {
    expect(releaseNotes(CHANGELOG, "0.3.10", "0.4.0")).toEqual({
      releases: [{ version: "0.4.0", date: "2026-10-07", notes:
        "### Added\n- A wrapped entry that goes on\n  to a second line. ([#9](https://example.invalid/pull/9))\n\n### Fixed\n- A fix." }],
      omitted: 0,
    });
  });

  it("tells every release that was skipped, newest first, comparing versions as numbers", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.8", "0.4.0");
    expect(notes.releases.map((release) => release.version)).toEqual(["0.4.0", "0.3.10", "0.3.9"]);
    expect(notes.omitted).toBe(0);
  });

  it("stops at the release the update installs: nothing unreleased, nothing newer", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.7", "0.3.10");
    expect(notes.releases.map((release) => release.version)).toEqual(["0.3.10", "0.3.9"]);
    expect(JSON.stringify(notes)).not.toContain("Not in any release yet");
  });

  it("leaves out a release whose section is empty, and the compare links under the last one", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.6", "0.3.8");
    expect(notes.releases).toEqual([{ version: "0.3.7", date: "2026-10-03", notes: "First of the line." }]);
  });

  it("keeps a heading of its own level inside a release: only a release or Unreleased ends a section", () => {
    const log = "## [Unreleased]\n\n## Planned\n- Not yet.\n\n## [0.4.0] - 2026-10-07\n\n### Changed\n- A change.\n\n## Migration\n\nRun the thing.\n\n## [0.3.9]\n- Nine.\n";
    expect(releaseNotes(log, "0.3.9", "0.4.0").releases).toEqual([
      { version: "0.4.0", date: "2026-10-07", notes: "### Changed\n- A change.\n\n## Migration\n\nRun the thing." },
    ]);
  });

  it("keeps a linked heading that names no release, and ends at a release it cannot read", () => {
    const log = "## [0.4.0] - 2026-10-07\nBefore.\n\n## [Migration](https://example.com/migrate)\nRun the thing.\n\n## [0.4.0-rc.1] - 2026-10-01\nA candidate.\n\n## [0.3.9](https://example.com/v0.3.9)\nNine.\n";
    expect(releaseNotes(log, "0.3.8", "0.4.0").releases).toEqual([
      { version: "0.4.0", date: "2026-10-07", notes: "Before.\n\n## [Migration](https://example.com/migrate)\nRun the thing." },
    ]);
  });

  it("tells the latest release alone when the running version is unknown", () => {
    expect(releaseNotes(CHANGELOG, null, "0.3.10").releases.map((release) => release.version)).toEqual(["0.3.10"]);
    expect(releaseNotes(CHANGELOG, "main", "0.3.10").releases.map((release) => release.version)).toEqual(["0.3.10"]);
  });

  it("has nothing for a release the changelog does not name, or a tag that is no version", () => {
    expect(releaseNotes(CHANGELOG, "0.4.0", "0.4.1")).toEqual({ releases: [], omitted: 0 });
    expect(releaseNotes(CHANGELOG, "0.3.9", "nightly")).toEqual({ releases: [], omitted: 0 });
    expect(releaseNotes("", "0.3.9", "0.4.0")).toEqual({ releases: [], omitted: 0 });
  });

  it("counts the older releases a long jump leaves out", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.7", "0.4.0", 160);
    expect(notes.releases.map((release) => release.version)).toEqual(["0.4.0", "0.3.10"]);
    expect(notes.omitted).toBe(1);
  });

  it("cuts the newest release at a line when it alone is over the budget", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.7", "0.4.0", 40);
    expect(notes.releases).toEqual([{ version: "0.4.0", date: "2026-10-07", notes: "### Added\n- A wrapped entry that goes on\n\n…" }]);
    expect(notes.omitted).toBe(2);
  });
});

describe("the bounds of an answer", () => {
  it("tells a version the changelog names twice once, by its first section", () => {
    const twice = "## [Unreleased]\n\n## [0.2.0] - 2026-01-02\n- first\n\n## [0.2.0] - 2026-01-02\n- again\n\n## [0.1.0]\n- old\n";
    expect(releaseNotes(twice, "0.1.0", "0.2.0").releases.map((release) => release.notes)).toEqual(["- first"]);
  });

  it("counts a release's summary toward the budget, not its section alone", () => {
    const log = "## [0.2.0]\n- two\n\n## [0.1.5]\n- one and a half\n\n## [0.1.0]\n- one\n";
    const summaries = new Map([["0.1.5", { en: { new: ["x".repeat(100)] } }]]);
    expect(releaseNotes(log, "0.1.0", "0.2.0", 60).omitted).toBe(0);
    expect(releaseNotes(log, "0.1.0", "0.2.0", 60, summaries)).toMatchObject({ omitted: 1 });
  });

  it("tells the newest release within the budget: its summary first, its notes cut to the room left", () => {
    const log = "## [0.2.0]\n- two\n\n## [0.1.0]\n- one\n";
    const summary = { en: { new: ["x".repeat(100)] } };
    const summaries = new Map([["0.2.0", summary]]);
    const summarySize = JSON.stringify(summary).length;
    expect(releaseNotes(log, "0.1.0", "0.2.0", 200, summaries).releases[0]).toMatchObject({ notes: "- two", summary });
    const told = releaseNotes(log, "0.1.0", "0.2.0", 60, summaries);
    expect(told.releases).toHaveLength(1);
    expect(told.releases[0]!.summary).toBeUndefined();
    expect(told.releases[0]!.notes).toBe("- two");
    const long = `## [0.2.0]\n${"- line\n".repeat(40)}\n## [0.1.0]\n- one\n`;
    const cut = releaseNotes(long, "0.1.0", "0.2.0", 300, summaries).releases[0]!;
    expect(cut.summary).toEqual(summary);
    expect(cut.notes.endsWith("…")).toBe(true);
    expect(cut.notes.length + summarySize).toBeLessThanOrEqual(300 + 3);
    const alone = releaseNotes(long, "0.1.0", "0.2.0", 100, summaries).releases[0]!;
    expect(alone.summary).toBeUndefined();
    expect(alone.notes.length).toBeLessThanOrEqual(103);
  });

  it("names at most RELEASES_LIMIT releases and counts the rest, however large the budget", () => {
    const log = Array.from({ length: 60 }, (_, i) => `## [0.${60 - i}.0]\n- r\n`).join("\n");
    const told = releaseNotes(log, "0.0.0", "0.60.0", 1_000_000);
    expect(told.releases.length).toBe(RELEASES_LIMIT);
    expect(told.omitted).toBe(10);
  });
});

describe("a release told as patch notes", () => {
  const written = JSON.stringify({
    "0.4.0": {
      en: { new: ["  A new thing.  ", "", 7, "Another."], fixed: ["A fix."], removed: ["Not a list the app has."] },
      ko: { new: ["새 기능."], improved: [], fixed: "수정." },
      ja: {},
      fr: { new: ["Une chose."] },
    },
    "0.3.10": { en: { improved: ["Ten is better."] } },
    "0.3.9": "nine",
    "next": { en: { new: ["No version."] } },
    "0.3.8": { en: ["Not grouped."] },
    "0.3.7": { en: { new: "One line, not a list." } },
  });

  it("reads each release's lines, under the lists and in the languages the app has", () => {
    expect([...releaseSummaries(written)]).toEqual([
      ["0.4.0", { en: { new: ["A new thing.", "Another."], fixed: ["A fix."] }, ko: { new: ["새 기능."] } }],
      ["0.3.10", { en: { improved: ["Ten is better."] } }],
    ]);
  });

  it("has none in a file that is not an object of releases", () => {
    for (const text of ["", "not json", "[]", "null", "7", '"0.4.0"', '{"__proto__":{"en":{"new":["x"]}}}']) expect(releaseSummaries(text).size).toBe(0);
  });

  it("cuts a line that is no line, and a list that is no handful", () => {
    const told = releaseSummaries(JSON.stringify({ "0.4.0": { en: {
      new: ["a".repeat(HIGHLIGHT_LIMIT + 500)], fixed: Array.from({ length: HIGHLIGHTS_PER_GROUP + 5 }, (_, index) => `Fix ${index}.`),
    } } })).get("0.4.0")!.en!;
    expect(told.new![0]).toHaveLength(HIGHLIGHT_LIMIT + 1);
    expect(told.new![0]!.endsWith("…")).toBe(true);
    expect(told.fixed).toHaveLength(HIGHLIGHTS_PER_GROUP);
  });

  it("puts a release's summary beside its notes, and leaves a release without one as it was", () => {
    const notes = releaseNotes(CHANGELOG, "0.3.8", "0.4.0", undefined, releaseSummaries(written));
    expect(notes.releases.map((release) => [release.version, release.summary])).toEqual([
      ["0.4.0", { en: { new: ["A new thing.", "Another."], fixed: ["A fix."] }, ko: { new: ["새 기능."] } }],
      ["0.3.10", { en: { improved: ["Ten is better."] } }],
      ["0.3.9", undefined],
    ]);
    expect("summary" in notes.releases[2]!).toBe(false);
  });

  it("compares versions as numbers, and not what is no version", () => {
    expect(compareVersions("0.3.10", "0.3.9")! > 0).toBe(true);
    expect(compareVersions("0.3.9", "0.3.9")).toBe(0);
    expect(compareVersions("0.3.9", "1.0.0")! < 0).toBe(true);
    expect(compareVersions("0.3.9", "main")).toBeNull();
  });
});

describe("this repository's own summaries", () => {
  const root = join(import.meta.dir, "..");
  const text = readFileSync(join(root, SUMMARIES_FILE), "utf8");
  const summaries = releaseSummaries(text);
  const released = [...readFileSync(join(root, "CHANGELOG.md"), "utf8").matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1]!);
  const BEFORE = "0.3.52";
  const LINE = 90;

  it("tells every release since in every language the app has", () => {
    const missing = released.filter((version) => compareVersions(version, BEFORE)! > 0)
      .flatMap((version) => SUMMARY_LANGUAGES.filter((language) => !summaries.get(version)?.[language]).map((language) => `${version} ${language}`));
    expect(missing).toEqual([]);
  });

  it("holds nothing but short lines for releases the changelog names, the same lists in every language", () => {
    const raw = JSON.parse(text) as Record<string, Record<string, Record<string, string[]>>>;
    for (const [version, entry] of Object.entries(raw)) {
      expect(released).toContain(version);
      expect(Object.keys(entry).sort()).toEqual([...SUMMARY_LANGUAGES].sort());
      expect(summaries.get(version) as unknown).toEqual(entry);
      const shape = (language: string) => SUMMARY_GROUPS.map((group) => entry[language]![group]?.length ?? 0);
      for (const language of SUMMARY_LANGUAGES) {
        expect([version, language, shape(language)]).toEqual([version, language, shape("en")]);
        for (const line of Object.values(entry[language]!).flat()) expect(line.length).toBeLessThanOrEqual(LINE);
      }
    }
  });
});
