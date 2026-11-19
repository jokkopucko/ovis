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
  expect(times(changes.snapshot("local", snapshot(["a", "done", 1297])))).toEqual({ a: undefined });
  expect(times(changes.snapshot("win", snapshot(["w", "working", 12])))).toEqual({ w: undefined });
  time.at(2_000);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 13])))).toEqual({ w: 2_000 });
  time.at(3_000);
  expect(times(changes.snapshot("local", snapshot(["a", "working", 1298])))).toEqual({ a: 3_000 });
  // nothing changed: the times stay
  time.at(4_000);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 13])))).toEqual({ w: 2_000 });
});

it("dates a status frame once, and its counter in the next snapshot is the same change", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "working", 12]));
  time.at(2_000);
  // frames that repeat a status to carry a context are not changes
  expect(changes.status("win", "w", "working")).toBeUndefined();
  expect(changes.status("win", "w", "done")).toBe(2_000);
  time.at(2_500);
  expect(times(changes.snapshot("win", snapshot(["w", "done", 13])))).toEqual({ w: 2_000 });
  time.at(3_000);
  // the next raised counter, with no frame before it, is a change of its own
  expect(times(changes.snapshot("win", snapshot(["w", "done", 14])))).toEqual({ w: 3_000 });
});

it("starts an agent over on a lower counter, a new herdr run", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "working", 12]));
  time.at(2_000);
  changes.snapshot("win", snapshot(["w", "done", 13]));
  time.at(3_000);
  expect(times(changes.snapshot("win", snapshot(["w", "idle", 1])))).toEqual({ w: undefined });
});

it("forgets closed panes and removed PCs", () => {
  const time = clock();
  const changes = new AgentChanges(null, time.now);
  changes.snapshot("win", snapshot(["w", "working", 1], ["x", "working", 2]));
  changes.snapshot("local", snapshot(["a", "working", 1]));
  time.at(2_000);
  changes.snapshot("win", snapshot(["w", "done", 3], ["x", "done", 4]));
  changes.snapshot("local", snapshot(["a", "done", 2]));
  // x closes, and comes back under the same id: a new agent, with no time
  changes.snapshot("win", snapshot(["w", "done", 3]));
  expect(times(changes.snapshot("win", snapshot(["w", "done", 3], ["x", "done", 4])))).toEqual({ w: 2_000, x: undefined });
  changes.keepMachines(["win"]);
  expect(times(changes.snapshot("local", snapshot(["a", "done", 2])))).toEqual({ a: undefined });
});

it("never passes on a time from a remote PC's clock", () => {
  const changes = new AgentChanges(null, () => 5_000);
  const theirs = snapshot(["w", "done", 3]);
  theirs.panes[0]!.changed_at = 99;
  expect(times(changes.snapshot("win", theirs))).toEqual({ w: undefined });
});

it("keeps the times over a restart, and dates a change made while it was away when it is seen", () => {
  const dir = stateDir();
  const time = clock();
  const before = new AgentChanges(dir, time.now);
  before.snapshot("win", snapshot(["w", "working", 12]));
  before.snapshot("local", snapshot(["a", "working", 5]));
  time.at(2_000);
  before.snapshot("win", snapshot(["w", "done", 13]));
  before.flush();
  expect(existsSync(join(dir, "agent-changes.json"))).toBe(true);

  time.at(9_000);
  const after = new AgentChanges(dir, time.now);
  expect(times(after.snapshot("win", snapshot(["w", "done", 13])))).toEqual({ w: 2_000 });
  // a's counter rose while the server was down: dated now, the first time it is seen
  expect(times(after.snapshot("local", snapshot(["a", "done", 6])))).toEqual({ a: 9_000 });
});

it("starts empty from a file that is not its table, and writes a good one", () => {
  const dir = stateDir();
  writeFileSync(join(dir, "agent-changes.json"), "not json");
  const time = clock();
  const changes = new AgentChanges(dir, time.now);
  changes.snapshot("win", snapshot(["w", "working", 1]));
  time.at(2_000);
  changes.snapshot("win", snapshot(["w", "done", 2]));
  changes.flush();
  expect(JSON.parse(readFileSync(join(dir, "agent-changes.json"), "utf8"))).toEqual({ "win\nw": { seq: 2, status: "done", at: 2_000 } });
});
