import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type CheckStepStatus = "success" | "failure" | "skipped" | "not-run" | "interrupted";

export interface SourceIdentity {
  head: string | null;
  branch: string | null;
  trackedDiffSha256: string | null;
  untrackedFiles: { path: string; sha256: string }[];
  untrackedFileCount: number | null;
  untrackedContentSha256: string | null;
  untrackedFilesTruncated: boolean | null;
  fingerprint: string | null;
  reason: string | null;
}

export interface CheckStep {
  name: string;
  command: string[] | null;
  cwd: string;
  status: CheckStepStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number | null;
  startedAt: string | null;
  endedAt: string | null;
  stdout: string;
  stderr: string;
  reason: string | null;
}

export interface CheckReport {
  schemaVersion: 1;
  runId: string;
  status: "running" | "success" | "failure" | "interrupted";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  mode: string[];
  revision: {
    head: string | null;
    testedSha: string | null;
    headSha: string | null;
    headBranch: string | null;
    baseBranch: string | null;
    baseSha: string | null;
    branch: string | null;
  };
  toolchain: { bunVersion: string; nodeVersion: string | null; herdrVersion: string | null; herdrTestShards: number | null; platform: string; arch: string; ci: boolean };
  source: { start: SourceIdentity; end: SourceIdentity | null; unchanged: boolean | null };
  verification: {
    status: "pending" | "verified" | "invalidated" | "unknown";
    scope: "source-state-and-step-results";
    browserCurrentSource: "not-claimed";
    reason: string | null;
  };
  currentStep: string | null;
  steps: CheckStep[];
  errors: string[];
  browserArtifact: {
    path: string;
    buildAttempted: boolean;
    buildThisRun: boolean;
    identity: string | null;
    finalIdentity: string | null;
    unchangedAfterBuild: boolean | null;
    provenance: "built-this-run" | "pre-existing-unknown" | "modified-after-build" | "unknown" | "unavailable";
  };
  evidence: { logs: string[]; artifacts: string[]; retained: string[] };
}

export function createRunId(): string {
  return randomUUID();
}

function hashFile(path: string, hash: ReturnType<typeof createHash>): void {
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (let bytes = readSync(fd, buffer, 0, buffer.length, null); bytes > 0; bytes = readSync(fd, buffer, 0, buffer.length, null)) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(fd);
  }
}

export function reportPaths(
  cwd: string,
  env: Record<string, string | undefined>,
  runId: string,
): { reportPath: string; logDirectory: string } {
  const reportPath = env["CHECK_REPORT"]
    ? resolve(cwd, env["CHECK_REPORT"]!)
    : env["CHECK_DIR"]
      ? join(resolve(cwd, env["CHECK_DIR"]!), "report.json")
      : join(cwd, "node_modules", ".cache", "check", runId, "report.json");
  return {
    reportPath,
    logDirectory: join(dirname(reportPath), `${basename(reportPath)}.logs`, runId),
  };
}

export function sourceIdentity(cwd: string, excludedUntrackedPaths: readonly string[] = []): SourceIdentity {
  const boundedReason = (reason: string): string => reason.replace(/[\r\n\t]+/g, " ").trim().slice(0, 512) || "source identity unavailable";
  const gitFailure = (operation: string, result: ReturnType<typeof spawnSync>): string => {
    const detail = result.error?.message || (Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "");
    return boundedReason(`git ${operation} failed${detail ? `: ${detail}` : ` (exit ${result.status ?? "unknown"})`}`);
  };
  const unknown = (head: string | null, branch: string | null, reason: string): SourceIdentity => ({
    head,
    branch,
    trackedDiffSha256: null,
    untrackedFiles: [],
    untrackedFileCount: null,
    untrackedContentSha256: null,
    untrackedFilesTruncated: null,
    fingerprint: null,
    reason: boundedReason(reason),
  });
  const git = (args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const headResult = git(["rev-parse", "--verify", "HEAD"]);
  const head = headResult.status === 0 ? headResult.stdout.toString("utf8").trim() || null : null;
  const branchResult = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.status === 0 ? branchResult.stdout.toString("utf8").trim() || null : null;
  if (head === null || headResult.error) return unknown(head, branch, gitFailure("rev-parse --verify HEAD", headResult));

  const diff = git(["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
  const files = git(["ls-files", "--others", "--exclude-standard", "-z"]);
  if (diff.status !== 0 || files.status !== 0 || diff.error || files.error) {
    const failed = diff.status !== 0 || diff.error ? gitFailure("diff", diff) : gitFailure("ls-files --others", files);
    return unknown(head, branch, failed);
  }

  const trackedDiffSha256 = createHash("sha256").update(diff.stdout).digest("hex");
  const excluded = excludedUntrackedPaths.map((path) => resolve(cwd, path));
  const names = files.stdout.toString("utf8").split("\0").filter(Boolean).sort().filter((path) => {
    const absolute = resolve(cwd, path);
    return !excluded.some((prefix) => absolute === prefix || absolute.startsWith(`${prefix}${sep}`));
  });
  const untrackedFiles: SourceIdentity["untrackedFiles"] = [];
  const untrackedContent = createHash("sha256");
  const detailsLimit = 100;
  try {
    for (const path of names) {
      const absolute = resolve(cwd, path);
      const stat = lstatSync(absolute);
      const hash = createHash("sha256");
      const mode = stat.mode & 0o777;
      hash.update(`mode\0${mode}\0`);
      if (stat.isSymbolicLink()) hash.update(`symlink\0${readlinkSync(absolute)}`);
      else if (stat.isFile()) hashFile(absolute, hash);
      else throw new Error(`cannot hash untracked non-file: ${path}`);
      const sha256 = hash.digest("hex");
      untrackedContent.update(path).update("\0").update(String(mode)).update("\0").update(sha256).update("\0");
      if (untrackedFiles.length < detailsLimit) untrackedFiles.push({ path, sha256 });
    }
  } catch (error) {
    return {
      head,
      branch,
      trackedDiffSha256,
      untrackedFiles,
      untrackedFileCount: names.length,
      untrackedContentSha256: null,
      untrackedFilesTruncated: names.length > untrackedFiles.length,
      fingerprint: null,
      reason: boundedReason(`untracked source identity unavailable: ${error instanceof Error ? error.message : String(error)}`),
    };
  }
  const untrackedContentSha256 = untrackedContent.digest("hex");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ head, branch, trackedDiffSha256, untrackedFileCount: names.length, untrackedContentSha256 }))
    .digest("hex");
  return {
    head,
    branch,
    trackedDiffSha256,
    untrackedFiles,
    untrackedFileCount: names.length,
    untrackedContentSha256,
    untrackedFilesTruncated: names.length > untrackedFiles.length,
    fingerprint,
    reason: null,
  };
}

