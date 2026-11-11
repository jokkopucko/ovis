import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { forgetTranscriptState } from "./conversation.ts";
import { herdrRpc, paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import type { CommandOutcome, ConversationPart, ConversationResponse, SlashCommand } from "../shared/protocol.ts";
import { CATALOG_SOURCE_BUDGET_MS, mergeCatalogSources } from "./catalog-sources.ts";
import { paneContext } from "./pane-context.ts";
import { closeOpenCodeNative, openCodeNativeState } from "./opencode-native.ts";
import { forgetOpenCodeService, openCodeServiceOptions, OPENCODE_HTTP_TIMEOUT_MS } from "./opencode-service.ts";
import { skillRowSelected } from "./opencode-skill-attach.ts";

// Real herdr metadata + HTTP + an OpenCode store of the test's own, handed to the server (opencodeDb).
const root = mkdtempSync(join(tmpdir(), "ovis-opencode-contract-"));
const database = join(root, "opencode.db");
const fakeOpencode = join(root, "bin", "opencode");
const SESSION = "ses_contractTest01";
const PAGING_SESSION = "ses_contractPaging01";
const workspaces: string[] = [];
let paneId: string;
let pagingPaneId: string;
let server: ReturnType<typeof createServer>;
let db: Database;
let seq = 0;
let ids = 0;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const add = (type: string, data: Record<string, unknown>, session = SESSION): string => {
  const id = `msg_contract${(++ids).toString().padStart(4, "0")}`;
  seq += 3;
  db.query("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, session, type, seq, Date.now(), Date.now(), JSON.stringify(data));
  return id;
};
const turn = (prompt: string, answer: string, session = SESSION) => {
  add("user", { time: { created: Date.now() }, text: prompt, files: [], agents: [] }, session);
  add("assistant", {
    time: { created: Date.now(), completed: Date.now() }, agent: "build", model: { id: "contract-model", providerID: "test", variant: "high" },
    content: [{ type: "text", text: answer }], finish: "stop", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 20, write: 0 } },
  }, session);
  add("idle", { time: { created: Date.now() }, outcome: "succeeded" }, session);
};

/** The pane's session, as herdr's OpenCode integration reports it (herdr-tui-session.js). */
const reportSession = (session: string, targetPaneId = paneId) =>
  herdrRpc("pane.report_agent_session", { pane_id: targetPaneId, source: "herdr:opencode", agent: "opencode", agent_session_id: session, session_start_source: "select" });

const startOpencode = async (session: string): Promise<string> => {
  const created = await workspaceCreate({ cwd: root, label: `ovis-test-opencode-${session}` });
  workspaces.push(created.workspace.workspace_id);
  const targetPaneId = created.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: targetPaneId, text: `${fakeOpencode}\n` });
  for (const deadline = Date.now() + 10_000;;) {
    const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === targetPaneId);
    if (pane?.agent === "opencode") break;
    if (Date.now() > deadline) throw new Error("test opencode did not start");
    await Bun.sleep(50);
  }
  await reportSession(session, targetPaneId);
  return targetPaneId;
};

beforeAll(async () => {
  db = new Database(database, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, slug text NOT NULL, directory text NOT NULL, title text, version text NOT NULL, revert text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);
    CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq);
  `);
  for (const session of [SESSION, PAGING_SESSION]) {
    db.query("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'contract', ?, 'Contract', '2.0.24', 0, 0)").run(session, root);
  }
  turn("Check chat", "Answer one");

  // herdr takes a session report only from an agent holding the pane: a stand-in OpenCode
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(fakeOpencode, "#!/bin/sh\nsleep 600\n");
  chmodSync(fakeOpencode, 0o755);
  // Keep paging on its own pane as well as session: a timeout does not cancel
  // HTTP reads, and the other tests keep writing and switch their pane's session.
  [paneId, pagingPaneId] = await Promise.all([startOpencode(SESSION), startOpencode(PAGING_SESSION)]);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), opencodeDb: database });
});

afterAll(async () => {
  server?.stop();
  for (const workspaceId of workspaces) await workspaceClose(workspaceId);
  db?.close();
  forgetTranscriptState();
  rmSync(root, { recursive: true, force: true });
});

const url = (path: string, params: Record<string, string>, targetPaneId = paneId) =>
  `http://127.0.0.1:${server.port}${path}?${new URLSearchParams({ pane_id: targetPaneId, ...params })}`;

const read = async (params: Record<string, string> = {}, targetPaneId = paneId): Promise<ConversationResponse> => {
  const response = await fetch(url("/api/pane/conversation", params, targetPaneId));
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

it("serves an OpenCode pane's session over HTTP, and an unchanged one as 304", async () => {
  const first = await fetch(url("/api/pane/conversation", {}));
  expect(first.status).toBe(200);
  const conversation = await first.json() as ConversationResponse;
  expect(conversation.source).toBe("opencode-transcript");
  expect(conversation.history_id).toBe(`opencode-${SESSION}`);
  expect(conversation.cursor).toBeNull();
  expect(conversation.turns.map((entry) => [entry.role, entry.parts])).toEqual([
    ["user", [{ kind: "text", text: "Check chat" }]],
    ["assistant", [{ kind: "text", text: "Answer one", phase: "final_answer" }]],
  ]);
  expect(conversation.metadata).toEqual({ model: "contract-model", reasoning_effort: "high", context: { used: 35, window: null } });
  const etag = first.headers.get("etag")!;
  const again = await fetch(url("/api/pane/conversation", {}), { headers: { "if-none-match": etag } });
  expect(again.status).toBe(304);
  // a step that streams in place is a new answer
  turn("Check again", "Answer two");
  const changed = await fetch(url("/api/pane/conversation", {}), { headers: { "if-none-match": etag } });
  expect(changed.status).toBe(200);
  expect((await changed.json() as ConversationResponse).turns.length).toBe(4);
});

it("pages a long session, and answers 409 for a cursor from another history", async () => {
  // Batch fixture writes to reduce WAL frame volume, not per-commit fsyncs:
  // this store uses WAL + synchronous=NORMAL.
  db.transaction(() => {
    turn("Check chat", "Answer one", PAGING_SESSION);
    turn("Check again", "Answer two", PAGING_SESSION);
    for (let n = 0; n < 60; n++) turn(`p${n}`, `a${n}`, PAGING_SESSION);
  })();
  const newest = await read({}, pagingPaneId);
  expect(typeof newest.cursor).toBe("string");
  const older = await read({ before: newest.cursor! }, pagingPaneId);
  expect(older.history_id).toBe(newest.history_id);
  const prompts = [...older.turns, ...newest.turns].filter((entry) => entry.role === "user").map((entry) => (entry.parts[0] as { text: string }).text);
  expect(prompts).toEqual(["Check chat", "Check again", ...Array.from({ length: 60 }, (_, n) => `p${n}`)]);
  const refused = await fetch(url("/api/pane/conversation", { before: `opencode-ses_elsewhere:${newest.cursor!.split(":")[1]}` }, pagingPaneId));
  expect(refused.status).toBe(409);
  expect((await refused.json() as { error: { code: string } }).error.code).toBe("history_changed");
});

it("serves a cut tool output and a tool's picture by the refs the page gave them", async () => {
  add("user", { time: { created: Date.now() }, text: "open it", files: [] });
  add("assistant", {
    time: { created: Date.now() }, finish: "tool-calls",
    content: [{ type: "tool", id: "call_1", name: "read", state: {
      status: "completed", input: { path: "shot.png" },
      content: [{ type: "text", text: "z".repeat(5000) }, { type: "file", uri: `data:image/png;base64,${PNG.toString("base64")}`, mime: "image/png" }],
    } }],
  });
  const conversation = await read();
  const tool = conversation.turns.flatMap((entry) => entry.parts).filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool").at(-1)!;
  expect(tool.output_size).toBe(5000);
  const output = await fetch(url("/api/pane/conversation/tool-output", { ref: tool.output_ref! }));
  expect(output.status).toBe(200);
  // the ref names a place in a row OpenCode rewrites in place: its output is never pinned
  expect(output.headers.get("cache-control")).toBe("private, no-store");
  expect(await output.text()).toBe("z".repeat(5000));
  expect((await fetch(url("/api/pane/conversation/tool-output", { ref: `${tool.output_ref!.split(":")[0]}:7` }))).status).toBe(404);

  const image = await fetch(url("/api/pane/conversation/image", { ref: tool.images![0]!.ref }));
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/png");
  expect(image.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await image.arrayBuffer()).equals(PNG)).toBe(true);
  expect((await fetch(url("/api/pane/conversation/image", { ref: tool.images![0]!.ref.replace(/:0$/, ":3") }))).status).toBe(404);
});

it("does not cache OpenCode image refs while parallel tool results stream in", async () => {
  const earlierImage = Buffer.from([...PNG, 0x01]);
  const laterImage = Buffer.from([...PNG, 0x02]);
  const file = (bytes: Buffer) => ({ type: "file", uri: `data:image/png;base64,${bytes.toString("base64")}`, mime: "image/png" });
  add("user", { time: { created: Date.now() }, text: "read both images", files: [] });
  const messageId = add("assistant", {
    time: { created: Date.now() }, finish: "tool-calls",
    content: [
      { type: "tool", id: "call_early", name: "read", state: { status: "running", input: { path: "earlier.png" }, content: [] } },
      { type: "tool", id: "call_later", name: "read", state: { status: "completed", input: { path: "later.png" }, content: [file(laterImage)] } },
    ],
  });
  const firstConversation = await read();
  const initialTools = firstConversation.turns.at(-1)!.parts.filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool");
  expect(initialTools[1]!.images?.[0]!.ref).toBe(`opencode:${messageId}:0`);

  const ref = initialTools[1]!.images![0]!.ref;
  const firstImage = await fetch(url("/api/pane/conversation/image", { ref }));
  expect(firstImage.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await firstImage.arrayBuffer()).equals(laterImage)).toBe(true);

  db.query("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?").run(JSON.stringify({
    time: { created: Date.now() }, finish: "tool-calls",
    content: [
      { type: "tool", id: "call_early", name: "read", state: { status: "completed", input: { path: "earlier.png" }, content: [file(earlierImage)] } },
      { type: "tool", id: "call_later", name: "read", state: { status: "completed", input: { path: "later.png" }, content: [file(laterImage)] } },
    ],
  }), Date.now() + 1, messageId);

  const updatedConversation = await read();
  const updatedTools = updatedConversation.turns.at(-1)!.parts.filter((part): part is Extract<ConversationPart, { kind: "tool" }> => part.kind === "tool");
  expect(updatedTools.map((tool) => tool.images?.[0]?.ref)).toEqual([`opencode:${messageId}:0`, `opencode:${messageId}:1`]);

  const updatedImage = await fetch(url("/api/pane/conversation/image", { ref }));
  expect(updatedImage.headers.get("cache-control")).toBe("private, no-store");
  expect(Buffer.from(await updatedImage.arrayBuffer()).equals(earlierImage)).toBe(true);
});

