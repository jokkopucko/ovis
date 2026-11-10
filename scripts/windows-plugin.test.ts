import { expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { socketAddress } from "../server/herdr/client.ts";
import { descendantProcesses, windowsProcessTable } from "../server/windows-processes.ts";
import { updateStateDir } from "../server/update-state.ts";

/**
 * Removes a fixture's scratch folder, again while Windows still holds something in it: a process the
 * test started, or a scan of an executable it copied there, can keep a handle open for a moment
 * after the process is gone (#1907). Still fails, with the last error, once 10 s have passed.
 */
async function removeScratch(scratch: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      rmSync(scratch, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      if (Date.now() > deadline) throw error;
    }
    await Bun.sleep(100);
  }
}

it.skipIf(process.platform !== "win32")("runs the Windows launcher with executable and npm shim installations in literal percent paths", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "ovis bun shim "));
  const prefix = join(scratch, "npm %OS% !OS! ^x prefix");
  const bin = join(prefix, ".bun", "bin");
  mkdirSync(bin, { recursive: true });
  const launcher = join(prefix, "plugin.ps1");
  copyFileSync(join(import.meta.dir, "plugin.ps1"), launcher);
  const result = join(scratch, "arguments.json");
  writeFileSync(join(prefix, "plugin.ts"), `
    await Bun.write(${JSON.stringify(result)}, JSON.stringify(process.argv.slice(2)));
    process.exit(process.argv[2] === "status" ? 7 : 0);
  `);
  // This executable is private to the fixture, never installed on the host.
  const executable = join(scratch, "runtime.exe");
  copyFileSync(process.execPath, executable);
  writeFileSync(join(bin, "bun.ps1"), "throw 'PowerShell shim must never run'");
  writeFileSync(join(bin, "bun.cmd"), `@echo off\r\n"${executable}" %*\r\nexit /b %errorlevel%\r\n`);
  try {
    for (const installation of ["cmd", "exe"]) {
      if (installation === "exe") copyFileSync(executable, join(bin, "bun.exe"));
      const probe = `$env:PATH = '${bin.replaceAll("'", "''")}'; $bun = Get-Command bun -CommandType Application | Select-Object -First 1; Write-Output $bun.CommandType; Write-Output $bun.Source`;
      const resolution = Bun.spawn(["powershell.exe", "-NoProfile", "-EncodedCommand", Buffer.from(probe, "utf16le").toString("base64")], {
        windowsHide: true, stdout: "pipe", stderr: "pipe",
      });
      const [resolved, resolutionError, resolutionCode] = await Promise.all([
        new Response(resolution.stdout).text(), new Response(resolution.stderr).text(), resolution.exited,
      ]);
      expect(resolutionCode, resolutionError).toBe(0);
      expect(resolved.trim().split(/\r?\n/)).toEqual(["Application", join(bin, `bun.${installation}`)]);
      // a command's flags go on with it (link --code); anything that is not a plain flag is refused before Bun runs
      for (const [command, ...rest] of [["start"], ["status"], ["link", "--code", "--google"], ["link", "a&b"], ["link", "--code=%OS%"]] as [string, ...string[]][]) {
        const refused = rest.some((flag) => !/^--[a-z][a-z-]*$/.test(flag));
        rmSync(result, { force: true });
        const child = Bun.spawn(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, command, ...rest], {
          windowsHide: true,
          env: { ...process.env, USERPROFILE: prefix, HERDR_PLUGIN_STATE_DIR: scratch },
          stdout: "pipe", stderr: "pipe",
        });
        const timeout = setTimeout(() => child.kill(), 15_000);
        try {
          const [out, err, code] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
          ]);
          if (refused) {
            expect(code, `${installation} ${command} ${rest.join(" ")}: ${out}${err}`).not.toBe(0);
            expect(existsSync(result)).toBe(false);
            continue;
          }
          expect(code, `${installation} ${command}: ${out}${err}`).toBe(command === "status" ? 7 : 0);
          // start takes no flags: the launcher starts the server with the command alone
          expect(JSON.parse(readFileSync(result, "utf8"))).toEqual([command, ...rest]);
        } finally {
          clearTimeout(timeout);
        }
      }
    }
  } finally {
    await removeScratch(scratch);
  }
}, 70_000);

