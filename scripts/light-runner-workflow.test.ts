import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GITHUB_HOSTED_LABELS, parseWorkflow, root, type Job } from "./shell-workflow-rules.ts";
import { evaluateValue, type Contexts, type Value } from "./workflow-expression.ts";

// Light jobs (Detect changes, the PR title check, ...) take the self-hosted pool so they do not wait
// in GitHub's hosted queue, but a fork pull request's job must never reach that pool: the guard comes
// first, so a fork gets ubuntu-24.04 whatever the repository variables say.
const FORK_GUARD = "github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04'";
const LIGHT = `\${{ ${FORK_GUARD} || fromJSON(github.ref == 'refs/heads/main' && vars.CI_MAIN_SELF_HOSTED_LABELS || vars.CI_LIGHT_LABELS || vars.CI_SELF_HOSTED_LABELS || '["self-hosted","self-hosted-ovis"]') }}`;
// ci.yml's heavy Linux jobs: scripts/ci-runner-route.sh keeps forks hosted (scripts/ci-runner-route.test.ts)
const ROUTED = "${{ fromJSON(needs.changes.outputs.linux) }}";
// Fast checks: the Linux jobs' runner, or CI_FAST_SELF_HOSTED_LABELS only when those name ovis-vm (never a fork's)
const ROUTED_FAST = "${{ fromJSON(needs.changes.outputs.fast) }}";
// Integration tests: the Linux jobs' runner, or CI_INTEGRATION_SELF_HOSTED_LABELS' while their queue is short (never a fork's)
const ROUTED_INTEGRATION = "${{ fromJSON(needs.changes.outputs.integration) }}";
// herdr-core live contract: GitHub-hosted unless CI_HC_LIVE_LABELS moves it, and a fork stays hosted before it is read
const HC_LIVE = `\${{ ${FORK_GUARD} || fromJSON(vars.CI_HC_LIVE_LABELS || '"ubuntu-24.04"') }}`;
// Native Windows install: winvm's runner or windows-latest; the route keeps forks on windows-latest (scripts/ci-runner-route.test.ts)
const ROUTED_WINDOWS = "${{ fromJSON(needs.changes.outputs.windows) }}";
// the Rust PTY host: the runners with the Rust toolchain, or hosted (forks always)
const ROUTED_RUST = "${{ fromJSON(needs.changes.outputs.rust) }}";
// ci.yml's macOS session job: a fork stays on macos-15
const MAC_FORK_GUARD = "github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'macos-15'";
const MAC = `\${{ ${MAC_FORK_GUARD} || fromJSON(github.workflow == 'CI' && vars.CI_MAC_LABELS || '"macos-15"') }}`;
const MAC_PULL_REQUEST = "${{ fromJSON(matrix.os == 'macos-15' && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && vars.CI_MAC_LABELS || toJSON(matrix.os)) }}";
const HOSTED = /^(ubuntu|windows|macos)-[\w.-]+$/;
const hostedOnly = (label: string, expression: string): string => `\${{ inputs.hosted_only && '${label}' || ${expression.slice("${{ ".length)}`;
const HOSTED_ONLY_LIGHT = hostedOnly("ubuntu-24.04", LIGHT);

const dir = join(root, ".github/workflows");
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, workflow: parseWorkflow(join(dir, name)) }));

const triggers = (on: unknown): string[] => (typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on as object));

const pullRequestWorkflows = new Set(
  workflows.filter(({ workflow }) => triggers(workflow.on).some((event) => event === "pull_request" || event === "pull_request_target")).map(({ name }) => name),
);
for (let grew = true; grew; ) {
  grew = false;
  for (const { workflow } of workflows.filter(({ name }) => pullRequestWorkflows.has(name))) {
    for (const job of Object.values(workflow.jobs)) {
      const called = /^\.\/\.github\/workflows\/(.+\.yml)$/.exec(job.uses ?? "")?.[1];
      if (called && !pullRequestWorkflows.has(called)) {
        pullRequestWorkflows.add(called);
        grew = true;
      }
    }
  }
}

