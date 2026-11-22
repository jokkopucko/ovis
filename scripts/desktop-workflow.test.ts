import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Step { name?: string; run?: string; env?: Record<string, string> }
interface Workflow { jobs: { build: { steps: Step[] } } }

const workflow = Bun.YAML.parse(readFileSync(fileURLToPath(new URL("../.github/workflows/desktop.yml", import.meta.url)), "utf8")) as Workflow;
const build = workflow.jobs.build.steps.find((step) => step.name?.startsWith("Build "))!;
const signing = ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"];

const seenByDist = (env: Record<string, string>): string[] => {
  const stub = `bun() { for name in ${signing.join(" ")}; do [ "\${!name+set}" = set ] && echo "$name"; done; return 0; }`;
  const run = Bun.spawnSync(["bash", "-e", "-c", `${stub}\n${build.run}`], { env: { PATH: process.env.PATH ?? "", ...env } });
  expect(run.exitCode).toBe(0);
  return run.stdout.toString().split("\n").filter(Boolean);
};

test("the build step passes every signing variable it sets", () => {
  expect(Object.keys(build.env ?? {})).toEqual(expect.arrayContaining(signing));
});

test("a build with signing off gives electron-builder no empty signing variables", () => {
  expect(seenByDist(Object.fromEntries(signing.map((name) => [name, ""])))).toEqual([]);
});

test("a build with signing on keeps its certificate and password", () => {
  expect(seenByDist({ CSC_LINK: "mac.p12", CSC_KEY_PASSWORD: "pass", WIN_CSC_LINK: "", WIN_CSC_KEY_PASSWORD: "" })).toEqual(["CSC_LINK", "CSC_KEY_PASSWORD"]);
  expect(seenByDist({ CSC_LINK: "", CSC_KEY_PASSWORD: "", WIN_CSC_LINK: "win.pfx", WIN_CSC_KEY_PASSWORD: "pass" })).toEqual(["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]);
});
