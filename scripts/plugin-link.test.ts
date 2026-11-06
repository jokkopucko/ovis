import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeAccountService } from "../shared/account-service-fake.ts";
import { encodeOffer } from "../shared/relay-offer.ts";
import { loadRelayIdentity } from "../server/relay/identity.ts";
import { updateStateDir } from "../server/update-state.ts";
import { link } from "./plugin-link.ts";

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
    // drawn as a QR code in the terminal: block characters, one line per module row
    expect(text).toMatch(/█{4,}/);
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
    expect(text).toMatch(/█{4,}/);
    expect(text).toContain(pc.server_id.match(/.{4}/g)!.join(" "));
    // the QR code's own six-digit code is taken back too
    expect(cancelled).toBe(1);
  });

  it("signs in with the device flow, lists this PC in the account and approves the device that adds it after a number compare", async () => {
    const pc = identity();
    const time = clock();
    const service = new FakeAccountService(time.now);
    let account: string | null = null;
    let linkAsked = 0;
    const decisions: unknown[] = [];
    const local = localPc(async (request, path) => {
      if (path === "/api/account/status") return Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] });
      if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: "online", blocked: null });
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
    const code = await link([], {
      origin: ORIGIN, headers: {}, fetch: local.fetch, now: time.now, wait: time.wait, signal: new AbortController().signal,
      accountService: SERVICE, serviceFetch: (input, init) => service.fetch(new Request(input, init)), lines: answers("y"),
      out: (text) => {
        out.push(text);
        const shown = /code:? ([A-Z0-9-]{4,16})\b/.exec(text);
        if (shown) service.approveDevice(shown[1]!, "acct_1");
      },
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("https://github.com/login/device");
    expect(service.pcs("acct_1").map((entry) => [entry.server_id, entry.label])).toEqual([[pc.server_id, "old-desktop"]]);
    expect(text).toContain("Hako's iPhone wants to join your account");
    expect(text).toContain("123 456");
    expect(decisions).toEqual([{ id: "p1", decision: "approve" }]);
    expect(text).toContain("This PC is in your account");
  });

  it("does not sign in when this PC is already in an account, or when the account service is off", async () => {
    let account: string | null = "acct_1";
    const local = localPc((_request, path) => path === "/api/account/status" ? Response.json({ account, unlinked: [], removals: [], adds: [], blocked: [] }) : undefined);
    const out: string[] = [];
    const base = { origin: ORIGIN, headers: {}, fetch: local.fetch, out: (text: string) => out.push(text), signal: new AbortController().signal, lines: answers() };
    expect(await link([], { ...base, accountService: SERVICE })).toBe(0);
    expect(out.join("")).toContain("already in your account");
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
