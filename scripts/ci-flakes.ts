import { parseArgs } from "node:util";
import { failureSite, TIMEOUT_EXIT_CODE } from "./ci-browser-parallel.ts";

export interface LaneFailure {
  readonly script: string;
  readonly outcome: "failed" | "flaky";
  readonly site: string | null;
  readonly message: string | null;
}

function timedOut(header: string): string | null {
  const said = header.match(/Timed out after \d+s/)?.[0];
  if (said !== undefined) return said;
  return new RegExp(`\\(exit ${TIMEOUT_EXIT_CODE}\\b`).test(header) ? "Timed out" : null;
}

export function parseLaneLog(log: string): LaneFailure[] {
  const clean = Bun.stripANSI(log).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /gm, "");
  const headers = [...clean.matchAll(/^(FAILED|FLAKY) (scripts\/[\w.-]+\.ts)(?=[:\s]).*$/gm)];
  return headers.map((header, index) => {
    const body = clean.slice((header.index ?? 0) + header[0].length, headers[index + 1]?.index ?? clean.length);
    const limit = timedOut(header[0]);
    return {
      script: header[2] ?? "",
      outcome: header[1] === "FLAKY" ? "flaky" : "failed",
      ...(limit === null ? failureSite(body) : { site: null, message: `${limit} (the lane's limit)` }),
    };
  });
}

export interface FailureObservation extends LaneFailure {
  readonly main: boolean;
  readonly runId: number;
  readonly branch: string;
  readonly createdAt: string;
}

export interface RankedFailure {
  readonly script: string;
  readonly site: string | null;
  readonly message: string | null;
  failed: number;
  flaky: number;
  main: number;
  runId: number;
  branch: string;
  createdAt: string;
}

export function aggregateFailures(observations: readonly FailureObservation[]): RankedFailure[] {
  const rows = new Map<string, RankedFailure>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.script, observation.site, observation.message]);
    let row = rows.get(key);
    if (!row) {
      row = { script: observation.script, site: observation.site, message: observation.message, failed: 0, flaky: 0, main: 0, runId: observation.runId, branch: observation.branch, createdAt: observation.createdAt };
      rows.set(key, row);
    }
    row[observation.outcome]++;
    if (observation.main) row.main++;
    if (observation.createdAt > row.createdAt || (observation.createdAt === row.createdAt && observation.runId > row.runId)) {
      row.runId = observation.runId;
      row.branch = observation.branch;
      row.createdAt = observation.createdAt;
    }
  }
  return [...rows.values()].sort((a, b) =>
    (b.failed + b.flaky) - (a.failed + a.flaky) ||
    b.createdAt.localeCompare(a.createdAt) ||
    JSON.stringify([a.script, a.site, a.message]).localeCompare(JSON.stringify([b.script, b.site, b.message])));
}

class GhError extends Error {}

/** A write passes `attempts: 1`, since a 5xx may come after the write was done; `input` is its standard input. */
export async function gh(args: string[], { attempts = 3, input }: { attempts?: number; input?: string } = {}): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const child = Bun.spawn(["gh", ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code === 0) return stdout;
    const message = stderr.trim() || stdout.trim();
    if (attempt >= attempts || !/HTTP 5\d\d\b/.test(message)) throw new GhError(message);
  }
}

async function pooled<T, R>(items: readonly T[], visit: (item: T) => Promise<R>): Promise<R[]> {
  const queue = [...items];
  const results: R[] = [];
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) results.push(await visit(item));
    }
  }));
  return results;
}

/** A run of the default branch itself: a fork's pull request from a branch of that name is not one. */
export const isMainRun = (run: { readonly event: string; readonly head_branch: string }, defaultBranch: string): boolean =>
  run.event !== "pull_request" && run.head_branch === defaultBranch;

interface Run {
  readonly id: number;
  readonly run_attempt: number;
  readonly event: string;
  readonly head_branch: string;
  readonly created_at: string;
  readonly check_suite_node_id: string;
}

