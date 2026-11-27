import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandScansSettled, paneCommands, scanPaneCommands, setCommandsWait } from "./commands.ts";
import { FileBusyError, filePoolSize, setFilePoolOptions } from "./file-pool.ts";
import { HerdrError } from "./herdr/client.ts";
import * as herdr from "./herdr/client.ts";
import { HERMES_ECHO_RE } from "./dialogs/hermes.ts";
import { registry } from "./dialogs/registry.ts";
import { findLastIndex } from "./dialogs/shared.ts";
import * as directories from "./directories.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { paneAgentOf, resolveAgent } from "./pane-context.ts";
import { openCodeServiceOptions } from "./opencode-service.ts";
import * as conversation from "./conversation.ts";
import { requestIdContext } from "./http.ts";
import { PANE_SUMMARY_DEADLINE_MS, PANE_SUMMARY_KEEP_MS, PANE_SUMMARY_MAX_IDS, PANE_SUMMARY_PANE_MS, type PaneSummaries } from "../shared/pane-summary.ts";
import type { ConversationResponse, ConversationTurn, PaneContext } from "../shared/protocol.ts";

let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let panes: Record<string, { agent?: string; session?: string; cwd?: string; process: { pid: number; argv: string[]; cwd: string }[] }>;
let integrations: { target: string; label: string; command: string; available: boolean; state: string }[] = [];

const paneInfo = (id: string) => ({
  pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: panes[id]?.cwd ?? root, focused: false, revision: 0,
  ...(panes[id]?.agent ? { agent: panes[id]!.agent } : {}),
  ...(panes[id]?.session ? { agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: panes[id]!.session } } : {}),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-pane-routes-"));
  panes = {};
  integrations = [];
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: { pane_id?: string } };
        const id = request.params?.pane_id ?? "";
        const result = request.method === "pane.get" ? { pane: paneInfo(id) }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: panes[id]?.process ?? [] } }
          : request.method === "session.snapshot" ? { snapshot: { panes: Object.keys(panes).map(paneInfo), agents: [] } }
          : request.method === "agent.get" ? { agent: {} }
          : request.method === "integration.list" ? { integrations }
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const OMO_PROCESS = { pid: 2147483647, argv: ["omo"], cwd: "" };

it("diagnoses fallback and recovery without changing the conversation or 304 response", async () => {
  const id = crypto.randomUUID();
  const pane = `private-pane-${crypto.randomUUID()}`;
  const url = new URL(`http://x/api/pane/conversation?pane_id=${pane}`);
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line: unknown) => { lines.push(String(line)); });
  const read = spyOn(conversation, "paneConversation").mockRejectedValueOnce(
    new conversation.ConversationUnavailable("no_session_path", undefined, "copilot_process_lookup_failed"),
  ).mockResolvedValue({
    source: "copilot-transcript", turns: [], metadata: { model: null, reasoning_effort: null },
    cursor: null, history_id: "private-history", version: "fixture",
  });
  const ask = (headers?: HeadersInit) => requestIdContext.run({ id, route: "unmatched" }, () =>
    handlePaneRequest(new Request(url, { headers }), url, "/api/pane/conversation", {}));
  try {
    const fallback = (await ask())!;
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toEqual({ source: "scrollback", turns: [] });
    const recovered = (await ask({ "if-none-match": 'W/"fixture"' }))!;
    expect(recovered.status).toBe(304);
    expect(recovered.headers.get("etag")).toBe('W/"fixture"');
    const records = lines.map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({ event: "conversation.failed", operation: "conversation.copilot_process_lookup_failed", request_id: id });
    expect(records[1]).toMatchObject({ event: "conversation.recovered", episode_id: records[0].episode_id, request_id: id });
    expect(lines.join("\n")).not.toContain(pane);
    expect(lines.join("\n")).not.toContain("private-history");
  } finally { read.mockRestore(); warn.mockRestore(); }
});

it("answers a conversation with the PC's clock, which its turns' times are on", async () => {
  const url = new URL(`http://x/api/pane/conversation?pane_id=${crypto.randomUUID()}`);
  const read = spyOn(conversation, "paneConversation").mockResolvedValue({
    source: "claude-transcript", turns: [], metadata: { model: null, reasoning_effort: null }, cursor: null, history_id: "h", version: "clock-fixture",
  });
  const ask = (headers?: HeadersInit) => handlePaneRequest(new Request(url, { headers }), url, "/api/pane/conversation", {});
  try {
    const before = Date.now();
    const answered = (await ask())!;
    const body = await answered.json() as { server_time?: string };
    expect(Date.parse(body.server_time ?? "")).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.server_time ?? "")).toBeLessThanOrEqual(Date.now());
    expect(answered.headers.get("x-server-time")).toBe(body.server_time!);
    const after = Date.now();
    const unchanged = (await ask({ "if-none-match": 'W/"clock-fixture"' }))!;
    expect(unchanged.status).toBe(304);
    expect(Date.parse(unchanged.headers.get("x-server-time") ?? "")).toBeGreaterThanOrEqual(after);
    expect(Date.parse(unchanged.headers.get("x-server-time") ?? "")).toBeLessThanOrEqual(Date.now());
  } finally { read.mockRestore(); }
});

