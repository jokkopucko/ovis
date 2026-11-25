import { describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import type { HerdrPane, PaneContext, PlanSummary } from "../shared/protocol.ts";
import { transcriptPage } from "./conversation.ts";
import { paneAfterStatus } from "./machines.ts";
import type { ServedStatus } from "./approvals/codex-status.ts";
import { readPlan, SessionPlans } from "./session-plan.ts";
import { at, claude, file } from "./session-plan.fixture.ts";

const steps = (path: string) => (readPlan("claude-transcript", path) ?? []).map((step) => `${step.id}:${step.status}:${step.blocked_by.join(",")}`);

describe("SessionPlans", () => {
  const pane = (pane_id: string, agent: string, session = "s1"): HerdrPane => ({ pane_id, agent, cwd: "/w", agent_session: { kind: "id", value: session } } as unknown as HerdrPane);

  it("initializes an OmO plan from the todo tool answer", async () => {
    const f = file("omo.jsonl");
    f.add({ type: "message", timestamp: at(1), message: { role: "toolResult", toolName: "todo", toolCallId: "t1", content: [{ type: "text", text: "Overall: 0/2 done\n  Build:\n    - [ ] Read (in progress)\n    - [ ] Fix" }] } });
    const deps = { claudePath: () => null, codexPath: async () => null, omoPath: () => f.path, onChange: () => {} };
    const plans = new SessionPlans(deps);
    await plans.refresh([pane("omo1", "omo")]);
    plans.poll();
    expect(plans.summaryOf("omo1")).toEqual({ done: 0, total: 2, current: "Read" });
    expect(plans.planOf(pane("omo1", "omo"))?.map((step) => step.label)).toEqual(["Read", "Fix"]);
  });

  const omo = async () => {
    const f = file("omo.jsonl");
    let sequence = 0;
    const answer = (text: string, toolName = "todo") => f.add({ type: "message", timestamp: at(++sequence), message: { role: "toolResult", toolName, toolCallId: `t${sequence}`, content: [{ type: "text", text }] } });
    answer("Overall: 0/2 done\n  Build:\n    - [ ] Read (in progress)\n    - [ ] Fix");
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => null, omoPath: () => f.path, onChange: () => {} });
    await plans.refresh([pane("omo1", "omo")]);
    plans.poll();
    return { plans, answer, f };
  };

  it("updates OmO progress when another todo answer is appended", async () => {
    const { plans, answer } = await omo();
    answer("Overall: 1/2 done\n  Build:\n    - [X] Read\n    - [ ] Fix (in progress)");
    plans.poll();
    expect(plans.summaryOf("omo1")).toEqual({ done: 1, total: 2, current: "Fix" });
    expect(plans.planOf(pane("omo1", "omo"))).toMatchObject([
      { label: "Read", status: "completed", started_at: at(1), ended_at: at(2) },
      { label: "Fix", status: "in_progress", started_at: at(2), ended_at: null },
    ]);
  });

  it("retains the completed OmO plan when every task is done", async () => {
    const { plans, answer } = await omo();
    answer("Overall: 2/2 done\n  Build:\n    - [X] Read\n    - [X] Fix");
    plans.poll();
    expect(plans.summaryOf("omo1")).toEqual({ done: 2, total: 2, current: null });
  });

  it.each(["Todo list is empty.", "Todo list cleared."])("clears OmO progress when the answer says %s", async (empty) => {
    const { plans, answer } = await omo();
    answer(empty);
    plans.poll();
    expect(plans.summaryOf("omo1")).toBeNull();
    expect(plans.planOf(pane("omo1", "omo"))).toBeNull();
  });

  it.each([
    "Overall: 1/2 done\n  Build:\n    - [X] Read",
    "  Build:\n    - [X] Read\n… trimmed",
  ])("ignores a truncated OmO answer: %s", async (truncated) => {
    const { plans, answer } = await omo();
    answer(truncated);
    plans.poll();
    expect(plans.summaryOf("omo1")).toEqual({ done: 0, total: 2, current: "Read" });
  });

  it("excludes dropped OmO work while keeping blocked work pending", async () => {
    const { plans, answer } = await omo();
    answer("Overall: 0/2 done\n  Build:\n    - [ ] Read (dropped)\n    - [ ] Fix (blocked: waiting)");
    plans.poll();
    expect(plans.summaryOf("omo1")).toEqual({ done: 0, total: 1, current: null });
    expect(plans.planOf(pane("omo1", "omo"))?.map((step) => step.status)).toEqual(["pending"]);
  });

  it("ignores quoted OmO todos outside a todo tool result", async () => {
    const { plans, answer, f } = await omo();
    const text = "  Fake:\n    - [X] Wrong";
    f.add({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "never-answered", name: "todo", arguments: { op: "done" } }, { type: "text", text }] } });
    answer(text, "read");
    plans.poll();
    expect(plans.summaryOf("omo1")).toEqual({ done: 0, total: 2, current: "Read" });
  });

  it.each(["replaced", "unresolved"])("follows an OmO binding when it becomes %s", async (binding) => {
    const old = file("old.jsonl"), next = file("next.jsonl");
    const result = (label: string) => ({ type: "message", message: { role: "toolResult", toolName: "todo", content: [{ type: "text", text: `  Work:\n    - [ ] ${label}` }] } });
    old.add(result("Old work"));
    next.add(result("New work"));
    let path: string | null = old.path;
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => null, omoPath: () => path, onChange: () => {} });
    await plans.refresh([pane("omo1", "omo")]);
    plans.poll();
    path = binding === "replaced" ? next.path : null;
    await plans.refresh([pane("omo1", "omo")]);
    plans.poll();
    expect(plans.planOf(pane("omo1", "omo"))?.map((step) => step.label) ?? null).toEqual(binding === "replaced" ? ["New work"] : null);
  });

  it("keeps a remote PC's plan as its frames say", () => {
    const frame = (plan?: PlanSummary | null) => ({ type: "pane-status" as const, pane_id: "p1", agent_status: "working" as const, ...(plan === undefined ? {} : { plan }) });
    const planned = paneAfterStatus({ ...pane("p1", "claude"), background_tasks: 1 }, frame({ done: 1, total: 2, current: "Two" }));
    expect(planned).toMatchObject({ background_tasks: 1, plan: { done: 1, total: 2, current: "Two" } });
    expect(paneAfterStatus(planned, frame())).toMatchObject({ plan: { done: 1, total: 2 } });
    expect("plan" in paneAfterStatus(planned, frame(null))).toBe(false);
  });

  it("keeps a remote PC's context as its frames say", () => {
    const frame = (context?: PaneContext | null) => ({ type: "pane-status" as const, pane_id: "p1", agent_status: "idle" as const, ...(context === undefined ? {} : { context }) });
    const filled = paneAfterStatus(pane("p1", "claude"), frame({ used: 50_000, window: 200_000 }));
    expect(filled).toMatchObject({ context: { used: 50_000, window: 200_000 } });
    expect(paneAfterStatus(filled, frame())).toMatchObject({ context: { used: 50_000 } });
    expect("context" in paneAfterStatus(filled, frame(null))).toBe(false);
  });

  it("tells a Claude pane's context as its requests fill it, the main session's only, and clears it with the pane", async () => {
    const s = claude();
    const changes: [string, PaneContext | null][] = [];
    const plans = new SessionPlans({ claudePath: (id) => id === "p1" ? s.path : null, codexPath: async () => null, onChange: () => {}, onContext: (id, context) => changes.push([id, context]) });
    const request = (input: number, extra: Record<string, unknown> = {}) => s.add({ type: "assistant", timestamp: at(1), ...extra, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: input, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 } } });
    request(240_000);
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(changes).toEqual([["p1", { used: 242_000, window: 1_000_000 }]]);
    expect(plans.contextOf("p1")).toEqual({ used: 242_000, window: 1_000_000 });
    request(5_000, { isSidechain: true });
    plans.poll();
    expect(changes).toHaveLength(1);
    request(98_000);
    plans.poll();
    expect(changes.at(-1)).toEqual(["p1", { used: 100_000, window: 1_000_000 }]);
    await plans.refresh([pane("p1", "shell")]);
    expect(changes.at(-1)).toEqual(["p1", null]);
    expect(plans.contextOf("p1")).toBeNull();
  });

  it("takes a Claude pane's window from its status line capture, also when the capture comes after the request", async () => {
    const s = claude();
    s.add({ type: "assistant", timestamp: at(1), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 30_000 } } });
    let captured: number | null = null;
    const asked: [string, string | null][] = [];
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {}, claudeWindow: (path, model) => { asked.push([path, model]); return captured; } });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 30_000, window: null });
    captured = 200_000;
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 30_000, window: 200_000 });
    expect(asked.at(-1)).toEqual([s.path, "claude-opus-5-5"]);
    s.add({ type: "user", message: { role: "user", content: "<local-command-stdout>Set model to `Sonnet 5.5` for this session only</local-command-stdout>" } });
    plans.poll();
    expect(asked.at(-1)).toEqual([s.path, "claude-sonnet-5-5"]);
  });

  it("clears a pane's context as soon as it runs another session, before its transcript is read", async () => {
    const s = claude();
    s.add({ type: "assistant", timestamp: at(1), message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 30_000 } } });
    const changes: [string, PaneContext | null][] = [];
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {}, onContext: (id, context) => changes.push([id, context]), claudeWindow: () => 200_000 });
    await plans.refresh([pane("p1", "claude", "A")]);
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 30_000, window: 200_000 });
    await plans.refresh([pane("p1", "claude", "B")]);
    expect(plans.contextOf("p1")).toBeNull();
    expect(changes.at(-1)).toEqual(["p1", null]);
  });

  it("follows a Claude rewind on the recorded fork as the chat does: the abandoned answers' figure goes", async () => {
    // Given Claude Code 2.1.304's recorded restore: apple and banana answered, then "cherry" sent from before apple.
    const lines = readFileSync(new URL("./fixtures/claude-rewind-2.1.304-fork.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean);
    const fork = lines.findIndex((line) => line.includes('"content":"cherry"'));
    const f = file();
    writeFileSync(f.path, `${lines.slice(0, fork).join("\n")}\n`);
    const changes: [string, PaneContext | null][] = [];
    const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {}, onContext: (id, context) => changes.push([id, context]), claudeWindow: () => 200_000 });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 3, window: 200_000 });
    appendFileSync(f.path, `${lines.slice(fork).join("\n")}\n`);
    plans.poll();
    expect(changes.at(-1)).toEqual(["p1", null]);
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toBeUndefined();
  });

  it("tells the figure a Claude rewind went back to until the next answer, then that answer's", async () => {
    const f = file();
    const user = (uuid: string, parentUuid: string | null, content: string) => f.add({ type: "user", uuid, parentUuid, isSidechain: false, message: { role: "user", content } });
    const answer = (uuid: string, parentUuid: string, input: number) => f.add({ type: "assistant", uuid, parentUuid, isSidechain: false, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }], usage: { input_tokens: input } } });
    user("u1", null, "one");
    answer("a1", "u1", 10_000);
    user("u2", "a1", "two");
    answer("a2", "u2", 50_000);
    f.add({ type: "system", subtype: "turn_duration", uuid: "s2", parentUuid: "a2", isSidechain: false });
    const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {}, claudeWindow: () => 200_000 });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 50_000, window: 200_000 });
    user("u3", "s2", "three");
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 50_000, window: 200_000 });
    user("u4", "a1", "two again");
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toEqual({ used: 10_000, window: null });
    expect(plans.contextOf("p1")).toEqual({ used: 10_000, window: 200_000 });
    answer("a4", "u4", 12_000);
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 12_000, window: 200_000 });
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toEqual({ used: 12_000, window: null });
  });

  it("takes a Claude command's echo from before the last answer as a fork only once the conversation goes on from it, as the chat does", async () => {
    // Given an answered prompt, then a /context echo hanging from the prompt (as 2.1.304 links it after a Restore) and its output.
    const f = file();
    const echo = (uuid: string, parentUuid: string, content: string) => f.add({ type: "system", subtype: "local_command", uuid, parentUuid, isSidechain: false, content });
    f.add({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "one" } });
    f.add({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 30_000 } } });
    echo("c1", "u1", "<command-name>/context</command-name>\n<command-message>context</command-message>\n<command-args></command-args>");
    echo("o1", "c1", "<local-command-stdout>ok</local-command-stdout>");
    const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {}, claudeWindow: () => 200_000 });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toBeUndefined();
    expect(plans.contextOf("p1")).toBeNull();
    f.add({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "two" } });
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toEqual({ used: 30_000, window: null });
    expect(plans.contextOf("p1")).toEqual({ used: 30_000, window: 200_000 });
    echo("c2", "u1", "<command-name>/context</command-name>");
    echo("o2", "c2", "<local-command-stdout>ok</local-command-stdout>");
    f.add({ type: "system", subtype: "turn_duration", uuid: "s2", parentUuid: "a1", isSidechain: false });
    f.add({ type: "user", uuid: "u3", parentUuid: "o2", message: { role: "user", content: "three" } });
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toBeUndefined();
    expect(plans.contextOf("p1")).toBeNull();
  });

  it("takes a held Claude command's echo as a fork past the most records it keeps, while the chat still does", async () => {
    const f = file();
    f.add({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "one" } });
    f.add({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 30_000 } } });
    f.add({ type: "system", subtype: "local_command", uuid: "s0", parentUuid: "u1", content: "<command-name>/context</command-name>" });
    appendFileSync(f.path, Array.from({ length: 10_001 }, (_, i) => `${JSON.stringify({ type: "system", subtype: "turn_duration", uuid: `s${i + 1}`, parentUuid: `s${i}` })}\n`).join(""));
    const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {}, claudeWindow: () => 200_000 });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toBeUndefined();
    expect(plans.contextOf("p1")).toBeNull();
  });

  it("keeps the 1M window of an answer when a Claude command's echo is dropped", async () => {
    const f = file();
    f.add({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "one" } });
    f.add({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 250_000 } } });
    f.add({ type: "system", subtype: "local_command", uuid: "c1", parentUuid: "u1", content: "<command-name>/context</command-name>" });
    f.add({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "two" } });
    f.add({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 12_000 } } });
    const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toEqual({ used: 12_000, window: 1_000_000 });
    expect(plans.contextOf("p1")).toEqual({ used: 12_000, window: 1_000_000 });
  });

  it("keeps the 1M window of an answer before the range a Claude fork left", async () => {
    const f = file();
    const answer = (uuid: string, parentUuid: string, input: number) => f.add({ type: "assistant", uuid, parentUuid, message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: input } } });
    f.add({ type: "user", uuid: "u0", parentUuid: null, message: { role: "user", content: "u0" } });
    answer("a0", "u0", 250_000);
    f.add({ type: "user", uuid: "u1", parentUuid: "a0", message: { role: "user", content: "u1" } });
    answer("a1", "u1", 30_000);
    f.add({ type: "system", subtype: "local_command", uuid: "c", parentUuid: "u1", content: "<command-name>/context</command-name>" });
    const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toEqual({ used: 250_000, window: 1_000_000 });
    expect(plans.contextOf("p1")).toEqual({ used: 250_000, window: 1_000_000 });
    answer("a2", "c", 12_000);
    f.add({ type: "user", uuid: "u2", parentUuid: "a2", message: { role: "user", content: "u2" } });
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toEqual({ used: 12_000, window: 1_000_000 });
    expect(plans.contextOf("p1")).toEqual({ used: 12_000, window: 1_000_000 });
    f.add({ type: "user", uuid: "u3", parentUuid: "a0", message: { role: "user", content: "u3" } });
    answer("a3", "u3", 15_000);
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toEqual({ used: 15_000, window: 1_000_000 });
    expect(plans.contextOf("p1")).toEqual({ used: 15_000, window: 1_000_000 });
  });

  it("goes back to the chat's Claude figure on forks that leave each other's answers, or hang from a dropped echo", async () => {
    const row = async (lines: object[]) => {
      const f = file();
      for (const line of lines) f.add(line);
      const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {} });
      await plans.refresh([pane("p1", "claude")]);
      plans.poll();
      return { row: plans.contextOf("p1"), chat: transcriptPage("claude-transcript", f.path).metadata.context ?? null };
    };
    const user = (uuid: string, parentUuid: string | null) => ({ type: "user", uuid, parentUuid, message: { role: "user", content: uuid } });
    const answer = (uuid: string, parentUuid: string, input: number) => ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: input } } });
    const nested = [user("u0", null), answer("a0", "u0", 250_000), user("u1", "a0"), answer("a1", "u1", 30_000), user("u2", "u0"), answer("a2", "u2", 10_000), user("u3", "a1")];
    expect(await row(nested)).toEqual({ row: null, chat: null });
    expect(await row([...nested, answer("a3", "u3", 12_000)])).toEqual({ row: { used: 12_000, window: null }, chat: { used: 12_000, window: null } });
    const dropped = [user("u0", null), answer("a0", "u0", 10_000), user("u1", "a0"), answer("a1", "u1", 250_000),
      { type: "system", subtype: "local_command", uuid: "e", parentUuid: "u1", content: "<command-name>/context</command-name>" },
      { type: "system", subtype: "turn_duration", uuid: "o", parentUuid: "e" }, user("u2", "a1"), answer("a2", "u2", 12_000), user("u3", "o")];
    expect(await row(dropped)).toEqual({ row: { used: 250_000, window: 1_000_000 }, chat: { used: 250_000, window: 1_000_000 } });
    expect(await row([...dropped, answer("a3", "u3", 15_000)])).toEqual({ row: { used: 15_000, window: 1_000_000 }, chat: { used: 15_000, window: 1_000_000 } });
  });

  it("does not carry the 1M window of an answer a Claude rewind left", async () => {
    const f = file();
    f.add({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "one" } });
    f.add({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 250_000 } } });
    f.add({ type: "user", uuid: "u2", parentUuid: null, message: { role: "user", content: "again" } });
    f.add({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 10_000 } } });
    const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toEqual({ used: 10_000, window: null });
    expect(plans.contextOf("p1")).toEqual({ used: 10_000, window: null });
  });

  it("tells no Claude figure after a line too long to read, until the next request", async () => {
    const f = file();
    f.add({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "one" } });
    f.add({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 30_000 } } });
    const plans = new SessionPlans({ claudePath: () => f.path, codexPath: async () => null, onChange: () => {}, claudeWindow: () => 200_000 });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 30_000, window: 200_000 });
    f.add({ type: "user", uuid: "u2", parentUuid: null, message: { role: "user", content: [{ type: "text", text: "again" }, { type: "image", source: { type: "base64", media_type: "image/png", data: `iVBORw0KGgo${"A".repeat(9 * 1024 * 1024)}` } }] } });
    plans.poll();
    expect(transcriptPage("claude-transcript", f.path).metadata.context).toBeUndefined();
    expect(plans.contextOf("p1")).toBeNull();
    f.add({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", model: "claude-opus-5-5", content: [], usage: { input_tokens: 12_000 } } });
    plans.poll();
    expect(plans.contextOf("p1")).toEqual({ used: 12_000, window: 200_000 });
  });

  it("reads a Codex pane's context with the window Codex states", async () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "event_msg", payload: { type: "token_count", info: { model_context_window: 258_400, last_token_usage: { total_tokens: 64_600 } } } });
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, onChange: () => {} });
    await plans.refresh([pane("p2", "codex")]);
    plans.poll();
    expect(plans.contextOf("p2")).toEqual({ used: 64_600, window: 258_400 });
  });

  it("tells a Codex pane's context its server says at once, for the thread its rollout is, and the rollout's again without it", async () => {
    const thread = "01a210a7-62bd-79a2-9c7b-0c09d625d336";
    const f = file(`rollout-2026-11-25T12-00-00-${thread}_01a210a7-a189-7bb0-9115-c46322038d80.jsonl`);
    f.add({ timestamp: at(1), type: "event_msg", payload: { type: "token_count", info: { model_context_window: 475_000, last_token_usage: { total_tokens: 12_000 } } } });
    let served: ServedStatus | null = null;
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, codexServed: () => served, onChange: () => {} });
    await plans.refresh([pane("p2", "codex")]);
    plans.poll();
    expect(plans.contextOf("p2")).toEqual({ used: 12_000, window: 475_000 });
    served = { threadId: thread, context: { used: 12_955, window: 475_000 }, model: null };
    plans.servedChanged("p2");
    expect(plans.contextOf("p2")).toEqual({ used: 12_955, window: 475_000 });
    served = { threadId: "01a210a7-aa30-7f42-9a96-97d456dfe544", context: { used: 99, window: 475_000 }, model: null };
    plans.servedChanged("p2");
    expect(plans.contextOf("p2")).toEqual({ used: 12_000, window: 475_000 });
    served = { threadId: thread, context: { used: 12_955, window: 475_000 }, model: null };
    plans.servedChanged("p2");
    served = null;
    plans.servedChanged("p2");
    expect(plans.contextOf("p2")).toEqual({ used: 12_000, window: 475_000 });
  });

  it("tells a pane's summary as its plan moves, reads nothing while its transcript is as it was, and clears it when the pane runs something else", async () => {
    const s = claude();
    const changes: [string, PlanSummary | null][] = [];
    let codexLookups = 0;
    const plans = new SessionPlans({ claudePath: (id) => id === "p1" ? s.path : null, codexPath: async () => { codexLookups++; return null; }, onChange: (id, summary) => changes.push([id, summary]) });
    const a = s.create("One", 1, { activeForm: "Doing one" });
    s.create("Two");
    await plans.refresh([pane("p1", "claude"), pane("p2", "codex"), pane("p3", "shell")]);
    expect(changes).toEqual([]);
    plans.poll();
    expect(changes).toEqual([["p1", { done: 0, total: 2, current: null }]]);
    expect(codexLookups).toBe(1);
    s.update({ taskId: a, status: "in_progress" }, 2);
    plans.poll();
    plans.poll();
    expect(changes.at(-1)).toEqual(["p1", { done: 0, total: 2, current: "Doing one" }]);
    expect(changes).toHaveLength(2);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.status)).toEqual(["in_progress", "pending"]);
    await plans.refresh([pane("p1", "claude"), pane("p2", "codex")]);
    expect(codexLookups).toBe(1);
    await plans.refresh([pane("p1", "shell"), pane("p2", "codex")]);
    expect(changes.at(-1)).toEqual(["p1", null]);
    expect(plans.summaryOf("p1")).toBeNull();
  });

  it("looks a Codex pane's rollout up again when its session changes", async () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c1", arguments: JSON.stringify({ plan: [{ step: "Go", status: "completed" }] }) } });
    const looked: string[] = [];
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async (p) => { looked.push(p.agent_session?.value ?? ""); return f.path; }, onChange: (_id, summary) => changes.push(summary) });
    await plans.refresh([pane("p2", "codex", "t1")]);
    plans.poll();
    await plans.refresh([pane("p2", "codex", "t1")]);
    await plans.refresh([pane("p2", "codex", "t2")]);
    plans.poll();
    expect(looked).toEqual(["t1", "t2"]);
    expect(changes).toEqual([{ done: 1, total: 1, current: null }]);
  });

  it("drops a Codex lookup that ends after its pane left", async () => {
    const f = file("rollout.jsonl");
    f.add({ timestamp: at(1), type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "c1", arguments: JSON.stringify({ plan: [{ step: "Go", status: "pending" }] }) } });
    let answer: (path: string) => void = () => {};
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => null, codexPath: () => new Promise((resolve) => { answer = resolve; }), onChange: (_id, summary) => changes.push(summary) });
    const looking = plans.refresh([pane("p2", "codex")]);
    await plans.refresh([pane("p2", "shell")]);
    answer(f.path);
    await looking;
    plans.poll();
    expect(plans.known(pane("p2", "codex"))).toBe(false);
    expect(changes).toEqual([]);
  });

  it("keeps a lookup a request asked for, for a pane the last snapshot had not seen yet", async () => {
    const f = file("rollout.jsonl");
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, onChange: () => {} });
    await plans.refresh([]);
    await plans.ensure(pane("p3", "codex"), true);
    expect(plans.known(pane("p3", "codex"))).toBe(true);
  });

  it("tells a request the plan as the poll last read it, and reads nothing for it", async () => {
    const s = claude();
    s.create("One");
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    expect(plans.planOf(pane("p1", "claude"))).toBeNull();
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    s.create("Two", 2);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One", "Two"]);
  });

  it("tells a plan only for the pane as herdr has it now, in the session its transcript was found for", async () => {
    const s = claude();
    s.create("One");
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: () => {} });
    await plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["One"]);
    expect(plans.planOf(undefined)).toBeNull();
    expect(plans.planOf(pane("p1", "claude", "s2"))).toBeNull();
  });

  it("knows a pane's transcript only for the session it was found for", async () => {
    const f = file("rollout.jsonl");
    const plans = new SessionPlans({ claudePath: () => null, codexPath: async () => f.path, onChange: () => {} });
    await plans.refresh([pane("p2", "codex", "t1")]);
    expect(plans.known(pane("p2", "codex", "t1"))).toBe(true);
    expect(plans.known(pane("p2", "codex", "t2"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("reads a transcript it could not open again at the next poll, though its size is the same", () => {
    const s = claude();
    s.create("One");
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => s.path, codexPath: async () => null, onChange: (_id, summary) => changes.push(summary) });
    void plans.refresh([pane("p1", "claude")]);
    chmodSync(s.path, 0o000);
    try { plans.poll(); } finally { chmodSync(s.path, 0o644); }
    expect(changes).toEqual([]);
    plans.poll();
    expect(changes).toEqual([{ done: 0, total: 1, current: null }]);
  });

  it("reads at most its budget in one poll, and the rest at the next; a request in between reads none of it", () => {
    const big = claude();
    big.create("Far");
    big.add({ type: "user", timestamp: at(2), message: { role: "user", content: "x".repeat(33 * 1024 * 1024) } });
    big.create("Near", 3);
    const changes: (PlanSummary | null)[] = [];
    const plans = new SessionPlans({ claudePath: () => big.path, codexPath: async () => null, onChange: (_id, summary) => changes.push(summary) });
    void plans.refresh([pane("p1", "claude")]);
    plans.poll();
    expect(changes).toEqual([]);
    expect(plans.planOf(pane("p1", "claude"))).toBeNull();
    plans.poll();
    expect(changes).toEqual([{ done: 0, total: 2, current: null }]);
    expect(plans.planOf(pane("p1", "claude"))?.map((step) => step.label)).toEqual(["Far", "Near"]);
  });
});

describe("readPlan edges", () => {
  it("is caught up on a transcript that ends inside a line, and takes the line once it is whole", () => {
    const s = claude();
    s.create("One");
    appendFileSync(s.path, '{"type":"assistant","timestamp":"2026-10-07T00:09:00.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_z","name":"TaskCreate","input":{"subject":"Two"}}]}}');
    expect(steps(s.path)).toEqual(["1:pending:"]);
    appendFileSync(s.path, `\n${JSON.stringify({ type: "user", timestamp: at(9), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_z", content: "Task #2 created successfully: Two" }] }, toolUseResult: { task: { id: "2", subject: "Two" } } })}\n`);
    expect(steps(s.path)).toEqual(["1:pending:", "2:pending:"]);
  });

  it("ignores code-mode output and patches that mention update_plan", () => {
    const f = file("rollout.jsonl");
    const call = (name: string, input: string) => ({ timestamp: at(1), type: "response_item", payload: { type: "custom_tool_call", status: "completed", call_id: "c", name, input } });
    f.add(call("apply_patch", "+ tools.update_plan({plan:[{step:'fixture',status:'completed'}]})"));
    f.add(call("exec", "await tools.update_plan({plan:[{step:'real',status:'pending'}]});"));
    f.add({ timestamp: at(2), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "tools.update_plan({plan:[{step:'output',status:'pending'}]})" }] } });
    expect(readPlan("codex-transcript", f.path)).toBeNull();
  });
});
