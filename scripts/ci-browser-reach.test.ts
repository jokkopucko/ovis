import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { demoOnlyScripts, importClosure, serialBrowserScripts } from "./ci-browser-parallel.ts";
import { root, runScript } from "./shell-workflow-rules.ts";

type Job = { if?: string; needs?: string | string[]; steps?: { name?: string; run?: string; env?: Record<string, string> }[] };
const ci = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };
const BROWSER = "needs.changes.outputs.code == 'true' && needs.changes.outputs.browser != 'false'";

function reach(...paths: string[]): string {
  const result = spawnSync("bash", [join(root, "scripts/ci-browser-reach.sh")], { input: paths.map((path) => `${path}\n`).join(""), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/** Every existing path the files name in a string literal, or build from literal parts in join() or resolve(), with the files naming it. */
function namedPaths(sources: string[]): Map<string, Set<string>> {
  const named = new Map<string, Set<string>>();
  const name = (literal: string, file: string): void => {
    const path = literal.replace(/^(\.\.?\/)+/, "").replace(/^\//, "").replace(/\/$/, "");
    for (const candidate of [path, `${dirname(file)}/${path}`].map((written) => posix.normalize(written))) {
      if (path === "" || candidate === "." || candidate.startsWith("..") || !existsSync(join(root, candidate))) continue;
      const key = statSync(join(root, candidate)).isDirectory() ? `${candidate}/x` : candidate;
      (named.get(key) ?? named.set(key, new Set()).get(key)!).add(file);
    }
  };
  const LITERAL = /["'`]([A-Za-z0-9_.@/-]{1,120})["'`]/g;
  for (const file of sources) {
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(LITERAL)) name(match[1]!, file);
    for (const call of text.matchAll(/\b(?:join|resolve)\(/g)) {
      let depth = 1;
      let end = call.index + call[0].length;
      for (; depth > 0 && end < text.length; end++) depth += text[end] === "(" ? 1 : text[end] === ")" ? -1 : 0;
      const parts = [...text.slice(call.index + call[0].length, end - 1).matchAll(LITERAL)].map((match) => match[1]!);
      for (let from = 0; from < parts.length; from++) for (let to = from + 2; to <= parts.length; to++) name(parts.slice(from, to).join("/"), file);
    }
  }
  return named;
}

describe("a pull request's reach into the browser jobs", () => {
  const KEPT: [string, string[][]][] = [
    ["the client", [["src/App.tsx"]]],
    ["the server beside the client", [["server/index.ts", "src/App.tsx"]]],
    ["the wire contract", [["shared/protocol.ts"]]],
    ["a browser script", [["scripts/sidebar-filter-demo-regression.ts"]]],
    ["the demo", [["site/demo/transport.ts"]]],
    ["the relay", [["relay/src/worker.ts"]]],
    ["the desktop app", [["app/electron/src/browserTabs.ts"]]],
    ["the PTY host", [["crates/pty-sidecar/src/main.rs"]]],
    ["a dependency", [["bun.lock"]]],
    ["ci.yml itself", [[".github/workflows/ci.yml"]]],
    ["the action its jobs set up with", [[".github/actions/setup-ci/action.yml"]]],
    ["this script", [["scripts/ci-browser-reach.sh"]]],
    ["a server fixture, a test file among them", [["server/fixtures/prompt.txt"], ["server/fixtures/case.test.ts"], ["server/index.ts", "server/fixtures/prompt.txt"]]],
    ["the server beside the wire contract or a folder the list does not name", [["shared/protocol.ts", "server/index.ts"], ["server/index.ts", "plugins/new/index.ts"]]],
    ["the release summaries the server reads for its update notes", [["release-summaries.json"]]],
    ["a docs page a browser script reads its example from, beside a unit test", [["docs/themes.md", "server/access.test.ts"]]],
    ["the notices the client build bundles", [["THIRD_PARTY_NOTICES.md", "server/access.test.ts"]]],
    ["the worker folder a browser script copies", [["telemetry/src/worker.ts"]]],
    ["the attributes that decide how every script is checked out", [[".gitattributes"]]],
    ["a folder the list does not name", [["plugins/new/index.ts"]]],
    ["a test file in a folder a browser script takes in whole", [["scripts/skill-menu-cases/codex-helper.test.ts"], ["public/render.html/example.test.ts"], ["public/demo-transport.js/smoke.test.ts"]]],
    ["a test file outside the folders unit tests live in", [[".env-cache.test.ts"], ["shared/copy.test.tsx"], ["app/electron/src/tabs.test.ts"], ["site/demo/transport.test.ts"]]],
    ["a folder's own name, which is no path inside it", [["tui"]]],
    ["a name git quotes", [["\"docs/\\303\\251.md\""]]],
    ["one reaching path among others that do not", [["tui/src/main.zig", "changelog.d/fix.md", "src/lib/api.ts"]]],
    ["no path at all", [[]]],
  ];
  it.each(KEPT)("keeps them for %s", (_, lists) => {
    for (const paths of lists) expect(reach(...paths)).toBe("browser=true\n");
  });

  it.each([
    ["unit tests", ["server/relay/service.test.ts", "src/components/Sidebar.test.tsx", "scripts/ci-runner-route.test.ts", "integrations/gjc.test.ts"]],
    ["the terminal client", ["tui/src/main.zig", "crates/ovis-tui/src/main.rs"]],
    ["the push worker and the site", ["push-relay/src/index.ts", "ovis-site/index.html"]],
    ["the phone and native apps' own folders", ["app/android/app/build.gradle", "app/ios/App/Info.plist", "app/windows/Program.cs", "app/mac/Ovis.swift", "app/store/listing.json"]],
    ["the installers", ["install.sh", "install.ps1"]],
    ["the runner launcher", ["scripts/self-hosted-runner/run.sh"]],
    ["another workflow", [".github/workflows/beta.yml", ".github/workflows/remote-bundles.yml"]],
    ["a changelog fragment beside a unit test", ["changelog.d/fix.md", "server/store.test.ts"]],
  ])("leaves them out for %s", (_, paths) => {
    expect(reach(...paths)).toBe("browser=false\n");
  });

  it.each([
    ["the server", ["server/index.ts"]],
    ["a helper of tests a live script may load", ["server/relay/test-helpers.ts"]],
    ["the server beside paths that cannot reach the jobs", ["tui/src/main.zig", "server/http.ts", "changelog.d/fix.md", "server/http.test.ts"]],
  ])("runs only the scripts that can load the server for %s", (_, paths) => {
    expect(reach(...paths)).toBe("browser=live\n");
  });

  it("reads a last line that has no newline", () => {
    const result = spawnSync("bash", [join(root, "scripts/ci-browser-reach.sh")], { input: "tui/src/main.zig\nsrc/App.tsx", encoding: "utf8" });
    expect(result.stdout).toBe("browser=true\n");
  });

  const NAMED_NOT_READ: Record<string, string[]> = {
    "scripts/conventions.test.ts": ["scripts/demo-server.ts"],
  };

  it("leaves out no path that a browser job's script names", () => {
    const lane = serialBrowserScripts();
    const sources = [...new Set([...lane, "vite.config.ts", "scripts/build-cache.ts", "scripts/ci-browser-parallel.ts", "scripts/ci-browser.sh", "scripts/demo-server.ts", "scripts/test-herdr.ts", "scripts/test-shell.ts", "scripts/ci-chromium.sh", "scripts/ci-ffmpeg.sh", "scripts/check.ts"])].filter((file) => existsSync(join(root, file)));
    expect(lane.length).toBeGreaterThan(100);
    const named = namedPaths(sources);
    for (const script of lane) (named.get(script) ?? named.set(script, new Set()).get(script)!).add("scripts/ci-browser.sh");
    expect(named.has("scripts/fixtures/file-preview.webm"), "a path built from parts is read too").toBe(true);
    const paths = [...named.keys()];
    const result = spawnSync("bash", ["-c", "while IFS= read -r path; do printf '%s\\n' \"$path\" | bash \"$0\" | grep -q browser=false && echo \"$path\"; done; true", join(root, "scripts/ci-browser-reach.sh")], { input: paths.map((path) => `${path}\n`).join(""), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const leftOut = result.stdout.split("\n").filter((path) => path !== "");
    const unexplained = leftOut.flatMap((path) => [...named.get(path)!].filter((file) => !(NAMED_NOT_READ[path] ?? []).includes(file)).map((file) => `${path} (named in ${file})`));
    expect(unexplained, "A browser job's script names a path that scripts/ci-browser-reach.sh leaves out, so a pull request changing only that path would skip the job that reads it. Take the path out of the script's list, or, when that script only names it and never reads it, list the script under the path in NAMED_NOT_READ here.").toEqual([]);
    const stale = Object.entries(NAMED_NOT_READ).flatMap(([path, files]) => files.filter((file) => !leftOut.includes(path) || !named.get(path)!.has(file)).map((file) => `${path}: ${file}`));
    expect(stale, "These scripts no longer name these paths, or the paths are no longer left out: remove them from NAMED_NOT_READ.").toEqual([]);
  });
  it("leaves out, for a change to the server alone, no script that loads or names a file of the server", () => {
    const demoOnly = demoOnlyScripts(serialBrowserScripts());
    expect(demoOnly.length).toBeGreaterThan(100);
    for (const live of ["scripts/pane-mute-demo-regression.ts", "scripts/agent-skill-menu-demo-regression.ts", "scripts/boot-loading-demo-regression.ts", "scripts/core-kept-grid-demo-regression.ts"]) {
      expect(demoOnly).not.toContain(live);
    }
    const loaded = new Set(demoOnly.flatMap((script) => [...importClosure(root, script).files]));
    expect([...loaded].filter((file) => file.startsWith("server/")), "A script left out for a server-only change loads a file of the server").toEqual([]);
    const named = namedPaths([...loaded].filter((file) => file.startsWith("scripts/")));
    expect([...named.keys()].filter((path) => path.startsWith("server/")), "A script left out for a server-only change names a file of the server").toEqual([]);
  });
});

describe("ci.yml and the browser jobs a change cannot reach", () => {
  it("skips only the two browser jobs, and only by the change's reach", () => {
    expect(ci.jobs["browser-main"]!.if).toBe(BROWSER);
    expect(ci.jobs["browser-other"]!.if).toBe(BROWSER);
    expect(Object.entries(ci.jobs).filter(([, job]) => (job.if ?? "").includes("outputs.browser")).map(([id]) => id)).toEqual(["browser-main", "browser-other"]);
    expect(ci.jobs["integration-browser"]!.needs).toEqual(["changes", "integration", "browser-main", "browser-other"]);
  });

  it("leaves the demo-only scripts out of the other scripts' jobs alone, and only for a change to the server alone", () => {
    const env = (job: string) => ci.jobs[job]!.steps!.filter((step) => step.run?.includes("scripts/ci-browser-parallel.ts")).map((step) => step.env?.["BROWSER_LIVE_ONLY"]);
    expect(env("browser-other")).toEqual(["${{ github.workflow == 'CI' && needs.changes.outputs.browser == 'live' }}"]);
    expect(env("browser-main")).toEqual([undefined]);
  });

  const verdict = async (env: Record<string, string>): Promise<number> => {
    const check = ci.jobs["integration-browser"]!.steps!.find((step) => step.name === "Check results")!;
    return (await runScript(check.run!, tmpdir(), { CODE: "true", DRAFT: "false", BROWSER: "true", INTEGRATION_RESULT: "success", BROWSER_MAIN_RESULT: "success", BROWSER_OTHER_RESULT: "success", ...env })).code;
  };
  const SKIPPED = { BROWSER_MAIN_RESULT: "skipped", BROWSER_OTHER_RESULT: "skipped" };

  it("passes the required check on skipped browser jobs only when the change cannot reach them", async () => {
    expect(await verdict({})).toBe(0);
    expect(await verdict({ BROWSER: "false", ...SKIPPED })).toBe(0);
    expect(await verdict({ BROWSER: "true", ...SKIPPED })).toBe(1);
    expect(await verdict({ BROWSER: "", ...SKIPPED })).toBe(1);
    expect(await verdict({ BROWSER: "False", ...SKIPPED })).toBe(1);
  });

  it("asks the browser jobs to pass when only the scripts that can load the server ran", async () => {
    expect(await verdict({ BROWSER: "live" })).toBe(0);
    expect(await verdict({ BROWSER: "live", ...SKIPPED })).toBe(1);
    expect(await verdict({ BROWSER: "live", BROWSER_OTHER_RESULT: "failure" })).toBe(1);
    expect(await verdict({ BROWSER: "live", BROWSER_MAIN_RESULT: "cancelled" })).toBe(1);
  });

  it("fails it when a browser job that was to be skipped ended any other way, or the integration tests did not pass", async () => {
    expect(await verdict({ BROWSER: "false", BROWSER_MAIN_RESULT: "failure", BROWSER_OTHER_RESULT: "skipped" })).toBe(1);
    expect(await verdict({ BROWSER: "false", BROWSER_MAIN_RESULT: "skipped", BROWSER_OTHER_RESULT: "cancelled" })).toBe(1);
    expect(await verdict({ BROWSER: "false", BROWSER_MAIN_RESULT: "success", BROWSER_OTHER_RESULT: "skipped" })).toBe(1);
    expect(await verdict({ BROWSER: "false", ...SKIPPED, INTEGRATION_RESULT: "failure" })).toBe(1);
    expect(await verdict({ BROWSER: "false", ...SKIPPED, INTEGRATION_RESULT: "skipped" })).toBe(1);
    expect(await verdict({ BROWSER: "false", ...SKIPPED, DRAFT: "true" })).toBe(1);
  });
});
