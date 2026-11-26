import { expect, it, mock } from "bun:test";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { CopilotActivity } from "./copilot-activity.ts";

const pane: HerdrPane = { pane_id: "p", workspace_id: "w", tab_id: "t", terminal_id: "term", focused: false, revision: 1, agent: "copilot", agent_status: "idle" };
const roster = { all: () => [pane], pane: () => pane, lifetime: () => 1, herdrLifetime: () => "herdr-a" };
const snapshot: SessionSnapshot = { panes: [pane], agents: [], workspaces: [], tabs: [], layouts: [], protocol: 1, version: "fixture", herdr_lifetime: "herdr-a" };

it.skipIf(process.platform !== "linux")("corrects a missed working footer and a quoted one without replacing a prompt or finish", async () => {
  const reads = [true, false, undefined];
  const observer = new CopilotActivity(async () => reads.shift());
  const changed = mock();
  await observer.tick(roster, changed);
  expect(observer.apply(snapshot).panes[0]).toMatchObject({ agent_status: "idle", copilot_processing: true });
  await observer.tick(roster, changed);
  expect(observer.apply(snapshot).panes[0]?.copilot_processing).toBe(false);
  await observer.tick(roster, changed);
  expect(observer.apply(snapshot)).toBe(snapshot);
  expect(changed).toHaveBeenCalledTimes(3);
});

it.skipIf(process.platform !== "linux")("does not apply an outstanding read to a replacement pane", async () => {
  let release!: (busy: boolean) => void;
  const observer = new CopilotActivity(() => new Promise((resolve) => { release = resolve; }));
  const changed = mock();
  const tick = observer.tick(roster, changed);
  observer.forget("p");
  release(true);
  await tick;
  expect(observer.apply(snapshot)).toBe(snapshot);
  expect(changed).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "linux")("does not show a cached sample on a reused pane ID after Herdr restarts", async () => {
  const observer = new CopilotActivity(async () => false);
  await observer.tick(roster, () => {});
  expect(observer.apply(snapshot).panes[0]?.copilot_processing).toBe(false);
  const replacement: SessionSnapshot = { ...snapshot, herdr_lifetime: "herdr-b", panes: [{ ...pane, agent_status: "working" }] };
  expect(observer.apply(replacement).panes[0]?.copilot_processing).toBeUndefined();
});

it.skipIf(process.platform !== "linux")("drops a busy sample when observation pauses and resumes with a fresh idle sample", async () => {
  const reads = [true, false];
  const observer = new CopilotActivity(async () => reads.shift());
  const changed = mock();
  await observer.tick(roster, changed);
  await observer.tick(roster, changed, false);
  expect(observer.apply(snapshot)).toBe(snapshot);
  await observer.tick(roster, changed);
  expect(observer.apply(snapshot).panes[0]?.copilot_processing).toBe(false);
});
