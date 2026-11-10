import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lettaStore from "../letta-store.ts";
import * as served from "../runtime/capabilities.ts";
import { HERDR, HERDR_CORE } from "../runtime/capabilities.ts";
import { lettaMessagesPath } from "../letta-store.ts";
import { handlers, hub, root } from "./status.fake.ts";

// A herdr-core Letta pane: Letta sends no report, so herdr gives it no status (letta-code 0.34.44, hc 0.1.17)
const letta = (title: string, status = "unknown") => ({ pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent: "letta", agent_status: status, cwd: root, foreground_cwd: root, terminal_title: title, title });
// One turn of letta-code 0.34.44's local backend: the prompt, a Bash call, its result, the answer
const turn = readFileSync(join(import.meta.dir, "..", "fixtures", "letta", "messages-turn-0.34.44.jsonl"), "utf8").trim().split("\n");

const resolved: { mockRestore(): void }[] = [];
const resolving = () => { const spy = spyOn(lettaStore, "resolveLettaTranscript"); resolved.push(spy); return spy; };
/** the server serves herdr-core, where Letta panes report nothing; on herdr's TUI the tracker stays out */
const core = (serving = true) => { const spy = spyOn(served, "capabilities").mockReturnValue(serving ? HERDR_CORE : HERDR); resolved.push(spy); };
afterEach(() => { for (const spy of resolved.splice(0)) spy.mockRestore(); });

