import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { closeSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandScansSettled, paneCommands, scanPaneCommands, setCommandsWait } from "./commands.ts";
import { filePoolSize, setFilePoolOptions } from "./file-pool.ts";
import { HERMES_ECHO_RE } from "./dialogs/hermes.ts";
import { registry } from "./dialogs/registry.ts";
import { findLastIndex } from "./dialogs/shared.ts";
import * as directories from "./directories.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { paneAgentOf, resolveAgent } from "./pane-context.ts";
import { openCodeServiceOptions } from "./opencode-service.ts";
import * as conversation from "./conversation.ts";
import { requestIdContext } from "./http.ts";

// The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let panes: Record<string, { agent?: string; session?: string; cwd?: string; process: { pid: number; argv: string[]; cwd: string }[] }>;

const paneInfo = (id: string) => ({
  pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: panes[id]?.cwd ?? root, focused: false, revision: 0,
  ...(panes[id]?.agent ? { agent: panes[id]!.agent } : {}),
  ...(panes[id]?.session ? { agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: panes[id]!.session } } : {}),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-pane-routes-"));
  panes = {};
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
          // an agent with no session yet (a Claude pane's commands route asks which transcript it writes)
          : request.method === "agent.get" ? { agent: {} }
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
    // the time is no part of the answer's version: an unchanged transcript still answers 304, with the time as it answered
    const after = Date.now();
    const unchanged = (await ask({ "if-none-match": 'W/"clock-fixture"' }))!;
    expect(unchanged.status).toBe(304);
    expect(Date.parse(unchanged.headers.get("x-server-time") ?? "")).toBeGreaterThanOrEqual(after);
    expect(Date.parse(unchanged.headers.get("x-server-time") ?? "")).toBeLessThanOrEqual(Date.now());
  } finally { read.mockRestore(); }
});

