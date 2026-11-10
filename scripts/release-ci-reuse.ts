/**
 * Whether a Release run may take main's own CI as the validation of its commit instead of running
 * ci.yml a second time. .github/workflows/release-validate.yml asks before it calls ci.yml.
 *
 * The answer is yes only for the one push run of ci.yml on main for that exact commit, in this
 * repository, completed with success on its first or second attempt, with every job of ci.yml in
 * it and passed. Anything else is a no, and release-validate.yml then runs ci.yml as it always
 * did: no such run or several, another event, branch, commit or repository, a job that failed, was
 * cancelled or skipped, a job this file does not list, a run waiting behind another run of main, or
 * an answer from GitHub that cannot be read. A run still going is waited for until
 * RELEASE_CI_WAIT_SECONDS have passed or one of its jobs ends without passing. A no only costs a
 * second CI run: it never fails a release.
 *
 *   GITHUB_REPOSITORY, GITHUB_SHA   the commit the Release run publishes
 *   GH_TOKEN                        reads the Actions API (actions: read)
 *   GITHUB_API_URL                  that API, as the runner names it (default https://api.github.com)
 *   REVALIDATE                      the Release run's revalidate input: anything but false is a no, without asking GitHub
 *   RELEASE_CI_WAIT_SECONDS         how long a run still going is waited for (default 2400)
 *
 * Prints `green=true|false` and `run=<id>` for $GITHUB_OUTPUT on stdout and nothing else there (the
 * id only with a yes); what it found goes to stderr and the job summary. It exits 0 whatever happens.
 */
import { appendFileSync, writeSync } from "node:fs";

export const CI_WORKFLOW = ".github/workflows/ci.yml";

/**
 * ci.yml's jobs by the name a run lists them under, the matrix job aside. A push run skips none of
 * them. scripts/release-ci-reuse.test.ts holds this list to ci.yml: a job added, renamed or given a
 * condition a push run may not meet fails the unit suite until this file follows.
 */
export const CI_JOBS = [
  "Detect changes",
  "Native Windows install",
  "Native macOS session identity",
  "Rust PTY host",
  "herdr-core live contract",
  "Fast checks",
  "Integration tests",
  "Browser regression (ui-regression)",
  "Integration and browser",
];
const SHARD = "${{ strategy.job-total > 1 && format(' {0}/{1}', matrix.shard, strategy.job-total) || '' }}";
/** The `name:` of ci.yml's one matrix job, as written there. */
export const CI_MATRIX_JOB = `Browser regression (other scripts${SHARD})`;
/** The sizes of that matrix: one job on the self-hosted PC, four on GitHub's runners (ci.yml's `shard` lists). */
export const CI_SHARD_COUNTS = [1, 4];
/** The names the matrix job runs under for one size: its bare name alone, or `k/N` for every k. */
export const matrixJobs = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => CI_MATRIX_JOB.replace(SHARD, count > 1 ? ` ${index + 1}/${count}` : ""));

/** Main's push run takes 15 to 30 minutes, so 40 cover one that began when the Release run did. */
const WAIT_SECONDS = 2400;
const POLL_MS = 20_000;
/** A read that failed is tried again sooner than a run still going is looked at again. */
const RETRY_MS = 5_000;
const CALL_TIMEOUT_MS = 20_000;
/** GitHub failing to answer this many times in a row is a no. */
const API_ATTEMPTS = 3;

export type Get = (url: string, init: RequestInit) => Promise<Response>;
export interface Commit { repository: string; sha: string }
export interface Run { id: number; status: string; conclusion: string | null; attempt: number }
/** One reading of GitHub. `failed`: main's CI failed on this commit, which the Release run reports as a warning. */
export type Finding = { answer: "yes"; run: number } | { answer: "wait"; why: string } | { answer: "no"; why: string; failed?: true };
export interface Outcome { green: boolean; run: number | null; why: string; failed?: true }
/** `timeout`: the signal that ends one call to GitHub after `ms` (AbortSignal.timeout when left out). */
export interface Clock { now: () => number; sleep: (ms: number) => Promise<unknown>; log: (line: string) => void; timeout?: (ms: number) => AbortSignal }

