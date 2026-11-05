import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface Step { name?: string; if?: string; run?: string; uses?: string; env?: Record<string, string>; "working-directory"?: string }
interface Workflow {
  on: { push: { branches: string[]; paths: string[] }; workflow_dispatch: unknown };
  jobs: { deploy: { "runs-on": unknown; environment: { name: string }; permissions: Record<string, string>; steps: Step[] } };
}

/** The workflow at `path` (default: the committed one), as parsed YAML. */
export const loadWorkflow = (path = process.env.RELAY_DEPLOY_WORKFLOW ?? new URL("../.github/workflows/relay-deploy.yml", import.meta.url).pathname): Workflow =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as Workflow;

test("relay deploy runs on a push to main touching relay/ and by hand", () => {
  const { on } = loadWorkflow();
  expect(on.push.branches).toEqual(["main"]);
  expect(on.push.paths).toEqual(["relay/**", "shared/relay-server-proof.ts"]);
  expect("workflow_dispatch" in on).toBe(true);
});

test("relay deploy runs for every file outside relay/ the Worker imports", () => {
  const { paths } = loadWorkflow().on.push;
  const sources = [...new Bun.Glob("relay/*.ts").scanSync()].filter((path) => !path.endsWith(".test.ts"));
  const outside = new Set<string>();
  for (const source of sources) {
    for (const [, target] of readFileSync(source, "utf8").matchAll(/from "(\.\.\/[^"]+)"/g)) outside.add(new URL(target!, `file:///${source}`).pathname.slice(1));
  }
  expect(outside.size).toBeGreaterThan(0);
  for (const path of outside) expect(paths).toContain(path);
});

test("relay deploy job waits in the production environment with read-only permissions", () => {
  const { deploy } = loadWorkflow().jobs;
  expect(deploy.environment.name).toBe("production");
  expect(deploy.permissions).toEqual({ contents: "read" });
});

test("relay deploy runs on a GitHub-hosted runner, never a self-hosted one", () => {
  expect(loadWorkflow().jobs.deploy["runs-on"]).toBe("ubuntu-24.04");
});

test("only the deploy step gets the Cloudflare secrets", () => {
  const { steps } = loadWorkflow().jobs.deploy;
  for (const secret of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    const holders = steps.filter((step) => Object.values(step.env ?? {}).some((value) => value.includes(`secrets.${secret}`) && !value.includes("!=")));
    expect(holders.map((step) => step.run?.startsWith("bunx wrangler@") && step.run.endsWith(" deploy"))).toEqual([true]);
  }
});

test("the deploy is skipped without the secrets and the health check follows it", () => {
  const { steps } = loadWorkflow().jobs.deploy;
  const guard = steps.findIndex((step) => step.env?.HAS_CLOUDFLARE_API_TOKEN !== undefined && step.env?.HAS_CLOUDFLARE_ACCOUNT_ID !== undefined);
  const deploy = steps.findIndex((step) => step.run?.includes("bunx wrangler"));
  const health = steps.findIndex((step) => step.run?.includes("curl") && step.run.includes("https://relay.ovis.sh/health"));
  expect(guard).toBeGreaterThanOrEqual(0);
  expect(deploy).toBeGreaterThan(guard);
  expect(health).toBeGreaterThan(deploy);
  const guardId = (steps[guard] as Step & { id?: string }).id;
  expect(steps[deploy]!.if).toContain(`steps.${guardId}.outputs.ready == 'true'`);
  expect(steps[deploy]!["working-directory"]).toBe("relay");
  expect(steps[deploy]!.env?.CLOUDFLARE_API_TOKEN).toContain("secrets.CLOUDFLARE_API_TOKEN");
  expect(steps[deploy]!.env?.CLOUDFLARE_ACCOUNT_ID).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
  expect(steps[health]!.if).toContain(`steps.${guardId}.outputs.ready == 'true'`);
});

/** Runs the health step's script through `bash -e` against a local server that answers each request with the next status. */
async function runHealthStep(statuses: number[]): Promise<{ code: number; output: string; requests: number }> {
  const step = loadWorkflow().jobs.deploy.steps.find((candidate) => candidate.run?.includes("curl"))!;
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      const status = statuses[Math.min(requests++, statuses.length - 1)]!;
      return status === 302 ? new Response(null, { status, headers: { location: "/moved" } }) : new Response("ok", { status });
    },
  });
  try {
    const script = step.run!.replace("https://relay.ovis.sh/health", `http://127.0.0.1:${server.port}/health`).replace("sleep 5", "sleep 0");
    const child = Bun.spawn(["bash", "-e", "-c", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, output: stdout + stderr, requests };
  } finally {
    await server.stop(true);
  }
}

test("the health step passes on a 200", async () => {
  expect((await runHealthStep([200])).code).toBe(0);
}, 30_000);

test("the health step passes once a retry gets a 2xx", async () => {
  const result = await runHealthStep([503, 302, 204]);
  expect(result.code).toBe(0);
  expect(result.requests).toBe(3);
}, 30_000);

test("the health step fails on a 302 and says the code", async () => {
  const result = await runHealthStep([302]);
  expect(result.code).not.toBe(0);
  expect(result.requests).toBe(5);
  expect(result.output).toContain("HTTP 302");
}, 30_000);

test("the deploy runs one exact Wrangler version, not whatever bunx resolves", () => {
  const deploy = loadWorkflow().jobs.deploy.steps.find((step) => step.run?.includes("bunx wrangler"))!;
  expect(deploy.run).toMatch(/^bunx wrangler@\d+\.\d+\.\d+ deploy$/);
});

test("the relay's own tests run before the deploy", () => {
  const { steps } = loadWorkflow().jobs.deploy;
  const tests = steps.findIndex((step) => step.run === "bun test ./relay");
  expect(tests).toBeGreaterThanOrEqual(0);
  expect(tests).toBeLessThan(steps.findIndex((step) => step.run?.includes("bunx wrangler")));
});