it.each(["omp", "omo", "pi"] as const)("uses %s's live context without rereading its screen, and keeps the fallback", async (kind) => {
  const pane = crypto.randomUUID();
  const url = new URL(`http://x/api/pane/conversation?pane_id=${pane}`);
  const fileContext = { used: 32_002, window: null };
  const read = spyOn(conversation, "paneConversation").mockResolvedValue({
    source: `${kind}-transcript`, turns: [], metadata: { model: null, reasoning_effort: null, context: fileContext },
    cursor: null, history_id: "stable", version: "stable",
  });
  const scroll = spyOn(herdr, "paneScrollInfo").mockResolvedValue({ offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 });
  const screen = spyOn(herdr, "paneRead").mockResolvedValue({
    pane_id: pane, tab_id: "t", workspace_id: "w", format: "text", source: "visible", text: "◫ 48.1%/1M", revision: 1, truncated: false,
  });
  let sample: PaneContext | null | undefined = { used: 42_013, window: 200_000 };
  const approvals = { contextOf: (id: string, agent: string | null | undefined) => id === pane && agent === kind ? sample : undefined };
  const ask = async (etag?: string) => {
    const response = await handlePaneRequest(new Request(url, { headers: etag ? { "if-none-match": etag } : {} }), url, url.pathname, { approvals });
    if (response === null) throw new Error("conversation route not handled");
    return response;
  };
  const context = async (response: Response) => ((await response.json()) as ConversationResponse).metadata?.context;
  try {
    const first = await ask();
    expect(await context(first)).toEqual({ used: 42_013, window: 200_000 });
    const etag = first.headers.get("etag") ?? undefined;
    expect((await ask(etag)).status).toBe(304);

    sample = null;
    const unknown = await ask(etag);
    expect(unknown.status).toBe(200);
    expect(await context(unknown)).toEqual(fileContext);
    expect(scroll).not.toHaveBeenCalled();

    sample = undefined;
    expect(await context(await ask())).toEqual(kind === "omp" ? { used: 481_000, window: 1_000_000 } : fileContext);
  } finally { read.mockRestore(); scroll.mockRestore(); screen.mockRestore(); }
});

it("prefers the first omp report when it arrives during a screen read", async () => {
  const pane = crypto.randomUUID();
  const url = new URL(`http://x/api/pane/conversation?pane_id=${pane}`);
  const read = spyOn(conversation, "paneConversation").mockResolvedValue({
    source: "omp-transcript", turns: [], metadata: { model: null, reasoning_effort: null },
    cursor: null, history_id: "stable", version: "stable",
  });
  const scroll = spyOn(herdr, "paneScrollInfo").mockResolvedValue({ offset_from_bottom: 0, max_offset_from_bottom: 100, viewport_rows: 24 });
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const screen = spyOn(herdr, "paneRead").mockImplementation(async () => {
    reading.resolve();
    await release.promise;
    return { pane_id: pane, tab_id: "t", workspace_id: "w", format: "text", source: "visible", text: "◫ 48.1%/1M", revision: 1, truncated: false };
  });
  let sample: PaneContext | undefined;
  try {
    const pending = handlePaneRequest(new Request(url), url, url.pathname, { approvals: { contextOf: () => sample } });
    await reading.promise;
    sample = { used: 42_013, window: 200_000 };
    release.resolve();
    const response = await pending;
    if (response === null) throw new Error("conversation route not handled");
    const body: ConversationResponse = await response.json();
    expect(body.metadata?.context).toEqual({ used: 42_013, window: 200_000 });
  } finally { release.resolve(); read.mockRestore(); scroll.mockRestore(); screen.mockRestore(); }
});

it("asks a chat showing a history to wait only when Copilot's rejection may be waited out", async () => {
  const pane = crypto.randomUUID();
  const ask = async (diagnostic: NonNullable<conversation.ConversationUnavailable["diagnostic"]>, history: boolean) => {
    const url = new URL(`http://x/api/pane/conversation?pane_id=${pane}${history ? "&history_id=shown" : ""}`);
    const read = spyOn(conversation, "paneConversation").mockRejectedValue(new conversation.ConversationUnavailable("no_session_path", undefined, diagnostic));
    try { return await (await handlePaneRequest(new Request(url), url, "/api/pane/conversation", {}))!.json(); }
    finally { read.mockRestore(); }
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await ask("copilot_log_truncated", true)).toEqual({ source: "scrollback", turns: [], recovery: "waiting" });
    expect(await ask("copilot_log_truncated", false)).toEqual({ source: "scrollback", turns: [] });
    expect(await ask("copilot_session_unregistered", true)).toEqual({ source: "scrollback", turns: [] });
    expect(await ask("copilot_api_rpc_timeout", true)).toEqual({ source: "scrollback", turns: [], recovery: "waiting" });
    expect(await ask("copilot_api_unsupported_protocol", true)).toEqual({ source: "scrollback", turns: [] });
    expect(await ask("copilot_api_no_foreground", true)).toEqual({ source: "scrollback", turns: [] });
    expect(await ask("copilot_api_foreground_changed", true)).toEqual({ source: "scrollback", turns: [] });
  } finally { warn.mockRestore(); }
});

it("passes on what the user could change for a Copilot pane to be read, beside a wait", async () => {
  const pane = crypto.randomUUID();
  const url = new URL(`http://x/api/pane/conversation?pane_id=${pane}&history_id=shown`);
  const read = spyOn(conversation, "paneConversation").mockRejectedValue(
    new conversation.ConversationUnavailable("no_session_path", undefined, "copilot_log_truncated", "copilot_ui_server"));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await (await handlePaneRequest(new Request(url), url, "/api/pane/conversation", {}))!.json())
      .toEqual({ source: "scrollback", turns: [], recovery: "waiting", hint: "copilot_ui_server" });
  } finally { read.mockRestore(); warn.mockRestore(); }
});

it("says why a conversation could not be read, in the few words the chat can explain", async () => {
  const pane = crypto.randomUUID();
  const ask = async (error: conversation.ConversationUnavailable) => {
    const url = new URL(`http://x/api/pane/conversation?pane_id=${pane}`);
    const read = spyOn(conversation, "paneConversation").mockRejectedValue(error);
    try { return await (await handlePaneRequest(new Request(url), url, "/api/pane/conversation", {}))!.json(); }
    finally { read.mockRestore(); }
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const { ConversationUnavailable: Unavailable } = conversation;
    expect(await ask(new Unavailable("no_session_id"))).toEqual({ source: "scrollback", turns: [], unavailable: "not_found" });
    expect(await ask(new Unavailable("no_session_path"))).toEqual({ source: "scrollback", turns: [], unavailable: "not_found" });
    expect(await ask(new Unavailable("transcript_missing"))).toEqual({ source: "scrollback", turns: [], unavailable: "unreadable" });
    expect(await ask(new Unavailable("transcript_unreadable"))).toEqual({ source: "scrollback", turns: [], unavailable: "unreadable" });
    expect(await ask(new Unavailable("branch_unreadable"))).toEqual({ source: "scrollback", turns: [], unavailable: "unreadable" });
    expect(await ask(new Unavailable("no_recognized_transcript", undefined, "agent_cwd_missing"))).toEqual({ source: "scrollback", turns: [], unavailable: "no_folder" });
    expect(await ask(new Unavailable("no_recognized_transcript"))).toEqual({ source: "scrollback", turns: [] });
    panes[pane] = { agent: "droid", process: [] };
    expect(await ask(new Unavailable("no_recognized_transcript"))).toEqual({ source: "scrollback", turns: [], unavailable: "no_reader" });
    panes[pane] = { agent: "devin", process: [] };
    expect(await ask(new Unavailable("no_recognized_transcript"))).toEqual({ source: "scrollback", turns: [] });
    panes[pane] = { agent: "copilot", process: [] };
    expect(await ask(new Unavailable("transcript_missing"))).toEqual({ source: "scrollback", turns: [] });
    expect(await ask(new Unavailable("no_session_id"))).toEqual({ source: "scrollback", turns: [] });
    delete panes[pane];
    expect(await ask(new Unavailable("no_session_path", undefined, "copilot_log_truncated"))).toEqual({ source: "scrollback", turns: [] });
    expect(await ask(new Unavailable("pane_not_found"))).toEqual({ source: "scrollback", turns: [] });
    expect(await ask(new Unavailable("dsh_transcript_unavailable"))).toEqual({ source: "scrollback", turns: [] });
  } finally { warn.mockRestore(); }
});

