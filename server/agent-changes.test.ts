import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentStatus, SessionSnapshot } from "../shared/protocol.ts";
import machines from "../site/demo/fixtures/machines.json";
import { AgentChanges } from "./agent-changes.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), "agent-changes-")); dirs.push(dir); return dir; };

/** A PC's snapshot of agents given as [pane, status, herdr's counter]. */
function snapshot(...agents: [string, AgentStatus, number][]): SessionSnapshot {
  const fixture = machines.machines[0]!.snapshot! as unknown as SessionSnapshot;
  return { ...fixture,
    panes: agents.map(([pane_id, agent_status]) => ({ ...fixture.panes[0]!, pane_id, agent: "claude", agent_status })),
    agents: agents.map(([pane_id, agent_status, state_change_seq]) => ({ ...fixture.agents[0]!, pane_id, agent: "claude", agent_status, state_change_seq })) };
}
const times = (shown: SessionSnapshot): Record<string, number | undefined> =>
  Object.fromEntries(shown.panes.map((pane) => [pane.pane_id, pane.changed_at]));

function clock(start = 1_000): { now: () => number; at: (t: number) => void } {
  let t = start;
  return { now: () => t, at: (next) => { t = next; } };
}

it("dates nothing on first sight, and a raised counter on any PC by the one clock", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  // two PCs whose counters have unrelated origins
  expect(times(changes.snapshot("local", snapshot(["a", "done", 1297]), true))).toEqual({ a: undefined });
  expect(times(changes.snapshot("win", snapshot(["w", "working", 12]), true))).toEqual({ w: undefined });
  time.at(2_000);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 13]), true))).toEqual({ w: 2_000 });
  time.at(3_000);
  expect(times(changes.snapshot("local", snapshot(["a", "working", 1298]), true))).toEqual({ a: 3_000 });
  // nothing changed: the times stay
  time.at(4_000);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 13]), true))).toEqual({ w: 2_000 });
});

it("dates a status frame once, and its counter in the next snapshot is the same change", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "working", 12]), true);
  time.at(2_000);
  // frames that repeat a status to carry a context are not changes
  expect(changes.status("win", "w", "working")).toBeUndefined();
  expect(changes.status("win", "w", "done")).toBe(2_000);
  time.at(2_500);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 13]), true))).toEqual({ w: 2_000 });
  time.at(3_000);
  // the next raised counter, with no frame before it, is a change of its own
  expect(times(changes.snapshot("win", snapshot(["w", "done", 14]), true))).toEqual({ w: 3_000 });
});

it("takes the first counter after a status frame of a new agent as its start, not as a change", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  expect(changes.status("win", "w", "working")).toBeUndefined();
  time.at(2_000);
  expect(times(changes.snapshot("win", snapshot(["w", "working", 12]), true))).toEqual({ w: undefined });
  time.at(3_000);
  expect(times(changes.snapshot("win", snapshot(["w", "working", 13]), true))).toEqual({ w: 3_000 });
});

it("keeps the counter baseline across a live snapshot that omits it", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "done", 12]), true);
  const missing = snapshot(["w", "done", 12]);
  delete missing.agents[0]!.state_change_seq;
  expect(times(changes.snapshot("win", missing, true))).toEqual({ w: undefined });
  time.at(4_000);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 13]), true))).toEqual({ w: 4_000 });
});

it("keeps a status frame's change over a restart before its counter is seen", () => {
  const dir = stateDir();
  const time = clock();
  const before = new AgentChanges(dir, time.now);
  before.snapshot("win", snapshot(["w", "working", 12]), true);
  time.at(2_000);
  expect(before.status("win", "w", "done")).toBe(2_000);
  before.flush();

  time.at(9_000);
  const after = new AgentChanges(dir, time.now);
  expect(times(after.snapshot("win", snapshot(["w", "done", 13]), true))).toEqual({ w: 2_000 });
  time.at(10_000);
  expect(times(after.snapshot("win", snapshot(["w", "done", 14]), true))).toEqual({ w: 10_000 });
});

it("starts an agent over on a lower counter, a new herdr run", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "working", 12]), true);
  time.at(2_000);
  changes.snapshot("win", snapshot(["w", "done", 13]), true);
  time.at(3_000);
  expect(times(changes.snapshot("win", snapshot(["w", "idle", 1]), true))).toEqual({ w: undefined });
});

it("forgets closed panes and a removed PC", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "working", 1], ["x", "working", 2]), true);
  changes.snapshot("local", snapshot(["a", "working", 1]), true);
  time.at(2_000);
  changes.snapshot("win", snapshot(["w", "done", 3], ["x", "done", 4]), true);
  changes.snapshot("local", snapshot(["a", "done", 2]), true);
  // x closes, and comes back under the same id: a new agent, with no time
  changes.snapshot("win", snapshot(["w", "done", 3]), true);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 3], ["x", "done", 4]), true))).toEqual({ w: 2_000, x: undefined });
  changes.forget("local");
  expect(times(changes.snapshot("local", snapshot(["a", "done", 2]), true))).toEqual({ a: undefined });
});

it("never passes on a time from a remote PC's clock", () => {
  const changes = new AgentChanges(null, () => 5_000);
  const theirs = snapshot(["w", "done", 3]);
  theirs.panes[0]!.changed_at = 99;
  expect(times(changes.snapshot("win", theirs, true))).toEqual({ w: undefined });
});

