/**
 * What changed in the repository a pane (or a named folder) sits in, read with git and never
 * written: the list of changed files, and one file's patch at a time. The two are separate reads
 * so a repository with one enormous change does not cost every other file its diff.
 *
 * The `branch` scope is what Codex's review pane calls Branch: the working tree, untracked files
 * included, against the merge base of a chosen base and HEAD, so what the base went on to change
 * is left out. It is never guessed: a base that names no commit, a HEAD with no commit and a base
 * sharing no history with HEAD are each refused by name, with nothing compared in their place.
 * The list pins that comparison's identity (repository, HEAD, base, merge base), and a patch is
 * read from the pinned merge base once the repository and HEAD are checked against it.
 *
 * Every git call is an argv array (no shell), with external diff drivers, textconv filters, the
 * fsmonitor hook, optional locks and pathspec magic switched off, a byte cap on what is read and
 * a deadline after which the process is killed. A patch is sent whole or not at all: one that
 * passes its cap is reported as unavailable, never cut in the middle of a hunk. Nothing here
 * fetches, checks out or writes to the repository.
 *
 * It reads what this server's user can read in that repository, which is no more than the
 * terminal the same browser can already type `git diff` into.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

import type { RepoBranchComparison, RepoDiffFile, RepoDiffFileList, RepoDiffFilePatch, RepoDiffRefs, RepoDiffRepository, RepoDiffScope, RepoDiffStatus } from "../shared/protocol.ts";
import { gitEnvironment as buildGitEnvironment } from "./herdr-core/worktrees.ts";
import { errorResponse, jsonResponse } from "./http.ts";

export const REPO_DIFF_MAX_FILES = 2_000;
export const REPO_DIFF_MAX_LIST_BYTES = 2 * 1024 * 1024;
export const REPO_DIFF_MAX_PATCH_BYTES = 1024 * 1024;
/** Unchanged lines around each change, as `git diff` prints by default. */
export const REPO_DIFF_CONTEXT_LINES = 3;
export const REPO_DIFF_DEADLINE_MS = 10_000;
export const REPO_DIFF_MAX_REFS = 200;
const MAX_PATH_BYTES = 4_096;
const SNIFF_BYTES = 8_192;
const MAX_COMPARISON_BYTES = 8_192;

export interface RepoDiffOptions {
  git?: string;
  deadlineMs?: number;
  maxFiles?: number;
  maxListBytes?: number;
  maxPatchBytes?: number;
  maxRefs?: number;
  /**
   * Never fetch an object a partial clone is missing (git 2.44+ honours this). The history routes
   * set it: a commit or message is there or it is not. The diff routes leave it off, as a patch of
   * an older commit in a blobless clone needs its contents fetched.
   */
  noLazyFetch?: boolean;
}

/** A refusal in the API's own words: it never carries git's stderr. */
export class RepoDiffError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

export interface GitRun { code: number | null; stdout: string; overflow: boolean }

export interface Context {
  git: string;
  deadlineMs: number;
  maxFiles: number;
  maxListBytes: number;
  maxPatchBytes: number;
  maxRefs: number;
  noLazyFetch: boolean;
}

export function contextOf(options: RepoDiffOptions): Context {
  return {
    git: options.git ?? "git",
    deadlineMs: options.deadlineMs ?? REPO_DIFF_DEADLINE_MS,
    maxFiles: options.maxFiles ?? REPO_DIFF_MAX_FILES,
    maxListBytes: options.maxListBytes ?? REPO_DIFF_MAX_LIST_BYTES,
    maxPatchBytes: options.maxPatchBytes ?? REPO_DIFF_MAX_PATCH_BYTES,
    maxRefs: options.maxRefs ?? REPO_DIFF_MAX_REFS,
    noLazyFetch: options.noLazyFetch ?? false,
  };
}

const gitEnvironment = (noLazyFetch: boolean): Record<string, string> => buildGitEnvironment({ noLazyFetch });

