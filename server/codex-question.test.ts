import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import type { InteractivePrompt } from "../shared/protocol.ts";
import { CodexServers, onServedStatus } from "./approvals/codex.ts";
import { ApprovalHub } from "./approvals/hub.ts";
import { servedAnswers } from "./codex-question.ts";
import { handlePromptRequest } from "./prompt.ts";

/**
 * Codex 0.171.0 asking one question with request_user_input, recorded in an isolated CODEX_HOME and herdr-core: the
 * request its server sent Ovis, and the TUI's screen for it (`hc read`).
 */
const REQUEST = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "codex-question-0.171.0.json"), "utf8")) as { id: number; method: string; params: { threadId: string } };
const SCREEN = readFileSync(join(import.meta.dir, "fixtures", "codex-question-0.171.0.txt"), "utf8");

type Message = Record<string, unknown>;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function root(): string {
  // short: a socket's path has at most 104 bytes on macOS
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cq-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** herdr with one Codex pane showing `SCREEN`: the keys sent to it are kept. */
async function herdr(): Promise<{ sent: string[] }> {
  const path = join(root(), "herdr.sock");
  const pane = { sent: [] as string[] };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string } };
      const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      if (request.method === "session.snapshot") return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: "codex", agent_status: "blocked" }], layouts: [] } });
      if (request.method === "pane.read") return answer({ read: { text: SCREEN } });
      if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: [] } });
      if (request.method === "pane.get") return answer({ pane: { pane_id: "p_1" } });
      if (request.method === "agent.get") return answer({ agent: {} });
      if (request.method === "pane.send_keys" || request.method === "pane.send_text") {
        pane.sent.push(...(request.params.keys ?? [`text:${request.params.text}`]));
        return answer({});
      }
      socket.end(`${JSON.stringify({ id: request.id, error: { code: "not_found", message: request.method } })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  cleanups.push(() => {
    if (previous === undefined) delete process.env["HERDR_SOCKET"];
    else process.env["HERDR_SOCKET"] = previous;
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  return pane;
}

/** The Codex server Ovis started in the pane, waiting on the recorded question: what Ovis sends it is kept. */
async function codex() {
  const hub = new ApprovalHub(join(root(), "h"), [], {});
  const servers = new CodexServers(hub, { tmp: root() });
  cleanups.push(() => { servers.stop(); hub.stop(); });
  const program = servers.launch("p_1", [], "0.171.0")!;
  const received: Message[] = [];
  const waiting: { match: (message: Message) => boolean; resolve: () => void }[] = [];
  let client: ServerWebSocket<undefined> | null = null;
  const connected = Promise.withResolvers<void>();
  const server: Server<undefined> = Bun.serve({
    unix: join(dirname(program), "codex.sock"),
    fetch: (request, bun) => bun.upgrade(request) ? undefined : new Response("no", { status: 400 }),
    websocket: {
      open(socket) { client = socket; connected.resolve(); },
      message(socket, data) {
        const message = JSON.parse(String(data)) as Message;
        received.push(message);
        for (const wait of [...waiting]) if (wait.match(message)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(); }
        const reply = (result: unknown) => socket.send(JSON.stringify({ id: message["id"], result }));
        if (message["method"] === "initialize") reply({ userAgent: "ovis/0.171.0 (Ubuntu; x86_64) xterm (ovis; 0)" });
        if (message["method"] === "thread/loaded/list") reply({ data: [], nextCursor: null });
        if (message["method"] === "thread/resume") reply({});
      },
    },
  });
  cleanups.push(() => server.stop(true));
  const next = (match: (message: Message) => boolean) => new Promise<void>((resolve) => {
    if (received.some(match)) resolve();
    else waiting.push({ match, resolve });
  });
  const send = (message: Message) => client!.send(JSON.stringify(message));
  let barriers = 0;
  /** Resolves once Ovis has read all sent before: it subscribes to a subagent's thread only after reading it. */
  const read = async () => {
    const id = `b${++barriers}`;
    send({ method: "thread/started", params: { thread: { id, parentThreadId: "x", ephemeral: false } } });
    send({ method: "thread/status/changed", params: { threadId: id, status: { type: "active", activeFlags: [] } } });
    await next((message) => message["method"] === "thread/resume" && (message["params"] as Message)["threadId"] === id);
  };
  await connected.promise;
  await next((message) => message["method"] === "thread/loaded/list");
  send({ method: "thread/started", params: { thread: { id: REQUEST.params.threadId, parentThreadId: null, ephemeral: false } } });
  send(REQUEST);
  await read();
  const answers = () => received.filter((message) => message["id"] === REQUEST.id && "result" in message);
  return { send, read, answers, drop: () => client!.close() };
}

async function card(): Promise<InteractivePrompt> {
  const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
  return ((await (await handlePromptRequest(new Request(url), url, {}))!.json()) as { prompt: InteractivePrompt }).prompt;
}

async function answer(promptId: string, choice: Record<string, unknown>): Promise<number> {
  const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
  return (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...choice }) }), url, {}))!.status;
}

test("answers a question its Codex server waits on as data, with no key, and only once", async () => {
  const pane = await herdr();
  const server = await codex();
  const prompt = await card();
  expect([prompt.question, prompt.options.map((option) => option.label)]).toEqual(["Which color do you choose?", ["Red (Recommended)", "Blue"]]);
  expect(await answer(prompt.id, { option_index: 1 })).toBe(200);
  // the TUI has not drawn the next screen yet: a card read again is the same question, which takes no key
  const again = await card();
  expect(await answer(again.id, { option_index: 0 })).toBe(409);
  expect(await answer(again.id, { custom_text: "green" })).toBe(409);
  await server.read();
  expect(server.answers()).toEqual([{ id: REQUEST.id, result: { answers: { color: { answers: ["Blue"] } } } }]);
  expect(pane.sent).toEqual([]);
});

test("takes no key for a question the terminal answered, whatever the answer", async () => {
  const pane = await herdr();
  const server = await codex();
  server.send({ method: "serverRequest/resolved", params: { threadId: REQUEST.params.threadId, requestId: REQUEST.id } });
  await server.read();
  const prompt = await card();
  expect(await answer(prompt.id, { option_index: 0 })).toBe(409);
  expect(await answer(prompt.id, { custom_text: "green" })).toBe(409);
  expect([server.answers(), pane.sent]).toEqual([[], []]);
});

test("answers a card only for the request it was read for, not another asked alike since", async () => {
  const pane = await herdr();
  const server = await codex();
  const before = await card();
  server.send({ method: "serverRequest/resolved", params: { threadId: REQUEST.params.threadId, requestId: REQUEST.id } });
  server.send({ ...REQUEST, id: 72 });
  await server.read();
  expect(await answer(before.id, { option_index: 0 })).toBe(409);
  await server.read();
  expect([server.answers(), pane.sent]).toEqual([[], []]);
  expect(await answer((await card()).id, { option_index: 0 })).toBe(200);
});

test("takes no key for a question Ovis answered before its connection to the server was lost", async () => {
  const pane = await herdr();
  const server = await codex();
  const prompt = await card();
  expect(await answer(prompt.id, { option_index: 0 })).toBe(200);
  const lost = new Promise<void>((resolve) => { const stop = onServedStatus(() => { stop(); resolve(); }); });
  server.drop();
  await lost;
  expect(await answer((await card()).id, { option_index: 0 })).toBe(409);
  expect(pane.sent).toEqual([]);
});

test("leaves a note and several picks to the TUI", () => {
  const ask = { key: "0", threadId: "t", turnId: "u", itemId: "i", questions: [{ id: "color", header: "Color", question: "Which color do you choose?", options: [{ label: "Red", description: "" }], isOther: true, isSecret: false }] };
  expect(servedAnswers(ask, { pane_id: "p", prompt_id: "x", option_index: 0 })).toEqual({ color: { answers: ["Red"] } });
  expect(servedAnswers(ask, { pane_id: "p", prompt_id: "x", custom_text: "green" })).toBeNull();
  expect(servedAnswers(ask, { pane_id: "p", prompt_id: "x", option_index: 1 })).toBeNull();
  expect(servedAnswers(ask, { pane_id: "p", prompt_id: "x", option_indices: [0] })).toBeNull();
});