it("waits for every snapshotted Windows tree member after termination returns", async () => {
  const root = join(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "herdr windows stop tree "));
  const state = join(scratch, "plugin-state");
  mkdirSync(state);
  const rootPid = process.pid;
  const childPid = process.pid + 100_000_000;
  const previousRoot = process.env["HERDR_PLUGIN_ROOT"];
  const previousStateDir = process.env["HERDR_PLUGIN_STATE_DIR"];
  const previousConfigDir = process.env["HERDR_PLUGIN_CONFIG_DIR"];
  process.env["HERDR_PLUGIN_ROOT"] = root;
  process.env["HERDR_PLUGIN_STATE_DIR"] = state;
  process.env["HERDR_PLUGIN_CONFIG_DIR"] = join(scratch, "config");
  mkdirSync(join(scratch, "config"));
  writeFileSync(join(state, "server.pid"), `${rootPid}\n`);
  let terminated = false;
  let childAlive = true;
  let polls = 0;
  try {
    const { stop } = await import("./plugin.ts");
    const rootRow = {
      pid: rootPid,
      parent: 0,
      path: process.execPath,
      commandLine: `"${process.execPath}" "${join(root, "server", "managed.ts")}"`,
      started: 1,
    };
    const childRow = {
      pid: childPid,
      parent: rootPid,
      path: process.execPath,
      commandLine: `"${process.execPath}" -e child`,
      started: 2,
    };
    const result = await stop({
      isWindows: true,
      isAlive: pid => pid === rootPid ? !terminated : pid === childPid && childAlive,
      processTable: async () => {
        if (!terminated) return [rootRow, childRow];
        polls += 1;
        if (polls === 4) childAlive = false;
        return childAlive ? [childRow] : [];
      },
      terminateTree: pid => {
        expect(pid, "control: termination targets the recorded root process").toBe(rootPid);
        terminated = true;
        return { status: 0, error: undefined, stderr: "" };
      },
    });
    expect(result, "control: stop returns success after the original tree is gone").toBe(0);
    expect(childAlive, "regression (fails on main): stop must wait until every snapshotted member reports dead").toBe(false);
    expect(polls, "control: process liveness was rechecked through the delayed exit").toBe(4);
  } finally {
    for (const [key, value] of [
      ["HERDR_PLUGIN_ROOT", previousRoot],
      ["HERDR_PLUGIN_STATE_DIR", previousStateDir],
      ["HERDR_PLUGIN_CONFIG_DIR", previousConfigDir],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}, 15_000);

it.skipIf(process.platform !== "win32")("starts after its launcher exits, stops its owned tree and restarts on Windows", async () => {
  const root = join(import.meta.dir, "..");
  const scratch = mkdtempSync(join(tmpdir(), "herdr windows plugin "));
  const bin = join(scratch, ".bun", "bin");
  mkdirSync(bin, { recursive: true });
  copyFileSync(process.execPath, join(bin, "bun.exe"));
  const manifest = Bun.TOML.parse(readFileSync(join(root, "herdr-plugin.toml"), "utf8")) as {
    startup: { command: string[]; platforms: string[] }[];
    actions: { id: string; command: string[]; platforms?: string[] }[];
  };
  const socket = join(scratch, "herdr.sock");
  writeFileSync(socket, "test");
  const transcript = join(scratch, ".omp", "agent", "sessions", "history.jsonl");
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "saved history" }] } }) + "\n");
  // An isolated Herdr wire peer: no real sessions, panes, plugin registry or push keys.
  const peer = createServer(connection => {
    let buffer = "";
    connection.on("error", error => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error; // the forced stop can close a reply's pipe
    });
    connection.on("data", data => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.trim());
      const result = request.method === "ping"
        ? { version: "0.9.3", protocol: 22, capabilities: { direct_terminal_attach: false } }
        : request.method === "agent.get" ? { agent: { agent_session: { kind: "path", value: transcript } } }
        : { snapshot: { workspaces: [], panes: [{ pane_id: "history", agent: "omp", cwd: scratch }], tabs: [] } };
      connection.end(JSON.stringify({ id: request.id, result }) + "\n");
    });
  });
  await new Promise<void>((resolve, reject) => { peer.once("error", reject); peer.listen(socketAddress(socket), resolve); });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  const config = join(scratch, "config");
  const state = join(scratch, "plugin-state");
  mkdirSync(config);
  writeFileSync(join(config, ".env"), `HOST=127.0.0.1\nPORT=${port}\n`);
  const env: Record<string, string | undefined> = { ...process.env, HOME: undefined, USERPROFILE: scratch, APPDATA: join(scratch, "appdata"),
    // A running Herdr without Bun on PATH: the manifest's real Windows launcher must find it.
    Path: ["taskkill", "powershell", "git"].map(tool => dirname(Bun.which(tool)!)).join(";"),
    HERDR_SOCKET: socket, HERDR_SOCKET_PATH: socket, HERDR_PLUGIN_ROOT: undefined,
    HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: config, OVIS_STATE_DIR: join(scratch, "app-state"),
    OVIS_AUTO_UPDATE: "0", OVIS_TOKEN: "", HOST: "127.0.0.1", PORT: String(port) };
  delete env["PATH"];
  const run = async (command: string, expectedCode = 0) => {
    const entry = command === "start" ? manifest.startup.find(entry => entry.platforms.includes("windows"))
      : manifest.actions.find(entry => entry.id === `${command}-windows` && entry.platforms?.includes("windows"));
    const child = Bun.spawn(entry!.command, { cwd: root, windowsHide: true, env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err + out + (existsSync(join(state, "server.log")) ? readFileSync(join(state, "server.log"), "utf8") : "")).toBe(expectedCode);
    return out;
  };
  try {
    await run("start");
    // start's process has exited, but the managed server and its children must still answer.
    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { herdr: { terminal_mirror: boolean } };
    expect(health.herdr.terminal_mirror).toBe(true);
    // The "not built yet" notice is a 200 too: the page itself must come back.
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('<div id="root"');
    const history = await (await fetch(`http://127.0.0.1:${port}/api/pane/conversation?pane_id=history`)).json() as { source: string; turns: unknown[] };
    expect(history.source).toBe("omp-transcript");
    expect(JSON.stringify(history.turns)).toContain("saved history");
    // The spawned server must retain git on Windows' usual mixed-case Path key.
    const updates = await (await fetch(`http://127.0.0.1:${port}/api/updates`)).json() as { current_revision: string | null };
    expect(updates.current_revision).toMatch(/^[a-f0-9]{40}$/);
    const pid = Number(readFileSync(join(state, "server.pid"), "utf8").trim());
    const rows = await windowsProcessTable(30_000);
    // Windows keeps a dead parent's number on its children and hands that number on: a plain parent
    // walk can reach unrelated processes (this test's own runner among them) that never exit
    const owned = new Set([pid, ...descendantProcesses(rows, pid).map(member => member.pid)]);
    const birth = new Map(rows.map(row => [row.pid, row.started]));
    expect(owned.size).toBeGreaterThanOrEqual(3);
    for (let attempt = 0; attempt < 3; attempt++) await run("start"); // fast successful exits keep their exit code
    expect(Number(readFileSync(join(state, "server.pid"), "utf8"))).toBe(pid);
    const record = statSync(join(state, "server.pid"));
    try {
      utimesSync(join(state, "server.pid"), record.atime, new Date(0));
      await run("stop", 1); // a matching app started after an old PID record is not its owner
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
    } finally { utimesSync(join(state, "server.pid"), record.atime, record.mtime); }
    await run("stop");
    const deadline = Date.now() + 10_000;
    const stillOwned = () => [...owned].filter(member => {
      try { process.kill(member, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    });
    let remaining = stillOwned();
    while (remaining.length > 0 && Date.now() < deadline) {
      await Bun.sleep(50);
      remaining = stillOwned();
    }
    if (remaining.length > 0) {
      // a number Windows handed to a new process after the stop is no longer the owned member
      const now = new Map((await windowsProcessTable(30_000)).map(row => [row.pid, row.started]));
      remaining = stillOwned().filter(member => {
        const before = birth.get(member), after = now.get(member);
        return before === undefined || after === undefined || before === after;
      });
    }
    expect(remaining, "control: wait up to ten seconds for the Windows-owned process tree to disappear").toEqual([]);
    expect(existsSync(join(state, "server.pid"))).toBe(false);
    await run("start"); // forced Windows shutdown leaves a stale lock; restart must recover it
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
    await run("stop");
    const unrelated = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 90000)"], { windowsHide: true, stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(state, "server.pid"), String(unrelated.pid));
      await run("stop", 1);
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      expect(existsSync(join(state, "server.pid"))).toBe(true);
      rmSync(join(state, "server.pid"));
      const staleLock = join(updateStateDir(root, port, env["OVIS_STATE_DIR"]), "supervisor.lock", "pid");
      expect(existsSync(staleLock)).toBe(true);
      writeFileSync(staleLock, String(unrelated.pid));
      utimesSync(staleLock, new Date(0), new Date(0));
      await run("start"); // a reused supervisor PID must not block restart or be terminated
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).ok).toBe(true);
      expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
      await run("stop");
      // Simulate PID reuse after taskkill: the real CLI must leave this live fixture alone.
      const preload = join(scratch, "stop-boundaries.ts");
      for (const missingIdentity of [false, true]) {
        writeFileSync(join(state, "server.pid"), String(unrelated.pid));
        writeFileSync(preload, `
          Bun.spawnSync = ({ cmd }) => {
            if (cmd[0] !== "taskkill") throw new Error("unexpected termination");
            console.log("simulated tree termination");
            return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0 };
          };
          let reads = 0;
          Bun.spawn = (command) => {
            if (command[0] !== "powershell") throw new Error("unexpected probe");
            const first = reads++ === 0;
            const row = { ProcessId: ${unrelated.pid}, ParentProcessId: 0, ExecutablePath: process.execPath,
              CommandLine: '"' + process.execPath + '" "' + ${JSON.stringify(join(root, "server", "managed.ts"))} + '"',
              ...(first ? { Started: 1 } : ${missingIdentity} ? {} : { Started: 2 }) };
            return { exited: Promise.resolve(0), stdout: new Blob([JSON.stringify([row])]) };
          };
        `);
        const stop = Bun.spawn([process.execPath, "--preload", preload, join(root, "scripts", "plugin.ts"), "stop"],
          { cwd: root, windowsHide: true, env, stdout: "pipe", stderr: "pipe" });
        const [out, err, code] = await Promise.all([new Response(stop.stdout).text(), new Response(stop.stderr).text(), stop.exited]);
        expect(out).toContain("simulated tree termination");
        expect(code, out + err).toBe(missingIdentity ? 1 : 0);
        expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
        expect(existsSync(join(state, "server.pid"))).toBe(missingIdentity);
      }
    } finally {
      unrelated.kill(); await unrelated.exited;
      if (existsSync(join(state, "server.pid")) && Number(readFileSync(join(state, "server.pid"), "utf8")) === unrelated.pid) {
        rmSync(join(state, "server.pid"));
      }
    }
  } finally {
    if (existsSync(join(state, "server.pid"))) await run("stop");
    await new Promise<void>(resolve => peer.close(() => resolve()));
    await removeScratch(scratch);
  }
}, 90_000);
