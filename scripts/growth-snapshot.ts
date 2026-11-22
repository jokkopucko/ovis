/**
 *   bun scripts/growth-snapshot.ts --out <dir> [--repo owner/name]
 *
 * Reads, through the gh CLI on PATH (its own sign-in, or GH_TOKEN): the repository's counts,
 * traffic/views, traffic/clones, traffic/popular/referrers, traffic/popular/paths, and every
 * stargazer's star date. Writes <dir>/snapshot-<day>.json and <dir>/stars-by-day.csv. The traffic
 * endpoints need push access to the repository; GitHub keeps them for 14 days only, which is why
 * they are saved every week.
 *
 * Who starred is never kept: only the day of each star. The traffic's referrers and paths go to
 * the snapshot JSON alone: the line printed, which a workflow log shows, has only totals.
 *
 * Exit codes: 0 when counts and star dates were read (a traffic endpoint that failed is recorded as
 * {"error": "<status>"}), 2 when every traffic endpoint failed (a token without access, which
 * should turn a scheduled run red), 1 when the repository itself could not be read (nothing is
 * written), 3 when any stargazer page failed (no new output; a previous snapshot is left intact).
 * Files are staged before publication; an output failure exits 1.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Answer = { ok: true; body: unknown } | { ok: false; status: string };

async function gh(path: string, headers: string[] = []): Promise<Answer> {
  const child = Bun.spawn(["gh", "api", ...headers.flatMap((header) => ["-H", header]), path], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) return { ok: false, status: /HTTP (\d{3})/.exec(err)?.[1] ?? "failed" };
  try {
    return { ok: true, body: JSON.parse(out) };
  } catch {
    return { ok: false, status: "unreadable" };
  }
}

function argument(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

const args = process.argv.slice(2);
const out = argument(args, "--out");
const repo = argument(args, "--repo") ?? "devswha/ovis";
if (!out || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error("Usage: bun scripts/growth-snapshot.ts --out <dir> [--repo owner/name]");
  process.exit(1);
}

const meta = await gh(`repos/${repo}`);
if (!meta.ok) {
  console.error(`growth snapshot: could not read ${repo} (${meta.status})`);
  process.exit(1);
}
const counts = meta.body as Record<string, unknown>;
const totals = { stargazers_count: counts["stargazers_count"], forks_count: counts["forks_count"], subscribers_count: counts["subscribers_count"] };

const TRAFFIC = ["views", "clones", "popular/referrers", "popular/paths"] as const;
const traffic: Record<string, unknown> = {};
let failed = 0;
for (const name of TRAFFIC) {
  const answer = await gh(`repos/${repo}/traffic/${name}`);
  traffic[name] = answer.ok ? answer.body : { error: answer.status };
  if (!answer.ok) {
    failed += 1;
    console.error(`growth snapshot: traffic/${name} unavailable (${answer.status})`);
  }
}

// every page of stargazers with their star dates; only the day is kept
const starsByDay: Record<string, number> = {};
let starsRead = 0;
let starsError: string | null = null;
for (let page = 1; ; page += 1) {
  const answer = await gh(`repos/${repo}/stargazers?per_page=100&page=${page}`, ["Accept: application/vnd.github.star+json"]);
  if (!answer.ok || !Array.isArray(answer.body)) {
    starsError = answer.ok ? "unreadable" : answer.status;
    console.error(`growth snapshot: stargazers page ${page} unavailable (${starsError})`);
    break;
  }
  for (const entry of answer.body as Array<{ starred_at?: unknown }>) {
    if (typeof entry?.starred_at !== "string") continue;
    const day = entry.starred_at.slice(0, 10);
    starsByDay[day] = (starsByDay[day] ?? 0) + 1;
    starsRead += 1;
  }
  if (answer.body.length < 100) break;
}

// Do not publish partial dates or pair a new snapshot with a previous run's CSV.
// Star history can be fetched again; leave any previous complete output intact.
if (starsError !== null) process.exit(3);

const takenAt = new Date().toISOString();
const days = Object.keys(starsByDay).sort();
const snapshot = {
  taken_at: takenAt,
  repo,
  totals,
  views: traffic["views"],
  clones: traffic["clones"],
  referrers: traffic["popular/referrers"],
  paths: traffic["popular/paths"],
  stars_by_day: starsError === null ? Object.fromEntries(days.map((day) => [day, starsByDay[day]!])) : { error: starsError },
};
let cumulative = 0;
const csv = ["date,new_stars,cumulative", ...days.map((day) => `${day},${starsByDay[day]},${(cumulative += starsByDay[day]!)}`)].join("\n") + "\n";

mkdirSync(out, { recursive: true });
const staging = mkdtempSync(join(out, ".snapshot-"));
const snapshotName = `snapshot-${takenAt.slice(0, 10)}.json`;
try {
  writeFileSync(join(staging, snapshotName), JSON.stringify(snapshot, null, 1) + "\n");
  writeFileSync(join(staging, "stars-by-day.csv"), csv);
  // Publish CSV first: a failed CSV write or replacement must not leave new JSON.
  renameSync(join(staging, "stars-by-day.csv"), join(out, "stars-by-day.csv"));
  renameSync(join(staging, snapshotName), join(out, snapshotName));
} finally {
  rmSync(staging, { recursive: true, force: true });
}

const viewCount = (traffic["views"] as { count?: unknown } | undefined)?.count;
console.log(`growth snapshot: ${repo} stars=${totals.stargazers_count} stars_dated=${starsRead} views_14d=${typeof viewCount === "number" ? viewCount : "n/a"} traffic_failed=${failed}/${TRAFFIC.length}`);
process.exit(failed === TRAFFIC.length ? 2 : 0);
