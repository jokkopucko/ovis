import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneProcessInfo, SessionSnapshot } from "../shared/herdr-api.generated.ts";
import type { HerdrRuntimeFacts } from "../shared/machines.ts";
import type { MovePlanResponse } from "../shared/runtime-move.ts";
import { moveService, psProcessGroup, type MoveService, type PaneStopDeps } from "./runtime-move-service.ts";

const facts: HerdrRuntimeFacts = { serving: "herdr", source: "detected", tui: { installed: true, running: true }, app_installed: false, switch_to: "herdr-core", locked: null };
const roots: string[] = [];
const services: MoveService[] = [];

function world() {
  const root = mkdtempSync(join(tmpdir(), "ovis-runtime-move-stop-"));
  roots.push(root);
  const fronts: Record<string, { shell: number; group: number; name?: string }> = { p1: { shell: 101, group: 201 }, p2: { shell: 102, group: 202 } };
  const terminals: Record<number, number> = { 101: 201, 102: 202 };
  const shellPane = (pane_id: string) => ({ pane_id, tab_id: "t1", workspace_id: "w1", cwd: root, agent: null });
  const snapshot = { workspaces: [{ workspace_id: "w1", label: "demo" }], tabs: [{ tab_id: "t1", workspace_id: "w1", label: "1", number: 1 }], layouts: [], agents: [],
    panes: [shellPane("p1"), shellPane("p2"), { pane_id: "p9", tab_id: "t1", workspace_id: "w1", cwd: root, agent: "codex", agent_status: "working" }] } as unknown as SessionSnapshot;
  const sent: { paneId: string; keys: string[]; guard: () => boolean }[] = [];
  const signalled: number[] = [];
  let onInfo: ((paneId: string, inLane: boolean) => void) | null = null;
  let inLane = false;
  let own: number | null = 999;
  let onSend: ((paneId: string) => void) | null = null;
  const deps: PaneStopDeps = {
    snapshot: async () => snapshot,
    processInfo: async (paneId): Promise<PaneProcessInfo | undefined> => {
      onInfo?.(paneId, inLane);
      const front = fronts[paneId];
      return front ? { pane_id: paneId, shell_pid: front.shell, foreground_process_group_id: front.group, foreground_processes: [{ pid: front.group, name: front.name ?? "sleep" }] } : undefined;
    },
    sendKeys: async (paneId, keys, guard) => { sent.push({ paneId, keys, guard }); onSend?.(paneId); },
    signalGroup: (group) => { signalled.push(group); },
    ownGroup: async () => own,
    terminalGroup: async (shell) => terminals[shell] ?? null,
  };
  let tail: Promise<unknown> = Promise.resolve();
  const service = moveService({
    stateDir: join(root, "state"), port: 0, serving: () => "herdr", facts: () => facts, stores: {}, holdsPending: () => false,
    lane: (_pane, task) => { const run = tail.catch(() => undefined).then(task); tail = run; return run; },
    settleAfterTyping: async () => { inLane = true; }, inputEmpty: async () => null, switchRuntime: () => null, accepted: () => true, switching: () => false,
    stopDeps: deps, lock: { path: join(root, "runtime-move.sock") },
  });
  services.push(service);
  const wait = async () => {
    const answer = (await service.read()) as Extract<MovePlanResponse, { available: true }>;
    expect(await service.start(answer.plan.revision)).toBeNull();
    expect((await service.read()).status.state).toBe("waiting");
  };
  return { service, fronts, terminals, sent, signalled, wait, onSend: (fn: ((paneId: string) => void) | null) => { onSend = fn; }, setOwn: (group: number | null) => { own = group; }, onInfo: (fn: ((paneId: string, inLane: boolean) => void) | null) => { onInfo = fn; } };
}

