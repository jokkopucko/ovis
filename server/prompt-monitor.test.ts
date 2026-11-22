import { afterEach, describe, expect, it } from "bun:test";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { PromptMonitor } from "./prompt-monitor.ts";

const NEVER_MS = 3_600_000;

class FakeHerdr {
  readonly panes = new Map<string, string>();
  readonly screens = new Map<string, string | null | Error>();
  snapshots = 0;
  reads = 0;
  readsUnderWay = 0;
  mostReadsAtOnce = 0;
  snapshotFails = false;
  held: ReturnType<typeof Promise.withResolvers<void>> | null = null;

  reader() {
    return {
      snapshot: async (): Promise<SessionSnapshot> => {
        this.snapshots += 1;
        if (this.snapshotFails) throw new Error("herdr did not answer");
        const panes = [...this.panes].map(([pane_id, agent_status]) => ({ pane_id, agent_status }) as HerdrPane);
        return { panes } as SessionSnapshot;
      },
      read: async (pane: HerdrPane): Promise<string | null> => {
        this.reads += 1;
        this.readsUnderWay += 1;
        this.mostReadsAtOnce = Math.max(this.mostReadsAtOnce, this.readsUnderWay);
        const screen = this.screens.get(pane.pane_id) ?? null;
        await (this.held?.promise ?? Promise.resolve());
        this.readsUnderWay -= 1;
        if (screen instanceof Error) throw screen;
        return screen;
      },
    };
  }
}

const monitors: PromptMonitor[] = [];
afterEach(() => { for (const monitor of monitors.splice(0)) monitor.stop(); });

function setup() {
  const herdr = new FakeHerdr();
  const changes: [string, string][] = [];
  const ended: string[] = [];
  const monitor = new PromptMonitor(herdr.reader(), (paneId, signature) => changes.push([paneId, signature]), (paneId) => ended.push(paneId), NEVER_MS);
  monitors.push(monitor);
  return { herdr, changes, ended, monitor };
}

describe("PromptMonitor", () => {
  it("tells the first read and each change of what the prompt says, and nothing for the same prompt read again", async () => {
    const { herdr, changes, monitor } = setup();
    herdr.panes.set("p1", "idle");
    herdr.screens.set("p1", "trust");
    monitor.watch("p1");
    await monitor.tick();
    await monitor.tick();
    herdr.screens.set("p1", null);
    await monitor.tick();
    herdr.screens.set("p1", "trust");
    await monitor.tick();
    expect(changes.map(([paneId]) => paneId)).toEqual(["p1", "p1", "p1"]);
    const [opened, closed, reopened] = changes.map(([, signature]) => signature);
    expect(closed).not.toBe(opened);
    expect(reopened).toBe(opened);
    expect(monitor.current("p1")).toBe(reopened);
  });

  it("reads a working pane, as Codex asks its queued questions while it works", async () => {
    const { herdr, changes, monitor } = setup();
    herdr.panes.set("p1", "working");
    herdr.screens.set("p1", "queued question");
    monitor.watch("p1");
    await monitor.tick();
    expect(changes).toHaveLength(1);
  });

  it("reads a blocked pane: a watch begun while it waits is told its prompt, and so is the next step of a form while it stays blocked", async () => {
    const { herdr, changes, monitor } = setup();
    herdr.panes.set("p1", "blocked");
    herdr.screens.set("p1", "question 1 of 2");
    monitor.watch("p1");
    await monitor.tick();
    expect(changes).toHaveLength(1);
    herdr.screens.set("p1", "question 2 of 2");
    await monitor.tick();
    expect(changes).toHaveLength(2);
    expect(changes[1]![1]).not.toBe(changes[0]![1]);
    herdr.panes.set("p1", "idle");
    await monitor.tick();
    expect(changes).toHaveLength(2);
  });

  it("reads every watched pane from one snapshot a tick, and never runs two ticks at once", async () => {
    const { herdr, changes, monitor } = setup();
    herdr.panes.set("p1", "idle");
    herdr.panes.set("p2", "done");
    monitor.watch("p1");
    monitor.watch("p2");
    await monitor.tick();
    await Promise.all([monitor.tick(), monitor.tick()]);
    expect(herdr.snapshots).toBe(2);
    expect(changes.map(([paneId]) => paneId).sort()).toEqual(["p1", "p2"]);
  });

  it("reads at most four panes at once, however many are watched", async () => {
    const { herdr, changes, monitor } = setup();
    for (let i = 0; i < 10; i++) {
      herdr.panes.set(`p${i}`, "idle");
      monitor.watch(`p${i}`);
    }
    await monitor.tick();
    await monitor.tick();
    expect(changes).toHaveLength(10);
    expect(herdr.mostReadsAtOnce).toBe(4);
  });

  it("ends the watch of a pane that closed", async () => {
    const { herdr, ended, monitor } = setup();
    herdr.panes.set("p1", "idle");
    monitor.watch("p1");
    await monitor.tick();
    herdr.panes.delete("p1");
    await monitor.tick();
    expect(ended).toEqual(["p1"]);
    expect(monitor.size).toBe(0);
  });

  it("ends a watch after 10 failed reads in a row, a read that answers starting the count again, and a missed snapshot ending none", async () => {
    const { herdr, ended, monitor } = setup();
    herdr.panes.set("p1", "idle");
    herdr.screens.set("p1", new Error("pane.read failed"));
    monitor.watch("p1");
    for (let i = 0; i < 9; i++) await monitor.tick();
    herdr.screens.set("p1", null);
    await monitor.tick();
    herdr.screens.set("p1", new Error("pane.read failed"));
    for (let i = 0; i < 9; i++) await monitor.tick();
    herdr.snapshotFails = true;
    for (let i = 0; i < 20; i++) await monitor.tick();
    expect(ended).toEqual([]);
    herdr.snapshotFails = false;
    await monitor.tick();
    expect(ended).toEqual(["p1"]);
    expect(monitor.size).toBe(0);
  });

  it("counts no failed read of a watch that ended against the pane's new watch", async () => {
    const { herdr, ended, monitor } = setup();
    herdr.panes.set("p1", "idle");
    herdr.screens.set("p1", new Error("pane.read failed"));
    monitor.watch("p1");
    for (let i = 0; i < 9; i++) await monitor.tick();
    herdr.held = Promise.withResolvers<void>();
    const late = monitor.tick();
    await until(() => herdr.readsUnderWay === 1);
    monitor.unwatch("p1");
    monitor.watch("p1");
    herdr.held.resolve();
    await late;
    expect(ended).toEqual([]);
    expect(monitor.size).toBe(1);
  });
});

async function until(check: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100 && !check(); turn++) await Promise.resolve();
  expect(check()).toBe(true);
}
