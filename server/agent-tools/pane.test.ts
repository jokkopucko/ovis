import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessToolSetting, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import * as herdr from "../herdr/client.ts";
import { AcpChildren } from "../acp/children.ts";
import { KEEPER_BUILD, keeperBuilt } from "../acp/keeper.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import * as runtime from "../herdr-core/runtime.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { agentLaunch } from "../agent-launch.ts";
import { PreferenceStore } from "../preferences.ts";
import * as stateDocument from "../state-document.ts";
import { AgentToolHub } from "./hub.ts";
import { procLink, type PaneTerminal } from "./pane-proof.ts";
import { callerArgv, code, paneCallers, paneRuns, quote } from "./pane-test-fixture.ts";

const START: HarnessToolSetting = { level: "start", depth: 1, harnesses: ["opencode"] };
let state: string, hub: AgentToolHub, setting: HarnessToolSetting, terminals: PaneTerminal[];
let snapshot: ReturnType<typeof spyOn>;

function paneHub(preferences?: PreferenceStore) {
  return new AgentToolHub({ dir: join(state, "agent-tools"), setting: () => preferences ? harnessToolSetting(preferences.get().settings.agentHarnessTool) : setting,
    paneRunEpoch: () => preferences?.paneRunEpoch ?? null, acp: new AcpChildren(join(state, "acp")), resolve: () => null,
    panes: { list: async () => terminals, get: async address => terminals.find(t => t.address === address) ?? null } });
}