it("names herdr's missing integration as the reason an OpenCode or Grok pane has no conversation", async () => {
  const ask = async (paneId: string) => {
    const url = new URL(`http://x/api/pane/conversation?pane_id=${paneId}`);
    const read = spyOn(conversation, "paneConversation").mockRejectedValue(new conversation.ConversationUnavailable("no_session_id"));
    try { return await (await handlePaneRequest(new Request(url), url, "/api/pane/conversation", {}))!.json(); }
    finally { read.mockRestore(); }
  };
  const integration = (target: string, state: string) => ({ target, label: target, command: target, available: true, state });
  panes = { opencode: { agent: "opencode", process: [] }, grok: { agent: "grok", process: [] }, claude: { agent: "claude", process: [] } };
  integrations = [integration("opencode", "not_installed"), integration("grok", "current"), integration("claude", "not_installed")];
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await ask("opencode")).toEqual({ source: "scrollback", turns: [], unavailable: "no_integration" });
    expect(await ask("grok")).toEqual({ source: "scrollback", turns: [], unavailable: "not_found" });
    expect(await ask("claude")).toEqual({ source: "scrollback", turns: [], unavailable: "not_found" });
  } finally { warn.mockRestore(); }
});

it("diagnoses pending reads while preserving the retry response", async () => {
  const url = new URL(`http://x/api/pane/conversation?pane_id=${crypto.randomUUID()}`);
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line: unknown) => { lines.push(String(line)); });
  const read = spyOn(conversation, "paneConversation").mockRejectedValue(new conversation.ConversationReadPending());
  try {
    const response = (await handlePaneRequest(new Request(url), url, "/api/pane/conversation", {}))!;
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: {
      code: "conversation_read_pending", message: new conversation.ConversationReadPending().message,
    } });
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "conversation.failed", operation: "conversation.read_pending" });
  } finally { read.mockRestore(); warn.mockRestore(); }
});

it("does not report a plain shell's scrollback view as a conversation failure", async () => {
  panes["w:shell"] = { process: [{ pid: 2147483645, argv: ["/bin/bash"], cwd: root }] };
  const url = new URL("http://x/api/pane/conversation?pane_id=w:shell");
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    for (let i = 0; i < 3; i++) {
      const response = (await handlePaneRequest(new Request(url), url, "/api/pane/conversation", {}))!;
      expect(await response.json()).toMatchObject({ source: "scrollback", turns: [] });
    }
    expect(lines.filter((line) => line.includes("conversation."))).toEqual([]);
  } finally { warn.mockRestore(); }
});

it("still reports an agent pane herdr gives no folder, and does not count it as a recovery", async () => {
  panes["w:nocwd"] = { agent: "copilot", cwd: "", process: [] };
  const url = new URL("http://x/api/pane/conversation?pane_id=w:nocwd");
  const lines: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((line: unknown) => { lines.push(String(line)); });
  try {
    const response = (await handlePaneRequest(new Request(url), url, "/api/pane/conversation", {}))!;
    expect(await response.json()).toMatchObject({ source: "scrollback", turns: [] });
    const records = lines.filter((line) => line.includes("conversation.")).map((line) => JSON.parse(line));
    expect(records).toEqual([expect.objectContaining({ event: "conversation.failed", operation: "conversation.agent_cwd_missing" })]);
  } finally { warn.mockRestore(); }
});

it("names an omo pane that herdr labels pi omo in the commands route, and types into it as omo only once omo holds a session", async () => {
  panes["w:p1"] = { agent: "pi", process: [{ ...OMO_PROCESS, cwd: root }] };
  panes["w:p2"] = { agent: "pi", process: [{ pid: 2147483646, argv: ["/usr/bin/pi"], cwd: root }] };
  expect(await paneAgentOf("w:p1")).toBe("pi");
  expect(await paneAgentOf("w:p2")).toBe("pi");

  const quit = async (paneId: string) => {
    const url = new URL(`http://x/api/pane/commands?pane_id=${paneId}`);
    const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});
    return ((await response!.json()) as { commands: { name: string; description: string }[] }).commands.find((command) => command.name === "quit")?.description;
  };
  const omoQuit = paneCommands("omo", root).find((command) => command.name === "quit")?.description;
  const piQuit = paneCommands("pi", root).find((command) => command.name === "quit")?.description;
  expect(omoQuit).not.toBe(piQuit);
  expect(await quit("w:p1")).toBe(omoQuit);
  expect(await quit("w:p2")).toBe(piQuit);
});