/** Why `job` can never send a fork pull request's code to a self-hosted runner, or null. */
function forkSafe(job: Job & { strategy?: { matrix?: { include?: { os?: unknown }[] } } }): string | null {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return null;
  if (HOSTED.test(runsOn)) return "hosted";
  if (runsOn === LIGHT || runsOn === HOSTED_ONLY_LIGHT) return "light";
  if (runsOn === MAC || runsOn === hostedOnly("macos-15", MAC)) return "mac";
  if (runsOn === ROUTED || runsOn === hostedOnly("ubuntu-24.04", ROUTED)) return "routed";
  if (runsOn === ROUTED_FAST || runsOn === hostedOnly("ubuntu-24.04", ROUTED_FAST)) return "routed (fast)";
  if (runsOn === ROUTED_INTEGRATION || runsOn === hostedOnly("ubuntu-24.04", ROUTED_INTEGRATION)) return "routed (integration)";
  if (runsOn === HC_LIVE || runsOn === hostedOnly("ubuntu-24.04", HC_LIVE)) return "herdr-core live";
  if (runsOn === ROUTED_WINDOWS || runsOn === hostedOnly("windows-latest", ROUTED_WINDOWS)) return "routed (Windows)";
  if (runsOn === ROUTED_RUST || runsOn === hostedOnly("ubuntu-24.04", ROUTED_RUST)) return "routed (rust)";
  if (runsOn === "${{ matrix.os }}" || runsOn === MAC_PULL_REQUEST) {
    const include = job.strategy?.matrix?.include ?? [];
    const hosted = include.length > 0 && include.every((entry) => typeof entry.os === "string" && HOSTED.test(entry.os));
    return hosted ? (runsOn === MAC_PULL_REQUEST ? "mac on this repository's pull requests" : "hosted matrix") : null;
  }
  // a job that never runs for a pull request may take any runner: its condition must require that
  const condition = job.if ?? "";
  return /^(.+ && )?github\.event_name != 'pull_request'( && .+)?$/.test(condition) && !condition.includes("||") ? "not on pull requests" : null;
}