export function baseRevision(cwd: string, env: Record<string, string | undefined>): { branch: string | null; sha: string | null } {
  const branch = (env["GITHUB_BASE_REF"] || env["CI_MERGE_REQUEST_TARGET_BRANCH_NAME"] || null)?.slice(0, 512) ?? null;
  let sha = (env["GITHUB_BASE_SHA"] || env["CI_MERGE_REQUEST_TARGET_BRANCH_SHA"] || null)?.trim() ?? null;
  if (!sha && env["GITHUB_EVENT_PATH"]) {
    try {
      const path = env["GITHUB_EVENT_PATH"]!;
      if (statSync(path).size <= 1_048_576) {
        const event = JSON.parse(readFileSync(path, "utf8")) as {
          pull_request?: { base?: { sha?: string } };
          merge_group?: { base_sha?: string };
        };
        sha = event.pull_request?.base?.sha || event.merge_group?.base_sha || null;
      }
    } catch {}
  }
  if (!sha && branch) {
    try {
      const result = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", "--end-of-options", `${branch}^{commit}`], { encoding: "utf8", timeout: 5_000 });
      if (result.status === 0) sha = result.stdout.trim() || null;
    } catch {}
  }
  return { branch, sha: sha && /^[0-9a-f]{40,64}$/i.test(sha) ? sha : null };
}

/** The PR source commit is distinct from a merge commit checked out by CI. */
function headRevision(
  cwd: string,
  env: Record<string, string | undefined>,
  tested: { sha: string | null; branch: string | null },
): { headSha: string | null; headBranch: string | null } {
  const isPullRequest = env["GITHUB_EVENT_NAME"] === "pull_request" || env["GITHUB_EVENT_NAME"] === "pull_request_target";
  if (!isPullRequest) return { headSha: tested.sha, headBranch: tested.branch };
  try {
    const eventPath = env["GITHUB_EVENT_PATH"];
    if (!eventPath) return { headSha: null, headBranch: null };
    const path = resolve(cwd, eventPath);
    if (statSync(path).size > 1_048_576) return { headSha: null, headBranch: null };
    const event = JSON.parse(readFileSync(path, "utf8")) as {
      pull_request?: { head?: { sha?: unknown; ref?: unknown } };
    };
    const sha = event.pull_request?.head?.sha;
    const branch = event.pull_request?.head?.ref;
    if (typeof sha !== "string" || !/^[0-9a-f]{40,64}$/i.test(sha)
      || typeof branch !== "string" || branch.length === 0 || branch.length > 512 || /[\0-\x1f\x7f]/.test(branch)) {
      return { headSha: null, headBranch: null };
    }
    return { headSha: sha.toLowerCase(), headBranch: branch };
  } catch {
    return { headSha: null, headBranch: null };
  }
}

