import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { ApiError, CONVERSATION_ANSWER_MAX_BYTES, CONVERSATION_ANSWERS_BYTES, CONVERSATION_ANSWERS_KEPT, fetchPaneConversation, fetchPaneTranscript, conversationAnswerBytes, observePaneSessions, paneSessionEvents, paneSessionsMoving, peekPaneConversation, pinPaneConversation, prefetchPaneConversation, PRESS_READ_MS, unpinPaneConversation } from "./api.ts";
import { ConversationRefresh } from "./conversationRefresh.ts";
import { withChatReadDeadline } from "./chatReadDeadline.ts";
import type { ConversationResponse } from "../../shared/protocol.ts";

const realFetch = globalThis.fetch;
const globals = globalThis as unknown as { window?: unknown };
const realWindow = globals.window;
let restoreClock: (() => void) | undefined;
afterEach(() => {
  globalThis.fetch = realFetch;
  globals.window = realWindow;
  restoreClock?.();
  restoreClock = undefined;
  // the roster the event a test raised scheduled: this PC's panes are known again, and none is named
  observePaneSessions([{ id: "local", snapshot: { panes: [] } }], paneSessionEvents());
});

/** The roster naming each pane's session (herdr's agent_session), read after every PC event so far. */
function named(machine: string, sessions: Record<string, string | null>): void {
  observePaneSessions([{ id: machine, snapshot: { panes: Object.entries(sessions).map(([pane_id, value]) => ({ pane_id, agent: "claude", agent_session: value === null ? null : { agent: "claude", kind: "id", source: "herdr:claude", value } })) } }], paneSessionEvents());
}

describe("conversation polling", () => {
  it("echoes displayed history, retains it on a retryable read, and forgets it on a rejected history", async () => {
    const requests: { history: string | null; etag: string | null }[] = [];
    let status = 200;
    let history = "history-a";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ history: new URL(url, "http://fixture").searchParams.get("history_id"), etag: new Headers(init?.headers).get("if-none-match") });
      if (status === 304) return new Response(null, { status });
      if (status !== 200) return Response.json({ error: { code: status === 409 ? "history_changed" : "conversation_read_pending", message: "retry" } }, { status });
      return Response.json({ source: "copilot-transcript", history_id: history, cursor: null, turns: [] }, { headers: { etag: `"${history}"` } });
    }) as typeof fetch;
    const first = await fetchPaneConversation("retained-history");
    const displayed = { history_id: first.history_id };
    status = 503;
    await expect(fetchPaneConversation("retained-history", "local", displayed)).rejects.toBeInstanceOf(ApiError);
    expect(peekPaneConversation("retained-history")).toBe(first);
    status = 304;
    expect(await fetchPaneConversation("retained-history", "local", displayed)).toBe(first);
    status = 409;
    await expect(fetchPaneConversation("retained-history", "local", { ...displayed, from: "held-a" })).rejects.toBeInstanceOf(ApiError);
    expect(peekPaneConversation("retained-history")).toBeUndefined();
    status = 200; history = "history-b";
    expect((await fetchPaneConversation("retained-history")).history_id).toBe(history);
    expect(requests).toEqual([
      { history: null, etag: null },
      ...Array.from({ length: 2 }, () => ({ history: "history-a", etag: '"history-a"' })),
      { history: "history-a", etag: null },
      { history: null, etag: null },
    ]);
  });

  it.each([{ from: "history-a:50" }, { before: "history-a:50" }])("forgets every page size of a pane whose history a read rejects: %o", async (held) => {
    let status = 200;
    globalThis.fetch = (async (_url: string) => status === 200
      ? Response.json({ source: "claude-transcript", history_id: "history-a", cursor: "history-a:100", turns: [] }, { headers: { etag: '"history-a"' } })
      : Response.json({ error: { code: "history_changed", message: "reload" } }, { status })) as unknown as typeof fetch;
    const pane = `rejected-sized-${Object.keys(held)[0]}`;
    await fetchPaneConversation(pane);
    await fetchPaneConversation(pane, "local", { prompts: 10 });
    await fetchPaneConversation(pane, "local", { prompts: 25 });
    status = 409;
    await expect(fetchPaneConversation(pane, "local", { ...held, history_id: "history-a", prompts: 10 })).rejects.toBeInstanceOf(ApiError);
    expect([peekPaneConversation(pane), peekPaneConversation(pane, "local", 10), peekPaneConversation(pane, "local", 25)]).toEqual([undefined, undefined, undefined]);
  });

  it("revalidates a new finish without borrowing the previous finish's ETag", async () => {
    const sent: (string | null)[] = [];
    const body: ConversationResponse = { source: "claude-transcript", turns: [] };
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get("if-none-match"));
      return Response.json(body, { headers: { etag: '"same-answer"' } });
    }) as typeof fetch;
    const first = await fetchPaneConversation("finish-proof-revalidate");
    const next = await fetchPaneConversation("finish-proof-revalidate", "local", { fresh: true });
    expect(sent).toEqual([null, null]);
    expect(next).not.toBe(first);
    expect(next).toEqual(first);
  });

  it("asks with the last ETag and reuses the very same answer on a 304", async () => {
    const sent: (string | null)[] = [];
    let version = "\"v1\"";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const asked = new Headers(init?.headers).get("if-none-match");
      sent.push(asked);
      if (asked === version) return new Response(null, { status: 304, headers: { etag: version } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null, v: version }), { status: 200, headers: { etag: version } });
    }) as typeof fetch;
    const first = await fetchPaneConversation("w1:p1");
    const again = await fetchPaneConversation("w1:p1");
    expect(again).toBe(first);
    version = "\"v2\"";
    const changed = await fetchPaneConversation("w1:p1");
    expect(changed).not.toBe(first);
    expect((changed as unknown as { v: string }).v).toBe("\"v2\"");
    // an older page is asked for once: it never sends or keeps an ETag
    await fetchPaneConversation("w1:p1", "local", { before: "c:10" });
    await fetchPaneConversation("w1:p1", "local", { before: "c:10" });
    expect(sent).toEqual([null, "\"v1\"", "\"v1\"", null, null]);
  });

  it("keeps the polled answer however many older pages are read", async () => {
    const sent: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const asked = new Headers(init?.headers).get("if-none-match");
      sent.push(asked);
      if (asked === "\"v\"") return new Response(null, { status: 304, headers: { etag: "\"v\"" } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"v\"" } });
    }) as typeof fetch;
    const polled = await fetchPaneConversation("w9:p1");
    for (let page = 0; page < 40; page++) await fetchPaneConversation("w9:p1", "local", { before: `c:${page}` });
    // other panes polled in between: the one polled again stays the most recent
    for (let pane = 0; pane < 20; pane++) {
      await fetchPaneConversation(`w8:p${pane}`);
      expect(await fetchPaneConversation("w9:p1")).toBe(polled);
    }
    expect(sent.at(-1)).toBe("\"v\"");
  });

  it("gives up the oldest answers when they outgrow the byte budget, not only when there are too many", async () => {
    const asked = new Map<string, string | null>();
    // one answer just under its own maximum (the body carries the filler twice, as a turn and as a
    // field): enough of them outgrow the cache's byte budget while the count cap is still far away,
    // so only the budget can evict
    const filler = "x".repeat(CONVERSATION_ANSWER_MAX_BYTES / 2 - 64 * 1024);
    const panes = Math.ceil(CONVERSATION_ANSWERS_BYTES / CONVERSATION_ANSWER_MAX_BYTES) + 1;
    expect(panes).toBeLessThan(CONVERSATION_ANSWERS_KEPT);
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const etag = new Headers(init?.headers).get("if-none-match");
      asked.set(String(url), etag);
      if (etag !== null) return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [{ text: filler }], cursor: null, filler }), { status: 200, headers: { etag: `"${asked.size}"` } });
    }) as typeof fetch;
    for (let pane = 0; pane < panes; pane++) await fetchPaneConversation(`big:p${pane}`);
    asked.clear();
    // the newest panes are still cached, the ones the budget pushed out are not
    await fetchPaneConversation(`big:p${panes - 1}`);
    expect([...asked.values()]).toEqual([`"${panes}"`]);
    asked.clear();
    await fetchPaneConversation("big:p0");
    expect([...asked.values()]).toEqual([null]);
  });

  it("keeps the open pane's page at the size it was read, not the size a pin was taken at", async () => {
    // one answer just under its own maximum: only the byte budget can evict
    const filler = "x".repeat(CONVERSATION_ANSWER_MAX_BYTES / 2 - 64 * 1024);
    const panes = Math.ceil(CONVERSATION_ANSWERS_BYTES / CONVERSATION_ANSWER_MAX_BYTES) + 1;
    let reads = 0;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      reads += 1;
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [{ text: filler }], cursor: null, filler }), { status: 200, headers: { etag: `"${reads}"` } });
    }) as typeof fetch;
    // the chat's open pane reads its newest page at the page size the setting names
    pinPaneConversation("open:p1");
    const open = await fetchPaneConversation("open:p1", "local", { prompts: 10 });
    // the control: the same read on a pane the chat does not have open
    const control = await fetchPaneConversation("control:p1", "local", { prompts: 10 });
    expect(peekPaneConversation("control:p1", "local", 10)).toBe(control);
    for (let pane = 0; pane < panes; pane++) await fetchPaneConversation(`big:p${pane}`);
    // pinned by pane: the answer the open pane actually holds survives the budget
    expect(peekPaneConversation("open:p1", "local", 10)).toBe(open);
    // the control is gone
    expect(peekPaneConversation("control:p1", "local", 10)).toBeUndefined();
    unpinPaneConversation("open:p1");
  });
});

