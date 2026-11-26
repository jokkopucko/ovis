import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeAccountService } from "../shared/account-service-fake.ts";
import { accountOsOfPlatform } from "../shared/account-asker.ts";
import { generateKeyPair, importPublicKey } from "../shared/relay-e2ee.ts";
import { deriveServerId } from "../shared/relay-server-proof.ts";
import { encodeOffer } from "../shared/relay-offer.ts";
import { DEFAULT_ACCOUNT_SERVICE } from "../shared/web-policy.ts";
import { loadRelayIdentity } from "../server/relay/identity.ts";
import { updateStateDir } from "../server/update-state.ts";
import { mergeEnvLayers } from "../server/legacy-env.ts";
import { approveJoins, approveWaiting, link, linkSettings, type JoinOutcome, type OwnJoin, type WaitingDevice } from "./plugin-link.ts";
import { COMMAND_ALIASES } from "./plugin-runtime.ts";

const ORIGIN = "http://127.0.0.1:7317";
const CLOSING = "The sign-in was only for this and ends with it; nothing of it is kept on this PC.\nCheck: ovis status      Undo: ovis logout\n";
const FIRST_JOIN_HINT = "If your phone asks for six digits when you open old-desktop, run ovis approve on this PC and type them.\n";
/** How `ovis add` ends at a terminal once this PC is added, with Enter typed at its first question */
const ADDED_HERE = "Added. Open old-desktop from My PCs on your phone. If the phone shows six digits, type them here (Enter to finish without): ";
const FINISHED = `${ADDED_HERE}Finished without letting a device in. ${FIRST_JOIN_HINT}${CLOSING}`;
const SERVICE = "https://account.test";
const RELAY = "wss://relay.test";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function identity() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-link-"));
  scratch.push(dir);
  return loadRelayIdentity(dir);
}

function localPc(route: (request: Request, path: string) => Response | Promise<Response> | undefined) {
  const calls: { method: string; path: string; headers: Headers; body: string }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // as real fetch does: a call made with an aborted signal never leaves
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, headers: request.headers, body: request.method === "GET" ? "" : await request.clone().text() });
    if (url.origin !== ORIGIN) throw new TypeError(`unexpected address ${url.origin}`);
    return await route(request, url.pathname) ?? Response.json({ error: { code: "not_found" } }, { status: 404 });
  };
  return { fetch, calls };
}

function clock() {
  let now = Date.parse("2026-11-06T12:00:00Z");
  const waits: number[] = [];
  const due: (() => void)[] = [];
  return {
    now: () => now,
    waits,
    pass: (ms: number) => { now += ms; },
    after: (act: () => void) => { due.push(act); },
    wait: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      waits.push(ms);
      await new Promise((resolve) => setTimeout(resolve, 0));
      now += ms;
      const acts = due.splice(0);
      for (const act of acts) act();
      if (acts.length > 0) await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    },
  };
}

async function* answers(...lines: string[]): AsyncGenerator<string> { for (const line of lines) yield line; }

const silent = (): AsyncIterator<string> => ({ next: () => new Promise(() => {}) });

/**
 * Lines a person types when they choose to, as a terminal hands them over: one typed while nothing reads is kept
 * and goes to the next read, whenever that comes. What is typed and not sent (`begin`) stays in the terminal and
 * comes at the head of the line the next Enter sends (`type`), unless the terminal's input is discarded first
 * (`discard`, as tcflush does: what was begun, and the lines nobody read yet).
 */
function keyboard() {
  let reader: ((line: IteratorResult<string>) => void) | null = null;
  const kept: string[] = [];
  let begun = "";
  let discards = 0;
  let ended = false;
  const lines: AsyncIterator<string> = {
    next: () => {
      const line = kept.shift();
      if (line !== undefined) return Promise.resolve({ value: line, done: false });
      return ended ? Promise.resolve({ value: undefined, done: true }) : new Promise((resolve) => { reader = resolve; });
    },
  };
  return {
    lines,
    type: (rest: string) => { const line = begun + rest; begun = ""; const resolve = reader; reader = null; if (resolve === null) kept.push(line); else resolve({ value: line, done: false }); },
    begin: (text: string) => { begun += text; },
    discard: () => { discards++; begun = ""; kept.length = 0; return true; },
    end: () => { ended = true; const resolve = reader; reader = null; resolve?.({ value: undefined, done: true }); },
    discards: () => discards,
  };
}

/**
 * A QR code drawn in the terminal, whatever it carries: its three finder squares, top left, top right and
 * bottom left. The rest of the code follows its random payload, so no other run of blocks is certain.
 */
function expectQrCode(text: string): void {
  const rows = text.split("\n");
  const finder = ["█ █▀▀▀█ █", "█ █   █ █", "█ ▀▀▀▀▀ █"];
  const top = rows.findIndex((row) => row.startsWith(finder[0]!));
  // the quiet zone under the code: two module rows to a line, so its last line is all upper halves
  const bottom = rows.findIndex((row, index) => index > top && /^▀+$/.test(row));
  expect(top).toBeGreaterThan(0);
  expect(bottom).toBeGreaterThan(top);
  expect(rows.slice(top, top + 3).map((row) => [row.slice(0, 9), row.slice(-9)])).toEqual(finder.map((line) => [line, line]));
  expect(rows.slice(bottom - 3, bottom).map((row) => row.slice(0, 9))).toEqual(finder);
}

