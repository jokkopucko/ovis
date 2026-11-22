import { readSummary, RELEASES_LIMIT, type ReleaseNote, type ReleaseSummary, type UpdateNotes } from "../shared/update.ts";

const SECTION = /^## \[(\d+\.\d+\.\d+)\](?:\s+-\s+(\S+))?\s*$/;
const BOUNDARY = /^## \[(?:unreleased|\d+\.\d+\.\d+[^\]]*)\]/i;
const LINK_DEFINITION = /^\[[^\]]+\]:\s/;
export const NOTES_BUDGET = 48_000;
export const SUMMARIES_FILE = "release-summaries.json";

function triple(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export function compareVersions(a: string, b: string): number | null {
  const first = triple(a), second = triple(b);
  return first && second ? compare(first, second) : null;
}

/**
 * release-summaries.json as a release wrote it:
 * `{ "0.3.53": { "en": { "new": ["…"], "improved": ["…"], "fixed": ["…"] }, "ko": { … }, … } }`.
 * It is text from a Git remote, like the changelog: what is not a version with lines in a
 * language the app has is left out, and a file that is not JSON holds no summary.
 */
export function releaseSummaries(text: string): Map<string, ReleaseSummary> {
  const found = new Map<string, ReleaseSummary>();
  let written: unknown;
  try { written = JSON.parse(text); } catch { return found; }
  if (typeof written !== "object" || written === null || Array.isArray(written)) return found;
  for (const [version, entry] of Object.entries(written)) {
    const summary = triple(version) ? readSummary(entry) : undefined;
    if (summary) found.set(version, summary);
  }
  return found;
}

function sections(changelog: string): ReleaseNote[] {
  const found: ReleaseNote[] = [];
  let open: { version: string; date: string | null; lines: string[] } | null = null;
  const close = () => {
    if (open) found.push({ version: open.version, date: open.date, notes: open.lines.join("\n").trim() });
    open = null;
  };
  for (const line of changelog.split(/\r?\n/)) {
    if (BOUNDARY.test(line)) {
      close();
      const match = SECTION.exec(line);
      if (match) open = { version: match[1]!, date: match[2] ?? null, lines: [] };
    } else if (open && !LINK_DEFINITION.test(line)) open.lines.push(line);
  }
  close();
  return found;
}

function summarySize(summary: ReleaseSummary | undefined): number {
  return summary ? JSON.stringify(summary).length : 0;
}

export function releaseNotes(
  changelog: string, current: string | null, latest: string, budget = NOTES_BUDGET,
  summaries: ReadonlyMap<string, ReleaseSummary> = new Map(),
): Omit<UpdateNotes, "revision"> {
  const to = triple(latest);
  if (!to) return { releases: [], omitted: 0 };
  const from = current === null ? null : triple(current);
  const seen = new Set<string>();
  const wanted = sections(changelog)
    .filter((section) => {
      const version = triple(section.version)!;
      if (section.notes === "" || compare(version, to) > 0 || seen.has(section.version)) return false;
      seen.add(section.version);
      return from ? compare(version, from) > 0 : compare(version, to) === 0;
    })
    .sort((a, b) => compare(triple(b.version)!, triple(a.version)!))
    .map((section) => {
      const summary = summaries.get(section.version);
      return summary ? { ...section, summary } : section;
    });
  const releases: ReleaseNote[] = [];
  let used = 0;
  for (const section of wanted) {
    const size = section.notes.length + summarySize(section.summary);
    if (releases.length === 0 && size > budget) {
      const { summary: written, ...told } = section;
      const summary = written && summarySize(written) < budget ? written : undefined;
      const room = budget - summarySize(summary);
      const cut = section.notes.lastIndexOf("\n", room);
      const notes = section.notes.length > room ? `${section.notes.slice(0, cut > 0 ? cut : room).trimEnd()}\n\n…` : section.notes;
      releases.push(summary ? { ...told, summary, notes } : { ...told, notes });
      break;
    }
    if (releases.length === RELEASES_LIMIT || used + size > budget) break;
    releases.push(section);
    used += size;
  }
  return { releases, omitted: wanted.length - releases.length };
}
