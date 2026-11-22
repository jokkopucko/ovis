import { afterEach, expect, spyOn, test } from "bun:test";
import { generateKeyPair, exportPublicKey } from "../../../shared/relay-e2ee.ts";
import { encodeOffer } from "../../../shared/relay-offer.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { AddPcWaitOver, addInOnePress, ownWindowHere, keepAddPcWaiting, listOfferedPc, listThisPc, onAddPcWaiting, pagePc, pcAnswers, reopenAddWindow } from "./addThisPc.ts";
import { AccountServiceError, type AccountService } from "./service.ts";

afterEach(() => setTransport(nativeTransport));

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

test("a refusal of the account service (no two-step, a stale sign-in, the daily cap, an older service) leaves the PC unasked", async () => {
  const f = onePress({ admit: () => Promise.reject(new AccountServiceError(403, "two_step_required", "Set up two-step sign-in first")) });
  try {
    expect(await addInOnePress(f.service, PC_ID, "acct_1", () => true, true)).toBe("sign-in-again");
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
