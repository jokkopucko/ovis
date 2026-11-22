/**
 * The pull request of a workspace's branch, read and merged through the `gh` this PC already has
 * signed in: nothing new to sign in to, and no token passes through this server. gh runs in the
 * workspace's folder, so it finds the branch's pull request and the repository itself.
 */
import { PULL_REQUEST_LOG_CHARS, PULL_REQUEST_LOG_LINES, PULL_REQUEST_MAX_COMMENT_CHARS, PULL_REQUEST_MAX_THREADS,
  type PullRequestCheck, type PullRequestCheckLog, type PullRequestCheckState, type PullRequestMergeMethod, type PullRequestThread, type PullRequestView } from "../shared/pull-request.ts";

export interface PullRequestOptions {
  gh?: readonly string[];
  deadlineMs?: number;
}

export class PullRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
  }
}

const DEADLINE_MS = 20_000;
/** a pull request's JSON with its checks is a few hundred kilobytes at most */
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const OID = /^[0-9a-f]{40}$/;
const JOB_ID = /^[0-9]{1,20}$/;
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
const MERGEABLE_STATES = new Set(["clean", "unstable", "has_hooks"]);
const MERGE_QUEUE_QUERY = "query($owner:String!,$name:String!,$base:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$base){id}}}";
const PR_FIELDS = "number,title,url,state,isDraft,headRefName,baseRefName,headRefOid,mergeStateStatus,statusCheckRollup";
/** resolved threads are only skipped here: GitHub filters none, so pages are read until enough open ones are found */
const THREAD_PAGES = 10;
const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!,$base:String!,$after:String){repository(owner:$owner,name:$name){viewerDefaultMergeMethod mergeQueue(branch:$base){id} pullRequest(number:$number){reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated path line comments(first:1){totalCount nodes{author{login} body url}}}}}}}`;

function ghEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  return { ...env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GH_PAGER: "cat", NO_COLOR: "1", CLICOLOR: "0", GIT_TERMINAL_PROMPT: "0" };
}

interface GhRun { code: number; stdout: string; stderr: string }

async function readCapped(stream: ReadableStream<Uint8Array>, maxBytes: number, keepTail: boolean): Promise<{ text: string; overflow: boolean }> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let overflow = false;
  for await (const chunk of stream) {
    chunks.push(chunk);
    bytes += chunk.byteLength;
    while (bytes > maxBytes) {
      overflow = true;
      if (!keepTail) return { text: "", overflow };
      bytes -= chunks.shift()!.byteLength;
    }
  }
  return { text: Buffer.concat(chunks).toString("utf8"), overflow };
}

async function runGh(cwd: string, args: string[], options: PullRequestOptions, keepTail = false): Promise<GhRun & { overflow: boolean }> {
  const found = options.gh ?? (() => { const path = Bun.which("gh"); return path === null ? null : [path]; })();
  if (found === null) throw new PullRequestError("gh_missing", "GitHub CLI (gh) is not installed on this PC", 409);
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn([...found, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: ghEnvironment() });
  } catch {
    throw new PullRequestError("gh_missing", "GitHub CLI (gh) is not installed on this PC", 409);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // the deadline holds the answer, not only gh: a child gh started (git) may keep the pipes open after gh is gone
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { proc.kill(); reject(new PullRequestError("gh_timeout", "gh did not answer in time", 504)); }, options.deadlineMs ?? DEADLINE_MS);
  });
  try {
    const [out, err, code] = await Promise.race([Promise.all([readCapped(proc.stdout, keepTail ? LOG_KEEP_BYTES : MAX_JSON_BYTES, keepTail).then((read) => { if (read.overflow && !keepTail) proc.kill(); return read; }), readCapped(proc.stderr, MAX_STDERR_BYTES, true), proc.exited]), deadline]);
    if (out.overflow && !keepTail) throw new PullRequestError("gh_failed", "gh answered more than this view reads", 502);
    // gh exits 4 when it needs a sign-in; older releases only say so
    if (code === 4 || /gh auth login/.test(err.text)) throw new PullRequestError("gh_signed_out", "gh on this PC is not signed in to GitHub", 409);
    return { code, stdout: out.text, stderr: err.text, overflow: out.overflow };
  } finally {
    clearTimeout(timer);
  }
}

/** gh's first line of complaint, as one plain line: shown in the view, so no control characters */
function firstLine(stderr: string): string {
  return (stderr.split("\n").find((line) => line.trim() !== "") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/^X\s+/, "").trim().slice(0, 300);
}

function failure(stderr: string, fallback: string): PullRequestError {
  if (/no pull requests found/i.test(stderr)) return new PullRequestError("no_pull_request", "This branch has no pull request", 404);
  if (/not a git repository/i.test(stderr)) return new PullRequestError("not_a_repository", "This folder is not inside a git repository", 409);
  if (/none of the git remotes|no git remotes/i.test(stderr)) return new PullRequestError("no_github_remote", "This repository has no GitHub remote", 409);
  return new PullRequestError("gh_failed", firstLine(stderr) || fallback, 502);
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | null => typeof value === "string" && value !== "" ? value : null;
const httpUrl = (value: unknown): string | null => { const url = text(value); return url !== null && /^https?:\/\//.test(url) ? url : null; };

function checkState(item: Record<string, unknown>): PullRequestCheckState {
  if (item["__typename"] === "StatusContext") {
    const state = String(item["state"] ?? "").toUpperCase();
    return state === "SUCCESS" ? "pass" : state === "FAILURE" || state === "ERROR" ? "fail" : "pending";
  }
  if (String(item["status"] ?? "").toUpperCase() !== "COMPLETED") return "pending";
  switch (String(item["conclusion"] ?? "").toUpperCase()) {
    case "SUCCESS": return "pass";
    case "SKIPPED": return "skipped";
    case "NEUTRAL": case "STALE": return "neutral";
    default: return "fail";
  }
}

const CHECK_ORDER: Record<PullRequestCheckState, number> = { fail: 0, pending: 1, pass: 2, neutral: 3, skipped: 3 };

function checksOf(rollup: unknown): PullRequestCheck[] {
  const checks = (Array.isArray(rollup) ? rollup : []).map(record).map((item): PullRequestCheck => {
    const status = item["__typename"] === "StatusContext";
    const url = httpUrl(status ? item["targetUrl"] : item["detailsUrl"]);
    return {
      name: text(status ? item["context"] : item["name"]) ?? "check",
      workflow: status ? null : text(item["workflowName"]),
      state: checkState(item),
      url,
      job_id: status || url === null ? null : url.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1] ?? null,
    };
  });
  return checks.map((check, index) => ({ check, index })).sort((a, b) => CHECK_ORDER[a.check.state] - CHECK_ORDER[b.check.state] || a.index - b.index).map(({ check }) => check);
}

function threadsOf(connection: Record<string, unknown>): PullRequestThread[] {
  const nodes = (Array.isArray(connection["nodes"]) ? connection["nodes"] : []).map(record);
  return nodes.filter((node) => node["isResolved"] !== true).map((node): PullRequestThread => {
    const comments = record(node["comments"]);
    const first = record((Array.isArray(comments["nodes"]) ? comments["nodes"] : [])[0]);
    return {
      path: text(node["path"]) ?? "",
      line: typeof node["line"] === "number" ? node["line"] : null,
      outdated: node["isOutdated"] === true,
      author: text(record(first["author"])["login"]),
      body: (text(first["body"]) ?? "").slice(0, PULL_REQUEST_MAX_COMMENT_CHARS),
      comments: typeof comments["totalCount"] === "number" ? comments["totalCount"] : 1,
      url: httpUrl(first["url"]),
    };
  });
}

/** `-f`, not `-F`: gh would send a repository named `2048` or `true` as a number or a boolean */
const repositoryVariables = (owner: string, name: string): string[] => ["-f", `owner=${owner}`, "-f", `name=${name}`];

function placeOf(url: string | null): { host: string; owner: string; name: string } | null {
  const match = url?.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/);
  return match ? { host: match[1]!, owner: match[2]!, name: match[3]! } : null;
}

function parseJson(stdout: string): Record<string, unknown> {
  try { return record(JSON.parse(stdout)); } catch { throw new PullRequestError("gh_failed", "gh answered something this view cannot read", 502); }
}

/** GET /api/workspace/pr: the pull request of the branch checked out in `cwd`. */
export async function pullRequestView(cwd: string, options: PullRequestOptions = {}): Promise<PullRequestView> {
  const viewed = await runGh(cwd, ["pr", "view", "--json", PR_FIELDS], options);
  if (viewed.code !== 0) throw failure(viewed.stderr, "gh could not read this branch's pull request");
  const pr = parseJson(viewed.stdout);
  const url = httpUrl(pr["url"]);
  const number = pr["number"];
  const headOid = text(pr["headRefOid"]);
  const place = placeOf(url);
  if (url === null || typeof number !== "number" || headOid === null || !OID.test(headOid) || place === null) throw new PullRequestError("gh_failed", "gh answered something this view cannot read", 502);
  const { host, owner, name } = place;
  const baseRef = text(pr["baseRefName"]) ?? "";
  const threads: PullRequestThread[] = [];
  let repository: Record<string, unknown> = {};
  let after: string | null = null;
  let more = false;
  for (let page = 0; page < THREAD_PAGES && threads.length <= PULL_REQUEST_MAX_THREADS; page++) {
    const queried = await runGh(cwd, ["api", "graphql", ...(host === "github.com" ? [] : ["--hostname", host]), "-f", `query=${THREADS_QUERY}`, ...repositoryVariables(owner, name), "-F", `number=${number}`, "-f", `base=${baseRef}`, ...(after === null ? [] : ["-f", `after=${after}`])], options);
    if (queried.code !== 0) throw failure(queried.stderr, "gh could not read the review threads");
    repository = record(record(parseJson(queried.stdout)["data"])["repository"]);
    const connection = record(record(repository["pullRequest"])["reviewThreads"]);
    threads.push(...threadsOf(connection));
    const pageInfo = record(connection["pageInfo"]);
    after = text(pageInfo["endCursor"]);
    more = pageInfo["hasNextPage"] === true && after !== null;
    if (!more) break;
  }
  const method = String(repository["viewerDefaultMergeMethod"] ?? "MERGE").toLowerCase();
  const mergeQueue = repository["mergeQueue"] !== null && repository["mergeQueue"] !== undefined;
  const state = String(pr["state"] ?? "").toLowerCase();
  const mergeState = String(pr["mergeStateStatus"] ?? "unknown").toLowerCase();
  const draft = pr["isDraft"] === true;
  return {
    number,
    title: text(pr["title"]) ?? "",
    url,
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
    draft,
    head_ref: text(pr["headRefName"]) ?? "",
    base_ref: baseRef,
    head_oid: headOid,
    merge_state: mergeState,
    merge_queue: mergeQueue,
    mergeable: state === "open" && !draft && !mergeQueue && MERGEABLE_STATES.has(mergeState),
    merge_method: method === "squash" || method === "rebase" ? method : "merge",
    checks: checksOf(pr["statusCheckRollup"]),
    threads: threads.slice(0, PULL_REQUEST_MAX_THREADS),
    threads_truncated: more || threads.length > PULL_REQUEST_MAX_THREADS,
  };
}

/** GitHub's log line prefix: an ISO time, then a space */
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
/** terminal escapes: links and titles (OSC), colours and moves (CSI), and the two-byte ones (`ESC(B`) */
const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[ -/]*[0-~]/g;
/** a sent message holds no control character but tab and newline (shared/protocol.ts) */
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** GET /api/workspace/pr/log: the last lines of an Actions job's log, from the workspace's repository. */
export async function pullRequestLog(cwd: string, jobId: string, host: string, options: PullRequestOptions = {}): Promise<PullRequestCheckLog> {
  if (!JOB_ID.test(jobId)) throw new PullRequestError("invalid_job", "job_id must be an Actions job's number", 400);
  if (!HOST.test(host)) throw new PullRequestError("invalid_host", "host must be the pull request's GitHub host", 400);
  // gh api goes to github.com unless told: an Enterprise repository's path and the github.com token must not
  const run = await runGh(cwd, ["api", ...(host === "github.com" ? [] : ["--hostname", host]), `repos/{owner}/{repo}/actions/jobs/${jobId}/logs`], options, true);
  if (run.code !== 0) throw failure(run.stderr, "gh could not read that job's log");
  const lines = run.stdout.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(TIMESTAMP, "").replace(ESCAPES, "").replace(CONTROLS, ""));
  if (run.overflow) lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  let kept = lines.slice(-PULL_REQUEST_LOG_LINES);
  while (kept.length > 1 && kept.join("\n").length > PULL_REQUEST_LOG_CHARS) kept = kept.slice(1);
  const joined = kept.join("\n");
  return { job_id: jobId, text: joined.slice(-PULL_REQUEST_LOG_CHARS), truncated: run.overflow || kept.length < lines.length || joined.length > PULL_REQUEST_LOG_CHARS };
}

export interface MergeInput { number: number; head_oid: string; base_ref: string; method: PullRequestMergeMethod }

/** The body of POST /api/workspace/pr/merge, past its folder fields; null when it is not one. */
export function mergeInputOf(body: Record<string, unknown>): MergeInput | null {
  const { number, head_oid: headOid, base_ref: baseRef, method } = body;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) return null;
  if (typeof headOid !== "string" || !OID.test(headOid)) return null;
  if (typeof baseRef !== "string" || baseRef === "" || baseRef.length > 255) return null;
  if (method !== "merge" && method !== "squash" && method !== "rebase") return null;
  return { number, head_oid: headOid, base_ref: baseRef, method };
}

/**
 * POST /api/workspace/pr/merge: GitHub merges the pull request only while its head is still the
 * commit the view showed (`--match-head-commit`); its base, which gh cannot pin, is read again just
 * before, so a pull request moved to another base is not merged into it. The branch stays: the
 * workspace has it checked out.
 */
export async function mergePullRequest(cwd: string, input: MergeInput, options: PullRequestOptions = {}): Promise<void> {
  const viewed = await runGh(cwd, ["pr", "view", String(input.number), "--json", "baseRefName,headRefOid,url"], options);
  if (viewed.code !== 0) throw failure(viewed.stderr, "gh could not read the pull request");
  const now = parseJson(viewed.stdout);
  if (now["baseRefName"] !== input.base_ref || now["headRefOid"] !== input.head_oid) throw new PullRequestError("pull_request_changed", "The pull request changed since it was shown; refresh it before merging", 409);
  // through a merge queue gh only queues it, and the queue merges whatever the head is by then
  const place = placeOf(httpUrl(now["url"]));
  if (place === null) throw new PullRequestError("gh_failed", "gh answered something this view cannot read", 502);
  const queued = await runGh(cwd, ["api", "graphql", ...(place.host === "github.com" ? [] : ["--hostname", place.host]), "-f", `query=${MERGE_QUEUE_QUERY}`, ...repositoryVariables(place.owner, place.name), "-f", `base=${input.base_ref}`], options);
  if (queued.code !== 0) throw failure(queued.stderr, "gh could not read the base branch's merge rules");
  if (record(record(parseJson(queued.stdout)["data"])["repository"])["mergeQueue"] != null) throw new PullRequestError("merge_queue", "This base branch merges through a merge queue; merge it on GitHub", 409);
  const run = await runGh(cwd, ["pr", "merge", String(input.number), `--${input.method}`, "--match-head-commit", input.head_oid], options);
  if (run.code !== 0) throw new PullRequestError("merge_refused", firstLine(run.stderr) || "GitHub did not merge the pull request", 409);
}