async function hermesPane(paneId: string, run: (f: { skill(name: string): void; names(): Promise<string[]> }) => Promise<void>): Promise<void> {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = root;
  panes[paneId] = { agent: "hermes", process: [{ pid: 2147483645, argv: ["hermes"], cwd: root }] };
  try {
    await run({
      skill(name) {
        mkdirSync(join(root, ".hermes", "skills", name), { recursive: true });
        writeFileSync(join(root, ".hermes", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Added on disk.\n---\nBody.\n`);
      },
      async names() {
        const url = new URL(`http://x/api/pane/commands?pane_id=${paneId}`);
        const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});
        return ((await response!.json()) as { commands: { name: string }[] }).commands.map((command) => command.name);
      },
    });
  } finally {
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
}

it("lists a Hermes skill added on disk before a successful reload on the next commands request", async () => {
  const screen = readFileSync(join(import.meta.dir, "fixtures", "hermes-results", "reload-skills-added-120.txt"), "utf8");
  const lines = screen.split("\n");
  const below = lines.slice(findLastIndex(lines, (line) => HERMES_ECHO_RE.exec(line.trimEnd())?.[1] === "/reload-skills") + 1).join("\n");
  const reload = registry.readersFor("hermes").find((reader) => reader.id === "hermes-reload-skills")!;
  await hermesPane("w:hermes", async ({ skill, names }) => {
    expect(await names()).not.toContain("fixture-added");
    skill("fixture-added");
    expect(reload.parse(below, { agent: "hermes", omoAsk: null, omoTrusted: false, omoOpen: [], sent: "/reload-skills", working: false })?.catalogChanged).toBeTrue();
    expect(await names()).toContain("fixture-added");
  });
});

/**
 * A Claude pane whose project settings file is a FIFO: the commands scan reads it, and that read waits
 * until its writer closes it, as a call on a stalled mount (9p, a network share) would. The writer, on
 * a thread of its own, opens the FIFO (its open returns once the scan opens it to read), says
 * "opened", holds it until `release` or for `holdMs`, and then says which: "ok" or "not-equal" (let
 * go before it began to wait), or "timed-out" (this test's thread was held as long as the read).
 */
async function stalledClaudePane(paneId: string, holdMs: number, run: (f: { saying(count: number, ms: number): Promise<string | undefined>; release(): void; ask(): Promise<Response> }) => Promise<void>): Promise<void> {
  const project = join(root, "project");
  mkdirSync(join(project, ".claude", "skills", "fifo-guard"), { recursive: true });
  writeFileSync(join(project, ".claude", "skills", "fifo-guard", "SKILL.md"), "---\nname: fifo-guard\ndescription: Listed once the stalled read returns.\n---\nBody.\n");
  const fifo = join(project, ".claude", "settings.json");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = root;
  panes[paneId] = { agent: "claude", cwd: project, process: [{ pid: 2147483644, argv: ["claude"], cwd: project }] };
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const release = () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); };
  const writer = new Worker(URL.createObjectURL(new Blob([`
    import { closeSync, openSync } from "node:fs";
    self.onmessage = ({ data }) => {
      const fd = openSync(data.fifo, "w");
      postMessage("opened");
      const outcome = Atomics.wait(new Int32Array(data.gate), 0, 0, data.holdMs);
      closeSync(fd);
      postMessage(outcome);
    };
  `], { type: "application/typescript" })));
  const said: string[] = [];
  let heard = () => {};
  writer.addEventListener("message", (event: MessageEvent<string>) => { said.push(event.data); heard(); });
  writer.postMessage({ fifo, gate: gate.buffer, holdMs });
  try {
    await run({
      saying: (count, ms) => new Promise((done) => {
        const timer = setTimeout(() => done(said[count - 1]), ms);
        heard = () => { if (said.length >= count) { clearTimeout(timer); done(said[count - 1]); } };
        heard();
      }),
      release,
      ask: async () => {
        const url = new URL(`http://x/api/pane/commands?pane_id=${paneId}`);
        return (await handlePaneRequest(new Request(url), url, "/api/pane/commands", {}))!;
      },
    });
  } finally {
    release();
    if (said.length === 0) closeSync(openSync(fifo, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK));
    writer.terminate();
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
}

const commandNames = async (response: Response): Promise<string[]> => ((await response.json()) as { commands: { name: string }[] }).commands.map((command) => command.name);

it("scans a pane's skill folders off the server's thread, so a read that stalls holds up nothing else (#2254)", async () => {
  await stalledClaudePane("w:stall", 3_000, async ({ saying, release, ask }) => {
    const answer = ask();
    expect(await saying(1, 10_000)).toBe("opened");
    release();
    expect(["ok", "not-equal"]).toContain((await saying(2, 10_000))!);
    const response = await answer;
    expect(response.status).toBe(200);
    expect(await commandNames(response)).toContain("fifo-guard");
  });
}, 30_000);

it("answers 503 past a request's wait, and lets the request asked again wait for the same scan (#2254)", async () => {
  setFilePoolOptions();
  setCommandsWait(200);
  try {
    await stalledClaudePane("w:slow", 10_000, async ({ saying, release, ask }) => {
      const first = ask();
      expect(await saying(1, 10_000)).toBe("opened");
      const refused = await first;
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("1");
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("file_busy");
      setCommandsWait(10_000);
      const again = scanPaneCommands("claude", join(root, "project"), { environ: null }, null);
      release();
      expect((await again).map((command) => command.name)).toContain("fifo-guard");
      expect(filePoolSize().threads).toBe(1);
    });
  } finally {
    setCommandsWait();
    setFilePoolOptions();
  }
}, 30_000);

it("hands a scan that finished after its request gave up to the next request once, then scans again (#2254)", async () => {
  setFilePoolOptions();
  setCommandsWait(200);
  try {
    await stalledClaudePane("w:late", 10_000, async ({ saying, release, ask }) => {
      const first = ask();
      expect(await saying(1, 10_000)).toBe("opened");
      expect((await first).status).toBe(503);
      release();
      await commandScansSettled();
      const project = join(root, "project");
      rmSync(join(project, ".claude", "settings.json"));
      writeFileSync(join(project, ".claude", "settings.json"), "{}");
      mkdirSync(join(project, ".claude", "skills", "added-later"), { recursive: true });
      writeFileSync(join(project, ".claude", "skills", "added-later", "SKILL.md"), "---\nname: added-later\ndescription: Added after the slow scan.\n---\n");
      setCommandsWait(10_000);
      const kept = (await scanPaneCommands("claude", project, { environ: null }, null)).map((command) => command.name);
      expect(kept).toContain("fifo-guard");
      expect(kept).not.toContain("added-later");
      expect((await scanPaneCommands("claude", project, { environ: null }, null)).map((command) => command.name)).toContain("added-later");
    });
  } finally {
    setCommandsWait();
    setFilePoolOptions();
  }
}, 30_000);

