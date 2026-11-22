import { expect, it } from "bun:test";
import type { MovePane, MovePlan } from "../shared/runtime-move.ts";
import { HerdrError } from "./herdr/client.ts";
import { herdrSource, sameShape } from "./runtime-move-service.ts";

const plan = (panes: MovePane[]): MovePlan => ({ ready: true, revision: "r", workspaces: [{ workspace_id: "w1", name: "ovis", tabs: [{ tab_id: "t1", name: "1", root: { pane: "a" } }] }], panes });
const shown = plan([
  { pane_id: "a", cwd: "/a", name: null, verdict: { kind: "busy", reason: "agent_working", agent: "codex", command: null } },
  { pane_id: "b", cwd: "/b", name: null, verdict: { kind: "shell" } },
]);

it("lets a waiting move go only when what was shown is what moves", () => {
  const done = plan([{ ...shown.panes[0]!, verdict: { kind: "resume", agent: "codex", session_id: "s", argv: ["codex", "resume", "s"], ended: false } }, shown.panes[1]!]);
  expect(sameShape(shown, done)).toBe(true);
  expect(sameShape(shown, plan([{ ...done.panes[0]!, verdict: { kind: "fresh", agent: "claude" } }, shown.panes[1]!]))).toBe(false);
  expect(sameShape(shown, plan([{ ...done.panes[0]!, cwd: "/elsewhere" }, shown.panes[1]!]))).toBe(false);
  expect(sameShape(shown, plan([...done.panes, { pane_id: "c", cwd: "/c", name: null, verdict: { kind: "shell" } }]))).toBe(false);
  const waited = plan([{ pane_id: "a", cwd: "/a", name: null, verdict: { kind: "needs_you", agent: "copilot" } }, shown.panes[1]!]);
  expect(sameShape(waited, plan([{ ...waited.panes[0]!, verdict: { kind: "shell" } }, shown.panes[1]!]))).toBe(true);
  expect(sameShape(waited, plan([{ ...waited.panes[0]!, verdict: { kind: "resume", agent: "copilot" as never, session_id: "s", argv: ["copilot"], ended: true } }, shown.panes[1]!]))).toBe(true);
});

const HELD = Promise.resolve();
const inline = <T,>(_pane: string, task: () => T | Promise<T>): Promise<T> => HELD.then(task);
const idle = async () => ({ agent: "claude", agent_status: "idle" as const, agent_session: { value: "s1" } as never });

it("sends an exit only in the pane's input lane, after what was typed before it, and not over a message queued meanwhile", async () => {
  let tail: Promise<unknown> = Promise.resolve();
  const lane = <T,>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => undefined).then(task); tail = run; return run; };
  const sent: string[] = [];
  let queued = false;
  const source = herdrSource(() => queued, async () => true, lane, async (pane, text) => { sent.push(`${pane} ${text}`); }, idle);
  let typed: (() => void) | null = null;
  void lane("p1", () => new Promise<void>((resolve) => { typed = resolve; }));
  const exit = source.sendExit("p1", "claude", "s1", "/exit");
  for (let turn = 0; turn < 10 && typed === null; turn++) await Promise.resolve();
  expect(sent).toEqual([]);
  typed!();
  expect(await exit).toBe("sent");
  expect(sent).toEqual(["p1 /exit"]);
  let release: (() => void) | null = null;
  void lane("p1", () => new Promise<void>((resolve) => { release = resolve; }));
  const second = source.sendExit("p1", "claude", "s1", "/exit");
  for (let turn = 0; turn < 10 && release === null; turn++) await Promise.resolve();
  queued = true;
  release!();
  expect(await second).toBe("agent_busy");
  expect(sent).toEqual(["p1 /exit"]);
});

