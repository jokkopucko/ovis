import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  artifactIdentity,
  artifactUnchangedAfterBuild,
  baseRevision,
  initialReport,
  persistReport,
  revisionDetails,
  reportExitCode,
  reportPaths,
  sourceIdentity,
  verificationResult,
  type CheckStep,
} from "./check-report.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "check-report-test-"));
const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
};

describe("check report", () => {
  it("detects tracked edits and hashes untracked nonignored file contents", () => {
    const dir = scratch();
    try {
      git(dir, "init", "-q");
      git(dir, "config", "user.name", "check test");
      git(dir, "config", "user.email", "check@example.invalid");
      writeFileSync(join(dir, "tracked.txt"), "baseline\n");
      git(dir, "add", "tracked.txt");
      git(dir, "commit", "-qm", "baseline");

      const clean = sourceIdentity(dir);
      const reportPath = join(dir, "check-output", "report.json");
      const logPath = join(dir, "check-output", "logs", "step.log");
      mkdirSync(join(dir, "check-output", "logs"), { recursive: true });
      writeFileSync(reportPath, "report");
      writeFileSync(logPath, "output");
      expect(sourceIdentity(dir, [reportPath, join(dir, "check-output", "logs")]).fingerprint).toBe(clean.fingerprint);
      rmSync(join(dir, "check-output"), { recursive: true, force: true });

      writeFileSync(join(dir, "tracked.txt"), "edited\n");
      const changedTracked = sourceIdentity(dir);
      expect(changedTracked.trackedDiffSha256).not.toBe(clean.trackedDiffSha256);
      expect(changedTracked.fingerprint).not.toBe(clean.fingerprint);

      writeFileSync(join(dir, "notes.txt"), "first\n");
      const firstUntracked = sourceIdentity(dir);
      writeFileSync(join(dir, "notes.txt"), "second\n");
      const changedUntracked = sourceIdentity(dir);
      expect(firstUntracked.untrackedFiles.map((file) => file.path)).toContain("notes.txt");
      expect(changedUntracked.untrackedFiles[0]?.sha256).not.toBe(firstUntracked.untrackedFiles[0]?.sha256);
      expect(changedUntracked.fingerprint).not.toBe(firstUntracked.fingerprint);
      const priorMode = statSync(join(dir, "notes.txt")).mode & 0o777;
      chmodSync(join(dir, "notes.txt"), 0o755);
      const changedMode = sourceIdentity(dir);
      if ((statSync(join(dir, "notes.txt")).mode & 0o777) !== priorMode) {
        expect(changedMode.untrackedFiles[0]?.sha256).not.toBe(changedUntracked.untrackedFiles[0]?.sha256);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("chooses the documented durable report locations", () => {
    const cwd = "/repo";
    expect(reportPaths(cwd, {}, "run-id").reportPath).toBe("/repo/node_modules/.cache/check/run-id/report.json");
    expect(reportPaths(cwd, { CHECK_DIR: ".check" }, "run-id").reportPath).toBe("/repo/.check/report.json");
    expect(reportPaths(cwd, { CHECK_REPORT: "artifacts/check.json" }, "run-id").reportPath).toBe("/repo/artifacts/check.json");
  });

  it("hashes all dist assets, not just the entry document", () => {
    const dir = scratch();
    try {
      const dist = join(dir, "dist");
      const assets = join(dist, "assets");
      mkdirSync(assets, { recursive: true });
      writeFileSync(join(dist, "index.html"), "<script src='/assets/app.js'></script>");
      writeFileSync(join(assets, "app.js"), "one");
      const first = artifactIdentity(dist);
      writeFileSync(join(assets, "app.js"), "two");
      expect(artifactIdentity(dist)).not.toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps base branch names separate from an available base commit SHA", () => {
    const dir = scratch();
    try {
      const eventPath = join(dir, "event.json");
      writeFileSync(eventPath, JSON.stringify({ pull_request: { base: { sha: "a".repeat(40) } } }));
      expect(baseRevision(dir, { GITHUB_BASE_REF: "main", GITHUB_EVENT_PATH: eventPath })).toEqual({ branch: "main", sha: "a".repeat(40) });
      expect(baseRevision(dir, { GITHUB_BASE_REF: "main" })).toEqual({ branch: "main", sha: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes a PR head from the merge commit that CI actually tests", () => {
    const dir = scratch();
    try {
      const testedSha = "c".repeat(40);
      const headSha = "a".repeat(40);
      const baseSha = "b".repeat(40);
      const eventPath = join(dir, "event.json");
      writeFileSync(eventPath, JSON.stringify({
        pull_request: {
          head: { sha: headSha, ref: "feature/report-evidence" },
          base: { sha: baseSha },
        },
      }));
      expect(revisionDetails(dir, {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_BASE_REF: "main",
      }, { head: testedSha, branch: null })).toEqual({
        head: testedSha,
        testedSha,
        headSha,
        headBranch: "feature/report-evidence",
        baseBranch: "main",
        baseSha,
        branch: null,
      });

      writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: "merge-sha", ref: "feature/report-evidence" } } }));
      expect(revisionDetails(dir, {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
      }, { head: testedSha, branch: "merge-branch" })).toMatchObject({
        testedSha,
        headSha: null,
        headBranch: null,
      });
      expect(revisionDetails(dir, {}, { head: testedSha, branch: "local-branch" })).toMatchObject({
        headSha: testedSha,
        headBranch: "local-branch",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not claim verification when source identity is unavailable and fails on report persistence errors", () => {
    expect(verificationResult(null, "success")).toMatchObject({ status: "unknown", browserCurrentSource: "not-claimed" });
    expect(verificationResult(false, "success").status).toBe("invalidated");
    expect(verificationResult(true, "success")).toMatchObject({ status: "verified", scope: "source-state-and-step-results", browserCurrentSource: "not-claimed" });
    expect(verificationResult(true, "interrupted").status).toBe("unknown");
    expect(verificationResult(true, "success", false)).toMatchObject({ status: "invalidated", reason: expect.stringContaining("dist changed") });
    expect(artifactUnchangedAfterBuild("built", "built")).toBe(true);
    expect(artifactUnchangedAfterBuild("built", "mutated")).toBe(false);
    expect(artifactUnchangedAfterBuild(null, "unknown")).toBeNull();
    expect(reportExitCode(0, true)).toBe(1);
    expect(reportExitCode(7, true)).toBe(7);
    expect(reportExitCode(0, false, false)).toBe(1);
    expect(reportExitCode(0, false, true, false)).toBe(1);
    expect(reportExitCode(0, false, null)).toBe(1);
    expect(reportExitCode(0, false, true, null, true)).toBe(1);
    expect(reportExitCode(0, false, true, null, false)).toBe(0);
    expect(reportExitCode(0, false, true, true, true)).toBe(0);
    expect(reportExitCode(7, false, null, null, true)).toBe(7);
    expect(verificationResult(true, "success", null, true)).toMatchObject({ status: "unknown", reason: expect.stringContaining("dist identity") });
    expect(verificationResult(true, "success", null, false).status).toBe("verified");
  });

  it("persists a running report with failure, skipped, not-run and interrupted step states without environment secrets", () => {
    const dir = scratch();
    try {
      const log = join(dir, "step.log");
      const steps: CheckStep[] = ["failure", "skipped", "not-run", "interrupted"].map((status) => ({
        name: status,
        command: null,
        cwd: dir,
        status: status as CheckStep["status"],
        exitCode: status === "failure" ? 1 : null,
        signal: status === "interrupted" ? "SIGINT" : null,
        durationMs: null,
        startedAt: null,
        endedAt: null,
        stdout: log,
        stderr: log,
        reason: null,
      }));
      const report = initialReport({
        runId: "run-id",
        mode: ["run"],
        startedAt: "2026-10-10T00:00:00.000Z",
        source: {
          head: "abc",
          branch: "main",
          trackedDiffSha256: "diff",
          untrackedFiles: [],
          untrackedFileCount: 0,
          untrackedContentSha256: "empty",
          untrackedFilesTruncated: false,
          fingerprint: "source",
          reason: null,
        },
        baseBranch: "main",
        baseSha: null,
        env: { CI: "true", API_TOKEN: "must-not-be-serialized" },
        steps,
        logPaths: [log],
      });
      const reportDirectory = join(dir, "private");
      const path = join(reportDirectory, "report.json");
      persistReport(path, report);
      const initial = JSON.parse(readFileSync(path, "utf8"));
      if (process.platform !== "win32") {
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(reportDirectory).mode & 0o777).toBe(0o700);
      }
      expect(initial.status).toBe("running");
      expect(initial.steps.map((step: CheckStep) => step.status)).toEqual(["failure", "skipped", "not-run", "interrupted"]);
      expect(initial.evidence.logs).toEqual([log]);
      expect(initial.evidence.retained).toEqual([]);
      expect(initial.revision).toMatchObject({ baseBranch: "main", baseSha: null });
      expect(initial.verification).toMatchObject({ status: "pending", browserCurrentSource: "not-claimed" });
      expect(initial.browserArtifact).toMatchObject({
        buildAttempted: false,
        buildThisRun: false,
        identity: null,
        finalIdentity: null,
        unchangedAfterBuild: null,
        provenance: "unknown",
      });
      expect(readFileSync(path, "utf8")).not.toContain("must-not-be-serialized");

      const kept = join(dir, "hwc-kept");
      report.status = "failure";
      report.exitCode = 1;
      report.errors.push("teardown: could not stop herdr session fx-1");
      report.evidence.retained.push(kept);
      report.verification = verificationResult(true, report.status);
      persistReport(path, report);
      const failed = JSON.parse(readFileSync(path, "utf8"));
      expect(failed).toMatchObject({ status: "failure", exitCode: 1, evidence: { retained: [kept] }, verification: { status: "unknown" } });
      expect(failed.errors).toEqual(["teardown: could not stop herdr session fx-1"]);
      report.status = "interrupted";
      report.exitCode = 130;
      persistReport(path, report);
      expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("interrupted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
