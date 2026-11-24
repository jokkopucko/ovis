/**
 * `ovis join` against a stand-in for this PC's own server whose account calls go to the test account service with this
 * PC's real key proofs (POST /api/account/pc-proof, and /api/account/one-press asking POST /v1/pc/admission), on a
 * clock the test moves. The invite routes are the account service's (shared/account-service-fake.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";

import { verifyLineProof } from "../shared/account-list-invite.ts";
import { epochKeyCommitment, newEpochKey, wrapEpochKey, wrapToText } from "../shared/account-list-seal.ts";
import { listMember } from "../server/account/list.test-helpers.ts";
import { newInvite, readJoinLine } from "../shared/account-list-join.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { importPublicKey, importSecretKey } from "../shared/relay-e2ee.ts";
import { encodeOffer } from "../shared/relay-offer.ts";
import { answerServerChallenge } from "../shared/relay-server-proof.ts";
import { loadRelayIdentity } from "../server/relay/identity.ts";
import { absoluteInviteFile, join, JOIN_EXIT, parseJoinArgs, readInviteFile } from "./plugin-join.ts";
import { linkSettings } from "./plugin-link.ts";

const ORIGIN = "http://127.0.0.1:7317";
const SERVICE = "https://account.test";
const RELAY = "wss://relay.test";
const CLOSING = "Check: ovis status      Undo: ovis logout\n";
const HINT = "If your phone asks for six digits when you open old-desktop, run ovis approve on this PC and type them.\n";
const ASKED = [
  "This invite adds this PC to Ovis account acct_1.",
  "Compare this ID with Settings → Manage account → Account ID in your",
  "Ovis app, or with ovis status on a PC you already use.",
  "Is this your account? Type yes to add this PC to it: ",
].join("\n");

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function clock() {
  let now = Date.parse("2026-11-24T12:00:00Z");
  return {
    now: () => now,
    pass: (ms: number) => { now += ms; },
    wait: async (ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 0));
      now += ms;
      signal.throwIfAborted();
    },
  };
}

/** Lines typed at a terminal: one typed while nothing reads goes to the next read, unless the terminal is emptied first. */
function keyboard() {
  let reader: ((line: IteratorResult<string>) => void) | null = null;
  const kept: string[] = [];
  return {
    lines: { next: () => { const line = kept.shift(); return line !== undefined ? Promise.resolve({ value: line, done: false as const }) : new Promise<IteratorResult<string>>((resolve) => { reader = resolve; }); } },
    type: (line: string) => { const resolve = reader; reader = null; if (resolve === null) kept.push(line); else resolve({ value: line, done: false }); },
    discard: () => { kept.length = 0; return true; },
  };
}

interface Run {
  readonly code: number;
  /** stdout and stderr, as written */
  readonly out: string;
  readonly err: string;
  /** the line this run was given, and the invite's own line it was made from */
  readonly line: string;
  readonly made: string;
  readonly service: FakeAccountService;
  readonly serverId: string;
  /** this PC's relay key, as its listing names it */
  readonly endpoint: string;
  /** this PC's calls, as `METHOD /path` */
  readonly local: string[];
  /** the account service's calls, as `METHOD /path` */
  readonly calls: string[];
  /** what each of those calls carried */
  readonly bodies: string[];
  /** what had been asked of the account service, and of this PC, when the question showed; null when it did not */
  readonly beforeQuestion: { readonly service: string[]; readonly local: string[] } | null;
  readonly pressed: string[];
  readonly listed: () => { server_id: string; listed_by_device?: boolean }[];
  /** the files this run's PC keeps, read whole */
  readonly stateDir: string;
  /** this PC as the run left it: the account it is in and named for its relay pass (each naming in turn), its relay, how often it was stopped */
  readonly state: { account: string | null; named: string | null; relayOn: boolean; namings: (string | null)[]; stops: number };
}

interface Setup {
  /** the words after `ovis join`, which may carry the invite line */
  readonly args?: readonly string[] | ((line: string) => readonly string[]);
  /** the invite this run is given: made by a device of acct_1 by default, auto or plain */
  readonly auto?: boolean;
  readonly line?: (made: string) => string;
  readonly terminal?: boolean;
  readonly isTty?: boolean;
  /** typed at the account question; none typed when false */
  readonly confirm?: string | false;
  /** a device of the account presses Add as this PC asks for its admission the n-th time */
  readonly pressAfter?: number;
  /** Ctrl+C as this PC is asked for its admission the n-th time */
  readonly stopAt?: number;
  /** the account this PC is in as the run starts */
  readonly inAccount?: string;
  readonly running?: boolean;
  readonly blocked?: string;
  readonly prepare?: (service: FakeAccountService, time: ReturnType<typeof clock>) => Promise<void> | void;
  /** runs once the invite is made, before the run */
  readonly afterMade?: (service: FakeAccountService) => Promise<void> | void;
  /** answers an account service call in the service's place; `stop` is Ctrl+C */
  readonly serviceAnswer?: (path: string, request: Request, stop: () => void, forward: () => Promise<Response>) => Response | Promise<Response | undefined> | undefined;
  /** answers this PC's call in its server's place */
  readonly localAnswer?: (path: string, request: Request) => Response | Promise<Response> | undefined;
  /** the relay is off as the run starts, and the account named for this PC (none by default) */
  readonly relayOff?: boolean;
  readonly namedBefore?: string;
  readonly settings?: Record<string, string>;
  readonly inviteEnv?: string | ((line: string) => string);
  readonly stdin?: string;
  readonly service?: FakeAccountService;
  readonly time?: ReturnType<typeof clock>;
  readonly stateDir?: string;
  /** the account service and list id the invite's line names: this PC's service and no list by default */
  readonly inviteService?: string;
  readonly inviteList?: string;
  /** the account the invite is for: acct_1 by default */
  readonly inviteAccount?: string;
  /** told this PC's relay key once its relay identity is made, before the run */
  readonly beforeRun?: (endpoint: string) => void;
}

