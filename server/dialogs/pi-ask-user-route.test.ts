import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiAskBridgeState, PiAskSubmitReply, PiAskSubmitRequest } from "../../shared/pi-ask-bridge.ts";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { socketAddress } from "../herdr/client.ts";
import { handlePromptRequest, promptWaitEnded } from "../prompt.ts";
import fixture from "../fixtures/pi-ask-user-1.2.0-bridge.json";

const PID = 4242;
const posix = process.platform !== "win32";

interface Bridge {
  state: PiAskBridgeState;
  reply: PiAskSubmitReply;
  submits: PiAskSubmitRequest[];
  /** the extension's socket is there but its state read fails */
  broken?: boolean;
}

/**
 * A pi pane whose process runs the web UI's extension: a fake herdr RPC endpoint and a fake bridge
 * socket serving the recorded pi-ask 1.2.0 form, both in a temp directory. Never the user's herdr or pi.
 */
async function withBridgedPane(run: (pane: {
  status: string;
  /** the pane's foreground pid, as herdr reports it */
  foreground: number;
  /** called on each read of the bridge's state, before it answers */
  onState?: () => void;
  /** every key and text herdr was asked to send into the pane */
  keys: string[];
  /** called when herdr is asked for the pane's screen */
  onScreen?: () => void;
  /** the pane's screen, the recorded pi-ask form unless set */
  screen?: string;
  /** the pane's foreground pids as herdr reports them; unless set, `foreground` and the other pis */
  foregroundList?: number[];
  /** the foreground processes' argv as herdr reports it */
  argv?: string[];
  /** further foreground pis with the extension, each answering with its own state */
  others: Map<number, PiAskBridgeState>;
  bridge: Bridge;
  session: string;
  root: string;
  read(): Promise<InteractivePrompt | null>;
  answer(id: string, choice: object): Promise<{ status: number; body: { error?: { code: string } } }>;
}) => Promise<void>, options: { bridge?: boolean; written?: boolean; others?: number[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pau-"));
  const id = `pi-ask-user-${randomUUID()}`;
  const store = join(root, "sessions", "--proj--");
  mkdirSync(store, { recursive: true });
  const session = join(store, "2026-10-28T06-40-21-815Z_268a1f60-5ac8-45fa-8ecc-5a6b3a0ecdd7.jsonl");
  // the session up to the open call; the recorded dismissal is what pi-ask writes once answered
  if (options.written !== false) writeFileSync(session, fixture.transcript.slice(0, 4).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const bridge: Bridge = { state: { ...structuredClone(fixture.state), pid: PID, sessionFile: session } as PiAskBridgeState, reply: fixture.accepted.reply as PiAskSubmitReply, submits: [] };
  const served = options.bridge === false ? null : (() => {
    mkdirSync(join(root, "herdr-web-ui-ask"), { mode: 0o700 });
    return Bun.serve({
      unix: join(root, "herdr-web-ui-ask", `${PID}.sock`),
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/state") {
          pane.onState?.();
          if (bridge.broken) return new Response("broken", { status: 500 });
          return Response.json(bridge.state);
        }
        bridge.submits.push(await request.json() as PiAskSubmitRequest);
        return Response.json(bridge.reply);
      },
    });
  })();

  const others = new Map((options.others ?? []).map((pid) => [pid, { version: 1, pid, sessionFile: session, flows: [], openCalls: [] } as PiAskBridgeState]));
  const otherServers = [...others.keys()].map((pid) => Bun.serve({
    unix: join(root, "herdr-web-ui-ask", `${pid}.sock`),
    fetch: () => Response.json(others.get(pid)),
  }));
  const pane = {
    status: "blocked", foreground: PID, onState: undefined as (() => void) | undefined, keys: [] as string[],
    onScreen: undefined as (() => void) | undefined, screen: undefined as string | undefined, foregroundList: undefined as number[] | undefined, argv: undefined as string[] | undefined, others, bridge, session, root,
    read: async (): Promise<InteractivePrompt | null> => {
      const url = new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${id}`);
      const response = (await handlePromptRequest(new Request(url), url))!;
      expect(response.status).toBe(200);
      return (await response.json() as { prompt: InteractivePrompt | null }).prompt;
    },
    answer: async (prompt: string, choice: object) => {
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: id, prompt_id: prompt, ...choice }) }), url))!;
      return { status: response.status, body: await response.json() as { error?: { code: string } } };
    },
  };
  const sockets = new Set<Socket>();
  const herdr = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const request = JSON.parse(buffer.split("\n")[0]!) as { id: string; method: string; params?: { keys?: string[]; text?: string } };
      const reply = (result: unknown) => socket.end(JSON.stringify({ id: request.id, result }) + "\n");
      if (request.method === "session.snapshot") return reply({ snapshot: { panes: [{ pane_id: id, agent: "pi", agent_status: pane.status, terminal_id: id, focused: false }], layouts: [] } });
      if (request.method === "pane.read") {
        pane.onScreen?.();
        return reply({ read: { text: pane.screen ?? fixture.screen } });
      }
      if (request.method === "pane.get") return reply({ pane: { pane_id: id, scroll: { offset_from_bottom: 0 } } });
      if (request.method === "pane.process_info") return reply({ process_info: { foreground_processes: (pane.foregroundList ?? [pane.foreground, ...others.keys()]).map((pid) => ({ pid, argv: pane.argv ?? ["pi"] })) } });
      if (request.method === "pane.send_keys" || request.method === "pane.send_text") {
        pane.keys.push(...(request.params?.keys ?? [`text:${request.params?.text}`]));
        return reply({});
      }
      if (request.method === "agent.get") return reply({ agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: session } } });
      socket.end(JSON.stringify({ id: request.id, error: { code: "unexpected_fixture_rpc", message: `Unexpected test RPC ${request.method}` } }) + "\n");
    });
  });
  const endpoint = socketAddress(join(root, "herdr.sock"));
  await new Promise<void>((resolve, reject) => { herdr.once("error", reject); herdr.listen(endpoint, resolve); });
  const saved = { socket: process.env["HERDR_SOCKET"], agentDir: process.env["PI_CODING_AGENT_DIR"], store: process.env["PI_CODING_AGENT_SESSION_DIR"] };
  process.env["HERDR_SOCKET"] = endpoint;
  process.env["PI_CODING_AGENT_DIR"] = root;
  delete process.env["PI_CODING_AGENT_SESSION_DIR"];
  const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  try { await run(pane); } finally {
    promptWaitEnded(id);
    restore("HERDR_SOCKET", saved.socket);
    restore("PI_CODING_AGENT_DIR", saved.agentDir);
    restore("PI_CODING_AGENT_SESSION_DIR", saved.store);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => herdr.close(() => resolve()));
    await served?.stop(true);
    for (const server of otherServers) await server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}

test("pi-ask's form is a card, one question per step, and its answers go to pi-ask by value", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    // Given the recorded form open in a pane whose pi runs the extension
    const scope = (await pane.read())!;
    expect(scope).toMatchObject({
      agent: "pi", kind: "question", title: "Release plan", question: "Which part should ship first?", multi_select: false, custom_option_index: 2,
      options: [{ label: "Server (Recommended)", description: "Bridge and prompt route" }, { label: "Client", description: "Card polish only" }, { label: "Type your own answer", description: null }],
      steps: [{ label: "Scope", answered: false, current: true }, { label: "Checks", answered: false, current: false }, { label: "Tone", answered: false, current: false }],
    });
    expect(scope.can_step_back).toBeFalsy();
    // pi-ask never requires an answer; a multi-select's checks and typed text go together
    expect(scope.optional).toBe(true);
    expect(scope.checks_with_text).toBeUndefined();

    // When each step is answered from the card, with one trip back to the first
    expect((await pane.answer(scope.id, { option_index: 0 })).status).toBe(200);
    const checks = (await pane.read())!;
    expect(checks).toMatchObject({ question: "Which checks should run before the push?", multi_select: true, can_step_back: true, checks_with_text: true });
    expect(checks.options.map((option) => option.label)).toEqual(["Unit tests", "Browser QA", "Lint", "Type your own answer"]);
    expect((await pane.answer(checks.id, { option_indices: [0, 1], custom_text: "typecheck" })).status).toBe(200);
    const tone = (await pane.read())!;
    expect(tone.options[0]).toEqual({ label: "Short", description: "Pi's ask_user questions show as chat cards." });
    expect((await pane.answer(tone.id, { step_index: 0 })).status).toBe(200);
    const again = (await pane.read())!;
    expect(again).toMatchObject({ question: "Which part should ship first?", default_option_index: 0 });
    expect((await pane.answer(again.id, { option_index: 0 })).status).toBe(200);
    const checksAgain = (await pane.read())!;
    expect(checksAgain).toMatchObject({ default_option_indices: [0, 1], default_custom_text: "typecheck" });
    expect((await pane.answer(checksAgain.id, { option_indices: [0, 1], custom_text: "typecheck" })).status).toBe(200);
    expect(pane.bridge.submits).toEqual([]);
    const last = (await pane.read())!;
    expect((await pane.answer(last.id, { custom_text: "Plain and short" })).status).toBe(200);

    // Then pi-ask gets every answer at once, exactly as the recorded accepted submit
    expect(pane.bridge.submits).toEqual([{ ...fixture.accepted.request, createdAt: fixture.started.createdAt, sessionFile: pane.session } as PiAskSubmitRequest]);
    // and once pi-ask closes the form (completed, then its dismissal record), the card is gone
    pane.bridge.state = { ...pane.bridge.state, flows: [] };
    appendFileSync(pane.session, JSON.stringify(fixture.transcript[4]) + "\n");
    pane.status = "idle";
    expect(await pane.read()).toBeNull();
  });
});

test("pi-ask forward steps reach unanswered questions without submitting or sending keys", async () => {
  if (!posix) return;
  await withBridgedPane(async pane => {
    const first = (await pane.read())!;
    expect(first.steps?.map(step => step.can_navigate ?? false)).toEqual([false, true, true]);
    expect(first.can_step_next).toBe(true);
    expect((await pane.answer(first.id, { step_index: 2 })).status).toBe(200);
    const last = (await pane.read())!;
    expect(last.steps?.map(step => step.answered)).toEqual([false, false, false]);
    expect(last.steps?.findIndex(step => step.current)).toBe(2);
    expect(last.can_step_next ?? false).toBe(false);
    expect(pane.bridge.submits).toEqual([]);
    expect(pane.keys).toEqual([]);
  });
});

test("pi-ask Next saves only explicit drafts and refuses conflicting or out-of-range moves", async () => {
  if (!posix) return;
  await withBridgedPane(async pane => {
    const first = (await pane.read())!;
    for (const choice of [{ step_next: true, option_index: 0 }, { step_next: true, step_back: true }, { step_next: true, step_index: 1 }]) {
      expect((await pane.answer(first.id, choice)).status).toBe(400);
    }
    expect((await pane.answer(first.id, { step_next: true, draft: { option_indices: [], custom_text: "kept" } })).status).toBe(200);
    const second = (await pane.read())!;
    expect(second.steps?.findIndex(step => step.current)).toBe(1);
    expect(second.steps?.map(step => step.answered)).toEqual([true, false, false]);
    expect((await pane.answer(second.id, { step_back: true })).status).toBe(200);
    expect((await pane.read())?.default_custom_text).toBe("kept");
    expect((await pane.answer((await pane.read())!.id, { step_index: 2 })).status).toBe(200);
    expect((await pane.answer((await pane.read())!.id, { step_next: true })).status).toBe(400);
    expect(pane.bridge.submits).toEqual([]);
    expect(pane.keys).toEqual([]);
  });
});

test("an answer is refused when the card is stale, out of range, or pi-ask turns it down", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    const scope = (await pane.read())!;
    expect((await pane.answer(scope.id, { option_index: 2 })).status).toBe(400);
    expect((await pane.answer(scope.id, { option_indices: [0] })).status).toBe(400);
    expect((await pane.answer(scope.id, { option_index: 1 })).status).toBe(200);
    // the first step's card again, after the answer moved the form on
    expect((await pane.answer(scope.id, { option_index: 1 })).body.error?.code).toBe("prompt_changed");
    await pane.answer((await pane.read())!.id, { option_indices: [2] });

    pane.bridge.reply = fixture.refused.reply as PiAskSubmitReply;
    const tone = (await pane.read())!;
    const refused = await pane.answer(tone.id, { option_index: 1 });
    expect(refused.status).toBe(502);
    expect(refused.body.error?.code).toBe("reply_failed");

    pane.bridge.reply = { ok: false, error: "flow_not_found", message: "Ask flow is not active." };
    expect((await pane.answer((await pane.read())!.id, { option_index: 1 })).body.error?.code).toBe("prompt_changed");
    expect(pane.bridge.submits.map((submit) => submit.response)).toEqual([
      { kind: "answer", mode: "submit", answers: { scope: { values: ["client"] }, checks: { values: ["lint"] }, tone: { values: ["long"] } } },
      { kind: "answer", mode: "submit", answers: { scope: { values: ["client"] }, checks: { values: ["lint"] }, tone: { values: ["long"] } } },
    ]);
  });
});

test("a card's answers never go to a form reopened for the same call", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    // Given a card read up to its last step
    await pane.answer((await pane.read())!.id, { option_index: 0 });
    await pane.answer((await pane.read())!.id, { option_indices: [0] });
    const last = (await pane.read())!;

    // When pi-ask reopens the call's form (same flowId) with other questions before the answer lands
    const flow = pane.bridge.state.flows[0]!;
    pane.bridge.state = { ...pane.bridge.state, flows: [{ ...flow, createdAt: flow.createdAt + 1, questions: [{ ...flow.questions[0]!, prompt: "Ship to production?" }, ...flow.questions.slice(1)] }] };

    // Then the old card's answer is refused and nothing reaches pi-ask
    expect((await pane.answer(last.id, { option_index: 0 })).body.error?.code).toBe("prompt_changed");
    expect(pane.bridge.submits).toEqual([]);
    // and the new form starts over at its first question
    expect(await pane.read()).toMatchObject({ question: "Ship to production?", steps: [{ answered: false, current: true }, { answered: false }, { answered: false }] });
  });
});

test("questions can be skipped, a typed answer survives Back, and an answered question is reachable again", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    // Skip the first question (the card's Skip button sends an empty text)
    expect((await pane.answer((await pane.read())!.id, { custom_text: "" })).status).toBe(200);
    // On the second, type an answer and go Back: the typed text is kept
    const checks = (await pane.read())!;
    expect((await pane.answer(checks.id, { step_back: true, draft: { option_indices: [], custom_text: "typecheck" } })).status).toBe(200);
    const scope = (await pane.read())!;
    expect(scope.steps!.map((step) => step.answered)).toEqual([false, true, false]);
    // with no Back on the first question, the saved second one is still a button, and the card keeps edits as it moves
    expect(scope.steps!.map((step) => step.can_navigate ?? false)).toEqual([false, true, true]);
    expect(scope.drafts_saved).toBe(true);
    // and the answered second question is one click away again
    expect((await pane.answer(scope.id, { step_index: 1 })).status).toBe(200);
    expect(await pane.read()).toMatchObject({ question: "Which checks should run before the push?", default_custom_text: "typecheck" });
    // an unanswered question is reachable too, without submitting the form
    expect((await pane.answer((await pane.read())!.id, { step_index: 2 })).status).toBe(200);
    expect((await pane.answer((await pane.read())!.id, { step_back: true })).status).toBe(200);
    // Skip the rest: pi-ask gets only what was answered
    const second = (await pane.read())!;
    expect((await pane.answer(second.id, { option_indices: [], custom_text: "typecheck" })).status).toBe(200);
    expect((await pane.answer((await pane.read())!.id, { custom_text: "" })).status).toBe(200);
    expect(pane.bridge.submits.map((submit) => submit.response)).toEqual([{ kind: "answer", mode: "submit", answers: { checks: { values: [], customText: "typecheck" } } }]);
  });
});

test("the card follows pi's live branch, which a /tree move changes without writing to the session", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    // Given the session file ending in the call's dismissal, but pi's leaf moved back before it
    // (a /tree move appends nothing): pi-ask has reopened the form, and the extension says the call is open
    appendFileSync(pane.session, JSON.stringify(fixture.transcript[4]) + "\n");
    pane.bridge.state.flows[0]!.createdAt += 1;
    pane.bridge.state.openCalls = ["toolu_feat1202ask"];
    expect(await pane.read()).toMatchObject({ question: "Which part should ship first?", title: "Release plan", steps: [{ label: "Scope" }, { label: "Checks" }, { label: "Tone" }] });
    // and once pi's branch has the call settled, the card goes, with no card of guessed keys while the form is still up
    pane.bridge.state.openCalls = [];
    expect(await pane.read()).toBeNull();
  });
});

test("a typed answer from the composer keeps the checks the card shows as saved", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    await pane.answer((await pane.read())!.id, { option_index: 0 });
    await pane.answer((await pane.read())!.id, { option_indices: [0, 1] });
    await pane.answer((await pane.read())!.id, { step_index: 1 });
    // the composer sends only the typed text
    expect((await pane.answer((await pane.read())!.id, { custom_text: "typecheck" })).status).toBe(200);
    expect((await pane.answer((await pane.read())!.id, { option_index: 0 })).status).toBe(200);
    expect(pane.bridge.submits.map((submit) => submit.response)).toEqual([{ kind: "answer", mode: "submit", answers: { scope: { values: ["server"] }, checks: { values: ["unit", "browser"], customText: "typecheck" }, tone: { values: ["short"] } } }]);
  });
});

test("a form pi-ask dropped without telling the extension does not hide the live one", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    const live = pane.bridge.state.flows[0]!;
    // an earlier form whose call is settled in the session: pi-ask disposed it without a completed event
    // and a dropped /answer form, which has no call at all
    pane.bridge.state.flows = [{ ...live, flowId: "tool:earlier", toolCallId: "earlier", createdAt: 1 }, { ...live, flowId: "flow:1:x", toolCallId: undefined, createdAt: 2 }, live];
    expect(await pane.read()).toMatchObject({ question: "Which part should ship first?", title: "Release plan", steps: [{ label: "Scope" }, { label: "Checks" }, { label: "Tone" }] });
  });
});

test("pi-ask's form with no extension is never a card of guessed keys, even while herdr reports it blocked", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    expect(pane.status).toBe("blocked");
    expect(await pane.read()).toBeNull();
  }, { bridge: false });
});

test("an open pi-ask form that is no card is never a card of guessed keys", async () => {
  if (!posix) return;
  // a blocked pane whose pi has a form from /answer (no tool call) open
  await withBridgedPane(async (pane) => {
    writeFileSync(pane.session, fixture.transcript.slice(0, 2).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    pane.bridge.state.flows = [{ ...pane.bridge.state.flows[0]!, flowId: "flow:answer", toolCallId: undefined, source: "answer" }];
    pane.bridge.state.openCalls = [];
    expect(await pane.read()).toBeNull();
  });
  // or a form for a session the pane's report does not name
  await withBridgedPane(async (pane) => {
    pane.bridge.state.sessionFile = join(pane.root, "other.jsonl");
    expect(await pane.read()).toBeNull();
  });
});

test("an open pi-ask form in a session pi has not written yet is never a card of guessed keys", async () => {
  if (!posix) return;
  // pi writes its session file only once an assistant message is in; a form from /answer needs no
  // tool call. herdr reports the session's path, which does not exist yet.
  await withBridgedPane(async (pane) => {
    pane.bridge.state.flows = [{ ...pane.bridge.state.flows[0]!, flowId: "flow:answer", toolCallId: undefined, source: "answer" }];
    pane.bridge.state.openCalls = [];
    const card = await pane.read();
    // a card here could only be the generic one: answering it would type into the open form
    if (card) await pane.answer(card.id, { option_index: 0 });
    expect(card).toBeNull();
    expect(pane.keys).toEqual([]);
  }, { written: false });
  // and an extension socket of the pane's pi that does not answer: not knowing makes no room for keys
  await withBridgedPane(async (pane) => {
    pane.bridge.broken = true;
    const card = await pane.read();
    if (card) await pane.answer(card.id, { option_index: 0 });
    expect(card).toBeNull();
    expect(pane.keys).toEqual([]);
  }, { written: false });
});

/** pi's own select dialog, as pi draws it. */
const PI_SELECT = "────────────────────────\n Choose a color\n\n → Red\n   Blue\n\n ↑↓ navigate  enter select  escape/ctrl+c cancel";

/** A form from /answer: no tool call, no card, but pi-ask's all the same. */
const answerForm = (state: PiAskBridgeState) => ({ ...state.flows[0]!, flowId: "flow:answer", toolCallId: undefined, source: "answer" });
/** No open call, in the session file or on pi's live branch: only a form pi-ask reports is open. */
const noCall = (pane: { session: string; bridge: Bridge }) => {
  writeFileSync(pane.session, fixture.transcript.slice(0, 2).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  pane.bridge.state.openCalls = [];
};

test("not knowing whether a pi-ask form is open never makes room for keys", async () => {
  if (!posix) return;
  // the extension's socket of the pane's pi does not answer
  await withBridgedPane(async (pane) => {
    noCall(pane);
    pane.bridge.broken = true;
    const card = await pane.read();
    if (card) await pane.answer(card.id, { option_index: 0 });
    expect(card).toBeNull();
    expect(pane.keys).toEqual([]);
  });
  // two of the pane's foreground processes run the extension: no card binds, and the one with an
  // open form still holds the keys back
  await withBridgedPane(async (pane) => {
    noCall(pane);
    pane.bridge.state.flows = [];
    pane.others.get(PID + 7)!.flows = [answerForm(pane.bridge.state)];
    const card = await pane.read();
    if (card) await pane.answer(card.id, { option_index: 0 });
    expect(card).toBeNull();
    expect(pane.keys).toEqual([]);
  }, { others: [PID + 7] });
});

test("a pi-ask form that opens during the read or before the keys gets none of them", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    noCall(pane);
    // a pi with no extension in front: its own dialog keeps its card, as on main
    pane.screen = PI_SELECT;
    pane.foregroundList = [PID + 50];
    const card = (await pane.read())!;
    expect(card).toMatchObject({ question: "Choose a color" });
    // while the answer reads the pane, a pi the extension serves comes in front
    pane.onScreen = () => { pane.foregroundList = [PID]; };
    expect((await pane.answer(card.id, { option_index: 0 })).body.error?.code).toBe("prompt_changed");
    expect(pane.keys).toEqual([]);
  });
  await withBridgedPane(async (pane) => {
    noCall(pane);
    const form = answerForm(pane.bridge.state);
    pane.bridge.state.flows = [];
    // the form opens while herdr reads the pane's screen
    pane.onScreen = () => { pane.bridge.state.flows = [form]; };
    expect(await pane.read()).toBeNull();
  });
});

test("pi's own dialogs keep their cards only where no pi-ask extension serves the pane's pi", async () => {
  if (!posix) return;
  // no extension: pi's select dialog is a card, answered by keys as on main, whatever the session file holds
  await withBridgedPane(async (pane) => {
    pane.screen = PI_SELECT;
    const card = (await pane.read())!;
    expect(card).toMatchObject({ question: "Choose a color", options: [{ label: "Red" }, { label: "Blue" }] });
    expect((await pane.answer(card.id, { option_index: 0 })).status).toBe(200);
    expect(pane.keys).toEqual(["enter"]);
  }, { bridge: false });
  // the extension serves the pane's pi, with or without a form open: no card that answers by keys
  for (const open of [false, true]) {
    await withBridgedPane(async (pane) => {
      noCall(pane);
      pane.screen = PI_SELECT;
      pane.bridge.state.flows = open ? [answerForm(pane.bridge.state)] : [];
      expect(await pane.read()).toBeNull();
      expect(pane.keys).toEqual([]);
    });
  }
});

test("a pi-ask form the same pi opens during the last check gets no key", async () => {
  if (!posix) return;
  // the second reviewer's probe (ec2a5392): pi A's own dialog, its extension answering "no form",
  // and an /answer form opening in the same pi A while the last check re-reads the foreground
  await withBridgedPane(async (pane) => {
    noCall(pane);
    pane.screen = PI_SELECT;
    pane.bridge.state.flows = [];
    const card = await pane.read();
    pane.onState = () => { pane.bridge.state.flows = [answerForm(pane.bridge.state)]; };
    if (card) await pane.answer(card.id, { option_index: 0 });
    // the extension serves pi A, so its dialog had no card to answer by keys in the first place
    expect(card).toBeNull();
    expect(pane.keys).toEqual([]);
  });
});

test("an open call on pi's live branch holds the keys even when pi-ask reported no form", async () => {
  if (!posix) return;
  // a pi-ask that sends no started event: the extension lists no form, but pi's branch has the call
  await withBridgedPane(async (pane) => {
    noCall(pane);
    pane.bridge.state.flows = [];
    pane.bridge.state.openCalls = ["toolu_feat1202ask"];
    const card = await pane.read();
    if (card) await pane.answer(card.id, { option_index: 0 });
    expect(card).toBeNull();
    expect(pane.keys).toEqual([]);
  });
  // and when pi cannot say which calls are open: the extension serves this pi, so no key-driven card
  await withBridgedPane(async (pane) => {
    pane.bridge.state.flows = [];
    pane.bridge.state.openCalls = null;
    const card = await pane.read();
    if (card) await pane.answer(card.id, { option_index: 0 });
    expect(card).toBeNull();
    expect(pane.keys).toEqual([]);
  });
});

test("a pi pane gets no generic card of guessed keys at all", async () => {
  if (!posix) return;
  // a blocked pi pane whose screen no reader knows, with no pi-ask form anywhere: still no card
  await withBridgedPane(async (pane) => {
    noCall(pane);
    pane.bridge.state.flows = [];
    const card = await pane.read();
    if (card) await pane.answer(card.id, { option_index: 0 });
    expect(card).toBeNull();
    expect(pane.keys).toEqual([]);
  }, { bridge: false });
});

test("an OmO pane herdr labels pi keeps the generic card other agents get", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    noCall(pane);
    // herdr names an OmO pane `pi` while OmO waits; its process tree says OmO
    pane.argv = ["bun", "/home/u/lib/node_modules/omo-ai/bin/omo.js"];
    const card = await pane.read();
    expect(card?.fallback).toBe(true);
  }, { bridge: false });
});

test("a key never goes to a pi that came in front while the answer was on its way", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    noCall(pane);
    pane.screen = PI_SELECT;
    // pi B, which the extension serves and which has a form open, is not in front yet
    pane.others.get(PID + 9)!.flows = [answerForm(pane.bridge.state)];
    pane.foregroundList = [PID + 50];
    const card = (await pane.read())!;
    expect(card).toMatchObject({ question: "Choose a color" });
    // herdr's foreground becomes pi B while the answer reads the pane
    pane.onScreen = () => { pane.foregroundList = [PID + 9]; };
    const sent = await pane.answer(card.id, { option_index: 0 });
    expect(pane.keys).toEqual([]);
    expect(sent.status).toBe(409);
  }, { others: [PID + 9] });
});

test("an answer never leaves for a pi the pane no longer has in front", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    pane.bridge.state.flows[0]!.questions = [pane.bridge.state.flows[0]!.questions[0]!];
    const card = (await pane.read())!;
    let reads = 0;
    // the pane's foreground changes while the last step reads the bridge again: the old pi, still
    // running behind it, answers its socket with its own session and form
    pane.onState = () => { if (++reads === 2) pane.foreground = PID + 1; };
    const sent = await pane.answer(card.id, { option_index: 0 });
    expect(sent.status).toBe(409);
    expect(pane.bridge.submits).toEqual([]);
  });
});

test("question ids that name object properties keep their answers", async () => {
  if (!posix) return;
  await withBridgedPane(async (pane) => {
    const [scope, checks] = pane.bridge.state.flows[0]!.questions;
    pane.bridge.state.flows[0]!.questions = [{ ...scope!, id: "__proto__" }, { ...checks!, id: "constructor" }];
    const first = (await pane.read())!;
    expect(first.steps!.map((step) => step.answered)).toEqual([false, false]);
    expect((await pane.answer(first.id, { option_index: 0 })).status).toBe(200);
    const second = (await pane.read())!;
    expect(second.default_option_indices).toBeUndefined();
    expect((await pane.answer(second.id, { option_indices: [1] })).status).toBe(200);
    const answers = (pane.bridge.submits[0]!.response as { answers: Record<string, unknown> }).answers;
    expect(Object.hasOwn(answers, "__proto__")).toBe(true);
    expect(answers["__proto__"]).toEqual({ values: ["server"] });
    expect(answers["constructor"]).toEqual({ values: ["browser"] });
  });
});

test("no card without every fact the extension and the session agree on", async () => {
  if (!posix) return;
  const unbridged = async (change: (pane: { bridge: Bridge; session: string; root: string }) => void, options?: { bridge?: boolean }) => {
    let prompt: InteractivePrompt | null = null;
    await withBridgedPane(async (pane) => {
      pane.status = "idle";
      change(pane);
      prompt = await pane.read();
    }, options);
    return prompt;
  };
  // the form on screen alone, with no extension: the terminal, as before
  expect(await unbridged(() => undefined, { bridge: false })).toBeNull();
  // another session file than the one herdr reports for the pane
  expect(await unbridged((pane) => { pane.bridge.state.sessionFile = join(pane.root, "other.jsonl"); })).toBeNull();
  // a socket answering for another process
  expect(await unbridged((pane) => { pane.bridge.state.pid = PID + 1; })).toBeNull();
  // two forms at once, each with its call open on pi's branch
  expect(await unbridged((pane) => {
    pane.bridge.state.flows = [pane.bridge.state.flows[0]!, { ...pane.bridge.state.flows[0]!, flowId: "tool:other", toolCallId: "other" }];
    pane.bridge.state.openCalls = ["toolu_feat1202ask", "other"];
  })).toBeNull();
  // the call already settled on pi's branch
  expect(await unbridged((pane) => { pane.bridge.state.openCalls = []; })).toBeNull();
  // pi could not say which calls are open
  expect(await unbridged((pane) => { pane.bridge.state.openCalls = null; })).toBeNull();
  // a socket directory other users can enter: anyone who can write there could speak for pi
  expect(await unbridged((pane) => { chmodSync(join(pane.root, "herdr-web-ui-ask"), 0o755); })).toBeNull();
  // a form with no tool call behind it (pi-ask's /answer and /ask:replay)
  expect(await unbridged((pane) => { pane.bridge.state.flows = [{ ...pane.bridge.state.flows[0]!, toolCallId: undefined }]; })).toBeNull();
});