const no = (why: string, failed = false): Finding => ({ answer: "no", why, ...(failed ? { failed: true as const } : {}) });
/** A conclusion that says the checks failed; a run a newer push cancelled, or a job that never ran, did not fail. */
const failure = (conclusion: string | null): boolean => conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure";
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** A value GitHub sent, for a message: short and on one line. */
const shown = (value: unknown): string => (JSON.stringify(value ?? null) ?? "null").slice(0, 120);
/** A message for the job's log, where a line that starts with `::` is a workflow command. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ");

export const runsPath = ({ repository, sha }: Commit): string =>
  `/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`;
/** `filter=latest`: only the jobs of the run's last attempt. */
export const jobsPath = ({ repository }: Commit, run: number): string =>
  `/repos/${repository}/actions/runs/${run}/jobs?filter=latest&per_page=100`;

/**
 * The one push run of ci.yml on main for `commit` in GitHub's list of runs, or why the list holds
 * no such single run. The request already filters by commit, event and branch; every field is
 * checked again here, so a filter GitHub ignored is a no rather than another run taken on trust.
 */
export function pushRun(answer: unknown, commit: Commit): Run | string {
  const list = record(answer);
  const runs = list?.["workflow_runs"];
  if (!list || !Array.isArray(runs) || !whole(list["total_count"])) return "GitHub's list of runs is not { total_count, workflow_runs }";
  if (list["total_count"] !== runs.length) return `GitHub listed ${runs.length} of ${list["total_count"]} runs`;
  if (runs.length === 0) return "main has no push run of ci.yml for this commit";
  if (runs.length > 1) return `main has ${runs.length} push runs of ci.yml for this commit`;
  const run = record(runs[0]);
  const id = run?.["id"];
  if (!run || !whole(id) || id === 0) return "the run GitHub listed has no id";
  const facts: Array<[string, unknown, string]> = [
    ["path", run["path"], CI_WORKFLOW],
    ["event", run["event"], "push"],
    ["head_branch", run["head_branch"], "main"],
    ["head_sha", run["head_sha"], commit.sha],
    ["repository", record(run["repository"])?.["full_name"], commit.repository],
    ["head_repository", record(run["head_repository"])?.["full_name"], commit.repository],
  ];
  for (const [field, actual, expected] of facts) {
    if (actual !== expected) return `run ${id}: ${field} is ${shown(actual)}, not ${expected}`;
  }
  const { status, conclusion, run_attempt: attempt } = run;
  if (typeof status !== "string" || !(conclusion === null || typeof conclusion === "string") || !whole(attempt)) {
    return `run ${id} has no status, conclusion or run_attempt`;
  }
  return { id, status, conclusion, attempt };
}

/** Why `run` is neither taken nor waited for, whatever its jobs say; null when its jobs decide. */
export function runProblem(run: Run): Finding | null {
  // one rerun of the failed jobs is what a merge is allowed too; a run that needed more proves little
  if (run.attempt !== 1 && run.attempt !== 2) return no(`main's run ${run.id} is on attempt ${run.attempt}, and only a first or second attempt counts`);
  if (run.status === "completed") return run.conclusion === "success" ? null : no(`main's run ${run.id} ended ${shown(run.conclusion)}`, failure(run.conclusion));
  if (run.status === "queued" || run.status === "in_progress") return null;
  // pending: behind another run of main in ci.yml's concurrency group, with no saying when it starts
  return no(`main's run ${run.id} is ${shown(run.status)}, which is not a run to wait for`);
}

/** Why `names` are not exactly ci.yml's jobs, each once, with the matrix job in one of its sizes; null when they are. */
export function namesProblem(names: string[]): string | null {
  const sorted = [...names].sort();
  const expected = CI_SHARD_COUNTS.map((count) => [...CI_JOBS, ...matrixJobs(count)].sort());
  if (expected.some((set) => set.length === sorted.length && set.every((name, index) => name === sorted[index]))) return null;
  const known = new Set(expected.flat());
  const missing = CI_JOBS.filter((name) => !names.includes(name));
  const unexpected = names.filter((name, index) => !known.has(name) || names.indexOf(name) !== index);
  const sizes = CI_SHARD_COUNTS.map((count) => (count === 1 ? "one job" : `all of 1/${count} to ${count}/${count}`)).join(" nor ");
  const parts = [
    ...(missing.length ? [`missing ${missing.map(shown).join(", ")}`] : []),
    ...(unexpected.length ? [`not ci.yml's, or there twice: ${unexpected.map(shown).join(", ")}`] : []),
    ...(missing.length + unexpected.length ? [] : [`${shown(matrixJobs(1)[0])} is neither ${sizes}`]),
  ];
  return `the jobs are not ci.yml's (${parts.join("; ")})`;
}

