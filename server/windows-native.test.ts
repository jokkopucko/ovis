/**
 * What only a real Windows PC can show: its process table as PowerShell answers it, and a
 * session store on its own file system with its own path rules. Everything else about the
 * Windows branches is tested with rows and paths handed in (gjc-runtime.test.ts); these run
 * on the Windows runners of reusable CI and the remote-bundle workflow (#271).
 */
import { expect, it, spyOn } from "bun:test";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rm } from "node:fs/promises";

import { claudeProcessSession, forgetClaudeSessions, processClaudeConfigDir } from "./claude-store.ts";
import { agentStartArgs } from "./claude-settings-file.ts";
import { Database } from "bun:sqlite";

import { codexRolloutPath, directoryKey, sameDirectory, storedCwdCondition } from "./codex.ts";
import { gjcSessionFile, storeRelative } from "./gjc-runtime.ts";
import { descendantArgv, windowsProcessTable } from "./windows-processes.ts";
import { windowsBridgeFiles, windowsHost } from "./remote-host.ts";
import type { SshConnection } from "./ssh.ts";
import { psQuote } from "./powershell.ts";
import { powershellNativeArgs, shellCommandLine } from "./shell-agent.ts";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { isAgyProcessName, windowsHolders } from "./agy-store.ts";
import { ancestorsToRepoRoot } from "./skills/walk.ts";
import { startInteractiveWindowsHerdr } from "./windows-herdr-start.ts";
import ts from "typescript-api";

const onWindows = process.platform === "win32";

/** The JSON in `path` once it is whole; a file still being written reads as not there yet (#2165). */
function completeJson<T>(path: string): T | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  // a Windows scanner can hold the file just renamed into place for a moment
  catch (error) { if (["ENOENT", "EBUSY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
  try { return JSON.parse(text) as T; }
  catch (error) { if (error instanceof SyntaxError) return undefined; throw error; }
}

/** Waits for the whole JSON in `path`, looking again on every change in `dir`, until `ms` runs out. */
function watchJson<T>(dir: string, path: string, ms: number): { result: Promise<T>; looked: () => Promise<void>; close: () => Promise<void> } {
  const watcher = watch(dir);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const lookers: (() => void)[] = [];
  const result = new Promise<T>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error(`${path} was not written`)), ms);
    watcher.on("change", () => {
      try {
        const value = completeJson<T>(path);
        if (value !== undefined) { clearTimeout(deadline); resolve(value); }
      } catch (error) { clearTimeout(deadline); reject(error); }
      for (const looker of lookers.splice(0)) looker();
    });
  });
  // A waiting host has no child and therefore no result; still observe a later rejection on failure.
  void result.catch(() => {});
  return {
    result,
    // the next look at the file, or the result's failure if that comes first
    looked: () => Promise.race([new Promise<void>((resolve) => lookers.push(resolve)), result.then(() => {})]),
    close: async () => {
      clearTimeout(deadline);
      const closed = new Promise<void>((resolve) => watcher.once("close", resolve));
      watcher.close();
      await closed;
    },
  };
}

