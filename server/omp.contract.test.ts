import { afterAll, beforeAll, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "./index.ts";
import { type EventFrame, herdrRpc, type HerdrSubscription, paneProcessInfo, sessionSnapshot, subscribeEvents, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { agentProcesses } from "./conversation.ts";
import type { ConversationResponse, InteractivePrompt } from "../shared/protocol.ts";

// omp names its session file when it starts and writes it with the first message (seen on a
// fresh omp pane: herdr held the path, the file was not there). A fake omp stands in.
const root = mkdtempSync(join(tmpdir(), "ovis-omp-contract-"));
const slug = join(root, ".omp", "agent", "sessions", "-omp-contract");
const fresh = join(slug, "2026-10-06T00-00-00-000Z_omp-fresh.jsonl");
const originalHome = process.env["HOME"];
let workspaceId: string | undefined;
let paneId: string;
let handoffPaneId: string;
// omp 18.8.7's /handoff as recorded (server/fixtures/omp-handoff-18.8.7-*): a stand-in draws the
// "Generating handoff" status and, on Esc, the cancelled screen, then notes the key it got.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/omp-handoff-18.8.7-${name}`, import.meta.url), "utf8");
const recorded = fixture("session.jsonl").split("\n").filter(Boolean);
const compaction = recorded.find((line) => JSON.parse(line).type === "compaction")!;
const handoffSession = join(slug, "2026-10-20T09-51-33-687Z_omp-handoff.jsonl");
const handoffMarker = join(root, "handoff-keys");
const HANDOFF = `
const { readFileSync, writeFileSync } = require("node:fs");
const [generating, cancelled, marker] = process.argv.slice(2);
const draw = (file) => process.stdout.write("\\x1b[2J\\x1b[H" + readFileSync(file, "utf8").replace(/\\n$/, "").split("\\n").join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  if (!data.includes(0x1b)) return;
  // the key is noted before the screen that says so, which the test waits for
  writeFileSync(marker, JSON.stringify([...data]));
  draw(cancelled);
});
draw(generating);
`;
// omp 18.13.2's Ask with Markdown in its question and options as recorded (server/fixtures/omp-ask-18.13.2-md-*):
// a stand-in draws the screen and notes every key it gets; the session file holds the call it draws
const askSession = join(slug, "2026-10-28T06-38-25-019Z_omp-ask.jsonl");
const askMarker = join(root, "ask-keys");
const ASK = `
const { appendFileSync, readFileSync } = require("node:fs");
const [screen, moved, marker] = process.argv.slice(2);
const draw = (file) => process.stdout.write("\\x1b[2J\\x1b[H" + readFileSync(file, "utf8").replace(/\\n$/, "").split("\\n").join("\\r\\n"));
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (data) => {
  appendFileSync(marker, data);
  if (data.includes(0x0d)) process.stdout.write("\\x1b[2J\\x1b[HAnswered.\\r\\n");
  else if (/\\x1b(?:\\[|O)B/.test(data.toString("latin1"))) draw(moved);
});
draw(screen);
`;
let askWorkspaceId: string | undefined;
let askPaneId: string;
let server: ReturnType<typeof createServer>;
let seq = Date.now() * 1000;

beforeAll(async () => {
  mkdirSync(slug, { recursive: true });
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const fakeOmp = join(bin, "omp");
  writeFileSync(fakeOmp, "#!/bin/sh\nsleep 600\n");
  chmodSync(fakeOmp, 0o755);
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-omp-contract" });
  workspaceId = created.workspace.workspace_id;
  paneId = created.root_pane.pane_id;
  await herdrAfter([{ type: "pane.agent_status_changed", pane_id: paneId }], () => herdrRpc("pane.send_text", { pane_id: paneId, text: `${fakeOmp}\n` }),
    "saw the stand-in omp", (events) => events.some((event) => event.data?.["agent"] === "omp"));
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "herdr:omp", agent: "omp", state: "idle", seq: ++seq });
  await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:omp", agent: "omp", seq: ++seq, agent_session_path: fresh, session_start_source: "startup" });
  writeFileSync(handoffSession, recorded.filter((line) => line !== compaction)
    .map((line) => JSON.parse(line).type === "session" ? JSON.stringify({ ...JSON.parse(line), cwd: root }) : line).join("\n") + "\n");
  writeFileSync(join(root, "handoff.js"), HANDOFF);
  const handoffBin = join(root, "handoff-bin");
  mkdirSync(handoffBin, { recursive: true });
  copyFileSync(process.execPath, join(handoffBin, "omp"));
  chmodSync(join(handoffBin, "omp"), 0o755);
  const split = await herdrRpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: paneId, direction: "down", focus: false });
  handoffPaneId = split.pane.pane_id;
  const screens = ["generating-narrow.txt", "cancelled-narrow.txt"].map((name) => fileURLToPath(new URL(`./fixtures/omp-handoff-18.8.7-${name}`, import.meta.url)));
  await herdrAfter([drawnOn(handoffPaneId, "Generating handoff"), { type: "pane.agent_status_changed", pane_id: handoffPaneId }],
    () => herdrRpc("pane.send_text", { pane_id: handoffPaneId, text: `HOME='${root}' exec '${join(handoffBin, "omp")}' '${join(root, "handoff.js")}' '${screens[0]}' '${screens[1]}' '${handoffMarker}'\n` }),
    "drew the stand-in's handoff status and saw its omp",
    (events) => events.some((event) => event.event === "pane.output_matched")
      && events.some((event) => event.event === "pane.agent_status_changed" && event.data?.["agent"] === "omp"));
  await herdrRpc("pane.report_agent", { pane_id: handoffPaneId, source: "herdr:omp", agent: "omp", state: "idle", seq: ++seq });
  await herdrRpc("pane.report_agent_session", { pane_id: handoffPaneId, source: "herdr:omp", agent: "omp", seq: ++seq, agent_session_path: handoffSession, session_start_source: "startup" });
  writeFileSync(askSession, readFileSync(new URL("./fixtures/omp-ask-18.13.2-md-open.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).type === "session" ? JSON.stringify({ ...JSON.parse(line), cwd: root }) : line).join("\n") + "\n");
  writeFileSync(join(root, "ask.js"), ASK);
  const asking = await workspaceCreate({ cwd: root, label: "ovis-test-omp-ask-contract" });
  askWorkspaceId = asking.workspace.workspace_id;
  askPaneId = asking.root_pane.pane_id;
  const askScreen = fileURLToPath(new URL("./fixtures/omp-ask-18.13.2-md-single-60.txt", import.meta.url));
  // omp moves its cursor (`\u276f`) to the next row on Down
  const movedScreen = join(root, "ask-moved.txt");
  writeFileSync(movedScreen, readFileSync(askScreen, "utf8").replace("\u2502 \u276f \u25cb Use local socket", "\u2502   \u25cb Use local socket").replace("\u2502   \u25cb Remote relay", "\u2502 \u276f \u25cb Remote relay"));
  // herdr takes a report for a pane only once it has seen the pane's omp itself, which it announces
  await herdrAfter([drawnOn(askPaneId, "Which route should carry"), { type: "pane.agent_status_changed", pane_id: askPaneId }],
    () => herdrRpc("pane.send_text", { pane_id: askPaneId, text: `HOME='${root}' exec '${join(handoffBin, "omp")}' '${join(root, "ask.js")}' '${askScreen}' '${movedScreen}' '${askMarker}'\n` }),
    "drew the stand-in's Ask panel and saw its omp",
    (events) => events.some((event) => event.event === "pane.output_matched")
      && events.some((event) => event.event === "pane.agent_status_changed" && event.data?.["agent"] === "omp"));
  await herdrRpc("pane.report_agent", { pane_id: askPaneId, source: "herdr:omp", agent: "omp", state: "blocked", seq: ++seq });
  await herdrRpc("pane.report_agent_session", { pane_id: askPaneId, source: "herdr:omp", agent: "omp", seq: ++seq, agent_session_path: askSession, session_start_source: "startup" });
  process.env["HOME"] = root;
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  // herdr takes a few seconds to see each stand-in's omp; every wait above is bounded on its own
}, 30_000);

afterAll(async () => {
  server?.stop();
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  if (workspaceId) await workspaceClose(workspaceId);
  if (askWorkspaceId) await workspaceClose(askWorkspaceId);
  rmSync(root, { recursive: true, force: true });
});

const read = async (pane = paneId): Promise<ConversationResponse> => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/conversation?pane_id=${encodeURIComponent(pane)}`);
  expect(response.status).toBe(200);
  return await response.json() as ConversationResponse;
};

it("answers a session omp has not written yet as an empty conversation, then follows the file it writes", async () => {
  expect(await read()).toMatchObject({ source: "omp-transcript", turns: [], cursor: null, history_id: "unwritten:2026-10-06T00-00-00-000Z_omp-fresh" });
  writeFileSync(fresh, [
    { type: "session", version: 3, id: "omp-fresh", timestamp: new Date().toISOString(), cwd: root },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-06T00:00:01Z", message: { role: "user", content: [{ type: "text", text: "First prompt" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-06T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "First answer" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const written = await read();
  expect(written.source).toBe("omp-transcript");
  expect(written.history_id).not.toBe("unwritten:2026-10-06T00-00-00-000Z_omp-fresh");
  expect(written.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
});

function drawnOn(pane: string, text: string): HerdrSubscription {
  return { type: "pane.output_matched", pane_id: pane, source: "visible", match: { type: "substring", value: text } };
}

function herdrAfter(subscriptions: HerdrSubscription[], trigger: () => unknown, what: string, done: (events: EventFrame[]) => boolean = (events) => events.length > 0): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let over = false;
    const events: EventFrame[] = [];
    const finish = (error?: Error) => { if (over) return; over = true; clearTimeout(timer); subscription.close(); if (error) reject(error); else resolve(); };
    const subscription = subscribeEvents(subscriptions, {
      onStarted: () => { Promise.resolve().then(trigger).catch((error: Error) => finish(error)); },
      onEvent: (event) => { events.push(event); if (done(events)) finish(); },
      onError: (error) => finish(error),
    });
    const timer = setTimeout(() => finish(new Error(`herdr never ${what}`)), 10_000);
  });
}

async function promptOf(pane: string): Promise<InteractivePrompt | null> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`);
  expect(response.status).toBe(200);
  return (await response.json() as { prompt: InteractivePrompt | null }).prompt;
}