/** One git process in `cwd`: stdout up to `maxBytes`, killed at the deadline or once it prints more. */
export async function runGit(context: Context, cwd: string, args: string[], maxBytes: number): Promise<GitRun> {
  // an empty core.fsmonitor turns the hook off in every git: before 2.36, `false` names a program to run
  const argv = [context.git, "--no-pager", "--no-optional-locks", "--literal-pathspecs", "-c", "core.quotePath=false", "-c", "core.fsmonitor=", "-c", "color.ui=never", "-C", cwd, ...args];
  let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
  try {
    proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: gitEnvironment(context.noLazyFetch) });
  } catch {
    throw new RepoDiffError("git_unavailable", "git could not be started on this PC", 503);
  }
  const reader = proc.stdout.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    void reader.cancel().catch(() => undefined);
  }, context.deadlineMs);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        overflow = true;
        const keep = value.byteLength - (size - maxBytes);
        if (keep > 0) chunks.push(value.subarray(0, keep));
        proc.kill("SIGKILL");
        void reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
    const code = await proc.exited;
    if (timedOut) throw new RepoDiffError("git_timeout", "git did not answer in time", 504);
    return { code: overflow ? null : code, stdout: Buffer.concat(chunks).toString("utf8"), overflow };
  } finally {
    clearTimeout(timer);
  }
}

export async function repositoryOf(context: Context, cwd: string): Promise<RepoDiffRepository> {
  const top = await runGit(context, cwd, ["rev-parse", "--show-toplevel"], 16 * 1024);
  const root = top.stdout.replace(/\r?\n$/, "");
  if (top.code !== 0 || root === "") throw new RepoDiffError("not_a_repository", "that folder is not inside a git working tree", 409);
  const [branch, head] = await Promise.all([
    runGit(context, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 16 * 1024),
    runGit(context, root, ["rev-parse", "--quiet", "--verify", "HEAD^{commit}"], 1024),
  ]);
  const oid = head.code === 0 ? head.stdout.trim() : "";
  const name = branch.code === 0 ? branch.stdout.replace(/\r?\n$/, "") : "";
  return { root, branch: name === "" ? null : name, head: oid === "" ? null : oid, detached: name === "" && oid !== "", unborn: oid === "" };
}

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,199}$/;
/** A full git object id: 40 hex digits (SHA-1) or 64 (SHA-256), nothing between. */
export const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/**
 * The tree with nothing in it, in each object format git has (SHA-1, SHA-256): what a root commit's
 * changes are read against. git knows it in every repository of its format without storing it.
 */
export const EMPTY_TREE_OIDS: readonly string[] = ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"];
/** A branch as the picker offers it, by its full name: one that `git check-ref-format` accepts names that ref and nothing else. */
const FULL_REFNAME = /^refs\/(?:heads|remotes)\/[^\0-\x1f\x7f]+$/;
export const MAX_REFNAME_BYTES = 1_024;

/**
 * A revision that names one commit and is no option, range or path: a short expression such as
 * `main` or `HEAD~1`, or a full branch name the refs route offers, whose letters (`+`, Hangul,
 * any length up to the cap) a short expression does not allow; git's own refname rules hold it to
 * a name, so `..`, `@{`, `~`, `^`, `:` and spaces stay refused.
 */
export async function checkRevision(context: Context, root: string, name: string, value: string): Promise<void> {
  if (REVISION.test(value) && !value.includes("..")) return;
  if (FULL_REFNAME.test(value) && Buffer.byteLength(value) <= MAX_REFNAME_BYTES && (await runGit(context, root, ["check-ref-format", value], 1024)).code === 0) return;
  throw new RepoDiffError("invalid_revision", `${name} must name one commit: a hash, a branch, a tag or an expression such as HEAD~1`, 400);
}

export async function resolveRevision(context: Context, root: string, name: string, value: string): Promise<string> {
  await checkRevision(context, root, name, value);
  const parsed = await runGit(context, root, ["rev-parse", "--quiet", "--verify", "--end-of-options", `${value}^{commit}`], 1024);
  const oid = parsed.stdout.trim();
  if (parsed.code !== 0 || !OID.test(oid)) throw new RepoDiffError("revision_not_found", `${name} names no commit in this repository`, 404);
  return oid;
}

