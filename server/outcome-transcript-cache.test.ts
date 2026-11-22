import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as conversation from "./conversation.ts";
import * as client from "./herdr/client.ts";
import { commandInvocations, commandOutcome } from "./outcome.ts";
import { handlePromptRequest, noteSubmitted } from "./prompt.ts";
import { processStartedAtAsync } from "./process-start.ts";
import { GJC_NATIVE_DIRECTORY } from "../shared/gjc-native.ts";
import type { HerdrPane, PanePromptResponse, SessionSnapshot, SlashCommand } from "../shared/protocol.ts";

const realStat = fs.statSync;
const claudeAt = (path: string) => async () => {
  const proven = realStat(path, { bigint: true });
  return { source: "claude-transcript" as const, path, claudeFile: `${proven.dev}:${proven.ino}` };
};

it("shares unchanged snapshots and parses only verified appends within the read budget", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-transcript-cache-"));
  const path = join(root, "session.jsonl");
  const record = (modelId: string) => JSON.stringify({ type: "model_change", timestamp: "2026-10-20T00:00:00Z", modelId }) + "\n";
  fs.writeFileSync(path, record("old").repeat(10_000));
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(claudeAt(path));
  const reads = spyOn(fs, "readSync");
  const parses = spyOn(JSON, "parse");
  try {
    const first = await conversation.readCommandTranscript("viewer-one");
    expect(first?.records).toHaveLength(10_000);
    const firstReads = reads.mock.calls.length;
    expect(firstReads).toBeGreaterThan(0);
    parses.mockClear();
    expect(await conversation.readCommandTranscript("viewer-two")).toBe(first);
    expect(reads.mock.calls.length).toBe(firstReads);
    expect(parses.mock.calls).toHaveLength(0);
    reads.mockClear();
    fs.appendFileSync(path, record("new"));
    const grown = await conversation.readCommandTranscript("viewer-two");
    const bytes = reads.mock.results.reduce((sum, result) => sum + (result.type === "return" && typeof result.value === "number" ? result.value : 0), 0);
    expect(bytes).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
    expect(parses.mock.calls.length).toBeLessThanOrEqual(5);
    expect(grown?.records).toHaveLength(10_001);
    reads.mockClear();
    parses.mockClear();
    expect(await conversation.readCommandTranscript("viewer-one")).toBe(grown);
    expect(reads.mock.calls).toHaveLength(0);
    expect(parses.mock.calls).toHaveLength(0);
    const stat = fs.statSync(path);
    fs.utimesSync(path, stat.atime, new Date(stat.mtimeMs + 1000));
    expect(await conversation.readCommandTranscript("viewer-two")).not.toBe(grown);
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(parses.mock.calls.length).toBeGreaterThanOrEqual(10_001);
  } finally {
    parses.mockRestore();
    reads.mockRestore();
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("invalidates rewritten and replaced transcripts and completes a torn tail only once", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-transcript-rewrite-"));
  const path = join(root, "session.jsonl");
  const record = (modelId: string) => JSON.stringify({ type: "model_change", timestamp: "2026-10-20T00:00:00Z", modelId }) + "\n";
  fs.writeFileSync(path, record("old"));
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(claudeAt(path));
  try {
    const first = await conversation.readCommandTranscript("viewer");
    const next = record("new");
    fs.appendFileSync(path, next.slice(0, 20));
    expect((await conversation.readCommandTranscript("viewer"))?.records).toHaveLength(1);
    fs.appendFileSync(path, next.slice(20));
    const completed = await conversation.readCommandTranscript("viewer");
    expect(completed?.records.map(({ entry }) => entry.modelId)).toEqual(["old", "new"]);
    expect(await conversation.readCommandTranscript("another-viewer")).toBe(completed);
    fs.writeFileSync(path, record("replacement"));
    const rewritten = await conversation.readCommandTranscript("viewer");
    expect(rewritten?.identity).not.toBe(first?.identity);
    expect(rewritten?.records.map(({ entry }) => entry.modelId)).toEqual(["replacement"]);
    const replacement = join(root, "replacement.jsonl");
    fs.writeFileSync(replacement, record("other-inode"));
    fs.renameSync(replacement, path);
    const replaced = await conversation.readCommandTranscript("viewer");
    expect(replaced?.identity).not.toBe(rewritten?.identity);
    expect(replaced?.records.map(({ entry }) => entry.modelId)).toEqual(["other-inode"]);
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["claude-transcript", "omp-transcript"] as const)("reads clear boundaries from the current bounded snapshot: %s", async (source) => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-transcript-clear-"));
  const path = join(root, "session.jsonl");
  const clear = source === "claude-transcript"
    ? { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }
    : { type: "custom", customType: "context_clear" };
  fs.writeFileSync(path, [{ type: "model_change", modelId: "before" }, clear, { type: "model_change", modelId: "after" }]
    .map((entry) => JSON.stringify(entry)).join("\n"));
  const written = fs.statSync(path, { bigint: true });
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(source === "omp-transcript" ? async () => ({ source, path, ompFile: `${written.dev}:${written.ino}` }) : claudeAt(path));
  const reads = spyOn(fs, "readSync");
  try {
    const snapshot = await conversation.readCommandTranscript("viewer");
    expect(snapshot?.records.filter(({ entry }) => entry.type === "model_change").map(({ entry }) => entry.modelId)).toEqual(["after"]);
    const bytes = reads.mock.results.reduce((sum, result) => sum + (result.type === "return" && typeof result.value === "number" ? result.value : 0), 0);
    expect(bytes).toBeLessThanOrEqual(conversation.TRANSCRIPT_WINDOW_BYTES);
  } finally {
    reads.mockRestore();
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["plain", "unchanged-row", "reserved-echo"] as const)("does not complete /context through the prompt route after a larger /version rewrite: %s", async (rewrite) => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-route-rewrite-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const echo = (name: string) => JSON.stringify({ type: "system", subtype: "local_command",
    timestamp: new Date(at + 10).toISOString(),
    content: `<command-name>${name}</command-name>\n<command-message>command</command-message>` }) + "\n";
  const finalRow = rewrite === "plain" ? "" : JSON.stringify({ type: "progress", uuid: "unchanged-final-row" }) + "\n";
  const stdout = JSON.stringify({ type: "system", subtype: "local_command",
    timestamp: new Date(at + 20).toISOString(), content: "<local-command-stdout>fixture-version-output</local-command-stdout>" }) + "\n";
  const tail = rewrite === "plain" ? "" : stdout.slice(0, 25);
  expect(Buffer.byteLength(echo("/context"))).toBe(Buffer.byteLength(echo("/version")));
  fs.writeFileSync(path, echo("/context") + finalRow + tail);
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "claude", agent_status: "idle", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(claudeAt(path));
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  const sent = { id: "route-context", text: "/context", at, agent: "claude",
    identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
    invocations: commandInvocations("claude", "/context", []) };
  try {
    noteSubmitted(pane.pane_id, sent.text, sent);
    const cached = await conversation.readCommandTranscript(pane.pane_id);
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    if (rewrite === "reserved-echo") {
      const before = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
      expect(before.outcomes?.at(-1)).toMatchObject({ state: "accepted", evidence: [] });
    }
    fs.writeFileSync(path, echo("/version") + finalRow + stdout);
    const response = await handlePromptRequest(new Request(url), url);
    const shown = await response?.json() as PanePromptResponse;
    expect(shown.outcomes?.at(-1)).toMatchObject({ state: "accepted", evidence: [] });
    const rewritten = await conversation.readCommandTranscript(pane.pane_id);
    expect(rewritten).not.toBe(cached);
    expect(rewritten?.records).toHaveLength(finalRow ? 3 : 2);
    fs.appendFileSync(path, JSON.stringify({ type: "model_change", timestamp: new Date(at + 40).toISOString(), modelId: "fixture" }) + "\n");
    const appended = await conversation.readCommandTranscript(pane.pane_id);
    expect(appended?.identity).toBe(rewritten?.identity);
    expect(appended?.records).toHaveLength(finalRow ? 4 : 3);
  } finally {
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it.each(["foreign", "fifo"] as const)("does not observe /context from a file swapped in for the outcome read's open (#3398): %s", async (swap) => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-route-swap-"));
  const path = join(root, "session.jsonl");
  const foreign = join(root, swap === "fifo" ? "fifo" : "foreign.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const echo = JSON.stringify({ type: "system", subtype: "local_command", timestamp: new Date(at + 10).toISOString(),
    content: "<command-name>/context</command-name>\n<command-message>command</command-message>" }) + "\n";
  const stdout = JSON.stringify({ type: "system", subtype: "local_command", timestamp: new Date(at + 20).toISOString(),
    content: "<local-command-stdout>foreign-context-output</local-command-stdout>" }) + "\n";
  const filler = (row: string) => JSON.stringify({ type: "progress", uuid: "x".repeat(Buffer.byteLength(row) - 30) }) + "\n";
  fs.writeFileSync(path, filler(echo) + filler(stdout));
  expect(fs.statSync(path).size).toBe(Buffer.byteLength(echo + stdout));
  // a FIFO no one writes to: an open that waits on it would hang the server
  if (swap === "fifo") expect(Bun.spawnSync(["mkfifo", foreign]).exitCode).toBe(0);
  else fs.writeFileSync(foreign, echo + stdout);
  const pane = { pane_id: root, terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "claude", agent_status: "idle", cwd: root };
  const clock = spyOn(Date, "now").mockReturnValue(at + 30);
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(claudeAt(path));
  const snapshot = spyOn(client, "sessionSnapshot").mockResolvedValue({
    panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture",
  });
  const screen = spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false });
  const open = fs.openSync;
  let swaps = 0;
  const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] !== path || swaps === 0) return open(...args);
    swaps -= 1;
    return open(foreign, ...args.slice(1) as [fs.OpenMode]);
  }) as typeof fs.openSync);
  const sent = { id: "route-swap", text: "/context", at, agent: "claude",
    identity: JSON.stringify([pane.terminal_id, undefined]), screen: "", store: null, form: null,
    invocations: commandInvocations("claude", "/context", []) };
  try {
    noteSubmitted(pane.pane_id, sent.text, sent);
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${encodeURIComponent(pane.pane_id)}`);
    expect((await conversation.readCommandTranscript(pane.pane_id))?.records).toHaveLength(2);
    const stat = fs.statSync(path);
    fs.utimesSync(path, stat.atime, new Date(stat.mtimeMs + 1000));
    swaps = 1;
    const swapped = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
    expect(swaps).toBe(0);
    expect(swapped.outcomes?.at(-1)).toMatchObject({ state: "accepted", evidence: [] });
  } finally {
    opens.mockRestore();
    screen.mockRestore();
    snapshot.mockRestore();
    binding.mockRestore();
    clock.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not observe an omp command from a transcript swapped in after its resolver authorized one (#3398)", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "command-omp-swap-")));
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  const cwd = join(home, "project");
  fs.mkdirSync(cwd);
  const store = join(home, ".omp/agent/sessions", cwd.replaceAll("/", "-"));
  fs.mkdirSync(store, { recursive: true });
  const path = join(store, "2026-10-01_s1.jsonl");
  const foreign = join(home, "foreign.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const header = JSON.stringify({ type: "session", version: 3, id: "s1", cwd }) + "\n";
  fs.writeFileSync(path, header);
  fs.writeFileSync(foreign, header + JSON.stringify({ type: "thinking_level_change", timestamp: new Date(at + 10).toISOString(), thinkingLevel: "high" }) + "\n");
  const pane = { pane_id: "pane-omp", cwd, foreground_cwd: cwd, agent: "omp" } as HerdrPane;
  const snapshot = spyOn(client, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] } as SessionSnapshot));
  const rpc = spyOn(client, "herdrRpc").mockImplementation(async (method: string) => {
    if (method === "agent.get") return { agent: { agent_session: { kind: "path", value: path } } } as never;
    if (method === "pane.process_info") return { process_info: { foreground_processes: [] } } as never;
    throw new Error(`unexpected RPC: ${method}`);
  });
  conversation.betweenAuthorizationForTests((stage) => { if (stage === "after") fs.renameSync(foreign, path); });
  const thinking: SlashCommand = { name: "thinking", source: "builtin", description: "",
    forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] };
  const sent = { id: "omp-thinking", text: "/thinking high", at, agent: "omp", identity: "fixture", screen: "", form: null,
    invocations: commandInvocations("omp", "/thinking high", [thinking]) };
  try {
    const read = await conversation.readCommandTranscript(pane.pane_id);
    expect(fs.existsSync(foreign)).toBe(false);
    expect(commandOutcome(pane.pane_id, sent, { now: at + 30, transcript: read?.records })).toMatchObject({ state: "accepted", evidence: [] });
  } finally {
    conversation.betweenAuthorizationForTests(null);
    rpc.mockRestore();
    snapshot.mockRestore();
    if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
    conversation.forgetTranscriptState();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("does not observe a pi command from a transcript renamed over the one its resolver authorized (#3398)", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "command-pi-swap-")));
  const saved = { HOME: process.env["HOME"], PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"], PI_CODING_AGENT_SESSION_DIR: process.env["PI_CODING_AGENT_SESSION_DIR"] };
  process.env["HOME"] = home;
  process.env["PI_CODING_AGENT_DIR"] = join(home, ".pi/agent");
  delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  const cwd = join(home, "project");
  fs.mkdirSync(cwd);
  const store = join(home, ".pi/agent/sessions", cwd.replaceAll("/", "-"));
  fs.mkdirSync(store, { recursive: true });
  const path = join(store, "2026-10-01_s1.jsonl");
  const foreign = join(home, "foreign.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const header = JSON.stringify({ type: "session", version: 3, id: "s1", cwd }) + "\n";
  fs.writeFileSync(path, header);
  fs.writeFileSync(foreign, header + JSON.stringify({ type: "thinking_level_change", id: "a1", parentId: null,
    timestamp: new Date(at + 10).toISOString(), thinkingLevel: "high" }) + "\n");
  const pane = { pane_id: "pane-pi", cwd, foreground_cwd: cwd, agent: "pi" } as HerdrPane;
  const snapshot = spyOn(client, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] } as SessionSnapshot));
  const rpc = spyOn(client, "herdrRpc").mockImplementation(async (method: string) => {
    if (method === "agent.get") return { agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: path } } } as never;
    if (method === "pane.process_info") return { process_info: { foreground_processes: [] } } as never;
    throw new Error(`unexpected RPC: ${method}`);
  });
  const fstat = fs.fstatSync;
  let swapped = false;
  const proofs = spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
    const stat = fstat(...args);
    if (!swapped && args[1]?.bigint === true) { swapped = true; fs.renameSync(foreign, path); }
    return stat;
  }) as typeof fs.fstatSync);
  const thinking: SlashCommand = { name: "thinking", source: "builtin", description: "",
    forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] };
  const sent = { id: "pi-thinking", text: "/thinking high", at, agent: "pi", identity: "fixture", screen: "", form: null,
    invocations: commandInvocations("pi", "/thinking high", [thinking]) };
  try {
    const read = await conversation.readCommandTranscript(pane.pane_id);
    expect(swapped).toBe(true);
    expect(commandOutcome(pane.pane_id, sent, { now: at + 30, transcript: read?.records })).toMatchObject({ state: "accepted", evidence: [] });
  } finally {
    proofs.mockRestore();
    rpc.mockRestore();
    snapshot.mockRestore();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    conversation.forgetTranscriptState();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("does not observe an omp command from a transcript its resolver could not authorize (#3398)", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-omp-unauthorized-"));
  const path = join(root, "held.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  fs.writeFileSync(path, JSON.stringify({ type: "thinking_level_change", timestamp: new Date(at + 10).toISOString(), thinkingLevel: "high" }) + "\n");
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "omp-transcript", path, ompBlobs: null });
  const thinking: SlashCommand = { name: "thinking", source: "builtin", description: "",
    forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] };
  const sent = { id: "omp-unauthorized", text: "/thinking high", at, agent: "omp", identity: "fixture", screen: "", form: null,
    invocations: commandInvocations("omp", "/thinking high", [thinking]) };
  try {
    const read = await conversation.readCommandTranscript("pane-omp");
    expect(commandOutcome("pane-omp", sent, { now: at + 30, transcript: read?.records })).toMatchObject({ state: "accepted", evidence: [] });
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not observe /context from an opened file whose exact identity only rounds to the stat's (#3398)", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-exact-identity-"));
  const path = join(root, "session.jsonl");
  const foreign = join(root, "foreign.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const echo = JSON.stringify({ type: "system", subtype: "local_command", timestamp: new Date(at + 10).toISOString(),
    content: "<command-name>/context</command-name>\n<command-message>command</command-message>" }) + "\n";
  const stdout = JSON.stringify({ type: "system", subtype: "local_command", timestamp: new Date(at + 20).toISOString(),
    content: "<local-command-stdout>foreign-context-output</local-command-stdout>" }) + "\n";
  const filler = (row: string) => JSON.stringify({ type: "progress", uuid: "x".repeat(Buffer.byteLength(row) - 30) }) + "\n";
  fs.writeFileSync(path, filler(echo) + filler(stdout));
  fs.writeFileSync(foreign, echo + stdout);
  // two 64-bit file indexes (as on Windows) a double cannot tell apart: 2^60 and 2^60 + 1
  const own = 2n ** 60n;
  const other = own + 1n;
  expect(Number(other)).toBe(Number(own));
  const open = fs.openSync;
  const stat = fs.statSync;
  const fstat = fs.fstatSync;
  let swappedFd: number | null = null;
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "claude-transcript", path, claudeFile: `7:${own}` });
  const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] !== path) return open(...args);
    swappedFd = open(foreign, ...args.slice(1) as [fs.OpenMode]);
    return swappedFd;
  }) as typeof fs.openSync);
  const stats = spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    const value = stat(...args);
    return args[0] === path && value !== undefined ? Object.assign(value, typeof value.ino === "bigint" ? { dev: 7n, ino: own } : { dev: 7, ino: Number(own) }) : value;
  }) as typeof fs.statSync);
  const fstats = spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
    const value = fstat(...args);
    return args[0] === swappedFd ? Object.assign(value, typeof value.ino === "bigint" ? { dev: 7n, ino: other } : { dev: 7, ino: Number(other) }) : value;
  }) as typeof fs.fstatSync);
  const sent = { id: "exact-identity", text: "/context", at, agent: "claude", identity: "fixture", screen: "", form: null,
    invocations: commandInvocations("claude", "/context", []) };
  try {
    const read = await conversation.readCommandTranscript("pane-claude");
    expect(swappedFd).not.toBeNull();
    expect(commandOutcome("pane-claude", sent, { now: at + 30, transcript: read?.records })).toMatchObject({ state: "accepted", evidence: [] });
  } finally {
    fstats.mockRestore();
    stats.mockRestore();
    opens.mockRestore();
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not observe a gjc command from a transcript renamed over the one its resolver read (#3398)", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "command-gjc-swap-")));
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  const cwd = join(home, "work");
  const sessions = join(home, ".gjc/agent/sessions/v2-project");
  fs.mkdirSync(cwd);
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(join(home, ".gjc/agent", GJC_NATIVE_DIRECTORY), { recursive: true });
  const path = join(sessions, "session-a.jsonl");
  const foreign = join(home, "foreign.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const header = JSON.stringify({ type: "session", id: "session-a", cwd }) + "\n";
  fs.writeFileSync(path, header);
  fs.writeFileSync(foreign, header + JSON.stringify({ type: "thinking_level_change", timestamp: new Date(at + 10).toISOString(), thinkingLevel: "high" }) + "\n");
  const birth = await processStartedAtAsync(process.pid);
  fs.writeFileSync(join(home, ".gjc/agent", GJC_NATIVE_DIRECTORY, `${process.pid}.json`), JSON.stringify({ version: 1, pid: process.pid,
    processStartedAt: birth, instanceId: "extension-test", sequence: 1, updatedAt: Date.now(), session: { id: "session-a", path, cwd } }));
  const pane = { pane_id: "pane-gjc", cwd, foreground_cwd: cwd, agent: "gjc" } as HerdrPane;
  const snapshot = spyOn(client, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] } as SessionSnapshot));
  const rpc = spyOn(client, "herdrRpc").mockImplementation(async (method: string) => {
    if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: process.pid, argv: ["/usr/bin/gjc"] }] } } as never;
    throw new Error(`unexpected RPC: ${method}`);
  });
  const lstat = fs.lstatSync;
  let proofs = 0;
  const lstats = spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
    const value = lstat(...args);
    if (args[0] === path && ++proofs === 2) fs.renameSync(foreign, path);
    return value;
  }) as typeof fs.lstatSync);
  const thinking: SlashCommand = { name: "thinking", source: "builtin", description: "",
    forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] };
  const sent = { id: "gjc-thinking", text: "/thinking high", at, agent: "gjc", identity: "fixture", screen: "", form: null,
    invocations: commandInvocations("gjc", "/thinking high", [thinking]) };
  try {
    const read = await conversation.readCommandTranscript(pane.pane_id);
    expect(proofs).toBe(2);
    expect(fs.existsSync(foreign)).toBe(false);
    expect(commandOutcome(pane.pane_id, sent, { now: at + 30, transcript: read?.records })).toMatchObject({ state: "accepted", evidence: [] });
  } finally {
    lstats.mockRestore();
    rpc.mockRestore();
    snapshot.mockRestore();
    if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
    conversation.forgetTranscriptState();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("does not observe an omo command from a transcript renamed over the one its lookup read (#3398)", async () => {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "command-omo-swap-")));
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  const cwd = join(home, "work");
  const sessions = join(home, ".omo/agent/sessions", `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`);
  fs.mkdirSync(cwd);
  fs.mkdirSync(sessions, { recursive: true });
  const path = join(sessions, "2026-10-20_session-a.jsonl");
  const foreign = join(home, "foreign.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const header = JSON.stringify({ type: "session", id: "session-a", cwd, timestamp: new Date(at).toISOString() }) + "\n";
  fs.writeFileSync(path, header);
  fs.writeFileSync(foreign, header + JSON.stringify({ type: "thinking_level_change", timestamp: new Date(at + 10).toISOString(), thinkingLevel: "high" }) + "\n");
  const holder = Bun.spawn([process.execPath, "-e", `require("node:fs").openSync(${JSON.stringify(path)}, "r"); console.log("ready"); setInterval(() => {}, 1000);`],
    { cwd, env: { HOME: home, PATH: process.env["PATH"] ?? "" }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const ready = await holder.stdout.getReader().read();
  expect(new TextDecoder().decode(ready.value)).toContain("ready");
  const pane = { pane_id: "pane-omo", cwd, foreground_cwd: cwd, agent: "pi" } as HerdrPane;
  const snapshot = spyOn(client, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] } as SessionSnapshot));
  const rpc = spyOn(client, "herdrRpc").mockImplementation(async (method: string) => {
    if (method === "pane.process_info") return { process_info: { foreground_processes: [{ pid: holder.pid, argv: ["/usr/bin/omo"], cwd }] } } as never;
    throw new Error(`unexpected RPC: ${method}`);
  });
  const open = fs.openSync;
  let swapped = false;
  const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    if (!swapped && args[0] === path) { swapped = true; fs.renameSync(foreign, path); }
    return fd;
  }) as typeof fs.openSync);
  const thinking: SlashCommand = { name: "thinking", source: "builtin", description: "",
    forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] };
  const sent = { id: "omo-thinking", text: "/thinking high", at, agent: "omo", identity: "fixture", screen: "", form: null,
    invocations: commandInvocations("omo", "/thinking high", [thinking]) };
  try {
    const read = await conversation.readCommandTranscript(pane.pane_id);
    expect(swapped).toBe(true);
    expect(commandOutcome(pane.pane_id, sent, { now: at + 30, transcript: read?.records })).toMatchObject({ state: "accepted", evidence: [] });
  } finally {
    opens.mockRestore();
    rpc.mockRestore();
    snapshot.mockRestore();
    holder.kill();
    await holder.exited;
    if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
    conversation.forgetTranscriptState();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

it("discards the old echo when a transcript is rewritten after a torn append", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-partial-boundary-"));
  const path = join(root, "session.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const echo = (name: string) => JSON.stringify({ type: "system", subtype: "local_command",
    timestamp: new Date(at + 10).toISOString(),
    content: `<command-name>${name}</command-name>\n<command-message>command</command-message>` }) + "\n";
  const stdout = JSON.stringify({ type: "system", subtype: "local_command", timestamp: new Date(at + 20).toISOString(),
    content: "<local-command-stdout>fixture-output</local-command-stdout>" }) + "\n";
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(claudeAt(path));
  try {
    fs.writeFileSync(path, echo("/context"));
    await conversation.readCommandTranscript("one");
    fs.appendFileSync(path, stdout.slice(0, 50));
    await conversation.readCommandTranscript("one");
    fs.writeFileSync(path, echo("/version") + stdout);
    const rewritten = await conversation.readCommandTranscript("two");
    const sent = { id: "context", text: "/context", at, agent: "claude", identity: "fixture", screen: "", form: null,
      invocations: commandInvocations("claude", "/context", []) };
    expect(commandOutcome("pane", sent, { now: at + 30, transcript: rewritten?.records }).state).toBe("accepted");
  } finally {
    binding.mockRestore();
    conversation.forgetTranscriptState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not read a claude transcript renamed over the one its resolver proved (#3402)", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-claude-proof-"));
  const path = join(root, "session.jsonl");
  const foreign = join(root, "foreign.jsonl");
  const at = Date.parse("2026-10-20T00:00:00Z");
  const row = (content: string, offset: number) => JSON.stringify({ type: "system", subtype: "local_command",
    timestamp: new Date(at + offset).toISOString(), content }) + "\n";
  fs.writeFileSync(path, row("<command-name>/version</command-name>", 5));
  fs.writeFileSync(foreign, row("<command-name>/context</command-name>", 10) + row("<local-command-stdout>foreign</local-command-stdout>", 20));
  const foreignIno = realStat(foreign).ino;
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(async () => {
    const proven = await claudeAt(path)();
    fs.renameSync(foreign, path);
    return proven;
  });
  try {
    expect(await conversation.readCommandTranscript("pane-claude")).toBeNull();
    expect(realStat(path).ino).toBe(foreignIno);
  } finally {
    binding.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("does not read a codex rollout renamed over the one its process was proven to hold (#3402)", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-codex-proof-"));
  const path = join(root, "rollout.jsonl");
  const foreign = join(root, "foreign.jsonl");
  fs.writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "own" } }) + "\n");
  fs.writeFileSync(foreign, JSON.stringify({ type: "session_meta", payload: { id: "foreign" } }) + "\n");
  const binding = spyOn(conversation, "paneTranscript").mockImplementation(async () => {
    const proven = realStat(path, { bigint: true });
    fs.renameSync(foreign, path);
    return { source: "codex-transcript" as const, path, codexHome: root, codexFile: `${proven.dev}:${proven.ino}` };
  });
  try {
    expect(await conversation.readCommandTranscript("pane-codex")).toBeNull();
  } finally {
    binding.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("keeps reading a codex rollout its resolver proved no identity for, by the exact stat alone (#3402)", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "command-codex-unproven-"));
  const path = join(root, "rollout.jsonl");
  fs.writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { id: "own" } }) + "\n");
  const binding = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "codex-transcript", path, codexHome: root });
  try {
    expect(await conversation.readCommandTranscript("pane-codex")).not.toBeNull();
  } finally {
    binding.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