it("reads the agent again in the lane and types no exit into one that took work, changed or cannot be read", async () => {
  const sent: string[] = [];
  const type = async (pane: string, text: string) => { sent.push(`${pane} ${text}`); };
  const exit = (now: () => Promise<{ agent: string | null; agent_status: "idle" | "working" | "done" | "blocked" | "unknown"; agent_session?: never }>, session: string | null = "s1", empty = true) =>
    herdrSource(() => false, async () => empty, inline, type, now).sendExit("p1", "claude", session, "/exit");
  expect(await exit(async () => ({ agent: "claude", agent_status: "working" }))).toBe("agent_busy");
  expect(await exit(async () => ({ agent: "claude", agent_status: "blocked" }))).toBe("agent_busy");
  expect(await exit(async () => ({ agent: "codex", agent_status: "idle" }))).toBe("agent_busy");
  expect(await exit(async () => ({ agent: null, agent_status: "unknown" }))).toBe("agent_busy");
  expect(await exit(async () => { throw new Error("herdr did not answer"); })).toBe("agent_busy");
  expect(await exit(async () => undefined as never)).toBe("agent_busy");
  expect(await exit(idle, "s1", false)).toBe("input_left");
  expect(sent).toEqual([]);
  expect(await exit(async () => ({ agent: "claude", agent_status: "done", agent_session: { value: "s1" } as never }))).toBe("sent");
  expect(sent).toEqual(["p1 /exit"]);
});

it("types no exit into another conversation than the one the plan showed", async () => {
  const sent: string[] = [];
  const type = async (pane: string, text: string) => { sent.push(`${pane} ${text}`); };
  const source = herdrSource(() => false, async () => true, inline, type, idle);
  expect(await source.sendExit("p1", "claude", "s2", "/exit")).toBe("plan_changed");
  expect(await herdrSource(() => false, async () => true, inline, type, async () => ({ agent: "claude", agent_status: "idle" as const })).sendExit("p1", "claude", "s1", "/exit")).toBe("plan_changed");
  expect(sent).toEqual([]);
  expect(await source.sendExit("p1", "claude", null, "/exit")).toBe("sent");
  expect(await source.sendExit("p1", "claude", "s1", "/exit")).toBe("sent");
  expect(sent).toEqual(["p1 /exit", "p1 /exit"]);
});

it("reads the agent last: one that takes work while its input box is read is not typed into", async () => {
  const order: string[] = [];
  let status: "idle" | "working" = "idle";
  let boxRead: ((empty: boolean) => void) | null = null;
  const source = herdrSource(
    () => false,
    () => { order.push("box asked"); return new Promise<boolean>((resolve) => { boxRead = resolve; }); },
    inline,
    async () => { order.push("typed"); },
    async () => { order.push("agent asked"); return { agent: "claude", agent_status: status, agent_session: { value: "s1" } as never }; },
  );
  const exit = source.sendExit("p1", "claude", "s1", "/exit");
  for (let turn = 0; turn < 10 && boxRead === null; turn++) await Promise.resolve();
  expect(order).toEqual(["box asked"]);
  status = "working";
  boxRead!(true);
  expect(await exit).toBe("agent_busy");
  expect(order).toEqual(["box asked", "agent asked"]);
});

it("asks the queue again at herdr's write, and counts what herdr refuses before typing as not typed", async () => {
  let queued = false;
  const guards: boolean[] = [];
  const source = herdrSource(() => queued, async () => true, inline, async (_pane, _text, _socket, guard) => { queued = true; guards.push(guard!()); if (!guards.at(-1)) throw new HerdrError("cancelled", "not sent"); }, idle);
  expect(await source.sendExit("p1", "claude", "s1", "/exit")).toBe("agent_busy");
  expect(guards).toEqual([false]);
  const refusing = (code: string, fromReply = true) => herdrSource(() => false, async () => true, inline, async () => { throw new HerdrError(code, `herdr said ${code}`, fromReply); }, idle).sendExit("p1", "claude", "s1", "/exit");
  expect(await refusing("agent_blocked")).toBe("agent_busy");
  expect(await refusing("agent_not_found")).toBe("plan_changed");
  expect(await refusing("agent_not_ready")).toBe("plan_changed");
  expect(await refusing("connect_failed", false)).toBe("failed: herdr said connect_failed");
  expect(await refusing("timeout", false).then(() => "answered", (error: Error) => error.message)).toBe("herdr said timeout");
  expect(await refusing("socket_error", false).then(() => "answered", (error: Error) => error.message)).toBe("herdr said socket_error");
  for (const [code, fromReply] of [["connect_failed", true], ["cancelled", true], ["agent_blocked", false], ["agent_not_found", false], ["toString", true]] as const) {
    expect(await refusing(code, fromReply).then((answer) => `answered ${String(answer)}`, (error: Error) => error.message)).toBe(`herdr said ${code}`);
  }
});
