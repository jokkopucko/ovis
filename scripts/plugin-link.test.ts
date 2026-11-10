import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeAccountService } from "../shared/account-service-fake.ts";
import { encodeOffer } from "../shared/relay-offer.ts";
import { loadRelayIdentity } from "../server/relay/identity.ts";
import { updateStateDir } from "../server/update-state.ts";
import { approveWaiting, COMMAND_ALIASES, link, type WaitingDevice } from "./plugin-link.ts";

const ORIGIN = "http://127.0.0.1:7317";
const SERVICE = "https://account.test";
const RELAY = "wss://relay.test";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function identity() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-link-"));
  scratch.push(dir);
  return loadRelayIdentity(dir);
}

/** The PC's API as the CLI calls it, recording every call; `route` answers what a test cares about. */
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
    /** time a call took */
    pass: (ms: number) => { now += ms; },
    /** what a person does a while later: once the next wait has passed, as it ends */
    after: (act: () => void) => { due.push(act); },
    wait: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      waits.push(ms);
      // A turn, so a test's abort on the last answer lands before the next round. The time passes after it, not as the
      // wait begins: a line typed just before the wait comes at the time it was typed
      await new Promise((resolve) => setTimeout(resolve, 0));
      now += ms;
      const acts = due.splice(0);
      for (const act of acts) act();
      // what was typed just now is handed over before the wait ends
      if (acts.length > 0) await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    },
  };
}

async function* answers(...lines: string[]): AsyncGenerator<string> { for (const line of lines) yield line; }

