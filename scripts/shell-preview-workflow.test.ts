import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionProblems, backgroundProblems, cacheProblems, DEPLOY_ACTIONS, type Job, parseWorkflow, root, runScript,
  scriptProblems, secretProblems, type Step, stepList, unpackOutcomes, type Workflow,
} from "./shell-workflow-rules.ts";

/** The preview workflow at SHELL_PREVIEW_WORKFLOW (a mutated copy) or the committed one. */
const preview = (): Workflow => parseWorkflow(process.env.SHELL_PREVIEW_WORKFLOW ?? join(root, ".github/workflows/shell-preview.yml"));
const build = (): Job => preview().jobs["shell-build"]!;
const deploy = (): Job => preview().jobs["shell-deploy"]!;
const find = (job: Job, predicate: (step: Step) => boolean): Step => job.steps!.find(predicate)!;
const deployIndex = (): number => deploy().steps!.findIndex((candidate) => candidate.run?.includes("pages deploy dist-shell") === true);
const deployStep = (): Step => deploy().steps![deployIndex()]!;

/** `--flag value` of a wrangler command line. */
const flag = (command: string, name: string): string | undefined => command.match(new RegExp(`--${name} (\\S+)`))?.[1];
/** The production deploy in the committed release.yml: the command and the branch that is app.ovis.sh. */
const production = (): { run: string; branch: string } => {
  const run = parseWorkflow(join(root, ".github/workflows/release.yml")).jobs["shell-deploy"]!.steps!
    .find((candidate) => candidate.run?.includes("pages deploy dist-shell") === true)!.run!;
  return { run, branch: flag(run, "branch")! };
};

test("it runs only by hand, from main of devswha/ovis, as a build job and a deploy job after it", () => {
  const guard = "github.repository == 'devswha/ovis' && github.ref == 'refs/heads/main'";
  expect(Object.keys(preview().on)).toEqual(["workflow_dispatch"]);
  expect(Object.keys(preview().jobs)).toEqual(["shell-build", "shell-deploy"]);
  expect(build().if).toBe(guard);
  expect(deploy().if).toBe(guard);
  expect(deploy().needs).toBe("shell-build");
});

test("no script interpolates an expression or writes $GITHUB_ENV or $GITHUB_PATH, in any job", () => {
  expect(scriptProblems(preview())).toEqual([]);
});

test("the build holds no secret and no environment, restores the cache read-only and passes the tarball's SHA-256", () => {
  const job = build();
  expect(job.environment).toBeUndefined();
  expect(preview().permissions).toEqual({ contents: "read" });
  expect(job.permissions).toEqual({ contents: "read" });
  expect(JSON.stringify(job)).not.toContain("secrets.");
  expect(cacheProblems(preview())).toEqual([]);
  expect(find(job, (step) => step.uses === "./.github/actions/setup-ci").with).toEqual({ cache: "restore" });
  expect(find(job, (step) => step.uses?.startsWith("actions/checkout@") === true).with?.ref).toBe("${{ github.sha }}");
  for (const step of job.steps!) if (step.uses && !step.uses.startsWith("./")) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  expect(job.outputs).toEqual({ sha256: "${{ steps.pack.outputs.sha256 }}" });
  expect(stepList(job).slice(-2)).toEqual(["Pack the shell", "actions/upload-artifact"]);
});

test("the deploy job runs exactly its pinned steps: no checkout, no local action, only allowed pinned actions", () => {
  expect(actionProblems("shell-deploy", deploy(), DEPLOY_ACTIONS)).toEqual([]);
  expect(stepList(deploy())).toEqual([
    "oven-sh/setup-bun",
    "actions/download-artifact",
    "Check and unpack the shell",
    "Install the pinned wrangler",
    "Require the Cloudflare secrets",
    "Deploy the shell to the Pages preview branch",
    "Verify the preview serves this revision",
  ]);
  for (const step of deploy().steps!) expect(step.if).toBeUndefined();
  expect(find(deploy(), (step) => step.name === "Check and unpack the shell").env).toEqual({ EXPECTED_SHA256: "${{ needs.shell-build.outputs.sha256 }}" });
  expect(backgroundProblems("shell-deploy", deploy())).toEqual([]);
});

test("it waits in production on a GitHub-hosted runner, reading only", () => {
  const environment = deploy().environment;
  expect(typeof environment === "string" ? environment : environment?.name).toBe("production");
  expect(deploy()["runs-on"]).toBe("ubuntu-24.04");
  expect(deploy().permissions).toEqual({ contents: "read" });
  expect(deploy()["timeout-minutes"]).toBeGreaterThan(0);
});

