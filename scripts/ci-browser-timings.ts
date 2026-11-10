/**
 * Refreshes scripts/ci-browser-timings.json, the seconds scripts/ci-browser-parallel.ts orders and
 * shards the browser scripts by, from the summary.json that lane writes beside its logs:
 *   bun scripts/ci-browser-timings.ts --runs 5            # the newest 5 green runs of ci.yml on main
 *   bun scripts/ci-browser-timings.ts <summary.json>...   # summaries already on disk; both may be given
 * Every script scripts/ci-browser.sh lists gets its median over the summaries that hold it, in
 * whole seconds. Only a pass on the first run counts: a failure's seconds say nothing of a pass,
 * and a pass on the second run has both runs in its seconds. A listed script no summary holds
 * keeps the seconds it has, a script the list no longer holds leaves the table, and the table is
 * written longest first. With no summary at all, that leaving and that order are all it changes.
 * `--runs` reads through `gh` and changes nothing there: the runs' browser-main-* and
 * browser-other-* artifacts go to a temporary folder that is removed again.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serialBrowserScripts } from "./ci-browser-parallel.ts";

const repo = join(import.meta.dir, "..");
const TABLE = "scripts/ci-browser-timings.json";

/** What the command line asks for: how many CI runs to read, and the summaries already on disk. */
export function refreshRequest(argv: string[]): { runs: number; summaries: string[] } {
  const { values, positionals } = parseArgs({ args: argv, options: { runs: { type: "string" } }, allowPositionals: true });
  if (values.runs === undefined) return { runs: 0, summaries: positionals };
  const runs = Number(values.runs);
  if (!(Number.isInteger(runs) && runs >= 1)) throw new Error(`--runs must be a whole number of runs, 1 or more, not "${values.runs}"`);
  return { runs, summaries: positionals };
}

/** The seconds of every script in one summary.json that passed on its first run. */
export function firstRunSeconds(summary: unknown): Record<string, number> {
  const scripts = (summary as { scripts?: unknown } | null)?.scripts;
  if (!Array.isArray(scripts)) throw new Error("not a browser-logs summary.json: it has no list of scripts");
  const seconds: Record<string, number> = {};
  for (const entry of scripts as { script?: unknown; seconds?: unknown; code?: unknown; firstLog?: unknown }[]) {
    if (typeof entry?.script !== "string" || typeof entry.seconds !== "number" || !Number.isFinite(entry.seconds)) continue;
    if (entry.code !== 0 || entry.firstLog !== undefined) continue;
    seconds[entry.script] = entry.seconds;
  }
  return seconds;
}

/** The middle value, or the mean of the two middle ones; `values` holds at least one. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * The table for the `listed` scripts: each one's median over the `summaries` that hold it, in whole
 * seconds, or the seconds `existing` has for one that none holds. Longest first, and the listed
 * order between scripts of the same seconds, so the same input always writes the same file.
 */
export function refreshTimings(listed: readonly string[], existing: Readonly<Record<string, number>>, summaries: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  const rows = listed.flatMap((script, index) => {
    const seen = summaries.flatMap((summary) => Number.isFinite(summary[script]) ? [summary[script]!] : []);
    const seconds = seen.length > 0 ? Math.round(median(seen)) : existing[script];
    return seconds !== undefined && Number.isFinite(seconds) ? [{ script, index, seconds }] : [];
  });
  return Object.fromEntries(rows.sort((a, b) => b.seconds - a.seconds || a.index - b.index).map(({ script, seconds }) => [script, seconds]));
}

async function gh(args: string[]): Promise<string> {
  const child = Bun.spawn(["gh", ...args], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `gh ${args[0]} ${args[1]} exited ${code}`);
  return stdout;
}

/**
 * Of a run's artifact names, the browser lanes' logs of each job's last attempt. A run that was
 * run again keeps the artifacts of every attempt (`browser-main-<run>-<attempt>`,
 * `browser-other-<shard>-<run>-<attempt>`), and an earlier attempt would count the run twice.
 */
export function lastAttemptArtifacts(names: readonly string[]): string[] {
  const last = new Map<string, { name: string; attempt: number }>();
  for (const name of names) {
    const match = /^(browser-(?:main|other-\d+)-\d+)-(\d+)$/.exec(name);
    if (!match) continue;
    const attempt = Number(match[2]);
    if (attempt > (last.get(match[1]!)?.attempt ?? 0)) last.set(match[1]!, { name, attempt });
  }
  return [...last.values()].map(({ name }) => name).sort();
}

/**
 * Downloads the browser logs of the newest `runs` green pushes to main into `dir`; returns their
 * summary.json files. A run without such logs is passed over (one that changed only docs ran no
 * browser job, and an old run's artifacts have expired); a read or download that fails ends the
 * refresh, so the table is never written from part of the runs asked for.
 */
async function downloadSummaries(runs: number, dir: string): Promise<string[]> {
  const found: { databaseId: number }[] = JSON.parse(await gh([
    "run", "list", "--workflow", "ci.yml", "--branch", "main", "--event", "push", "--status", "success", "--limit", String(runs), "--json", "databaseId",
  ]));
  for (const { databaseId } of found) {
    const kept = await gh(["api", "--paginate", `repos/{owner}/{repo}/actions/runs/${databaseId}/artifacts?per_page=100`, "--jq", ".artifacts[] | select(.expired | not) | .name"]);
    const names = lastAttemptArtifacts(kept.split("\n").filter(Boolean));
    if (names.length === 0) { console.log(`run ${databaseId}: no browser logs kept`); continue; }
    await gh(["run", "download", String(databaseId), ...names.flatMap((name) => ["--name", name]), "--dir", join(dir, String(databaseId))]);
  }
  return [...new Bun.Glob("**/browser-logs/summary.json").scanSync({ cwd: dir, absolute: true })].sort();
}

async function main(): Promise<void> {
  const request = refreshRequest(process.argv.slice(2));
  const path = join(repo, TABLE);
  const existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
  const listed = serialBrowserScripts();
  const dir = request.runs > 0 ? mkdtempSync(join(tmpdir(), "ci-browser-timings-")) : null;
  try {
    const files = [...request.summaries, ...(dir ? await downloadSummaries(request.runs, dir) : [])];
    if (request.runs > 0 && files.length === 0) throw new Error(`No browser-logs summary.json in the newest ${request.runs} green runs of ci.yml on main`);
    const table = refreshTimings(listed, existing, files.map((file) => {
      try { return firstRunSeconds(JSON.parse(readFileSync(file, "utf8"))); } catch (error) { throw new Error(`${file}: ${(error as Error).message}`); }
    }));
    writeFileSync(path, JSON.stringify(table, null, 2) + "\n");
    const changed = listed.filter((script) => table[script] !== existing[script]);
    const dropped = Object.keys(existing).filter((script) => !listed.includes(script));
    const untimed = listed.filter((script) => !(script in table));
    console.log(`${TABLE}: ${files.length} summaries read, ${changed.length} entries changed; ${Object.keys(table).length} of the ${listed.length} listed scripts have one`);
    if (dropped.length > 0) console.log(`No longer listed, dropped: ${dropped.join(", ")}`);
    if (untimed.length > 0) console.log(`In no summary as a pass on the first run, and without an entry, so they keep starting first: ${untimed.join(", ")}`);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