/** A commit scope's base: one commit, or the empty tree of this repository's format, which a root commit is read against. */
async function resolveBase(context: Context, root: string, value: string): Promise<string> {
  if (!EMPTY_TREE_OIDS.includes(value)) return resolveRevision(context, root, "base", value);
  const tree = await runGit(context, root, ["rev-parse", "--quiet", "--verify", "--end-of-options", `${value}^{tree}`], 1024);
  if (tree.code !== 0 || tree.stdout.trim() !== value) throw new RepoDiffError("revision_not_found", "base names no commit in this repository", 404);
  return value;
}

/** The one merge base of two commits; none when their histories are unrelated. */
async function mergeBaseOf(context: Context, root: string, base: string, head: string): Promise<string | null> {
  const run = await runGit(context, root, ["merge-base", "--end-of-options", base, head], 1024);
  const oid = run.stdout.trim();
  if (run.code === 0 && OID.test(oid)) return oid;
  // 1 is git's answer for histories that share nothing; anything else is a failure of its own
  if (run.code === 1 && oid === "") return null;
  throw new RepoDiffError("git_failed", "git could not find the merge base", 500);
}

function scopeOf(value: string | null): RepoDiffScope {
  if (value === null || value === "" || value === "workspace") return "workspace";
  if (value === "staged" || value === "commit" || value === "branch") return value;
  throw new RepoDiffError("invalid_scope", "scope must be workspace, staged, commit or branch", 400);
}

/** A pinned branch comparison as the list sent it, in shape only: whether it still holds is checked against git. */
function parseComparison(value: string): RepoBranchComparison {
  const invalid = (): RepoDiffError => new RepoDiffError("invalid_comparison", "comparison must be the identity a branch list answered with: its repository root and three commit hashes", 400);
  if (Buffer.byteLength(value) > MAX_COMPARISON_BYTES) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid();
  const record = parsed as Record<string, unknown>;
  const keys = ["repository_root", "head_oid", "base_oid", "merge_base_oid"] as const;
  if (Object.keys(record).some((key) => !(keys as readonly string[]).includes(key))) throw invalid();
  for (const key of keys) {
    const field = record[key];
    if (typeof field !== "string" || field === "" || field.includes("\0")) throw invalid();
    if (key !== "repository_root" && !OID.test(field)) throw invalid();
  }
  return { repository_root: record.repository_root as string, head_oid: record.head_oid as string, base_oid: record.base_oid as string, merge_base_oid: record.merge_base_oid as string };
}

/** A path inside the repository, as git names it: relative, forward slashes, no `..`. */
function repositoryPath(name: string, value: string): string {
  const segments = value.split("/");
  if (value === "" || value.includes("\0") || value.startsWith("/") || Buffer.byteLength(value) > MAX_PATH_BYTES || segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new RepoDiffError("invalid_path", `${name} must be a file path relative to the repository root`, 400);
  }
  return value;
}

interface Comparison { scope: RepoDiffScope; base: string | null; head: string | null; comparison: RepoBranchComparison | null; args: string[] }