it("waits past a half-written result until the whole file is renamed into place (#2165)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-result-wait-"));
  const path = join(root, "result.json");
  const waiting = watchJson<{ pid: number }>(root, path, 15_000);
  try {
    let settled = false;
    void waiting.result.then(() => { settled = true; }, () => { settled = true; });
    // what the hosted runner saw: the name already there, its content not yet
    const looked = waiting.looked();
    writeFileSync(path, "{\"pid\":");
    await looked;
    // the watcher has seen the half-written file and is still waiting
    await Promise.resolve();
    expect(settled).toBe(false);
    writeFileSync(`${path}.tmp`, JSON.stringify({ pid: 7 }));
    renameSync(`${path}.tmp`, path);
    expect(await waiting.result).toEqual({ pid: 7 });
  } finally {
    await waiting.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// A hosted Windows runner can take more than bun's default 5 s on any native call (#2104).
it("gives every Windows-only case a budget sized for a busy hosted runner (#2104)", () => {
  const file = ts.createSourceFile(import.meta.path, readFileSync(import.meta.path, "utf8"), ts.ScriptTarget.Latest);
  const cases: { name: string; budget: number | undefined }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(file) === "it.skipIf") {
      const [name, , budget] = node.arguments;
      cases.push({ name: name!.getText(file), budget: budget && ts.isNumericLiteral(budget) ? Number(budget.text) : undefined });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(cases.length).toBeGreaterThan(10);
  expect(cases.filter(({ budget }) => budget === undefined || budget < 30_000)).toEqual([]);
});

it.skipIf(!onWindows)("waits when Windows accepts an interactive task without running it, but rejects a failed launcher", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-desktop-not-run-"));
  const marker = join(root, "unexpected-child");
  const script = join(root, "child.ts");
  writeFileSync(script, `await Bun.write(${JSON.stringify(marker)}, 'launched');`);
  const spawn = Bun.spawn.bind(Bun);
  let failedResult = false;
  const failures: unknown[] = [];
  // Replay Run returning no instance while the real, fresh task remains Ready/never-run.
  // Registration, status queries, private payload creation and cleanup still run natively.
  const intercepted = spyOn(Bun, "spawn").mockImplementation(((command: string[], options: Parameters<typeof Bun.spawn>[1]) => {
    const args = [...command];
    const encoded = args.indexOf("-EncodedCommand") + 1;
    let source = Buffer.from(args[encoded]!, "base64").toString("utf16le");
    source = source.replace("try { $running = $registered.Run($null) }", "try { $running = $null }");
    // A completed launcher error must not be mistaken for a never-run task.
    if (failedResult) source = source.replace("$deadline = [DateTime]::UtcNow.AddSeconds(30)", "$registered = [pscustomobject]@{ State = 3; LastTaskResult = 1 }; $deadline = [DateTime]::UtcNow.AddSeconds(30)");
    args[encoded] = Buffer.from(source, "utf16le").toString("base64");
    return spawn(args, options);
  }) as typeof Bun.spawn);
  try {
    expect(await startInteractiveWindowsHerdr(process.execPath, [script], join(root, "herdr.log"))).toBe("waiting_login");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith("herdr-start-"))).toEqual([]);
    failedResult = true;
    await expect(startInteractiveWindowsHerdr(process.execPath, [script], join(root, "herdr.log"))).rejects.toThrow("exited before reading its payload");
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith("herdr-start-"))).toEqual([]);
  } catch (error) { failures.push(error); }
  intercepted.mockRestore();
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Desktop wait test and cleanup failed");
}, 30_000);

it.skipIf(!onWindows)("starts a desktop child outside the launcher, preserving quoted arguments and private environment, or waits without launching", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-desktop-start-"));
  const registry = join(root, "physical registry");
  const legacy = join(root, "legacy registry");
  mkdirSync(registry);
  symlinkSync(registry, legacy, "junction");
  const resultPath = join(root, "result.json");
  const stopPath = join(root, "stop");
  const script = join(root, "child with spaces.ts");
  const sentinel = "private-launch-sentinel-\"&%!\n한글";
  const previous = process.env["OVIS_START_TEST_SECRET"];
  let pid: number | undefined;
  const waiting = watchJson<{ pid: number; secret: string; args: string[]; session: number }>(root, resultPath, 15_000);
  writeFileSync(script, `import { watch, existsSync, renameSync, writeFileSync } from 'node:fs';
import { dlopen, FFIType } from 'bun:ffi';
const { symbols } = dlopen('kernel32.dll', { ProcessIdToSessionId: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 } });
const session = new Uint32Array(1); if (!symbols.ProcessIdToSessionId(process.pid, session)) throw new Error('no session');
watch(${JSON.stringify(root)}, () => { if (existsSync(${JSON.stringify(stopPath)})) process.exit(0); });
// written whole under another name first: the result's name only appears with all of it (#2165)
writeFileSync(${JSON.stringify(`${resultPath}.tmp`)}, JSON.stringify({pid:process.pid, secret:process.env.OVIS_START_TEST_SECRET, args:process.argv.slice(2), session:session[0]}));
renameSync(${JSON.stringify(`${resultPath}.tmp`)}, ${JSON.stringify(resultPath)});
`);
  process.env["OVIS_START_TEST_SECRET"] = sentinel;
  const failures: unknown[] = [];
  try {
    const started = await startInteractiveWindowsHerdr(process.execPath, [script, "argument with spaces & 한글"], join(legacy, "herdr.log"));
    if (started === "waiting_login") {
      expect(existsSync(resultPath)).toBe(false);
    } else {
      // The launcher already exited, but this child's watch still runs in the desktop session.
      const child = await waiting.result;
      pid = child.pid;
      expect(child.session).toBeGreaterThan(0);
      expect(child.secret).toBe(sentinel);
      expect(child.args).toEqual(["argument with spaces & 한글"]);
      expect(() => process.kill(child.pid, 0)).not.toThrow();
    }
    expect(readdirSync(registry).filter((name) => name.startsWith("herdr-start-"))).toEqual([]);
  } catch (error) { failures.push(error); }
  try {
    await waiting.close();
    if (previous === undefined) delete process.env["OVIS_START_TEST_SECRET"]; else process.env["OVIS_START_TEST_SECRET"] = previous;
    // Only this fixture's child is stopped, never a herdr daemon or another test's task.
    if (pid !== undefined) try { process.kill(pid); } catch {}
    // Remove the junction itself before recursively cleaning its target fixture.
    await rm(legacy, { force: true, recursive: true });
    const cleanupBy = Date.now() + 5000;
    for (;;) {
      try { await rm(root, { recursive: true, force: true }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || Date.now() >= cleanupBy) throw error;
        await Bun.sleep(25);
      }
    }
  } catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Desktop startup test and cleanup failed");
}, 60_000);