it("reflects a /reload-skills typed in Hermes's own terminal on the next commands request", async () => {
  await hermesPane("w:typed", async ({ skill, names }) => {
    expect(await names()).not.toContain("typed-reload-skill");
    skill("typed-reload-skill");
    expect(await names()).toContain("typed-reload-skill");
  });
});

it("lists an agent's commands for a folder with no pane, from the folder's skills and the static tables alone", async () => {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
  try {
    const project = join(root, "project");
    mkdirSync(join(project, ".codex", "skills", "fixture-skill"), { recursive: true });
    writeFileSync(join(project, ".codex", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: A fixture skill.\n---\nBody.\n");
    const ask = async (query: string, method = "GET") => {
      const url = new URL(`http://x/api/agent/commands${query}`);
      return (await handlePaneRequest(new Request(url, { method }), url, "/api/agent/commands", {}))!;
    };
    const listed = await ask(`?agent=codex&cwd=${encodeURIComponent(project)}`);
    expect(listed.status).toBe(200);
    const { commands } = (await listed.json()) as { commands: { name: string; source: string; trigger?: string; origin?: string; provenance?: { transport: string; verified: boolean } }[] };
    expect(commands.filter((command) => command.source === "skill")).toMatchObject([{ name: "fixture-skill", source: "skill", trigger: "$", origin: "project", provenance: { transport: "scan", verified: false } }]);
    expect(commands.some((command) => command.source === "builtin")).toBeTrue();
    expect(commands.every((command) => command.provenance?.verified === false)).toBeTrue();
    expect(await (await ask("?agent=nonesuch")).json()).toEqual({ commands: [] });
    const missingAgent = await ask("");
    expect(missingAgent.status).toBe(400);
    expect(((await missingAgent.json()) as { error: { code: string } }).error.code).toBe("missing_agent");
    const missingFolder = await ask(`?agent=codex&cwd=${encodeURIComponent(join(root, "missing"))}`);
    expect(missingFolder.status).toBe(400);
    expect(((await missingFolder.json()) as { error: { code: string } }).error.code).toBe("invalid_cwd");
    expect((await ask("?agent=codex", "POST")).status).toBe(400);
  } finally {
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
});

it("lists OpenCode's skills for a folder with no pane in the form its installed version types them", async () => {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
  try {
    const project = join(root, "project");
    mkdirSync(join(project, ".opencode", "skills", "effect"), { recursive: true });
    writeFileSync(join(project, ".opencode", "skills", "effect", "SKILL.md"), "---\nname: effect\ndescription: Apply Effect.\n---\nBody.\n");
    const state = join(root, "opencode-state");
    mkdirSync(state, { recursive: true });
    const skill = async () => {
      const url = new URL(`http://x/api/agent/commands?agent=opencode&cwd=${encodeURIComponent(project)}`);
      const { commands } = await (await handlePaneRequest(new Request(url), url, "/api/agent/commands", { openCodeStateDir: state }))!.json() as { commands: { name: string; source: string; trigger?: string }[] };
      return commands.find((command) => command.name === "effect");
    };
    openCodeServiceOptions.stateDir = join(root, "elsewhere");
    const v1 = await skill();
    expect(v1?.source).toBe("skill");
    expect(v1?.trigger ?? "/").toBe("/");
    // OpenCode 2.0.32 names its version in service.json: its skills are typed with @
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, password: "fixture", version: "2.0.32" }));
    expect(await skill()).toMatchObject({ source: "skill", trigger: "@" });
  } finally {
    delete openCodeServiceOptions.stateDir;
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
});

async function openCodePane(run: (f: { state: string; skill(): Promise<{ trigger?: string; provenance?: { verified?: boolean } } | undefined> }) => Promise<void>, session?: string, argv = ["opencode"]): Promise<void> {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = mkdtempSync(join(tmpdir(), "ovis-pane-routes-home-"));
  mkdirSync(join(root, ".opencode", "skills", "effect"), { recursive: true });
  writeFileSync(join(root, ".opencode", "skills", "effect", "SKILL.md"), "---\nname: effect\ndescription: Apply Effect.\n---\nBody.\n");
  const state = mkdtempSync(join(root, "opencode-state-"));
  panes["w:p1"] = { agent: "opencode", ...(session ? { session } : {}), process: [{ pid: 2147483644, argv, cwd: root }] };
  openCodeServiceOptions.stateDir = join(root, "elsewhere");
  try {
    await run({
      state,
      async skill() {
        const url = new URL("http://x/api/pane/commands?pane_id=w:p1");
        const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", { openCodeStateDir: state, opencodeDb: join(root, "opencode.db") });
        const { commands } = await response!.json() as { commands: { name: string; trigger?: string; provenance?: { verified?: boolean } }[] };
        return commands.find((command) => command.name === "effect");
      },
    });
  } finally {
    delete openCodeServiceOptions.stateDir;
    rmSync(process.env["HOME"]!, { recursive: true, force: true });
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
}

it("offers a session-less OpenCode pane's skill in the form its installed version types, unverified", async () => {
  await openCodePane(async ({ state, skill }) => {
    const v1 = await skill();
    expect(v1?.trigger ?? "/").toBe("/");
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, password: "fixture", version: "2.0.32" }));
    const v2 = await skill();
    expect(v2?.trigger).toBe("@");
    expect(v2?.provenance?.verified).toBe(false);
  });
});

it("offers a session-less OpenCode pane started with --standalone or --server its skill with @, unverified (#1551)", async () => {
  // OpenCode 2's own flags: such a TUI runs without the background service, so no service file names its version
  for (const argv of [["opencode", "--standalone"], ["opencode", "--server", "http://127.0.0.1:9"], ["opencode", "--server=http://127.0.0.1:9"]]) {
    await openCodePane(async ({ skill }) => {
      const v2 = await skill();
      expect(v2?.trigger).toBe("@");
      expect(v2?.provenance?.verified).toBe(false);
    }, undefined, argv);
  }
  for (const [session, argv] of [["ses_paneRoutesUnread", ["opencode", "--standalone"]], [undefined, ["opencode", "--", "--standalone"]]] as const) {
    await openCodePane(async ({ skill }) => {
      const row = await skill();
      expect(row).toBeDefined();
      expect(row?.trigger).toBeUndefined();
    }, session, [...argv]);
  }
});

