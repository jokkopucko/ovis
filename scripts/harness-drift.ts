/**
 * Which agent CLIs run without Ovis's own link because their latest release is outside the versions it was measured
 * on: an approval hook's (each adapter's `supports`, server/approvals/adapters.ts) or Codex's own server's
 * (supportsCodexServer). Outside them Ovis adds nothing and falls back to reading the agent's terminal without a word
 * (and pi, which asks nothing itself, runs commands without the approval dialog the hook adds), so a new release
 * (Codex 0.172) turns cards and turn ends back into screen reading on the day it ships.
 *
 *   bun scripts/harness-drift.ts
 *
 * Reads each CLI's latest version from the npm registry, nothing else, and prints a Markdown table of every CLI whose
 * latest release Ovis does not read as data, or whose version could not be read. Exits 1 when the table has a row.
 */
import { APPROVAL_ADAPTERS } from "../server/approvals/adapters.ts";
import { supportsCodexServer } from "../server/approvals/codex.ts";
import { parseVersion } from "../shared/agent-catalog.ts";

export interface Harness {
  /** the agent kind, as herdr names it */
  readonly kind: string;
  /** Ovis's link to it, which a release outside the window runs without */
  readonly link: string;
  /** the npm package its releases are published as */
  readonly npm: string;
  readonly supports: (version: string) => boolean;
}

/** The npm package each agent's official install puts in place (claude.ai, pi.dev, get.omo.dev and omp.sh install these too). */
export const RELEASES: Readonly<Record<string, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  copilot: "@github/copilot",
  omo: "omo-ai",
  omp: "@oh-my-pi/pi-coding-agent",
  pi: "@earendil-works/pi-coding-agent",
};

function releasesOf(kind: string): string {
  const npm = RELEASES[kind];
  if (npm === undefined) throw new Error(`scripts/harness-drift.ts: no npm package for ${kind}; add it to RELEASES`);
  return npm;
}

export const HARNESSES: readonly Harness[] = [
  ...APPROVAL_ADAPTERS.map((adapter) => ({ kind: adapter.kind, link: "Ovis's hook", npm: releasesOf(adapter.kind), supports: (version: string) => adapter.supports(version) })),
  { kind: "codex", link: "its own server", npm: releasesOf("codex"), supports: supportsCodexServer },
];

/** A CLI's latest release, or why it could not be read. */
export type Latest = { readonly version: string } | { readonly error: string };

export interface Drift {
  readonly kind: string;
  readonly npm: string;
  readonly link: string;
  /** the latest version, or why none was read */
  readonly latest: string;
  readonly outside: boolean;
}

/** The CLIs whose latest release Ovis does not read as data (`outside`), and those whose release was not read, in HARNESSES' order. */
export function drifted(harnesses: readonly Harness[], latest: ReadonlyMap<string, Latest>): Drift[] {
  return harnesses.flatMap((harness): Drift[] => {
    const release = latest.get(harness.kind) ?? { error: "not asked" };
    if ("error" in release) return [{ kind: harness.kind, npm: harness.npm, link: harness.link, latest: release.error, outside: false }];
    return harness.supports(release.version) ? [] : [{ kind: harness.kind, npm: harness.npm, link: harness.link, latest: release.version, outside: true }];
  });
}

export function driftTable(rows: readonly Drift[]): string {
  if (rows.length === 0) return "Every agent CLI's latest release is one Ovis reads as data.";
  return [
    "| Agent CLI | npm package | Latest | Now |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.kind} | \`${row.npm}\` | ${row.outside ? row.latest : "unknown"} | ${row.outside ? `runs without ${row.link}: outside the measured versions` : `not checked: ${row.latest}`} |`),
  ].join("\n");
}

async function latestOf(npm: string): Promise<Latest> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${npm}/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { error: `npm answered ${response.status}` };
    const { version } = await response.json() as { version?: unknown };
    // as the server reads an agent's --version: its first dotted number, a pre-release suffix left out
    const numeric = typeof version === "string" ? parseVersion(version) : null;
    return numeric === null ? { error: `npm named no version (${JSON.stringify(version)})` } : { version: numeric };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

if (import.meta.main) {
  const latest = new Map(await Promise.all(HARNESSES.map(async (harness) => [harness.kind, await latestOf(harness.npm)] as const)));
  const rows = drifted(HARNESSES, latest);
  console.log(driftTable(rows));
  process.exitCode = rows.length === 0 ? 0 : 1;
}