afterEach(() => {
  for (const service of services.splice(0)) { service.cancel(); service.stop(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a stop and a cancel", () => {
  it("sends no Ctrl+C when the wait is cancelled during the last look at the pane", async () => {
    const { service, sent, wait, onInfo } = world();
    await wait();
    onInfo((paneId, inLane) => { if (paneId === "p1" && inLane) service.cancel(); });
    expect(await service.stopPane("p1", false)).toBe("not_waiting");
    expect(sent).toEqual([]);
  });

  it("hands herdr a guard that refuses the send once the wait is cancelled", async () => {
    const { service, sent, wait } = world();
    await wait();
    expect(await service.stopPane("p1", false)).toBeNull();
    expect(sent.map(({ paneId, keys }) => [paneId, keys])).toEqual([["p1", ["ctrl+c"]]]);
    expect(sent[0]!.guard()).toBe(true);
    service.cancel();
    expect(sent[0]!.guard()).toBe(false);
  });
});

describe("this server's own process group", () => {
  it("refuses to end anything while it is unknown", async () => {
    const { service, sent, signalled, wait, setOwn } = world();
    await wait();
    setOwn(null);
    expect(await service.stopPane("p1", false)).toBe("own_group_unknown");
    expect(await service.stopPane("p1", true)).toBe("own_group_unknown");
    expect([sent, signalled]).toEqual([[], []]);
  });

  it("refuses a pane whose command is that group", async () => {
    const { service, sent, wait, setOwn } = world();
    await wait();
    setOwn(201);
    expect(await service.stopPane("p1", false)).toBe("own_server");
    expect(sent).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("reads the same group through ps as the system reports", async () => {
    const proc = Number(readFileSync("/proc/self/stat", "utf8").replace(/^.*\) /s, "").split(" ")[2]);
    expect(await psProcessGroup(process.pid)).toBe(proc);
  });
});

describe("ending every running command at once", () => {
  it("ends only the exact list the person confirmed, once", async () => {
    const { service, fronts, sent, wait } = world();
    await wait();
    const offer = await service.prepareStopAll();
    expect(offer).toEqual({ token: expect.any(String), panes: [{ pane_id: "p1", command: "sleep" }, { pane_id: "p2", command: "sleep" }] });
    fronts["p2"] = { shell: 102, group: 303 };
    expect(await service.stopAll((offer as { token: string }).token)).toBe("changed");
    expect(sent).toEqual([]);
    const again = (await service.prepareStopAll()) as { token: string };
    expect(await service.stopAll(again.token)).toBeNull();
    expect(sent.map(({ paneId }) => paneId)).toEqual(["p1", "p2"]);
    expect(await service.stopAll(again.token)).toBe("no_offer");
    expect(sent).toHaveLength(2);
  });

  it("ends nothing for a token it did not hand out", async () => {
    const { service, sent, wait } = world();
    await wait();
    await service.prepareStopAll();
    expect(await service.stopAll("not-the-token")).toBe("no_offer");
    expect(sent).toEqual([]);
  });
});

describe("what a stop checks right before it acts", () => {
  it("sends nothing once the server stops", async () => {
    const { service, sent, wait, onInfo } = world();
    await wait();
    onInfo((paneId, inLane) => { if (paneId === "p1" && inLane) service.stop(); });
    expect(await service.stopPane("p1", false)).toBe("not_waiting");
    expect(sent).toEqual([]);
  });

  it("compares the command shown with the one in the same look as its group", async () => {
    const { service, fronts, sent, wait, onInfo } = world();
    await wait();
    let looks = 0;
    onInfo((paneId) => { if (paneId === "p1" && ++looks === 2) fronts["p1"] = { shell: 101, group: 401, name: "vim" }; });
    expect(await service.stopPane("p1", false, "sleep")).toBe("changed");
    expect(sent).toEqual([]);
  });

  it("forces only a group this PC's terminal reports in front of that shell", async () => {
    const { service, terminals, signalled, wait } = world();
    await wait();
    expect(await service.stopPane("p1", false)).toBeNull();
    const tried = Date.now();
    const realNow = Date.now;
    Date.now = () => tried + 3_100;
    try {
      // herdr's pid for the shell is not a process here (another pid namespace): nothing is signalled
      delete terminals[101];
      expect(await service.stopPane("p1", true)).toBe("not_local");
      terminals[101] = 999;
      expect(await service.stopPane("p1", true)).toBe("not_local");
      expect(signalled).toEqual([]);
      terminals[101] = 201;
      expect(await service.stopPane("p1", true)).toBeNull();
      expect(signalled).toEqual([201]);
    } finally { Date.now = realNow; }
  });
});

describe("End all after its confirm", () => {
  it("ends a later pane only while it runs the group that was confirmed", async () => {
    const { service, fronts, sent, wait, onSend } = world();
    await wait();
    const offer = (await service.prepareStopAll()) as { token: string };
    onSend((paneId) => { if (paneId === "p1") fronts["p2"] = { shell: 102, group: 303 }; });
    expect(await service.stopAll(offer.token)).toBe("changed");
    expect(sent.map(({ paneId }) => paneId)).toEqual(["p1"]);
  });

  it("offers a pane again once the command it stopped gave way to another", async () => {
    const { service, fronts, wait } = world();
    await wait();
    expect(await service.stopPane("p1", false)).toBeNull();
    fronts["p1"] = { shell: 101, group: 301 };
    const offer = (await service.prepareStopAll()) as { panes: { pane_id: string }[] };
    expect(offer.panes.map((pane) => pane.pane_id)).toEqual(["p1", "p2"]);
  });
});

describe("the merge pass's two cases", () => {
  it("sends no Ctrl+C when the command in front became another one in the same group by the last look", async () => {
    const { service, fronts, sent, wait, onInfo } = world();
    await wait();
    // the shell's job exec'd another program: same shell, same group, another name
    onInfo((paneId, inLane) => { if (paneId === "p1" && inLane) fronts["p1"] = { shell: 101, group: 201, name: "vim" }; });
    expect(await service.stopPane("p1", false, "sleep")).toBe("changed");
    expect(sent).toEqual([]);
  });

  it("ends nothing asked for after the server stopped", async () => {
    const { service, sent, wait } = world();
    await wait();
    service.stop();
    expect(await service.stopPane("p1", false)).toBe("not_waiting");
    expect(await service.prepareStopAll()).toBe("not_waiting");
    expect(sent).toEqual([]);
  });
});
