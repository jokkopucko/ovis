import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./typecheck.ts", import.meta.url));
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ovis-typecheck-"));
  // A compiler stand-in at Bun's command boundary records each child's actual environment.
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { tsc: "bun compiler.ts" } }));
  writeFileSync(join(cwd, "compiler.ts"), `
    const project = process.argv.includes("-p") ? "tools" : "main";
    console.log(JSON.stringify({ project, args: process.argv.slice(2),
      GOGC: process.env["GOGC"], GOMAXPROCS: process.env["GOMAXPROCS"],
      GOMEMLIMIT: process.env["GOMEMLIMIT"],
      marker: process.env["TYPECHECK_MARKER"] }));
    if (process.env["FAIL_PROJECT"] === project) process.exit(2);
  `);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function run(settings: Record<string, string> = {}) {
  const env = { ...process.env };
  delete env["GOGC"];
  delete env["GOMAXPROCS"];
  delete env["GOMEMLIMIT"];
  delete env["FAIL_PROJECT"];
  const result = Bun.spawnSync([process.execPath, script], {
    cwd, env: { ...env, TYPECHECK_MARKER: "inherited", ...settings }, timeout: 5_000,
  });
  return {
    code: result.exitCode,
    records: result.stdout.toString().trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

it.each([
  [{}, "off", String(Math.min(32, availableParallelism())), "8GiB"],
  [{ GOGC: "100" }, "100", String(Math.min(32, availableParallelism())), "8GiB"],
  [{ GOMAXPROCS: "8" }, "off", "8", "8GiB"],
  [{ GOMEMLIMIT: "1GiB" }, "off", String(Math.min(32, availableParallelism())), "1GiB"],
  [{ GOGC: "off", GOMAXPROCS: "4", GOMEMLIMIT: "2GiB" }, "off", "4", "2GiB"],
  [{ GOGC: "", GOMAXPROCS: "", GOMEMLIMIT: "" }, "", "", ""],
] satisfies [Record<string, string>, string, string, string][])(
  "passes Go defaults and caller overrides to both compiler processes: %j",
  (settings, GOGC, GOMAXPROCS, GOMEMLIMIT) => {
    const result = run(settings);
    expect(result.code).toBe(0);
    expect(result.records).toEqual([
      { project: "main", args: ["--noEmit"], GOGC, GOMAXPROCS, GOMEMLIMIT, marker: "inherited" },
      { project: "tools", args: ["--noEmit", "-p", "tsconfig.tools.json"], GOGC, GOMAXPROCS, GOMEMLIMIT, marker: "inherited" },
    ].map((record) => JSON.parse(JSON.stringify(record))));
  },
);

it.each(["main", "tools"])("preserves a failing %s compiler's exit code and stops", (project) => {
  const result = run({ FAIL_PROJECT: project });
  expect(result.code).toBe(2);
  expect(result.records.map((record) => record.project)).toEqual(project === "main" ? ["main"] : ["main", "tools"]);
});
