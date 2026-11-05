import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialBrowserScripts } from "./ci-browser-parallel.ts";

// Exercise the whole lane without installing Chromium, building, or opening a browser.
const stub = `
bun() {
  case "$1" in
    scripts/demo-build.ts) printf 'DEMO_DIR=%s\\n' "$HERDR_DEMO_BUILD";;
    scripts/*)
      [ "\${CHROME_PATH:-}" = /stub/chrome ] || return 91
      [ "\${FFMPEG:-}" = /stub/ffmpeg ] || return 92
      printf 'PASS stubbed browser step\\nFAIL stubbed browser marker\\nSERVER listening on http://127.0.0.1:3000\\nSTEP=%s EVIDENCE=%s\\n' "$1" "\${UI_EVIDENCE_DIR:-}";;
  esac
  if [ "$1" = "\${FAIL_SCRIPT:-}" ]; then return 7; fi
}
sudo() { return 0; }
bash() {
  if [ "$#" -eq 1 ] && [ "$1" = scripts/ci-chromium.sh ]; then
    printf '/stub/chrome\\n'
  elif [ "$#" -eq 1 ] && [ "$1" = scripts/ci-ffmpeg.sh ]; then
    printf '/stub/ffmpeg\\n'
  else
    command bash "$@"
  fi
}
source "$1"
`;

/**
 * A hang guard, not a speed check: the stubbed lane still forks a few processes for every browser
 * script, and took up to 5 s on a host at load 100 of 128 cores, where a 5 s limit killed it (#2110).
 * Each lane test gets the guard and room to report what the lane printed. The guard ends the lane and
 * every process under it (ending only its bash leaves the script's pipeline running), then stops
 * reading and fails with what was printed: it never waits for the output to close, which a process
 * the lane left behind can hold open. The lane stays in the test's own process group, which
 * scripts/ci-tests.ts ends when the file finishes or the run is interrupted, so such a process goes
 * with it.
 */
const LANE_HANG_MS = 60_000;
const LANE_TEST_MS = LANE_HANG_MS + 10_000;
const inheritedEnv = () => Object.fromEntries(
  ["HOME", "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []),
);

/** Ends `pid` and every process under it, read from the process table before any is ended. */
async function endTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited;
    return;
  }
  const table = await new Response(Bun.spawn(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" }).stdout).text();
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [own, parent] = line.trim().split(/\s+/).map(Number);
    if (own && parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), own]);
  }
  const tree: number[] = [];
  for (const pending = [pid]; pending.length > 0;) {
    const next = pending.pop()!;
    tree.push(next);
    pending.push(...(children.get(next) ?? []));
  }
  for (const member of tree) try { process.kill(member, "SIGKILL"); } catch { /* already gone */ }
}

