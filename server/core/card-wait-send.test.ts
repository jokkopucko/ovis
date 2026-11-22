import { afterEach, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer as createSocketServer, type Socket } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { socketAddress } from "../herdr/client.ts";
import * as prompt from "../prompt.ts";
import * as served from "../runtime/capabilities.ts";
import { HERDR, HERDR_CORE } from "../runtime/capabilities.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus, InteractivePrompt, PendingMessage, ServerMessage } from "../../shared/protocol.ts";
import { composerMessage, composerPayload } from "../../src/lib/compose.ts";
import { useComposerSends, type ComposerSendsDeps } from "../../src/lib/useComposerSends.ts";
import { HerdrSocket } from "../../src/lib/ws.ts";

// Codex 0.167 asking to run a command, while it keeps reporting working; then its input box once answered
const approval = "Would you like to run the following command?\n\n$ rm -rf junk\n\n› 1. Yes, proceed (y)\n  2. No, and tell Codex what to do differently (esc)\n\nPress enter to confirm or esc to cancel\n";
const inputBox = "› Ask Codex to do anything\n\n  gpt-6.1 default · /workspace\n";
// Codex 0.167 at work with one question collapsed in its queue: its own input box still takes a message
const collapsed = readFileSync(join(import.meta.dir, "..", "fixtures", "herdr-core-cards", "codex-question-queued-0.167.0.txt"), "utf8");
/** what the stand-in daemon is only asked: any other request writes to the pane */
const READS = new Set(["events.subscribe", "session.snapshot", "pane.get", "agent.get", "pane.process_info", "pane.read", "pane.scroll_info"]);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/**
 * Ovis on herdr-core (`core`) or on herdr, over a stand-in for the daemon that shows one Codex pane. Only the daemon is a
 * stand-in: the HTTP and WebSocket handlers, the status hub and the pending delivery run unchanged. `refuses`: the
 * requests the daemon answers with a refusal of its own.
 */
async function serve(core: boolean, status: AgentStatus, shown: string, refuses: Record<string, { code: string; message: string }> = {}) {
  const root = mkdtempSync(join(tmpdir(), "ovis-card-send-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const spy = spyOn(served, "capabilities").mockReturnValue(core ? HERDR_CORE : HERDR);
  cleanups.push(() => spy.mockRestore());
  const pane = { pane_id: "t1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t1", cwd: root, focused: false, revision: 0, agent: "codex", agent_status: status };
  const daemon = { screen: shown, methods: [] as string[], written: (from: number) => daemon.methods.slice(from).filter((method) => !READS.has(method)) };
  const sockets = new Set<Socket>();
  const listener = createSocketServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const { id, method } = JSON.parse(buffer.split("\n")[0]!) as { id: string; method: string };
      buffer = "";
      daemon.methods.push(method);
      if (method === "events.subscribe") return;
      const result = method === "session.snapshot" ? { snapshot: { panes: [pane], agents: [{ ...pane }], workspaces: [], tabs: [], layouts: [] } }
        : method === "pane.get" ? { pane } : method === "agent.get" ? { agent: pane }
        : method === "pane.process_info" ? { process_info: { shell_pid: 2147483645, foreground_processes: [{ pid: 2147483646, argv: ["/usr/bin/codex"], cwd: root }] } }
        : method === "pane.read" ? { read: { text: daemon.screen } }
        : method === "pane.scroll_info" ? { scroll: { offset: 0, max: 0 } } : {};
      const refusal = refuses[method];
      if (!socket.destroyed) socket.write(`${JSON.stringify(refusal ? { id, error: refusal } : { id, result })}\n`);
    });
  });
  cleanups.push(() => new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); listener.close(() => resolve()); }));
  await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(socketAddress(join(root, "herdr.sock")), resolve); });
  const before = process.env.HERDR_SOCKET;
  process.env.HERDR_SOCKET = join(root, "herdr.sock");
  cleanups.push(() => { if (before === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = before; });
  let cardTick: () => Promise<void> = () => Promise.resolve();
  const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), herdrProfiles: async () => [], registerBridge: false, tailscaleOwner: null, terminalAttach: false,
    cardTimer: (tick: () => Promise<void>) => { cardTick = tick; return () => {}; } } as Parameters<typeof createServer>[0]);
  cleanups.push(() => app.stop());
  return { daemon, port: app.port, tickCards: () => cardTick() };
}