describe("conversation read started by a press", () => {
  // herdr reports each pane's session: only then is a press read started and taken
  beforeEach(() => named("local", Object.fromEntries(["press:p1", "press:p2", "press:held", "press:again", "press:p3", "press:p4", "press:late", "press:failed"].map((pane) => [pane, "a"]))));
  /** every request the chat makes: its query and whether it revalidates */
  function answering(): { url: string; etag: string | null }[] {
    const sent: { url: string; etag: string | null }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), etag: new Headers(init?.headers).get("if-none-match") });
      return Response.json({ source: "claude-transcript", history_id: "history-a", cursor: null, turns: [] }, { headers: { etag: '"a"' } });
    }) as typeof fetch;
    return sent;
  }

  it("starts at the press, and the mount read of the chat it opens takes it instead of asking again", async () => {
    const sent = answering();
    prefetchPaneConversation("press:p1", "local", 10);
    expect(sent).toHaveLength(1);
    // ChatView's mount read: no answer shown yet, a new presentation
    const mounted = await fetchPaneConversation("press:p1", "local", { prompts: 10, fresh: true });
    expect(sent).toHaveLength(1);
    expect(peekPaneConversation("press:p1", "local", 10)).toBe(mounted);
    // taken once: the next read asks the server
    await fetchPaneConversation("press:p1", "local", { prompts: 10, history_id: mounted.history_id });
    expect(sent).toHaveLength(2);
  });

  it("names the history of the cached answer the mount read draws, so that read still takes it", async () => {
    const sent = answering();
    await fetchPaneConversation("press:p2", "local", { prompts: 10 });
    prefetchPaneConversation("press:p2", "local", 10);
    prefetchPaneConversation("press:p2", "local", 10);
    await fetchPaneConversation("press:p2", "local", { prompts: 10, history_id: "history-a", fresh: true });
    expect(sent.map((request) => new URL(request.url, "http://fixture").searchParams.get("history_id"))).toEqual([null, "history-a"]);
    expect(sent[1]!.etag).toBeNull();
  });

  /** A press held past its read's answer (a click lasts 50-150 ms): the answer is in the cache before the chat mounts. */
  async function heldPast(paneId: string, before?: ConversationResponse): Promise<void> {
    for (let turn = 0; turn < 50 && peekPaneConversation(paneId, "local", 10) === before; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** ChatView's mount: the cached answer draws before paint, then the mount read names its history. */
  async function mount(paneId: string): Promise<{ drawn: ConversationResponse | undefined; read: ConversationResponse }> {
    const drawn = peekPaneConversation(paneId, "local", 10);
    return { drawn, read: await fetchPaneConversation(paneId, "local", { prompts: 10, history_id: drawn?.history_id, fresh: true }) };
  }

  it("is taken by the mount read of a press held past its answer, which names that answer's history", async () => {
    const sent = answering();
    prefetchPaneConversation("press:held", "local", 10);
    await heldPast("press:held");
    const { drawn } = await mount("press:held");
    expect(drawn?.history_id).toBe("history-a");
    expect(sent).toHaveLength(1);
  });

  it("gives a chat opened again an answer of its own, not the one it drew", async () => {
    const sent = answering();
    const earlier = await fetchPaneConversation("press:again", "local", { prompts: 10 });
    prefetchPaneConversation("press:again", "local", 10);
    await heldPast("press:again", earlier);
    const { drawn, read } = await mount("press:again");
    expect(sent).toHaveLength(2);
    // the very object drawn would tell the chat nothing was read: no presentation read, no finish proved
    expect(read).not.toBe(drawn);
    expect(read).toEqual(drawn!);
  });

  it("is not taken once it failed: the chat that mounts after it asks the server again (#2593)", async () => {
    let status = 503;
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => { failed = resolve; });
    const sent: string[] = [];
    globalThis.fetch = (async (url: string) => {
      sent.push(String(url));
      if (status === 200) return Response.json({ source: "claude-transcript", history_id: "history-a", cursor: null, turns: [] }, { headers: { etag: '"a"' } });
      const response = Response.json({ error: { code: "conversation_read_pending", message: "retry" } }, { status });
      const body = response.json.bind(response);
      // the press read has its error once this body is read; the rest of its failure is promise turns
      response.json = async () => { try { return await body(); } finally { failed(); } };
      return response;
    }) as typeof fetch;
    prefetchPaneConversation("press:failed", "local", 10);
    await failure;
    await new Promise((resolve) => setImmediate(resolve));
    // the bridge is back before the chat mounts, within PRESS_READ_MS of the press
    status = 200;
    const mounted = await fetchPaneConversation("press:failed", "local", { prompts: 10, fresh: true });
    expect(mounted.history_id).toBe("history-a");
    expect(sent).toHaveLength(2);
  });

  it("starts nothing for a pane whose chat is mounted: a cached tab reads no more than before", () => {
    const sent = answering();
    pinPaneConversation("press:p3");
    prefetchPaneConversation("press:p3", "local", 10);
    unpinPaneConversation("press:p3");
    expect(sent).toHaveLength(0);
  });

  it("is not taken by another page, PC or page size, nor once its press is old", async () => {
    const sent = answering();
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    restoreClock = () => { clock.mockRestore(); };
    prefetchPaneConversation("press:p4", "local", 10);
    await fetchPaneConversation("press:p4", "local", { prompts: 25 });
    await fetchPaneConversation("press:p4", "pc-a", { prompts: 10 });
    await fetchPaneConversation("press:p4", "local", { prompts: 10, before: "history-a:5" });
    expect(sent).toHaveLength(4);
    now = PRESS_READ_MS;
    await fetchPaneConversation("press:p4", "local", { prompts: 10, fresh: true });
    expect(sent).toHaveLength(5);
  });

  it("is taken only while the roster names the session it was read for: a pane on another one asks the server", async () => {
    const sent: string[] = [];
    const histories = new Map<string, string>([["press:same", "session-a"], ["press:switched", "session-a"]]);
    globalThis.fetch = (async (url: string) => {
      const pane = new URL(url, "http://fixture").searchParams.get("pane_id")!;
      sent.push(pane);
      const history = histories.get(pane)!;
      return Response.json({ source: "claude-transcript", history_id: history, cursor: null, turns: [] }, { headers: { etag: `"${history}"` } });
    }) as typeof fetch;
    const roster = (switched: string) => observePaneSessions([{ id: "local", snapshot: { panes: [
      { pane_id: "press:same", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "a" } },
      { pane_id: "press:switched", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: switched } },
    ] } }]);
    roster("a");
    for (const pane of histories.keys()) {
      prefetchPaneConversation(pane, "local", 10);
      await heldPast(pane);
    }
    // herdr moves one pane to session B between the press read's answer and the click
    histories.set("press:switched", "session-b");
    roster("b");
    const same = await mount("press:same");
    expect(same.read.history_id).toBe("session-a");
    const switched = await mount("press:switched");
    expect(switched.drawn).toBeUndefined();
    expect(switched.read.history_id).toBe("session-b");
    expect(sent).toEqual(["press:same", "press:switched", "press:switched"]);
  });

  it("takes no press read once its PC says its panes changed, before the roster naming them comes", async () => {
    const sent = answering();
    named("local", { "press:moving": "a" });
    prefetchPaneConversation("press:moving", "local", 10);
    await heldPast("press:moving");
    paneSessionsMoving("pc-other");
    await mount("press:moving");
    expect(sent).toHaveLength(1);
    const drawn = peekPaneConversation("press:moving", "local", 10);
    prefetchPaneConversation("press:moving", "local", 10);
    await heldPast("press:moving", drawn);
    paneSessionsMoving("local");
    await mount("press:moving");
    expect(sent).toHaveLength(3);
  });

  it("draws and takes no answer an earlier press read brings between its PC's event and the roster after it", async () => {
    const sent: string[] = [];
    let history = "session-a";
    const first = Promise.withResolvers<void>();
    globalThis.fetch = (async (url: string) => {
      sent.push(url);
      const answered = history;
      if (sent.length === 1) await first.promise;
      return Response.json({ source: "claude-transcript", history_id: answered, cursor: null, turns: [] }, { headers: { etag: `"${answered}"` } });
    }) as typeof fetch;
    observePaneSessions([{ id: "gap-pc", snapshot: { panes: [{ pane_id: "press:gap", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "a" } }] } }]);
    prefetchPaneConversation("press:gap", "gap-pc", 10);
    // herdr moves the pane to B: the PC's event comes, the roster naming B is still on its way
    history = "session-b";
    paneSessionsMoving("gap-pc");
    first.resolve();
    for (let turn = 0; turn < 50 && sent.length < 2; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    // the chat the click opens, before the roster: A's answer is neither drawn nor taken
    expect(peekPaneConversation("press:gap", "gap-pc", 10)?.history_id).not.toBe("session-a");
    const mounted = await fetchPaneConversation("press:gap", "gap-pc", { prompts: 10, fresh: true });
    expect(mounted.history_id).toBe("session-b");
  });

  it("starts no press read for a pane whose session herdr does not report: its chat asks the server on mount", async () => {
    let history = "session-a";
    const sent: string[] = [];
    globalThis.fetch = (async (url: string) => {
      sent.push(url);
      return Response.json({ source: "copilot-transcript", history_id: history, cursor: null, turns: [] }, { headers: { etag: `"${history}"` } });
    }) as typeof fetch;
    named("local", { "press:unnamed": null });
    prefetchPaneConversation("press:unnamed", "local", 10);
    for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    // the agent goes to session B; the roster still names no session
    history = "session-b";
    named("local", { "press:unnamed": null });
    const { read } = await mount("press:unnamed");
    expect(read.history_id).toBe("session-b");
    expect(sent).toHaveLength(1);
  });

  it("keeps a PC's panes unknown after its event until a roster read after it, not one read before it", async () => {
    let history = "session-a";
    const sent: string[] = [];
    globalThis.fetch = (async (url: string) => {
      sent.push(url);
      return Response.json({ source: "claude-transcript", history_id: history, cursor: null, turns: [] }, { headers: { etag: `"${history}"` } });
    }) as typeof fetch;
    const roster = (value: string, readAfter: number) => observePaneSessions([{ id: "local", snapshot: { panes: [{ pane_id: "press:stale", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value } }] } }], readAfter);
    roster("a", paneSessionEvents());
    prefetchPaneConversation("press:stale", "local", 10);
    await heldPast("press:stale");
    // a roster read is out when herdr moves the pane to B and its PC says so; that read answers after the event
    const polled = paneSessionEvents();
    history = "session-b";
    paneSessionsMoving("local");
    roster("a", polled);
    expect(peekPaneConversation("press:stale", "local", 10)).toBeUndefined();
    expect((await mount("press:stale")).read.history_id).toBe("session-b");
    // the refetch the event scheduled names B: the pane's session is known again, and B's pages are kept
    roster("b", paneSessionEvents());
    const read = await fetchPaneConversation("press:stale", "local", { prompts: 10 });
    expect(peekPaneConversation("press:stale", "local", 10)).toBe(read);
    expect(read.history_id).toBe("session-b");
  });

  it("keeps an old press read that answers last out of the cache a newer read filled", async () => {
    const answers: ((history: string) => void)[] = [];
    globalThis.fetch = (async (_url: string) => {
      const history = await new Promise<string>((resolve) => { answers.push(resolve); });
      return Response.json({ source: "claude-transcript", history_id: history, cursor: null, turns: [] }, { headers: { etag: `"${history}"` } });
    }) as typeof fetch;
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    restoreClock = () => { clock.mockRestore(); };
    prefetchPaneConversation("press:late", "local", 10);
    // the chat mounts after the press read is too old to take, and asks again
    now = PRESS_READ_MS;
    const mounted = fetchPaneConversation("press:late", "local", { prompts: 10, fresh: true });
    for (let turn = 0; turn < 50 && answers.length < 2; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    answers[1]!("newer");
    await mounted;
    answers[0]!("older");
    for (let turn = 0; turn < 50 && peekPaneConversation("press:late", "local", 10)?.history_id === "newer"; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peekPaneConversation("press:late", "local", 10)?.history_id).toBe("newer");
  });
});