/**
 * What the jobs of `run`'s last attempt say. A run still going is waited for while none of its jobs
 * has ended without passing; a completed one is a yes only when every job belongs to that attempt
 * of that run, passed, and the names are ci.yml's. A skipped job is not a passed one.
 */
export function jobsFinding(answer: unknown, run: Run, commit: Commit): Finding {
  const list = record(answer);
  const entries = list?.["jobs"];
  if (!list || !Array.isArray(entries) || !whole(list["total_count"])) return no(`GitHub's list of the jobs of run ${run.id} is not { total_count, jobs }`);
  if (list["total_count"] !== entries.length) return no(`GitHub listed ${entries.length} of the ${list["total_count"]} jobs of run ${run.id}`);
  const jobs: Array<{ name: string; status: string; conclusion: string | null }> = [];
  for (const entry of entries) {
    const job = record(entry);
    const name = job?.["name"];
    const status = job?.["status"];
    const conclusion = job?.["conclusion"];
    if (!job || typeof name !== "string" || typeof status !== "string" || !(conclusion === null || typeof conclusion === "string")) {
      return no(`a job of run ${run.id} has no name, status or conclusion`);
    }
    if (job["run_id"] !== run.id || job["run_attempt"] !== run.attempt || job["head_sha"] !== commit.sha) {
      return no(`job ${shown(name)} is not of attempt ${run.attempt} of run ${run.id} for this commit`);
    }
    jobs.push({ name, status, conclusion });
  }
  const ended = jobs.find((job) => job.status === "completed" && job.conclusion !== "success");
  if (ended) return no(`${shown(ended.name)} ended ${shown(ended.conclusion)} in main's run ${run.id}`, failure(ended.conclusion));
  if (run.status !== "completed") return { answer: "wait", why: `main's run ${run.id} is ${run.status} and no job of it has failed` };
  const unfinished = jobs.find((job) => job.status !== "completed");
  if (unfinished) return no(`${shown(unfinished.name)} is ${shown(unfinished.status)} although run ${run.id} is completed`);
  const problem = namesProblem(jobs.map((job) => job.name));
  return problem ? no(`run ${run.id}: ${problem}`) : { answer: "yes", run: run.id };
}

/** One reading of GitHub: the list of runs, then that run's jobs. `read` throws when GitHub cannot be read. */
export async function observe(commit: Commit, read: (path: string) => Promise<unknown>): Promise<Finding> {
  const run = pushRun(await read(runsPath(commit)), commit);
  if (typeof run === "string") return no(run);
  return runProblem(run) ?? jobsFinding(await read(jobsPath(commit, run.id)), run, commit);
}

/**
 * Reads a path of the Actions API as JSON; throws on a transport error, a status that is not 2xx or a
 * body that is not JSON. Every call carries a signal that ends it after CALL_TIMEOUT_MS, so a GitHub
 * that accepts the request and never answers is a failed read, not a job that hangs.
 */
