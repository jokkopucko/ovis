import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import machines from "../site/demo/fixtures/machines.json";
import { CompletionTracker } from "./completion.ts";
import { Finishes, finishHerdrIdentity, herdrLifetime } from "./finishes.ts";
import { LaunchedAgents } from "./launched-agents.ts";
import { shownStatus } from "../src/lib/sidebarOrder.ts";

function snapshot(status: AgentStatus): SessionSnapshot {
  const fixture = machines.machines[0]!.snapshot!;
  return { ...fixture, panes: [{ ...fixture.panes[0]!, pane_id: "p", agent: "codex", agent_status: status }],
    agents: [{ ...fixture.agents[0]!, pane_id: "p", agent: "codex", agent_status: status, state_change_seq: 5 }] };
}

it("counts the completion tracker's displayed DONE with an unchanged herdr sequence", async () => {
  const tracker = new CompletionTracker();
  const finishes = new Finishes(() => "daemon-a");
  const shown = async (status: AgentStatus) => finishes.snapshot(await tracker.readSnapshot(async () => snapshot(status)), tracker);
  expect((await shown("working")).panes[0]?.finish_id).toBe(0);
  const done = await shown("unknown");
  expect(done.agents[0]?.state_change_seq).toBe(5);
  expect(done.panes[0]).toMatchObject({ agent_status: "done", finish_id: 1 });
  expect((await shown("unknown")).panes[0]?.finish_id).toBe(1);
  await shown("working");
  expect((await shown("unknown")).panes[0]?.finish_id).toBe(2);
});

it("counts only the post-launch status, not startup's raw WORKING and DONE", () => {
  const launched = new LaunchedAgents();
  const finishes = new Finishes(() => "daemon-a");
  launched.launched("p", "codex", 100);
  expect(finishes.status("p", launched.settle("p", "working", 100)).finish_id).toBe(0);
  expect(finishes.status("p", launched.settle("p", "done", 101)).finish_id).toBe(0);
  finishes.status("p", launched.settle("p", "working", 102));
  expect(finishes.status("p", launched.settle("p", "done", 103)).finish_id).toBe(1);
});

it("keeps a newer live finish when an older empty roster completes, but retires a fresh absence", async () => {
  const tracker = new CompletionTracker();
  const finishes = new Finishes(() => "daemon-a");
  const empty = { ...snapshot("done"), panes: [], agents: [] };
  const held = Promise.withResolvers<SessionSnapshot>();
  const older = tracker.readSnapshot(() => held.promise).then((read) => finishes.snapshot(read, tracker));
  finishes.status("p", tracker.observe("p", "working", "codex"));
  const opened = finishes.status("p", tracker.observe("p", "done", "codex"));
  finishes.snapshot(await tracker.readSnapshot(async () => snapshot("done")), tracker);
  held.resolve(empty);
  await older;
  expect(tracker.current("p")).toBe("done");
  expect(finishes.status("p", "done")).toEqual(opened);
  finishes.snapshot(await tracker.readSnapshot(async () => empty), tracker);
  expect(tracker.current("p")).toBeUndefined();
  expect(finishes.status("p", "done").finish_id).toBe(opened.finish_id + 1);
});

it("dates a resync-observed turn before a held refresh resolves over its completion", async () => {
  const completions = new CompletionTracker();
  const finishes = new Finishes(() => "daemon-a");
  const report = (status: AgentStatus) => finishes.status("p", completions.observe("p", status, "codex"));
  report("working");
  const opened = report("done");
  finishes.resync(completions, snapshot("working").panes, new Set());
  const held = Promise.withResolvers<SessionSnapshot>();
  const refresh = completions.readSnapshot(() => held.promise).then((read) => finishes.snapshot(read, completions));
  const next = report("done");
  held.resolve(snapshot("working"));
  const read = await refresh;
  expect(next.finish_id).toBe(opened.finish_id + 1);
  expect(read.panes[0]?.finish_id).toBe(next.finish_id);
  expect(shownStatus(read.panes[0]!, { p: opened.finish_id })).toBe("done");
});

it("does not replay a stale resync WORKING over a pane in the newer exclusions", () => {
  const completions = new CompletionTracker();
  const finishes = new Finishes(() => "daemon-a");
  const opened = finishes.status("p", completions.observe("p", "done", "codex"));
  finishes.resync(completions, snapshot("working").panes, new Set(["p"]));
  expect(finishes.status("p", completions.current("p")!)).toEqual(opened);
});

it("does not resurrect an excluded pane that ended while the resync read was pending", () => {
  const completions = new CompletionTracker();
  const finishes = new Finishes(() => "daemon-a");
  const opened = finishes.status("p", completions.observe("p", "done", "codex"));
  completions.forget("p");
  finishes.ended("p");
  finishes.resync(completions, snapshot("done").panes, new Set(["p"]));
  expect(finishes.status("p", "working").finish_id).toBe(opened.finish_id);
  expect(finishes.status("p", "done").finish_id).toBe(opened.finish_id + 1);
});
it("shares one counter between status frames and snapshots, including repeats and pane ID reuse", () => {
  const finishes = new Finishes(() => "daemon-a");
  finishes.status("p", "working");
  const event = finishes.status("p", "done");
  expect(event.finish_id).toBe(1);
  expect(finishes.snapshot(snapshot("done"), new CompletionTracker())).toMatchObject({ finish_epoch: event.finish_epoch, panes: [{ finish_id: 1 }] });
  expect(finishes.status("p", "done")).toEqual(event);
  finishes.ended("p");
  expect(finishes.status("p", "done").finish_id).toBe(2);
});

