import { expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryChanged } from "../conversation-shared.ts";
import { KeeperClient } from "./client.ts";

function archive() {
  const root = mkdtempSync(join(tmpdir(), "archive-"));
  const socket = new Socket();
  const client = new KeeperClient(root, { connect: () => socket });
  let seq = 0;
  const rawRow = (dir: string, raw: string) => {
    const line = JSON.stringify({ dir, seq: ++seq, ts: 1000 + seq, raw }) + "\n";
    appendFileSync(join(root, "archive.jsonl"), line); socket.emit("data", line);
  };
  const row = (dir: string, message: unknown) => rawRow(dir, JSON.stringify(message));
  const update = (value: unknown) => row("from-agent", { method: "session/update", params: { sessionId: "child", update: value } });
  const chunk = (sessionUpdate: string, text: string) => update({ sessionUpdate, content: { type: "text", text } });
  const prompt = (text: string) => {
    const id = "p" + seq;
    row("to-agent", { id, method: "session/prompt", params: { sessionId: "child", prompt: [{ type: "text", text }] } });
    return id;
  };
  const mode = (phase: string) => row("keeper", { method: "_keeper/mode", params: { mode: "acp", phase } });
  row("keeper", { method: "_keeper/session", params: { sessionId: "child" } });
  return { client, root, row, rawRow, update, chunk, prompt, mode, close: () => { client.close(); rmSync(root, { recursive: true, force: true }); } };
}

it("marks the last agent text final only after the matching end_turn", async () => {
  const { client, row, prompt, chunk, close } = archive();
  try {
    const id = prompt("Hello"); chunk("agent_message_chunk", "Answer");
    const end = (request: string) => row("from-agent", { id: request, result: { stopReason: "end_turn" } });
    end("unrelated");
    const running = await client.history.page({});
    expect(running.turns.at(-1)?.parts).toEqual([{ kind: "text", text: "Answer" }]);
    end(id);
    const done = await client.history.page({});
    expect(done.turns.at(-1)?.parts).toEqual([{ kind: "text", text: "Answer", phase: "final_answer" }]);
    expect(done.version).not.toBe(running.version);
  } finally { close(); }
});

it("only shows messages, plans and approvals for the keeper session", async () => {
  const { client, row, prompt, chunk, mode, close } = archive();
  const other = (sessionUpdate: string) => row("from-agent", { method: "session/update", params: {
    sessionId: "other", update: { sessionUpdate, content: { type: "text", text: "foreign" }, entries: [{ content: "foreign", status: "pending" }] },
  } });
  try {
    prompt("Hello"); other("agent_message_chunk"); other("plan");
    row("from-agent", { method: "session/request_permission", id: "elsewhere", params: { sessionId: "other" } });
    chunk("agent_message_chunk", "Mine");
    expect((await client.history.page({})).turns.at(-1)?.parts).toEqual([{ kind: "text", text: "Mine" }]);
    expect(client.turn?.text).toBe("Mine");
    expect(client.pending()).toEqual([]);
    expect(client.history.plan).toBeNull();
    mode("start"); other("user_message_chunk"); chunk("user_message_chunk", "Loaded"); mode("ready");
    expect((await client.history.page({})).turns.map(t => t.parts)).toEqual([[{ kind: "text", text: "Loaded" }]]);
  } finally { close(); }
});

for (const issue of ["failed", "oversize", "malformed", "invalid JSON"] as const) {
  it(`retains a complete transcript after a ${issue} replay and later plan`, async () => {
    const { client, row, rawRow, prompt, chunk, update, mode, close } = archive();
    try {
      prompt("Original"); chunk("agent_message_chunk", "Old answer");
      const before = await client.history.page({});
      mode("start"); chunk("agent_message_chunk", "DISCARDED");
      if (issue === "oversize") row("keeper", { method: "_keeper/oversize", params: { dir: "from-agent" } });
      if (issue === "malformed") update({ sessionUpdate: null });
      if (issue === "invalid JSON") rawRow("from-agent", '{"broken":"☃"');
      mode(issue === "failed" ? "failed" : "ready");
      update({ sessionUpdate: "plan", entries: [] });
      const after = await client.history.page({});
      expect(after.history_id).toBe(before.history_id);
      expect(after.turns.at(-1)?.parts).toMatchObject([{ kind: "text", text: "Old answer" }, { kind: "tool", name: "plan" }]);
    } finally { close(); }
  });
}