it("cancels omp's /handoff from its card, and keeps the same conversation when a handoff compacts it in place", async () => {
  const original = readFileSync(handoffSession, "utf8");
  const before = await read(handoffPaneId);
  expect(before.source).toBe("omp-transcript");
  expect(before.turns.filter((turn) => turn.role === "user")).toHaveLength(2);

  const card = await promptOf(handoffPaneId);
  expect(card).toMatchObject({ agent: "omp", question: "Generating handoff…", options: [{ label: "Cancel", description: null }] });
  let answering!: Promise<Response>;
  await herdrAfter([drawnOn(handoffPaneId, "Handoff cancelled")], () => {
    answering = fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: handoffPaneId, prompt_id: card!.id, option_index: 0 }),
    });
  }, "drew the stand-in's cancelled handoff");
  expect((await answering).status).toBe(200);
  expect(JSON.parse(readFileSync(handoffMarker, "utf8"))).toEqual([0x1b]);
  expect(await promptOf(handoffPaneId)).toBeNull();
  expect(readFileSync(handoffSession, "utf8")).toBe(original);
  expect((await read(handoffPaneId)).history_id).toBe(before.history_id);

  // a finished handoff appends its compaction entry to the same session file
  appendFileSync(handoffSession, compaction + "\n");
  const after = await read(handoffPaneId);
  expect(after.history_id).toBe(before.history_id);
  expect(after.turns.slice(0, before.turns.length)).toEqual(before.turns);
});

