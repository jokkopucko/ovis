import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Step = { name?: string; id?: string; if?: string; shell?: string; run?: string; env?: Record<string, string> };
const root = fileURLToPath(new URL("../", import.meta.url));
type Workflow = {
  on: Record<string, { types?: string[] } | null>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { "runs-on": string; permissions?: Record<string, string>; steps: Step[] }>;
};
const source = readFileSync(join(root, ".github/workflows/pr-title.yml"), "utf8");
const workflow = Bun.YAML.parse(source) as Workflow;
const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as Workflow;
const steps = workflow.jobs.title!.steps;
const step = steps.find((candidate) => candidate.name === "Check the pull request title")!;

function check(eventName: string, payload?: unknown, raw?: string) {
  const dir = mkdtempSync(join(tmpdir(), "pr-title-"));
  try {
    const script = join(dir, "step");
    writeFileSync(script, step.run!);
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", GITHUB_EVENT_NAME: eventName };
    if (payload !== undefined || raw !== undefined) {
      env.GITHUB_EVENT_PATH = join(dir, "event.json");
      writeFileSync(env.GITHUB_EVENT_PATH, raw ?? JSON.stringify(payload));
    }
    const result = spawnSync("node", [script], { cwd: dir, encoding: "utf8", timeout: 5_000, env });
    expect(result.error).toBeUndefined();
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const titled = (action: string, title: unknown) => check("pull_request", { action, pull_request: { title } });

describe.skipIf(process.platform === "win32")("PR title check", () => {
  it("runs alone in a job that checks out nothing, fork pull requests hosted, reading the title as data", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["title"]);
    expect(workflow.jobs.title!["runs-on"]).toStartWith("${{ github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04' || ");
    expect(steps).toEqual([step]);
    expect(step.shell).toBe("node {0}");
    expect(step.env).toBeUndefined();
    expect(step.run).not.toContain("${{");
    expect(source).not.toContain("pull_request.title");
  });

  it("is rechecked on an edit, with no token permissions and no pull_request_target", () => {
    expect(Object.keys(workflow.on)).toEqual(["pull_request"]);
    expect(workflow.on.pull_request!.types).toEqual(["opened", "edited", "synchronize", "reopened"]);
    expect(source).not.toContain("pull_request_target");
    expect(workflow.permissions).toEqual({});
    for (const job of Object.values(workflow.jobs)) expect(job.permissions).toBeUndefined();
  });

  it("never cancels CI's run: an edit restarts this workflow only", () => {
    expect(workflow.concurrency).toEqual({ group: "pr-title-${{ github.event.pull_request.number }}", "cancel-in-progress": true });
    expect(ci.on.pull_request!.types).not.toContain("edited");
    expect(Object.values(ci.jobs).flatMap((job) => job.steps ?? []).map((candidate) => candidate.name)).not.toContain(step.name);
  });

  it("accepts the documented shape with any scope and summary text", () => {
    for (const title of [
      "fix(chat): keep the finished turn finished after Send",
      "docs(contributors): Clarify PC and native session",
      "feat(i18n): 한국어 설명을 더 자연스럽게 다듬기",
      "ci(pr): check current titles against the documented grammar",
      "chore(deps, ci/actions): bump GitHub Actions",
    ]) {
      expect({ title, ...titled("opened", title) }).toEqual({ title, status: 0, output: "The title matches type(scope): summary.\n" });
    }
  });

  it("rejects titles outside the grammar without printing them", () => {
    for (const title of [
      "hold the draft",
      "fix: hold the draft",
      "fix(): hold the draft",
      "fix(   ): hold the draft",
      "fix( composer): hold the draft",
      "fix(composer):",
      "fix(composer): ",
      "fix(composer):   ",
      "fix(composer):keep it",
      "fix(composer):  keep it",
      "Fix(composer): keep it",
      "(composer): keep it",
      "fix(composer) keep it",
      " fix(composer): keep it",
      "fix(composer): keep it ",
      "fix(composer): keep it\nsecond line",
      "fix(composer): keep it\r",
      "fix(composer): keep\u0000it",
      "fix(composer): keep\u2028it",
      "",
    ]) {
      const result = titled("opened", title);
      expect({ title, status: result.status }).toEqual({ title, status: 1 });
      expect(result.output).toStartWith("::error title=Pull request title::The title must read type(scope): summary");
      expect(result.output.trimEnd().split("\n")).toHaveLength(1);
      if (title.trim()) expect(result.output).not.toContain(title.trim());
    }
  });

  it("fails a pull request event whose payload has no title", () => {
    for (const payload of [{}, { pull_request: {} }, { pull_request: { title: null } }, { pull_request: { title: 42 } }]) {
      const result = check("pull_request", payload);
      expect(result.status).toBe(1);
      expect(result.output).toContain("The event payload has no pull request title.");
    }
    expect(check("pull_request").status).toBe(1);
    expect(check("pull_request", undefined, "{not json").output).toContain("The event payload could not be read.");
  });

  it("skips other events without reading a payload", () => {
    for (const event of ["push", "workflow_dispatch", "workflow_call"]) {
      expect(check(event)).toEqual({ status: 0, output: "Not a pull request: no title to check.\n" });
    }
  });

  it("checks the title of the current payload after an edit", () => {
    expect(titled("opened", "fix(chat): keep the finished turn finished after Send").status).toBe(0);
    expect(titled("edited", "fix(chat): keep finished turns finished after Send").status).toBe(0);
    expect(titled("opened", "fix(chat): keep the finished turn finished after Send").status).toBe(0);
    expect(titled("edited", "keep the finished turn finished after Send").status).toBe(1);
  });

  it("never executes title text or lets it write workflow commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "pr-title-sentinel-"));
    try {
      const sentinel = join(dir, "ran");
      const payloads = [
        `$(touch ${sentinel})`,
        `\`touch ${sentinel}\``,
        `'; touch ${sentinel}; echo '`,
        `"; require("fs").writeFileSync("${sentinel}", ""); "`,
        "::error::injected",
        "fix(chat): ok\n::warning::injected",
        "fix(chat): ok%0A::warning::injected",
        "::stop-commands::token",
      ];
      for (const payload of payloads) {
        for (const title of [payload, `fix(chat): ${payload}`]) {
          const result = titled("edited", title);
          const valid = !/[\n\r]/.test(title) && title.startsWith("fix(chat): ");
          expect({ title, status: result.status }).toEqual({ title, status: valid ? 0 : 1 });
          expect(result.output).not.toContain("injected");
          expect(result.output).not.toContain("touch");
          expect(result.output).not.toContain("stop-commands");
          expect(result.output.match(/::/g)?.length ?? 0).toBe(valid ? 0 : 2);
        }
      }
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