describe("self-hosted runners and fork pull requests", () => {
  test("the light runner expression sends fork pull requests to ubuntu-24.04 before reading any variable", () => {
    expect(LIGHT.indexOf(FORK_GUARD)).toBe(4);
    expect(LIGHT.indexOf("vars.")).toBeGreaterThan(LIGHT.indexOf(FORK_GUARD));
  });

  test("the matrix Mac form sends only a macos-15 entry of a pull request from this repository to CI_MAC_LABELS", () => {
    const mac = '["self-hosted","self-hosted-ovis-mac"]';
    const run = (os: string, event: string, head: string | null, vars: Record<string, string> = { CI_MAC_LABELS: mac }) =>
      evaluateValue(MAC_PULL_REQUEST, { github: { event_name: event, repository: "devswha/ovis", event: head === null ? {} : { pull_request: { head: { repo: { full_name: head } } } } }, vars, matrix: { os } } as Contexts);
    expect(run("macos-15", "pull_request", "devswha/ovis")).toEqual(["self-hosted", "self-hosted-ovis-mac"]);
    expect(run("macos-15", "pull_request", "someone/fork")).toBe("macos-15");
    expect(run("macos-15", "pull_request", "devswha/ovis", {})).toBe("macos-15");
    for (const event of ["push", "workflow_dispatch", "workflow_run", "pull_request_target"]) expect(run("macos-15", event, null)).toBe("macos-15");
    for (const os of ["macos-15-intel", "ubuntu-24.04", "ubuntu-24.04-arm"]) expect(run(os, "pull_request", "devswha/ovis")).toBe(os);
  });

  test("ci.yml's macOS session job keeps forks on macos-15 and stays there while CI_MAC_LABELS is unset", () => {
    const ci = workflows.find(({ name }) => name === "ci.yml")!.workflow;
    expect(ci.jobs["macos-session"]!["runs-on"]).toBe(hostedOnly("macos-15", MAC));
    expect((ci.jobs["macos-session"] as Job & { env?: Record<string, string> }).env?.["CLAUDE_CONFIG_DIR"]).toBe("");
    expect(MAC.indexOf(MAC_FORK_GUARD)).toBe(4);
    expect(MAC.indexOf("vars.")).toBeGreaterThan(MAC.indexOf(MAC_FORK_GUARD));
    expect(/'([^']+)'$/.exec(MAC_FORK_GUARD)![1]).toMatch(HOSTED);
    expect(JSON.parse(/vars\.CI_MAC_LABELS \|\| '([^']+)'\)/.exec(MAC)![1]!)).toMatch(HOSTED);
  });

  test("ci.yml's routed Linux label comes from scripts/ci-runner-route.sh", () => {
    const ci = workflows.find(({ name }) => name === "ci.yml")!.workflow;
    const changes = ci.jobs.changes!;
    expect(changes.outputs?.linux).toBe("${{ steps.route.outputs.linux }}");
    expect(changes.outputs?.fast).toBe("${{ steps.route.outputs.fast }}");
    expect(changes.outputs?.integration).toBe("${{ steps.route.outputs.integration }}");
    expect(changes.steps?.find((step) => step.id === "route")?.env?.["INTEGRATION_LABELS"]).toBe("${{ vars.CI_INTEGRATION_SELF_HOSTED_LABELS }}");
    expect(changes.outputs?.windows).toBe("${{ steps.route.outputs.windows }}");
    expect(changes.steps?.find((step) => step.id === "route")?.env?.["WINVM_READY"]).toBe("${{ github.workflow == 'CI' && vars.CI_WINVM_READY || '' }}");
    expect(changes.steps?.find((step) => step.id === "route")?.env?.["PR_DRAFT"]).toBe("${{ github.event.pull_request.draft }}");
    expect(changes.outputs?.rust).toBe("${{ steps.route.outputs.rust }}");
    expect(changes.steps?.find((step) => step.id === "route")?.env?.["LINUX_LABELS"]).toBe("${{ github.workflow == 'CI' && vars.CI_LINUX_SELF_HOSTED_LABELS || '' }}");
    expect(changes.steps?.find((step) => step.id === "route")?.run).toBe('bash scripts/ci-runner-route.sh >> "$GITHUB_OUTPUT"');
  });

  test("herdr-core live contract is GitHub-hosted unless CI_HC_LIVE_LABELS moves it, and a fork never reads it", () => {
    expect(HC_LIVE.indexOf(FORK_GUARD)).toBe(4);
    const run = (event: string, head: string | null, vars: Record<string, string>) =>
      evaluateValue(HC_LIVE, { github: { event_name: event, repository: "devswha/ovis", event: head === null ? {} : { pull_request: { head: { repo: { full_name: head } } } } }, vars } as Contexts);
    const moved = { CI_HC_LIVE_LABELS: '["self-hosted","self-hosted-ovis"]' };
    expect(run("pull_request", "devswha/ovis", {})).toBe("ubuntu-24.04");
    expect(run("push", null, {})).toBe("ubuntu-24.04");
    expect(run("pull_request", "devswha/ovis", moved)).toEqual(["self-hosted", "self-hosted-ovis"]);
    expect(run("push", null, moved)).toEqual(["self-hosted", "self-hosted-ovis"]);
    expect(run("pull_request", "someone/fork", moved)).toBe("ubuntu-24.04");
  });

  test("some job uses the light runner expression", () => {
    const light = workflows.flatMap(({ workflow }) => Object.values(workflow.jobs).filter((job) => job["runs-on"] === LIGHT || job["runs-on"] === HOSTED_ONLY_LIGHT));
    expect(light.length).toBeGreaterThan(0);
  });

  test("pull requests run ci.yml", () => {
    expect(pullRequestWorkflows.has("ci.yml")).toBe(true);
  });

  for (const { name, workflow } of workflows.filter(({ name }) => pullRequestWorkflows.has(name))) {
    test(`${name}: no pull request job can reach a self-hosted runner without the fork guard`, () => {
      const unsafe = Object.entries(workflow.jobs)
        .filter(([, job]) => job["runs-on"] !== undefined && forkSafe(job) === null)
        .map(([id, job]) => `${id}: ${String(job["runs-on"])}`);
      expect(unsafe).toEqual([]);
    });
  }
});

