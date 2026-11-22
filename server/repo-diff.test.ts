import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { parsePatchFiles } from "@pierre/diffs";

import type { ApiError, RepoBranchComparison, RepoDiffFileList, RepoDiffFilePatch, RepoDiffRefs } from "../shared/protocol.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { REPO_DIFF_CONTEXT_LINES, REPO_DIFF_MAX_FILES, REPO_DIFF_MAX_LIST_BYTES, REPO_DIFF_MAX_PATCH_BYTES, REPO_DIFF_MAX_REFS, repoDiffFile, repoDiffFiles, repoDiffRefs } from "./repo-diff.ts";

process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "herdr-repo-diff-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** `git update-ref --stdin`: many refs made or dropped in one process. */
function updateRefs(cwd: string, commands: string[]): void {
  const result = Bun.spawnSync(["git", "-C", cwd, "update-ref", "--stdin"], { stdin: Buffer.from(`${commands.join("\n")}\n`), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git update-ref --stdin failed: ${result.stderr.toString()}`);
}

function repository(name: string): string {
  const root = join(scratch, name);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "main");
  return root;
}

const query = (values: Record<string, string> = {}) => new URLSearchParams(values);
const lines = (count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join("");
async function withEnvironment<T>(name: string, value: string, body: () => Promise<T>): Promise<T> {
  const inherited = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (inherited === undefined) delete process.env[name];
    else process.env[name] = inherited;
  }
}
const parsed = (patch: string | null) => parsePatchFiles(patch ?? "", undefined, true).flatMap((entry) => entry.files);

const UNICODE = "dir with space/ünï 文件.txt";

describe("workspace and staged changes", () => {
  let root: string;
  beforeAll(() => {
    root = repository("changes");
    mkdirSync(join(root, "dir with space"));
    writeFileSync(join(root, "keep.txt"), "a\nb\nc\n");
    writeFileSync(join(root, "gone.txt"), "going\n");
    writeFileSync(join(root, "moved-from.txt"), lines(12));
    writeFileSync(join(root, "pic.bin"), new Uint8Array([0, 1, 2, 3, 0, 255]));
    writeFileSync(join(root, UNICODE), "eins\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    git(root, "mv", "moved-from.txt", "moved-to.txt");
    writeFileSync(join(root, "moved-to.txt"), lines(12).replace("line 3\n", "line three\n"));
    writeFileSync(join(root, "staged-new.txt"), "fresh\n");
    git(root, "add", "moved-to.txt", "staged-new.txt");
    writeFileSync(join(root, "keep.txt"), "a\nB\nc\nd\n");
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "pic.bin"), new Uint8Array([9, 0, 9, 0]));
    writeFileSync(join(root, UNICODE), "zwei\n");
    writeFileSync(join(root, "new file.txt"), "one\ntwo\n");
    writeFileSync(join(root, "blob.bin"), new Uint8Array([1, 0, 2, 0]));
  });

  it("lists unstaged and untracked files with status, counts and the repository they are in", async () => {
    const list = await repoDiffFiles(root, query());
    expect(list.repository).toEqual({ root, branch: "main", head: git(root, "rev-parse", "HEAD").trim(), detached: false, unborn: false });
    expect(list).toMatchObject({ scope: "workspace", base: null, head: null, total: 6, truncated: false, limits: { max_files: REPO_DIFF_MAX_FILES, max_list_bytes: REPO_DIFF_MAX_LIST_BYTES } });
    expect(list.files).toEqual([
      { path: "blob.bin", old_path: null, status: "untracked", additions: null, deletions: null, binary: null },
      { path: UNICODE, old_path: null, status: "modified", additions: 1, deletions: 1, binary: false },
      { path: "gone.txt", old_path: null, status: "deleted", additions: 0, deletions: 1, binary: false },
      { path: "keep.txt", old_path: null, status: "modified", additions: 2, deletions: 1, binary: false },
      { path: "new file.txt", old_path: null, status: "untracked", additions: null, deletions: null, binary: null },
      { path: "pic.bin", old_path: null, status: "modified", additions: null, deletions: null, binary: true },
    ]);
  });

  it("answers the same list from a folder below the repository's top", async () => {
    const list = await repoDiffFiles(join(root, "dir with space"), query());
    expect(list.repository.root).toBe(root);
    expect(list.files.map((file) => file.path)).toContain("keep.txt");
  });

  it("lists staged files apart, a rename with where it came from", async () => {
    const list = await repoDiffFiles(root, query({ scope: "staged" }));
    expect(list.files).toEqual([
      { path: "moved-to.txt", old_path: "moved-from.txt", status: "renamed", additions: 1, deletions: 1, binary: false },
      { path: "staged-new.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false },
    ]);
  });

  it("gives each text file one whole patch Pierre parses: edit, deletion, untracked, addition, rename", async () => {
    const edit = await repoDiffFile(root, query({ path: "keep.txt" }));
    expect(edit).toMatchObject({ unavailable: null, truncated: false, file: { path: "keep.txt", status: "modified", additions: 2, deletions: 1 }, limits: { max_patch_bytes: REPO_DIFF_MAX_PATCH_BYTES, context_lines: REPO_DIFF_CONTEXT_LINES } });
    expect(edit.patch).toStartWith("diff --git a/keep.txt b/keep.txt\n");
    expect(parsed(edit.patch).map((file) => [file.name, file.type, file.hunks.length])).toEqual([["keep.txt", "change", 1]]);

    const deleted = await repoDiffFile(root, query({ path: "gone.txt" }));
    expect(parsed(deleted.patch).map((file) => [file.name, file.type])).toEqual([["gone.txt", "deleted"]]);

    const untracked = await repoDiffFile(root, query({ path: "new file.txt" }));
    expect(untracked.file).toEqual({ path: "new file.txt", old_path: null, status: "untracked", additions: null, deletions: null, binary: false });
    expect(parsed(untracked.patch).map((file) => [file.name, file.type, file.additionLines])).toEqual([["new file.txt", "new", ["one\n", "two\n"]]]);

    const added = await repoDiffFile(root, query({ scope: "staged", path: "staged-new.txt" }));
    expect(parsed(added.patch).map((file) => [file.name, file.type])).toEqual([["staged-new.txt", "new"]]);

    const renamed = await repoDiffFile(root, query({ scope: "staged", path: "moved-to.txt", old_path: "moved-from.txt" }));
    expect(renamed.file).toMatchObject({ status: "renamed", old_path: "moved-from.txt" });
    expect(parsed(renamed.patch).map((file) => [file.name, file.prevName, file.type])).toEqual([["moved-to.txt", "moved-from.txt", "rename-changed"]]);
  });

  it("keeps a path with spaces and non-ASCII letters as it is, in the list and in the patch", async () => {
    const answer = await repoDiffFile(root, query({ path: UNICODE }));
    expect(answer.file.path).toBe(UNICODE);
    expect(answer.patch).toStartWith(`diff --git a/${UNICODE} b/${UNICODE}\n`);
    expect(parsed(answer.patch).map((file) => [file.name, file.deletionLines, file.additionLines])).toEqual([[UNICODE, ["eins\n"], ["zwei\n"]]]);
  });

  it("says a binary file is binary instead of sending a patch, tracked or not", async () => {
    for (const path of ["pic.bin", "blob.bin"]) {
      const answer = await repoDiffFile(root, query({ path }));
      expect(answer).toMatchObject({ patch: null, unavailable: "binary", truncated: false, file: { path, binary: true } });
    }
  });

  it("refuses a path that is not one inside the repository, and one where nothing changed", async () => {
    for (const path of ["", "../outside.txt", "/etc/hosts", "a//b", "dir/../keep.txt", "./keep.txt", "keep.txt\0"]) {
      await expect(repoDiffFile(root, query({ path }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    }
    await expect(repoDiffFile(root, query({ path: "keep.txt", old_path: "../x" }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    // pathspec magic and globs are read as plain names
    for (const path of ["staged-new.txt", "*.txt", ":(glob)**", ":/keep.txt"]) {
      await expect(repoDiffFile(root, query({ path }))).rejects.toMatchObject({ code: "not_found", status: 404 });
    }
  });

  it("refuses an unknown scope, and revisions outside the commit scope", async () => {
    await expect(repoDiffFiles(root, query({ scope: "everything" }))).rejects.toMatchObject({ code: "invalid_scope", status: 400 });
    await expect(repoDiffFiles(root, query({ scope: "staged", base: "HEAD" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
  });

  it("refuses an unrelated old path instead of returning another file's patch first", async () => {
    await expect(repoDiffFile(root, query({ path: "keep.txt", old_path: UNICODE }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
  });

  it("refuses stale rename metadata after the original path is reused", async () => {
    const root = repository("reused-rename-path");
    writeFileSync(join(root, "old.txt"), lines(12));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    git(root, "mv", "old.txt", "new.txt");
    writeFileSync(join(root, "old.txt"), "replacement\n");
    git(root, "add", ".");
    await expect(repoDiffFile(root, query({ scope: "staged", path: "new.txt", old_path: "old.txt" }))).rejects.toMatchObject({ code: "invalid_path", status: 400 });
    const answer = await repoDiffFile(root, query({ scope: "staged", path: "new.txt" }));
    expect(parsed(answer.patch).map((file) => file.name)).toEqual(["new.txt"]);
  });
});

describe("comparing two commits", () => {
  let root: string;
  let first: string;
  let second: string;
  beforeAll(() => {
    root = repository("commits");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    first = git(root, "rev-parse", "HEAD").trim();
    writeFileSync(join(root, "a.txt"), "one\ntwo\n");
    writeFileSync(join(root, "b.txt"), "new\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "second");
    second = git(root, "rev-parse", "HEAD").trim();
    git(root, "tag", "v1", first);
    writeFileSync(join(root, "a.txt"), "dirty\n");
  });

  it("lists and patches what differs between the two, named as full hashes", async () => {
    const comparisons: Record<string, string>[] = [{ base: "HEAD~1" }, { base: "v1", head: "main" }, { base: first, head: second }];
    for (const revisions of comparisons) {
      const list = await repoDiffFiles(root, query({ scope: "commit", ...revisions }));
      expect(list).toMatchObject({ scope: "commit", base: first, head: second, total: 2, truncated: false });
      expect(list.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([["a.txt", "modified", 1, 0], ["b.txt", "added", 1, 0]]);
    }
    const answer = await repoDiffFile(root, query({ scope: "commit", base: first, head: second, path: "a.txt" }));
    expect(answer).toMatchObject({ base: first, head: second, unavailable: null });
    expect(parsed(answer.patch).map((file) => [file.name, file.additionLines.includes("two\n"), file.additionLines.includes("dirty\n")])).toEqual([["a.txt", true, false]]);
    expect((await repoDiffFiles(root, query({ scope: "commit", base: second, head: second }))).files).toEqual([]);
  });

  it("refuses a revision that is an option, a range or malformed, and one that names no commit", async () => {
    const marker = join(scratch, "option-ran");
    for (const base of [`--output=${marker}`, "-p", "HEAD..main", "HEAD:a.txt", "HEAD main", "", "x".repeat(201)]) {
      await expect(repoDiffFiles(root, query({ scope: "commit", base }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
    }
    expect(existsSync(marker)).toBeFalse();
    await expect(repoDiffFiles(root, query({ scope: "commit" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
    await expect(repoDiffFiles(root, query({ scope: "commit", base: "no-such-branch" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
    await expect(repoDiffFile(root, query({ scope: "commit", base: first, head: "deadbeef", path: "a.txt" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
  });
});

describe("a branch against a base", () => {
  let root: string;
  let fork: string;
  let baseTip: string;
  let head: string;
  const branchQuery = (values: Record<string, string> = {}) => query({ scope: "branch", base: "main", ...values });
  const pinned = (list: RepoDiffFileList, values: Record<string, string> = {}) => query({ scope: "branch", comparison: JSON.stringify(list.comparison), ...values });
  beforeAll(() => {
    root = repository("branch");
    writeFileSync(join(root, "shared.txt"), lines(6));
    writeFileSync(join(root, "base-only.txt"), "base\n");
    writeFileSync(join(root, "moved-from.txt"), lines(12));
    writeFileSync(join(root, "gone.txt"), "going\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "fork point");
    fork = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "feature.txt"), "committed on the branch\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "branch work");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "base-only.txt"), "base moved on\n");
    writeFileSync(join(root, "shared.txt"), lines(6).replace("line 1\n", "base edit\n"));
    git(root, "commit", "-q", "-a", "-m", "base moves on");
    baseTip = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "feature");
    head = git(root, "rev-parse", "HEAD").trim();
    git(root, "mv", "moved-from.txt", "moved-to.txt");
    writeFileSync(join(root, "moved-to.txt"), lines(12).replace("line 3\n", "line three\n"));
    git(root, "add", "moved-to.txt");
    writeFileSync(join(root, "shared.txt"), lines(6).replace("line 6\n", "branch edit\n"));
    rmSync(join(root, "gone.txt"));
    writeFileSync(join(root, "untracked.txt"), "never added\n");
    writeFileSync(join(root, "untracked.bin"), new Uint8Array([0, 1, 2, 0]));
  });

  it("branch compares merge base including untracked", async () => {
    const list = await repoDiffFiles(root, branchQuery());
    expect(list.repository).toEqual({ root, branch: "feature", head, detached: false, unborn: false });
    expect(list).toMatchObject({ scope: "branch", base: baseTip, head, total: 6, truncated: false });
    expect(list.comparison).toEqual({ repository_root: root, head_oid: head, base_oid: baseTip, merge_base_oid: fork });
    expect(list.files).toEqual([
      { path: "feature.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false },
      { path: "gone.txt", old_path: null, status: "deleted", additions: 0, deletions: 1, binary: false },
      { path: "moved-to.txt", old_path: "moved-from.txt", status: "renamed", additions: 1, deletions: 1, binary: false },
      { path: "shared.txt", old_path: null, status: "modified", additions: 1, deletions: 1, binary: false },
      { path: "untracked.bin", old_path: null, status: "untracked", additions: null, deletions: null, binary: null },
      { path: "untracked.txt", old_path: null, status: "untracked", additions: null, deletions: null, binary: null },
    ]);
    for (const base of ["refs/heads/main", baseTip]) expect((await repoDiffFiles(root, branchQuery({ base }))).comparison).toEqual(list.comparison);

    const shared = await repoDiffFile(root, pinned(list, { path: "shared.txt" }));
    expect(shared).toMatchObject({ scope: "branch", base: baseTip, head, comparison: list.comparison, unavailable: null });
    expect(parsed(shared.patch).map((file) => [file.name, file.deletionLines.includes("line 6\n"), file.additionLines.includes("branch edit\n"), file.deletionLines.includes("base edit\n"), file.additionLines.includes("base edit\n")])).toEqual([["shared.txt", true, true, false, false]]);
    const added = await repoDiffFile(root, pinned(list, { path: "feature.txt" }));
    expect(parsed(added.patch).map((file) => [file.name, file.type])).toEqual([["feature.txt", "new"]]);
    const renamed = await repoDiffFile(root, pinned(list, { path: "moved-to.txt", old_path: "moved-from.txt" }));
    expect(parsed(renamed.patch).map((file) => [file.name, file.prevName, file.type])).toEqual([["moved-to.txt", "moved-from.txt", "rename-changed"]]);
    const untracked = await repoDiffFile(root, pinned(list, { path: "untracked.txt" }));
    expect(untracked.file).toMatchObject({ status: "untracked", binary: false });
    expect(parsed(untracked.patch).map((file) => [file.name, file.type, file.additionLines])).toEqual([["untracked.txt", "new", ["never added\n"]]]);
    expect(await repoDiffFile(root, pinned(list, { path: "untracked.bin" }))).toMatchObject({ patch: null, unavailable: "binary", file: { binary: true } });
    expect(await repoDiffFile(root, pinned(list, { path: "untracked.txt" }), { maxPatchBytes: 16 })).toMatchObject({ patch: null, unavailable: "too_large", truncated: true });
    await expect(repoDiffFile(root, pinned(list, { path: "base-only.txt" }))).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("detached HEAD is valid", async () => {
    git(root, "checkout", "-q", "--detach");
    try {
      const list = await repoDiffFiles(root, branchQuery());
      expect(list.repository).toMatchObject({ branch: null, head, detached: true, unborn: false });
      expect(list.comparison).toEqual({ repository_root: root, head_oid: head, base_oid: baseTip, merge_base_oid: fork });
      expect(list.files.map((file) => file.path)).toEqual(["feature.txt", "gone.txt", "moved-to.txt", "shared.txt", "untracked.bin", "untracked.txt"]);
      expect(parsed((await repoDiffFile(root, pinned(list, { path: "feature.txt" }))).patch).map((file) => file.name)).toEqual(["feature.txt"]);
    } finally {
      git(root, "checkout", "-q", "feature");
    }
  });

  it("unborn and unrelated histories fail", async () => {
    const unborn = repository("branch-unborn");
    await expect(repoDiffFiles(unborn, branchQuery())).rejects.toMatchObject({ code: "unborn_head", status: 409 });
    await expect(repoDiffFiles(unborn, branchQuery({ base: "-p" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });

    const orphan = repository("branch-orphan");
    writeFileSync(join(orphan, "a.txt"), "one\n");
    git(orphan, "add", ".");
    git(orphan, "commit", "-q", "-m", "main");
    git(orphan, "checkout", "-q", "--orphan", "island");
    writeFileSync(join(orphan, "b.txt"), "two\n");
    git(orphan, "add", ".");
    git(orphan, "commit", "-q", "-m", "island");
    writeFileSync(join(orphan, "c.txt"), "not listed in the base's place\n");
    const log = git(orphan, "log", "--all", "--oneline");
    await expect(repoDiffFiles(orphan, branchQuery())).rejects.toMatchObject({ code: "no_common_ancestor", status: 409 });
    expect(git(orphan, "log", "--all", "--oneline")).toBe(log);
    expect(git(orphan, "status", "--porcelain")).toBe("?? c.txt\n");

    const marker = join(scratch, "branch-option-ran");
    for (const base of [`--output=${marker}`, "-p", "main..feature", "HEAD:a.txt", "$(touch x)", "main; ls", "", "x".repeat(201)]) {
      await expect(repoDiffFiles(root, branchQuery({ base }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
    }
    expect(existsSync(marker)).toBeFalse();
    await expect(repoDiffFiles(root, query({ scope: "branch" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
    await expect(repoDiffFiles(root, branchQuery({ base: "no-such-branch" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
    await expect(repoDiffFiles(root, branchQuery({ base: "refs/heads/no-such-branch" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
    await expect(repoDiffFiles(root, branchQuery({ head: "HEAD" }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
  });

  it("base moves retain pinned comparison", async () => {
    const list = await repoDiffFiles(root, branchQuery());
    const movedTip = git(root, "commit-tree", git(root, "rev-parse", `${baseTip}^{tree}`).trim(), "-p", baseTip, "-m", "base moves again").trim();
    git(root, "update-ref", "refs/heads/main", movedTip);
    try {
      expect(movedTip).not.toBe(baseTip);
      const answer = await repoDiffFile(root, pinned(list, { path: "shared.txt" }));
      expect(answer.comparison).toEqual(list.comparison);
      expect(answer).toMatchObject({ base: baseTip, head });
      expect(parsed(answer.patch).map((file) => [file.deletionLines.includes("line 6\n"), file.additionLines.includes("branch edit\n"), file.deletionLines.includes("base edit\n")])).toEqual([[true, true, false]]);
      const fresh = await repoDiffFiles(root, branchQuery());
      expect(fresh.comparison).toEqual({ repository_root: root, head_oid: head, base_oid: movedTip, merge_base_oid: fork });
    } finally {
      git(root, "update-ref", "refs/heads/main", baseTip);
    }
  });

  it("HEAD or repository move requires refresh", async () => {
    const list = await repoDiffFiles(root, branchQuery());
    const identity = list.comparison!;
    const moved = git(root, "commit-tree", git(root, "rev-parse", `${head}^{tree}`).trim(), "-p", head, "-m", "more branch work").trim();
    git(root, "update-ref", "refs/heads/feature", moved);
    try {
      expect(moved).not.toBe(head);
      await expect(repoDiffFile(root, pinned(list, { path: "shared.txt" }))).rejects.toMatchObject({ code: "comparison_changed", status: 409 });
      expect((await repoDiffFiles(root, branchQuery())).comparison).toEqual({ ...identity, head_oid: moved });
    } finally {
      git(root, "update-ref", "refs/heads/feature", head);
    }
    const other = repository("branch-other");
    writeFileSync(join(other, "shared.txt"), "elsewhere\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "other");
    await expect(repoDiffFile(other, pinned(list, { path: "shared.txt" }))).rejects.toMatchObject({ code: "comparison_changed", status: 409 });
    const malformed: unknown[] = ["{", "[]", "null", JSON.stringify({ ...identity, extra: 1 }), JSON.stringify({ ...identity, merge_base_oid: "HEAD" }), JSON.stringify({ ...identity, repository_root: "" }), JSON.stringify({ head_oid: identity.head_oid }), "x".repeat(9_000)];
    // a full git id is 40 (SHA-1) or 64 (SHA-256) hex digits, nothing between or around
    for (const key of ["head_oid", "base_oid", "merge_base_oid"] as const) {
      for (const length of [39, 41, 63, 65]) malformed.push(JSON.stringify({ ...identity, [key]: "a".repeat(length) }));
    }
    for (const comparison of malformed) {
      await expect(repoDiffFile(root, query({ scope: "branch", comparison: comparison as string, path: "shared.txt" }))).rejects.toMatchObject({ code: "invalid_comparison", status: 400 });
    }
    await expect(repoDiffFile(root, query({ scope: "branch", comparison: JSON.stringify({ ...identity, merge_base_oid: baseTip }), path: "shared.txt" }))).rejects.toMatchObject({ code: "invalid_comparison", status: 400 });
    await expect(repoDiffFile(root, query({ scope: "branch", comparison: JSON.stringify({ ...identity, base_oid: "f".repeat(40) }), path: "shared.txt" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
    await expect(repoDiffFile(root, branchQuery({ path: "shared.txt" }))).rejects.toMatchObject({ code: "invalid_comparison", status: 400 });
    await expect(repoDiffFiles(root, pinned(list))).rejects.toMatchObject({ code: "invalid_comparison", status: 400 });
    await expect(repoDiffFiles(root, query({ scope: "workspace", comparison: JSON.stringify(identity) }))).rejects.toMatchObject({ code: "invalid_comparison", status: 400 });
  });

  it("refs are bounded and remote symbolic HEAD is omitted", async () => {
    const refs = await repoDiffRefs(root);
    expect(refs.repository.root).toBe(root);
    expect(refs).toMatchObject({ truncated: false, limits: { max_refs: REPO_DIFF_MAX_REFS, max_list_bytes: REPO_DIFF_MAX_LIST_BYTES } });
    expect(refs.refs).toEqual([{ name: "refs/heads/feature", oid: head }, { name: "refs/heads/main", oid: baseTip }]);

    git(root, "update-ref", "refs/remotes/origin/main", baseTip);
    git(root, "update-ref", "refs/remotes/origin/feature", head);
    git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    git(root, "tag", "v1", fork);
    expect((await repoDiffRefs(root)).refs).toEqual([
      { name: "refs/heads/feature", oid: head }, { name: "refs/heads/main", oid: baseTip },
      { name: "refs/remotes/origin/feature", oid: head }, { name: "refs/remotes/origin/main", oid: baseTip },
    ]);
    // a base picked from the list is named in full, so it is that branch and never a tag of the same name (which git reads first)
    git(root, "tag", "main", fork);
    expect((await repoDiffFiles(root, branchQuery({ base: "refs/heads/main" }))).comparison?.base_oid).toBe(baseTip);
    expect((await repoDiffFiles(root, branchQuery({ base: "main" }))).comparison?.base_oid).toBe(fork);
    git(root, "tag", "-d", "main");

    const many = Array.from({ length: 210 }, (_, index) => `refs/heads/many/${String(index).padStart(3, "0")}`);
    updateRefs(root, many.map((name) => `create ${name} ${fork}`));
    const crowded = await repoDiffRefs(root);
    expect(crowded.refs.length).toBe(REPO_DIFF_MAX_REFS);
    expect(crowded.truncated).toBe(true);
    expect(crowded.refs[0]).toEqual({ name: "refs/heads/feature", oid: head });
    expect(crowded.refs.every((ref) => /^refs\/(?:heads|remotes)\//.test(ref.name) && /^[0-9a-f]{40}$/.test(ref.oid))).toBe(true);
    expect((await repoDiffFiles(root, branchQuery({ base: "refs/heads/many/209" }))).comparison?.base_oid).toBe(fork);
    const few = await repoDiffRefs(root, { maxRefs: 3 });
    expect(few.refs.map((ref) => ref.name)).toEqual(["refs/heads/feature", "refs/heads/main", "refs/heads/many/000"]);
    expect(few).toMatchObject({ truncated: true, limits: { max_refs: 3 } });
    const cut = await repoDiffRefs(root, { maxListBytes: 256 });
    expect(cut.truncated).toBe(true);
    expect(cut.refs.length).toBeGreaterThan(0);
    expect(cut.refs.every((ref) => /^[0-9a-f]{40}$/.test(ref.oid))).toBe(true);
    updateRefs(root, many.map((name) => `delete ${name}`));
  });

  it("compares every branch the refs list offers, by its full name, and still refuses expressions in that shape", async () => {
    const offered = ["refs/heads/topic+base", "refs/heads/topic/한글", `refs/heads/topic/${"x".repeat(192)}`, "refs/remotes/origin/release+1"];
    updateRefs(root, offered.map((name) => `create ${name} ${fork}`));
    try {
      const listed = (await repoDiffRefs(root)).refs.map((ref) => ref.name);
      for (const name of offered) {
        expect(listed).toContain(name);
        const list = await repoDiffFiles(root, branchQuery({ base: name }));
        expect(list.comparison).toEqual({ repository_root: root, head_oid: head, base_oid: fork, merge_base_oid: fork });
        expect(parsed((await repoDiffFile(root, pinned(list, { path: "feature.txt" }))).patch).map((file) => file.name)).toEqual(["feature.txt"]);
      }
      expect(offered[2]!.length).toBe(209);
      // a full name with letters a short expression refuses is a name and nothing more: no range, reflog,
      // peel, path, space or option rides on it, and none past the cap
      const marker = join(scratch, "refname-option-ran");
      for (const base of ["refs/heads/topic+base..main", "refs/heads/topic+base@{1}", "refs/heads/topic+base^{tree}", "refs/heads/topic+base~1", "refs/heads/topic+base:feature.txt", "refs/heads/topic+base ", `refs/heads/topic+base --output=${marker}`, "refs/heads/topic+base.lock", "refs/heads/topic+base/", `refs/heads/topic+${"x".repeat(1_100)}`, "refs/tags/v1+x", "refs/heads/topic+base\0"]) {
        await expect(repoDiffFiles(root, branchQuery({ base }))).rejects.toMatchObject({ code: "invalid_revision", status: 400 });
      }
      // a valid name that starts like an option is still only a refname, and here names nothing
      await expect(repoDiffFiles(root, branchQuery({ base: "refs/heads/-p" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
      expect(existsSync(marker)).toBeFalse();
    } finally {
      updateRefs(root, offered.map((name) => `delete ${name}`));
    }
  });

  it("refuses a patch when a checkout lands while it is read, never answering it under the old identity", async () => {
    const racy = repository("branch-race");
    writeFileSync(join(racy, "a.txt"), "base\n");
    git(racy, "add", ".");
    git(racy, "commit", "-q", "-m", "base");
    git(racy, "checkout", "-q", "-b", "other");
    writeFileSync(join(racy, "a.txt"), "other-branch-content\n");
    git(racy, "commit", "-q", "-a", "-m", "other");
    git(racy, "checkout", "-q", "-b", "feature", "main");
    writeFileSync(join(racy, "a.txt"), "feature-content\n");
    git(racy, "commit", "-q", "-a", "-m", "feature");
    const list = await repoDiffFiles(racy, query({ scope: "branch", base: "main" }));
    const cases = [["patch", "*\" diff \"*-U3*", "other"], ["emptied patch", "*\" diff \"*-U3*", "main"], ["emptied listing", "*--name-status*", "main"]] as const;
    for (const [label, when, target] of cases) {
      const marker = join(scratch, `race-${target}-${label.length}`);
      const racer = join(scratch, `racing-git-${label.length}`);
      writeFileSync(racer, `#!/bin/sh\ncase "$*" in ${when}) [ -f '${marker}' ] || { touch '${marker}'; git -C '${racy}' checkout -q ${target}; } ;; esac\nexec git "$@"\n`);
      chmodSync(racer, 0o755);
      try {
        await expect(repoDiffFile(racy, pinned(list, { path: "a.txt" }), { git: racer })).rejects.toMatchObject({ code: "comparison_changed", status: 409 });
        expect(existsSync(marker)).toBeTrue();
        expect(git(racy, "rev-parse", "HEAD").trim()).not.toBe(list.comparison!.head_oid);
      } finally {
        git(racy, "checkout", "-q", "feature");
      }
    }
  });

  it("never fetches, checks out or writes while comparing a branch", async () => {
    const log = join(scratch, "git-calls.log");
    const logging = join(scratch, "logging-git");
    writeFileSync(logging, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec git "$@"\n`);
    chmodSync(logging, 0o755);
    rmSync(log, { force: true });
    const list = await repoDiffFiles(root, branchQuery(), { git: logging });
    await repoDiffFile(root, pinned(list, { path: "shared.txt" }), { git: logging });
    await repoDiffRefs(root, { git: logging });
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThan(5);
    const commands = calls.map((call) => /-C \S+ (\S+)/.exec(call)?.[1] ?? call);
    expect(new Set(commands)).toEqual(new Set(["rev-parse", "symbolic-ref", "merge-base", "diff", "ls-files", "for-each-ref"]));
    expect(git(root, "status", "--porcelain")).toBe(" D gone.txt\nR  moved-from.txt -> moved-to.txt\n M shared.txt\n?? untracked.bin\n?? untracked.txt\n");
  });
});

describe("repositories in an unusual state", () => {
  it("reads a repository with no commit yet: nothing, then untracked, then staged", async () => {
    const root = repository("unborn");
    const empty = await repoDiffFiles(root, query());
    expect(empty.repository).toEqual({ root, branch: "main", head: null, detached: false, unborn: true });
    expect(empty).toMatchObject({ files: [], total: 0, truncated: false });
    writeFileSync(join(root, "first.txt"), "hello\n");
    expect((await repoDiffFiles(root, query())).files.map((file) => [file.path, file.status])).toEqual([["first.txt", "untracked"]]);
    git(root, "add", "first.txt");
    expect((await repoDiffFiles(root, query({ scope: "staged" }))).files).toEqual([{ path: "first.txt", old_path: null, status: "added", additions: 1, deletions: 0, binary: false }]);
    const staged = await repoDiffFile(root, query({ scope: "staged", path: "first.txt" }));
    expect(parsed(staged.patch).map((file) => [file.name, file.type])).toEqual([["first.txt", "new"]]);
    await expect(repoDiffFiles(root, query({ scope: "commit", base: "HEAD" }))).rejects.toMatchObject({ code: "revision_not_found", status: 404 });
    expect(await repoDiffRefs(root)).toMatchObject({ refs: [], truncated: false });
  });

  it("reads a detached HEAD and a clean tree", async () => {
    const root = repository("detached");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    const head = git(root, "rev-parse", "HEAD").trim();
    git(root, "checkout", "-q", "--detach");
    const list = await repoDiffFiles(root, query());
    expect(list.repository).toEqual({ root, branch: null, head, detached: true, unborn: false });
    expect(list).toMatchObject({ files: [], total: 0, truncated: false });
  });

  it("says a folder outside any repository is not one, and that a conflicted file has no unified patch", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    await expect(repoDiffFiles(plain, query())).rejects.toMatchObject({ code: "not_a_repository", status: 409 });
    await expect(repoDiffFile(plain, query({ path: "a.txt" }))).rejects.toMatchObject({ code: "not_a_repository", status: 409 });
    await expect(repoDiffFiles(join(scratch, "missing"), query())).rejects.toMatchObject({ code: "not_a_repository", status: 409 });

    const root = repository("conflict");
    writeFileSync(join(root, "c.txt"), "base\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    git(root, "checkout", "-q", "-b", "side");
    writeFileSync(join(root, "c.txt"), "side\n");
    git(root, "commit", "-q", "-a", "-m", "side");
    git(root, "checkout", "-q", "main");
    writeFileSync(join(root, "c.txt"), "main\n");
    git(root, "commit", "-q", "-a", "-m", "main");
    expect(Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", root, "merge", "side"], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(1);
    expect((await repoDiffFiles(root, query())).files).toEqual([{ path: "c.txt", old_path: null, status: "unmerged", additions: null, deletions: null, binary: null }]);
    expect(await repoDiffFile(root, query({ path: "c.txt" }))).toMatchObject({ patch: null, unavailable: "unmerged", truncated: false });
  });
});

describe("bounds", () => {
  let root: string;
  const names = Array.from({ length: 30 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`);
  beforeAll(() => {
    root = repository("bounds");
    writeFileSync(join(root, "big.txt"), lines(400));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, "big.txt"), lines(400, "changed"));
    for (const name of names) writeFileSync(join(root, name), "x\n");
  });

  it("cuts a list at the file cap and says how many there were", async () => {
    const list = await repoDiffFiles(root, query(), { maxFiles: 5 });
    expect(list).toMatchObject({ total: 31, truncated: true, limits: { max_files: 5 } });
    expect(list.files.map((file) => file.path)).toEqual(["big.txt", ...names.slice(0, 4)]);
  });

  it("cuts a list at the byte cap on a whole name, with the total unknown", async () => {
    const list = await repoDiffFiles(root, query(), { maxListBytes: 64 });
    expect(list).toMatchObject({ total: null, truncated: true, limits: { max_list_bytes: 64 } });
    expect(list.files.length).toBeGreaterThan(0);
    expect(list.files.length).toBeLessThan(31);
    for (const file of list.files) expect(["big.txt", ...names]).toContain(file.path);
  });

  it("sends no part of a patch past the cap, for a tracked and an untracked file", async () => {
    const whole = await repoDiffFile(root, query({ path: "big.txt" }));
    expect(parsed(whole.patch).map((file) => [file.name, file.additionLines.length])).toEqual([["big.txt", 400]]);
    const capped = await repoDiffFile(root, query({ path: "big.txt" }), { maxPatchBytes: 512 });
    expect(capped).toMatchObject({ patch: null, unavailable: "too_large", truncated: true, file: { path: "big.txt", additions: 400, deletions: 400 }, limits: { max_patch_bytes: 512 } });
    writeFileSync(join(root, "f00.txt"), lines(200));
    expect(await repoDiffFile(root, query({ path: "f00.txt" }), { maxPatchBytes: 512 })).toMatchObject({ patch: null, unavailable: "too_large", truncated: true });
    writeFileSync(join(root, "f01.txt"), "y\n".repeat(250));
    expect(await repoDiffFile(root, query({ path: "f01.txt" }), { maxPatchBytes: 512 })).toMatchObject({ patch: null, unavailable: "too_large", truncated: true });
  });

  it("does not follow an untracked link out of the repository", async () => {
    const secret = join(scratch, "secret.txt");
    writeFileSync(secret, "do not read\n");
    symlinkSync(secret, join(root, "link.txt"));
    expect(await repoDiffFile(root, query({ path: "link.txt" }))).toMatchObject({ patch: null, unavailable: "unsupported", truncated: false });
  });

  it("stops a git that does not answer by its deadline, and says when there is no git", async () => {
    const hung = join(scratch, "hung-git");
    writeFileSync(hung, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(hung, 0o755);
    await expect(repoDiffFiles(root, query(), { git: hung, deadlineMs: 50 })).rejects.toMatchObject({ code: "git_timeout", status: 504 });
    await expect(repoDiffFiles(root, query(), { git: join(scratch, "no-git-here") })).rejects.toMatchObject({ code: "git_unavailable", status: 503 });
  });

  it("runs none of the programs a repository's configuration names", async () => {
    const hooked = repository("hooked");
    const marker = join(scratch, "program-ran");
    const program = join(scratch, "program.sh");
    writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\n[ -f "$1" ] && cat "$1"\nexit 0\n`);
    chmodSync(program, 0o755);
    writeFileSync(join(hooked, ".gitattributes"), "*.txt diff=marker\n");
    writeFileSync(join(hooked, "a.txt"), "one\n");
    git(hooked, "add", ".");
    git(hooked, "commit", "-q", "-m", "first");
    writeFileSync(join(hooked, "a.txt"), "two\n");
    writeFileSync(join(hooked, "b.txt"), "new\n");
    git(hooked, "config", "diff.external", program);
    git(hooked, "config", "diff.marker.textconv", program);
    git(hooked, "config", "core.fsmonitor", program);
    // git before 2.36 reads core.fsmonitor=false as a hook named `false`, found on PATH
    const onPath = join(scratch, "on-path");
    mkdirSync(onPath);
    writeFileSync(join(onPath, "false"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(onPath, "false"), 0o755);
    rmSync(marker, { force: true });
    const spawn = spyOn(Bun, "spawn");
    try {
      await withEnvironment("PATH", `${onPath}${delimiter}${process.env["PATH"] ?? ""}`, async () => {
        expect((await repoDiffFiles(hooked, query())).files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
        for (const path of ["a.txt", "b.txt"]) expect((await repoDiffFile(hooked, query({ path }))).patch).toStartWith(`diff --git a/${path} b/${path}\n`);
      });
      // the stand-in above only runs on git before 2.36, so the value itself is checked on any git
      const argvs = (spawn.mock.calls as unknown as [string[]][]).map(([argv]) => argv).filter((argv) => argv[0] === "git");
      expect(argvs.length).toBeGreaterThan(0);
      for (const argv of argvs) {
        expect(argv[argv.indexOf("core.fsmonitor=") - 1]).toBe("-c");
        expect(argv).not.toContain("core.fsmonitor=false");
      }
    } finally {
      spawn.mockRestore();
    }
    expect(existsSync(marker)).toBeFalse();
  });

  it("reads the repository asked about, not a common directory the server inherited", async () => {
    const own = repository("own-common");
    writeFileSync(join(own, "a.txt"), "one\n");
    git(own, "add", ".");
    git(own, "commit", "-q", "-m", "first");
    writeFileSync(join(own, "a.txt"), "two\n");
    writeFileSync(join(own, "b.txt"), "new\n");
    const foreign = repository("foreign-common");
    mkdirSync(join(foreign, ".git", "info"), { recursive: true });
    writeFileSync(join(foreign, ".git", "info", "exclude"), "b.txt\n");
    const head = git(own, "rev-parse", "HEAD").trim();
    await withEnvironment("GIT_COMMON_DIR", join(foreign, ".git"), async () => {
      const list = await repoDiffFiles(own, query());
      expect(list.repository.head).toBe(head);
      expect(list.files.map((file) => file.path)).toEqual(["a.txt", "b.txt"]);
      expect((await repoDiffFile(own, query({ path: "a.txt" }))).patch).toContain("\n+two\n");
    });
  });
});

describe("GET /api/workspace/diff/*", () => {
  let root: string;
  let server: ReturnType<typeof createServer>;
  let base: string;
  let watchCookie: string;
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-repo-diff-state-"));
  const owner = { authorization: "Bearer test-repo-diff" };
  beforeAll(() => {
    root = repository("http");
    writeFileSync(join(root, "a.txt"), "one\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "first");
    writeFileSync(join(root, "a.txt"), "two\n");
    const store = new DeviceStore(stateDir);
    const watchToken = store.pair(store.startPairing().code, "Watch", "watch")!.token;
    // a first pairing is a device only once its cookie came back: that return is what saves it
    expect(store.match(watchToken)).not.toBeNull();
    watchCookie = `ovis_device=${watchToken}`;
    server = createServer({ port: 0, stateDir, token: "test-repo-diff", tailscaleOwner: null, machines: false });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => { server.stop(); rmSync(stateDir, { recursive: true, force: true }); });

  const files = (search: string, headers: Record<string, string> = owner, method = "GET") => fetch(`${base}/api/workspace/diff/files?${search}`, { method, headers });
  const directory = () => `directory=${encodeURIComponent(root)}`;

  it("answers a named folder's list and one file's patch, never cached", async () => {
    const listed = await files(directory());
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    const list = await listed.json() as RepoDiffFileList;
    expect(list.repository.root).toBe(root);
    expect(list.files).toEqual([{ path: "a.txt", old_path: null, status: "modified", additions: 1, deletions: 1, binary: false }]);
    const response = await fetch(`${base}/api/workspace/diff/file?${directory()}&path=a.txt`, { headers: owner });
    expect(response.status).toBe(200);
    const answer = await response.json() as RepoDiffFilePatch;
    expect(parsed(answer.patch).map((file) => [file.name, file.type])).toEqual([["a.txt", "change"]]);
  });

  it("lists the branches and compares the branch against one, the patch by the list's identity", async () => {
    const list = await (await files(directory())).json() as RepoDiffFileList;
    const listed = await fetch(`${base}/api/workspace/diff/refs?${directory()}`, { headers: owner });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("private, no-store");
    const refs = await listed.json() as RepoDiffRefs;
    expect(refs.refs).toEqual([{ name: "refs/heads/main", oid: list.repository.head! }]);
    const branch = await files(`${directory()}&scope=branch&base=refs%2Fheads%2Fmain`);
    expect(branch.status).toBe(200);
    const compared = await branch.json() as RepoDiffFileList;
    const identity: RepoBranchComparison = { repository_root: root, head_oid: list.repository.head!, base_oid: list.repository.head!, merge_base_oid: list.repository.head! };
    expect(compared).toMatchObject({ scope: "branch", comparison: identity });
    expect(compared.files.map((file) => file.path)).toEqual(["a.txt"]);
    const patch = await fetch(`${base}/api/workspace/diff/file?${directory()}&scope=branch&path=a.txt&comparison=${encodeURIComponent(JSON.stringify(identity))}`, { headers: owner });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as RepoDiffFilePatch).comparison).toEqual(identity);
    for (const [search, status, code] of [
      [`${directory()}&scope=branch`, 400, "invalid_revision"],
      [`${directory()}&scope=branch&base=nope`, 404, "revision_not_found"],
      [`${directory()}&scope=branch&base=main&comparison=%7B%7D`, 400, "invalid_comparison"],
    ] as const) {
      const response = await files(search);
      expect([search, response.status]).toEqual([search, status]);
      expect(((await response.json()) as ApiError).error.code).toBe(code);
    }
    const stale = await fetch(`${base}/api/workspace/diff/file?${directory()}&scope=branch&path=a.txt&comparison=${encodeURIComponent(JSON.stringify({ ...identity, head_oid: "0".repeat(40) }))}`, { headers: owner });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as ApiError).error.code).toBe("comparison_changed");
  });

  it("refuses bad input in the error envelope", async () => {
    const cases: [string, number, string][] = [
      ["", 400, "missing_directory"],
      ["directory=relative%2Ffolder", 400, "invalid_cwd"],
      [`directory=${encodeURIComponent(join(scratch, "nowhere"))}`, 400, "invalid_cwd"],
      [`directory=${encodeURIComponent(scratch)}`, 409, "not_a_repository"],
      [`${directory()}&scope=all`, 400, "invalid_scope"],
      [`${directory()}&scope=commit&base=--output%3D%2Ftmp%2Fx`, 400, "invalid_revision"],
      [`${directory()}&scope=commit&base=nope`, 404, "revision_not_found"],
    ];
    for (const [search, status, code] of cases) {
      const response = await files(search);
      expect([search, response.status]).toEqual([search, status]);
      const body = await response.json() as ApiError;
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
    }
    for (const [path, status, code] of [["..%2Fx", 400, "invalid_path"], ["", 400, "invalid_path"], ["absent.txt", 404, "not_found"]] as const) {
      const response = await fetch(`${base}/api/workspace/diff/file?${directory()}&path=${path}`, { headers: owner });
      expect(response.status).toBe(status);
      expect((await response.json() as ApiError).error.code).toBe(code);
    }
    const posted = await files(directory(), { ...owner, "x-herdr-machine": "1" }, "POST");
    expect(posted.status).toBe(400);
    expect((await posted.json() as ApiError).error.code).toBe("method_not_allowed");
  });

  it("is closed to a stranger, to another site's page and to a device that can only watch", async () => {
    expect((await files(directory(), {})).status).toBe(401);
    const crossSite = await files(directory(), { ...owner, "sec-fetch-site": "cross-site" });
    expect(crossSite.status).toBe(403);
    expect((await crossSite.json() as ApiError).error.code).toBe("cross_site");
    const crossSiteRefs = await fetch(`${base}/api/workspace/diff/refs?${directory()}`, { headers: { ...owner, "sec-fetch-site": "cross-site" } });
    expect(crossSiteRefs.status).toBe(403);
    expect((await crossSiteRefs.json() as ApiError).error.code).toBe("cross_site");
    expect((await fetch(`${base}/api/session`, { headers: { cookie: watchCookie } })).status).not.toBe(401);
    for (const path of ["workspace/diff/files", "workspace/diff/file", "workspace/diff/refs", "machines/pc1/workspace/diff/files", "machines/pc1/workspace/diff/file", "machines/pc1/workspace/diff/refs", "machines/local/workspace/diff/file"]) {
      const response = await fetch(`${base}/api/${path}?${directory()}&path=a.txt`, { headers: { cookie: watchCookie } });
      expect([path, response.status]).toEqual([path, 403]);
      expect((await response.json() as ApiError).error.code).toBe("read_only");
    }
  });
});
