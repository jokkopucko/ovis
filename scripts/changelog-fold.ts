import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FRAGMENTS_DIR = "changelog.d";
export const FRAGMENTS_README = "README.md";
export const FRAGMENT_NAME = /^[a-z0-9][a-z0-9.-]*\.md$/;
export const SECTIONS = ["Added", "Changed", "Removed", "Fixed", "Maintenance"] as const;

const REPO = "https://github.com/devswha/ovis";
/** the repository before its rename: the links CHANGELOG.md already has keep it, and GitHub redirects them */
const LEGACY_REPO = "https://github.com/devswha/herdr-web-ui";
const UNRELEASED = "## [Unreleased]";
const HINT = `see ${FRAGMENTS_DIR}/${FRAGMENTS_README}`;
const CHANGELOG_HINT = `fix the entry, or move it into a ${FRAGMENTS_DIR}/ fragment (${HINT})`;

type Sections = Map<string, string[]>;

export function conflictMarkers(text: string): number[] {
  return text.split("\n").flatMap((line, index) => /^(<{7}|>{7})( |$)|^={7}$/.test(line.replace(/\r$/, "")) ? [index + 1] : []);
}

function readSections(text: string, where: string, { allowed, firstLine = 1, hint = HINT }: { allowed?: readonly string[]; firstLine?: number; hint?: string } = {}): Sections {
  const sections: Sections = new Map();
  let entries: string[] | undefined;
  let blank = false;
  text.split(/\r?\n/).forEach((line, index) => {
    const at = `${where}:${index + firstLine}`;
    const afterBlank = blank;
    blank = !line.trim();
    if (blank) return;
    const heading = /^### (.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1]!;
      if (allowed && !allowed.includes(name)) throw new Error(`${at}: "${line}" is not one of ${allowed.map((s) => `### ${s}`).join(", ")}; ${hint}`);
      entries = sections.get(name) ?? [];
      sections.set(name, entries);
    } else if (!entries) {
      throw new Error(`${at}: text before the first section heading; start with a heading such as ### Fixed (${hint})`);
    } else if (/^- \S/.test(line)) {
      entries.push(line);
    } else if (/^\s+\S/.test(line) && entries.length > 0 && !afterBlank) {
      entries[entries.length - 1] += `\n${line}`;
    } else {
      throw new Error(`${at}: "${line}" is neither a "- " entry nor an indented continuation of one, which may not follow a blank line (${hint})`);
    }
  });
  for (const [name, list] of sections) if (list.length === 0) throw new Error(`${where}: ### ${name} has no "- " entry under it (${hint})`);
  return sections;
}