export const reader = (api: string, token: string | undefined, get: Get = fetch, timeout: (ms: number) => AbortSignal = (ms) => AbortSignal.timeout(ms)) => async (path: string): Promise<unknown> => {
  const response = await get(`${api}${path}`, {
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ovis-release-ci-reuse", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    signal: timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`GitHub answered ${response.status}`);
  }
  const body = await response.text();
  try { return JSON.parse(body) as unknown; } catch { throw new Error("GitHub's answer is not JSON"); }
};

/**
 * Reads GitHub until it says yes or no, or `waitMs` have passed: a run still going, and a read that
 * failed fewer than API_ATTEMPTS times in a row, are asked about again every `pollMs`.
 */
export async function reuse(commit: Commit, read: (path: string) => Promise<unknown>, waitMs: number, clock: Clock, pollMs = POLL_MS): Promise<Outcome> {
  const deadline = clock.now() + waitMs;
  let failures = 0;
  for (;;) {
    let finding: Finding;
    let pause = pollMs;
    try {
      finding = await observe(commit, read);
      failures = 0;
    } catch (error) {
      failures += 1;
      const why = `GitHub could not be read (${oneLine((error as Error).message)})`;
      if (failures >= API_ATTEMPTS) return { green: false, run: null, why: `${why}, ${API_ATTEMPTS} times in a row` };
      finding = { answer: "wait", why };
      pause = Math.min(pollMs, RETRY_MS);
    }
    if (finding.answer === "yes") return { green: true, run: finding.run, why: `main's CI run ${finding.run} passed this commit` };
    if (finding.answer === "no") return { green: false, run: null, why: finding.why, ...(finding.failed ? { failed: true } : {}) };
    if (clock.now() >= deadline) return { green: false, run: null, why: `${finding.why}, ${Math.round(waitMs / 1000)} s after this check began` };
    clock.log(`${finding.why}; asking again`);
    await clock.sleep(Math.min(pause, deadline - clock.now()));
  }
}

/** The whole check, from the job's environment. It answers no rather than throw. */
export async function main(env: Record<string, string | undefined>, io: Clock & { get: Get }): Promise<Outcome> {
  const refuse = (why: string): Outcome => ({ green: false, run: null, why });
  const revalidate = env["REVALIDATE"] ?? "";
  if (revalidate !== "" && revalidate !== "false") return refuse("the revalidate input asks for the whole CI in this run");
  const commit = { repository: env["GITHUB_REPOSITORY"] ?? "", sha: env["GITHUB_SHA"] ?? "" };
  if (!/^[\w.-]+\/[\w.-]+$/.test(commit.repository) || !/^[0-9a-f]{40}$/.test(commit.sha)) return refuse("GITHUB_REPOSITORY or GITHUB_SHA does not name a commit");
  const seconds = env["RELEASE_CI_WAIT_SECONDS"] ?? "";
  // a wait that cannot be read is no wait: a run already green is still taken, one still going is not
  const waitMs = seconds === "" ? WAIT_SECONDS * 1000 : /^\d{1,5}$/.test(seconds) ? Number(seconds) * 1000 : 0;
  try {
    return await reuse(commit, reader(env["GITHUB_API_URL"] || "https://api.github.com", env["GH_TOKEN"] || undefined, io.get, io.timeout), waitMs, io);
  } catch (error) {
    return refuse(`the check itself failed (${oneLine((error as Error).message)})`);
  }
}

/** The two lines for $GITHUB_OUTPUT: a run id only beside a yes, and a yes only beside a run id. */
export function outputLines(outcome: Outcome): string {
  const green = outcome.green === true && whole(outcome.run) && outcome.run > 0;
  return `green=${green}\nrun=${green ? outcome.run : ""}\n`;
}

/** What the Release run shows for the outcome: a line in the log, an annotation and the job summary. */
function report(outcome: Outcome, env: Record<string, string | undefined>): void {
  const line = oneLine(outcome.green
    ? `${outcome.why}: this run does not run CI again.`
    : `Running CI in this run: ${outcome.why}.`);
  console.error(`::${outcome.failed ? "warning" : "notice"} title=Release validation::${line}`);
  const summary = env["GITHUB_STEP_SUMMARY"];
  if (!summary) return;
  const link = outcome.green && env["GITHUB_SERVER_URL"] && env["GITHUB_REPOSITORY"]
    ? `\n\n${env["GITHUB_SERVER_URL"]}/${env["GITHUB_REPOSITORY"]}/actions/runs/${outcome.run}`
    : "";
  appendFileSync(summary, `### Release validation\n\n${line}${link}\n`);
}

if (import.meta.main) {
  const outcome = await main(process.env, { get: fetch, now: Date.now, sleep: Bun.sleep, log: (line) => console.error(line) })
    .catch((error: unknown): Outcome => ({ green: false, run: null, why: `the check itself failed (${oneLine(String(error))})` }));
  try { report(outcome, process.env); } catch { /* the answer below does not depend on it */ }
  // one synchronous write, last: an answer is either whole or not there at all
  try { writeSync(1, outputLines(outcome)); } catch { /* no answer is a no to release-validate.yml */ }
  process.exit(0);
}
