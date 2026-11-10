import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { WorkspaceWorktreeInfo } from "../../shared/herdr-api.generated.ts";
import type { WorktreeInfo } from "../herdr/client.ts";

/**
 * herdr's worktree calls, answered with git on a herdr-core PC: hc has no worktrees, so Ovis runs
 * `git worktree` itself and opens a checkout as a workspace of its own, as New workspace does
 * there. A workspace Ovis knows to be a checkout of a repository carries herdr's `worktree` facts
 * (WorkspaceWorktreeInfo) in this label on its terminals, as JSON.
 */
export const WORKTREE_LABEL = "ovis.worktree";

/** herdr's default folder for new checkouts (its `worktree_directory`): `<dir>/<repository>/<branch, slashes as dashes>` */
export const defaultCheckoutPath = (repoName: string, branch: string): string =>
  join(homedir(), ".herdr", "worktrees", repoName, worktreeFolder(branch));

/** the branch as a folder and workspace name, as herdr makes them */
export const worktreeFolder = (branch: string): string => branch.trim().replaceAll("/", "-");

/** A refusal in herdr's words for its worktree calls (not_git_worktree, worktree_create_failed, …). */
export class WorktreeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The facts a workspace's terminals carry, or null for a label that is missing or not herdr's shape. */
export function worktreeOfLabels(labels: Record<string, string> | undefined): WorkspaceWorktreeInfo | null {
  return labeledWorktree(labels)?.facts ?? null;
}

/**
 * The label as written: herdr's facts, and which git folder the checkout had (`.git/worktrees/<name>`)
 * by its file identity: git reuses the name for a checkout added again at the same path, but that
 * is a new folder.
 */
export function labeledWorktree(labels: Record<string, string> | undefined): { facts: WorkspaceWorktreeInfo; gitId: string | null } | null {
  const text = labels?.[WORKTREE_LABEL];
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { repo_key, repo_name, repo_root, checkout_path, is_linked_worktree, git_id } = value as Record<string, unknown>;
  if (typeof repo_key !== "string" || typeof repo_name !== "string" || typeof repo_root !== "string" || typeof checkout_path !== "string" || typeof is_linked_worktree !== "boolean") return null;
  return { facts: { repo_key, repo_name, repo_root, checkout_path, is_linked_worktree }, gitId: typeof git_id === "string" ? git_id : null };
}

/** A git folder's file identity: device, inode and birth time; null when it is gone. */
export function gitDirIdentity(gitDir: string): string | null {
  try {
    const found = statSync(gitDir);
    return `${found.dev}:${found.ino}:${found.birthtimeMs}`;
  } catch {
    return null;
  }
}

/** The label for a checkout: its facts and its git folder's identity. */
export const worktreeLabel = (facts: WorkspaceWorktreeInfo, gitDir: string): string => JSON.stringify({ ...facts, git_id: gitDirIdentity(gitDir) });

/** A path as the file system names it, so a pane's folder and git's checkout list compare; as given when it is gone. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** One checkout of a repository, as `git worktree list` says it; the first is the repository's own. */
export type Checkout = Pick<WorktreeInfo, "path" | "branch" | "is_bare" | "is_detached" | "is_prunable">;

export interface Repository {
  repo_key: string;
  repo_name: string;
  repo_root: string;
  /** the checkout the asked folder is in */
  checkout: string;
  /** that checkout's own git folder */
  git_dir: string;
  checkouts: Checkout[];
}

function gitEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // a repository the server itself was started inside is not the one asked about
    if (value === undefined || name === "GIT_DIR" || name === "GIT_WORK_TREE" || name === "GIT_INDEX_FILE" || name === "GIT_COMMON_DIR") continue;
    env[name] = value;
  }
  return { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/** `git worktree add` or `remove` on a large checkout can take well over a few seconds (herdr's client waits 60 s). */
const GIT_TIMEOUT_MS = 55_000;

export async function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["git", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: gitEnvironment() });
  } catch {
    throw new WorktreeError("worktree_list_failed", "git could not be started on this PC");
  }
  const timer = setTimeout(() => proc.kill("SIGKILL"), GIT_TIMEOUT_MS);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: exit === 0, stdout, stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `git worktree list --porcelain`: one block per checkout, the repository's own first. Its lines
 * end in NUL with `-z` and in a newline without it (`end`). Git writes a path as it is in both,
 * quoting nothing, so only a path with a newline in it needs `-z`: by line it is cut there.
 */
export function parseCheckouts(porcelain: string, end: "\0" | "\n" = "\0"): Checkout[] {
  const checkouts: Checkout[] = [];
  for (const block of porcelain.split(end === "\0" ? /\0\0+/u : /\n\n+/u)) {
    const lines = block.split(end).filter((line) => line !== "");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!path) continue;
    const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length).replace(/^refs\/heads\//u, "") ?? null;
    checkouts.push({
      path,
      branch,
      is_bare: lines.includes("bare"),
      is_detached: lines.includes("detached"),
      is_prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
    });
  }
  return checkouts;
}

/** The repository a folder is in and its checkouts; `not_git_worktree` for a folder outside git. */
export async function repositoryOf(folder: string): Promise<Repository> {
  const where = await git(folder, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--git-dir"]);
  const [top, common, own] = where.stdout.split("\n");
  if (!where.ok || !top || !common || !own) throw new WorktreeError("not_git_worktree", `${folder} is not in a git worktree`);
  // git before 2.31 knows no --path-format and writes the switch back as its first line, so the three
  // answers would be read one line off: refused, as its rejected -z refused the listing before
  if (!isAbsolute(top) || !isAbsolute(common) || !isAbsolute(own)) throw new WorktreeError("worktree_list_failed", "git on this PC is older than 2.31, which worktrees here need");
  let listed = await git(folder, ["worktree", "list", "--porcelain", "-z"]);
  // git before 2.36 (Ubuntu 22.04 has 2.34) knows no -z and answers with its usage: it lists by line
  const byLine = !listed.ok && /\bunknown switch\b/u.test(listed.stderr);
  if (byLine) listed = await git(folder, ["worktree", "list", "--porcelain"]);
  if (!listed.ok) throw new WorktreeError("worktree_list_failed", listed.stderr || "git worktree list failed");
  const checkouts = parseCheckouts(listed.stdout, byLine ? "\n" : "\0").map((checkout) => ({ ...checkout, path: realPath(checkout.path) }));
  const root = checkouts[0]?.path ?? realPath(top);
  return { repo_key: realPath(common), repo_name: basename(root), repo_root: root, checkout: realPath(top), git_dir: realPath(own), checkouts };
}

/** herdr's facts for one checkout of the repository. */
export const factsOf = (repository: Repository, checkout: string): WorkspaceWorktreeInfo => ({
  repo_key: repository.repo_key,
  repo_name: repository.repo_name,
  repo_root: repository.repo_root,
  checkout_path: checkout,
  is_linked_worktree: checkout !== repository.repo_root,
});

/** The checkout a folder lies in: the longest checkout path it is in, or none. */
export function checkoutHolding(checkouts: readonly Pick<Checkout, "path">[], folder: string): string | null {
  let best: string | null = null;
  for (const { path } of checkouts) {
    const below = relative(path, folder);
    if (below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below) && (best === null || path.length > best.length)) best = path;
  }
  return best;
}
