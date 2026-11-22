import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot, subscribeEvents, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { opencodeAuthHeader, type OpenCodeFormInfo } from "./opencode-service.ts";
import type { InteractivePrompt, ServerMessage } from "../shared/protocol.ts";
import { OpenCodePromptState } from "./prompt.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-opencode-prompt-contract-"));
const fakeOpencode = join(root, "bin", "opencode");
const workspaces: string[] = [];
let server: ReturnType<typeof createServer>;
let mockService: ReturnType<typeof Bun.serve>;
let mockPort = 0;
const PASSWORD = "test-secret-password";
const SESSION_SINGLE = "ses_opencodeQuestion01";
const SESSION_MULTI = "ses_opencodeQuestion02";

let pendingForms: Record<string, OpenCodeFormInfo[]> = {};
let receivedReplies: Array<{ sessionID: string; formID: string; answer: Record<string, string | string[]>; auth: string }> = [];
let replyStatusOverride = 0;

beforeAll(async () => {
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(fakeOpencode, "#!/bin/sh\nsleep 600\n");
  chmodSync(fakeOpencode, 0o755);

  mockService = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      if (req.method === "GET" && url.pathname === "/api/info") return Response.json({ version: "2.0.32", pid: process.pid, urls: [url.origin], paths: { tmp: root } });

      // List forms: GET /api/session/{sessionID}/form
      const listMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/form$/);
      if (req.method === "GET" && listMatch) {
        const sessionID = decodeURIComponent(listMatch[1]!);
        const forms = pendingForms[sessionID] ?? [];
        return new Response(JSON.stringify({ data: forms }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Reply form: POST /api/session/{sessionID}/form/{formID}/reply
      const replyMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/form\/([^/]+)\/reply$/);
      if (req.method === "POST" && replyMatch) {
        if (replyStatusOverride > 0) {
          const status = replyStatusOverride;
          replyStatusOverride = 0;
          return new Response("Simulated error", { status });
        }
        const sessionID = decodeURIComponent(replyMatch[1]!);
        const formID = decodeURIComponent(replyMatch[2]!);
        const body = (await req.json()) as { answer: Record<string, string | string[]> };
        receivedReplies.push({ sessionID, formID, answer: body.answer, auth });
        pendingForms[sessionID] = (pendingForms[sessionID] ?? []).filter((f) => f.id !== formID);
        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    },
  });

  mockPort = mockService.port ?? 0;

  writeFileSync(
    join(root, "service.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${mockPort}`,
      pid: process.pid,
      password: PASSWORD,
    }),
  );

  server = createServer({
    port: 0,
    hostname: "127.0.0.1",
    token: "",
    stateDir: join(root, "server-state"),
    openCodeStateDir: root,
  });
  await server.statusReady;
});

afterAll(async () => {
  mockService?.stop(true);
  server?.stop();
  for (const id of workspaces) await workspaceClose(id).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

async function setupOpencodePane(sessionID: string, label: string): Promise<string> {
  const created = await workspaceCreate({ cwd: root, label: `test-opencode-${label}` });
  workspaces.push(created.workspace.workspace_id);
  const paneId = created.root_pane.pane_id;

  const started = Promise.withResolvers<void>();
  const detected = Promise.withResolvers<void>();
  const subscription = subscribeEvents([{ type: "pane.agent_status_changed", pane_id: paneId }], {
    onStarted: () => started.resolve(),
    onEvent: (frame) => { if (frame.data?.agent === "opencode") detected.resolve(); },
    onError: (error) => { started.reject(error); detected.reject(error); },
  });
  const timeout = setTimeout(() => detected.reject(new Error("test opencode did not start")), 10_000);
  try {
    await started.promise;
    await herdrRpc("pane.send_text", { pane_id: paneId, text: `${fakeOpencode}\n` });
    await detected.promise;
  } finally {
    clearTimeout(timeout);
    subscription.close();
  }

  await herdrRpc("pane.report_agent_session", {
    pane_id: paneId,
    source: "herdr:opencode",
    agent: "opencode",
    agent_session_id: sessionID,
    session_start_source: "select",
  });
  await herdrRpc("pane.report_agent", {
    pane_id: paneId,
    source: "herdr:opencode",
    agent: "opencode",
    agent_session_id: sessionID,
    state: "blocked",
  });

  const pane = (await sessionSnapshot()).panes.find((p) => p.pane_id === paneId);
  expect(pane?.agent_session?.agent).toBe("opencode");
  expect(pane?.agent_status).toBe("blocked");
  return paneId;
}

function frameWhere(ws: WebSocket, holds: () => boolean): Promise<void> {
  if (holds()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.removeEventListener("message", check); reject(new Error("expected websocket frame")); }, 10_000);
    const check = (): void => {
      if (!holds()) return;
      clearTimeout(timer);
      ws.removeEventListener("message", check);
      resolve();
    };
    ws.addEventListener("message", check);
  });
}

