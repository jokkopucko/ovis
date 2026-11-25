import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, root, type Job, type Step } from "./shell-workflow-rules.ts";

const workflow = parseWorkflow(join(root, ".github/workflows/remote-bundles.yml"));
const needsOf = (job: Job): string[] => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);

type Run = { event: string; ref: string; ran: (id: string) => boolean };
const SMOKE_WINDOWS = "!cancelled() && (needs.bundle-linux.outputs.windows != '' || needs.bundle-windows.result == 'success')";
const RELEASE = "!cancelled() && startsWith(github.ref, 'refs/tags/remote-v') && needs.bundle.result == 'success' && needs.smoke-windows.result == 'success' && needs.ssh.result == 'success'";
// What each job condition of the workflow means when every job passes; a condition missing here fails the test.
const CONDITIONS: Record<string, (run: Run) => boolean> = {
  "github.event_name == 'pull_request'": (run) => run.event === "pull_request",
  "github.event_name != 'pull_request'": (run) => run.event !== "pull_request",
  [SMOKE_WINDOWS]: (run) => run.ran("bundle-linux") || run.ran("bundle-windows"),
  [RELEASE]: (run) => run.ref.startsWith("refs/tags/remote-v") && ["bundle", "smoke-windows", "ssh"].every(run.ran),
};

function ran(event: string, ref: string): Record<string, Job> {
  const results = new Map<string, boolean>();
  const settle = (id: string): boolean => {
    if (!results.has(id)) {
      const job = workflow.jobs[id]!;
      const run: Run = { event, ref, ran: settle };
      // without a condition GitHub's implicit success() asks every job before it, however far back, to have passed
      const allBefore = (from: string): boolean => needsOf(workflow.jobs[from]!).every((need) => settle(need) && allBefore(need));
      results.set(id, job.if === undefined ? allBefore(id) : CONDITIONS[job.if]!(run));
    }
    return results.get(id)!;
  };
  return Object.fromEntries(Object.keys(workflow.jobs).filter(settle).map((id) => [id, workflow.jobs[id]!]));
}

const withScripts = (run: string): string => [run, ...[...run.matchAll(/\bscripts\/[\w-]+\.sh\b/g)].map((match) => readFileSync(join(root, match[0]), "utf8"))].join("\n");
const checks = (jobs: Record<string, Job>): string[] => [...new Set(Object.values(jobs).flatMap((job) => (job.steps ?? []).map((step) => withScripts(step.run ?? "")).flatMap((run) => [...run.matchAll(/scripts\/(remote-bundle-smoke|ssh-integration|ssh-password-docker)\.ts|server\/windows-native\.test\.ts/g)].map((match) => match[0]))))].sort();
const smokedOn = (jobs: Record<string, Job>): string[] => Object.entries(jobs).filter(([, job]) => (job.steps ?? []).some((step) => (step.run ?? "").includes("scripts/remote-bundle-smoke.ts"))).map(([, job]) => String(job["runs-on"])).sort();
const sshParts = (job: Job): string[] => (job.steps ?? []).flatMap((step) => [...(step.run ?? "").matchAll(/scripts\/ci-ssh-checks\.sh (\w+)/g)].map((match) => match[1]!));
const at = (steps: Step[], found: (step: Step) => boolean): number => steps.findIndex(found);
const runs = (text: string) => (step: Step): boolean => (step.run ?? "").includes(text);