describe("conversation peek", () => {
  it("hands back the newest page last answered, without asking the server", async () => {
    let asked = 0;
    globalThis.fetch = (async (_url: string) => {
      asked += 1;
      return new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"p\"" } });
    }) as typeof fetch;
    const answer = await fetchPaneConversation("peek:p1");
    expect(peekPaneConversation("peek:p1")).toBe(answer);
    expect(peekPaneConversation("peek:p1", "local")).toBe(answer);
    expect(asked).toBe(1);
  });

  it("has nothing for a pane never read, or read on another PC", async () => {
    globalThis.fetch = (async (_url: string) => new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { status: 200, headers: { etag: "\"q\"" } })) as typeof fetch;
    expect(peekPaneConversation("peek:never")).toBeUndefined();
    await fetchPaneConversation("peek:p2", "pc-a");
    expect(peekPaneConversation("peek:p2", "pc-a")).toBeDefined();
    expect(peekPaneConversation("peek:p2")).toBeUndefined();
  });

  it("hands back the newest turns a held read brought, not the page from before the chat held its start", async () => {
    let turns = 2;
    globalThis.fetch = (async (url: string) => {
      const from = new URL(url, "http://fixture").searchParams.get("from");
      const body = { source: "claude-transcript", history_id: "h", cursor: from ?? "h:0", turns: Array.from({ length: turns }, (_, index) => ({ role: "user", ts: null, parts: [{ kind: "text", text: `turn ${index}` }] })) };
      return Response.json(body, { headers: { etag: `"${from}-${turns}"` } });
    }) as typeof fetch;
    await fetchPaneConversation("peek:held", "local", { prompts: 10 });
    // the newest page moved: the chat holds its start and reads from it from now on
    turns = 6;
    const held = await fetchPaneConversation("peek:held", "local", { from: "h:2", history_id: "h", prompts: 10 });
    // a chat opened again draws what the open one last showed
    expect(peekPaneConversation("peek:held", "local", 10)).toBe(held);
  });

  it("keeps a held page that answers after a newer newest-page read out of the page a chat opened again draws", async () => {
    const held = Promise.withResolvers<void>();
    globalThis.fetch = (async (url: string) => {
      const from = new URL(url, "http://fixture").searchParams.get("from");
      if (from === null) return Response.json({ source: "claude-transcript", history_id: "session-b", cursor: null, turns: [] }, { headers: { etag: '"session-b"' } });
      await held.promise;
      return Response.json({ source: "claude-transcript", history_id: "session-a", cursor: from, turns: [] }, { headers: { etag: '"session-a-held"' } });
    }) as typeof fetch;
    // the chat on session A held its start and unmounted with that read in flight; the pane went to B
    const late = fetchPaneConversation("peek:late-held", "local", { from: "session-a:40", history_id: "session-a", prompts: 10 });
    const plain = await fetchPaneConversation("peek:late-held", "local", { prompts: 10 });
    held.resolve();
    expect((await late).history_id).toBe("session-a");
    expect(peekPaneConversation("peek:late-held", "local", 10)).toBe(plain);
  });

  it.each([{ from: "session-a:40" }, {}])("reads a page sent while the pane left its session again, and keeps none of the old one: %o", async (page) => {
    const pane = `peek:left-${Object.keys(page).length}`;
    let session = "a";
    const first = Promise.withResolvers<void>();
    let reads = 0;
    globalThis.fetch = (async (_url: string) => {
      const history = `session-${session}`;
      if (++reads === 1) await first.promise;
      return Response.json({ source: "claude-transcript", history_id: history, cursor: `${history}:40`, turns: [] }, { headers: { etag: `"${history}"` } });
    }) as typeof fetch;
    const roster = (value: string) => observePaneSessions([{ id: "local", snapshot: { panes: [{ pane_id: pane, agent: "codex", agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value } }] } }]);
    roster("a");
    const read = fetchPaneConversation(pane, "local", { ...page, prompts: 10 });
    session = "b";
    roster("b");
    first.resolve();
    // the caller gets the session the pane is on, never the one it left while the read was out
    const answer = await read;
    expect(answer.history_id).toBe("session-b");
    expect(reads).toBe(2);
    expect(peekPaneConversation(pane, "local", 10)).toBe(answer);
  });

  it("reads again for the session a pane moved to, also when a newer read overtook this one", async () => {
    const pane = "peek:overtaken";
    let history = "session-a";
    const first = Promise.withResolvers<void>();
    let reads = 0;
    globalThis.fetch = (async (_url: string) => {
      const answered = history;
      if (++reads === 1) await first.promise;
      return Response.json({ source: "claude-transcript", history_id: answered, cursor: null, turns: [] }, { headers: { etag: `"${answered}"` } });
    }) as typeof fetch;
    const roster = (value: string) => observePaneSessions([{ id: "local", snapshot: { panes: [{ pane_id: pane, agent: "codex", agent_session: { agent: "codex", kind: "id", source: "herdr:codex", value } }] } }]);
    roster("a");
    const older = fetchPaneConversation(pane, "local", { prompts: 10 });
    history = "session-b";
    roster("b");
    const newer = await fetchPaneConversation(pane, "local", { prompts: 10 });
    first.resolve();
    expect(newer.history_id).toBe("session-b");
    expect((await older).history_id).toBe("session-b");
    expect(peekPaneConversation(pane, "local", 10)?.history_id).toBe("session-b");
  });

  it("reads again once for a session a pane moved to, however often its PC says its panes changed meanwhile", async () => {
    let reads = 0;
    globalThis.fetch = (async (_url: string) => {
      reads += 1;
      // every answer comes after another event from its PC
      paneSessionsMoving("busy-pc");
      return Response.json({ source: "claude-transcript", history_id: "h", cursor: null, turns: [] }, { headers: { etag: '"h"' } });
    }) as typeof fetch;
    await fetchPaneConversation("peek:busy", "busy-pc", { prompts: 10 });
    expect(reads).toBe(2);
    expect(peekPaneConversation("peek:busy", "busy-pc", 10)).toBeUndefined();
  });

  it("draws no page a replaced herdr's pane of the same ID read, nor one of a pane the roster stopped listing", async () => {
    globalThis.fetch = (async (_url: string) => Response.json({ source: "claude-transcript", history_id: "h", cursor: null, turns: [] }, { headers: { etag: '"h"' } })) as typeof fetch;
    const roster = (lifetime: string, panes: string[]) => observePaneSessions([{ id: "local", snapshot: { herdr_lifetime: lifetime, panes: panes.map((pane_id) => ({ pane_id, agent: "claude", agent_session: null })) } }]);
    roster("one", ["peek:reused", "peek:gone"]);
    await fetchPaneConversation("peek:reused", "local", { prompts: 10 });
    await fetchPaneConversation("peek:gone", "local", { prompts: 10 });
    roster("one", ["peek:reused"]);
    expect(peekPaneConversation("peek:gone", "local", 10)).toBeUndefined();
    expect(peekPaneConversation("peek:reused", "local", 10)).toBeDefined();
    roster("two", ["peek:reused"]);
    expect(peekPaneConversation("peek:reused", "local", 10)).toBeUndefined();
  });

  it("keeps the pages of the session a pane moved to when a read of the one it left is rejected", async () => {
    const held = Promise.withResolvers<void>();
    globalThis.fetch = (async (url: string) => {
      if (new URL(url, "http://fixture").searchParams.has("from")) {
        await held.promise;
        return Response.json({ error: { code: "history_changed", message: "reload" } }, { status: 409 });
      }
      return Response.json({ source: "claude-transcript", history_id: "session-b", cursor: null, turns: [] }, { headers: { etag: '"session-b"' } });
    }) as typeof fetch;
    const roster = (value: string) => observePaneSessions([{ id: "local", snapshot: { panes: [{ pane_id: "peek:stale-409", agent: "claude", agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value } }] } }]);
    roster("a");
    const rejected = fetchPaneConversation("peek:stale-409", "local", { from: "session-a:40", history_id: "session-a", prompts: 10 });
    roster("b");
    const plain = await fetchPaneConversation("peek:stale-409", "local", { prompts: 10 });
    held.resolve();
    await expect(rejected).rejects.toBeInstanceOf(ApiError);
    expect(peekPaneConversation("peek:stale-409", "local", 10)).toBe(plain);
  });

  it("never hands back an older page", async () => {
    globalThis.fetch = (async (_url: string) => new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: "c:1" }), { status: 200, headers: { etag: "\"r\"" } })) as typeof fetch;
    await fetchPaneConversation("peek:p3", "local", { before: "c:5" });
    expect(peekPaneConversation("peek:p3")).toBeUndefined();
  });
});