async function readCard(paneId: string): Promise<InteractivePrompt> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(`http://127.0.0.1:${mockPort}`);
  const body = JSON.parse(text) as { prompt: InteractivePrompt | null };
  if (!body.prompt) throw new Error("Expected a native question card");
  return body.prompt;
}

describe("opencode prompt contract", () => {
  it("exposes optional questions and sends empty answers through the native service", async () => {
    const sessionID = "ses_opencodeOptional";
    pendingForms[sessionID] = [{
      id: "form_optional", sessionID, title: "Optional", metadata: { kind: "question" },
      fields: [
        { key: "text", type: "string", required: false },
        { key: "choice", type: "select", required: false, options: [{ value: "a", label: "A" }] },
        { key: "checks", type: "multiselect", required: false, options: [{ value: "a", label: "A" }] },
      ],
    }];
    const paneId = await setupOpencodePane(sessionID, "optional");
    receivedReplies = [];
    for (const multi of [false, false, true]) {
      const prompt = await readCard(paneId);
      expect(prompt.optional).toBe(true);
      const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
        method: "POST", body: JSON.stringify({
          pane_id: paneId, prompt_id: prompt.id, ...(multi ? { option_indices: [] } : { custom_text: "" }),
        }),
      });
      expect(response.status).toBe(200);
    }
    expect(receivedReplies.map((reply) => reply.answer)).toEqual([{ text: "", choice: "", checks: [] }]);
  });

  it("drops buffered answers when the server stops", async () => {
    const sessionID = "ses_opencodeRestart";
    pendingForms[sessionID] = [{
      id: "form_restart", sessionID, title: "Restart", metadata: { kind: "question" },
      fields: [{ key: "first", type: "string", custom: true }, { key: "second", type: "string", custom: true }],
    }];
    const paneId = await setupOpencodePane(sessionID, "restart");
    const first = await readCard(paneId);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST", body: JSON.stringify({ pane_id: paneId, prompt_id: first.id, custom_text: "buffered" }),
    });
    expect(response.status).toBe(200);
    expect((await readCard(paneId)).steps?.[1]?.current).toBe(true);
    const clear = spyOn(OpenCodePromptState.prototype, "clear");
    try {
      server.stop();
      expect(clear).toHaveBeenCalledTimes(1);
    } finally { clear.mockRestore(); }
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "server-state"), openCodeStateDir: root });
    await server.statusReady;
    expect((await readCard(paneId)).steps?.[0]?.current).toBe(true);
  });

  it("detects single question form and answers it via native HTTP API", async () => {
    receivedReplies = [];
    pendingForms[SESSION_SINGLE] = [
      {
        id: "form_single_1",
        sessionID: SESSION_SINGLE,
        title: "Configuration",
        metadata: { kind: "question" },
        fields: [
          {
            key: "q0",
            type: "string",
            title: "Color choice",
            description: "What is your favorite color?",
            options: [
              { value: "blue", label: "Blue", description: "The ocean" },
              { value: "red", label: "Red", description: "The fire" },
            ],
            custom: true,
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_SINGLE, "single");

    const prompt = await readCard(paneId);
    expect(prompt).not.toBeNull();
    expect(prompt!.agent).toBe("opencode");
    expect(prompt!.kind).toBe("question");
    expect(prompt!.question).toBe("What is your favorite color?");
    expect(prompt!.options.length).toBe(3);
    expect(prompt!.custom_option_index).toBe(2);

    const answerRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt!.id,
        option_index: 1,
      }),
    });
    expect(answerRes.status).toBe(200);
    const answerText = await answerRes.text();
    expect(answerText).not.toContain(PASSWORD);
    expect(answerText).not.toContain(`http://127.0.0.1:${mockPort}`);
    const answerBody = JSON.parse(answerText);
    expect(answerBody).toEqual({ ok: true });

    expect(receivedReplies.length).toBe(1);
    const reply = receivedReplies[0]!;
    expect(reply.sessionID).toBe(SESSION_SINGLE);
    expect(reply.formID).toBe("form_single_1");
    expect(reply.answer).toEqual({ q0: "red" });
    expect(reply.auth).toBe(opencodeAuthHeader(PASSWORD));
  });

  it("handles multi-question form sequentially with server-side buffering", async () => {
    receivedReplies = [];
    pendingForms[SESSION_MULTI] = [
      {
        id: "form_multi_1",
        sessionID: SESSION_MULTI,
        title: "Project Setup",
        metadata: { kind: "question" },
        fields: [
          {
            key: "framework",
            type: "string",
            title: "Framework",
            description: "Which frontend framework?",
            options: [
              { value: "react", label: "React" },
              { value: "vue", label: "Vue" },
            ],
            custom: false,
          },
          {
            key: "tools",
            type: "multiselect",
            custom: true,
            title: "Tools",
            description: "Select tooling",
            options: [
              { value: "eslint", label: "ESLint" },
              { value: "prettier", label: "Prettier" },
              { value: "tailwind", label: "Tailwind CSS" },
            ],
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_MULTI, "multi");

    const step1 = await readCard(paneId);
    expect(step1).not.toBeNull();
    expect(step1!.question).toBe("Which frontend framework?");
    expect(step1!.steps).toBeDefined();
    expect(step1!.steps?.length).toBe(2);
    expect(step1!.steps?.[0]?.current).toBe(true);
    expect(step1!.steps?.[0]?.answered).toBe(false);

    const ansRes1 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: step1!.id,
        option_index: 0,
      }),
    });
    expect(ansRes1.status).toBe(200);
    expect(receivedReplies.length).toBe(0);

    const step2 = await readCard(paneId);
    expect(step2).not.toBeNull();
    expect(step2!.question).toBe("Select tooling");
    expect(step2!.multi_select).toBe(true);
    expect(step2!.steps?.[0]?.answered).toBe(true);
    expect(step2!.steps?.[1]?.current).toBe(true);

    const ansRes2 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: step2!.id,
        option_indices: [0, 2],
        custom_text: "custom-tool",
      }),
    });
    expect(ansRes2.status).toBe(200);

    expect(receivedReplies.length).toBe(1);
    const reply = receivedReplies[0]!;
    expect(reply.sessionID).toBe(SESSION_MULTI);
    expect(reply.formID).toBe("form_multi_1");
    expect(reply.answer).toEqual({
      framework: "react",
      tools: ["eslint", "tailwind", "custom-tool"],
    });
  });

  it("tells a prompt watch when an answer moves the card to the form's next question, the pane still blocked", async () => {
    const sessionID = "ses_opencodeWatched";
    pendingForms[sessionID] = [{
      id: "form_watched", sessionID, title: "Watched", metadata: { kind: "question" },
      fields: [{ key: "first", type: "string", custom: true }, { key: "second", type: "string", custom: true }],
    }];
    const paneId = await setupOpencodePane(sessionID, "watched");
    const frames: ServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    ws.addEventListener("message", (event) => frames.push(JSON.parse(String(event.data)) as ServerMessage));
    const changes = () => frames.filter((frame) => frame.type === "prompt-changed" && frame.pane_id === paneId).length;
    try {
      await frameWhere(ws, () => frames.some((frame) => frame.type === "snapshot"));
      ws.send(JSON.stringify({ type: "prompt-watch", pane_id: paneId, enabled: true }));
      await frameWhere(ws, () => changes() === 1);
      const first = await readCard(paneId);
      const answered = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
        method: "POST", body: JSON.stringify({ pane_id: paneId, prompt_id: first.id, custom_text: "one" }),
      });
      expect(answered.status).toBe(200);
      expect((await readCard(paneId)).steps?.[1]?.current).toBe(true);
      await frameWhere(ws, () => changes() === 2);
    } finally { ws.close(); }
  }, 30_000);

  it("handles custom text answers for OpenCode questions", async () => {
    const SESSION_CUSTOM = "ses_opencodeCustom01";
    receivedReplies = [];
    pendingForms[SESSION_CUSTOM] = [
      {
        id: "form_custom_1",
        sessionID: SESSION_CUSTOM,
        title: "Feedback",
        metadata: { kind: "question" },
        fields: [
          {
            key: "comments",
            type: "string",
            title: "Comments",
            description: "Any extra comments?",
            options: [],
            custom: true,
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_CUSTOM, "custom");

    const prompt = await readCard(paneId);
    expect(prompt).not.toBeNull();
    expect(prompt!.custom_option_index).toBe(0);

    const ansRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt!.id,
        custom_text: "Everything looks great!",
      }),
    });
    expect(ansRes.status).toBe(200);

    expect(receivedReplies.length).toBe(1);
    expect(receivedReplies[0]!.answer).toEqual({ comments: "Everything looks great!" });
  });

  it("allows stepping back to previous questions in a multi-step form and revising answers", async () => {
    const SESSION_STEP_BACK = "ses_opencodeStepBack01";
    receivedReplies = [];
    pendingForms[SESSION_STEP_BACK] = [
      {
        id: "form_stepback_1",
        sessionID: SESSION_STEP_BACK,
        title: "Multi-Step Wizard",
        metadata: { kind: "question" },
        fields: [
          {
            key: "framework",
            type: "string",
            title: "Framework",
            description: "Which frontend framework?",
            options: [
              { value: "react", label: "React" },
              { value: "vue", label: "Vue" },
            ],
            custom: false,
          },
          {
            key: "styling",
            type: "string",
            title: "Styling",
            description: "Which styling library?",
            options: [
              { value: "tailwind", label: "Tailwind" },
              { value: "vanilla", label: "Vanilla CSS" },
            ],
            custom: false,
          },
          {
            key: "notes",
            type: "string",
            title: "Notes",
            description: "Any extra notes?",
            options: [],
            custom: true,
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_STEP_BACK, "stepback");

    const prompt0 = await readCard(paneId);
    expect(prompt0).not.toBeNull();
    expect(prompt0!.can_step_back).toBeFalsy();
    expect(prompt0!.steps?.[0]?.current).toBe(true);

    const ans0 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt0!.id,
        option_index: 0,
      }),
    });
    expect(ans0.status).toBe(200);

    const prompt1 = await readCard(paneId);
    expect(prompt1).not.toBeNull();
    expect(prompt1!.can_step_back).toBe(true);
    expect(prompt1!.steps?.[0]?.answered).toBe(true);
    expect(prompt1!.steps?.[1]?.current).toBe(true);

    const backRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt1!.id,
        step_back: true,
      }),
    });
    expect(backRes.status).toBe(200);

    const prompt0Again = await readCard(paneId);
    expect(prompt0Again).not.toBeNull();
    expect(prompt0Again!.can_step_back).toBeFalsy();
    expect(prompt0Again!.default_option_index).toBe(0);

    const reviseAns = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt0Again!.id,
        option_index: 1,
      }),
    });
    expect(reviseAns.status).toBe(200);

    const prompt1Again = await readCard(paneId);
    expect(prompt1Again).not.toBeNull();
    const ans1 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt1Again!.id,
        option_index: 0,
      }),
    });
    expect(ans1.status).toBe(200);

    const prompt2 = await readCard(paneId);
    expect(prompt2).not.toBeNull();
    expect(prompt2!.can_step_back).toBe(true);

    const jumpRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt2!.id,
        step_index: 0,
      }),
    });
    expect(jumpRes.status).toBe(200);

    const prompt0Jumped = await readCard(paneId);
    expect(prompt0Jumped).not.toBeNull();
    expect(prompt0Jumped!.default_option_index).toBe(1);

    await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt0Jumped!.id,
        option_index: 1,
      }),
    });

    const prompt1Adv = await readCard(paneId);
    expect(prompt1Adv).not.toBeNull();
    expect(prompt1Adv!.default_option_index).toBe(0);

    await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt1Adv!.id,
        option_index: 0,
      }),
    });

    const prompt2Final = await readCard(paneId);
    expect(prompt2Final).not.toBeNull();

    const finalAns = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt2Final!.id,
        custom_text: "All set!",
      }),
    });
    expect(finalAns.status).toBe(200);

    expect(receivedReplies.length).toBe(1);
    expect(receivedReplies[0]!.sessionID).toBe(SESSION_STEP_BACK);
    expect(receivedReplies[0]!.formID).toBe("form_stepback_1");
    expect(receivedReplies[0]!.answer).toEqual({
      framework: "vue",
      styling: "tailwind",
      notes: "All set!",
    });
  });

  it("preserves form identity when reply fails with non-409 error and allows retry", async () => {
    const SESSION_RETRY = "ses_opencodeRetry";
    pendingForms[SESSION_RETRY] = [
      {
        id: "form_retry_1",
        sessionID: SESSION_RETRY,
        title: "Deploy Options",
        metadata: { kind: "question" },
        fields: [
          {
            key: "target",
            type: "select",
            description: "Deploy Target",
            options: [
              { label: "Staging", value: "staging" },
              { label: "Production", value: "production" },
            ],
          },
        ],
      },
    ];

    const paneId = await setupOpencodePane(SESSION_RETRY, "retry");

    const prompt = await readCard(paneId);
    expect(prompt).not.toBeNull();

    replyStatusOverride = 500;
    const failRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt!.id,
        option_index: 0,
      }),
    });
    expect(failRes.status).toBe(502);

    const retryPrompt = await readCard(paneId);
    expect(retryPrompt).not.toBeNull();
    expect(retryPrompt!.id).toBe(prompt!.id);
    expect(retryPrompt!.default_option_index).toBeUndefined();

    const successRes = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneId,
        prompt_id: prompt!.id,
        option_index: 0,
      }),
    });
    expect(successRes.status).toBe(200);
  }, 20_000);

  it("handles multiple concurrent OpenCode instances independently without draft crosstalk", async () => {
    const SESSION_A = "ses_opencodeMultiInstanceA";
    const SESSION_B = "ses_opencodeMultiInstanceB";

    pendingForms[SESSION_A] = [
      {
        id: "form_a_1",
        sessionID: SESSION_A,
        title: "Instance A Setup",
        metadata: { kind: "question" },
        fields: [
          {
            key: "service_name",
            type: "string",
            description: "Service Name",
            options: [],
            custom: true,
          },
          {
            key: "env",
            type: "select",
            description: "Environment",
            options: [
              { label: "Staging", value: "staging" },
              { label: "Production", value: "production" },
            ],
          },
        ],
      },
    ];

    pendingForms[SESSION_B] = [
      {
        id: "form_b_1",
        sessionID: SESSION_B,
        title: "Instance B Database",
        metadata: { kind: "question" },
        fields: [
          {
            key: "db",
            type: "select",
            description: "Database Engine",
            options: [
              { label: "PostgreSQL", value: "postgres" },
              { label: "SQLite", value: "sqlite" },
            ],
          },
        ],
      },
    ];

    const paneIdA = await setupOpencodePane(SESSION_A, "instance-a");
    const paneIdB = await setupOpencodePane(SESSION_B, "instance-b");

    receivedReplies = [];

    const promptA1 = await readCard(paneIdA);
    const promptB = await readCard(paneIdB);

    expect(promptA1).not.toBeNull();
    expect(promptB).not.toBeNull();

    const ansA1 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneIdA,
        prompt_id: promptA1!.id,
        custom_text: "AuthService",
      }),
    });
    expect(ansA1.status).toBe(200);

    const resBCheck = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt?pane_id=${encodeURIComponent(paneIdB)}`);
    const bodyBCheck = (await resBCheck.json()) as { prompt: InteractivePrompt | null };
    expect(bodyBCheck.prompt).not.toBeNull();
    expect(bodyBCheck.prompt!.question).toBe("Database Engine");

    const ansB = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneIdB,
        prompt_id: bodyBCheck.prompt!.id,
        option_index: 0,
      }),
    });
    expect(ansB.status).toBe(200);

    expect(receivedReplies.length).toBe(1);
    expect(receivedReplies[0]!.sessionID).toBe(SESSION_B);
    expect(receivedReplies[0]!.formID).toBe("form_b_1");
    expect(receivedReplies[0]!.answer).toEqual({ db: "postgres" });

    const promptA2 = await readCard(paneIdA);
    expect(promptA2).not.toBeNull();
    expect(promptA2!.can_step_back).toBe(true);

    const ansA2 = await fetch(`http://127.0.0.1:${server.port}/api/pane/prompt/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pane_id: paneIdA,
        prompt_id: promptA2!.id,
        option_index: 1,
      }),
    });
    expect(ansA2.status).toBe(200);

    expect(receivedReplies.length).toBe(2);
    expect(receivedReplies[1]!.sessionID).toBe(SESSION_A);
    expect(receivedReplies[1]!.formID).toBe("form_a_1");
    expect(receivedReplies[1]!.answer).toEqual({
      service_name: "AuthService",
      env: "production",
    });
  }, 25_000);
});