describe("ci.yml's hosted_only input", () => {
  type CiStep = { uses?: string; if?: string; with?: Record<string, unknown>; env?: Record<string, string> };
  type CiJob = Job & { steps?: CiStep[] };
  const ci = workflows.find(({ name }) => name === "ci.yml")!.workflow as unknown as { on: Record<string, { inputs?: Record<string, { type?: string; default?: unknown }> } | null>; jobs: Record<string, CiJob> };
  const setupCi = Bun.YAML.parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8")) as { inputs: { cache: { default: string } } };
  const PREFIX = /^inputs\.hosted_only && '([^']+)' \|\| /;
  const labelSets = ['["self-hosted","self-hosted-ovis"]', '["self-hosted","self-hosted-ovis-main"]', '"ubuntu-24.04"'];
  const variables = (value: string | null): Value => (value === null ? {} : Object.fromEntries(["CI_MAIN_SELF_HOSTED_LABELS", "CI_LIGHT_LABELS", "CI_SELF_HOSTED_LABELS", "CI_MAC_LABELS", "CI_HC_LIVE_LABELS"].map((name) => [name, value])));
  const ownRuns: Contexts[] = [];
  for (const [workflow, event, ref, pullRequest] of [
    ["CI", "push", "refs/heads/main", null], ["CI", "push", "refs/heads/topic", null], ["CI", "workflow_dispatch", "refs/heads/main", null], ["CI", "workflow_dispatch", "refs/heads/topic", null],
    ["CI", "pull_request", "refs/pull/1/merge", "devswha/ovis"], ["CI", "pull_request", "refs/pull/1/merge", "someone/fork"],
    ["Release", "workflow_dispatch", "refs/heads/main", null], ["Relay deploy", "push", "refs/heads/main", null], ["Website", "workflow_run", "refs/heads/main", null],
  ] as const) {
    for (const vars of [null, ...labelSets]) {
      for (const [routedTo, windows] of labelSets.flatMap((set) => ['"windows-latest"', '["self-hosted","self-hosted-ovis-win"]'].map((label) => [set, label] as const))) {
        for (const inputs of [{}, { hosted_only: false }, { hosted_only: null }, { self_hosted_labels: "" }]) {
          for (const [environment, draft] of [["self-hosted", "false"], ["github-hosted", "false"], ["github-hosted", "true"]]) {
            const github = { workflow, event_name: event, ref, repository: "devswha/ovis", event: pullRequest === null ? {} : { pull_request: { draft: draft === "true", head: { repo: { full_name: pullRequest } } } } };
            const needs = { changes: { outputs: { linux: routedTo, fast: routedTo, integration: routedTo, rust: routedTo, windows, draft, code: "true" } } };
            ownRuns.push({ github, vars: variables(vars), inputs, needs, runner: { environment, os: "Linux" } } as Contexts);
          }
        }
      }
    }
  }
  const called = (context: Contexts): Contexts => ({ ...context, inputs: { hosted_only: true } });

  test("the evaluation reads ci.yml's runner expressions as GitHub does", () => {
    const push = { github: { workflow: "CI", event_name: "push", ref: "refs/heads/main", repository: "devswha/ovis", event: {} }, vars: { CI_MAIN_SELF_HOSTED_LABELS: '["self-hosted","self-hosted-ovis-main"]' }, inputs: {} };
    expect(evaluateValue(LIGHT, push)).toEqual(["self-hosted", "self-hosted-ovis-main"]);
    expect(evaluateValue(LIGHT, { ...push, vars: {} })).toEqual(["self-hosted", "self-hosted-ovis"]);
    const fork = { ...push, github: { ...push.github, event_name: "pull_request", ref: "refs/pull/1/merge", event: { pull_request: { head: { repo: { full_name: "someone/fork" } } } } } };
    expect(evaluateValue(LIGHT, fork)).toBe("ubuntu-24.04");
    const topic = { ...push, github: { ...push.github, ref: "refs/heads/topic" }, vars: { CI_MAC_LABELS: '["self-hosted","self-hosted-ovis-mac"]' } };
    expect(evaluateValue(MAC, topic)).toEqual(["self-hosted", "self-hosted-ovis-mac"]);
    expect(evaluateValue(MAC, { ...topic, github: { ...topic.github, ref: "refs/heads/main" } })).toEqual(["self-hosted", "self-hosted-ovis-mac"]);
    expect(evaluateValue(MAC, { ...topic, github: { ...topic.github, workflow: "Release" } })).toBe("macos-15");
    expect(evaluateValue(ROUTED, { ...push, needs: { changes: { outputs: { linux: '"ubuntu-24.04"' } } } })).toBe("ubuntu-24.04");
  });

  test("every job runs where it ran before in ci.yml's own runs, and on its hosted label when called with hosted_only: true", () => {
    for (const [id, job] of Object.entries(ci.jobs)) {
      const runsOn = job["runs-on"] as string;
      if (GITHUB_HOSTED_LABELS.includes(runsOn)) continue;
      const inner = /^\$\{\{ ([\s\S]*) \}\}$/.exec(runsOn)![1]!;
      const prefix = PREFIX.exec(inner);
      expect(prefix, `${id}: runs-on starts with the hosted_only prefix`).not.toBeNull();
      const label = prefix![1]!;
      const before = `\${{ ${inner.slice(prefix![0].length)} }}`;
      expect([LIGHT, MAC, ROUTED, ROUTED_FAST, ROUTED_INTEGRATION, ROUTED_RUST, ROUTED_WINDOWS, HC_LIVE], `${id}: behind the prefix, the expression it had`).toContain(before);
      expect(GITHUB_HOSTED_LABELS).toContain(label);
      for (const context of ownRuns) expect([id, evaluateValue(runsOn, context)]).toEqual([id, evaluateValue(before, context)]);
      for (const context of ownRuns) expect([id, evaluateValue(runsOn, called(context))]).toEqual([id, label]);
    }
  });

  test("every job restores the caches it restored before in ci.yml's own runs, and none when called with hosted_only: true", () => {
    for (const [id, job] of Object.entries(ci.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses === "./.github/actions/setup-ci") {
          const mode = /^\$\{\{ inputs\.hosted_only && 'none' \|\| '(save|restore)' \}\}$/.exec(String(step.with?.cache));
          expect(mode, `${id}: setup-ci's cache`).not.toBeNull();
          expect([id, mode![1]]).toEqual([id, id === "herdr-core-live" ? "restore" : setupCi.inputs.cache.default]);
          for (const context of ownRuns) expect(evaluateValue(step.with!.cache, context)).toBe(mode![1]!);
          for (const context of ownRuns) expect(evaluateValue(step.with!.cache, called(context))).toBe("none");
        }
        if (step.uses?.startsWith("actions/cache")) {
          const condition = /^(.+) && !inputs\.hosted_only$/.exec(step.if ?? "");
          expect(condition, `${id}: ${step.uses} skipped under hosted_only`).not.toBeNull();
          expect([id, condition![1]]).toEqual([id, id === "herdr-core-live" ? "needs.changes.outputs.draft != 'true'" : "needs.changes.outputs.draft != 'true' && runner.environment != 'self-hosted'"]);
          for (const context of ownRuns) expect(evaluateValue(step.if, context, true)).toBe(evaluateValue(condition![1], context, true));
          for (const context of ownRuns) expect(evaluateValue(step.if, called(context), true)).toBe(false);
        }
      }
    }
  });

  test("is read exactly where reviewed: each runner, each setup-ci cache, each cache step's condition and the route", () => {
    const reads: string[] = [];
    const scan = (value: unknown, path: string[]): void => {
      if (typeof value === "string") {
        if (/hosted_only/.test(value)) reads.push(`${path.join(".")}: ${value}`);
      } else if (Array.isArray(value)) {
        value.forEach((entry: { id?: string; name?: string; uses?: string } | null, index) => scan(entry, [...path, entry?.id ?? entry?.name ?? entry?.uses?.replace(/@.*/, "") ?? String(index)]));
      } else if (typeof value === "object" && value !== null) {
        for (const [key, entry] of Object.entries(value)) scan(entry, [...path, key]);
      }
    };
    for (const [key, value] of Object.entries(ci)) if (key !== "on") scan(value, [key]);
    const runner = (id: string, label: string, expression: string): string => `jobs.${id}.runs-on: ${hostedOnly(label, expression)}`;
    const cache = (id: string, mode: string): string => `jobs.${id}.steps../.github/actions/setup-ci.with.cache: \${{ inputs.hosted_only && 'none' || '${mode}' }}`;
    const PLAYWRIGHT = "Cache Playwright browser.if: needs.changes.outputs.draft != 'true' && runner.environment != 'self-hosted' && !inputs.hosted_only";
    expect(reads.sort()).toEqual([
      runner("changes", "ubuntu-24.04", LIGHT),
      "jobs.changes.steps.route.env.HOSTED_ONLY: ${{ inputs.hosted_only }}",
      runner("windows-install", "windows-latest", ROUTED_WINDOWS),
      cache("windows-install", "save"),
      runner("macos-session", "macos-15", MAC),
      cache("macos-session", "save"),
      runner("rust-pty-host", "ubuntu-24.04", ROUTED_RUST),
      cache("rust-pty-host", "save"),
      runner("herdr-core-live", "ubuntu-24.04", HC_LIVE),
      cache("herdr-core-live", "restore"),
      "jobs.herdr-core-live.steps.hc-cache.if: needs.changes.outputs.draft != 'true' && !inputs.hosted_only",
      runner("fast", "ubuntu-24.04", ROUTED_FAST),
      cache("fast", "save"),
      runner("integration", "ubuntu-24.04", ROUTED_INTEGRATION),
      cache("integration", "save"),
      runner("browser-main", "ubuntu-24.04", ROUTED),
      cache("browser-main", "save"),
      `jobs.browser-main.steps.${PLAYWRIGHT}`,
      runner("browser-other", "ubuntu-24.04", ROUTED),
      cache("browser-other", "save"),
      `jobs.browser-other.steps.${PLAYWRIGHT}`,
      runner("integration-browser", "ubuntu-24.04", LIGHT),
    ].sort());
  });

  test("is a boolean that only pages.yml and the Release's validation pass, as true, and the route reads it", () => {
    expect(ci.on["workflow_call"]!.inputs!["hosted_only"]).toMatchObject({ type: "boolean", default: false });
    const passed = workflows.flatMap(({ name, workflow }) => Object.entries(workflow.jobs).filter(([, job]) => job.uses === "./.github/workflows/ci.yml").map(([id, job]) => [name, id, (job as { with?: Record<string, unknown> }).with?.["hosted_only"]]));
    expect(passed.sort()).toEqual([["pages.yml", "validate", true], ["relay-deploy.yml", "validate", undefined], ["release-validate.yml", "ci", true]]);
    const route = ci.jobs["changes"]!.steps!.find((step) => (step as { id?: string }).id === "route")!;
    expect(route.env?.["HOSTED_ONLY"]).toBe("${{ inputs.hosted_only }}");
  });
});