it("counts malformed archive rows without losing later prompts, live and on restore", async () => {
  const { root, client, row, rawRow, prompt, chunk, update, close } = archive();
  const replay = new Socket();
  const restored = new KeeperClient(root, { connect: () => replay });
  try {
    for (const kind of [{}, [], 1, null]) {
      update({ sessionUpdate: kind });
      row("from-agent", { method: kind });
    }
    rawRow("from-agent", '{"broken":"☃"');
    rawRow("from-agent", "[]");
    prompt("Hello");
    chunk("agent_message_chunk", "Still here");
    replay.emit("data", readFileSync(join(root, "archive.jsonl"), "utf8"));
    for (const reader of [client, restored]) {
      expect((await reader.history.page({})).turns.map(turn => turn.parts)).toEqual([
        [{ kind: "text", text: "Hello" }], [{ kind: "text", text: "Still here" }],
      ]);
      expect(reader.malformedRows).toBe(10);
    }
  } finally { restored.close(); close(); }
});

// Live prompt plus the user echo gjc sends, Codex-style edits, and a session/load replay.
it("pages prompts once, folds tool updates and replaces the visible history only on a complete replay", async () => {
  const { client, row, prompt, chunk, update, mode, close } = archive();
  try {
    prompt("First"); chunk("user_message_chunk", "First"); chunk("agent_message_chunk", "One");
    prompt("Edit"); chunk("agent_thought_chunk", "Check the note");
    update({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "edit", title: "Change note" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "note.txt", oldText: "A", newText: "B" }] });
    row("from-agent", { method: "session/request_permission", id: "agent-1", params: { toolCall: { title: "Only on the card" } } });
    chunk("agent_message_chunk", "Done"); update({ sessionUpdate: "plan", entries: [{ content: "Check note", status: "completed", priority: "medium" }] });
    const last = await client.history.page({ prompts: 1 });
    expect(last.turns).toMatchObject([{ role: "user", parts: [{ text: "Edit" }] }, { role: "assistant", parts: [{ kind: "thinking", text: "Check the note" }, { kind: "tool", summary: "Change note", state: "ok", edits: [{ path: "note.txt", before: "A", after: "B" }], output: "--- note.txt\nA\n+++ note.txt\nB" }, { text: "Done" }, { kind: "tool", name: "plan" }] }]);
    expect(client.history.plan).toMatchObject([{ label: "Check note", status: "completed" }]);
    if (!last.cursor) throw new Error("no older page");
    expect((await client.history.page({ before: last.cursor })).turns.map(t => t.parts)).toEqual([[{ kind: "text", text: "First" }], [{ kind: "text", text: "One" }]]);
    mode("start"); chunk("user_message_chunk", "Discarded replay"); mode("failed");
    expect((await client.history.page({ prompts: 1 })).turns).toEqual(last.turns);
    mode("start"); chunk("user_message_chunk", "From the TUI"); chunk("agent_message_chunk", "Reply");
    expect((await client.history.page({})).history_id).toBe(last.history_id);
    mode("ready");
    expect((await client.history.page({})).turns.map(t => t.parts)).toEqual([[{ kind: "text", text: "From the TUI" }], [{ kind: "text", text: "Reply" }]]);
    expect(client.history.plan).toBeNull();
    await expect(client.history.page({ before: last.cursor })).rejects.toBeInstanceOf(HistoryChanged);
  } finally { close(); }
});

it("applies nullable tool updates during replay without clearing the earlier kind or status", async () => {
  const { client, chunk, update, mode, close } = archive();
  try {
    mode("start");
    chunk("user_message_chunk", "Edit the note");
    update({ sessionUpdate: "tool_call", toolCallId: "t1", kind: "edit", title: "Change note", status: "in_progress" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", kind: null, status: "completed" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: null, content: [{ type: "diff", path: "note.txt", oldText: "A", newText: "B" }] });
    mode("ready");
    expect((await client.history.page({})).turns.at(-1)?.parts).toMatchObject([
      { kind: "tool", name: "edit", state: "ok", edits: [{ path: "note.txt", before: "A", after: "B" }] },
    ]);
  } finally { close(); }
});
