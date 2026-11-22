import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { privateStateFs } from "./private-state.ts";

const snapshot = (panes: { id: string; status: string; agent?: string | null; focused?: boolean }[]): SessionSnapshot => ({
  panes: panes.map((pane) => ({ pane_id: pane.id, agent: pane.agent === undefined ? "claude" : pane.agent, agent_status: pane.status, focused: pane.focused ?? false })),
  agents: panes.map((pane) => ({ pane_id: pane.id, agent_status: pane.status, focused: pane.focused ?? false })),
} as unknown as SessionSnapshot);

function delayedSnapshot() {
  let release!: (value: SessionSnapshot) => void;
  const pending = new Promise<SessionSnapshot>((resolve) => { release = resolve; });
  return { read: () => pending, release };
}

describe("CompletionTracker", () => {
  it("does not let an unknown snapshot captured before a new turn finish that turn", async () => {
    const tracker = new CompletionTracker();
    const atRest = snapshot([{ id: "p", agent: "codex", status: "unknown" }]);
    tracker.present(atRest);
    let release!: (value: SessionSnapshot) => void;
    const pending = new Promise<SessionSnapshot>((resolve) => { release = resolve; });
    const reading = tracker.readSnapshot(() => pending);
    tracker.observe("p", "working", "codex");
    release(atRest);
    expect((await reading).panes[0]!.agent_status).toBe("working");
    expect(tracker.seen("p")).toBe(false);
    expect(tracker.observe("p", "unknown", "codex")).toBe("done");
  });

  it("keeps a finish and its acknowledgment ahead of an older working snapshot", async () => {
    for (const acknowledge of [false, true]) {
      const tracker = new CompletionTracker();
      tracker.observe("p", "working", "codex");
      const old = delayedSnapshot();
      const reading = tracker.readSnapshot(old.read);
      expect(tracker.observe("p", "unknown", "codex")).toBe("done");
      if (acknowledge) expect(tracker.seen("p")).toBe(true);
      old.release(snapshot([{ id: "p", agent: "codex", status: "working" }]));
      const shown = await reading;
      expect(shown.panes[0]!.agent_status).toBe(acknowledge ? "idle" : "done");
      expect(shown.agents[0]!.agent_status).toBe(acknowledge ? "idle" : "done");
      expect(tracker.observe("p", "unknown", "codex")).toBe(acknowledge ? "unknown" : "done");
    }
  });

  it("gives a later snapshot precedence when concurrent reads resolve out of order", async () => {
    for (const newerFirst of [false, true]) {
      const tracker = new CompletionTracker();
      const old = delayedSnapshot();
      const fresh = delayedSnapshot();
      const olderRead = tracker.readSnapshot(old.read);
      const newerRead = tracker.readSnapshot(fresh.read);
      if (newerFirst) {
        fresh.release(snapshot([{ id: "p", agent: "codex", status: "working" }]));
        await newerRead;
        old.release(snapshot([{ id: "p", agent: "codex", status: "unknown" }]));
        expect((await olderRead).panes[0]!.agent_status).toBe("working");
      } else {
        old.release(snapshot([{ id: "p", agent: "codex", status: "unknown" }]));
        await olderRead;
        fresh.release(snapshot([{ id: "p", agent: "codex", status: "working" }]));
        expect((await newerRead).panes[0]!.agent_status).toBe("working");
      }
      expect(tracker.observe("p", "unknown", "codex")).toBe("done");
    }
  });

  it("does not revive a closed pane from an old snapshot or forget work newer than a missing pane", async () => {
    const tracker = new CompletionTracker();
    const missing = delayedSnapshot();
    const missingRead = tracker.readSnapshot(missing.read);
    tracker.observe("p", "working", "codex");
    missing.release(snapshot([]));
    await missingRead;
    expect(tracker.observe("p", "unknown", "codex")).toBe("done");

    tracker.observe("p", "working", "codex");
    const old = delayedSnapshot();
    const reading = tracker.readSnapshot(old.read);
    tracker.forget("p");
    old.release(snapshot([{ id: "p", agent: "codex", status: "working" }]));
    expect((await reading).panes).toHaveLength(0);
    expect(tracker.observe("p", "unknown", "codex")).toBe("unknown");
  });

  it("does not restore an old agent's finish from a snapshot after its replacement", async () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "codex");
    tracker.observe("p", "unknown", "codex");
    const old = delayedSnapshot();
    const reading = tracker.readSnapshot(old.read);
    expect(tracker.observe("p", "unknown", "claude")).toBe("unknown");
    old.release(snapshot([{ id: "p", agent: "codex", status: "unknown" }]));
    expect((await reading).panes[0]!.agent_status).toBe("unknown");
    expect(tracker.present(snapshot([{ id: "p", agent: "claude", status: "unknown" }])).panes[0]!.agent_status).toBe("unknown");
  });

  it("matches finished raw identities before applying an omo display label", async () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "pi");
    tracker.observe("p", "unknown", "claude");
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
    const raw = snapshot([{ id: "p", agent: "claude", status: "idle" }]);
    const shown = await tracker.readSnapshot(async () => raw, async (value) => ({
      ...value,
      panes: value.panes.map((pane) => ({ ...pane, agent: "omo" })),
      agents: value.agents.map((agent) => ({ ...agent, agent: "omo" })),
    }));
    expect(shown.panes[0]!.agent).toBe("omo");
    expect(shown.panes[0]!.agent_status).toBe("done");
    expect(shown.agents[0]!.agent_status).toBe("done");
  });

  it("keeps new work ahead of a snapshot still waiting for display labeling", async () => {
    const tracker = new CompletionTracker();
    const raw = snapshot([{ id: "p", agent: "claude", status: "unknown" }]);
    const label = delayedSnapshot();
    let entered!: () => void;
    const labeling = new Promise<void>((resolve) => { entered = resolve; });
    const reading = tracker.readSnapshot(async () => raw, () => { entered(); return label.read(); });
    await labeling;
    tracker.observe("p", "working", "claude");
    label.release(snapshot([{ id: "p", agent: "omo", status: "unknown" }]));
    const shown = await reading;
    expect(shown.panes[0]!.agent).toBe("omo");
    expect(shown.panes[0]!.agent_status).toBe("working");
    expect(tracker.seen("p")).toBe(false);
    expect(tracker.observe("p", "unknown", "claude")).toBe("done");
  });

  it("on herdr-core, finishes only on the program's own working then idle, and keeps no badge without a report", () => {
    const tracker = new CompletionTracker(null, () => null, () => true);
    tracker.observe("reported", "working", "claude");
    expect(tracker.observe("reported", "idle", "claude")).toBe("done");
    expect(tracker.observe("reported", "unknown", "claude")).toBe("unknown");

    tracker.observe("cleared", "working", "claude");
    expect(tracker.observe("cleared", "unknown", "claude")).toBe("unknown");
    expect(tracker.observe("cleared", "idle", "claude")).toBe("idle");

    tracker.observe("handover", "working", "codex");
    expect(tracker.observe("handover", "unknown", "claude")).toBe("unknown");

    tracker.observe("paused", "blocked", "claude");
    expect(tracker.observe("paused", "idle", "claude")).toBe("idle");
    tracker.observe("resumed", "blocked", "claude");
    tracker.observe("resumed", "working", "claude");
    expect(tracker.observe("resumed", "idle", "claude")).toBe("done");

    tracker.observe("anonymous", "working", null);
    expect(tracker.observe("anonymous", "idle", null)).toBe("idle");

    tracker.observe("direct", "working", "codex");
    expect(tracker.observe("direct", "idle", "claude")).toBe("idle");

    tracker.observe("replay", "working", "claude");
    expect(tracker.observe("replay", "idle", "claude")).toBe("done");
    expect(tracker.replayed("replay", "unknown", { before: "idle", agent: "claude" })).toBe(true);
    expect(tracker.observe("replay", "unknown", "claude")).toBe("unknown");
  });

  it("on herdr-core, a resync after lost events finishes only the program that reported the work", () => {
    const tracker = new CompletionTracker(null, () => null, () => true);
    tracker.observe("same", "working", "claude");
    tracker.observe("other", "working", "codex");
    tracker.observe("cleared", "working", "claude");
    tracker.resync([{ pane_id: "same", agent_status: "idle", agent: "claude" }, { pane_id: "other", agent_status: "idle", agent: "claude" }, { pane_id: "cleared", agent_status: "unknown", agent: "claude" }], new Set());
    expect(tracker.observe("same", "idle", "claude")).toBe("done");
    expect(tracker.observe("other", "idle", "claude")).toBe("idle");
    expect(tracker.observe("cleared", "unknown", "claude")).toBe("unknown");
  });

  it("drops a derived finish when its agent leaves or another agent replaces it", () => {
    const tracker = new CompletionTracker();
    tracker.observe("left", "working", "codex");
    expect(tracker.observe("left", "unknown", "codex")).toBe("done");
    expect(tracker.observe("left", "unknown", null)).toBe("unknown");
    expect(tracker.observe("left", "unknown", "claude")).toBe("unknown");

    tracker.observe("replaced", "working", "codex");
    expect(tracker.observe("replaced", "unknown", "codex")).toBe("done");
    expect(tracker.observe("replaced", "unknown", "claude")).toBe("unknown");
    expect(tracker.observe("replaced", "idle", "claude")).toBe("idle");
  });

  it("does not transfer a persisted Codex finish to another agent after a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-replaced-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("p", "working", "codex");
      before.observe("p", "unknown", "codex");
      const after = new CompletionTracker(file, () => "herdr-a");
      expect(after.present(snapshot([{ id: "p", agent: "claude", status: "unknown" }])).panes[0]!.agent_status).toBe("unknown");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reports an idle after work as done until focus moves onto the pane, as herdr does for agents it does not lose", () => {
    const tracker = new CompletionTracker();
    // omo, live-traced: pi/working, then claude/unknown, then claude/idle
    expect(tracker.observe("p", "working", "pi")).toBe("working");
    expect(tracker.observe("p", "unknown", "claude")).toBe("working");
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
    expect(tracker.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("done");
    expect(tracker.seen("p")).toBe(true);
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("idle");
    expect(tracker.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
    expect(tracker.seen("p")).toBe(false);
  });

  it("finishes the pane herdr has focused as done: nobody moved focus there to see it", () => {
    const tracker = new CompletionTracker();
    expect(tracker.observe("p", "working", "claude")).toBe("working");
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("done");
    expect(tracker.seen("p")).toBe(true);
    expect(tracker.present(snapshot([{ id: "p", status: "idle", focused: true }])).panes[0]!.agent_status).toBe("idle");
  });

  it("leaves idle alone when the pane never worked, herdr said done itself, or it works again", () => {
    const tracker = new CompletionTracker();
    expect(tracker.observe("q", "idle")).toBe("idle");
    tracker.observe("q", "working");
    expect(tracker.observe("q", "done")).toBe("done");
    // herdr's own done turns idle when its terminal brings the pane to the front
    expect(tracker.observe("q", "idle")).toBe("idle");
    tracker.observe("r", "working");
    expect(tracker.observe("r", "idle")).toBe("done");
    expect(tracker.observe("r", "working")).toBe("working");
    expect(tracker.seen("r")).toBe(false);
  });

  it("finishes an agent that reads unknown at rest, as Codex does, and keeps it done until seen", () => {
    const tracker = new CompletionTracker();
    expect(tracker.observe("p", "unknown", "codex")).toBe("unknown");
    // live, herdr 0.9.3: codex/working for a turn, then codex/unknown at rest
    expect(tracker.observe("p", "working", "codex")).toBe("working");
    expect(tracker.observe("p", "unknown", "codex")).toBe("done");
    const codex = (status: string, focused = false) => snapshot([{ id: "p", agent: "codex", status, focused }]);
    expect(tracker.present(codex("unknown")).panes[0]!.agent_status).toBe("done");
    expect(tracker.seen("p")).toBe(true);
    expect(tracker.present(codex("unknown", true)).panes[0]!.agent_status).toBe("unknown");
    expect(tracker.observe("p", "working", "codex")).toBe("working");
    expect(tracker.observe("p", "unknown", "codex")).toBe("done");
  });

  it("keeps an agent handoff working through repeated unknown snapshots until it goes idle", () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "pi");
    const handoff = snapshot([{ id: "p", agent: "claude", status: "unknown" }]);
    for (let repeat = 0; repeat < 3; repeat++) {
      const presented = tracker.present(handoff);
      expect(presented.panes[0]!.agent_status).toBe("working");
      expect(presented.agents[0]!.agent_status).toBe("working");
    }
    expect(tracker.seen("p")).toBe(false);
    expect(tracker.observe("p", "idle", "claude")).toBe("done");
  });

  it("lets an unknown with no agent left be unknown: the agent quit", () => {
    const tracker = new CompletionTracker();
    tracker.observe("p", "working", "gjc");
    expect(tracker.observe("p", "unknown", null)).toBe("unknown");
    expect(tracker.observe("p", "idle", null)).toBe("idle");
  });

  it("forgets panes that left the snapshot", () => {
    const tracker = new CompletionTracker();
    tracker.observe("gone", "working");
    tracker.observe("gone", "idle");
    tracker.present(snapshot([]));
    expect(tracker.present(snapshot([{ id: "gone", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
  });

  it("keeps what finished across a restart of this server, and not what was still working", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("finished", "working", "gjc");
      expect(before.observe("finished", "idle", "gjc")).toBe("done");
      before.observe("running", "working", "pi");
      const after = new CompletionTracker(file, () => "herdr-a");
      const panes = after.present(snapshot([{ id: "finished", agent: "gjc", status: "idle" }, { id: "running", agent: "pi", status: "idle" }])).panes;
      expect(panes.map((pane) => pane.agent_status)).toEqual(["done", "idle"]);
      expect(after.seen("finished")).toBe(true);
      const again = new CompletionTracker(file, () => "herdr-a");
      expect(again.present(snapshot([{ id: "finished", agent: "gjc", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("flushes the kept finishes before they replace the old file, and the folder after", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-flush-"));
    const file = join(dir, "completions.json");
    const tracker = new CompletionTracker(file, () => "herdr-a");
    tracker.observe("p", "working", "gjc");
    const order: string[] = [];
    const flush = ((fd: number) => { order.push(`fsync ${fs.fstatSync(fd).isDirectory() ? "directory" : "file"}`); }) as never;
    const fsync = spyOn(fs, "fsyncSync").mockImplementation(flush);
    const directoryFsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(flush);
    const rename = spyOn(fs, "renameSync");
    rename.mockImplementation(((from: string, to: string) => { order.push("rename"); rename.mockRestore(); fs.renameSync(from, to); }) as never);
    try {
      expect(tracker.observe("p", "idle", "gjc")).toBe("done");
      fsync.mockRestore(); directoryFsync.mockRestore(); rename.mockRestore();
      expect(order).toEqual(process.platform === "win32" ? ["fsync file", "rename"] : ["fsync file", "rename", "fsync directory"]);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ herdr: "herdr-a", finished: ["p"] });
      expect(fs.readdirSync(dir)).toEqual(["completions.json"]);
    } finally {
      fsync.mockRestore(); directoryFsync.mockRestore(); rename.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a Codex finish across a restart while herdr still reports unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-codex-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("p", "working", "codex");
      before.observe("p", "unknown", "codex");
      const atRest = snapshot([{ id: "p", agent: "codex", status: "unknown" }]);
      const after = new CompletionTracker(file, () => "herdr-a");
      expect(after.present(atRest).panes[0]!.agent_status).toBe("done");
      expect(after.seen("p")).toBe(true);
      expect(new CompletionTracker(file, () => "herdr-a").present(atRest).panes[0]!.agent_status).toBe("unknown");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads legacy idle finishes without assigning their unknown identity to a new agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-legacy-"));
    try {
      const file = join(dir, "completions.json");
      writeFileSync(file, JSON.stringify({ herdr: "herdr-a", finished: ["idle", "unknown"] }));
      const tracker = new CompletionTracker(file, () => "herdr-a");
      const shown = tracker.present(snapshot([{ id: "idle", agent: "gjc", status: "idle" }, { id: "unknown", agent: "codex", status: "unknown" }]));
      expect(shown.panes.map((pane) => pane.agent_status)).toEqual(["done", "unknown"]);
      expect(tracker.seen("unknown")).toBe(false);
      expect(tracker.seen("idle")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("drops what was kept for another herdr, whose pane ids name other panes, and a broken file", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-completion-"));
    try {
      const file = join(dir, "completions.json");
      const before = new CompletionTracker(file, () => "herdr-a");
      before.observe("p", "working");
      before.observe("p", "idle");
      const restarted = new CompletionTracker(file, () => "herdr-b");
      expect(restarted.present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
      writeFileSync(file, "{not json");
      expect(new CompletionTracker(file, () => "herdr-a").present(snapshot([{ id: "p", status: "idle" }])).panes[0]!.agent_status).toBe("idle");
      const nowhere = join(dir, "none.json");
      const unnamed = new CompletionTracker(nowhere, () => null);
      unnamed.observe("p", "working");
      unnamed.observe("p", "idle");
      expect(existsSync(nowhere)).toBe(false);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ herdr: "herdr-a" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("takes a status read back from a snapshot for news only where it is a change", () => {
    const tracker = new CompletionTracker(null);
    expect(tracker.replayed("fresh", "idle", { before: "working", agent: "claude" })).toBe(true);
    expect(tracker.observe("fresh", "idle", "claude")).toBe("done");
    // herdr reads that finish as idle in a snapshot and done in an event: not news, the DONE stands
    expect(tracker.replayed("fresh", "idle", { before: "done", agent: "claude" })).toBe(false);
    expect(tracker.current("fresh")).toBe("done");
    tracker.observe("handoff", "working", "pi");
    expect(tracker.observe("handoff", "unknown", "claude")).toBe("working");
    expect(tracker.replayed("handoff", "idle", { before: "unknown", agent: "claude" })).toBe(true);
    expect(tracker.observe("handoff", "idle", "claude")).toBe("done");
    const late = new CompletionTracker(null);
    late.present(snapshot([{ id: "late", status: "unknown", agent: "codex" }]));
    expect(late.replayed("late", "unknown", { before: "working", agent: "codex" })).toBe(true);
    expect(late.observe("late", "unknown", "codex")).toBe("done");
    const settled = new CompletionTracker(null);
    settled.observe("p", "working", "claude");
    settled.present(snapshot([{ id: "p", status: "idle" }]));
    expect(settled.current("p")).toBe("done");
    expect(settled.replayed("p", "idle", { before: "working", agent: "claude" })).toBe(true);
    expect(settled.observe("p", "idle", "claude")).toBe("done");
    const lossy = new CompletionTracker(null);
    lossy.observe("p", "working", "codex");
    lossy.observe("q", "working", "codex");
    lossy.resync([{ pane_id: "p", agent_status: "idle", agent: "codex" }, { pane_id: "q", agent_status: "idle", agent: "codex" }], new Set(["q"]));
    expect([lossy.current("p"), lossy.current("q")]).toEqual(["done", "working"]);
    expect(lossy.replayed("p", "unknown", { before: "idle", agent: "codex" })).toBe(false);
    const handed = new CompletionTracker(null);
    handed.observe("p", "working", "codex");
    handed.observe("gone", "working", "codex");
    handed.resync([{ pane_id: "p", agent_status: "unknown", agent: "claude" }], new Set());
    expect(handed.current("p")).toBe("done");
    expect(handed.replayed("p", "idle", { before: "unknown", agent: "claude" })).toBe(false);
    expect(handed.current("gone")).toBeUndefined();
    expect(tracker.replayed("fresh", "working", { before: "idle", agent: "claude" })).toBe(true);
    expect(tracker.replayed("fresh", "blocked", { before: "idle", agent: "claude" })).toBe(true);
  });
});
