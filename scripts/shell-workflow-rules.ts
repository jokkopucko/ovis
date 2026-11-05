// Rules shared by release.yml's and shell-preview.yml's hosted-shell jobs and their tests
// (scripts/shell-deploy-workflow.test.ts, scripts/shell-preview-workflow.test.ts).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; "working-directory"?: string; env?: Record<string, string>; with?: Record<string, string> }
export interface Job { needs?: string | string[]; if?: string; env?: Record<string, string>; "runs-on"?: unknown; environment?: string | { name: string; url?: string }; permissions?: Record<string, string>; outputs?: Record<string, string>; "timeout-minutes"?: number; uses?: string; steps?: Step[] }
export interface Workflow { on: Record<string, unknown>; env?: Record<string, string>; permissions?: Record<string, string>; jobs: Record<string, Job> }

export const root = join(dirname(new URL(import.meta.url).pathname), "..");
export const parseWorkflow = (path: string): Workflow => Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;

/** The only actions a job holding the Cloudflare token may use, each at its full commit SHA. */
export const DEPLOY_ACTIONS = [
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
];

const steps = (job: Job): Step[] => job.steps ?? [];
const label = (job: string, step: Step, index: number): string => `${job}.steps[${index}] (${step.name ?? step.uses ?? step.run?.split("\n")[0]})`;

/** Steps of any job that interpolate an expression into a script or hand a later step env or PATH entries. */
export function scriptProblems(workflow: Workflow): string[] {
  const problems: string[] = [];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    steps(job).forEach((step, index) => {
      if (step.run?.includes("${{")) problems.push(`${label(name, step, index)}: \${{ }} inside run`);
      if (/\$\{?GITHUB_(ENV|PATH)\b/.test(step.run ?? "")) problems.push(`${label(name, step, index)}: writes $GITHUB_ENV or $GITHUB_PATH`);
    });
  }
  return problems;
}

/** Scripts of `job` that leave a process running past their step: a `&` job, nohup, setsid or disown. */
export function backgroundProblems(name: string, job: Job): string[] {
  const problems: string[] = [];
  steps(job).forEach((step, index) => {
    const script = (step.run ?? "").replace(/&&/g, "").replace(/\d*>&\d*-?/g, "").replace(/&>/g, "");
    if (script.includes("&") || /\b(nohup|setsid|disown)\b/.test(script)) problems.push(`${label(name, step, index)}: starts a background process`);
  });
  return problems;
}

/** A job that may run next to a token: no checkout, no local action, only the allowed pinned actions. */
export function actionProblems(name: string, job: Job, allowed: string[]): string[] {
  const problems: string[] = [];
  steps(job).forEach((step, index) => {
    if (!step.uses) return;
    if (step.uses.startsWith("actions/checkout@")) problems.push(`${label(name, step, index)}: checks out the repository`);
    else if (step.uses.startsWith("./")) problems.push(`${label(name, step, index)}: runs a local action`);
    else if (!allowed.includes(step.uses)) problems.push(`${label(name, step, index)}: ${step.uses} is not an allowed pinned action`);
  });
  return problems;
}

/** Where the Cloudflare secrets reach in `workflow`, other than the given step of `deployJob`; `!= ''` presence checks are fine. */
export function secretProblems(workflow: Workflow, deployJob: string, deployStep: number): string[] {
  const problems: string[] = [];
  const holds = (value: unknown): boolean => JSON.stringify(value ?? {}).replace(/secrets\.CLOUDFLARE_\w+ != ''/g, "").includes("secrets.CLOUDFLARE_");
  if (holds(workflow.env)) problems.push("workflow env");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (holds(job.env)) problems.push(`${name} env`);
    steps(job).forEach((step, index) => {
      if (holds(step) && !(name === deployJob && index === deployStep)) problems.push(label(name, step, index));
    });
  }
  return problems;
}

