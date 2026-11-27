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

  it.each(["live report", "unbound replacement", "unbound peer", "different transcript", "overlapping reads"] as const)("routes an aborted Letta approval correctly after %s", async (replacement) => {
    core();
    const store = join(root, "letta-store-abandoned");
    const agent = "agent-local-g";
    const messages = lettaMessagesPath(store, agent, "default");
    if (!messages) throw new Error("missing fixture path");
    mkdirSync(join(messages, ".."), { recursive: true });
    writeFileSync(messages, `${turn.slice(0, 2).join("\n")}\n`);
    const h = hub();
    const failed: string[] = [];
    spyOn(h.status.push, "onFailed").mockImplementation(async (paneId: string) => { failed.push(paneId); });
    const bound = { path: join(root, "t7.jsonl"), session: `default:${agent}`, agent, conversation: "default", store, startedAt: 0 };
    const resolve = resolving().mockResolvedValue(bound);
    h.herdrSays(letta("[ ! ] Action Required | Tutor"));
    await h.snapshot();
    expect(h.last().status).toBe("blocked");
    expect(h.status.letta.tracks("w1:p1")).toBe(true);
    const aborted = JSON.parse(turn.at(-1) ?? "");
    aborted.message.stopReason = "aborted";
    aborted.timestamp = new Date().toISOString();
    appendFileSync(messages, `${JSON.stringify(aborted)}\n`);
    await h.status.letta.poll();

    const sameTitle = replacement === "unbound peer" || replacement === "different transcript";
    const peer = { ...letta("Peer"), pane_id: "w1:p2" };
    if (replacement === "live report") handlers.onStatus("w1:p1", "idle", "letta");
    if (replacement === "different transcript") resolve.mockImplementation(async (pane) => pane.pane_id === "w1:p1"
      ? { ...bound, store: join(root, "other-store") } : null);
    else resolve.mockResolvedValue(null);
    if (replacement === "overlapping reads") {
      const begun = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      resolve.mockImplementationOnce(async () => { begun.resolve(); await release.promise; return bound; });
      h.herdrSays({ ...letta("[ ! ] Action Required | Tutor"), cwd: join(root, "tutor") });
      const held = h.snapshot();
      await begun.promise;
      const bothEntered = Promise.withResolvers<void>();
      const refresh = h.status.letta.refresh.bind(h.status.letta);
      let entered = 0;
      spyOn(h.status.letta, "refresh").mockImplementation((panes) => {
        const result = refresh(panes);
        if (++entered === 2) bothEntered.resolve();
        return result;
      });
      h.herdrSays(letta("[ ! ] Action Required | Remote"));
      const remoteWait = h.snapshot();
      h.herdrSays(letta("Remote"));
      const remoteRest = h.snapshot();
      await bothEntered.promise;
      release.resolve();
      await Promise.all([held, remoteWait, remoteRest]);
    } else {
      const title = sameTitle ? "Tutor" : "Remote";
      const peers = sameTitle ? [peer] : [];
      h.herdrSays(letta(`[ ! ] Action Required | ${title}`), ...peers);
      expect((await h.snapshot()).panes[0]?.agent_status).toBe("blocked");
      h.herdrSays(letta(title), ...peers);
      await h.snapshot();
    }

    expect(failed).toEqual(replacement === "unbound peer" ? ["w1:p1"] : []);
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
    h.herdrSays(letta("Tutor", "working"));
    const snapshot = await h.snapshot();
    expect(h.status.letta.runs("w1:p1")).toBe(false);
    expect(snapshot.panes[0]!.agent_status).toBe("working");
  });
});