async function comparisonOf(context: Context, repository: RepoDiffRepository, params: URLSearchParams, kind: "files" | "file"): Promise<Comparison> {
  const scope = scopeOf(params.get("scope"));
  const base = params.get("base");
  const head = params.get("head");
  const pinned = params.get("comparison");
  if (scope !== "branch" && pinned !== null) throw new RepoDiffError("invalid_comparison", "comparison applies to scope=branch only", 400);
  if (scope === "workspace" || scope === "staged") {
    if (base !== null || head !== null) throw new RepoDiffError("invalid_revision", "base and head apply to scope=commit and scope=branch only", 400);
    return { scope, base: null, head: null, comparison: null, args: scope === "staged" ? ["--cached"] : [] };
  }
  const root = repository.root;
  if (scope === "commit") {
    if (base === null) throw new RepoDiffError("invalid_revision", "scope=commit needs a base revision", 400);
    const [from, to] = await Promise.all([resolveBase(context, root, base), resolveRevision(context, root, "head", head ?? "HEAD")]);
    return { scope, base: from, head: to, comparison: null, args: [from, to] };
  }
  if (head !== null) throw new RepoDiffError("invalid_revision", "scope=branch compares the working tree; head applies to scope=commit only", 400);
  if (kind === "file") {
    if (pinned === null) throw new RepoDiffError("invalid_comparison", "a branch patch needs the comparison its list answered with", 400);
    const identity = parseComparison(pinned);
    if (identity.repository_root !== root || identity.head_oid !== repository.head) {
      throw new RepoDiffError("comparison_changed", "the repository or its HEAD is no longer the one this comparison was made on; refresh the list", 409);
    }
    // HEAD is proven above; the base is a commit of this repository (not a tag object's id), and the
    // ids are immutable, so their merge base is too: one that differs was never this repository's answer
    if (await resolveRevision(context, root, "base", identity.base_oid) !== identity.base_oid || await mergeBaseOf(context, root, identity.base_oid, identity.head_oid) !== identity.merge_base_oid) {
      throw new RepoDiffError("invalid_comparison", "comparison does not name a merge base of this repository's commits", 400);
    }
    return { scope, base: identity.base_oid, head: identity.head_oid, comparison: identity, args: [identity.merge_base_oid] };
  }
  if (pinned !== null) throw new RepoDiffError("invalid_comparison", "comparison applies to a patch read; a list names its base", 400);
  if (base === null) throw new RepoDiffError("invalid_revision", "scope=branch needs a base branch or commit", 400);
  await checkRevision(context, root, "base", base);
  if (repository.head === null) throw new RepoDiffError("unborn_head", "the repository has no commit yet, so there is no branch to compare", 409);
  const from = await resolveRevision(context, root, "base", base);
  const mergeBase = await mergeBaseOf(context, root, from, repository.head);
  if (mergeBase === null) throw new RepoDiffError("no_common_ancestor", "base and HEAD share no history; nothing is compared in its place", 409);
  const identity: RepoBranchComparison = { repository_root: root, head_oid: repository.head, base_oid: from, merge_base_oid: mergeBase };
  return { scope, base: from, head: repository.head, comparison: identity, args: [mergeBase] };
}

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--ignore-submodules=dirty", "--src-prefix=a/", "--dst-prefix=b/"];

const STATUS: Record<string, RepoDiffStatus> = { A: "added", D: "deleted", M: "modified", R: "renamed", C: "copied", T: "type_changed", U: "unmerged" };

/** The whole NUL-terminated fields of `-z` output: what follows the last NUL was cut short. */
function fields(output: string): string[] {
  const end = output.lastIndexOf("\0");
  return end < 0 ? [] : output.slice(0, end).split("\0");
}

interface Listing { files: RepoDiffFile[]; complete: boolean }

async function changedFiles(context: Context, root: string, comparison: Comparison, pathspec: string[]): Promise<Listing> {
  const tail = [...comparison.args, "--", ...pathspec];
  const [names, counts, others] = await Promise.all([
    runGit(context, root, ["diff", ...DIFF_FLAGS, "--name-status", "-z", ...tail], context.maxListBytes),
    runGit(context, root, ["diff", ...DIFF_FLAGS, "--numstat", "-z", ...tail], context.maxListBytes),
    comparison.scope === "workspace" || comparison.scope === "branch"
      ? runGit(context, root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspec], context.maxListBytes)
      : Promise.resolve<GitRun>({ code: 0, stdout: "", overflow: false }),
  ]);
  for (const run of [names, counts, others]) {
    if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not compare this repository", 500);
  }
  const stats = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const numbers = fields(counts.stdout);
  for (let index = 0; index < numbers.length; index += 1) {
    const [added, deleted, ...rest] = numbers[index]!.split("\t");
    if (added === undefined || deleted === undefined) break;
    let path = rest.join("\t");
    // a rename: the counts stand alone, then the old and the new name
    if (path === "") { path = numbers[index + 2] ?? ""; index += 2; }
    if (path === "") break;
    const binary = added === "-" || deleted === "-";
    stats.set(path, { additions: binary ? null : Number(added), deletions: binary ? null : Number(deleted), binary });
  }
  const found = new Map<string, RepoDiffFile>();
  const named = fields(names.stdout);
  for (let index = 0; index < named.length;) {
    const letter = named[index]![0] ?? "";
    const status = STATUS[letter];
    const paired = letter === "R" || letter === "C";
    const path = named[index + (paired ? 2 : 1)];
    if (status === undefined || path === undefined) break;
    // a conflict's counts are those of a combined diff, which no one is shown
    const stat = status === "unmerged" ? undefined : stats.get(path);
    const file: RepoDiffFile = { path, old_path: paired ? named[index + 1]! : null, status, additions: stat?.additions ?? null, deletions: stat?.deletions ?? null, binary: stat?.binary ?? null };
    // a conflicted file can be named twice; the conflict is what there is to say about it
    if (found.get(path)?.status !== "unmerged") found.set(path, file);
    index += paired ? 3 : 2;
  }
  for (const path of fields(others.stdout)) {
    if (!found.has(path)) found.set(path, { path, old_path: null, status: "untracked", additions: null, deletions: null, binary: null });
  }
  const files = [...found.values()].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { files, complete: !names.overflow && !others.overflow };
}