/** Jobs that install packages (and so run their install scripts) without restoring the cache read-only. */
export function cacheProblems(workflow: Workflow): string[] {
  const problems: string[] = [];
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const setup = steps(job).filter((step) => step.uses === "./.github/actions/setup-ci");
    if (steps(job).some((step) => /\bbun (install|i)\b/.test(step.run ?? "")) && setup.length > 0 && setup.some((step) => step.with?.cache !== "restore")) {
      problems.push(`${name}: setup-ci may save the dependency cache`);
    }
  }
  return problems;
}

/** What identifies each step of a job: its name, else its action without the SHA, else its script. */
export const stepList = (job: Job): string[] => steps(job).map((step) => step.name ?? step.uses?.replace(/@.*/, "") ?? step.run!);

/** Runs `script` as GitHub runs a `run:` (`bash -e -o pipefail`) in `cwd` with `env` added to a minimal environment. */
export async function runScript(script: string, cwd: string, env: Record<string, string>): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", script], {
    cwd, stdout: "pipe", stderr: "pipe",
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: cwd, RUNNER_TEMP: cwd, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, output: stdout + stderr };
}

/** What the deploy's unpack step must refuse: a complete shell plus these files, this setup or these tar arguments. */
const REFUSED: Record<string, { files?: Record<string, string>; setup?: (src: string) => void; args?: string[] }> = {
  "a symlink": { setup: (src) => symlinkSync("/proc/self/environ", join(src, "environ.txt")) },
  "a hardlink": { setup: (src) => linkSync(join(src, "index.html"), join(src, "copy.html")) },
  "a FIFO": { setup: (src) => { Bun.spawnSync(["mkfifo", join(src, "pipe")]); } },
  "_worker.js at the top": { files: { "_worker.js": "export default {}" } },
  "_worker.js deeper down": { files: { "assets/_worker.js": "export default {}" } },
  "a _worker.js directory": { files: { "_worker.js/index.js": "export default {}" } },
  "functions/ at the top": { files: { "functions/index.js": "export function onRequest() {}" } },
  "a nested functions/": { files: { "assets/functions/a.js": "export function onRequest() {}" } },
  "_routes.json": { files: { "_routes.json": "{}" } },
  "a nested _routes.json": { files: { "assets/_routes.json": "{}" } },
  "../x": { files: { "x": "x" }, args: ["--transform", "s,^\\./x$,../x,"] },
  "/abs": { files: { "x": "x" }, args: ["-P", "--transform", "s,^\\./x$,/abs,"] },
};

/**
 * Runs the deploy's unpack step (`script`) against a clean dist-shell tarball and one per refused entry,
 * each with its right SHA-256, and returns each case's exit code and output.
 */
export async function unpackOutcomes(script: string): Promise<Record<string, { code: number; output: string }>> {
  const outcomes: Record<string, { code: number; output: string }> = {};
  for (const [name, refused] of [["a clean shell", {}], ...Object.entries(REFUSED)] as Array<[string, (typeof REFUSED)[string]]>) {
    const dir = mkdtempSync(join(tmpdir(), "shell-unpack-"));
    try {
      const src = join(dir, "src");
      const files = { "index.html": "<!doctype html>", "build.json": "{}\n", "assets/app.js": "", ...refused.files };
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(src, path)), { recursive: true });
        writeFileSync(join(src, path), body);
      }
      refused.setup?.(src);
      mkdirSync(join(dir, "shell"));
      const tarball = join(dir, "shell/dist-shell.tar.gz");
      const packed = Bun.spawnSync(["tar", "-czf", tarball, "-C", src, ...(refused.args ?? []), "."], { stderr: "pipe" });
      if (packed.exitCode !== 0) throw new Error(`${name}: ${packed.stderr.toString()}`);
      const digest = new Bun.CryptoHasher("sha256").update(readFileSync(tarball)).digest("hex");
      outcomes[name] = await runScript(script, dir, { EXPECTED_SHA256: digest });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return outcomes;
}
