import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPair, exportPublicKey } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { AddPcWaitOver, addByList, addInOnePress, ownWindowHere, keepAddPcWaiting, listOfferedPc, listThisPc, onAddPcWaiting, pagePc, pcAnswers, reopenAddWindow } from "./addThisPc.ts";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { readSeenPcs } from "./seenPcs.ts";
import { AccountService, AccountServiceError } from "./service.ts";
import { memoryAccountStore, memoryLock } from "./store.ts";

afterEach(() => setTransport(nativeTransport));

test("Add this PC is kept in the device's record of its PCs only from the PC's own window: one press from any other page proves nothing", async () => {
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const [hostname, kept] of [["127.0.0.1", { how: "window" }], ["desk.tailnet.ts.net", undefined]] as const) {
      const keys = generateKeyPair();
      const publicKey = exportPublicKey(keys.publicKey);
      const serverId = deriveServerId(importPublicKey(publicKey));
      const stored = new Map<string, string>();
      Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: { getItem: (name: string) => stored.get(name) ?? null, setItem: (name: string, value: string) => { stored.set(name, value); }, removeItem: (name: string) => { stored.delete(name); } } });
      Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { hostname, pathname: "/", origin: `http://${hostname}`, href: `http://${hostname}/`, search: "", hash: "" } });
      const answer = async (input: RequestInfo | URL): Promise<Response> => {
        const path = new URL(String(input), "http://localhost").pathname;
        if (path === "/api/account/status") return Response.json({ account: null });
        if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") });
        return Response.json({});
      };
      setTransport({ ...nativeTransport, fetch: answer });
      const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
      const service = { listPcs: async () => [], putPc: async () => {}, deletePc: async () => {}, session: async () => ({ account: "acct_1" }), forSignIn() { return this; } } as unknown as AccountService;
      try {
        await listThisPc(service, { relistMs: 540_000 });
        // the record is written behind the add, in turns of this thread: fifty of them pass before it is read
        for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
        expect(readSeenPcs("acct_1").pcs[Buffer.from(keys.publicKey).toString("hex")]).toEqual(kept as never);
      } finally { fetchSpy.mockRestore(); }
    }
  } finally {
    warn.mockRestore();
    if (savedLocation) Object.defineProperty(globalThis, "location", savedLocation); else Reflect.deleteProperty(globalThis, "location");
    if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("a failure of the relay pass setup never keeps Add this PC from its pairing wait", async () => {
  const keys = generateKeyPair();
  const publicKey = exportPublicKey(keys.publicKey);
  const serverId = deriveServerId(importPublicKey(publicKey));
  const asked: string[] = [];
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), "http://localhost").pathname;
    asked.push(path);
    if (path === "/api/account/status") return Response.json({ account: null });
    if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") });
    return Response.json({ error: { code: "internal", message: "relay/account.json is not writable" } }, { status: 500 });
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const listed: string[] = [];
  const service = { listPcs: async () => [], putPc: async (id: string) => { listed.push(id); }, deletePc: async () => {}, session: async () => ({ account: "acct_1" }), forSignIn() { return this; } } as unknown as AccountService;
  try {
    expect(await listThisPc(service, { relistMs: 540_000 })).toEqual({ name: "desk", serverId, account: "acct_1" });
    expect(listed).toEqual([serverId]);
    expect(asked).toContain("/api/account/relay-account");
  } finally { fetchSpy.mockRestore(); warn.mockRestore(); }
});