/** A terminal at which nothing is ever typed. */
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
  const lines: AsyncIterator<string> = {
    next: () => {
      const line = kept.shift();
      return line === undefined ? new Promise((resolve) => { reader = resolve; }) : Promise.resolve({ value: line, done: false });
    },
  };
  return {
    lines,
    type: (rest: string) => { const line = begun + rest; begun = ""; const resolve = reader; reader = null; if (resolve === null) kept.push(line); else resolve({ value: line, done: false }); },
    begin: (text: string) => { begun += text; },
    discard: () => { discards++; begun = ""; kept.length = 0; return true; },
    /** how often the terminal's input was discarded */
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
    // drawn as a QR code in the terminal: block characters, two module rows to a line
    expectQrCode(text);
    // renewed when the pair ran out, as the Settings view does, and the code taken back on the way out
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
    let cancelled = 0;
    const local = localPc((request, path) => {
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/code") return Response.json({ code: "ABCD-EFGH-JK", expires_at: new Date(Date.now() + 600_000).toISOString(), server_id: pc.server_id });
      if (path === "/api/relay/offer") return Response.json({ url: "https://app.ovis.sh/s/x/#offer=garbage" });
      if (path === "/api/devices/pair/cancel") { cancelled++; return Response.json({ ok: true }); }
      return undefined;
    });
    const out: string[] = [];
    expect(await link(["--code"], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text) => out.push(text), signal: new AbortController().signal, lines: answers(), accountService: SERVICE })).toBe(1);
    expect(cancelled).toBe(1);
  });

  it("--code takes back the pairing a renewal started when it fails before its QR code came", async () => {
    const pc = identity();
    const time = clock();
    let offers = 0;
    const cancels: unknown[] = [];
    const local = localPc(async (request, path) => {
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/code") return Response.json({ code: "ABCD-EFGH-JK", expires_at: new Date(time.now() + 600_000).toISOString(), server_id: pc.server_id });
      if (path === "/api/relay/offer") {
        if (++offers === 2) return Response.json({ error: { code: "internal_error", message: "internal error (x)" } }, { status: 500 });
        return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: "111111" }, "https://app.ovis.sh"), expires_at: new Date(time.now() + 600_000).toISOString() });
      }
      if (path === "/api/devices/pair/cancel") { cancels.push(await request.json()); return Response.json({ ok: true }); }
      return undefined;
    });
    expect(await link(["--code"], { origin: ORIGIN, headers: {}, fetch: local.fetch, out: () => undefined, signal: new AbortController().signal, now: time.now, wait: time.wait, lines: answers(), accountService: SERVICE })).toBe(1);
    // not the first round's 111111: the renewal's /api/relay/code started a pairing whose code never came back
    expect(cancels).toEqual([{}]);
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
    expect(text).toContain("No code to type");
    expectQrCode(text);
    expect(text).toContain(pc.server_id.match(/.{4}/g)!.join(" "));
    // the QR code's own six-digit code is taken back too
    expect(cancelled).toBe(1);
  });

  /** `link` against a PC that a phone adds once the PC is signed in; `approve` plays the person finishing the sign-in shown. */
  async function linkToAccount(options: { args?: string[]; prepare?: (service: FakeAccountService) => void; approve: (service: FakeAccountService, code: string) => void; enforcing?: boolean }) {
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
      // a relay asking for a pass refuses this PC until it named its account
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: options.enforcing && named === null ? "error" : "online", blocked: null });
      if (path === "/api/account/relay-account") { named = (await request.json() as { account: string }).account; return new Response(null, { status: 204 }); }
      if (path === "/api/relay/link") {
        // approved on this PC only, as the add-me screen asks
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
      accountService: SERVICE, serviceFetch: (input, init) => service.fetch(new Request(input, init)), lines: keys.lines, terminal: true, discard: keys.discard,
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown) options.approve(service, shown[1]!);
        // the answer, typed once the digits were on the screen long enough to compare
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

  /**
   * `link` signed in to acct_1 and waiting; `status` answers each look at the account, by the count of pairing polls
   * so far and the time since this PC was listed (the waiting began). `down`: when the PC's server refuses every connection.
   */
  async function waiting(status: (polls: number, elapsed: number) => { account: string | null; enrolling?: boolean }, down: (elapsed: number) => boolean = () => false, latency: number | ((polls: number, elapsed: number) => number) = 0) {
    const pc = identity();
    const time = clock();
    let began: number | null = null;
    const elapsed = () => began === null ? -1 : time.now() - began;
    const service = new FakeAccountService(time.now);
    let polls = 0;
    const writes: string[] = [];
    // when the approve-here window was asked for, and the accounts this PC was told it asks its relay pass under
    const linkAt: number[] = [];
    // when this PC was put in the account's list
    const putAt: number[] = [];
    const named: string[] = [];
    const local = localPc(async (request, path) => {
      if (down(elapsed())) throw new TypeError("connection refused");
      if (path === "/api/account/status") return Response.json({ unlinked: [], removals: [], adds: [], blocked: [], ...status(polls, elapsed()) });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/account/relay-account") { named.push((await request.json() as { account: string }).account); return new Response(null, { status: 204 }); }
      if (path === "/api/relay/link") { began ??= time.now(); linkAt.push(elapsed()); }
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      // `latency`: how long each look for a request takes to be answered
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
    // in the account after 40 polls: 80 seconds of waiting
    const { code, calls, writes, pc } = await waiting((polls) => ({ account: polls >= 40 ? "acct_1" : null }));
    expect(code).toBe(0);
    const order = calls.filter((call) => call.path === "/api/relay/link" || call.path === "/api/relay/pairings").map((call) => call.path === "/api/relay/link" ? "link" : "poll");
    // the listing's own, then one each time 30 seconds of 2-second waits have passed (the first poll comes before any wait)
    expect(order.join(" ")).toBe(["link", ...Array(16).fill("poll"), "link", ...Array(15).fill("poll"), "link", ...Array(9).fill("poll")].join(" "));
    for (const call of calls.filter((entry) => entry.path === "/api/relay/link")) {
      expect(call.method).toBe("POST");
      expect(call.headers.get("x-ovis-local-only")).toBe("1");
      expect(call.body).toBe("{}");
    }
    // the directory heard of this PC once, when it was listed: reopening the window writes nothing there
    expect(writes).toEqual([`PUT /v1/pcs/${pc.server_id} at poll 0`]);
  });

  it("stops by itself after 30 minutes of waiting", async () => {
    const { code, out, time, polls } = await waiting(() => ({ account: null }));
    expect(code).toBe(1);
    expect(out.at(-1)).toBe("Stopped waiting after 30 minutes. Run this again to keep waiting.\n");
    expect(time.waits.filter((ms) => ms === 2_000)).toHaveLength(900);
    expect(polls()).toBe(901);
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
      // each look takes that long, so the 30-second openings drift off the 20-minute mark
      const { code, linkAt, writes } = await waiting(() => ({ account: null }), () => false, latency);
      expect(code).toBe(1);
      // the last window ends within two looks of the run's end, and never after it
      expect(Math.max(...linkAt)).toBeLessThanOrEqual(20 * 60_000);
      expect(Math.max(...linkAt)).toBeGreaterThan(20 * 60_000 - 2 * (2_000 + latency));
      // and the listing is renewed with it, once
      expect(writes.filter((write) => write.startsWith("PUT")).length).toBe(4);
    }
  // seven runs of 30 minutes: more than the default five seconds on a busy host
  }, 60_000);

  it("asks for its last window and lists this PC anew in time when a look near the end takes longer than every look before it", async () => {
    const cutoff = 20 * 60_000;
    const runs: [string, (polls: number, elapsed: number) => number, number][] = [
      // every look is answered at once until minute 20, where one takes three seconds
      ["one slow look at the end", (_polls, elapsed) => elapsed >= cutoff ? 3_000 : 0, 3_000],
      // quick for 19 minutes 50 seconds, then four seconds a look
      ["slow from just before the end", (_polls, elapsed) => elapsed >= cutoff - 10_000 ? 4_000 : 100, 4_000],
      // no two looks alike
      ["uneven all the way", (polls) => [0, 2_700, 400, 5_100, 900, 50, 3_300][polls % 7]!, 5_100],
      ["slower and slower", (_polls, elapsed) => Math.floor(elapsed / 60_000) * 250, 5_000],
    ];
    for (const [name, latency, slowest] of runs) {
      const { code, linkAt, putAt } = await waiting(() => ({ account: null }), () => false, latency);
      expect([name, code]).toEqual([name, 1]);
      // never a window that outlives the run, and the last one is asked for by the last look that came in time
      expect([name, Math.max(...linkAt) <= cutoff]).toEqual([name, true]);
      expect([name, Math.max(...linkAt) > cutoff - (2_000 + slowest)]).toEqual([name, true]);
      // the PC is listed anew in the last half minute before that, and not after it
      expect([name, Math.max(...putAt) >= cutoff - 30_000 && Math.max(...putAt) <= cutoff]).toEqual([name, true]);
    }
  }, 60_000);

  it("does not call this PC added when it turns out to be in another account after a late unanswered call", async () => {
    // one call fails at minute 25, and the status read first then names another account
    const { code, out, writes, pc } = await waiting((_polls, elapsed) => ({ account: elapsed >= 25 * 60_000 ? "acct_other" : null }), (elapsed) => elapsed >= 25 * 60_000 && elapsed < 25 * 60_000 + 1_000);
    expect(code).toBe(1);
    expect(out.at(-1)).toContain("This PC joined another Ovis account (acct_other)");
    expect(out.join("")).not.toContain("this PC is in your account");
    expect(writes.at(-1)).toMatch(new RegExp(`^DELETE /v1/pcs/${pc.server_id} `));
  });

  it("waits for an Ovis server that restarts, and asks for its window again with the first call it answers", async () => {
    // refusing connections from 40 s to 50 s; in the account a minute in
    const { code, out, calls, linkAt } = await waiting((_polls, elapsed) => ({ account: elapsed >= 60_000 ? "acct_1" : null }), (elapsed) => elapsed >= 40_000 && elapsed < 50_000);
    expect(code).toBe(0);
    expect(out.filter((text) => text.includes("not answering"))).toEqual(["The Ovis on this PC is not answering (is it restarting?). Waiting for it…\n"]);
    expect(out.filter((text) => text.includes("answers again"))).toHaveLength(1);
    // the listing's own, the 30-second one, then at once when the server is back (a restarted server has no window)
    expect(linkAt).toEqual([0, 30_000, 50_000]);
    // while it was away only the window was asked for: one poll failed, then nothing else was tried
    const paths = calls.map((call) => call.path);
    const lost = paths.indexOf("/api/relay/pairings", paths.lastIndexOf("/api/relay/link") - 6);
    expect(paths.slice(lost, lost + 7)).toEqual(["/api/relay/pairings", ...Array(5).fill("/api/relay/link"), "/api/relay/pairings"]);
    expect(out.at(-1)).toBe("This PC is in your account (acct_1): every device of your account can use it.\n");
  });

  it("stops when the server goes away too late in the run to ask for its window again", async () => {
    const { code, out, linkAt } = await waiting(() => ({ account: null }), (elapsed) => elapsed >= 25 * 60_000);
    expect(code).toBe(1);
    expect(out.at(-1)).toBe("The Ovis on this PC stopped answering, too close to this run's 30 minutes to open its approval window again. Run this again once it is back.\n");
    expect(Math.max(...linkAt)).toBe(20 * 60_000);
  });

  it("ends well when one call went unanswered late in the run and this PC is in the account by then", async () => {
    // added at minute 25, where a single call times out: not a restart, and nothing is left to open a window for
    let failed = 0;
    const { code, out, linkAt } = await waiting((_polls, elapsed) => ({ account: elapsed >= 25 * 60_000 ? "acct_1" : null }), (elapsed) => elapsed >= 25 * 60_000 && failed++ === 0);
    expect(code).toBe(0);
    expect(out.at(-1)).toBe("This PC is in your account (acct_1): every device of your account can use it.\n");
    expect(out.join("")).not.toContain("too close to this run's 30 minutes");
    expect(Math.max(...linkAt)).toBe(20 * 60_000);
  });

  it("keeps waiting for the account's other devices over a server restart, without asking for a window", async () => {
    const { code, linkAt } = await waiting((polls, elapsed) => ({ account: polls >= 2 ? "acct_1" : null, enrolling: elapsed < 60_000 }), (elapsed) => elapsed >= 20_000 && elapsed < 40_000);
    expect(code).toBe(0);
    // in the account: nothing is left to approve
    expect(linkAt).toEqual([0]);
  });

  it("keeps waiting while the account's other devices are brought in, saying so once, and ends well when they are", async () => {
    const { code, out, polls } = await waiting((polls) => ({ account: polls >= 3 ? "acct_1" : null, enrolling: polls >= 3 && polls < 8 }));
    expect(code).toBe(0);
    expect(polls()).toBe(8);
    expect(out.filter((text) => text.includes("Bringing in"))).toEqual(["Added. Bringing in your account's other devices…\n"]);
    expect(out.at(-1)).toBe("This PC is in your account (acct_1): every device of your account can use it.\n");
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
    // never done within the 30 minutes: it fails, and says where the wait is
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
    // the account that signed in no longer lists a PC it cannot add, and the PC names the account it is in
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
      prepare: (service) => service.offer(["google"], ["google"]),
      approve: (service, shown) => service.approveDevice(shown, "acct_1"),
    });
    expect(code).toBe(0);
    expect(text).toContain("https://www.google.com/device");
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
  async function prompting(options: { pending: (polls: number, decisions: { id: string; decision: string }[]) => string[]; said: (text: string, type: (line: string) => void, answer: (line: string) => void) => void; terminal?: boolean; decide?: (attempt: number) => void; joined?: (decisions: { id: string; decision: string }[]) => boolean; refuse?: (waits: number) => boolean; called?: (path: string, type: (line: string) => void, polls: number) => void; lines?: AsyncIterator<string>; request?: (id: string) => { label?: string; digits?: string }; discard?: (() => boolean) | null; keys?: ReturnType<typeof keyboard> }) {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    const keys = options.keys ?? keyboard();
    let refused = 0;
    let polls = 0;
    let attempts = 0;
    const decisions: { id: string; decision: string }[] = [];
    const local = localPc(async (request, path) => {
      // the PC's server is down: every call is refused
      if (options.refuse?.(time.waits.length)) { if (++refused > 200) throw new Error("the loop spins without waiting"); throw new TypeError("connection refused"); }
      // typed while this call is on its way
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
      // the terminal's input can be discarded, unless a test says it cannot (`null`: no way to; or a way that fails)
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
    // asked once, and the prompt's line is ended before the last word
    expect(out.filter((text) => text.includes("Enter to decline"))).toHaveLength(1);
    expect(out.at(-1)).toBe("\nStopped waiting after 30 minutes. Run this again to keep waiting.\n");
    expect(decisions).toEqual([]);
    // the waiting went on under the prompt: every poll, and the window every 30 seconds until the last ten minutes,
    // with every look of the half minute before them
    expect(polls()).toBe(901);
    expect(calls.filter((call) => call.path === "/api/relay/link")).toHaveLength(41 + 14);
  });

  it("drops a request that stopped waiting at its prompt, and never takes a line typed after it as the answer to the next", async () => {
    const { code, out, decisions } = await prompting({
      // p1 for three polls, nothing for two, then p2 until it is answered
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 5 || decisions.length > 0 ? [] : ["p2"],
      said: (text, type, answer) => {
        // typed too late: nothing is asked about any more
        if (text.includes("Phone p1 is no longer waiting")) type("222");
        if (text.includes("Phone p2 wants")) answer("");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((text) => text.includes("Enter to decline")).map((text) => text.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(out).toContain("\nPhone p1 is no longer waiting.\n");
    // the late line approved nothing: p2 got the answer typed at its own prompt
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  it("never takes a line typed for a request that went away as the answer to the next one shown in the same look", async () => {
    const { code, out, decisions } = await prompting({
      // p1 for three polls, then p2 in the very poll that drops p1
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      said: (text, type, answer) => {
        // meant for p1, sent as its prompt ends: p2's digits were never on the screen
        if (text.includes("Phone p1 is no longer waiting")) type("222");
        if (text.includes("Phone p2 wants")) answer("");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((text) => text.includes("Enter to decline")).map((text) => text.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    // the line approved nothing: p2 got the answer typed at its own prompt
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  it("never takes a line begun under a request that went away as the answer to the next one: it answers nothing, also when it comes right after the next prompt", async () => {
    let shown = 0;
    const { code, out, text, decisions } = await prompting({
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      said: (said, type, answer) => {
        // the line begun at p1's prompt is sent only as p2's prompt comes on the screen; the answer to p2 follows its second showing
        if (said.includes("Phone p2 wants")) { if (++shown === 1) type("222"); else answer(""); }
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(text).toContain("That line answered nothing: a request went away while it may have been typed.");
    // p2 is asked again under the notice
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  // In canonical mode the terminal hands a line over when Enter is pressed, and it is stamped then: what was typed at
  // p1's prompt and not sent comes with the Enter pressed at p2's, however long after p2's prompt showed
  it("never takes a line begun at a request that went away as the answer to the next one, also when its Enter comes two seconds after the next prompt", async () => {
    for (const gap of [false, true]) {
      // what the terminal held: a y, the digits (the two requests show the same ones here), or nothing (a bare Enter)
      for (const held of ["y", "222", "111 222", ""]) {
        let shown = 0;
        const { code, out, text, decisions } = await prompting({
          // p1 for three polls; p2 in the very look that drops p1, or two looks later
          pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : gap && polls <= 5 ? [] : ["p2"],
          said: (said, _type, answer) => {
            // the Enter two seconds after p2's prompt sends the held line; p2's own answer follows its second showing
            if (said.includes("Phone p2 wants")) answer(++shown === 1 ? held : "");
          },
          joined: (decisions) => decisions.length > 0,
        });
        expect(code).toBe(0);
        expect(out.filter((said) => said.includes("That line answered nothing: a request went away while it may have been typed. Answer again for the request shown now."))).toHaveLength(1);
        expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
        // the held line decided nothing, neither way: p2 got the answer typed at its second showing
        expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
        expect(text).not.toContain("Approved");
      }
    }
  }, 30_000);

  it("drops the line held at a request that went away when its Enter comes while nothing is asked, and only that one", async () => {
    const { code, out, decisions } = await prompting({
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 6 || decisions.length > 0 ? [] : ["p2"],
      said: (said, _type, answer) => {
        // Enter after p1 went: the line held at its prompt comes while nothing is asked
        if (said.includes("Phone p1 is no longer waiting")) answer("222");
        // p2's answer is then the first line typed at its prompt: all six, as p1 showed the same digits
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
        // Enter as p1 shows (dropped, too soon); its digits are then typed and not sent
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
      // Enter at p1's prompt while the look that finds p1 gone is on its way; more is then typed, and not sent
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
  /** What is said of three or six digits that are not the request's: whose they are not, and that Enter declines. */
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
    // other digits in the same width are still other digits, and a wide space by itself is Enter by itself
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
          // the line that is no answer first; what is typed under the question asked again decides
          said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++asked === 1 ? line : then); },
          joined: (decisions) => decisions.length > 0,
        });
        expect(code).toBe(0);
        // said in one line, and asked again under it. Digits of another value are said to be just that
        const told = /^(\d{3}|\d{6})$/.test(line) ? otherDigits(line, "Phone p1", "111222") : NOT_AN_ANSWER;
        expect([line, out.filter((said) => said.startsWith("That line answered nothing") || said.includes("Enter to decline"))]).toEqual([line, [PROMPT, told, PROMPT]]);
        // the line itself decided nothing: the request still waited for the answer typed after it
        expect([line, decisions]).toEqual([line, [{ id: "p1", decision: then === "" ? "decline" : "approve" }]]);
      }
    }
  }, 60_000);

  it("leaves a request waiting when only lines that are no answer were typed at it", async () => {
    const { code, out, decisions } = await prompting({
      pending: () => ["p1"],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer("y"); },
    });
    // never answered: it runs out by itself, as a request nobody answered does
    expect(code).toBe(1);
    expect(decisions).toEqual([]);
    expect(out.filter((said) => said === NOT_AN_ANSWER).length).toBeGreaterThan(1);
  });

  it("approves nothing with another request's digits: neither the ones answered before, nor the same device's earlier ones", async () => {
    // the same phone asks twice: the same label, other digits
    const request = (id: string) => ({ label: "Phone", digits: id === "p1" ? "111222" : "333444" });
    let second = 0;
    const first = await prompting({
      request,
      // p1 is answered, then p2 shows
      pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
      // p1's digits at both; under p2's question asked again, Enter
      said: (said, _type, answer) => { if (said.includes("111 222")) answer("222"); if (said.includes("333 444")) answer(++second === 1 ? "222" : ""); },
      joined: (decisions) => decisions.length > 1,
    });
    expect(first.code).toBe(0);
    expect(first.out.filter((said) => said.startsWith("That line answered nothing"))).toEqual([otherDigits("222", "Phone", "333444")]);
    expect(first.decisions).toEqual([{ id: "p1", decision: "approve" }, { id: "p2", decision: "decline" }]);
    // p1 goes away with its digits typed and not sent; they come at p2's prompt, and are typed there again
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
    // the first was dropped as begun at p1, the second is no answer to p2
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
          // p1 is answered; p2 comes after it
          pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
          said: (said, _type, answer) => {
            if (said.includes("Phone p1 wants")) answer("456");
            // the three digits that approved p1, typed once more; then all six, p1's six, or Enter
            if (said.includes("Phone p2 wants") && ++asked <= 2) answer(asked === 1 ? "456" : then);
          },
          joined: (decisions) => decisions.length > 1,
        });
        expect(prompts(out).slice(0, 3)).toEqual([short("p1", "111456"), whole("p2", "222456"), whole("p2", "222456")]);
        // its own last three name neither request; p1's six are another request's digits, and said to be
        expect(out.filter((said) => said.startsWith("That line answered nothing")).slice(0, 2)).toEqual([SIX_ONLY, ...decision === null ? [otherDigits("111456", "Phone p2", "222456")] : []]);
        expect([then, decisions]).toEqual([then, [{ id: "p1", decision: "approve" }, ...decision === null ? [] : [{ id: "p2", decision }]]]);
      }
    }, 30_000);

    it("is approved only by all six when the other one went away unanswered: the line held at that one is dropped, and the same line typed again approves nothing", async () => {
      let asked = 0;
      const { code, out, decisions } = await prompting({
        request,
        // p1 for three polls; p2 in the very look that drops p1
        pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
        // p1's answer comes with the Enter pressed at p2's prompt, and is typed again; then p2's own six
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
        // p2 waits alone and is asked with its last three; from the third look the person's own request p1 waits beside it
        pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 2 ? ["p2"] : ["p2", "p1"],
        // 456, read off p1's device; then p2's own six
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
        // p2 alone at the look that asks about it; p1 comes while the person types
        pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 1 ? ["p2"] : ["p2", "p1"],
        said: (said, _type, answer) => {
          // 456, read off p1's device
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
        // p3 (333 789) is answered, then p1; p1's first answer does not reach the server, so it is asked again
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
        // the question asks for no digits, and what it shows typed back at it is no answer
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
      // down from the third wait, for ten waits
      refuse: (waits) => { if (waits >= 3) downAt ??= waits; return downAt !== null && waits < downAt + 10; },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(text).toContain("The Ovis on this PC answers again.");
    // one refused call a look, not thousands between two waits
    expect(refused()).toBeLessThanOrEqual(11);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
  });

  const LOST = "That line answered nothing: the answer before it may not have reached the Ovis on this PC, and it may have been typed meanwhile. Answer again for the request shown now.\n";

  it("asks about a request again when its answer did not reach the server, rather than skipping it or sending the old answer", async () => {
    let prompts = 0;
    const { code, text, out, decisions, calls } = await prompting({
      pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
      // its digits; then, asked again, Enter twice: the first may have been typed while the answer was on its way
      said: (said, _type, answer) => { if (said.includes("Enter to decline")) answer(++prompts === 1 ? "222" : ""); },
      // the first answer's call is never answered
      decide: (attempt) => { if (attempt === 1) throw new TypeError("timed out"); },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("Enter to decline"))).toHaveLength(3);
    expect(out.filter((said) => said === LOST)).toHaveLength(1);
    expect(text).toContain("Your answer may not have reached the Ovis on this PC. Phone p1 is asked about again if it is still waiting.");
    expect(calls.filter((call) => call.path === "/api/relay/pairing").map((call) => JSON.parse(call.body))).toEqual([{ id: "p1", decision: "approve" }, { id: "p1", decision: "decline" }]);
    // what the server took is the answer typed under the question asked again
    expect(decisions).toEqual([{ id: "p1", decision: "decline" }]);
  });

  it("answers nothing with the first line after an answer that did not reach the server: typed meanwhile, it never answers the request shown next", async () => {
    for (const typed of ["", "456", "111456", "789"]) {
      let lost = false;
      let asked = 0;
      const { code, out, decisions } = await prompting({
        request: (id) => ({ digits: id === "p1" ? "111456" : "222789" }),
        // the server took p1's answer although its call was never answered: p1 waits no more, and p2 shows
        pending: (_polls, decisions) => !lost ? ["p1"] : decisions.length > 0 ? [] : ["p2"],
        decide: (attempt) => { if (attempt === 1) { lost = true; throw new TypeError("timed out"); } },
        said: (said, _type, answer) => {
          if (said.includes("Phone p1 wants")) answer("456");
          // typed while the server did not answer, sent two seconds after p2's prompt; p2's own answer follows
          if (said.includes("Phone p2 wants") && ++asked <= 2) answer(asked === 1 ? typed : "789");
        },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect(out.filter((said) => said === LOST)).toHaveLength(1);
      expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
      // the line typed meanwhile decided nothing, neither way: p2 got the answer typed at its second showing
      expect([typed, decisions]).toEqual([typed, [{ id: "p2", decision: "approve" }]]);
    }
  }, 30_000);

  it("approves nothing with a line typed twice after its request went away: the second never waits for the next request", async () => {
    const { code, out, text, decisions } = await prompting({
      // p1 for three polls, nothing for two, then p2 with other digits to compare
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 5 || decisions.length > 0 ? [] : ["p2"],
      said: (said, type) => {
        // too late for p1, and once more when nothing seemed to happen: a terminal keeps the second for the next read
        if (said.includes("Phone p1 is no longer waiting")) { type("222"); type("222"); }
      },
    });
    // p2 was asked about and never answered
    expect(code).toBe(1);
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(decisions).toEqual([]);
    // and the lines that went nowhere are said to have
    expect(text).toContain("That line answered nothing: no request is waiting for an answer.");
  });

  it("approves nothing with a line typed twice as its request gives way to the next in one look", async () => {
    const { code, out, decisions } = await prompting({
      pending: (polls) => polls <= 3 ? ["p1"] : ["p2"],
      said: (said, type) => { if (said.includes("Phone p1 is no longer waiting")) { type("222"); type("222"); } },
    });
    expect(code).toBe(1);
    // both are dropped above p2's prompt, which shows once
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
          // typed ahead, twice, and an empty line that would decline
          if (said.includes(when)) { type("222"); type("222"); type(""); }
          // the answer at the prompt that follows the notice
          if (said.includes("Phone p1 wants") && !answered) { answered = true; answer(""); }
        },
        joined: (decisions) => decisions.length > 0,
      });
      expect(code).toBe(0);
      expect(text).toContain("That line answered nothing");
      // p1 is shown once, and what answers it is the line typed there
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
            // typed while this PC waits for its first request, and not sent
            if (said.includes("Its request shows here to approve")) keys.begin(begun);
            // Enter two seconds after the prompt, with the rest typed first; asked again, Enter
            if (said.includes("Phone p1 wants")) answer(++asked === 1 ? rest : "");
          },
          joined: (decisions) => decisions.length > 0,
        });
        expect(code).toBe(0);
        expect(text).not.toContain("Approved");
        // what the Enter sent is what was typed after the prompt: nothing (a decline), or a rest that is no answer
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
          // the digits the next phone shows, typed before this PC asks about it
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
          // a y first; the digits are begun as the line saying it is no answer comes, and finished under the prompt shown again
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
              // the first Enter sends what was begun, or a first answer that could have been; the digits typed after that count
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
      // p1 is known from the first poll; its prompt comes after the look at the account that follows
      called: (path, type, polls) => { if (path === "/api/account/status" && polls === 1 && !typedAhead) { typedAhead = true; type("222"); } },
      said: () => undefined,
    });
    expect(typedAhead).toBe(true);
    expect(code).toBe(1);
    expect(decisions).toEqual([]);
    // said above the prompt, which then shows once
    expect(text).toContain("That line answered nothing: it was typed before the request shown now was asked about.");
    expect(out.filter((said) => said.includes("Enter to decline"))).toHaveLength(1);
  });

  it("answers one request with one line: a second line at its prompt never answers the next request", async () => {
    const { code, out, decisions } = await prompting({
      pending: (_polls, decisions) => decisions.length === 0 ? ["p1"] : decisions.length === 1 ? ["p2"] : [],
      said: (said, _type, answer) => {
        // its digits for p1, and Enter once more: an empty line would decline p2 unseen
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
      // said once, with the way out for someone who is at a terminal after all
      expect(out.filter((said) => said.includes("This is not run in a terminal"))).toEqual(["This is not run in a terminal, so no request can be answered here: each is declined as it shows. Run this in a terminal to approve one (over ssh, run ssh -t).\n"]);
      // each is shown, and declined at once: no line was typed at its prompt
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
    // said once, before the first request is declined
    expect(out.filter((said) => said.includes("This is not run in a terminal"))).toHaveLength(1);
    expect(text.indexOf("This is not run in a terminal")).toBeLessThan(text.indexOf("Phone p1 wants"));
  });

  it("approves nothing with a second line typed right after an answer: the next request's prompt was only just shown", async () => {
    let again = false;
    const { code, out, text, decisions } = await prompting({
      // p1 and p2 wait together: p2's prompt shows in the look that sends p1's answer
      pending: (_polls, decisions) => decisions.length === 0 ? ["p1", "p2"] : ["p2"],
      said: (said, type, answer) => {
        // all six: the two show the same digits here
        if (said.includes("Phone p1 wants")) answer("111222");
        // the digits and Enter once more, a moment after the first: p2's were not compared
        if (said.includes("Phone p2 wants") && !again) { again = true; type("111222"); }
      },
    });
    // p2 was asked about, again under the notice, and never answered
    expect(code).toBe(1);
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
    expect(text).toContain("That line answered nothing: it came as the request showed, too soon to have compared its digits.");
    expect(out.filter((said) => said.includes("Enter to decline")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
  });

  it("asks once more for the answer to a request that follows one that went away, however long after: the first line may have been begun at that one", async () => {
    const { code, out, decisions } = await prompting({
      // p1 runs out after three polls; p2 comes minutes later
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 200 || decisions.length > 0 ? [] : ["p2"],
      said: (said, _type, answer) => { if (said.includes("Phone p2 wants")) answer("111222"); },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    // one line is dropped, once: the answer typed under the notice counts
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
      // Ctrl+D while waiting for the phone
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
        // the renewal is due after nine minutes of polls (2 s each): its PUT fails, and this PC is added before the next look
        if (polls === 271) failPuts = true;
        if (polls === 272) { account = "acct_1"; enrolling = true; }
        // the account service takes writes again
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
    // off the list while the service refused the PUT, and back with the first look after it, two looks before the run ended
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
        // the renewal is due after nine minutes of polls (2 s each); its PUT fails once
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
        // the renewal is due after nine minutes of polls (2 s each)
        if (++polls === 271) loseDelete = true;
        // it keeps waiting, and the listing is back on the next round
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

  const PHONE = { id: "00000000000000a1", label: "Hako's iPhone", role: "drive", created_at: "2026-11-06T12:00:30.000Z", last_seen_at: null, current: false, via_relay: true };
  const OLD = { id: "00000000000000b2", label: "Old tablet", role: "drive", created_at: "2026-10-01T09:00:00.000Z", last_seen_at: null, current: false, via_relay: true };
  /** A row of GET /api/devices: `account` only on a member of the PC's account, `via_relay` only on one paired through the relay. */
  type Row = Omit<typeof PHONE, "via_relay"> & { via_relay?: true; account?: string; added_by?: string };
  // the phone once it linked itself: a member of the account, which the account's key vouches for
  const MEMBER: Row = { ...PHONE, via_relay: true, account: "acct_1" };
  // a device that typed the QR code's six digits at this PC's own address
  const DIRECT: Row = { id: "00000000000000c3", label: "Tailnet laptop", role: "drive", created_at: "2026-11-06T12:00:40.000Z", last_seen_at: null, current: false };

  /**
   * `add` signed in to acct_1 and showing its QR code. `step` plays what happens to the PC before each look at its
   * account (`looks` so far, and the time since the first code); `said` hears every line, to `type` a line at that
   * very moment or to `answer` after the next wait (two seconds: time to read the question), or after that many waits.
   */
  async function scanning(options: {
    args?: string[]; isTty?: boolean; terminal?: boolean; size?: () => { rows: number; columns: number };
    step?: (pc: { account: string | null; enrolling: boolean; devices: Row[] }, looks: number, elapsed: number, stop: AbortController) => void;
    said?: (text: string, type: (line: string) => void, answer: (line: string, waits?: number) => void, stop: AbortController, begin: (text: string) => void) => void;
    /** the terminal's input can be discarded (tcflush), as on Linux and macOS */
    discard?: boolean;
    cancel?: () => Response;
    /** an answer to a removal instead of the PC's own; with none, what happens to the PC as the removal is on its way */
    revoke?: (pc: { account: string | null; enrolling: boolean; devices: Row[] }, id: string) => Response | undefined;
    /** an answer the PC gives instead of its own, by the path and the codes shown so far; one that throws is a PC that does not answer */
    refuse?: (path: string, codes: number) => Response | undefined;
    /** the account service's answer to one call, instead of `pass()` */
    service?: (request: Request, pass: () => Promise<Response>, at: { pc: ReturnType<typeof identity>; stop: AbortController; now: () => number }) => Promise<Response>;
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
    // the six-digit codes the QR codes carried, what was taken back, and the devices revoked
    const offers: string[] = [];
    // how long after the first code each one came
    const renewedAt: number[] = [];
    const cancels: unknown[] = [];
    const revoked: string[] = [];
    // the accounts this PC was told to ask its relay pass under
    const named: unknown[] = [];
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
      if (path === "/api/relay/code") return Response.json({ code: `ABCD-EFGH-J${offers.length + 1}`, expires_at: new Date(time.now() + 600_000).toISOString(), server_id: pc.server_id });
      if (path === "/api/relay/offer") {
        began ??= time.now();
        offers.push(String(100001 + offers.length));
        renewedAt.push(time.now() - began);
        return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, code: offers.at(-1)! }, "https://app.ovis.sh"), expires_at: new Date(time.now() + 600_000).toISOString() });
      }
      if (path === "/api/devices/pair/cancel") { cancels.push(await request.json()); return options.cancel?.() ?? Response.json({ ok: true, cancelled: true }); }
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
    const code = await link(options.args ?? [], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: stop.signal,
      accountService: SERVICE, lines: keys.lines,
      serviceFetch: (input, init) => {
        const request = new Request(input, init);
        return options.service ? options.service(request, () => service.fetch(request), { pc, stop, now: time.now }) : service.fetch(request);
      },
      terminal: options.terminal ?? true, isTty: options.isTty ?? true, ...options.size ? { size: options.size } : {},
      ...options.discard === true ? { discard: keys.discard } : {},
      out: (text) => {
        out.push(text);
        // the sign-in's code, not the pairing code shown later
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown && !approved) { approved = true; service.approveDevice(shown[1]!, "acct_1"); }
        const later = (line: string, waits: number): void => time.after(() => { if (waits <= 1) keys.type(line); else later(line, waits - 1); });
        options.said?.(text, keys.type, (line, waits = 1) => later(line, waits), stop, keys.begin);
      },
    });
    const paths = local.calls.map((call) => `${call.method} ${call.path}`);
    return { code, out, text: out.join(""), offers, renewedAt, cancels, revoked, named, service, pc, time, paths, looks: () => looks, discards: keys.discards };
  }

  const ON = "\x1b[?1049h";
  const OFF = "\x1b[?1049l";

  it("ends in one QR code: a signed-in device that scans it adds this PC, and the command names the account and that device", async () => {
    const { code, out, text, offers, cancels, service, pc, paths } = await scanning({
      step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } },
    });
    expect(code).toBe(0);
    expect(service.pcs("acct_1").map((entry) => entry.server_id)).toEqual([pc.server_id]);
    // asked for only once the PC is listed and its relay is online, the code before the offer
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
    // on the terminal's other screen, which is left before anything else is said: the code is gone from the terminal
    expect(drawn.startsWith(`${ON}\x1b[2J\x1b[H`)).toBe(true);
    expect(out.slice(out.indexOf(drawn) + 1)).toEqual([OFF, "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n"]);
    // one code, taken back, and nothing approved here: no request is looked for
    expect(offers).toEqual(["100001"]);
    expect(cancels).toEqual([{ code: "100001" }]);
    expect(paths).not.toContain("GET /api/relay/pairings");
    // the sign-in ends with the run
    expect(service.pcs("acct_1").length).toBe(1);
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
    // --print on a terminal too: lines that stay, for a window that cannot hold the screen
    const onTty = await scanning({ args: ["--print"], step: (state, looks) => { if (looks === 1) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } } });
    expect(onTty.text).not.toContain("\x1b");
  });

  it("shows three codes at most, one as the last runs out, then stops after 30 minutes with the last taken back", async () => {
    const { code, out, text, offers, cancels, time } = await scanning();
    expect(code).toBe(1);
    expect(offers).toEqual(["100001", "100002", "100003"]);
    expect(text).toContain("ABCD-EFGH-J3");
    // each drawn over the one before, on the one screen entered once
    expect(out.filter((line) => line.includes(ON)).length).toBe(1);
    expect(out.filter((line) => line.startsWith("\x1b[2J\x1b[H")).length).toBe(2);
    expect(out.slice(-3)).toEqual([OFF, "The code and the QR code no longer work.\n", "Stopped after 30 minutes. Run ovis add again.\n"]);
    expect(cancels).toEqual([{ code: "100003" }]);
    // looked at every two seconds for those 30 minutes
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
    // one that could not be removed is named, with where to revoke it
    const stuck = await scanning({
      step: (state, looks, _elapsed, stop) => { if (looks === 2) { state.devices = [OLD, PHONE]; stop.abort(); } },
      revoke: () => Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 }),
    });
    expect(stuck.out.at(-1)).toBe("Stopped. Run ovis add again to add this PC. Hako's iPhone could not be removed (/api/devices/00000000000000a1: this device can only watch): revoke it in Settings → Devices and PCs on this PC.\n");
  });

  it("takes the code back when the run fails, and says when it could not be", async () => {
    const { code, out, cancels } = await scanning({
      refuse: (path, codes) => path === "/api/account/status" && codes > 0 ? Response.json({ error: { code: "internal_error", message: "internal error (y)" } }, { status: 500 }) : undefined,
      cancel: () => Response.json({ error: { code: "internal_error", message: "internal error (x)" } }, { status: 500 }),
    });
    expect(code).toBe(1);
    expect(cancels).toEqual([{ code: "100001" }]);
    expect(out.slice(-3, -1)).toEqual([OFF, "The code could not be taken back (/api/devices/pair/cancel: internal error (x)): it works until it runs out.\n"]);
    expect(out.at(-1)).toContain("Could not link this PC");
  });

  it("is done only once the account's other devices are in, and shows no code again after a device paired", async () => {
    const { code, out, offers, cancels } = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 4) { state.account = "acct_1"; state.enrolling = true; state.devices = [OLD, MEMBER]; }
        // well past the first code's ten minutes
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
      "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n",
    ]);
  });

  // what is said once every device that came since the code was shown is gone, and this PC is out of the other account
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
        // while "Keep that device?" waits
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
      // enrolled as the phone's removal is on its way
      revoke: (state, id) => { if (id === PHONE.id) state.devices = [...state.devices, LAPTOP]; return undefined; },
    });
    expect(code).toBe(1);
    expect(revoked).toEqual([PHONE.id, TABLET.id, LAPTOP.id]);
    // the one that linked itself is named as the adder, not the ones it brought in after it
    expect(out.at(-1)).toBe(`This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone, Mallory's tablet, Mallory's laptop paired with this PC since the code was shown and were removed. ${OUT}`);
  });

  it("says so when the PC stays in the other account: by a device paired before this run, or one that could not be removed", async () => {
    // a device paired before this run linked itself to another account, and brought one of that account's in
    const before = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [{ ...OLD, account: "acct_2" }, { ...PHONE, account: "acct_2", added_by: OLD.id }]; } },
    });
    expect(before.code).toBe(1);
    expect(before.revoked).toEqual([PHONE.id]);
    expect(before.out.at(-1)).toBe("This PC joined another Ovis account (acct_2), added by Old tablet, not the one you signed in to (acct_1). Hako's iPhone paired with this PC since the code was shown and was removed. This PC is still in that account, by Old tablet, paired before this run. It was taken off the list of the account you signed in to. If that account is not yours, open Settings → Devices and PCs on this PC and choose Revoke all.\n");
    // its entry in the account that signed in, whose Add could not work, goes; its relay pass is left to its members
    expect(before.service.pcs("acct_1")).toEqual([]);
    expect(before.named.filter((account) => account !== "acct_1")).toEqual([]);
    const stuck = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; } },
      revoke: () => Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 }),
    });
    expect(stuck.code).toBe(1);
    expect(stuck.out.at(-1)).toBe("This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone could not be removed (/api/devices/00000000000000a1: this device can only watch): revoke it in Settings → Devices and PCs on this PC. This PC is still in that account. It was taken off the list of the account you signed in to. If that account is not yours, open Settings → Devices and PCs on this PC and choose Revoke all.\n");
    // where the PC is after the removal cannot be read: what went is said all the same, and nothing is claimed
    let gone = false;
    const unread = await scanning({
      step: (state, looks) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; } },
      revoke: () => { gone = true; return undefined; },
      refuse: (path) => gone && path === "/api/account/status" ? Response.json({ error: { code: "internal_error", message: "internal error (y)" } }, { status: 500 }) : undefined,
    });
    expect(unread.code).toBe(1);
    expect(unread.revoked).toEqual([PHONE.id]);
    expect(unread.out.at(-1)).toBe("This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone paired with this PC since the code was shown and was removed. What is paired with this PC now could not be read (/api/account/status: internal error (y)): devices of that account may still be paired. Open Settings → Devices and PCs on this PC and choose Revoke all if that account is not yours.\n");
    // nor can it be told whether the account's member brought more of its devices in, when the devices cannot be read again
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
        // the look after the removal: the tablet paired before, whose link the other account kept out, got in
        if (looks === 3) { state.account = "acct_1"; state.devices = [owner]; }
      },
    });
    expect(revoked).toEqual([PHONE.id]);
    expect(out.slice(-2)).toEqual([
      "This PC joined another Ovis account (acct_2), added by Hako's iPhone, not the one you signed in to (acct_1). Hako's iPhone paired with this PC since the code was shown and was removed.\n",
      "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n",
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
    // the word, in any case and with spaces around it, keeps
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
    // keep typed and not sent before anything was asked (as at an earlier run's question): its Enter, pressed at this
    // question well past the dwell, sends an empty line
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
    // once for the question, as it first shows
    expect(ahead.discards()).toBe(1);
    // typed under the question, it keeps: what is typed there is never discarded
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
        // typed ahead during the sign-in: the terminal hands it over with the first read
        if (text.includes("Signed in.")) type("y");
        // and once more as the question shows
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
    // y typed at the first question and not sent; this PC joins the account by another device, the question is asked
    // anew, and the Enter comes two seconds after it showed, or two looks later
    for (const looksLater of [1, 2]) {
      let shows = 0;
      const { code, out, revoked } = await scanning({
        step: (state, looks) => {
          if (looks === 2) state.devices = [OLD, PHONE];
          if (looks === 14) { state.account = "acct_1"; state.devices = [owner, PHONE]; }
        },
        said: (text, _type, answer) => {
          if (text !== NEXT) return;
          // the held line's Enter, then nothing more: the default
          if (++shows === 1) answer("keep", looksLater);
          else answer("");
        },
      });
      expect(out.slice(-6)).toEqual(["\n", NEXT, HELD, NEXT, "Removed.\n", "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n"]);
      expect(out).not.toContain("Kept.\n");
      expect(revoked).toEqual([PHONE.id]);
      expect(code).toBe(0);
    }
    // the line typed under the question shown again is the one that counts
    let shows = 0;
    const kept = await scanning({
      step: (state, looks) => {
        if (looks === 2) state.devices = [OLD, PHONE];
        if (looks === 14) { state.account = "acct_1"; state.devices = [owner, PHONE]; }
      },
      said: (text, _type, answer) => { if (text === NEXT) answer(++shows === 1 ? "" : "keep"); },
    });
    expect(kept.out.slice(-4)).toEqual([HELD, NEXT, "Kept.\n", "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n"]);
    expect(kept.revoked).toEqual([]);
  });

  it("takes no line begun at a question that was dropped as the answer to one about another device", async () => {
    // the phone is asked about, then links itself: its question goes. A device that typed the code at this PC's own
    // address is asked about next, while the account's other devices are brought in
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
        // sent at the first question, in the look that finds this PC in the account
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
    expect(out.at(-1)).toBe("\nThis PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n");
    expect(revoked).toEqual([]);
  });

  it("names as the adder only a member of the account, and still asks about a device that took the code without being one", async () => {
    // the phone paired before links itself (it is in `known`), right after a stranger took the code
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
      "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n",
    ]);
    expect(soon.revoked).toEqual([PHONE.id]);
    expect(soon.offers).toEqual(["100001"]);
    expect(soon.code).toBe(0);
    // the same while the question about that device already waits: it is asked anew, not dropped
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
      "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n",
    ]);
    expect(waiting.revoked).toEqual([PHONE.id]);
    // one that could not be removed: the run does not end well
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
    expect(untold.out.slice(-2)).toEqual(["Kept.\n", "This PC is in your account (acct_1): every device of your account can use it.\n"]);
  });

  it("names as the adder the member that linked itself, not a device of the account it then brought in", async () => {
    const BARE: Row = { id: "00000000000000d4", label: "Hako's MacBook", role: "drive", created_at: "2026-11-06T12:00:50.000Z", last_seen_at: null, current: false, via_relay: true, account: "acct_1" };
    // the phone scanned the code, then brought the account's laptop in, whose row is the newer one
    const scanned = await scanning({
      step: (state, looks) => {
        if (looks === 3) { state.account = "acct_1"; state.enrolling = true; state.devices = [OLD, MEMBER, { ...BARE, added_by: PHONE.id }]; }
        if (looks === 5) state.enrolling = false;
      },
    });
    expect(scanned.out.slice(-2)).toEqual([
      "Added by Hako's iPhone. Bringing in your account's other devices…\n",
      "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n",
    ]);
    expect(scanned.code).toBe(0);
    // a device paired before this run linked itself and brought the laptop in: the laptop came since, and added nothing
    const before = await scanning({
      step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [{ ...OLD, account: "acct_1" }, { ...BARE, added_by: OLD.id }]; } },
    });
    expect(before.out.at(-1)).toBe("This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n");
    // where it cannot be told which one linked itself (an Ovis that does not say who brought a member in), none is named
    const untold = await scanning({
      step: (state, looks) => { if (looks === 3) { state.account = "acct_1"; state.devices = [OLD, MEMBER, BARE]; } },
    });
    expect(untold.out.at(-1)).toBe("This PC is in your account (acct_1): every device of your account can use it.\n");
    expect(untold.code).toBe(0);
  });

  it("keeps a device that linked itself as its removal was on its way: the account that signed in vouches for it by then", async () => {
    // slow to link: asked about after its 15 seconds, and Enter pressed just as it became a member
    const { code, out, revoked } = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, answer) => { if (text.includes("Keep that device?")) answer(""); },
      revoke: (state) => { state.account = "acct_1"; state.devices = [OLD, MEMBER]; return undefined; },
    });
    expect(revoked).toEqual([]);
    expect(out.slice(-2)).toEqual([
      "Hako's iPhone is in your account by now, so it stays.\n",
      "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n",
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
      "This PC is in your account (acct_1), added by Hako's iPhone: every device of your account can use it.\n",
    ]);
    expect(told.code).toBe(0);
  });

  it("ends on a look taken after the removal, not the one before it: what came in between is seen", async () => {
    // asked about and removed, but as its removal was on its way it linked itself to an account of its own and
    // brought that account's laptop in
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
    // with this PC in the account: a device that paired as the other was removed is asked about, not passed over
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
      "This PC is in your account (acct_1), added by Old tablet: every device of your account can use it.\n",
    ]);
    expect(between.code).toBe(0);
    // and with this PC in no account: the run does not end while a device is left to ask about
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
        // keep was sent at the first question; in the look that takes it, this PC joins the account by another device
        // and a second line is handed over: both came under the old question, and neither is the one held back
        if (answered && !joined) { joined = true; typeNow(""); state.account = "acct_1"; state.devices = [owner, PHONE]; }
      },
      said: (text, type, answer) => {
        typeNow = type;
        if (text.includes("so this PC is in no account. Keep that device?")) { answered = true; answer("keep"); }
        // a line begun at the first question: its Enter comes two looks after the next one showed
        if (text === NEXT && ++shows === 1) answer("keep", 2);
        if (text === HELD) answer("", 3);
      },
    });
    expect(out.filter((line) => line.includes("answered nothing"))).toEqual(["That line answered nothing: its question is no longer asked.\n", HELD]);
    expect(out).not.toContain("Kept.\n");
    expect(revoked).toEqual([PHONE.id]);
    expect(code).toBe(0);
  });

  it("ends a code pending from elsewhere before its QR code when the relay takes no typed code, so the QR code carries digits of its own", async () => {
    const { code, text, cancels, paths } = await scanning({
      refuse: (path) => path === "/api/relay/code" ? Response.json({ error: { code: "code_unavailable", message: "Pairing with a typed code works through Ovis's relay only; scan the QR code instead." } }, { status: 409 }) : undefined,
      step: (state, looks) => { if (looks === 1) { state.account = "acct_1"; state.devices = [OLD, MEMBER]; } },
    });
    expect(code).toBe(0);
    expect(text).toContain("No code to type this time");
    // what was pending (from Settings or ovis pair, which showed its six digits) went before the offer; the code the
    // QR code carried is then taken back by its own digits
    expect(cancels).toEqual([{}, { code: "100001" }]);
    const order = ["POST /api/relay/code", "POST /api/devices/pair/cancel", "POST /api/relay/offer"].map((call) => paths.indexOf(call));
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
    // left alone until the 30 minutes are over, it is named and removed then too
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
      // a device pairs in the first code's last seconds, and the looks as it runs out get no answer
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
    // a PC that does not answer for its devices just then: the one the question named is removed all the same
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
    // a device took the code after the last look that was answered, then the run is stopped and this PC answers no more
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
    // read three times before it is given up on
    expect(reads).toBe(3);
    expect(silent.out.at(-1)).toBe(`Stopped. Run ovis add again to add this PC.${UNREAD("connection refused")}`);
    // one that was asked about is removed all the same, and what else may be paired is still not known
    let asked: AbortController | null = null;
    const named = await scanning({
      step: (state, looks, _elapsed, stop) => { asked = stop; if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep that device?")) stop.abort(); },
      refuse: (path) => { if (asked?.signal.aborted === true && path === "/api/devices") throw new TypeError("connection refused"); return undefined; },
    });
    expect(named.revoked).toEqual([PHONE.id]);
    expect(named.out.at(-1)).toBe(`\nStopped. Run ovis add again to add this PC. Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.${UNREAD("connection refused")}`);
    // a PC that answers the second try: the device goes, and nothing is left unknown
    let later: AbortController | null = null;
    let tries = 0;
    const second = await scanning({
      step: (state, looks, _elapsed, stop) => { later = stop; if (looks === 2) { state.devices = [OLD, PHONE]; stop.abort(); } },
      refuse: (path) => { if (later?.signal.aborted === true && path === "/api/devices" && ++tries === 1) throw new TypeError("connection refused"); return undefined; },
    });
    expect(second.revoked).toEqual([PHONE.id]);
    expect(second.out.at(-1)).toBe("Stopped. Run ovis add again to add this PC. Hako's iPhone paired with this PC since the code was shown and was removed: nobody kept it.\n");
    // the same at the 30-minute stop
    let late = false;
    const stopped = await scanning({
      step: (_state, _looks, elapsed) => { late = elapsed >= 1_798_000; },
      refuse: (path) => { if (late && path === "/api/devices") throw new TypeError("connection refused"); return undefined; },
    });
    expect(stopped.out.at(-1)).toBe(`Stopped after 30 minutes. Run ovis add again.${UNREAD("/api/devices: the Ovis on this PC did not answer (connection refused)")}`);
    // before any code was shown nothing can have paired with one: nothing is said of it
    let early: AbortController | null = null;
    const codeless = await scanning({
      said: (_text, _type, _answer, stop) => { early = stop; },
      refuse: (path, codes) => {
        if (codes > 0) return undefined;
        // stopped during the look before the first code, on a PC that then answers no more
        if (path === "/api/account/status" && early !== null) early.abort();
        if (early?.signal.aborted === true && path === "/api/devices") throw new TypeError("connection refused");
        return undefined;
      },
    });
    expect(codeless.offers).toEqual([]);
    expect(codeless.text).not.toContain("could not be read");
    // a member of another account that brings one more device in for each one removed: it is looked at four times
    // more, and then said that it cannot be told that none is left
    let brought = 0;
    const endless = await scanning({
      step: (state, looks, _elapsed, stop) => { if (looks === 2) { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; stop.abort(); } },
      revoke: (state) => { brought++; state.devices = [...state.devices, { ...PHONE, id: `00000000000000d${brought}`, label: `Mallory ${brought}`, account: "acct_2", added_by: OLD.id }]; return undefined; },
    });
    expect(endless.revoked).toEqual([PHONE.id, "00000000000000d1", "00000000000000d2", "00000000000000d3"]);
    expect(endless.out.at(-1)).toBe("Stopped. Run ovis add again to add this PC. Hako's iPhone, Mallory 1, Mallory 2, Mallory 3 paired with this PC since the code was shown and were removed: nobody kept them. More devices paired with this PC while these were removed: one that paired since the code was shown may still be paired. Open Settings → Devices and PCs on this PC and revoke any device there that is not yours.\n");
  });

  it("removes a device that links itself to another account as the run is stopped, and keeps one that links itself to the account that signed in", async () => {
    // read as not signed in, then a member of another account by the time its removal lands
    const stranger = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep that device?")) stop.abort(); },
      revoke: (state) => { state.account = "acct_2"; state.devices = [OLD, { ...PHONE, account: "acct_2" }]; return undefined; },
    });
    expect(stranger.revoked).toEqual([PHONE.id]);
    // the owner's own phone, slow to link: a member of the account that signed in by then, which vouches for it
    const own = await scanning({
      step: (state, looks) => { if (looks === 2) state.devices = [OLD, PHONE]; },
      said: (text, _type, _answer, stop) => { if (text.includes("Keep that device?")) stop.abort(); },
      revoke: (state) => { state.account = "acct_1"; state.devices = [OLD, MEMBER]; return undefined; },
    });
    expect(own.revoked).toEqual([]);
    expect(own.out.at(-1)).toBe("\nStopped. Run ovis add again to add this PC.\n");
  });

  it("takes the code back and removes the device also when the terminal is gone and every write fails", async () => {
    // the window closed, or the ssh session dropped (SIGHUP): nothing can be written any more
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
      // this PC is listed from an earlier run, long enough ago to be listed anew, and the account service takes no new
      // listing: every look tries to put it back, and Ctrl+C lands during one of those
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
    // one that paired in the run's last seconds, of which nothing was asked yet, goes with the stop
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
    // the looks from the 4th to the 20th go unanswered
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
    // the server restarts as the first code runs out: no answer to the typed code twice, then a relay not back online
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
    // still three codes in all, and the run's 30 minutes
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
    // read once without an answer, once for the devices it had, and once with the look before the first code
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
        // the code and the QR code on the screen, then the signal
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

  /**
   * `pair --approve` over the requests that wait: `said` hears every line, to `type` a line at that very moment or to
   * `answer` two seconds later (the time a person takes to compare the digits), and `decide` answers for the PC's server.
   */
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
        // a turn later: the lines come once the one who asks waits for them
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
        // its digits for p1, and Enter once more: an empty line would decline p2 unseen
        if (said.includes("Phone p1 wants")) answer("222", "");
        // p2's own answer, typed once its digits were compared
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
        // the same digits and Enter once more, as p2's prompt comes on the screen; then nothing but Enter
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
        // the last three, which name neither; then all six
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
        // its digits; asked again, an Enter that may have been pressed meanwhile, then the digits
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
      // a terminal whose input ended (Ctrl+D): each request is declined as it shows
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
    // the first phone's digits, typed before the command asked about it
    keys.begin("222");
    let declined = 0;
    const { code, out, decisions } = await approving({
      keys,
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      said: (said, _type, answer) => {
        if (said.includes("Phone p1 wants")) answer("");
        // and the second one's, typed before its prompt
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
    // someone else's request is asked about first; the person types what their own phone shows
    let asked = 0;
    const { code, out, decisions } = await approving({
      pairings: [waiting("p1", "111222"), waiting("p2", "333444")],
      said: (said, _type, answer) => {
        // p2's last three at p1's prompt; then, having read what was said, Enter
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
    // all six of another request, full-width and spaced as an input method types them, are told the same way
    let again = 0;
    const six = await approving({
      pairings: [waiting("p1", "111222")],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++again === 1 ? "３３３ ４４４" : ""); },
    });
    expect(six.out[1]).toStartWith("That line answered nothing: 333444 are not this request's digits: Phone p1 shows 111 222.");
    expect(six.decisions).toEqual([{ id: "p1", decision: "decline" }]);
    // a line that is no digits keeps the plain words
    let third = 0;
    const habit = await approving({
      pairings: [waiting("p1", "111222")],
      said: (said, _type, answer) => { if (said.includes("Phone p1 wants")) answer(++third === 1 ? "y" : ""); },
    });
    expect(habit.out[1]).toBe("That line answered nothing: only the digits shown approve a request, and only Enter by itself declines it. Answer again.\n");
  });

  it("reads the waiting requests again before three digits approve: one that came since and ends in the same three makes all six needed", async () => {
    // p1 was listed when the command started; p9 asked after that, and its screen ends in 222 too
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
    // with nobody beside it, three digits approve, after that one look
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