it("reports a newest read in flight, so a fresh attach's connected edge can leave it to that read", async () => {
  refreshClock();
  const refresh = new ConversationRefresh();
  const { promise, resolve } = Promise.withResolvers<void>();
  let reads = 0;
  refresh.setRead(async () => { reads += 1; await promise; });
  expect(refresh.reading).toBe(false);
  refresh.refresh();
  expect(refresh.reading).toBe(true);
  resolve();
  await settleRefresh();
  expect(refresh.reading).toBe(false);
  expect(reads).toBe(1);
  refresh.stop();
});

it("counts a compressed answer by its parsed body, not the bytes on the wire", () => {
  const body = { turns: [{ text: "x".repeat(5000) }] } as unknown as Parameters<typeof conversationAnswerBytes>[0];
  expect(conversationAnswerBytes(body, "300")).toBe(300);
  expect(conversationAnswerBytes(body, "300", "identity")).toBe(300);
  expect(conversationAnswerBytes(body, "300", "gzip")).toBe(JSON.stringify(body).length);
});

it("counts a body's JSON in bytes, so a CJK page cannot slip under the per-answer cap", () => {
  // the oracle is an encoder, not this module's own counter
  const cjk = { turns: [{ text: "字".repeat(1000) }] } as unknown as Parameters<typeof conversationAnswerBytes>[0];
  const json = JSON.stringify(cjk);
  expect(conversationAnswerBytes(cjk, null, "gzip")).toBe(new TextEncoder().encode(json).length);
  // the code-unit length this used to report is a third of it
  expect(conversationAnswerBytes(cjk, null, "gzip")).toBeGreaterThan(json.length * 2);
  const emoji = { turns: [{ text: "🙂".repeat(100) }] } as unknown as Parameters<typeof conversationAnswerBytes>[0];
  expect(conversationAnswerBytes(emoji, null, "gzip")).toBe(new TextEncoder().encode(JSON.stringify(emoji)).length);
});