async function joining(setup: Setup = {}): Promise<Run> {
  const stateDir = setup.stateDir ?? mkdtempSync(joinPath(tmpdir(), "ovis-join-"));
  if (setup.stateDir === undefined) scratch.push(stateDir);
  const identity = loadRelayIdentity(stateDir);
  setup.beforeRun?.(bytesToHex(importPublicKey(identity.public_key)));
  const time = setup.time ?? clock();
  const service = setup.service ?? new FakeAccountService(time.now);
  service.opensAll = true;
  await setup.prepare?.(service, time);
  const ACCOUNT = setup.inviteAccount ?? "acct_1";
  const owner = service.issueToken(ACCOUNT);
  const fresh = await newInvite(setup.inviteService ?? SERVICE, ACCOUNT, setup.inviteList ?? null);
  const made = await service.fetch(new Request(`${SERVICE}/v1/pc-invites`, { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json" }, body: JSON.stringify({ invite_key: fresh.key, ...setup.auto ? { auto: true } : {} }) }));
  expect(made.status).toBe(200);
  await setup.afterMade?.(service);
  const madeLine = fresh.line;
  const line = setup.line?.(madeLine) ?? madeLine;
  const state = { account: setup.inAccount ?? null as string | null, named: setup.namedBefore ?? null as string | null, relayOn: setup.relayOff !== true, namings: [] as (string | null)[], stops: 0 };
  const local: string[] = [];
  const calls: string[] = [];
  const bodies: string[] = [];
  const pressed: string[] = [];
  const stop = new AbortController();
  const serviceFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    bodies.push(await request.clone().text());
    expect(new URL(request.url).origin).toBe(SERVICE);
    return await setup.serviceAnswer?.(path, request.clone(), () => stop.abort(), () => service.fetch(request.clone())) ?? await service.fetch(request);
  };
  const prove = async () => {
    const challenge = await (await serviceFetch(`${SERVICE}/v1/pc/challenge`, { method: "POST", body: JSON.stringify({ server_id: identity.server_id, public_key: bytesToHex(importPublicKey(identity.public_key)) }) })).json() as { challenge_id: string; frame: string };
    return { server_id: identity.server_id, challenge_id: challenge.challenge_id, proof: answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key), { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id })! };
  };
  const refuse = (code: string, status: number) => Response.json({ error: { code, message: code } }, { status });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    init?.signal?.throwIfAborted();
    const request = new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe(ORIGIN);
    const path = url.pathname;
    local.push(`${request.method} ${path}`);
    const answered = await setup.localAnswer?.(path, request.clone());
    if (answered !== undefined) return answered;
    if (path === "/api/account/status") return Response.json({ account: state.account, enrolling: false });
    if (path === "/api/relay" && request.method === "GET") return Response.json({ phase: !state.relayOn ? "off" : state.account === null ? "connecting" : "online", blocked: setup.blocked ?? null, relay_account: state.named });
    if (path === "/api/relay/start") { state.relayOn = true; return Response.json({ phase: "connecting", blocked: null }); }
    if (path === "/api/relay/stop") { state.relayOn = false; state.stops++; return Response.json({ phase: "off", blocked: null }); }
    if (path === "/api/relay/link") return Response.json({ url: encodeOffer({ v: 1, server_id: identity.server_id, server_public_key: identity.public_key, relay: RELAY, name: "old-desktop" }, "https://app.ovis.sh") });
    if (path === "/api/relay/link/close") return Response.json({ ok: true });
    if (path === "/api/account/relay-account") { state.named = (await request.json() as { account: string | null }).account; state.namings.push(state.named); return new Response(null, { status: 204 }); }
    if (path === "/api/account/pc-proof") return Response.json(await prove());
    if (path === "/api/account/one-press") {
      const body = await request.json() as { account?: unknown };
      if (typeof body.account !== "string") return refuse("invalid_account", 400);
      pressed.push(body.account);
      if (pressed.length === setup.stopAt) { stop.abort(); return refuse("no_admission", 404); }
      if (pressed.length === setup.pressAfter) {
        const admit = await service.fetch(new Request(`${SERVICE}/v1/pcs/${identity.server_id}/admit`, { method: "POST", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` }, body: "{}" }));
        expect(admit.status).toBe(200);
      }
      if (state.named !== body.account) return refuse("account_mismatch", 409);
      if (state.account !== null) return refuse("in_account", 409);
      const admitted = await serviceFetch(`${SERVICE}/v1/pc/admission`, { method: "POST", body: JSON.stringify({ ...await prove(), account: body.account, with_listing_id: true }) });
      if (admitted.status === 404) return refuse("no_admission", 404);
      if (!admitted.ok) {
        const code = ((await admitted.json()) as { error?: { code?: string } }).error?.code;
        return code === "listing_expired" ? refuse("listing_expired", 409) : refuse("account_unavailable", 503);
      }
      state.account = body.account;
      return Response.json({ account: state.account });
    }
    return refuse("not_found", 404);
  };
  const keys = keyboard();
  const out: string[] = [];
  const err: string[] = [];
  let beforeQuestion: Run["beforeQuestion"] = null;
  const heard = (text: string): void => {
    if (text.includes("Is this your account? Type yes")) {
      beforeQuestion ??= { service: [...calls], local: [...local] };
      if (setup.confirm !== false) { time.pass(2_000); keys.type(setup.confirm ?? "yes"); }
    }
  };
  const args = typeof setup.args === "function" ? setup.args(line) : setup.args ?? ["--invite-file", "/invite"];
  const inviteEnv = typeof setup.inviteEnv === "function" ? setup.inviteEnv(line) : setup.inviteEnv;
  const code = await join(args, {
    origin: ORIGIN, headers: {}, fetch, serviceFetch, accountService: SERVICE, now: time.now, wait: time.wait, signal: stop.signal,
    lines: keys.lines, discard: keys.discard, terminal: setup.terminal ?? true, isTty: setup.isTty ?? true, running: setup.running ?? true,
    ...linkSettings(setup.settings ?? {}),
    ...inviteEnv === undefined ? {} : { inviteEnv },
    platform: "linux",
    readFile: (path) => { if (path !== "/invite") throw new Error("ENOENT"); return `${line}\n`; },
    readStdin: async () => setup.stdin ?? `  ${line}\n`,
    out: (text) => { out.push(text); heard(text); },
    err: (text) => { err.push(text); heard(text); },
  });
  return {
    code, out: out.join(""), err: err.join(""), line, made: madeLine, service, serverId: identity.server_id, endpoint: bytesToHex(importPublicKey(identity.public_key)), local, calls, bodies, beforeQuestion, pressed, stateDir, state,
    listed: () => service.pcs(ACCOUNT).filter((entry) => entry.server_id === identity.server_id),
  };
}

/** The private key a join line carries, as the line spells it. */
const secretOf = (line: string): string => (JSON.parse(Buffer.from(line.slice("ovis-join:1:".length), "base64url").toString("utf8")) as { secret: string }).secret;

/** Nothing this run wrote shows the invite, or its secret apart, and nothing it sent the account service carries either. */
function expectNoInvite(run: Run): void {
  const secret = secretOf(run.made);
  expect(secret).toHaveLength(184);
  const payload = run.made.slice("ovis-join:1:".length);
  for (const text of [run.out, run.err, ...run.bodies]) {
    for (const part of [secret, payload, secret.slice(40, 80), payload.slice(-60)]) expect(text).not.toContain(part);
    // a line's start ({"v":1 in base64url): the prefix alone may be named, never what follows it
    expect(text).not.toContain("ovis-join:1:eyJ");
  }
}

describe("ovis join: the invite", () => {
  it("is read from a file, standard input, the line on the command line or OVIS_INVITE, trimmed", async () => {
    const pinned = ["--account", "acct_1"];
    for (const [form, setup] of [
      ["a file", { args: ["--invite-file", "/invite", ...pinned] }],
      ["standard input", { args: ["-", ...pinned] }],
      ["the command line", { args: (line: string) => [line, ...pinned] }],
      ["OVIS_INVITE", { args: pinned, inviteEnv: (line: string) => ` ${line}\n` }],
    ] as const) {
      const run = await joining({ ...setup, terminal: false, isTty: false, pressAfter: 1 });
      expect([form, run.code]).toEqual([form, 0]);
      expect(run.calls).toContain("POST /v1/pc-invites/redeem");
      expectNoInvite(run);
    }
    // OVIS_INVITE only where no other form names one
    const both = await joining({ args: ["--invite-file", "/invite", ...pinned], inviteEnv: "ovis-join:1:x", terminal: false, isTty: false, pressAfter: 1 });
    expect(both.code).toBe(0);
  });

  it("refuses two ways at once, none, an unknown flag and a bad --account before anything is asked, never repeating a word that could be the invite", async () => {
    const line = (await newInvite(SERVICE, "acct_1", null)).line;
    for (const [args, said] of [
      [[line, "--invite-file", "/invite"], "give the invite one way only"],
      [[line, line], "give the invite one way only"],
      [["-", "--invite-file", "/invite"], "give the invite one way only"],
      [[], "needs the invite a device of your account made"],
      [["--invite-file"], "--invite-file needs a value"],
      [["--force", line], "unknown flag --force"],
      [[`--account=${line}`, "--invite-file", "/invite"], "--account takes the id of the Ovis account the invite is for"],
    ] as const) {
      const run = await joining({ args });
      expect([args, run.code]).toEqual([args, JOIN_EXIT.usage]);
      expect(run.out).toContain(said);
      expect(run.out).not.toContain(secretOf(line).slice(40, 80));
      expect(run.local).toEqual([]);
      expect(run.calls).toEqual([]);
    }
    const unread = await joining({ args: ["--invite-file", "/elsewhere"] });
    expect(unread.code).toBe(JOIN_EXIT.usage);
    expect(unread.out).toBe("Could not read the file --invite-file names (it must be a file you can read). Nothing was sent.\n");
    expect(parseJoinArgs(["--json", "-", "--account=acct_1"])).toEqual({ source: { kind: "stdin" }, account: "acct_1", json: true });
  });

  it("refuses anything but a join line in its one form, before any request, naming no part of it", async () => {
    const NOT_ONE = "That is not an Ovis invite: an invite is one line that starts with ovis-join:1:, made on a device signed in to your account. Nothing was sent.\n";
    for (const line of [
      (made: string) => `${made}x`, (made: string) => made.slice(0, -1), () => "hello", (made: string) => made.replace("ovis-join:1:", "ovis-join:2:"),
      (made: string) => made.replace("ovis-join:1:", "ovis-invite:1:"), () => `ovis-invite:1:acct_1:${"A".repeat(42)}w`, (made: string) => `${made}=`,
    ]) {
      const run = await joining({ line });
      expect(run.code).toBe(JOIN_EXIT.invite_invalid);
      expect(run.out).toBe(NOT_ONE);
      expect(run.local).toEqual([]);
      expect(run.calls).toEqual([]);
      expectNoInvite(run);
    }
  });

  it("acts only on a line for this PC's own account service; nothing is sent otherwise", async () => {
    for (const other of ["https://account.ovis.sh", "https://account.test:8443", "https://evil.example"]) {
      const run = await joining({ inviteService: other });
      expect([other, run.code]).toEqual([other, JOIN_EXIT.invite_invalid]);
      expect(run.out).toBe("This invite is for another account service than the one this PC uses (https://account.test). Nothing was sent. Ask for an invite on a device signed in to that service, or check OVIS_ACCOUNT_SERVICE_URL here.\n");
      expect([run.local, run.calls]).toEqual([[], []]);
    }
  });

  describe("a line that names the account's signed list", () => {
    const LIST = "0f484e9226ad290aaac6dea9244aced4e2b7b97297ecd8d52d437a57c33e5383";
    /** This PC's own keys for the list, as its card names them. */
    const pcKeys = listMember();
    /**
     * this PC as one that follows lists: it says so, and answers the joins by the list as `joins` has them. `prepared`:
     * what it answers a join's preparation (an invite a PC joins with by itself)
     */
    const following = (joins: (count: number, body: Record<string, unknown>) => Response, prepared?: () => Response | Promise<Response>) => {
      const asked: Record<string, unknown>[] = [];
      let endpoint = "";
      const card = async () => ({ key: (await pcKeys).key, enc: (await pcKeys).enc, endpoint, list: LIST });
      return { asked, card, endpointIs: (value: string) => { endpoint = value; }, localAnswer: (path: string, request: Request): Promise<Response> | Response | undefined => {
        if (path === "/api/account/list" && request.method === "GET") return Response.json({ pinned: false });
        if (path === "/api/account/list/join/prepare" && prepared) return prepared();
        if (path !== "/api/account/list/join") return undefined;
        return request.json().then(async (body) => {
          const sent = body as Record<string, unknown>;
          // the first ask brings no proof: the PC hands over its own card, for the line to sign its proof for
          if (sent.proof === undefined) return Response.json({ state: "prove", card: await card() });
          asked.push(sent);
          return joins(asked.length, sent);
        });
      } };
    };

    it("is refused on an Ovis that follows no list, before anything is sent: the invite stays unused", async () => {
      const listed = await joining({ inviteList: LIST });
      expect(listed.code).toBe(JOIN_EXIT.not_available);
      expect(listed.out).toBe("This invite is for an account with a signed member list, which needs a newer Ovis on this PC. Update it in Settings → Updates, then run this again. Nothing was sent.\n");
      expect(listed.calls).toEqual([]);
      expectNoInvite(listed);
    });

    it("joins by that list: this PC is asked whether its list holds it, with the account and the list the line names, and never for the account service's admission", async () => {
      const pc = following((count) => Response.json(count < 3 ? { state: "waiting", standing: "waiting" } : { state: "added", account: "acct_1" }));
      const run = await joining({ inviteList: LIST, localAnswer: pc.localAnswer, beforeRun: (endpoint) => pc.endpointIs(endpoint) });
      expect(run.code).toBe(0);
      // each ask names the account, the list and the invite, and carries the line's proof for the card the PC handed over
      expect(pc.asked).toHaveLength(3);
      const { key } = await readJoinLine(run.made, { service: SERVICE, followsLists: true });
      for (const ask of pc.asked) {
        expect(ask).toEqual({ account: "acct_1", list: LIST, invite: key, proof: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) });
        expect(await verifyLineProof({ account: "acct_1", server_id: run.serverId, list: LIST, card: await pc.card() }, ask.proof, key)).toBe(true);
      }
      expect(run.pressed).toEqual([]);
      expect(run.out).toContain("Added: this PC is in your account (acct_1)");
      expectNoInvite(run);
    });

    it("an invite a PC joins with by itself, on a PC the list holds already: the line proves the join for this PC's own card, and signs no join", async () => {
      const pc: ReturnType<typeof following> = following(() => Response.json({ state: "added", account: "acct_1" }), async () => Response.json({ state: "prove", card: await pc.card() }));
      const run = await joining({ auto: true, inviteList: LIST, localAnswer: pc.localAnswer, beforeRun: (endpoint) => pc.endpointIs(endpoint) });
      expect(run.code).toBe(0);
      const { key } = await readJoinLine(run.made, { service: SERVICE, followsLists: true });
      expect(pc.asked).toHaveLength(1);
      expect(await verifyLineProof({ account: "acct_1", server_id: run.serverId, list: LIST, card: await pc.card() }, pc.asked[0]!.proof, key)).toBe(true);
      expect(run.local).not.toContain("POST /api/account/list/join/body");
      expect(run.local).not.toContain("POST /api/account/list/join/place");
    });

    it("an invite a PC joins with by itself, on a PC its account bound meanwhile though its join still says waiting: it is added, and keeps its listing", async () => {
      let prepared = 0;
      const run = await joining({ auto: true, inviteList: LIST, localAnswer: (path, request) => {
        if (path === "/api/account/list" && request.method === "GET") return Response.json({ pinned: false });
        // the PC is in its list and pinned, and its copy has not reached the disk yet: each ask says it waits
        if (path === "/api/account/list/join/prepare") { prepared++; return Response.json({ state: "waiting", standing: "in" }); }
        if (path === "/api/account/status" && prepared > 0) return Response.json({ account: "acct_1", enrolling: false });
        return undefined;
      } });
      expect(prepared).toBeGreaterThan(0);
      expect(run.code).toBe(0);
      expect(run.listed()).toHaveLength(1);
      expect(run.out + run.err).not.toContain("was not added");
    });

    it("an invite a PC joins with by itself, where the account service hands a key to the names that the list does not commit to: it says so once, and joins without names", async () => {
      const handed = newEpochKey(1);
      const committed = epochKeyCommitment({ list: LIST, epoch: newEpochKey(1) });
      const bodies: Record<string, unknown>[] = [];
      let prepares = 0;
      const run = await joining({ auto: true, inviteList: LIST, localAnswer: (path, request) => {
        if (path === "/api/account/list" && request.method === "GET") return Response.json({ pinned: false });
        if (path === "/api/account/list/join/prepare") return request.json().then(async (body) => {
          prepares++;
          // a wrap the line opens, of a key the list's opening entry does not commit to
          const wrap = await wrapEpochKey({ list: LIST, epoch: handed, member: (body as { invite: string }).invite });
          return Response.json({ state: "prepared", list: LIST, seq: 3, enc: (await pcKeys).enc, seal: { epoch: 1, opens: committed }, wraps: [{ epoch: 1, wrap: wrapToText(wrap!) }] });
        });
        if (path === "/api/account/list/join/body") return request.json().then((body) => {
          bodies.push(body as Record<string, unknown>);
          return Response.json(bodies.length < 2 ? { state: "again" } : { state: "added", account: "acct_1" });
        });
        return undefined;
      } });
      expect(run.code).toBe(0);
      expect(prepares).toBe(2);
      const said = (run.out + run.err).split("does not commit to").length - 1;
      expect(said).toBe(1);
      expect(run.out + run.err).toContain("Tell the account's owner: the account service did this.");
      // nothing sealed under a key the list does not commit to
      for (const body of bodies) expect(body).not.toHaveProperty("sealed");
    });

    it("ends with this PC's own words where it will not join that list, and takes itself off the account's list", async () => {
      const pc = following(() => Response.json({ error: { code: "list_removed", message: "This PC was removed from this Ovis account. It can come back only as a new PC: on the PC, reset its relay identity, then add it again." } }, { status: 409 }));
      const run = await joining({ inviteList: LIST, localAnswer: pc.localAnswer, beforeRun: (endpoint) => pc.endpointIs(endpoint) });
      expect(run.code).toBe(JOIN_EXIT.not_added);
      expect(run.out).toContain("Could not add this PC: This PC was removed from this Ovis account.");
      expect(run.listed()).toEqual([]);
      expect(run.pressed).toEqual([]);
    });
  });

  it("sends the invite's public key and a signature over this account, this PC and this challenge: never the line or its secret", async () => {
    const run = await joining({ pressAfter: 1 });
    expect(run.code).toBe(0);
    const redeem = JSON.parse(run.bodies[run.calls.indexOf("POST /v1/pc-invites/redeem")]!) as Record<string, string>;
    expect(Object.keys(redeem).sort()).toEqual(["challenge_id", "invite_key", "invite_signature", "label", "os", "proof", "public_key", "relay", "server_id"]);
    expect(redeem.invite_signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expectNoInvite(run);
  });
});

describe("ovis join: the account it joins", () => {
  it("asks at a terminal, naming the account, before anything goes to the account service; anything but yes ends it with the invite unused", async () => {
    for (const answer of ["y", "", "no", "yes please"]) {
      const run = await joining({ confirm: answer });
      expect([answer, run.code]).toEqual([answer, JOIN_EXIT.not_confirmed]);
      expect(run.out).toContain(ASKED);
      expect(run.out.endsWith("This PC was not added, and the invite was not used.\n")).toBe(true);
      // the invite was made; nothing went to the account service from this run
      expect(run.calls).toEqual([]);
      expect(run.local).toEqual(["GET /api/account/status", "POST /api/account/one-press"]);
      expect(run.listed()).toEqual([]);
      expectNoInvite(run);
    }
    const yes = await joining({ confirm: "ＹＥＳ", pressAfter: 1 });
    expect(yes.code).toBe(0);
    // what was asked before the question: this PC's account, and whether it takes a press (asked with no account)
    expect(yes.beforeQuestion).toEqual({ service: [], local: ["GET /api/account/status", "POST /api/account/one-press"] });
  });

  it("with --account, asks nothing when it is the invite's account, and sends nothing at all when it is another", async () => {
    const same = await joining({ args: ["--invite-file", "/invite", "--account", "acct_1"], pressAfter: 1 });
    expect(same.code).toBe(0);
    expect(same.out).not.toContain("Is this your account?");
    expect(same.out).toContain("Ovis account acct_1 is the one --account names.\n");
    for (const other of ["acct_2", "acct_10", "acct"]) {
      const run = await joining({ args: ["--invite-file", "/invite", `--account=${other}`, "--json"] });
      expect([other, run.code]).toEqual([other, JOIN_EXIT.account_mismatch]);
      // the invite's account is not named: whoever made the invite chose it
      const said = "The invite is for another Ovis account than the one --account names. Nothing was sent, and the invite was not used. ovis status --json on a PC already in your account shows its full id.";
      expect(run.err).toBe(`${said}\n`);
      expect(JSON.parse(run.out)).toEqual({ ok: false, error: "account_mismatch", message: said });
      expect(run.local).toEqual([]);
      expect(run.calls).toEqual([]);
    }
  });

  it("with --account, takes the account's start as Settings and ovis status show it (12 characters or more), as ovis add does", async () => {
    const long = "acct_0123456789abcdef";
    for (const given of [long, long.slice(0, 12), long.slice(0, 16)]) {
      const run = await joining({ inviteAccount: long, args: ["--invite-file", "/invite", "--account", given], terminal: false, isTty: false, pressAfter: 1 });
      expect([given, run.code]).toEqual([given, 0]);
    }
    for (const given of [long.slice(0, 11), `${long.slice(0, 12)}x`]) {
      const run = await joining({ inviteAccount: long, args: ["--invite-file", "/invite", "--account", given], terminal: false, isTty: false });
      expect([given, run.code]).toEqual([given, JOIN_EXIT.account_mismatch]);
      expect(run.out).not.toContain(long.slice(0, 6));
    }
  });

  it("refuses where nobody can type yes and no --account names the account, naming --account, with nothing sent", async () => {
    for (const [terminal, isTty] of [[false, false], [true, false], [false, true]] as const) {
      const run = await joining({ terminal, isTty });
      expect([terminal, isTty, run.code]).toEqual([terminal, isTty, JOIN_EXIT.not_confirmed]);
      expect(run.out).toContain("Not run in a terminal, so nobody here can confirm the account the invite is for. Run ovis join --account <the account's id>");
      expect(run.calls).toEqual([]);
    }
    // standard input that carried the invite is no terminal to type at
    const piped = await joining({ args: ["-"] });
    expect(piped.code).toBe(JOIN_EXIT.not_confirmed);
    // with --json nothing is asked, at a terminal too: --account names the account
    const json = await joining({ args: ["--invite-file", "/invite", "--json"] });
    expect(json.code).toBe(JOIN_EXIT.not_confirmed);
    expect(json.beforeQuestion).toBeNull();
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, error: "not_confirmed" });
    expect(json.err).toContain("With --json nothing is asked: name the account with ovis join --account <the account's id>");
    expect(json.calls).toEqual([]);
  });

  it("under the fleet preview, asks at a terminal even with --account, as ovis add does, and refuses anywhere else", async () => {
    const preview = { settings: { OVIS_PREVIEW: "fleet" } };
    const asked = await joining({ ...preview, args: ["--invite-file", "/invite", "--account", "acct_1"], pressAfter: 1 });
    expect(asked.code).toBe(0);
    expect(asked.out).toContain(ASKED);
    for (const setup of [{ terminal: false, isTty: false }, { args: ["--invite-file", "/invite", "--account", "acct_1", "--json"] }] as Setup[]) {
      const refused = await joining({ ...preview, args: ["--invite-file", "/invite", "--account", "acct_1"], ...setup });
      expect(refused.code).toBe(JOIN_EXIT.not_confirmed);
      expect(refused.out + refused.err).toContain("Adding this PC needs a terminal");
      expect(refused.calls).toEqual([]);
    }
  });

  it("says so and redeems nothing when this PC is in that account already; refuses another account, naming logout", async () => {
    const same = await joining({ inAccount: "acct_1" });
    expect(same.code).toBe(0);
    expect(same.out).toBe("This PC is already in Ovis account acct_1. The invite was not used.\n");
    expect(same.calls).toEqual([]);
    // the invite is still good for another PC
    const json = await joining({ inAccount: "acct_1", args: ["--invite-file", "/invite", "--json", "--account", "acct_1"] });
    expect(JSON.parse(json.out)).toEqual({ ok: true, account: "acct_1", added: false, online: null });
    const other = await joining({ inAccount: "acct_other0000" });
    expect(other.code).toBe(JOIN_EXIT.other_account);
    expect(other.out).toBe("This PC is in another Ovis account (acct_other00). Run ovis logout to take it out of that one first, then run ovis join again. The invite was not used.\n");
    expect(other.calls).toEqual([]);
  });
});

describe("ovis join: adding this PC", () => {
  it("a plain invite lists this PC with its own proof, says to press Add, and waits for it as ovis add does; then the PC is bound and its relay online", async () => {
    const run = await joining({ pressAfter: 3 });
    expect(run.code).toBe(0);
    expect(run.out).toContain("This PC is listed in Ovis account acct_1 as old-desktop. Open Ovis on your phone or another device signed in to that account and press Add for old-desktop (its card shows for 10 minutes).\nWaiting… (up to 10:00, Ctrl+C to stop)\n");
    expect(run.out.endsWith(`Added. Open old-desktop from My PCs.\n${HINT}${CLOSING}`)).toBe(true);
    expect(run.pressed).toEqual(["acct_1", "acct_1", "acct_1"]);
    expect(run.listed().map((entry) => entry.listed_by_device)).toEqual([false]);
    // listed by redeeming, with the label ovis add gives the PC; then named for its relay pass, and asked about the press
    expect(run.calls.filter((call) => !call.endsWith("/challenge"))).toEqual(["POST /v1/pc-invites/redeem", "POST /v1/pc/admission", "POST /v1/pc/admission", "POST /v1/pc/admission"]);
    expect(run.local).toContain("POST /api/relay/link/close");
    expect(run.local.indexOf("POST /api/account/relay-account")).toBeLessThan(run.local.lastIndexOf("POST /api/account/one-press"));
    expectNoInvite(run);
  });

  it("an auto invite is admitted at once: no Add to press, nothing to wait for", async () => {
    const run = await joining({ auto: true, args: ["--invite-file", "/invite", "--account", "acct_1"], terminal: false, isTty: false });
    expect(run.code).toBe(0);
    expect(run.pressed).toEqual(["acct_1"]);
    expect(run.out).toBe([
      "Ovis account acct_1 is the one --account names.\n",
      "This PC is listed in Ovis account acct_1 as old-desktop, and the invite adds it with no Add to press.\n",
      `Added. Open old-desktop from My PCs.\n${HINT}${CLOSING}`,
    ].join(""));
    expectNoInvite(run);
  });

  it("nobody pressing Add while its card offers it takes this PC off the account's list again, with its own exit code", async () => {
    const run = await joining({ args: ["--invite-file", "/invite", "--json", "--account", "acct_1"] });
    expect(run.code).toBe(JOIN_EXIT.no_add);
    expect(run.code).not.toBe(JOIN_EXIT.invite_invalid);
    expect(run.err).toContain("Nobody pressed Add for old-desktop within 10 minutes of its listing. This PC was taken off your account's list; it is in no account. Ask for a new invite to try again.\n");
    expect(JSON.parse(run.out)).toEqual({ ok: false, error: "no_add", message: "Not added while its card offered Add: nobody pressed it, or a device declined it.", listed: false });
    expect(run.calls).toContain(`POST /v1/pcs/${run.serverId}/leave`);
    expect(run.listed()).toEqual([]);
    expectNoInvite(run);
  });

  it("Ctrl+C while it waits takes this PC off the account's list, so no half-listed PC stays", async () => {
    const run = await joining({ stopAt: 2 });
    expect(run.code).toBe(JOIN_EXIT.stopped);
    expect(run.out.endsWith("Stopped. This PC was taken off your account's list; it is in no account. Ask for a new invite to try again.\n")).toBe(true);
    expect(run.listed()).toEqual([]);
    expectNoInvite(run);
  });

  it("run again with the same invite within its 15 minutes, finishes what a run that could not leave began", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    const stateDir = mkdtempSync(joinPath(tmpdir(), "ovis-join-"));
    scratch.push(stateDir);
    let line = "";
    // the first run stops, and its leave does not reach the account service
    const first = await joining({ service, time, stateDir, stopAt: 2, line: (made) => { line = made; return made; }, serviceAnswer: (path) => path.endsWith("/leave") ? Response.json({ error: { code: "unavailable" } }, { status: 503 }) : undefined });
    expect(first.code).toBe(JOIN_EXIT.stopped);
    expect(first.out).toContain("could not be taken off your account's list just now: choose No on its card on a device of your account, or run ovis join again.");
    expect(first.listed()).toHaveLength(1);
    time.pass(60_000);
    const again = await joining({ service, time, stateDir, line: () => line, pressAfter: 1 });
    expect(again.code).toBe(0);
    expect(again.listed().map((entry) => entry.listed_by_device)).toEqual([false]);
    expectNoInvite(again);
  });

  it("with --json: one object on stdout at the end, every other word on stderr, and no watch for a first device even at a terminal", async () => {
    const run = await joining({ args: ["--json", "--invite-file", "/invite", "--account", "acct_1"], pressAfter: 1 });
    expect(run.code).toBe(0);
    expect(run.out.split("\n")).toHaveLength(2);
    expect(JSON.parse(run.out)).toEqual({ ok: true, account: "acct_1", added: true, online: true });
    expect(run.err).toContain("Ovis account acct_1 is the one --account names.\n");
    expect(run.err).toContain("Added. Open old-desktop from My PCs.\n");
    expect(run.local).not.toContain("GET /api/relay/joins");
    expectNoInvite(run);
  });
});

describe("ovis join: what the account service says", () => {
  const plainly = (setup: Setup = {}) => joining({ args: ["--invite-file", "/invite", "--account", "acct_1", "--json"], terminal: false, isTty: false, ...setup });
  const UNCLEAR = "The account service did not say whether it took this PC. Try again in a moment. This PC was taken off that account's list again; the invite may be spent.";
  const answered = (code: string, status: number, headers: Record<string, string> = {}) => (path: string) =>
    path === "/v1/pc-invites/redeem" ? Response.json({ error: { code, message: `the service's own words ${code}` } }, { status, headers }) : undefined;

  it("an invite another PC used is the one invite_invalid, in its own words", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    let line = "";
    const first = await plainly({ service, time, pressAfter: 1, line: (made) => { line = made; return made; } });
    expect(first.code).toBe(0);
    const second = await plainly({ service, time, line: () => line });
    expect(second.code).toBe(JOIN_EXIT.invite_invalid);
    expect(JSON.parse(second.out)).toEqual({ ok: false, error: "invite_invalid", message: "This invite does not work: it is mistyped, used or expired (an invite works once, for 15 minutes). Ask for a new one." });
    expect(second.listed()).toEqual([]);
    expectNoInvite(second);
  });

  it("an invite past its 15 minutes is invite_invalid, and nothing stays listed", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    const owner = service.issueToken("acct_1");
    const fresh = await newInvite(SERVICE, "acct_1", null);
    expect((await service.fetch(new Request(`${SERVICE}/v1/pc-invites`, { method: "POST", headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify({ invite_key: fresh.key }) }))).status).toBe(200);
    const line = fresh.line;
    time.pass(15 * 60_000);
    const run = await plainly({ service, time, line: () => line });
    expect(run.code).toBe(JOIN_EXIT.invite_invalid);
    expect(run.listed()).toEqual([]);
    // the window the listing opened is closed again
    expect(run.local.at(-1)).toBe("POST /api/relay/link/close");
  });

  it("maps each refusal to its own exit code and name, in its own words, never the service's", async () => {
    for (const [setup, error, said] of [
      [{ serviceAnswer: answered("rate_limited", 429, { "retry-after": "60" }) }, "rate_limited", "The account service asks this PC to wait: try again in 60 seconds."],
      [{ serviceAnswer: answered("pc_add_cap", 429, { "retry-after": "18000" }) }, "pc_add_cap", "Your Ovis account has added as many PCs as it may for now: try again in 5 hours. The invite was not used."],
      [{ serviceAnswer: answered("directory_full", 409) }, "directory_full", "Your account holds as many PCs as it can. Remove one in the Ovis app, then run ovis join again (with a new invite once this one ran out)."],
      [{ serviceAnswer: answered("not_found", 404) }, "not_available", "The account service takes no PC invites for this account. Add this PC with ovis add instead."],
      [{ serviceAnswer: answered("internal", 500) }, "service_unreachable", UNCLEAR],
      [{ serviceAnswer: (path: string) => { if (path === "/v1/pc-invites/redeem") throw new TypeError("fetch failed"); return undefined; } }, "service_unreachable", UNCLEAR],
      [{ serviceAnswer: (path: string) => path === "/v1/pc-invites/redeem" ? new Response("<html>", { status: 200 }) : undefined }, "service_unreachable", UNCLEAR],
      [{ serviceAnswer: answered("list_endpoint", 409) }, "not_added", "The account service did not take this PC (list_endpoint). This PC was not added."],
      [{ blocked: "serve_only" }, "relay_unavailable", "The Ovis relay cannot run here (serve_only). Nothing was sent."],
      [{ running: false }, "not_running", "Ovis is not running on this PC. Start it (ovis start, or open the app), then run this again."],
    ] as const) {
      const run = await plainly(setup as Setup);
      expect([error, run.code]).toEqual([error, JOIN_EXIT[error]]);
      const object = JSON.parse(run.out) as { ok: boolean; error: string; message: string; retry_after?: number };
      expect([error, object.ok, object.error, object.message]).toEqual([error, false, error, said]);
      expect(run.err.endsWith(`${said}\n`)).toBe(true);
      expect(run.err).not.toContain("the service's own words");
      if (said === UNCLEAR) expect([error, run.calls.filter((call) => call === "POST /v1/pc-invites/redeem").length, run.calls.at(-1)]).toEqual([error, 3, `POST /v1/pcs/${run.serverId}/leave`]);
      if (error === "rate_limited") expect(object.retry_after).toBe(60);
      if (error === "pc_add_cap") expect(object.retry_after).toBe(18000);
      expect(run.listed()).toEqual([]);
      expectNoInvite(run);
    }
  });

  it("asks again, with a fresh proof, when its proof lapsed on the way or the service says try_again", async () => {
    let tries = 0;
    const run = await plainly({ pressAfter: 1, serviceAnswer: (path) => {
      if (path !== "/v1/pc-invites/redeem" || ++tries > 2) return undefined;
      return Response.json({ error: { code: tries === 1 ? "proof_invalid" : "try_again" } }, { status: tries === 1 ? 401 : 409 });
    } });
    expect(run.code).toBe(0);
    expect(run.calls.filter((call) => call === "POST /v1/pc-invites/redeem")).toHaveLength(3);
    // each try answers a challenge of its own, with a signature of its own
    const tried = run.bodies.filter((_, index) => run.calls[index] === "POST /v1/pc-invites/redeem").map((body) => JSON.parse(body) as { challenge_id: string; invite_signature: string });
    expect(new Set(tried.map((body) => body.challenge_id)).size).toBe(3);
    expect(new Set(tried.map((body) => body.invite_signature)).size).toBe(3);
  });

  it("an account's daily PC adds used up answer an auto invite's redeem with pc_add_cap and its retry-after", async () => {
    const run = await plainly({ auto: true, afterMade: async (service) => {
      // three PCs added in one press today
      for (let added = 0; added < 3; added++) {
        const other = mkdtempSync(joinPath(tmpdir(), "ovis-join-other-"));
        scratch.push(other);
        const pc = loadRelayIdentity(other);
        const owner = service.issueToken("acct_1");
        await service.fetch(new Request(`${SERVICE}/v1/pcs/${pc.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${owner}` }, body: JSON.stringify({ label: "pc", public_key: bytesToHex(importPublicKey(pc.public_key)), relay: RELAY }) }));
        expect((await service.fetch(new Request(`${SERVICE}/v1/pcs/${pc.server_id}/admit`, { method: "POST", headers: { authorization: `Bearer ${owner}` }, body: "{}" }))).status).toBe(200);
      }
    } });
    expect(run.code).toBe(JOIN_EXIT.pc_add_cap);
    expect((JSON.parse(run.out) as { retry_after: number }).retry_after).toBeGreaterThan(0);
  });

  it("the PC's ask past a plain invite card's ten minutes ends the wait, and takes the PC off the list", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    const stateDir = mkdtempSync(joinPath(tmpdir(), "ovis-join-"));
    scratch.push(stateDir);
    let line = "";
    // a first run that died outright left the listing; the next comes 11 minutes later, still within the invite's 15
    await joining({ service, time, stateDir, args: ["--invite-file", "/invite", "--account", "acct_1"], terminal: false, isTty: false, stopAt: 1, line: (made) => { line = made; return made; }, serviceAnswer: (path) => path.endsWith("/leave") ? Response.json({}, { status: 503 }) : undefined });
    time.pass(11 * 60_000);
    const run = await joining({ service, time, stateDir, args: ["--invite-file", "/invite", "--account", "acct_1", "--json"], terminal: false, isTty: false, line: () => line });
    // the service's card_until said so: no wait for an Add nobody can press
    expect(run.code).toBe(JOIN_EXIT.no_add);
    expect(JSON.parse(run.out)).toEqual({ ok: false, error: "no_add", listed: false,
      message: "The card that offers Add for this PC ran out 10 minutes after the invite was first used. Ask for a new invite. This PC was taken off that account's list again; the invite may be spent." });
    expect(run.pressed).toEqual([]);
    expect(run.listed()).toEqual([]);
  });
});