it("keeps the terminal for a session the store does not hold", async () => {
  await reportSession("ses_notInTheStore");
  try {
    expect(await read()).toEqual({ source: "scrollback", turns: [] });
  } finally {
    await reportSession(SESSION);
  }
  expect((await read()).source).toBe("opencode-transcript");
});

it("counts an OpenCode pane's running subagent, holds the turn that ends meanwhile as BG, and leaves its card when it ends", async () => {
  const PARENT = "ses_contractSubagents";
  const CHILD = "ses_contractChild01";
  // the columns child sessions came with (2.0.26 on): this store began as a 2.0.24 one
  for (const column of ["parent_id text", "agent text", "model text"]) db.exec(`ALTER TABLE session_v2 ADD COLUMN ${column}`);
  db.query("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'contract', ?, 'Contract', '2.0.32', 0, 0)").run(PARENT, root);
  add("user", { time: { created: Date.now() }, text: "scan it in the background", files: [], agents: [] }, PARENT);
  db.query("INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, agent, time_created, time_updated) VALUES (?, 'global', ?, 'child', ?, 'Scan the repo', '2.0.32', 'explore', ?, ?)").run(CHILD, PARENT, root, Date.now(), Date.now());
  add("user", { time: { created: Date.now() }, text: "You are a subagent spawned by another session.\nscan" }, CHILD);
  const target = await startOpencode(PARENT);
  // a server of its own, whose OpenCode state holds no service: never the machine's own service.json
  const own = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-subagents"), opencodeDb: database, openCodeStateDir: join(root, "no-service") });
  // its status subscription is up before the turn is reported, or the turn's events go by unseen
  await own.statusReady;
  const base = `http://127.0.0.1:${own.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${own.port}/ws`);
  const frames: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  ws.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data)) as Record<string, unknown>); for (const wake of waiters) wake(); });
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  // only a frame received after `from` (the frame count before the step it should follow) answers
  const frame = (match: (frame: Record<string, unknown>) => boolean, what: string, from = 0) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => { waiters.delete(check); reject(new Error(`no frame: ${what}`)); }, 15_000);
    const check = () => { const found = frames.slice(from).find((seen) => seen.type === "pane-status" && seen.pane_id === target && match(seen)); if (found) { clearTimeout(timeout); waiters.delete(check); resolve(found); } };
    waiters.add(check);
    check();
  });
  const reportState = (state: string) => herdrRpc("pane.report_agent", { pane_id: target, source: "herdr:opencode", agent: "opencode", agent_session_id: PARENT, state });
  try {
    const started = frames.length;
    await reportState("working");
    await frame((seen) => seen.agent_status === "working", "the turn at work", started);
    // a snapshot names the pane and its session to the tracker, which counts the child from the store:
    // this one, or one the server took on its own since the turn started, which said it first
    await fetch(`${base}/api/session`);
    await frame((seen) => seen.background_tasks === 1, "the running subagent counted", started);
    let from = frames.length;
    await reportState("idle");
    // the turn ended while its subagent runs: BG, not DONE
    expect(await frame((seen) => seen.background_wait === true, "the turn held on its subagent", from)).toMatchObject({ background_tasks: 1 });
    const { snapshot } = await (await fetch(`${base}/api/session`)).json() as { snapshot: { panes: { pane_id: string; background_tasks?: number; background_wait?: true }[] } };
    expect(snapshot.panes.find((pane) => pane.pane_id === target)).toMatchObject({ background_tasks: 1, background_wait: true });
    const listed = await (await fetch(`${base}/api/pane/omo-tasks?pane_id=${encodeURIComponent(target)}`)).json() as { tasks: { id: string; title: string; category: string | null; status: string }[] };
    expect(listed.tasks.map((task) => [task.id, task.title, task.category, task.status])).toEqual([[CHILD, "Scan the repo", "explore", "running"]]);

    // it ends, and OpenCode wakes the parent with its answer
    from = frames.length;
    add("assistant", { time: { created: Date.now(), completed: Date.now() }, finish: "stop", content: [{ type: "text", text: "Three TODOs." }] }, CHILD);
    add("idle", { time: { created: Date.now() }, outcome: "succeeded" }, CHILD);
    add("synthetic", {
      time: { created: Date.now() }, description: "Scan the repo", metadata: { source: "subagent", childID: CHILD, agent: "explore", state: "completed" },
      text: `<subagent sessionID="${CHILD}" state="completed" description="Scan the repo">\nThree TODOs.\n</subagent>`,
    }, PARENT);
    await frame((seen) => seen.background_tasks === 0, "the ended subagent no longer counted", from);
    const ended = await (await fetch(`${base}/api/pane/omo-tasks?pane_id=${encodeURIComponent(target)}`)).json() as { tasks: { id: string; status: string }[] };
    expect(ended.tasks.map((task) => [task.id, task.status])).toEqual([[CHILD, "completed"]]);
    const response = await fetch(`${base}/api/pane/conversation?${new URLSearchParams({ pane_id: target })}`);
    expect(response.status).toBe(200);
    const conversation = await response.json() as ConversationResponse;
    expect(conversation.turns.at(-1)?.parts).toEqual([{ kind: "task_result", tasks: [expect.objectContaining({ id: CHILD, title: "Scan the repo", agent: "explore", status: "completed", result: "Three TODOs." })] }]);
  } finally {
    ws.close();
    own.stop();
  }
}, 60_000);


/**
 * OpenCode v2's own service, faked in the pinned OpenAPI shapes (843a6c51): /api/info, a session,
 * /api/command and /api/skill for a directory, and /api/event. The pane runs a stand-in that draws
 * the recorded 2.0.32 autocomplete once `@effect` is typed and logs every byte it is sent.
 */