it("takes a message sent right after a card is answered in the terminal, the card's wait not yet ended", async () => {
  const { daemon, port, tickCards } = await serve(true, "working", approval);
  const reader = spyOn(prompt, "waitingCard");
  cleanups.push(() => reader.mockRestore());
  const seen: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => ws.close());
  const frame = (match: (frame: any) => boolean): Promise<any> => {
    const found = seen.find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`no such frame: ${JSON.stringify(seen.slice(-4))}`)), 10_000);
      ws.addEventListener("message", function listen(event) {
        if (!match(JSON.parse(String(event.data)))) return;
        clearTimeout(timeout); ws.removeEventListener("message", listen); resolve(JSON.parse(String(event.data)));
      });
    });
  };
  ws.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
  await frame((seen) => seen.type === "snapshot");
  ws.send(JSON.stringify({ type: "attach", pane_id: "t1", cols: 100, rows: 30 }));
  await frame((seen) => seen.type === "input-ready" && seen.pane_id === "t1" && seen.ready !== false);
  // the page is in use, so the terminal it shows is read on every tick: the pong says the server has taken that in
  ws.send(JSON.stringify({ type: "presence", active: true }));
  ws.send(JSON.stringify({ type: "ping", id: 1 }));
  await frame((seen) => seen.type === "pong" && seen.id === 1);

  // the card is read and waited on, then answered in the terminal itself: the next read finds no card, the wait holds
  let shown = frame((seen) => seen.type === "pane-status" && seen.pane_id === "t1" && seen.agent_status === "blocked");
  await tickCards();
  await shown;
  daemon.screen = inputBox;
  await tickCards();
  expect(reader).toHaveBeenCalledTimes(2);
  // the next read would end the wait: the message goes in before it, the pages still showing the pane blocked
  expect(seen.filter((seen) => seen.type === "pane-status" && seen.pane_id === "t1").at(-1)?.agent_status).toBe("blocked");
  const from = daemon.methods.length;
  ws.send(JSON.stringify({ type: "submit", id: 1, pane_id: "t1", text: "next step", payload: "next step", delivery: "queue" }));
  const result = await frame((seen) => seen.type === "submit-result" && seen.id === 1);
  // Codex works, by its own report: the message waits for its turn's end as a queued row, and nothing is typed
  expect(result, JSON.stringify({ result, methods: [...new Set(daemon.methods)] })).toMatchObject({ ok: true, pending: { text: "next step", state: "queued" } });
  expect(daemon.written(from)).toEqual([]);
}, 30_000);

async function page(port: number) {
  const globals = globalThis as unknown as { window?: unknown };
  const before = globals.window;
  globals.window = globalThis;
  const socket = new HerdrSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => { socket.close(); globals.window = before; });
  const seen: ServerMessage[] = [];
  const waiting = new Set<() => void>();
  socket.on((message) => { seen.push(message); for (const look of [...waiting]) look(); });
  const frame = <T extends ServerMessage>(what: string, match: (message: ServerMessage) => message is T): Promise<T> => new Promise((resolve, reject) => {
    const look = (): void => {
      const found = seen.find(match);
      if (found === undefined) return;
      clearTimeout(timeout); waiting.delete(look); resolve(found);
    };
    const timeout = setTimeout(() => { waiting.delete(look); reject(new Error(`the page never got ${what}: ${JSON.stringify(seen.slice(-4))}`)); }, 10_000);
    waiting.add(look);
    look();
  });
  const ready = frame("the pane's input", (message): message is Extract<ServerMessage, { type: "input-ready" }> => message.type === "input-ready" && message.pane_id === "t1" && message.ready !== false);
  socket.attach("t1", 100, 30);
  socket.connect();
  await ready;
  /** the rows the page lists for the pane, once everything sent before now has been answered */
  const rows = async (): Promise<PendingMessage[]> => {
    await socket.pendingAction("t1", "no-such-row", "discard");
    return seen.filter((message): message is Extract<ServerMessage, { type: "pending-messages" }> => message.type === "pending-messages" && message.pane_id === "t1").at(-1)?.messages ?? [];
  };
  /** the status the page shows for the pane: its newest status frame's */
  const status = (): AgentStatus | undefined => seen.filter((message): message is Extract<ServerMessage, { type: "pane-status" }> => message.type === "pane-status" && message.pane_id === "t1").at(-1)?.agent_status;
  return { socket, frame, rows, status };
}

