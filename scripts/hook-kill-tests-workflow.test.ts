import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, root, type Job } from "./shell-workflow-rules.ts";

// hook-kill-tests.yml runs job-started.sh's refusals and its signal (the isolated tests of
// scripts/self-hosted-runner.test.ts) in a throwaway container on GitHub's hosted runner. Nothing may move it onto the
// self-hosted runners, give it more than a read token, leave a pull request without its run, or rename its check;
// its container stays confined, and shows it before any test starts.
const file = join(root, ".github/workflows/hook-kill-tests.yml");
const workflow = parseWorkflow(file);
const job = workflow.jobs["hook-kill-tests"]! as Job & { name?: string };
const container = readFileSync(join(root, "scripts/self-hosted-runner/hook-test-container.sh"), "utf8");
const dockerfile = readFileSync(join(root, "scripts/self-hosted-runner/hook-test.Dockerfile"), "utf8");
const CONTAINER_RESULT_CHECK = String.raw`out="$RUNNER_TEMP/hook-test-out"
status=$(cat "$out/status" 2>/dev/null || echo missing)
if [ "$status" != 0 ]; then echo "::error::the container's command did not end with status 0 (status: $status)"; exit 1; fi
counts=$( { grep -E '^ *[0-9]+ (pass|skip|fail|todo)$' "$out/log.txt" || true; } | sed -E 's/^ +//' | LC_ALL=C sort | tr '\n' ';')
if [ "$counts" != "0 fail;8 pass;" ]; then echo "::error::the tests' summary is '$counts', not '0 fail;8 pass;'"; exit 1; fi
if grep -q 'kill tests skipped' "$out/log.txt"; then echo "::error::the kill tests were skipped"; exit 1; fi
echo "the container's own result: status 0, 0 fail;8 pass;"
`;
const setupCi = Bun.YAML.parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8")) as { inputs: Record<string, { default?: string }> };

describe("hook kill tests workflow", () => {
  test("keeps the check's name, which branch protection matches", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["hook-kill-tests"]);
    expect(job.name).toBe("Hook kill tests (container)");
  });

  test("runs on a hosted runner written literally, with only a read token and no secret", () => {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job.environment).toBeUndefined();
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    expect(readFileSync(file, "utf8")).not.toMatch(/\bsecrets\./);
  });

  test("runs on every pull request, drafts included, and every push to main: no path filter and no condition", () => {
    const on = workflow.on as Record<string, Record<string, string[]>>;
    expect(Object.keys(on).sort()).toEqual(["pull_request", "push"]);
    expect(on["pull_request"]).toEqual({ types: ["opened", "synchronize", "reopened", "ready_for_review"] });
    expect(on["push"]).toEqual({ branches: ["main"] });
    expect(job.if).toBeUndefined();
    for (const step of job.steps ?? []) expect(step.if, `${step.name ?? step.uses}: a step that can be skipped`).toBeUndefined();
  });

  test("cancels a pull request's superseded run and never a push run of main", () => {
    expect(workflow.concurrency).toEqual({
      group: "hook-kill-tests-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
  });

  test("cannot go green on a failure or wait on another job", () => {
    const failSoft = (owner: object) => (owner as Record<string, unknown>)["continue-on-error"];
    expect(failSoft(job)).toBeUndefined();
    for (const step of job.steps ?? []) expect(failSoft(step), `${step.name ?? step.uses}: continue-on-error`).toBeUndefined();
    expect(job.needs).toBeUndefined();
  });

  test("ends with a check of the files the container wrote, independent of the container script", () => {
    const last = job.steps!.at(-1)!;
    expect(last.name).toBe("Check the container's own result");
    expect(last.run).toBe(CONTAINER_RESULT_CHECK);
  });

  test("starts its one container confined: no network, capability, privilege, host pid namespace or socket", () => {
    const run = job.steps!.map((step) => step.run ?? "").join("\n");
    expect(run).toContain("bash scripts/self-hosted-runner/hook-test-container.sh ovis-hook-test:ci");
    const line = /docker run -d [^']*/.exec(container)![0].replace(/\\\n\s*/g, " ");
    for (const flag of ["--rm", "--init", "--name \"$name\"", "--user hooktest", "--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 2048", "-v \"$src:/src:ro\""]) {
      expect(line).toContain(flag);
    }
    for (const forbidden of [/--privileged/, /--pid[ =]/, /--cap-add/, /docker\.sock/, /--network[ =]host/, /--userns/]) expect(line).not.toMatch(forbidden);
  });

  test("checks the container's proofs before any test starts, and fails on any skip", () => {
    const go = container.indexOf('touch "$out/go"');
    for (const proof of [
      'if [ "$cfg" != "Privileged=false CapDrop=[ALL] CapAdd=[] NetworkMode=none PidMode= SecurityOpt=[no-new-privileges]" ]',
      'if [ "$mounts" != "$want" ]',
      "grep -qx 'init=docker-init'",
      "[ \"$box_ns\" != 'pid:[4026531836]' ]",
      '[ "$box_ns" != "$host_ns" ]',
      "grep -q '^docker.sock: .*No such file or directory'",
      "for cap in CapPrm CapEff CapBnd",
      "grep -Eq '^net: lo ?$'",
      "grep -Eq ' /src [^ ]+ ro[ ,]'",
    ]) {
      const at = container.indexOf(proof);
      expect(at, proof).toBeGreaterThan(-1);
      expect(at, `${proof} comes after the go file`).toBeLessThan(go);
    }
    expect(container).toContain('expected="0 fail;8 pass;"');
    expect(container).toContain("if grep -q 'kill tests skipped' \"$out/log.txt\"; then");
  });

  test("builds an image of its own, from a base pinned by digest, at the Bun version CI sets, with the marker the harness guards on", () => {
    expect(dockerfile).toMatch(/^FROM oven\/bun:([\d.]+)-debian@sha256:[0-9a-f]{64}$/m);
    expect(/^FROM oven\/bun:([\d.]+)-/m.exec(dockerfile)![1]).toBe(setupCi.inputs["bun-version"]!.default);
    expect(dockerfile).toContain(">/opt/runner-hooks/ovis-runner-image");
    expect(dockerfile).toContain("chmod 0444 /opt/runner-hooks/ovis-runner-image");
    expect(dockerfile).toMatch(/^USER hooktest$/m);
    // the runner image itself never carries the marker: its containers never run these tests
    expect(readFileSync(join(root, "scripts/self-hosted-runner/Dockerfile"), "utf8")).not.toContain("ovis-runner-image");
  });
});