/** The browser timer the refresher uses, advanced without sleeping or a DOM. */
function refreshClock(): { advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  restoreClock = () => { clock.mockRestore(); };
  globals.window = {
    setTimeout(callback: () => void, delay: number): number {
      const id = next++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number | undefined): void { if (id !== undefined) timers.delete(id); },
  };
  return {
    advance(ms: number): void {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) {
        timers.delete(id);
        timer.callback();
      }
    },
    pending(): number { return timers.size; },
  };
}

async function settleRefresh(): Promise<void> {
  for (let step = 0; step < 20; step++) await Promise.resolve();
}

/** A chat on a bridge that pushes its pane's transcript changes. */
function pushedRefresh(): ConversationRefresh {
  const refresh = new ConversationRefresh();
  refresh.setPushes(true);
  return refresh;
}

describe("conversation invalidation refresh", () => {
  it("coalesces pushes at exactly 1000ms and keeps the 10s backstop, ETag and 304 identity", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const requests: { resolve: (response: Response) => void }[] = [];
    const etags: (string | null)[] = [];
    const answers: unknown[] = [];
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      etags.push(new Headers(init?.headers).get("if-none-match"));
      const { promise, resolve } = Promise.withResolvers<Response>();
      requests.push({ resolve });
      return promise;
    }) as typeof fetch;
    refresh.setRead(async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      try { answers.push(await fetchPaneConversation("refresh-burst:p1")); }
      finally { active -= 1; }
    });
    refresh.refresh();
    clock.advance(100);
    for (let push = 0; push < 8; push++) refresh.invalidate();
    requests[0]!.resolve(new Response(JSON.stringify({ source: "claude-transcript", turns: [], cursor: null }), { headers: { etag: "\"push-v1\"" } }));
    await settleRefresh();
    expect(requests).toHaveLength(1);
    clock.advance(899);
    refresh.invalidate();
    expect(requests).toHaveLength(1);
    clock.advance(1);
    expect(requests).toHaveLength(2);
    expect(etags).toEqual([null, "\"push-v1\""]);
    requests[1]!.resolve(new Response(null, { status: 304, headers: { etag: "\"push-v1\"" } }));
    await settleRefresh();
    expect(answers[1]).toBe(answers[0]);
    expect(maxActive).toBe(1);
    clock.advance(9999);
    expect(requests).toHaveLength(2);
    clock.advance(1);
    expect(requests).toHaveLength(3);
    refresh.stop();
    requests[2]!.resolve(new Response(null, { status: 304, headers: { etag: "\"push-v1\"" } }));
    await settleRefresh();
    expect(clock.pending()).toBe(0);
  });

  it("bounds sustained pushes without extending the deadline and eventually shows the latest REST output", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const starts: number[] = [];
    const answers: ConversationResponse[] = [];
    let output = "initial";
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (async (_url: string) => new Response(JSON.stringify({
      source: "claude-transcript",
      turns: [{ role: "assistant", ts: null, parts: [{ kind: "text", text: output }] }],
      cursor: null,
    }), { headers: { etag: `"${output}"` } })) as typeof fetch;
    refresh.setRead(async () => {
      starts.push(performance.now());
      active += 1; maxActive = Math.max(maxActive, active);
      try { answers.push(await fetchPaneConversation("refresh-sustained:p1")); }
      finally { active -= 1; }
    });
    refresh.refresh();
    await settleRefresh();
    for (let push = 1; push <= 53; push++) {
      clock.advance(100);
      output = `output-${push}`;
      refresh.invalidate();
      await settleRefresh();
    }
    expect(starts).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    clock.advance(699);
    expect(starts).toHaveLength(6);
    clock.advance(1);
    await settleRefresh();
    expect(starts).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000]);
    expect(answers.at(-1)?.turns[0]?.parts[0]).toEqual({ kind: "text", text: "output-53" });
    expect(maxActive).toBe(1);
    // A push after idle is not delayed until the periodic backstop.
    clock.advance(2500);
    output = "after-idle";
    refresh.invalidate();
    await settleRefresh();
    expect(starts).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 8500]);
    expect(answers.at(-1)?.turns[0]?.parts[0]).toEqual({ kind: "text", text: "after-idle" });
    refresh.stop();
  });

  it("lets an explicit refresh bypass and replace a delayed push", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const starts: number[] = [];
    refresh.setRead(async () => { starts.push(performance.now()); });
    refresh.refresh();
    await settleRefresh();
    clock.advance(100);
    refresh.invalidate();
    clock.advance(400);
    refresh.refresh();
    await settleRefresh();
    expect(starts).toEqual([0, 500]);
    clock.advance(500);
    expect(starts).toEqual([0, 500]);
    // The explicit read also establishes the next push deadline.
    refresh.invalidate();
    clock.advance(499);
    expect(starts).toEqual([0, 500]);
    clock.advance(1);
    await settleRefresh();
    expect(starts).toEqual([0, 500, 1500]);
    refresh.stop();
  });

  it("runs an immediate refresh after the in-flight read, without waiting for a push deadline", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const first = Promise.withResolvers<void>();
    const starts: number[] = [];
    refresh.setRead(async () => {
      starts.push(performance.now());
      if (starts.length === 1) await first.promise;
    });
    refresh.refresh();
    clock.advance(100);
    refresh.invalidate();
    clock.advance(100);
    refresh.refresh();
    expect(starts).toEqual([0]);
    first.resolve();
    await settleRefresh();
    expect(starts).toEqual([0, 200]);
    clock.advance(1800);
    expect(starts).toEqual([0, 200]);
    refresh.stop();
  });

  it("keeps long in-flight reads serial and trails at the later of completion and the fixed deadline", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const starts: number[] = [];
    const releases: (() => void)[] = [];
    let output = "initial";
    let shown = "";
    let active = 0;
    let maxActive = 0;
    refresh.setRead(async () => {
      const captured = output;
      const { promise, resolve } = Promise.withResolvers<void>();
      releases.push(resolve);
      starts.push(performance.now());
      active += 1; maxActive = Math.max(maxActive, active);
      try { await promise; shown = captured; }
      finally { active -= 1; }
    });
    refresh.invalidate();
    clock.advance(100);
    output = "during-first";
    refresh.invalidate();
    clock.advance(2400);
    output = "latest-first";
    refresh.invalidate();
    expect(starts).toEqual([0]);
    releases[0]!();
    await settleRefresh();
    expect(starts).toEqual([0, 2500]);
    expect(shown).toBe("initial");
    clock.advance(100);
    output = "during-second";
    refresh.invalidate();
    clock.advance(700);
    output = "latest-second";
    refresh.invalidate();
    releases[1]!();
    await settleRefresh();
    expect(shown).toBe("latest-first");
    expect(starts).toEqual([0, 2500]);
    clock.advance(199);
    expect(starts).toEqual([0, 2500]);
    clock.advance(1);
    expect(starts).toEqual([0, 2500, 3500]);
    releases[2]!();
    await settleRefresh();
    expect(shown).toBe("latest-second");
    expect(maxActive).toBe(1);
    refresh.stop();
  });

  it("starts an older page after the newest read and its gap fill, and never holds the next newest read behind it", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const first = Promise.withResolvers<void>();
    const gap = Promise.withResolvers<void>();
    const page = Promise.withResolvers<void>();
    const reads: string[] = [];
    let active = 0;
    let maxActive = 0;
    let newest = 0;
    refresh.setRead(async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      reads.push("latest");
      newest += 1;
      try {
        if (newest === 1) {
          await first.promise;
          reads.push("gap");
          await gap.promise;
        }
      } finally { active -= 1; }
    });
    refresh.refresh();
    const older = refresh.page(async () => {
      reads.push("older");
      await page.promise;
      return "page";
    });
    clock.advance(100);
    for (let push = 0; push < 4; push++) refresh.invalidate();
    first.resolve();
    await settleRefresh();
    expect(reads).toEqual(["latest", "gap"]);
    gap.resolve();
    await settleRefresh();
    expect(reads).toEqual(["latest", "gap", "older"]);
    // the older page is still loading: the pushed newest read keeps its own 1 s deadline
    clock.advance(900);
    await settleRefresh();
    expect(reads).toEqual(["latest", "gap", "older", "latest"]);
    // and an explicit refresh (a clear, a send) does not wait for it either
    refresh.refresh();
    await settleRefresh();
    expect(reads).toEqual(["latest", "gap", "older", "latest", "latest"]);
    page.resolve();
    expect(await older).toBe("page");
    expect(maxActive).toBe(1);
    refresh.stop();
  });

  it("resumes visibility without waiting for the cancelled screen's stalled REST read", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const old = Promise.withResolvers<void>();
    const current = Promise.withResolvers<void>();
    const reads: string[] = [];
    let oldSignal: AbortSignal | undefined;
    refresh.setRead(async (signal) => {
      reads.push("old"); oldSignal = signal;
      await withChatReadDeadline(() => old.promise, 30_000, signal).catch(() => {});
    });
    refresh.refresh();
    refresh.invalidate();
    refresh.stop();
    refresh.setRead(async () => { reads.push("current"); await current.promise; });
    refresh.refresh();
    refresh.refresh();
    expect(reads).toEqual(["old"]);
    try {
      await settleRefresh();
      expect(reads).toEqual(["old", "current"]);
      expect(oldSignal?.aborted).toBe(true);
    } finally { old.resolve(); current.resolve(); refresh.stop(); }
    await settleRefresh();
    clock.advance(2000);
    expect(reads).toEqual(["old", "current"]);
    refresh.stop();
    clock.advance(30_000);
    expect(reads).toEqual(["old", "current"]);
    expect(clock.pending()).toBe(0);
  });

  it("aborts an active older page on reader replacement", async () => {
    refreshClock();
    const refresh = pushedRefresh();
    refresh.setRead(async () => {});
    refresh.refresh();
    await settleRefresh();
    let pageSignal: AbortSignal | undefined;
    const older = refresh.page((signal) => {
      pageSignal = signal;
      return withChatReadDeadline(() => new Promise<string>(() => {}), 30_000, signal);
    });
    refresh.setRead(async () => {});
    await expect(older).rejects.toMatchObject({ name: "AbortError" });
    expect(pageSignal?.aborted).toBe(true);
    refresh.stop();
  });

  it("cancels a queued older page without starting it after the screen closes", async () => {
    refreshClock();
    const refresh = pushedRefresh();
    refresh.setRead(async (signal) => {
      await withChatReadDeadline(() => new Promise<void>(() => {}), 30_000, signal).catch(() => {});
    });
    refresh.refresh();
    let started = false;
    const older = refresh.page(async () => { started = true; });
    refresh.stop();
    await expect(older).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(false);
  });

  it("drops an old reader's in-flight trailing work on replacement without starting the new reader", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const old = Promise.withResolvers<void>();
    const reads: string[] = [];
    refresh.setRead(async () => { reads.push("old"); await old.promise; });
    refresh.refresh();
    refresh.invalidate();
    refresh.setRead(async () => { reads.push("current"); });
    old.resolve();
    await settleRefresh();
    clock.advance(1999);
    expect(reads).toEqual(["old"]);
    refresh.refresh();
    await settleRefresh();
    expect(reads).toEqual(["old", "current"]);
    refresh.stop();
  });

  it("drops delayed push work on reader replacement even without stop", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const reads: string[] = [];
    refresh.setRead(async () => { reads.push("old"); });
    refresh.refresh();
    await settleRefresh();
    clock.advance(100);
    refresh.invalidate();
    refresh.setRead(async () => { reads.push("current"); });
    clock.advance(30_000);
    await settleRefresh();
    expect(reads).toEqual(["old"]);
    expect(clock.pending()).toBe(0);
    refresh.invalidate();
    await settleRefresh();
    expect(reads).toEqual(["old", "current"]);
    refresh.stop();
  });

  it("cancels the delayed trailing read and its timer when the chat becomes hidden", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    let reads = 0;
    refresh.setRead(async () => { reads += 1; });
    refresh.refresh();
    await settleRefresh();
    clock.advance(100);
    refresh.invalidate();
    refresh.stop();
    expect(clock.pending()).toBe(0);
    clock.advance(30_000);
    await settleRefresh();
    expect(reads).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("drops pending pushes and timers while hidden, even when a read is still in flight", async () => {
    const clock = refreshClock();
    const refresh = pushedRefresh();
    const result = Promise.withResolvers<void>();
    let reads = 0;
    refresh.setRead(async () => { reads += 1; await result.promise; });
    refresh.refresh();
    refresh.invalidate();
    refresh.stop();
    refresh.invalidate();
    refresh.refresh();
    expect(clock.pending()).toBe(0);
    result.resolve();
    await settleRefresh();
    clock.advance(30_000);
    expect(reads).toBe(1);
    expect(clock.pending()).toBe(0);
  });

  it("reads every 2s without pushes and moves a waiting backstop when pushes come and go", async () => {
    const clock = refreshClock();
    const refresh = new ConversationRefresh();
    let reads = 0;
    refresh.setRead(async () => { reads += 1; });
    refresh.refresh();
    await settleRefresh();
    clock.advance(1999);
    expect(reads).toBe(1);
    clock.advance(1);
    await settleRefresh();
    expect(reads).toBe(2);
    // the bridge starts pushing: the waiting poll becomes the 10s backstop from now
    clock.advance(1000);
    refresh.setPushes(true);
    clock.advance(9999);
    expect(reads).toBe(2);
    clock.advance(1);
    await settleRefresh();
    expect(reads).toBe(3);
    // the tab lets go of its pane: no pushes, so the 2s poll is back without waiting out 10s
    refresh.setPushes(false);
    clock.advance(2000);
    await settleRefresh();
    expect(reads).toBe(4);
    refresh.stop();
    expect(clock.pending()).toBe(0);
  });
});

