import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, PanePromptResponse, SlashCommand } from "../shared/protocol.ts";
import { commandInvocations, commandOutcome, CommandReservations, ownsCommandDialog, WINDOW_MS, type CommandSend } from "./outcome.ts";
import { parsePrompt } from "./dialogs/live.ts";
import { finishPrompt, type DialogReader } from "./dialogs/shared.ts";
import { bindCommandProcess, commandSendFrom, handlePromptRequest, noteCommandEvidence, noteSubmitted } from "./prompt.ts";
import { socketAddress } from "./herdr/client.ts";
import { readCommandTranscript } from "./conversation.ts";
import * as processStart from "./process-start.ts";
import { registry } from "./dialogs/registry.ts";
import { source as claudeSource } from "./skills/claude.ts";
import { source as ompSource } from "./skills/omp.ts";
import { source as piSource } from "./skills/pi.ts";

const at = Date.parse("2026-10-20T00:00:00Z");
const row = (name: string, interaction: "none" | "dialog" | "terminal" | "unknown" = "none"): SlashCommand => ({
  name, source: "builtin", description: "", forms: [{ match: "bare", interaction }, { match: "other", interaction }],
});
const send = (text = "/context", agent = "claude", commands = [row("context")]): CommandSend => ({
  id: "send-1", text, at, agent, screen: "", identity: "session-1",
  invocations: commandInvocations(agent, text, commands),
  form: commandInvocations(agent, text, commands)[0]?.form ?? null,
});
const outcome = (sent: CommandSend, input: Partial<Parameters<typeof commandOutcome>[2]> = {}) => commandOutcome("pane-1", sent, { now: at + 100, ...input });
const local = (command: string, time = at + 10) => [
  { type: "system", subtype: "local_command", timestamp: new Date(time).toISOString(), content: `<command-name>${command}</command-name>\n<command-message>${command.slice(1)}</command-message>\n<command-args></command-args>` },
  { type: "system", subtype: "local_command", timestamp: new Date(time + 1).toISOString(), content: "<local-command-stdout>fixture-output</local-command-stdout>" },
].map((entry) => JSON.stringify(entry)).join("\n");

describe("command invocation syntax", () => {
  it("records inline skills only in the pane's syntax and keeps every match", () => {
    const review: SlashCommand = { ...row("review"), source: "skill", trigger: "$" };
    expect(commandInvocations("codex", "Please use $review now $review", [review])).toHaveLength(2);
    expect(commandInvocations("omo", "Please use $review", [review])).toHaveLength(1);
    expect(commandInvocations("omo", "Please use $review", [{ ...review, trigger: undefined }])).toHaveLength(1);
    expect(commandInvocations("pi", "Please use $review now", [review])).toEqual([]);
    expect(commandInvocations("claude", "Use /review now", [{ ...review, trigger: undefined }])).toHaveLength(1);
    expect(commandInvocations("claude", "Use /context now", [row("context")])).toEqual([]);
  });
  it("records only catalog-backed at tokens, not file mentions", () => {
    const skill: SlashCommand = { ...row("review"), trigger: "@", source: "skill" };
    expect(commandInvocations("opencode", "Use @review", [skill])).toHaveLength(1);
    expect(commandInvocations("opencode", "Read @path", [skill])).toEqual([]);
  });
  it("keeps unknown leading commands and selects specific and other forms", () => {
    expect(commandInvocations("pi", "/myext run", [])).toMatchObject([{ form: null }]);
    expect(commandInvocations("pi", "$myext run", [])).toEqual([]);
    const model: SlashCommand = { ...row("model"), forms: [{ match: "bare", interaction: "dialog" }, { match: "other", interaction: "none" }] };
    expect(commandInvocations("pi", "/model test-model", [model])[0]?.form?.interaction).toBe("none");
  });
  it("keeps absolute paths plain unless the catalog explicitly names that invocation", () => {
    for (const agent of ["claude", "pi", "codex", "omo"]) {
      expect(commandInvocations(agent, "/tmp/build.log shows a failure, why?", [])).toEqual([]);
      expect(commandInvocations(agent, "/etc/hosts", [])).toEqual([]);
      expect(commandInvocations(agent, "/myext run", [])).toHaveLength(1);
    }
    expect(commandInvocations("claude", "/plugin/task run", [{ ...row("plugin/task"), source: "skill" }])).toHaveLength(1);
  });
});

