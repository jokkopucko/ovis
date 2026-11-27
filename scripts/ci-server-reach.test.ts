import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { root } from "./shell-workflow-rules.ts";

type Job = { if?: string; steps?: { run?: string }[] };
const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job & { outputs?: Record<string, string> }> };
const SERVER_JOBS = ["herdr-core-live", "macos-session", "rust-pty-host"];
const SERVER = "needs.changes.outputs.code == 'true' && needs.changes.outputs.server != 'false'";

function reach(...paths: string[]): string {
  const result = spawnSync("bash", [join(root, "scripts/ci-server-reach.sh")], { input: paths.map((path) => `${path}\n`).join(""), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("a pull request's reach into the server-side jobs", () => {
  it.each([
    ["the server", ["server/index.ts"]],
    ["the wire contract", ["shared/protocol.ts"]],
    ["the terminal client", ["tui/core/pane.ts"]],
    ["the PTY host and the ACP keeper", ["crates/pty-sidecar/src/main.rs"], ["crates/acp-keeper/src/main.rs"]],
    ["a script", ["scripts/install-herdr-core.ts"]],
    ["a dependency", ["bun.lock"], ["package.json"]],
    ["ci.yml and the action its jobs set up with", [".github/workflows/ci.yml"], [".github/actions/setup-ci/action.yml"]],
    ["the client build's config", ["vite.config.ts"]],
    ["the client's account and relay code, which the ovis command shares", ["src/lib/account/store.ts"], ["src/lib/relay/new.ts"], ["src/lib/nativeApp.ts"], ["src/lib/shellMode.ts"]],
    ["the docs", ["docs/development.md"]],
    ["a folder the list does not name", ["plugins/new/index.ts"]],
    ["a folder's own name, which is no path inside it", ["src"]],
    ["a name git quotes", ["\"src/\\303\\251.ts\""]],
    ["one reaching path among client ones", ["src/App.tsx", "server/index.ts", "src/styles.css"]],
    ["no path at all", []],
  ])("keeps them for %s", (_, ...lists) => {
    for (const paths of lists as string[][]) expect(reach(...paths)).toBe("server=true\n");
  });

  it.each([
    ["the client", ["src/App.tsx", "src/components/Sidebar.tsx", "src/styles.css", "src/lib/i18n/ko.ts"]],
    ["the client's tests", ["src/components/Sidebar.test.tsx"]],
    ["its static files and page", ["public/manifest.webmanifest", "index.html"]],
    ["a changelog fragment beside the client", ["changelog.d/fix.md", "src/App.tsx"]],
  ])("leaves them out for %s", (_, paths) => {
    expect(reach(...paths)).toBe("server=false\n");
  });

  it("reads a last line that has no newline", () => {
    const result = spawnSync("bash", [join(root, "scripts/ci-server-reach.sh")], { input: "src/App.tsx\nserver/index.ts", encoding: "utf8" });
    expect(result.stdout).toBe("server=true\n");
  });

  function filesTheJobsTestsLoad(): Map<string, string> {
    const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }), js: new Bun.Transpiler({ loader: "js" }) };
    const from = new Map<string, string>();
    const queue: string[] = [];
    const add = (file: string, by: string): void => {
      if (!from.has(file)) { from.set(file, by); queue.push(file); }
    };
    const tests = (path: string): string[] => statSync(join(root, path)).isDirectory()
      ? readdirSync(join(root, path), { recursive: true, encoding: "utf8" }).filter((name) => /\.test\.tsx?$/.test(name)).map((name) => join(path, name))
      : [path];
    for (const id of SERVER_JOBS) {
      for (const step of ci.jobs[id]!.steps ?? []) {
        for (const line of (step.run ?? "").split("\n")) {
          for (const word of line.split(/[\s"()]+/)) {
            const path = normalize(word.replace(/^\.\//, ""));
            if (/^(server|shared|scripts|tui|src)\//.test(path) && existsSync(join(root, path))) for (const test of tests(path)) add(test, `ci.yml ${id}`);
          }
        }
      }
    }
    while (queue.length > 0) {
      const file = queue.shift()!;
      const loader = file.endsWith(".tsx") ? "tsx" : file.endsWith(".ts") ? "ts" : /\.m?js$/.test(file) ? "js" : undefined;
      if (loader === undefined) continue;
      const text = readFileSync(join(root, file), "utf8");
      // files read at run time beside the file: new URL("<path>", import.meta.url), join/resolve(import.meta.dir, "<part>", ...)
      const runtime = [...text.matchAll(/new URL\(\s*["'`]([^"'`$]+)["'`]\s*,\s*import\.meta\.url/g)].map((match) => match[1]!)
        .concat([...text.matchAll(/\b(?:join|resolve)\(\s*import\.meta\.dir((?:\s*,\s*["'`][^"'`$]+["'`])+)/g)].map((match) => [...match[1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((part) => part[1]!).join("/")));
      for (const path of runtime) {
        const read = relative(root, join(root, dirname(file), path));
        if (read.startsWith("..") || !existsSync(join(root, read))) continue;
        if (statSync(join(root, read)).isDirectory()) from.set(`${read}/x`, file); else add(read, file);
      }
      for (const { path } of transpilers[loader].scanImports(text.replace(/^#!.*/, ""))) {
        if (!path.startsWith(".")) continue;
        const base = join(dirname(file), path);
        const found = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((candidate) => existsSync(join(root, candidate)) && statSync(join(root, candidate)).isFile());
        if (found) add(relative(root, join(root, found)), file);
      }
    }
    return from;
  }

  it("leaves out no file that the jobs' tests load", () => {
    const files = filesTheJobsTestsLoad();
    expect(files.has("server/fixtures/acp/keeper.jsonl"), "a fixture a test reads through new URL(..., import.meta.url) is counted").toBe(true);
    expect(files.size).toBeGreaterThan(300);
    for (const id of SERVER_JOBS) expect([...files.values()].some((by) => by === `ci.yml ${id}`), `found no bun test of ${id} in ci.yml`).toBe(true);
    const result = spawnSync("bash", ["-c", "while IFS= read -r path; do printf '%s\\n' \"$path\" | bash \"$0\" | grep -q server=false && echo \"$path\"; done; true", join(root, "scripts/ci-server-reach.sh")], { input: [...files.keys()].map((path) => `${path}\n`).join(""), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const leftOut = result.stdout.split("\n").filter((path) => path !== "").map((path) => `${path} (loaded by ${files.get(path)})`);
    expect(leftOut, "A test of a server-side job loads a file that scripts/ci-server-reach.sh leaves out, so a pull request changing only that file would skip the job that tests it: take the path out of the script's list").toEqual([]);
  });
});

describe("ci.yml and the server-side jobs a change cannot reach", () => {
  it("gives bun test only paths from the repository's root, which match no file of the client's", () => {
    // bun test's bare filter (server/acp) also selects src/lib/server/acp-view.test.ts: ./server/acp does not
    const bare = SERVER_JOBS.flatMap((id) => (ci.jobs[id]!.steps ?? []).flatMap((step) => (step.run ?? "").split("\n")))
      .flatMap((line) => line.split(/[\s"()]+/)).filter((word) => /^(server|shared|scripts|tui|src)\//.test(word));
    expect(bare).toEqual([]);
  });

  it("skips only those jobs by the change's reach, and every other event keeps them", () => {
    for (const id of SERVER_JOBS) expect([id, ci.jobs[id]!.if]).toEqual([id, SERVER]);
    expect(Object.entries(ci.jobs).filter(([, job]) => (job.if ?? "").includes("outputs.server")).map(([id]) => id).sort()).toEqual(SERVER_JOBS);
    expect(ci.jobs["changes"]!.outputs!["server"]).toBe("${{ steps.filter.outputs.server }}");
    const filter = ci.jobs["changes"]!.steps!.find((step) => (step.run ?? "").includes("ci-server-reach.sh"))!.run!;
    // the script is read after the early exits of every event but a pull request's, which leave server unset: the jobs run
    expect(filter.indexOf("bash scripts/ci-server-reach.sh")).toBeGreaterThan(filter.lastIndexOf("exit 0"));
    expect(filter).toContain('printf \'%s\\n\' "$CHANGED" | bash scripts/ci-server-reach.sh >> "$GITHUB_OUTPUT"');
  });
});