test("Add this PC lists it with the system this browser runs, which a device of the account shows while the listing asks", async () => {
  const keys = generateKeyPair();
  const publicKey = exportPublicKey(keys.publicKey);
  const serverId = deriveServerId(importPublicKey(publicKey));
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/account/status") return Response.json({ account: null });
    if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") });
    if (path === "/api/account/pc-proof") return Response.json({ error: { code: "not_found" } }, { status: 404 });
    return new Response(null, { status: 204 });
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  const navigatorWas = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36", maxTouchPoints: 0 }, configurable: true });
  const entries: unknown[] = [];
  const service = { listPcs: async () => [], putPc: async (_id: string, entry: unknown) => { entries.push(entry); }, deletePc: async () => {}, session: async () => ({ account: "acct_1" }), forSignIn() { return this; } } as unknown as AccountService;
  try {
    await listThisPc(service, { relistMs: 540_000 });
    await listOfferedPc(service, { v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk", code: "123456" }, "acct_1");
    expect(entries.map((entry) => (entry as { os?: unknown }).os)).toEqual(["linux", "linux"]);
  } finally {
    fetchSpy.mockRestore();
    if (navigatorWas === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", navigatorWas);
  }
});

test("a pass setup that never answers does not hold Add this PC either", async () => {
  const keys = generateKeyPair();
  const publicKey = exportPublicKey(keys.publicKey);
  const serverId = deriveServerId(importPublicKey(publicKey));
  const asked: string[] = [];
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), "http://localhost").pathname;
    asked.push(path);
    if (path === "/api/account/status") return Response.json({ account: null });
    if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") });
    if (path === "/api/account/pc-proof") return Response.json({ error: { code: "not_found" } }, { status: 404 });
    return new Promise<Response>(() => {});
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  const service = { listPcs: async () => [], putPc: async () => {}, deletePc: async () => {}, session: async () => ({ account: "acct_1" }), forSignIn() { return this; } } as unknown as AccountService;
  try {
    expect((await listThisPc(service, { relistMs: 540_000 })).name).toBe("desk");
    expect(asked).toContain("/api/account/relay-account");
  } finally { fetchSpy.mockRestore(); }
});

test("reopening the add window asks the link route alone, for an approve-here window", async () => {
  const asked: { path: string; localOnly: string | null }[] = [];
  const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    asked.push({ path: new URL(String(input), "http://localhost").pathname, localOnly: new Headers(init?.headers).get("x-ovis-local-only") });
    return Response.json({ url: "https://app.ovis.sh/#not-read" });
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  try {
    expect((await reopenAddWindow()).serverId).toBeNull();
    expect(asked).toEqual([{ path: "/api/relay/link", localOnly: "1" }]);
  } finally { fetchSpy.mockRestore(); }
});

test("reopening the add window says which PC opened it", async () => {
  const publicKey = exportPublicKey(generateKeyPair().publicKey);
  const serverId = deriveServerId(importPublicKey(publicKey));
  const answer = async (_input: RequestInfo | URL): Promise<Response> => Response.json({ url: encodeOffer({ v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") });
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  try { expect((await reopenAddWindow()).serverId).toBe(serverId); } finally { fetchSpy.mockRestore(); }
});

function listing(signedIn: { account: string | null }) {
  const publicKey = exportPublicKey(generateKeyPair().publicKey);
  const serverId = deriveServerId(importPublicKey(publicKey));
  const asked: string[] = [];
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input), "http://localhost").pathname;
    asked.push(path);
    if (path === "/api/health") return Response.json({ web_ui: { boot_id: "boot", revision: null, server_id: serverId } });
    return path === "/api/relay/link"
      ? Response.json({ url: encodeOffer({ v: 1, server_id: serverId, server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") })
      : Response.json({});
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  const calls: string[] = [];
  const reads: (() => void)[] = [];
  const service = (bound?: string): AccountService => {
    const mine = (): void => { if (bound !== undefined && signedIn.account !== bound) throw new Error("another sign-in is stored"); };
    return {
      listPcs: async () => { mine(); for (const read of reads) read(); return [{ server_id: serverId, added_at: new Date(0).toISOString() }]; },
      refreshPc: async () => { mine(); return "legacy"; },
      putPc: async () => { mine(); calls.push(`putPc as ${signedIn.account}`); },
      deletePc: async () => { mine(); calls.push(`deletePc as ${signedIn.account}`); },
      session: async () => signedIn.account === null ? undefined : { account: signedIn.account },
      forSignIn: (session: { account: string }) => service(session.account),
    } as unknown as AccountService;
  };
  return { serverId, calls, reads, asked, service: service(), restore: () => fetchSpy.mockRestore() };
}

test("a listing writes only as the sign-in stored when it began", async () => {
  const signedIn = { account: "acct_1" as string | null };
  const pc = listing(signedIn);
  pc.reads.push(() => { signedIn.account = "acct_2"; });
  try {
    await expect(listThisPc(pc.service, { relistMs: 540_000 })).rejects.toThrow("another sign-in is stored");
    expect(pc.calls).toEqual([]);
  } finally { pc.restore(); }
});

test("a listing for a wait writes nothing for another PC, under another account, or once the wait ended", async () => {
  const signedIn = { account: "acct_1" as string | null };
  const pc = listing(signedIn);
  const why = async (wait: { serverId: string; account: string; running: () => boolean }): Promise<unknown> =>
    listThisPc(pc.service, { relistMs: 540_000, for: wait }).then(() => "listed", (error: unknown) => error instanceof AddPcWaitOver ? error.why : error);
  try {
    expect(await why({ serverId: "another-pc", account: "acct_1", running: () => true })).toBe("pc");
    // which PC answers is read from its health: no window was opened on a PC that is not the wait's
    expect(pc.asked).toEqual(["/api/health"]);
    expect(await why({ serverId: pc.serverId, account: "acct_2", running: () => true })).toBe("sign-in");
    // stopped while the directory was read: neither the old entry is deleted nor a new one put
    let running = true;
    pc.reads.push(() => { running = false; });
    expect(await why({ serverId: pc.serverId, account: "acct_1", running: () => running })).toBe("ended");
    expect(pc.calls).toEqual([]);
    pc.reads.length = 0;
    expect(await why({ serverId: pc.serverId, account: "acct_1", running: () => true })).toBe("listed");
    expect(pc.calls).toEqual(["deletePc as acct_1", "putPc as acct_1"]);
  } finally { pc.restore(); }
});

test("a listing for a wait that was stopped opens no window, and reads nothing once a window on its way has opened", async () => {
  const signedIn = { account: "acct_1" as string | null };
  const pc = listing(signedIn);
  let sessions = 0;
  const session = pc.service.session.bind(pc.service);
  pc.service.session = async () => { sessions++; return await session(); };
  const why = async (running: () => boolean): Promise<unknown> =>
    listThisPc(pc.service, { relistMs: 540_000, for: { serverId: pc.serverId, account: "acct_1", running } }).then(() => "listed", (error: unknown) => error instanceof AddPcWaitOver ? error.why : error);
  try {
    // stopped while the PC was asked which one it is: no window is asked for after Stop waiting
    expect(await why(() => false)).toBe("ended");
    expect(pc.asked).toEqual(["/api/health"]);
    pc.asked.length = 0;
    expect(await why(() => !pc.asked.includes("/api/relay/link"))).toBe("ended");
    expect(pc.asked).toEqual(["/api/health", "/api/relay/link"]);
    expect(sessions).toBe(0);
    expect(pc.calls).toEqual([]);
  } finally { pc.restore(); }
});

test("a wait kept or forgotten is told to whoever listens, until they stop", () => {
  const heard: (string | null)[] = [];
  const off = onAddPcWaiting((waiting) => heard.push(waiting?.name ?? null));
  keepAddPcWaiting({ name: "desk", until: 2, serverId: "pc", account: "acct_1", listedAt: 1 });
  keepAddPcWaiting(null);
  off();
  keepAddPcWaiting(null);
  expect(heard).toEqual(["desk", null]);
});

test("which PC answers is read from its health, and from the hosted app's page where its health does not say", async () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "location");
  let health: unknown = { web_ui: { boot_id: "boot", revision: null, server_id: "pc-1" } };
  const answer = async (_input: RequestInfo | URL): Promise<Response> => Response.json(health);
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  try {
    expect(await pcAnswers("pc-1")).toBe(true);
    expect(await pcAnswers("pc-2")).toBe(false);
    // an Ovis that does not tell its ID: nothing says which PC this is
    health = { web_ui: { boot_id: "boot", revision: null } };
    await expect(pcAnswers("pc-1")).rejects.toThrow("did not say which PC it is");
    // the hosted app's page names the PC it reaches
    Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: { pathname: `/s/${deriveServerId(importPublicKey(exportPublicKey(generateKeyPair().publicKey)))}/`, origin: "http://localhost" } });
    const named = pagePc();
    expect(named).not.toBeNull();
    expect(await pcAnswers(named!)).toBe(true);
    expect(await pcAnswers("pc-2")).toBe(false);
  } finally {
    fetchSpy.mockRestore();
    if (saved) Object.defineProperty(globalThis, "location", saved); else Reflect.deleteProperty(globalThis, "location");
  }
});

// the relay tab lists the PC its QR code names beside the code, and the listing never holds the code up: from the offer
// itself, so no pairing window of the PC is opened or closed for it; only under the account the screen showed; and
// never again for a PC listed already
test.each([
  ["not listed yet, under the account the screen showed", "acct_1", null, ["put"]],
  ["listed an hour ago", "acct_1", 3_600_000, []],
  ["not listed, with another account's sign-in stored since the screen was drawn", "acct_2", null, []],
] as const)("the relay tab's listing beside a QR code, which never holds the code up, for a PC %s, writes only what that account lacks", async (_what, stored, age, writes) => {
  const keys = generateKeyPair();
  const publicKey = exportPublicKey(keys.publicKey);
  const offer = { v: 1 as const, server_id: deriveServerId(importPublicKey(publicKey)), server_public_key: publicKey, relay: "wss://relay.ovis.sh", name: "desk", code: "123456" };
  const pcCalls = spyOn(globalThis, "fetch");
  const written: string[] = [];
  const entry = { server_id: offer.server_id, label: "desk", added_at: new Date(Date.now() - (age ?? 0)).toISOString(), last_seen_at: null, public_key: null, relay: null };
  const service = { listPcs: async () => age === null ? [] : [entry], putPc: async () => { written.push("put"); }, deletePc: async () => { written.push("delete"); }, session: async () => ({ account: stored }), forSignIn() { return this; } } as unknown as AccountService;
  try {
    const listed = listOfferedPc(service, offer, "acct_1");
    if (stored === "acct_1") await listed;
    else await expect(listed).rejects.toBeInstanceOf(AddPcWaitOver);
    expect(written).toEqual([...writes]);
    expect(pcCalls).not.toHaveBeenCalled();
  } finally { pcCalls.mockRestore(); }
});


/** The account service and the PC as one press sees them: what each was asked, in order, and how each answers. */
function onePress(answers: { admit?: () => Promise<unknown>; pc?: (path: string) => Response } = {}) {
  const calls: string[] = [];
  const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname;
    calls.push(`${path} ${String(init?.body ?? "")}`);
    return answers.pc?.(path) ?? (path === "/api/account/relay-account" ? new Response(null, { status: 204 }) : Response.json({ account: "acct_1" }));
  };
  setTransport({ ...nativeTransport, fetch: answer });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(answer as typeof fetch);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const signedIn = { account: "acct_1" };
  const service = {
    session: async () => ({ account: signedIn.account, refresh_token: `refresh-${signedIn.account}` }),
    forSignIn: (session: { account: string }) => ({ admitPc: async (id: string) => { calls.push(`admit ${id} as ${session.account}`); return await (answers.admit?.() ?? Promise.resolve({ account: session.account, new_until: "x" })); } }),
  } as unknown as AccountService;
  return { calls, signedIn, service, restore: () => { fetchSpy.mockRestore(); warn.mockRestore(); } };
}

const PC_ID = "0123456789abcdef0123456789abcdef";

test("one press: the service admits the PC as the stored sign-in, then the PC is named that account and takes the press for it", async () => {
  const f = onePress();
  try {
    expect(await addInOnePress(f.service, PC_ID, "acct_1", () => true, true)).toBe("added");
    expect(f.calls).toEqual([`admit ${PC_ID} as acct_1`, '/api/account/relay-account {"account":"acct_1"}', '/api/account/one-press {"account":"acct_1"}']);
  } finally { f.restore(); }
});

test("one press asks nothing when the stored sign-in is not the account it was for, or the attempt is over", async () => {
  const f = onePress();
  try {
    f.signedIn.account = "acct_2";
    expect(await addInOnePress(f.service, PC_ID, "acct_1", () => true, true)).toBe("refused");
    f.signedIn.account = "acct_1";
    expect(await addInOnePress(f.service, PC_ID, "acct_1", () => false, true)).toBe("refused");
    expect(f.calls).toEqual([]);
  } finally { f.restore(); }
});

test.each([
  // signing in again as before cannot pass it: the person is told what does
  ["two_step_required", "no-two-step"],
  ["session_not_fresh", "sign-in-again"],
  ["own_sign_in_required", "sign-in-again"],
  ["pc_add_cap", "refused"],
] as const)("a refusal of the account service (%s) leaves the PC unasked and answers %s", async (code, outcome) => {
  const f = onePress({ admit: () => Promise.reject(new AccountServiceError(403, code, "The sign-in was refused")) });
  try {
    expect<string>(await addInOnePress(f.service, PC_ID, "acct_1", () => true, true)).toBe(outcome);
    expect(f.calls).toEqual([`admit ${PC_ID} as acct_1`]);
  } finally { f.restore(); }
});

test("a PC that refuses the press, or has no such route, is no one-press add", async () => {
  for (const status of [404, 409, 502, 503]) {
    const f = onePress({ pc: (path) => path === "/api/account/one-press" ? Response.json({ error: { code: "x", message: "x" } }, { status }) : new Response(null, { status: 204 }) });
    try { expect(await addInOnePress(f.service, PC_ID, "acct_1", () => true, true)).toBe("refused"); }
    finally { f.restore(); }
  }
});

test("one press asks the account service nothing for a PC whose step-2 switch is off: no cap is spent and nobody is rung", async () => {
  const f = onePress();
  try {
    expect(await addInOnePress(f.service, PC_ID, "acct_1", () => true, false)).toBe("refused");
    expect(f.calls).toEqual([]);
  } finally { f.restore(); }
});

test("the PC's own window, as the server judges it: its owner socket, or the access token on a loopback address", () => {
  expect(ownWindowHere({ via: "local" }, "example.ts.net")).toBe(true);
  expect(ownWindowHere({ via: "token" }, "127.0.0.1")).toBe(true);
  expect(ownWindowHere({ via: "token" }, "[::1]")).toBe(true);
  expect(ownWindowHere({ via: "token" }, "localhost")).toBe(true);
  expect(ownWindowHere({ via: "token" }, "127.0.0.2")).toBe(true);
  expect(ownWindowHere({ via: "token" }, "192.168.1.10")).toBe(false);
  for (const via of ["device", "relay", "open", "portal"]) expect(ownWindowHere({ via }, "127.0.0.1")).toBe(false);
  expect(ownWindowHere(null, "127.0.0.1")).toBe(false);
});

const RUN = "0123456789abcdef";

test("an add by the account's list names this PC's account first, then asks the PC to start it, as `ovis add` does", async () => {
  const f = onePress({ pc: (path) => path === "/api/account/list/add" ? Response.json({ state: "waiting", run: RUN, account: "acct_1", list: "f".repeat(64), until: "x" }) : new Response(null, { status: 204 }) });
  try {
    expect(await addByList("acct_1")).toEqual({ kind: "run", run: RUN });
    expect(f.calls).toEqual(['/api/account/relay-account {"account":"acct_1"}', '/api/account/list/add {"account":"acct_1"}']);
  } finally { f.restore(); }
});

test("a naming the PC refuses does not stop the ask: the PC says itself what it lacks", async () => {
  const f = onePress({ pc: (path) => path === "/api/account/list/add" ? Response.json({ error: { code: "account_mismatch", message: "x" } }, { status: 409 }) : Response.json({ error: { code: "internal", message: "x" } }, { status: 500 }) });
  try {
    expect(await addByList("acct_1")).toEqual({ kind: "refused", why: "account_mismatch" });
    expect(f.calls.map((call) => call.split(" ")[0])).toEqual(["/api/account/relay-account", "/api/account/list/add"]);
  } finally { f.restore(); }
});

test.each([
  ["an account that keeps no list", 200, { state: "no_list", account: "acct_1" }, { kind: "none" }],
  ["a PC that follows no list", 404, { error: { code: "not_found", message: "x" } }, { kind: "none" }],
  ["a window that is not the PC's own", 403, { error: { code: "owner_only", message: "x" } }, { kind: "none" }],
  ["an Ovis without the route", 405, { error: { code: "method_not_allowed", message: "x" } }, { kind: "none" }],
  ["the account service away", 503, { error: { code: "account_unavailable", message: "x" } }, { kind: "refused", why: "account_unavailable" }],
  ["a PC its account's list removed", 409, { error: { code: "list_removed", message: "x" } }, { kind: "refused", why: "list_removed" }],
  ["an add that ended as it began", 200, { state: "ended", run: RUN, account: "acct_1", why: "unavailable" }, { kind: "refused", why: "unavailable" }],
  ["a PC that is in the account by its list already", 200, { state: "added", run: RUN, account: "acct_1", list: "f".repeat(64) }, { kind: "added" }],
] as const)("an add by the list where the PC answers for %s", async (_, status, body, outcome) => {
  const f = onePress({ pc: (path) => path === "/api/account/list/add" ? Response.json(body, { status }) : new Response(null, { status: 204 }) });
  try { expect(await addByList("acct_1")).toEqual(outcome); }
  finally { f.restore(); }
});

test("a PC that cannot be reached after the account service admitted it is no one press: the digit wait comes, nothing is thrown", async () => {
  const f = onePress({ pc: () => { throw new TypeError("Disconnected"); } });
  try {
    expect(await addInOnePress(f.service, PC_ID, "acct_1", () => true, true)).toBe("refused");
  } finally { f.restore(); }
});

test("one press names this PC for nobody when another tab signed in to another account while the service answered", async () => {
  const f = onePress({ admit: async () => { f.signedIn.account = "acct_2"; return { account: "acct_1", new_until: "x" }; } });
  try {
    expect(await addInOnePress(f.service, PC_ID, "acct_1", () => true, true)).toBe("refused");
    expect(f.calls).toEqual([`admit ${PC_ID} as acct_1`]);
  } finally { f.restore(); }
});

/**
 * The PC's own window signed in to the account with its own sign-in, made `age` ago: the real client over the account
 * service's fake. It registers no key of its own (only the phone app and app.ovis.sh do), so an old sign-in proves nothing.
 */
async function ownWindowSignedIn(age: number) {
  let now = Date.now();
  const fake = new FakeAccountService(() => now);
  fake.opensAll = true;
  const store = memoryAccountStore();
  const token = fake.issueToken("acct_1");
  await store.set("session", { service: "https://account.example", account: "acct_1", provider: "github", access_token: token, refresh_token: "r", expires_at: now + 365 * 86_400_000, sign_in_id: "this-sign-in", signed_in_at: now });
  now += age;
  const service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: () => now });
  const keys = generateKeyPair();
  const publicKey = exportPublicKey(keys.publicKey);
  const serverId = deriveServerId(importPublicKey(publicKey));
  const challenges = (): number => fake.requests.filter((line) => line === "POST /v1/pcs/challenge").length;
  return { fake, service, serverId, publicKey, challenges };
}

