import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_JOBS, matrixJobs } from "./release-ci-reuse.ts";
import { DEPLOY_ACTIONS, type Job, parseWorkflow, root, runScript, scriptProblems, type Step, stepList } from "./shell-workflow-rules.ts";

// A Release run tags a commit only after release-validate.yml names what validated it: ci.yml run
// there, or main's own push run that scripts/release-ci-reuse.ts verified, with Fast checks run
// again on GitHub's runner. These tests hold the shape that makes a skipped, failed or cancelled job
// stop a release instead of passing it, and run the two scripts that decide.
type CallJob = Job & { name?: string; with?: Record<string, string>; "continue-on-error"?: boolean };
interface Input { description?: string; required?: boolean; default?: unknown; type?: string }
const wrapper = parseWorkflow(join(root, ".github/workflows/release-validate.yml"));
const release = parseWorkflow(join(root, ".github/workflows/release.yml"));
const ciYml = parseWorkflow(join(root, ".github/workflows/ci.yml"));
const job = (workflow: typeof wrapper, name: string): CallJob => workflow.jobs[name]! as CallJob;
const step = (from: Job, predicate: (candidate: Step) => boolean): Step => from.steps!.find(predicate)!;
const reuse = job(wrapper, "reuse");
const fast = job(wrapper, "fast");
const ci = job(wrapper, "ci");
const verdict = job(wrapper, "verdict");
const publish = job(release, "publish");
const REVALIDATE: Input = { required: false, default: false, type: "boolean" };
const READS = { contents: "read", actions: "read" };
const STATUS_FUNCTION = /\b(?:always|cancelled|failure|success)\s*\(/;
/** The jobs and steps of `workflow` that carry `continue-on-error`, whatever its value. */
const carrying = (workflow: typeof wrapper): string[] => Object.entries(workflow.jobs).flatMap(([id, candidate]) => [
  ...("continue-on-error" in candidate ? [id] : []),
  ...(candidate.steps ?? []).flatMap((entry, index) => ("continue-on-error" in entry ? [`${id}.steps[${index}]`] : [])),
]);

const scratch = mkdtempSync(join(tmpdir(), "release-validate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
/** Runs a step's script with `env` and returns its exit code, its log and what it wrote to $GITHUB_OUTPUT. */
async function runStep(script: string, env: Record<string, string>): Promise<{ code: number; log: string; output: string }> {
  const output = join(scratch, `output-${files++}`);
  const result = await runScript(script, scratch, { ...env, GITHUB_OUTPUT: output });
  return { code: result.code, log: result.output, output: existsSync(output) ? readFileSync(output, "utf8") : "" };
}

describe("release-validate.yml", () => {
  test("is called by release.yml and can be run by hand, with the same switch back to the whole CI", () => {
    expect(Object.keys(wrapper.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    const call = wrapper.on["workflow_call"] as { inputs: Record<string, Input>; outputs: Record<string, { value: string }> };
    const dispatch = wrapper.on["workflow_dispatch"] as { inputs: Record<string, Input> };
    expect(Object.keys(call.inputs)).toEqual(["revalidate"]);
    expect(Object.keys(dispatch.inputs)).toEqual(["revalidate"]);
    expect(call.inputs["revalidate"]).toMatchObject(REVALIDATE);
    expect(dispatch.inputs["revalidate"]).toMatchObject(REVALIDATE);
    expect(Object.keys(call.outputs)).toEqual(["validated_by"]);
    expect(call.outputs["validated_by"]!.value).toBe("${{ jobs.verdict.outputs.validated_by }}");
  });

  test("has four jobs, and gives a token only what reading main's run and running ci.yml need", () => {
    expect(Object.keys(wrapper.jobs)).toEqual(["reuse", "fast", "ci", "verdict"]);
    expect(wrapper.permissions).toEqual({ contents: "read" });
    expect(reuse.permissions).toEqual(READS);
    // the workflow's own: what ci.yml gives its Fast checks
    expect(fast.permissions).toBeUndefined();
    expect(ci.permissions).toEqual(READS);
    expect(verdict.permissions).toEqual({});
    expect(JSON.stringify(wrapper)).not.toContain("secrets.");
  });

  test("lets only the reuse job fail without failing the run", () => {
    // on any other job or step, a failure there would no longer fail validate or publish
    expect(carrying(wrapper)).toEqual(["reuse"]);
    expect(reuse["continue-on-error"]).toBe(true);
    expect(carrying(release)).toEqual([]);
  });

  test("asks about main's run on a GitHub-hosted runner, where waiting holds no runner main's run needs", () => {
    expect(reuse["runs-on"]).toBe("ubuntu-24.04");
    expect(reuse.needs).toBeUndefined();
    expect(reuse.if).toBeUndefined();
    // a reuse job that fails gives no answer, and no answer runs ci.yml
    expect(reuse["continue-on-error"]).toBe(true);
    expect(reuse.outputs).toEqual({ green: "${{ steps.decide.outputs.green }}", run: "${{ steps.decide.outputs.run }}" });
    expect(stepList(reuse)).toEqual(["actions/checkout", "oven-sh/setup-bun", "Ask whether main's CI already passed this commit"]);
    expect(reuse.steps![0]!.with).toEqual({ ref: "${{ github.sha }}", "persist-credentials": false } as unknown as Record<string, string>);
    const setupCi = Bun.YAML.parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8")) as { inputs: Record<string, { default: string }> };
    expect(reuse.steps![1]!.uses).toBe(DEPLOY_ACTIONS[0]!);
    expect(reuse.steps![1]!.with).toEqual({ "bun-version": setupCi.inputs["bun-version"]!.default, "no-cache": true } as unknown as Record<string, string>);
    const decide = reuse.steps![2]!;
    expect(decide.id).toBe("decide");
    expect(decide.if).toBeUndefined();
    expect(decide.env).toEqual({ GH_TOKEN: "${{ github.token }}", REVALIDATE: "${{ inputs.revalidate }}", RELEASE_CI_WAIT_SECONDS: "2400" });
    expect(decide.run).toContain("$(bun scripts/release-ci-reuse.ts)");
  });

  test("gives the script time to answer before the job is cancelled", () => {
    const wait = Number(step(reuse, (candidate) => candidate.id === "decide").env!["RELEASE_CI_WAIT_SECONDS"]);
    expect(wait).toBeGreaterThan(0);
    expect(reuse["timeout-minutes"]).toBe(45);
    // checkout, Bun and a last look at GitHub after the wait
    expect(reuse["timeout-minutes"]! * 60).toBeGreaterThanOrEqual(wait + 240);
  });

  test("runs Fast checks itself, on GitHub's runner, exactly when ci.yml is skipped for main's run", () => {
    expect(fast.name).toBe("Fast checks (GitHub-hosted)");
    expect(fast.needs).toBe("reuse");
    // ci's condition below, turned around: neither runs in a cancelled run, one of the two in any other
    expect(fast.if).toBe("${{ !cancelled() && !inputs.revalidate && needs.reuse.result == 'success' && needs.reuse.outputs.green == 'true' }}");
    // never a runner variable: the self-hosted runner skips the tests this job is here for
    expect(fast["runs-on"]).toBe("ubuntu-24.04");
    expect(fast.outputs).toBeUndefined();
  });

  test("its Fast checks is ci.yml's, step for step", () => {
    const theirs = job(ciYml, "fast");
    const UPDATE = "release-validate.yml's `fast` job is ci.yml's Fast checks, which a release that takes main's run runs again on GitHub's runner: make the same change to both, so such a release still checks what every other does";
    const uploads = (candidate: Step): boolean => candidate.uses?.startsWith("actions/upload-artifact@") === true;
    /** All of a job but where it runs and when, its artifact's name left out. */
    const checks = ({ name: _name, needs: _needs, if: _if, "runs-on": _runner, ...rest }: CallJob): object =>
      ({ ...rest, steps: rest.steps!.map((candidate) => (uploads(candidate) ? { ...candidate, with: { ...candidate.with, name: "" } } : candidate)) });
    expect(checks(fast), UPDATE).toEqual(checks(theirs));
    expect(fast["timeout-minutes"], UPDATE).toBe(theirs["timeout-minutes"]!);
    expect(fast.env, UPDATE).toEqual(theirs.env!);
    expect(stepList(fast)).toEqual(["actions/checkout", "./.github/actions/setup-ci", "bun install --frozen-lockfile", "bun run check fast", "Release guards", "Preserve check report and verification logs"]);
    // what a copy cannot follow: a step that reads the jobs ci.yml's own needs, or an environment set for all of ci.yml
    expect(JSON.stringify(checks(theirs)), UPDATE).not.toMatch(/\b(?:needs|matrix|strategy)\./);
    expect([ciYml.env, (ciYml as { defaults?: unknown }).defaults], UPDATE).toEqual([wrapper.env, (wrapper as { defaults?: unknown }).defaults]);
    // one artifact, under a name no job of ci.yml uploads
    const names = (candidate: Job): string[] => (candidate.steps ?? []).filter(uploads).map((upload) => upload.with!["name"]!);
    expect(names(theirs)).toEqual(["check-fast-${{ github.run_id }}-${{ github.run_attempt }}"]);
    expect(names(fast)).toEqual(["check-fast-hosted-${{ github.run_id }}-${{ github.run_attempt }}"]);
    expect(Object.values(ciYml.jobs).flatMap(names)).not.toContain(names(fast)[0]!);
  });

  test("runs ci.yml unless the reuse job succeeded and said yes, and always with revalidate", () => {
    expect(ci.needs).toBe("reuse");
    expect(ci.if).toBe("${{ !cancelled() && (inputs.revalidate || needs.reuse.result != 'success' || needs.reuse.outputs.green != 'true') }}");
    expect(ci.uses).toBe("./.github/workflows/ci.yml");
    expect(ci.with).toBeUndefined();
  });

  test("ends in a verdict that runs whatever happened before it", () => {
    expect(verdict.needs).toEqual(["reuse", "fast", "ci"]);
    expect(verdict.if).toBe("${{ always() }}");
    expect(verdict["runs-on"]).toBe("ubuntu-24.04");
    expect(verdict["timeout-minutes"]).toBeGreaterThan(0);
    expect(verdict.outputs).toEqual({ validated_by: "${{ steps.verdict.outputs.validated_by }}" });
    expect(verdict.steps).toHaveLength(1);
    expect(verdict.steps![0]!.id).toBe("verdict");
    expect(verdict.steps![0]!.if).toBeUndefined();
    expect(verdict.steps![0]!.env).toEqual({
      CI_RESULT: "${{ needs.ci.result }}", FAST_RESULT: "${{ needs.fast.result }}", REUSE_RESULT: "${{ needs.reuse.result }}",
      REUSE_GREEN: "${{ needs.reuse.outputs.green }}", REUSE_RUN: "${{ needs.reuse.outputs.run }}", REVALIDATE: "${{ inputs.revalidate }}",
    });
  });

  test("no script interpolates an expression or writes $GITHUB_ENV or $GITHUB_PATH", () => {
    expect(scriptProblems(wrapper)).toEqual([]);
    for (const candidate of Object.values(wrapper.jobs)) {
      for (const { run } of candidate.steps ?? []) expect(run ?? "").not.toContain("${{");
    }
  });
});

describe("release.yml", () => {
  /** Every job that runs after `name`: the jobs that need it, and the jobs that need those. */
  const after = (name: string): string[] => {
    const found = new Set<string>();
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, candidate] of Object.entries(release.jobs)) {
        if (!found.has(id) && [candidate.needs ?? []].flat().some((need) => need === name || found.has(need))) {
          found.add(id);
          grew = true;
        }
      }
    }
    return [...found];
  };

  test("validates through release-validate.yml, with a revalidate input that runs the whole CI", () => {
    const validate = job(release, "validate");
    expect(validate.uses).toBe("./.github/workflows/release-validate.yml");
    expect(validate.needs).toBe("preflight");
    expect(validate.if).toBeUndefined();
    expect(validate.with).toEqual({ revalidate: "${{ inputs.revalidate }}" });
    expect(validate.permissions).toEqual(READS);
    expect((release.on["workflow_dispatch"] as { inputs: Record<string, Input> }).inputs["revalidate"]).toMatchObject(REVALIDATE);
    // ci.yml runs for a release only where the verdict can see its result
    expect(Object.entries(release.jobs).filter(([, candidate]) => candidate.uses?.endsWith("/ci.yml")).map(([id]) => id)).toEqual([]);
  });

  test("publishes only after validate and the PTY host, and first requires the verdict's name", () => {
    expect(publish.needs).toEqual(["validate", "pty-sidecar"]);
    expect(publish.if).toBeUndefined();
    expect(release.jobs["pty-sidecar"]!.if).toBeUndefined();
    const guard = publish.steps![0]!;
    expect(guard.name).toBe("Require a validated commit");
    expect(guard.if).toBeUndefined();
    expect(guard.uses).toBeUndefined();
    expect(guard.env).toEqual({ VALIDATED_BY: "${{ needs.validate.outputs.validated_by }}" });
    expect(stepList(publish).indexOf("Publish the validated commit")).toBeGreaterThan(0);
    expect(publish.steps!.filter((candidate) => candidate.run?.includes("gh release create")).map((candidate) => candidate.name)).toEqual(["Publish the validated commit"]);
    expect(publish.steps!.every((candidate) => candidate.if === undefined)).toBe(true);
  });

  test("gives a token that can tag only to publish and the jobs after it", () => {
    /** What `candidate`'s token may write: by its own permissions, else by the workflow's. */
    const writes = (candidate: Job, workflow: Pick<typeof release, "permissions"> = release): string[] => {
      const granted: unknown = candidate.permissions ?? workflow.permissions;
      if (granted === "read-all") return [];
      // write-all, or no permissions anywhere, which is the repository's default and may write
      if (typeof granted !== "object" || granted === null) return [String(granted)];
      return Object.entries(granted).filter(([, access]) => access !== "read" && access !== "none").map(([scope]) => scope);
    };
    expect(release.permissions).toEqual({ contents: "read" });
    const published = ["publish", ...after("publish")];
    const before = Object.entries(release.jobs).filter(([id]) => !published.includes(id)).map(([id, candidate]) => [id, writes(candidate)] as const);
    // pty-sidecar runs beside validate, before the verdict: its two scopes sign the binaries' build
    // provenance (pty-sidecar.yml's attest job) and can create neither a tag nor a release, which
    // take contents: write
    expect(before).toEqual([["preflight", []], ["validate", []], ["pty-sidecar", ["id-token", "attestations"]]]);
    expect(release.jobs["pty-sidecar"]!.permissions).toEqual({ contents: "read", "id-token": "write", attestations: "write" });
    expect(writes(publish)).toEqual(["contents"]);
    // the rule itself
    expect(writes({ permissions: { contents: "write", actions: "read", packages: "none" } })).toEqual(["contents"]);
    expect(writes({}, { permissions: { contents: "write" } })).toEqual(["contents"]);
    expect(writes({ permissions: {} }, { permissions: { contents: "write" } })).toEqual([]);
    expect(writes({}, {})).toEqual(["undefined"]);
    expect([writes({ permissions: "write-all" as unknown as Record<string, string> }), writes({ permissions: "read-all" as unknown as Record<string, string> })]).toEqual([["write-all"], []]);
  });

  test("publish and every job after it run on success alone: none carries a status function", () => {
    const later = after("publish");
    expect(later.sort()).toEqual(["desktop", "mac-dmg", "shell-attach", "shell-build", "shell-deploy", "windows-app"]);
    // with one, a job would run although publish was skipped or had refused
    expect(["publish", ...later].filter((id) => STATUS_FUNCTION.test(release.jobs[id]!.if ?? ""))).toEqual([]);
    expect(STATUS_FUNCTION.test("always() && x")).toBe(true);
    expect(STATUS_FUNCTION.test("${{ !cancelled() }}")).toBe(true);
    expect(STATUS_FUNCTION.test("github.repository == 'devswha/ovis' && github.ref == 'refs/heads/main'")).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("the reuse job's answer", () => {
  const decide = step(reuse, (candidate) => candidate.id === "decide").run!;
  const NO = "green=false\nrun=\n";
  /** Runs the decide step with a `bun` that prints `stdout` and exits with `exit`. */
  async function answer(stdout: string, exit = 0): Promise<{ code: number; output: string; called: string }> {
    const bin = mkdtempSync(join(scratch, "bin-"));
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$FAKE_CALLED\"\nprintf '%s' \"$FAKE_STDOUT\"\nexit \"$FAKE_EXIT\"\n", { mode: 0o755 });
    const called = join(bin, "called");
    const result = await runStep(decide, { PATH: `${bin}:/usr/bin:/bin`, FAKE_STDOUT: stdout, FAKE_EXIT: String(exit), FAKE_CALLED: called });
    return { code: result.code, output: result.output, called: existsSync(called) ? readFileSync(called, "utf8") : "" };
  }

  test("passes on a yes with its run id, as the script printed it", async () => {
    expect(await answer("green=true\nrun=42426987381\n")).toEqual({ code: 0, output: "green=true\nrun=42426987381\n", called: "scripts/release-ci-reuse.ts\n" });
    expect((await answer("green=true\nrun=7")).output).toBe("green=true\nrun=7\n");
  });

  test("writes a no for a no, a crash, half an answer or anything else", async () => {
    for (const [stdout, exit] of [
      ["green=false\nrun=\n", 0], ["green=false\nrun=42426987381\n", 0], ["", 0], ["", 1], ["", 127],
      // a yes from a script that then failed
      ["green=true\nrun=42426987381\n", 1], ["green=true\nrun=42426987381\n", 139],
      ["green=true\n", 0], ["green=true\nrun=\n", 0], ["run=42426987381\n", 0], ["run=42426987381\ngreen=true\n", 0],
      ["green=true\nrun=0\n", 0], ["green=true\nrun=042\n", 0], ["green=true\nrun=42a\n", 0], ["green=true\nrun=-1\n", 0], ["green=true\nrun=4 2\n", 0],
      ["green=True\nrun=42\n", 0], ["green=true \nrun=42\n", 0], [" green=true\nrun=42\n", 0], ["green=true\r\nrun=42\r\n", 0],
      // more than the two lines: another output, or a delimiter that would swallow what follows
      ["green=true\nrun=42\nvalidated_by=ci\n", 0], ["x=1\ngreen=true\nrun=42\n", 0], ["green=true\nrun=42\n\ngreen=true\n", 0], ["green<<EOF\ntrue\nEOF\nrun=42\n", 0],
      ["green=true\nrun=42\ngreen=false\n", 0],
    ] as const) {
      const result = await answer(stdout, exit);
      expect([stdout, exit, result.code, result.output]).toEqual([stdout, exit, 0, NO]);
    }
  }, 60_000);

  test("writes a no when bun or the script is not there to ask", async () => {
    // no bun on this path, or the system's own with no script under the step's directory
    const result = await runStep(decide, { PATH: "/usr/bin:/bin" });
    expect([result.code, result.output]).toEqual([0, NO]);
  });

  /** Runs the decide step from the repository, with the real script and a local server in GitHub's place. */
  async function ask(respond: (url: URL) => Response): Promise<{ code: number; output: string; log: string; paths: string[] }> {
    const paths: string[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => { const url = new URL(request.url); paths.push(url.pathname); return respond(url); } });
    try {
      const output = join(scratch, `output-${files++}`);
      const result = await runScript(decide, root, {
        HOME: scratch, RUNNER_TEMP: scratch, GITHUB_OUTPUT: output, GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
        GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GH_TOKEN: "t0ken", REVALIDATE: "false", RELEASE_CI_WAIT_SECONDS: "0",
      });
      return { code: result.code, output: existsSync(output) ? readFileSync(output, "utf8") : "", log: result.output, paths };
    } finally {
      await server.stop(true);
    }
  }
  const REPO = "devswha/ovis";
  const SHA = "c99017754cb330143589afb2f74473828b86615e";
  const RUN = 42426987381;
  const listed = (conclusion: string) => ({
    total_count: 1,
    workflow_runs: [{ id: RUN, path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: SHA, status: "completed", conclusion, run_attempt: 1, repository: { full_name: REPO }, head_repository: { full_name: REPO } }],
  });
  const names = [...CI_JOBS, ...matrixJobs(1)];
  const passed = { total_count: names.length, jobs: names.map((name) => ({ name, run_id: RUN, run_attempt: 1, head_sha: SHA, status: "completed", conclusion: "success" })) };

  test("with the script itself: a green run of main is a yes, a failed one and a GitHub that fails are a no", async () => {
    const green = await ask((url) => Response.json(url.pathname.endsWith("/jobs") ? passed : listed("success")));
    expect([green.code, green.output]).toEqual([0, `green=true\nrun=${RUN}\n`]);
    expect(green.paths).toEqual([`/repos/${REPO}/actions/workflows/ci.yml/runs`, `/repos/${REPO}/actions/runs/${RUN}/jobs`]);
    expect(green.log).toContain(`::notice title=Release validation::main's CI run ${RUN} passed this commit`);

    const red = await ask((url) => Response.json(url.pathname.endsWith("/jobs") ? passed : listed("failure")));
    expect([red.code, red.output]).toEqual([0, NO]);
    expect(red.log).toContain(`::warning title=Release validation::Running CI in this run: main's run ${RUN} ended "failure".`);

    const down = await ask(() => new Response("down", { status: 503 }));
    expect([down.code, down.output]).toEqual([0, NO]);
  }, 60_000);
});

describe.skipIf(process.platform === "win32")("the verdict", () => {
  const script = verdict.steps![0]!.run!;
  const guard = publish.steps![0]!.run!;
  const RESULTS = ["success", "failure", "cancelled", "skipped", ""];
  interface Case { ci: string; fast: string; reuse: string; green: string; run: string; revalidate: string }
  const decide = (c: Case) => runStep(script, { CI_RESULT: c.ci, FAST_RESULT: c.fast, REUSE_RESULT: c.reuse, REUSE_GREEN: c.green, REUSE_RUN: c.run, REVALIDATE: c.revalidate });
  const publishes = async (validatedBy: string): Promise<boolean> => (await runStep(guard, { VALIDATED_BY: validatedBy })).code === 0;
  /** What the verdict job hands release.yml: the output of a step that passed, nothing from one that failed. */
  const handed = (result: { code: number; output: string }): string => (result.code === 0 ? /^validated_by=(.*)\n$/.exec(result.output)?.[1] ?? "" : "");
  /** Main's run verified: ci.yml skipped for it, and Fast checks passed in this run. */
  const yes: Case = { ci: "skipped", fast: "success", reuse: "success", green: "true", run: "42426987381", revalidate: "false" };
  /** No verified run: ci.yml runs in this run, and Fast checks of its own is skipped. */
  const no: Case = { ...yes, fast: "skipped", green: "false", run: "" };

  test("names ci.yml when it passed in this run, whatever the reuse job and Fast checks said", async () => {
    const cases: Case[] = [];
    for (const reuseResult of RESULTS) {
      for (const fastResult of RESULTS) {
        for (const [green, run] of [["true", "42426987381"], ["false", ""], ["", ""]] as const) {
          for (const revalidate of ["false", "true"]) cases.push({ ci: "success", fast: fastResult, reuse: reuseResult, green, run, revalidate });
        }
      }
    }
    for (const result of await Promise.all(cases.map(decide))) expect([result.code, result.output]).toEqual([0, "validated_by=ci\n"]);
  }, 60_000);

  test("names main's run when ci.yml was skipped for a verified yes and Fast checks passed here", async () => {
    const result = await decide(yes);
    expect([result.code, result.output]).toEqual([0, "validated_by=main-run-42426987381\n"]);
    expect(result.log).toContain("Validated by main-run-42426987381");
  });

  test("says what was missing when it refuses", async () => {
    const result = await decide({ ...yes, fast: "failure" });
    expect([result.code, result.output]).toEqual([1, ""]);
    expect(result.log).toBe("::error::Not validated: ci.yml ended 'skipped' in this run, and main's own run was not verified with Fast checks passed here (revalidate 'false', its job 'success', green 'true', run '42426987381', Fast checks 'failure').\n");
  });

  // release.yml's table of what can happen, each row with what publish may do
  for (const [name, c, validatedBy] of [
    ["main's run verified, Fast checks passed here, ci.yml skipped", yes, "main-run-42426987381"],
    ["main's run verified, Fast checks failed here", { ...yes, fast: "failure" }, ""],
    ["main's run verified, the run cancelled while Fast checks ran", { ...yes, fast: "cancelled" }, ""],
    ["main's run verified, the run cancelled before Fast checks started", { ...yes, fast: "skipped" }, ""],
    ["main's run verified, Fast checks with no result", { ...yes, fast: "" }, ""],
    ["no verified run, ci.yml passed", { ...no, ci: "success" }, "ci"],
    ["no verified run, ci.yml failed", { ...no, ci: "failure" }, ""],
    ["no verified run, the run cancelled while ci.yml ran", { ...no, ci: "cancelled" }, ""],
    ["no verified run, the run cancelled before ci.yml started", no, ""],
    ["the reuse job failed, ci.yml passed", { ...no, ci: "success", reuse: "failure", green: "" }, "ci"],
    ["the reuse job failed, ci.yml failed", { ...no, ci: "failure", reuse: "failure", green: "" }, ""],
    ["the reuse job timed out with no answer, and the run was cancelled before ci.yml started", { ...no, reuse: "cancelled", green: "" }, ""],
    ["Fast checks passed here, without a verified run", { ...no, fast: "success" }, ""],
    ["ci.yml failed although main's run was verified and Fast checks passed", { ...yes, ci: "failure" }, ""],
    ["ci.yml cancelled although main's run was verified and Fast checks passed", { ...yes, ci: "cancelled" }, ""],
    ["ci.yml passed although Fast checks failed here", { ...yes, ci: "success", fast: "failure" }, "ci"],
    ["a yes from a reuse job that did not succeed", { ...yes, reuse: "failure" }, ""],
    ["a yes without a run id", { ...yes, run: "" }, ""],
    ["a run id without a yes", { ...yes, green: "" }, ""],
    ["revalidate, and ci.yml passed", { ...no, ci: "success", revalidate: "true" }, "ci"],
    ["revalidate, and ci.yml failed", { ...no, ci: "failure", revalidate: "true" }, ""],
    ["revalidate, and ci.yml skipped although a run is named and Fast checks passed", { ...yes, revalidate: "true" }, ""],
    ["everything skipped", { ci: "skipped", fast: "skipped", reuse: "skipped", green: "", run: "", revalidate: "false" }, ""],
    ["nothing known", { ci: "", fast: "", reuse: "", green: "", run: "", revalidate: "" }, ""],
  ] as const) {
    test(`${name}: ${validatedBy ? `validated by ${validatedBy}` : "not validated, nothing is published"}`, async () => {
      const result = await decide(c);
      expect(handed(result)).toBe(validatedBy);
      expect(result.code === 0).toBe(validatedBy !== "");
      if (!validatedBy) {
        expect(result.output).toBe("");
        expect(result.log).toContain("::error::Not validated:");
      }
      expect(await publishes(handed(result))).toBe(validatedBy !== "");
    });
  }

  test("writes validated_by in those two cases only, for every combination of results", async () => {
    const cases: Case[] = [];
    for (const ciResult of RESULTS) {
      for (const fastResult of RESULTS) {
        for (const reuseResult of RESULTS) {
          for (const green of ["true", "false", "", "TRUE"]) {
            for (const run of ["42426987381", "", "0", "42a", "4 2", "-1"]) {
              for (const revalidate of ["false", "true", ""]) cases.push({ ci: ciResult, fast: fastResult, reuse: reuseResult, green, run, revalidate });
            }
          }
        }
      }
    }
    const results: Array<{ code: number; output: string }> = [];
    for (let at = 0; at < cases.length; at += 32) results.push(...await Promise.all(cases.slice(at, at + 32).map(decide)));
    const wrong: string[] = [];
    const named = { ci: 0, main: 0 };
    for (const [index, c] of cases.entries()) {
      const { code, output } = results[index]!;
      const verified = c.ci === "skipped" && c.fast === "success" && c.reuse === "success" && c.green === "true" && c.run === "42426987381" && c.revalidate === "false";
      const expected = c.ci === "success" ? "validated_by=ci\n" : verified ? "validated_by=main-run-42426987381\n" : "";
      if (output !== expected || (code === 0) !== (expected !== "")) wrong.push(`${JSON.stringify(c)}: exit ${code}, wrote ${JSON.stringify(output)}`);
      if (output === "validated_by=ci\n") named.ci += 1;
      else if (output !== "") named.main += 1;
    }
    expect(wrong).toEqual([]);
    expect(cases).toHaveLength(9000);
    // ci.yml passed: 1 result of 5, whatever the others say; main's run: the one combination
    expect(named).toEqual({ ci: 1800, main: 1 });
  }, 120_000);

  test("publish refuses every name but the verdict's two", async () => {
    for (const name of ["ci", "main-run-42426987381", "main-run-1"]) expect([name, await publishes(name)]).toEqual([name, true]);
    for (const name of ["", " ", "CI", "ci ", " ci", "ci\n", "cid", "success", "skipped", "true", "main-run-", "main-run", "main-run-x", "main-run-1a", "main-run--1", "main-run-1 ", "run-1", "ci|main-run-1", "main-run-1\nci", "x\nci"]) {
      const result = await runStep(guard, { VALIDATED_BY: name });
      expect([name, result.code]).toEqual([name, 1]);
      expect(result.log).toContain("::error::validate ended without naming what validated this commit; refusing to publish it.");
    }
  }, 60_000);
});
