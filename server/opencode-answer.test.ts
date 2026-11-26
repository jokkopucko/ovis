import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, InteractivePrompt, PromptAnswer } from "../shared/protocol.ts";
import { handlePromptRequest, OpenCodePromptState, promptWaitEnded, shownPromptText } from "./prompt.ts";
import * as service from "./opencode-service.ts";
import type { OpenCodeFormInfo } from "./opencode-service.ts";

const deferred = <T>() => Promise.withResolvers<T>();
let serial = 0;

async function fixture(run: (f: {
  forms: OpenCodeFormInfo[];
  session: string | null;
  closed: boolean;
  replies: unknown[];
  sent: string[];
  version: string;
  permissions: unknown[];
  permissionReplies: { path: string; body: unknown }[];
  permissionReply?: () => Response;
  permissionListing?: () => Promise<Response>;
  /** GET /api/session/{id}/message/{messageID} answers, by message id */
  messages: Record<string, unknown>;
  messageReads: number;
  listing?: () => Promise<Response>;
  replying?: () => Promise<Response>;
  snapshot?: () => Promise<void>;
  serviceFile: string;
  working(): void;
  readResponse(): Promise<Response>;
  read(): Promise<InteractivePrompt>;
  /** a prompt watch's read of its own state, of the pane as it ran the given session */
  watch(state: OpenCodePromptState, session: string): Promise<string | null | undefined>;
  answer(prompt: InteractivePrompt, choice: Omit<PromptAnswer, "pane_id" | "prompt_id">, signal?: AbortSignal): Promise<Response>;
  /** answers delivered, by the way they went */
  counted: { answers: number; ways: (string | null)[] };
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "opencode-answer-"));
  const path = join(root, "herdr.sock");
  const paneId = `oc_${++serial}`;
  const session = "ses_fixture01";
  const url = new URL(`http://localhost/api/pane/prompt?pane_id=${paneId}`);
  const answerUrl = new URL("http://localhost/api/pane/prompt/answer");
  const counted = { answers: 0, ways: [] as (string | null)[] };
  const options = { openCodeStateDir: root, onAnswering: () => (way: string | null) => { counted.ways.push(way); if (way !== null) counted.answers += 1; } };
  const f = {
    counted,
    serviceFile: join(root, "service.json"),
    working: () => promptWaitEnded(paneId),
    session: session as string | null, closed: false,
    forms: [{
      id: "form_a", sessionID: session, title: "Fixture", metadata: { kind: "question" },
      fields: [{ key: "q0", type: "string", custom: true }, { key: "q1", type: "string", custom: true }],
    }] satisfies OpenCodeFormInfo[],
    replies: [] as unknown[], sent: [] as string[],
    version: "2.0.32", permissions: [] as unknown[], permissionReplies: [] as { path: string; body: unknown }[],
    permissionReply: undefined as (() => Response) | undefined,
    permissionListing: undefined as (() => Promise<Response>) | undefined,
    messages: Object.fromEntries(commands.map(({ message }) => [message.data.id, message])) as Record<string, unknown>, messageReads: 0,
    listing: undefined as (() => Promise<Response>) | undefined,
    replying: undefined as (() => Promise<Response>) | undefined,
    snapshot: undefined as (() => Promise<void>) | undefined,
    async readResponse() {
      const response = await handlePromptRequest(new Request(url), url, options);
      if (!response) throw new Error("Missing prompt response");
      return response;
    },
    async read() {
      const response = await handlePromptRequest(new Request(url), url, options);
      expect(response?.status).toBe(200);
      const text = await response!.text();
      expect(text).not.toContain("fixture-password");
      expect(text).not.toContain(service.url.origin);
      const { prompt } = JSON.parse(text) as { prompt: InteractivePrompt };
      return prompt;
    },
    watch(state: OpenCodePromptState, value: string) {
      const pane = { pane_id: paneId, agent: "opencode", agent_status: "blocked", agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value } } as HerdrPane;
      return shownPromptText(pane, [pane], { openCodeStateDir: root, openCodeState: state, ompLookups: new Map() });
    },
    async answer(prompt: InteractivePrompt, choice: Omit<PromptAnswer, "pane_id" | "prompt_id">, signal?: AbortSignal) {
      const response = await handlePromptRequest(new Request(answerUrl, {
        method: "POST", signal, body: JSON.stringify({ pane_id: paneId, prompt_id: prompt.id, ...choice }),
      }), answerUrl, options);
      expect(response).not.toBeNull();
      const text = await response!.clone().text();
      expect(text).not.toContain("fixture-password");
      expect(text).not.toContain(service.url.origin);
      return response!;
    },
  };
  const service = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/api/info") return Response.json({ version: f.version, pid: process.pid, urls: [], paths: { tmp: root } });
      if (request.method === "GET" && pathname.endsWith("/permission")) {
        const listing = f.permissionListing;
        f.permissionListing = undefined;
        return listing ? listing() : Response.json({ data: f.permissions });
      }
      if (request.method === "GET" && pathname.startsWith("/api/session/ses_fixture01/message/")) {
        f.messageReads += 1;
        const message = f.messages[decodeURIComponent(pathname.split("/").at(-1)!)];
        return message ? Response.json(message) : Response.json({ _tag: "NotFound" }, { status: 404 });
      }
      if (request.method === "POST" && pathname.includes("/permission/")) {
        f.permissionReplies.push({ path: pathname, body: await request.json() });
        return f.permissionReply?.() ?? new Response(null, { status: 204 });
      }
      if (request.method === "GET") {
        const listing = f.listing;
        f.listing = undefined;
        return listing ? listing() : Response.json(f.forms);
      }
      f.replies.push(await request.json());
      return f.replying ? f.replying() : new Response(null, { status: 204 });
    },
  });
  writeFileSync(join(root, "service.json"), JSON.stringify({ url: service.url.origin, password: "fixture-password", pid: process.pid }));
  const sockets = new Set<Socket>();
  const rpc = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const req = JSON.parse(input.split("\n")[0]!) as { id: string; method: string };
      const pane = {
        pane_id: paneId, agent: f.session ? "opencode" : null, agent_status: "blocked",
        agent_session: f.session ? { agent: "opencode", source: "herdr:opencode", kind: "id", value: f.session } : null,
      };
      if (req.method.startsWith("pane.send")) f.sent.push(req.method);
      const result = req.method === "session.snapshot" ? { snapshot: { panes: f.closed ? [] : [pane], layouts: [] } } : { read: { text: "" } };
      const hold = req.method === "session.snapshot" ? f.snapshot : undefined;
      if (hold) f.snapshot = undefined;
      if (hold) void hold().then(() => socket.end(`${JSON.stringify({ id: req.id, result })}\n`));
      else socket.end(`${JSON.stringify({ id: req.id, result })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => { rpc.once("error", reject); rpc.listen(path, resolve); });
  const previous = process.env["HERDR_SOCKET"];
  process.env["HERDR_SOCKET"] = path;
  try { await run(f); expect(f.sent).toEqual([]); }
  finally {
    if (previous === undefined) delete process.env["HERDR_SOCKET"]; else process.env["HERDR_SOCKET"] = previous;
    service.stop(true);
    for (const socket of sockets) socket.destroy();
    rpc.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe("OpenCode answer ordering", () => {
  it("asks for the verified service on Windows too, for the question card and its answer", async () => {
    const asked = spyOn(service, "openCodeService");
    try {
      await fixture(async (f) => {
        f.forms[0]!.fields.length = 1;
        const prompt = await f.read();
        expect((await f.answer({ ...prompt, id: `${prompt.id}-stale` }, { custom_text: "answered" })).status).toBe(409);
        expect(f.counted.answers).toBe(0);
        expect((await f.answer(prompt, { custom_text: "answered" })).status).toBe(200);
        expect(f.replies).toHaveLength(1);
        expect(f.counted.answers).toBe(1);
        expect(f.counted.ways.at(-1)).toBe("native");
      });
      expect(asked.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(asked.mock.calls.every((call) => call[2]?.onWindows === true)).toBe(true);
    } finally {
      asked.mockRestore();
    }
  });

  it("keeps the prompt id and defaults after a failed reply and allows immediate retry", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      const prompt = await f.read();
      f.replying = async () => new Response(null, { status: 503 });
      expect((await f.answer(prompt, { custom_text: "submitted" })).status).toBe(502);
      const polled = await f.read();
      expect(polled.id).toBe(prompt.id);
      expect(polled.default_custom_text).toBeUndefined();
      f.replying = undefined;
      expect((await f.answer(prompt, { custom_text: "later correction" })).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: "submitted" } }, { answer: { q0: "later correction" } }]);
    });
  });

  it.each(["string", "select", "multiselect"])("allows an optional %s question to be skipped", async (type) => {
    await fixture(async (f) => {
      f.forms[0]!.fields = [{ key: "q0", type, required: false, options: type === "string" ? [] : [{ value: "a", label: "A" }] }];
      const prompt = await f.read();
      expect(prompt.optional).toBe(true);
      expect((await f.answer(prompt, type === "multiselect" ? { option_indices: [] } : { custom_text: "" })).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: type === "multiselect" ? [] : "" } }]);
    });
  });

  it.each(["string", "select", "multiselect"])("still requires an answer for a required %s question", async (type) => {
    await fixture(async (f) => {
      f.forms[0]!.fields = [{ key: "q0", type, required: true, options: type === "string" ? [] : [{ value: "a", label: "A" }] }];
      const prompt = await f.read();
      expect((await f.answer(prompt, type === "multiselect" ? { option_indices: [] } : { custom_text: "" })).status).toBe(400);
      expect(f.replies).toEqual([]);
    });
  });

  it("uses an empty array when skipping an optional multiselect with empty custom text", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields = [{ key: "q0", type: "multiselect", required: false }];
      expect((await f.answer(await f.read(), { custom_text: "" })).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: [] } }]);
    });
  });

  it("keeps drafts when unrelated upstream fields change", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "saved first" })).status).toBe(200);
      const prompt = await f.read();
      f.forms[0]!.metadata = { kind: "question", timestamp: 123 };
      expect((await f.read()).id).toBe(prompt.id);
      expect((await f.read()).steps?.[1]?.current).toBe(true);
    });
  });

  it("invalidates drafts when a reused form changes its fields", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "saved first" })).status).toBe(200);
      const prompt = await f.read();
      f.forms[0]!.fields[0]!.key = "replacement";
      const replacement = await f.read();
      expect(replacement.id).not.toBe(prompt.id);
      expect(replacement.steps?.[0]?.current).toBe(true);
      expect(replacement.default_custom_text).toBeUndefined();
    });
  });

  it("never returns service credentials or location in GET and POST responses", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      expect((await f.answer(await f.read(), { custom_text: "first" })).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: "first" } }]);
    });
  });
  it.each(["switch", "close", "abort"] as const)("refuses an answer when %s happens during form lookup", async (change) => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      const prompt = await f.read();
      const entered = deferred<void>();
      const release = deferred<void>();
      const controller = new AbortController();
      f.listing = async () => { entered.resolve(); await release.promise; return Response.json(f.forms); };
      const answering = f.answer(prompt, { custom_text: "private answer" }, controller.signal);
      await entered.promise;
      if (change === "switch") f.session = "ses_fixture02";
      if (change === "close") f.closed = true;
      if (change === "abort") controller.abort();
      release.resolve();
      expect((await answering).status).toBe(409);
      expect(f.replies).toEqual([]);
    });
  });

  it("does not let a late empty listing erase an acknowledged answer", async () => {
    await fixture(async (f) => {
      const first = await f.read();
      const entered = deferred<void>();
      const release = deferred<void>();
      f.listing = async () => { entered.resolve(); await release.promise; return Response.json([]); };
      const oldRead = f.read();
      await entered.promise;
      expect((await f.answer(first, { custom_text: "saved first" })).status).toBe(200);
      release.resolve();
      expect((await oldRead).steps?.[1]?.current).toBe(true);
      expect((await f.read()).steps?.[1]?.current).toBe(true);
    });
  });

  it("does not copy an old form answer into its replacement", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "old secret" })).status).toBe(200);
      f.forms[0]!.id = "form_replacement";
      expect((await f.read()).default_custom_text).toBeUndefined();
    });
  });

  it("does not reuse a draft in another session with the same form id", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "old session" })).status).toBe(200);
      f.session = "ses_fixture02";
      f.forms[0]!.sessionID = f.session;
      expect((await f.read()).steps?.[0]?.current).toBe(true);
    });
  });

  it("drops buffered answers when the OpenCode session ends", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "old session" })).status).toBe(200);
      f.session = null;
      expect(await f.read()).toBeNull();
      f.session = "ses_fixture01";
      expect((await f.read()).steps?.[0]?.current).toBe(true);
    });
  });

  it("keeps custom multiselect answers as native arrays", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields = [{ key: "q0", type: "multiselect", custom: true, options: [{ value: "a", label: "A" }] }];
      const prompt = await f.read();
      expect(prompt.custom_option_index).toBe(1);
      expect((await f.answer(prompt, { custom_text: "own" })).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: ["own"] } }]);
    });
  });

  it("returns graceful fallback for malformed fields", async () => {
    await fixture(async (f) => {
      f.listing = async () => Response.json([{ ...f.forms[0], fields: [null] }]);
      expect((await f.read()).fallback).toBe(true);
    });
  });

  it.each(["empty", "permission", "missing", "error", "slow"] as const)("keeps the fallback card when native lookup is %s", async (kind) => {
    await fixture(async (f) => {
      const release = deferred<Response>();
      if (kind === "empty") f.forms = [];
      if (kind === "permission") f.forms[0]!.metadata = { kind: "permission" };
      if (kind === "missing") rmSync(f.serviceFile);
      if (kind === "error") f.listing = async () => new Response(null, { status: 503 });
      if (kind === "slow") f.listing = () => release.promise;
      try { expect((await f.read()).fallback).toBe(true); }
      finally { release.resolve(Response.json([])); }
    });
  });

  it("does not let a newer poll reject a valid answer to the same form", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      const prompt = await f.read();
      const entered = deferred<void>();
      const release = deferred<void>();
      f.listing = async () => { entered.resolve(); await release.promise; return Response.json(f.forms); };
      const answering = f.answer(prompt, { custom_text: "first" });
      await entered.promise;
      expect((await f.read()).id).toBe(prompt.id);
      release.resolve();
      expect((await answering).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: "first" } }]);
    });
  });

  it("keeps newer session progress when an old snapshot arrives late", async () => {
    await fixture(async (f) => {
      await f.read();
      const entered = deferred<void>();
      const release = deferred<void>();
      f.snapshot = async () => { entered.resolve(); await release.promise; };
      const oldRead = f.read();
      await entered.promise;
      f.session = "ses_fixture02";
      f.forms[0]!.sessionID = f.session;
      expect((await f.answer(await f.read(), { custom_text: "session B" })).status).toBe(200);
      release.resolve();
      await oldRead;
      expect((await f.read()).steps?.[1]?.current).toBe(true);
    });
  });

  it("sends no key when the lookup right before the key is overtaken by another session", async () => {
    await fixture(async (f) => {
      f.forms = [];
      const prompt = await f.read();
      expect(prompt.fallback).toBe(true);
      const entered = deferred<void>();
      const release = deferred<void>();
      f.listing = async () => {
        f.listing = async () => { entered.resolve(); await release.promise; return Response.json([]); };
        return Response.json([]);
      };
      const answering = f.answer(prompt, { option_index: prompt.options.findIndex((option) => option.label === "Enter") });
      await entered.promise;
      f.session = "ses_fixture02";
      await f.read();
      release.resolve();
      expect((await answering).status).toBe(409);
    });
  });

  it("does not return an empty card for a lookup superseded by another session", async () => {
    await fixture(async (f) => {
      await f.read();
      const entered = deferred<void>();
      const release = deferred<void>();
      const oldForms = structuredClone(f.forms);
      f.listing = async () => { entered.resolve(); await release.promise; return Response.json(oldForms); };
      const oldRead = f.readResponse();
      await entered.promise;
      f.session = "ses_fixture02";
      f.forms[0]!.sessionID = f.session;
      const current = await f.read();
      release.resolve();
      const response = await oldRead;
      expect(response.status).toBe(409);
      expect((await f.read()).id).toBe(current.id);
    });
  });

  it.each(["error", "slow", "missing"] as const)("keeps card identity and edits across transient %s", async (kind) => {
    await fixture(async (f) => {
      const prompt = await f.read();
      const release = deferred<Response>();
      if (kind === "error") f.listing = async () => new Response(null, { status: 503 });
      if (kind === "slow") f.listing = () => release.promise;
      if (kind === "missing") rmSync(f.serviceFile);
      try {
        expect((await f.read()).id).toBe(prompt.id);
        if (kind !== "missing") expect((await f.read()).id).toBe(prompt.id);
      } finally { release.resolve(Response.json(f.forms)); }
    });
  });

  it("submits multiselect checks and custom text together", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields = [{ key: "q0", type: "multiselect", custom: true, options: [{ value: "a", label: "A" }] }];
      expect((await f.answer(await f.read(), { option_indices: [0], custom_text: "own" })).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: ["a", "own"] } }]);
    });
  });

  it("does not poll again after advancing a native form", async () => {
    await fixture(async (f) => {
      const first = await f.read();
      let reads = 0;
      const list = async (): Promise<Response> => {
        reads++;
        f.listing = list;
        return Response.json(f.forms);
      };
      f.listing = list;
      expect((await f.answer(first, { custom_text: "first" })).status).toBe(200);
      expect(reads).toBe(1);
    });
  });

  it("never submits for a Next, with or without an answer in the same body", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      const card = await f.read();
      expect((await f.answer(card, { step_next: true, custom_text: "first" })).status).toBe(400);
      expect((await f.answer(card, { step_next: true })).status).toBe(400);
      expect(f.replies).toEqual([]);
      expect(f.counted.answers).toBe(0);
    });
  });

  it("saves unsent edits on backward navigation", async () => {
    await fixture(async (f) => {
      expect((await f.answer(await f.read(), { custom_text: "first" })).status).toBe(200);
      expect((await f.answer(await f.read(), {
        step_back: true, draft: { option_indices: [], custom_text: "not submitted yet" },
      })).status).toBe(200);
      expect((await f.answer(await f.read(), { custom_text: "revised first" })).status).toBe(200);
      expect((await f.read()).default_custom_text).toBe("not submitted yet");
      expect(f.replies).toEqual([]);
      expect(f.counted.answers).toBe(0);
    });
  });

  it.each(["session", "working", "settled"] as const)("acknowledges a delivered answer despite concurrent %s", async (change) => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      const entered = deferred<void>();
      const release = deferred<void>();
      f.replying = async () => { entered.resolve(); await release.promise; return new Response(null, { status: 204 }); };
      const answering = f.answer(await f.read(), { custom_text: "first" });
      await entered.promise;
      if (change === "session") f.session = "ses_fixture02";
      if (change === "working") f.working();
      if (change === "settled") { f.forms = []; await f.read(); }
      release.resolve();
      expect((await answering).status).toBe(200);
      expect(f.replies).toEqual([{ answer: { q0: "first" } }]);
    });
  });

  it("reports an unknown delivery rather than failure when the native reply times out", async () => {
    await fixture(async (f) => {
      f.forms[0]!.fields.length = 1;
      const release = deferred<Response>();
      f.replying = () => release.promise;
      try {
        const response = await f.answer(await f.read(), { custom_text: "accepted upstream" });
        expect((await response.json() as { error: { code: string } }).error.code).toBe("reply_unconfirmed");
        expect(f.replies).toEqual([{ answer: { q0: "accepted upstream" } }]);
      } finally { release.resolve(new Response(null, { status: 204 })); }
    });
  }, 3_000);

  it("bounds an unresponsive service lookup without waiting for a reply", async () => {
    await fixture(async (f) => {
      const prompt = await f.read();
      const release = deferred<Response>();
      f.listing = () => release.promise;
      const start = performance.now();
      try {
        expect((await f.answer(prompt, { custom_text: "first" })).status).toBe(502);
        expect(performance.now() - start).toBeLessThan(2_500);
        expect(f.replies).toEqual([]);
      } finally { release.resolve(Response.json(f.forms)); }
    });
  }, 3_000);

  it("drops the card once the form is answered or cancelled elsewhere, with no fallback card while herdr still says blocked", async () => {
    for (const [form, gone] of questions) {
      await fixture(async (f) => {
        f.forms = [form];
        const prompt = await f.read();
        expect(prompt).toMatchObject({ agent: "opencode", options: [{ label: "Red" }, { label: "Blue" }, {}] });
        f.forms = [];
        expect(await f.read(), gone).toBeNull();
        expect((await f.answer(prompt, { option_index: 0 })).status).toBe(409);
        expect(f.replies).toEqual([]);
      });
    }
  });

  it("keeps the fallback card of a permission it cannot show when a form beside it closes", async () => {
    await fixture(async (f) => {
      f.forms = [questions[0]![0]];
      f.permissions = [asked("shell")];
      f.messages = {};
      expect((await f.read()).fallback).toBe(true);
      f.forms = [];
      expect((await f.read())?.fallback).toBe(true);
    });
  });

  it("keeps the fallback card when a form closes on a read whose permission list failed", async () => {
    await fixture(async (f) => {
      f.forms = [questions[0]![0]];
      expect((await f.read()).fallback).toBeUndefined();
      f.forms = [];
      f.permissionListing = async () => new Response(null, { status: 503 });
      expect((await f.read())?.fallback).toBe(true);
    });
  });

  it("keeps another session's fallback card when a watch still reading the pane's earlier session sees that session's form go", async () => {
    await fixture(async (f) => {
      const watch = new OpenCodePromptState();
      f.forms = [questions[0]![0]];
      expect(await f.watch(watch, "ses_fixture01")).toEqual(expect.any(String));
      f.session = "ses_fixture02";
      expect((await f.read()).fallback).toBe(true);
      f.forms = [];
      await f.watch(watch, "ses_fixture01");
      expect((await f.read())?.fallback).toBe(true);
    });
  });
});

/** The question forms a real OpenCode 2.2.2 asked (server/fixtures/opencode-form-2.2.2.json), moved to the fixture's session, each with how it ended. */
const formEvents = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "opencode-form-2.2.2.json"), "utf8")) as { events: { type: string; data: { id?: string; form?: OpenCodeFormInfo } }[] }).events;
const questions = formEvents.filter((event) => event.type === "form.created").map((event) => [
  { ...event.data.form!, sessionID: "ses_fixture01" },
  formEvents.find((ended) => ended.type !== "form.created" && ended.data.id === event.data.form!.id)!.type,
] as const);

/** The permission requests a real OpenCode 2.2.2 asked (server/fixtures/opencode-permission-2.2.2.json), moved to the fixture's session. */
const recorded: Record<string, unknown>[] = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "opencode-permission-2.2.2.json"), "utf8")) as { events: { type: string; data: Record<string, unknown> }[] })
  .events.filter((event) => event.type === "permission.asked").map((event) => ({ ...event.data, sessionID: "ses_fixture01" }));
/** Shell requests a real OpenCode 2.2.2 asked, each with the message its call is in and the command that ran (server/fixtures/opencode-permission-command-2.2.2.json). */
const commands = (JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "opencode-permission-command-2.2.2.json"), "utf8")) as {
  cases: { condition: string; executed: string; permission: { id: string } & Record<string, unknown>; message: { data: { id: string; content: { state: { input: Record<string, unknown> } }[] } } }[];
}).cases.map((recorded) => ({ ...recorded, permission: { ...recorded.permission, sessionID: "ses_fixture01" } }));
const command = (condition: string) => commands.find((recorded) => recorded.condition === condition)!;
const asked = (action: string): Record<string, unknown> => action === "shell" ? command("long").permission : recorded.find((request) => request.action === action)!;

describe("OpenCode permission card", () => {
  it.each([[0, "once"], [1, "always"], [2, "reject"]] as const)("answers the pending request through its service: option %i is %s, no key typed", async (index, decision) => {
    await fixture(async (f) => {
      f.forms = [];
      f.permissions = [asked("shell")];
      const prompt = await f.read();
      expect(prompt).toMatchObject({ kind: "approval", agent: "opencode", body: `$ ${command("long").executed}` });
      expect(prompt.options).toHaveLength(3);
      expect((await f.answer(prompt, { option_index: index })).status).toBe(200);
      expect(f.permissionReplies).toEqual([{ path: `/api/session/ses_fixture01/permission/${String(asked("shell").id)}/reply`, body: { decision } }]);
      expect(f.counted.answers).toBe(1);
      expect(f.counted.ways).toEqual(["native"]);
    });
  });

  it("drops the card once the request is answered elsewhere, with no fallback card while herdr still says blocked, and refuses an answer to it", async () => {
    await fixture(async (f) => {
      f.forms = [];
      f.permissions = [asked("edit")];
      const prompt = await f.read();
      f.permissions = [];
      expect(await f.read()).toBeNull();
      expect((await f.answer(prompt, { option_index: 0 })).status).toBe(409);
      expect(f.permissionReplies).toEqual([]);
    });
  });

  it("reports a request OpenCode no longer holds as changed", async () => {
    await fixture(async (f) => {
      f.forms = [];
      f.permissions = [asked("webfetch")];
      f.permissionReply = () => Response.json({ _tag: "PermissionNotFoundError" }, { status: 404 });
      const prompt = await f.read();
      expect((await f.answer(prompt, { option_index: 1 })).status).toBe(409);
      expect(f.permissionReplies).toHaveLength(1);
    });
  });

  it("shows the command another call runs, though the request keeps its id", async () => {
    await fixture(async (f) => {
      f.forms = [];
      f.permissions = [command("short").permission];
      expect((await f.read()).body).toBe(`$ ${command("short").executed}`);
      f.permissions = [{ ...command("long").permission, id: command("short").permission.id }];
      expect((await f.read()).body).toBe(`$ ${command("long").executed}`);
    });
  });

  it("shows the whole command a request's call runs, its message read again by no later read", async () => {
    await fixture(async (f) => {
      f.forms = [];
      for (const { permission, executed } of commands) {
        f.permissions = [permission];
        const reads = f.messageReads;
        expect((await f.read()).body).toBe(`$ ${executed}`);
        expect((await f.read()).body).toBe(`$ ${executed}`);
        expect(f.messageReads).toBe(reads + 1);
      }
    });
  });

  it.each(["version", "build", "shape", "session", "size", "message", "streaming"] as const)("leaves the request to the fallback card: %s not read", async (kind) => {
    await fixture(async (f) => {
      f.forms = [];
      f.permissions = [asked("shell")];
      if (kind === "version") f.version = "3.0.0";
      if (kind === "build") f.version = "2.unknown";
      if (kind === "shape") f.permissions = [{ ...asked("shell"), resources: "ls -la ." }];
      if (kind === "session") f.permissions = [{ ...asked("shell"), sessionID: "ses_other" }];
      const { message } = command("long");
      const call = message.data.content[0]!;
      const withState = (state: Record<string, unknown>) => ({ ...message, data: { ...message.data, content: [{ ...call, state: { ...call.state, ...state } }] } });
      if (kind === "size") f.messages = { [message.data.id]: withState({ input: { command: "echo " + "x".repeat(12_000) } }) };
      if (kind === "message") f.messages = {};
      if (kind === "streaming") f.messages = { [message.data.id]: withState({ status: "streaming" }) };
      expect((await f.read()).fallback).toBe(true);
    });
  });
it("sends nothing to a service that is no longer a 2.x one when the answer comes", async () => {
    await fixture(async (f) => {
      f.forms = [];
      f.permissions = [asked("shell")];
      const prompt = await f.read();
      // the answer's first read still sees 2.0.32; the service changes while the pane's binding is checked again
      f.snapshot = async () => {
        f.snapshot = async () => { f.version = "3.0.0"; service.forgetOpenCodeService(); };
      };
      expect((await f.answer(prompt, { option_index: 1 })).status).toBe(502);
      expect(f.permissionReplies).toEqual([]);
    });
  });

  it("shows no request an older read finishing late still listed, once a newer read saw it go", async () => {
    await fixture(async (f) => {
      f.forms = [];
      f.permissions = [asked("shell")];
      const prompt = await f.read();
      const entered = deferred<void>();
      const release = deferred<void>();
      const listed = [...f.permissions];
      f.permissionListing = async () => { entered.resolve(); await release.promise; return Response.json({ data: listed }); };
      const older = f.read();
      await entered.promise;
      f.permissions = [];
      expect((await f.read())?.id).not.toBe(prompt.id);
      release.resolve();
      expect((await older)?.kind).not.toBe("approval");
    });
  });
});