it("does not give a pane with an OpenCode session it cannot read the service file's version", async () => {
  await openCodePane(async ({ state, skill }) => {
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, password: "fixture", version: "2.0.32" }));
    expect((await skill())?.trigger ?? "/").toBe("/");
  }, "ses_paneRoutesUnread");
});

it("keeps the version a pane's own OpenCode session records over the service file's", async () => {
  const database = join(root, "opencode.db");
  const db = new Database(database, { create: true });
  db.exec("CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text, version text NOT NULL, revert text, time_created integer NOT NULL, time_updated integer NOT NULL)");
  db.exec("CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
  db.query("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_paneRoutes01', 'global', 's', ?, 't', '1.19.3', 0, 0)").run(root);
  db.close();
  await openCodePane(async ({ state, skill }) => {
    writeFileSync(join(state, "service.json"), JSON.stringify({ url: "http://127.0.0.1:9", pid: process.pid, password: "fixture", version: "2.0.32" }));
    expect((await skill())?.trigger ?? "/").toBe("/");
  }, "ses_paneRoutes01");
});

it("answers OpenCode's commands for a folder with no pane while its opencode.json is a FIFO no one writes", async () => {
  const homeBefore = process.env["HOME"];
  process.env["HOME"] = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
  const project = join(root, "fifo-project");
  mkdirSync(project, { recursive: true });
  const fifo = join(project, "opencode.json");
  expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
  const opening = join(root, "fifo-opening");
  const writer = Bun.spawn(["sh", "-c", `sleep 20; touch '${opening}'; printf '{}' > '${fifo}'`]);
  try {
    const url = new URL(`http://x/api/agent/commands?agent=opencode&cwd=${encodeURIComponent(project)}`);
    const response = (await handlePaneRequest(new Request(url), url, "/api/agent/commands", { openCodeStateDir: join(root, "no-opencode-state") }))!;
    expect(existsSync(opening)).toBe(false);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { commands: unknown[] }).commands.length).toBeGreaterThan(0);
  } finally {
    writer.kill();
    rmSync(fifo, { force: true });
    if (homeBefore === undefined) delete process.env["HOME"];
    else process.env["HOME"] = homeBefore;
  }
});

it("resolves a pane with no agent to null and its commands route to []", async () => {
  panes["w:p3"] = { process: [] };
  expect(await paneAgentOf("w:p3")).toBeNull();
  const url = new URL("http://x/api/pane/commands?pane_id=w:p3");
  const response = await handlePaneRequest(new Request(url), url, "/api/pane/commands", {});
  expect(await response!.json()).toEqual({ commands: [] });
});

const claudeLine = (version: string) => JSON.stringify({ type: "user", version, message: { role: "user", content: "hi" } }) + "\n";

it("reads a version from the store the pane's own transcript names, and leaks none to another pane", () => {
  const first = join(root, "first.jsonl");
  const second = join(root, "second.jsonl");
  writeFileSync(first, claudeLine("2.1.100"));
  writeFileSync(second, claudeLine("2.1.200"));
  const pane = (agent: string) => ({ agent }) as never;
  expect(resolveAgent(pane("claude"), null, { path: first })).toEqual({ agent: "claude", version: "2.1.100" });
  expect(resolveAgent(pane("claude"), null, { path: second })).toEqual({ agent: "claude", version: "2.1.200" });
  expect(resolveAgent(pane("claude"), null, { path: first }).version).toBe("2.1.100");
  expect(resolveAgent(pane("claude"), null).version).toBeNull();
  expect(resolveAgent(pane("pi"), null, { path: first }).version).toBeNull();
  expect(resolveAgent(pane("claude"), { omo: { agentDir: null, pluginDir: null } }, { path: first })).toEqual({ agent: "omo", version: null });
  expect(resolveAgent({ agent_session: { agent: "codex" } } as never, null).agent).toBe("codex");
  expect(resolveAgent({} as never, null)).toEqual({ agent: null, version: null });
});

it("asks the share rule about the folder an agent's commands are listed for, as one nobody chose and no pane's", async () => {
  const expanded = spyOn(directories, "expandedDirectory").mockReturnValue(null);
  try {
    const url = new URL("http://x/api/agent/commands?agent=claude&cwd=%2F%2Fhost%2Fshare");
    const response = (await handlePaneRequest(new Request(url), url, "/api/agent/commands", {}))!;
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([400, "invalid_cwd"]);
    // on a Windows PC a share no pane works on is refused before it is read (directories.ts expandedPath)
    expect(expanded.mock.calls).toEqual([["//host/share"]]);
  } finally { expanded.mockRestore(); }
});

const summaryUrl = (ids: string[]) => new URL(`http://x/api/pane/summary?${new URLSearchParams(ids.map((id) => ["pane_id", id]))}`);
const askSummary = (ids: string[], method = "GET") => {
  const url = summaryUrl(ids);
  return handlePaneRequest(new Request(url, { method }), url, "/api/pane/summary", {});
};
const said = (text: string, ts: string): conversation.RecognizedConversation => ({
  source: "claude-transcript", cursor: null, history_id: "h", version: "v", metadata: { model: null, reasoning_effort: null },
  turns: [{ role: "user", ts, parts: [{ kind: "text", text }] } satisfies ConversationTurn],
});