it("starts with a random epoch per server and rotates on proven herdr identity change, not read failures", () => {
  let identity: string | null = "daemon-a";
  const finishes = new Finishes(() => identity);
  const first = finishes.status("p", "done");
  expect(new Finishes(() => identity).epoch).not.toBe(first.finish_epoch);
  identity = null;
  expect(finishes.epoch).toBe(first.finish_epoch);
  identity = "daemon-a";
  expect(finishes.status("p", "done")).toEqual(first);
  identity = "daemon-b";
  const restarted = finishes.status("p", "done");
  expect(restarted.finish_epoch).not.toBe(first.finish_epoch);
  expect(restarted.finish_id).toBe(1);
  expect(finishes.snapshot(snapshot("done"), new CompletionTracker()).finish_epoch).toBe(restarted.finish_epoch);
});

it("names one herdr by the same opaque lifetime from every server, and another herdr by another", () => {
  const identity = "66306:1234567:1790829888292852700";
  expect(herdrLifetime(identity)).toBe(herdrLifetime(identity));
  expect(herdrLifetime(identity)).toMatch(/^[0-9a-f]{32}$/);
  expect(herdrLifetime(identity)).not.toContain("1234567");
  expect(herdrLifetime("66306:1234568:1790829888292852700")).not.toBe(herdrLifetime(identity));
});

it("recognizes a replaced socket file and Windows marker incarnation, never just a reused PID", () => {
  const dir = mkdtempSync(join(tmpdir(), "finish-identity-"));
  try {
    const first = join(dir, "first"), second = join(dir, "second");
    writeFileSync(first, "123:1790829888292852700");
    writeFileSync(second, "123:1790829888292852701");
    expect(finishHerdrIdentity(first, "linux")).not.toBe(finishHerdrIdentity(second, "linux"));
    expect(finishHerdrIdentity(first, "win32")).not.toBe(finishHerdrIdentity(second, "win32"));
    expect(finishHerdrIdentity(join(dir, "missing"), "linux")).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps a moved pane's finish count under its new ID, so a finish read before the move stays read (#1503)", () => {
  const finishes = new Finishes(() => "daemon-a");
  finishes.status("w1:p1", "working");
  expect(finishes.status("w1:p1", "done").finish_id).toBe(1);
  finishes.moved("w1:p1", "w2:p1");
  // the same finish, told again under the new ID, is not a new one
  expect(finishes.status("w2:p1", "done").finish_id).toBe(1);
  finishes.status("w2:p1", "working");
  expect(finishes.status("w2:p1", "done").finish_id).toBe(2);
  // herdr reusing the old ID later goes on from its count, as for any ended pane
  expect(finishes.status("w1:p1", "done").finish_id).toBe(2);
});

it("counts a moved pane's finishes above what a reused new ID had, and renumbers the reads of its latest (#1503)", () => {
  const finishes = new Finishes(() => "daemon-a");
  // an earlier pane under w2:p1 finished four times and ended
  for (let turn = 0; turn < 4; turn++) { finishes.status("w2:p1", "working"); finishes.status("w2:p1", "done"); }
  finishes.status("w2:p1", "unknown");
  finishes.status("w1:p1", "working");
  expect(finishes.status("w1:p1", "done").finish_id).toBe(1);
  const renumber = finishes.moved("w1:p1", "w2:p1");
  // the moved finish is the same one under the new ID: above the earlier pane's, and a read of it stays a read
  expect(finishes.status("w2:p1", "done").finish_id).toBe(5);
  expect(renumber(1)).toBe(5);
  expect(renumber(0)).toBe(0);
  finishes.status("w2:p1", "working");
  expect(finishes.status("w2:p1", "done").finish_id).toBe(6);
});

it("counts a new finish under a moved pane's new ID when its work was still told under the old ID (#1503)", () => {
  const finishes = new Finishes(() => "daemon-a");
  finishes.status("w1:p1", "working");
  expect(finishes.status("w1:p1", "done").finish_id).toBe(1);
  finishes.moved("w1:p1", "w2:p1");
  // a late event of the old ID: the moved pane went back to work
  finishes.status("w1:p1", "working");
  expect(finishes.status("w2:p1", "done").finish_id).toBe(2);
});

it("counts a late old-ID status for the pane's newest ID after two moves (#1503)", () => {
  const finishes = new Finishes(() => "daemon-a");
  finishes.status("a", "working");
  expect(finishes.status("a", "done").finish_id).toBe(1);
  finishes.moved("a", "b");
  finishes.moved("b", "c");
  finishes.status("a", "working");
  expect(finishes.status("c", "done").finish_id).toBe(2);
});