describe("OpenCode v2 native service", () => {
  const NATIVE_SESSION = "ses_contractNative01";
  const nativeRoot = join(root, "native");
  const standIn = join(nativeRoot, "bin", "opencode");
  const typedLog = join(nativeRoot, "typed.log");
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let info: Record<string, unknown> = {};
  let fake: ReturnType<typeof Bun.serve>;
  let nativePane: string;
  let connected = Promise.withResolvers<void>();
  /** runs once, inside the next session lookup, before the fake answers it */
  let duringLookup: (() => Promise<void>) | undefined;
  /** every chunk the stand-in reads from its terminal, reported by the stand-in itself with when it read it (ms since the epoch) */
  let onTyped: ((chunk: string, start: number, at: number) => void) | undefined;
  const typedWaiters = new Set<() => void>();
  /** while set, session lookups get no answer (the bridge's own request timeout ends them) */
  let withholdLookups = false;
  /** while set, every request but /api/info gets no answer: a service that hangs */
  let hangAll = false;
  let onHungRequest: (() => void) | undefined;
  /** other sessions the fake service holds besides NATIVE_SESSION */
  const extraSessions = new Set<string>();
  const withheld = new Set<() => void>();
  /** how /api/event answers: normally, never (held), 404 or 503 */
  let eventMode: "ok" | "slow" | "absent" | "error" = "ok";
  /** when the fake received each request of the bridge's (not the stand-in's reports), in ms since the epoch */
  const requestsAt: number[] = [];
  const typed = (): string => existsSync(typedLog) ? readFileSync(typedLog, "latin1") : "";
  /** each event 10 ms after the last, so the evidence names exactly which event settled a send */
  let clock = 0;
  const push = (type: string, data: Record<string, unknown>): number => {
    clock = Math.max(clock + 10, Date.now());
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_${type}_${clock}`, created: clock, type, data })}\n\n`);
    for (const stream of streams) stream.enqueue(bytes);
    return clock;
  };
  const catalog = async (base: SlashCommand[]): Promise<SlashCommand[]> => {
    const context = await paneContext(nativePane);
    return mergeCatalogSources("opencode", context.pane, nativeRoot, base);
  };
  /** the composer's own catalog request, which a send is classified against (it never discovers) */
  const browserCatalog = async (): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/commands?pane_id=${encodeURIComponent(nativePane)}`);
    const { commands } = await response.json() as { commands: SlashCommand[] };
    expect(commands.find((row) => row.name === "effect")?.provenance).toEqual({ transport: "native", verified: true });
  };
  const scanned: SlashCommand[] = [
    { name: "review", description: "review", source: "builtin", provenance: { transport: "static", verified: false } },
    { name: "effect", description: "scanned", source: "skill", trigger: "@", provenance: { transport: "scan", verified: false } },
  ];

  beforeAll(async () => {
    mkdirSync(join(nativeRoot, "bin"), { recursive: true });
    mkdirSync(join(nativeRoot, ".opencode", "skills", "effect"), { recursive: true });
    writeFileSync(join(nativeRoot, ".opencode", "skills", "effect", "SKILL.md"), "---\nname: effect\ndescription: Apply Effect\n---\nUse Effect.\n");
    // the recorded 2.0.32 screens with their colours (40x24, inside the 80x24 attach): @effect selected, then accepted
    const recorded = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-ansi-narrow-${name}.ansi`), "utf8").replace(/\n/g, "\r\n");
    writeFileSync(join(nativeRoot, "screen.txt"), recorded("first-selected"));
    writeFileSync(join(nativeRoot, "accepted.txt"), recorded("accepted"));
    writeFileSync(join(nativeRoot, "closed.txt"), recorded("closed"));
    writeFileSync(standIn, `#!${process.execPath}
const { appendFileSync, readFileSync, statSync } = require("node:fs");
let typed = "";
process.stdin.setRawMode(true);
process.stdin.on("data", (chunk) => {
  const at = performance.timeOrigin + performance.now();
  appendFileSync(${JSON.stringify(typedLog)}, chunk);
  const start = statSync(${JSON.stringify(typedLog)}).size - chunk.length;
  fetch(readFileSync(${JSON.stringify(join(nativeRoot, "fake.url"))}, "utf8") + "/test/typed", { method: "POST", headers: { "x-typed-start": String(start), "x-typed-at": String(at) }, body: chunk }).catch(() => {});
  const before = typed;
  typed += chunk.toString("latin1");
  if (!before.endsWith("@effect") && typed.endsWith("@effect")) process.stdout.write("\\u001b[2J\\u001b[H" + readFileSync(${JSON.stringify(join(nativeRoot, "screen.txt"))}, "utf8"));
  if (before.endsWith("@effect") && typed.endsWith("@effect\\t")) process.stdout.write("\\u001b[2J\\u001b[H" + readFileSync(${JSON.stringify(join(nativeRoot, "accepted.txt"))}, "utf8"));
  // Ctrl-L: the prompt with its autocomplete closed (closedPrompt)
  if (chunk.toString("latin1") === "\\u000c") process.stdout.write("\\u001b[2J\\u001b[H" + readFileSync(${JSON.stringify(join(nativeRoot, "closed.txt"))}, "utf8"));
});
`);
    chmodSync(standIn, 0o755);
    fake = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/info") return Response.json(info);
        if (url.pathname === "/test/typed") return request.text().then((chunk) => {
          onTyped?.(chunk, Number(request.headers.get("x-typed-start")), Number(request.headers.get("x-typed-at")));
          for (const wake of typedWaiters) wake();
          return new Response(null, { status: 204 });
        });
        requestsAt.push(performance.timeOrigin + performance.now());
        if (url.pathname === "/api/event" && eventMode === "slow") return new Promise<Response>((resolve) => withheld.add(() => resolve(new Response(null, { status: 503 }))));
        if (url.pathname === "/api/event" && eventMode !== "ok") return new Response(null, { status: eventMode === "absent" ? 404 : 503 });
        if (hangAll && url.pathname !== "/api/info") {
          onHungRequest?.();
          return new Promise<Response>((resolve) => withheld.add(() => resolve(new Response(null, { status: 503 }))));
        }
        const held = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        if (url.pathname.startsWith("/api/session/") && extraSessions.has(held)) return Response.json({ data: { id: held } });
        if (url.pathname === `/api/session/${NATIVE_SESSION}` && withholdLookups) {
          return new Promise<Response>((resolve) => withheld.add(() => resolve(Response.json({ data: { id: NATIVE_SESSION } }))));
        }
        if (url.pathname === `/api/session/${NATIVE_SESSION}`) {
          const gate = duringLookup;
          duringLookup = undefined;
          return (gate ? gate() : Promise.resolve()).then(() => Response.json({ data: { id: NATIVE_SESSION } }));
        }
        const directory = url.searchParams.get("location[directory]");
        if (url.pathname === "/api/command") return Response.json({ location: { directory }, data: [{ name: "review", description: "review changes" }, { name: "shipit", description: "Ship the change" }] });
        if (url.pathname === "/api/skill") return Response.json({ location: { directory }, data: [{ id: "effect", name: "effect", description: "Apply Effect", path: join(nativeRoot, ".opencode", "skills", "effect", "SKILL.md"), content: "Use Effect." }] });
        if (url.pathname === "/api/event") {
          let mine: ReadableStreamDefaultController<Uint8Array>;
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { mine = controller; streams.add(controller); connected.resolve(); controller.enqueue(new TextEncoder().encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")); },
            cancel() { streams.delete(mine); },
          }), { headers: { "content-type": "text/event-stream" } });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    info = { version: "2.0.32", pid: process.pid, urls: [fake.url.origin], paths: { tmp: nativeRoot } };
    writeFileSync(join(nativeRoot, "fake.url"), fake.url.origin);
    writeFileSync(join(nativeRoot, "service.json"), JSON.stringify({ url: fake.url.origin, pid: process.pid, password: "native-secret", version: "2.0.32" }));
    openCodeServiceOptions.stateDir = nativeRoot;
    const created = await workspaceCreate({ cwd: nativeRoot, label: "ovis-test-opencode-native" });
    workspaces.push(created.workspace.workspace_id);
    nativePane = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: nativePane, text: `exec ${standIn}\n` });
    for (const deadline = Date.now() + 10_000;;) {
      const pane = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === nativePane);
      if (pane?.agent === "opencode") break;
      if (Date.now() > deadline) throw new Error("native stand-in opencode did not start");
      await Bun.sleep(50);
    }
    await reportSession(NATIVE_SESSION, nativePane);
  });

  afterAll(() => {
    closeOpenCodeNative();
    for (const stream of streams) stream.close();
    fake?.stop(true);
    delete openCodeServiceOptions.stateDir;
    forgetOpenCodeService();
  });

  it("replaces the scanned skills with the service's own rows, keeping builtins", async () => {
    const rows = await catalog(scanned);
    expect(rows.find((row) => row.name === "effect")).toMatchObject({ source: "skill", trigger: "@", description: "Apply Effect", provenance: { transport: "native", verified: true } });
    expect(rows.find((row) => row.name === "shipit")).toMatchObject({ provenance: { transport: "native", verified: true } });
    expect(rows.filter((row) => row.name === "review")).toEqual([scanned[0]!]);
  });

  it("ignores a service.json whose pid is not the process answering, and keeps the scanned rows", async () => {
    info = { ...info, pid: process.pid + 1 };
    forgetOpenCodeService();
    closeOpenCodeNative();
    try {
      expect(await catalog(scanned)).toEqual(scanned);
    } finally {
      info = { ...info, pid: process.pid };
      forgetOpenCodeService();
    }
  });

  it("types @effect through the autocomplete once, and settles the send from the session's native events", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const frames: Record<string, unknown>[] = [];
    const result = Promise.withResolvers<Record<string, unknown>>();
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      frames.push(frame);
      if (frame.type === "submit-result" && frame.id === 1) result.resolve(frame);
    });
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    try {
      // the send opens its own event stream (the test before closed the last one); events go to it
      connected = Promise.withResolvers<void>();
      // no catalog request first: the cold send derives the skill from the verified service itself
      ws.send(JSON.stringify({ type: "submit", id: 1, pane_id: nativePane, text: "@effect apply it", payload: "@effect apply it" }));
      expect(await result.promise).toMatchObject({ ok: true });
      for (const deadline = Date.now() + 5_000; !(existsSync(typedLog) && typed().endsWith("\r"));) {
        if (Date.now() > deadline) throw new Error(`typed: ${existsSync(typedLog) ? JSON.stringify(typed()) : "nothing"}`);
        await Bun.sleep(50);
      }
      expect(typed()).toBe("@effect\t\u001b[200~apply it\u001b[201~\r");
      const outcomes = async () => ((await (await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${nativePane}`)).json()) as { outcomes?: CommandOutcome[] }).outcomes ?? [];
      expect((await outcomes()).map((outcome) => outcome.state)).toEqual(["accepted"]);
      await connected.promise;
      // the real 2.0.32 sequence (no session.skill.activated for an attached skill): the message is enqueued with its
      // skills, delivered, and an execution succeeds. Another session's turn, a message without the skill, another
      // text, and a turn that ends before our message was delivered settle nothing.
      const item = (text: string, skills: string[]) => ({ type: "user", payload: { text, skills: skills.map((id) => ({ id, name: id, mention: { start: 0, end: id.length + 1, text: `@${id}` }, text: "Use Effect." })) }, delivery: "steer" });
      push("session.inbox.enqueued", { sessionID: "ses_other", inboxID: "msg_a", item: item("@effect apply it", ["effect"]) });
      push("session.inbox.delivered", { sessionID: "ses_other", inboxID: "msg_a" });
      push("session.execution.succeeded", { sessionID: "ses_other" });
      push("session.inbox.enqueued", { sessionID: NATIVE_SESSION, inboxID: "msg_b", item: item("@effect apply it", []) });
      push("session.inbox.enqueued", { sessionID: NATIVE_SESSION, inboxID: "msg_c", item: item("something else", ["effect"]) });
      push("session.inbox.delivered", { sessionID: NATIVE_SESSION, inboxID: "msg_b" });
      push("session.inbox.delivered", { sessionID: NATIVE_SESSION, inboxID: "msg_c" });
      // not this send's message either: a skill set that only contains ours, and text that differs only in spacing
      push("session.inbox.enqueued", { sessionID: NATIVE_SESSION, inboxID: "msg_e", item: item("@effect apply it", ["effect", "other"]) });
      push("session.inbox.delivered", { sessionID: NATIVE_SESSION, inboxID: "msg_e" });
      push("session.execution.succeeded", { sessionID: NATIVE_SESSION });
      push("session.inbox.enqueued", { sessionID: NATIVE_SESSION, inboxID: "msg_f", item: item("@effect  apply it", ["effect"]) });
      push("session.inbox.delivered", { sessionID: NATIVE_SESSION, inboxID: "msg_f" });
      push("session.execution.succeeded", { sessionID: NATIVE_SESSION });
      push("session.execution.started", { sessionID: NATIVE_SESSION });
      push("session.inbox.enqueued", { sessionID: NATIVE_SESSION, inboxID: "msg_d", item: item("@effect apply it", ["effect"]) });
      push("session.execution.succeeded", { sessionID: NATIVE_SESSION });
      push("session.inbox.delivered", { sessionID: NATIVE_SESSION, inboxID: "msg_d" });
      push("session.execution.started", { sessionID: NATIVE_SESSION });
      const settled = push("session.execution.succeeded", { sessionID: NATIVE_SESSION });
      for (const deadline = Date.now() + 5_000; ;) {
        const [outcome] = await outcomes();
        if (outcome?.state === "result-observed") {
          expect(outcome.evidence).toEqual([{ kind: "native", at: new Date(settled).toISOString() }]);
          break;
        }
        if (Date.now() > deadline) throw new Error(`outcome: ${JSON.stringify(outcome)}`);
        await Bun.sleep(50);
      }
    } finally { ws.close(); }
  });
  it("queues @effect while the pane works, and types it through the autocomplete once when the pane is ready", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const frames: Record<string, unknown>[] = [];
    const waiters = new Set<() => void>();
    ws.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data)) as Record<string, unknown>); for (const wake of waiters) wake(); });
    const frame = (match: (frame: Record<string, unknown>) => boolean) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(check); reject(new Error("frame not received")); }, 10_000);
      const check = () => { const found = frames.find(match); if (found) { clearTimeout(timeout); waiters.delete(check); resolve(found); } };
      waiters.add(check);
      check();
    });
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    const before = typed().length;
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: nativePane, cols: 80, rows: 24 }));
      await frame((message) => message.type === "pty-data" && message.pane_id === nativePane);
      await herdrRpc("pane.report_agent", { pane_id: nativePane, source: "herdr:opencode", agent: "opencode", agent_session_id: NATIVE_SESSION, state: "working" });
      for (const deadline = Date.now() + 5_000; (await sessionSnapshot()).panes.find((pane) => pane.pane_id === nativePane)?.agent_status !== "working";) {
        if (Date.now() > deadline) throw new Error("the pane did not report working");
        await Bun.sleep(50);
      }
      await browserCatalog();
      const completed = typedSince(before);
      ws.send(JSON.stringify({ type: "submit", id: 2, pane_id: nativePane, text: "@effect apply it", payload: "@effect apply it", delivery: "queue" }));
      expect(await frame((message) => message.type === "submit-result" && message.id === 2)).toMatchObject({ ok: true, pending: { state: "queued" } });
      expect(typed().length).toBe(before);
      await herdrRpc("pane.report_agent", { pane_id: nativePane, source: "herdr:opencode", agent: "opencode", agent_session_id: NATIVE_SESSION, state: "idle" });
      const delivered = await frame((message) => message.type === "pending-messages" && Array.isArray(message.removed) && message.removed.length > 0);
      expect(JSON.stringify(delivered.removed)).not.toContain("error");
      // The receipt acknowledges the PTY write, not the stand-in reading its Enter.
      expect(await completed).toBe("@effect\t\u001b[200~apply it\u001b[201~\r");
    } finally { ws.close(); }
  });
  // #511: a queued message for an agent alone is one guarded paste, never typed key by key through the autocomplete
  it("pastes a queued agent-only message whole when the pane is ready, its @effect left as text", async () => {
    const { ws, frame } = await socket();
    const before = typed().length;
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: nativePane, cols: 80, rows: 24 }));
      await frame((message) => message.type === "pty-data" && message.pane_id === nativePane);
      await reportState("working");
      await untilStatus("working");
      await browserCatalog();
      const completed = typedSince(before);
      ws.send(JSON.stringify({ type: "submit", id: 5, pane_id: nativePane, text: "@effect apply it", payload: "@effect apply it", delivery: "queue", agent_only: true }));
      expect(await frame((message) => message.type === "submit-result" && message.id === 5)).toMatchObject({ ok: true, pending: { state: "queued" } });
      await reportState("idle");
      await frame((message) => message.type === "pending-messages" && Array.isArray(message.removed) && message.removed.length > 0);
      expect(await completed).toBe("\u001b[200~@effect apply it\u001b[201~\r");
    } finally { ws.close(); }
  });
  it("pastes an agent-only message queued while the pane is ready at once, its @effect left as text", async () => {
    const { ws, frame } = await socket();
    const before = typed().length;
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: nativePane, cols: 80, rows: 24 }));
      await frame((message) => message.type === "pty-data" && message.pane_id === nativePane);
      await reportState("idle");
      // after an earlier turn herdr reads an idle report as done: either is a pane at rest
      await untilStatus("idle", "done");
      await browserCatalog();
      const completed = typedSince(before);
      ws.send(JSON.stringify({ type: "submit", id: 6, pane_id: nativePane, text: "@effect apply it", payload: "@effect apply it", delivery: "queue", agent_only: true }));
      expect(await frame((message) => message.type === "submit-result" && message.id === 6)).toMatchObject({ ok: true });
      expect(await completed).toBe("\u001b[200~@effect apply it\u001b[201~\r");
    } finally { ws.close(); }
  });
/** A socket recording every frame; `frame` resolves on the first one (already seen or next) matching. */
  async function socket() {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const frames: Record<string, unknown>[] = [];
    const waiters = new Set<() => void>();
    ws.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data)) as Record<string, unknown>); for (const wake of waiters) wake(); });
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    const frame = (match: (frame: Record<string, unknown>) => boolean, from = 0) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(check); reject(new Error("frame not received")); }, 10_000);
      const check = () => { const found = frames.slice(from).find(match); if (found) { clearTimeout(timeout); waiters.delete(check); resolve(found); } };
      waiters.add(check);
      check();
    });
    return { ws, frames, frame };
  }
  const reportState = (state: string) => herdrRpc("pane.report_agent", { pane_id: nativePane, source: "herdr:opencode", agent: "opencode", agent_session_id: NATIVE_SESSION, state });
  const untilStatus = async (status: string, ...or: string[]) => {
    for (const deadline = Date.now() + 5_000; ![status, ...or].includes((await sessionSnapshot()).panes.find((pane) => pane.pane_id === nativePane)?.agent_status ?? "");) {
      if (Date.now() > deadline) throw new Error(`the pane did not report ${[status, ...or].join(" or ")}`);
      await Bun.sleep(50);
    }
  };
  /** herdr reports another OpenCode session for the pane while the bridge waits on the service */
  const switchSessionDuringLookup = () => {
    const switched = Promise.withResolvers<void>();
    duringLookup = async () => { await reportSession("ses_contractReplacement", nativePane); switched.resolve(); };
    return switched.promise;
  };

  it("types nothing when the pane's session changes while an immediate send waits on the service", async () => {
    const { ws, frame } = await socket();
    const before = typed().length;
    try {
      await browserCatalog();
      const switched = switchSessionDuringLookup();
      ws.send(JSON.stringify({ type: "submit", id: 3, pane_id: nativePane, text: "@effect apply it", payload: "@effect apply it" }));
      const answer = await frame((message) => message.type === "submit-result" && message.id === 3);
      await switched;
      expect(answer).toMatchObject({ ok: false, code: "pending_target_changed" });
      expect(typed().slice(before)).toBe("");
    } finally {
      duringLookup = undefined;
      ws.close();
      await reportSession(NATIVE_SESSION, nativePane);
    }
  });

  it("types nothing when the pane's session changes while a queued send waits on the service", async () => {
    const { ws, frames, frame } = await socket();
    const before = typed().length;
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: nativePane, cols: 80, rows: 24 }));
      await frame((message) => message.type === "pty-data" && message.pane_id === nativePane);
      await reportState("working");
      await untilStatus("working");
      await browserCatalog();
      ws.send(JSON.stringify({ type: "submit", id: 4, pane_id: nativePane, text: "@effect apply it", payload: "@effect apply it", delivery: "queue" }));
      expect(await frame((message) => message.type === "submit-result" && message.id === 4)).toMatchObject({ ok: true, pending: { state: "queued" } });
      const switched = switchSessionDuringLookup();
      const from = frames.length;
      await reportState("idle");
      await switched;
      // the delivery ends unsent: held for review or removed, never typed
      const ended = await frame((message) => message.type === "pending-messages"
        && ((Array.isArray(message.removed) && message.removed.length > 0)
          || (Array.isArray(message.messages) && (message.messages as { state: string }[]).some((item) => item.state === "held" || item.state === "uncertain"))), from);
      expect(JSON.stringify(ended)).toContain("pending_target_changed");
      expect(typed().slice(before)).toBe("");
    } finally {
      duringLookup = undefined;
      ws.close();
      await reportSession(NATIVE_SESSION, nativePane);
    }
  });

  it("settles a send whose own message arrives before anything after its Enter can run", async () => {
    const { ws, frame } = await socket();
    let settled = 0;
    let started = false;
    // the barrier: once the first key reaches the terminal, no session lookup is answered, and the Enter byte
    // itself releases the send's whole real 2.0.32 event sequence
    onTyped = (chunk) => {
      if (!started) { started = true; withholdLookups = true; }
      if (!chunk.includes("\r") || settled) return;
      const item = { type: "user", payload: { text: "@effect barrier check", skills: [{ id: "effect", name: "effect", mention: { start: 0, end: 7, text: "@effect" }, text: "Use Effect." }] }, delivery: "steer" };
      push("session.inbox.enqueued", { sessionID: NATIVE_SESSION, inboxID: "msg_barrier", item });
      push("session.execution.started", { sessionID: NATIVE_SESSION });
      push("session.inbox.delivered", { sessionID: NATIVE_SESSION, inboxID: "msg_barrier" });
      settled = push("session.execution.succeeded", { sessionID: NATIVE_SESSION });
    };
    try {
      await browserCatalog();
      ws.send(JSON.stringify({ type: "submit", id: 6, pane_id: nativePane, text: "@effect barrier check", payload: "@effect barrier check" }));
      expect(await frame((message) => message.type === "submit-result" && message.id === 6)).toMatchObject({ ok: true });
      const outcome = async () => (((await (await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${nativePane}`)).json()) as { outcomes?: CommandOutcome[] }).outcomes ?? [])
        .find((entry) => entry.text === "@effect barrier check");
      for (const deadline = Date.now() + 5_000; ;) {
        const current = await outcome();
        if (current?.state === "result-observed") {
          expect(current.evidence).toEqual([{ kind: "native", at: new Date(settled).toISOString() }]);
          break;
        }
        if (Date.now() > deadline) throw new Error(`outcome: ${JSON.stringify(current)} (events pushed: ${settled !== 0})`);
        await Bun.sleep(50);
      }
    } finally {
      onTyped = undefined;
      withholdLookups = false;
      for (const release of withheld) release();
      withheld.clear();
      ws.close();
    }
  });

  const outcomesAt = async (port: number, pane: string): Promise<CommandOutcome[]> =>
    ((await (await fetch(`http://127.0.0.1:${port}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { outcomes?: CommandOutcome[] }).outcomes ?? [];
  const typedSince = (before: number): Promise<string> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      typedWaiters.delete(check);
      reject(new Error(`typed: ${JSON.stringify(typed().slice(before))}`));
    }, 5_000);
    const check = () => {
      const text = typed().slice(before);
      if (!text.endsWith("\r")) return;
      clearTimeout(timeout);
      typedWaiters.delete(check);
      resolve(text);
    };
    typedWaiters.add(check);
    check();
  });

  /**
   * The stand-in redraws only as it is typed to, so a test that left @effect's row selected (as Tab leaving the skill
   * unconfirmed does) leaves it on screen for the next. A send reads its autocomplete and the agent named beside it
   * from the first screen showing that row, which could then be the old one, not the one its own @effect draws.
   * This draws the prompt with the autocomplete closed: once the stand-in has read its Ctrl-L (typed.log ends with it,
   * written before the redraw) and herdr shows no selected row, every screen after it is the next send's own.
   */
  const closedPrompt = async (): Promise<void> => {
    await herdrRpc("pane.send_text", { pane_id: nativePane, text: "\u000c" });
    for (const deadline = Date.now() + 5_000;;) {
      if (typed().endsWith("\u000c") && !skillRowSelected((await paneRead({ paneId: nativePane, source: "visible", format: "ansi" })).text, "effect")) break;
      if (Date.now() > deadline) throw new Error("the stand-in's closed prompt was not drawn");
      await Bun.sleep(25);
    }
  };

  it("delivers a queued message completely when Tab leaves the skill unconfirmed", async () => {
    const acceptedPath = join(nativeRoot, "accepted.txt");
    const accepted = readFileSync(acceptedPath, "utf8");
    const unconfirmed = readFileSync(join(nativeRoot, "screen.txt"), "utf8");
    const { ws, frame } = await socket();
    const before = typed().length;
    try {
      writeFileSync(acceptedPath, unconfirmed);
      const ready = frame((message) => message.type === "input-ready" && message.pane_id === nativePane);
      ws.send(JSON.stringify({ type: "attach", pane_id: nativePane, cols: 80, rows: 24 }));
      await ready;
      await reportState("working");
      await browserCatalog();
      const queued = frame((message) => message.type === "submit-result" && message.id === 1494);
      ws.send(JSON.stringify({ type: "submit", id: 1494, pane_id: nativePane, text: "@effect fallback", payload: "@effect fallback", delivery: "queue" }));
      expect(await queued).toMatchObject({ ok: true, pending: { state: "queued" } });
      const settled = frame((message) => message.type === "pending-messages" && (
        Array.isArray(message.removed) && message.removed.length > 0
        || Array.isArray(message.messages) && message.messages.some((entry) => entry.state === "uncertain" || entry.state === "held")));
      await reportState("idle");
      const receipt = await settled;
      expect(receipt).toMatchObject({ removed: [{ outcome: "sent" }] });
      expect(await typedSince(before)).toBe("@effect\t\u001b[200~ fallback\u001b[201~\r");
      const outcome = (await outcomesAt(server.port, nativePane)).find((entry) => entry.text === "@effect fallback");
      expect(outcome).toMatchObject({ state: "terminal-required", unattached_skills: ["effect"] });
    } finally {
      writeFileSync(acceptedPath, accepted);
      ws.close();
      await reportState("idle");
    }
  });

  it.each(["immediate", "queue"] as const)("refuses a confirmed Tab agent switch during %s delivery without Enter", async (delivery) => {
    const selectedPath = join(nativeRoot, "screen.txt");
    const acceptedPath = join(nativeRoot, "accepted.txt");
    const selected = readFileSync(selectedPath, "utf8");
    const accepted = readFileSync(acceptedPath, "utf8");
    const { ws, frame } = await socket();
    await closedPrompt();
    const before = typed().length;
    let uncertainId: string | undefined;
    try {
      await browserCatalog();
      writeFileSync(selectedPath, selected.replace("MiniMax", "Build · MiniMax"));
      writeFileSync(acceptedPath, accepted.replace("MiniMax", "Plan · MiniMax"));
      if (delivery === "queue") {
        const ready = frame((message) => message.type === "input-ready" && message.pane_id === nativePane);
        ws.send(JSON.stringify({ type: "attach", pane_id: nativePane, cols: 80, rows: 24 }));
        await ready;
        const working = frame((message) => message.type === "pane-status" && message.pane_id === nativePane && message.agent_status === "working");
        await reportState("working");
        await working;
      }
      const submitted = frame((message) => message.type === "submit-result" && message.id === 1493);
      ws.send(JSON.stringify({ type: "submit", id: 1493, pane_id: nativePane, text: "@effect switched agent", payload: "@effect switched agent", ...(delivery === "queue" ? { delivery } : {}) }));
      if (delivery === "queue") {
        expect(await submitted).toMatchObject({ ok: true, pending: { state: "queued" } });
        const refused = frame((message) => message.type === "pending-messages" && Array.isArray(message.messages)
          && message.messages.some((entry) => entry.state === "uncertain" && entry.error?.code === "submit_changed"));
        await reportState("idle");
        const result = await refused;
        const item = (result.messages as Array<{ id: string; state: string; error?: { code: string; message: string } }>).find((entry) => entry.state === "uncertain");
        uncertainId = item?.id;
        expect(item?.error).toMatchObject({ code: "submit_changed" });
        expect(item?.error?.message).toContain(JSON.stringify("Build"));
        expect(item?.error?.message).toContain(JSON.stringify("Plan"));
      } else {
        const result = await submitted;
        expect(result).toMatchObject({ ok: false, code: "submit_changed" });
        expect(result.message).toEqual(expect.stringContaining(JSON.stringify("Build")));
        expect(result.message).toEqual(expect.stringContaining(JSON.stringify("Plan")));
      }
      expect(typed().slice(before)).toBe("@effect\t");
      const outcome = (await outcomesAt(server.port, nativePane)).find((entry) => entry.text === "@effect switched agent");
      expect(outcome).toBeUndefined();
    } finally {
      writeFileSync(selectedPath, selected);
      writeFileSync(acceptedPath, accepted);
      // an uncertain message holds every later queued send to this shared pane until it is discarded
      if (uncertainId) {
        const discarded = frame((message) => message.type === "pending-result" && message.id === 1495);
        ws.send(JSON.stringify({ type: "pending-action", id: 1495, pane_id: nativePane, pending_id: uncertainId, action: "discard" }));
        expect(await discarded).toMatchObject({ ok: true });
      }
      ws.close();
      await reportState("idle");
    }
  });

  it("attaches @effect and records the send after the pane's OpenCode session changed, with no catalog request since", async () => {
    const { ws, frame } = await socket();
    const before = typed().length;
    try {
      // the composer fetched the catalog for the old session and does not refetch on a session change
      await browserCatalog();
      extraSessions.add("ses_contractNative02");
      await reportSession("ses_contractNative02", nativePane);
      ws.send(JSON.stringify({ type: "submit", id: 7, pane_id: nativePane, text: "@effect after switch", payload: "@effect after switch" }));
      expect(await frame((message) => message.type === "submit-result" && message.id === 7)).toMatchObject({ ok: true });
      expect(await typedSince(before)).toBe("@effect\t\u001b[200~after switch\u001b[201~\r");
      const outcome = (await outcomesAt(server.port, nativePane)).find((entry) => entry.text === "@effect after switch");
      expect(outcome?.state).toBe("accepted");
      expect(outcome?.note).toBeUndefined();
    } finally {
      ws.close();
      await reportSession(NATIVE_SESSION, nativePane);
    }
  });

  it("attaches @effect and records the send on a fresh server that never served a catalog", async () => {
    const created = await workspaceCreate({ cwd: nativeRoot, label: "ovis-test-opencode-native-fresh" });
    workspaces.push(created.workspace.workspace_id);
    const freshPane = created.root_pane.pane_id;
    await herdrRpc("pane.send_text", { pane_id: freshPane, text: `exec ${standIn}\n` });
    for (const deadline = Date.now() + 10_000; (await sessionSnapshot()).panes.find((pane) => pane.pane_id === freshPane)?.agent !== "opencode";) {
      if (Date.now() > deadline) throw new Error("fresh stand-in opencode did not start");
      await Bun.sleep(50);
    }
    extraSessions.add("ses_contractFresh01");
    await reportSession("ses_contractFresh01", freshPane);
    // a bridge started after the tab: nothing remembered for this pane
    const fresh = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-fresh") });
    const ws = new WebSocket(`ws://127.0.0.1:${fresh.port}/ws`);
    const result = Promise.withResolvers<Record<string, unknown>>();
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === "submit-result" && frame.id === 8) result.resolve(frame);
    });
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    const before = typed().length;
    try {
      ws.send(JSON.stringify({ type: "submit", id: 8, pane_id: freshPane, text: "@effect fresh start", payload: "@effect fresh start" }));
      expect(await result.promise).toMatchObject({ ok: true });
      expect(await typedSince(before)).toBe("@effect\t\u001b[200~fresh start\u001b[201~\r");
      const outcome = (await outcomesAt(fresh.port, freshPane)).find((entry) => entry.text === "@effect fresh start");
      expect(outcome?.state).toBe("accepted");
    } finally {
      ws.close();
      fresh.stop();
    }
  });

  it("types within the attach budget without inventing a skill record when a cold service hangs", async () => {
    const { ws, frame } = await socket();
    const before = typed().length;
    const first = Promise.withResolvers<boolean>();
    const hung = Promise.withResolvers<void>();
    const budget = Promise.withResolvers<() => void>();
    let expired = false;
    const realSetTimeout = globalThis.setTimeout;
    const realTimeout = AbortSignal.timeout;
    const deadline = Promise.withResolvers<never>();
    const deadlineTimer = realSetTimeout(() => {
      deadline.reject(new Error("OpenCode attach budget or hung request was not observed"));
    }, 10_000);
    const ready = Promise.race([Promise.all([budget.promise, hung.promise]), deadline.promise]);
    // Hold only the aggregate attach timer; all delivery and test deadlines remain real.
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(Object.assign((...[callback, delay, ...args]: Parameters<typeof setTimeout>) => {
      if (delay !== CATALOG_SOURCE_BUDGET_MS) return realSetTimeout(callback, delay, ...args);
      const handle = realSetTimeout(callback, delay, ...args);
      clearTimeout(handle);
      budget.resolve(() => { expired = true; callback(...args); });
      return handle;
    }, realSetTimeout));
    // The individual HTTP timeout must not rescue a missing aggregate budget.
    const httpTimeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === OPENCODE_HTTP_TIMEOUT_MS ? new AbortController().signal : realTimeout(ms));
    try {
      closeOpenCodeNative();
      forgetOpenCodeService();
      extraSessions.add("ses_contractHang01");
      await reportSession("ses_contractHang01", nativePane);
      hangAll = true;
      onHungRequest = () => hung.resolve();
      // Reports can arrive out of order; only this send's first byte counts.
      onTyped = (_chunk, start) => { if (start === before) first.resolve(expired); };
      ws.send(JSON.stringify({ type: "submit", id: 9, pane_id: nativePane, text: "@effect while hung", payload: "@effect while hung" }));
      const [expire] = await ready;
      expect(typed().length).toBe(before);
      expire();
      timers.mockRestore();
      httpTimeout.mockRestore();
      expect(await frame((message) => message.type === "submit-result" && message.id === 9)).toMatchObject({ ok: true });
      expect(await Promise.race([first.promise, deadline.promise])).toBe(true);
      const sent = await typedSince(before);
      expect(sent.startsWith("@effect\t")).toBe(false);
      expect(sent).toContain("@effect while hung");
      const outcome = (await outcomesAt(server.port, nativePane)).find((entry) => entry.text === "@effect while hung");
      expect(outcome).toBeUndefined();
    } finally {
      clearTimeout(deadlineTimer);
      timers.mockRestore();
      httpTimeout.mockRestore();
      hangAll = false;
      onHungRequest = undefined;
      onTyped = undefined;
      for (const release of withheld) release();
      withheld.clear();
      ws.close();
      await reportSession(NATIVE_SESSION, nativePane);
      closeOpenCodeNative();
      forgetOpenCodeService();
    }
  });

  it("reads only its own server's OpenCode state, never the default one, for the list, a cold send and its watch", async () => {
    // the default location (what a server without its own state would read) names a service that counts every request
    let defaultAsked = 0;
    const decoy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { defaultAsked++; return Response.json({ version: "2.0.32", pid: process.pid }); } });
    const xdg = mkdtempSync(join(tmpdir(), "ovis-opencode-default-state-"));
    mkdirSync(join(xdg, "opencode"));
    writeFileSync(join(xdg, "opencode", "service.json"), JSON.stringify({ url: decoy.url.origin, pid: process.pid, password: "decoy", version: "2.0.32" }));
    const previousXdg = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = xdg;
    delete openCodeServiceOptions.stateDir;
    closeOpenCodeNative();
    forgetOpenCodeService();
    const own = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state-own"), openCodeStateDir: nativeRoot });
    const ws = new WebSocket(`ws://127.0.0.1:${own.port}/ws`);
    const result = Promise.withResolvers<Record<string, unknown>>();
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type === "submit-result" && frame.id === 11) result.resolve(frame);
    });
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
    const before = typed().length;
    try {
      extraSessions.add("ses_contractOwnState01");
      await reportSession("ses_contractOwnState01", nativePane);
      const listed = await (await fetch(`http://127.0.0.1:${own.port}/api/pane/commands?pane_id=${encodeURIComponent(nativePane)}`)).json() as { commands: SlashCommand[] };
      expect(listed.commands.find((row) => row.name === "shipit")?.provenance?.transport).toBe("native");
      // a new session after the list: the send is cold again and looks the service up itself
      extraSessions.add("ses_contractOwnState02");
      await reportSession("ses_contractOwnState02", nativePane);
      ws.send(JSON.stringify({ type: "submit", id: 11, pane_id: nativePane, text: "@effect from own state", payload: "@effect from own state" }));
      expect(await result.promise).toMatchObject({ ok: true });
      expect(await typedSince(before)).toBe("@effect\t\u001b[200~from own state\u001b[201~\r");
      expect((await outcomesAt(own.port, nativePane)).find((entry) => entry.text === "@effect from own state")?.state).toBe("accepted");
      expect(defaultAsked).toBe(0);
    } finally {
      ws.close();
      own.stop();
      decoy.stop(true);
      if (previousXdg === undefined) delete process.env["XDG_STATE_HOME"]; else process.env["XDG_STATE_HOME"] = previousXdg;
      rmSync(xdg, { recursive: true, force: true });
      openCodeServiceOptions.stateDir = nativeRoot;
      closeOpenCodeNative();
      forgetOpenCodeService();
      await reportSession(NATIVE_SESSION, nativePane);
    }
  });

  it("reads a cold @ send by the v1 rule when the running v2 service says the pane's session is not its own", async () => {
    const { ws, frame } = await socket();
    const before = typed().length;
    try {
      closeOpenCodeNative();
      forgetOpenCodeService();
      // a pane whose OpenCode is not this service's (an OpenCode 1.x TUI, say): the service answers 404 for its session
      await reportSession("ses_contractNotHeld01", nativePane);
      ws.send(JSON.stringify({ type: "submit", id: 12, pane_id: nativePane, text: "@effect not this service", payload: "@effect not this service" }));
      expect(await frame((message) => message.type === "submit-result" && message.id === 12)).toMatchObject({ ok: true });
      const sent = await typedSince(before);
      expect(sent.startsWith("@effect\t")).toBe(false);
      // its '@' names a file there: no skill, so no record and no not-attached note
      expect((await outcomesAt(server.port, nativePane)).find((entry) => entry.text === "@effect not this service")).toBeUndefined();
    } finally {
      ws.close();
      await reportSession(NATIVE_SESSION, nativePane);
      closeOpenCodeNative();
      forgetOpenCodeService();
    }
  });

  it("answers the catalog and a cold @ send without opening an opencode.json that is a FIFO", async () => {
    const fifo = join(nativeRoot, "opencode.json");
    expect(await Bun.spawn(["mkfifo", fifo]).exited).toBe(0);
    // A writer waits at the FIFO from the start: its open returns only once something opens the FIFO to read,
    // and that first reader is handed its text. A server that read opencode.json would be handed it at once,
    // so nothing here waits on the FIFO and no time is counted: who got the text is the proof.
    const text = crypto.randomUUID();
    const writer = Bun.spawn(["sh", "-c", 'echo ready; printf %s "$2" > "$1"', "sh", fifo, text], { stdout: "pipe" });
    // It waits there before anything below asks the server: it says so, and then sleeps in its open (where
    // the system tells a process's state). A read made before it waited would find no writer and go unseen.
    expect(new TextDecoder().decode((await writer.stdout.getReader().read()).value)).toBe("ready\n");
    for (const until = Date.now() + 5_000; existsSync(`/proc/${writer.pid}/stat`);) {
      const stat = readFileSync(`/proc/${writer.pid}/stat`, "utf8");
      if (stat.charAt(stat.lastIndexOf(") ") + 2) === "S") break;
      if (Date.now() > until) throw new Error("the FIFO's writer never waited in its open");
      await new Promise((resolve) => setImmediate(resolve));
    }
    const { ws, frame } = await socket();
    const before = typed().length;
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/commands?pane_id=${encodeURIComponent(nativePane)}`);
      expect(response.status).toBe(200);
      // a cold send to a hung service must not scan opencode.json or invent a skill record
      closeOpenCodeNative();
      forgetOpenCodeService();
      extraSessions.add("ses_contractFifo01");
      await reportSession("ses_contractFifo01", nativePane);
      hangAll = true;
      ws.send(JSON.stringify({ type: "submit", id: 10, pane_id: nativePane, text: "@effect past the fifo", payload: "@effect past the fifo" }));
      expect(await frame((message) => message.type === "submit-result" && message.id === 10)).toMatchObject({ ok: true });
      expect(await typedSince(before)).toContain("@effect past the fifo");
      const outcome = (await outcomesAt(server.port, nativePane)).find((entry) => entry.text === "@effect past the fifo");
      expect(outcome).toBeUndefined();
      // The first to open the FIFO is this read (O_NONBLOCK: it waits for no writer): the writer was still
      // waiting, and its text comes here. After any earlier open the writer has left and there is none.
      const fd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        await writer.exited;
        const handed = Buffer.alloc(text.length + 1);
        expect(handed.subarray(0, readSync(fd, handed)).toString()).toBe(text);
      } finally { closeSync(fd); }
    } finally {
      writer.kill();
      rmSync(fifo, { force: true });
      hangAll = false;
      for (const release of withheld) release();
      withheld.clear();
      ws.close();
      await reportSession(NATIVE_SESSION, nativePane);
      closeOpenCodeNative();
      forgetOpenCodeService();
    }
  });

  it("never waits on the event stream before the first key, in all three delivery paths", async () => {
    const { ws, frame } = await socket();
    const gaps: Record<string, number> = {};
    let id = 100;
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: nativePane, cols: 80, rows: 24 }));
      await frame((message) => message.type === "pty-data" && message.pane_id === nativePane);
      for (const mode of ["slow", "absent", "error"] as const) {
        for (const path of ["immediate", "queued", "prompt"] as const) {
          // no stream open yet: a watcher that waited for one would wait here, before the first key
          closeOpenCodeNative();
          forgetOpenCodeService();
          eventMode = mode;
          const typedFirst = Promise.withResolvers<number>();
          const text = path === "prompt" ? `/review ${mode}` : `@effect ${path} ${mode}`;
          const request = ++id;
          if (path === "queued") {
            await reportState("working");
            await untilStatus("working");
          }
          const before = typed().length;
          // Measured from the last thing this send itself waited on before its first byte: its submit, the
          // queued send's idle report, or a request of the bridge's. A send that types before asking the
          // service anything (a /command) was measured from the previous send's requests (#2143).
          // Reports can arrive out of order; identify this send's first byte, regardless of chunking.
          let since = performance.timeOrigin + performance.now();
          requestsAt.length = 0;
          onTyped = (_chunk, start, at) => {
            if (start === before) typedFirst.resolve(at - Math.max(since, ...requestsAt.filter((requestAt) => requestAt <= at)));
          };
          const completed = typedSince(before);
          ws.send(JSON.stringify({ type: "submit", id: request, pane_id: nativePane, text, payload: text, ...(path === "queued" ? { delivery: "queue" } : {}) }));
          const answer = await frame((message) => message.type === "submit-result" && message.id === request);
          expect(answer).toMatchObject({ ok: true });
          if (path === "queued") {
            since = performance.timeOrigin + performance.now();
            await reportState("idle");
          }
          gaps[`${path}/${mode}`] = Math.round(await typedFirst.promise);
          // Keep this delivery's observer and service alive until its whole send has reached the TUI.
          await completed;
          if (path === "queued") await frame((message) => message.type === "pending-messages"
            && Array.isArray(message.removed) && message.removed.some((item) => item.id === (answer.pending as { id: string }).id));
          onTyped = undefined;
          for (const release of withheld) release();
          withheld.clear();
        }
      }
      console.log(`first-key gaps (ms): ${JSON.stringify(gaps)}`);
      // the old watcher waited up to 1.5 s for the stream here; the bound leaves room for a loaded host
      expect(Object.entries(gaps).filter(([, gap]) => gap >= 1_000)).toEqual([]);
    } finally {
      eventMode = "ok";
      onTyped = undefined;
      for (const release of withheld) release();
      withheld.clear();
      ws.close();
    }
  }, 90_000);

  it("closes the shared stream when its last verified pane ends or stops being OpenCode", async () => {
    const lifecycleRoot = join(nativeRoot, "lifecycle");
    mkdirSync(join(lifecycleRoot, "bin"), { recursive: true });
    const sleeper = join(lifecycleRoot, "bin", "opencode");
    writeFileSync(sleeper, "#!/bin/sh\nsleep 600\n");
    chmodSync(sleeper, 0o755);
    // An OpenCode that leaves when the test says so. A ctrl+c typed into its pane is not sure to end it:
    // in a loaded CI run herdr never saw the stand-in go, and the pane stayed OpenCode until it closed.
    mkdirSync(join(lifecycleRoot, "leaving"), { recursive: true });
    const leaver = join(lifecycleRoot, "leaving", "opencode");
    const leave = join(lifecycleRoot, "leave.fifo");
    expect(await Bun.spawn(["mkfifo", leave]).exited).toBe(0);
    writeFileSync(leaver, `#!/bin/sh\nread _ < '${leave}'\n`);
    chmodSync(leaver, 0o755);
    let opened = Promise.withResolvers<void>();
    let closed = Promise.withResolvers<void>();
    const sessions = new Set(["ses_lifecycleEnd", "ses_lifecycleAgent", "ses_lifecycleHandover"]);
    // idleTimeout 0: a quiet event stream is closed only by the bridge, never by the fake itself
    const second = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/info") return Response.json({ version: "2.0.32", pid: process.pid, urls: [], paths: { tmp: lifecycleRoot } });
      const session = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      if (url.pathname.startsWith("/api/session/") && sessions.has(session)) return Response.json({ data: { id: session } });
      const directory = url.searchParams.get("location[directory]");
      if (url.pathname === "/api/command") return Response.json({ location: { directory }, data: [] });
      if (url.pathname === "/api/skill") return Response.json({ location: { directory }, data: [{ id: "effect", name: "effect", path: "/builtin/effect.md", content: "x" }] });
      if (url.pathname === "/api/event") {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode("data: {\"type\":\"server.connected\",\"data\":{}}\n\n")); opened.resolve(); },
          cancel() { closed.resolve(); },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(null, { status: 404 });
    } });
    writeFileSync(join(lifecycleRoot, "service.json"), JSON.stringify({ url: second.url.origin, pid: process.pid, password: "lifecycle", version: "2.0.32" }));
    const within = <T>(promise: Promise<T>, what: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen (native ${JSON.stringify(openCodeNativeState())})`)), 15_000); })]).finally(() => clearTimeout(timer));
    };
    const startPane = async (session: string, program = sleeper): Promise<{ paneId: string; workspaceId: string }> => {
      const created = await workspaceCreate({ cwd: lifecycleRoot, label: `ovis-test-opencode-${session}` });
      // closed at the end even when its start fails: a stand-in waiting on the FIFO never ends by itself
      started.push(created.workspace.workspace_id);
      const paneId = created.root_pane.pane_id;
      await herdrRpc("pane.send_text", { pane_id: paneId, text: `${program}\n` });
      for (const deadline = Date.now() + 10_000; (await sessionSnapshot()).panes.find((pane) => pane.pane_id === paneId)?.agent !== "opencode";) {
        if (Date.now() > deadline) throw new Error("stand-in opencode not detected");
        await Bun.sleep(50);
      }
      await reportSession(session, paneId);
      return { paneId, workspaceId: created.workspace.workspace_id };
    };
    const verify = async (paneId: string): Promise<void> => {
      const context = await paneContext(paneId);
      const rows = await mergeCatalogSources("opencode", context.pane, lifecycleRoot, []);
      expect(rows.some((row) => row.name === "effect" && row.provenance?.transport === "native")).toBe(true);
    };
    closeOpenCodeNative();
    forgetOpenCodeService();
    openCodeServiceOptions.stateDir = lifecycleRoot;
    const started: string[] = [];
    let leaving: ReturnType<typeof Bun.spawn> | undefined;
    try {
      // pane end: herdr's pane.ended reaches the collector's onPaneEnded
      const ending = await startPane("ses_lifecycleEnd");
      await verify(ending.paneId);
      await within(opened.promise, "the stream opening for the first pane");
      expect(openCodeNativeState()).toEqual({ stream: true, panes: [ending.paneId] });
      await workspaceClose(ending.workspaceId);
      await within(closed.promise, "the stream closing after the last verified pane ended");
      expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });

      // agent change: OpenCode leaves the pane, so its status names no opencode agent any more
      opened = Promise.withResolvers<void>();
      closed = Promise.withResolvers<void>();
      const changing = await startPane("ses_lifecycleAgent", leaver);
      await verify(changing.paneId);
      await within(opened.promise, "the stream opening for the second pane");
      leaving = Bun.spawn(["sh", "-c", `printf '\\n' > '${leave}'`]);
      await within(leaving.exited, "the stand-in OpenCode being told to leave");
      await within(closed.promise, "the stream closing after the last verified pane stopped being OpenCode");
      expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });

      // a replacement server, started before the old one stops (the last server's stop releases every pane):
      // its collector learns the pane verified before it started, and ends it
      opened = Promise.withResolvers<void>();
      closed = Promise.withResolvers<void>();
      const handed = await startPane("ses_lifecycleHandover");
      await verify(handed.paneId);
      await within(opened.promise, "the stream opening for the handed-over pane");
      const replaced = server;
      server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), opencodeDb: database });
      await server.statusReady;
      replaced.stop();
      expect(openCodeNativeState()).toEqual({ stream: true, panes: [handed.paneId] });
      await workspaceClose(handed.workspaceId);
      await within(closed.promise, "the stream closing after the replacement collector saw the pane close");
      expect(openCodeNativeState()).toEqual({ stream: false, panes: [] });
    } finally {
      // the ones the test closed already answer with an error
      for (const workspaceId of started) await workspaceClose(workspaceId).catch(() => {});
      leaving?.kill();
      rmSync(leave, { force: true });
      closeOpenCodeNative();
      second.stop(true);
      openCodeServiceOptions.stateDir = nativeRoot;
      forgetOpenCodeService();
    }
  }, 60_000);
});