async function lane(fail = "", kept = false, ci = "") {
  const dir = mkdtempSync(join(tmpdir(), "hwc-browser-test-"));
  try {
    const child = Bun.spawn(["bash", "-c", stub, "stub", join(import.meta.dir, "ci-browser.sh")], {
      cwd: dir,
      env: { ...inheritedEnv(), BROWSER_PARALLEL: "", CI: ci, CHECK_DIR: kept ? dir : "", UI_EVIDENCE_DIR: "", FAIL_SCRIPT: fail, TMPDIR: dir },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    // read as it comes, so what the lane printed is there even when the guard stops reading
    const readers = [child.stdout.getReader(), child.stderr.getReader()];
    const printed = ["", ""];
    const drained = Promise.all(readers.map(async (reader, index) => {
      const decoder = new TextDecoder();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) printed[index] += decoder.decode(chunk.value, { stream: true });
    }));
    const ended = Promise.withResolvers<void>();
    let hung = false;
    const guard = setTimeout(() => {
      hung = true;
      // only a lane whose bash still runs: once it has exited, its pid may name another process
      const running = child.exitCode === null && child.signalCode === null;
      void (running ? endTree(child.pid) : Promise.resolve()).finally(() => {
        for (const reader of readers) reader.cancel().catch(() => {});
        ended.resolve();
      });
    }, LANE_HANG_MS);
    await Promise.race([Promise.all([drained, child.exited]), ended.promise]).finally(() => clearTimeout(guard));
    const [text, error] = printed as [string, string];
    if (hung) throw new Error(`the stubbed lane's output did not end within ${LANE_HANG_MS / 1000} s; what it printed:\n${text}`);
    const code = await child.exited;
    expect(error).toBe("");
    const demo = text.match(/^\[[^\]]+\] DEMO_DIR=(.+)$/m)?.[1];
    expect(demo).toBeDefined();
    expect(existsSync(demo ?? "")).toBe(false);
    return { text, code, evidence: existsSync(join(dir, kept ? "" : ".ci", "browser-evidence")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (text: string) => [...text.matchAll(/^(scripts\/\S+)\s+(\d+)\s+(\d+)$/gm)].map((row) => ({
  script: row[1], seconds: Number(row[2]), code: Number(row[3]),
}));

describe("browser lane", () => {
  it("fails each workflow ffmpeg step when the pinned binary cannot be fetched", async () => {
    const workflow = Bun.YAML.parse(readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
    };
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps)
      .filter((step) => step.name === "Pinned ffmpeg for the relay media run");
    // the browser lane's; the relay-skew job, which had the other, returns once a release holds server/relay/
    expect(steps).toHaveLength(1);
    for (const step of steps) {
      const dir = mkdtempSync(join(tmpdir(), "hwc-ffmpeg-step-"));
      try {
        const githubEnv = join(dir, "env");
        const child = Bun.spawn(["bash", "-e", "-c", `bash() { return 1; }\n${step.run}`], {
          cwd: dir, env: { ...inheritedEnv(), GITHUB_ENV: githubEnv },
          stdout: "ignore", stderr: "ignore",
        });
        expect(await child.exited).toBe(1);
        expect(existsSync(githubEnv)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("summarizes passing and failing scripts and stops at the original exit code", async () => {
    const { text, code } = await lane("scripts/sticky-modifiers-regression.ts");
    expect(code).toBe(7);
    expect(rows(text)).toEqual([
      { script: "scripts/demo-build.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/ui-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/ui-contexts-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/machine-events-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/workspace-rows-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/pending-pane-switch-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/lan-exposure-notice-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/terminal-dispose-browser-qa.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/herdr-restart-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/sticky-modifiers-regression.ts", seconds: expect.any(Number), code: 7 },
    ]);
    expect(text).not.toMatch(/STEP=scripts\/key-bar-customization-demo-regression\.ts/);
    expect(text).toMatch(/^TIMING scripts\/sticky-modifiers-regression\.ts seconds=\d+ exit=7$/m);
    expect(text).toMatch(/^scripts\/sticky-modifiers-regression\.ts\s+\d+\s+7$/m);
    expect(text).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] SERVER listening on http:\/\/127\.0\.0\.1:3000$/m);
    expect(text).toMatch(/^PASS stubbed browser step$/m);
    expect(text).toMatch(/^FAIL stubbed browser marker$/m);
    expect(text).toMatch(/^Browser lane total: seconds=\d+ exit=7$/m);
  }, LANE_TEST_MS);

  it("summarizes every script and exits zero on success without enabling local evidence", async () => {
    const { text, code, evidence } = await lane();
    expect(code).toBe(0);
    expect(rows(text).map((row) => row.script)).toEqual(["scripts/demo-build.ts", ...serialBrowserScripts()]);
    expect(rows(text).map((row) => row.script)).toContain("scripts/copilot-chat-browser-qa.ts");
    expect(rows(text).every((row) => row.code === 0 && row.seconds >= 0)).toBe(true);
    expect(evidence).toBe(false);
    expect(text).not.toMatch(/EVIDENCE=.+/);
    expect(text).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] SERVER listening on http:\/\/127\.0\.0\.1:3000$/m);
    expect(text).toMatch(/^PASS stubbed browser step$/m);
    expect(text).toMatch(/^FAIL stubbed browser marker$/m);
  }, LANE_TEST_MS);

  it("keeps only cheap existing screenshots when CHECK_DIR is set", async () => {
    const { text, code, evidence } = await lane("", true);
    expect(code).toBe(0);
    expect(evidence).toBe(true);
    for (const script of ["sticky-modifiers-regression.ts", "file-viewer-regression.ts"]) {
      expect(text).toMatch(new RegExp(`^\\[[^\\]]+\\] STEP=scripts/${script} EVIDENCE=.+/browser-evidence$`, "m"));
    }
    for (const script of ["ui-regression.ts", "ui-contexts-regression.ts", "key-bar-customization-demo-regression.ts"]) {
      expect(text).toMatch(new RegExp(`^\\[[^\\]]+\\] STEP=scripts/${script} EVIDENCE=$`, "m"));
    }
  }, LANE_TEST_MS);

  it("creates evidence under .ci when CI has no CHECK_DIR", async () => {
    const { text, code, evidence } = await lane("", false, "1");
    expect(code).toBe(0);
    expect(evidence).toBe(true);
    expect(text).toMatch(/^\[[^\]]+\] STEP=scripts\/file-viewer-regression\.ts EVIDENCE=.ci\/browser-evidence$/m);
    expect(text).toMatch(/^Browser lane total: seconds=\d+ exit=0$/m);
  }, LANE_TEST_MS);
});

// Browser scripts that CI does not run: they are run by hand. A new browser script belongs in
// scripts/ci-browser.sh, or here when CI cannot run it.
const MANUAL_BROWSER_SCRIPTS = [
  "scripts/android-ime-regression.ts", // an Android emulator over ADB (docs/terminal-input.md)
  "scripts/chat-browser-qa.ts", // docs/development.md
  "scripts/font-swap-demo-regression.ts", // docs/development.md
  "scripts/keyboard-viewport-demo-regression.ts", // docs/development.md
  "scripts/machines-browser-qa.ts", // an SSH_TEST_KEEP=1 fixture (docs/remote-pcs.md)
  "scripts/output-browser-qa.ts", // docs/terminal-flow-control.md
  "scripts/skill-activity-browser-qa.ts", // docs/chat-skill-activity.md
  "scripts/terminal-file-links-regression.ts",
  "scripts/update-browser-qa.ts", // a private Git remote and install (docs/app-updates.md)
  "scripts/windows-lens-browser-qa.ts",
  "scripts/windows-terminal-browser-qa.ts", // native Windows: .github/workflows/windows-terminal-qa.yml
];

/**
 * Every script the lane runs, plus every script those import (`from "./x.ts"`, `import("./x.ts")`)
 * or spawn (`spawn([..., join(import.meta.dir, "x.ts")`), transitively. A path built anywhere else
 * (a Bun.build entry, say) is not a run. A spawn counts only from a file that runs as a script: an
 * imported helper's spawn usually sits under `import.meta.main`.
 */
function laneReach(lane: string[]): Set<string> {
  const reached = new Set<string>();
  const ran = new Set<string>();
  const pending = lane.map((script) => ({ script, runs: true }));
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { script, runs } = next;
    const path = join(import.meta.dir, "..", script);
    // A name with no file behind it (terminal-dispose-fixture.ts is an in-memory Bun.build entry) has nothing to read.
    if ((runs ? ran : reached).has(script) || !existsSync(path)) continue;
    reached.add(script);
    if (runs) ran.add(script);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([\w.-]+\.tsx?)["']/g)) {
      pending.push({ script: `scripts/${match[1]}`, runs: false });
    }
    if (!runs) continue;
    for (const match of source.matchAll(/spawn(?:Sync)?\(\s*\[[^\]]*?import\.meta\.dir,\s*["']([\w.-]+\.tsx?)["']/g)) {
      pending.push({ script: `scripts/${match[1]}`, runs: true });
    }
  }
  return reached;
}

describe("browser lane assignment", () => {
  const lane = serialBrowserScripts();
  const onDisk = readdirSync(import.meta.dir).filter((name) => /-(regression|browser-qa)\.ts$/.test(name)).map((name) => `scripts/${name}`);

  it("runs each script once, and only scripts that exist", () => {
    expect(new Set(lane).size).toBe(lane.length);
    expect(lane.filter((script) => !existsSync(join(import.meta.dir, "..", script)))).toEqual([]);
  });

  it("runs every browser script on disk, directly or through a script it runs, unless it is manual", () => {
    const reached = laneReach(lane);
    expect(onDisk.filter((script) => !reached.has(script) && !MANUAL_BROWSER_SCRIPTS.includes(script))).toEqual([]);
  });

  // With no CHECK_DIR or CI, both runners hand every script an empty UI_EVIDENCE_DIR, and the
  // parallel one an empty CHECK_BROWSER_EVIDENCE_DIR too. `??` keeps that empty path, so the script
  // writes into the checkout or fails to create it (#1554).
  it("takes an empty evidence folder as unset in every script the lane runs", () => {
    const keepsEmpty = /(?:UI|CHECK_BROWSER)_EVIDENCE_DIR["']?\]?\s*\?\?/;
    expect([...laneReach(lane)].filter((script) => keepsEmpty.test(readFileSync(join(import.meta.dir, "..", script), "utf8")))).toEqual([]);
  });

  it("keeps the manual list to scripts that exist and that CI does not run", () => {
    const reached = laneReach(lane);
    expect(MANUAL_BROWSER_SCRIPTS.filter((script) => !onDisk.includes(script) || reached.has(script))).toEqual([]);
  });
});