it.each([200, 409])("a timed-out read cannot replace or clear the last conversation ETag after a late %s response", async (status) => {
  const originalTimer = globalThis.setTimeout;
  const clock = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) => originalTimer(callback, delay === 15_000 ? 10 : delay)) as typeof setTimeout);
  try {
    const pane = "deadline-cache:p1";
    globalThis.fetch = (async (_url: string) => Response.json({ source: "codex-transcript", turns: [], cursor: null }, { headers: { etag: '"current"' } })) as typeof fetch;
    const current = await fetchPaneConversation(pane);
    let resolve!: (body: ConversationResponse) => void;
    const late = new Promise<ConversationResponse>((done) => { resolve = done; });
    const lateResponse = Response.json({}, { status, headers: { etag: '"obsolete"' } });
    lateResponse.json = () => late;
    globalThis.fetch = (async (_url: string) => lateResponse) as typeof fetch;
    await expect(fetchPaneConversation(pane)).rejects.toThrow("timed out");
    resolve({ source: "codex-transcript", turns: [], cursor: null });
    await Promise.resolve();
    const asked: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      asked.push(new Headers(init?.headers).get("if-none-match"));
      return new Response(null, { status: 304 });
    }) as typeof fetch;
    expect(await fetchPaneConversation(pane)).toBe(current);
    expect(asked).toEqual(['"current"']);
  } finally { clock.mockRestore(); }
});