it("asks a chat showing a history to wait only when Copilot's rejection may be waited out", async () => {
  const pane = crypto.randomUUID();
  const ask = async (diagnostic: "copilot_log_truncated" | "copilot_session_unregistered" | "copilot_api_rpc_timeout" | "copilot_api_no_foreground" | "copilot_api_foreground_changed", history: boolean) => {
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
    // a --ui-server API that timed out may answer later; one that names no or another foreground session settled it
    expect(await ask("copilot_api_rpc_timeout", true)).toEqual({ source: "scrollback", turns: [], recovery: "waiting" });
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
  // typing needs omo's own holder record (server/core/omo-pane-send.test.ts): an argv alone keeps herdr's label
  expect(await paneAgentOf("w:p1")).toBe("pi");
  // an ordinary pi stays pi
  expect(await paneAgentOf("w:p2")).toBe("pi");

  // omo's catalog describes /quit in its own words, pi's in others: the route answers with the pane's
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

/** a Hermes pane in the fake herdr, its skills under a HOME of the test's own */
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
    // the recognized reload the client refetches on (catalog_changed)
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
      /** the writer's `count`th word, waited for at most `ms` */
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
    // a writer still waiting for a reader (the scan never opened the FIFO) gets one, and ends
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
    // the scan is inside its read: this thread still runs, and lets the writer go
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
      // the scan goes on: the next read of the same pane waits for it rather than taking another thread
      // (asked here as the route asks, so it joins at once, before the scan is let go)
      setCommandsWait(10_000);
      const again = scanPaneCommands("claude", join(root, "project"), { environ: null }, null);
      release();
      expect((await again).map((command) => command.name)).toContain("fifo-guard");
      // one scan, on one thread: a second would have taken another, the first still being busy
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
      // the scan finishes with nobody waiting for it
      release();
      await commandScansSettled();
      // a skill added since: the kept answer, taken by the next request, does not have it
      const project = join(root, "project");
      rmSync(join(project, ".claude", "settings.json"));
      writeFileSync(join(project, ".claude", "settings.json"), "{}");
      mkdirSync(join(project, ".claude", "skills", "added-later"), { recursive: true });
      writeFileSync(join(project, ".claude", "skills", "added-later", "SKILL.md"), "---\nname: added-later\ndescription: Added after the slow scan.\n---\n");
      setCommandsWait(10_000);
      const kept = (await scanPaneCommands("claude", project, { environ: null }, null)).map((command) => command.name);
      expect(kept).toContain("fifo-guard");
      expect(kept).not.toContain("added-later");
      // taken once: the request after it scans again
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
  // the user's own skills stay out of the answer: a HOME of the test's own
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
    // no herdr RPC answers this route: the fake socket above would throw for one
    const listed = await ask(`?agent=codex&cwd=${encodeURIComponent(project)}`);
    expect(listed.status).toBe(200);
    const { commands } = (await listed.json()) as { commands: { name: string; source: string; trigger?: string; origin?: string; provenance?: { transport: string; verified: boolean } }[] };
    expect(commands.filter((command) => command.source === "skill")).toMatchObject([{ name: "fixture-skill", source: "skill", trigger: "$", origin: "project", provenance: { transport: "scan", verified: false } }]);
    expect(commands.some((command) => command.source === "builtin")).toBeTrue();
    // no process, no version: no row is verified against one
    expect(commands.every((command) => command.provenance?.verified === false)).toBeTrue();
    // the folder is optional; an agent the bridge has no tables for has no rows
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
    // the server's own OpenCode state (createServer's openCodeStateDir), not the process-wide default
    const skill = async () => {
      const url = new URL(`http://x/api/agent/commands?agent=opencode&cwd=${encodeURIComponent(project)}`);
      const { commands } = await (await handlePaneRequest(new Request(url), url, "/api/agent/commands", { openCodeStateDir: state }))!.json() as { commands: { name: string; source: string; trigger?: string }[] };
      return commands.find((command) => command.name === "effect");
    };
    openCodeServiceOptions.stateDir = join(root, "elsewhere");
    // no OpenCode 2 has written its service file: the v1 form
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

/** an OpenCode pane (herdr labels it opencode) in a project with one skill, under a HOME and state dir of the test's own */
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
    // no service file: the v1 form
    const v1 = await skill();
    expect(v1?.trigger ?? "/").toBe("/");
    // OpenCode 2.0.32 names its version in service.json: the skill is typed with @, but the file verifies nothing
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
  // a pane with a session it cannot read may be an OpenCode 1 one: the flag alone does not decide it;
  // and a word after `--` is a directory, not a flag
  for (const [session, argv] of [["ses_paneRoutesUnread", ["opencode", "--standalone"]], [undefined, ["opencode", "--", "--standalone"]]] as const) {
    await openCodePane(async ({ skill }) => {
      const row = await skill();
      expect(row).toBeDefined();
      expect(row?.trigger).toBeUndefined();
    }, session, [...argv]);
  }
});

it("does not give a pane with an OpenCode session it cannot read the service file's version", async () => {
  // no opencode.db: the session's own version is unknown, and it may be an OpenCode 1 session
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
    // the store's 1.19.3 wins: the v1 form, not the service's @
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
  // the writer comes long after the answer should: a read that blocks on the FIFO could only return once
  // the writer opened it, after it marks `opening`
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
  // no store, an agent that keeps no version, an omo pane: unverified
  expect(resolveAgent(pane("claude"), null).version).toBeNull();
  expect(resolveAgent(pane("pi"), null, { path: first }).version).toBeNull();
  expect(resolveAgent(pane("claude"), { omo: { agentDir: null, pluginDir: null } }, { path: first })).toEqual({ agent: "omo", version: null });
  // a session report names the agent when herdr's label is absent
  expect(resolveAgent({ agent_session: { agent: "codex" } } as never, null).agent).toBe("codex");
  expect(resolveAgent({} as never, null)).toEqual({ agent: null, version: null });
});

// the New workspace dialog asks for a folder's skills by itself, also with the folder an address named
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