/**
 * The chat composer's Send as PaneTerminal wires it, over the page's socket: what the page knows of the pane (`status`)
 * and of the card it shows for it, if any, and whether held messages are sent by themselves.
 */
function composer(socket: HerdrSocket, { status: agentStatus, card, autoSend = false }: { status: AgentStatus | undefined; card: InteractivePrompt | null; autoSend?: boolean }) {
  let actions!: ReturnType<typeof useComposerSends>;
  function Composer() {
    const deps: Partial<ComposerSendsDeps> = {
      agent: "codex", agentStatus, paneId: "t1", paneRef: { current: "t1" }, machineId: "local", queueOwner: paneStorageId("local", "t1"),
      socketRef: { current: socket }, sessionRef: { current: null }, pendingScopeRef: { current: "scope" },
      heldRef: { current: false }, secretRef: { current: null }, observeRef: { current: false }, draftHeldForRef: { current: null },
      stillOpenRef: { current: null }, stillOpenNotedRef: { current: false }, chatNavigation: { current: 0 }, setChatLocalSend: () => {},
      // a question in Codex's queue is no card to answer from the composer, and only an open one holds the input (PaneTerminal)
      answering: card !== null && !card.queued && !card.fallback ? card : null, heldByOpenQueue: card?.queued === "open",
      ended: false, answerPending: false, pendingAnswer: null, settings: { autoSendQueued: autoSend },
      knownOutcomes: () => [], inputRowNow: () => "ready", showSentCommand: () => {}, t: (key) => key,
      submitComposerMessage: (text, delivery, clearDraft, sendAnyway, resendId, generation, agentOnly, holdOnly) =>
        socket.submit("t1", composerMessage(text), composerPayload(text, true), false, delivery, clearDraft, sendAnyway, resendId, generation, agentOnly, holdOnly),
    };
    actions = useComposerSends(deps as ComposerSendsDeps);
    return null;
  }
  renderToStaticMarkup(createElement(Composer));
  return actions;
}

function collapsedCard(): InteractivePrompt {
  const card = prompt.codexQueuedPrompt(collapsed, [{ key: "k1", title: "Which color?", options: ["red", "blue"] }]);
  if (card === null) throw new Error("the fixture no longer reads as a collapsed question");
  return card;
}

it("holds a normal Send to a Codex a herdr-core server shows blocked over its collapsed question, automatic sending off, and writes nothing to herdr", async () => {
  const { daemon, port, tickCards } = await serve(true, "working", collapsed);
  const card = collapsedCard();
  const reader = spyOn(prompt, "waitingCard").mockImplementation(async () => ({ kind: prompt.waitingKindOf(card) ?? null, id: card.id }));
  cleanups.push(() => reader.mockRestore());
  const { socket, frame, rows } = await page(port);
  const waits = frame("the card's wait", (message): message is Extract<ServerMessage, { type: "pane-status" }> => message.type === "pane-status" && message.pane_id === "t1" && message.agent_status === "blocked");
  await tickCards();
  const shown = await waits;
  const from = daemon.methods.length;

  expect(await composer(socket, { status: shown.agent_status, card }).composerSend("next step")).toBe(true);

  const listed = await rows();
  expect(daemon.written(from)).toEqual([]);
  expect(listed).toMatchObject([{ text: "next step", state: "held" }]);
}, 30_000);