describe("ovis join: what a run that does not finish leaves", () => {
  const pinned = { args: ["--invite-file", "/invite", "--account", "acct_1", "--json"], terminal: false, isTty: false } as const;
  const redeems = (run: Run) => run.calls.filter((call) => call === "POST /v1/pc-invites/redeem").length;
  const leaves = (run: Run) => run.calls.filter((call) => call.endsWith("/leave")).length;

  it("asks again when the service's answer to the redeem was lost, and the same PC and key get the same listing", async () => {
    let lost = false;
    const run = await joining({ ...pinned, pressAfter: 1, serviceAnswer: async (path, _request, _stop, forward) => {
      if (path !== "/v1/pc-invites/redeem" || lost) return undefined;
      lost = true;
      // the service took it; its answer never came back
      expect((await forward()).status).toBe(200);
      throw new TypeError("connection reset");
    } });
    expect(run.code).toBe(0);
    expect([redeems(run), leaves(run)]).toEqual([2, 0]);
    expect(run.listed().map((entry) => entry.listed_by_device)).toEqual([false]);
  });

  it("takes the PC off the list when the service took the redeem but no answer could be read, and says the invite may be spent", async () => {
    const run = await joining({ ...pinned, serviceAnswer: async (path, _request, _stop, forward) => {
      if (path !== "/v1/pc-invites/redeem") return undefined;
      await forward();
      return new Response("upstream timed out", { status: 504 });
    } });
    expect(run.code).toBe(JOIN_EXIT.service_unreachable);
    expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: "service_unreachable", listed: false });
    expect([redeems(run), leaves(run)]).toEqual([3, 1]);
    expect(run.listed()).toEqual([]);
  });

  it("Ctrl+C while the redeem is on its way takes off what it may have listed, and still prints its one object", async () => {
    const run = await joining({ ...pinned, serviceAnswer: async (path, _request, stop, forward) => {
      if (path !== "/v1/pc-invites/redeem") return undefined;
      await forward();
      stop();
      throw new DOMException("aborted", "AbortError");
    } });
    expect(run.code).toBe(JOIN_EXIT.stopped);
    expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: "stopped", listed: false });
    expect(leaves(run)).toBe(1);
    expect(run.listed()).toEqual([]);
  });

  it("takes off the listing the service made under another account than the invite's, and adds nothing", async () => {
    const run = await joining({ ...pinned, serviceAnswer: (path) => path === "/v1/pc-invites/redeem"
      ? Response.json({ account: "acct_2", listing_id: "0".repeat(32), auto: false, card_until: null, admission_until: null }) : undefined });
    expect(run.code).toBe(JOIN_EXIT.not_added);
    expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: "not_added", listed: false });
    const left = JSON.parse(run.bodies[run.calls.findIndex((call) => call.endsWith("/leave"))]!) as { account: string };
    expect(left.account).toBe("acct_2");
    expect(run.pressed).toEqual([]);
  });

  it("an auto invite asks a few times for its admission, and when it is not there takes the PC off the list", async () => {
    let asks = 0;
    const missing = (path: string) => path === "/v1/pc/admission" && ++asks <= 2 ? Response.json({ error: { code: "no_admission", message: "none" } }, { status: 404 }) : undefined;
    const late = await joining({ ...pinned, auto: true, serviceAnswer: missing });
    expect(late.code).toBe(0);
    expect(late.pressed).toHaveLength(3);
    const never = await joining({ ...pinned, auto: true, serviceAnswer: (path) => path === "/v1/pc/admission" ? Response.json({ error: { code: "no_admission", message: "none" } }, { status: 404 }) : undefined });
    expect(never.code).toBe(JOIN_EXIT.not_added);
    expect(never.pressed).toHaveLength(3);
    expect(JSON.parse(never.out)).toMatchObject({ ok: false, error: "not_added", listed: false });
    expect(never.listed()).toEqual([]);
  });

  it("puts back the account named for the relay pass and the relay it turned on, and closes its window, when it ends unbound", async () => {
    for (const namedBefore of [undefined, "acct_9"]) {
      const run = await joining({ ...pinned, relayOff: true, ...namedBefore === undefined ? {} : { namedBefore } });
      expect(run.code).toBe(JOIN_EXIT.no_add);
      expect(run.state.namings.at(-1)).toBe(namedBefore ?? null);
      expect(run.state.named).toBe(namedBefore ?? null);
      expect([run.state.relayOn, run.state.stops]).toEqual([false, 1]);
      expect(run.local.at(-1)).not.toBe("POST /api/relay/link");
      expect(run.local).toContain("POST /api/relay/link/close");
    }
    // added: the relay stays on, named for the account it is in
    const added = await joining({ ...pinned, relayOff: true, pressAfter: 1 });
    expect(added.code).toBe(0);
    expect([added.state.relayOn, added.state.stops, added.state.named]).toEqual([true, 0, "acct_1"]);
    // a relay that was on stays on
    const on = await joining({ ...pinned });
    expect([on.state.relayOn, on.state.stops]).toEqual([true, 0]);
  });

  it("asks once more for an Add pressed in the card's last seconds before it takes the PC off the list", async () => {
    // the 101st ask is the one after the wait: an Add pressed just then is taken
    const run = await joining({ ...pinned, pressAfter: 102 });
    expect(run.code).toBe(0);
    expect(leaves(run)).toBe(0);
    expect(run.pressed).toHaveLength(102);
  });

  it("waits for Add only as long as the service says the card offers it", async () => {
    const time = clock();
    const service = new FakeAccountService(time.now);
    const stateDir = mkdtempSync(joinPath(tmpdir(), "ovis-join-"));
    scratch.push(stateDir);
    let line = "";
    await joining({ ...pinned, service, time, stateDir, stopAt: 1, line: (made) => { line = made; return made; }, serviceAnswer: (path) => path.endsWith("/leave") ? Response.json({}, { status: 503 }) : undefined });
    time.pass(4 * 60_000);
    const again = await joining({ ...pinned, service, time, stateDir, line: () => line });
    const [, minutes] = /Waiting… \(up to (\d+):\d\d, Ctrl\+C to stop\)/.exec(again.err) ?? [];
    // 10 minutes from the first redeem, 4 of them gone: not 10 from this run
    expect(Number(minutes), again.err).toBe(6);
    expect(again.code).toBe(JOIN_EXIT.no_add);
  });

  it("prints one object with its own exit code for any error of its own: a local answer that is not JSON, a relay key that does not read", async () => {
    for (const localAnswer of [
      (path: string) => path === "/api/relay/link" ? new Response("not json", { status: 200 }) : undefined,
      (path: string) => path === "/api/relay/link" ? Response.json({ url: 42 }) : undefined,
    ]) {
      const run = await joining({ ...pinned, localAnswer });
      expect(run.code, run.err).toBe(JOIN_EXIT.internal);
      expect(run.out.split("\n")).toHaveLength(2);
      expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: "internal" });
      expect(run.calls).toEqual([]);
    }
  });
});