it("shows an omp Ask card in the open call's Markdown, answered by the keys of the menu on screen (#1644)", async () => {
  const card = await promptOf(askPaneId);
  expect(card).toMatchObject({
    agent: "omp", text_format: "markdown", custom_option_index: 2,
    question: "Which **route** should carry the `fixture` session? See [the guide](https://example.com/guide).",
    options: [
      { label: "Use `local` socket", description: "Keeps the **session** on *this* PC." },
      { label: "Remote relay", description: "Goes through [the relay](https://example.com/relay) with `ssh`." },
    ],
  });

  const open = readFileSync(askSession, "utf8");
  appendFileSync(askSession, JSON.stringify({ type: "message", id: "r1", parentId: "c328f4b1", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "omp-md-ask", toolName: "ask", content: [{ type: "text", text: "answered" }] } }) + "\n");
  const drawn = await promptOf(askPaneId);
  expect(drawn?.text_format).toBeUndefined();
  expect(drawn).toMatchObject({ question: "Which route should carry the fixture session? See the guide (https://example.com/guide).", options: [{ label: "Use local socket" }, { label: "Remote relay" }] });
  writeFileSync(askSession, open);

  const rich = await promptOf(askPaneId);
  expect(rich?.text_format).toBe("markdown");
  expect(rich!.id).toBe(card!.id);
  let answering!: Promise<Response>;
  await herdrAfter([drawnOn(askPaneId, "Answered.")], () => {
    answering = fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: askPaneId, prompt_id: rich!.id, option_index: 1 }),
    });
  }, "drew the stand-in's answer");
  const answered = await answering;
  expect(answered.status, await answered.text()).toBe(200);
  expect(readFileSync(askMarker, "latin1")).toMatch(/^\x1b(?:\[|O)B\r$/);
});

