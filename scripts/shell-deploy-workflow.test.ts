import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionProblems, backgroundProblems, cacheProblems, DEPLOY_ACTIONS, type Job, parseWorkflow, root, runScript,
  scriptProblems, secretProblems, type Step, stepList, unpackOutcomes, type Workflow,
} from "./shell-workflow-rules.ts";

/** The workflow at SHELL_DEPLOY_WORKFLOW (a mutated copy) or the committed release.yml. */
const loadWorkflow = (): Workflow => parseWorkflow(process.env.SHELL_DEPLOY_WORKFLOW ?? join(root, ".github/workflows/release.yml"));
const build = (): Job => loadWorkflow().jobs["shell-build"]!;
const deploy = (): Job => loadWorkflow().jobs["shell-deploy"]!;
const attach = (): Job => loadWorkflow().jobs["shell-attach"]!;
const find = (job: Job, predicate: (step: Step) => boolean): Step => job.steps!.find(predicate)!;
const deployIndex = (): number => deploy().steps!.findIndex((step) => step.run?.includes("pages deploy dist-shell") === true);
const SHA256_OUTPUT = "${{ needs.shell-build.outputs.sha256 }}";

const withDir = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "shell-deploy-"));
  try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("the shell builds after publish and deploys after the build, from main of devswha/ovis only, never on a tag push", () => {
  const guard = "github.repository == 'devswha/ovis' && github.ref == 'refs/heads/main'";
  expect(build().needs).toBe("publish");
  expect(build().if).toBe(guard);
  expect(deploy().needs).toBe("shell-build");
  expect(deploy().if).toBe(guard);
  expect("push" in loadWorkflow().on).toBe(false);
});

test("no script interpolates an expression or writes $GITHUB_ENV or $GITHUB_PATH, in any job", () => {
  expect(scriptProblems(loadWorkflow())).toEqual([]);
});

test("every job that installs packages restores the dependency cache read-only", () => {
  expect(cacheProblems(loadWorkflow())).toEqual([]);
  expect(find(build(), (step) => step.uses === "./.github/actions/setup-ci").with).toEqual({ cache: "restore" });
});

