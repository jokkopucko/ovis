import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isolatedHcEnv, stopIsolatedCore } from "../scripts/test-hc.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MovePlan } from "../shared/runtime-move.ts";
import { paneSplit, sessionSnapshot, tabCreate, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { HcConnection, spawnHcConnect } from "./herdr-core/connection.ts";
import { planMove } from "./runtime-move.ts";
import { runMove } from "./runtime-move-run.ts";
import { coreDestination, herdrSource } from "./runtime-move-service.ts";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlanResponse, MoveStatus } from "../shared/runtime-move.ts";
import type { RuntimeService } from "./herdr-core/runtime-choice.ts";
import { createServer } from "./index.ts";
import { herdrRpc } from "./herdr/client.ts";

/**
 * A move of shells only, from the test herdr session to a real hc in a core of its own (its
 * session, state, config and runtime folders): built, then ended again when the switch is refused,
 * then built and kept when it is taken. Runs only where OVIS_TEST_HC_BIN names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];
const TEST_MS = 60_000;

describe.skipIf(!bin)("move of herdr's session to a real herdr-core", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mv-")));
  const stateDir = join(root, "ovis-state");
  // set only once the core's own folders exist: afterAll stops a core only through it
  let env: Record<string, string> = {};
  let hc: HcConnection | null = null;
  let workspace: string | null = null;
  const originalHcEnv = process.env["OVIS_HC_ENV"];
  const originalHcBin = process.env["OVIS_HC_BIN"];

  beforeAll(async () => {
    for (const sub of ["state", "config", "run", "ovis-state", "home", "bin"]) mkdirSync(join(root, sub), { mode: 0o700 });
    // a stand-in agent first on the core's PATH: an agent the move starts there is never a real CLI
    writeFileSync(join(root, "bin", "claude"), "#!/bin/sh\n[ \"$2\" = refused ] && { sleep 2; exit 1; }\nwhile :; do sleep 60; done\n");
    chmodSync(join(root, "bin", "claude"), 0o755);
    // and on the PATH of the login shell the move's panes start from: Debian's /etc/profile sets a PATH of its own
    writeFileSync(join(root, "home", ".profile"), `export PATH="${join(root, "bin")}:$PATH"\n`);
    env = isolatedHcEnv(root, { PATH: `${join(root, "bin")}:/usr/bin:/bin`, SHELL: "/bin/bash", OVIS_HC_BIN: bin! });
    // the move reaches the core the server would once it serves herdr-core (runtime.ts hcEnv)
    process.env["OVIS_HC_ENV"] = JSON.stringify(env);
    // found as startRuntime finds it: in this process's environment
    process.env["OVIS_HC_BIN"] = bin!;
    const started = Bun.spawn([bin!, "server", "start"], { env, stdout: "ignore", stderr: "pipe" });
    expect({ exit: await started.exited, stderr: await new Response(started.stderr).text() }).toMatchObject({ exit: 0 });
    hc = new HcConnection(() => spawnHcConnect(bin!, env));
  }, TEST_MS);

  afterAll(async () => {
    hc?.close();
    await stopIsolatedCore(bin!, env);
    if (workspace) await workspaceClose(workspace);
    if (originalHcEnv === undefined) delete process.env["OVIS_HC_ENV"]; else process.env["OVIS_HC_ENV"] = originalHcEnv;
    if (originalHcBin === undefined) delete process.env["OVIS_HC_BIN"]; else process.env["OVIS_HC_BIN"] = originalHcBin;
    rmSync(root, { recursive: true, force: true });
  });

  it("builds every workspace, tab and split on herdr-core, and ends all of it when the switch is refused", async () => {
    const left = join(root, "left");
    const right = join(root, "right");
    const logs = join(root, "logs");
    for (const dir of [left, right, logs]) mkdirSync(dir);
    const created = await workspaceCreate({ cwd: left, label: "moved" });
    workspace = created.workspace.workspace_id;
    const down = await paneSplit(created.root_pane.pane_id, "down", false);
    const tab = await tabCreate({ workspaceId: workspace, cwd: logs, label: "logs" });
    // the split's shell starts where the first pane is; its folder in the plan is the one asked of the move
    const full = await planMove(await sessionSnapshot(), { findResume: async () => null, processInfo: async () => undefined, inputEmpty: async () => null, holdsPending: () => false });
    const ours = new Set([created.root_pane.pane_id, down.pane_id, tab.root_pane.pane_id]);
    const plan: MovePlan = {
      ready: true,
      revision: full.revision,
      workspaces: full.workspaces.filter((entry) => entry.workspace_id === workspace),
      panes: full.panes.filter((pane) => ours.has(pane.pane_id)).map((pane) => ({ ...pane, cwd: pane.pane_id === down.pane_id ? right : pane.cwd, verdict: { kind: "shell" } })),
    };
    const moved = async (id: string) => (await hc!.call("terminal.list", { labels: { "ovis.move": id }, all: true })).terminals.filter((terminal) => terminal.state === "live");

    const refusedDestination = await coreDestination(stateDir, "refused-move");
    try {
      const journal = await runMove(stateDir, 7421, "refused-move", plan, herdrSource(() => false, async () => null, (_pane, task) => Promise.resolve(task())), refusedDestination, { switchRuntime: () => "locked" });
      expect([journal.state, journal.reason]).toEqual(["rolled_back", "switch_refused: locked"]);
      expect(await moved("refused-move")).toEqual([]);
    } finally { refusedDestination.close(); }

    const destination = await coreDestination(stateDir, "kept-move");
    try {
      const journal = await runMove(stateDir, 7421, "kept-move", plan, herdrSource(() => false, async () => null, (_pane, task) => Promise.resolve(task())), destination, { switchRuntime: () => null });
      expect(journal.state).toBe("committed");
    } finally { destination.close(); }
    const terminals = await moved("kept-move");
    expect(terminals.map((terminal) => terminal.cwd).sort()).toEqual([left, logs, right].sort());
    const labels = terminals.map((terminal) => terminal.labels ?? {});
    expect(new Set(labels.map((entry) => entry["herdr.space"])).size).toBe(1);
    expect(labels.map((entry) => entry["ovis.tab"] ?? "").sort()).toEqual(["1", "1", "logs"].sort());
    const layout = (await hc!.call("doc.get", { name: "ovis-layout" })).value as { workspaces: { tabs: { root: { split?: string } }[] }[] };
    expect(layout.workspaces[0]?.tabs[0]?.root.split).toBe("down");
    // herdr is left as it was: its panes are all still there
    expect((await sessionSnapshot()).panes.filter((pane) => ours.has(pane.pane_id))).toHaveLength(3);
  }, TEST_MS);

  // the whole flow over the HTTP route: a pane at work makes it wait, the person ends that agent, it
  // goes by itself; the launcher's answer decides whether it stays or is ended again
  const facts: HerdrRuntimeFacts = { serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: false, switch_to: "herdr-core", locked: null };
  async function viaRoute(answer: { ok: true } | { ok: false; status: number; code: string; message: string }) {
    const asked: unknown[] = [];
    const runtimeService: RuntimeService = { facts: () => facts, request: (target) => { asked.push(target); return answer; } };
    const server = createServer({ port: 0, hostname: "127.0.0.1", token: "test-move-route", stateDir: mkdtempSync(join(root, "route-")), runtimeService });
    const headers = { authorization: "Bearer test-move-route", "content-type": "application/json", "x-herdr-update": "1" };
    const read = async () => (await (await fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { headers })).json()) as Extract<MovePlanResponse, { available: true }>;
    const statusUntil = async (done: (status: MoveStatus) => boolean): Promise<MoveStatus> => {
      for (const deadline = Date.now() + 30_000; ;) {
        const { status } = await read();
        if (done(status)) return status;
        if (Date.now() > deadline) throw new Error(`the move's status stayed ${JSON.stringify(status)}`);
        await Bun.sleep(100);
      }
    };
    const created = await workspaceCreate({ cwd: root, label: "route" });
    const pane = created.root_pane.pane_id;
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "codex", state: "working" });
    try {
      const { plan } = await read();
      expect((await fetch(`http://127.0.0.1:${server.port}/api/runtime/move`, { method: "POST", headers, body: JSON.stringify({ revision: plan.revision }) })).status).toBe(202);
      expect((await read()).status.state).toBe("waiting");
      await herdrRpc("pane.release_agent", { pane_id: pane, source: "manual", agent: "codex" });
      const status = await statusUntil((now) => now.state !== "waiting" && now.state !== "moving");
      return { status, asked, pane };
    } finally {
      server.stop();
      await workspaceClose(created.workspace.workspace_id).catch(() => undefined);
    }
  }
  const live = async () => (await hc!.call("terminal.list", { all: true })).terminals.filter((terminal) => terminal.state === "live" && terminal.labels?.["ovis.move"]);

  it("waits for a pane at work, goes once it is done, builds everything on herdr-core and switches", async () => {
    const before = new Set((await live()).map((terminal) => terminal.address));
    const { status, asked } = await viaRoute({ ok: true });
    expect(status).toEqual({ state: "done" });
    expect(asked).toEqual(["herdr-core"]);
    const built = (await live()).filter((terminal) => !before.has(terminal.address));
    expect(built.length).toBe((await sessionSnapshot()).panes.length + 1);
    for (const terminal of built) await hc!.call("terminal.kill", { terminal: terminal.address });
  }, TEST_MS);

  it("ends everything it built on herdr-core when the launcher refuses the switch, and leaves herdr as it was", async () => {
    const before = new Set((await live()).map((terminal) => terminal.address));
    const panesBefore = (await sessionSnapshot()).panes.length;
    const { status, asked, pane } = await viaRoute({ ok: false, status: 409, code: "runtime_locked", message: "locked" });
    expect(status).toMatchObject({ state: "rolled_back", reason: "switch_refused: locked" });
    expect(asked).toEqual(["herdr-core"]);
    expect((await live()).filter((terminal) => !before.has(terminal.address))).toEqual([]);
    // herdr's own panes are all there (the route's workspace was the test's, closed after)
    expect((await sessionSnapshot()).panes.length).toBe(panesBefore);
    expect(pane).not.toBe("");
  }, TEST_MS);

  // a resumed agent in a split whose folder is gone: its shell starts home, not in the first pane's folder,
  // and the move goes on only once the agent runs the conversation it was given
  async function resumeInSplit(session: string) {
    const left = join(root, `left-${session}`);
    mkdirSync(left);
    const move = `split-${session}`;
    const plan: MovePlan = {
      ready: true, revision: "r",
      workspaces: [{ workspace_id: "w", name: move, tabs: [{ tab_id: "t", name: "1", root: { split: "right", ratio: 0.5, first: { pane: "x1" }, second: { pane: "x2" } } }] }],
      panes: [
        { pane_id: "x1", cwd: left, name: null, verdict: { kind: "shell" } },
        { pane_id: "x2", cwd: null, name: null, verdict: { kind: "resume", agent: "claude", session_id: session, argv: ["claude", "--resume", session], ended: true } },
      ],
    };
    // nothing in herdr is touched: the agent was ended there already, and no pane of the test session is named
    const source = { pane: async () => null, holdsPending: () => false, inputEmpty: async () => true, sendExit: async () => { throw new Error("no exit is typed"); }, runsConversation: async () => false, start: async () => { throw new Error("nothing restarts in herdr"); } };
    const destination = await coreDestination(stateDir, move);
    try {
      const journal = await runMove(stateDir, 7421, move, plan, source, destination, { switchRuntime: () => null });
      const terminals = (await hc!.call("terminal.list", { labels: { "ovis.move": move }, all: true })).terminals;
      return { journal, terminals };
    } finally { destination.close(); }
  }

  it("starts a split whose folder is gone in the home folder, and switches once the agent runs its conversation", async () => {
    const { journal, terminals } = await resumeInSplit("kept-session");
    expect(journal.state).toBe("committed");
    const live = terminals.filter((terminal) => terminal.state === "live");
    expect(live.map((terminal) => terminal.cwd).sort()).toEqual([join(root, "left-kept-session"), homedir()].sort());
    for (const terminal of live) await hc!.call("terminal.kill", { terminal: terminal.address });
  }, TEST_MS);

  it("rolls back when the agent started on herdr-core comes up, then refuses its conversation and quits", async () => {
    const { journal, terminals } = await resumeInSplit("refused");
    expect([journal.state, journal.reason]).toEqual(["rolled_back", "resume_unconfirmed"]);
    expect(terminals.filter((terminal) => terminal.state === "live")).toEqual([]);
  }, TEST_MS);
});