describe("evidence-only command outcomes", () => {
  it("never resolves from an idle screen, a generic delta, or elapsed time", () => {
    expect(outcome(send()).state).toBe("accepted");
    const changed = outcome({ ...send(), screen: "fixture-before" }, { screen: "a\n".repeat(2000) });
    expect(changed.state).toBe("accepted");
    expect(changed.preview?.length).toBe(2000);
    expect(changed.preview?.includes("\n")).toBe(true);
    expect(outcome(send(), { now: at + 600_000 }).state).toBe("unknown");
  });
  it("expires live previews at the deadline and after a later delivery", () => {
    const sent = { ...send("/model", "claude", [row("model", "dialog")]), screen: "fixture-before" };
    expect(outcome(sent, { screen: "fixture-live", now: at + 599_999 }).preview).toBeDefined();
    expect(outcome(sent, { screen: "fixture-live", now: at + 600_000 }).preview).toBeUndefined();
    expect(outcome(sent, { screen: "fixture-live", now: at + 3 * 60 * 60_000 }).preview).toBeUndefined();
    expect(outcome({ ...sent, closedAt: at + 20 }, { screen: "fixture-live" }).preview).toBeUndefined();
  });
  it("correlates Claude local output with this send, not another command or an old echo", () => {
    expect(outcome(send(), { transcript: local("/context") })).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript" }] });
    expect(outcome(send(), { transcript: local("/cost") }).state).toBe("accepted");
    expect(outcome(send(), { transcript: local("/context", at - 10) }).state).toBe("accepted");
    expect(outcome(send(), { transcript: local("/context").split("\n")[1] }).state).toBe("accepted");
  });
  it("gives identical sends disjoint evidence windows", () => {
    const first = send();
    const second = { ...send(), id: "send-2", at: at + 100 };
    expect(outcome(first, { transcript: local("/context", at + 110), nextAt: second.at }).state).toBe("unknown");
    expect(outcome(second, { transcript: local("/context"), now: at + 200 }).state).toBe("accepted");
    expect(outcome(second, { transcript: local("/context", at + 110), now: at + 200 }).state).toBe("result-observed");
  });
  it("returns terminal-required immediately even with no waiting screen", () => {
    expect(outcome(send("/status", "devin", [row("status", "terminal")])).state).toBe("terminal-required");
    expect(outcome(send("/btw hi", "claude", [row("btw", "terminal")]), { transcript: local("/btw") }).state).toBe("terminal-required");
    expect(outcome(send("/btw hi", "omp", [row("btw")])).state).toBe("terminal-required");
  });
  it("requires a matching persisted state value after the send", () => {
    const sent = send("/model test-model", "pi", [row("model")]);
    const record = (modelId: string, timestamp = at + 1) => JSON.stringify({ type: "model_change", timestamp: new Date(timestamp).toISOString(), modelId, provider: "test" });
    expect(outcome(sent, { transcript: record("test-model") }).state).toBe("result-observed");
    expect(outcome(sent, { transcript: record("another") }).state).toBe("accepted");
    expect(outcome(sent, { transcript: record("test-model", at - 1) }).state).toBe("accepted");
    expect(outcome(send("/myext run", "pi", []), { now: at + 600_000 }).state).toBe("unknown");
  });
  it("requires a continuously unrecognized wait for two seconds", () => {
    expect(outcome(send(), { waitingSince: at + 10, now: at + 2009 }).state).toBe("accepted");
    expect(outcome(send(), { waitingSince: at + 10, now: at + 2010 }).state).toBe("terminal-required");
  });
  for (const [agent, command] of [["hermes", "help"], ["claude", "goal"]] as const) {
    it(`offers the terminal for an unrecognized ${agent} /${command} after idle settling`, () => {
      const sent = send(`/${command}`, agent, [row(command, "dialog")]);
      expect(outcome(sent, { settledSince: at, now: at + 1999 }).state).toBe("accepted");
      expect(outcome(sent, { settledSince: at, now: at + 2000 })).toMatchObject({ state: "terminal-required", evidence: [] });
    });
  }
  it("does not apply idle settling to none, unknown, or unlisted forms", () => {
    for (const sent of [send(), send("/myext", "pi", []), send("/custom", "hermes", [row("custom", "unknown")])]) {
      expect(outcome(sent, { settledSince: at, now: at + 2000 }).state).toBe("accepted");
    }
  });
  it("does not treat a previously recognized dialog as an unrecognized settled screen", () => {
    const sent = { ...send("/model", "claude", [row("model", "dialog")]), dialogObserved: true as const };
    expect(outcome(sent, { settledSince: at, now: at + 2000 }).state).toBe("accepted");
  });
  it("retains confirmed evidence after the card or result leaves the screen", () => {
    const sent = send();
    sent.outcome = outcome(sent, { transcript: local("/context") });
    expect(outcome(sent, { now: at + 700_000, nextAt: at + 200 }).state).toBe("result-observed");
  });
  it("resolves only this send's reader commit, never just the existence of a card", () => {
    const sent = send();
    expect(outcome(sent, { dialog: { id: "card-1", reader: "claude-model" } }).state).toBe("interaction-required");
    expect(outcome(sent, { evidence: { kind: "dialog", at: at + 1 } }).state).toBe("result-observed");
    expect(outcome(sent, { evidence: { kind: "dialog", at: at - 1 } }).state).toBe("accepted");
  });
  it("accepts persisted effort and compaction only for the matching command", () => {
    const entry = (type: string) => JSON.stringify({ type, timestamp: new Date(at + 10).toISOString(), thinkingLevel: "high" });
    for (const agent of ["pi", "omp", "gjc", "omo"]) {
      expect(outcome(send("/thinking high", agent, [row("thinking")]), { transcript: entry("thinking_level_change") }).state).toBe("result-observed");
      expect(outcome(send("/compact", agent, [row("compact")]), { transcript: entry("compaction") }).state).toBe("accepted");
      expect(outcome(send("/myext", agent, []), { transcript: entry("compaction") }).state).toBe("accepted");
    }
    expect(outcome(send("/compact", "codex", [row("compact")]), { transcript: entry("compacted") }).state).toBe("accepted");
    expect(outcome(send("/context", "codex"), { transcript: local("/context") }).state).toBe("accepted");
  });
  it("calls Claude's /compact done only once the compaction is recorded, not when its line is written at the start", () => {
    const line = (entry: object, ms: number) => JSON.stringify({ ...entry, timestamp: new Date(at + ms).toISOString() });
    // Claude Code 2.1: `/compact` as a user line when it starts; the boundary, the summary, its echo and output when it ends
    const started = line({ type: "user", message: { role: "user", content: "/compact" } }, 10);
    const ended = [started,
      line({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }, 40_000),
      line({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation." } }, 40_000),
      line({ type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>" } }, 10),
      line({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } }, 40_001)].join("\n");
    const sent = send("/compact", "claude", [row("compact")]);
    expect(outcome(sent, { now: at + 2_000, transcript: started }).state).toBe("accepted");
    expect(outcome(sent, { now: at + 41_000, transcript: ended })).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript", at: new Date(at + 40_000).toISOString() }] });
  });
  it("does not call a queued Claude /compact done on an automatic compaction", () => {
    const line = (entry: object, ms: number) => JSON.stringify({ ...entry, timestamp: new Date(at + ms).toISOString() });
    const boundary = (trigger: string) => line({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger, preTokens: 160_000 } }, 30_000);
    const summary = line({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation." } }, 30_000);
    const sent = send("/compact", "claude", [row("compact")]);
    expect(outcome(sent, { now: at + 31_000, transcript: [boundary("auto"), summary].join("\n") }).state).toBe("accepted");
    expect(outcome(sent, { now: at + 31_000, transcript: [boundary("manual"), summary].join("\n") }).state).toBe("result-observed");
  });
});

it("serves bounded outcomes, strips observer previews, and records only a successful card commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-outcome-route-"));
  const socketPath = join(root, "herdr.sock");
  const previous = process.env.HERDR_SOCKET;
  const paneId = `outcome-${Date.now()}`;
  let agent = "pi";
  let status = "idle";
  let screen = "fixture-screen\nsecond-line";
  let onRead: (() => void) | undefined;
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input) as { id: string; method: string };
      if (request.method === "pane.read") { const run = onRead; onRead = undefined; run?.(); }
      const result = request.method === "session.snapshot"
        ? { snapshot: { panes: [{ pane_id: paneId, agent, agent_status: status }], layouts: [] } }
        : { read: { text: screen } };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketAddress(socketPath), resolve); });
  process.env.HERDR_SOCKET = socketPath;
  try {
    for (let index = 0; index < 6; index++) {
      const sent = { ...send("/myext run", "pi", []), at: Date.now() - 600_001, id: `unknown-${index}`, identity: JSON.stringify([undefined, undefined]), store: null };
      expect(sent.form).toBeNull();
      noteSubmitted(paneId, sent.text, sent);
    }
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
    const response = await handlePromptRequest(new Request(url), url);
    expect(response?.status).toBe(200);
    const answer = await response?.json() as { outcomes: { id: string; state: string; preview?: string }[] };
    expect(answer.outcomes).toHaveLength(5);
    expect(answer.outcomes[0]?.id).toBe("unknown-1");
    expect(answer.outcomes.every((outcome) => outcome.state === "unknown")).toBe(true);
    expect(answer.outcomes.at(-1)?.preview).toBeUndefined();
    const observer = await handlePromptRequest(new Request(url), url, { readOnly: true });
    const watched = await observer?.json() as { outcomes: { preview?: string }[] };
    expect(watched.outcomes.every((outcome) => outcome.preview === undefined)).toBe(true);
    agent = "claude";
    status = "blocked";
    screen = " Accessing workspace:\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel";
    const current = { ...send("/myext", "claude", []), at: Date.now() - 1, id: "card-send", identity: JSON.stringify([undefined, undefined]), store: null };
    noteSubmitted(paneId, current.text, current);
    const shown = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
    expect(shown.prompt).not.toBeNull();
    const answerUrl = new URL("http://localhost/api/pane/prompt/answer");
    const request = (promptId: string) => new Request(answerUrl, { method: "POST", body: JSON.stringify({ pane_id: paneId, prompt_id: promptId, option_index: 0 }) });
    expect((await handlePromptRequest(request("stale-card"), answerUrl))?.status).toBe(409);
    if (!shown.prompt) throw new Error("fixture card missing");
    expect((await handlePromptRequest(request(shown.prompt.id), answerUrl))?.status).toBe(200);
    const committed = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
    expect(committed.outcomes?.at(-1)).toMatchObject({ state: "accepted", evidence: [] });
    onRead = () => noteSubmitted(paneId, current.text, { ...current, id: "racing-send", outcome: undefined, dialogId: undefined });
    const raced = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
    expect(raced.outcomes?.at(-1)).toMatchObject({ id: "racing-send", state: "accepted", evidence: [] });
    agent = "hermes";
    status = "idle";
    const tail = "fixture-route-tail-1\nfixture-route-tail-2\nfixture-route-tail-3";
    screen = tail;
    const readers = spyOn(registry, "readersFor").mockReturnValue([resultReader]);
    try {
      for (const id of ["route-result-1", "route-result-2"]) {
        const command = { ...send("/status", "hermes", [row("status", "unknown")]), at: Date.now() - 1, id,
          screen: tail, identity: JSON.stringify([undefined, undefined]), store: null };
        noteSubmitted(paneId, command.text, command);
      }
      screen = `${tail}\n> /status\n${block}`;
      const first = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
      expect(first.outcomes?.slice(-2).map(({ id, state }) => [id, state])).toEqual([
        ["route-result-1", "result-observed"], ["route-result-2", "accepted"],
      ]);
      screen += `\n> /status\n${block}`;
      const both = await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse;
      expect(both.outcomes?.slice(-2).map(({ id, state }) => [id, state])).toEqual([
        ["route-result-1", "result-observed"], ["route-result-2", "result-observed"],
      ]);
      let now = Date.now();
      const clock = spyOn(Date, "now").mockImplementation(() => now);
      const poll = async () => (await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse).outcomes?.at(-1);
      try {
        for (const [kind, name] of [["hermes", "help"], ["claude", "goal"]] as const) {
          agent = kind;
          status = "idle";
          screen = `> /${name}\nfixture-unrecognized-layout`;
          noteSubmitted(paneId, `/${name}`, { ...send(`/${name}`, kind, [row(name, "dialog")]), at: now - 1,
            id: `settling-${name}`, identity: JSON.stringify([undefined, undefined]), store: null });
          expect((await poll())?.state).toBe("accepted");
          now += 1999;
          expect((await poll())?.state).toBe("accepted");
          screen += "\nfixture-output-progress";
          expect((await poll())?.state).toBe("accepted");
          now += 1999;
          expect((await poll())?.state).toBe("accepted");
          status = "working";
          expect((await poll())?.state).toBe("accepted");
          now += 1000;
          status = "done";
          expect((await poll())?.state).toBe("accepted");
          now += 2000;
          expect((await poll())?.state).toBe("terminal-required");
          screen = `> /${name}\n${block}`;
          now += 100;
          expect((await poll())?.state).toBe("terminal-required");
        }
        agent = "hermes";
        status = "idle";
        readers.mockReturnValue([{ ...resultReader, chromeStart: (lines) => lines.findIndex((line) => line.startsWith("fixture-chrome:")) }]);
        screen = "fixture-help-top\nfixture-help-tail\nfixture-chrome: 1s";
        noteSubmitted(paneId, "/help", { ...send("/help", agent, [row("help", "dialog")]), at: now - 1,
          id: "settling-chrome", identity: JSON.stringify([undefined, undefined]), store: null });
        expect((await poll())?.state).toBe("accepted");
        now += 2000;
        screen = screen.replace("1s", "3s");
        expect((await poll())?.state).toBe("terminal-required");
        for (const [kind, name] of [["hermes", "status"], ["claude", "goal"]] as const) {
          agent = kind;
          screen = `${tail}\nfixture-chrome: 1s`;
          const silent = { ...send(`/${name}`, kind, [row(name, "dialog")]), at: now - 1, screen,
            id: `silent-${name}`, identity: JSON.stringify([undefined, undefined]), store: null };
          noteSubmitted(paneId, silent.text, silent);
          expect((await poll())?.state).toBe("accepted");
          now += 2100;
          expect((await poll())?.state).toBe("accepted");
          screen = screen.replace("1s", "3s");
          expect((await poll())?.state).toBe("accepted");
          now = silent.at + 600_000;
          expect((await poll())?.state).toBe("unknown");
        }
        agent = "hermes";
        readers.mockReturnValue([resultReader]);
        screen = tail;
        const slow = { ...send("/status", agent, [row("status", "dialog")]), at: now - 1, screen,
          id: "slow-status", identity: JSON.stringify([undefined, undefined]), store: null };
        noteSubmitted(paneId, slow.text, slow);
        screen += "\n> /status";
        expect((await poll())?.state).toBe("accepted");
        now += 2000;
        expect((await poll())?.state).toBe("terminal-required");
        now += 100;
        screen += `\n${block}`;
        expect(await poll()).toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
      } finally { clock.mockRestore(); }
    } finally { readers.mockRestore(); }
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

const block = "RESULT-BEGIN\nfixture-payload\nRESULT-END";
const resultReader: DialogReader = {
  id: "fixture-result", agents: ["hermes"], priority: 1, kind: "result", reread: "none", list: "none",
  parse(screen) {
    if (!screen.includes(block)) return null;
    return { ...finishPrompt("hermes", {
      kind: "question", title: "", question: "", body: block, options: [], multi_select: false, custom_option_index: null,
    }, { responder: "hermes-input", selectedIndex: 0, checkedOptionIndices: [], menuLabels: [], customMenuIndex: null, rejectWithEscapeIndex: null }),
    resultText: block, catalogChanged: true };
  },
};

let readerPaneSequence = 0;

/** A herdr stand-in serving one pane whose screen the test sets; keys sent to it are kept. */
async function withFakeHerdr(pane: { agent: string; status: string; screen: string; terminal_id?: string; agent_session?: HerdrPane["agent_session"]; pid?: number; argv?: string[]; cwd?: string }, run: (paneId: string, keys: unknown[], processReads: () => number, calls: () => Record<string, number>) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-outcome-reader-"));
  const socketPath = join(root, "herdr.sock");
  const previous = process.env.HERDR_SOCKET;
  const paneId = `outcome-reader-${++readerPaneSequence}`;
  const keys: unknown[] = [];
  const calls: Record<string, number> = {};
  let processReads = 0;
  const server = createServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input) as { id: string; method: string; params?: { keys?: unknown; text?: unknown } };
      if (request.method === "pane.send_keys") keys.push(request.params?.keys);
      if (request.method === "pane.send_text") keys.push(request.params?.text);
      if (request.method === "pane.process_info") processReads += 1;
      calls[request.method] = (calls[request.method] ?? 0) + 1;
      const result = request.method === "session.snapshot"
        ? { snapshot: { panes: [{ pane_id: paneId, agent: pane.agent, agent_status: pane.status, terminal_id: pane.terminal_id, agent_session: pane.agent_session, cwd: pane.cwd }], layouts: [] } }
        : request.method === "pane.process_info"
        ? { process_info: { foreground_processes: pane.pid === undefined ? [] : [{ pid: pane.pid, argv: pane.argv ?? [pane.agent] }] } }
        : request.method === "agent.get"
        ? { agent: { pane_id: paneId, agent: pane.agent, agent_status: pane.status, terminal_id: pane.terminal_id, agent_session: pane.agent_session } }
        : { read: { text: pane.screen } };
      socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketAddress(socketPath), resolve); });
  process.env.HERDR_SOCKET = socketPath;
  try {
    await run(paneId, keys, () => processReads, () => ({ ...calls }));
  } finally {
    if (previous === undefined) delete process.env.HERDR_SOCKET;
    else process.env.HERDR_SOCKET = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

it("correlates Pi's thinking card and session-only commit with bare /thinking, not /model", async () => {
  const pane = {
    pane_id: "fixture", workspace_id: "w", tab_id: "t", terminal_id: "fixture-terminal",
    focused: false, revision: 0, agent: "pi", agent_status: "idle", status: "idle", screen: "Ready",
    // pi holds the pane's input: its cards answer only then
    pid: 2147483646, argv: ["pi"],
  };
  await withFakeHerdr(pane, async (paneId, keys) => {
    const catalog = ["thinking", "model"].map((name) => ({ ...row(name), forms: piSource.forms?.[name] }));
    const command = commandSendFrom(pane, "pi", catalog, "/thinking")!;
    noteSubmitted(paneId, command.text, command);
    pane.screen = "Thinking Level\n\nShift+Tab cycles thinking levels in-session\n\n>\n\n→ ✓ medium\n    high\n\nEnter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel\n────────────────────\n/tmp/fixture\n0.0%/215k (auto)";
    const shown = await served(paneId);
    expect(command.dialogObserved).toBe(true);
    expect(command.dialogId).toBe(shown.prompt?.id);
    const url = new URL("http://localhost/api/pane/prompt/answer");
    const response = await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: paneId, prompt_id: shown.prompt!.id, option_index: 0 }) }), url);
    expect(response?.status).toBe(200);
    expect(keys).toEqual([["enter"]]);
    expect((await served(paneId)).outcomes).toMatchObject([{ id: command.id, state: "result-observed", evidence: [{ kind: "dialog" }] }]);
    pane.screen = "Ready again";
    const model = commandSendFrom(pane, "pi", catalog, "/model")!;
    noteSubmitted(paneId, model.text, model);
    pane.screen = "Thinking Level\n\n>\n\n→ ✓ medium\n\nEnter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel";
    await served(paneId);
    expect(model.dialogObserved).not.toBe(true);
  });
});

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const promptUrl = (paneId: string): URL => new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
const served = async (paneId: string): Promise<PanePromptResponse> =>
  await (await handlePromptRequest(new Request(promptUrl(paneId)), promptUrl(paneId)))?.json() as PanePromptResponse;