it("holds a normal Send made as a new connection opens, before it knows the server's features, and writes nothing to herdr", async () => {
  const { daemon, port, tickCards } = await serve(true, "working", collapsed);
  const card = collapsedCard();
  const reader = spyOn(prompt, "waitingCard").mockImplementation(async () => ({ kind: prompt.waitingKindOf(card) ?? null, id: card.id }));
  cleanups.push(() => reader.mockRestore());
  const { socket: first, frame } = await page(port);
  const waits = frame("the card's wait", (message): message is Extract<ServerMessage, { type: "pane-status" }> => message.type === "pane-status" && message.pane_id === "t1" && message.agent_status === "blocked");
  await tickCards();
  const shown = await waits;
  const from = daemon.methods.length;

  // the page reconnects: its newest status for the pane is still the card's wait, and Send is pressed as the socket opens
  const again = new HerdrSocket(`ws://127.0.0.1:${port}/ws`);
  cleanups.push(() => again.close());
  const heard: ServerMessage[] = [];
  again.on((message) => { heard.push(message); });
  const sent = Promise.withResolvers<boolean | string | object>();
  again.attach("t1", 100, 30);
  again.connect();
  (again as unknown as { socket: WebSocket }).socket.addEventListener("open", () => {
    expect(again.featuresListed()).toBe(false);
    void Promise.resolve(composer(again, { status: shown.agent_status, card }).composerSend("next step")).then(sent.resolve, sent.reject);
  });
  expect(await sent.promise).toBe(true);

  await again.pendingAction("t1", "no-such-row", "discard");
  const listed = heard.filter((message): message is Extract<ServerMessage, { type: "pending-messages" }> => message.type === "pending-messages" && message.pane_id === "t1").at(-1)?.messages ?? [];
  expect(daemon.written(from)).toEqual([]);
  expect(listed).toMatchObject([{ text: "next step", state: "held" }]);
  first.close();
}, 30_000);

it.each([
  ["off", "held", false],
  ["on", "queued", true],
] as const)("types nothing for a normal Send in the read or two a wait outlives its card, automatic sending %s: the message is %s", async (_setting, state, autoSend) => {
  const { daemon, port, tickCards } = await serve(true, "working", approval);
  const { socket, frame, rows, status } = await page(port);
  // the page is in use, so the terminal it shows is read on every tick: the rows' answer says the server has taken that in
  socket.setPresence(true);
  await rows();
  const waits = frame("the card's wait", (message): message is Extract<ServerMessage, { type: "pane-status" }> => message.type === "pane-status" && message.pane_id === "t1" && message.agent_status === "blocked");
  await tickCards();
  await waits;
  // answered in the terminal: Codex works on, the page shows no card any more, and one read without it leaves the wait on
  daemon.screen = inputBox;
  await tickCards();
  expect(status()).toBe("blocked");
  const from = daemon.methods.length;

  expect(await composer(socket, { status: status(), card: null, autoSend }).composerSend("next step")).toBe(true);

  const listed = await rows();
  expect(daemon.written(from)).toEqual([]);
  expect(listed).toMatchObject([{ text: "next step", state }]);
}, 30_000);

it("still types a reply at once into a Codex that herdr itself calls blocked over its collapsed questions, automatic sending off", async () => {
  // herdr reads the collapsed queue as blocked and refuses agent.prompt for it: the server types the message itself (composer.ts)
  const { daemon, port } = await serve(false, "blocked", collapsed, { "agent.prompt": { code: "agent_blocked", message: "questions collapsed" } });
  const { socket, frame, rows } = await page(port);
  const roster = await frame("its snapshot", (message): message is Extract<ServerMessage, { type: "snapshot" }> => message.type === "snapshot");
  const from = daemon.methods.length;

  expect(await composer(socket, { status: roster.snapshot.panes[0]!.agent_status, card: collapsedCard() }).composerSend("next step")).toBe(true);

  expect(await rows()).toEqual([]);
  expect(daemon.written(from)).toEqual(["agent.prompt", "pane.send_text", "pane.send_keys"]);
}, 30_000);