test("the build holds no secret and no environment, and builds the release tag's checkout after the tag gate", () => {
  const job = build();
  expect(job.environment).toBeUndefined();
  expect(job.permissions).toEqual({ contents: "read" });
  expect(JSON.stringify(job)).not.toContain("secrets.");
  const checkout = find(job, (step) => step.uses?.startsWith("actions/checkout@") === true);
  expect(checkout.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
  expect(checkout.with).toEqual({ ref: "refs/tags/v${{ inputs.version }}", "persist-credentials": false } as unknown as Record<string, string>);
  const names = stepList(job);
  const gate = names.indexOf("Require the release tag's commit");
  expect(gate).toBeGreaterThan(0);
  expect(gate).toBeLessThan(names.indexOf("bun install --frozen-lockfile"));
  expect(names.indexOf("Require the built shell")).toBe(names.indexOf("Build the shell") + 1);
  expect(names.slice(-2)).toEqual(["Pack the shell", "actions/upload-artifact"]);
  expect(job.outputs).toEqual({ sha256: "${{ steps.pack.outputs.sha256 }}" });
  expect(find(job, (step) => step.name === "Pack the shell").id).toBe("pack");
  expect(find(job, (step) => step.uses?.startsWith("actions/upload-artifact@") === true).with?.["if-no-files-found"]).toBe("error");
});

test("the deploy job runs exactly its pinned steps: no checkout, no local action, only allowed pinned actions", () => {
  expect(actionProblems("shell-deploy", deploy(), DEPLOY_ACTIONS)).toEqual([]);
  expect(stepList(deploy())).toEqual([
    "oven-sh/setup-bun",
    "actions/download-artifact",
    "Check and unpack the shell",
    "Install the pinned wrangler",
    "Check the Cloudflare secrets",
    "Deploy the shell to Cloudflare Pages",
    "Verify app.ovis.sh serves this revision",
  ]);
  const setupCi = Bun.YAML.parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8")) as { inputs: Record<string, { default: string }> };
  expect(deploy().steps![0]!.with).toEqual({ "bun-version": setupCi.inputs["bun-version"]!.default, "no-cache": true } as unknown as Record<string, string>);
  expect(deploy().steps![1]!.with?.name).toBe(find(build(), (step) => step.uses?.startsWith("actions/upload-artifact@") === true).with?.name);
  expect(find(deploy(), (step) => step.name === "Check and unpack the shell").env).toEqual({ EXPECTED_SHA256: SHA256_OUTPUT });
});

test("it waits in production on a GitHub-hosted runner, reading only", () => {
  const environment = deploy().environment;
  expect(typeof environment === "string" ? environment : environment?.name).toBe("production");
  expect(deploy()["runs-on"]).toBe("ubuntu-24.04");
  expect(deploy().permissions).toEqual({ contents: "read" });
  expect(deploy()["timeout-minutes"]).toBeGreaterThan(0);
});

test("only the deploy step receives the Cloudflare secrets; the check before it sees only whether they are set", () => {
  expect(deployIndex()).toBeGreaterThanOrEqual(0);
  expect(secretProblems(loadWorkflow(), "shell-deploy", deployIndex())).toEqual([]);
  expect(deploy().steps![deployIndex()]!.env).toEqual({ CLOUDFLARE_API_TOKEN: "${{ secrets.CLOUDFLARE_API_TOKEN }}", CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}" });
});

test("no job that holds a token starts a background process", () => {
  for (const name of ["shell-deploy", "shell-attach"]) expect(backgroundProblems(name, loadWorkflow().jobs[name]!)).toEqual([]);
});

test("the deploy runs the wrangler the committed lockfile pins, installed from this commit with --frozen-lockfile", () => {
  const step = deploy().steps![deployIndex()]!;
  expect(step.run).toBe("deploy-tools/node_modules/.bin/wrangler pages deploy dist-shell --project-name ovis-app --branch main --no-bundle");
  expect(step["working-directory"]).toBe("${{ runner.temp }}");
  const install = find(deploy(), (candidate) => candidate.name === "Install the pinned wrangler").run!;
  expect(install).toContain('"https://raw.githubusercontent.com/$GITHUB_REPOSITORY/$GITHUB_SHA/.github/deploy-tools/$file"');
  expect(install).toContain("for file in package.json bun.lock; do");
  expect(install).toContain("bun install --frozen-lockfile --ignore-scripts");
  const manifest = JSON.parse(readFileSync(join(root, ".github/deploy-tools/package.json"), "utf8")) as { dependencies: Record<string, string> };
  expect(manifest.dependencies).toEqual({ wrangler: "4.156.0" });
  expect(readFileSync(join(root, ".github/deploy-tools/bun.lock"), "utf8")).toMatch(/"wrangler": \["wrangler@4\.156\.0", "", \{.*\}, "sha512-[A-Za-z0-9+/=]+"\]/);
});

test("the deploy is skipped with a notice without the secrets, and verification follows it", () => {
  const steps = deploy().steps!;
  const guard = steps.findIndex((step) => step.env?.HAS_CLOUDFLARE_API_TOKEN !== undefined);
  const verify = steps.findIndex((step) => step.env?.SHELL_BUILD_URL !== undefined);
  expect(guard).toBeLessThan(deployIndex());
  expect(verify).toBeGreaterThan(deployIndex());
  const guardStep = steps[guard]!;
  expect(guardStep.env?.HAS_CLOUDFLARE_API_TOKEN).toBe("${{ secrets.CLOUDFLARE_API_TOKEN != '' }}");
  expect(guardStep.env?.HAS_CLOUDFLARE_ACCOUNT_ID).toBe("${{ secrets.CLOUDFLARE_ACCOUNT_ID != '' }}");
  expect(guardStep.run).toContain("::notice");
  expect(guardStep.run).toContain("ready=false");
  const ready = `steps.${guardStep.id}.outputs.ready == 'true'`;
  expect(steps[deployIndex()]!.if).toBe(ready);
  expect(steps[verify]!.if).toBe(ready);
  expect(steps[verify]!.env).toEqual({ SHELL_BUILD_URL: "https://app.ovis.sh/build.json", EXPECTED_REVISION: "${{ github.sha }}" });
});

test("only the attach job may write; it checks nothing out, holds no secret and attaches only after a deploy that did not fail", () => {
  const job = attach();
  expect(job.needs).toEqual(["shell-build", "shell-deploy"]);
  expect(job.if).toBeUndefined();
  expect(job.permissions).toEqual({ contents: "write" });
  expect(job.environment).toBeUndefined();
  expect(JSON.stringify(job)).not.toContain("secrets.");
  expect(actionProblems("shell-attach", job, [DEPLOY_ACTIONS[1]!])).toEqual([]);
  expect(stepList(job)).toEqual(["actions/download-artifact", "Attach the shell tarball and its SHA-256 to the release"]);
  const step = job.steps![1]!;
  expect(step.if).toBeUndefined();
  expect(step.env?.EXPECTED_SHA256).toBe(SHA256_OUTPUT);
  expect(step.run).toContain('echo "$EXPECTED_SHA256  dist-shell.tar.gz" | sha256sum --check --strict');
  expect(step.run).toContain("gh release upload \"$RELEASE_TAG\" dist-shell.tar.gz dist-shell.tar.gz.sha256");
  for (const [name, candidate] of Object.entries(loadWorkflow().jobs)) {
    if (name.startsWith("shell-") && name !== "shell-attach") expect(candidate.permissions).toEqual({ contents: "read" });
  }
});

/** A git repository with two commits, `first` and `second` (HEAD). */
async function withRepo(body: (dir: string, first: string, second: string) => Promise<void>): Promise<void> {
  await withDir(async (dir) => {
    const git = (...args: string[]): string => {
      const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd: dir, env: { PATH: process.env.PATH!, HOME: dir } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "first");
    const first = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "second");
    git("tag", "-a", "v1.2.3", "-m", "v1.2.3");
    git("tag", "v1.0.0", first);
    await body(dir, first, git("rev-parse", "HEAD"));
  });
}

const gate = (dir: string, tag: string, sha: string) =>
  runScript(find(build(), (step) => step.name === "Require the release tag's commit").run!, dir, { RELEASE_TAG: tag, RELEASE_SHA: sha });

test("the tag gate passes a release tag on the published commit at HEAD", async () => {
  await withRepo(async (dir, _first, head) => expect((await gate(dir, "v1.2.3", head)).code).toBe(0));
});

test("the tag gate refuses a malformed version, a missing tag, a tag on another commit and another checkout", async () => {
  await withRepo(async (dir, first, head) => {
    for (const [tag, sha, message] of [
      ["v1.2", head, "is not a release tag"],
      ["v1.2.3;true", head, "is not a release tag"],
      ["v9.9.9", head, "is not a tag in this checkout"],
      ["v1.0.0", head, "points at"],
      ["v1.2.3", first, "points at"],
    ] as const) {
      const result = await gate(dir, tag, sha);
      expect([tag, result.code === 0, result.output.includes(message)]).toEqual([tag, false, true]);
    }
    Bun.spawnSync(["git", "checkout", "-q", first], { cwd: dir });
    const elsewhere = await gate(dir, "v1.2.3", head);
    expect(elsewhere.code).not.toBe(0);
    expect(elsewhere.output).toContain("The checkout is not");
  });
});

/** Packs `files` into shell/dist-shell.tar.gz under `dir` and returns its SHA-256. */
function pack(dir: string, files: Record<string, string>): string {
  mkdirSync(join(dir, "src"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "src", name), body);
  mkdirSync(join(dir, "shell"));
  Bun.spawnSync(["tar", "-czf", join(dir, "shell/dist-shell.tar.gz"), "-C", join(dir, "src"), "."]);
  return new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, "shell/dist-shell.tar.gz"))).digest("hex");
}

