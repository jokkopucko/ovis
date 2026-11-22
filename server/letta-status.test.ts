import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createLettaStatus, lettaMessagesFile, lettaPanes, lettaRefreshKey, lettaTitleStatus, lettaTurnAfter } from "./letta-status.ts";
import { noTurn } from "./omo-status.ts";

// One turn of letta-code 0.34.44's local backend (old-desktop, 2026-11-08): the prompt, a Bash call, its result, the answer
const turn = readFileSync(join(import.meta.dir, "fixtures", "letta", "messages-turn-0.34.44.jsonl"), "utf8").trim().split("\n");

const pane = (id: string, agent: string | null, status: HerdrPane["agent_status"]): HerdrPane => ({
  pane_id: id, workspace_id: "w1", tab_id: "w1:t1", focused: false, cwd: "/p", foreground_cwd: "/p", agent, agent_status: status,
} as HerdrPane);

describe("a Letta pane's status from its local messages", () => {
  it("works from the prompt through each tool call and its result, and rests on the answer", () => {
    const seen: (string | null)[] = [];
    let state = noTurn();
    for (const line of turn) { state = lettaTurnAfter(state, { text: line }); seen.push(state.status); }
    expect(seen).toEqual(["working", "working", "working", "idle"]);
    expect(state.at).toBe(Date.parse("2026-11-08T02:29:09.323Z"));
  });

  it("takes no Letta tool for a prompt waiting on the user, whatever its name: only the approval title says Letta waits", () => {
    const ask = JSON.stringify({ type: "message", timestamp: "2026-11-08T02:29:01.501Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: {} }] } });
    const state = lettaTurnAfter(noTurn(), { text: ask });
    expect(state.status).toBe("working");
    expect(state.asks).toEqual([]);
  });

  it("reads a messages file only as a regular file of its own conversation folder, never through a link or from a FIFO, and only its tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "letta-messages-"));
    try {
      const folder = join(dir, "conversations", "key");
      mkdirSync(folder, { recursive: true });
      const real = join(folder, "messages.jsonl");
      writeFileSync(real, `${"x".repeat(100)}\n${turn.join("\n")}\n`);
      const file = lettaMessagesFile(turn.at(-1)!.length + 50);
      expect(file.stat(real)).not.toBeNull();
      const seen: string[] = [];
      await file.lines(real, 0, file.stat(real)!.size, (line) => { if ("text" in line) seen.push(line.text); }, () => true);
      expect(seen.some((line) => line.startsWith("xxxx"))).toBe(false);
      expect(seen.at(-1)).toBe(turn.at(-1));
      // a link put where the file was, or a link for the conversation's folder, gives another conversation's status
      const other = join(dir, "other.jsonl");
      writeFileSync(other, turn.join("\n"));
      const linkedFolder = join(dir, "conversations", "linked");
      mkdirSync(linkedFolder);
      symlinkSync(other, join(linkedFolder, "messages.jsonl"));
      expect(file.stat(join(linkedFolder, "messages.jsonl"))).toBeNull();
      symlinkSync(folder, join(dir, "conversations", "folder-link"));
      expect(file.stat(join(dir, "conversations", "folder-link", "messages.jsonl"))).toBeNull();
      // nor does a link for a folder above it, here the store's conversations folder pointing into another store
      const otherStore = join(dir, "other-store");
      mkdirSync(join(otherStore, "conversations", "key"), { recursive: true });
      writeFileSync(join(otherStore, "conversations", "key", "messages.jsonl"), turn.join("\n"));
      const linkedStore = join(dir, "linked-store");
      mkdirSync(linkedStore);
      symlinkSync(join(otherStore, "conversations"), join(linkedStore, "conversations"));
      expect(file.stat(join(linkedStore, "conversations", "key", "messages.jsonl"))).toBeNull();
      const fifoFolder = join(dir, "conversations", "fifo");
      mkdirSync(fifoFolder);
      spawnSync("mkfifo", [join(fifoFolder, "messages.jsonl")]);
      expect(file.stat(join(fifoFolder, "messages.jsonl"))).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("finds only Letta panes no report gives a status, with the messages file of the conversation it shows", async () => {
    const found = await lettaPanes([pane("t1", "letta", "unknown"), pane("t2", "letta", "working"), pane("t3", "claude", "unknown"), pane("t4", "letta", "unknown")], {
      resolve: async (target) => target.pane_id === "t1"
        ? { store: "/h/.letta/lc-local-backend", agent: "agent-local-a", conversation: "default", startedAt: 1000 }
        : null,
    });
    expect([...found]).toEqual([
      ["t1", { path: join("/h/.letta/lc-local-backend", "conversations", Buffer.from("default:agent-local-a").toString("base64url"), "messages.jsonl"), startedAt: 1000 }],
      ["t4", { path: null, startedAt: null }],
    ]);
  });

  it("takes Letta's own title where no report and no tracked messages file gave a status", () => {
    const titled = (id: string, status: HerdrPane["agent_status"], title: string, agent = "letta") => ({ ...pane(id, agent, status), terminal_title: title } as HerdrPane);
    const panes = [titled("t1", "unknown", "⠋ Tutor"), titled("t2", "unknown", "Tutor"), titled("t3", "unknown", "⠋ Tutor"), titled("t4", "blocked", "⠋ Tutor"), titled("t5", "unknown", "⠋ x", "claude")];
    const last = new Map<string, HerdrPane["agent_status"]>();
    expect(lettaTitleStatus({ panes: panes }, (paneId) => paneId === "t3", last)).toEqual([{ paneId: "t1", status: "working" }]);
    expect(panes.map((p) => p.agent_status)).toEqual(["working", "idle", "unknown", "blocked", "unknown"]);
    const next = [titled("t1", "unknown", "Tutor"), titled("t2", "unknown", "⠙ Tutor")];
    expect(lettaTitleStatus({ panes: next }, () => false, last)).toEqual([{ paneId: "t1", status: "idle" }, { paneId: "t2", status: "working" }]);
    expect(lettaTitleStatus({ panes: [titled("t2", "working", "Tutor")] }, () => false, last)).toEqual([]);
    expect([...last.keys()]).toEqual([]);
  });

  it("shows a tracked pane waiting on the user's approval as blocked, where its messages only show the pending call", () => {
    const titled = (id: string, status: HerdrPane["agent_status"], title: string) => ({ ...pane(id, "letta", status), terminal_title: title } as HerdrPane);
    const last = new Map<string, HerdrPane["agent_status"]>();
    expect(lettaTitleStatus({ panes: [titled("t1", "working", "⠋ Tutor")] }, () => true, last)).toEqual([]);
    const waiting = [titled("t1", "working", "[ ! ] Action Required | Tutor")];
    expect(lettaTitleStatus({ panes: waiting }, () => true, last)).toEqual([{ paneId: "t1", status: "blocked" }]);
    expect(waiting[0]!.agent_status).toBe("blocked");
    expect(lettaTitleStatus({ panes: [titled("t1", "working", "⠙ Tutor")] }, () => true, last)).toEqual([{ paneId: "t1", status: "working" }]);
  });

  it("takes the spinner after an approval over an older rest the file read while it waited", () => {
    const titled = (id: string, status: HerdrPane["agent_status"], title: string) => ({ ...pane(id, "letta", status), terminal_title: title } as HerdrPane);
    const last = new Map<string, HerdrPane["agent_status"]>();
    lettaTitleStatus({ panes: [titled("t1", "working", "[ ! ] Action Required | Tutor")] }, () => true, last);
    // approved, the call runs and the title spins, while the file still ends at an older answer
    const after = [titled("t1", "idle", "⠋ Tutor")];
    expect(lettaTitleStatus({ panes: after }, () => true, last)).toEqual([{ paneId: "t1", status: "working" }]);
    expect(after[0]!.agent_status).toBe("working");
  });

  it("finds a pane again early when its title's name or its spinner changes, not on every spinner frame", () => {
    const titled = (title: string) => ({ ...pane("t1", "letta", "unknown"), terminal_title: title } as HerdrPane);
    expect(lettaRefreshKey(titled("⠋ Tutor"))).toBe(lettaRefreshKey(titled("⠙ Tutor")));
    expect(lettaRefreshKey(titled("⠋ Tutor"))).not.toBe(lettaRefreshKey(titled("Tutor")));
    expect(lettaRefreshKey(titled("Tutor"))).not.toBe(lettaRefreshKey(titled("Coder")));
    expect(lettaRefreshKey(titled("Tutor"))).not.toBe(lettaRefreshKey(titled("[ ! ] Action Required | Tutor")));
  });

  it("looks a pane up again within its refresh interval only when its refresh key changes", async () => {
    let lookups = 0;
    const tracker = createLettaStatus({ discover: async () => { lookups += 1; return new Map(); }, snapshot: async () => ({ panes: [] }) as never, onChange: () => {} });
    const titled = (title: string) => [{ ...pane("t1", "letta", "unknown"), terminal_title: title } as HerdrPane];
    await tracker.refresh(titled("Tutor"));
    await tracker.refresh(titled("Tutor"));
    expect(lookups).toBe(1);
    await tracker.refresh(titled("⠋ Tutor"));
    expect(lookups).toBe(2);
    const withShell = (title: string) => [...titled("⠋ Tutor"), { ...pane("t2", null, "unknown"), terminal_title: title } as HerdrPane];
    await tracker.refresh(withShell("~/proj"));
    const before = lookups;
    await tracker.refresh(withShell("~/proj — make test"));
    expect(lookups).toBe(before);
    tracker.stop();
  });

  it("keeps a tracked pane waiting on approval blocked in a read that finished after a newer one", () => {
    const titled = (id: string, status: HerdrPane["agent_status"], title: string) => ({ ...pane(id, "letta", status), terminal_title: title } as HerdrPane);
    const last = new Map<string, HerdrPane["agent_status"]>();
    lettaTitleStatus({ panes: [titled("t1", "working", "[ ! ] Action Required | Tutor")] }, () => true, last);
    const stale = [titled("t1", "working", "⠋ Tutor")];
    expect(lettaTitleStatus({ panes: stale }, () => true, last, false)).toEqual([]);
    expect(stale[0]!.agent_status).toBe("blocked");
  });

  it("goes on from the status a tracked messages file gave when the file stops speaking", () => {
    const titled = (id: string, status: HerdrPane["agent_status"], title: string) => ({ ...pane(id, "letta", status), terminal_title: title } as HerdrPane);
    const last = new Map<string, HerdrPane["agent_status"]>();
    expect(lettaTitleStatus({ panes: [titled("t1", "working", "⠋ Tutor")] }, () => true, last)).toEqual([]);
    expect(lettaTitleStatus({ panes: [titled("t1", "unknown", "Tutor")] }, () => false, last)).toEqual([{ paneId: "t1", status: "idle" }]);
  });

  it("keeps a cloud conversation, whose messages are on the server, without a file", async () => {
    const found = await lettaPanes([pane("t1", "letta", "unknown")], { resolve: async () => ({ store: "/s", agent: "agent-a", conversation: "conv-123", startedAt: 5 }) });
    expect(found.get("t1")).toEqual({ path: null, startedAt: 5 });
  });
});