describe("remote-bundles.yml", () => {
  const EVERY_CHECK = ["scripts/remote-bundle-smoke.ts", "scripts/ssh-integration.ts", "scripts/ssh-password-docker.ts", "server/windows-native.test.ts"];

  it("reads every job condition it has", () => {
    expect(Object.entries(workflow.jobs).filter(([, job]) => job.if !== undefined && CONDITIONS[job.if] === undefined).map(([id, job]) => `${id}: ${job.if}`)).toEqual([]);
  });

  it("runs on a pull request, a remote-v tag and a manual run", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["pull_request", "push", "workflow_dispatch"]);
    expect(workflow.on["push"]).toEqual({ tags: ["remote-v*"] });
  });

  it("runs a pull request's checks on two GitHub-hosted runners: Linux builds both bundles and runs the SSH checks, Windows smokes its bundle", () => {
    const jobs = ran("pull_request", "refs/pull/1/merge");
    expect(Object.keys(jobs).sort()).toEqual(["bundle-linux", "smoke-windows"]);
    expect(checks(jobs)).toEqual(EVERY_CHECK);
    expect(smokedOn(jobs)).toEqual(["ubuntu-24.04", "windows-latest"]);
    expect(sshParts(jobs["bundle-linux"]!)).toEqual(["server", "integration", "password"]);
    expect(sshParts(workflow.jobs["ssh"]!)).toEqual(["server", "integration", "password"]);
  });

  it.each([["workflow_dispatch", "refs/heads/main"], ["push", "refs/tags/remote-v9.9.9"]])("keeps every job of a %s run as it was", (event, ref) => {
    const jobs = ran(event, ref);
    expect(Object.keys(jobs).sort()).toEqual(["bundle", "bundle-windows", ...(event === "push" ? ["release"] : []), "smoke-windows", "ssh"]);
    expect(checks(jobs)).toEqual(EVERY_CHECK);
  });

  it("uploads a pull request's Windows bundle before any Linux check, and smokes it whatever became of them", () => {
    const linux = workflow.jobs["bundle-linux"]!;
    const steps = linux.steps!;
    const upload = at(steps, (step) => step.id === "windows-artifact");
    expect(at(steps, runs("build-remote-bundle.ts win32-x64"))).toBeLessThan(upload);
    for (const later of ["pty-sidecar.ts build", "remote-bundle-smoke.ts", "ci-ssh-checks.sh"]) expect([later, at(steps, runs(later)) > upload]).toEqual([later, true]);
    expect(linux.outputs).toEqual({ windows: "${{ steps.windows-artifact.outputs.artifact-id }}" });
    expect(workflow.jobs["smoke-windows"]!.if).toBe(SMOKE_WINDOWS);
    expect(needsOf(workflow.jobs["smoke-windows"]!).sort()).toEqual(["bundle-linux", "bundle-windows"]);
  });

  it("gives smoke-windows the artifact both builders upload, holding the Windows bundle alone", () => {
    const uploads = (id: string): Step[] => workflow.jobs[id]!.steps!.filter((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"));
    const download = workflow.jobs["smoke-windows"]!.steps!.find((step) => (step.uses ?? "").startsWith("actions/download-artifact@"))!;
    for (const id of ["bundle-linux", "bundle-windows"]) expect([id, uploads(id).map((step) => step.with?.["name"])]).toEqual([id, [download.with?.["name"]]]);
    const linux = workflow.jobs["bundle-linux"]!.steps!;
    const build = linux[at(linux, runs("build-remote-bundle.ts win32-x64"))]!;
    expect(uploads("bundle-linux")[0]!.with?.["path"]).toBe(`${build.env?.["HERDR_BUNDLE_OUTPUT"]}/*`);
    expect(build.env?.["HERDR_BUNDLE_OUTPUT"]).not.toBe("remote-bundles");
  });

  it("runs the Linux bundle and its smoke whatever became of the Windows bundle", () => {
    const linux = workflow.jobs["bundle-linux"]!.steps!;
    const conditions = [linux.find((step) => step.id === "pty-host"), linux.find((step) => step.id === "linux-bundle"), linux.find(runs("remote-bundle-smoke.ts"))].map((step) => step?.if);
    expect(conditions).toEqual(["!cancelled() && steps.common.outcome == 'success'", "!cancelled() && steps.pty-host.outcome == 'success'", "!cancelled() && steps.linux-bundle.outcome == 'success'"]);
  });

  it("runs the pull request's SSH checks on a bundle without the Rust PTY host, as the ssh job's, whatever became of the other checks", () => {
    const linux = workflow.jobs["bundle-linux"]!.steps!;
    const node = linux.find((step) => step.id === "node-bundle")!;
    expect(node.env).toEqual({ HERDR_BUNDLE_PTY_SIDECAR: "" });
    expect(node.run).toBe("bun run scripts/build-remote-bundle.ts");
    expect(node.if).toBe("!cancelled() && steps.common.outcome == 'success'");
    expect(linux.find((step) => step.id === "common")!.run).toBe("bun run typecheck && bun run build");
    for (const step of linux.filter(runs("ci-ssh-checks.sh"))) expect([step.name, step.if]).toEqual([step.name, "!cancelled() && steps.node-bundle.outcome == 'success'"]);
    expect(at(linux, (step) => step.id === "node-bundle")).toBeGreaterThan(at(linux, runs("remote-bundle-smoke.ts")));
    expect(workflow.jobs["ssh"]!.env?.["HERDR_BUNDLE_PTY_SIDECAR"]).toBeUndefined();
  });

  it("publishes a tag's bundles only when every job it needs passed", () => {
    expect(workflow.jobs["release"]!.if).toBe(RELEASE);
    expect(needsOf(workflow.jobs["release"]!).sort()).toEqual(["bundle", "smoke-windows", "ssh"]);
  });

  // GitHub's paths filter: the last pattern a path matches decides, and a pattern starting with ! leaves the path out.
  const triggers = (path: string): boolean => {
    let matched = false;
    for (const pattern of (workflow.on["pull_request"] as { paths: string[] }).paths) {
      const negated = pattern.startsWith("!");
      if (new Bun.Glob(negated ? pattern.slice(1) : pattern).match(path)) matched = !negated;
    }
    return matched;
  };

  it("leaves out a pull request that changes only the server's unit tests or notes, which no bundle carries", () => {
    for (const path of ["server/store.test.ts", "server/relay/service.test.ts", "server/machine-api.contract.test.ts", "shared/protocol.test.ts", "server/AGENTS.md"]) expect([path, triggers(path)]).toEqual([path, false]);
    for (const path of ["server/index.ts", "server/relay/service.ts", "server/machine-profile.test-helpers.ts", "server/fixtures/prompt.txt", "shared/protocol.ts", "server/windows-native.test.ts", "bun.lock", "scripts/ci-ssh-checks.sh", ".github/workflows/remote-bundles.yml"]) expect([path, triggers(path)]).toEqual([path, true]);
  });
});

describe("scripts/ci-ssh-checks.sh", () => {
  it("refuses a part it does not know", () => {
    const result = Bun.spawnSync(["bash", join(root, "scripts/ci-ssh-checks.sh"), "nope"], { stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("usage:");
  });
});