export async function repoDiffFiles(cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<RepoDiffFileList> {
  const context = contextOf(options);
  const repository = await repositoryOf(context, cwd);
  const comparison = await comparisonOf(context, repository, params, "files");
  const listing = await changedFiles(context, repository.root, comparison, []);
  return {
    repository,
    scope: comparison.scope,
    base: comparison.base,
    head: comparison.head,
    comparison: comparison.comparison,
    files: listing.files.slice(0, context.maxFiles),
    total: listing.complete ? listing.files.length : null,
    truncated: !listing.complete || listing.files.length > context.maxFiles,
    limits: { max_files: context.maxFiles, max_list_bytes: context.maxListBytes },
  };
}

/**
 * What an untracked path is on disk. Only its last component is checked for a link (lstat, before
 * the open): a directory above it that is a link is followed, out of the repository too.
 */
function untrackedKind(path: string, maxBytes: number): "text" | "binary" | "too_large" | "unsupported" {
  let fd: number | null = null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return "unsupported";
    if (stat.size > maxBytes) return "too_large";
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(SNIFF_BYTES);
    return buffer.subarray(0, readSync(fd, buffer, 0, SNIFF_BYTES, 0)).includes(0) ? "binary" : "text";
  } catch {
    return "unsupported";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export async function repoDiffFile(cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<RepoDiffFilePatch> {
  const context = contextOf(options);
  const path = repositoryPath("path", params.get("path") ?? "");
  const oldParam = params.get("old_path");
  const oldPath = oldParam === null || oldParam === "" ? null : repositoryPath("old_path", oldParam);
  const repository = await repositoryOf(context, cwd);
  const comparison = await comparisonOf(context, repository, params, "file");
  const pathspec = oldPath !== null && oldPath !== path ? [oldPath, path] : [path];

  const answer = (patch: string | null, unavailable: RepoDiffFilePatch["unavailable"], described: RepoDiffFile): RepoDiffFilePatch => ({
    repository,
    scope: comparison.scope,
    base: comparison.base,
    head: comparison.head,
    comparison: comparison.comparison,
    file: described,
    patch,
    unavailable,
    truncated: unavailable === "too_large",
    limits: { max_patch_bytes: context.maxPatchBytes, context_lines: REPO_DIFF_CONTEXT_LINES },
  });

  const read = async (): Promise<RepoDiffFilePatch> => {
    const listing = await changedFiles(context, repository.root, comparison, pathspec);
    const file = listing.files.find((candidate) => candidate.path === path);
    if (file === undefined) throw new RepoDiffError("not_found", "nothing changed at that path in this comparison", 404);
    if (oldPath !== null && file.old_path !== oldPath) throw new RepoDiffError("invalid_path", "old_path no longer belongs to this file's change; refresh the list", 400);
    if (file.status === "unmerged") return answer(null, "unmerged", file);
    if (file.binary === true) return answer(null, "binary", file);

    let run: GitRun;
    if (file.status === "untracked") {
      const kind = untrackedKind(join(repository.root, path), context.maxPatchBytes);
      if (kind === "binary") return answer(null, "binary", { ...file, binary: true });
      if (kind !== "text") return answer(null, kind, file);
      run = await runGit(context, repository.root, ["diff", "--no-index", ...DIFF_FLAGS, `-U${REPO_DIFF_CONTEXT_LINES}`, "--", "/dev/null", path], context.maxPatchBytes);
      if (!run.overflow && run.code !== 1 && run.code !== 0) throw new RepoDiffError("git_failed", "git could not read that file", 500);
    } else {
      run = await runGit(context, repository.root, ["diff", ...DIFF_FLAGS, `-U${REPO_DIFF_CONTEXT_LINES}`, ...comparison.args, "--", ...pathspec], context.maxPatchBytes);
      if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not compare that file", 500);
    }
    if (run.overflow) return answer(null, "too_large", file);
    if (run.stdout === "") throw new RepoDiffError("not_found", "nothing changed at that path in this comparison", 404);
    if (!run.stdout.startsWith("diff --git ")) return answer(null, "unsupported", file);
    return answer(run.stdout, null, file.status === "untracked" ? { ...file, binary: false } : file);
  };
  // a branch patch is the pinned comparison's or none: HEAD is read again once the working tree has been,
  // whatever the read answered, so a checkout that landed during it (one that changed the file, or one
  // that left nothing changed there) is refused as a moved HEAD rather than answered under the old identity
  const pinned = comparison.comparison;
  const confirmPinned = async (): Promise<void> => {
    if (pinned === null) return;
    const after = await repositoryOf(context, cwd);
    if (after.root !== pinned.repository_root || after.head !== pinned.head_oid) throw new RepoDiffError("comparison_changed", "the repository or its HEAD is no longer the one this comparison was made on; refresh the list", 409);
  };
  let result: RepoDiffFilePatch;
  try {
    result = await read();
  } catch (error) {
    await confirmPinned();
    throw error;
  }
  await confirmPinned();
  return result;
}

/**
 * GET /api/workspace/diff/refs: the repository's branches, local and remote, each as its full
 * refname and the commit it is at, for a base picker. Read from the refs on disk; nothing is
 * fetched. A remote's symbolic HEAD (`refs/remotes/origin/HEAD`) names no branch of its own and
 * is left out. The list is sorted and cut at `limits.max_refs`; `truncated` says when it was,
 * and a base not offered can still be typed.
 */
export async function repoDiffRefs(cwd: string, options: RepoDiffOptions = {}): Promise<RepoDiffRefs> {
  const context = contextOf(options);
  const repository = await repositoryOf(context, cwd);
  const run = await runGit(context, repository.root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "--sort=refname", "--", "refs/heads/", "refs/remotes/"], context.maxListBytes);
  if (!run.overflow && run.code !== 0) throw new RepoDiffError("git_failed", "git could not list this repository's branches", 500);
  const refs: RepoDiffRefs["refs"] = [];
  // one ref per line, its fields NUL-separated; what follows the last newline was cut short
  for (const line of run.stdout.split("\n").slice(0, -1)) {
    const [name, oid, symref] = line.split("\0");
    if (name === undefined || oid === undefined || symref === undefined || symref !== "" || !OID.test(oid) || Buffer.byteLength(name) > MAX_REFNAME_BYTES) continue;
    refs.push({ name, oid });
  }
  return {
    repository,
    refs: refs.slice(0, context.maxRefs),
    truncated: run.overflow || refs.length > context.maxRefs,
    limits: { max_refs: context.maxRefs, max_list_bytes: context.maxListBytes },
  };
}

/** The HTTP answer of any of the routes, with every refusal in the `{ error: { code, message } }` envelope. */
export async function repoDiffResponse(kind: "files" | "file" | "refs", cwd: string, params: URLSearchParams, options: RepoDiffOptions = {}): Promise<Response> {
  try {
    const body = kind === "files" ? await repoDiffFiles(cwd, params, options) : kind === "file" ? await repoDiffFile(cwd, params, options) : await repoDiffRefs(cwd, options);
    return jsonResponse(body, 200, { "cache-control": "private, no-store" });
  } catch (error) {
    if (error instanceof RepoDiffError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    return errorResponse(error);
  }
}