export function parseFragment(text: string, name: string): Sections {
  if (!FRAGMENT_NAME.test(name)) throw new Error(`${FRAGMENTS_DIR}/${name}: rename it to lowercase words joined by "-" ending in .md, e.g. composer-attach-limit.md`);
  if (/^#{1,2} /m.test(text)) throw new Error(`${FRAGMENTS_DIR}/${name}: a fragment has no "#" or "##" heading, only ### sections (${HINT})`);
  // an editor's byte order mark would otherwise read as text before the first heading
  const sections = readSections(text.replace(/^\uFEFF/, ""), `${FRAGMENTS_DIR}/${name}`, { allowed: SECTIONS });
  if (sections.size === 0) throw new Error(`${FRAGMENTS_DIR}/${name}: empty; write a ### section and a "- " entry, or delete the file`);
  return sections;
}

export function linkPr(sections: Sections, pr: number): Sections {
  const link = `  ([#${pr}](${REPO}/pull/${pr}))`;
  return new Map([...sections].map(([name, entries]) => [name, entries.map((entry) => entry.includes(`${REPO}/pull/${pr})`) ? entry : `${entry}\n${link}`)]));
}

export function foldChangelog(changelog: string, fragments: { name: string; sections: Sections }[], version: string, date: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected version X.Y.Z without v");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Expected date YYYY-MM-DD");
  if (changelog.includes("\r")) throw new Error("CHANGELOG.md must use LF line endings");
  const lines = changelog.split("\n");
  const start = lines.indexOf(UNRELEASED);
  if (start < 0 || lines.indexOf(UNRELEASED, start + 1) >= 0) throw new Error(`CHANGELOG.md must contain exactly one "${UNRELEASED}" line`);
  const offset = lines.slice(start + 1).findIndex((line) => line.startsWith("## "));
  if (offset < 0) throw new Error("CHANGELOG.md has no release under Unreleased");
  const end = start + 1 + offset;
  const previous = /^## \[(\d+\.\d+\.\d+)\]/.exec(lines[end]!)?.[1];
  if (!previous) throw new Error(`CHANGELOG.md: "${lines[end]}" under Unreleased is not a released version`);
  if (lines.some((line) => line.startsWith(`## [${version}]`))) throw new Error(`CHANGELOG.md already has ${version}`);

  const merged: Sections = readSections(lines.slice(start + 1, end).join("\n"), "CHANGELOG.md", { firstLine: start + 2, hint: CHANGELOG_HINT });
  for (const fragment of fragments) {
    for (const [name, entries] of fragment.sections) merged.set(name, [...(merged.get(name) ?? []), ...entries]);
  }
  if (merged.size === 0) throw new Error(`Nothing to release: Unreleased and ${FRAGMENTS_DIR}/ are both empty`);
  const order = [...SECTIONS.filter((name) => merged.has(name)), ...[...merged.keys()].filter((name) => !(SECTIONS as readonly string[]).includes(name))];
  const notes = order.flatMap((name) => ["", `### ${name}`, ...merged.get(name)!]);

  const unreleasedLink = `[Unreleased]: ${REPO}/compare/v${previous}...HEAD`;
  const legacyLink = lines.indexOf(`[Unreleased]: ${LEGACY_REPO}/compare/v${previous}...HEAD`);
  const link = legacyLink >= end ? legacyLink : lines.indexOf(unreleasedLink);
  if (link < end) throw new Error(`CHANGELOG.md must end its links with "${unreleasedLink}"`);
  const tail = lines.slice(end);
  tail.splice(link - end, 1, `[Unreleased]: ${REPO}/compare/v${version}...HEAD`, `[${version}]: ${REPO}/compare/v${previous}...v${version}`);
  return [...lines.slice(0, start), UNRELEASED, "", `## [${version}] - ${date}`, ...notes, "", ...tail].join("\n");
}

/**
 * The PR whose squash merge added `path` (its subject ends in `(#N)`), if it is merged yet.
 * `--follow` so a later PR that renamed the fragment counts as a rename, not as the add.
 */
function addedBy(path: string): number | undefined {
  const subjects = execFileSync("git", ["log", "--follow", "--diff-filter=A", "--format=%s", "--", path], { encoding: "utf8" });
  const pr = subjects.split("\n").map((subject) => /\(#(\d+)\)$/.exec(subject.trim())?.[1]).find(Boolean);
  return pr ? Number(pr) : undefined;
}

export function fragmentFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name !== FRAGMENTS_README)
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

if (import.meta.main) {
  // the local date (Swedish formats it YYYY-MM-DD), not toISOString's UTC one, which is a day behind in KST mornings
  const [version = "", date = new Date().toLocaleDateString("sv-SE")] = process.argv.slice(2);
  const unlinked: string[] = [];
  const fragments = fragmentFiles(FRAGMENTS_DIR).map((name) => {
    const path = join(FRAGMENTS_DIR, name);
    const pr = addedBy(path);
    if (!pr) unlinked.push(path);
    const sections = parseFragment(readFileSync(path, "utf8"), name);
    return { name, sections: pr ? linkPr(sections, pr) : sections };
  });
  writeFileSync("CHANGELOG.md", foldChangelog(readFileSync("CHANGELOG.md", "utf8"), fragments, version, date));
  for (const { name } of fragments) unlinkSync(join(FRAGMENTS_DIR, name));
  console.log(`CHANGELOG.md: ${version} - ${date}, with the Unreleased notes and ${fragments.length} fragment(s), which are deleted.`);
  if (unlinked.length > 0) console.log(`No merged PR found for (add its link by hand): ${unlinked.join(", ")}`);
  console.log("Next: add `by @login` to the links of PRs from outside contributors (gh pr view N --json author).");
}