it.each([200, 409])("an aborted screen's late %s body cannot replace or purge the current cache", async (status) => {
  const pane = `aborted-cache:${status}`;
  globalThis.fetch = (async () => Response.json({ source: "claude-transcript", history_id: "H1", turns: [], cursor: null }, { headers: { etag: '"current"' } })) as unknown as typeof fetch;
  const current = await fetchPaneConversation(pane);
  const late = Promise.withResolvers<ConversationResponse>();
  const bodyStarted = Promise.withResolvers<void>();
  const response = Response.json({}, { status, headers: { etag: '"obsolete"' } });
  response.json = () => { bodyStarted.resolve(); return late.promise; };
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
  const screen = new AbortController();
  const pending = fetchPaneConversation(pane, "local", { signal: screen.signal });
  await bodyStarted.promise;
  screen.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  late.resolve({ source: "claude-transcript", history_id: "obsolete", turns: [], cursor: null });
  await settleRefresh();
  expect(peekPaneConversation(pane)).toBe(current);
});


describe("screen cancellation across press and session reads", () => {
  it.each([200, 409])("cancels only the taken press read, keeping a newer cache after its late %s body", async (status) => {
    const pane = `press:cancel:${status}`;
    named("local", { [pane]: "a" });
    const late = Promise.withResolvers<ConversationResponse>();
    const bodyStarted = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      if (++calls === 1) {
        const response = Response.json({}, { status });
        response.json = () => { bodyStarted.resolve(); return late.promise; };
        return response;
      }
      return Response.json({ source: "claude-transcript", history_id: "current", turns: [], cursor: null }, { headers: { etag: '"current"' } });
    }) as unknown as typeof fetch;
    prefetchPaneConversation(pane, "local", 10);
    await bodyStarted.promise;
    const screen = new AbortController();
    const adopted = fetchPaneConversation(pane, "local", { prompts: 10, signal: screen.signal });
    const newer = await fetchPaneConversation(pane, "local", { prompts: 10 });
    expect(calls).toBe(2); // the press was taken once, not shared by the later caller
    screen.abort();
    await expect(adopted).rejects.toMatchObject({ name: "AbortError" });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    late.resolve({ source: "claude-transcript", history_id: "obsolete", turns: [], cursor: null });
    await settleRefresh();
    expect(peekPaneConversation(pane, "local", 10)).toBe(newer);
    const etags: (string | null)[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => { etags.push(new Headers(init?.headers).get("if-none-match")); return new Response(null, { status: 304 }); }) as unknown as typeof fetch;
    expect(await fetchPaneConversation(pane, "local", { prompts: 10 })).toBe(newer);
    expect(etags).toEqual(['"current"']);
  });

  it("an already hidden screen neither starts a request nor consumes another screen's pending press", async () => {
    const pane = "press:already-hidden";
    named("local", { [pane]: "a" });
    const response = Promise.withResolvers<Response>();
    let calls = 0;
    globalThis.fetch = (() => { calls += 1; return response.promise; }) as unknown as typeof fetch;
    prefetchPaneConversation(pane, "local", 10);
    const hidden = new AbortController(); hidden.abort();
    await expect(fetchPaneConversation(pane, "local", { prompts: 10, signal: hidden.signal })).rejects.toMatchObject({ name: "AbortError" });
    const adopted = fetchPaneConversation(pane, "local", { prompts: 10 });
    response.resolve(Response.json({ source: "claude-transcript", turns: [], cursor: null }));
    await adopted;
    expect(calls).toBe(1);
  });

  it.each([false, true])("removes a taken press read's screen listener after settling (reject=%s)", async (reject) => {
    const pane = `press:listener:${reject}`;
    named("local", { [pane]: "a" });
    const response = Promise.withResolvers<Response>();
    globalThis.fetch = (() => response.promise) as unknown as typeof fetch;
    prefetchPaneConversation(pane, "local", 10);
    const screen = new AbortController();
    const add = spyOn(screen.signal, "addEventListener");
    const remove = spyOn(screen.signal, "removeEventListener");
    try {
      const adopted = fetchPaneConversation(pane, "local", { prompts: 10, signal: screen.signal });
      if (reject) { response.reject(new Error("fixture offline")); await expect(adopted).rejects.toThrow("fixture offline"); }
      else { response.resolve(Response.json({ source: "claude-transcript", turns: [] })); await adopted; }
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]![1]);
    } finally { add.mockRestore(); remove.mockRestore(); }
  });

  it("cancels the one permitted session replacement retry with the original screen", async () => {
    const pane = "screen:session-retry";
    named("local", { [pane]: "a" });
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    globalThis.fetch = ((_url: string, init?: RequestInit) => { signals.push(init!.signal as AbortSignal); return signals.length === 1 ? first.promise : second.promise; }) as unknown as typeof fetch;
    const screen = new AbortController();
    const pending = fetchPaneConversation(pane, "local", { signal: screen.signal });
    named("local", { [pane]: "b" });
    first.resolve(Response.json({ source: "claude-transcript", history_id: "a", turns: [] }));
    await settleRefresh();
    expect(signals).toHaveLength(2);
    screen.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signals[1]!.aborted).toBe(true);
    second.resolve(Response.json({ source: "claude-transcript", history_id: "b", turns: [] }, { headers: { etag: '"late-b"' } }));
    await settleRefresh();
    expect(signals).toHaveLength(2);
    expect(peekPaneConversation(pane)).toBeUndefined();
  });
});

it("cancels a terminal fallback's pending read with its screen without retrying a wrapped read", async () => {
  const late = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  let transport: AbortSignal | undefined, reads = 0;
  globalThis.fetch = ((_url: string, init?: RequestInit) => { reads += 1; transport = init?.signal as AbortSignal; started.resolve(); return late.promise; }) as unknown as typeof fetch;
  const screen = new AbortController();
  const pending = fetchPaneTranscript("cancel:terminal-fallback", 100, "local", screen.signal);
  await started.promise;
  screen.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(transport?.aborted).toBe(true);
  late.resolve(Response.json({ read: { text: "obsolete terminal", truncated: false } }));
  await settleRefresh();
  expect(reads).toBe(1);
});