it("answers each pane's last words once, reading one prompt of each", async () => {
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => said(`hello from ${paneId}`, "2026-11-12T10:00:00Z"));
  try {
    const response = (await askSummary(["w:p1", "w:p2", "w:p1", " "]))!;
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as PaneSummaries;
    expect(Number.isNaN(Date.parse(body.server_time))).toBe(false);
    expect(body.summaries).toEqual({
      "w:p1": { role: "user", text: "hello from w:p1", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" },
      "w:p2": { role: "user", text: "hello from w:p2", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" },
    });
    expect(read.mock.calls.map((call) => [call[0], call[2]])).toEqual([["w:p1", { prompts: 1 }], ["w:p2", { prompts: 1 }]]);
  } finally { read.mockRestore(); }
});

it("gives null for a pane with no conversation to read, beside the panes it can", async () => {
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    if (paneId === "shell") throw new conversation.ConversationUnavailable("no_session_path");
    if (paneId === "fresh") throw new conversation.ConversationNotStarted("s1");
    return said("fine", "2026-11-12T10:00:00Z");
  });
  try {
    const body = await (await askSummary(["shell", "w:p1", "fresh"]))!.json() as PaneSummaries;
    expect(body.summaries).toEqual({ shell: null, "w:p1": { role: "user", text: "fine", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" }, fresh: null });
  } finally { read.mockRestore(); }
});

it("leaves out a pane whose read failed for now, beside the panes it can, and reads it anew for the next request", async () => {
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    if (paneId === "pending") throw new conversation.ConversationReadPending();
    if (paneId === "busy") throw new FileBusyError("every file thread is busy");
    if (paneId === "herdr") throw new HerdrError("timeout", "herdr did not answer");
    if (paneId === "changed") throw new conversation.HistoryChanged();
    return said("fine", "2026-11-12T10:00:00Z");
  });
  try {
    const body = await (await askSummary(["pending", "busy", "w:p1", "herdr", "changed"]))!.json() as PaneSummaries;
    expect(body.summaries).toEqual({ "w:p1": { role: "user", text: "fine", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" } });
    await askSummary(["pending"]);
    expect(read.mock.calls.filter((call) => call[0] === "pending")).toHaveLength(2);
  } finally { read.mockRestore(); }
});

it("leaves out a pane whose summary cannot be made from its turns, beside the panes it can", async () => {
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => paneId === "malformed"
    ? { ...said("x", "2026-11-12T10:00:00Z"), turns: [{ role: "assistant", ts: null, parts: null }] as unknown as ConversationTurn[] }
    : said("fine", "2026-11-12T10:00:00Z"));
  try {
    const response = (await askSummary(["malformed", "w:p1"]))!;
    expect(response.status).toBe(200);
    expect(((await response.json()) as PaneSummaries).summaries).toEqual({ "w:p1": { role: "user", text: "fine", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" } });
  } finally { read.mockRestore(); }
});

it("refuses a summary with no pane, too many panes or another method", async () => {
  const read = spyOn(conversation, "paneConversation");
  const code = async (response: Response | null) => [response!.status, ((await response!.json()) as { error: { code: string } }).error.code];
  try {
    expect(await code(await askSummary([]))).toEqual([400, "missing_pane_id"]);
    expect(await code(await askSummary(["", "  "]))).toEqual([400, "missing_pane_id"]);
    expect(await code(await askSummary(Array.from({ length: PANE_SUMMARY_MAX_IDS + 1 }, (_, index) => `w:p${index}`)))).toEqual([400, "too_many_panes"]);
    expect(await code(await askSummary(["w:p1"], "POST"))).toEqual([400, "method_not_allowed"]);
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
});

it("reports only the panes it has no time left to start reading as skipped", async () => {
  let clock = 1_000_000;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const stuck = Promise.withResolvers<conversation.RecognizedConversation>();
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    if (paneId === "stuck") { clock += 5; return stuck.promise; }
    clock += PANE_SUMMARY_DEADLINE_MS - 5;
    return said("first", "2026-11-12T10:00:00Z");
  });
  try {
    const body = await (await askSummary(["w:p1", "stuck", "w:p3"]))!.json() as PaneSummaries;
    expect(Object.keys(body.summaries)).toEqual(["w:p1"]);
    expect(read.mock.calls.map((call) => call[0])).toEqual(["w:p1", "stuck"]);
    expect(body).toMatchObject({ skipped: ["w:p3"] });
  } finally {
    stuck.resolve(said("late", "2026-11-12T10:00:00Z"));
    await stuck.promise;
    read.mockRestore(); now.mockRestore();
  }
});

it("keeps a pane id such as __proto__ as an ordinary key", async () => {
  const read = spyOn(conversation, "paneConversation").mockImplementation(async () => said("fine", "2026-11-12T10:00:00Z"));
  try {
    const body = await (await askSummary(["__proto__", "w:p1"]))!.json() as PaneSummaries;
    expect(Object.keys(body.summaries)).toEqual(["__proto__", "w:p1"]);
    expect(Object.getOwnPropertyDescriptor(body.summaries, "__proto__")?.value).toEqual({ role: "user", text: "fine", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" });
  } finally { read.mockRestore(); }
});

function paneTimers(late: string) {
  const set = globalThis.setTimeout;
  const delays: [string, number][] = [];
  let reading = "";
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
    delays.push([reading, ms ?? 0]);
    return set(reading === late ? callback : () => {}, 0);
  }) as unknown as typeof setTimeout);
  return { delays, reads: (paneId: string) => { reading = paneId; }, restore: () => timers.mockRestore() };
}

it("leaves out a pane whose read runs past its share and reads the panes after it", async () => {
  const slow = Promise.withResolvers<conversation.RecognizedConversation>();
  const timers = paneTimers("slow");
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    timers.reads(paneId);
    return paneId === "slow" ? slow.promise : said(`hello from ${paneId}`, "2026-11-12T10:00:00Z");
  });
  try {
    const body = await (await askSummary(["slow", "w:p2", "w:p3"]))!.json() as PaneSummaries;
    expect(Object.keys(body.summaries)).toEqual(["w:p2", "w:p3"]);
    expect(timers.delays[0]).toEqual(["slow", PANE_SUMMARY_PANE_MS]);
  } finally {
    slow.resolve(said("late words", "2026-11-12T10:00:00Z"));
    await slow.promise;
    read.mockRestore(); timers.restore();
  }
});

it("has a later request for a pane wait on the read still running for it, and starts a new read once it settled", async () => {
  const slow = Promise.withResolvers<conversation.RecognizedConversation>();
  const timers = paneTimers("running");
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    timers.reads(paneId);
    return paneId === "running" ? slow.promise : said(`hello from ${paneId}`, "2026-11-12T10:00:00Z");
  });
  const slowReads = () => read.mock.calls.filter((call) => call[0] === "running").length;
  try {
    expect(Object.keys((await (await askSummary(["running", "w:p2"]))!.json() as PaneSummaries).summaries)).toEqual(["w:p2"]);
    const second = askSummary(["running"]);
    slow.resolve(said("late words", "2026-11-12T10:00:00Z"));
    const body = await (await second)!.json() as PaneSummaries;
    expect(slowReads()).toBe(1);
    expect(body.summaries).toEqual({ running: { role: "user", text: "late words", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" } });
    await askSummary(["running"]);
    expect(slowReads()).toBe(2);
  } finally {
    slow.resolve(said("late words", "2026-11-12T10:00:00Z"));
    read.mockRestore(); timers.restore();
  }
});

it("hands the result of a read a request stopped waiting for to the next request for the pane, once", async () => {
  const slow = Promise.withResolvers<conversation.RecognizedConversation>();
  const timers = paneTimers("kept");
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    timers.reads(paneId);
    return paneId === "kept" ? slow.promise : said(`hello from ${paneId}`, "2026-11-12T10:00:00Z");
  });
  const keptReads = () => read.mock.calls.filter((call) => call[0] === "kept").length;
  try {
    expect(Object.keys((await (await askSummary(["kept"]))!.json() as PaneSummaries).summaries)).toEqual([]);
    slow.resolve(said("words read late", "2026-11-12T10:00:00Z"));
    await slow.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    timers.reads("none");
    const body = await (await askSummary(["kept"]))!.json() as PaneSummaries;
    expect(body.summaries).toEqual({ kept: { role: "user", text: "words read late", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" } });
    expect(keptReads()).toBe(1);
    await askSummary(["kept"]);
    expect(keptReads()).toBe(2);
  } finally {
    slow.resolve(said("words read late", "2026-11-12T10:00:00Z"));
    read.mockRestore(); timers.restore();
  }
});

it("drops a kept result once PANE_SUMMARY_KEEP_MS has passed since it settled", async () => {
  let clock = 2_000_000;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const slow = Promise.withResolvers<conversation.RecognizedConversation>();
  const timers = paneTimers("expired");
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    timers.reads(paneId);
    return paneId === "expired" && read.mock.calls.length === 1 ? slow.promise : said("words of a new read", "2026-11-12T10:05:00Z");
  });
  try {
    await askSummary(["expired"]);
    slow.resolve(said("words read late", "2026-11-12T10:00:00Z"));
    await slow.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock += PANE_SUMMARY_KEEP_MS;
    timers.reads("none");
    const body = await (await askSummary(["expired"]))!.json() as PaneSummaries;
    expect(body.summaries).toEqual({ expired: { role: "user", text: "words of a new read", at: "2026-11-12T10:05:00Z", asked_at: "2026-11-12T10:05:00Z" } });
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    slow.resolve(said("words read late", "2026-11-12T10:00:00Z"));
    read.mockRestore(); timers.restore(); now.mockRestore();
  }
});

it("shares a running read with a later request while it is younger than a request's time", async () => {
  let clock = 1_000_000;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const first = Promise.withResolvers<conversation.RecognizedConversation>();
  const timers = paneTimers("aged");
  let reads = 0;
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    timers.reads(paneId);
    reads++;
    return reads === 1 ? first.promise : said("words after the turn", "2026-11-12T10:05:00Z");
  });
  try {
    expect(Object.keys((await (await askSummary(["aged"]))!.json() as PaneSummaries).summaries)).toEqual([]);
    clock += PANE_SUMMARY_DEADLINE_MS - 1;
    timers.reads("none");
    const inside = askSummary(["aged"]);
    first.resolve(said("words from mid-turn", "2026-11-12T10:00:00Z"));
    expect((await (await inside)!.json() as PaneSummaries).summaries).toEqual({ aged: { role: "user", text: "words from mid-turn", at: "2026-11-12T10:00:00Z", asked_at: "2026-11-12T10:00:00Z" } });
    expect(reads).toBe(1);
  } finally {
    first.resolve(said("words from mid-turn", "2026-11-12T10:00:00Z"));
    read.mockRestore(); timers.restore(); now.mockRestore();
  }
});