describe("ovis link, on the PC itself", () => {
  it("refuses a server that is not on this machine, before asking it anything", async () => {
    const pc = localPc(() => Response.json({}));
    const out: string[] = [];
    for (const origin of ["http://192.168.0.10:7317", "http://100.64.0.2:7317", "https://pc.example.ts.net"]) {
      const code = await link(["--code"], { origin, headers: {}, fetch: pc.fetch, out: (text) => out.push(text), signal: new AbortController().signal, lines: answers(), accountService: SERVICE });
      expect(code).toBe(1);
    }
    expect(pc.calls).toEqual([]);
    expect(out.join("")).toContain("not on a loopback address");
  });

  it("--code shows the code to type, this PC's ID and the relay QR code, and a new pair when they run out", async () => {
    const pc = identity();
    const time = clock();
    const stop = new AbortController();
    const codes = ["ABCD-EFGH-JK", "MNPQ-RSTV-WX"];
    let minted = 0;
    let offers = 0;
    let cancelled = 0;
    const cancels: unknown[] = [];
    const local = localPc(async (request, path) => {
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/code") {
        const code = codes[minted++]!;
        return Response.json({ code, expires_at: new Date(time.now() + 600_000).toISOString(), server_id: pc.server_id });
      }
      if (path === "/api/relay/offer") {
        // the page asks for the offer after the code, never beside it: the code starts a new pairing
        expect(offers).toBe(minted - 1);
        if (++offers === 2) stop.abort();
        return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: String(100000 + offers) }, "https://app.ovis.sh"), expires_at: new Date(time.now() + 600_000).toISOString() });
      }
      if (path === "/api/devices/pair/cancel") { cancelled++; cancels.push(await request.json()); return Response.json({ ok: true }); }
      return undefined;
    });
    const out: string[] = [];
    const code = await link(["--code"], { origin: ORIGIN, headers: { authorization: "Bearer t0k3n" }, fetch: local.fetch, out: (text) => out.push(text), signal: stop.signal, now: time.now, wait: time.wait, lines: answers(), accountService: SERVICE });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("ABCD-EFGH-JK");
    expect(text).toContain("MNPQ-RSTV-WX");
    expect(text).toContain(pc.server_id.match(/.{4}/g)!.join(" "));
    expectQrCode(text);
    expect(time.waits).toEqual([600_000]);
    expect(cancelled).toBe(1);
    // only the code it showed last: a pairing started since in Settings or on another device stays
    expect(cancels).toEqual([{ code: "100002" }]);
    for (const call of local.calls.filter((entry) => entry.method === "POST")) {
      expect(call.headers.get("x-herdr-update")).toBe("1");
      expect(call.headers.get("origin")).toBe(ORIGIN);
      expect(call.headers.get("authorization")).toBe("Bearer t0k3n");
    }
  });

  it("--code takes the pairing code back on an error too, not only on Ctrl+C", async () => {
    const pc = identity();
    const cancelled: unknown[] = [];
    const local = localPc(async (request, path) => {
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/code") return Response.json({ code: "ABCD-EFGH-JK", expires_at: new Date(Date.now() + 600_000).toISOString(), server_id: pc.server_id, pairing: { id: "p1" } });
      if (path === "/api/relay/offer") return Response.json({ url: "https://app.ovis.sh/s/x/#offer=garbage" });
      if (path === "/api/devices/pair/cancel") { cancelled.push(await request.json()); return Response.json({ ok: true }); }
      return undefined;
    });
    const out: string[] = [];
    expect(await link(["--code"], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text) => out.push(text), signal: new AbortController().signal, lines: answers(), accountService: SERVICE })).toBe(1);
    expect(cancelled).toEqual([{ id: "p1" }]);
  });

  it("--code takes back the pairing a renewal started when it fails before its QR code came", async () => {
    const pc = identity();
    const time = clock();
    let offers = 0;
    const cancels: unknown[] = [];
    const local = localPc(async (request, path) => {
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/code") return Response.json({ code: "ABCD-EFGH-JK", expires_at: new Date(time.now() + 600_000).toISOString(), server_id: pc.server_id, pairing: { id: `p${offers + 1}` } });
      if (path === "/api/relay/offer") {
        if (++offers === 2) return Response.json({ error: { code: "internal_error", message: "internal error (x)" } }, { status: 500 });
        return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: "111111" }, "https://app.ovis.sh"), expires_at: new Date(time.now() + 600_000).toISOString(), pairing: { id: request.headers.get("x-ovis-pairing") } });
      }
      if (path === "/api/devices/pair/cancel") { cancels.push(await request.json()); return Response.json({ ok: true }); }
      return undefined;
    });
    expect(await link(["--code"], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: () => undefined, signal: new AbortController().signal, now: time.now, wait: time.wait, lines: answers(), accountService: SERVICE })).toBe(1);
    expect(cancels).toEqual([{ id: "p2" }]);
  });

  it("--code turns the relay on first when it is off, and waits until it is online to ask for a code", async () => {
    const pc = identity();
    const time = clock();
    const stop = new AbortController();
    let phase = "off";
    const local = localPc((request, path) => {
      if (path === "/api/relay" && request.method === "GET") {
        const now = phase;
        // a code asked for while the relay connects is refused (500): only an online relay mints one
        if (phase === "connecting") phase = "online";
        return Response.json({ phase: now, blocked: null });
      }
      if (path === "/api/relay/start") { phase = "connecting"; return Response.json({ phase, blocked: null }); }
      if (path === "/api/relay/code") return Response.json({ code: "ABCD-EFGH-JK", expires_at: new Date(Date.now() + 600_000).toISOString(), server_id: pc.server_id });
      if (path === "/api/relay/offer") { stop.abort(); return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: "123456" }, "https://app.ovis.sh"), expires_at: new Date(Date.now() + 600_000).toISOString() }); }
      if (path === "/api/relay/code/cancel") return Response.json({ ok: true });
      return undefined;
    });
    const out: string[] = [];
    expect(await link(["--code"], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text) => out.push(text), signal: stop.signal, now: time.now, wait: time.wait, lines: answers(), accountService: SERVICE })).toBe(0);
    expect(local.calls.map((call) => `${call.method} ${call.path}`).slice(0, 5)).toEqual(["GET /api/relay", "POST /api/relay/start", "GET /api/relay", "GET /api/relay", "POST /api/relay/code"]);
    expect(out.join("")).toContain("ABCD-EFGH-JK");
  });

  it("--code still shows the QR code when the relay takes no typed code, as Settings does", async () => {
    const pc = identity();
    const stop = new AbortController();
    let cancelled = 0;
    const local = localPc((request, path) => {
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/code") return Response.json({ error: { code: "internal_error", message: "internal error (x)" } }, { status: 500 });
      if (path === "/api/relay/offer") { stop.abort(); return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: "123456" }, "https://app.ovis.sh"), expires_at: new Date(Date.now() + 600_000).toISOString() }); }
      if (path === "/api/devices/pair/cancel") { cancelled++; return Response.json({ ok: true }); }
      return undefined;
    });
    const out: string[] = [];
    expect(await link(["--code"], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text) => out.push(text), signal: stop.signal, lines: answers(), accountService: SERVICE })).toBe(0);
    const text = out.join("");
    // the reason the PC gave, without the route it was asked on
    expect(text).toContain("No code to type this time (internal error (x)).");
    expect(text).not.toContain("/api/relay/code");
    expectQrCode(text);
    expect(text).toContain(pc.server_id.match(/.{4}/g)!.join(" "));
    expect(cancelled).toBe(1);
  });

  it("--code on a machine profile says that it takes devices through its account, and makes and takes back nothing", async () => {
    const pc = identity();
    for (const refusing of ["/api/relay/code", "/api/relay/offer"]) {
      const local = localPc((request, path) => {
        if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
        if (path === refusing) return Response.json({ error: { code: "machine_profile", message: "A machine takes devices through its account." } }, { status: 409 });
        if (path === "/api/relay/code") return Response.json({ error: { code: "code_unavailable", message: "no typed code" } }, { status: 409 });
        if (path === "/api/relay/offer") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: "123456" }, "https://app.ovis.sh"), expires_at: new Date(Date.now() + 600_000).toISOString() });
        if (path === "/api/devices/pair/cancel") return Response.json({ ok: true });
        return undefined;
      });
      const out: string[] = [];
      expect(await link(["--code"], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text) => out.push(text), signal: new AbortController().signal, lines: answers(), accountService: SERVICE })).toBe(1);
      expect([refusing, out.join("")]).toEqual([refusing, "This PC runs the machine profile, which takes devices through its Ovis account, not with a code. Run ovis add to add this machine to your Ovis account; every device of that account can then use it.\n"]);
      const posts = local.calls.filter((call) => call.method === "POST").map((call) => call.path);
      expect(posts).toEqual(refusing === "/api/relay/code" ? ["/api/relay/code"] : ["/api/relay/code", "/api/relay/offer"]);
    }
  });

  it("--code takes nothing back when neither the code nor the QR code was made: the pairing pending stays", async () => {
    for (const refusal of [{ code: "machine_profile", message: "A machine takes devices through its account." }, { code: "relay_offline", message: "The relay is not reachable." }]) {
      const local = localPc((request, path) => {
        if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
        if (path === "/api/relay/code" || path === "/api/relay/offer") return Response.json({ error: refusal }, { status: 409 });
        if (path === "/api/devices/pair/cancel" || path === "/api/relay/code/cancel") return Response.json({ ok: true });
        return undefined;
      });
      const out: string[] = [];
      expect(await link(["--code"], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text) => out.push(text), signal: new AbortController().signal, lines: answers(), accountService: SERVICE })).toBe(1);
      const posts = local.calls.filter((call) => call.method === "POST").map((call) => call.path);
      expect([refusal.code, posts]).toEqual([refusal.code, refusal.code === "machine_profile" ? ["/api/relay/code"] : ["/api/relay/code", "/api/relay/offer"]]);
      expect(out.join("")).not.toContain("Stopped");
    }
  });

  async function linkToAccount(options: { args?: string[]; prepare?: (service: FakeAccountService) => void; approve: (service: FakeAccountService, code: string) => void; enforcing?: boolean; service?: string; openBrowser?: (url: string) => boolean }) {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    options.prepare?.(service);
    let account: string | null = null;
    let linkAsked = 0;
    let named: string | null = null;
    const decisions: unknown[] = [];
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: options.enforcing && named === null ? "error" : "online", blocked: null });
      if (path === "/api/account/relay-account") { named = (await request.json() as { account: string }).account; return new Response(null, { status: 204 }); }
      if (path === "/api/relay/link") {
        expect(request.headers.get("x-ovis-local-only")).toBe("1");
        linkAsked++;
        return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      }
      if (path === "/api/relay/pairings") return Response.json({ pairings: linkAsked > 0 && decisions.length === 0 ? [{ id: "p1", label: "Hako's iPhone", digits: "123456", intent: "account", expires_at: new Date(time.now() + 60_000).toISOString() }] : [] });
      if (path === "/api/relay/pairing") {
        decisions.push(await request.json());
        account = "acct_1";
        return Response.json({ ok: true });
      }
      return undefined;
    });
    const out: string[] = [];
    const keys = keyboard();
    const code = await link([...options.args ?? [], "--approve"], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal,
      accountService: options.service ?? SERVICE, serviceFetch: (input, init) => service.fetch(new Request(input, init)), lines: keys.lines, terminal: true, discard: keys.discard,
      ...options.openBrowser === undefined ? {} : { openBrowser: options.openBrowser },
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown) options.approve(service, shown[1]!);
        if (text.includes("Enter to decline")) time.after(() => keys.type("456"));
      },
    });
    return { code, text: out.join(""), service, pc, decisions, named, calls: local.calls };
  }

  it("--approve signs in with the device flow, lists this PC in the account and approves the device that adds it after a number compare, with no QR code", async () => {
    const { code, text, service, pc, decisions, calls } = await linkToAccount({ approve: (service, shown) => service.approveDevice(shown, "acct_1") });
    // the approval is the way in: no code that admits its holder is asked of the PC, and the window stays open
    expect(calls.filter((call) => ["/api/relay/offer", "/api/relay/code", "/api/relay/link/close", "/api/devices"].includes(call.path))).toEqual([]);
    expect(text).not.toContain("Scan this QR code");
    expect(code).toBe(0);
    expect(text).toContain("https://github.com/login/device");
    expect(service.pcs("acct_1").map((entry) => [entry.server_id, entry.label])).toEqual([[pc.server_id, "old-desktop"]]);
    expect(text).toContain("Hako's iPhone wants to join your account");
    expect(text).toContain("123 456");
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
    expect(text).toContain("This PC is in your account (acct_1): every device of your account can use it.");
  });

  async function waiting(status: (polls: number, elapsed: number) => { account: string | null; enrolling?: boolean }, down: (elapsed: number) => boolean = () => false, latency: number | ((polls: number, elapsed: number) => number) = 0) {
    const pc = identity();
    const time = clock();
    let began: number | null = null;
    const elapsed = () => began === null ? -1 : time.now() - began;
    const service = new FakeAccountService(time.now);
    let polls = 0;
    const writes: string[] = [];
    const linkAt: number[] = [];
    const putAt: number[] = [];
    const named: string[] = [];
    const local = localPc(async (request, path) => {
      if (down(elapsed())) throw new TypeError("connection refused");
      if (path === "/api/account/status") return Response.json({ unlinked: [], removals: [], adds: [], blocked: [], ...status(polls, elapsed()) });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/account/relay-account") { named.push((await request.json() as { account: string }).account); return new Response(null, { status: 204 }); }
      if (path === "/api/relay/link") { began ??= time.now(); linkAt.push(elapsed()); }
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") { polls++; time.pass(typeof latency === "number" ? latency : latency(polls, elapsed())); return Response.json({ pairings: [] }); }
      return undefined;
    });
    const out: string[] = [];
    const code = await link(["--approve"], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal, lines: silent(), terminal: true, accountService: SERVICE,
      serviceFetch: (input, init) => {
        const request = new Request(input, init);
        if (request.method === "PUT" || request.method === "DELETE") writes.push(`${request.method} ${new URL(request.url).pathname} at poll ${polls}`);
        if (request.method === "PUT") putAt.push(elapsed());
        return service.fetch(request);
      },
      out: (text) => { out.push(text); const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text); if (shown) service.approveDevice(shown[1]!, "acct_1"); },
    });
    return { code, out, text: out.join(""), calls: local.calls, writes, time, pc, polls: () => polls, linkAt, putAt, named, service };
  }

  it("asks for its approve-here window again after 30 seconds of waiting, without writing to the account's list", async () => {
    const { code, calls, writes, pc } = await waiting((polls) => ({ account: polls >= 40 ? "acct_1" : null }));
    expect(code).toBe(0);
    const order = calls.filter((call) => call.path === "/api/relay/link" || call.path === "/api/relay/pairings").map((call) => call.path === "/api/relay/link" ? "link" : "poll");
    expect(order.join(" ")).toBe(["link", ...Array(16).fill("poll"), "link", ...Array(15).fill("poll"), "link", ...Array(9).fill("poll")].join(" "));
    for (const call of calls.filter((entry) => entry.path === "/api/relay/link")) {
      expect(call.method).toBe("POST");
      expect(call.headers.get("x-ovis-local-only")).toBe("1");
      expect(call.body).toBe("{}");
    }
    expect(writes).toEqual([`PUT /v1/pcs/${pc.server_id} at poll 0`]);
  });

  it("stops by itself after 30 minutes of waiting", async () => {
    const { code, out, time, polls } = await waiting(() => ({ account: null }));
    expect(code).toBe(1);
    expect(out.at(-1)).toBe("Stopped waiting after 30 minutes. Run this again to keep waiting.\n");
    expect(time.waits.filter((ms) => ms === 2_000)).toHaveLength(900);
    expect(polls()).toBe(901);
  });

  it("keeps waiting when run again after it stopped, though the earlier run's listing is not this sign-in's to renew", async () => {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    let account: string | null = null;
    let polls = 0;
    // the look from which this PC is in the account: none in the first run
    let joinsAt = Number.POSITIVE_INFINITY;
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") { if (++polls >= joinsAt) account = "acct_1"; return Response.json({ pairings: [] }); }
      return undefined;
    });
    const run = async () => {
      const out: string[] = [];
      const code = await link(["--approve"], {
        origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal, lines: silent(), terminal: true, accountService: SERVICE,
        serviceFetch: (input, init) => service.fetch(new Request(input, init)),
        out: (text) => { out.push(text); const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text); if (shown) service.approveDevice(shown[1]!, "acct_1"); },
      });
      return { code, text: out.join("") };
    };
    const first = await run();
    expect([first.code, first.text.endsWith("Stopped waiting after 30 minutes. Run this again to keep waiting.\n")]).toEqual([1, true]);
    // the listing the first run renewed last is more than nine minutes old: due for renewal, by another sign-in
    joinsAt = polls + 3;
    const { code, text } = await run();
    expect(text).not.toContain("Could not link this PC");
    expect(text).toContain("This PC stays listed, but an earlier run listed it, so your other devices may no longer show it as new.\n");
    expect(code).toBe(0);
    expect(service.pcs("acct_1").map((entry) => entry.server_id)).toEqual([pc.server_id]);
  });

  it("never asks for a window that would outlive its 30 minutes, nor shows this PC as new past it: neither in the last ten", async () => {
    const { code, linkAt, writes, pc } = await waiting(() => ({ account: null }));
    expect(code).toBe(1);
    // the server keeps a window ten minutes from when it was asked for: the last one ends as the run does
    expect(Math.max(...linkAt)).toBe(20 * 60_000);
    // every look of the last half minute asks, so the last one in time is among them whatever a look takes
    expect(linkAt.filter((at) => at > 19 * 60_000)).toEqual(Array.from({ length: 16 }, (_, look) => 19 * 60_000 + 30_000 + look * 2_000));
    // listed, then listed anew at 9 and 18 minutes (2-second polls) and with the first of those last looks, at 19:30,
    // so the account's devices offer Add until the run is all but over. Not after: the card would outlive the window and the run
    const entry = `/v1/pcs/${pc.server_id}`;
    expect(writes).toEqual([`PUT ${entry} at poll 0`, ...[271, 541, 586].flatMap((poll) => [`DELETE ${entry} at poll ${poll}`, `PUT ${entry} at poll ${poll}`])]);
  });

  it("asks for its last window with the last look before the last ten minutes, however long the calls take", async () => {
    for (const latency of [300, 500, 700, 900, 1_300, 1_900, 2_500]) {
      const { code, linkAt, writes } = await waiting(() => ({ account: null }), () => false, latency);
      expect(code).toBe(1);
      expect(Math.max(...linkAt)).toBeLessThanOrEqual(20 * 60_000);
      expect(Math.max(...linkAt)).toBeGreaterThan(20 * 60_000 - 2 * (2_000 + latency));
      expect(writes.filter((write) => write.startsWith("PUT")).length).toBe(4);
    }
  // seven runs of 30 minutes: more than the default five seconds on a busy host
  }, 60_000);

  it("asks for its last window and lists this PC anew in time when a look near the end takes longer than every look before it", async () => {
    const cutoff = 20 * 60_000;
    const runs: [string, (polls: number, elapsed: number) => number, number][] = [
      ["one slow look at the end", (_polls, elapsed) => elapsed >= cutoff ? 3_000 : 0, 3_000],
      ["slow from just before the end", (_polls, elapsed) => elapsed >= cutoff - 10_000 ? 4_000 : 100, 4_000],
      ["uneven all the way", (polls) => [0, 2_700, 400, 5_100, 900, 50, 3_300][polls % 7]!, 5_100],
      ["slower and slower", (_polls, elapsed) => Math.floor(elapsed / 60_000) * 250, 5_000],
    ];
    for (const [name, latency, slowest] of runs) {
      const { code, linkAt, putAt } = await waiting(() => ({ account: null }), () => false, latency);
      expect([name, code]).toEqual([name, 1]);
      expect([name, Math.max(...linkAt) <= cutoff]).toEqual([name, true]);
      expect([name, Math.max(...linkAt) > cutoff - (2_000 + slowest)]).toEqual([name, true]);
      expect([name, Math.max(...putAt) >= cutoff - 30_000 && Math.max(...putAt) <= cutoff]).toEqual([name, true]);
    }
  }, 60_000);

  it("does not call this PC added when it turns out to be in another account after a late unanswered call", async () => {
    const { code, out, writes, pc } = await waiting((_polls, elapsed) => ({ account: elapsed >= 25 * 60_000 ? "acct_other" : null }), (elapsed) => elapsed >= 25 * 60_000 && elapsed < 25 * 60_000 + 1_000);
    expect(code).toBe(1);
    expect(out.at(-1)).toContain("This PC joined another Ovis account (acct_other)");
    expect(out.join("")).not.toContain("this PC is in your account");
    expect(writes.at(-1)).toMatch(new RegExp(`^DELETE /v1/pcs/${pc.server_id} `));
  });

  it("waits for an Ovis server that restarts, and asks for its window again with the first call it answers", async () => {
    const { code, out, calls, linkAt } = await waiting((_polls, elapsed) => ({ account: elapsed >= 60_000 ? "acct_1" : null }), (elapsed) => elapsed >= 40_000 && elapsed < 50_000);
    expect(code).toBe(0);
    expect(out.filter((text) => text.includes("not answering"))).toEqual(["The Ovis on this PC is not answering (is it restarting?). Waiting for it…\n"]);
    expect(out.filter((text) => text.includes("answers again"))).toHaveLength(1);
    // the listing's own, the 30-second one, then at once when the server is back (a restarted server has no window)
    expect(linkAt).toEqual([0, 30_000, 50_000]);
    const paths = calls.map((call) => call.path);
    const lost = paths.indexOf("/api/relay/pairings", paths.lastIndexOf("/api/relay/link") - 6);
    expect(paths.slice(lost, lost + 7)).toEqual(["/api/relay/pairings", ...Array(5).fill("/api/relay/link"), "/api/relay/pairings"]);
    expect(out.at(-1)).toBe("This PC is in your account (acct_1): every device of your account can use it.\n" + CLOSING);
  });

  it("stops when the server goes away too late in the run to ask for its window again", async () => {
    const { code, out, linkAt } = await waiting(() => ({ account: null }), (elapsed) => elapsed >= 25 * 60_000);
    expect(code).toBe(1);
    expect(out.at(-1)).toBe("The Ovis on this PC stopped answering, too close to this run's 30 minutes to open its approval window again. Run this again once it is back.\n");
    expect(Math.max(...linkAt)).toBe(20 * 60_000);
  });

  it("ends well when one call went unanswered late in the run and this PC is in the account by then", async () => {
    let failed = 0;
    const { code, out, linkAt } = await waiting((_polls, elapsed) => ({ account: elapsed >= 25 * 60_000 ? "acct_1" : null }), (elapsed) => elapsed >= 25 * 60_000 && failed++ === 0);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe("This PC is in your account (acct_1): every device of your account can use it.\n" + CLOSING);
    expect(out.join("")).not.toContain("too close to this run's 30 minutes");
    expect(Math.max(...linkAt)).toBe(20 * 60_000);
  });

  it("keeps waiting for the account's other devices over a server restart, without asking for a window", async () => {
    const { code, linkAt } = await waiting((polls, elapsed) => ({ account: polls >= 2 ? "acct_1" : null, enrolling: elapsed < 60_000 }), (elapsed) => elapsed >= 20_000 && elapsed < 40_000);
    expect(code).toBe(0);
    expect(linkAt).toEqual([0]);
  });

  it("keeps waiting while the account's other devices are brought in, saying so once, and ends well when they are", async () => {
    const { code, out, polls } = await waiting((polls) => ({ account: polls >= 3 ? "acct_1" : null, enrolling: polls >= 3 && polls < 8 }));
    expect(code).toBe(0);
    expect(polls()).toBe(8);
    expect(out.filter((text) => text.includes("Bringing in"))).toEqual(["Added. Bringing in your account's other devices…\n"]);
    expect(out.at(-1)).toBe("This PC is in your account (acct_1): every device of your account can use it.\n" + CLOSING);
  });

  it("stops after 30 minutes when the account's other devices never come in, without saying it is done", async () => {
    const { code, text, out } = await waiting((polls) => ({ account: polls >= 1 ? "acct_1" : null, enrolling: true }));
    expect(code).toBe(1);
    expect(text).not.toContain("This PC is in your account (");
    expect(out.at(-1)).toBe("Stopped waiting after 30 minutes: this PC is in your account, but its other devices are not in yet. Open the Ovis app on the phone that added it, then run this again.\n");
  });

  it("run again while the account's other devices are still coming in, it waits for them without a sign-in", async () => {
    const time = clock();
    let looks = 0;
    let until = 4;
    const local = localPc((_request, path) => path === "/api/account/status" ? Response.json({ account: "acct_1", enrolling: ++looks < until, unlinked: [], removals: [], adds: [], blocked: [] }) : undefined);
    const out: string[] = [];
    const base = { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text: string) => out.push(text), signal: new AbortController().signal, lines: answers(), now: time.now, wait: time.wait, accountService: SERVICE,
      serviceFetch: () => { throw new Error("no sign-in is needed to wait"); } };
    expect(await link([], base)).toBe(0);
    expect(looks).toBe(4);
    expect(out[0]).toContain("its account's other devices are not in yet");
    expect(out.at(-1)).toBe("This PC is in an Ovis account (acct_1): every device of that account can use it.\n");
    out.length = 0;
    until = Infinity;
    expect(await link([], base)).toBe(1);
    expect(out.at(-1)).toBe("Stopped waiting after 30 minutes: this PC is in the account, but its other devices are not in yet. Open the Ovis app on the phone that added it, then run this again.\n");
    expect(local.calls.every((call) => call.path === "/api/account/status")).toBe(true);
  });

  it("fails, naming both accounts and the way out, when this PC ended in another account than the one that signed in", async () => {
    const { code, text, out, writes, pc, named, service } = await waiting((polls) => ({ account: polls >= 2 ? "acct_someone_else_entirely" : null, enrolling: true }));
    expect(code).toBe(1);
    expect(out.at(-1)).toBe("This PC joined another Ovis account (acct_someone), not the one you signed in to (acct_1). It was taken off the list of the account you signed in to. If that was not you, open Settings → Devices and PCs on this PC and choose Revoke all.\n");
    expect(writes).toEqual([`PUT /v1/pcs/${pc.server_id} at poll 0`, `DELETE /v1/pcs/${pc.server_id} at poll 2`]);
    expect(service.pcs("acct_1")).toEqual([]);
    expect(named).toEqual(["acct_1", "acct_someone_else_entirely"]);
    expect(text).not.toContain("This PC is in your account");
    expect(text).not.toContain("Bringing in");
  });

  it("links a PC whose Ovis relay asks for a pass: it signs in and names its account before waiting for the relay", async () => {
    const { code, text, named, decisions } = await linkToAccount({ enforcing: true, approve: (service, shown) => service.approveDevice(shown, "acct_1") });
    expect([code, named]).toEqual([0, "acct_1"]);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
    expect(text).toContain("This PC is in your account");
  });

  it("shows the Ovis link page and its code, with a QR code, when the account service has it", async () => {
    const { code, text, service } = await linkToAccount({
      prepare: (service) => service.offerLinkPage(["github", "google"]),
      approve: (service, shown) => service.approveOnLinkPage(shown, "acct_1", "google"),
    });
    expect(code).toBe(0);
    expect(text).toContain(`${SERVICE}/link`);
    expect(text).not.toContain("github.com/login/device");
    expectQrCode(text);
    expect(service.pcs("acct_1")).toHaveLength(1);
  });

  it("opens the link page with its code filled in where this PC's desktop has a browser, and says which code to check", async () => {
    const opened: string[] = [];
    const { code, text } = await linkToAccount({
      prepare: (service) => service.offerLinkPage(["github", "google"]),
      approve: (service, shown) => service.approveOnLinkPage(shown, "acct_1", "google"),
      openBrowser: (url) => { opened.push(url); return true; },
    });
    expect(code).toBe(0);
    expect(opened).toHaveLength(1);
    const page = new URL(opened[0]!);
    expect(`${page.origin}${page.pathname}`).toBe(`${SERVICE}/link`);
    expect(text).toContain(`  ${opened[0]}`);
    // the code to type stays on the screen for a sign-in on another device; the QR code is the headless screen's
    expect(text).not.toContain("Or scan this");
  });

  it("without a browser, shows the address and the code to type, with the QR code of the filled-in page", async () => {
    const { code, text } = await linkToAccount({
      prepare: (service) => service.offerLinkPage(["github", "google"]),
      approve: (service, shown) => service.approveOnLinkPage(shown, "acct_1", "google"),
      openBrowser: () => false,
    });
    expect(code).toBe(0);
    expect(text).toContain(`1. On any device, open: ${SERVICE}/link`);
    expectQrCode(text);
  });

  it("names the sign-ins of the link page only at the real account service: a test copy may ask for another", async () => {
    for (const [service, named] of [[SERVICE, false], [DEFAULT_ACCOUNT_SERVICE, true]] as const) {
      const { code, text } = await linkToAccount({
        service,
        prepare: (fake) => fake.offerLinkPage(["github", "google"]),
        approve: (fake, shown) => fake.approveOnLinkPage(shown, "acct_1", "google"),
      });
      expect(code).toBe(0);
      expect(text).toContain(`${service}/link`);
      expect([text.includes("GitHub"), text.includes("Google")]).toEqual([named, named]);
    }
  });

  it("uses GitHub's device page when the link page refuses with 429", async () => {
    const { code, text } = await linkToAccount({
      prepare: (service) => {
        service.offerLinkPage(["github", "google"]);
        const answer = service.fetch;
        Object.defineProperty(service, "fetch", { value: async (input: Request | string | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : new Request(input, init);
          return new URL(request.url).pathname === "/v1/signin/ovis/device"
            ? Response.json({ error: { code: "rate_limited", message: "" } }, { status: 429 }) : answer(request);
        } });
      },
      approve: (service, shown) => service.approveDevice(shown, "acct_1"),
    });
    expect(code).toBe(0);
    expect(text).toContain("https://github.com/login/device");
  });

  it("--github and --google keep the provider's own device page, even where the link page exists", async () => {
    const { code, text } = await linkToAccount({
      args: ["--google"],
      prepare: (service) => service.offerLinkPage(["github", "google"]),
      approve: (service, shown) => service.approveDevice(shown, "acct_1"),
    });
    expect(code).toBe(0);
    expect(text).toContain("https://www.google.com/device");
  });

  it("uses the device page the service offers when it has no link page", async () => {
    const { code, text } = await linkToAccount({
      prepare: (service) => service.offerSignIns(["google"], ["google"]),
      approve: (service, shown) => service.approveDevice(shown, "acct_1"),
    });
    expect(code).toBe(0);
    expect(text).toContain("https://www.google.com/device");
  });

  it("with --account naming another account than the one this PC is in, fails and names the way out, never switching it", async () => {
    const account = "acct_0123456789abcdef";
    const local = localPc((_request, path) => path === "/api/account/status" ? Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] }) : undefined);
    const run = async (args: string[]) => {
      const out: string[] = [];
      const code = await link(args, { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text) => out.push(text), signal: new AbortController().signal, lines: answers(), accountService: SERVICE, terminal: false, isTty: false });
      return { code, text: out.join("") };
    };
    for (const other of ["acct_2", "acct_0123456789abcdeX", "acct_0123456789ab_"]) {
      const refused = await run(["--account", other]);
      expect([other, refused.code]).toEqual([other, 1]);
      // the short form, as ovis status shows it, never the whole id
      expect(refused.text).toBe("This PC is in another Ovis account (acct_0123456). Run ovis logout to take it out of that one first, then run ovis add again.\n");
    }
    // the account it is in, by all of its id or its start as ovis status shows it: done, as before
    for (const same of [account, account.slice(0, 12)]) expect(await run(["--account", same])).toEqual({ code: 0, text: "This PC is already in an Ovis account (acct_0123456).\n" });
    expect(local.calls.map((call) => call.path).every((path) => path === "/api/account/status")).toBe(true);
  });

  describe("on a PC in its account that the account's move left with no key of its own in the list", () => {
    const LIST = "a".repeat(64);
    const until = "2026-11-06T12:10:00Z";
    /**
     * `after`: what the PC's status says once its add said added: `keyed` (its key is in), `kept` (it still says it
     * needs keys; it never does once its key is in), `left` (it left its account meanwhile: no account, no list)
     */
    const run = async (states: readonly Record<string, unknown>[], start: Response = Response.json({ state: "waiting", run: "r1", account: "acct_1", list: LIST, until }), after: "keyed" | "kept" | "left" = "keyed") => {
      const time = clock();
      const calls: { call: string; body: unknown }[] = [];
      const left = [...states];
      let keyed = false;
      const local = localPc(async (request, path) => {
        if (path === "/api/account/status" && keyed && after === "left") return Response.json({ account: null, enrolling: false, unlinked: [], removals: [], adds: [], blocked: [] });
        if (path === "/api/account/status") return Response.json({ account: "acct_1", enrolling: false, unlinked: [], removals: [], adds: [], blocked: [], list: { pinned_list: LIST, standing: "in", reason: keyed ? null : "no key of its own", ...(keyed ? {} : { needs_keys: true }) } });
        if (path === "/api/relay/link/close") return Response.json({ ok: true });
        if (!path.startsWith("/api/account/list/add")) return undefined;
        calls.push({ call: `${request.method} ${path}`, body: request.method === "GET" ? new URL(request.url).search : await request.json() });
        if (request.method === "POST" && path === "/api/account/list/add") return start;
        if (path === "/api/account/list/add/cancel") return Response.json({ state: "ended", run: "r1", account: "acct_1", why: "cancelled" });
        const next = left.shift() ?? { state: "waiting", run: "r1", account: "acct_1", list: LIST, until };
        if (next.state === "added" && after !== "kept") keyed = true;
        return Response.json(next);
      });
      const out: string[] = [];
      const code = await link([], { origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: async (ms, signal) => { time.pass(ms); await time.wait(ms, signal); },
        signal: new AbortController().signal, accountService: SERVICE, lines: answers(), terminal: false, isTty: false, out: (text) => out.push(text),
        serviceFetch: async () => { throw new Error("a PC in its account signs in to nothing for its keys"); } });
      return { code, text: out.join(""), calls };
    };

    it("goes on to the add by the account's list, and is done once the device whose number was confirmed gave it its keys", async () => {
      const { code, text, calls } = await run([
        { state: "number", run: "r1", account: "acct_1", list: LIST, digits: "123456", until },
        { state: "confirmed", run: "r1", account: "acct_1", list: LIST, until },
        { state: "added", run: "r1", account: "acct_1", list: LIST },
      ]);
      expect(code).toBe(0);
      expect(text).toContain("This PC is in your Ovis account (acct_1) and follows its signed list, but holds no key of its own in it yet: it came in as your account moved, so it lets your account's devices in and lets nobody new in itself.\n");
      expect(text).toContain("This PC shows 123 456. If the device that adds it shows the same number, run ovis add --confirm 123456 on this PC within 2 minutes");
      expect(text).toContain("Done: this PC holds its own keys in your account's list now, so a device that asks to join can be approved here too (ovis approve).\n");
      expect(text).not.toContain("already in an Ovis account");
      expect(calls[0]).toEqual({ call: "POST /api/account/list/add", body: { account: "acct_1" } });
      expect(calls.slice(1).every((call) => call.call === "GET /api/account/list/add" && call.body === "?run=r1")).toBe(true);
    });

    it("says it still has no key of its own when nobody compared a number in time, and takes nothing off the account", async () => {
      const { code, text, calls } = await run([]);
      expect(code).toBe(1);
      expect(text).toContain("No device of your account compared a number with this PC within 10 minutes, so it still holds no key of its own in your account's list. Run ovis add again");
      expect(text).not.toMatch(/Added|taken off|Done/);
      expect(calls.at(-1)?.call).toBe("POST /api/account/list/add/cancel");
    });

    it("says Done only once this PC no longer says it needs keys, whatever its add answered", async () => {
      const { code, text } = await run([
        { state: "number", run: "r1", account: "acct_1", list: LIST, digits: "123456", until },
        { state: "confirmed", run: "r1", account: "acct_1", list: LIST, until },
        { state: "added", run: "r1", account: "acct_1", list: LIST },
      ], undefined, "kept");
      expect(code).toBe(1);
      expect(text).not.toContain("Done:");
      expect(text).toContain("this PC still holds no key of its own in your account's list");
    });

    it("never says Done for a PC that left its account meanwhile: its status names no account and no list", async () => {
      const { code, text } = await run([
        { state: "number", run: "r1", account: "acct_1", list: LIST, digits: "123456", until },
        { state: "confirmed", run: "r1", account: "acct_1", list: LIST, until },
        { state: "added", run: "r1", account: "acct_1", list: LIST },
      ], undefined, "left");
      expect(code).toBe(1);
      expect(text).not.toContain("Done:");
      expect(text).toContain("This PC is no longer in Ovis account acct_1, so it holds no key of its own in that account's list.");
    });

    it("says why where this PC takes no keys by the list, and that it is still in its account", async () => {
      const { code, text } = await run([], Response.json({ error: { code: "account_mismatch", message: "This PC was set up for another account. Sign in to that one, or add this PC again." } }, { status: 409 }));
      expect(code).toBe(1);
      expect(text).toContain("Could not give this PC its keys: This PC was set up for another account. Sign in to that one, or add this PC again. This PC is still in your account, and holds no key of its own in its list yet. Run ovis add again to finish.\n");
    });
  });

  it("does not sign in when this PC is already in an account, or when the account service is off", async () => {
    let account: string | null = "acct_1";
    const local = localPc((_request, path) => path === "/api/account/status" ? Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] }) : undefined);
    const out: string[] = [];
    const base = { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text: string) => out.push(text), signal: new AbortController().signal, lines: answers() };
    expect(await link([], { ...base, accountService: SERVICE })).toBe(0);
    // whose account it is cannot be told without a sign-in: the start of its id, not "your account"
    expect(out.join("")).toBe("This PC is already in an Ovis account (acct_1).\n");
    out.length = 0;
    account = null;
    expect(await link([], { ...base, accountService: null })).toBe(1);
    expect(out.join("")).toContain("--code");
    expect(local.calls.map((call) => call.path)).toEqual(["/api/account/status", "/api/account/status"]);
  });

  it("shows a pairing's label without the terminal controls it carries, so it cannot hide the digits", async () => {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    let account: string | null = null;
    let decided = false;
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") return Response.json({ pairings: decided ? [] : [{ id: "p1", label: "\x1b[2J\x1b[HPress y\x1b[8m\u009b31m", digits: "654321", intent: "pc", expires_at: new Date(time.now() + 60_000).toISOString() }] });
      if (path === "/api/relay/pairing") { decided = true; account = "acct_1"; return Response.json({ ok: true }); }
      return undefined;
    });
    const out: string[] = [];
    const keys = keyboard();
    await link(["--approve"], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal,
      accountService: SERVICE, serviceFetch: (input, init) => service.fetch(new Request(input, init)), lines: keys.lines, terminal: true, discard: keys.discard,
      out: (text) => { out.push(text); const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text); if (shown) service.approveDevice(shown[1]!, "acct_1"); if (text.includes("Enter to decline")) time.after(() => keys.type("")); },
    });
    const text = out.join("");
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(text).toContain("[2J[HPress y[8m31m wants to pair with this PC");
    expect(text).toContain("654 321");
  });

  it("Ctrl+C at an approval prompt stops at once and ends the sign-in", async () => {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    const stop = new AbortController();
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account: null, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") return Response.json({ pairings: [{ id: "p1", label: "Phone", digits: "111222", intent: "account", expires_at: new Date(time.now() + 60_000).toISOString() }] });
      return undefined;
    });
    let token = "";
    const out: string[] = [];
    const code = await link(["--approve"], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: stop.signal,
      accountService: SERVICE, lines: silent(), terminal: true,
      serviceFetch: async (input, init) => {
        const request = new Request(input, init);
        const answer = await service.fetch(request);
        if (new URL(request.url).pathname === "/v1/token" && answer.ok) token = (await answer.clone().json() as { access_token: string }).access_token;
        return answer;
      },
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown) service.approveDevice(shown[1]!, "acct_1");
        if (text.includes("Enter to decline")) stop.abort();
      },
    });
    expect(code).toBe(1);
    expect(local.calls.some((call) => call.path === "/api/relay/pairing")).toBe(false);
    // signed out at the service: the token no longer lists the account's PCs
    expect((await service.fetch(new Request(SERVICE + "/v1/pcs", { headers: { authorization: "Bearer " + token } }))).status).toBe(401);
  });

  /**
   * `link` signed in to acct_1 and waiting, with requests to approve: `pending` names the ones waiting at each poll
   * (each shows 111 222 unless `request` gives it other digits, so a line begun for one would approve the next),
   * `said` hears every line, to `type` a line at that very moment or to `answer` after the next wait (two seconds: the
   * time a person takes to compare the digits), and `decide` may fail the call that carries an answer.
   */
  async function prompting(options: { pending: (polls: number, decisions: { id: string; decision: string }[]) => string[]; said: (text: string, type: (line: string) => void, answer: (line: string) => void) => void; terminal?: boolean; decide?: (attempt: number) => void; joined?: (decisions: { id: string; decision: string }[]) => boolean; refuse?: (waits: number) => boolean; called?: (path: string, type: (line: string) => void, polls: number) => void; lines?: AsyncIterator<string>; request?: (id: string) => { label?: string; digits?: string; local_only?: true }; discard?: (() => boolean) | null; keys?: ReturnType<typeof keyboard> }) {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    const keys = options.keys ?? keyboard();
    let refused = 0;
    let polls = 0;
    let attempts = 0;
    const decisions: { id: string; decision: string }[] = [];
    const local = localPc(async (request, path) => {
      if (options.refuse?.(time.waits.length)) { if (++refused > 200) throw new Error("the loop spins without waiting"); throw new TypeError("connection refused"); }
      options.called?.(path, keys.type, polls);
      if (path === "/api/account/status") return Response.json({ account: options.joined?.(decisions) ? "acct_1" : null, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") return Response.json({ pairings: options.pending(++polls, decisions).map((id) => ({ id, label: `Phone ${id}`, digits: "111222", ...options.request?.(id), intent: "account", expires_at: new Date(time.now() + 60_000).toISOString() })) });
      if (path === "/api/relay/pairing") {
        options.decide?.(++attempts);
        decisions.push(await request.json() as { id: string; decision: string });
        return Response.json({ ok: true });
      }
      return undefined;
    });
    const out: string[] = [];
    const code = await link(["--approve"], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal,
      accountService: SERVICE, lines: options.lines ?? keys.lines, terminal: options.terminal ?? true, serviceFetch: (input, init) => service.fetch(new Request(input, init)),
      ...options.discard === null ? {} : { discard: options.discard ?? keys.discard },
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown) service.approveDevice(shown[1]!, "acct_1");
        options.said(text, keys.type, (line) => time.after(() => keys.type(line)));
      },
    });
    return { code, out, text: out.join(""), calls: local.calls, decisions, polls: () => polls, refused: () => refused };
  }

  it("stops after its 30 minutes with a request left unanswered, and keeps its window open meanwhile", async () => {
    const { code, out, calls, decisions, polls } = await prompting({ pending: () => ["p1"], said: () => undefined });
    expect(code).toBe(1);
    expect(out.filter((text) => text.includes("Enter to decline"))).toHaveLength(1);
    expect(out.at(-1)).toBe("\nStopped waiting after 30 minutes. Run this again to keep waiting.\n");
    expect(decisions).toEqual([]);
    expect(polls()).toBe(901);
    expect(calls.filter((call) => call.path === "/api/relay/link")).toHaveLength(41 + 14);
  });

  it("drops a request that stopped waiting at its prompt, and never takes a line typed after it as the answer to the next", async () => {
    const { code, out, decisions } = await prompting({
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 5 || decisions.length > 0 ? [] : ["p2"],
      said: (text, type, answer) => {
        if (text.includes("Phone p1 is no longer waiting")) type("222");
        if (text.includes("Phone p2 wants")) answer("");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((text) => text.includes("Enter to decline")).map((text) => text.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(out).toContain("\nPhone p1 is no longer waiting.\n");
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  it("never takes a line typed for a request that went away as the answer to the next one shown in the same look", async () => {
    const { code, out, decisions } = await prompting({
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      said: (text, type, answer) => {
        if (text.includes("Phone p1 is no longer waiting")) type("222");
        if (text.includes("Phone p2 wants")) answer("");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((text) => text.includes("Enter to decline")).map((text) => text.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  it("never takes a line begun under a request that went away as the answer to the next one: it answers nothing, also when it comes right after the next prompt", async () => {
    let shown = 0;
    const { code, out, text, decisions } = await prompting({
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      said: (said, type, answer) => {
        if (said.includes("Phone p2 wants")) { if (++shown === 1) type("222"); else answer(""); }
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(text).toContain("That line answered nothing: a request went away while it may have been typed.");
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  // In canonical mode the terminal hands a line over when Enter is pressed, and it is stamped then: what was typed at
  // p1's prompt and not sent comes with the Enter pressed at p2's, however long after p2's prompt showed
  it("never takes a line begun at a request that went away as the answer to the next one, also when its Enter comes two seconds after the next prompt", async () => {
    for (const gap of [false, true]) {
      for (const held of ["y", "222", "111 222", ""]) {
        let shown = 0;
        const { code, out, text, decisions } = await prompting({
          pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : gap && polls <= 5 ? [] : ["p2"],
          said: (said, _type, answer) => {
            if (said.includes("Phone p2 wants")) answer(++shown === 1 ? held : "");
          },
          joined: (decisions) => decisions.length > 0,
        });
        expect(code).toBe(0);
        expect(out.filter((said) => said.includes("That line answered nothing: a request went away while it may have been typed. Answer again for the request shown now."))).toHaveLength(1);
        expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
        expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
        expect(text).not.toContain("Approved");
      }
    }
  }, 30_000);

  it("drops the line held at a request that went away when its Enter comes while nothing is asked, and only that one", async () => {
    const { code, out, decisions } = await prompting({
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 6 || decisions.length > 0 ? [] : ["p2"],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 is no longer waiting")) answer("222");
        if (said.includes("Phone p2 wants")) answer("111222");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("That line answered nothing: a request went away while it may have been typed.\n"))).toHaveLength(1);
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(decisions).toEqual([{ id: "p2", decision: "approve" }]);
  });

  it("drops the line held at a request that went away also when an Enter pressed too soon came at that request first", async () => {
    let p1 = 0;
    let p2 = 0;
    const { code, text, decisions } = await prompting({
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      said: (said, type, answer) => {
        if (said.includes("Phone p1 wants") && ++p1 === 1) type("");
        if (said.includes("Phone p2 wants")) answer(++p2 === 1 ? "222" : "");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(text).toContain("too soon to have compared its digits");
    expect(text).toContain("That line answered nothing: a request went away while it may have been typed.");
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  it("drops the line held at a request that went away also when another line came as that request went: that one is not the held one", async () => {
    let typed = false;
    let shown = 0;
    const { code, out, decisions } = await prompting({
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      called: (path, type, polls) => { if (path === "/api/relay/pairings" && polls === 3 && !typed) { typed = true; type("222"); } },
      said: (said, _type, answer) => { if (said.includes("Phone p2 wants") && ++shown <= 2) answer(shown === 1 ? "222" : ""); },
      joined: (decisions) => decisions.length > 0,
    });
    expect(typed).toBe(true);
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("That line answered nothing")).map((said) => said.trim())).toEqual([
      "That line answered nothing: no request is waiting for an answer.",
      "That line answered nothing: a request went away while it may have been typed. Answer again for the request shown now.",
    ]);
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  const PROMPT = "Phone p1 wants to join your account. Approve it only if its screen shows 111 222. Type 222 to approve, or press Enter to decline: ";
  const NOT_AN_ANSWER = "That line answered nothing: only the digits shown approve a request, and only Enter by itself declines it. Answer again.\n";
  const otherDigits = (typed: string, label: string, digits: string): string => `That line answered nothing: ${typed} are not this request's digits: ${label} shows ${digits.slice(0, 3)} ${digits.slice(3)}. If the device you are adding shows other digits than those, this request is not that device's: press Enter by itself to decline it, and do not type the digits below.\n`;

  it("approves a request only with its own digits (all six, with or without the space, or the last three), and declines it only with Enter by itself", async () => {
    for (const [line, decision] of [
      ["111 222", "approve"], ["111222", "approve"], ["222", "approve"], ["  222 ", "approve"], [" 111  222\t", "approve"],
      ["", "decline"], ["  ", "decline"],
    ] as const) {
      const { code, out, decisions } = await prompting({
        pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
        said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(line); },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect([line, decisions]).toEqual([line, [{ id: "p1", decision }]]);
      expect(out.filter((said) => said.includes("Enter to decline"))).toEqual([PROMPT]);
      expect(out.some((said) => said === "Approved.\n")).toBe(decision === "approve");
      expect(out.some((said) => said === "Declined.\n")).toBe(decision === "decline");
      expect(out).not.toContain(NOT_AN_ANSWER);
    }
  }, 30_000);

  it("asks about a device that adds this PC from its own add screen as that device shows it: the number is typed there, or compared", async () => {
    // the device that adds this PC (AddPcSheet, "Add this PC") shows an input for this PC's number, not digits of its own
    const ADDING = "Phone p1 wants to add this PC to your account. Type 111 222 on that device, or check that it shows the same number, then type 222 here to approve, or press Enter to decline: ";
    const { code, out, decisions } = await prompting({
      pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
      request: () => ({ local_only: true }),
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer("222"); },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("Enter to decline"))).toEqual([ADDING]);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
  });

  it("asks for all six digits of such a device as of any other, when another request ends in the same three", async () => {
    const shown: string[] = [];
    await prompting({
      pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1", "p2"],
      request: (id) => ({ digits: id === "p1" ? "111456" : "222456", local_only: true }),
      said: (said, _type, answer) => { if (said.includes("Enter to decline")) { shown.push(said); answer(""); } },
      joined: (decisions) => decisions.length > 1,
    });
    expect(shown[0]).toBe("Phone p1 wants to add this PC to your account. Type 111 456 on that device, or check that it shows the same number. Another request's digits end in 456 too, so type all six (111456) here to approve, or press Enter to decline: ");
  });

  it("approves with the digits as an input method types them: full-width digits and its wide space are the same digits", async () => {
    for (const line of ["２２２", "１１１２２２", "１１１　２２２", "１１１ ２２２", "2２2", "　222　"]) {
      const { code, out, decisions } = await prompting({
        pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
        said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(line); },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect([line, decisions]).toEqual([line, [{ id: "p1", decision: "approve" }]]);
      expect(out.filter((said) => said.includes("Enter to decline"))).toEqual([PROMPT]);
    }
    for (const [line, decision] of [["２２３", null], ["１１１", null], ["　", "decline"]] as const) {
      let asked = 0;
      const { decisions } = await prompting({
        pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
        said: (said, _type, answer) => { if (said.includes("Phone p1 wants") && ++asked === 1) answer(line); },
        joined: (decisions) => decisions.length > 0,
      });
      expect([line, decisions]).toEqual([line, decision === null ? [] : [{ id: "p1", decision }]]);
    }
  }, 30_000);

  it("answers nothing with a line that is neither the digits nor empty: a habitual y or a typo declines nothing, and the question is asked again", async () => {
    for (const then of ["222", ""]) {
      for (const line of ["n", "no", "y", "Y", "yes", "111", "223", "333444", "22", "2222", "1112222", "111222 222", "y222", "222y", "٢٢٢"]) {
        let asked = 0;
        const { code, out, decisions } = await prompting({
          pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
          said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++asked === 1 ? line : then); },
          joined: (decisions) => decisions.length > 0,
        });
        expect(code).toBe(0);
        const told = /^(\d{3}|\d{6})$/.test(line) ? otherDigits(line, "Phone p1", "111222") : NOT_AN_ANSWER;
        expect([line, out.filter((said) => said.startsWith("That line answered nothing") || said.includes("Enter to decline"))]).toEqual([line, [PROMPT, told, PROMPT]]);
        expect([line, decisions]).toEqual([line, [{ id: "p1", decision: then === "" ? "decline" : "approve" }]]);
      }
    }
  }, 60_000);

  it("leaves a request waiting when only lines that are no answer were typed at it", async () => {
    const { code, out, decisions } = await prompting({
      pending: () => ["p1"],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer("y"); },
    });
    expect(code).toBe(1);
    expect(decisions).toEqual([]);
    expect(out.filter((said) => said === NOT_AN_ANSWER).length).toBeGreaterThan(1);
  });

  it("approves nothing with another request's digits: neither the ones answered before, nor the same device's earlier ones", async () => {
    const request = (id: string) => ({ label: "Phone", digits: id === "p1" ? "111222" : "333444" });
    let second = 0;
    const first = await prompting({
      request,
      pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
      said: (said, _type, answer) => { if (said.includes("111 222")) answer("222"); if (said.includes("333 444")) answer(++second === 1 ? "222" : ""); },
      joined: (decisions) => decisions.length > 1,
    });
    expect(first.code).toBe(0);
    expect(first.out.filter((said) => said.startsWith("That line answered nothing"))).toEqual([otherDigits("222", "Phone", "333444")]);
    expect(first.decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "decline" }]);
    let shown = 0;
    const again = await prompting({
      request,
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      said: (said, _type, answer) => { if (said.includes("333 444")) answer(++shown <= 2 ? "222" : ""); },
      joined: (decisions) => decisions.length > 0,
    });
    expect(again.code).toBe(0);
    const p2 = "Phone wants to join your account. Approve it only if its screen shows 333 444. Type 444 to approve, or press Enter to decline: ";
    expect(again.out.filter((said) => said.includes("Enter to decline"))).toEqual([
      "Phone wants to join your account. Approve it only if its screen shows 111 222. Type 222 to approve, or press Enter to decline: ", p2, p2, p2,
    ]);
    expect(again.out.filter((said) => said.startsWith("\nThat line answered nothing") || said.startsWith("That line answered nothing")).map((said) => said.trim().slice(0, 60))).toEqual([
      "That line answered nothing: a request went away while it may",
      "That line answered nothing: 222 are not this request's digit",
    ]);
    expect(again.decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  // Digits are uniform, so two requests end in the same three once in a thousand pairs: the last three then name neither
  describe("a request whose last three digits another request shares", () => {
    const request = (id: string) => ({ digits: id === "p1" ? "111456" : id === "p2" ? "222456" : "333789" });
    const short = (id: string, digits: string) => `Phone ${id} wants to join your account. Approve it only if its screen shows ${digits.slice(0, 3)} ${digits.slice(3)}. Type ${digits.slice(3)} to approve, or press Enter to decline: `;
    const whole = (id: string, digits: string) => `Phone ${id} wants to join your account. Approve it only if its screen shows ${digits.slice(0, 3)} ${digits.slice(3)}. Another request's digits end in ${digits.slice(3)} too, so type all six (${digits}) to approve, or press Enter to decline: `;
    const SIX_ONLY = "That line answered nothing: only all six digits shown approve this request, and only Enter by itself declines it. Answer again.\n";
    const prompts = (out: string[]) => out.filter((said) => said.includes("Enter to decline"));

    it("is approved only by all six when the other one was asked about before it in this run: its last three, typed again, approve nothing", async () => {
      for (const [then, decision] of [["222456", "approve"], ["222 456", "approve"], ["111456", null], ["", "decline"]] as const) {
        let asked = 0;
        const { out, decisions } = await prompting({
          request,
          pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
          said: (said, _type, answer) => {
            if (said.includes("Phone p1 wants")) answer("456");
            if (said.includes("Phone p2 wants") && ++asked <= 2) answer(asked === 1 ? "456" : then);
          },
          joined: (decisions) => decisions.length > 1,
        });
        expect(prompts(out).slice(0, 3)).toEqual([short("p1", "111456"), whole("p2", "222456"), whole("p2", "222456")]);
        expect(out.filter((said) => said.startsWith("That line answered nothing")).slice(0, 2)).toEqual([SIX_ONLY, ...decision === null ? [otherDigits("111456", "Phone p2", "222456")] : []]);
        expect([then, decisions]).toEqual([then, [{ id: "p1", decision: "approve" }, ...decision === null ? [] : [{ id: "p2", decision }]]]);
      }
    }, 30_000);

    it("is approved only by all six when the other one went away unanswered: the line held at that one is dropped, and the same line typed again approves nothing", async () => {
      let asked = 0;
      const { code, out, decisions } = await prompting({
        request,
        pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
        said: (said, _type, answer) => { if (said.includes("Phone p2 wants") && ++asked <= 3) answer(asked <= 2 ? "456" : "222456"); },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect(prompts(out)).toEqual([short("p1", "111456"), whole("p2", "222456"), whole("p2", "222456"), whole("p2", "222456")]);
      expect(out.filter((said) => said.includes("That line answered nothing")).map((said) => said.trim())).toEqual([
        "That line answered nothing: a request went away while it may have been typed. Answer again for the request shown now.",
        SIX_ONLY.trim(),
      ]);
      expect(decisions).toEqual([{ id: "p2", decision: "approve" }]);
    });

    it("is approved only by all six when the other one waits beside it now, and so is that one", async () => {
      const { code, out, decisions } = await prompting({
        request,
        pending: (_polls, decisions) => ["p1", "p2"].filter((id) => !decisions.some((decision) => decision.id === id)),
        said: (said, _type, answer) => {
          if (said === whole("p1", "111456")) answer("111 456");
          if (said === whole("p2", "222456")) answer("222456");
        },
        joined: (decisions) => decisions.length > 1,
      });
      expect(code).toBe(0);
      expect(prompts(out)).toEqual([whole("p1", "111456"), whole("p2", "222456")]);
      expect(decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "approve" }]);
    });

    it("asks again for all six once another request with the same last three starts waiting beside it: the three digits then approve nothing", async () => {
      let asked = 0;
      const { code, out, decisions } = await prompting({
        request,
        pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 2 ? ["p2"] : ["p2", "p1"],
        said: (said, _type, answer) => { if (said === whole("p2", "222456") && ++asked <= 2) answer(asked === 1 ? "456" : "222456"); },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect(prompts(out)).toEqual([short("p2", "222456"), whole("p2", "222456"), whole("p2", "222456")]);
      expect(out).toContain("\nAnother request's digits end in 456 too: only all six digits approve Phone p2 now.\n");
      expect(out.filter((said) => said === SIX_ONLY)).toHaveLength(1);
      expect(decisions).toEqual([{ id: "p2", decision: "approve" }]);
    });

    it("looks once more before it sends an approval typed as three digits: a request that came since the last look and ends in them takes it back", async () => {
      let asked = 0;
      const { code, out, decisions } = await prompting({
        request,
        pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 1 ? ["p2"] : ["p2", "p1"],
        said: (said, _type, answer) => {
          if (said === short("p2", "222456")) answer("456");
          if (said === whole("p2", "222456") && ++asked === 1) answer("222 456");
        },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect(prompts(out)).toEqual([short("p2", "222456"), whole("p2", "222456")]);
      expect(out).toContain("That line answered nothing: another request's digits end in 456 too, so only all six digits approve Phone p2 now.\n");
      expect(decisions).toEqual([{ id: "p2", decision: "approve" }]);
    });

    it("sends an answer already given in full, or a decline, when another request with the same last three comes beside it", async () => {
      for (const [line, decision] of [["222456", "approve"], ["", "decline"]] as const) {
        const { out, decisions } = await prompting({
          request,
          pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 1 ? ["p2"] : ["p2", "p1"],
          said: (said, _type, answer) => { if (said === short("p2", "222456")) answer(line); },
          joined: (decisions) => decisions.length > 0,
        });
        expect(prompts(out)).toEqual([short("p2", "222456")]);
        expect(decisions).toEqual([{ id: "p2", decision }]);
      }
    });

    it("keeps to its last three when no other request shares them, and when it is the same request asked again", async () => {
      let asked = 0;
      const { code, out, decisions } = await prompting({
        request,
        pending: (_polls, decisions) => decisions.length === 0 ? ["p3"] : decisions.length === 1 ? ["p1"] : [],
        said: (said, _type, answer) => {
          if (said.includes("Phone p3 wants")) answer("789");
          if (said.includes("Phone p1 wants") && ++asked <= 3) answer("456");
        },
        decide: (attempt) => { if (attempt === 2) throw new TypeError("timed out"); },
        joined: (decisions) => decisions.length > 1,
      });
      expect(code).toBe(0);
      expect(new Set(prompts(out))).toEqual(new Set([short("p3", "333789"), short("p1", "111456")]));
      expect(decisions).toEqual([{ id: "p3", decision: "approve" }, { id: "p1", decision: "approve" }]);
    });
  });

  it("approves nothing for a request whose digits are not six digits: a bare Enter never matches what is missing, and nothing but Enter answers it", async () => {
    const prompt = "Phone p1 wants to join your account, but its request came without six digits to compare, so it cannot be approved here. Press Enter to decline: ";
    for (const digits of ["", "12", "123", "abcdef", "12345", "1234567"]) {
      for (const line of ["", digits, digits.slice(3)]) {
        let asked = 0;
        const { code, out, decisions } = await prompting({
          request: () => ({ digits }),
          pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
          said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++asked === 1 ? line : ""); },
          joined: (decisions) => decisions.length > 0,
        });
        expect(code).toBe(0);
        expect([digits, line, decisions]).toEqual([digits, line, [{ id: "p1", decision: "decline" }]]);
        expect(out.filter((said) => said.includes("Enter to decline") || said.includes("That line answered nothing"))).toEqual(line === "" ? [prompt]
          : [prompt, "That line answered nothing: this request cannot be approved here, and only Enter by itself declines it. Answer again.\n", prompt]);
      }
    }
  }, 30_000);

  it("approves nothing when the only line sent was begun under the request before the one shown", async () => {
    let typedOnce = false;
    const { code, decisions } = await prompting({
      pending: (polls) => polls <= 3 ? ["p1"] : ["p2"],
      said: (said, type) => { if (said.includes("Phone p2 wants") && !typedOnce) { typedOnce = true; type("222"); } },
    });
    expect(code).toBe(1);
    expect(decisions).toEqual([]);
  });

  it("leaves a request unanswered when the only line typed was for the one before it", async () => {
    const { code, decisions } = await prompting({
      pending: (polls) => polls <= 3 ? ["p1"] : ["p2"],
      said: (text, type) => { if (text.includes("Phone p1 is no longer waiting")) type("222"); },
    });
    expect(code).toBe(1);
    expect(decisions).toEqual([]);
  });

  it("waits between looks while the PC's server is down, also with an answer typed, and sends it once the server is back", async () => {
    let downAt: number | null = null;
    const { code, text, decisions, refused } = await prompting({
      pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
      said: (said, type) => { if (said.includes("not answering")) type("222"); },
      refuse: (waits) => { if (waits >= 3) downAt ??= waits; return downAt !== null && waits < downAt + 10; },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(text).toContain("The Ovis on this PC answers again.");
    expect(refused()).toBeLessThanOrEqual(11);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
  });

  const LOST = "That line answered nothing: the answer before it may not have reached the Ovis on this PC, and it may have been typed meanwhile. Answer again for the request shown now.\n";

  it("asks about a request again when its answer did not reach the server, rather than skipping it or sending the old answer", async () => {
    let prompts = 0;
    const { code, text, out, decisions, calls } = await prompting({
      pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
      said: (said, _type, answer) => { if (said.includes("Enter to decline")) answer(++prompts === 1 ? "222" : ""); },
      decide: (attempt) => { if (attempt === 1) throw new TypeError("timed out"); },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("Enter to decline"))).toHaveLength(3);
    expect(out.filter((said) => said === LOST)).toHaveLength(1);
    expect(text).toContain("Your answer may not have reached the Ovis on this PC. Phone p1 is asked about again if it is still waiting.");
    expect(calls.filter((call) => call.path === "/api/relay/pairing").map((call) => JSON.parse(call.body))).toEqual([{ id: "p1", decision: "approve" }, { id: "p1", decision: "decline" }]);
    expect(decisions).toEqual([{ id: "p1", decision: "decline" }]);
  });

  it("answers nothing with the first line after an answer that did not reach the server: typed meanwhile, it never answers the request shown next", async () => {
    for (const typed of ["", "456", "111456", "789"]) {
      let lost = false;
      let asked = 0;
      const { code, out, decisions } = await prompting({
        request: (id) => ({ digits: id === "p1" ? "111456" : "222789" }),
        pending: (_polls, decisions) => !lost ? ["p1"] : decisions.length > 0 ? [] : ["p2"],
        decide: (attempt) => { if (attempt === 1) { lost = true; throw new TypeError("timed out"); } },
        said: (said, _type, answer) => {
          if (said.includes("Phone p1 wants")) answer("456");
          if (said.includes("Phone p2 wants") && ++asked <= 2) answer(asked === 1 ? typed : "789");
        },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect(out.filter((said) => said === LOST)).toHaveLength(1);
      expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
      expect([typed, decisions]).toEqual([typed, [{ id: "p2", decision: "approve" }]]);
    }
  }, 30_000);

  it("approves nothing with a line typed twice after its request went away: the second never waits for the next request", async () => {
    const { code, out, text, decisions } = await prompting({
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 5 || decisions.length > 0 ? [] : ["p2"],
      said: (said, type) => {
        // too late for p1, and once more when nothing seemed to happen: a terminal keeps the second for the next read
        if (said.includes("Phone p1 is no longer waiting")) { type("222"); type("222"); }
      },
    });
    expect(code).toBe(1);
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(decisions).toEqual([]);
    expect(text).toContain("That line answered nothing: no request is waiting for an answer.");
  });

  it("approves nothing with a line typed twice as its request gives way to the next in one look", async () => {
    const { code, out, decisions } = await prompting({
      pending: (polls) => polls <= 3 ? ["p1"] : ["p2"],
      said: (said, type) => { if (said.includes("Phone p1 is no longer waiting")) { type("222"); type("222"); } },
    });
    expect(code).toBe(1);
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(out.findIndex((said) => said.includes("That line answered nothing"))).toBeLessThan(out.findIndex((said) => said.includes("Phone p2 wants")));
    expect(decisions).toEqual([]);
  });

  it("takes no line typed before the first request as its answer: neither during the sign-in nor while waiting for a request", async () => {
    for (const when of ["Waiting for the sign-in", "Its request shows here to approve"]) {
      let answered = false;
      const { code, out, text, decisions } = await prompting({
        pending: (polls, decisions) => polls <= 2 || decisions.length > 0 ? [] : ["p1"],
        said: (said, type, answer) => {
          if (said.includes(when)) { type("222"); type("222"); type(""); }
          if (said.includes("Phone p1 wants") && !answered) { answered = true; answer(""); }
        },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect(text).toContain("That line answered nothing");
      expect(out.filter((said) => said.includes("Enter to decline"))).toHaveLength(1);
      expect(decisions).toEqual([{ id: "p1", decision: "decline" }]);
    }
  });

  // A terminal hands a line over only when Enter is pressed: what was typed before a prompt and not sent would come
  // with the Enter pressed at it, long after it showed. So the terminal's input is discarded as a request first shows
  describe("what was typed and not sent before a request's prompt showed", () => {
    it("is no part of its answer: neither the digits typed ahead of the first request, nor a start the rest is typed to", async () => {
      for (const [begun, rest] of [["222", ""], ["111222", ""], ["111 222", ""], ["22", "2"], ["1112", "22"]] as const) {
        const keys = keyboard();
        let asked = 0;
        const { code, out, text, decisions } = await prompting({
          keys,
          pending: (polls, decisions) => polls <= 2 || decisions.length > 0 ? [] : ["p1"],
          said: (said, _type, answer) => {
            if (said.includes("Its request shows here to approve")) keys.begin(begun);
            if (said.includes("Phone p1 wants")) answer(++asked === 1 ? rest : "");
          },
          joined: (decisions) => decisions.length > 0,
        });
        expect(code).toBe(0);
        expect(text).not.toContain("Approved");
        expect([begun, out.filter((said) => said.includes("Enter to decline")).length]).toEqual([begun, rest === "" ? 1 : 2]);
        expect([begun, decisions]).toEqual([begun, [{ id: "p1", decision: "decline" }]]);
      }
    }, 30_000);

    it("is no part of the answer to a later request either: typed after one answer, it does not answer the request that shows next", async () => {
      const keys = keyboard();
      const { code, decisions } = await prompting({
        keys,
        request: (id) => ({ digits: id === "p1" ? "111222" : "333444" }),
        pending: (polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 && polls > 6 ? ["p2"] : [],
        said: (said, _type, answer) => {
          if (said.includes("Phone p1 wants")) answer("222");
          if (said === "Approved.\n") keys.begin("444");
          if (said.includes("Phone p2 wants")) answer("");
        },
        joined: (decisions) => decisions.length > 1,
      });
      expect(code).toBe(0);
      expect(decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "decline" }]);
    });

    it("is discarded once for a request, as its prompt first shows: what is typed under a prompt stays when the prompt is shown again", async () => {
      const keys = keyboard();
      let asked = 0;
      const { code, decisions } = await prompting({
        keys,
        pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
        said: (said, _type, answer) => {
          if (said.includes("Phone p1 wants")) answer(++asked === 1 ? "y" : "2");
          if (said.includes("That line answered nothing")) keys.begin("22");
        },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect(keys.discards()).toBe(1);
      expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
    });

    it("is not looked for where the input is no terminal", async () => {
      const keys = keyboard();
      await prompting({ keys, terminal: false, pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"], said: () => undefined, joined: (decisions) => decisions.length > 0 });
      expect(keys.discards()).toBe(0);
    });

    it("costs the first line after the prompt where the terminal's input cannot be discarded: that line answers nothing, and the question is asked again", async () => {
      for (const discard of [null, () => false, () => { throw new Error("no tcflush here"); }]) {
        for (const [begun, rest] of [["222", ""], ["", ""], ["", "222"]] as const) {
          const keys = keyboard();
          let asked = 0;
          const { code, out, decisions } = await prompting({
            keys, discard,
            pending: (polls, decisions) => polls <= 2 || decisions.length > 0 ? [] : ["p1"],
            said: (said, _type, answer) => {
              if (said.includes("Its request shows here to approve")) keys.begin(begun);
              if (said.includes("Phone p1 wants")) answer(++asked === 1 ? rest : "222");
            },
            joined: (decisions) => decisions.length > 0,
          });
          expect(code).toBe(0);
          expect(out.filter((said) => said.includes("Enter to decline") || said.includes("That line answered nothing"))).toEqual([
            PROMPT,
            "That line answered nothing: this terminal's input could not be emptied as the request showed, so it may have been begun before that. Answer again for the request shown now.\n",
            PROMPT,
          ]);
          expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
        }
      }
    }, 30_000);
  });

  it("takes no line that came between a request's arrival and its prompt: the digits were not on the screen yet", async () => {
    let typedAhead = false;
    const { code, out, text, decisions } = await prompting({
      pending: () => ["p1"],
      called: (path, type, polls) => { if (path === "/api/account/status" && polls === 1 && !typedAhead) { typedAhead = true; type("222"); } },
      said: () => undefined,
    });
    expect(typedAhead).toBe(true);
    expect(code).toBe(1);
    expect(decisions).toEqual([]);
    expect(text).toContain("That line answered nothing: it was typed before the request shown now was asked about.");
    expect(out.filter((said) => said.includes("Enter to decline"))).toHaveLength(1);
  });

  it("answers one request with one line: a second line at its prompt never answers the next request", async () => {
    const { code, out, decisions } = await prompting({
      pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 wants")) { answer("222"); answer(""); }
        if (said.includes("Phone p2 wants")) answer("111 222");
      },
      joined: (decisions) => decisions.length > 1,
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "approve" }]);
  });

  it("declines every request when its input is not a terminal, whatever was piped in, without reading it, and still ends", async () => {
    for (const piped of [[], ["222"], ["222", "222", "222"]]) {
      let reads = 0;
      const lines = answers(...piped);
      const { code, out, text, decisions } = await prompting({
        lines: { next: () => { reads++; return lines.next(); } }, terminal: false,
        pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
        said: () => undefined,
        joined: (decisions) => decisions.length > 1,
      });
      expect(code).toBe(0);
      // what is not a terminal is never read: none of its lines is taken, dropped or waited for
      expect(reads).toBe(0);
      expect(text).not.toContain("That line answered nothing");
      expect(text).not.toContain("The terminal's input ended");
      expect(out.filter((said) => said.includes("This is not run in a terminal"))).toEqual(["This is not run in a terminal, so no request can be answered here: each is declined as it shows. Run this in a terminal to approve one (over ssh, run ssh -t).\n"]);
      expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
      expect(out.filter((said) => said === "Declined.\n")).toHaveLength(2);
      expect(decisions).toEqual([{ id: "p1", decision: "decline" }, { id: "p2", decision: "decline" }]);
    }
  });

  it("approves nothing with a line from an input that is not a terminal, also when it comes long after a request's prompt", async () => {
    // `(sleep 60; echo y) | ovis add`, or `yes | ovis add`: every line comes after a prompt, and nobody compared its digits
    const { code, out, text, decisions } = await prompting({
      terminal: false,
      pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
      said: (said, _type, answer) => { if (said.includes("wants")) { answer("222"); answer("222"); } },
      joined: (decisions) => decisions.length > 1,
    });
    expect(code).toBe(0);
    expect(decisions).toEqual([{ id: "p1", decision: "decline" }, { id: "p2", decision: "decline" }]);
    expect(out.filter((said) => said.includes("This is not run in a terminal"))).toHaveLength(1);
    expect(text.indexOf("This is not run in a terminal")).toBeLessThan(text.indexOf("Phone p1 wants"));
  });

  it("approves nothing with a second line typed right after an answer: the next request's prompt was only just shown", async () => {
    let again = false;
    const { code, out, text, decisions } = await prompting({
      pending: (_polls, decisions) => decisions.length === 0 ? ["p1", "p2"] : ["p2"],
      said: (said, type, answer) => {
        if (said.includes("Phone p1 wants")) answer("111222");
        if (said.includes("Phone p2 wants") && !again) { again = true; type("111222"); }
      },
    });
    expect(code).toBe(1);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
    expect(text).toContain("That line answered nothing: it came as the request showed, too soon to have compared its digits.");
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
  });

  it("asks once more for the answer to a request that follows one that went away, however long after: the first line may have been begun at that one", async () => {
    const { code, out, decisions } = await prompting({
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 200 || decisions.length > 0 ? [] : ["p2"],
      said: (said, _type, answer) => { if (said.includes("Phone p2 wants")) answer("111222"); },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("That line answered nothing"))).toHaveLength(1);
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
    expect(decisions).toEqual([{ id: "p2", decision: "approve" }]);
  });

  it("says so when the terminal's input ends while nothing is asked, before it declines the requests that follow", async () => {
    let end: (() => void) | null = null;
    const closing: AsyncIterator<string> = { next: () => new Promise((resolve) => { end = () => resolve({ value: undefined, done: true }); }) };
    const { code, out, text, decisions } = await prompting({
      lines: closing,
      pending: (polls, decisions) => polls <= 5 || decisions.length > 0 ? [] : ["p1"],
      called: (path, _type, polls) => { if (path === "/api/relay/pairings" && polls === 2) end?.(); },
      said: () => undefined,
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(decisions).toEqual([{ id: "p1", decision: "decline" }]);
    expect(out.filter((said) => said.includes("The terminal's input ended"))).toHaveLength(1);
    expect(text.indexOf("The terminal's input ended")).toBeLessThan(text.indexOf("Phone p1 wants"));
  });

  it("ends the run when reading the terminal fails, when it does and not at the next request", async () => {
    const { code, text, polls } = await prompting({
      lines: { next: () => Promise.reject(new Error("EIO: read failed")) },
      pending: () => [],
      said: () => undefined,
    });
    expect(code).toBe(1);
    expect(text).toContain("Could not link this PC: EIO: read failed");
    expect(polls()).toBeLessThan(3);
  });

  it("reads the terminal only once this PC is listed and the person was told what to do, so a run in the background stops no sooner", async () => {
    let listed = false;
    let readWhenListed: boolean | null = null;
    const keys = keyboard();
    const { code } = await prompting({
      lines: { next: () => { readWhenListed ??= listed; return keys.lines.next(); } },
      pending: () => [],
      said: (said) => { if (said.includes("Its request shows here to approve")) listed = true; },
      joined: () => listed,
    });
    expect(code).toBe(0);
    expect(readWhenListed).toBe(true);
  });

  it("declines a request when the input ends at its prompt (Ctrl+D), and the ones after it", async () => {
    let end: (() => void) | null = null;
    const closing: AsyncIterator<string> = { next: () => new Promise((resolve) => { end = () => resolve({ value: undefined, done: true }); }) };
    const { code, decisions } = await prompting({
      lines: closing,
      pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
      said: (said) => { if (said.includes("Phone p1 wants")) end?.(); },
      joined: (decisions) => decisions.length > 1,
    });
    expect(code).toBe(0);
    expect(decisions).toEqual([{ id: "p1", decision: "decline" }, { id: "p2", decision: "decline" }]);
  });

  it("puts this PC back in the account's list while the account's other devices are brought in, not only at the end", async () => {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    let account: string | null = null;
    let enrolling = false;
    let polls = 0;
    let failPuts = false;
    const listed: [number, boolean][] = [];
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account, enrolling, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") {
        polls++;
        if (polls === 271) failPuts = true;
        if (polls === 272) { account = "acct_1"; enrolling = true; }
        if (polls === 274) failPuts = false;
        if (polls === 274 || polls === 276) listed.push([polls, service.pcs("acct_1").length === 1]);
        if (polls === 278) enrolling = false;
        return Response.json({ pairings: [] });
      }
      return undefined;
    });
    const out: string[] = [];
    const code = await link(["--approve"], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal, lines: answers(), accountService: SERVICE,
      serviceFetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "PUT" && failPuts) throw new TypeError("offline for a moment");
        return service.fetch(request);
      },
      out: (text) => { out.push(text); const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text); if (shown) service.approveDevice(shown[1]!, "acct_1"); },
    });
    expect(code).toBe(0);
    expect(listed).toEqual([[274, false], [276, true]]);
    expect(out.join("")).toContain("Added. Bringing in your account's other devices");
  });

  it("keeps this PC listed when renewing its listing fails after the old one went, and lists it again", async () => {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    let account: string | null = null;
    let polls = 0;
    let failPuts = 0;
    let listedDuringFailure: boolean | null = null;
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") {
        polls++;
        if (polls === 271) failPuts = 1;
        if (polls === 273) listedDuringFailure = service.pcs("acct_1").length === 1;
        if (polls === 275) account = "acct_1";
        return Response.json({ pairings: [] });
      }
      return undefined;
    });
    const out: string[] = [];
    const code = await link(["--approve"], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal, lines: answers(), accountService: SERVICE,
      serviceFetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "PUT" && failPuts > 0) { failPuts--; throw new TypeError("offline for a moment"); }
        return service.fetch(request);
      },
      out: (text) => { out.push(text); const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text); if (shown) service.approveDevice(shown[1]!, "acct_1"); },
    });
    expect(code).toBe(0);
    expect(listedDuringFailure).toBe(true);
    expect(service.pcs("acct_1").map((entry) => entry.server_id)).toEqual([pc.server_id]);
  });

  it("puts this PC back in the account's list when a renewal's DELETE went through but its answer was lost", async () => {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    let polls = 0;
    let loseDelete = false;
    let account: string | null = null;
    let listedAfter: boolean | null = null;
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") {
        if (++polls === 271) loseDelete = true;
        if (polls === 273) { listedAfter = service.pcs("acct_1").length === 1; account = "acct_1"; }
        return Response.json({ pairings: [] });
      }
      return undefined;
    });
    const out: string[] = [];
    expect(await link(["--approve"], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal, lines: answers(), accountService: SERVICE,
      serviceFetch: async (input, init) => {
        const request = new Request(input, init);
        const answer = await service.fetch(request);
        if (request.method === "DELETE" && loseDelete) { loseDelete = false; throw new TypeError("connection reset"); }
        return answer;
      },
      out: (text) => { out.push(text); const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text); if (shown) service.approveDevice(shown[1]!, "acct_1"); },
    })).toBe(0);
    expect(listedAfter).toBe(true);
    expect(service.pcs("acct_1").map((entry) => entry.server_id)).toEqual([pc.server_id]);
    expect(out.join("")).not.toContain("dropped out of your account's list");
  });

  /**
   * `ovis add` at a PC that takes the account's one-press admission (POST /api/account/one-press). It binds as
   * server/account/one-press.ts does once the account service holds an admission of its listing by the account named.
   * A device of the account presses Add on this PC's card (`pressAfter`: right after that ask was answered), which is its
   * own fresh sign-in admitting the PC (src/components/UnconfirmedPcNotices.tsx). `stopAt`: Ctrl+C as that ask comes.
   */
  async function pressing(options: {
    pressAfter?: number; stopAt?: number;
    args?: string[]; terminal?: boolean; isTty?: boolean; settings?: Record<string, string | undefined>;
    /** what the person types at "Is this your account?" (yes by default); false: nothing */
    confirm?: string | false;
    /** Ctrl+C once this PC is in an account: as the ask that bound it answers, or as the relay is waited for after it */
    stopWhenBound?: "take" | "relay";
    /** Ctrl+C as this PC is named for its listing's account, before the wait set up anything */
    stopWhenNamed?: boolean;
    /** a device of the account chooses No on the card right after that ask: its own fresh sign-in removes the listing */
    noAfter?: number;
    answer?: (asks: number, state: { account: string | null }) => Response | undefined;
    prepare?: (service: FakeAccountService, pc: ReturnType<typeof identity>, time: ReturnType<typeof clock>) => Promise<void> | void;
    relay?: () => string;
    /** the joins waiting on this PC's own window at its Nth read (GET /api/relay/joins); none by default */
    joins?: (reads: number) => OwnJoin[] | Response;
    /** this PC's answer to the Nth six digits typed for a join (POST /api/relay/join); it lets the device in by default */
    join?: (typed: { id: string; digits: string }, count: number) => Response | undefined;
    /** this PC's devices at its Nth read (GET /api/devices); not answered by default */
    devices?: (reads: number) => unknown[];
    /**
     * each text the command writes once this PC is added; `answer` types a line `after` ms (2 s by default: once it
     * could be read). By default Enter is typed at the first question
     */
    watch?: (said: string, answer: (line: string, after?: number) => void, stop: () => void) => void;
    /** this PC's answers on its add by the account's signed list (/api/account/list/add…); no such route by default */
    list?: (call: { readonly action: "start" | "state" | "confirm" | "cancel"; readonly body: Record<string, unknown>; readonly count: number }) => Response | undefined;
    /** each text the command writes, before this PC is added too; `type` types a line `after` ms later (2 s by default) */
    said?: (text: string, type: (line: string, after?: number) => void) => void;
    /** this PC's answer to a reset of its relay identity (POST /api/relay/reset-identity); no such route by default */
    reset?: () => Response;
    /** Ctrl+C once the command said the number was confirmed */
    stopAfterConfirm?: boolean;
  } = {}) {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    service.opensAll = true;
      await options.prepare?.(service, pc, time);
    const stop = new AbortController();
    const state = { account: null as string | null };
    const askedAt: number[] = [];
    const pressed: unknown[] = [];
    const named: unknown[] = [];
    const typed: { id: string; digits: string }[] = [];
    let joinReads = 0;
    let deviceReads = 0;
    let resets = 0;
    const resetBodies: unknown[] = [];
    const listCalls: { action: string; body: Record<string, unknown> }[] = [];
    let added = false;
    let signedOutBeforeAdded: boolean | undefined;
    let token = "";
    const pressAdd = async (): Promise<void> => {
      const own = service.issueToken("acct_1");
      const admitted = await service.fetch(new Request(`${SERVICE}/v1/pcs/${pc.server_id}/admit`, { method: "POST", headers: { authorization: `Bearer ${own}`, "content-type": "application/json" }, body: "{}" }));
      expect(admitted.ok).toBe(true);
    };
    const refuse = (code: string, message: string, status: number) => Response.json({ error: { code, message } }, { status });
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account: state.account, enrolling: false, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") {
        if (options.stopWhenBound === "relay" && state.account !== null) stop.abort();
        return Response.json({ phase: options.relay?.() ?? (state.account === null ? "connecting" : "online"), blocked: null });
      }
      if (path === "/api/account/relay-account") {
        named.push((await request.json() as { account?: unknown }).account);
        if (options.stopWhenNamed === true) stop.abort();
        return new Response(null, { status: 204 });
      }
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/link/close") return Response.json({ ok: true });
      if (path === "/api/relay/joins") {
        const listed = options.joins?.(++joinReads) ?? [];
        return listed instanceof Response ? listed : Response.json({ joins: listed });
      }
      if (path === "/api/relay/join") {
        const body = await request.json() as { id: string; digits: string };
        typed.push(body);
        return options.join?.(body, typed.length) ?? Response.json({ ok: true });
      }
      if (path === "/api/devices" && options.devices !== undefined) return Response.json({ devices: options.devices(++deviceReads) });
      if (path.startsWith("/api/account/list/add") && options.list !== undefined) {
        const action = request.method === "GET" ? "state" : path.endsWith("/confirm") ? "confirm" : path.endsWith("/cancel") ? "cancel" : "start";
        // a poll names its run in the query, every other call in its body
        const body = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await request.json() as Record<string, unknown>;
        listCalls.push({ action, body });
        const answer = options.list({ action, body, count: listCalls.filter((call) => call.action === action).length });
        if (answer !== undefined && answer.ok && (await answer.clone().json() as { state?: string }).state === "added") state.account = "acct_1";
        return answer;
      }
      if (path === "/api/relay/reset-identity" && options.reset !== undefined) { resets++; resetBodies.push(await request.json()); return options.reset(); }
      // which PC this is, as its health says it
      if (path === "/api/health" && options.reset !== undefined) return Response.json({ ok: true, web_ui: { server_id: pc.server_id } });
      if (path === "/api/account/one-press") {
        const body = await request.json() as { account?: unknown };
        if (typeof body.account !== "string") return refuse("invalid_account", "Name the account", 400);
        askedAt.push(time.now());
        pressed.push(body.account);
        const asks = askedAt.length;
        if (asks === options.stopAt) { stop.abort(); return refuse("no_admission", "The account service did not admit this PC in one press", 404); }
        const answer = options.answer?.(asks, state) ?? (() => {
          if (state.account !== null) return refuse("in_account", "This PC is already in an account", 409);
          const listed = service.pcs(body.account as string).find((entry) => entry.server_id === pc.server_id);
          if (listed?.admitted_at == null) return refuse("no_admission", "The account service did not admit this PC in one press", 404);
          state.account = body.account as string;
          return Response.json({ account: state.account });
        })();
        if (asks === options.pressAfter) await pressAdd();
        if (options.stopWhenBound === "take" && state.account !== null) stop.abort();
        if (asks === options.noAfter) {
          const removed = await service.fetch(new Request(`${SERVICE}/v1/pcs/${pc.server_id}`, { method: "DELETE", headers: { authorization: `Bearer ${service.issueToken("acct_1")}` } }));
          expect(removed.status).toBe(204);
        }
        return answer;
      }
      return undefined;
    });
    const out: string[] = [];
    const keys = keyboard();
    const code = await link(options.args ?? [], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: stop.signal,
      accountService: SERVICE, lines: keys.lines, discard: keys.discard, terminal: options.terminal ?? true, isTty: options.isTty ?? true,
      ...linkSettings(options.settings ?? {}),
      serviceFetch: async (input, init) => {
        const request = new Request(input, init);
        const answer = await service.fetch(request);
        if (new URL(request.url).pathname === "/v1/token" && answer.ok) token = (await answer.clone().json() as { access_token: string }).access_token;
        if (new URL(request.url).pathname === "/v1/signout") signedOutBeforeAdded ??= !added;
        return answer;
      },
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown) service.approveDevice(shown[1]!, "acct_1");
        // typed once the question could be read
        if (text.includes("Is this your account? Type yes") && options.confirm !== false) { time.pass(2_000); keys.type(options.confirm ?? "yes"); }
        options.said?.(text, (line, after = 2_000) => { setTimeout(() => { time.pass(after); keys.type(line); }, 0); });
        if (options.stopAfterConfirm === true && text.includes("Confirmed. Press Add")) setTimeout(() => stop.abort(), 0);
        if (text.startsWith("Added")) added = true;
        if (added) {
          const answer = (line: string, after = 2_000): void => { setTimeout(() => { time.pass(after); keys.type(line); }, 0); };
          if (options.watch !== undefined) options.watch(text, answer, () => stop.abort());
          else if (text.endsWith("type them here (Enter to finish without): ")) answer("");
        }
      },
    });
    const listed = () => service.pcs("acct_1").filter((entry) => entry.server_id === pc.server_id);
    // the sign-in ends with the run, whatever ended it
    const signedOut = (await service.fetch(new Request(`${SERVICE}/v1/session`, { headers: { authorization: `Bearer ${token}` } }))).status === 401;
    return { code, text: out.join(""), askedAt, pressed, named, typed, service, pc, listed, signedOut, signedOutBeforeAdded, listCalls, resets: () => resets, resetBodies, paths: local.calls.map((call) => `${call.method} ${call.path}`) };
  }

  // the id first, with where to compare it; the PCs as what that account lists, which a decoy account can copy
  const ASKED = [
    "     Ovis account acct_1 (signed in with GitHub).",
    "     Compare this ID with Settings → Manage account → Account ID in your",
    "     Ovis app, or with ovis status on a PC you already use.",
    "     That account lists no PCs yet.",
    "     Is this your account? Type yes to add this PC to it: ",
  ].join("\n");
  // the step that says what to press comes once this PC said how its account adds it (POST /api/account/list/add)
  const LISTED_AND_NAMED = "     This PC is listed in your account as old-desktop.\n     Asking your account how it adds this PC…\n\n2/2  Press Add on a device of your account\n     Open Ovis on your phone or another PC and press Add for old-desktop.\n";
  const NO_TERMINAL = "Not run in a terminal, so nobody here can confirm the account that signs in. Run ovis add --account <your account id> (ovis status on a PC already in your account shows the id, and so does Manage account in Settings), or run ovis add in a terminal.\n";

  it("without --qr, asks whether the account is yours, waits for Add on a device of that account, takes its admission here, and comes online", async () => {
    const run = await pressing({ pressAfter: 2 });
    expect(run.code).toBe(0);
    // the account is named and confirmed before anything is listed in it
    expect(run.text).toContain(ASKED);
    expect(run.text).toContain(`${LISTED_AND_NAMED}     Waiting… (up to 10:00, Ctrl+C to stop)\n`);
    expect(run.text.endsWith(FINISHED)).toBe(true);
    // asked every six seconds, each time for the account that signed in, until the admission was there
    expect(run.pressed).toEqual(["acct_1", "acct_1", "acct_1"]);
    expect(run.askedAt.map((at) => at - run.askedAt[0]!)).toEqual([0, 6_000, 12_000]);
    // nothing that lets its holder in is made or shown, and the window for digits approved here is closed
    expect(run.paths.filter((path) => ["POST /api/relay/offer", "POST /api/relay/code", "GET /api/relay/pairings"].includes(path))).toEqual([]);
    expect(run.paths).toContain("POST /api/relay/link/close");
    expect(run.text).not.toContain("QR code");
    // listed, named for its relay pass, and named again once added, which asks for the pass the account now gives
    expect(run.named).toEqual(["acct_1", "acct_1"]);
    expect(run.paths.lastIndexOf("POST /api/account/relay-account")).toBeGreaterThan(run.paths.lastIndexOf("POST /api/account/one-press"));
    expect(run.listed().map((entry) => entry.listed_by_device)).toEqual([false]);
    expect(run.signedOut).toBe(true);
  });

  describe("an account that keeps a signed list (POST /api/account/list/add)", () => {
    const RUN = "0123456789abcdef";
    const state = (body: Record<string, unknown>) => Response.json({ run: RUN, account: "acct_1", list: "ab".repeat(32), until: "2026-11-06T12:10:00.000Z", ...body });
    const wrongNumber = () => Response.json({ error: { code: "wrong_number", message: "That is not the number this PC shows now" } }, { status: 409 });
    const NUMBER = "This PC shows 482 913. Does the device that adds it show the same number? Type yes if it does, or press Enter if it does not: ";
    /** this PC's add as its states go: waiting, the number until it is answered, confirmed, then added once Add was pressed */
    const adding = (options: { added?: boolean; onConfirm?: (digits: unknown) => Record<string, unknown> | Response } = {}) => {
      let confirmed = false;
      let cancelled = false;
      return ({ action, body, count }: { action: string; body: Record<string, unknown>; count: number }): Response => {
        if (action === "start") return state({ state: "waiting" });
        if (action === "cancel") { cancelled = true; return Response.json({ state: "ended", run: RUN, account: "acct_1", why: "cancelled" }); }
        if (action === "confirm") {
          const answer = options.onConfirm?.(body.digits) ?? { state: "confirmed" };
          if (answer instanceof Response) return answer;
          confirmed = answer.state === "confirmed";
          return state(answer);
        }
        if (cancelled) return Response.json({ state: "ended", run: RUN, account: "acct_1", why: "cancelled" });
        if (confirmed) return count >= 4 && options.added !== false ? Response.json({ state: "added", run: RUN, account: "acct_1", list: "ab".repeat(32) }) : state({ state: "confirmed" });
        return state({ state: "number", digits: "482913" });
      };
    };

    it("shows the number this PC and the adding device share, takes a typed yes for that number, and is added once Add is pressed", async () => {
      const run = await pressing({ list: adding(), said: (text, type) => { if (text.endsWith(NUMBER)) type("yes"); } });
      expect(run.code).toBe(0);
      expect(run.text).toContain("Your account keeps a signed list of its devices: the device that adds this PC shows a number, and this PC shows it here. They must be the same before you press Add.\n");
      expect(run.text).toContain(`${NUMBER}Confirmed. Press Add for old-desktop on that device now.\n`);
      expect(run.text).toContain("Added. ");
      // the yes carries the number it was typed under, and nothing asks for the account service's own admission
      expect(run.listCalls.filter((call) => call.action === "confirm").map((call) => call.body)).toEqual([{ digits: "482913", run: RUN }]);
      expect(run.listCalls[0]).toEqual({ action: "start", body: { account: "acct_1" } });
      // every poll names the run this command started
      expect(run.listCalls.filter((call) => call.action === "state").every((call) => call.body.run === RUN)).toBe(true);
      expect(run.pressed).toEqual([]);
      expect(run.named).toEqual(["acct_1", "acct_1"]);
      expect(run.signedOut).toBe(true);
    });

    it("takes Enter at the number as a no: the add ends, and the PC is taken off the account's list", async () => {
      const run = await pressing({ list: adding(), said: (text, type) => { if (text.endsWith(NUMBER)) type(""); } });
      expect(run.code).toBe(1);
      expect(run.listCalls.map((call) => call.action)).toContain("cancel");
      expect(run.listCalls.map((call) => call.action)).not.toContain("confirm");
      expect(run.text).toContain("Could not add this PC: the numbers were not the same, so nothing was added.");
      expect(run.text).toContain("This PC was taken off your account's list; it is in no account.");
      expect(run.listed()).toEqual([]);
    });

    it("takes nothing but yes or Enter, and no line typed before the number showed", async () => {
      let typedAhead = false;
      const lines = ["482913", "yes"];
      const run = await pressing({ list: adding(), said: (text, type) => {
        // typed before the number is there: the terminal's input is emptied as it shows
        if (text.includes("Your account keeps a signed list") && !typedAhead) { typedAhead = true; type("yes", 0); }
        if (text.endsWith(NUMBER)) type(lines.shift() ?? "yes");
      } });
      expect(run.code).toBe(0);
      expect(run.text).toContain("That line answered nothing: type yes if that device shows the same number, or press Enter by itself if it does not. Answer again.\n");
      expect(run.listCalls.filter((call) => call.action === "confirm")).toHaveLength(1);
    });
    it("says so when the number it was typed under is no longer the one this PC shows", async () => {
      let asked = 0;
      const run = await pressing({ list: adding({ onConfirm: () => ++asked === 1 ? wrongNumber() : { state: "confirmed" } }),
        said: (text, type) => { if (text.endsWith(NUMBER)) type("yes"); } });
      expect(run.code).toBe(0);
      expect(run.text).toContain("That number is no longer the one this PC shows, so nothing was confirmed.\n");
      expect(run.listCalls.filter((call) => call.action === "confirm")).toHaveLength(2);
    });

    it("where nobody can type, prints the number with the command that confirms it, and confirms nothing itself", async () => {
      let reads = 0;
      const run = await pressing({ args: ["--account", "acct_1"], terminal: false, isTty: false,
        list: ({ action }) => action === "start" ? state({ state: "waiting" }) : ++reads < 3 ? state({ state: "number", digits: "482913" }) : ++reads < 6 ? state({ state: "confirmed" }) : Response.json({ state: "added", run: RUN, account: "acct_1", list: "ab".repeat(32) }) });
      expect(run.code).toBe(0);
      expect(run.text.split("This PC shows 482 913. If the device that adds it shows the same number, run ovis add --confirm 482913 on this PC within 2 minutes, then press Add on that device.").length).toBe(2);
      expect(run.text).toContain("An agent adds a PC in one step with an invite: ovis join.");
      expect(run.listCalls.map((call) => call.action)).not.toContain("confirm");
    });

    it("names the list's step, and never the one-press step, once this PC said the account keeps a list", async () => {
      const run = await pressing({ list: adding(), said: (text, type) => { if (text.endsWith(NUMBER)) type("yes"); } });
      expect(run.code).toBe(0);
      expect(run.text).toContain([
        "     This PC is listed in your account as old-desktop.",
        "     Asking your account how it adds this PC…",
        "",
        "2/2  Compare a number with a device of your account",
        "     Open Ovis on your phone or another PC and choose Add for old-desktop.",
        "     Your account keeps a signed list of its devices: the device that adds this PC shows a number, and this PC shows it here. They must be the same before you press Add.",
        "     Waiting… (up to 10:00, Ctrl+C to stop)",
        "",
      ].join("\n"));
      expect(run.text).not.toContain("Press Add on a device of your account");
      expect(run.text.split("Your account keeps a signed list").length).toBe(2);
    });

    it("waits while the account service does not say whether the account keeps a list, and binds nothing on its word meanwhile", async () => {
      const run = await pressing({ pressAfter: 1, list: ({ action, count }) => action === "start" && count < 3 ? Response.json({ error: { code: "account_unavailable", message: "away" } }, { status: 503 }) : state({ state: "no_list" }) });
      expect(run.code).toBe(0);
      expect(run.text).toContain("The account service did not answer this PC just now. Still waiting…\n");
      // what to press is said once this PC knows it, and once
      expect(run.text.indexOf("2/2  Press Add on a device of your account")).toBeGreaterThan(run.text.indexOf("Still waiting…"));
      expect(run.text.split("2/2  Press Add on a device of your account").length).toBe(2);
      expect(run.text).not.toContain("Compare a number");
      // only once the PC said the account keeps no list is the admission asked for
      expect(run.paths.indexOf("POST /api/account/one-press", 2)).toBeGreaterThan(run.paths.lastIndexOf("POST /api/account/list/add"));
      expect(run.listCalls.map((call) => call.action)).toEqual(["start", "start", "start"]);
    });

    it("gives its add up when it stops: a yes confirmed before joins nothing once the command is gone", async () => {
      // the number is confirmed, and the command is stopped while it waits for Add on the device
      const run = await pressing({ list: adding({ added: false }), said: (text, type) => { if (text.endsWith(NUMBER)) type("yes"); },
        watch: () => undefined, stopAfterConfirm: true });
      expect(run.code).toBe(1);
      expect(run.listCalls.at(-1)).toEqual({ action: "cancel", body: { run: RUN } });
    });

    it("gives its add up also when its terminal fails after the number was confirmed", async () => {
      const actions: string[] = [];
      const answers = adding({ added: false });
      let failed = false;
      const ended = await pressing({ list: (call) => { actions.push(call.action); return answers(call); }, watch: () => undefined,
        said: (text, type) => {
          if (text.endsWith(NUMBER)) type("yes");
          // the terminal the command writes to goes away as it says the number was confirmed
          if (!failed && text.includes("Confirmed. Press Add")) { failed = true; throw new Error("The terminal is gone"); }
        } }).then((run) => run.code, (error: unknown) => error);
      expect(failed).toBe(true);
      // the command ends, whichever way it reports that
      expect(ended).not.toBe(0);
      expect(actions.at(-1)).toBe("cancel");
    });

    it("reports nothing of an add that took its place on this PC", async () => {
      const run = await pressing({ list: ({ action }) => action === "start" ? state({ state: "waiting" }) : Response.json({ state: "replaced" }) });
      expect(run.code).toBe(1);
      expect(run.text).toContain("Could not add this PC: another add was started on this PC meanwhile, which took this one's place.");
      expect(run.text).not.toContain("Added");
    });

    it("ends with what this PC said when its add ended otherwise", async () => {
      const run = await pressing({ list: ({ action }) => action === "start" ? state({ state: "waiting" }) : Response.json({ state: "ended", run: RUN, account: "acct_1", why: "attempts" }) });
      expect(run.code).toBe(1);
      expect(run.text).toContain("Could not add this PC: this PC showed three numbers in this run and none was confirmed.");
    });

    describe("ovis add --confirm <number>", () => {
      const confirming = async (args: string[], answer?: (digits: unknown) => Response) => {
        const sent: unknown[] = [];
        const local = localPc(async (request, path) => {
          if (path !== "/api/account/list/add/confirm" || answer === undefined) return undefined;
          const { digits } = await request.json() as { digits?: unknown };
          sent.push(digits);
          return answer(digits);
        });
        const out: string[] = [];
        const code = await link(args, { origin: ORIGIN, headers: {}, fetch: local.fetch, signal: new AbortController().signal, accountService: SERVICE, lines: keyboard().lines, out: (text) => { out.push(text); } });
        return { code, text: out.join(""), sent, paths: local.calls.map((call) => `${call.method} ${call.path}`) };
      };

      it("confirms the number it carries, and nothing else is asked of this PC or the account service", async () => {
        const run = await confirming(["--confirm", "482 913"], () => state({ state: "confirmed" }));
        expect(run.code).toBe(0);
        expect(run.sent).toEqual(["482913"]);
        expect(run.paths).toEqual(["POST /api/account/list/add/confirm"]);
        expect(run.text).toBe("Confirmed: this PC and that device show 482 913. Press Add for this PC on that device now; the ovis add that showed the number finishes when it is added.\n");
      });

      it("says so when that is not the number this PC shows now, which this PC then shows no more", async () => {
        const run = await confirming(["--confirm=111111"], () => wrongNumber());
        expect(run.code).toBe(1);
        expect(run.text).toContain("111 111 is not the number this PC shows now, so nothing was confirmed, and that number is no longer shown");
      });

      it("says so when the add it would confirm has ended", async () => {
        const run = await confirming(["--confirm=482913"], () => Response.json({ state: "ended", run: RUN, account: "acct_1", why: "timeout" }));
        expect(run.code).toBe(1);
        expect(run.text).toBe("The add this PC was running has ended (timeout), so nothing was confirmed. Run ovis add again.\n");
      });

      it("takes six digits only, and says so where this PC shows no number", async () => {
        for (const given of ["yes", "48291", ""]) {
          const run = await confirming(["--confirm", given], () => state({ state: "confirmed" }));
          expect([run.code, run.sent]).toEqual([1, []]);
        }
        const none = await confirming(["--confirm", "482913"]);
        expect(none.code).toBe(1);
        expect(none.text).toBe("The Ovis on this PC shows no number to confirm. Run ovis add first.\n");
      });
    });

    describe("a PC the account's list removed", () => {
      const REMOVED = Response.json({ error: { code: "list_removed", message: "This PC was removed from this Ovis account." } }, { status: 409 });
      const QUESTION = "This PC was removed from this Ovis account. It can come back only as a new PC: its relay identity is reset, so every device that opens it through the Ovis relay is let in again. Add it again as a new PC? Type yes: ";
      const removedOnce = (inner: ReturnType<typeof adding>) => {
        let reset = false;
        return { reset: () => { reset = true; return Response.json({ phase: "connecting", blocked: null }); },
          list: (call: { action: "start" | "state" | "confirm" | "cancel"; body: Record<string, unknown>; count: number }) => call.action === "start" && !reset ? REMOVED.clone() : inner(call) };
      };

      it("is added again as a new PC in one step a person confirms: its relay identity is reset, it is listed again, and the number follows", async () => {
        const run = await pressing({ ...removedOnce(adding()), said: (text, type) => { if (text.endsWith(QUESTION) || text.endsWith(NUMBER)) type("yes"); } });
        expect(run.code).toBe(0);
        expect(run.resets()).toBe(1);
        // the reset names the identity and the account the question was about
        expect(run.resetBodies).toEqual([{ removed: { account: "acct_1", server_id: run.pc.server_id } }]);
        expect(run.text).toContain("This PC has a new relay identity, and is listed in your account again.\n");
        // reset before it is listed again, and only then is the add started anew
        const reset = run.paths.indexOf("POST /api/relay/reset-identity");
        expect(run.paths.indexOf("POST /api/relay/link", reset)).toBeGreaterThan(reset);
        expect(run.paths.lastIndexOf("POST /api/account/list/add")).toBeGreaterThan(reset);
      });

      it("resets nothing when this PC is no longer the one the question was about", async () => {
        const stale = { ...removedOnce(adding()), reset: () => Response.json({ error: { code: "identity_changed", message: "no longer that one" } }, { status: 409 }) };
        const run = await pressing({ ...stale, said: (text, type) => { if (text.endsWith(QUESTION)) type("yes"); } });
        expect(run.code).toBe(1);
        expect(run.text).toContain("This PC is no longer the one that question was about (it was reset already), so nothing was reset.");
      });

      it("is not added again without that yes, and its relay identity stays", async () => {
        const run = await pressing({ ...removedOnce(adding()), said: (text, type) => { if (text.endsWith(QUESTION)) type(""); } });
        expect(run.code).toBe(1);
        expect(run.resets()).toBe(0);
        expect(run.text).toContain("This PC was removed from this Ovis account, and was not added again.");
      });

      it("is never added again where nobody can type", async () => {
        const run = await pressing({ ...removedOnce(adding()), args: ["--account", "acct_1"], terminal: false, isTty: false });
        expect(run.code).toBe(1);
        expect(run.resets()).toBe(0);
        expect(run.text).toContain("It can come back only as a new PC, which a person at this PC confirms: run ovis add in a terminal on it.");
      });
    });
  });

  it("lists this PC with the system it runs, which the card on a device of the account shows while it asks", async () => {
    let fake: FakeAccountService | undefined;
    const seen: unknown[] = [];
    const run = await pressing({
      pressAfter: 1,
      prepare: (service) => { fake = service; },
      answer: (asks) => { if (asks === 1) seen.push(...fake!.pcs("acct_1").map((entry) => entry.asking?.os)); return undefined; },
    });
    expect(run.code).toBe(0);
    expect(seen).toEqual([accountOsOfPlatform(process.platform)]);
  });

  it("lists nothing, and asks this PC nothing, unless yes is typed at the account it names", async () => {
    for (const answer of ["y", "", "no", "yes please"]) {
      const run = await pressing({ confirm: answer });
      expect([answer, run.code]).toEqual([answer, 1]);
      expect(run.text.endsWith("This PC was not listed in that account. Run ovis add again and sign in with your own account.\n")).toBe(true);
      expect(run.listed()).toEqual([]);
      expect(run.pressed).toEqual([]);
      expect(run.paths).not.toContain("POST /api/account/relay-account");
      expect(run.signedOut).toBe(true);
    }
    // the account's own PCs are named in the question, and yes may be typed in any case, full-width too
    const named = await pressing({ confirm: "ＹＥＳ", pressAfter: 1, prepare: async (service) => {
      const other = generateKeyPair().publicKey;
      const put = await service.fetch(new Request(`${SERVICE}/v1/pcs/${deriveServerId(other)}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken("acct_1")}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "Desk", public_key: Buffer.from(other).toString("hex"), relay: RELAY }) }));
      expect(put.ok).toBe(true);
    } });
    expect(named.code).toBe(0);
    expect(named.text).toContain(`     Ovis app, or with ovis status on a PC you already use.\n     That account lists:\n       - Desk (added ${new Date(Date.parse("2026-11-06T12:00:00Z")).toISOString().slice(0, 10)})\n     Is this your account?`);
    // every line of the question fits 80 columns
    const question = named.text.slice(named.text.indexOf("     Ovis account acct_1"), named.text.indexOf("Type yes to add this PC to it: ") + 31);
    expect(question.split("\n").every((line) => line.length <= 80)).toBe(true);
  });

  it("refuses before the sign-in where it is not run in a terminal and no --account names the account, in one plain line", async () => {
    for (const [terminal, isTty] of [[false, false], [true, false], [false, true]] as const) {
      const run = await pressing({ terminal, isTty });
      expect([terminal, isTty, run.code]).toEqual([terminal, isTty, 1]);
      expect(run.text).toBe(NO_TERMINAL);
      expect(run.paths).toEqual(["GET /api/account/status", "POST /api/account/one-press"]);
      expect(run.service.requests.filter((line) => line.includes("/signin/") || line.includes("/v1/token"))).toEqual([]);
    }
  });

  it("with --account and no terminal, asks nothing when the account that signed in is that one, and adds the PC in plain lines", async () => {
    for (const args of [["--account", "acct_1"], ["--account=acct_1"]]) {
      const run = await pressing({ args, terminal: false, isTty: false, pressAfter: 1 });
      expect([args, run.code]).toEqual([args, 0]);
      expect(run.text).not.toContain("Is this your account?");
      expect(run.text).toContain("     Ovis account acct_1 (signed in with GitHub) is the one --account names.\n");
      expect(run.text.endsWith(`Added. Open old-desktop from My PCs.\n${FIRST_JOIN_HINT}${CLOSING}`)).toBe(true);
      expect(run.text).not.toContain("\x1b");
      // nothing can be typed here, so no join is watched for
      expect(run.paths).not.toContain("GET /api/relay/joins");
    }
  });

  it("with --account naming another account than the one that signed in, lists nothing and says so", async () => {
    const run = await pressing({ args: ["--account", "acct_someone_else"], terminal: false, isTty: false, pressAfter: 1 });
    expect(run.code).toBe(1);
    expect(run.text.endsWith("Signed in to Ovis account acct_1, not the one --account names (acct_someone), so this PC was not listed in it. Run ovis add again and sign in with that account.\n")).toBe(true);
    expect(run.listed()).toEqual([]);
    expect(run.pressed).toEqual([]);
    expect(run.signedOut).toBe(true);
    // a start shorter than ovis status shows names no account
    const short = await pressing({ args: ["--account", "acct"], terminal: false, isTty: false });
    expect(short.code).toBe(1);
    expect(short.listed()).toEqual([]);
  });

  it("under the fleet preview, takes the press only at a terminal, and asks there even with --account", async () => {
    const refused = await pressing({ settings: { OVIS_PREVIEW: "fleet" }, args: ["--account", "acct_1"], terminal: false, isTty: false });
    expect(refused.code).toBe(1);
    expect(refused.text).toBe("Adding this PC needs a terminal: there it asks whether the account that signed in is yours. Run ovis add in a terminal (over ssh, run ssh -t).\n");
    expect(refused.paths).toEqual(["GET /api/account/status", "POST /api/account/one-press"]);
    const asked = await pressing({ settings: { OVIS_PREVIEW: "fleet" }, args: ["--account", "acct_1"], pressAfter: 1 });
    expect(asked.code).toBe(0);
    expect(asked.text).toContain(ASKED);
    const declined = await pressing({ settings: { OVIS_PREVIEW: "fleet" }, args: ["--account", "acct_1"], confirm: "" });
    expect(declined.code).toBe(1);
    expect(declined.listed()).toEqual([]);
  });

  it("says this PC is in the account, and how to undo it, when Ctrl+C comes as the ask that bound it answers or while the relay is waited for", async () => {
    for (const when of ["take", "relay"] as const) {
      const run = await pressing({ pressAfter: 1, stopWhenBound: when, relay: () => "connecting" });
      expect([when, run.code]).toEqual([when, 0]);
      expect(run.text.endsWith("Stopped. This PC is in Ovis account acct_1 all the same: your devices can open old-desktop from My PCs once its relay is online. If that is not your account, run ovis logout now.\n")).toBe(true);
      expect(run.text).not.toContain("in no account");
      expect(run.listed().map((entry) => entry.listed_by_device)).toEqual([false]);
    }
  });

  it("as the ten minutes end, finds a bind whose answer was lost, and takes an Add the last ask found this PC in the account by", async () => {
    // the last ask bound this PC, but its answer did not come back
    const lost = await pressing({ pressAfter: 100, answer: (asks, state) => {
      if (asks !== 101) return undefined;
      state.account = "acct_1";
      return Response.json({ error: { code: "account_unavailable", message: "fetch failed" } }, { status: 503 });
    } });
    expect(lost.code).toBe(0);
    expect(lost.text).not.toContain("Nobody pressed Add");
    expect(lost.text.endsWith(FINISHED)).toBe(true);
    // an Add as the time ran out kept the listing; the ask after it found this PC in the account (another window took it).
    // An account service since its listings ask for ten minutes from their sign-in refuses an Add that late (listing_expired):
    // this is the one from before, which still admits it
    const joined = await pressing({ pressAfter: 101, prepare: (service) => { service.pcAddProofs = false; }, answer: (asks, state) => {
      if (asks !== 102) return undefined;
      state.account = "acct_1";
      return Response.json({ error: { code: "in_account", message: "This PC is already in an account" } }, { status: 409 });
    } });
    expect(joined.code).toBe(0);
    expect(joined.text.endsWith(FINISHED)).toBe(true);
  });

  it("stops after the ten minutes Add is offered for, takes this PC off the account's list, and says it is in no account", async () => {
    const run = await pressing();
    expect(run.code).toBe(1);
    expect(run.askedAt.at(-1)! - run.askedAt[0]!).toBe(600_000);
    expect(run.text).toContain("Nobody pressed Add for old-desktop within 10 minutes of its listing. This PC was taken off your account's list; it is in no account. Run ovis add to try again.\n");
    expect(run.listed()).toEqual([]);
    expect(run.signedOut).toBe(true);
  });

  it("takes the admission of an Add pressed as the ten minutes ran out, rather than calling it not added", async () => {
    // an account service from before its listings asked for ten minutes from their sign-in: one since refuses an Add that late
    const run = await pressing({ pressAfter: 101, prepare: (service) => { service.pcAddProofs = false; } });
    expect(run.code).toBe(0);
    expect(run.pressed).toHaveLength(102);
    expect(run.text).not.toContain("Nobody pressed Add");
    expect(run.text.endsWith(FINISHED)).toBe(true);
  });

  it("Ctrl+C while it waits takes this PC off the account's list, says it is in no account, and ends the sign-in", async () => {
    const run = await pressing({ stopAt: 2 });
    expect(run.code).toBe(1);
    expect(run.text.endsWith("Stopped. This PC was taken off your account's list; it is in no account. Run ovis add to try again.\n")).toBe(true);
    expect(run.listed()).toEqual([]);
    expect(run.signedOut).toBe(true);
  });

  it("Ctrl+C as the wait is set up, right after the listing, takes this PC off the account's list too", async () => {
    const run = await pressing({ stopWhenNamed: true });
    expect(run.code).toBe(1);
    // the window's close never left: the run was stopped before it
    expect(run.paths).not.toContain("POST /api/relay/link/close");
    expect(run.pressed).toEqual([]);
    expect(run.text.endsWith("Stopped. This PC was taken off your account's list; it is in no account. Run ovis add to try again.\n")).toBe(true);
    expect(run.listed()).toEqual([]);
    expect(run.signedOut).toBe(true);
  });

  it("Ctrl+C after a device pressed Add leaves the listing that device admitted, and says to run add again to finish", async () => {
    const run = await pressing({ pressAfter: 1, stopAt: 2 });
    expect(run.code).toBe(1);
    expect(run.text.endsWith("Stopped. This PC is in no account yet, but your account still lists it. A device may have pressed Add just now. Run ovis add again to finish adding it.\n")).toBe(true);
    expect(run.listed().map((entry) => entry.admitted_at !== null)).toEqual([true]);
  });

  /** an earlier run listed this PC with a sign-in of its own, `ago` before this run */
  const listedEarlier = (ago: number) => async (service: FakeAccountService, pc: ReturnType<typeof identity>, time: ReturnType<typeof clock>): Promise<void> => {
    const token = service.issueToken("acct_1", { device: true });
    const put = await service.fetch(new Request(`${SERVICE}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "old-desktop", public_key: Buffer.from(importPublicKey(pc.public_key)).toString("hex"), relay: RELAY }) }));
    expect(put.ok).toBe(true);
    time.pass(ago);
  };

  it("waits only for what is left of an earlier run's ten minutes, and says the listing it could not take off is still there", async () => {
    const run = await pressing({ prepare: listedEarlier(4 * 60_000) });
    expect(run.code).toBe(1);
    // the sign-in itself took a few seconds of them
    const [, minutes, seconds] = /Waiting… \(up to (\d+):(\d\d), Ctrl\+C to stop\)/.exec(run.text) ?? [];
    expect(Number(minutes)).toBe(5);
    expect(run.askedAt.at(-1)! - run.askedAt[0]!).toBe((5 * 60 + Number(seconds)) * 1000);
    expect(run.text).toContain("Nobody pressed Add for old-desktop within 10 minutes of its listing. This PC is in no account yet, but your account still lists it. On a device of your account, choose No or Remove from my account on its card, then run ovis add again.\n");
    expect(run.listed()).toHaveLength(1);
  });

  it("waits for nothing when an earlier run's listing is past its ten minutes, and says how to start over", async () => {
    const run = await pressing({ prepare: listedEarlier(11 * 60_000) });
    expect(run.code).toBe(1);
    expect(run.pressed).toEqual([]);
    expect(run.text).toContain("more than 10 minutes ago, so your devices no longer offer Add for it. On a device of your account, choose No or Remove from my account on its card, then run ovis add again.\n");
    expect(run.text).not.toContain("2/2");
  });

  it("says how to add a PC its account lists as its own already, with no Add waiting for it, rather than waiting for one", async () => {
    const run = await pressing({ prepare: async (service, pc, time) => {
      // listed by a sign-in of the app's own: the account's PC, which no card offers Add for
      const put = await service.fetch(new Request(`${SERVICE}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken("acct_1")}`, "content-type": "application/json" },
        body: JSON.stringify({ label: "old-desktop", public_key: Buffer.from(importPublicKey(pc.public_key)).toString("hex"), relay: RELAY }) }));
      expect(put.ok).toBe(true);
      time.pass(5 * 60_000);
    } });
    expect(run.code).toBe(1);
    expect(run.pressed).toEqual(["acct_1"]);
    expect(run.text).toContain("Your account lists this PC already, so your devices offer no Add for it, and no Add pressed in the last 10 minutes waits for it. Run ovis add --approve, then choose Add on this PC in Ovis on a device of your account and compare its number here.\n");
    expect(run.listed()).toHaveLength(1);
  });

  it("says so when a device of the account chose No for this PC", async () => {
    const run = await pressing({ noAfter: 2 });
    expect(run.code).toBe(1);
    expect(run.text).toContain("Nobody pressed Add for old-desktop within 10 minutes of its listing. Your account no longer lists this PC (a device chose No); it is in no account. Run ovis add to try again.\n");
  });

  it("says which other account this PC joined meanwhile, and takes it off the list of the one that signed in", async () => {
    const run = await pressing({ answer: (asks, state) => { if (asks === 2) state.account = "acct_other0000"; return undefined; } });
    expect(run.code).toBe(1);
    expect(run.text).toContain("This PC joined another Ovis account (acct_other00), not the one you signed in to (acct_1). It is not on the list of the account you signed in to. If that was not you, open Settings → Devices and PCs on this PC and choose Revoke all.\n");
    expect(run.listed()).toEqual([]);
  });

  it("waits longer between asks while the account service does not answer this PC, says so once, and still takes the admission", async () => {
    const run = await pressing({ pressAfter: 2, answer: (asks) => asks <= 2 ? Response.json({ error: { code: "account_unavailable", message: "fetch failed" } }, { status: 503 }) : undefined });
    expect(run.code).toBe(0);
    expect(run.text.split("The account service did not answer this PC just now. Still waiting…").length).toBe(2);
    expect(run.askedAt.map((at) => at - run.askedAt[0]!)).toEqual([0, 15_000, 30_000]);
  });

  it("says why when this PC refuses the admission, and takes it off the account's list", async () => {
    const run = await pressing({ answer: () => Response.json({ error: { code: "identity_changed", message: "This PC's relay identity was reset while it was being added. Add it again." } }, { status: 409 }) });
    expect(run.code).toBe(1);
    expect(run.text.endsWith("Could not add this PC: This PC's relay identity was reset while it was being added. Add it again. This PC was taken off your account's list; it is in no account. Run ovis add to try again.\n")).toBe(true);
    expect(run.listed()).toEqual([]);
  });

  it("says this PC is added even when its relay does not come online in time", async () => {
    const run = await pressing({ pressAfter: 1, relay: () => "connecting" });
    expect(run.code).toBe(0);
    expect(run.text).toContain(`Added: this PC is in your account (acct_1), but its Ovis relay did not come online within 30 seconds. Your devices can open old-desktop from My PCs once it does (ovis status says when).\n${FIRST_JOIN_HINT}${CLOSING}`);
    expect(run.paths).not.toContain("GET /api/relay/joins");
  });

  /**
   * A PC added in one press has no member yet, so the first device that opens it sends a first join: six digits only
   * this PC may let in (docs/account.md, "Who may admit a device"). With no screen, its terminal does.
   */
  describe("after Added, at a terminal: the first device that opens this PC", () => {
    const WATCH = ADDED_HERE;
    const ASKED_AT = "2026-11-06T12:00:30.000Z";
    const at = new Date(ASKED_AT).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const first = (id: string, label: string, digits: string): OwnJoin => ({ id, label, asked_at: ASKED_AT, digits });
    const asks = (label: string) => `${label} asks to open this PC (from Ovis account acct_1, asked at ${at}). Type the six digits ${label} shows (one wrong entry ends this request), or press Enter to finish without: `;
    const after = (text: string) => text.slice(text.indexOf(WATCH));

    it("says only that the approval was received where the account's signed list lets the device in", async () => {
      const run = await pressing({
        pressAfter: 2,
        joins: (reads) => reads < 3 ? [] : [{ ...first("f1", "Pixel", "482913"), list: true }],
        watch: (said, answer) => { if (said.endsWith(asks("Pixel"))) answer("482913"); },
      });
      expect(run.code).toBe(0);
      expect(after(run.text)).toContain(`${asks("Pixel")}The approval of Pixel was received. It opens this PC once it is in your account's list, which takes a moment; if it does not, have it ask again.\n`);
      expect(after(run.text)).not.toContain("is let in");
    });

    it("says that Ovis on this PC needs an update where it is behind its account's list, and promises nothing", async () => {
      const run = await pressing({
        pressAfter: 2,
        joins: (reads) => reads < 3 ? [] : [{ ...first("f1", "Pixel", "482913"), list: true, list_behind: true }],
        watch: (said, answer) => { if (said.endsWith(asks("Pixel"))) answer("482913"); },
      });
      expect(run.code).toBe(0);
      expect(after(run.text)).toContain(`${asks("Pixel")}Pixel was not let in: Ovis on this PC is older than what a device wrote into your account's list`);
      expect(after(run.text)).not.toContain("was received");
    });

    it("asks about the first join that comes by its device, shows none of its digits, and lets it in with the six typed here", async () => {
      const run = await pressing({
        pressAfter: 2,
        joins: (reads) => reads < 3 ? [] : [first("f1", "Pixel", "482913")],
        watch: (said, answer) => { if (said.endsWith(asks("Pixel"))) answer("482 913"); },
      });
      expect(run.code).toBe(0);
      expect(after(run.text)).toBe(`${WATCH}\n${asks("Pixel")}Pixel is let in; it opens this PC in a moment.\n${CLOSING}`);
      expect(run.typed).toEqual([{ id: "f1", digits: "482913" }]);
      // the sign-in ended before the watch: nothing in it needs the account service
      expect([run.signedOut, run.signedOutBeforeAdded]).toEqual([true, true]);
    });

    it("says so when the digits are wrong, which ends that join, and lets the device's next request in", async () => {
      const device = { wrong: false };
      const run = await pressing({
        pressAfter: 1,
        // the device asks again once its first request ended
        joins: () => [first(device.wrong ? "f2" : "f1", "Pixel", device.wrong ? "555666" : "482913")],
        join: (typed) => {
          if (typed.id !== "f1") return undefined;
          device.wrong = true;
          return Response.json({ error: { code: "wrong_digits", message: "Those are not the digits the new device shows; it was not let in." } }, { status: 409 });
        },
        watch: (said, answer) => { if (said.endsWith(asks("Pixel"))) answer(device.wrong ? "555666" : "111111"); },
      });
      expect(run.code).toBe(0);
      expect(run.typed).toEqual([{ id: "f1", digits: "111111" }, { id: "f2", digits: "555666" }]);
      expect(after(run.text)).toContain(`${asks("Pixel")}That is not the number Pixel shows, so it was not let in. Have Pixel ask again: its request shows here.\n${asks("Pixel")}Pixel is let in; it opens this PC in a moment.\n`);
    });

    it("finishes without letting a device in on Enter by itself, also with a first join waiting, and says how to let it in later", async () => {
      const run = await pressing({
        pressAfter: 1,
        joins: () => [first("f1", "Pixel", "482913")],
        watch: (said, answer) => { if (said.endsWith(asks("Pixel"))) answer(""); },
      });
      expect(run.code).toBe(0);
      expect(run.typed).toEqual([]);
      expect(run.text.endsWith(`${asks("Pixel")}Finished without letting a device in. ${FIRST_JOIN_HINT}${CLOSING}`)).toBe(true);
    });

    it("takes no line that came before the question could be read, nor one that answers neither way", async () => {
      let shown = 0;
      const run = await pressing({
        pressAfter: 1,
        joins: () => [first("f1", "Pixel", "482913")],
        watch: (said, answer) => {
          if (!said.endsWith(asks("Pixel"))) return;
          shown++;
          // the first comes as the question shows, a key pressed twice
          answer(shown === 2 ? "yes" : "482913", shown === 1 ? 0 : 2_000);
        },
      });
      expect(run.code).toBe(0);
      expect(run.typed).toEqual([{ id: "f1", digits: "482913" }]);
      expect(after(run.text)).toContain("That line answered nothing: it came before the question could be read. Answer again.\n");
      expect(after(run.text)).toContain("That line answered nothing: type all six digits Pixel shows, or press Enter by itself to finish without. Answer again.\n");
    });

    it("says so and ends when a row of the account's list it knew from the start signs in: the phone that pressed Add, with no join", async () => {
      // one press read the account's list before it answered, so the phone is a row already, never used here
      const row = { id: "00000000000000c3", label: "Pixel", role: "drive", created_at: ASKED_AT, last_seen_at: null, current: false, via_relay: true, through_account: true };
      const connection = { route: "relay", relay: RELAY, rtt_ms: null, since: "2026-11-06T12:01:00.000Z" };
      for (const used of [{ connection }, { last_seen_at: "2026-11-06T00:00:00.000Z" }]) {
        const run = await pressing({ pressAfter: 1, devices: (reads) => [reads < 3 ? row : { ...row, ...used }], watch: () => undefined });
        expect(run.code).toBe(0);
        expect(after(run.text)).toBe(`${WATCH}\nPixel can open this PC now: it got in through your account. ${FIRST_JOIN_HINT}${CLOSING}`);
      }
    });

    it("takes no session that ended, nor a member in use, as a device getting in", async () => {
      const row = { id: "00000000000000c3", label: "Pixel", role: "drive", created_at: ASKED_AT, last_seen_at: "2026-11-05T00:00:00.000Z", current: false, via_relay: true, through_account: true };
      const member = { id: "00000000000000d4", label: "Desk", role: "drive", created_at: ASKED_AT, last_seen_at: ASKED_AT, current: false, via_relay: true, account: "acct_1" };
      const run = await pressing({
        pressAfter: 1, watch: () => undefined,
        devices: (reads) => reads < 3
          ? [{ ...row, connection: { route: "relay", rtt_ms: 40, since: "2026-11-06T11:00:00.000Z" } }, member]
          : [row, { ...member, last_seen_at: "2026-11-06T12:05:00.000Z" }],
      });
      expect(run.code).toBe(0);
      expect(after(run.text)).toBe(`${WATCH}\nStopped watching after 10 minutes. ${FIRST_JOIN_HINT}${CLOSING}`);
    });

    it("says so and ends when a device got in through the account meanwhile", async () => {
      const run = await pressing({
        pressAfter: 1,
        devices: (reads) => reads < 3 ? [] : [{ id: "00000000000000c3", label: "Pixel", role: "drive", created_at: ASKED_AT, last_seen_at: null, current: false, via_relay: true, through_account: true }],
        watch: () => undefined,
      });
      expect(run.code).toBe(0);
      expect(after(run.text)).toBe(`${WATCH}\nPixel can open this PC now: it got in through your account. ${FIRST_JOIN_HINT}${CLOSING}`);
    });

    it("stops by itself after ten minutes, and on Ctrl+C; the PC stays added either way", async () => {
      const quiet = await pressing({ pressAfter: 1, watch: () => undefined });
      expect(quiet.code).toBe(0);
      expect(after(quiet.text)).toBe(`${WATCH}\nStopped watching after 10 minutes. ${FIRST_JOIN_HINT}${CLOSING}`);
      const stopped = await pressing({ pressAfter: 1, joins: () => [first("f1", "Pixel", "482913")], watch: (said, _answer, stop) => { if (said.endsWith(asks("Pixel"))) setTimeout(stop, 0); } });
      expect(stopped.code).toBe(0);
      expect(stopped.typed).toEqual([]);
      expect(stopped.text.endsWith(`${asks("Pixel")}\nStopped. ${FIRST_JOIN_HINT}${CLOSING}`)).toBe(true);
      expect(stopped.signedOut).toBe(true);
    });

    it("ends as before, with the way to let a device in later, at an Ovis that lists no joins to its terminal", async () => {
      const run = await pressing({ pressAfter: 1, joins: () => Response.json({ error: { code: "not_found" } }, { status: 404 }), watch: () => undefined });
      expect(run.code).toBe(0);
      expect(run.text.endsWith(`Added. Open old-desktop from My PCs.\n${FIRST_JOIN_HINT}${CLOSING}`)).toBe(true);
    });
  });

  it("--qr keeps the QR code a device of the account scans, and never asks this PC for the admission", async () => {
    const run = await scanning({ step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } } });
    expect(run.code).toBe(0);
    expectQrCode(run.text);
    expect(run.paths).not.toContain("POST /api/account/one-press");
    expect(run.text).not.toContain("cannot take an Add");
  });

  it("without --qr, shows the QR code at a PC that takes no one-press add, and says why", async () => {
    const run = await scanning({ plain: true, step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } } });
    expect(run.code).toBe(0);
    expectQrCode(run.text);
    expect(run.calls.filter((call) => call.path === "/api/account/one-press").map((call) => call.body)).toEqual(["{}"]);
    expect(run.text).toContain("The Ovis on this PC cannot take an Add pressed on your phone (its Step 2 is off, or it is older), so a device of your account adds it by scanning a QR code.\n");
    // one that does not count this terminal as the PC itself (a forwarded port) says that instead
    const notOwn = await scanning({ plain: true, refuse: (path) => path === "/api/account/one-press" ? Response.json({ error: { code: "owner_only", message: "Add this PC to your account on this PC itself." } }, { status: 403 }) : undefined,
      step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } } });
    expect(notOwn.code).toBe(0);
    expect(notOwn.text).toContain("The Ovis on this PC does not count this terminal as the PC itself, so it cannot take an Add pressed on your phone from here: a device of your account adds it by scanning a QR code.\n");
  });

  const PHONE = { id: "00000000000000a1", label: "Hako's iPhone", role: "drive", created_at: "2026-11-06T12:00:30.000Z", last_seen_at: null, current: false, via_relay: true };
  const OLD = { id: "00000000000000b2", label: "Old tablet", role: "drive", created_at: "2026-10-01T09:00:00.000Z", last_seen_at: null, current: false, via_relay: true };
  /** A row of GET /api/devices: `account` only on a member of the PC's account, `via_relay` only on one paired through the relay. */
  type Row = Omit<typeof PHONE, "via_relay"> & { via_relay?: true; account?: string; added_by?: string };
  // the phone once it linked itself: a member of the account, which the account's key vouches for
  const MEMBER: Row = { ...PHONE, via_relay: true, account: "acct_1" };
  const DIRECT: Row = { id: "00000000000000c3", label: "Tailnet laptop", role: "drive", created_at: "2026-11-06T12:00:40.000Z", last_seen_at: null, current: false };

  async function scanning(options: {
    args?: string[]; isTty?: boolean; terminal?: boolean; size?: () => { rows: number; columns: number };
    /** run without --qr: this PC then shows the QR code only when it takes no one-press add (here: no such route) */
    plain?: boolean;
    step?: (pc: { account: string | null; enrolling: boolean; devices: Row[] }, looks: number, elapsed: number, stop: AbortController) => void;
    said?: (text: string, type: (line: string) => void, answer: (line: string, waits?: number) => void, stop: AbortController, begin: (text: string) => void) => void;
    /** the terminal's input can be discarded (tcflush), as on Linux and macOS */
    discard?: boolean;
    cancel?: () => Response;
    revoke?: (pc: { account: string | null; enrolling: boolean; devices: Row[] }, id: string) => Response | undefined;
    refuse?: (path: string, codes: number) => Response | undefined;
    service?: (request: Request, pass: () => Promise<Response>, at: { pc: ReturnType<typeof identity>; stop: AbortController; now: () => number }) => Promise<Response>;
    settings?: Record<string, string | undefined>;
    confirm?: string | false;
    ends?: boolean;
    soon?: boolean;
    /**
     * This PC makes its codes for the account `x-ovis-expect-account` names (docs/account.md, "A code made for an
     * account"): its answers repeat that account, or `expect`'s, and name the code `p<n>` (the typed code's id
     * `typedId`'s); `read` answers the read of a code by its id, live by default. Unset: an Ovis from before that.
     */
    tied?: { expect?: { code?: string; offer?: string }; typedId?: string; read?: (id: string, looks: number) => Record<string, unknown> | undefined };
  } = {}) {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    const keys = keyboard();
    const stop = new AbortController();
    const state = { account: null as string | null, enrolling: false, devices: [OLD] as Row[] };
    let looks = 0;
    let began: number | null = null;
    let approved = false;
    const listedAtName: number[] = [];
    const offers: string[] = [];
    const renewedAt: number[] = [];
    const cancels: unknown[] = [];
    // the look each code was taken back at, and the ids its code was read by
    const cancelledAt: number[] = [];
    const reads: unknown[] = [];
    // when each code's ten minutes end, by its id
    const until = new Map<string, number>();
    const revoked: string[] = [];
    const named: unknown[] = [];
    const tied = options.tied;
    /** What a PC that makes its codes for an account adds to a code's answer. */
    const forAccount = (request: Request, expect: string | undefined, id: string) => tied === undefined ? {}
      : { expect_account: expect ?? request.headers.get("x-ovis-expect-account"), pairing: { id } };
    const local = localPc(async (request, path) => {
      const refusal = options.refuse?.(path, offers.length);
      if (refusal !== undefined) return refusal;
      if (path === "/api/account/status") {
        if (began !== null) options.step?.(state, looks++, time.now() - began, stop);
        // as real fetch does: a call aborted on its way fails
        stop.signal.throwIfAborted();
        return Response.json({ account: state.account, enrolling: state.enrolling, unlinked: [], removals: [], adds: [], blocked: [] });
      }
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/account/relay-account") { named.push((await request.json() as { account?: unknown }).account); return new Response(null, { status: 204 }); }
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/link/close") return Response.json({ ok: true });
      if (path === "/api/devices" && request.method === "GET") return Response.json({ devices: state.devices });
      if (path === "/api/relay/code") return Response.json({ code: `ABCD-EFGH-J${offers.length + 1}`, expires_at: new Date(time.now() + 600_000).toISOString(), server_id: pc.server_id, ...forAccount(request, tied?.expect?.code, tied?.typedId ?? `p${offers.length + 1}`) });
      if (path === "/api/relay/offer") {
        began ??= time.now();
        offers.push(String(100001 + offers.length));
        renewedAt.push(time.now() - began);
        // as the PC reads it: live until its ten minutes are over (no device waits under it here)
        until.set(`p${offers.length}`, time.now() + 600_000);
        return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: offers.at(-1)! }, options.settings?.["OVIS_RELAY_APP_URL"] ?? "https://app.ovis.sh"), expires_at: new Date(time.now() + 600_000).toISOString(), ...forAccount(request, tied?.expect?.offer, `p${offers.length}`) });
      }
      if (path === "/api/relay/offer/keep" && tied !== undefined) {
        const { id } = await request.json() as { id: string };
        reads.push(id);
        return Response.json(tied.read?.(id, looks) ?? (time.now() <= (until.get(id) ?? Infinity) ? { state: "live", id, expect_account: "acct_1", expires_at: new Date(until.get(id) ?? time.now()).toISOString() }
          : { state: "ended", id, expect_account: "acct_1", ended: { why: "expired", at: new Date(time.now()).toISOString() } }));
      }
      if (path === "/api/devices/pair/cancel") { cancels.push(await request.json()); cancelledAt.push(looks); return options.cancel?.() ?? Response.json({ ok: true, cancelled: true }); }
      if (path.startsWith("/api/devices/") && request.method === "DELETE") {
        // as the app's own revoke: from this app's origin, as a machine call
        expect(request.headers.get("x-herdr-machine")).toBe("1");
        expect(request.headers.get("origin")).toBe(ORIGIN);
        const id = path.slice("/api/devices/".length);
        const refusal = options.revoke?.(state, id);
        if (refusal !== undefined) return refusal;
        // as the PC's own revoke (server/devices.ts): never a member of the account `x-ovis-unless-account` names,
        // and a PC whose last member of an account went is in none
        const row = state.devices.find((device) => device.id === id);
        if (row === undefined) return Response.json({ error: { code: "not_found", message: "no such device" } }, { status: 404 });
        const unless = request.headers.get("x-ovis-unless-account");
        if (unless !== null && row.account === unless) return Response.json({ error: { code: "account_member", message: "that device is a member of the account by now" } }, { status: 409 });
        state.devices = state.devices.filter((device) => device !== row);
        if (row.account !== undefined && !state.devices.some((device) => device.account === row.account)) state.account = null;
        revoked.push(id);
        return new Response(null, { status: 204 });
      }
      return undefined;
    });
    const out: string[] = [];
    const code = await link([...options.plain === true ? [] : ["--qr"], ...options.args ?? []], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: stop.signal,
      accountService: SERVICE, lines: keys.lines,
      serviceFetch: (input, init) => {
        const request = new Request(input, init);
        return options.service ? options.service(request, () => service.fetch(request), { pc, stop, now: time.now }) : service.fetch(request);
      },
      terminal: options.terminal ?? true, isTty: options.isTty ?? true, ...options.size ? { size: options.size } : {},
      ...options.discard === true ? { discard: keys.discard } : {},
      ...linkSettings(options.settings ?? {}),
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown && !approved) { approved = true; service.approveDevice(shown[1]!, "acct_1"); }
        if (text.includes("Press Enter to show the QR code")) {
          listedAtName.push(service.pcs("acct_1").length);
          const early = options.soon === true && listedAtName.length === 1;
          if (!early) time.pass(2_000);
          if (options.confirm !== false) keys.type(early ? "" : options.confirm ?? "");
          if (options.ends === true) keys.end();
        }
        const later = (line: string, waits: number): void => time.after(() => { if (waits <= 1) keys.type(line); else later(line, waits - 1); });
        options.said?.(text, keys.type, (line, waits = 1) => later(line, waits), stop, keys.begin);
      },
    });
    const paths = local.calls.map((call) => `${call.method} ${call.path}`);
    return { code, out, text: out.join(""), offers, renewedAt, cancels, cancelledAt, reads, revoked, named, service, pc, time, paths, calls: local.calls, listedAtName, looks: () => looks, discards: keys.discards };
  }

  const ON = "\x1b[?1049h";
  const OFF = "\x1b[?1049l";

  it("ends in one QR code: a signed-in device that scans it adds this PC, and the command names the account and that device", async () => {
    const { code, out, text, offers, cancels, service, pc, paths } = await scanning({
      step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } },
    });
    expect(code).toBe(0);
    expect(service.pcs("acct_1").map((entry) => entry.server_id)).toEqual([pc.server_id]);
    const order = ["POST /api/relay/link", "POST /api/relay/link/close", "GET /api/devices", "POST /api/relay/code", "POST /api/relay/offer"].map((call) => paths.indexOf(call));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeGreaterThan(-1);
    expect(paths.lastIndexOf("GET /api/relay")).toBeLessThan(order[3]!);
    expect(text).toContain("Scan this QR code with a device that is signed in to this Ovis account. It adds this PC to the account; there is no number to type.");
    expect(text).toContain("Code to type: ABCD-EFGH-J1   (works once, expires in 10:00)");
    expect(text).toContain(pc.server_id.match(/.{4}/g)!.join(" "));
    expect(text).toContain("Anyone who can read this screen can pair with this PC while the code is shown.");
    const drawn = out.find((line) => line.includes("Scan this QR code"))!;
    expectQrCode(drawn);
    expect(drawn.startsWith(`${ON}\x1b[2J\x1b[H`)).toBe(true);
    expect(out.slice(out.indexOf(drawn) + 1)).toEqual([OFF, "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n" + CLOSING]);
    expect(offers).toEqual(["100001"]);
    expect(cancels).toEqual([{ code: "100001" }]);
    expect(paths).not.toContain("GET /api/relay/pairings");
    expect(service.pcs("acct_1").length).toBe(1);
  });

  it("leaves alone the account's own devices the PC lets in as it joins: they came by the account's list, not by the code", async () => {
    // GET /api/devices names a device the account's list let in `through_account`, with no `account` of its own
    const JOINED: Row & { through_account: true } = { id: "00000000000000d4", label: "Pixel", role: "drive", created_at: "2026-11-06T12:00:50.000Z", last_seen_at: null, current: false, via_relay: true, through_account: true };
    const { code, out, revoked, paths } = await scanning({
      step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER, JOINED]; } },
    });
    expect(code).toBe(0);
    expect(revoked).toEqual([]);
    expect(paths.some((path) => path.startsWith("DELETE /api/devices/"))).toBe(false);
    expect(out.at(-1)).toBe("This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n" + CLOSING);
  });

  it("draws no QR code where there is no terminal, and asks for no sign-in first; --print writes it as plain lines", async () => {
    const refused = await scanning({ isTty: false });
    expect(refused.code).toBe(1);
    expect(refused.text).toBe("The QR code is a key to this PC. Run this in a terminal, or pass --print to write it anyway.\n");
    expect(refused.paths).toEqual(["GET /api/account/status"]);
    const printed = await scanning({ isTty: false, args: ["--print"], step: (state, looks) => { if (looks === 1) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } } });
    expect(printed.code).toBe(0);
    expectQrCode(printed.text);
    expect(printed.text).not.toContain("\x1b");
    expect(printed.cancels).toEqual([{ code: "100001" }]);
    const onTty = await scanning({ args: ["--print"], step: (state, looks) => { if (looks === 1) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } } });
    expect(onTty.text).not.toContain("\x1b");
  });

  const NEEDS_TERMINAL = "Adding this PC needs a terminal: the QR code and the code to type are a key to this PC, so they are never written to a pipe, a file or a log. Run ovis add in a terminal (over ssh, run ssh -t).\n";
  const NAMED = "Signed in as Ovis account acct_1 (signed in with GitHub). Press Enter to show the QR code for this account's phone, or press Ctrl+C if that is not your account: ";
  const NOT_SHOWN = "The QR code was not shown, and this PC was not listed in that account. Run ovis add again and sign in with your own account.\n";
  const joins = (state: { account: string | null; devices: Row[] }, looks: number): void => { if (looks === 1) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } };
  const FLEET = { OVIS_PREVIEW: "fleet" };

  it("under the fleet preview, writes no QR code where its output or its input is not a terminal, --print or not, and asks for no sign-in first", async () => {
    for (const [args, isTty, terminal] of [[[], false, true], [["--print"], false, true], [[], true, false], [["--print"], true, false], [["--print"], false, false]] as const) {
      const refused = await scanning({ settings: FLEET, args: [...args], isTty, terminal, discard: true, step: joins });
      expect([args, isTty, terminal, refused.code]).toEqual([args, isTty, terminal, 1]);
      expect(refused.text).toBe(NEEDS_TERMINAL);
      expect(refused.paths).toEqual(["GET /api/account/status"]);
      expect(refused.offers).toEqual([]);
      expect(refused.service.pcs("acct_1")).toEqual([]);
    }
    const listed = await scanning({ settings: { OVIS_PREVIEW: "other, fleet" }, args: ["--print"], isTty: false, discard: true, step: joins });
    expect([listed.code, listed.text]).toEqual([1, NEEDS_TERMINAL]);
  });

  it("under the fleet preview, names the account that signed in, and lists this PC and shows its QR code only after Enter typed at that name", async () => {
    const shown = await scanning({ settings: FLEET, discard: true, step: joins });
    expect(shown.code).toBe(0);
    const at = shown.out.indexOf(NAMED);
    expect(at).toBeGreaterThan(-1);
    expect(shown.listedAtName).toEqual([0]);
    expect(shown.out.slice(0, at).some((text) => text.includes("Scan this QR code"))).toBe(false);
    expect(shown.out.slice(at + 1)).toContain(`     This PC is listed in that account as ${shown.service.pcs("acct_1")[0]?.label}.\n`);
    expectQrCode(shown.out.find((text) => text.includes("Scan this QR code"))!);
    expect(shown.offers).toEqual(["100001"]);
    expect(shown.service.pcs("acct_1").map((entry) => entry.server_id)).toEqual([shown.pc.server_id]);
    const printed = await scanning({ settings: FLEET, args: ["--print"], discard: true, step: joins });
    expect(printed.code).toBe(0);
    expect(printed.out).toContain(NAMED);
    expectQrCode(printed.text);
    expect(printed.text).not.toContain("\x1b");
    for (const line of ["no", "y", " x "]) {
      const declined = await scanning({ settings: FLEET, discard: true, confirm: line, step: joins });
      expect([line, declined.code]).toEqual([line, 1]);
      expect(declined.out.at(-1)).toBe(NOT_SHOWN);
      expect(declined.offers).toEqual([]);
      expect(declined.paths.filter((path) => path.includes("/api/relay/"))).toEqual([]);
      expect(declined.service.pcs("acct_1")).toEqual([]);
    }
    const ended = await scanning({ settings: FLEET, discard: true, confirm: false, ends: true, step: joins });
    expect(ended.code).toBe(1);
    expect(ended.out.slice(-2)).toEqual(["\n", NOT_SHOWN]);
    expect(ended.offers).toEqual([]);
    expect(ended.service.pcs("acct_1")).toEqual([]);
  });

  it("under the fleet preview, takes no first line as that Enter where the terminal's input cannot be emptied, nor one typed before the name could be read", async () => {
    const again = (why: string): string => `That line answered nothing: ${why} Answer again.\n${NAMED}`;
    // no discard (Windows, no C library): the first line may have been begun before the name showed
    const held = await scanning({ settings: FLEET, step: joins });
    expect(held.out.filter((text) => text.includes("answered nothing"))).toEqual([again("this terminal's input could not be emptied as the question showed, so it may have been typed before it.")]);
    expect([held.code, held.offers]).toEqual([0, ["100001"]]);
    const soon = await scanning({ settings: FLEET, discard: true, soon: true, step: joins });
    expect(soon.out.filter((text) => text.includes("answered nothing"))).toEqual([again("it came before the question could be read.")]);
    expect([soon.code, soon.offers]).toEqual([0, ["100001"]]);
  });

  const APP = "https://app.example.test:17541";
  const WRAPPER_NAMES = { OVIS_RELAY_APP_URL: APP, OVIS_CLI_NAME: "/opt/wrapper/bin/ovis-wrapper" };
  const approving = (settings: Record<string, string | undefined>) => scanning({ args: ["--approve"], settings, said: (text, _type, _answer, stop) => { if (text.includes("choose Add on")) stop.abort(); } });

  it("with the fleet preview off, writes the QR code with --print where its output is not a terminal, asks for no Enter, and names app.ovis.sh and ovis whatever OVIS_RELAY_APP_URL and OVIS_CLI_NAME say, as before it", async () => {
    for (const names of [{}, WRAPPER_NAMES]) {
      for (const value of [undefined, "", "fleets", "no-fleet"]) {
        const printed = await scanning({ settings: { ...names, OVIS_PREVIEW: value }, isTty: false, args: ["--print"], discard: true, confirm: "no", step: joins });
        expect([value, printed.code]).toEqual([value, 0]);
        expectQrCode(printed.text);
        expect(printed.text).not.toContain("\x1b");
        expect(printed.text).not.toContain("Press Enter");
        expect(printed.text).toContain("Or, on that device, open app.ovis.sh, choose Pair with a code and type it.\n");
        expect(printed.out).toContain(`     Signed in. This PC is listed in your account as ${printed.service.pcs("acct_1")[0]?.label}.\n`);
        expect(printed.offers).toEqual(["100001"]);
      }
      const piped = await scanning({ settings: names, isTty: false, terminal: false, args: ["--print"], step: joins });
      expect(piped.code).toBe(0);
      expectQrCode(piped.text);
      const plain = await scanning({ settings: names, discard: true, confirm: "no", step: joins });
      expect(plain.code).toBe(0);
      expect(plain.text).not.toContain("Press Enter");
      expect(plain.listedAtName).toEqual([]);
      expect(plain.out.some((text) => text.startsWith(`${ON}\x1b[2J\x1b[H`) && text.includes("Scan this QR code"))).toBe(true);
      const refused = await scanning({ settings: names, isTty: false, step: joins });
      expect([refused.code, refused.text]).toEqual([1, "The QR code is a key to this PC. Run this in a terminal, or pass --print to write it anyway.\n"]);
      const late = await scanning({ settings: names });
      expect(late.out.slice(-2)).toEqual(["The code and the QR code no longer work.\n", "Stopped after 30 minutes. Run ovis add again.\n"]);
      const approve = await approving(names);
      expect(approve.text).toContain("(the Ovis app or app.ovis.sh), choose Add on");
      expect(approve.text).toContain("If it shows Join there instead, choose Join, then Ask to join or Type the number.");
    }
  });

  it("under the fleet preview, names the app the server pairs with and the command OVIS_CLI_NAME gives, not app.ovis.sh and a bare ovis", async () => {
    const settings = { ...WRAPPER_NAMES, ...FLEET };
    const { text } = await scanning({ settings });
    expect(/open (\S+), choose Pair with a code/.exec(text)?.[1]).toBe("app.example.test:17541");
    expect(text).toContain("/opt/wrapper/bin/ovis-wrapper add again");
    expect(text).not.toMatch(/(^|[\s(`])ovis (add|link|pair|status|login)\b/m);
    expect(text).not.toContain("app.ovis.sh");
    const refused = await scanning({ settings, isTty: false });
    expect(refused.text).toContain("Run /opt/wrapper/bin/ovis-wrapper add in a terminal");
    const approve = await approving(settings);
    expect(approve.text).toContain("(the Ovis app or app.example.test:17541), choose Add on");
  });

  it("takes the fleet preview from the plugin's settings as the plugin merges them: its settings file after its environment", async () => {
    for (const environment of [{}, { OVIS_PREVIEW: "other" }]) {
      const named = await scanning({ settings: mergeEnvLayers([environment, FLEET]), discard: true, confirm: "no", step: joins });
      expect(named.out).toContain(NAMED);
      expect([named.code, named.out.at(-1), named.offers]).toEqual([1, NOT_SHOWN, []]);
      const refused = await scanning({ settings: mergeEnvLayers([environment, FLEET]), args: ["--print"], isTty: false, step: joins });
      expect([refused.code, refused.text]).toEqual([1, NEEDS_TERMINAL]);
    }
    const off = await scanning({ settings: mergeEnvLayers([FLEET, { OVIS_PREVIEW: "" }]), discard: true, confirm: "no", step: joins });
    expect([off.code, off.listedAtName, off.offers]).toEqual([0, [], ["100001"]]);
  });

  it("shows three codes at most, one as the last runs out, then stops after 30 minutes with the last taken back", async () => {
    const { code, out, text, offers, cancels, time } = await scanning();
    expect(code).toBe(1);
    expect(offers).toEqual(["100001", "100002", "100003"]);
    expect(text).toContain("ABCD-EFGH-J3");
    expect(out.filter((line) => line.includes(ON)).length).toBe(1);
    expect(out.filter((line) => line.startsWith("\x1b[2J\x1b[H")).length).toBe(2);
    expect(out.slice(-3)).toEqual([OFF, "The code and the QR code no longer work.\n", "Stopped after 30 minutes. Run ovis add again.\n"]);
    expect(cancels).toEqual([{ code: "100003" }]);
    expect(time.waits.filter((ms) => ms === 2_000).length).toBe(900);
  });

  it("Ctrl+C takes the QR code off the screen and back, and removes a device that got in just before", async () => {
    const quiet = await scanning({ step: (_state, looks, _elapsed, stop) => { if (looks === 2) stop.abort(); } });
    expect(quiet.code).toBe(1);
    expect(quiet.out.slice(-3)).toEqual([OFF, "The code and the QR code no longer work.\n", "Stopped. Run ovis add again to add this PC.\n"]);
    expect(quiet.cancels).toEqual([{ code: "100001" }]);
    const late = await scanning({ step: (state, looks, _elapsed, stop) => { if (looks === 2) { state.devices = [OLD, PHONE]; stop.abort(); } } });
    expect(late.out.at(-1)).toBe("Stopped. Run ovis add again to add this PC. Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.\n");
    expect(late.revoked).toEqual([PHONE.id]);
    // the code went first: a device that pairs as it is removed would get in again with it
    expect(late.paths.lastIndexOf("POST /api/devices/pair/cancel")).toBeLessThan(late.paths.indexOf(`DELETE /api/devices/${PHONE.id}`));
    const stuck = await scanning({
      step: (state, looks, _elapsed, stop) => { if (looks === 2) { state.devices = [OLD, PHONE]; stop.abort(); } },
      revoke: () => Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 }),
    });
    expect(stuck.out.at(-1)).toBe("Stopped. Run ovis add again to add this PC. Hako's iPhone could not be removed (/api/devices/00000000000000a1: this device can only watch): revoke it in Settings → Devices and PCs on this PC.\n");
  });

  it("takes the code back when the run fails, and says when that was not confirmed", async () => {
    const { code, out, cancels } = await scanning({
      refuse: (path, codes) => path === "/api/account/status" && codes > 0 ? Response.json({ error: { code: "internal_error", message: "internal error (y)" } }, { status: 500 }) : undefined,
      cancel: () => Response.json({ error: { code: "internal_error", message: "internal error (x)" } }, { status: 500 }),
    });
    expect(code).toBe(1);
    expect(cancels).toEqual([{ code: "100001" }]);
    expect(out.slice(-3, -1)).toEqual([OFF, "Taking the code back was not confirmed (/api/devices/pair/cancel: internal error (x)): it may work until it runs out.\n"]);
    expect(out.at(-1)).toContain("Could not link this PC");
  });

  it("says how to make room when the account service refuses the listing with 409 directory_full, and keeps every other refusal's text", async () => {
    const refusing = (code: string) => scanning({ service: async (request, pass) => {
      if (new URL(request.url).pathname.startsWith("/v1/pcs/") && request.method === "PUT") return Response.json({ error: { code, message: "no room" } }, { status: 409 });
      return pass();
    } });
    const full = await refusing("directory_full");
    expect(full.code).toBe(1);
    expect(full.out.at(-1)).toStartWith("Could not link this PC: ");
    expect(full.out.at(-1)).toContain("ovis add again");
    expect(full.text).not.toContain("directory_full");
    const other = await refusing("conflict");
    expect(other.code).toBe(1);
    expect(other.out.at(-1)).toBe("Could not link this PC: The account service answered 409 (conflict)\n");
  });

  it("is done only once the account's other devices are in, and shows no code again after a device paired", async () => {
    const { code, out, offers, cancels } = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 4) { state.account = "acct_1"; state.enrolling = true; state.devices = [OLD, MEMBER]; }
        if (looks === 400) state.enrolling = false;
      },
    });
    expect(code).toBe(0);
    expect(offers).toEqual(["100001"]);
    expect(cancels).toEqual([{ code: "100001" }]);
    expect(out.slice(-4)).toEqual([
      OFF,
      "Hako's iPhone paired with this PC. Waiting for it to add this PC to your account…\n",
      "Added by Hako's iPhone. Bringing in your account's other devices…\n",
      "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n" + CLOSING,
    ]);
  });

  const OUT = "This PC is in no account again. Run ovis add again, and scan the code with a device signed in to the account you signed in to here.\n";

  it("removes whoever came since the code was shown when the PC ended in another account, without a question, and names both accounts and the device", async () => {
    // a stranger who holds the code and is signed in to an account of their own: their device links itself as this
    // PC's first member, so the PC joins their account
    const { code, out, text, service, pc, cancels, revoked, named } = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, label: "\x1b[2JMallory", account: "acct_2" }]; } },
    });
    expect(code).toBe(1);
    expect(revoked).toEqual([PHONE.id]);
    expect(out.at(-1)).toBe(`This PC joined another Ovis account (acct_2), added by [2JMallory, not the one you signed in to (acct_1). [2JMallory paired with this PC since the code was shown and was removed. ${OUT}`);
    expect(text).not.toContain("Keep");
    expect(cancels).toEqual([{ code: "100001" }]);
    // its relay pass is never asked under the other account, and it stays listed in the one that signed in
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((account) => account !== "acct_1")).toEqual([]);
    expect(service.pcs("acct_1").map((entry) => entry.server_id)).toEqual([pc.server_id]);
  });

  it("removes a device that was asked about and then signed in to an account of its own, with its question unanswered", async () => {
    const { code, out, revoked, named } = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 14) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; }
      },
    });
    expect(code).toBe(1);
    expect(revoked).toEqual([PHONE.id]);
    expect(out.slice(-2)).toEqual([
      "Hako's iPhone paired with this PC but has not added this PC to an account yet, so this PC is in no account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      `\nThis PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone paired with this PC since the code was shown and was removed. ${OUT}`,
    ]);
    expect(named.filter((account) => account !== "acct_1")).toEqual([]);
  });

  it("removes the other account's devices that its member brings in meanwhile, looking again until none is left", async () => {
    const TABLET: Row = { id: "00000000000000e5", label: "Mallory's tablet", role: "drive", created_at: "2026-11-06T12:00:45.000Z", last_seen_at: null, current: false, via_relay: true, account: "acct_2", added_by: PHONE.id };
    const LAPTOP: Row = { ...TABLET, id: "00000000000000f6", label: "Mallory's laptop", created_at: "2026-11-06T12:00:50.000Z" };
    const { code, out, revoked } = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }, TABLET]; } },
      revoke: (state, id) => { if (id === PHONE.id) state.devices = [...state.devices, LAPTOP]; return undefined; },
    });
    expect(code).toBe(1);
    expect(revoked).toEqual([PHONE.id, TABLET.id, LAPTOP.id]);
    expect(out.at(-1)).toBe(`This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone, Mallory's tablet, Mallory's laptop paired with this PC since the code was shown and were removed. ${OUT}`);
  });

  it("says so when the PC stays in the other account: by a device paired before this run, or one that could not be removed", async () => {
    const before = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [{ ...OLD, account: "acct_2" }, { ...PHONE, account: "acct_2", added_by: OLD.id }]; } },
    });
    expect(before.code).toBe(1);
    expect(before.revoked).toEqual([PHONE.id]);
    expect(before.out.at(-1)).toBe("This PC joined another Ovis account (acct_2), added by Old tablet, not the one you signed in to (acct_1). Hako's iPhone paired with this PC since the code was shown and was removed. This PC is still in that account, by Old tablet, paired before this run. It was taken off the list of the account you signed in to. If that account is not yours, open Settings → Devices and PCs on this PC and choose Revoke all.\n");
    expect(before.service.pcs("acct_1")).toEqual([]);
    expect(before.named.filter((account) => account !== "acct_1")).toEqual([]);
    const stuck = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; } },
      revoke: () => Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 }),
    });
    expect(stuck.code).toBe(1);
    expect(stuck.out.at(-1)).toBe("This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone could not be removed (/api/devices/00000000000000a1: this device can only watch): revoke it in Settings → Devices and PCs on this PC. This PC is still in that account. It was taken off the list of the account you signed in to. If that account is not yours, open Settings → Devices and PCs on this PC and choose Revoke all.\n");
    let gone = false;
    const unread = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; } },
      revoke: () => { gone = true; return undefined; },
      refuse: (path) => gone && path === "/api/account/status" ? Response.json({ error: { code: "internal_error", message: "internal error (y)" } }, { status: 500 }) : undefined,
    });
    expect(unread.code).toBe(1);
    expect(unread.revoked).toEqual([PHONE.id]);
    expect(unread.out.at(-1)).toBe("This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone paired with this PC since the code was shown and was removed. What is paired with this PC now could not be read (/api/account/status: internal error (y)): devices of that account may still be paired. Open Settings → Devices and PCs on this PC and choose Revoke all if that account is not yours.\n");
    let cut = false;
    let again = 0;
    const blind = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; } },
      revoke: () => { cut = true; return undefined; },
      refuse: (path) => { if (cut && path === "/api/devices") { again++; throw new TypeError("connection refused"); } return undefined; },
    });
    expect(blind.code).toBe(1);
    expect(blind.revoked).toEqual([PHONE.id]);
    expect(again).toBe(3);
    expect(blind.out.at(-1)).toBe("This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone paired with this PC since the code was shown and was removed. What is paired with this PC now could not be read (/api/devices: the Ovis on this PC did not answer (connection refused)): devices of that account may still be paired. Open Settings → Devices and PCs on this PC and choose Revoke all if that account is not yours.\n");
    expect(unread.service.pcs("acct_1").length).toBe(1);
  });

  it("says that a device may still be paired when more keep pairing than it looks again for, also once the PC is out of the other account", async () => {
    // the other account's phone goes at once, and with it the PC is in no account again; but a device pairs for
    // each one removed (with a code that was passed on, say), and the last of them is still paired
    let came = 0;
    const { code, out, revoked, named } = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; } },
      revoke: (state) => { came++; state.devices = [...state.devices, { ...DIRECT, id: `00000000000000d${came}`, label: `Stray ${came}` }]; return undefined; },
    });
    expect(code).toBe(1);
    expect(revoked).toEqual([PHONE.id, "00000000000000d1", "00000000000000d2", "00000000000000d3"]);
    expect(out.at(-1)).toBe("This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone, Stray 1, Stray 2, Stray 3 paired with this PC since the code was shown and were removed. This PC is in no account again, but more devices paired with it while these were removed, and one may still be paired. Open Settings → Devices and PCs on this PC and revoke any device there that is not yours, then run ovis add again.\n");
    expect(named.filter((account) => account !== "acct_1")).toEqual([]);
  });

  it("goes on when a device of the account that signed in links itself as the other account's devices go", async () => {
    const owner: Row = { ...OLD, account: "acct_1" };
    const { code, out, revoked } = await scanning({
      step: (state, looks) => {
        if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; }
        if (looks === 3) { state.account = "acct_1"; state.devices = [owner]; }
      },
    });
    expect(revoked).toEqual([PHONE.id]);
    expect(out.slice(-2)).toEqual([
      "This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone paired with this PC since the code was shown and was removed.\n",
      "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n" + CLOSING,
    ]);
    expect(code).toBe(0);
  });

  it("asks about a device that paired but is not signed in, and removes it on N", async () => {
    const { code, out, offers, revoked, time } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("n"); },
    });
    expect(code).toBe(1);
    expect(out.slice(-5)).toEqual([
      OFF,
      "Hako's iPhone paired with this PC. Waiting for it to add this PC to your account…\n",
      "Hako's iPhone paired with this PC but has not added this PC to an account yet, so this PC is in no account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      "Removed.\n",
      "Sign in on that device, then run ovis add again.\n",
    ]);
    expect(revoked).toEqual([PHONE.id]);
    expect(offers).toEqual(["100001"]);
    // asked 15 seconds after the device showed, not at once: one that is signed in adds the PC within those
    const asked = time.waits.length;
    expect(asked).toBeGreaterThanOrEqual(3 + 8);
    expect(asked).toBeLessThan(3 + 12);
  });

  it("keeps that device on the word keep, and still fails: the PC is in no account", async () => {
    const { code, out, revoked, offers } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("keep"); },
    });
    expect(code).toBe(1);
    expect(out.slice(-2)).toEqual(["Kept.\n", "Sign in on that device, then run ovis add again.\n"]);
    expect(revoked).toEqual([]);
    expect(offers).toEqual(["100001"]);
  });

  it("removes the device on a y begun before the first question showed, however late its Enter comes: only the word keep keeps it", async () => {
    // the terminal gives no sign of a line begun and not sent: its Enter comes well past the dwell, as if for this question
    for (const typed of ["y", "Y", "yes", "kee", "keep it", "k"]) {
      const { code, out, revoked } = await scanning({
        step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
        said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer(typed, 2); },
      });
      expect(code).toBe(1);
      expect(out).not.toContain("Kept.\n");
      expect(revoked).toEqual([PHONE.id]);
      expect(out.includes("Only the word keep keeps it, not y.\n")).toBe(/^y(es)?$/i.test(typed));
    }
    for (const typed of ["keep", " KEEP "]) {
      const { out, revoked } = await scanning({
        step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
        said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer(typed); },
      });
      expect(out).toContain("Kept.\n");
      expect(revoked).toEqual([]);
    }
  });

  it("discards what the terminal holds as the question shows: the word keep begun before it keeps nothing, and is typed under it to keep", async () => {
    const ahead = await scanning({
      discard: true,
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer, _stop, begin) => {
        if (text.includes("Signed in.")) begin("keep");
        if (text.includes("Keep that device?")) answer("", 2);
      },
    });
    expect(ahead.out).not.toContain("Kept.\n");
    expect(ahead.revoked).toEqual([PHONE.id]);
    expect(ahead.discards()).toBe(1);
    const under = await scanning({
      discard: true,
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("keep", 2); },
    });
    expect(under.out).toContain("Kept.\n");
    expect(under.revoked).toEqual([]);
  });

  it("reads the word keep typed full-width, as an input method left in its wide mode types it, and still nothing else", async () => {
    const wide = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("ｋｅｅｐ\u3000"); },
    });
    expect(wide.out).toContain("Kept.\n");
    expect(wide.revoked).toEqual([]);
    const yes = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("ｙ"); },
    });
    expect(yes.out).toContain("Only the word keep keeps it, not y.\n");
    expect(yes.revoked).toEqual([PHONE.id]);
  });

  it("takes no line typed before the question could be read as its answer", async () => {
    let asked = false;
    const { out, revoked } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, type, answer) => {
        if (text.includes("Signed in.")) type("y");
        if (text.includes("Keep that device?") && !asked) { asked = true; type("y"); }
        if (text.includes("answered nothing")) answer("n");
      },
    });
    expect(out.filter((line) => line.includes("answered nothing"))).toEqual(["That line answered nothing: it came before the question could be read. Answer again.\n"]);
    expect(out.slice(-2)).toEqual(["Removed.\n", "Sign in on that device, then run ovis add again.\n"]);
    expect(revoked).toEqual([PHONE.id]);
  });

  it("takes no line begun at a question that changed as the answer to the next one, however late its Enter comes", async () => {
    const owner: Row = { ...OLD, account: "acct_1" };
    const HELD = "That line answered nothing: the question changed while it may have been typed. Answer again for the question shown now.\n";
    const NEXT = "Hako's iPhone paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ";
    for (const looksLater of [1, 2]) {
      let shows = 0;
      const { code, out, revoked } = await scanning({
        step: (state, looks) => {
          if (looks === 2) state.devices = [OLD, PHONE];
          if (looks === 14) { state.account = "acct_1"; state.devices = [owner, PHONE]; }
        },
        said: (text, _type, answer) => {
          if (text !== NEXT) return;
          if (++shows === 1) answer("keep", looksLater);
          else answer("");
        },
      });
      expect(out.slice(-6)).toEqual(["\n", NEXT, HELD, NEXT, "Removed.\n", "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n" + CLOSING]);
      expect(out).not.toContain("Kept.\n");
      expect(revoked).toEqual([PHONE.id]);
      expect(code).toBe(0);
    }
    let shows = 0;
    const kept = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 14) { state.account = "acct_1"; state.devices = [owner, PHONE]; }
      },
      said: (text, _type, answer) => { if (text === NEXT) answer(++shows === 1 ? "" : "keep"); },
    });
    expect(kept.out.slice(-4)).toEqual([HELD, NEXT, "Kept.\n", "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n" + CLOSING]);
    expect(kept.revoked).toEqual([]);
  });

  it("takes no line begun at a question that was dropped as the answer to one about another device", async () => {
    let shows = 0;
    const { code, out, revoked } = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 14) { state.account = "acct_1"; state.enrolling = true; state.devices = [OLD, MEMBER]; }
        if (looks === 16) state.devices = [OLD, MEMBER, DIRECT];
        if (looks === 30) state.enrolling = false;
      },
      said: (text, _type, answer) => { if (text.includes("Tailnet laptop paired with this PC while the code was shown")) answer(++shows === 1 ? "keep" : ""); },
    });
    expect(out.filter((line) => line.includes("answered nothing"))).toEqual(["That line answered nothing: the question changed while it may have been typed. Answer again for the question shown now.\n"]);
    expect(out).not.toContain("Kept.\n");
    expect(revoked).toEqual([DIRECT.id]);
    expect(code).toBe(0);
  });

  it("says of a line handed over as its question went that it answered nothing, and still drops the next one", async () => {
    const owner: Row = { ...OLD, account: "acct_1" };
    const NEXT = "Hako's iPhone paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ";
    let typeNow: (line: string) => void = () => undefined;
    let shows = 0;
    const { out, revoked } = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 14) { typeNow("y"); state.account = "acct_1"; state.devices = [owner, PHONE]; }
      },
      said: (text, type, answer) => {
        typeNow = type;
        if (text === NEXT) answer(++shows === 1 ? "keep" : "n");
      },
    });
    expect(out.filter((line) => line.includes("answered nothing"))).toEqual([
      "That line answered nothing: its question is no longer asked.\n",
      "That line answered nothing: the question changed while it may have been typed. Answer again for the question shown now.\n",
    ]);
    expect(out).not.toContain("Kept.\n");
    expect(revoked).toEqual([PHONE.id]);
  });

  it("removes that device where no answer can be typed, and says when it could not", async () => {
    const piped = await scanning({ terminal: false, step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; } });
    expect(piped.code).toBe(1);
    expect(piped.out.slice(-3)).toEqual(["\nNo answer can be typed here, so it is not kept.\n", "Removed.\n", "Sign in on that device, then run ovis add again.\n"]);
    expect(piped.revoked).toEqual([PHONE.id]);
    const failing = await scanning({
      terminal: false, step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      revoke: () => Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 }),
    });
    expect(failing.out.at(-2)).toBe("Hako's iPhone could not be removed (/api/devices/00000000000000a1: this device can only watch): revoke it in Settings → Devices and PCs on this PC.\n");
  });

  it("drops the question when that device signs in after all and adds the PC", async () => {
    const { code, out, revoked } = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 14) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; }
      },
    });
    expect(code).toBe(0);
    expect(out.at(-1)).toBe("\nThis PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n" + CLOSING);
    expect(revoked).toEqual([]);
  });

  it("names as the adder only a member of the account, and still asks about a device that took the code without being one", async () => {
    const owner: Row = { ...OLD, account: "acct_1" };
    const soon = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 4) { state.account = "acct_1"; state.devices = [owner, PHONE]; }
      },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer(""); },
    });
    expect(soon.out.slice(-5)).toEqual([
      OFF,
      "Hako's iPhone paired with this PC. Waiting for it to add this PC to your account…\n",
      "Hako's iPhone paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      "Removed.\n",
      "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n" + CLOSING,
    ]);
    expect(soon.revoked).toEqual([PHONE.id]);
    expect(soon.offers).toEqual(["100001"]);
    expect(soon.code).toBe(0);
    const waiting = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 14) { state.account = "acct_1"; state.devices = [owner, PHONE]; }
      },
      said: (text, _type, answer) => { if (text.includes("is not in your account. Keep that device?")) answer("n"); },
    });
    // the first line after the question changed answers nothing (it may have been begun at the old one): asked once more
    expect(waiting.out.slice(-7)).toEqual([
      "Hako's iPhone paired with this PC but has not added this PC to an account yet, so this PC is in no account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      "\n",
      "Hako's iPhone paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      "That line answered nothing: the question changed while it may have been typed. Answer again for the question shown now.\n",
      "Hako's iPhone paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      "Removed.\n",
      "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n" + CLOSING,
    ]);
    expect(waiting.revoked).toEqual([PHONE.id]);
    const stuck = await scanning({
      terminal: false,
      step: (state, looks) => { if (looks === 2) { state.account = "acct_1"; state.devices = [owner, PHONE]; } },
      revoke: () => Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 }),
    });
    expect(stuck.code).toBe(1);
    expect(stuck.text).toContain("Hako's iPhone could not be removed");
    expect(stuck.text).not.toContain("added by Hako's iPhone");
    // and a server that tells no account of any row vouches for none: the newcomer is not named as the adder
    const untold = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_1"; state.devices = [OLD, PHONE]; } },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("keep"); },
    });
    expect(untold.out.slice(-2)).toEqual(["Kept.\n", "This PC is in your account (acct_1): every device of your account can use it.\n" + CLOSING]);
  });

  it("names as the adder the member that linked itself, not a device of the account it then brought in", async () => {
    const BARE: Row = { id: "00000000000000d4", label: "Hako's MacBook", role: "drive", created_at: "2026-11-06T12:00:50.000Z", last_seen_at: null, current: false, via_relay: true, account: "acct_1" };
    const scanned = await scanning({
      step: (state, looks) => {
        if (looks === 3) { state.account = "acct_1"; state.enrolling = true; state.devices = [OLD, MEMBER, { ...BARE, added_by: PHONE.id }]; }
        if (looks === 5) state.enrolling = false;
      },
    });
    expect(scanned.out.slice(-2)).toEqual([
      "Added by Hako's iPhone. Bringing in your account's other devices…\n",
      "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n" + CLOSING,
    ]);
    expect(scanned.code).toBe(0);
    const before = await scanning({
      step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [{ ...OLD, account: "acct_1" }, { ...BARE, added_by: OLD.id }]; } },
    });
    expect(before.out.at(-1)).toBe("This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n" + CLOSING);
    // where it cannot be told which one linked itself (an Ovis that does not say who brought a member in), none is named
    const untold = await scanning({
      step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER, BARE]; } },
    });
    expect(untold.out.at(-1)).toBe("This PC is in your account (acct_1): every device of your account can use it.\n" + CLOSING);
    expect(untold.code).toBe(0);
  });

  it("keeps a device that linked itself as its removal was on its way: the account that signed in vouches for it by then", async () => {
    const { code, out, revoked } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer(""); },
      revoke: (state) => { state.account = "acct_1"; state.devices = [OLD, MEMBER]; return undefined; },
    });
    expect(revoked).toEqual([]);
    expect(out.slice(-2)).toEqual([
      "Hako's iPhone is in your account by now, so it stays.\n",
      "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n" + CLOSING,
    ]);
    expect(code).toBe(0);
    // and one whose row says so in the same look, though the account was read before it linked: no removal is asked for
    let pcState: { account: string | null; devices: Row[] } | null = null;
    let asked = false;
    const told = await scanning({
      step: (state, looks) => { pcState = state; if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) { asked = true; answer(""); } },
      refuse: (path) => {
        if (asked && path === "/api/devices") { pcState!.account = "acct_1"; pcState!.devices = [OLD, MEMBER]; }
        return undefined;
      },
    });
    expect(told.paths.filter((call) => call.startsWith("DELETE "))).toEqual([]);
    expect(told.out.slice(-2)).toEqual([
      "That line answered nothing: its question is no longer asked.\n",
      "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n" + CLOSING,
    ]);
    expect(told.code).toBe(0);
  });

  it("ends on a look taken after the removal, not the one before it: what came in between is seen", async () => {
    const LAPTOP: Row = { id: "00000000000000e5", label: "Mallory's laptop", role: "drive", created_at: "2026-11-06T12:00:50.000Z", last_seen_at: null, current: false, via_relay: true, account: "acct_2", added_by: PHONE.id };
    const elsewhere = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer(""); },
      revoke: (state, id) => { if (id === PHONE.id) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }, LAPTOP]; } return undefined; },
    });
    expect(elsewhere.revoked).toEqual([PHONE.id, LAPTOP.id]);
    expect(elsewhere.out.slice(-2)).toEqual([
      "Removed.\n",
      "This PC joined another Ovis account (acct_2), not the one you signed in to (acct_1). Mallory's laptop paired with this PC since the code was shown and was removed. This PC is in no account again. Run ovis add again, and scan the code with a device signed in to the account you signed in to here.\n",
    ]);
    expect(elsewhere.code).toBe(1);
    const owner: Row = { ...OLD, account: "acct_1" };
    const between = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_1"; state.devices = [owner, PHONE]; } },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer(""); },
      revoke: (state, id) => { if (id === PHONE.id) state.devices = [...state.devices, DIRECT]; return undefined; },
    });
    expect(between.revoked).toEqual([PHONE.id, DIRECT.id]);
    expect(between.out.slice(-4)).toEqual([
      "Removed.\n",
      "Tailnet laptop paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      "Removed.\n",
      "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n" + CLOSING,
    ]);
    expect(between.code).toBe(0);
    const more = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer(""); },
      revoke: (state, id) => { if (id === PHONE.id) state.devices = [...state.devices, DIRECT]; return undefined; },
    });
    expect(more.revoked).toEqual([PHONE.id, DIRECT.id]);
    expect(more.out.slice(-5)).toEqual([
      "Removed.\n",
      "Tailnet laptop paired with this PC at its own address, not through the relay.\n",
      "Tailnet laptop paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      "Removed.\n",
      "This PC is in no account yet. Run ovis add again.\n",
    ]);
    expect(more.code).toBe(1);
  });

  it("drops the line begun at a question that changed also when another line came in the look that changed it", async () => {
    const owner: Row = { ...OLD, account: "acct_1" };
    const NEXT = "Hako's iPhone paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ";
    const HELD = "That line answered nothing: the question changed while it may have been typed. Answer again for the question shown now.\n";
    let typeNow: (line: string) => void = () => undefined;
    let answered = false;
    let joined = false;
    let shows = 0;
    const { code, out, revoked } = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (answered && !joined) { joined = true; typeNow(""); state.account = "acct_1"; state.devices = [owner, PHONE]; }
      },
      said: (text, type, answer) => {
        typeNow = type;
        if (text.includes("so this PC is in no account. Keep that device?")) { answered = true; answer("keep"); }
        if (text === NEXT && ++shows === 1) answer("keep", 2);
        if (text === HELD) answer("", 3);
      },
    });
    expect(out.filter((line) => line.includes("answered nothing"))).toEqual(["That line answered nothing: its question is no longer asked.\n", HELD]);
    expect(out).not.toContain("Kept.\n");
    expect(revoked).toEqual([PHONE.id]);
    expect(code).toBe(0);
  });

  it("at an Ovis from before ids, ends no code before its QR code when the relay takes no typed code, and takes back the QR code's as the run ends", async () => {
    const { code, text, cancels, offers, paths } = await scanning({
      refuse: (path) => path === "/api/relay/code" ? Response.json({ error: { code: "code_unavailable", message: "Pairing with a typed code works through Ovis's relay only; scan the QR code instead." } }, { status: 409 }) : undefined,
      step: (state, looks) => { if (looks === 1) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } },
    });
    expect(code).toBe(0);
    expect(text).toContain("No code to type this time (Pairing with a typed code works through Ovis's relay only; scan the QR code instead.).");
    expect(text).not.toContain("/api/relay/code");
    expect(cancels).toEqual([{ code: "100001" }]);
    expect(offers).toEqual(["100001"]);
    const order = ["POST /api/relay/code", "POST /api/relay/offer", "POST /api/devices/pair/cancel"].map((call) => paths.indexOf(call));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("counts a device that typed the code at this PC's own address as let in: no further code, and it is asked about at once", async () => {
    const { code, out, offers, cancels, revoked } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, DIRECT]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("n"); },
    });
    expect(code).toBe(1);
    expect(out.slice(-5)).toEqual([
      OFF,
      "Tailnet laptop paired with this PC at its own address, not through the relay.\n",
      "Tailnet laptop paired with this PC while the code was shown and is not in your account. Keep that device? Type keep to keep it, or press Enter to remove it: ",
      "Removed.\n",
      "This PC is in no account yet. Run ovis add again.\n",
    ]);
    expect(offers).toEqual(["100001"]);
    expect(cancels).toEqual([{ code: "100001" }]);
    expect(revoked).toEqual([DIRECT.id]);
    const ignored = await scanning({ step: (state, looks) => { if (looks === 2) state.devices = [OLD, DIRECT]; } });
    expect(ignored.offers).toEqual(["100001"]);
    expect(ignored.out.slice(-3)).toEqual(["\nNo answer came in time, so it is not kept.\n", "Removed.\n", "This PC is in no account yet. Run ovis add again.\n"]);
    expect(ignored.revoked).toEqual([DIRECT.id]);
    expect(ignored.time.waits.filter((ms) => ms === 2_000).length).toBe(900);
  });

  it("renews a code only after a look that was answered: a device that paired while the PC's server was silent leads to no further code", async () => {
    let pcState: { devices: Row[] } | null = null;
    let late = false;
    let silent = 0;
    const { code, offers, out, revoked } = await scanning({
      step: (state, _looks, elapsed) => { pcState = state; late = elapsed >= 598_000; },
      refuse: (path) => {
        if (!late || path !== "/api/account/status") return undefined;
        pcState!.devices = [OLD, PHONE];
        if (++silent <= 3) throw new TypeError("connection refused");
        return undefined;
      },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("n"); },
    });
    expect(code).toBe(1);
    expect(silent).toBeGreaterThan(3);
    expect(offers).toEqual(["100001"]);
    expect(out).toContain("Hako's iPhone paired with this PC. Waiting for it to add this PC to your account…\n");
    expect(revoked).toEqual([PHONE.id]);
  });

  it("Ctrl+C, a SIGTERM or the terminal closing at the question removes the device: only the word keep keeps it", async () => {
    const { code, out, revoked } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep that device?")) stop.abort(); },
    });
    expect(code).toBe(1);
    expect(revoked).toEqual([PHONE.id]);
    expect(out.at(-1)).toBe("\nStopped. Run ovis add again to add this PC. Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.\n");
    expect(out.join("")).not.toContain("not kept");
    // one still in the 15 seconds it gets to add the PC, of which nothing was asked yet, goes as well
    const early = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Waiting for it to add this PC")) stop.abort(); },
    });
    expect(early.text).not.toContain("Keep");
    expect(early.revoked).toEqual([PHONE.id]);
    const two = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE, DIRECT]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep those devices?")) stop.abort(); },
    });
    expect(two.out.at(-1)).toBe("\nStopped. Run ovis add again to add this PC. Hako's iPhone, Tailnet laptop paired with this PC since the code was shown and were removed: nobody kept them.\n");
    expect(two.revoked).toEqual([PHONE.id, DIRECT.id]);
    // a device the person kept stays, and so does a member of the account that signed in
    const owner: Row = { ...OLD, account: "acct_1" };
    const kept = await scanning({
      step: (state, looks, _elapsed, stop) => {
        if (looks === 2) { state.account = "acct_1"; state.enrolling = true; state.devices = [owner, MEMBER, DIRECT]; }
        if (looks === 12) stop.abort();
      },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer("keep"); },
    });
    expect(kept.out).toContain("Kept.\n");
    expect(kept.out.at(-1)).toBe("Stopped. Run ovis add again to add this PC.\n");
    expect(kept.revoked).toEqual([]);
    let halt: AbortController | null = null;
    const unlisted = await scanning({
      step: (state, looks, _elapsed, stop) => { halt = stop; if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep that device?")) stop.abort(); },
      refuse: (path) => { if (halt?.signal.aborted === true && path === "/api/devices") throw new TypeError("connection refused"); return undefined; },
    });
    expect(unlisted.revoked).toEqual([PHONE.id]);
  });

  it("says that devices may still be paired when this PC's devices cannot be read as the run ends, after trying again", async () => {
    const UNREAD = (why: string) => ` The devices paired with this PC could not be read as the run ended (${why}): one that paired since the code was shown may still be paired. Open Settings → Devices and PCs on this PC and revoke any device there that is not yours.\n`;
    let halt: AbortController | null = null;
    let reads = 0;
    const silent = await scanning({
      step: (state, looks, _elapsed, stop) => { halt = stop; if (looks === 2) { state.devices = [OLD, PHONE]; stop.abort(); } },
      refuse: (path) => {
        if (halt?.signal.aborted !== true || path !== "/api/devices") return undefined;
        reads++;
        throw new TypeError("connection refused");
      },
    });
    expect(silent.code).toBe(1);
    expect(silent.revoked).toEqual([]);
    expect(reads).toBe(3);
    expect(silent.out.at(-1)).toBe(`Stopped. Run ovis add again to add this PC.${UNREAD("connection refused")}`);
    let asked: AbortController | null = null;
    const named = await scanning({
      step: (state, looks, _elapsed, stop) => { asked = stop; if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep that device?")) stop.abort(); },
      refuse: (path) => { if (asked?.signal.aborted === true && path === "/api/devices") throw new TypeError("connection refused"); return undefined; },
    });
    expect(named.revoked).toEqual([PHONE.id]);
    expect(named.out.at(-1)).toBe(`\nStopped. Run ovis add again to add this PC. Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.${UNREAD("connection refused")}`);
    let later: AbortController | null = null;
    let tries = 0;
    const second = await scanning({
      step: (state, looks, _elapsed, stop) => { later = stop; if (looks === 2) { state.devices = [OLD, PHONE]; stop.abort(); } },
      refuse: (path) => { if (later?.signal.aborted === true && path === "/api/devices" && ++tries === 1) throw new TypeError("connection refused"); return undefined; },
    });
    expect(second.revoked).toEqual([PHONE.id]);
    expect(second.out.at(-1)).toBe("Stopped. Run ovis add again to add this PC. Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.\n");
    let late = false;
    const stopped = await scanning({
      step: (_state, _looks, elapsed) => { late = elapsed >= 1_798_000; },
      refuse: (path) => { if (late && path === "/api/devices") throw new TypeError("connection refused"); return undefined; },
    });
    expect(stopped.out.at(-1)).toBe(`Stopped after 30 minutes. Run ovis add again.${UNREAD("/api/devices: the Ovis on this PC did not answer (connection refused)")}`);
    let early: AbortController | null = null;
    const codeless = await scanning({
      said: (_text, _type, _answer, stop) => { early = stop; },
      refuse: (path, codes) => {
        if (codes > 0) return undefined;
        if (path === "/api/account/status" && early !== null) early.abort();
        if (early?.signal.aborted === true && path === "/api/devices") throw new TypeError("connection refused");
        return undefined;
      },
    });
    expect(codeless.offers).toEqual([]);
    expect(codeless.text).not.toContain("could not be read");
    let brought = 0;
    const endless = await scanning({
      step: (state, looks, _elapsed, stop) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; stop.abort(); } },
      revoke: (state) => { brought++; state.devices = [...state.devices, { ...PHONE, id: `00000000000000d${brought}`, label: `Mallory ${brought}`, account: "acct_2", added_by: OLD.id }]; return undefined; },
    });
    expect(endless.revoked).toEqual([PHONE.id, "00000000000000d1", "00000000000000d2", "00000000000000d3"]);
    expect(endless.out.at(-1)).toBe("Stopped. Run ovis add again to add this PC. Hako's iPhone, Mallory 1, Mallory 2, Mallory 3 paired with this PC since the code was shown and were removed: nobody kept them. More devices paired with this PC while these were removed: one that paired since the code was shown may still be paired. Open Settings → Devices and PCs on this PC and revoke any device there that is not yours.\n");
  });

  it("removes a device that links itself to another account as the run is stopped, and keeps one that links itself to the account that signed in", async () => {
    const stranger = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep that device?")) stop.abort(); },
      revoke: (state) => { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; return undefined; },
    });
    expect(stranger.revoked).toEqual([PHONE.id]);
    const own = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep that device?")) stop.abort(); },
      revoke: (state) => { state.account = "acct_1"; state.devices = [OLD, MEMBER]; return undefined; },
    });
    expect(own.revoked).toEqual([]);
    expect(own.out.at(-1)).toBe("\nStopped. Run ovis add again to add this PC.\n");
  });

  it("takes the code back and removes the device also when the terminal is gone and every write fails", async () => {
    let cancelled = false;
    let removed = false;
    const writes: boolean[][] = [];
    const { code, cancels, revoked } = await scanning({
      step: (state, looks, _elapsed, stop) => { if (looks === 2) { state.devices = [OLD, PHONE]; stop.abort(); } },
      cancel: () => { cancelled = true; return Response.json({ ok: true, cancelled: true }); },
      revoke: () => { removed = true; return undefined; },
      said: (_text, _type, _answer, stop) => {
        if (!stop.signal.aborted) return;
        writes.push([cancelled, removed]);
        throw new Error("write EIO");
      },
    });
    expect(code).toBe(1);
    expect(cancels).toEqual([{ code: "100001" }]);
    expect(revoked).toEqual([PHONE.id]);
    // a write to a terminal that is gone can end the process where it stands: none comes before the code is back and
    // the device is gone
    expect(writes[0]).toEqual([true, true]);
  });

  it("Ctrl+C while a look is on its way at the question removes the device too, and says nothing of an answer", async () => {
    let asked = false;
    const { code, out, revoked, text } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (line) => { if (line.includes("Keep that device?")) asked = true; },
      service: async (request, pass, at) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/pcs" && request.method === "GET") return Response.json({ pcs: [{ server_id: at.pc.server_id, label: "old-desktop", public_key: "ab".repeat(32), relay: RELAY, added_at: new Date(at.now() - 3_600_000).toISOString(), last_seen_at: null }] });
        if (path.startsWith("/v1/pcs/") && request.method === "DELETE") return new Response(null, { status: 204 });
        if (path.startsWith("/v1/pcs/") && request.method === "PUT") {
          if (asked) at.stop.abort();
          throw new TypeError("offline for a moment");
        }
        return pass();
      },
    });
    expect(code).toBe(1);
    expect(revoked).toEqual([PHONE.id]);
    expect(text).not.toContain("not kept");
    expect(out.join("")).toContain("Stopped. Run ovis add again to add this PC. Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.");
  });

  it("removes the device when no answer came by the 30-minute stop", async () => {
    const { code, out, revoked, time } = await scanning({ step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; } });
    expect(code).toBe(1);
    expect(out.slice(-3)).toEqual(["\nNo answer came in time, so it is not kept.\n", "Removed.\n", "Sign in on that device, then run ovis add again.\n"]);
    expect(revoked).toEqual([PHONE.id]);
    expect(time.waits.filter((ms) => ms === 2_000).length).toBe(900);
    const last = await scanning({ step: (state, _looks, elapsed) => { if (elapsed >= 1_794_000) state.devices = [OLD, PHONE]; } });
    expect(last.text).not.toContain("Keep");
    expect(last.out.at(-1)).toBe("Stopped after 30 minutes. Run ovis add again. Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.\n");
    expect(last.revoked).toEqual([PHONE.id]);
  });

  it("removes the device also when the run fails with it unanswered for", async () => {
    let failing = false;
    const { code, out, revoked } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; if (looks === 4) failing = true; },
      refuse: (path) => failing && path === "/api/account/status" ? Response.json({ error: { code: "internal_error", message: "internal error (y)" } }, { status: 500 }) : undefined,
    });
    expect(code).toBe(1);
    expect(revoked).toEqual([PHONE.id]);
    expect(out.slice(-2)).toEqual([
      "Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.\n",
      "Could not link this PC: /api/account/status: internal error (y)\n",
    ]);
  });

  it("waits for a PC whose server stops answering: no spin, no early code, and a renewal that got no answer is asked again", async () => {
    let statusCalls = 0;
    const looking = await scanning({
      refuse: (path, codes) => {
        if (path === "/api/account/status" && codes > 0 && ++statusCalls >= 4 && statusCalls <= 20) throw new TypeError("connection refused");
        return undefined;
      },
    });
    expect(looking.code).toBe(1);
    expect(looking.offers).toEqual(["100001", "100002", "100003"]);
    expect(looking.time.waits.filter((ms) => ms === 2_000).length).toBe(900);
    expect(looking.out.at(-1)).toBe("Stopped after 30 minutes. Run ovis add again.\n");
    let codeCalls = 0;
    let offerCalls = 0;
    const renewing = await scanning({
      refuse: (path, codes) => {
        if (path === "/api/relay/code" && codes === 1 && ++codeCalls <= 2) throw new TypeError("connection refused");
        if (path === "/api/relay/offer" && codes === 1 && ++offerCalls <= 2) return Response.json({ error: { code: "relay_offline", message: "The relay is not reachable; wait until it is online before pairing." } }, { status: 409 });
        return undefined;
      },
    });
    expect(renewing.code).toBe(1);
    expect(renewing.text).not.toContain("Could not link this PC");
    expect(renewing.out.filter((line) => line.includes("gave no code just now")).length).toBe(1);
    expect(renewing.offers).toEqual(["100001", "100002", "100003"]);
    expect(renewing.time.waits.filter((ms) => ms === 2_000).length).toBe(900);
    // while a look goes unanswered no code is made: whether a device got in cannot be told
    let away = false;
    const blind = await scanning({
      step: (_state, _looks, elapsed) => { away = elapsed >= 598_000 && elapsed < 660_000; },
      refuse: (path) => { if (away && path === "/api/devices") throw new TypeError("connection refused"); return undefined; },
    });
    expect(blind.offers.length).toBe(3);
    expect(blind.paths.filter((call) => call === "POST /api/relay/offer").length).toBe(3);
    expect(blind.renewedAt[1]).toBeGreaterThanOrEqual(660_000);
    // nor before the devices this PC had are known
    let first = true;
    const start = await scanning({
      refuse: (path, codes) => {
        if (codes === 0 && first && (path === "/api/devices" || path === "/api/relay/link/close")) { if (path === "/api/devices") first = false; throw new TypeError("connection refused"); }
        return undefined;
      },
      step: (state, looks) => { if (looks === 1) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } },
    });
    expect(start.code).toBe(0);
    expect(start.paths.slice(0, start.paths.indexOf("POST /api/relay/offer")).filter((call) => call === "GET /api/devices").length).toBe(3);
  });

  it("draws the QR code only in a window that holds it, and again when the window grew", async () => {
    let size = { rows: 24, columns: 80 };
    const { code, out } = await scanning({
      size: () => size,
      step: (state, looks) => {
        if (looks === 2) size = { rows: 60, columns: 120 };
        if (looks === 4) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; }
      },
    });
    expect(code).toBe(0);
    const drawn = out.filter((line) => line.includes("Scan this QR code"));
    expect(drawn.length).toBe(2);
    expect(drawn[0]).toContain("This window is too small for the QR code");
    expect(drawn[0]).not.toContain("▀▀▀▀▀");
    expect(drawn[0]).toContain("Code to type: ABCD-EFGH-J1");
    expectQrCode(drawn[1]!);
  });

  // a PC that makes its codes for the account the command names (docs/account.md, "A code made for an account")
  const TIED = {};
  const OLDER = "The Ovis on this PC is older than this command. Update it in Settings → Updates on this PC before you pair a new device.";
  const UNKNOWN = "The Ovis on this PC no longer knows the code shown (it restarted), so that code does not work. A new one comes when it would have run out.\n";
  const RELAY_DOWN = "This PC's Ovis relay is off or not online just now, so it gave no code. Asking again…\n";
  /** The account each call to `path` named for its code. */
  const namedFor = (calls: readonly { path: string; headers: Headers }[], path: string) => calls.filter((call) => call.path === path).map((call) => call.headers.get("x-ovis-expect-account"));
  const times = (text: string, part: string): number => text.split(part).length - 1;
  const live = (id: string) => ({ state: "live", id, expect_account: "acct_1", expires_at: "2026-11-06T12:10:00.000Z" });
  const endedBy = (why: string) => (id: string) => ({ state: "ended", id, expect_account: "acct_1", ended: { why, at: "2026-11-06T12:01:00.000Z" } });

  it("asks for its code for the account that signed in, the code to type and the QR code alike, and reads that code by its id while it is out", async () => {
    const { code, text, calls, reads, offers, cancels } = await scanning({ tied: TIED, step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } } });
    expect(code).toBe(0);
    expect(namedFor(calls, "/api/relay/code")).toEqual(["acct_1"]);
    expect(namedFor(calls, "/api/relay/offer")).toEqual(["acct_1"]);
    expect(text).toContain("Code to type: ABCD-EFGH-J1   (works once, expires in 10:00)");
    expect(text).not.toContain("older than this command");
    // at each look while the code was out, and no more once this PC was in the account
    expect(reads).toEqual(["p1", "p1", "p1"]);
    expect(offers).toEqual(["100001"]);
    expect(cancels).toEqual([{ code: "100001", id: "p1" }]);
  });

  it("takes no code that this PC made for another account than the one that signed in: the code goes back, and the run fails naming both", async () => {
    for (const expect_account of [{ code: "acct_9", offer: "acct_9" }, { code: "acct_9" }, { offer: "acct_9" }]) {
      const { code, out, cancels, offers } = await scanning({ tied: { expect: expect_account } });
      expect([expect_account, code]).toEqual([expect_account, 1]);
      // what became of the code is said on its own line, before
      expect(out.slice(-2)).toEqual(["The code and the QR code no longer work.\n", "Could not link this PC: The Ovis on this PC made its code for another Ovis account (acct_9) than the one you signed in to (acct_1). Run ovis add again.\n"]);
      expect(out.some((text) => text.includes("Scan this QR code"))).toBe(false);
      expect(cancels).toEqual([{ code: "100001", id: "p1" }]);
      expect(offers).toEqual(["100001"]);
    }
  });

  it("ends no code made for the account because a device shows in the list: one that came another way is asked about while the code stays out; an older Ovis ends it at once", async () => {
    const step = (state: { devices: Row[] }, looks: number) => { if (looks === 2) state.devices = [OLD, DIRECT]; };
    const tied = await scanning({ tied: TIED, terminal: false, step });
    const older = await scanning({ terminal: false, step });
    const removedAt = (run: { paths: string[] }) => run.paths.indexOf(`DELETE /api/devices/${DIRECT.id}`);
    const endedAt = (run: { paths: string[] }) => run.paths.indexOf("POST /api/devices/pair/cancel");
    expect([tied.code, older.code]).toEqual([1, 1]);
    expect([tied.revoked, older.revoked]).toEqual([[DIRECT.id], [DIRECT.id]]);
    // the code made for the account is taken back only as the run ends, after that device was asked about and removed
    expect(removedAt(tied)).toBeGreaterThan(-1);
    expect(endedAt(tied)).toBeGreaterThan(removedAt(tied));
    expect(tied.reads.length).toBeGreaterThan(1);
    // at an older Ovis, the code goes the moment a device shows
    expect(endedAt(older)).toBeGreaterThan(-1);
    expect(endedAt(older)).toBeLessThan(removedAt(older));
    expect([tied.cancels, older.cancels]).toEqual([[{ code: "100001", id: "p1" }], [{ code: "100001" }]]);
  });

  it("says when its code ended on this PC, and why, and stops: nothing is taken back that is not out", async () => {
    const said: Record<string, string> = {
      replaced: "another pairing code was made on this PC, which replaced it.",
      cancelled: "it was taken back on this PC.",
      revoked: "a device that held it was revoked on this PC.",
      overused: "five devices paired with it, and none of them joined your account.",
      guessed: "a wrong code was typed for it five times.",
    };
    for (const [why, sentence] of Object.entries(said)) {
      // the looks are counted only where a step is played
      const { code, out, cancels, offers } = await scanning({ tied: { read: (id, looks) => looks >= 2 ? endedBy(why)(id) : live(id) }, step: () => undefined });
      expect([why, code]).toEqual([why, 1]);
      expect(out.slice(-2)).toEqual([OFF, `The code no longer works: ${sentence} Run ovis add again.\n`]);
      expect(cancels).toEqual([]);
      expect(offers).toEqual(["100001"]);
    }
  });

  it("goes on when its code ran out or this PC joined with it, and says once when this PC no longer knows it", async () => {
    const expired = await scanning({ tied: { read: (id) => id === "p1" ? endedBy("expired")(id) : undefined } });
    expect(expired.offers).toEqual(["100001", "100002", "100003"]);
    expect(expired.text).not.toContain("no longer works:");
    const joined = await scanning({ tied: { read: endedBy("joined") }, step: (state, looks) => { if (looks === 4) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } } });
    expect(joined.code).toBe(0);
    expect(joined.text).not.toContain("no longer works:");
    const unknown = await scanning({ tied: { read: (id) => id === "p1" ? { state: "unknown" } : undefined } });
    expect(times(unknown.text, UNKNOWN)).toBe(1);
    expect(unknown.offers).toEqual(["100001", "100002", "100003"]);
  });

  it("tells the refusals of its code apart: the relay off or not online, this PC in an account by now, an account id it does not take", async () => {
    let down = 2;
    const offline = await scanning({ tied: TIED, refuse: (path) => path === "/api/relay/code" && down-- > 0 ? Response.json({ error: { code: "relay_offline", message: "The relay is not reachable." } }, { status: 409 }) : undefined });
    expect(times(offline.text, RELAY_DOWN)).toBe(1);
    expect(offline.text).not.toContain("is it restarting?");
    // nothing pending was ended for it: the first code is the first thing taken back
    expect(offline.paths.indexOf("POST /api/devices/pair/cancel")).toBeGreaterThan(offline.paths.indexOf("POST /api/relay/offer"));
    expect(offline.offers).toEqual(["100001", "100002", "100003"]);
    // the PC joined an account as its next code was asked for: nothing is said of it, and the code pending stays
    let pc: { account: string | null; devices: Row[] } | null = null;
    const joined = await scanning({
      tied: TIED,
      step: (state) => { pc = state; },
      refuse: (path, codes) => {
        if (path !== "/api/relay/code" || codes !== 1) return undefined;
        pc!.account = "acct_1";
        pc!.devices = [OLD, MEMBER];
        return Response.json({ error: { code: "in_account", message: "This PC is in an Ovis account." } }, { status: 409 });
      },
    });
    expect(joined.code).toBe(0);
    expect(joined.text).not.toContain("Asking again");
    expect(joined.cancels).toEqual([{ code: "100001", id: "p1" }]);
    expect(joined.offers).toEqual(["100001"]);
    // the PC joined an account between the code to type and the QR code: the offer made none, and only the code to
    // type this command made last is taken back, by its id, never whichever pairing is pending by then
    let at: { account: string | null; devices: Row[] } | null = null;
    const between = await scanning({
      tied: TIED,
      step: (state) => { at = state; },
      refuse: (path, codes) => {
        if (path !== "/api/relay/offer" || codes !== 1) return undefined;
        at!.account = "acct_1";
        at!.devices = [OLD, MEMBER];
        return Response.json({ error: { code: "in_account", message: "This PC is in an Ovis account." } }, { status: 409 });
      },
    });
    expect(between.code).toBe(0);
    expect(between.text).not.toContain("Asking again");
    expect(between.offers).toEqual(["100001"]);
    expect(between.cancels).toEqual([{ id: "p2" }]);
    const invalid = await scanning({ tied: TIED, refuse: (path) => path === "/api/relay/code" ? Response.json({ error: { code: "invalid_account", message: "x-ovis-expect-account names no account id." } }, { status: 400 }) : undefined });
    expect(invalid.code).toBe(1);
    expect(invalid.out.at(-1)).toBe("Could not link this PC: The Ovis on this PC did not take the id of the account you signed in to (acct_1) for its code (/api/relay/code: x-ovis-expect-account names no account id.)\n");
    expect(invalid.cancels).toEqual([]);
    expect(invalid.offers).toEqual([]);
  });

  it("shows no QR code that is not the code to type it made, and takes back only its own", async () => {
    const { code, text, cancels } = await scanning({ tied: { typedId: "p0" }, step: joins });
    expect(code).toBe(1);
    expect(text).toContain("This PC's QR code carries a code made elsewhere");
    expect(text).not.toContain("ABCD-EFGH-J1");
    expect(text).not.toContain("Scan this QR code");
    // the QR code's code (p1) is left as it is
    expect(cancels).toEqual([{ id: "p0" }]);
  });

  it("takes back by its id the code to type it made when its QR code was refused, and ends no other code", async () => {
    const { code, cancels, offers } = await scanning({
      tied: TIED,
      refuse: (path) => path === "/api/relay/offer" ? Response.json({ error: { code: "relay_offline", message: "The relay is not reachable." } }, { status: 409 }) : undefined,
    });
    expect(code).toBe(1);
    expect(offers).toEqual([]);
    expect(cancels).toEqual([{ id: "p1" }]);
  });

  it("stops when another code was made since its code to type: no new code that would replace that one, and only its own is taken back", async () => {
    const { code, text, cancels, offers, paths } = await scanning({
      tied: TIED,
      refuse: (path) => path === "/api/relay/offer" ? Response.json({ error: { code: "pairing_gone", message: "The code this offer names is no longer the one pending on this PC; no new code was made." } }, { status: 409 }) : undefined,
    });
    expect(code).toBe(1);
    expect(offers).toEqual([]);
    expect(paths.filter((call) => call === "POST /api/relay/code")).toHaveLength(1);
    expect(cancels).toEqual([{ id: "p1" }]);
    expect(text).toContain("Another pairing code was made on this PC");
  });

  it("makes no new code while its code still holds a device that paired with it in time, and renews it once that device's time is over", async () => {
    let at = 0;
    const { renewedAt, offers } = await scanning({
      // past its ten minutes the PC still reads the code live while that device may link, here until 10:40
      tied: { read: (id) => id === "p1" && at <= 640_000 ? live(id) : undefined },
      step: (_state, _looks, elapsed) => { at = elapsed; },
    });
    expect(offers).toEqual(["100001", "100002", "100003"]);
    expect(renewedAt[1]).toBeGreaterThan(640_000);
  });

  it("at an Ovis from before codes made for an account, says so on the screen of each QR code it draws", async () => {
    const { out, offers } = await scanning();
    expect(offers).toEqual(["100001", "100002", "100003"]);
    const cards = out.filter((part) => part.includes("Scan this QR code"));
    expect(cards.length).toBe(3);
    for (const card of cards) expect(card).toContain(OLDER.trimEnd());
    // nothing of it is said on the screen the QR code's screen covers
    expect(out.filter((part) => part.includes(OLDER.trimEnd()) && !cards.includes(part))).toEqual([]);
  });

  it("at an Ovis from before codes made for an account, --print says so once before its first code, and reads no code by an id", async () => {
    const { out, text, calls, paths, offers } = await scanning({ args: ["--print"] });
    expect(offers).toEqual(["100001", "100002", "100003"]);
    expect(times(text, OLDER)).toBe(1);
    expect(out.indexOf(OLDER)).toBeLessThan(out.findIndex((part) => part.includes("Scan this QR code")));
    expect(namedFor(calls, "/api/relay/offer")).toEqual(["acct_1", "acct_1", "acct_1"]);
    expect(paths).not.toContain("POST /api/relay/offer/keep");
  });

  it("says the Ovis on this PC is too old for link, rather than failing on an unknown route", async () => {
    const local = localPc((_request, path) => path === "/api/account/status" ? Response.json({ error: { code: "not_found", message: "unknown endpoint /api/account/status" } }, { status: 404 }) : undefined);
    const out: string[] = [];
    expect(await link([], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text) => out.push(text), signal: new AbortController().signal, lines: answers(), accountService: SERVICE })).toBe(1);
    expect(out.join("")).toContain("Settings → Updates");
  });

  it("runs the copy of link the app updated to, as phone-setup does", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "ovis-link-release-"));
    scratch.push(scratchDir);
    const root = join(import.meta.dir, "..");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new URL(request.url).pathname === "/api/health"
      ? Response.json({ ok: true, herdr: { version: "0.9.5", protocol: 1 }, auth: { required: false, authenticated: true } })
      : new Response(null, { status: 404 }) });
    try {
      const updates = updateStateDir(root, server.port!, join(scratchDir, "app-state"));
      const release = join(updates, "release-test");
      mkdirSync(join(release, "scripts"), { recursive: true });
      writeFileSync(join(release, "scripts", "plugin.ts"), 'console.log("active release", process.argv.slice(2).join(" "));');
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, windowsHide: true }).stdout.toString().trim();
      writeFileSync(join(updates, "current.json"), JSON.stringify({ source_revision: revision, directory: release }));
      mkdirSync(join(scratchDir, "config"));
      writeFileSync(join(scratchDir, "config", ".env"), `PORT=${server.port}\n`);
      const child = Bun.spawn([process.execPath, "scripts/plugin.ts", "link", "--code"], { cwd: root, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
        ...process.env, HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_CONFIG_DIR: join(scratchDir, "config"),
        HERDR_PLUGIN_STATE_DIR: join(scratchDir, "plugin-state"), OVIS_STATE_DIR: join(scratchDir, "app-state"),
      } });
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exit, stderr).toBe(0);
      expect(stdout).toContain("active release link --code");
    } finally { server.stop(true); }
  });

  it("add refuses an output that is not a terminal, --print too, only under the fleet preview, set in its environment or in the plugin's settings file", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "ovis-link-preview-"));
    scratch.push(scratchDir);
    const root = join(import.meta.dir, "..");
    const paths: string[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
      const path = new URL(request.url).pathname;
      paths.push(`${request.method} ${path}`);
      if (path === "/api/health") return Response.json({ ok: true, herdr: { version: "0.9.5", protocol: 1 }, auth: { required: false, authenticated: true } });
      if (path === "/api/account/status") return Response.json({ account: null, enrolling: false, unlinked: [], removals: [], adds: [], blocked: [] });
      return new Response(null, { status: 404 });
    } });
    try {
      mkdirSync(join(scratchDir, "config"));
      const run = async (preview: string | undefined, args: string[], settings = ""): Promise<[string, number]> => {
        paths.length = 0;
        writeFileSync(join(scratchDir, "config", ".env"), `PORT=${server.port}\n${settings}`);
        const environment: Record<string, string | undefined> = {
          ...process.env, HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_CONFIG_DIR: join(scratchDir, "config"),
          HERDR_PLUGIN_STATE_DIR: join(scratchDir, "plugin-state"), OVIS_STATE_DIR: join(scratchDir, "app-state"), OVIS_TOKEN: "",
          OVIS_ACCOUNT_SERVICE_URL: "https://account.test", OVIS_PREVIEW: preview, OVIS_CLI_NAME: "",
        };
        if (preview === undefined) delete environment["OVIS_PREVIEW"];
        const child = Bun.spawn([process.execPath, "scripts/plugin.ts", ...args], { cwd: root, windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: environment });
        const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
        expect(stderr).toBe("");
        return [stdout, exit];
      };
      const refusal = "Adding this PC needs a terminal: the QR code and the code to type are a key to this PC, so they are never written to a pipe, a file or a log. Run ovis add in a terminal (over ssh, run ssh -t).\n";
      for (const args of [["add", "--print"], ["add"], ["login", "--print"], ["add", "--qr"]]) {
        expect([args, ...await run("fleet", args)]).toEqual([args, refusal, 1]);
        // without --qr or --print it first asks whether this PC takes an add by a press, which this one does not (404)
        expect(paths).toEqual(["GET /api/health", "GET /api/account/status", ...args.length === 1 ? ["POST /api/account/one-press"] : []]);
      }
      const before = "The QR code is a key to this PC. Run this in a terminal, or pass --print to write it anyway.\n";
      expect(await run("", ["add"])).toEqual([before, 1]);
      expect(await run(undefined, ["add"])).toEqual([before, 1]);
      expect(await run(undefined, ["add", "--print"], "OVIS_PREVIEW=fleet\n")).toEqual([refusal, 1]);
      expect(paths).toEqual(["GET /api/health", "GET /api/account/status"]);
      expect(await run("other", ["add", "--print"], "OVIS_PREVIEW=fleet\n")).toEqual([refusal, 1]);
      expect(await run(undefined, ["add"], "OVIS_PREVIEW=fleet\nOVIS_CLI_NAME=/opt/wrapper/bin/ovis-wrapper\n")).toEqual([refusal.replace("Run ovis add", "Run /opt/wrapper/bin/ovis-wrapper add"), 1]);
      expect(await run("fleet", ["add"], "OVIS_PREVIEW=\n")).toEqual([before, 1]);
    } finally { server.stop(true); }
  });

  it("add and login are names of link", () => {
    expect(COMMAND_ALIASES).toEqual({ add: "link", login: "link" });
  });

  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    it.skipIf(process.platform === "win32")(`--code takes its code back when ${signal} ends it, not only on Ctrl+C`, async () => {
      const scratchDir = mkdtempSync(join(tmpdir(), "ovis-link-signal-"));
      scratch.push(scratchDir);
      const pc = identity();
      const root = join(import.meta.dir, "..");
      const cancels: unknown[] = [];
      const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/health") return Response.json({ ok: true, herdr: { version: "0.9.5", protocol: 1 }, auth: { required: false, authenticated: true } });
        if (path === "/api/relay") return Response.json({ phase: "online", blocked: null });
        if (path === "/api/relay/code") return Response.json({ code: "ABCD-EFGH-JK", expires_at: new Date(Date.now() + 600_000).toISOString(), server_id: pc.server_id });
        if (path === "/api/relay/offer") {
          return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: "123456" }, "https://app.ovis.sh"), expires_at: new Date(Date.now() + 600_000).toISOString() });
        }
        if (path === "/api/devices/pair/cancel") { cancels.push(await request.json()); return Response.json({ ok: true }); }
        return new Response(null, { status: 404 });
      } });
      try {
        mkdirSync(join(scratchDir, "config"));
        writeFileSync(join(scratchDir, "config", ".env"), `PORT=${server.port}\n`);
        const child = Bun.spawn([process.execPath, "scripts/plugin.ts", "link", "--code"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
          ...process.env, HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_CONFIG_DIR: join(scratchDir, "config"),
          HERDR_PLUGIN_STATE_DIR: join(scratchDir, "plugin-state"), OVIS_STATE_DIR: join(scratchDir, "app-state"), OVIS_TOKEN: "",
        } });
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let stdout = "";
        while (!stdout.includes("Press Ctrl+C to stop")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          stdout += decoder.decode(chunk.value, { stream: true });
        }
        // twice, as a process group and a checkout's link passing it on deliver it: the second must not cut the clean-up short
        child.kill(signal);
        child.kill(signal);
        const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        expect(cancels, stderr).toEqual([{ code: "123456" }]);
        expect(exit).toBe(0);
      } finally { server.stop(true); }
    });
  }

  it.skipIf(process.platform === "win32")("passes a SIGTERM on to the copy of link the app updated to, so it can take its code back", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "ovis-link-release-term-"));
    scratch.push(scratchDir);
    const root = join(import.meta.dir, "..");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 404 }) });
    try {
      const updates = updateStateDir(root, server.port!, join(scratchDir, "app-state"));
      const release = join(updates, "release-test");
      mkdirSync(join(release, "scripts"), { recursive: true });
      writeFileSync(join(release, "scripts", "plugin.ts"), 'process.on("SIGTERM", () => { console.log("release took its code back"); process.exit(0); }); console.log("release ready"); setTimeout(() => process.exit(3), 10_000);');
      const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root, windowsHide: true }).stdout.toString().trim();
      writeFileSync(join(updates, "current.json"), JSON.stringify({ source_revision: revision, directory: release }));
      mkdirSync(join(scratchDir, "config"));
      writeFileSync(join(scratchDir, "config", ".env"), `PORT=${server.port}\n`);
      const child = Bun.spawn([process.execPath, "scripts/plugin.ts", "link", "--code"], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: {
        ...process.env, HOST: "127.0.0.1", HERDR_PLUGIN_ROOT: root, HERDR_PLUGIN_CONFIG_DIR: join(scratchDir, "config"),
        HERDR_PLUGIN_STATE_DIR: join(scratchDir, "plugin-state"), OVIS_STATE_DIR: join(scratchDir, "app-state"),
      } });
      const decoder = new TextDecoder();
      let stdout = "";
      const reader = child.stdout.getReader();
      while (!stdout.includes("release ready")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stdout += decoder.decode(chunk.value, { stream: true });
      }
      child.kill("SIGTERM");
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stdout += decoder.decode(chunk.value, { stream: true });
      }
      expect(stdout).toContain("release took its code back");
      expect(await child.exited).toBe(0);
    } finally { server.stop(true); }
  });
});

describe("pair --approve, asked as ovis add asks", () => {
  const waiting = (id: string, digits: string): WaitingDevice => ({ id, label: `Phone ${id}`, digits });

  async function approving(options: { pairings: WaitingDevice[]; said: (text: string, type: (line: string) => void, answer: (...lines: string[]) => void) => void; terminal?: boolean; lines?: AsyncIterator<string>; decide?: (attempt: number) => "taken" | "gone" | "away"; list?: (count: number) => WaitingDevice[]; discard?: null; keys?: ReturnType<typeof keyboard> }) {
    let at = Date.parse("2026-11-06T12:00:00Z");
    const keys = options.keys ?? keyboard();
    const out: string[] = [];
    const decisions: { id: string; decision: string }[] = [];
    let attempts = 0;
    let listed = 0;
    const list = options.list;
    const code = await approveWaiting(options.pairings, {
      ...list === undefined ? {} : { list: async () => list(++listed) },
      lines: options.lines ?? keys.lines, terminal: options.terminal ?? true, signal: new AbortController().signal, now: () => at,
      ...options.discard === null ? {} : { discard: keys.discard },
      out: (text) => {
        out.push(text);
        options.said(text, keys.type, (...lines) => { setTimeout(() => { at += 2_000; for (const line of lines) keys.type(line); }, 0); });
      },
      decide: async (id, decision) => {
        const sent = options.decide?.(++attempts) ?? "taken";
        if (sent === "taken") decisions.push({ id, decision });
        return sent;
      },
    });
    return { code, out, text: out.join(""), decisions };
  }

  it("asks about each waiting request with its digits, and approves the ones whose digits are typed", async () => {
    const { code, out, decisions } = await approving({
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 wants")) answer("222");
        if (said.includes("Phone p2 wants")) answer("");
      },
    });
    expect(code).toBe(0);
    expect(out).toEqual([
      "Phone p1 wants to pair with this PC. Approve it only if its screen shows 111 222. Type 222 to approve, or press Enter to decline: ",
      "Approved.\n",
      "Phone p2 wants to pair with this PC. Approve it only if its screen shows 333 444. Type 444 to approve, or press Enter to decline: ",
      "Declined.\n",
    ]);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "decline" }]);
  });

  it("answers one request with one line: a second line sent right behind an answer never answers the request after it", async () => {
    let asked = 0;
    const { code, out, decisions } = await approving({
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 wants")) answer("222", "");
        if (said.includes("Phone p2 wants") && ++asked === 1) answer("444");
      },
    });
    expect(code).toBe(0);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "approve" }]);
    expect(out.filter((said) => said === "Declined.\n")).toEqual([]);
  });

  it("drops a line that comes as a request shows, too soon to have compared its digits, and asks again", async () => {
    let asked = 0;
    const { code, out, text, decisions } = await approving({
      pairings: [waiting("p1", "111222"), waiting("p2", "111222")],
      said: (said, type, answer) => {
        if (said.includes("Phone p1 wants")) answer("111222");
        if (said.includes("Phone p2 wants")) { if (++asked === 1) type("111222"); else answer(""); }
      },
    });
    expect(code).toBe(0);
    expect(text).toContain("That line answered nothing: it came as the request showed, too soon to have compared its digits.");
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "decline" }]);
  });

  it("asks for all six digits of each request whose last three another waiting request shares", async () => {
    let asked = 0;
    const { code, out, decisions } = await approving({
      pairings: [waiting("p1", "111456"), waiting("p2", "222456"), waiting("p3", "333789")],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 wants")) answer("111456");
        if (said.includes("Phone p2 wants")) answer(++asked === 1 ? "456" : "222 456");
        if (said.includes("Phone p3 wants")) answer("789");
      },
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("Enter to decline"))).toEqual([
      "Phone p1 wants to pair with this PC. Approve it only if its screen shows 111 456. Another request's digits end in 456 too, so type all six (111456) to approve, or press Enter to decline: ",
      "Phone p2 wants to pair with this PC. Approve it only if its screen shows 222 456. Another request's digits end in 456 too, so type all six (222456) to approve, or press Enter to decline: ",
      "Phone p2 wants to pair with this PC. Approve it only if its screen shows 222 456. Another request's digits end in 456 too, so type all six (222456) to approve, or press Enter to decline: ",
      "Phone p3 wants to pair with this PC. Approve it only if its screen shows 333 789. Type 789 to approve, or press Enter to decline: ",
    ]);
    expect(out).toContain("That line answered nothing: only all six digits shown approve this request, and only Enter by itself declines it. Answer again.\n");
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "approve" }, { id: "p3", decision: "approve" }]);
  });

  it("asks about a request again when its answer did not reach the PC's server, and takes no line typed meanwhile as that answer", async () => {
    let asked = 0;
    const { code, out, decisions } = await approving({
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 wants")) answer(++asked === 2 ? "" : "222");
        if (said.includes("Phone p2 wants")) answer("444");
      },
      decide: (attempt) => attempt === 1 ? "away" : "taken",
    });
    expect(code).toBe(0);
    expect(out.filter((said) => !said.includes("Enter to decline"))).toEqual([
      "Your answer may not have reached the Ovis on this PC. Phone p1 is asked about again.\n",
      "That line answered nothing: the answer before it may not have reached the Ovis on this PC, and it may have been typed meanwhile. Answer again for the request shown now.\n",
      "Approved.\n",
      "Approved.\n",
    ]);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "approve" }]);
  });

  it("stops when the PC's server takes no answer and nothing can be typed: it never asks in a circle", async () => {
    const { code, out, decisions } = await approving({
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      lines: answers(),
      said: () => undefined,
      decide: () => "away",
    });
    expect(code).toBe(1);
    expect(out.at(-1)).toBe("Your answer may not have reached the Ovis on this PC. Run this again once it answers.\n");
    expect(out.filter((said) => said.includes("Enter to decline"))).toHaveLength(1);
    expect(decisions).toEqual([]);
  });

  it("takes nothing typed and not sent before a request's prompt as part of its answer: neither before the first, nor between two", async () => {
    const keys = keyboard();
    keys.begin("222");
    let declined = 0;
    const { code, out, decisions } = await approving({
      keys,
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 wants")) answer("");
        if (said === "Declined.\n" && ++declined === 1) keys.begin("444");
        if (said.includes("Phone p2 wants")) answer("");
      },
    });
    expect(code).toBe(0);
    expect(out).not.toContain("Approved.\n");
    expect(decisions).toEqual([{ id: "p1", decision: "decline" }, { id: "p2", decision: "decline" }]);
    expect(keys.discards()).toBe(2);
  });

  it("drops the first line after each prompt where the terminal's input cannot be discarded, and asks again", async () => {
    const keys = keyboard();
    keys.begin("222");
    let asked = 0;
    const { code, out, decisions } = await approving({
      keys, discard: null,
      pairings: [waiting("p1", "111222")],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++asked === 1 ? "" : "222"); },
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("That line answered nothing"))).toEqual(["That line answered nothing: this terminal's input could not be emptied as the request showed, so it may have been begun before that. Answer again for the request shown now.\n"]);
    expect(out.filter((said) => said.includes("Enter to decline"))).toHaveLength(2);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
  });

  it("answers no request when its input is not a terminal, whatever was piped in: it says so, fails, and declines none, the person's own phone included", async () => {
    let reads = 0;
    let listed = 0;
    const sent: string[] = [];
    const lines = answers("222", "444");
    const out: string[] = [];
    const code = await approveWaiting([waiting("p1", "111222"), waiting("p2", "333444")], {
      lines: { next: () => { reads++; return lines.next(); } }, terminal: false, signal: new AbortController().signal,
      out: (text) => { out.push(text); },
      list: async () => { listed++; return []; },
      decide: async (id, decision) => { sent.push(`${id} ${decision}`); return "taken"; },
    });
    // an ssh without -t costs a refusal, not the request: it still waits for a run at a terminal
    expect(code).toBe(1);
    expect(out).toEqual(["This is not run in a terminal, so no request can be answered here. Nothing was declined: the requests keep waiting. Run this in a terminal to answer them (over ssh, run ssh -t).\n"]);
    expect(sent).toEqual([]);
    expect([reads, listed]).toEqual([0, 0]);
  });

  it("says in so many words that digits of another value are not this request's, and that Enter declines it", async () => {
    let asked = 0;
    const { code, out, decisions } = await approving({
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 wants")) answer(++asked === 1 ? "444" : "");
        if (said.includes("Phone p2 wants")) answer("444");
      },
    });
    expect(code).toBe(0);
    const P1 = "Phone p1 wants to pair with this PC. Approve it only if its screen shows 111 222. Type 222 to approve, or press Enter to decline: ";
    expect(out.slice(0, 4)).toEqual([
      P1,
      "That line answered nothing: 444 are not this request's digits: Phone p1 shows 111 222. If the device you are adding shows other digits than those, this request is not that device's: press Enter by itself to decline it, and do not type the digits below.\n",
      P1,
      "Declined.\n",
    ]);
    expect(decisions).toEqual([{ id: "p1", decision: "decline" }, { id: "p2", decision: "approve" }]);
    let again = 0;
    const six = await approving({
      pairings: [waiting("p1", "111222")],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++again === 1 ? "３３３ ４４４" : ""); },
    });
    expect(six.out[1]).toStartWith("That line answered nothing: 333444 are not this request's digits: Phone p1 shows 111 222.");
    expect(six.decisions).toEqual([{ id: "p1", decision: "decline" }]);
    let third = 0;
    const habit = await approving({
      pairings: [waiting("p1", "111222")],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++third === 1 ? "y" : ""); },
    });
    expect(habit.out[1]).toBe("That line answered nothing: only the digits shown approve a request, and only Enter by itself declines it. Answer again.\n");
  });

  it("reads the waiting requests again before three digits approve: one that came since and ends in the same three makes all six needed", async () => {
    let asked = 0;
    const lists: number[] = [];
    const { code, out, decisions } = await approving({
      pairings: [waiting("p1", "111222")],
      list: (count) => { lists.push(count); return [waiting("p1", "111222"), waiting("p9", "999222")]; },
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++asked === 1 ? "222" : "111222"); },
    });
    expect(code).toBe(0);
    expect(out).toEqual([
      "Phone p1 wants to pair with this PC. Approve it only if its screen shows 111 222. Type 222 to approve, or press Enter to decline: ",
      "That line answered nothing: another request's digits end in 222 too, so only all six digits approve Phone p1 now.\n",
      "Phone p1 wants to pair with this PC. Approve it only if its screen shows 111 222. Another request's digits end in 222 too, so type all six (111222) to approve, or press Enter to decline: ",
      "Approved.\n",
    ]);
    // read once, for the three digits: all six name the request by themselves
    expect(lists).toEqual([1]);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
    const alone = await approving({
      pairings: [waiting("p1", "111222")],
      list: () => [waiting("p1", "111222"), waiting("p9", "999333")],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer("222"); },
    });
    expect(alone.decisions).toEqual([{ id: "p1", decision: "approve" }]);
    // a list that cannot be read: the three digits approve nothing, and all six still do
    let third = 0;
    const away = await approving({
      pairings: [waiting("p1", "111222")],
      list: () => { throw new Error("no answer"); },
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++third === 1 ? "222" : "111 222"); },
    });
    expect(away.out[1]).toBe("The waiting requests could not be read again just now, so the last three digits approved nothing. Phone p1 is asked about again.\n");
    expect(away.decisions).toEqual([{ id: "p1", decision: "approve" }]);
  });

  it("says so when a request no longer waits, and goes on to the next", async () => {
    const gone = await approving({
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer("222"); if (said.includes("Phone p2 wants")) answer("444"); },
      decide: (attempt) => attempt === 1 ? "gone" : "taken",
    });
    expect(gone.code).toBe(0);
    expect(gone.out).toContain("Phone p1 is no longer waiting.\n");
    expect(gone.decisions).toEqual([{ id: "p2", decision: "approve" }]);
  });
});

describe("ovis approve, a members join typed with all six of its digits (#28)", () => {
  // labels without digits, so a digit on the screen can only be one the command showed
  const joinOf = (id: string) => ({ id, label: `Tablet ${id === "j1" ? "one" : "two"}` });
  /** `said`: each text the command writes; `answer` types lines once the prompt was on the screen long enough. */
  async function joining(options: { joins: OwnJoin[]; said: (text: string, answer: (...lines: string[]) => void) => void; terminal?: boolean; approve?: (attempt: number) => JoinOutcome; account?: string | null }) {
    let at = Date.parse("2026-11-22T12:00:00Z");
    const keys = keyboard();
    const out: string[] = [];
    const sent: { id: string; digits: string }[] = [];
    let reads = 0;
    const code = await approveJoins(options.joins, {
      ...options.account === undefined ? {} : { account: options.account },
      lines: { next: () => { reads++; return keys.lines.next(); } }, terminal: options.terminal ?? true, signal: new AbortController().signal, now: () => at, discard: keys.discard,
      out: (text) => {
        out.push(text);
        options.said(text, (...lines) => { setTimeout(() => { at += 2_000; for (const line of lines) keys.type(line); }, 0); });
      },
      approve: async (id, digits) => { sent.push({ id, digits }); return options.approve?.(sent.length) ?? "approved"; },
    });
    return { code, out, text: out.join(""), sent, reads };
  }
  const prompt = (said: string, id: string): boolean => said.includes(joinOf(id).label) && said.endsWith(": ");

  it("asks for the six digits the new device shows, shows none itself, takes no three, and lets it in with all six", async () => {
    let asked = 0;
    const { code, out, sent } = await joining({
      joins: [joinOf("j1")],
      said: (said, answer) => { if (prompt(said, "j1")) answer(++asked === 1 ? "456" : "123 456"); },
    });
    expect(code).toBe(0);
    expect(asked).toBe(2);
    // no candidates: the terminal shows no digits to pick from
    expect(out.filter((said) => prompt(said, "j1")).join("")).not.toMatch(/[0-9]/);
    expect(sent).toEqual([{ id: "j1", digits: "123456" }]);
  });

  it("ends a join at one wrong entry, never asking for it again, and goes on to the next; Enter by itself sends nothing", async () => {
    const asked: string[] = [];
    const { code, sent } = await joining({
      joins: [joinOf("j1"), joinOf("j2")],
      said: (said, answer) => {
        if (prompt(said, "j1")) { asked.push("j1"); answer("000000"); }
        if (prompt(said, "j2")) { asked.push("j2"); answer(""); }
      },
      approve: () => "wrong_digits",
    });
    expect(code).toBe(0);
    expect(asked).toEqual(["j1", "j2"]);
    expect(sent).toEqual([{ id: "j1", digits: "000000" }]);
  });

  it("stops at a locked or strict PC, says so, and asks about no other join", async () => {
    for (const refusal of ["locked", "strict"] as const) {
      const asked: string[] = [];
      const { code, text, sent } = await joining({
        joins: [joinOf("j1"), joinOf("j2")],
        said: (said, answer) => { if (prompt(said, "j1")) { asked.push("j1"); answer("123456"); } if (prompt(said, "j2")) asked.push("j2"); },
        approve: () => refusal,
      });
      expect(code).toBe(1);
      expect(asked).toEqual(["j1"]);
      expect(sent).toHaveLength(1);
      expect(text).toContain(refusal === "locked" ? "locked" : "safety log");
    }
  });

  it("never says a members join is approved where a block here keeps that device out, on a PC with no list", async () => {
    const { code, out } = await joining({ joins: [{ ...joinOf("j1"), list_held: true }], said: (said, answer) => { if (said.includes("asks to join your account")) answer("123456"); } });
    expect(code).toBe(0);
    expect(out.at(-1)).toStartWith("Tablet one was not let in here: a device was blocked on this PC, and until that block is lifted this PC keeps out every device that came after it. Lift");
    expect(out.join("")).not.toMatch(/Approved:|is let in;/);
  });

  it("approves nothing when its input is not a terminal: it reads no line and sends nothing", async () => {
    const { code, sent, reads } = await joining({ joins: [joinOf("j1")], terminal: false, said: (_said, answer) => answer("123456") });
    expect(code).toBe(1);
    expect([sent, reads]).toEqual([[], 0]);
  });

  describe("a first join: the first device that opens a PC with no member, which only this PC may let in", () => {
    const ASKED_AT = "2026-11-22T11:58:00.000Z";
    const clock = new Date(ASKED_AT).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    // the digits come with a first join (its own window's card shows them); the terminal never does
    const firstOf = (id: string, digits: string) => ({ id, label: id === "f1" ? "Pixel" : "Galaxy", asked_at: ASKED_AT, digits });
    const firstPrompt = (label: string) => `${label} asks to open this PC (from Ovis account acct_1a2b3c4, asked at ${clock}). Type the six digits ${label} shows (one wrong entry ends this request), or press Enter to skip: `;

    it("names the device, the account it comes from and when it asked, shows none of its digits, and lets it in with all six typed", async () => {
      let asked = 0;
      const { code, out, sent } = await joining({
        joins: [firstOf("f1", "482913")], account: "acct_1a2b3c4d5e6f",
        said: (said, answer) => { if (said === firstPrompt("Pixel")) answer(++asked === 1 ? "913" : "482 913"); },
      });
      expect(code).toBe(0);
      expect(asked).toBe(2);
      expect(out[0]).toBe(firstPrompt("Pixel"));
      for (const said of out) expect(said).not.toMatch(/482|913/);
      expect(sent).toEqual([{ id: "f1", digits: "482913" }]);
      expect(out.at(-1)).toBe("Pixel is let in; it opens this PC in a moment.\n");
    });

    it("says only that the approval was received for a join the account's signed list lets in: the device is in once its entry is", async () => {
      const { code, out } = await joining({
        joins: [{ ...firstOf("f1", "482913"), list: true }], account: "acct_1a2b3c4d5e6f",
        said: (said, answer) => { if (said === firstPrompt("Pixel")) answer("482913"); },
      });
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("The approval of Pixel was received. It opens this PC once it is in your account's list, which takes a moment; if it does not, have it ask again.\n");
      expect(out.join("")).not.toContain("is let in");
    });

    it("says that Ovis on this PC needs an update where it is behind its account's list, and never that the device is let in", async () => {
      const { code, out } = await joining({
        joins: [{ ...firstOf("f1", "482913"), list: true, list_behind: true }], account: "acct_1a2b3c4d5e6f",
        said: (said, answer) => { if (said === firstPrompt("Pixel")) answer("482913"); },
      });
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("Pixel was not let in: Ovis on this PC is older than what a device wrote into your account's list, and lets nobody new in until it is updated. Update Ovis on this PC (Settings → Updates), then have Pixel ask again; or allow it on another device of your account.\n");
      expect(out.join("")).not.toMatch(/is let in|was received/);
    });

    it("says that this PC lets nobody into the list itself where it joined by an invite, and never that the approval was received", async () => {
      const { code, out } = await joining({
        joins: [{ ...firstOf("f1", "482913"), list: true, list_not_signer: true }], account: "acct_1a2b3c4d5e6f",
        said: (said, answer) => { if (said === firstPrompt("Pixel")) answer("482913"); },
      });
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("Pixel was not let in: this PC joined your account by an invite, and a PC that did lets nobody into your account's list itself. Allow Pixel on another device of your account.\n");
      expect(out.join("")).not.toMatch(/is let in|was received/);
    });

    it("says that this PC came in as its account moved and has no key of its own in the list, never an invite, and how it gets one", async () => {
      const { code, out } = await joining({
        joins: [{ ...firstOf("f1", "482913"), list: true, list_needs_keys: true }], account: "acct_1a2b3c4d5e6f",
        said: (said, answer) => { if (said === firstPrompt("Pixel")) answer("482913"); },
      });
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("Pixel was not let in: this PC came into your account's list as your account moved, and holds no key of its own in it yet, so it lets nobody into the list itself. Allow Pixel on another device of your account, or run ovis add on this PC to give it its keys (compare the number with a device of your account), then have Pixel ask again.\n");
      expect(out.join("")).not.toMatch(/invite|is let in|was received/);
    });

    it("says that this PC keeps that device out by a block here, whatever the list holds, and where the block is lifted", async () => {
      const { code, out } = await joining({
        joins: [{ ...firstOf("f1", "482913"), list: true, list_held: true }], account: "acct_1a2b3c4d5e6f",
        said: (said, answer) => { if (said === firstPrompt("Pixel")) answer("482913"); },
      });
      expect(code).toBe(0);
      expect(out.at(-1)).toBe("Pixel was not let in here: a device was blocked on this PC, and until that block is lifted this PC keeps out every device that came after it, whether or not your account's list holds it. Lift the block on a device of your account that is older than it and signs in with two-step sign-in, or run ovis recover on this PC, which lists the block with the command that lifts it. Pixel can open this PC after that.\n");
      expect(out.join("")).not.toMatch(/is let in;|was received|not added/);
    });

    it("approves nothing for a join this PC cannot let in, from an app older than its account's list, and says to update that app", async () => {
      const { code, out, sent, reads } = await joining({
        joins: [{ ...firstOf("f1", "482913"), list_unknown: true }], account: "acct_1a2b3c4d5e6f",
        said: (said, answer) => { if (said === firstPrompt("Pixel")) answer("482913"); },
      });
      expect(code).toBe(0);
      expect(sent).toEqual([]);
      expect(reads).toBe(0);
      expect(out.join("")).toBe("Pixel cannot be let in here: this PC lets devices into your account by its signed list, and Pixel asked without its part of that list, as an Ovis older than 0.5.10 does. Update Ovis on Pixel, then have it ask to join again.\n");
    });

    it("says so when the digits are wrong, which ends that join, and how to try again; Enter by itself skips the next and sends nothing", async () => {
      const { code, out, sent } = await joining({
        joins: [firstOf("f1", "482913"), firstOf("f2", "111222")], account: "acct_1a2b3c4d5e6f",
        said: (said, answer) => {
          if (said === firstPrompt("Pixel")) answer("000000");
          if (said === firstPrompt("Galaxy")) answer("");
        },
        approve: () => "wrong_digits",
      });
      expect(code).toBe(0);
      expect(sent).toEqual([{ id: "f1", digits: "000000" }]);
      expect(out).toContain("That is not the number Pixel shows, so it was not let in. To try again, have Pixel ask again, then run ovis approve again.\n");
      expect(out).toContain("Galaxy is left waiting until its time runs out.\n");
    });

    it("says only that the approval was received for every join into the list, a join that is not a first one too, and that Ovis needs an update where this PC is behind", async () => {
      const typed = (said: string, answer: (line: string) => void) => { if (prompt(said, "j1")) answer("123456"); };
      const listed = await joining({ joins: [{ ...joinOf("j1"), list: true }], account: null, said: typed });
      expect(listed.out.at(-1)).toBe("The approval of Tablet one was received. It opens this PC once it is in your account's list, which takes a moment; if it does not, have it ask again.\n");
      expect(listed.out.join("")).not.toContain("joins your account");
      const behind = await joining({ joins: [{ ...joinOf("j1"), list: true, list_behind: true }], account: null, said: typed });
      expect(behind.out.at(-1)).toContain("Update Ovis on this PC");
      expect(behind.out.join("")).not.toMatch(/joins your account|was received/);
    });

    it("leaves out the account when this PC did not say which, and asks about a members join as before", async () => {
      const { out, sent } = await joining({
        joins: [firstOf("f1", "482913"), joinOf("j1")], account: null,
        said: (said, answer) => {
          if (said.startsWith("Pixel asks")) answer("482913");
          if (prompt(said, "j1")) answer("123456");
        },
      });
      expect(out[0]).toBe(`Pixel asks to open this PC (asked at ${clock}). Type the six digits Pixel shows (one wrong entry ends this request), or press Enter to skip: `);
      expect(out).toContain("Approved: Tablet one joins your account once it confirms.\n");
      expect(sent).toEqual([{ id: "f1", digits: "482913" }, { id: "j1", digits: "123456" }]);
    });

    it("where its input is not a terminal, lists each first join with the way to let it in, and approves nothing", async () => {
      const { code, out, sent, reads } = await joining({
        joins: [firstOf("f1", "482913")], account: "acct_1a2b3c4d5e6f", terminal: false,
        said: (_said, answer) => answer("482913"),
      });
      expect(code).toBe(1);
      expect([sent, reads]).toEqual([[], 0]);
      expect(out).toEqual([
        `Pixel asks to open this PC (from Ovis account acct_1a2b3c4, asked at ${clock}). Run ovis approve in a terminal on this PC and type the six digits Pixel shows.\n`,
        "This is not run in a terminal, so no request can be answered here. Nothing was declined: the requests keep waiting. Run this in a terminal to answer them (over ssh, run ssh -t).\n",
      ]);
    });
  });
});