// herdr 0.9.5 keeps naming a pane omp while its omp is stopped behind the shell (job control), and the screen still
// shows omp's last dialog, the same card to the parser: the shell holds the input then, and gets no card and no key
it("offers no card and sends no key while omp is stopped behind its shell, over 18.13's panel and 18.10's", async () => {
  const standIn = join(root, "handoff-bin", "omp");
  for (const [fixture, tail, drawn] of [
    ["omp-approval-18.13.2-unicode-narrow", "\u276f\n FOREIGN-2245\n", "FOREIGN-2245"],
    ["omp-approval-18.10.4-unicode-narrow", null, "approve \u00b7"],
  ] as const) {
    const shown = readFileSync(new URL(`./fixtures/${fixture}.txt`, import.meta.url), "utf8");
    const screen = join(root, `${fixture}.txt`);
    writeFileSync(screen, shown);
    const stale = join(root, `${fixture}-stale.txt`);
    writeFileSync(stale, tail === null ? shown : `${shown.trimEnd().split("\n").slice(0, -2).join("\n")}\n${tail}`);
    const ompKeys = join(root, `${fixture}-omp-keys`);
    const shellKeys = join(root, `${fixture}-shell-keys`);
    const created = await workspaceCreate({ cwd: root, label: `ovis-test-omp-stopped-${fixture}` });
    let pid: number | undefined;
    try {
      const pane = created.root_pane.pane_id;
      await herdrAfter([drawnOn(pane, "Allow tool: bash"), { type: "pane.agent_status_changed", pane_id: pane }],
        () => herdrRpc("pane.send_text", { pane_id: pane, text: `HOME='${root}' '${standIn}' '${join(root, "ask.js")}' '${screen}' '${screen}' '${ompKeys}'\n` }),
        "drew the stand-in's approval panel and saw its omp",
        (events) => events.some((event) => event.event === "pane.output_matched")
          && events.some((event) => event.event === "pane.agent_status_changed" && event.data?.["agent"] === "omp"));
      const live = await promptOf(pane);
      expect(live, fixture).toMatchObject({ kind: "approval", title: "Allow tool: bash" });
      pid = agentProcesses((await paneProcessInfo(pane))?.foreground_processes ?? [], "omp")[0]?.pid;
      expect(pid, fixture).toBeNumber();
      await herdrAfter([drawnOn(pane, "Stopped")], () => process.kill(pid!, "SIGSTOP"), "saw the shell stop the stand-in");
      await herdrAfter([drawnOn(pane, "CLEARED-2245")], () => herdrRpc("pane.send_text", { pane_id: pane, text: "clear; printf 'CLEARED-%s\\n' 2245\n" }), "cleared the screen");
      await herdrAfter([drawnOn(pane, drawn)], () => herdrRpc("pane.send_text", {
        pane_id: pane, text: `clear; cat '${stale}'; stty raw -echo; dd bs=1 count=1 of='${shellKeys}' 2>/dev/null; stty sane; printf 'DD-%s\\n' DONE\n`,
      }), "drew the stale dialog from the shell");
      // herdr 0.9.5 keeps naming the pane omp here (the case this guards), 0.9.3 drops the name: the outcome is the same
      expect(["omp", null], fixture).toContain((await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane)?.agent ?? null);
      expect(await promptOf(pane), fixture).toBeNull();
      const answered = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane_id: pane, prompt_id: live!.id, option_index: 0 }),
      });
      expect(answered.status, fixture).toBe(409);
      await herdrAfter([drawnOn(pane, "DD-DONE")], () => herdrRpc("pane.send_text", { pane_id: pane, text: "Z" }), "saw the shell take its key");
      expect(readFileSync(shellKeys, "latin1"), fixture).toBe("Z");
      expect(existsSync(ompKeys), fixture).toBe(false);
    } finally {
      if (pid !== undefined) process.kill(pid, "SIGKILL");
      await workspaceClose(created.workspace.workspace_id);
    }
  }
}, 60_000);

