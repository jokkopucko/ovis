import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeAccountService } from "../shared/account-service-fake.ts";
import { encodeOffer } from "../shared/relay-offer.ts";
import { loadRelayIdentity } from "../server/relay/identity.ts";
import { updateStateDir } from "../server/update-state.ts";
import { COMMAND_ALIASES, link } from "./plugin-link.ts";

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
  return {
    now: () => now,
    waits,
    /** time a call took */
    pass: (ms: number) => { now += ms; },
    wait: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      waits.push(ms);
      now += ms;
      // a turn, so a test's abort on the last answer lands before the next round
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
    },
  };
}

async function* answers(...lines: string[]): AsyncGenerator<string> { for (const line of lines) yield line; }

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
    const code = await link(options.args ?? [], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal,
      accountService: SERVICE, serviceFetch: (input, init) => service.fetch(new Request(input, init)), lines: answers("y"),
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown) options.approve(service, shown[1]!);
      },
    });
    return { code, text: out.join(""), service, pc, decisions, named };
  }

  it("signs in with the device flow, lists this PC in the account and approves the device that adds it after a number compare", async () => {
    const { code, text, service, pc, decisions } = await linkToAccount({ approve: (service, shown) => service.approveDevice(shown, "acct_1") });
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
  async function waiting(status: (polls: number, elapsed: number) => { account: string | null; enrolling?: boolean }, down: (elapsed: number) => boolean = () => false, latency = 0) {
    const pc = identity();
    const time = clock();
    let began: number | null = null;
    const elapsed = () => began === null ? -1 : time.now() - began;
    const service = new FakeAccountService(time.now);
    let polls = 0;
    const writes: string[] = [];
    // when the approve-here window was asked for, and the accounts this PC was told it asks its relay pass under
    const linkAt: number[] = [];
    const named: string[] = [];
    const local = localPc(async (request, path) => {
      if (down(elapsed())) throw new TypeError("connection refused");
      if (path === "/api/account/status") return Response.json({ unlinked: [], removals: [], adds: [], blocked: [], ...status(polls, elapsed()) });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/account/relay-account") { named.push((await request.json() as { account: string }).account); return new Response(null, { status: 204 }); }
      if (path === "/api/relay/link") { began ??= time.now(); linkAt.push(elapsed()); }
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      // `latency`: how long each look for a request takes to be answered
      if (path === "/api/relay/pairings") { polls++; time.pass(latency); return Response.json({ pairings: [] }); }
      return undefined;
    });
    const out: string[] = [];
    const code = await link([], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal, lines: answers(), accountService: SERVICE,
      serviceFetch: (input, init) => {
        const request = new Request(input, init);
        if (request.method === "PUT" || request.method === "DELETE") writes.push(`${request.method} ${new URL(request.url).pathname} at poll ${polls}`);
        return service.fetch(request);
      },
      out: (text) => { out.push(text); const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text); if (shown) service.approveDevice(shown[1]!, "acct_1"); },
    });
    return { code, out, text: out.join(""), calls: local.calls, writes, time, pc, polls: () => polls, linkAt, named, service };
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
    expect(linkAt.filter((at) => at > 19 * 60_000)).toEqual([19 * 60_000 + 30_000, 20 * 60_000]);
    // listed, then listed anew at 9 and 18 minutes (2-second polls) and with the last window at 20, so the
    // account's devices offer Add until the run ends. Not after: the card would outlive the window and the run
    const entry = `/v1/pcs/${pc.server_id}`;
    expect(writes).toEqual([`PUT ${entry} at poll 0`, ...[271, 541, 601].flatMap((poll) => [`DELETE ${entry} at poll ${poll}`, `PUT ${entry} at poll ${poll}`])]);
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
  });

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
    await link([], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal,
      accountService: SERVICE, serviceFetch: (input, init) => service.fetch(new Request(input, init)), lines: answers("n"),
      out: (text) => { out.push(text); const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text); if (shown) service.approveDevice(shown[1]!, "acct_1"); },
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
    const never: AsyncIterator<string> = { next: () => new Promise(() => {}) };
    const out: string[] = [];
    const code = await link([], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: stop.signal,
      accountService: SERVICE, lines: never,
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
        if (text.includes("Approve?")) stop.abort();
      },
    });
    expect(code).toBe(1);
    expect(local.calls.some((call) => call.path === "/api/relay/pairing")).toBe(false);
    // signed out at the service: the token no longer lists the account's PCs
    expect((await service.fetch(new Request(SERVICE + "/v1/pcs", { headers: { authorization: "Bearer " + token } }))).status).toBe(401);
  });

  /** Lines a person types when they choose to, not ahead of time. */
  function keyboard() {
    let reader: ((line: IteratorResult<string>) => void) | null = null;
    const lines: AsyncIterator<string> = { next: () => new Promise((resolve) => { reader = resolve; }) };
    return { lines, type: (line: string) => { const resolve = reader; reader = null; resolve?.({ value: line, done: false }); } };
  }

  /**
   * `link` signed in to acct_1 and waiting, with requests to approve: `pending` names the ones waiting at each poll,
   * `said` hears every line (to type an answer at), and `decide` may fail the call that carries an answer.
   */
  async function prompting(options: { pending: (polls: number, decisions: { id: string; decision: string }[]) => string[]; said: (text: string, type: (line: string) => void) => void; decide?: (attempt: number) => void; joined?: (decisions: { id: string; decision: string }[]) => boolean; refuse?: (waits: number) => boolean }) {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    const keys = keyboard();
    let refused = 0;
    let polls = 0;
    let attempts = 0;
    const decisions: { id: string; decision: string }[] = [];
    const local = localPc(async (request, path) => {
      // the PC's server is down: every call is refused
      if (options.refuse?.(time.waits.length)) { if (++refused > 200) throw new Error("the loop spins without waiting"); throw new TypeError("connection refused"); }
      if (path === "/api/account/status") return Response.json({ account: options.joined?.(decisions) ? "acct_1" : null, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
      if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: pc.server_id, server_public_key: pc.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
      if (path === "/api/relay/pairings") return Response.json({ pairings: options.pending(++polls, decisions).map((id) => ({ id, label: `Phone ${id}`, digits: "111222", intent: "account", expires_at: new Date(time.now() + 60_000).toISOString() })) });
      if (path === "/api/relay/pairing") {
        options.decide?.(++attempts);
        decisions.push(await request.json() as { id: string; decision: string });
        return Response.json({ ok: true });
      }
      return undefined;
    });
    const out: string[] = [];
    const code = await link([], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal,
      accountService: SERVICE, lines: keys.lines, serviceFetch: (input, init) => service.fetch(new Request(input, init)),
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown) service.approveDevice(shown[1]!, "acct_1");
        options.said(text, keys.type);
      },
    });
    return { code, out, text: out.join(""), calls: local.calls, decisions, polls: () => polls, refused: () => refused };
  }

  it("stops after its 30 minutes with a request left unanswered, and keeps its window open meanwhile", async () => {
    const { code, out, calls, decisions, polls } = await prompting({ pending: () => ["p1"], said: () => undefined });
    expect(code).toBe(1);
    // asked once, and the prompt's line is ended before the last word
    expect(out.filter((text) => text.includes("Approve?"))).toHaveLength(1);
    expect(out.at(-1)).toBe("\nStopped waiting after 30 minutes. Run this again to keep waiting.\n");
    expect(decisions).toEqual([]);
    // the waiting went on under the prompt: every poll, and the window every 30 seconds until the last ten minutes
    expect(polls()).toBe(901);
    expect(calls.filter((call) => call.path === "/api/relay/link")).toHaveLength(41);
  });

  it("drops a request that stopped waiting at its prompt, and never takes a line typed after it as the answer to the next", async () => {
    const { code, out, decisions } = await prompting({
      // p1 for three polls, nothing for two, then p2 until it is answered
      pending: (polls, decisions) => polls <= 3 ? ["p1"] : polls <= 5 || decisions.length > 0 ? [] : ["p2"],
      said: (text, type) => {
        // typed too late: nothing is asked about any more
        if (text.includes("Phone p1 is no longer waiting")) type("y");
        if (text.includes("Phone p2 wants")) type("n");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((text) => text.includes("Approve?")).map((text) => text.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    expect(out).toContain("\nPhone p1 is no longer waiting.\n");
    // the late y approved nothing: p2 got the answer typed at its own prompt
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  it("never takes a line typed for a request that went away as the answer to the next one shown in the same look", async () => {
    const { code, out, decisions } = await prompting({
      // p1 for three polls, then p2 in the very poll that drops p1
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      said: (text, type) => {
        // meant for p1, sent as its prompt ends: p2's digits were never on the screen
        if (text.includes("Phone p1 is no longer waiting")) type("y");
        if (text.includes("Phone p2 wants")) type("n");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((text) => text.includes("Approve?")).map((text) => text.slice(0, 8))).toEqual(["Phone p1", "Phone p2"]);
    // the y approved nothing: p2 got the answer typed at its own prompt
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  it("never hands a read begun under a request that went away to the next one: its line answers nothing, also when it comes after the next prompt", async () => {
    let shown = 0;
    const { code, out, text, decisions } = await prompting({
      pending: (polls, decisions) => decisions.length > 0 ? [] : polls <= 3 ? ["p1"] : ["p2"],
      said: (said, type) => {
        // the y begun at p1's prompt is sent only once p2's prompt is on the screen; the answer to p2 follows at its second showing
        if (said.includes("Phone p2 wants")) type(++shown === 1 ? "y" : "n");
      },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(text).toContain("That line answered nothing");
    // p2 is asked again under the notice
    expect(out.filter((said) => said.includes("Approve?")).map((said) => said.slice(0, 8))).toEqual(["Phone p1", "Phone p2", "Phone p2"]);
    expect(decisions).toEqual([{ id: "p2", decision: "decline" }]);
  });

  it("approves nothing when the only line sent was begun under the request before the one shown", async () => {
    let typedOnce = false;
    const { code, decisions } = await prompting({
      pending: (polls) => polls <= 3 ? ["p1"] : ["p2"],
      said: (said, type) => { if (said.includes("Phone p2 wants") && !typedOnce) { typedOnce = true; type("y"); } },
    });
    expect(code).toBe(1);
    expect(decisions).toEqual([]);
  });

  it("leaves a request unanswered when the only line typed was for the one before it", async () => {
    const { code, decisions } = await prompting({
      pending: (polls) => polls <= 3 ? ["p1"] : ["p2"],
      said: (text, type) => { if (text.includes("Phone p1 is no longer waiting")) type("y"); },
    });
    expect(code).toBe(1);
    expect(decisions).toEqual([]);
  });

  it("waits between looks while the PC's server is down, also with an answer typed, and sends it once the server is back", async () => {
    let downAt: number | null = null;
    const { code, text, decisions, refused } = await prompting({
      pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
      said: (said, type) => { if (said.includes("not answering")) type("y"); },
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

  it("asks about a request again when its answer did not reach the server, rather than skipping it or sending the old answer", async () => {
    let prompts = 0;
    const { code, text, out, decisions, calls } = await prompting({
      pending: (_polls, decisions) => decisions.length > 0 ? [] : ["p1"],
      said: (said, type) => { if (said.includes("Approve?")) type(++prompts === 1 ? "y" : "n"); },
      // the first answer's call is never answered
      decide: (attempt) => { if (attempt === 1) throw new TypeError("timed out"); },
      joined: (decisions) => decisions.length > 0,
    });
    expect(code).toBe(0);
    expect(out.filter((said) => said.includes("Approve?"))).toHaveLength(2);
    expect(text).toContain("Your answer may not have reached the Ovis on this PC. Phone p1 is asked about again if it is still waiting.");
    expect(calls.filter((call) => call.path === "/api/relay/pairing").map((call) => JSON.parse(call.body))).toEqual([{ id: "p1", decision: "approve" }, { id: "p1", decision: "decline" }]);
    // what the server took is the answer typed the second time
    expect(decisions).toEqual([{ id: "p1", decision: "decline" }]);
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
    const code = await link([], {
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
    expect(await link([], {
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
