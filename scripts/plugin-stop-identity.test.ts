import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessBirth } from "../server/process-owner.ts";

/**
 * herdr plugin update builds the new version in a new installation folder while the server the old folder started
 * runs on. Stop, run from the new folder (HERDR_PLUGIN_ROOT) with the same plugin state folder, must stop that server
 * by the identity start recorded (pid and birth), and nothing else. Each case runs in a process of its own, as
 * scripts/plugin.ts reads its state folder once.
 */
const root = join(import.meta.dir, "..");

async function runStop(scratch: string, body: string, argv?: string[]): Promise<{ code: number; out: string; err: string }> {
  const script = join(scratch, "stop.ts");
  writeFileSync(script, `const { stop } = await import(${JSON.stringify(join(root, "scripts", "plugin.ts"))});\n${body}`);
  const newFolder = join(scratch, "new installation", "checkout");
  mkdirSync(newFolder, { recursive: true });
  const child = Bun.spawn([process.execPath, ...argv ?? [script]], {
    env: { ...process.env, HERDR_PLUGIN_ROOT: newFolder, HERDR_PLUGIN_STATE_DIR: join(scratch, "state"), HERDR_PLUGIN_CONFIG_DIR: join(scratch, "config"), OVIS_PLUGIN_CHECKOUT: "" },
    stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, out, err };
}

function scratchWithRecord(pid: number, birth?: { platform: string; value: string }): string {
  const scratch = mkdtempSync(join(tmpdir(), "ovis stop identity "));
  mkdirSync(join(scratch, "state")); mkdirSync(join(scratch, "config"));
  writeFileSync(join(scratch, "state", "server.pid"), `${pid}\n`);
  writeFileSync(join(scratch, "state", "server.owner"), `${JSON.stringify(birth ? { pid, birth } : { pid, birth_unknown: true })}\n`);
  return scratch;
}

const windowsCase = (rowStarted: number, commandLine: string) => `
  const own = '"' + process.execPath + '" "' + ${JSON.stringify(join(root, "server", "managed.ts"))}.replace(${JSON.stringify(root)}, process.env.HERDR_PLUGIN_ROOT) + '"';
  const pid = Number((await Bun.file(process.env.HERDR_PLUGIN_STATE_DIR + "/server.pid").text()).trim()), rows = [{ pid, parent: 0, path: process.execPath, commandLine: ${JSON.stringify(commandLine)} === "OWN" ? own : ${JSON.stringify(commandLine)}, started: ${rowStarted} }];
  let target = 0, terminated = false;
  const result = await stop({ isWindows: true, isAlive: () => !terminated, processTable: async () => terminated ? [] : rows,
    terminateTree: (p) => { target = p; terminated = true; return { status: 0, error: undefined, stderr: "" }; } });
  console.log(JSON.stringify({ result, stopped: target === pid }));`;
const oldFolderServer = `"${process.execPath}" "${join(tmpdir(), "old installation", "checkout", "server", "managed.ts")}"`;

it("stops, from a new installation folder, the server another folder started: by its recorded pid and birth", async () => {
  const scratch = scratchWithRecord(process.pid, { platform: "win32", value: "1700000000000" });
  try {
    const { code, out, err } = await runStop(scratch, windowsCase(1700000000000, oldFolderServer));
    expect(code, err).toBe(0);
    expect(JSON.parse(out.trim().split("\n").at(-1)!), err).toEqual({ result: 0, stopped: true });
    // install.ps1 takes a stdout line starting `stopped ` for "this stop stopped a server"
    expect(out).toMatch(new RegExp(`^stopped Ovis \\(pid ${process.pid}\\)$`, "m"));
    expect(existsSync(join(scratch, "state", "server.pid")), "the next start finds no server recorded").toBe(false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 30_000);

it("refuses a process that only holds the recorded pid, even one whose command line names this plugin's server", async () => {
  for (const commandLine of [oldFolderServer, `"${process.execPath}" "${join(root, "server", "managed.ts")}"`]) {
    const scratch = scratchWithRecord(process.pid, { platform: "win32", value: "1700000000000" });
    try {
      const { code, out, err } = await runStop(scratch, windowsCase(1700000009999, commandLine));
      expect(code, err).toBe(0);
      expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ result: 1, stopped: false });
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(true);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}, 60_000);

it("stops a real process recorded the way start records it, from another folder, on this platform", async () => {
  const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { detached: true, stdio: "ignore", windowsHide: true });
  let scratch = "";
  try {
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    const pid = server.pid!;
    const birth = readProcessBirth(pid);
    if (birth.state !== "identified") throw new Error(`no birth for ${pid}: ${birth.state}`);
    scratch = scratchWithRecord(pid, birth.birth);
    const { code, out, err } = await runStop(scratch, "process.exitCode = await stop();");
    expect(code, `${out}\n${err}`).toBe(0);
    await exited;
    expect(existsSync(join(scratch, "state", "server.pid"))).toBe(false);
  } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);

// install.ps1 decides whether the repair's stop stopped a server ($said -match '^stopped ') by this line, from the stop of
// the checkout's sources and from the release binary's (`ovis-server plugin stop`, whose entry is server/main.ts)
it("says `stopped ` at the start of a stdout line for the server it stopped, and only then, from source and as the release binary runs it", async () => {
  for (const entry of [[join(root, "scripts", "plugin.ts"), "stop"], [join(root, "server", "main.ts"), "plugin", "stop"]]) {
    const server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { detached: true, stdio: "ignore", windowsHide: true });
    let scratch = "";
    try {
      const pid = server.pid!;
      const birth = readProcessBirth(pid);
      if (birth.state !== "identified") throw new Error(`no birth for ${pid}: ${birth.state}`);
      scratch = scratchWithRecord(pid, birth.birth);
      const stopped = await runStop(scratch, "", entry);
      expect(stopped.code, `${entry[0]}\n${stopped.out}\n${stopped.err}`).toBe(0);
      expect(stopped.out).toMatch(new RegExp(`^stopped Ovis \\(pid ${pid}\\)`, "m"));
      const none = await runStop(scratch, "", entry);
      expect(none.code, none.err).toBe(0);
      expect(none.out).not.toMatch(/^stopped /m);
    } finally {
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }
}, 60_000);

it("stops a server whose creation time matches exactly, though its pid record is older than its start", async () => {
  const scratch = scratchWithRecord(process.pid, { platform: "win32", value: "1700000000000" });
  try {
    utimesSync(join(scratch, "state", "server.pid"), new Date(0), new Date(0));
    const { code, out, err } = await runStop(scratch, windowsCase(1700000000000, oldFolderServer));
    expect(code, err).toBe(0);
    expect(JSON.parse(out.trim().split("\n").at(-1)!), err).toEqual({ result: 0, stopped: true });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}, 30_000);

it("with no creation time recorded, stops this folder's server form only when its pid record is not older than its start", async () => {
  for (const aged of [false, true]) {
    const scratch = scratchWithRecord(process.pid);
    try {
      if (aged) utimesSync(join(scratch, "state", "server.pid"), new Date(0), new Date(0));
      const { code, out, err } = await runStop(scratch, windowsCase(1700000000000, "OWN"));
      expect(code, err).toBe(0);
      expect(JSON.parse(out.trim().split("\n").at(-1)!), `aged: ${aged}\n${err}`).toEqual(aged ? { result: 1, stopped: false } : { result: 0, stopped: true });
      expect(existsSync(join(scratch, "state", "server.pid"))).toBe(aged);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
}, 60_000);