// bunx and npx run omp's npm package entry point (its `bin`, dist/cli.js) with bun: the process's argv is the runtime and that
// script, and omp names the process omp itself (prctl, as this stand-in does), which herdr reports (#2280)
// omp names itself through Linux's prctl here, as omp does; macOS's process name comes from its executable
it.skipIf(process.platform !== "linux")("offers the approval card of an omp started from its npm package's entry point", async () => {
  const entry = join(root, "npm", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `
const { dlopen, FFIType, ptr } = require("bun:ffi");
const libc = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
libc.symbols.prctl(15, ptr(Buffer.from("omp\\0")), 0n, 0n, 0n);
${ASK}`);
  const screen = fileURLToPath(new URL("./fixtures/omp-approval-18.13.2-unicode-narrow.txt", import.meta.url));
  const keys = join(root, "npm-entry-keys");
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-omp-npm-entry" });
  try {
    const pane = created.root_pane.pane_id;
    await herdrAfter([drawnOn(pane, "Allow tool: bash"), { type: "pane.agent_status_changed", pane_id: pane }],
      () => herdrRpc("pane.send_text", { pane_id: pane, text: `HOME='${root}' exec '${process.execPath}' '${entry}' '${screen}' '${screen}' '${keys}'\n` }),
      "drew the stand-in's approval panel and saw its omp",
      (events) => events.some((event) => event.event === "pane.output_matched")
        && events.some((event) => event.event === "pane.agent_status_changed" && event.data?.["agent"] === "omp"));
    const [process_] = (await paneProcessInfo(pane))?.foreground_processes ?? [];
    expect(process_).toMatchObject({ name: "omp", argv: [process.execPath, entry, screen, screen, keys] });
    expect(await promptOf(pane)).toMatchObject({ agent: "omp", kind: "approval", title: "Allow tool: bash" });
  } finally {
    await workspaceClose(created.workspace.workspace_id);
  }
}, 30_000);

// omp 18.8.7's pictures as recorded (server/fixtures/omp-pictures-18.8.7-*): the bytes sit in the blob
// store beside the session store, the transcript holds `blob:sha256:<digest>`
it("serves an omp session's prompt and tool pictures, named by ref, from omp's blob store", async () => {
  const blob = readFileSync(new URL("./fixtures/omp-pictures-18.8.7-blob.webp", import.meta.url));
  const blobs = join(root, ".omp", "agent", "blobs");
  mkdirSync(blobs, { recursive: true });
  writeFileSync(join(blobs, createHash("sha256").update(blob).digest("hex")), blob);
  writeFileSync(fresh, readFileSync(new URL("./fixtures/omp-pictures-18.8.7-session.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line).type === "session" ? JSON.stringify({ ...JSON.parse(line), cwd: root }) : line).join("\n") + "\n");
  const refs = (await read()).turns.flatMap((turn) => turn.parts.flatMap((part) => part.kind === "image" ? [part.ref] : part.kind === "tool" ? (part.images ?? []).map((image) => image.ref) : []));
  expect(refs).toEqual(["pi-prompt:d4a9dbba:0", expect.stringMatching(/^pi:call_[0-9a-f]+\|fc_[0-9a-f]+:0$/), "pi-prompt:faaa5772:0"]);
  const image = (ref: string) => fetch(`http://127.0.0.1:${server.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref })}`);
  for (const ref of refs) {
    const response = await image(ref);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400, immutable");
    expect(Buffer.from(await response.arrayBuffer()).equals(blob)).toBe(true);
  }
  expect((await image("pi-prompt:d4a9dbba:1")).status).toBe(404);
  expect((await image("pi:../blobs:0")).status).toBe(404);
});

it("answers the /btw topics saved beside the pane's own OMP session, and none for a pane whose session is not written", async () => {
  // OMP 18.14 keeps a session's /btw topics in its artifacts folder: the session file's path without .jsonl
  const history = join(askSession.slice(0, -".jsonl".length), "btw-history");
  mkdirSync(history, { recursive: true });
  writeFileSync(join(history, "entry-btw1.json"), JSON.stringify({ question: "Which port?", answer: "7421", status: "complete", createdAt: 1_792_642_086_836, updatedAt: 1_792_642_088_314, id: "btw1", leafId: null }));
  const topics = async (pane: string): Promise<{ id: string; answer: string }[]> => {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/btw?pane_id=${encodeURIComponent(pane)}`);
    expect(response.status).toBe(200);
    return (await response.json() as { topics: { id: string; answer: string }[] }).topics;
  };
  expect((await topics(askPaneId)).map((topic) => [topic.id, topic.answer])).toEqual([["btw1", "7421"]]);
  expect(await topics(paneId)).toEqual([]);
});