test("it deploys release.yml's pinned wrangler to the fixed preview branch of the same project, never to its production branch", () => {
  const run = deployStep().run!;
  const { run: productionRun, branch } = production();
  expect(branch).toBe("main");
  expect(run).toBe(productionRun.replace("--branch main", "--branch preview"));
  expect(deployStep()["working-directory"]).toBe("${{ runner.temp }}");
  const previewBranch = flag(run, "branch")!;
  expect(previewBranch).toBe("preview");
  expect(run.match(/--branch/g)).toHaveLength(1);
  const url = `https://${previewBranch}.${flag(run, "project-name")}.pages.dev`;
  expect(url).toBe("https://preview.ovis-app.pages.dev");
  const environment = deploy().environment;
  expect(typeof environment === "string" ? undefined : environment?.url).toBe(`${url}/`);
  expect(find(deploy(), (step) => step.env?.SHELL_BUILD_URL !== undefined).env).toEqual({ SHELL_BUILD_URL: `${url}/build.json`, EXPECTED_REVISION: "${{ github.sha }}" });
  const release = parseWorkflow(join(root, ".github/workflows/release.yml")).jobs["shell-deploy"]!;
  expect(find(deploy(), (step) => step.name === "Install the pinned wrangler").run).toBe(find(release, (step) => step.name === "Install the pinned wrangler").run);
});

test("only the deploy step receives the Cloudflare secrets; the check before it sees only whether they are set", () => {
  expect(deployIndex()).toBeGreaterThanOrEqual(0);
  expect(secretProblems(preview(), "shell-deploy", deployIndex())).toEqual([]);
  expect(deployStep().env).toEqual({ CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}", CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" });
});

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "shell-preview-"));
  try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("a build without index.html or build.json fails before it is packed", async () => {
  const required = find(build(), (step) => step.name === "Require the built shell");
  await withDir(async (dir) => {
    mkdirSync(join(dir, "dist-shell"));
    writeFileSync(join(dir, "dist-shell", "index.html"), "<!doctype html>");
    const missing = await runScript(required.run!, dir, {});
    expect(missing.code).not.toBe(0);
    expect(missing.output).toContain("dist-shell/build.json");
    writeFileSync(join(dir, "dist-shell", "build.json"), "{}\n");
    expect((await runScript(required.run!, dir, {})).code).toBe(0);
  });
});

test("unset Cloudflare secrets fail the run and are named", async () => {
  const check = find(deploy(), (step) => step.env?.HAS_CLOUDFLARE_API_TOKEN !== undefined);
  await withDir(async (dir) => {
    const unset = await runScript(check.run!, dir, { HAS_CLOUDFLARE_API_TOKEN: "true", HAS_CLOUDFLARE_ACCOUNT_ID: "false" });
    expect(unset.code).not.toBe(0);
    expect(unset.output).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect((await runScript(check.run!, dir, { HAS_CLOUDFLARE_API_TOKEN: "true", HAS_CLOUDFLARE_ACCOUNT_ID: "true" })).code).toBe(0);
  });
});

test("the deploy refuses links, special files, paths outside the tarball and Pages server code before unpacking", async () => {
  const outcomes = await unpackOutcomes(find(deploy(), (step) => step.name === "Check and unpack the shell").run!);
  expect(outcomes["a clean shell"]!.code).toBe(0);
  const refused = Object.entries(outcomes).filter(([name]) => name !== "a clean shell")
    .map(([name, { code, output }]) => [name, code !== 0 && /::error::the tarball holds a (link or a special file|path outside it or Pages server code)/.test(output)]);
  expect(refused).toEqual(refused.map(([name]) => [name, true]));
  expect(refused.length).toBe(12);
}, 30_000);

/** The verify step against a local server answering every request with `status` and `body`. */
async function verify(status: number, body: string): Promise<{ code: number; requests: number; output: string }> {
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch: () => { requests++; return new Response(body, { status }); } });
  try {
    let result = { code: -1, output: "" };
    await withDir(async (dir) => {
      result = await runScript(find(deploy(), (step) => step.env?.SHELL_BUILD_URL !== undefined).run!.replace("sleep 5", "sleep 0"), dir, {
        SHELL_BUILD_URL: `http://127.0.0.1:${server.port}/build.json`, EXPECTED_REVISION: "a".repeat(40),
      });
    });
    return { ...result, requests };
  } finally {
    await server.stop(true);
  }
}

test("verification passes once the preview serves this revision", async () => {
  const result = await verify(200, `${JSON.stringify({ revision: "a".repeat(40) })}\n`);
  expect(result.code).toBe(0);
  expect(result.requests).toBe(1);
}, 30_000);

test("verification fails after bounded retries while the preview serves another revision", async () => {
  const result = await verify(200, `${JSON.stringify({ revision: "b".repeat(40) })}\n`);
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
  expect(result.output).toContain("did not serve revision");
}, 30_000);
