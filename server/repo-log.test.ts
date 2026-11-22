import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiError, RepoBranches, RepoCommitDetail, RepoDiffFileList, RepoLog } from "../shared/protocol.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { MACHINE_PROXY_PATH } from "./machine-api.ts";
import { repoDiffFile, repoDiffFiles } from "./repo-diff.ts";
import { REPO_LOG_MAX_LIMIT, repoBranches, repoCommit, repoLog } from "./repo-log.ts";

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ovis-repo-log-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, args: string[], at?: number): string {
  // a CI runner's own GIT_AUTHOR_* / GIT_COMMITTER_* would outrank `-c user.name`
  const people = { GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  const dates = at === undefined ? people : { ...people, GIT_AUTHOR_DATE: `${at} +0900`, GIT_COMMITTER_DATE: `${at} +0900` };
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...dates } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function repository(name: string): string {
  const root = join(scratch, name);
  mkdirSync(root);
  git(root, ["init", "-q", "-b", "main"]);
  return root;
}

function commit(root: string, message: string, at: number, file = "a.txt"): string {
  writeFileSync(join(root, file), `${message}\n`);
  git(root, ["add", "--", file]);
  git(root, ["commit", "-q", "-m", message], at);
  return git(root, ["rev-parse", "HEAD"]);
}

const query = (values: Record<string, string> = {}) => new URLSearchParams(values);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const codeOf = async (promise: Promise<unknown>) => promise.then(() => "resolved", (error: unknown) => (error as { code?: string }).code);

describe("GET /api/workspace/git/log", () => {
  let root: string;
  let oids: string[];
  beforeAll(() => {
    root = repository("log");
    oids = [1, 2, 3, 4, 5].map((n) => commit(root, `commit ${n}`, 1_700_000_000 + n * 60));
    // names a comma-split or short-name list would read wrong, and an annotated tag that must peel to its commit
    git(root, ["branch", "feat/a,b", oids[2]!]);
    git(root, ["tag", "-a", "v1.0", "-m", "release", oids[0]!]);
    git(root, ["update-ref", "refs/remotes/origin/main", oids[3]!]);
    git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  });

  it("pages from a pinned commit, newest first, with the refs on each commit by full name", async () => {
    const first = await repoLog(root, query({ limit: "2" }));
    expect(first.ref).toBe("HEAD");
    expect(first.oid).toBe(oids[4]!);
    expect(first.commits.map((entry) => entry.subject)).toEqual(["commit 5", "commit 4"]);
    expect(first.commits[0]).toMatchObject({ oid: oids[4], parents: [oids[3]], author: { name: "Fixture", email: "fixture@example.invalid", time: "2023-11-15T07:18:20+09:00" }, refs: ["refs/heads/main"] });
    expect(first.commits[1]!.refs).toEqual(["refs/remotes/origin/main"]);
    expect(first.next_skip).toBe(2);

    commit(root, "commit 6", 1_700_000_000 + 6 * 60);
    const second = await repoLog(root, query({ limit: "2", oid: first.oid!, skip: String(first.next_skip) }));
    expect(second.commits.map((entry) => [entry.subject, entry.refs])).toEqual([["commit 3", ["refs/heads/feat/a,b"]], ["commit 2", []]]);
    const last = await repoLog(root, query({ limit: "2", oid: first.oid!, skip: "4" }));
    expect(last.commits.map((entry) => [entry.subject, entry.parents, entry.refs])).toEqual([["commit 1", [], ["refs/tags/v1.0"]]]);
    expect(last.next_skip).toBeNull();

    const branch = await repoLog(root, query({ ref: "refs/heads/feat/a,b" }));
    expect(branch.oid).toBe(oids[2]!);
    expect(branch.commits.map((entry) => entry.subject)).toEqual(["commit 3", "commit 2", "commit 1"]);
    expect(branch.next_skip).toBeNull();
  });

  it("never fetches a commit a partial clone is missing, while a diff of its older commits still reads their contents", async () => {
    const remote = repository("log-promisor");
    commit(remote, "older", 1_700_000_000);
    commit(remote, "shared", 1_700_000_030);
    git(remote, ["config", "uploadpack.allowFilter", "true"]);
    git(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    const clone = join(scratch, "log-partial");
    git(scratch, ["clone", "-q", "--filter=blob:none", `file://${remote}`, clone]);
    const later = commit(remote, "only on the remote", 1_700_000_060);
    expect(await codeOf(repoLog(clone, query({ oid: later })))).toBe("revision_not_found");
    expect(await codeOf(repoCommit(clone, query({ rev: later })))).toBe("revision_not_found");
    expect(Bun.spawnSync(["git", "-C", clone, "cat-file", "-e", later], { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } }).exitCode).not.toBe(0);
    const older = await repoDiffFile(clone, query({ scope: "commit", base: "HEAD~1", head: "HEAD", path: "a.txt" }));
    expect(older.patch).toContain("\n-older\n+shared\n");
  });

  it("answers an empty page for a repository with no commit yet", async () => {
    const empty = repository("log-unborn");
    expect(await repoLog(empty, query())).toMatchObject({ oid: null, commits: [], next_skip: null, repository: { unborn: true } });
  });

  it("refuses what names no commit, and limits and skips out of range", async () => {
    for (const [values, code] of [
      [{ ref: "--all" }, "invalid_revision"],
      [{ ref: "main..feat" }, "invalid_revision"],
      [{ ref: "nope" }, "revision_not_found"],
      [{ oid: "main" }, "invalid_revision"],
      [{ oid: "0".repeat(40) }, "revision_not_found"],
      [{ limit: "0" }, "invalid_limit"],
      [{ limit: String(REPO_LOG_MAX_LIMIT + 1) }, "invalid_limit"],
      [{ skip: "-1" }, "invalid_skip"],
      [{ skip: "x" }, "invalid_skip"],
    ] as const) {
      expect([values, await codeOf(repoLog(root, query(values)))]).toEqual([values, code]);
    }
  });
});

describe("GET /api/workspace/git/branches", () => {
  it("lists the current branch first, then by last commit, with each upstream and how far apart they are", async () => {
    const root = repository("branches");
    const base = commit(root, "base", 1_700_000_000);
    git(root, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
    git(root, ["update-ref", "refs/remotes/origin/main", base]);
    git(root, ["branch", "--set-upstream-to=origin/main", "main"]);
    commit(root, "ahead on main", 1_700_000_100);
    git(root, ["checkout", "-q", "-b", "old", base]);
    commit(root, "old work", 1_700_000_050, "b.txt");
    git(root, ["checkout", "-q", "-b", "newest"]);
    commit(root, "newest work", 1_700_000_200, "c.txt");
    git(root, ["update-ref", "refs/remotes/origin/gone", base]);
    git(root, ["branch", "--set-upstream-to=origin/gone", "old"]);
    git(root, ["update-ref", "-d", "refs/remotes/origin/gone"]);
    git(root, ["checkout", "-q", "main"]);

    const listed = await repoBranches(root);
    expect(listed.branches.map((branch) => [branch.name, branch.current, branch.upstream, branch.ahead, branch.behind, branch.upstream_gone])).toEqual([
      ["refs/heads/main", true, "refs/remotes/origin/main", 1, 0, false],
      ["refs/heads/newest", false, null, null, null, false],
      ["refs/heads/old", false, "refs/remotes/origin/gone", null, null, true],
    ]);
    expect(listed.branches[0]).toMatchObject({ subject: "ahead on main", committed_at: "2023-11-15T07:15:00+09:00" });
    expect(listed.truncated).toBe(false);

    const cut = await repoBranches(root, { maxRefs: 1 });
    expect(cut.branches.map((branch) => branch.name)).toEqual(["refs/heads/main"]);
    expect(cut.truncated).toBe(true);
  });
});

describe("GET /api/workspace/git/show", () => {
  let root: string;
  let first: string;
  let merge: string;
  beforeAll(() => {
    root = repository("show");
    first = commit(root, "root commit", 1_700_000_000);
    git(root, ["checkout", "-q", "-b", "side"]);
    commit(root, "side work", 1_700_000_100, "side.txt");
    git(root, ["checkout", "-q", "main"]);
    const mainTip = commit(root, "main work", 1_700_000_200, "main.txt");
    git(root, ["merge", "-q", "--no-ff", "-m", "Merge side\n\nThe whole story, line one.\nLine two, ünïcode.", "side"], 1_700_000_300);
    merge = git(root, ["rev-parse", "HEAD"]);
    expect(git(root, ["rev-parse", "HEAD^1"])).toBe(mainTip);
  });

  it("answers a commit's whole message, and its changes against its first parent", async () => {
    const detail = await repoCommit(root, query({ rev: "HEAD" }));
    expect(detail.commit.oid).toBe(merge);
    expect(detail.commit.parents).toHaveLength(2);
    expect(detail.message).toBe("Merge side\n\nThe whole story, line one.\nLine two, ünïcode.");
    expect(detail.message_truncated).toBe(false);
    expect(detail.base).toBe(detail.commit.parents[0]!);
    expect(detail.commit.refs).toEqual(["refs/heads/main"]);
    expect(detail.refs_truncated).toBe(false);
    const changes = await repoDiffFiles(root, query({ scope: "commit", base: detail.commit.parents[0]!, head: detail.commit.oid }));
    expect(changes.files.map((file) => file.path)).toEqual(["side.txt"]);
  });

  it("reads a root commit against the empty tree, which the diff routes take in the commit scope", async () => {
    const detail = await repoCommit(root, query({ rev: first }));
    expect(detail.commit.parents).toEqual([]);
    expect(detail.base).toBe(EMPTY_TREE);
    const changes = await repoDiffFiles(root, query({ scope: "commit", base: EMPTY_TREE, head: first }));
    expect(changes.files.map((file) => [file.path, file.status])).toEqual([["a.txt", "added"]]);
    expect((await repoDiffFile(root, query({ scope: "commit", base: EMPTY_TREE, head: first, path: "a.txt" }))).patch).toContain("\n+root commit\n");
    // the empty tree is a base only: it is no commit to read from
    expect(await codeOf(repoDiffFiles(root, query({ scope: "commit", base: first, head: EMPTY_TREE })))).toBe("revision_not_found");
  });

  it("answers no base for a shallow clone's boundary commit, whose parent it does not have", async () => {
    const shallow = join(scratch, "show-shallow");
    git(scratch, ["clone", "-q", "--depth=1", `file://${root}`, shallow]);
    const boundary = await repoCommit(shallow, query({ rev: "HEAD" }));
    expect(boundary.commit.oid).toBe(merge);
    expect(boundary.commit.parents).toEqual([]);
    expect(boundary.base).toBeNull();
  });

  it("cuts a long message at its cap and says so, and refuses what names no commit", async () => {
    const whole = await repoCommit(root, query({ rev: first }), { maxMessageBytes: "root commit".length });
    expect([whole.message, whole.message_truncated]).toEqual(["root commit", false]);
    const cut = await repoCommit(root, query({ rev: merge }), { maxMessageBytes: 12 });
    expect(cut.message).toBe("Merge side\n\n");
    expect(cut.message_truncated).toBe(true);
    for (const [values, code] of [[{}, "invalid_revision"], [{ rev: "--all" }, "invalid_revision"], [{ rev: "nope" }, "revision_not_found"]] as const) {
      expect([values, await codeOf(repoCommit(root, query(values)))]).toEqual([values, code]);
    }
  });
});

describe("the /api/workspace/git routes over HTTP", () => {
  let root: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let watchCookie: string;
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-repo-log-state-"));
  const owner = { authorization: "Bearer test-repo-log" };
  beforeAll(() => {
    root = repository("http");
    commit(root, "first", 1_700_000_000);
    const store = new DeviceStore(stateDir);
    const watchToken = store.pair(store.startPairing().code, "Watch", "watch")!.token;
    expect(store.match(watchToken)).not.toBeNull();
    watchCookie = `ovis_device=${watchToken}`;
    server = createServer({ port: 0, stateDir, token: "test-repo-log", tailscaleOwner: null, machines: false });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  const directory = () => `directory=${encodeURIComponent(root)}`;

  it("answers the three reads, never cached, and refuses in the error envelope", async () => {
    const log = await fetch(`${base}/api/workspace/git/log?${directory()}`, { headers: owner });
    expect(log.status).toBe(200);
    expect(log.headers.get("cache-control")).toBe("private, no-store");
    expect(((await log.json()) as RepoLog).commits.map((entry) => entry.subject)).toEqual(["first"]);
    const branches = await fetch(`${base}/api/workspace/git/branches?${directory()}`, { headers: owner });
    expect(((await branches.json()) as RepoBranches).branches.map((branch) => branch.name)).toEqual(["refs/heads/main"]);
    const show = await fetch(`${base}/api/workspace/git/show?${directory()}&rev=HEAD`, { headers: owner });
    expect(((await show.json()) as RepoCommitDetail).message).toBe("first");
    for (const [search, status, code] of [
      ["git/log?", 400, "missing_directory"],
      [`git/show?${directory()}`, 400, "invalid_revision"],
      [`git/log?directory=${encodeURIComponent(scratch)}`, 409, "not_a_repository"],
    ] as const) {
      const response = await fetch(`${base}/api/workspace/${search}`, { headers: owner });
      expect([search, response.status, ((await response.json()) as ApiError).error.code]).toEqual([search, status, code]);
    }
    const posted = await fetch(`${base}/api/workspace/git/log?${directory()}`, { method: "POST", headers: { ...owner, "x-herdr-machine": "1" } });
    expect(posted.status).toBe(400);
    expect(((await posted.json()) as ApiError).error.code).toBe("method_not_allowed");
    const files = await fetch(`${base}/api/workspace/diff/files?${directory()}&scope=commit&base=${EMPTY_TREE}&head=HEAD`, { headers: owner });
    expect(((await files.json()) as RepoDiffFileList).files.map((file) => file.path)).toEqual(["a.txt"]);
  });

  it("is closed to another site's page and to a device that can only watch, here and through a PC's route", async () => {
    const crossSite = await fetch(`${base}/api/workspace/git/log?${directory()}`, { headers: { ...owner, "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    expect(((await crossSite.json()) as ApiError).error.code).toBe("cross_site");
    for (const route of ["log", "branches", "show"]) {
      expect([route, MACHINE_PROXY_PATH.test(`workspace/git/${route}`)]).toEqual([route, true]);
      for (const path of [`workspace/git/${route}`, `machines/pc1/workspace/git/${route}`]) {
        const response = await fetch(`${base}/api/${path}?${directory()}&rev=HEAD`, { headers: { cookie: watchCookie } });
        expect([path, response.status, ((await response.json()) as ApiError).error.code]).toEqual([path, 403, "read_only"]);
      }
    }
    expect(MACHINE_PROXY_PATH.test("workspace/git/other")).toBe(false);
  });
});