describe("ovis join: the invite file", () => {
  it("reads a regular file up to the cap and one byte more, and refuses a FIFO, a folder or a device at once", async () => {
    const dir = mkdtempSync(joinPath(tmpdir(), "ovis-join-file-"));
    scratch.push(dir);
    const file = joinPath(dir, "invite");
    writeFileSync(file, "ovis-join:1:x\n");
    expect(readInviteFile(file)).toBe("ovis-join:1:x\n");
    writeFileSync(file, "x".repeat(10_000));
    expect(readInviteFile(file)).toHaveLength(4097);
    const fifo = joinPath(dir, "fifo");
    if (process.platform !== "win32" && spawnSync("mkfifo", [fifo]).status === 0) {
      const started = Date.now();
      expect(() => readInviteFile(fifo)).toThrow();
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    expect(() => readInviteFile(dir)).toThrow();
    if (process.platform !== "win32") expect(() => readInviteFile("/dev/zero")).toThrow();
  });

  it("names a relative --invite-file from the caller's folder, for a release that runs elsewhere", () => {
    expect(absoluteInviteFile(["--invite-file", "inv.txt", "--account", "a"], "/home/me")).toEqual(["--invite-file", "/home/me/inv.txt", "--account", "a"]);
    expect(absoluteInviteFile(["--invite-file=sub/inv", "--json"], "/w")).toEqual(["--invite-file=/w/sub/inv", "--json"]);
    expect(absoluteInviteFile(["--invite-file", "/abs/inv", "-"], "/w")).toEqual(["--invite-file", "/abs/inv", "-"]);
  });
});
