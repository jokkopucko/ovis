import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as conversation from "./conversation.ts";
import * as client from "./herdr/client.ts";
import { commandInvocations } from "./outcome.ts";
import { handlePromptRequest, noteSubmitted } from "./prompt.ts";
import type { PanePromptResponse } from "../shared/protocol.ts";

const realStat = fs.statSync;
const claudeAt = (path: string) => async () => {
  const proven = realStat(path, { bigint: true });
  return { source: "claude-transcript" as const, path, claudeFile: `${proven.dev}:${proven.ino}` };
};

const bytesRead = (reads: ReturnType<typeof spyOn<typeof fs, "readSync">>) => reads.mock.results.reduce((sum, result) =>
  sum + (result.type === "return" && typeof result.value === "number" ? result.value : 0), 0);

it.each([20, 128])("resolves a Chat model send from a %i MiB pi session within the read budget", async (megabytes) => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-budget-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  fs.writeFileSync(path, JSON.stringify({ type: "session", id: "session", version: 3 }) + "\n");
  for (let index = 0; index < megabytes; index++) {
    fs.appendFileSync(path, JSON.stringify({ type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
      message: { role: "assistant", content: "x".repeat(1024 * 1024) } }) + "\n");
  }
  fs.appendFileSync(path, JSON.stringify({ type: "model_change", id: "selected", parentId: `entry-${megabytes - 1}`,
    timestamp: new Date(at + 10).toISOString(), provider: "fixture", modelId: "chosen-model" }) + "\n");
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "pi", agent_status: "idle", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  const reads = spyOn(fs, "readSync");
  try {
    const sent = { id: "model", text: "/model chosen-model", at, agent: "pi",
      identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
      invocations: commandInvocations("pi", "/model chosen-model", []) };
    noteSubmitted(pane.pane_id, sent.text, sent);
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    const response = await handlePromptRequest(new Request(url), url);
    const shown: PanePromptResponse = await response?.json();
    expect(response?.status).toBe(200);
    expect(bytesRead(reads)).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
    expect(shown.outcomes?.at(-1)).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript" }] });
  } finally {
    reads.mockRestore();
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps resolving a pi send while appends slide the window of a session over 16 MiB", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-sliding-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const answer = (index: number) => JSON.stringify({ type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
    message: { role: "assistant", content: "x".repeat(1024 * 1024) } }) + "\n";
  fs.writeFileSync(path, JSON.stringify({ type: "session", id: "session", version: 3 }) + "\n");
  for (let index = 0; index < 20; index++) fs.appendFileSync(path, answer(index));
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "pi", agent_status: "working", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  try {
    const sent = { id: "sliding-model", text: "/model chosen-model", at, agent: "pi",
      identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
      invocations: commandInvocations("pi", "/model chosen-model", []) };
    noteSubmitted(pane.pane_id, sent.text, sent);
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    const latest = async () => ((await (await handlePromptRequest(new Request(url), url))?.json()) as PanePromptResponse).outcomes?.at(-1);
    expect(await latest()).toMatchObject({ state: "accepted", evidence: [] });
    fs.appendFileSync(path, answer(20));
    expect(await latest()).toMatchObject({ state: "accepted", evidence: [] });
    fs.appendFileSync(path, JSON.stringify({ type: "model_change", id: "selected", parentId: "entry-20",
      timestamp: new Date(at + 10).toISOString(), provider: "fixture", modelId: "chosen-model" }) + "\n");
    expect(await latest()).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript" }] });
  } finally {
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not complete a pi send from another branch whose first entry heads the slid window", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-branch-cut-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const entry = (id: string, parentId: string | null) => JSON.stringify({ type: "message", id, parentId,
    message: { role: "assistant", content: "x".repeat(1024 * 1024) } }) + "\n";
  fs.writeFileSync(path, JSON.stringify({ type: "session", id: "session", version: 3 }) + "\n");
  for (let index = 0; index < 20; index++) fs.appendFileSync(path, entry(`a${index}`, index ? `a${index - 1}` : null));
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "pi", agent_status: "working", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  try {
    const sent = { id: "branch-cut-model", text: "/model chosen-model", at, agent: "pi",
      identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
      invocations: commandInvocations("pi", "/model chosen-model", []) };
    noteSubmitted(pane.pane_id, sent.text, sent);
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    const latest = async () => ((await (await handlePromptRequest(new Request(url), url))?.json()) as PanePromptResponse).outcomes?.at(-1);
    expect(await latest()).toMatchObject({ state: "accepted" });
    for (let index = 0; index < 15; index++) fs.appendFileSync(path, entry(`b${index}`, index ? `b${index - 1}` : "a0"));
    fs.appendFileSync(path, JSON.stringify({ type: "model_change", id: "chosen", parentId: "b14",
      timestamp: new Date(at + 10).toISOString(), modelId: "chosen-model" }) + "\n");
    expect(await latest()).toMatchObject({ state: "accepted", evidence: [] });
  } finally {
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a pi branch's identity while its fork slides to the head of the window and out", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-fork-slide-"));
  const path = join(root, "session.jsonl");
  const entry = (id: string, parentId: string | null, mebibytes = 1) => JSON.stringify({ type: "message", id, parentId,
    message: { role: "assistant", content: "x".repeat(mebibytes * 1024 * 1024) } }) + "\n";
  fs.writeFileSync(path, [entry("e0", null), entry("e1", "e0"), entry("e2", "e1"), entry("e3", "e2"),
    entry("fork", "e1"), ...Array.from({ length: 13 }, (_, index) => entry(`f${index}`, index ? `f${index - 1}` : "fork"))].join(""));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const first = await conversation.readCommandTranscript("fork-slide");
    expect(first).not.toBeNull();
    let parent = "f12";
    for (let step = 0; step < 12; step++) {
      fs.appendFileSync(path, entry(`g${step}`, parent));
      parent = `g${step}`;
      expect((await conversation.readCommandTranscript("fork-slide"))?.identity).toBe(first?.identity);
    }
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("names a fork made after the pi branch's last entry afresh, though that entry is still on the path", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-later-fork-"));
  const path = join(root, "session.jsonl");
  const line = (entry: object) => JSON.stringify(entry) + "\n";
  fs.writeFileSync(path, line({ type: "message", id: "root", parentId: null }) + line({ type: "message", id: "a0", parentId: "root" }));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const before = await conversation.readCommandTranscript("later-fork");
    fs.appendFileSync(path, line({ type: "message", id: "a1", parentId: "a0" }) + line({ type: "message", id: "b0", parentId: "a0" })
      + line({ type: "model_change", id: "chosen", parentId: "b0", modelId: "chosen-model" }));
    const after = await conversation.readCommandTranscript("later-fork");
    expect(after?.records.map(({ entry }) => entry.id)).toEqual(["root", "a0", "b0", "chosen"]);
    expect(after?.identity).not.toBe(before?.identity);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("completes a pi send bound to a branch after the session leaves it and /tree comes back (#1879)", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-branch-return-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const line = (entry: object) => JSON.stringify(entry) + "\n";
  fs.writeFileSync(path, line({ type: "message", id: "root", parentId: null }) + line({ type: "message", id: "a0", parentId: "root" })
    + line({ type: "message", id: "a1", parentId: "a0" }));
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "pi", agent_status: "working", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  try {
    const sent = { id: "branch-return-model", text: "/model chosen-model", at, agent: "pi",
      identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
      invocations: commandInvocations("pi", "/model chosen-model", []) };
    noteSubmitted(pane.pane_id, sent.text, sent);
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    const latest = async () => ((await (await handlePromptRequest(new Request(url), url))?.json()) as PanePromptResponse).outcomes?.at(-1);
    expect(await latest()).toMatchObject({ state: "accepted", evidence: [] });
    fs.appendFileSync(path, line({ type: "message", id: "b0", parentId: "root" }));
    expect(await latest()).toMatchObject({ state: "accepted", evidence: [] });
    fs.appendFileSync(path, line({ type: "model_change", id: "chosen", parentId: "a1",
      timestamp: new Date(at + 10).toISOString(), modelId: "chosen-model" }));
    expect(await latest()).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript" }] });
  } finally {
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not credit a pi send with a later identical send's result when its own went to the branch the session visited", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-branch-visit-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const line = (entry: object) => JSON.stringify(entry) + "\n";
  fs.writeFileSync(path, line({ type: "message", id: "root", parentId: null }) + line({ type: "message", id: "a0", parentId: "root" })
    + line({ type: "message", id: "a1", parentId: "a0" }));
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "pi", agent_status: "working", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  try {
    const send = (id: string, sentAt: number) => {
      const sent = { id, text: "/model chosen-model", at: sentAt, agent: "pi",
        identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
        invocations: commandInvocations("pi", "/model chosen-model", []) };
      noteSubmitted(pane.pane_id, sent.text, sent);
    };
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    const outcomes = async () => ((await (await handlePromptRequest(new Request(url), url))?.json()) as PanePromptResponse).outcomes ?? [];
    send("first", at);
    await outcomes();
    fs.appendFileSync(path, line({ type: "message", id: "b0", parentId: "root" }));
    await outcomes();
    fs.appendFileSync(path, line({ type: "model_change", id: "first-result", parentId: "b0",
      timestamp: new Date(at + 5).toISOString(), modelId: "chosen-model" }));
    await outcomes();
    send("second", at + 10);
    fs.appendFileSync(path, line({ type: "model_change", id: "second-result", parentId: "a1",
      timestamp: new Date(at + 15).toISOString(), modelId: "chosen-model" }));
    const shown = await outcomes();
    expect(shown.find(({ id }) => id === "first")?.state).not.toBe("result-observed");
    expect(shown.find(({ id }) => id === "second")).toMatchObject({ state: "result-observed",
      evidence: [{ kind: "transcript", at: new Date(at + 15).toISOString() }] });
  } finally {
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a pi branch when the session goes to another branch and back to its last entry between two polls", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-branch-back-"));
  const path = join(root, "session.jsonl");
  const line = (entry: object) => JSON.stringify(entry) + "\n";
  fs.writeFileSync(path, line({ type: "message", id: "root", parentId: null }) + line({ type: "message", id: "a0", parentId: "root" }));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const before = await conversation.readCommandTranscript("branch-back");
    fs.appendFileSync(path, line({ type: "message", id: "b0", parentId: "root" }) + line({ type: "message", id: "a1", parentId: "a0" }));
    const after = await conversation.readCommandTranscript("branch-back");
    expect(after?.records.map(({ entry }) => entry.id)).toEqual(["root", "a0", "a1"]);
    expect(after?.identity).toBe(before?.identity);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("names a pi branch afresh on coming back to its last entry when something else was written under that entry", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-branch-back-hidden-"));
  const path = join(root, "session.jsonl");
  const line = (entry: object) => JSON.stringify(entry) + "\n";
  fs.writeFileSync(path, line({ type: "message", id: "root", parentId: null }) + line({ type: "message", id: "a0", parentId: "root" }));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const before = await conversation.readCommandTranscript("branch-back-hidden");
    fs.appendFileSync(path, line({ type: "message", id: "b0", parentId: "root" }));
    expect((await conversation.readCommandTranscript("branch-back-hidden"))?.identity).not.toBe(before?.identity);
    fs.appendFileSync(path, line({ type: "message", id: "a1", parentId: "a0" }) + line({ type: "model_change", id: "chosen", parentId: "a0", modelId: "chosen-model" }));
    const after = await conversation.readCommandTranscript("branch-back-hidden");
    expect(after?.records.map(({ entry }) => entry.id)).toEqual(["root", "a0", "chosen"]);
    expect(after?.identity).not.toBe(before?.identity);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not take a later entry that reuses a remembered pi branch's last id for that branch", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-reused-id-"));
  const path = join(root, "session.jsonl");
  const line = (entry: object) => JSON.stringify(entry) + "\n";
  const big = (id: string, parentId: string, mebibytes: number) => line({ type: "message", id, parentId,
    message: { role: "assistant", content: "x".repeat(mebibytes * 1024 * 1024) } });
  fs.writeFileSync(path, line({ type: "message", id: "root", parentId: null }) + line({ type: "message", id: "a0", parentId: "root" })
    + line({ type: "message", id: "a1", parentId: "a0" }));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const before = await conversation.readCommandTranscript("reused-id");
    fs.appendFileSync(path, big("b0", "root", 15));
    await conversation.readCommandTranscript("reused-id");
    fs.appendFileSync(path, line({ type: "message", id: "a1", parentId: "b0" }));
    expect(await conversation.readCommandTranscript("reused-id")).toBeNull();
    fs.appendFileSync(path, big("b1", "a1", 2));
    const after = await conversation.readCommandTranscript("reused-id");
    expect(after?.records.map(({ entry }) => entry.id)).toEqual(["a1", "b1"]);
    expect(after?.identity).not.toBe(before?.identity);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("names a pi branch afresh when an append cuts its last entry away and forks after the window's first entry", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-leaf-cut-fork-"));
  const path = join(root, "session.jsonl");
  const entry = (id: string, parentId: string | null) => JSON.stringify({ type: "message", id, parentId,
    message: { role: "assistant", content: "x".repeat(1024 * 1024) } }) + "\n";
  fs.writeFileSync(path, JSON.stringify({ type: "session", id: "session", version: 3 }) + "\n");
  for (let index = 0; index < 20; index++) fs.appendFileSync(path, entry(`a${index}`, index ? `a${index - 1}` : null));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const before = await conversation.readCommandTranscript("leaf-cut-fork");
    expect(before?.records.at(-1)?.entry.id).toBe("a19");
    for (let index = 0; index < 14; index++) fs.appendFileSync(path, entry(`h${index}`, index ? `h${index - 1}` : "a19"));
    fs.appendFileSync(path, entry("k", "h0") + JSON.stringify({ type: "model_change", id: "chosen", parentId: "k", modelId: "chosen-model" }) + "\n");
    const after = await conversation.readCommandTranscript("leaf-cut-fork");
    expect(after?.records.map(({ entry }) => entry.id)).toEqual(["h0", "k", "chosen"]);
    expect(after?.identity).not.toBe(before?.identity);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a pi branch when an append cuts its last entry out of the window", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-leaf-cut-"));
  const path = join(root, "session.jsonl");
  const entry = (index: number) => JSON.stringify({ type: "message", id: `a${index}`, parentId: index ? `a${index - 1}` : null,
    message: { role: "assistant", content: "x".repeat(1024 * 1024) } }) + "\n";
  fs.writeFileSync(path, JSON.stringify({ type: "session", id: "session", version: 3 }) + "\n");
  for (let index = 0; index < 20; index++) fs.appendFileSync(path, entry(index));
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const before = await conversation.readCommandTranscript("leaf-cut");
    expect(before?.records.at(-1)?.entry.id).toBe("a19");
    for (let index = 20; index < 35; index++) fs.appendFileSync(path, entry(index));
    const after = await conversation.readCommandTranscript("leaf-cut");
    expect(after?.records[0]?.entry.id).toBe("a20");
    expect(after?.identity).toBe(before?.identity);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("withholds pi evidence when a missing parent is not explained by a window cutoff", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-missing-parent-"));
  const path = join(root, "session.jsonl");
  fs.writeFileSync(path, JSON.stringify({ type: "model_change", id: "leaf", parentId: "missing", modelId: "chosen-model" }) + "\n");
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    expect(fs.statSync(path).size).toBeLessThan(conversation.TRANSCRIPT_WINDOW_BYTES);
    expect(await conversation.readCommandTranscript("missing-parent")).toBeNull();
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("parses only appended records after validating the entire retained tail", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-append-budget-"));
  const path = join(root, "session.jsonl");
  const record = (modelId: string) => JSON.stringify({ type: "model_change", modelId }) + "\n";
  fs.writeFileSync(path, record("old").repeat(1000));
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(claudeAt(path));
  const reads = spyOn(fs, "readSync");
  const parses = spyOn(JSON, "parse");
  try {
    await conversation.readCommandTranscript("append-budget");
    reads.mockClear();
    parses.mockClear();
    fs.appendFileSync(path, record("new"));
    const result = await conversation.readCommandTranscript("append-budget");
    expect(result?.records).toHaveLength(1001);
    expect(parses.mock.calls.length).toBeLessThanOrEqual(5);
    expect(bytesRead(reads)).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
  } finally {
    parses.mockRestore();
    reads.mockRestore();
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("resolves pi evidence only on the fully contained active branch", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-pi-branch-"));
  const path = join(root, "session.jsonl");
  const entries = [
    { id: "root", parentId: null, type: "model_change", modelId: "root-model" },
    { id: "abandoned", parentId: "root", type: "model_change", modelId: "old-model" },
    { id: "leaf", parentId: "abandoned", type: "message", message: { role: "assistant", content: [] } },
  ];
  fs.writeFileSync(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "pi-transcript", path });
  try {
    const first = await conversation.readCommandTranscript("pi-branch");
    expect(first?.records.some(({ entry }) => entry.modelId === "old-model")).toBe(true);
    fs.appendFileSync(path, JSON.stringify({ id: "new", parentId: "root", type: "model_change", modelId: "new-model" }) + "\n");
    const switched = await conversation.readCommandTranscript("pi-branch");
    expect(switched?.identity).not.toBe(first?.identity);
    expect(switched?.records.some(({ entry }) => entry.modelId === "old-model")).toBe(false);
    expect(switched?.records.some(({ entry }) => entry.modelId === "new-model")).toBe(true);
    fs.appendFileSync(path, JSON.stringify({ id: "more", parentId: "new", type: "message", message: { role: "assistant", content: [] } }) + "\n");
    expect((await conversation.readCommandTranscript("pi-branch"))?.identity).toBe(switched?.identity);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("validates the full overlapping tail within budget when the window slides", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "outcome-sliding-window-"));
  const path = join(root, "session.jsonl");
  const record = (modelId: string) => JSON.stringify({ type: "model_change", modelId, padding: "x".repeat(64 * 1024) }) + "\n";
  fs.writeFileSync(path, record("old").repeat(260));
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(claudeAt(path));
  const reads = spyOn(fs, "readSync");
  const parses = spyOn(JSON, "parse");
  try {
    const first = await conversation.readCommandTranscript("sliding");
    const changedOffset = first!.records[1]!.offset;
    reads.mockClear();
    parses.mockClear();
    fs.appendFileSync(path, '{"type":"model_change","modelId":"new"}\n');
    const appended = await conversation.readCommandTranscript("sliding");
    expect(appended?.records.at(-1)?.entry.modelId).toBe("new");
    expect(parses.mock.calls.length).toBeLessThanOrEqual(5);
    expect(bytesRead(reads)).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
    const fd = fs.openSync(path, "r+");
    try { fs.writeSync(fd, Buffer.from(record("bad")), 0, Buffer.byteLength(record("bad")), changedOffset); }
    finally { fs.closeSync(fd); }
    fs.appendFileSync(path, '{"type":"model_change","modelId":"end"}\n');
    reads.mockClear();
    parses.mockClear();
    const rewritten = await conversation.readCommandTranscript("sliding");
    expect(rewritten?.records.find(row => row.offset === changedOffset)?.entry.modelId).toBe("bad");
    expect(rewritten?.identity).not.toBe(appended?.identity);
    expect(parses.mock.calls.length).toBeGreaterThan(5);
    expect(bytesRead(reads)).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
  } finally {
    parses.mockRestore();
    reads.mockRestore();
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