describe("session-scoped command outcomes", () => {
  const session = (value: string) => ({ agent: "claude", kind: "id", source: "herdr:claude", value });
  const target = () => ({
    pane_id: "fixture", workspace_id: "w", tab_id: "t", terminal_id: "terminal",
    focused: false, revision: 0, agent: "claude", agent_status: "idle", status: "idle",
    agent_session: session("earlier"), screen: "",
  });
  const submit = async (paneId: string, pane: HerdrPane, text: string) => {
    const command = commandSendFrom(pane, "claude", [row("context"), row("clear"), row("new"), row("resume", "terminal")], text);
    if (!command) throw new Error("fixture command was not recorded");
    bindCommandProcess(paneId, command);
    noteSubmitted(paneId, text, command);
    return command;
  };

  for (const agent of ["claude", "codex"]) {
    for (const replacement of ["session", "terminal", "process"]) {
      it(`keeps ${agent}'s first-turn receipt through session discovery, then drops it on a new ${replacement}`, async () => {
        const pane = { ...target(), agent, agent_session: null as HerdrPane["agent_session"], pid: 2147483645 };
        await withFakeHerdr(pane, async (paneId) => {
          const text = agent === "codex" ? "$imagegen" : "/context";
          const catalog: SlashCommand[] = agent === "codex"
            ? [{ ...row("imagegen"), source: "skill", trigger: "$" }] : [row("context")];
          const command = commandSendFrom(pane, agent, catalog, text);
          if (!command) throw new Error("fixture command was not recorded");
          bindCommandProcess(paneId, command);
          noteSubmitted(paneId, text, command);
          expect((await served(paneId)).outcomes).toMatchObject([{ id: command.id, state: "accepted", evidence: [] }]);
          pane.agent_session = { ...session("first-turn"), agent };
          expect((await served(paneId)).outcomes).toMatchObject([{ id: command.id, state: "accepted", evidence: [] }]);
          expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
          if (replacement === "session") pane.agent_session = { ...session("other"), agent };
          if (replacement === "terminal") pane.terminal_id = "replacement";
          if (replacement === "process") pane.pid++;
          expect((await served(paneId)).outcomes).toBeUndefined();
        });
      });
    }
  }

  // native Windows lists only the shell; a renamed agent executable matches no known program
  for (const foreground of ["no process", "another program"] as const) {
    it(`keeps codex's first-turn receipt through session discovery when its process cannot be told: ${foreground}`, async () => {
      const pane = { ...target(), agent: "codex", agent_session: null as HerdrPane["agent_session"],
        ...foreground === "another program" ? { pid: 2147483645, argv: ["/opt/fixture/agent-launcher", "--fixture"] } : {} };
      await withFakeHerdr(pane, async (paneId) => {
        const command = commandSendFrom(pane, "codex", [{ ...row("imagegen"), source: "skill", trigger: "$" }], "$imagegen");
        if (!command) throw new Error("fixture command was not recorded");
        bindCommandProcess(paneId, command);
        noteSubmitted(paneId, "$imagegen", command);
        expect((await served(paneId)).outcomes).toMatchObject([{ id: command.id, state: "accepted", evidence: [] }]);
        pane.agent_session = { ...session("first-turn"), agent: "codex" };
        expect((await served(paneId)).outcomes).toMatchObject([{ id: command.id, state: "accepted", evidence: [] }]);
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
        // adopted into the session it started, it stays scoped to that session
        pane.agent_session = { ...session("other"), agent: "codex" };
        expect((await served(paneId)).outcomes).toBeUndefined();
      });
    });
  }

  it("keeps all first-turn sends when the session is discovered before the first poll", async () => {
    const pane = { ...target(), agent_session: null as HerdrPane["agent_session"], pid: 2147483645 };
    await withFakeHerdr(pane, async (paneId) => {
      const first = await submit(paneId, pane, "/context");
      const second = await submit(paneId, pane, "/context");
      pane.agent_session = session("first-turn");
      expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([first.id, second.id]);
      pane.agent_session = session("other");
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });

  for (const text of ["/clear", "/new", "/resume next"]) {
    it(`does not carry a first-turn ${text} into yet another session`, async () => {
      const pane = { ...target(), agent_session: null as HerdrPane["agent_session"], pid: 2147483645 };
      await withFakeHerdr(pane, async (paneId) => {
        const current = await submit(paneId, pane, text);
        expect((await served(paneId)).outcomes).toHaveLength(1);
        pane.agent_session = session("first-turn");
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([current.id]);
        pane.agent_session = session("other");
        expect((await served(paneId)).outcomes).toBeUndefined();
      });
    });
  }

  for (const text of ["/clear", "/new", "/resume next"]) {
    it(`does not carry a sessionless ${text} into a different agent process`, async () => {
      const pane = { ...target(), agent_session: null as HerdrPane["agent_session"], pid: 2147483645 };
      await withFakeHerdr(pane, async (paneId) => {
        await submit(paneId, pane, text);
        expect((await served(paneId)).outcomes).toHaveLength(1);
        pane.pid++;
        pane.agent_session = session("replacement");
        expect((await served(paneId)).outcomes).toBeUndefined();
        expect((await served(paneId)).outcomes).toBeUndefined();
      });
    });

    it(`keeps ${text}'s own row after first-turn discovery and its subsequent session change`, async () => {
      const pane = { ...target(), agent_session: null as HerdrPane["agent_session"], pid: 2147483645 };
      await withFakeHerdr(pane, async (paneId) => {
        const earlier = await submit(paneId, pane, "/context");
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([earlier.id]);
        pane.agent_session = session("first-turn");
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([earlier.id]);
        const current = await submit(paneId, pane, text);
        pane.agent_session = session("changed");
        expect((await served(paneId)).outcomes).toMatchObject([{ id: current.id, text, evidence: [] }]);
        pane.pid++;
        expect((await served(paneId)).outcomes).toBeUndefined();
      });
    });
  }

  it("reads the pane's processes and the session once per poll while a command's transcript is open", async () => {
    // a Claude pane in a folder, so the poll resolves its transcript down to Claude's (empty) store
    const store = mkdtempSync(join(tmpdir(), "outcome-claude-store-"));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = store;
    const pane = { ...target(), pid: 2147483645, cwd: store,
      agent_session: session("0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9") };
    try {
      await withFakeHerdr(pane, async (paneId, _keys, _processReads, calls) => {
        const command = await submit(paneId, pane, "/context");
        await command.visibility?.binding;
        const before = calls();
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
        const after = calls();
        const made = (method: string) => (after[method] ?? 0) - (before[method] ?? 0);
        expect(made("agent.get")).toBe(1);
        expect(made("pane.process_info")).toBe(1);
        expect(made("session.snapshot")).toBe(1);
      });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      rmSync(store, { recursive: true, force: true });
    }
  });

  // the Codex, omp and gjc lookups take the poll's process read too, rather than asking herdr again (#1879); Codex
  // reads once more right before a screen match may bind a rollout to its processes
  for (const [agent, text, reads] of [["codex", "$imagegen", 2], ["omp", "/context", 1], ["gjc", "/context", 1]] as const) {
    it(`reads a ${agent} pane's processes once per poll while a command's transcript is open`, async () => {
      const store = mkdtempSync(join(tmpdir(), `outcome-${agent}-store-`));
      const previous = process.env.CODEX_HOME;
      process.env.CODEX_HOME = store;
      const pane = { ...target(), agent, pid: 2147483645, argv: [agent], cwd: store, agent_session: { ...session("fixture-session"), agent } };
      try {
        await withFakeHerdr(pane, async (paneId, _keys, _processReads, calls) => {
          const catalog: SlashCommand[] = agent === "codex" ? [{ ...row("imagegen"), source: "skill", trigger: "$" }] : [row("context")];
          const command = commandSendFrom(pane, agent, catalog, text);
          if (!command) throw new Error("fixture command was not recorded");
          bindCommandProcess(paneId, command);
          noteSubmitted(paneId, text, command);
          await command.visibility?.binding;
          const before = calls();
          expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
          const made = (method: string) => (calls()[method] ?? 0) - (before[method] ?? 0);
          expect(made("pane.process_info")).toBe(reads);
          expect(made("session.snapshot")).toBe(1);
        });
      } finally {
        if (previous === undefined) delete process.env.CODEX_HOME;
        else process.env.CODEX_HOME = previous;
        rmSync(store, { recursive: true, force: true });
      }
    });
  }

  // a poll read with no omp in it (none in front, only the shell, or an omp gone since) says nothing of the omp
  // the pane runs now, which may keep another store than the session herdr still reports
  for (const [label, foreground] of [["no process", []], ["only the shell", [{ pid: 2147483640, argv: ["bash"] }]]] as const) {
    it(`asks for an omp pane's processes again when the poll's read names ${label}`, async () => {
      const pane = { ...target(), agent: "omp", pid: 2147483645, argv: ["omp"], cwd: "/tmp", agent_session: null as HerdrPane["agent_session"] };
      await withFakeHerdr(pane, async (paneId, _keys, processReads) => {
        await readCommandTranscript(paneId, undefined, { processes: { foreground_processes: [...foreground] } as never }).catch(() => null);
        expect(processReads()).toBe(1);
      });
    });
  }

  it("omits a known session's sends once a restarted agent still reports that session id", async () => {
    // herdr keeps a restarted Claude Code's old session id until the new process's first turn
    const pane = { ...target(), pid: 2147483645 };
    await withFakeHerdr(pane, async (paneId) => {
      await submit(paneId, pane, "/context");
      expect((await served(paneId)).outcomes).toHaveLength(1);
      pane.pid++;
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });

  for (const polled of [true, false]) {
    it(`keeps a send to a restarted agent once herdr corrects the session id kept from the process before (${polled ? "polled" : "unpolled"})`, async () => {
      const pane = { ...target(), pid: 2147483645 };
      await withFakeHerdr(pane, async (paneId) => {
        const earlier = await submit(paneId, pane, "/context");
        await earlier.visibility?.binding;
        if (polled) expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([earlier.id]);
        // restarted, and herdr still reports the earlier process's session id
        pane.pid++;
        if (polled) expect((await served(paneId)).outcomes).toBeUndefined();
        const fresh = await submit(paneId, pane, "/context");
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([fresh.id]);
        pane.agent_session = session("corrected");
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([fresh.id]);
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([fresh.id]);
        pane.agent_session = session("other");
        expect((await served(paneId)).outcomes).toBeUndefined();
      });
    });
  }

  // a new process that truly owns the same session: claude -c, claude --resume, codex resume
  const resumed = async (paneId: string, pane: ReturnType<typeof target> & { pid?: number }) => {
    const earlier = await submit(paneId, pane, "/context");
    await earlier.visibility?.binding;
    expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([earlier.id]);
    pane.pid = pane.pid! + 1;
    expect((await served(paneId)).outcomes).toBeUndefined();
    const fresh = await submit(paneId, pane, "/context");
    expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([fresh.id]);
    return fresh;
  };

  it("does not carry a resumed session's send into the conversation a later Chat /clear starts", async () => {
    const pane = { ...target(), pid: 2147483645 };
    await withFakeHerdr(pane, async (paneId) => {
      await resumed(paneId, pane);
      const clear = await submit(paneId, pane, "/clear");
      pane.agent_session = session("cleared");
      expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([clear.id]);
      expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([clear.id]);
    });
  });

  it("drops a resumed session's send once its session changes in the terminal after herdr's lag, and stops reading its process", async () => {
    const pane = { ...target(), pid: 2147483645 };
    await withFakeHerdr(pane, async (paneId, _keys, processReads) => {
      const fresh = await resumed(paneId, pane);
      // past the lag herdr shows for a restarted agent's old id, and past the send's window
      const later = fresh.at + 11 * 60_000;
      const clock = spyOn(Date, "now").mockImplementation(() => later);
      try {
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([fresh.id]);
        const reads = processReads();
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([fresh.id]);
        expect(processReads()).toBe(reads);
        pane.agent_session = session("other");
        expect((await served(paneId)).outcomes).toBeUndefined();
      } finally {
        clock.mockRestore();
      }
    });
  });

  // herdr keeps a restarted agent's old session id for up to a minute (STALE_SESSION_LAG_MS): within it a session
  // change typed in the terminal is taken for the agent's own session, past it for a later one
  for (const [lag, kept] of [[59_000, true], [61_000, false]] as const) {
    it(`${kept ? "keeps" : "drops"} a resumed session's send whose session changes in the terminal ${lag / 1000} s after it`, async () => {
      const pane = { ...target(), pid: 2147483645 };
      await withFakeHerdr(pane, async (paneId) => {
        const fresh = await resumed(paneId, pane);
        pane.agent_session = session("typed-in-terminal");
        const clock = spyOn(Date, "now").mockImplementation(() => fresh.at + lag);
        try {
          expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual(kept ? [fresh.id] : undefined);
        } finally {
          clock.mockRestore();
        }
      });
    });
  }

  // herdr names an OmO pane `pi` (its process cannot be told on native Windows): the session herdr reports under
  // that label is the one the OmO send started, and a later one is not
  it("adopts an unmatched OmO send into the session herdr reports under the pane's label at the send", async () => {
    const pane = { ...target(), agent: "pi", agent_session: null as HerdrPane["agent_session"] };
    await withFakeHerdr(pane, async (paneId) => {
      const command = commandSendFrom(pane, "omo", [row("context")], "/context");
      if (!command) throw new Error("fixture command was not recorded");
      bindCommandProcess(paneId, command);
      noteSubmitted(paneId, "/context", command);
      expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
      const reported = { agent: "pi", kind: "path", source: "herdr:pi", value: "/fixture/omo-first.jsonl" };
      pane.agent_session = reported;
      expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
      expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
      pane.agent_session = { ...reported, value: "/fixture/omo-later.jsonl" };
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });

  it("does not adopt a send no process was bound to into another agent's session in the same terminal", async () => {
    const pane = { ...target(), agent: "codex", agent_session: null as HerdrPane["agent_session"] };
    await withFakeHerdr(pane, async (paneId) => {
      const command = commandSendFrom(pane, "codex", [{ ...row("imagegen"), source: "skill", trigger: "$" }], "$imagegen");
      if (!command) throw new Error("fixture command was not recorded");
      bindCommandProcess(paneId, command);
      noteSubmitted(paneId, "$imagegen", command);
      expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
      // Codex quit before its first turn, and Claude started in the same terminal
      pane.agent = "claude";
      pane.agent_session = session("claude-first");
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });

  it("leaves a send unidentified when its process answers as started after the send, and never adopts it", async () => {
    const pane = { ...target(), agent_session: null as HerdrPane["agent_session"], pid: 2147483645 };
    const late = spyOn(processStart, "processStartUpperBoundAsync").mockImplementation(async () => Date.now() + 1000);
    try {
      await withFakeHerdr(pane, async (paneId) => {
        const command = await submit(paneId, pane, "/context");
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
        // a process it was never bound to cannot replace it
        pane.pid++;
        expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
        pane.agent_session = session("first-turn");
        expect((await served(paneId)).outcomes).toBeUndefined();
      });
    } finally {
      late.mockRestore();
    }
  });

  it("hides a send whose process cannot be told apart only after two misses in a row", async () => {
    const pane = { ...target(), pid: 2147483645 as number | undefined };
    let bound = false;
    // no start time at binding; afterwards the pid runs on
    const started = spyOn(processStart, "processStartedAt").mockImplementation(() => bound ? 1000 : null);
    const alive = spyOn(processStart, "processAlive").mockReturnValue(true);
    // macOS takes a live pid as the same process (a pid is handed out again only after the whole range)
    const counted = process.platform !== "darwin";
    try {
      await withFakeHerdr(pane, async (paneId) => {
        const command = await submit(paneId, pane, "/context");
        const shown = async () => (await served(paneId)).outcomes?.map(({ id }) => id);
        expect(await shown()).toEqual([command.id]);
        bound = true;
        pane.pid = undefined;
        expect(await shown()).toEqual([command.id]);
        pane.pid = 2147483645;
        expect(await shown()).toEqual([command.id]);
        pane.pid = undefined;
        expect(await shown()).toEqual([command.id]);
        expect(await shown()).toEqual(counted ? undefined : [command.id]);
      });
    } finally {
      alive.mockRestore();
      started.mockRestore();
    }
  });

  it("keeps a send while its live process is out of the foreground (Ctrl+Z)", async () => {
    // the test runner stands in for the suspended agent, on every platform; it started before the send
    const pane = { ...target(), pid: process.pid as number | undefined };
    const before = spyOn(processStart, "processStartUpperBoundAsync").mockImplementation(async () => Date.now() - 60_000);
    try {
      await withFakeHerdr(pane, async (paneId) => {
        const command = await submit(paneId, pane, "/context");
        const shown = async () => (await served(paneId)).outcomes?.map(({ id }) => id);
        expect(await shown()).toEqual([command.id]);
        pane.pid = undefined;
        expect(await shown()).toEqual([command.id]);
        // Windows hands a finished process's number to the next one at once: there a live pid proves nothing
        expect(await shown()).toEqual(process.platform === "win32" ? undefined : [command.id]);
        expect(await shown()).toEqual(process.platform === "win32" ? undefined : [command.id]);
      });
    } finally {
      before.mockRestore();
    }
  });

  it("hides a send at the first look without its process once that process is gone", async () => {
    const exited = Bun.spawn([process.execPath, "--version"], { stdout: "ignore", stderr: "ignore" });
    await exited.exited;
    const pane = { ...target(), pid: exited.pid as number | undefined };
    await withFakeHerdr(pane, async (paneId) => {
      const command = await submit(paneId, pane, "/context");
      expect((await served(paneId)).outcomes?.map(({ id }) => id)).toEqual([command.id]);
      pane.pid = undefined;
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });

  it("omits earlier session sends after an agent restart", async () => {
    const pane = target();
    await withFakeHerdr(pane, async (paneId) => {
      await submit(paneId, pane, "/context");
      expect((await served(paneId)).outcomes).toHaveLength(1);
      pane.agent_session = session("restarted");
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });

  for (const text of ["/clear", "/new", "/resume next"]) {
    it(`keeps only the initiating ${text} row across its session change without inventing evidence`, async () => {
      const pane = target();
      await withFakeHerdr(pane, async (paneId) => {
        await submit(paneId, pane, "/context");
        const current = await submit(paneId, pane, text);
        pane.agent_session = session("changed");
        const shown = await served(paneId);
        expect(shown.outcomes).toMatchObject([{ id: current.id, text, evidence: [] }]);
        expect(shown.outcomes?.[0]?.state).not.toBe("result-observed");
        expect((await served(paneId)).outcomes?.map((item) => item.id)).toEqual([current.id]);
        pane.agent_session = session("restarted-again");
        expect((await served(paneId)).outcomes).toBeUndefined();
      });
    });
  }

  it("keeps every current-session outcome after an earlier session send", async () => {
    const pane = target();
    await withFakeHerdr(pane, async (paneId) => {
      await submit(paneId, pane, "/context");
      pane.agent_session = session("current");
      const first = await submit(paneId, pane, "/context");
      const second = await submit(paneId, pane, "/context");
      expect((await served(paneId)).outcomes?.map((item) => item.id)).toEqual([first.id, second.id]);
    });
  });

  it("does not carry a session-changing command into a replacement terminal", async () => {
    const pane = target();
    await withFakeHerdr(pane, async (paneId) => {
      await submit(paneId, pane, "/clear");
      pane.terminal_id = "replacement";
      pane.agent_session = session("restarted");
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });

  it("keeps correlated evidence on a session-changing send and later current sends", async () => {
    const pane = target();
    await withFakeHerdr(pane, async (paneId) => {
      const current = await submit(paneId, pane, "/clear");
      noteCommandEvidence(paneId, current.id, { kind: "native", at: current.at + 1 });
      pane.agent_session = session("changed");
      expect((await served(paneId)).outcomes).toMatchObject([{ id: current.id, state: "result-observed", evidence: [{ kind: "native" }] }]);
      const next = await submit(paneId, pane, "/context");
      expect((await served(paneId)).outcomes?.map((item) => item.id)).toEqual([current.id, next.id]);
    });
  });

  it("keeps the initiating receipt when the next session sends before the first poll", async () => {
    const pane = target();
    await withFakeHerdr(pane, async (paneId) => {
      const current = await submit(paneId, pane, "/clear");
      pane.agent_session = session("changed");
      const next = await submit(paneId, pane, "/context");
      expect((await served(paneId)).outcomes?.map((item) => item.id)).toEqual([current.id, next.id]);
      pane.agent_session = session("restarted-again");
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });

  it("does not carry a skill named clear or a closed clear send into another session", async () => {
    const pane = target();
    await withFakeHerdr(pane, async (paneId) => {
      const skill = commandSendFrom(pane, "claude", [{ ...row("clear"), source: "skill" }], "/clear");
      if (!skill) throw new Error("fixture skill was not recorded");
      noteSubmitted(paneId, skill.text, skill);
      pane.agent_session = session("after-skill");
      expect((await served(paneId)).outcomes).toBeUndefined();
      await submit(paneId, pane, "/clear");
      noteSubmitted(paneId, "ordinary follow-up");
      pane.agent_session = session("restarted");
      expect((await served(paneId)).outcomes).toBeUndefined();
    });
  });
});

describe("integrated dialog readers", () => {
  it("keeps a skill running after answering its incidental question below the echo", async () => {
    const pane = { agent: "claude", status: "blocked", screen: `fixture-anchor\n> /review
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
` };
    await withFakeHerdr(pane, async (paneId) => {
      const current = { ...send("/review", "claude", [{ ...row("review"), source: "skill" }]),
        at: Date.now() - 10, screen: "fixture-anchor", identity: JSON.stringify([undefined, undefined]), store: null };
      noteSubmitted(paneId, current.text, current);
      const shown = await served(paneId);
      expect(shown.prompt?.kind).toBe("question");
      expect(shown.outcomes?.at(-1)?.state).toBe("interaction-required");
      const url = new URL("http://localhost/api/pane/prompt/answer");
      const answered = await handlePromptRequest(new Request(url, { method: "POST",
        body: JSON.stringify({ pane_id: paneId, prompt_id: shown.prompt!.id, option_index: 0 }) }), url);
      expect(answered?.status).toBe(200);
      pane.status = "working";
      pane.screen = "fixture-anchor\n> /review\n● Working on it…";
      expect((await served(paneId)).outcomes?.at(-1)).toMatchObject({ state: "accepted", evidence: [] });
    });
  });

  it("links a skill's question beside Claude's fullscreen diff panel to its send", async () => {
    // every row of the 2.1.303 capture ends in the panel's edge in column 99 and the panel's text, the echo's row too
    const lines = fixture("claude-diff-panel-2.1.303-english-180.txt").split("\n");
    const screen = lines.slice(0, 33).join("\n");
    lines[33] = `${"❯ /review".padEnd(99)}│`;
    const pane = { agent: "claude", status: "blocked", screen: lines.join("\n") };
    await withFakeHerdr(pane, async (paneId) => {
      const current = { ...send("/review", "claude", [{ ...row("review"), source: "skill" }]),
        at: Date.now() - 10, screen, identity: JSON.stringify([undefined, undefined]), store: null };
      noteSubmitted(paneId, current.text, current);
      const shown = await served(paneId);
      expect(shown.prompt).toMatchObject({ kind: "question", question: "Which color?" });
      expect(shown.outcomes?.at(-1)?.state).toBe("interaction-required");
      expect(current.dialogId).toBe(shown.prompt!.id);
    });
  });

  it("keeps a skill's question linked when only its send's screen looks like a side panel", async () => {
    // a table's divider through every row of the send's screen passes there for the panel's edge, not on the next screen
    const table = Array.from({ length: 8 }, (_, index) => `${`Task ${index}`.padEnd(40)}\u2502 preserve requirement ${index}`);
    const pane = { agent: "claude", status: "blocked", screen: [...table, "\u276f /review", "\u2610 Dataset", "",
      "Which evaluation dataset should we use?", "", "\u276f 1. LM-O", "     Occlusion benchmark.", "  2. YCB-V", "     Household objects.",
      "  3. Type something.", "\u2500".repeat(28), "  4. Chat about this", "", "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel"].join("\n") };
    await withFakeHerdr(pane, async (paneId) => {
      const current = { ...send("/review", "claude", [{ ...row("review"), source: "skill" }]),
        at: Date.now() - 10, screen: table.join("\n"), identity: JSON.stringify([undefined, undefined]), store: null };
      noteSubmitted(paneId, current.text, current);
      const shown = await served(paneId);
      expect(shown.prompt).toMatchObject({ kind: "question", question: "Which evaluation dataset should we use?" });
      expect(shown.outcomes?.at(-1)?.state).toBe("interaction-required");
      expect(current.dialogId).toBe(shown.prompt!.id);
    });
  });

  it("gives no send a terminal command's question when its echoes were counted without the panel's cut", () => {
    // the first send's screen shows too few of the panel's rows to be cut, the second's enough: the second's echoes
    // were counted as drawn, its own echo with the panel's text missed; the later screen is cut
    const edge = (text: string, panel = "") => `${text.padEnd(99)}\u2502${panel}`;
    const top = Array.from({ length: 7 }, (_, index) => edge(`fixture-row-${index}`, index === 0 ? "1 file changed +2" : ""));
    const skill = [{ ...row("review"), source: "skill" as const }];
    const first = { ...send("/review", "claude", skill), id: "first", screen: top.join("\n") };
    const second = { ...send("/review", "claude", skill), id: "second", at: at + 1,
      screen: [...top, edge("\u276f /review", " 3 +three"), edge("\u25cf Reviewed."), edge("fixture-tail")].join("\n") };
    const question = ["\u2610 Dataset", "", "Which evaluation dataset should we use?", "", "\u276f 1. LM-O", "  2. YCB-V",
      "  3. Type something.", "\u2500".repeat(28), "  4. Chat about this", "", "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel"];
    const later = [...second.screen.split("\n"), edge("\u276f /review"), edge("\u25cf Reviewed again."), edge("\u276f /review"),
      ...question.map((line) => edge(line))].join("\n");
    const reservations = new CommandReservations();
    const readers = registry.readersFor("claude");
    reservations.add(first, readers);
    reservations.add(second, readers);
    const prompt = parsePrompt("claude", later);
    expect(prompt).toMatchObject({ kind: "question" });
    expect(ownsCommandDialog(second, prompt!, later, registry.readerFor(prompt!.responder)!, readers)).toBe(false);
  });

  it("gives a later send no terminal command's question through an echo count inherited from screens read the other way (#2207)", () => {
    // as above, the second send's echoes were counted as drawn; once the first send's reservation expires, the third's
    // screens, read alike, are cut, and the second's count would let the third skip its own echo for the next one
    const edge = (text: string, panel = "") => `${text.padEnd(99)}\u2502${panel}`;
    const top = Array.from({ length: 7 }, (_, index) => edge(`fixture-row-${index}`, index === 0 ? "1 file changed +2" : ""));
    const skill = [{ ...row("review"), source: "skill" as const }];
    const first = { ...send("/review", "claude", skill), id: "first", screen: top.join("\n") };
    const second = { ...send("/review", "claude", skill), id: "second", at: at + 1,
      screen: [...top, edge("\u276f /review", " 3 +three"), edge("\u25cf Reviewed."), edge("fixture-tail")].join("\n") };
    const third = { ...send("/review", "claude", skill), id: "third", at: at + WINDOW_MS,
      screen: [...second.screen.split("\n"), edge("\u276f /review"), edge("\u25cf Reviewed again."), edge("third-tail")].join("\n") };
    const question = ["\u2610 Dataset", "", "Which evaluation dataset should we use?", "", "\u276f 1. LM-O", "  2. YCB-V",
      "  3. Type something.", "\u2500".repeat(28), "  4. Chat about this", "", "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel"];
    // the third send's own result, then the same command typed in the terminal, which asks
    const later = [...third.screen.split("\n"), edge("\u276f /review"), edge("\u25cf Reviewed a third time."), edge("\u276f /review"),
      ...question.map((line) => edge(line))].join("\n");
    const reservations = new CommandReservations();
    const readers = registry.readersFor("claude");
    reservations.add(first, readers);
    reservations.add(second, readers);
    expect(second.countedCut).toBe(false);
    reservations.add(third, readers);
    expect(third.countedCut).toBe(true);
    const prompt = parsePrompt("claude", later);
    expect(prompt).toMatchObject({ kind: "question" });
    expect(ownsCommandDialog(third, prompt!, later, registry.readerFor(prompt!.responder)!, readers)).toBe(false);
  });

  it("still gives a send its own question after a send counted the other way whose result was seen and whose screen scrolled off", () => {
    const edge = (text: string, panel = "") => `${text.padEnd(99)}\u2502${panel}`;
    const top = Array.from({ length: 7 }, (_, index) => edge(`fixture-row-${index}`, index === 0 ? "1 file changed +2" : ""));
    const skill = [{ ...row("review"), source: "skill" as const }];
    const first = { ...send("/review", "claude", skill), id: "first", screen: top.join("\n") };
    const second = { ...send("/review", "claude", skill), id: "second", at: at + 60_000,
      screen: [...top, edge("\u276f /review", " 3 +three"), edge("\u25cf Reviewed."), edge("old-tail")].join("\n") };
    const third = { ...send("/review", "claude", skill), id: "third", at: at + WINDOW_MS,
      screen: [...Array.from({ length: 7 }, (_, index) => edge(`fresh-row-${index}`)), edge("fresh-tail")].join("\n") };
    const reservations = new CommandReservations();
    const readers = registry.readersFor("claude");
    reservations.add(first, readers);
    reservations.add(second, readers);
    // Claude's own records acknowledge both earlier sends: neither still owes an echo
    const acknowledged = (time: number) => JSON.stringify({ type: "user", timestamp: new Date(time).toISOString(), message: { content: "/review" } });
    first.outcome = commandOutcome("p", first, { now: at + 60_020, transcript: acknowledged(at + 10) });
    second.outcome = commandOutcome("p", second, { now: at + 60_020, transcript: acknowledged(at + 60_010) });
    expect(second.outcome.state).toBe("result-observed");
    reservations.add(third, readers);
    const question = ["\u2610 Dataset", "", "Which evaluation dataset should we use?", "", "\u276f 1. LM-O", "  2. YCB-V",
      "  3. Type something.", "\u2500".repeat(28), "  4. Chat about this", "", "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 Esc to cancel"];
    const later = [third.screen, edge("\u276f /review"), ...question.map((line) => edge(line))].join("\n");
    const prompt = parsePrompt("claude", later);
    expect(prompt).toMatchObject({ kind: "question" });
    expect(ownsCommandDialog(third, prompt!, later, registry.readerFor(prompt!.responder)!, readers)).toBe(true);
  });

  it("completes a named Claude model card through the real answer handler", async () => {
    const pane = { agent: "claude", status: "idle", screen: `❯ /model

────────────────────────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions.

  ❯ 1. Opus 5.5 ✔             For complex work and everyday tasks
    2. Sonnet 5.5             Most efficient for simpler tasks

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this session only · Esc to cancel
` };
    await withFakeHerdr(pane, async (paneId, keys) => {
      const current = { ...send("/model", "claude", [{ ...row("model", "dialog"), forms: claudeSource.forms!.model }]),
        at: Date.now() - 10, screen: "fixture-anchor", identity: JSON.stringify([undefined, undefined]), store: null };
      noteSubmitted(paneId, current.text, current);
      const shown = await served(paneId);
      expect(shown.outcomes?.at(-1)?.state).toBe("interaction-required");
      expect(shown.prompt?.kind).toBe("question");
      const url = new URL("http://localhost/api/pane/prompt/answer");
      const answered = await handlePromptRequest(new Request(url, { method: "POST",
        body: JSON.stringify({ pane_id: paneId, prompt_id: shown.prompt!.id, option_index: 0 }) }), url);
      expect(answered?.status).toBe(200);
      expect(keys.length).toBeGreaterThan(0);
      pane.screen = "fixture-anchor\n> ";
      expect((await served(paneId)).outcomes?.at(-1)).toMatchObject({ state: "result-observed", evidence: [{ kind: "dialog" }] });
    });
  });

  it("completes Claude's /effort while Ultracode is on, and through its switch (#2232)", async () => {
    // Claude Code 2.1.311's slider: with the switch on (no card before the switch was read), a level
    // picked with `s`; with it off, the switch's row, Tab, then `s` once the slider shows it on
    const cases = [
      { start: "on", option: 3, label: "Turn Ultracode off", keys: ["s"] },
      { start: "off", option: 5, label: "Turn Ultracode on", keys: [["tab"], "s"] },
    ];
    for (const { start, option, label, keys: expected } of cases) {
      let keys: unknown[] = [];
      const pane = { agent: "claude", status: "idle",
        get screen() {
          if (keys.includes("s")) return fixture("claude-effort-2.1.311-set-120.txt");
          return fixture(`claude-effort-2.1.311-${keys.some((sent) => Array.isArray(sent) && sent.includes("tab")) ? "on" : start}-120.txt`);
        } };
      await withFakeHerdr(pane, async (paneId, sent) => {
        keys = sent;
        const current = { ...send("/effort", "claude", [{ ...row("effort", "dialog"), forms: claudeSource.forms!.effort }]),
          at: Date.now() - 10, screen: "fixture-anchor", identity: JSON.stringify([undefined, undefined]), store: null };
        expect(current.form).toEqual({ match: "bare", interaction: "dialog", dialog: "claude-effort" });
        noteSubmitted(paneId, current.text, current);
        const shown = await served(paneId);
        expect(shown.outcomes?.at(-1)?.state, start).toBe("interaction-required");
        expect(shown.prompt?.options.at(-1)?.label, start).toBe(label);
        // the switch's drawn state stays with the server
        expect(shown.prompt, start).not.toHaveProperty("claudeUltracode");
        const url = new URL("http://localhost/api/pane/prompt/answer");
        const answered = await handlePromptRequest(new Request(url, { method: "POST",
          body: JSON.stringify({ pane_id: paneId, prompt_id: shown.prompt!.id, option_index: option }) }), url);
        expect(answered?.status, start).toBe(200);
        expect(keys, start).toEqual(expected);
        expect((await served(paneId)).outcomes?.at(-1), start).toMatchObject({ state: "result-observed", evidence: [{ kind: "dialog" }] });
      });
    }
  });

  it("closes a command's card correlation when a later plain message is sent", async () => {
    const pane = { agent: "claude", status: "idle", screen: fixture("claude-goal-2.1.304-active-120.txt") };
    await withFakeHerdr(pane, async (paneId) => {
      const goal: SlashCommand = { ...row("goal", "dialog"), forms: claudeSource.forms!.goal };
      const current = { ...send("/goal", "claude", [goal]), at: Date.now() - 10,
        identity: JSON.stringify([undefined, undefined]), store: null };
      noteSubmitted(paneId, current.text, current);
      expect((await served(paneId)).outcomes?.at(-1)?.state).toBe("interaction-required");
      noteSubmitted(paneId, "Please continue with the next task");
      const shown = await served(paneId);
      expect(shown.outcomes?.at(-1)).toMatchObject({ state: "unknown", evidence: [] });
      expect(current.dialogId).toBeUndefined();
    });
  });

  it("does not complete a skill after answering a Bash approval below its echo", async () => {
    const pane = { agent: "claude", status: "blocked",
      screen: "fixture-anchor\n> /review\n Bash command\n\n   pwd\n\n This command requires approval\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel" };
    await withFakeHerdr(pane, async (paneId) => {
      const current = { ...send("/review", "claude", [{ ...row("review"), source: "skill" }]),
        at: Date.now() - 10, screen: "fixture-anchor", identity: JSON.stringify([undefined, undefined]), store: null };
      noteSubmitted(paneId, current.text, current);
      const shown = await served(paneId);
      expect(shown.prompt?.kind).toBe("approval");
      if (!shown.prompt) throw new Error("fixture approval missing");
      const url = new URL("http://localhost/api/pane/prompt/answer");
      const answered = await handlePromptRequest(new Request(url, { method: "POST",
        body: JSON.stringify({ pane_id: paneId, prompt_id: shown.prompt.id, option_index: 0 }) }), url);
      expect(answered?.status).toBe(200);
      expect((await served(paneId)).outcomes?.at(-1)).toMatchObject({ state: "accepted", evidence: [] });
    });
  });

  it("keeps a bare Claude /goal interaction-required while its own goal card is up", async () => {
    const goal: SlashCommand = { name: "goal", source: "builtin", description: "", forms: claudeSource.forms!.goal };
    const sent = send("/goal", "claude", [goal]);
    expect(sent.form).toEqual({ match: "bare", interaction: "dialog", dialog: "claude-goal" });
    expect(registry.readerFor("claude-goal")?.id).toBe(sent.form!.dialog!);
    await withFakeHerdr({ agent: "claude", status: "idle", screen: fixture("claude-goal-2.1.304-active-120.txt") }, async (paneId) => {
      const current = { ...sent, at: Date.now() - 1, id: "goal-send", identity: JSON.stringify([undefined, undefined]), store: null };
      noteSubmitted(paneId, current.text, current);
      const shown = await served(paneId);
      expect(shown.prompt).toMatchObject({ agent: "claude", title: "Goal active", options: [{ label: "Close" }] });
      // the route hands over which words are the bridge's own, as keys the client translates (#1482)
      expect(shown.prompt?.own_text).toEqual({ title: { key: "Goal active" }, labels: { 0: { key: "Close" } } });
      expect(shown.outcomes?.at(-1)).toMatchObject({ id: "goal-send", state: "interaction-required" });
      expect(current.dialogId).toBe(shown.prompt!.id);
      // a form naming another reader's dialog is not waiting on this card
      const other = { ...current, id: "other-send", form: { match: "bare" as const, interaction: "dialog" as const, dialog: "claude-model" }, outcome: undefined, dialogId: undefined };
      noteSubmitted(paneId, other.text, other);
      expect((await served(paneId)).outcomes?.at(-1)).toMatchObject({ id: "other-send", state: "accepted" });
    });
  });

  const handoffRow: SlashCommand = { name: "handoff", source: "builtin", description: "", forms: ompSource.forms!.handoff };
  const compaction = (method: string, time: number): string => {
    const recorded = fixture("omp-handoff-18.8.7-session.jsonl").split("\n").find((line) => line.includes('"type":"compaction"'))!;
    return JSON.stringify({ ...JSON.parse(recorded), method, timestamp: new Date(time).toISOString() });
  };
  it("resolves omp's /handoff only from the handoff compaction appended after the send", () => {
    const sent = send("/handoff", "omp", [handoffRow]);
    expect(sent.form).toEqual({ match: "bare", interaction: "dialog", dialog: "omp-handoff" });
    expect(registry.readerFor("omp-handoff")?.id).toBe(sent.form!.dialog!);
    expect(outcome(sent, { transcript: compaction("handoff", at + 10) })).toMatchObject({ state: "result-observed", evidence: [{ kind: "transcript" }] });
    expect(outcome(send("/handoff focus on tests", "omp", [handoffRow]), { transcript: compaction("handoff", at + 10) }).state).toBe("result-observed");
    expect(outcome(sent, { transcript: compaction("handoff", at - 10) }).state).toBe("accepted");
    expect(outcome(sent, { transcript: compaction("auto", at + 10) }).state).toBe("accepted");
  });
  it("keeps omp's /handoff interaction-required on its card, and a cancel from it never resolves the send", async () => {
    const pane = { agent: "omp", status: "working", screen: fixture("omp-handoff-18.8.7-generating-narrow.txt"), pid: 4242, argv: ["omp"] };
    await withFakeHerdr(pane, async (paneId, keys) => {
      const current = { ...send("/handoff", "omp", [handoffRow]), at: Date.now() - 1, id: "handoff-send", identity: JSON.stringify([undefined, undefined]), store: null };
      noteSubmitted(paneId, current.text, current);
      const shown = await served(paneId);
      expect(shown.prompt).toMatchObject({ agent: "omp", question: "Generating handoff…", options: [{ label: "Cancel" }] });
      expect(shown.outcomes?.at(-1)).toMatchObject({ id: "handoff-send", state: "interaction-required" });
      expect(current.dialogId).toBe(shown.prompt!.id);
      const answerUrl = new URL("http://localhost/api/pane/prompt/answer");
      const answered = await handlePromptRequest(new Request(answerUrl, { method: "POST", body: JSON.stringify({ pane_id: paneId, prompt_id: shown.prompt!.id, option_index: 0 }) }), answerUrl);
      expect(answered?.status).toBe(200);
      expect(keys).toEqual([["esc"]]);
      pane.screen = fixture("omp-handoff-18.8.7-cancelled-narrow.txt");
      const after = await served(paneId);
      expect(after.prompt).toBeNull();
      expect(after.outcomes?.at(-1)).toMatchObject({ id: "handoff-send", state: "accepted", evidence: [] });
    });
  });
});

describe("registered result evidence", () => {
  const anchor = "fixture-tail-1\nfixture-tail-2\nfixture-tail-3";
  const sent = () => ({ ...send("/reload-skills", "hermes", [row("reload-skills", "unknown")]), screen: anchor });
  it("requires a new complete block below this send's new command echo", () => {
    const input = { screen: `${anchor}\n> /reload-skills\n${block}`, readers: [resultReader] };
    expect(outcome(sent(), input)).toMatchObject({ state: "result-observed", catalog_changed: true, evidence: [{ kind: "recognized-result" }] });
    expect(outcome({ ...sent(), screen: block }, input).state).toBe("accepted");
    expect(outcome(sent(), { ...input, screen: `${block}\n> /reload-skills` }).state).toBe("accepted");
    expect(outcome(sent(), { ...input, screen: block }).state).toBe("accepted");
    expect(outcome(sent(), { ...input, screen: `> /other\n${block}` }).state).toBe("accepted");
    expect(outcome(sent(), { ...input, screen: `> /reload-skills\n> /other\n${block}` }).state).toBe("accepted");
    expect(outcome(sent(), { ...input, readers: [{ ...resultReader, kind: undefined }] }).state).toBe("accepted");
  });
  it("does not reuse unchanged output and accepts a new anchored result", () => {
    const input = { screen: `${anchor}\n> /reload-skills\n${block}`, readers: [resultReader] };
    expect(outcome({ ...sent(), id: "send-2", screen: input.screen }, input).state).toBe("accepted");
    expect(outcome({ ...sent(), id: "send-3", screen: anchor }, input).state).toBe("result-observed");
  });
  it("upgrades an unrecognized-dialog terminal fallback when a correlated result arrives later", () => {
    const command = { ...send("/status", "hermes", [row("status", "dialog")]), screen: anchor };
    command.outcome = outcome(command, { now: at + 2000, settledSince: at });
    expect(command.outcome.state).toBe("terminal-required");
    expect(outcome(command, { now: at + 2100, screen: `${anchor}\n> /status\n${block}`, readers: [resultReader] }))
      .toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
  });
  it("upgrades a dialog fallback only for a correlated card commit", () => {
    const command = send("/model", "claude", [row("model", "dialog")]);
    command.outcome = outcome(command, { now: at + 2000, settledSince: at });
    expect(outcome(command, { now: at + 2100, evidence: { kind: "dialog", at: at - 1 } }))
      .toMatchObject({ state: "terminal-required", evidence: [] });
    expect(outcome(command, { now: at + 2100, evidence: { kind: "dialog", at: at + 2100 } }))
      .toMatchObject({ state: "result-observed", evidence: [{ kind: "dialog" }] });
  });
  it("keeps terminal-form commands terminal even when later result or card evidence arrives", () => {
    const command = { ...send("/status", "hermes", [row("status", "terminal")]), screen: anchor };
    command.outcome = outcome(command);
    expect(outcome(command, { now: at + 2100, screen: `${anchor}\n> /status\n${block}`, readers: [resultReader] }))
      .toMatchObject({ state: "terminal-required", evidence: [] });
    expect(outcome(command, { now: at + 2100, evidence: { kind: "dialog", at: at + 2100 } }))
      .toMatchObject({ state: "terminal-required", evidence: [] });
  });
  it("observes a recognized dialog result before its screen settles", () => {
    const command = { ...send("/status", "hermes", [row("status", "dialog")]), screen: anchor };
    expect(outcome(command, { now: at + 1000, settledSince: at, screen: `${anchor}\n> /status\n${block}`, readers: [resultReader] }))
      .toMatchObject({ state: "result-observed", evidence: [{ kind: "recognized-result" }] });
  });
});

describe("anchored result echo ownership", () => {
  const anchor = "fixture-tail-1\nfixture-tail-2\nfixture-tail-3";
  const echo = "> /status";
  const result = `${echo}\n${block}`;
  const sent = (screen = anchor): CommandSend => ({ ...send("/status", "hermes", [row("status", "unknown")]), screen });
  const readers = [resultReader];
  let pane = 0;
  const queued = (screens: string[], registeredReaders = readers, commands?: readonly string[]): CommandSend[] => {
    const paneId = `result-order-${++pane}`;
    const registered = spyOn(registry, "readersFor").mockReturnValue(registeredReaders);
    try {
      return screens.map((screen, index) => {
        const text = commands?.[index] ?? "/status";
        const command = { ...send(text, "hermes", [row(text.slice(1), "unknown")]), screen,
          id: `${paneId}-${index}`, at: at + index, store: null };
        noteSubmitted(paneId, command.text, command);
        return command;
      });
    } finally { registered.mockRestore(); }
  };

  it("does not resolve a redraw duplicating an old echo and block before the snapshot tail", () => {
    const before = `${result}\n${anchor}`;
    expect(outcome(sent(before), { screen: `${result}\n${result}\n${anchor}`, readers }).state).toBe("accepted");
  });

  it("does not resolve an old block scrolled into view above the snapshot tail", () => {
    expect(outcome(sent(), { screen: `${result}\n${anchor}`, readers }).state).toBe("accepted");
  });

  it("does not give a terminal-typed same-command result to the earlier Chat echo", () => {
    expect(outcome(sent(), { screen: `${anchor}\n${echo}\n${result}`, readers }).state).toBe("accepted");
  });

  it("does not claim an unreserved terminal result printed before the Chat echo", () => {
    expect(outcome(sent(), { screen: `${anchor}\n${result}\n${echo}`, readers }).state).toBe("accepted");
    expect(outcome(sent(), { screen: `${anchor}\n${result}\n${result}`, readers }).state).toBe("accepted");
  });

  it("keeps a previously resolved result when an extra terminal echo appears later", () => {
    const command = sent();
    command.outcome = outcome(command, { screen: `${anchor}\n${result}`, readers });
    expect(command.outcome.state).toBe("result-observed");
    expect(outcome(command, { screen: `${anchor}\n${result}\n${result}`, readers }).state).toBe("result-observed");
  });

  it("resolves only the first of two quick sends when only its echo and result arrived", () => {
    const [first, second] = queued([anchor, anchor]);
    if (!first || !second) throw new Error("missing fixture sends");
    const observation = { screen: `${anchor}\n${result}`, readers };
    expect(outcome(first, { ...observation, nextAt: second.at }).state).toBe("result-observed");
    expect(outcome(second, observation).state).toBe("accepted");
  });

  it("resolves two quick sends from their own echoes even when their outputs are identical", () => {
    const [first, second] = queued([anchor, anchor]);
    if (!first || !second) throw new Error("missing fixture sends");
    const observation = { screen: `${anchor}\n${result}\n${result}`, readers };
    expect(outcome(first, { ...observation, nextAt: second.at }).state).toBe("result-observed");
    expect(outcome(second, observation).state).toBe("result-observed");
  });

  it("resolves a second identical output below its echo while the first block stays visible", () => {
    const before = `${anchor}\n${result}`;
    const [first, second] = queued([anchor, before]);
    if (!first || !second) throw new Error("missing fixture sends");
    expect(outcome(second, { screen: `${before}\n${result}`, readers }).state).toBe("result-observed");
    expect(outcome(second, { screen: before, readers }).state).toBe("accepted");
  });

  it("does not recognize any result when the send-time anchor is lost or empty", () => {
    expect(outcome(sent(), { screen: result, readers }).state).toBe("accepted");
    expect(outcome(sent(""), { screen: result, readers }).state).toBe("accepted");
    expect(outcome(sent(), { screen: `${anchor}\n${result}\n${anchor}\n${result}`, readers }).state).toBe("accepted");
  });

  it("keeps echo reservations when older outcomes leave the five-send response window", () => {
    const sends = queued(Array.from({ length: 6 }, () => anchor));
    const last = sends.at(-1);
    if (!last) throw new Error("missing fixture send");
    expect(outcome(last, { screen: `${anchor}\n${result}`, readers }).state).toBe("accepted");
    expect(outcome(last, { screen: `${anchor}\n${Array.from({ length: 6 }, () => result).join("\n")}`, readers }).state).toBe("result-observed");
  });

  it("keeps an unresolved command reservation after five other commands evict its displayed outcome", () => {
    const commands = ["/status", "/help", "/version", "/profile", "/cost", "/context", "/status"];
    const sends = queued(commands.map(() => anchor), readers, commands);
    const last = sends.at(-1);
    if (!last) throw new Error("missing fixture send");
    expect(last.resultEchoes?.[resultReader.id]).toBe(2);
    expect(outcome(last, { screen: `${anchor}\n${result}`, readers }).state).toBe("accepted");
    expect(outcome(last, { screen: `${anchor}\n${result}\n${result}`, readers }).state).toBe("result-observed");
  });

  it("marks correlation ambiguous instead of renumbering when the reservation cap drops an unresolved command", () => {
    const commands = ["/status", ...Array.from({ length: 64 }, (_, index) => `/other-${index}`), "/status"];
    const last = queued(commands.map(() => anchor), readers, commands).at(-1);
    if (!last) throw new Error("missing fixture send");
    expect(outcome(last, { screen: `${anchor}\n${result}`, readers }).state).toBe("accepted");
    expect(outcome(last, { screen: `${anchor}\n${result}\n${result}`, readers }).state).toBe("accepted");
  });

  it("does not treat terminal excess echoes as additional Chat reservations for either pending send", () => {
    const [first, second] = queued([anchor, anchor]);
    if (!first || !second) throw new Error("missing fixture sends");
    const screen = `${anchor}\n${result}\n${result}\n${echo}`;
    expect(outcome(first, { screen, readers, nextAt: second.at }).state).toBe("unknown");
    expect(outcome(second, { screen, readers }).state).toBe("accepted");
  });

  it("expires capped ownership without a timer and keeps the loss-marker overflow fail-closed", () => {
    const reservations = new CommandReservations();
    for (let index = 0; index < 130; index++) {
      const command = { ...sent(), text: `/unresolved-${index}`, id: `capped-${index}`, at: at + index };
      reservations.add(command, readers);
    }
    const blocked = { ...sent(), id: "blocked-by-overflow", at: at + 131 };
    reservations.add(blocked, readers);
    expect(outcome(blocked, { screen: `${anchor}\n${result}`, readers }).state).toBe("accepted");
    const fresh = { ...sent(), id: "after-deadline", at: at + 700_000 };
    reservations.add(fresh, readers);
    expect(fresh.resultEchoes?.[resultReader.id]).toBe(1);
    expect(outcome(fresh, { now: fresh.at + 100, screen: `${anchor}\n${result}`, readers }).state).toBe("result-observed");
  });

  it("does not reuse a resolved later send's echo position while an earlier reservation remains", () => {
    const reservations = new CommandReservations();
    const first = { ...sent(), id: "pending-first" };
    const second = { ...sent(), id: "resolved-second", at: at + 1 };
    reservations.add(first, readers);
    reservations.add(second, readers);
    second.outcome = outcome(second, { screen: `${anchor}\n${echo}\n${result}`, readers });
    expect(second.outcome.state).toBe("result-observed");
    const third = { ...sent(), id: "pending-third", at: at + 2 };
    reservations.add(third, readers);
    expect(third.resultEchoes?.[resultReader.id]).toBe(3);
    expect(outcome(third, { screen: `${anchor}\n${echo}\n${result}`, readers }).state).toBe("accepted");
  });

  it("carries pending echo order across a changing tail before either command echo arrives", () => {
    const later = `${anchor}\nfixture-progress-1\nfixture-progress-2\nfixture-progress-3`;
    const [first, second] = queued([anchor, later]);
    if (!first || !second) throw new Error("missing fixture sends");
    const observation = { screen: `${later}\n${result}`, readers };
    expect(outcome(first, { ...observation, nextAt: second.at }).state).toBe("result-observed");
    expect(outcome(second, observation).state).toBe("accepted");
  });

  it("uses a reader's echo shape for ownership and every following command boundary", () => {
    const native = { ...resultReader, echoOf: (line: string, command: string) => line.trim() === `⚙️  ${command}` };
    const readers = [native];
    const [first, second] = queued([anchor, anchor], readers);
    if (!first || !second) throw new Error("missing fixture sends");
    const completed = `⚙️  /status\n${block}`;
    expect(outcome(first, { screen: `${anchor}\n${completed}`, readers, nextAt: second.at }).state).toBe("result-observed");
    expect(outcome(second, { screen: `${anchor}\n${completed}`, readers }).state).toBe("accepted");
    expect(outcome(second, { screen: `${anchor}\n${completed}\n${completed}`, readers }).state).toBe("result-observed");
    expect(outcome(sent(), { screen: `${anchor}\n⚙️  /status\n⚙️  /other\n${block}`, readers }).state).toBe("accepted");
    expect(outcome(sent(), { screen: `${anchor}\n⚙️  /status\n${completed}`, readers }).state).toBe("accepted");
    expect(outcome(sent(), { screen: `${anchor}\n${completed}`, readers: [resultReader] }).state).toBe("accepted");
  });

  const chrome = "fixture-status: idle\n────────\n❯ fixture-input\n────────";
  const chromeReader = {
    ...resultReader,
    chromeStart: (lines: string[]) => lines.findIndex((line) => line.startsWith("fixture-status:")),
    parse(screen: string) {
      // The uncut idle input is required evidence that this fixture result finished.
      return screen.includes("\n❯ fixture-input\n") ? resultReader.parse(screen, {
        agent: "hermes", omoAsk: null, omoTrusted: false, omoOpen: [], sent: "/status", working: false,
      }) : null;
    },
  };

  it("anchors above unchanged bottom chrome while retaining the idle prompt for the reader", () => {
    const snapshot = `${anchor}\n${chrome}`;
    const screen = `${anchor}\n${result}\n${chrome}`;
    expect(outcome(sent(snapshot), { screen, readers: [chromeReader] })).toMatchObject({
      state: "result-observed", evidence: [{ kind: "recognized-result" }], catalog_changed: true,
    });
    // Without the reader hook, the unchanged chrome remains the anchor at the screen's end.
    expect(outcome(sent(snapshot), { screen, readers })).toMatchObject({ state: "accepted", evidence: [] });
    expect(outcome(sent(snapshot), { screen, readers: [{ ...chromeReader, agents: ["claude"] }, resultReader] }).state).toBe("accepted");
    // Chrome is per agent, so one registered result reader can provide the shared boundary.
    expect(outcome(sent(snapshot), { screen, readers: [
      { ...chromeReader, id: "fixture-chrome", parse: () => null }, resultReader,
    ] }).state).toBe("result-observed");
  });

  it("does not resolve when only chrome changes, even if that chrome contains an echo and result", () => {
    const snapshot = `${anchor}\n${chrome}`;
    const changed = `${anchor}\nfixture-status: changed\n${result}\n────────\n❯ fixture-input\n────────`;
    expect(outcome(sent(snapshot), { screen: changed, readers: [chromeReader] })).toMatchObject({ state: "accepted", evidence: [] });
    expect(outcome(sent(snapshot), { screen: `${anchor}\n${chrome.replace("idle", "busy")}`, readers: [chromeReader] }).state).toBe("accepted");
  });

  it("reserves ordered echoes above chrome for two quick sends with identical input areas", () => {
    const snapshot = `${anchor}\n${chrome}`;
    const [first, second] = queued([snapshot, snapshot], [chromeReader]);
    if (!first || !second) throw new Error("missing fixture sends");
    const one = `${anchor}\n${result}\n${chrome}`;
    expect(outcome(first, { screen: one, readers: [chromeReader], nextAt: second.at }).state).toBe("result-observed");
    expect(outcome(second, { screen: one, readers: [chromeReader] }).state).toBe("accepted");
    const both = `${anchor}\n${result}\n${result}\n${chrome}`;
    expect(outcome(second, { screen: both, readers: [chromeReader] }).state).toBe("result-observed");
  });

  it("does not count command-shaped input chrome as an already emitted echo when reserving", () => {
    const commandChrome = chrome.replace("❯ fixture-input", "❯ /status");
    const native = { ...chromeReader, echoOf: (line: string, command: string) => line.trim() === `⚙️  ${command}` };
    const [first, second] = queued([`${anchor}\n${commandChrome}`, `${anchor}\n${commandChrome}`], [native]);
    if (!first || !second) throw new Error("missing fixture sends");
    expect(second.resultEchoes?.[chromeReader.id]).toBe(2);
  });

  it("keeps the whole screen when a chrome hook finds no persistent input area", () => {
    const absent = { ...resultReader, chromeStart: chromeReader.chromeStart };
    expect(outcome(sent(), { screen: `${anchor}\n${result}`, readers: [absent] }).state).toBe("result-observed");
  });

  for (const [label, chromeStart] of [
    ["past the end", (lines: string[]) => lines.length + 10],
    ["below minus one", (_lines: string[]) => -5],
    ["fractional", (_lines: string[]) => -0.5],
    ["not a number", (_lines: string[]) => NaN],
  ] as const) it(`rejects a chrome boundary ${label} instead of treating it as no chrome`, () => {
    const reader = { ...resultReader, chromeStart };
    const command = sent(anchor);
    expect(outcome(command, { screen: `${anchor}\n${result}`, readers: [reader] })).toMatchObject({ state: "accepted", evidence: [] });
    new CommandReservations().add(command, [reader]);
    expect(command.resultEchoes?.[reader.id]).toBeNull();
  });

  it("rejects a too-low send-time boundary hiding an old command echo and complete block", () => {
    const reader = {
      ...resultReader,
      chromeStart: (lines: string[]) => lines.at(-1) === "CHROME 00:00" ? 2 : lines.findIndex((line) => line.startsWith("CHROME")),
    };
    const command = sent(`${anchor}\n${result}\nCHROME 00:00`);
    const screen = `${anchor}\n${result}\nCHROME 00:01`;
    expect(outcome(command, { screen, readers: [reader] })).toMatchObject({ state: "accepted", evidence: [] });
  });

  it("rejects read-time chrome containing any command echo recognized by an applicable reader", () => {
    const boundary = { ...resultReader, chromeStart: (lines: string[]) => lines.findIndex((line) => line.startsWith("CHROME")) };
    const gear = { ...resultReader, id: "gear-echo", echoOf: (line: string, command: string) => line === `⚙️  ${command}`, parse: () => null };
    const snapshot = `${anchor}\nCHROME 00:00`;
    const screen = `${anchor}\n${result}\nCHROME 00:01\n⚙️  /other\n${block}`;
    expect(outcome(sent(snapshot), { screen, readers: [boundary, gear] }).state).toBe("accepted");
    expect(outcome(sent(snapshot), { screen, readers: [boundary, { ...gear, agents: ["claude"] }] }).state).toBe("result-observed");
    expect(outcome(sent(snapshot), { screen: `${anchor}\n${result}\nCHROME 00:01\n> /other`, readers: [boundary] }).state).toBe("accepted");
  });

  it("passes the next echo line as a completion boundary without the following send's block", () => {
    const firstBlock = block.replace("fixture-payload", "fixture-first");
    const secondBlock = block.replace("fixture-payload", "fixture-second");
    const idle = "❯ fixture-idle";
    const parsedScreens: string[] = [];
    const reader: DialogReader = {
      ...resultReader,
      parse(screen, ctx) {
        parsedScreens.push(screen);
        const lines = screen.split("\n");
        if (lines.at(-1) !== echo && lines.at(-1) !== idle) return null;
        const ownBlock = lines.slice(0, -1).join("\n");
        if (ownBlock !== firstBlock && ownBlock !== secondBlock) return null;
        const parsed = resultReader.parse(block, ctx);
        return parsed ? { ...parsed, body: ownBlock, resultText: ownBlock } : null;
      },
    };
    const [first, second] = queued([anchor, anchor], [reader]);
    if (!first || !second) throw new Error("missing fixture sends");
    const screen = `${anchor}\n${echo}\n${firstBlock}\n${echo}\n${secondBlock}\n${idle}`;
    expect(outcome(first, { screen, readers: [reader], nextAt: second.at }).state).toBe("result-observed");
    expect(outcome(second, { screen, readers: [reader] }).state).toBe("result-observed");
    expect(parsedScreens).toEqual([`${firstBlock}\n${echo}`, `${secondBlock}\n${idle}`]);
  });
});