it("keeps the times over a restart, and dates a change made while it was away when it is seen", () => {
  const dir = stateDir();
  const time = clock();
  const before = new AgentChanges(dir, time.now);
  before.snapshot("win", snapshot(["w", "working", 12]), true);
  before.snapshot("local", snapshot(["a", "working", 5]), true);
  time.at(2_000);
  before.snapshot("win", snapshot(["w", "done", 13]), true);
  before.flush();
  expect(existsSync(join(dir, "agent-changes.json"))).toBe(true);

  time.at(9_000);
  const after = new AgentChanges(dir, time.now);
  expect(times(after.snapshot("win", snapshot(["w", "done", 13]), true))).toEqual({ w: 2_000 });
  // a's counter rose while the server was down: dated now, the first time it is seen
  expect(times(after.snapshot("local", snapshot(["a", "done", 6]), true))).toEqual({ a: 9_000 });
});

it("starts empty from a file that is not its table, and writes a good one", () => {
  const dir = stateDir();
  writeFileSync(join(dir, "agent-changes.json"), "not json");
  const time = clock();
  const changes = new AgentChanges(dir, time.now);
  changes.snapshot("win", snapshot(["w", "working", 1]), true);
  time.at(2_000);
  changes.snapshot("win", snapshot(["w", "done", 2]), true);
  changes.flush();
  expect(JSON.parse(readFileSync(join(dir, "agent-changes.json"), "utf8"))).toEqual({ "win\nw": { seq: 2, status: "done", at: 2_000 } });
});

it("does not mistake a damaged saved row for a prior observation", () => {
  const dir = stateDir();
  writeFileSync(join(dir, "agent-changes.json"), JSON.stringify({ "local\np": {} }));
  const changes = new AgentChanges(dir, () => 4_000);
  expect(times(changes.snapshot("local", snapshot(["p", "idle", 1]), true))).toEqual({ p: undefined });
  changes.flush();
});

it("writes only the newest 2,000 entries even when more panes are tracked", () => {
  const dir = stateDir();
  const time = clock();
  const changes = new AgentChanges(dir, time.now);
  for (let index = 0; index <= 2_000; index++) {
    const pane = `p${index}`;
    changes.status("local", pane, "working");
    time.at(1_000 + index);
    changes.status("local", pane, "done");
  }
  changes.flush();
  const disk = JSON.parse(readFileSync(join(dir, "agent-changes.json"), "utf8"));
  expect(Object.keys(disk)).toHaveLength(2_000);
  expect(disk["local\np0"]).toBeUndefined();
  expect(disk["local\np2000"]?.at).toBe(3_000);
});

it("dates a frame's change once, when snapshots without its counter come between", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "working", 12]), true);
  time.at(2_000);
  expect(changes.status("win", "w", "done")).toBe(2_000);
  // the roster read every few seconds, before herdr's counter shows the change
  time.at(2_500);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 12]), true))).toEqual({ w: 2_000 });
  time.at(3_000);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 13]), true))).toEqual({ w: 2_000 });
});

it("only shows the times kept for a roster that is not live, and leaves other PCs alone", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "working", 1]), true);
  changes.snapshot("local", snapshot(["a", "working", 1]), true);
  time.at(2_000);
  changes.snapshot("win", snapshot(["w", "done", 2]), true);
  time.at(3_000);
  // a cached roster older than the times kept: no change is dated, and nothing is forgotten
  expect(times(changes.snapshot("win", snapshot(["w", "working", 1], ["x", "idle", 1]), false))).toEqual({ w: 2_000, x: undefined });
  expect(times(changes.snapshot("win", snapshot(["x", "idle", 1]), false))).toEqual({ x: undefined });
  // a live roster of one PC prunes only that PC's agents
  changes.snapshot("local", snapshot(["b", "idle", 1]), true);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 2]), true))).toEqual({ w: 2_000 });
});

it("keeps a PC's times while it is not yet listed after a restart, and writes nothing after stop", () => {
  const dir = stateDir();
  const time = clock();
  const before = new AgentChanges(dir, time.now);
  before.snapshot("hc", snapshot(["h", "working", 1]), true);
  time.at(2_000);
  before.snapshot("hc", snapshot(["h", "done", 2]), true);
  before.flush();
  const after = new AgentChanges(dir, time.now);
  // another PC is read first, as the local roster is before herdr-core's catalog answers
  after.snapshot("local", snapshot(["a", "idle", 1]), true);
  after.flush();
  expect(times(new AgentChanges(dir, time.now).snapshot("hc", snapshot(["h", "done", 2]), true))).toEqual({ h: 2_000 });
  // stopped: a late read changes nothing on disk
  const written = readFileSync(join(dir, "agent-changes.json"), "utf8");
  after.snapshot("local", snapshot(["a", "working", 2]), true);
  after.flush();
  expect(readFileSync(join(dir, "agent-changes.json"), "utf8")).toBe(written);
});

it("hands back the same roster when no time changes", () => {
  const changes = new AgentChanges(null, () => 1_000);
  const shown = changes.snapshot("win", snapshot(["w", "idle", 1]), true);
  expect(changes.snapshot("win", shown, true)).toBe(shown);
});