it.skipIf(!onWindows)("stops skill discovery at the user's home whatever its letter case", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-home-case-"));
  const before = process.env["USERPROFILE"];
  try {
    process.env["USERPROFILE"] = home.toLowerCase();
    // home is itself a repository: a folder under it with no .git of its own must not reach it
    mkdirSync(join(home, ".git"));
    const cwd = join(home.toUpperCase(), "work", "sub");
    mkdirSync(cwd, { recursive: true });
    expect(ancestorsToRepoRoot(cwd)).toEqual([cwd]);
    expect(ancestorsToRepoRoot(home.toUpperCase())).toEqual([]);
    // and a folder above home in another case is not a project of its own either
    expect(ancestorsToRepoRoot(dirname(home).toUpperCase())).toEqual([]);
  } finally {
    if (before === undefined) delete process.env["USERPROFILE"]; else process.env["USERPROFILE"] = before;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(!onWindows)("finds this process holding an open file through Restart Manager, then observes its release", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-agy-native-"));
  const path = join(root, "conversation.lock");
  let fd: number | undefined;
  try {
    fd = openSync(path, "w+");
    expect(windowsHolders(path)).toContain(process.pid);
    closeSync(fd);
    fd = undefined;
    const after = windowsHolders(path);
    expect(after).not.toBeNull();
    expect(after!).not.toContain(process.pid);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(!onWindows)("recognizes Windows Agy executable names and full paths regardless of letter case", () => {
  expect(isAgyProcessName("agy.exe")).toBe(true);
  expect(isAgyProcessName("AGY.ExE")).toBe(true);
  expect(isAgyProcessName("C:\\Programs\\Antigravity\\AgY.eXe")).toBe(true);
  expect(isAgyProcessName("c:\\PROGRAMS\\ANTIGRAVITY\\AGY.EXE")).toBe(true);
  expect(isAgyProcessName("C:\\Programs\\agyx.exe")).toBe(false);
}, 30_000);

for (const migrated of [false, true]) {
  it.skipIf(!onWindows)(`writes the Windows bridge launcher and reads startup status with migration junction=${migrated}`, async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "ovis-registry-native-")));
    const legacy = join(home, ".config", "herdr-web-ui");
    const target = migrated ? join(home, "physical [%TEMP%] registry's folder") : legacy;
    const registry = join(target, "bridges");
    const session = migrated ? "web-qa" : undefined;
    const files = windowsBridgeFiles(session);
    const runPowerShell = async (script: string) => {
      const wait = script.includes("Invoke-CimMethod") ? "; Wait-Process -Id $r.ProcessId -Timeout 15 -ErrorAction SilentlyContinue" : "";
      const prefixed = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; $env:USERPROFILE=${psQuote(home)}; $env:APPDATA=${psQuote(home)}; $env:LOCALAPPDATA=${psQuote(home)}; $env:XDG_CONFIG_HOME=''; ${script}${wait}`;
      const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
      const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(prefixed, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe", env });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(stderr);
      return stdout.replaceAll("\r\n", "\n").trim();
    };
    const ssh = { runPowerShell } as unknown as SshConnection;
    try {
      mkdirSync(registry, { recursive: true });
      if (migrated) {
        mkdirSync(join(home, ".config"));
        symlinkSync(target, legacy, "junction");
      }
      const inspection = await windowsHost.inspect(ssh, session);
      expect(inspection.registryDir).toBe(join(legacy, "bridges"));
      const descriptor = { pid: 2147483647, port: 1, token: "fixture", socket_path: "C:\\herdr.sock", bridge_protocol: 1, bundle_version: REMOTE_BUNDLE_VERSION };
      writeFileSync(join(registry, "fixture[1].json"), JSON.stringify(descriptor));
      expect(await windowsHost.descriptors(ssh)).toEqual([descriptor]);
      expect((await windowsHost.inspect(ssh, session)).descriptors).toEqual([descriptor]);
      await windowsHost.stop(ssh, descriptor.pid);
      expect(existsSync(join(registry, "fixture[1].json"))).toBe(false);
      mkdirSync(join(inspection.runtimeDir, "bin"), { recursive: true });
      mkdirSync(join(inspection.runtimeDir, "server"));
      copyFileSync(process.execPath, join(inspection.runtimeDir, "bin", "bun.exe"));
      writeFileSync(join(inspection.runtimeDir, "server", "remote-entry.ts"), `await Bun.write(${JSON.stringify(join(home, "started.json"))}, JSON.stringify({ session: process.env.HERDR_REMOTE_SESSION ?? "", cwd: process.cwd() }));`);
      writeFileSync(join(registry, files.status), "interactive_failed: stale attempt");
      await windowsHost.start(ssh, { session, herdrPath: "C:\\herdr.exe", inspection });
      expect(JSON.parse(readFileSync(join(home, "started.json"), "utf8"))).toEqual({ session: session ?? "", cwd: home });
      const launcher = readFileSync(join(registry, files.launcher), "utf8");
      expect(launcher.startsWith("@echo off\r\n")).toBe(true);
      expect(launcher).toContain(`set "HERDR_REMOTE_SESSION=${session ?? ""}"`);
      expect(existsSync(join(registry, files.status))).toBe(false);
      writeFileSync(join(registry, files.status), "interactive_failed: this attempt");
      expect(await windowsHost.startupNotice!(ssh, session)).toBe("this attempt");
    } finally {
      if (migrated && existsSync(legacy)) await runPowerShell(`[IO.Directory]::Delete(${psQuote(legacy)})`);
      await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }, 60_000);
}

it.skipIf(!onWindows)("installs with native tar when PATH shadows tar, and preserves the runtime after bad extraction", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-bundle-native-")));
  const before = process.env["OVIS_BUNDLE_MANIFEST"];
  const runtime = join(home, "herdr-web-ui", `remote-v${REMOTE_BUNDLE_VERSION}`);
  const runPowerShell = async (script: string) => {
    const prefixed = `$env:LOCALAPPDATA=${psQuote(home)}; $env:PATH=${psQuote(join(home, "shadow"))}+';'+$env:PATH; ${script}`;
    // started from PowerShell 7 (the CI step), the child inherits its module path, and Windows
    // PowerShell then cannot load its own Get-FileHash; with none set it builds its own, as over SSH
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(prefixed, "utf16le").toString("base64")], { stdout: "pipe", stderr: "pipe", env });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
    return stdout.trim();
  };
  const ssh = { runPowerShell, upload: async (source: string, destination: string) => copyFileSync(source, destination) } as unknown as SshConnection;
  try {
    mkdirSync(join(home, "input", "bin"), { recursive: true });
    copyFileSync(process.execPath, join(home, "input", "bin", "bun.exe"));
    mkdirSync(join(home, "shadow"));
    // An invalid executable first on PATH must never handle this archive.
    writeFileSync(join(home, "shadow", "tar.exe"), "not a Windows executable");
    await runPowerShell(`& "$env:SystemRoot\\System32\\tar.exe" -czf ${psQuote(join(home, "bundle.tgz"))} -C ${psQuote(join(home, "input"))} .; if ($LASTEXITCODE -ne 0) { throw 'fixture archive failed' }`);
    const manifest = join(home, "manifest.json");
    const writeManifest = async () => writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "win32-x64": { url: "bundle.tgz", sha256: createHash("sha256").update(new Uint8Array(await Bun.file(join(home, "bundle.tgz")).arrayBuffer())).digest("hex") } } }));
    await writeManifest();
    process.env["OVIS_BUNDLE_MANIFEST"] = manifest;
    await windowsHost.installBundle(ssh, "win32-x64", AbortSignal.timeout(60_000));
    expect(existsSync(join(runtime, "bin", "bun.exe"))).toBe(true);
    const target = realpathSync(runtime);
    writeFileSync(join(home, "bundle.tgz"), "invalid archive with a valid manifest checksum");
    await writeManifest();
    await expect(windowsHost.installBundle(ssh, "win32-x64", AbortSignal.timeout(60_000))).rejects.toThrow();
    expect(realpathSync(runtime)).toBe(target);
    expect(existsSync(join(home, "herdr-web-ui", "install.lock"))).toBe(false);
    expect(existsSync(join(home, "herdr-web-ui", `install.${process.pid}`))).toBe(false);
  } finally {
    if (before === undefined) delete process.env["OVIS_BUNDLE_MANIFEST"]; else process.env["OVIS_BUNDLE_MANIFEST"] = before;
    // Remove the junction separately: the immutable release is cleaned with the fixture.
    if (existsSync(runtime)) await runPowerShell(`[IO.Directory]::Delete(${psQuote(runtime)})`);
    rmSync(home, { recursive: true, force: true });
  }
}, 120_000);

it.skipIf(!onWindows)("reads this PC's process table: this process, its parent, when it started and what it runs", async () => {
  const rows = await windowsProcessTable(30_000);
  const self = rows.find((row) => row.pid === process.pid);
  expect(self).toBeDefined();
  expect(self!.parent).toBe(process.ppid);
  // ms since 1970, as Date.now() counts: started before now, and not a day ago
  expect(typeof self!.started).toBe("number");
  expect(self!.started!).toBeLessThanOrEqual(Date.now() + 2000);
  expect(self!.started!).toBeGreaterThan(Date.now() - 24 * 60 * 60 * 1000);
  expect((self!.path ?? "").toLowerCase()).toContain("bun");
  // found from its parent the way a pane's program is found from the pane's shell
  expect(descendantArgv(rows, process.ppid).some((argv) => (argv[0] ?? "").toLowerCase() === (self!.path ?? "").toLowerCase())).toBe(true);
}, 40_000);

it.skipIf(!onWindows)("keeps a session file inside its store on a real Windows file system", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-gjc-native-")));
  try {
    const root = join(home, ".gjc", "agent", "sessions");
    const store = join(root, "v2-project");
    mkdirSync(join(store, "2026-10-01_session"), { recursive: true });
    const session = join(store, "2026-10-01_session.jsonl");
    writeFileSync(session, "{}\n");
    writeFileSync(join(store, "2026-10-01_session", "task.jsonl"), "{}\n");
    expect(root).toContain("\\");
    expect(gjcSessionFile(root, session)).toBe(session);
    // the drive letter's case is not another place, and a subagent's file stands for its session
    const lower = session[0]!.toLowerCase() + session.slice(1);
    const upper = session[0]!.toUpperCase() + session.slice(1);
    expect(gjcSessionFile(root, lower)).toBe(lower);
    expect(gjcSessionFile(root, upper)).toBe(upper);
    expect(gjcSessionFile(root, join(store, "2026-10-01_session", "task.jsonl"))).toBe(session);
    expect(storeRelative(root, session)).toEqual(["v2-project", "2026-10-01_session.jsonl"]);
    for (const outside of [`${root}-evil\\v2-project\\session.jsonl`, `${root}\\..\\sessions-evil\\v2-project\\session.jsonl`, `\\\\server\\share\\session.jsonl`, root]) {
      expect(storeRelative(root, outside)).toBeNull();
      expect(gjcSessionFile(root, outside)).toBeNull();
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(!onWindows)("reads a Codex rollout path stored with the \\\\?\\ prefix, and still keeps it inside the store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-codex-native-")));
  try {
    const home = join(root, "With Spaces", ".codex");
    const day = join(home, "sessions", "2026", "10", "05");
    mkdirSync(day, { recursive: true });
    const path = join(day, "rollout.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    const outside = join(root, "other.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { source: "cli", thread_source: "user" } }));
    // as Codex on Windows writes `threads.rollout_path`
    expect(codexRolloutPath(`\\\\?\\${path}`, home)).toBe(path);
    expect(codexRolloutPath(path, home)).toBe(path);
    expect(codexRolloutPath(`\\\\?\\${outside}`, home)).toBeNull();
    // raw `..` segments (join would fold them) that climb from the store to `outside`, which exists
    expect(codexRolloutPath(`\\\\?\\${home}\\sessions\\..\\..\\..\\other.jsonl`, home)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(!onWindows)("finds Codex's thread under the on-disk casing when herdr reports another spelling of the directory (#740)", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "herdr-codex-cwd-")));
  mkdirSync(join(root, "Recorde"));
  const reported = join(root, "recorde");
  const canonical = realpathSync.native(reported);
  const db = new Database(":memory:");
  try {
    // the two spellings are only one directory to the file system, not to directoryKey
    expect(directoryKey(reported)).not.toBe(directoryKey(canonical));
    db.run("CREATE TABLE threads (id TEXT, cwd TEXT)");
    db.run("INSERT INTO threads VALUES (?, ?)", ["own", `\\\\?\\${canonical}`]);
    const { where, params } = storedCwdCondition(reported);
    expect(db.query<{ id: string }, string[]>(`SELECT id FROM threads WHERE ${where}`).all(...params)).toEqual([{ id: "own" }]);
    expect(sameDirectory(reported, canonical)).toBe(true);
    mkdirSync(join(root, "Other"));
    expect(sameDirectory(reported, join(root, "Other"))).toBe(false);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(!onWindows)("finds a Claude's own store from the start it records, which the process table repeats", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-claude-native-")));
  const serverConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  delete process.env["CLAUDE_CONFIG_DIR"];
  try {
    const session = "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42";
    // Claude records its start as FILETIME ticks, as PowerShell gives them
    const probe = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc()`], { stdin: "ignore", stderr: "ignore" });
    const procStart = probe.stdout.toString().trim();
    expect(procStart).toMatch(/^\d+$/);
    const user = join(home, "User With Spaces");
    const store = join(user, ".claude-second");
    mkdirSync(join(store, "sessions"), { recursive: true });
    mkdirSync(join(user, ".claude", "sessions"), { recursive: true });
    const record = (start: string) => writeFileSync(join(store, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: session, procStart: start, kind: "interactive" }));
    // a millisecond off is another process that had this PID
    record(String(BigInt(procStart) + 10_000n));
    expect(await claudeProcessSession(user, process.pid, store)).toBeNull();
    record(procStart);
    expect(await claudeProcessSession(user, process.pid, store)).toBe(session);
    expect(await processClaudeConfigDir(process.pid, [process.execPath], user)).toBe(store);
  } finally {
    forgetClaudeSessions();
    if (serverConfigDir !== undefined) process.env["CLAUDE_CONFIG_DIR"] = serverConfigDir;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

it.skipIf(!onWindows)("gives Claude Code a settings file whose path an npm install's PowerShell shim passes on intact, where the JSON loses its quotes (#2232)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-claude-settings-native-")));
  try {
    const json = JSON.stringify({ ultracode: true });
    // a space in the folder, as a profile's %LOCALAPPDATA% can have
    const dir = join(root, "claude settings");
    const started = agentStartArgs("claude", ["--settings", json], { platform: "win32", dir });
    expect(started[0]).toBe("--settings");
    const path = started[1]!;
    expect(dirname(path)).toBe(dir);
    expect(readFileSync(path, "utf8")).toBe(json);
    expect(agentStartArgs("claude", ["--settings", json], { platform: "win32", dir })).toEqual(started);
    // npm's claude.ps1 in small: Windows PowerShell hands its $args to a native program, here this Bun
    // writing down the argv it got
    const seen = join(root, "argv.jsonl");
    const program = join(root, "argv.ts");
    writeFileSync(program, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
    const shim = join(root, "claude.ps1");
    // with a BOM, or Windows PowerShell reads a path outside ASCII in the ANSI code page
    writeFileSync(shim, `\uFEFF& ${psQuote(process.execPath)} ${psQuote(program)} $args\n`);
    // herdr's launch of a PowerShell script, once with the file's path and once with the JSON itself
    const script = [path, json].map((value) => `& ${psQuote(shim)} '--settings' ${psQuote(value)}`).join("\n");
    // as in the bundle install case: started from PowerShell 7, its module path would come along
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "psmodulepath"));
    const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdout: "ignore", stderr: "pipe", env });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(stderr);
    const runs = readFileSync(seen, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as string[]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual(["--settings", path]);
    // the reason for the file: the JSON arrives without its quotes, which Claude Code refuses as invalid
    expect(runs[1]![0]).toBe("--settings");
    expect(runs[1]![1]).not.toBe(json);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

it.skipIf(!onWindows)("runs nothing an argument holds when herdr-core's PowerShell start reaches a .cmd agent, and passes what it lets through intact (#3084, #3092)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-cmd-agent-")));
  try {
    const seen = join(root, "argv.jsonl");
    const program = join(root, "argv.ts");
    writeFileSync(program, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
    // npm's cmd-shim around this Bun, a shim reaching it through `call`, which reads the line once more,
    // and one doing so with delayed expansion on
    const npm = join(root, "npm");
    const called = join(root, "call");
    const delayed = join(root, "delayed");
    for (const dir of [npm, called, delayed]) mkdirSync(dir);
    writeFileSync(join(npm, "claude.cmd"), ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", `SET "_prog=${process.execPath}"`,
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "${program}" %*`, ""].join("\r\n"));
    writeFileSync(join(called, "claude.cmd"), `@call "${join(npm, "claude.cmd")}" %*\r\n`);
    writeFileSync(join(delayed, "claude.cmd"), `@setlocal EnableDelayedExpansion\r\n@call "${join(npm, "claude.cmd")}" %*\r\n`);
    const settings = "C:\\Users\\R&D\\AppData\\Local\\ovis\\claude settings\\a.json";
    const passed = [["--settings", settings], ["a & echo x> pwned"], ["a | echo x> pwned"], ["a > pwned"], ["a < b > pwned"]];
    const cases = [...passed, ['x"', "a & echo x> pwned & rem"], ['"', " & echo x> pwned & rem "], ["--append-system-prompt", 'a 12" screen', "--settings", settings],
      ["a&cd>pwned"], ["a ^& echo x> pwned"], ["a & echo %OS%> pwned"], ["a & !OS!"], ["!Q!", "a & echo x> pwned & rem"]];
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !["path", "psmodulepath"].includes(name.toLowerCase())));
    const shells = ["powershell", ...(Bun.which("pwsh") ? ["pwsh"] as const : [])] as const;
    const letThrough: { shell: string; started: string[][] }[] = [];
    for (const shell of shells) {
      for (const dir of [npm, called, delayed]) {
        const lines: string[] = [];
        const started: string[][] = [];
        for (const args of cases) {
          let line: string;
          try { line = shellCommandLine("powershell", "claude", powershellNativeArgs(shell, args)); }
          catch { continue; }
          lines.push(line);
          started.push(args);
        }
        rmSync(seen, { force: true });
        // typed as the start types it: `& 'claude' …`, the name found on the PATH
        const child = Bun.spawn([`${shell}.exe`, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(lines.join("\n"), "utf16le").toString("base64")],
          { cwd: root, stdout: "ignore", stderr: "pipe", env: { ...env, Q: '"', Path: `${dir};${process.env["Path"] ?? process.env["PATH"] ?? ""}` } });
        const [stderr] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        const runs = existsSync(seen) ? readFileSync(seen, "utf8").trim().split(/\r?\n/).map((text) => JSON.parse(text) as string[]) : [];
        // nothing ran but the agent, which got each argument as it was
        expect({ shell, dir, ran: readdirSync(root).filter((name) => name.startsWith("pwned")) }).toEqual({ shell, dir, ran: [] });
        expect({ shell, dir, runs, stderr: runs.length === started.length ? "" : stderr }).toEqual({ shell, dir, runs: started, stderr: "" });
        if (dir === npm) letThrough.push({ shell, started });
      }
    }
    // the start lets through each one cmd reads as text, and no other
    expect(letThrough).toEqual(shells.map((shell) => ({ shell, started: passed })));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 120_000);