describe("a Letta pane's status in the hub, where no report gives one", () => {
  it("leaves Letta panes as herdr gives them on herdr's TUI", async () => {
    core(false);
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor"));
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]!.agent_status).toBe("unknown");
    expect(h.status.letta.runs("w1:p1")).toBe(false);
  });

  it("keeps an approval wait blocked when the messages file then shows an older finished answer", async () => {
    core();
    const store = join(root, "letta-store-stale");
    const agent = "agent-local-c";
    const messages = lettaMessagesPath(store, agent, "default")!;
    mkdirSync(join(messages, ".."), { recursive: true });
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    resolving().mockResolvedValue({ path: join(root, "t3.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 });
    h.herdrSays(letta("[ ! ] Action Required | Tutor"));
    await h.status.letta.refresh([letta("[ ! ] Action Required | Tutor")] as never);
    await h.snapshot();
    expect(h.last().status).toBe("blocked");
    // the file now reads to an answer that was written before the approval was asked
    appendFileSync(messages, `${turn.slice(2).join("\n")}\n`);
    await h.status.letta.poll();
    expect(h.last().status).toBe("blocked");
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(0);
  });

  it("works while Letta's title spins and finishes once when it stops, from the title alone", async () => {
    core();
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("working");
    h.herdrSays(letta("Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("done");
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(1);
  });

  it("keeps the work a Letta title shows through a status event that says nothing, and finishes it once", async () => {
    core();
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("working");
    // herdr-core tells a status event for a pane that reports nothing: unknown
    handlers.onStatus("w1:p1", "unknown", "letta");
    expect(h.last().status).toBe("working");
    h.herdrSays(letta("Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("done");
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(1);
  });

  it("lets no title from before a live report restart the finish it told", async () => {
    core();
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("working");
    // the program itself reports its turn done, then says nothing: the old spinner is no evidence of work any more
    handlers.onStatus("w1:p1", "done", "letta");
    handlers.onStatus("w1:p1", "unknown", "letta");
    expect(h.last().status).not.toBe("working");
  });

  it("tells no failure a later successful answer replaced while the approval waited", async () => {
    core();
    const store = join(root, "letta-store-superseded");
    const agent = "agent-local-f";
    const messages = lettaMessagesPath(store, agent, "default")!;
    mkdirSync(join(messages, ".."), { recursive: true });
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    const failed: string[] = [];
    spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failed.push(paneId); });
    resolving().mockResolvedValue({ path: join(root, "t6.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 });
    h.herdrSays(letta("[ ! ] Action Required | Tutor"));
    await h.status.letta.refresh([letta("[ ! ] Action Required | Tutor")] as never);
    await h.snapshot();
    const aborted = JSON.parse(turn.at(-1)!);
    aborted.message.stopReason = "aborted";
    appendFileSync(messages, `${JSON.stringify(aborted)}\n`);
    await h.status.letta.poll();
    // a new turn then ends well, all while the title still asked
    appendFileSync(messages, `${turn.slice(0, 1).concat(turn.slice(-1)).join("\n")}\n`);
    await h.status.letta.poll();
    h.herdrSays(letta("Tutor"));
    await h.snapshot();
    expect(failed).toEqual([]);
  });

  it("tells no turn from a read that began before one already applied and finished after it", async () => {
    core();
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor"));
    await h.snapshot();
    // a read begins while the spinner still turns, and is answered only after a newer read saw it stop
    const release = await h.heldSnapshot();
    h.herdrSays(letta("Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("done");
    await release();
    expect(h.last().status).toBe("done");
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(1);
  });

  it("keeps a status the program reports over its title", async () => {
    core();
    const h = hub();
    resolving().mockResolvedValue(null);
    h.herdrSays(letta("⠋ Tutor", "blocked"));
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]!.agent_status).toBe("blocked");
  });

  it("shows a file-tracked pane as blocked while its pending call waits for the user's approval", async () => {
    core();
    const store = join(root, "letta-store-asking");
    const agent = "agent-local-b";
    const messages = lettaMessagesPath(store, agent, "default")!;
    mkdirSync(join(messages, ".."), { recursive: true });
    // the prompt and the call waiting for approval: nothing more is written until the user answers
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    resolving().mockResolvedValue({ path: join(root, "t2.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 });
    h.herdrSays(letta("⠋ Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("working");
    h.herdrSays(letta("[ ! ] Action Required | Tutor"));
    const snapshot = await h.snapshot();
    expect(snapshot.panes[0]!.agent_status).toBe("blocked");
    expect(h.last().status).toBe("blocked");
  });

  it("keeps tracking a pane through a replay after a gap, which carries Ovis's own Letta status, not a report", async () => {
    core();
    const store = join(root, "letta-store-replay");
    const agent = "agent-local-d";
    const messages = lettaMessagesPath(store, agent, "default")!;
    mkdirSync(join(messages, ".."), { recursive: true });
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    resolving().mockResolvedValue({ path: join(root, "t4.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 });
    h.herdrSays(letta("Tutor"));
    await h.status.letta.refresh([letta("Tutor")] as never);
    await h.snapshot();
    expect(h.status.letta.tracks("w1:p1")).toBe(true);
    const doneBefore = h.alerts.filter((alert) => alert === "done").length;
    // the collector replays the snapshot's status around a gap: Ovis's own working, not herdr's word
    handlers.onStatus("w1:p1", "working", "letta", { before: "idle", agent: "letta" });
    expect(h.status.letta.tracks("w1:p1")).toBe(true);
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(doneBefore);
  });

  it("tells a denied approval's end as the failed rest the file wrote while it waited", async () => {
    core();
    const store = join(root, "letta-store-denied");
    const agent = "agent-local-e";
    const messages = lettaMessagesPath(store, agent, "default")!;
    mkdirSync(join(messages, ".."), { recursive: true });
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    const failed: string[] = [];
    spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failed.push(paneId); });
    resolving().mockResolvedValue({ path: join(root, "t5.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 });
    h.herdrSays(letta("[ ! ] Action Required | Tutor"));
    await h.status.letta.refresh([letta("[ ! ] Action Required | Tutor")] as never);
    await h.snapshot();
    expect(h.last().status).toBe("blocked");
    // denied: Letta writes an aborted answer while the title still asks, then its title rests
    const aborted = JSON.parse(turn.at(-1)!);
    aborted.message.stopReason = "aborted";
    aborted.timestamp = new Date().toISOString();
    appendFileSync(messages, `${JSON.stringify(aborted)}\n`);
    await h.status.letta.poll();
    h.herdrSays(letta("Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("idle");
    expect(failed).toEqual(["w1:p1"]);
  });

  it("works through a turn in Letta's local messages and finishes once, and gives the pane back to a report", async () => {
    core();
    const store = join(root, "letta-store");
    const agent = "agent-local-a";
    const messages = lettaMessagesPath(store, agent, "default")!;
    mkdirSync(join(messages, ".."), { recursive: true });
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    resolving().mockResolvedValue({ path: join(root, "t.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 });
    h.herdrSays(letta("Tutor"));
    await h.status.letta.refresh([letta("Tutor")] as never);
    await h.snapshot();
    expect(h.status.letta.tracks("w1:p1")).toBe(true);
    expect(h.last().status).toBe("working");
    appendFileSync(messages, `${turn.slice(2).join("\n")}\n`);
    await h.status.letta.poll();
    expect(h.last().status).toBe("done");
    expect(h.alerts.filter((alert) => alert === "done")).toHaveLength(1);
    // a report takes the pane back from Letta's own files
    h.herdrSays(letta("Tutor", "working"));
    const snapshot = await h.snapshot();
    expect(h.status.letta.runs("w1:p1")).toBe(false);
    expect(snapshot.panes[0]!.agent_status).toBe("working");
  });
});