test("Add this PC in one press from a sign-in made just now: as before, nothing is proved", async () => {
  const signedIn = await ownWindowSignedIn(0);
  const pcSide = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://localhost").pathname;
    if (path === "/api/account/status") return Response.json({ account: null });
    if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: signedIn.serverId, server_public_key: signedIn.publicKey, relay: "wss://relay.ovis.sh", name: "desk" }, "https://app.ovis.sh") });
    if (path === "/api/account/pc-proof") return Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (path === "/api/account/one-press") return Response.json({ account: "acct_1" });
    return new Response(null, { status: 204 });
  };
  setTransport({ ...nativeTransport, fetch: pcSide });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(pcSide as typeof fetch);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const listed = await listThisPc(signedIn.service, { relistMs: 540_000 });
    expect(await addInOnePress(signedIn.service, listed.serverId, "acct_1", () => true, true)).toBe("added");
    expect(signedIn.challenges()).toBe(0);
    expect(signedIn.fake.pcs("acct_1").map((pc) => [pc.server_id, pc.listed_by_device, pc.admitted_at !== null])).toEqual([[signedIn.serverId, false, true]]);
  } finally { fetchSpy.mockRestore(); warn.mockRestore(); }
});

test("one press from a sign-in days old is refused as before: sign-in-again, after one bare admit", async () => {
  const signedIn = await ownWindowSignedIn(3 * 86_400_000);
  // the PC listed itself with a sign-in code of its own, as ovis add does
  const typed = signedIn.fake.issueToken("acct_1", { device: true });
  const put = await signedIn.fake.fetch(`https://account.example/v1/pcs/${signedIn.serverId}`, { method: "PUT", headers: { authorization: `Bearer ${typed}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "desk", public_key: Array.from(importPublicKey(signedIn.publicKey), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.ovis.sh" }) });
  expect(put.ok).toBe(true);
  const f = onePress();
  try {
    expect(await addInOnePress(signedIn.service, signedIn.serverId, "acct_1", () => true, true)).toBe("sign-in-again");
    expect(signedIn.challenges()).toBe(0);
    expect(signedIn.fake.requests.filter((line) => line.endsWith("/admit"))).toHaveLength(1);
  } finally { f.restore(); }
});
