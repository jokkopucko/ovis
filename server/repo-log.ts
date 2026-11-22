import type { RepoBranch, RepoBranches, RepoCommit, RepoCommitDetail, RepoLog } from "../shared/protocol.ts";
import { errorResponse, jsonResponse } from "./http.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { type Context, EMPTY_TREE_OIDS, type GitRun, MAX_REFNAME_BYTES, OID, RepoDiffError, type RepoDiffOptions, checkRevision, contextOf, repositoryOf, resolveRevision, runGit } from "./repo-diff.ts";

/**
 * A repository's history, read with git and never written: a page of commits, the local branches
 * with their upstreams, and one commit's whole message. They run git as the diff routes do
 * (`repo-diff.ts`: argv only, the same safety flags, byte caps and deadline), and one commit's
 * changes are read with those routes, against the `base` the commit read names.
 */

export const REPO_LOG_MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const MAX_SKIP = 999_999_999;
export const REPO_COMMIT_MAX_MESSAGE_BYTES = 64 * 1024;

export interface RepoLogOptions extends RepoDiffOptions {
  maxMessageBytes?: number;
}

const historyContext = (options: RepoLogOptions): Context => contextOf({ ...options, noLazyFetch: true });

/** No signature is checked (that runs gpg), and the text is UTF-8 whatever the repository's log encoding. */
const LOG_FLAGS = ["--no-color", "--no-decorate", "--no-show-signature", "--encoding=UTF-8", "-z"];
const COMMIT_FIELDS = ["%H", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%s"];
/** Each field ends in a NUL, and `-z` ends each commit with one more. */
const COMMIT_FORMAT = `--format=${COMMIT_FIELDS.map((field) => `${field}%x00`).join("")}`;

type CommitRow = Omit<RepoCommit, "refs">;

/** The whole commits of `log` output in COMMIT_FORMAT: what follows the last complete one was cut short. */
function commitsOf(output: string): CommitRow[] {
  const end = output.lastIndexOf("\0");
  const tokens = end < 0 ? [] : output.slice(0, end).split("\0");
  const width = COMMIT_FIELDS.length + 1;
  const commits: CommitRow[] = [];
  for (let index = 0; index + width <= tokens.length; index += width) {
    const [oid, parents, authorName, authorEmail, authorTime, committerName, committerEmail, committerTime, subject, separator] = tokens.slice(index, index + width);
    if (oid === undefined || !OID.test(oid) || separator !== "") break;
    commits.push({
      oid,
      parents: parents === "" || parents === undefined ? [] : parents.split(" "),
      author: { name: authorName ?? "", email: authorEmail ?? "", time: authorTime ?? "" },
      committer: { name: committerName ?? "", email: committerEmail ?? "", time: committerTime ?? "" },
      subject: subject ?? "",
    });
  }
  return commits;
}

/** The branches, remote branches and tags at these commits, an annotated tag at the commit it names. */
async function refsAt(context: Context, root: string, oids: string[]): Promise<{ refs: Map<string, string[]>; complete: boolean }> {
  const refs = new Map<string, string[]>();
  if (oids.length === 0) return { refs, complete: true };
  const run = await runGit(context, root, ["for-each-ref", "--format=%(objectname)%00%(*objectname)%00%(symref)%00%(refname)", "--sort=refname", ...oids.map((oid) => `--points-at=${oid}`), "--", "refs/heads/", "refs/remotes/", "refs/tags/"], context.maxListBytes);
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not list this repository's refs", 500);
  // one ref per line, read by its full name so a name with a comma or a slash reads as itself
  for (const line of run.stdout.split("\n").slice(0, -1)) {
    const [oid, peeled, symref, name] = line.split("\0");
    const at = peeled === "" ? oid : peeled;
    if (at === undefined || name === undefined || symref !== "" || Buffer.byteLength(name) > MAX_REFNAME_BYTES) continue;
    refs.set(at, [...(refs.get(at) ?? []), name]);
  }
  return { refs, complete: !run.overflow };
}

function countOf(params: URLSearchParams, name: string, code: string, min: number, max: number, fallback: number): number {
  const value = params.get(name);
  if (value === null || value === "") return fallback;
  if (!/^\d{1,9}$/.test(value) || Number(value) < min || Number(value) > max) throw new RepoDiffError(code, `${name} must be a whole number from ${min} to ${max}`, 400);
  return Number(value);
}

function checkLog(run: GitRun): void {
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not read this repository's history", 500);
}

export async function repoLog(cwd: string, params: URLSearchParams, options: RepoLogOptions = {}): Promise<RepoLog> {
  const context = historyContext(options);
  const limit = countOf(params, "limit", "invalid_limit", 1, REPO_LOG_MAX_LIMIT, DEFAULT_LIMIT);
  const skip = countOf(params, "skip", "invalid_skip", 0, MAX_SKIP, 0);
  const pinned = params.get("oid") ?? "";
  if (pinned !== "" && !OID.test(pinned)) throw new RepoDiffError("invalid_revision", "oid must be the full commit hash a first page answered with", 400);
  const repository = await repositoryOf(context, cwd);
  const root = repository.root;
  const ref = params.get("ref") || "HEAD";
  await checkRevision(context, root, "ref", ref);
  let oid: string | null;
  if (pinned !== "") {
    if (await resolveRevision(context, root, "oid", pinned) !== pinned) throw new RepoDiffError("revision_not_found", "oid names no commit in this repository", 404);
    oid = pinned;
  } else {
    oid = ref === "HEAD" && repository.head === null ? null : await resolveRevision(context, root, "ref", ref);
  }
  const limits = { max_limit: REPO_LOG_MAX_LIMIT, max_list_bytes: context.maxListBytes };
  if (oid === null) return { repository, ref, oid, skip, commits: [], next_skip: null, refs_truncated: false, limits };

  const run = await runGit(context, root, ["log", ...LOG_FLAGS, COMMIT_FORMAT, `--skip=${skip}`, `--max-count=${limit + 1}`, "--end-of-options", oid, "--"], context.maxListBytes);
  checkLog(run);
  const read = commitsOf(run.stdout);
  if (read.length === 0 && run.overflow) throw new RepoDiffError("too_large", "a commit on this page is too large to list", 500);
  const page = read.slice(0, limit);
  const { refs, complete } = await refsAt(context, root, page.map((entry) => entry.oid));
  return {
    repository,
    ref,
    oid,
    skip,
    commits: page.map((entry) => ({ ...entry, refs: refs.get(entry.oid) ?? [] })),
    next_skip: read.length > limit || run.overflow ? skip + page.length : null,
    refs_truncated: !complete,
    limits,
  };
}

const BRANCH_FORMAT = "--format=%(HEAD)%00%(refname)%00%(objectname)%00%(symref)%00%(upstream)%00%(upstream:track,nobracket)%00%(committerdate:iso-strict)%00%(contents:subject)";

/** `for-each-ref` rows in BRANCH_FORMAT; what follows the last newline was cut short. */
function branchesOf(output: string): RepoBranch[] {
  const branches: RepoBranch[] = [];
  for (const line of output.split("\n").slice(0, -1)) {
    const [head, name, oid, symref, upstream, track, committed, subject] = line.split("\0");
    if (name === undefined || oid === undefined || !OID.test(oid) || symref !== "" || upstream === undefined || track === undefined || Buffer.byteLength(name) > MAX_REFNAME_BYTES) continue;
    const gone = upstream !== "" && track === "gone";
    const counted = upstream !== "" && !gone;
    branches.push({
      name,
      oid,
      current: head === "*",
      upstream: upstream === "" ? null : upstream,
      // C locale: `ahead 2, behind 1`, either alone, or nothing when the two are level
      ahead: counted ? Number(/\bahead (\d+)/.exec(track)?.[1] ?? 0) : null,
      behind: counted ? Number(/\bbehind (\d+)/.exec(track)?.[1] ?? 0) : null,
      upstream_gone: gone,
      committed_at: committed ?? "",
      subject: subject ?? "",
    });
  }
  return branches;
}

export async function repoBranches(cwd: string, options: RepoLogOptions = {}): Promise<RepoBranches> {
  const context = historyContext(options);
  const repository = await repositoryOf(context, cwd);
  const root = repository.root;
  // the last --sort is the first key: newest commit first, then by name
  const run = await runGit(context, root, ["for-each-ref", BRANCH_FORMAT, "--sort=refname", "--sort=-committerdate", "--", "refs/heads/"], context.maxListBytes);
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not list this repository's branches", 500);
  const listed = branchesOf(run.stdout);
  let current = listed.find((branch) => branch.current);
  if (current === undefined && run.overflow && repository.branch !== null) {
    const own = await runGit(context, root, ["for-each-ref", BRANCH_FORMAT, "--", `refs/heads/${repository.branch}`], context.maxListBytes);
    current = own.code === 0 ? branchesOf(own.stdout).find((branch) => branch.current) : undefined;
  }
  const ordered = current === undefined ? listed : [current, ...listed.filter((branch) => branch !== current && branch.name !== current.name)];
  return {
    repository,
    branches: ordered.slice(0, context.maxRefs),
    truncated: run.overflow || ordered.length > context.maxRefs,
    limits: { max_branches: context.maxRefs, max_list_bytes: context.maxListBytes },
  };
}

/** A shallow clone's boundary commit: git shows it with no parents, though it has some this clone does not. */
async function shallowBoundary(context: Context, root: string, oid: string): Promise<boolean> {
  const path = await runGit(context, root, ["rev-parse", "--git-path", "shallow"], 16 * 1024);
  if (path.code !== 0) throw new RepoDiffError("git_failed", "git could not read this repository's history", 500);
  try {
    return readFileSync(resolve(root, path.stdout.replace(/\r?\n$/, "")), "utf8").split("\n").includes(oid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function repoCommit(cwd: string, params: URLSearchParams, options: RepoLogOptions = {}): Promise<RepoCommitDetail> {
  const context = historyContext(options);
  const maxMessageBytes = options.maxMessageBytes ?? REPO_COMMIT_MAX_MESSAGE_BYTES;
  const rev = params.get("rev") ?? "";
  if (rev === "") throw new RepoDiffError("invalid_revision", "rev must name one commit: a hash, a branch, a tag or an expression such as HEAD~1", 400);
  const repository = await repositoryOf(context, cwd);
  const root = repository.root;
  const oid = await resolveRevision(context, root, "rev", rev);
  const [fields, body, refs] = await Promise.all([
    runGit(context, root, ["log", ...LOG_FLAGS, COMMIT_FORMAT, "--max-count=1", "--end-of-options", oid, "--"], context.maxListBytes),
    // one byte more than the cap: git ends the message with a newline, which is not part of it (`format:` adds no other)
    runGit(context, root, ["log", ...LOG_FLAGS.filter((flag) => flag !== "-z"), "--pretty=format:%B", "--max-count=1", "--end-of-options", oid, "--"], maxMessageBytes + 1),
    refsAt(context, root, [oid]),
  ]);
  checkLog(fields);
  checkLog(body);
  const [read] = commitsOf(fields.stdout);
  if (read === undefined) throw new RepoDiffError("too_large", "this commit is too large to read", 500);
  let message = body.stdout.replace(/\n+$/, "");
  let cut = body.overflow;
  if (cut) {
    // a message cut at its cap may end inside a character, which decodes as U+FFFD
    message = body.stdout.replace(/\uFFFD+$/u, "");
    while (Buffer.byteLength(message) > maxMessageBytes) message = message.slice(0, -1);
  } else if (Buffer.byteLength(message) > maxMessageBytes) {
    cut = true;
    while (Buffer.byteLength(message) > maxMessageBytes) message = message.slice(0, -1);
  }
  const boundary = read.parents.length === 0 && await shallowBoundary(context, root, oid);
  return {
    repository,
    commit: { ...read, refs: refs.refs.get(oid) ?? [] },
    refs_truncated: !refs.complete,
    message,
    message_truncated: cut,
    base: read.parents[0] ?? (boundary ? null : oid.length === 64 ? EMPTY_TREE_OIDS[1]! : EMPTY_TREE_OIDS[0]!),
    limits: { max_message_bytes: maxMessageBytes },
  };
}

/** The HTTP answer of any of the three routes, with every refusal in the `{ error: { code, message } }` envelope. */
export async function repoLogResponse(kind: "log" | "branches" | "show", cwd: string, params: URLSearchParams, options: RepoLogOptions = {}): Promise<Response> {
  try {
    const body = kind === "log" ? await repoLog(cwd, params, options) : kind === "branches" ? await repoBranches(cwd, options) : await repoCommit(cwd, params, options);
    return jsonResponse(body, 200, { "cache-control": "private, no-store" });
  } catch (error) {
    if (error instanceof RepoDiffError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