const paneRegistry = () => join(state, "agent-tools", "pane-runs.json");
const runs = () => paneRuns(paneRegistry());
const { callerEnv, inPane, outside, holdPane } = paneCallers(() => state, terminal => {
  terminals = [...terminals.filter(t => t.address !== terminal.address), terminal];
});

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "athp-"));
  setting = START;
  terminals = [];
  hub = paneHub();
  hub.listen();
  snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ protocol: 22, version: "fixture", agents: [], workspaces: [], tabs: [], layouts: [], panes: [] });
});
afterEach(() => { snapshot.mockRestore(); hub.close(); rmSync(state, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "linux")("ovis agent from a pane hc started", () => {
  it("accepts concurrent first calls from one proven pane without asking for consent", async () => {
    const shell = await holdPane("t7");
    try {
      const line = callerArgv(["ls", "--json"]).map(quote).join(" ");
      expect((await shell.run(`${line} & ${line}; wait`, 2)).map(reply => reply.kind)).toEqual(["sessions", "sessions"]);
    } finally { await shell.close(); }
  });

  it.skipIf(!keeperBuilt)("starts work on the first call from a proven pane and only asks a person for the child's own approval", async () => {
    hub.close();
    serveRuntime(HERDR_CORE);
    const program = join(state, "agy");
    const replay = join(import.meta.dir, "replay-agent.fake.ts");
    const recording = join(import.meta.dir, "fixtures/agy-1.5.16-ask-write.jsonl");
    writeFileSync(program, `#!/bin/sh\n[ "$1" = --version ] && { echo 1.5.16; exit; }\nexec ${quote(process.execPath)} ${quote(replay)} ${quote(recording)} ${quote(join(state, "replay.jsonl"))}\n`);
    chmodSync(program, 0o755);
    const programs: ReturnType<typeof Bun.spawn>[] = [];
    const fake = new FakeHcCore();
    fake.onStart = started => { programs.push(Bun.spawn([...started.argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: callerEnv() })); };
    const hc = new HcConnection(() => fake.transport());
    const acp = new AcpChildren(join(state, "acp"), { hc, keeperBin: () => KEEPER_BUILD });
    setting = { ...START, harnesses: ["agy"] };
    hub = new AgentToolHub({ dir: join(state, "agent-tools"), acp, setting: () => setting, resolve: () => ({ argv: [program] }),
      panes: { list: async () => terminals, get: async address => terminals.find(t => t.address === address) ?? null } });
    hub.listen();
    const shell = await holdPane("t7");
    try {
      const started = await shell.call(["start", "--harness", "agy", "--cwd", state, "--task", "write a file", "--json"]);
      expect(started).toMatchObject({ kind: "session", sent: { accepted: true } });
      const session = started.session;
      if (!session || typeof session !== "object" || !("address" in session) || typeof session.address !== "string") throw new Error("missing child address");
      expect(await shell.call(["wait", session.address, "--timeout-s", "5", "--json"])).toMatchObject({ state: { state: "waiting_human" } });
      expect(acp.forPane(session.address)?.client.pending()).toHaveLength(1);
    } finally {
      await shell.close();
      acp.close();
      for (const proc of programs) { proc.kill(); await proc.exited; }
      hc.close();
      serveRuntime(null);
    }
  });

  it("shares one pane run and its call count across processes and an Ovis restart", async () => {
    const shell = await holdPane("t7", "t7");
    try {
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      const [first] = runs();
      if (!first) throw new Error("missing first pane run");
      hub.close();
      hub = paneHub();
      await hub.reconcilePanes();
      hub.listen();
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      expect(runs()).toEqual([{ id: first.id, self: "t7", calls: 2 }]);
    } finally { await shell.close(); }
  });

  it("refuses tokenless calls in a pane Ovis already manages", async () => {
    hub.runs.reserve().bind({ self: "t7", root: "0123456789abcdef", depth: 0, started_by: null, harness: "omo" });
    expect(code((await inPane("t7", ["ls", "--json"])).reply)).toBe("not_granted");
  });

  it("marks an Ovis-launched OpenCode pane before its tokenless process calls the tool", async () => {
    const fake = new FakeHcCore();
    const terminal = fake.spawn();
    const hc = new HcConnection(() => fake.transport());
    const connection = spyOn(runtime, "coreConnection").mockReturnValue(hc);
    const shell = await holdPane(terminal.address);
    let reply: Record<string, unknown> | undefined;
    const start = spyOn(herdr, "agentStart").mockImplementationOnce(async () => {
      const { labels } = await hc.call("terminal.get", { terminal: terminal.address });
      terminals = terminals.map(t => t.address === terminal.address ? { ...t, labels } : t);
      reply = await shell.call(["ls", "--json"]);
    });
    serveRuntime(HERDR_CORE);
    try {
      expect(await agentLaunch(terminal.address, { kind: "opencode", name: "opencode-fixture" })).toEqual({ agent_started: true });
      expect(reply).toMatchObject({ kind: "refusal", error: { code: "not_granted" } });
      expect(await shell.call(["ls", "--json"])).toMatchObject({ error: { code: "not_granted" } });
    } finally {
      start.mockRestore(); connection.mockRestore(); serveRuntime(null);
      await shell.close(); hc.close();
    }
  });

  it("does not restore revoked runs after re-enabling starts and restarting with the old registry still intact", async () => {
    const preferences = new PreferenceStore(state);
    preferences.set({ settings: { agentHarnessTool: START } });
    hub.close();
    hub = paneHub(preferences);
    hub.listen();
    const first = await holdPane("t7"), second = await holdPane("t8");
    const unsubscribe = preferences.subscribe(() => hub.settingsChanged());
    const write = stateDocument.writeStateDocument;
    let registryUnavailable = false;
    const failed = spyOn(stateDocument, "writeStateDocument").mockImplementation((path, text, keepDamaged) => {
      if (path === paneRegistry() && registryUnavailable) throw new Error("fixture: registry write failed");
      write(path, text, keepDamaged);
    });
    try {
      for (const shell of [first, second]) expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      const previous = runs().map(row => row.id);
      const oldFile = readFileSync(paneRegistry(), "utf8");
      registryUnavailable = true;
      expect(() => preferences.set({ settings: { agentHarnessTool: { ...START, level: "view" } } })).toThrow("fixture: registry write failed");
      preferences.set({ settings: { agentHarnessTool: START } });
      expect(readFileSync(paneRegistry(), "utf8")).toBe(oldFile);
      hub.close();
      hub = paneHub(new PreferenceStore(state));
      await hub.reconcilePanes();
      hub.listen();
      registryUnavailable = false;
      for (const shell of [first, second]) expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      expect(runs().filter(row => previous.includes(row.id))).toEqual([]);
    } finally { failed.mockRestore(); unsubscribe(); await first.close(); await second.close(); }
  });

  it("keeps a live legacy pane's run and start key across upgrade and removes the old decisions", async () => {
    const shell = await holdPane("t7");
    try {
      const terminal = terminals[0], root = terminal?.pid;
      const birth = root ? procLink(root)?.birth : undefined;
      if (!terminal || !root || !birth) throw new Error("missing fixture root");
      const key = { pane: terminal.address, created_ms: terminal.created_ms, root, birth };
      const id = "0123456789abcdef", child = "fedcba9876543210";
      const grants = join(state, "agent-tools", "pane-grants.json");
      writeFileSync(paneRegistry(), JSON.stringify([{ run: { id, self: key.pane, root: id, depth: 0, started_by: null, harness: "hc-pane", created_ms: 1 }, starts: [{ key: "work", run: child }], calls: [] }]));
      writeFileSync(grants, JSON.stringify([{ id: "ab0123456789cdef", key, state: "allowed", run: id, label: "legacy pane" }]));
      hub.close();
      hub = paneHub();
      await hub.reconcilePanes();
      hub.listen();
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      expect(runs()).toEqual([{ id, self: key.pane, calls: 1 }]);
      expect(hub.runs.previousStart(id, "work")).toBe(child);
      expect(existsSync(grants)).toBe(false);
    } finally { await shell.close(); }
  });

  it("removes stale legacy decisions even when there is no registry to migrate", () => {
    const grants = join(state, "agent-tools", "pane-grants.json");
    writeFileSync(grants, JSON.stringify([{ state: "denied" }]));
    hub.close();
    hub = paneHub();
    expect(existsSync(grants)).toBe(false);
  });

  it("refuses a process outside every pane", async () => {
    terminals = [{ address: "t7", state: "live", pid: 999_999_999, created_ms: 1, labels: {} }];
    const reply = await outside(["ls", "--json"]);
    expect(reply.code).toBe(1);
    expect(code(reply.reply)).toBe("not_granted");
  });

  it("refuses another pane's process that claims to be pane X, and never grants it X's run", async () => {
    const shell = await holdPane("t7");
    try {
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      const posing = await inPane("t9", ["ls", "--json"], { hint: "t7" });
      expect(code(posing.reply)).toBe("not_granted");
      expect(runs()).toEqual([expect.objectContaining({ self: "t7", calls: 1 })]);
      expect((await inPane("t9", ["ls", "--json"])).reply).toMatchObject({ kind: "sessions" });
    } finally { await shell.close(); }
  });

  it("ends a closed pane's run and starts a new one at the same address", async () => {
    const shell = await holdPane("t7");
    let previous: string | undefined;
    try {
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      previous = runs()[0]?.id;
    } finally { await shell.close(); }
    terminals = [];
    await hub.reconcilePanes();
    expect(runs()).toEqual([]);
    expect((await inPane("t7", ["ls", "--json"])).reply).toMatchObject({ kind: "sessions" });
    expect(runs()[0]?.id).not.toBe(previous);
  });

  it("ends the old run when hc reports a different root for a pane that is still open", async () => {
    const previous = await holdPane("t7");
    try {
      expect(await previous.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      const prior = terminals.find(t => t.address === "t7");
      const replacement = await holdPane("t7");
      try {
        terminals = terminals.map(t => t.address === "t7" && prior ? { ...t, created_ms: prior.created_ms } : t);
        await hub.reconcilePanes();
        expect(runs()).toEqual([]);
        expect(code(await previous.call(["ls", "--json"]))).toBe("not_granted");
        expect(await replacement.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      } finally { await replacement.close(); }
    } finally { await previous.close(); }
  });

  it.each([["view", "not_granted"], ["off", "tools_off"]] as const)("refuses a proved pane and ends its run at %s", async (level, reason) => {
    const shell = await holdPane("t7");
    try {
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      setting = { ...START, level };
      hub.settingsChanged();
      expect(code(await shell.call(["ls", "--json"]))).toBe(reason);
      expect(runs()).toEqual([]);
    } finally { await shell.close(); }
  });

  it("keeps the hub's limits: an unticked harness is not started for a pane", async () => {
    const shell = await holdPane("t7");
    try {
      const request = ["start", "--harness", "opencode", "--cwd", state, "--json"];
      setting = { ...START, harnesses: ["agy"] };
      expect(code(await shell.call(request))).toBe("not_granted");
      setting = START;
      expect(code(await shell.call(request))).toBe("start_failed"); // only the missing fixture adapter stops it
    } finally { await shell.close(); }
  });

  it("still refuses starts on other machines for a proved local pane", async () => {
    const reply = await inPane("t7", ["start", "--harness", "opencode", "--on", "other", "--json"]);
    expect(reply.reply).toMatchObject({ error: { code: "approval_required", message: expect.stringContaining("another machine") } });
  });
});
