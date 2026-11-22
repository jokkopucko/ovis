import { readFileSync } from "node:fs";
import { releaseSummaries, SUMMARIES_FILE } from "../server/release-notes.ts";
import { SUMMARY_GROUPS, SUMMARY_LANGUAGES, type SummaryGroup } from "../shared/update.ts";
import { FRAGMENTS_DIR, fragmentFiles } from "./changelog-fold.ts";

const GROUP_HEADINGS: Record<SummaryGroup, string> = { new: "New features", improved: "Improvements", fixed: "Bug fixes" };

/**
 * `fragments` are the files left in changelog.d/: a fragment merged after the release PR folded
 * them would ship without a line in these notes, so the release refuses until it is placed.
 */
export function releaseNotes(version: string, packageVersion: string, manifest: string, changelog: string, summaries: string, fragments: string[] = []): string {
  if (version !== version.trim() || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Expected version X.Y.Z without v");
  if (fragments.length > 0) {
    throw new Error(`${FRAGMENTS_DIR}/ still holds ${fragments.join(", ")}, which this release's notes would leave out. In a PR, move their entries `
      + `under "## [${version}]" in CHANGELOG.md (bun scripts/changelog-fold.ts only makes a new version), add each PR link, and delete the files`);
  }
  if (packageVersion !== version) throw new Error("package.json version does not match");
  if (!manifest.split(/\r?\n/).some((line) => line === `version = "${version}"`)) throw new Error("herdr-plugin.toml version does not match");
  const sections = changelog.split(/^## /m).slice(1);
  const matching = sections.filter((section) => section.startsWith(`[${version}]`) && /^(?:\s|$)/.test(section.slice(version.length + 2)));
  if (matching.length !== 1) throw new Error("CHANGELOG.md must contain exactly one heading for this version");
  const notes = matching[0]!.split("\n").slice(1).filter((line) => !/^\[[^\]]+\]: /.test(line)).join("\n").trim();
  if (!notes) throw new Error("Release notes are empty");
  const summary = releaseSummaries(summaries).get(version);
  const untold = SUMMARY_LANGUAGES.filter((language) => !summary?.[language]);
  if (untold.length > 0) throw new Error(`${SUMMARIES_FILE} must tell this version in: ${untold.join(", ")}`);
  const lines = SUMMARY_LANGUAGES.flatMap((language) => SUMMARY_GROUPS.flatMap((group) => summary![language]![group] ?? []));
  if (lines.some((line) => /[\r\n]/.test(line))) throw new Error(`${SUMMARIES_FILE} lines must each be one line`);
  const english = summary!.en!;
  const lists = SUMMARY_GROUPS.flatMap((group) => {
    const written = english[group];
    // plain text, as the app shows it: no `<` may open a tag or a comment that hides the fold
    return written ? [`### ${GROUP_HEADINGS[group]}\n\n${written.map((line) => `- ${line.replaceAll("<", "&lt;")}`).join("\n")}`] : [];
  });
  // the blank lines inside <details> are what make GitHub render the markdown there
  return [...lists, `<details><summary>Full changelog</summary>\n\n${notes}\n\n</details>`].join("\n\n");
}

if (import.meta.main) {
  console.log(releaseNotes(process.argv[2] ?? "", JSON.parse(readFileSync("package.json", "utf8")).version,
    readFileSync("herdr-plugin.toml", "utf8"), readFileSync("CHANGELOG.md", "utf8"), readFileSync(SUMMARIES_FILE, "utf8"), fragmentFiles(FRAGMENTS_DIR)));
}