export function revisionDetails(
  cwd: string,
  env: Record<string, string | undefined>,
  source: Pick<SourceIdentity, "head" | "branch">,
): CheckReport["revision"] {
  const base = baseRevision(cwd, env);
  const environmentBranch = env["GITHUB_HEAD_REF"]
    || (env["GITHUB_REF_TYPE"] === "branch" ? env["GITHUB_REF_NAME"] : null)
    || env["CI_COMMIT_BRANCH"]
    || null;
  const branch = (source.branch || environmentBranch)?.slice(0, 512) ?? null;
  const head = headRevision(cwd, env, { sha: source.head, branch });
  return {
    head: source.head,
    testedSha: source.head,
    headSha: head.headSha,
    headBranch: head.headBranch,
    baseBranch: base.branch,
    baseSha: base.sha,
    branch,
  };
}

export function verificationResult(
  unchanged: boolean | null,
  status: CheckReport["status"],
  artifactUnchangedAfterBuild: boolean | null = null,
  artifactVerificationRequired = false,
): CheckReport["verification"] {
  const base = { scope: "source-state-and-step-results" as const, browserCurrentSource: "not-claimed" as const };
  if (unchanged === false) return { ...base, status: "invalidated", reason: "tracked or untracked source contents changed during the check" };
  if (artifactUnchangedAfterBuild === false) return { ...base, status: "invalidated", reason: "dist changed after the check build; browser artifact verification was invalidated" };
  if (unchanged === null) return { ...base, status: "unknown", reason: "the source identity could not be captured completely" };
  if (artifactVerificationRequired && artifactUnchangedAfterBuild === null) return { ...base, status: "unknown", reason: "the built dist identity could not be captured completely" };
  if (status === "success") return { ...base, status: "verified", reason: null };
  return { ...base, status: "unknown", reason: status === "interrupted" ? "the check was interrupted" : "the check did not complete successfully" };
}

export function artifactUnchangedAfterBuild(builtIdentity: string | null, finalIdentity: string | null): boolean | null {
  if (builtIdentity !== null && finalIdentity !== null) return builtIdentity === finalIdentity;
  return builtIdentity !== null && finalIdentity === null ? false : null;
}

export function reportExitCode(
  exitCode: number,
  persistenceFailed: boolean,
  sourceUnchanged: boolean | null = null,
  artifactUnchangedAfterBuild: boolean | null = null,
  artifactVerificationRequired = false,
): number {
  return exitCode === 0 && (
    persistenceFailed || sourceUnchanged !== true || artifactUnchangedAfterBuild === false
    || (artifactVerificationRequired && artifactUnchangedAfterBuild !== true)
  ) ? 1 : exitCode;
}

export function artifactIdentity(path: string): string | null {
  const root = resolve(path);
  const hash = createHash("sha256");
  const visit = (absolute: string, name: string): void => {
    const stat = lstatSync(absolute);
    hash.update(`${name}\0`);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(absolute);
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("dist contains an external symlink");
      hash.update(`symlink\0${readlinkSync(absolute)}\0`);
    }
    else if (stat.isDirectory()) {
      hash.update(`directory\0${stat.mode & 0o777}\0`);
      for (const entry of readdirSync(absolute).sort()) visit(join(absolute, entry), relative(root, join(absolute, entry)));
    } else if (stat.isFile()) {
      hash.update(`file\0${stat.mode & 0o777}\0`);
      hashFile(absolute, hash);
      hash.update("\0");
    } else hash.update(`other\0${stat.mode}\0${stat.size}\0`);
  };
  try {
    visit(root, ".");
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export function persistReport(path: string, report: CheckReport, temporaryDirectory = dirname(path)): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(temporaryDirectory, `${report.runId}.report.tmp`);
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function initialReport(input: {
  runId: string;
  mode: string[];
  startedAt: string;
  source: SourceIdentity;
  baseBranch: string | null;
  baseSha: string | null;
  env: Record<string, string | undefined>;
  steps: CheckStep[];
  logPaths: string[];
}): CheckReport {
  return {
    schemaVersion: 1,
    runId: input.runId,
    status: "running",
    exitCode: null,
    startedAt: input.startedAt,
    endedAt: null,
    durationMs: null,
    mode: input.mode,
    revision: {
      head: input.source.head,
      testedSha: input.source.head,
      headSha: null,
      headBranch: null,
      baseBranch: input.baseBranch,
      baseSha: input.baseSha,
      branch: input.source.branch,
    },
    toolchain: {
      bunVersion: Bun.version,
      nodeVersion: null,
      herdrVersion: null,
      herdrTestShards: null,
      platform: process.platform,
      arch: process.arch,
      ci: input.env["CI"] === "true",
    },
    source: { start: input.source, end: null, unchanged: null },
    verification: { status: "pending", scope: "source-state-and-step-results", browserCurrentSource: "not-claimed", reason: null },
    currentStep: null,
    steps: input.steps,
    errors: [],
    browserArtifact: {
      path: "dist",
      buildAttempted: false,
      buildThisRun: false,
      identity: null,
      finalIdentity: null,
      unchangedAfterBuild: null,
      provenance: "unknown",
    },
    evidence: { logs: input.logPaths, artifacts: [], retained: [] },
  };
}
