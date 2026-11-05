import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";

import { AGENT_CATALOG, type AgentCatalogEntry } from "../shared/agent-catalog.ts";
import { AgentDetector, catalogLocator, LOGIN_PATH_KEPT_MS, runVersion, TIMEOUT_KEPT_MS, versionSpawn } from "./agent-catalog-detect.ts";
import type { LoginPathResult } from "./shell-agent.ts";

const entry = (id: string): AgentCatalogEntry => AGENT_CATALOG.find((candidate) => candidate.id === id)!;

// Stub agents are real executables run by the real runVersion: POSIX shell scripts, so not on Windows
describe.skipIf(process.platform === "win32")("AgentDetector", () => {
  let bin: string;
  let runs: string;
  /** a home with no installer folders: the detector never looks in the real one here */
  let emptyHome: string;
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name} >> '${runs}'\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const runsOf = (name: string) => readFileSync(runs, "utf8").split("\n").filter((line) => line === name).length;
  const locate = async (binary: string) => Bun.which(binary, { PATH: bin });

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), "ovis-catalog-bin-"));
    emptyHome = mkdtempSync(join(tmpdir(), "ovis-catalog-empty-home-"));
    runs = join(bin, "runs.log");
    writeFileSync(runs, "");
    stub("claude", "echo '2.1.311 (Claude Code)'");
    stub("codex", "echo 'codex-cli 0.150.0'");
    stub("omp", "echo 'usage: omp [options]'");
    stub("hermes", "echo 'Hermes Agent v0.21.5'");
  });
  afterAll(() => {
    rmSync(bin, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  });

  it("reads an installed agent's version once, and again only when its executable changes", async () => {
    const detector = new AgentDetector({ home: emptyHome, locate });
    expect(await detector.state(entry("claude"), "linux")).toEqual({ installed: true, binary: "claude", on_path: true, version: "2.1.311", version_error: null, meets_min_version: true });
    expect(await detector.state(entry("claude"), "linux")).toMatchObject({ version: "2.1.311" });
    expect(runsOf("claude")).toBe(1);
    // an update replaces the file: the next read asks it again
    stub("claude", "echo '2.1.320 (Claude Code, updated)'");
    expect(await detector.state(entry("claude"), "linux")).toMatchObject({ version: "2.1.320" });
    expect(runsOf("claude")).toBe(2);
  });

  it("reads the version again when the executable is replaced by another file of the same size and time", async () => {
    stub("copilot", "echo 'copilot 0.10.0'");
    const target = join(bin, "copilot");
    utimesSync(target, 1_700_000_000, 1_700_000_000);
    const detector = new AgentDetector({ home: emptyHome, locate });
    expect(await detector.state(entry("copilot"), "linux")).toMatchObject({ version: "0.10.0" });
    // an updater writes the new file beside the old one and renames it over: same size, mtime copied
    const before = statSync(target);
    const next = join(bin, "copilot.next");
    writeFileSync(next, readFileSync(target, "utf8").replace("0.10.0", "0.20.0"));
    chmodSync(next, 0o755);
    utimesSync(next, 1_700_000_000, 1_700_000_000);
    renameSync(next, target);
    const after = statSync(target);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    expect(await detector.state(entry("copilot"), "linux")).toMatchObject({ version: "0.20.0" });
    expect(runsOf("copilot")).toBe(2);
  });

  it("runs one version flag for readers that ask at once", async () => {
    const detector = new AgentDetector({ home: emptyHome, locate });
    const before = runsOf("omp");
    const [first, second] = await Promise.all([detector.state(entry("omp"), "linux"), detector.state(entry("omp"), "linux")]);
    expect(first).toEqual(second);
    expect(runsOf("omp") - before).toBe(1);
  });

  it("reports an agent as not installed while a program it needs to run is missing, without running its version flag", async () => {
    // shaped like DeepSeek Harness: the TUI a pane starts (dsh-tui), and the launcher it needs (dsh)
    const harness: AgentCatalogEntry = { ...entry("codex"), id: "needs-test", detect: { binaries: ["needs-tui"], needs: ["needs-launcher"], version_args: ["--version"] }, min_version: null };
    stub("needs-tui", "echo 'needs-tui 0.17.0 (launcher)'");
    const detector = new AgentDetector({ home: emptyHome, locate });
    expect(await detector.state(harness, "linux")).toEqual({ installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null });
    expect(runsOf("needs-tui")).toBe(0);
    stub("needs-launcher", "echo '0.2.1-rc.5'");
    expect(await detector.state(harness, "linux")).toEqual({ installed: true, binary: "needs-tui", on_path: true, version: "0.17.0", version_error: null, meets_min_version: null });
    expect(runsOf("needs-launcher")).toBe(0);
  });

  it("says when a version is older than Ovis's feature needs, or cannot be read", async () => {
    const detector = new AgentDetector({ home: emptyHome, locate });
    expect(await detector.state(entry("codex"), "linux")).toEqual({ installed: true, binary: "codex", on_path: true, version: "0.150.0", version_error: null, meets_min_version: false });
    expect(await detector.state(entry("omp"), "linux")).toEqual({ installed: true, binary: "omp", on_path: true, version: null, version_error: "unreadable", meets_min_version: null });
  });

  it("gives a slow version flag the longer limit its catalog entry sets, and every other one the default", async () => {
    // Hermes answers its version flag in 2.3 to 6.7 s on a busy PC, past the 5 s default
    expect(entry("hermes").detect.version_timeout_ms).toBeGreaterThan(7_000);
    const limits: Record<string, number> = {};
    // nothing is run: the limit each probe is given is all this reads
    const run = async (executable: string, _args: readonly string[], timeoutMs: number): Promise<never> => {
      limits[basename(executable)] = timeoutMs;
      throw new Error("not run here");
    };
    const detector = new AgentDetector({ home: emptyHome, locate, timeoutMs: 300, run });
    const slow = entry("claude");
    await detector.state({ ...slow, detect: { ...slow.detect, version_timeout_ms: 12_345 } }, "linux");
    await detector.state(entry("codex"), "linux");
    expect(limits).toEqual({ claude: 12_345, codex: 300 });
  });

  it("never reads a version out of a flag that fails, or out of what it prints as an error", async () => {
    // a wrapper whose target is gone, as a removed nvm Node leaves one: the shell's error names the
    // missing path, Node's version and all, and exits 127
    stub("opencode", `exec '${join(bin, "missing", "node", "v22.17.1", "bin", "opencode")}' "$@"`);
    // a flag that prints its version only on stderr, and succeeds
    stub("pi", "echo 'pi 1.2.3' >&2");
    const detector = new AgentDetector({ home: emptyHome, locate });
    expect(await detector.state(entry("opencode"), "linux")).toEqual({ installed: true, binary: "opencode", on_path: true, version: null, version_error: "failed", meets_min_version: null });
    expect(await detector.state(entry("pi"), "linux")).toEqual({ installed: true, binary: "pi", on_path: true, version: null, version_error: "unreadable", meets_min_version: null });
  });

  it("asks a failed version flag again after a while, so an install repaired behind an unchanged wrapper shows", async () => {
    let now = 1_000;
    const target = join(bin, "letta.target");
    stub("letta", `[ -f '${target}' ] && exec cat '${target}'\necho "${target}: No such file or directory" >&2\nexit 127`);
    const detector = new AgentDetector({ home: emptyHome, locate, now: () => now });
    expect(await detector.state(entry("letta"), "linux")).toMatchObject({ version: null, version_error: "failed" });
    await detector.state(entry("letta"), "linux");
    expect(runsOf("letta")).toBe(1);
    writeFileSync(target, "letta 0.5.0\n");
    now += TIMEOUT_KEPT_MS;
    expect(await detector.state(entry("letta"), "linux")).toMatchObject({ version: "0.5.0", version_error: null });
    expect(runsOf("letta")).toBe(2);
  });

  it("kills a version flag that hangs, and asks again only after a while", async () => {
    // gjc: an agent with no limit of its own, so the detector's 300 ms applies
    stub("gjc", "exec sleep 10");
    let now = 1_000;
    const detector = new AgentDetector({ home: emptyHome, locate, timeoutMs: 300, now: () => now });
    // the 10 s sleep is ended at the detector's 300 ms limit: the answer says it timed out
    expect(await detector.state(entry("gjc"), "linux")).toEqual({ installed: true, binary: "gjc", on_path: true, version: null, version_error: "timeout", meets_min_version: null });
    await detector.state(entry("gjc"), "linux");
    expect(runsOf("gjc")).toBe(1);
    now += TIMEOUT_KEPT_MS;
    await detector.state(entry("gjc"), "linux");
    expect(runsOf("gjc")).toBe(2);
  });

  it("reports an agent not on PATH as not installed, and runs nothing where its name proves nothing", async () => {
    const looked: string[] = [];
    const detector = new AgentDetector({ home: emptyHome, locate: async (binary) => { looked.push(binary); return locate(binary); } });
    expect(await detector.state(entry("grok"), "linux")).toEqual({ installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null });
    expect(await detector.state(entry("cmd"), "windows")).toEqual({ installed: null, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null });
    expect(looked).toEqual(["grok"]);
  });

  it("finds an agent an installer put on the login shell's PATH only, reading that PATH at most once a minute", async () => {
    let now = 0;
    let probes = 0;
    const probe = async () => { probes++; return { path: `/nonexistent:${bin}` }; };
    const locateWithLogin = catalogLocator({ probe, servicePath: () => "/usr/bin/nonexistent", now: () => now });
    expect(await locateWithLogin("claude")).toBe(join(bin, "claude"));
    expect(await locateWithLogin("grok")).toBeNull();
    expect(probes).toBe(1);
    now += LOGIN_PATH_KEPT_MS;
    await locateWithLogin("grok");
    expect(probes).toBe(2);
    // the service PATH alone, as tests and Windows run it
    expect(await catalogLocator({ probe: null, servicePath: () => "/usr/bin/nonexistent" })("claude")).toBeNull();
    expect(await catalogLocator({ probe: null, servicePath: () => bin })("claude")).toBe(join(bin, "claude"));
    const detector = new AgentDetector({ home: emptyHome, locate: locateWithLogin });
    expect(await detector.state(entry("claude"), "linux")).toMatchObject({ installed: true, binary: "claude" });
  });

  it("runs a version flag with the PATH its agent was found on, so a script's interpreter there is found", async () => {
    const agents = mkdtempSync(join(tmpdir(), "ovis-catalog-login-bin-"));
    const runtime = mkdtempSync(join(tmpdir(), "ovis-catalog-login-runtime-"));
    const script = (path: string, body: string) => { writeFileSync(path, body); chmodSync(path, 0o755); };
    try {
      // an interpreter only the login shell's PATH has, as nvm's node is for a server run as a service,
      // and an npm-style agent run by it through env
      script(join(runtime, "ovis-fake-node"), "#!/bin/sh\necho 'cmd 1.88.2'\n");
      script(join(agents, "cmd"), "#!/usr/bin/env ovis-fake-node\n");
      const locateWithLogin = catalogLocator({ probe: async () => ({ path: `${agents}${delimiter}${runtime}` }), servicePath: () => "/usr/bin/nonexistent" });
      expect(await new AgentDetector({ home: emptyHome, locate: locateWithLogin }).state(entry("cmd"), "linux")).toMatchObject({ installed: true, version: "1.88.2", version_error: null });
      // an interpreter beside the agent, as npm's global folder has node: found whatever the PATH
      script(join(agents, "ovis-fake-node"), "#!/bin/sh\necho 'cmd 1.88.3'\n");
      script(join(agents, "letta"), "#!/usr/bin/env ovis-fake-node\n");
      expect(await new AgentDetector({ home: emptyHome, locate: async (binary) => binary === "letta" ? join(agents, "letta") : null }).state(entry("letta"), "linux")).toMatchObject({ installed: true, version_error: null });
    } finally {
      rmSync(agents, { recursive: true, force: true });
      rmSync(runtime, { recursive: true, force: true });
    }
  });

  it("finds an agent its installer put in its own folder, off PATH, and says so", async () => {
    const home = mkdtempSync(join(tmpdir(), "ovis-catalog-home-"));
    try {
      const dir = join(home, ".pi", "agent", "bin");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "pi"), "#!/bin/sh\necho '1.4.0'\n");
      chmodSync(join(dir, "pi"), 0o755);
      const nowhere = async () => null;
      const detector = new AgentDetector({ locate: nowhere, home });
      const pi = { ...entry("pi"), detect: { ...entry("pi").detect, install_dirs: { linux: ["~/.pi/agent/bin"] } } };
      expect(await detector.state(pi, "linux")).toEqual({ installed: true, binary: "pi", on_path: false, version: "1.4.0", version_error: null, meets_min_version: null });
      // another platform's folders are never looked in
      expect(await detector.state(pi, "macos")).toMatchObject({ installed: false });
      const windows = new AgentDetector({ locate: nowhere, home, env: { LOCALAPPDATA: home } });
      const viaVariable = { ...pi, detect: { ...pi.detect, install_dirs: { linux: ["%LOCALAPPDATA%/.pi/agent/bin"] } } };
      expect(await windows.state(viaVariable, "linux")).toMatchObject({ installed: true, on_path: false });
      // a variable the environment does not have names no folder
      expect(await new AgentDetector({ locate: nowhere, home, env: {} }).state(viaVariable, "linux")).toMatchObject({ installed: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("never finds a binary through a relative, empty or '.' PATH entry, whatever the server's working folder", async () => {
    const cwd = process.cwd();
    process.chdir(bin);
    try {
      for (const path of [".", "", `.:${"/nonexistent"}`, "bin-relative", `:/nonexistent`]) {
        expect(await catalogLocator({ probe: null, servicePath: () => path })("claude")).toBeNull();
        expect(await catalogLocator({ probe: async () => ({ path }), servicePath: () => "/nonexistent" })("claude")).toBeNull();
      }
      // an absolute entry still counts
      expect(await catalogLocator({ probe: null, servicePath: () => `.:${bin}` })("claude")).toBe(join(bin, "claude"));
    } finally {
      process.chdir(cwd);
    }
  });

  /** Whether `pid` has ended: no such process, or one that only waits to be reaped. */
  const gone = async (pid: number): Promise<boolean> => {
    const state = (await new Response(Bun.spawn(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout).text()).trim();
    return state === "" || state.startsWith("Z");
  };
  /** Waits for `pid` to end, for at most a second: SIGKILL is sent at once, and the kernel ends the process right after. */
  const ends = async (pid: number): Promise<boolean> => {
    const deadline = performance.now() + 1_000;
    while (performance.now() < deadline) if (await gone(pid)) return true;
    return gone(pid);
  };

  it("ends a timed-out version flag with every process it started, even one still holding its output", async () => {
    const pidFile = join(bin, "holder.pid");
    stub("holder", `sleep 30 &\necho $! > '${pidFile}'\nsleep 30`);
    const run = await runVersion(join(bin, "holder"), ["--version"], 300);
    // ended by the 300 ms limit, not by the flag (it sleeps 30 s): timed out, with no exit code of its own
    expect([run.timedOut, run.exitCode]).toEqual([true, null]);
    expect(await ends(Number(readFileSync(pidFile, "utf8").trim()))).toBe(true);
  });

  it("reads the version of a flag that answers and exits at once, and ends the child it left holding the output", async () => {
    const pidFile = join(bin, "leaver.pid");
    stub("leaver", `sleep 30 &\necho $! > '${pidFile}'\necho 'leaver 1.2.3'\nexit 0`);
    // a 3 s limit, under the test's own 5 s: a run kept until the limit fails on its answer, not the test timeout
    const run = await runVersion(join(bin, "leaver"), ["--version"], 3_000);
    // answered by the flag's own exit, not by the limit, though its child still held the output
    expect([run.timedOut, run.exitCode]).toEqual([false, 0]);
    expect(run.stdout).toContain("leaver 1.2.3");
    expect(await ends(Number(readFileSync(pidFile, "utf8").trim()))).toBe(true);
  });

  it("reads at most a bounded amount of what a version flag prints", async () => {
    stub("chatty", "yes 1.2.3 | head -c 1000000");
    const run = await runVersion(join(bin, "chatty"), ["--version"], 5_000);
    expect(run.timedOut).toBe(false);
    expect(run.stdout.length).toBeLessThan(10_000);
    expect(run.stdout.startsWith("1.2.3")).toBe(true);
  });
});

describe("versionSpawn", () => {
  it("runs a Windows batch file (an npm agent's .cmd shim) through cmd.exe, with its line as cmd reads it", () => {
    const comspec = "C:\\Windows\\system32\\cmd.exe";
    expect(versionSpawn("C:\\Users\\Jo Doe\\AppData\\Roaming\\npm\\codex.cmd", ["--version"], "win32", comspec)).toEqual({
      cmd: [comspec, "/d", "/s", "/c", '""C:\\Users\\Jo Doe\\AppData\\Roaming\\npm\\codex.cmd" "--version""'],
      windowsVerbatimArguments: true,
    });
    expect(versionSpawn("C:\\tools\\AGENT.BAT", ["--version"], "win32", "").cmd.slice(0, 4)).toEqual(["cmd.exe", "/d", "/s", "/c"]);
  });

  it("runs anything else as itself", () => {
    expect(versionSpawn("C:\\Users\\u\\.local\\bin\\claude.exe", ["--version"], "win32", "cmd.exe")).toEqual({ cmd: ["C:\\Users\\u\\.local\\bin\\claude.exe", "--version"], windowsVerbatimArguments: false });
    expect(versionSpawn("/opt/tools/agent.cmd", ["--version"], "linux", undefined)).toEqual({ cmd: ["/opt/tools/agent.cmd", "--version"], windowsVerbatimArguments: false });
  });
});

describe.skipIf(process.platform !== "win32")("runVersion on Windows", () => {
  it("reads the version a .cmd shim prints, from a folder with a space in its name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis catalog cmd "));
    try {
      const shim = join(dir, "agent.cmd");
      // %~1: the first argument as the shim got it, cmd's quotes taken off (an npm shim hands %* to node, which does the same)
      writeFileSync(shim, "@echo off\r\necho agent 4.5.6 %~1\r\n");
      const run = await runVersion(shim, ["--version"], 10_000);
      expect([run.timedOut, run.exitCode, run.stdout.trim()]).toEqual([false, 0, "agent 4.5.6 --version"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("catalogLocator.refresh", () => {
  it("lets refreshes asked for while one waits to start join it: one login shell for them all", async () => {
    const first = Promise.withResolvers<LoginPathResult>();
    let runs = 0;
    const locate = catalogLocator({ probe: async () => { runs += 1; return runs === 1 ? first.promise : { path: "/usr/bin" }; }, servicePath: () => "" });
    const reading = locate("claude");
    const refreshes = [locate.refresh!(), locate.refresh!(), locate.refresh!()];
    first.resolve({ path: null, reason: "the first read" });
    await reading;
    await Promise.all(refreshes);
    expect(runs).toBe(2);
  });
});