it("starts a new read for a request that comes after the running one has aged past a request's time", async () => {
  let clock = 1_000_000;
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  const first = Promise.withResolvers<conversation.RecognizedConversation>();
  const second = Promise.withResolvers<conversation.RecognizedConversation>();
  const timers = paneTimers("old");
  let reads = 0;
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    timers.reads(paneId);
    reads++;
    return reads === 1 ? first.promise : reads === 2 ? second.promise : said("words of a third read", "2026-11-12T10:09:00Z");
  });
  try {
    expect(Object.keys((await (await askSummary(["old"]))!.json() as PaneSummaries).summaries)).toEqual([]);
    clock += PANE_SUMMARY_DEADLINE_MS;
    expect(Object.keys((await (await askSummary(["old"]))!.json() as PaneSummaries).summaries)).toEqual([]);
    expect(reads).toBe(2);
    first.resolve(said("words from mid-turn", "2026-11-12T10:00:00Z"));
    await first.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    timers.reads("none");
    const third = askSummary(["old"]);
    second.resolve(said("words after the turn", "2026-11-12T10:05:00Z"));
    const body = await (await third)!.json() as PaneSummaries;
    expect(reads).toBe(2);
    expect(body.summaries).toEqual({ old: { role: "user", text: "words after the turn", at: "2026-11-12T10:05:00Z", asked_at: "2026-11-12T10:05:00Z" } });
  } finally {
    first.resolve(said("words from mid-turn", "2026-11-12T10:00:00Z"));
    second.resolve(said("words after the turn", "2026-11-12T10:05:00Z"));
    await second.promise;
    read.mockRestore(); timers.restore(); now.mockRestore();
  }
});

it("ends the request at once when the asker goes away during a read, reading no further pane", async () => {
  const held = Promise.withResolvers<conversation.RecognizedConversation>();
  const asker = new AbortController();
  const timers = paneTimers("none");
  const read = spyOn(conversation, "paneConversation").mockImplementation(async (paneId) => {
    timers.reads(paneId);
    return held.promise;
  });
  try {
    const url = summaryUrl(["w:p1", "w:p2"]);
    const answer = handlePaneRequest(new Request(url, { signal: asker.signal }), url, "/api/pane/summary", {});
    asker.abort();
    const body = await (await answer)!.json() as PaneSummaries;
    expect(Object.keys(body.summaries)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    held.resolve(said("first", "2026-11-12T10:00:00Z"));
    await held.promise;
    read.mockRestore(); timers.restore();
  }
});