interface Job {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

async function flaggedFlaky(repo: string, job: Job): Promise<boolean | "unread"> {
  let text: string;
  try { text = await gh(["api", `repos/${repo}/check-runs/${job.id}/annotations?per_page=100`, "--paginate", "--slurp"]); }
  catch (error) {
    if (error instanceof GhError && /HTTP 5\d\d\b/.test(error.message)) return "unread";
    throw error;
  }
  const pages: Annotation[][] = JSON.parse(text);
  return pages.flat().some(isFlakyWarning);
}

interface Annotation { readonly title: string | null }
const isFlakyWarning = (annotation: Annotation): boolean => annotation.title?.startsWith("Flaky browser script") === true;

/** GraphQL's answer to SUITE_QUERY: one entry per check suite asked for, each check run (a job of any attempt) with its first annotations. */
export interface SuiteAnswer {
  readonly data: { readonly nodes: readonly ({ readonly checkRuns?: { readonly nodes: readonly { readonly databaseId: number; readonly annotations: { readonly totalCount: number; readonly nodes: readonly Annotation[] } }[] } } | null)[] };
}
// checkType ALL: without it a suite lists only its latest attempt's check runs, and the scan reads every attempt
const SUITE_QUERY = "query($ids: [ID!]!) { nodes(ids: $ids) { ... on CheckSuite { checkRuns(first: 100, filterBy: {checkType: ALL}) { nodes { databaseId annotations(first: 15) { totalCount nodes { title } } } } } } }";

/**
 * Whether each check run in the answer carries the flaky warning, by job id (a check run's id is its job's). A run with
 * more annotations than the answer holds, none of them the warning, is left out: its annotations are read through REST.
 */
export function flaggedJobs(answer: SuiteAnswer): Map<number, boolean> {
  const flagged = new Map<number, boolean>();
  for (const run of answer.data.nodes.flatMap((suite) => suite?.checkRuns?.nodes ?? [])) {
    const flaky = run.annotations.nodes.some(isFlakyWarning);
    if (flaky || run.annotations.totalCount <= run.annotations.nodes.length) flagged.set(run.databaseId, flaky);
  }
  return flagged;
}

/**
 * The flaky warnings of these runs' jobs, 20 check suites a GraphQL query: one REST request per passed job would spend
 * most of the Actions token's 1,000 REST requests an hour on a day's scan. A job missing from the map (a suite past 100
 * check runs, or a query a server error or GraphQL's rate limit kept from us) has its annotations read through REST as
 * before.
 */
async function flaggedBySuite(runs: readonly Run[]): Promise<Map<number, boolean>> {
  const flagged = new Map<number, boolean>();
  for (let start = 0; start < runs.length; start += 20) {
    const ids = runs.slice(start, start + 20).flatMap((run) => ["-f", `ids[]=${run.check_suite_node_id}`]);
    let text: string;
    try { text = await gh(["api", "graphql", "-f", `query=${SUITE_QUERY}`, ...ids]); }
    catch (error) {
      if (error instanceof GhError && /HTTP 5\d\d\b|rate limit/i.test(error.message)) continue;
      throw error;
    }
    for (const [job, flaky] of flaggedJobs(JSON.parse(text))) flagged.set(job, flaky);
  }
  return flagged;
}

export interface ScanStats {
  readonly runs: number;
  jobs: number;
  jobsSkipped: number;
  jobsClean: number;
  logsRead: number;
  runsUnread: number;
  logsUnread: number;
}

export interface Scan {
  readonly repo: string;
  readonly hours: number;
  readonly since: string;
  readonly until: string;
  readonly stats: ScanStats;
  readonly rows: readonly RankedFailure[];
}

export async function scan(hours: number, repoName?: string): Promise<Scan> {
  if (!Number.isFinite(hours) || hours <= 0) throw new Error("--hours must be a positive number");
  const repo = repoName ?? (await gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).trim();
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3_600_000).toISOString();
  const runPages: { workflow_runs: Run[] }[] = JSON.parse(await gh([
    "api", `repos/${repo}/actions/workflows/ci.yml/runs?per_page=100&created=${encodeURIComponent(`>=${since}`)}`, "--paginate", "--slurp",
  ]));
  const runs = runPages.flatMap((page) => page.workflow_runs);
  const defaultBranch = (await gh(["api", `repos/${repo}`, "--jq", ".default_branch"])).trim();
  const stats: ScanStats = { runs: runs.length, jobs: 0, jobsSkipped: 0, jobsClean: 0, logsRead: 0, runsUnread: 0, logsUnread: 0 };
  const groups = await pooled(runs, async (run) => {
    const jobs: { run: Run; job: Job }[] = [];
    for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
      let text: string;
      try {
        text = await gh(["api", `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`, "--paginate", "--slurp"]);
      } catch (error) {
        if (!(error instanceof GhError) || !/HTTP 5\d\d\b/.test(error.message)) throw error;
        stats.runsUnread++;
        continue;
      }
      const pages: { jobs: Job[] }[] = JSON.parse(text);
      for (const job of pages.flatMap((page) => page.jobs)) {
        if (!job.name.startsWith("Browser regression")) continue;
        stats.jobs++;
        if (job.status !== "completed" || (job.conclusion !== "success" && job.conclusion !== "failure")) stats.jobsSkipped++;
        else jobs.push({ run, job });
      }
    }
    return jobs;
  });
  const passed = groups.flat().filter(({ job }) => job.conclusion === "success");
  const suites = await flaggedBySuite([...new Set(passed.map(({ run }) => run))]);
  let allowEscapes = true;
  const observations = await pooled(groups.flat(), async ({ run, job }) => {
    const flagged = job.conclusion === "success" ? suites.get(job.id) ?? await flaggedFlaky(repo, job) : true;
    if (flagged === false) {
      stats.jobsClean++;
      return [];
    }
    const args = ["api", `repos/${repo}/actions/jobs/${job.id}/logs`];
    let log: string;
    try {
      try {
        log = await gh(allowEscapes ? [...args, "--allow-escape-sequences"] : args);
      } catch (error) {
        if (!(error instanceof GhError) || !/unknown flag.*allow-escape-sequences/.test(error.message)) throw error;
        allowEscapes = false;
        log = await gh(args);
      }
    } catch (error) {
      if (!(error instanceof GhError) || !/HTTP (404|410|5\d\d)\b/.test(error.message)) throw error;
      if (/HTTP 5\d\d\b/.test(error.message) || flagged === "unread") stats.logsUnread++;
      else stats.jobsSkipped++;
      return [];
    }
    if (!log.trim()) {
      if (flagged === "unread") stats.logsUnread++;
      else stats.jobsSkipped++;
      return [];
    }
    stats.logsRead++;
    return parseLaneLog(log).map((failure) => ({
      ...failure, main: isMainRun(run, defaultBranch), runId: run.id, branch: run.head_branch, createdAt: run.created_at,
    }));
  });
  return { repo, hours, since, until: until.toISOString(), stats, rows: aggregateFailures(observations.flat()) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { hours: { type: "string", default: "24" }, repo: { type: "string" }, json: { type: "boolean", default: false } },
  });
  const { since, stats, rows } = await scan(Number(values.hours), values.repo);
  if (values.json) {
    console.log(JSON.stringify({ ...stats, rows }, null, 2));
    return;
  }
  console.log(`${stats.runs} CI runs since ${since}; browser jobs: ${stats.jobs}, of which ${stats.jobsClean} passed with no second run, ${stats.logsRead} had their log read and ${stats.jobsSkipped} were skipped (running, skipped or without a log).`);
  if (stats.jobs === 0) {
    console.log(stats.runsUnread > 0 ? `Nothing was read: ${stats.runsUnread} run attempts' job lists answered a server error.` : "Nothing was read.");
    return;
  }
  const unread = stats.runsUnread + stats.logsUnread;
  if (unread > 0) console.log(`Not read for a server error: ${stats.runsUnread} run attempts' job lists and ${stats.logsUnread} jobs whose log or annotations could not be read.`);
  if (rows.length === 0) {
    console.log(unread > 0 ? "No browser script failed or needed a second run in what could be read." : "No browser script failed or needed a second run.");
    return;
  }
  console.log("failed\tflaky\ton main\tscript\tsite\tmessage\tmost recent run\tbranch");
  for (const row of rows) console.log([row.failed, row.flaky, row.main, row.script, row.site ?? "-", row.message ?? "-", row.runId, row.branch].join("\t"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