const unpack = (dir: string, expected: string) => runScript(find(deploy(), (step) => step.name === "Check and unpack the shell").run!, dir, { EXPECTED_SHA256: expected });

test("the deploy unpacks only the tarball whose SHA-256 the build passed, and only a complete shell", async () => {
  await withDir(async (dir) => {
    const digest = pack(dir, { "index.html": "<!doctype html>", "build.json": "{}\n" });
    expect((await unpack(dir, "")).code).not.toBe(0);
    expect((await unpack(dir, "0".repeat(64))).code).not.toBe(0);
    const ok = await unpack(dir, digest);
    expect(ok.code).toBe(0);
    expect(readFileSync(join(dir, "dist-shell/build.json"), "utf8")).toBe("{}\n");
  });
  await withDir(async (dir) => {
    const result = await unpack(dir, pack(dir, { "index.html": "<!doctype html>" }));
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("no build.json");
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

/** Runs the verify step's script against a local server that answers each request with the next status and `body`. */
async function runVerifyStep(statuses: number[], body: string): Promise<{ code: number; output: string; requests: number }> {
  const step = find(deploy(), (candidate) => candidate.env?.SHELL_BUILD_URL !== undefined);
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const status = statuses[Math.min(requests++, statuses.length - 1)]!;
      return status === 302 ? new Response(null, { status, headers: { location: "/moved" } }) : new Response(body, { status });
    },
  });
  try {
    let result = { code: -1, output: "" };
    await withDir(async (dir) => {
      result = await runScript(step.run!.replace("sleep 5", "sleep 0"), dir, { SHELL_BUILD_URL: `http://127.0.0.1:${server.port}/build.json`, EXPECTED_REVISION: REVISION });
    });
    return { ...result, requests };
  } finally {
    await server.stop(true);
  }
}

const REVISION = "a".repeat(40);
const revisionBody = (revision: string): string => `${JSON.stringify({ revision })}\n`;

test("verification passes on a 200 that names the tag's revision", async () => {
  expect((await runVerifyStep([200], revisionBody(REVISION))).code).toBe(0);
}, 30_000);

test("verification retries a 503 and a 302 until a 2xx", async () => {
  const result = await runVerifyStep([503, 302, 201], revisionBody(REVISION));
  expect(result.code).toBe(0);
  expect(result.requests).toBe(3);
}, 30_000);

test("verification fails on a 302 after bounded retries and says the code", async () => {
  const result = await runVerifyStep([302], revisionBody(REVISION));
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
  expect(result.output).toContain("HTTP 302");
}, 30_000);

test("verification fails on a 200 that serves another revision", async () => {
  const result = await runVerifyStep([200], revisionBody("b".repeat(40)));
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
  expect(result.output).toContain("did not serve revision");
}, 30_000);

test("verification fails when only a nested revision matches the tag's", async () => {
  const result = await runVerifyStep([200], JSON.stringify({ revision: "b".repeat(40), metadata: { revision: REVISION } }));
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
}, 30_000);

test("verification fails on a body that is not JSON, even if it contains the revision", async () => {
  const result = await runVerifyStep([200], `<html>revision ${REVISION}</html>`);
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(12);
}, 30_000);

test("verification fails when the top-level revision is not a string", async () => {
  const result = await runVerifyStep([200], JSON.stringify({ revision: [REVISION] }));
  expect(result.code).not.toBe(0);
}, 30_000);
