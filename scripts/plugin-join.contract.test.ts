/**
 * `ovis join` against this PC's own server (server/index.ts on a state folder of its own and a free port) and the test
 * account service it uses: the invite is redeemed with the PC's own proof (POST /api/account/pc-proof), and the PC binds
 * itself through the same one press as `ovis add` (POST /api/account/one-press, which asks POST /v1/pc/admission). The
 * relay of that harness never comes online, so the command alone is told it is once the PC is in the account (GET
 * /api/relay). No test sleeps: the waits between asks end at once.
 */
import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join as joinPath } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";

import { TestList } from "../server/account/list.test-helpers.ts";
import { pairingPc, type Pc } from "../server/account/pairing.test-helpers.ts";
import { bounded } from "../server/relay/test-helpers.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { entryFromText, readBody } from "../shared/account-list-entry.ts";
import { readKind } from "../shared/account-list.ts";
import { signInviteRedeem, verifyLineProof } from "../shared/account-list-invite.ts";
import { newInvite, readJoinLine } from "../shared/account-list-join.ts";
import { join, JOIN_EXIT } from "./plugin-join.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

const OWNER = "acct_owner";
const SERVICE = "https://account.test";

async function fresh(): Promise<Pc> {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" } });
  made.account.opensAll = true;
  pcs.push(made);
  return made;
}

/** An invite as a device of OWNER makes one: the service gets its public key, the line keeps its private key. */
async function inviteFor(made: Pc, auto = false): Promise<string> {
  const fresh = await newInvite(SERVICE, OWNER, null);
  const response = await made.account.fetch(new Request(`${SERVICE}/v1/pc-invites`, { method: "POST", headers: { authorization: `Bearer ${made.account.issueToken(OWNER)}` }, body: JSON.stringify({ invite_key: fresh.key, ...auto ? { auto: true } : {} }) }));
  expect(response.status).toBe(200);
  return fresh.line;
}

/** The private key the line carries, as it spells it, and the line's base64url after its prefix. */
const secrets = (line: string): string[] => {
  const payload = line.slice("ovis-join:1:".length);
  return [payload, (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { secret: string }).secret];
};

/** Every file this PC keeps, read whole. */
function stateFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((name) => joinPath(dir, name)).filter((path) => statSync(path).isFile()).map((path) => readFileSync(path, "latin1"));
}

/**
 * `ovis join --account OWNER --json` as an agent runs it, with no terminal. `heard` sees each line it says on stderr, and
 * may press Add on a device of the account (`press`) or stop the run (`stop`).
 */
async function joining(made: Pc, line: string, heard: (text: string, act: { press: () => void; stop: () => void }) => void = () => undefined, pressAt?: number) {
  const serverId = made.app.context.services.relay.currentIdentity()!.server_id;
  const stop = new AbortController();
  const out: string[] = [];
  const err: string[] = [];
  const asked: number[] = [];
  const waiting: unknown[] = [];
  let pressed: Promise<Response> | null = null;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    // the harness's relay never comes online: the command is told it does once the PC is in the account
    if (path === "/api/relay" && request.method === "GET") return Response.json({ ...await (await globalThis.fetch(request)).json() as object, phase: made.devices.account() === null ? "connecting" : "online" });
    const body = request.method === "POST" ? await request.clone().text() : "";
    const response = await globalThis.fetch(request);
    if (path === "/api/account/one-press" && body !== "{}") {
      asked.push(response.status);
      waiting.push((await made.status()).waiting_for_add);
      if (asked.length === pressAt) { act.press(); await pressed; }
    }
    return response;
  };
  const act = {
    press: () => {
      pressed ??= made.account.fetch(new Request(`${SERVICE}/v1/pcs/${serverId}/admit`, { method: "POST", headers: { authorization: `Bearer ${made.account.issueToken(OWNER)}` }, body: "{}" }));
    },
    stop: () => stop.abort(),
  };
  const code = await bounded(join(["--invite-file", "/invite", "--account", OWNER, "--json"], {
    origin: `http://127.0.0.1:${made.app.port}`, headers: {}, fetch, accountService: SERVICE, serviceFetch: made.account.fetch, signal: stop.signal,
    lines: { next: () => new Promise(() => {}) }, terminal: false, isTty: false, running: true, platform: "linux",
    wait: (_ms, signal) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else setTimeout(resolve, 0); }),
    readFile: () => `${line}\n`, readStdin: async () => "",
    out: (text) => out.push(text),
    err: (text) => { err.push(text); heard(text, act); },
  }));
  return { code, out: out.join(""), err: err.join(""), asked, waiting, serverId, pressed: pressed as Promise<Response> | null };
}

test("a plain invite: the PC lists itself on its own proof, waits for Add on a device of the account, takes that admission and is in the account; the invite is in none of its files", async () => {
  const made = await fresh();
  const line = await inviteFor(made);
  // Add is pressed only after two asks found none, so the PC was seen waiting
  const run = await joining(made, line, undefined, 2);
  expect((await run.pressed)?.status).toBe(200);
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toEqual({ ok: true, account: OWNER, added: true, online: true });
  expect(made.devices.account()).toBe(OWNER);
  expect(made.account.pcs(OWNER).map((entry) => [entry.server_id, entry.listed_by_device])).toEqual([[run.serverId, false]]);
  // the PC said it waits for Add while no admission was there, and not once it was in
  expect(run.waiting.slice(0, -1)).toEqual([true, true]);
  expect(run.waiting.at(-1)).toBe(false);
  expect((await made.status()).waiting_for_add).toBe(false);
  // bound to the account: its named account cannot be forgotten
  const cleared = await made.local("/api/account/relay-account", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: null } });
  expect([cleared.status, cleared.body.error?.code]).toEqual([409, "in_account"]);
  expect((await made.local("/api/relay")).body.relay_account).toBe(OWNER);
  for (const text of [run.out, run.err, ...stateFiles(made.stateDir)]) for (const secret of secrets(line)) expect(text.includes(secret)).toBe(false);
});

test("an auto invite: the PC is in the account at once, with no Add", async () => {
  const made = await fresh();
  const line = await inviteFor(made, true);
  const run = await joining(made, line);
  expect(run.code).toBe(0);
  expect(run.asked).toEqual([200]);
  expect(made.devices.account()).toBe(OWNER);
  for (const text of stateFiles(made.stateDir)) for (const secret of secrets(line)) expect(text.includes(secret)).toBe(false);
});

/** A PC whose account keeps a signed list, and that list as its members write it. */
async function listed() {
  // What the PC posts with its keys, with the two members a PC that joined by a plain invite adds (`invite`,
  // `invite_proof`), which the fake service checks as the account service does
  const posts: { invite?: unknown; invite_proof?: unknown; key?: unknown; enc?: unknown }[] = [];
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" }, accountFetch: async (request, service) => {
    if (new URL(request.url).pathname !== "/v2/pc/list/keys") return await service.fetch(request);
    const { invite, invite_proof, key, enc } = await request.clone().json() as Record<string, unknown>;
    posts.push({ invite, invite_proof, key, enc });
    return await service.fetch(request);
  } });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  made.account.completions = true;
  pcs.push(made);
  const list = await TestList.start(made.account, OWNER);
  const endpoint = bytesToHex(importPublicKey(made.app.context.services.relay.currentIdentity()!.public_key));
  return { made, list, endpoint, posts };
}

/** `ovis join --account OWNER --json` on a line that names the list. `joinAsked`: after this PC answered each ask of its join by the list. */
async function joiningList(made: Pc, line: string, joinAsked: (count: number) => Promise<void> = async () => undefined) {
  const out: string[] = [];
  const err: string[] = [];
  const sent: string[] = [];
  const pressed: string[] = [];
  let asks = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path === "/api/relay" && request.method === "GET") return Response.json({ ...await (await globalThis.fetch(request)).json() as object, phase: made.devices.account() === null ? "connecting" : "online" });
    const body = request.method === "POST" ? await request.clone().text() : "";
    sent.push(body);
    if (path === "/api/account/one-press" && body !== "{}") pressed.push(body);
    const response = await globalThis.fetch(request);
    if (path === "/api/account/list/join") await joinAsked(++asks);
    return response;
  };
  const code = await bounded(join(["--invite-file", "/invite", "--account", OWNER, "--json"], {
    origin: `http://127.0.0.1:${made.app.port}`, headers: {}, fetch, accountService: SERVICE, serviceFetch: made.account.fetch, signal: new AbortController().signal,
    lines: { next: () => new Promise(() => {}) }, terminal: false, isTty: false, running: true, platform: "linux",
    wait: (_ms, signal) => new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else setTimeout(resolve, 0); }),
    readFile: () => `${line}\n`, readStdin: async () => "",
    out: (text) => out.push(text), err: (text) => { err.push(text); },
  }), 60_000);
  return { code, out: out.join(""), err: err.join(""), sent, pressed };
}

test("an auto invite of an account that keeps a signed list: the PC joins by an entry of its own that the line signs, pinned to that list, and the line stays with the command", async () => {
  const { made, list, endpoint } = await listed();
  const invite = await list.invite({ auto: true });
  const run = await joiningList(made, invite.line);
  expect(run.err).not.toContain("Could not add");
  expect(run.code).toBe(0);
  expect(JSON.parse(run.out)).toEqual({ ok: true, account: OWNER, added: true, online: true });
  expect(made.devices.account()).toBe(OWNER);
  // by the list alone: no admission of the account service bound it, and the list holds the PC as one that joined by that invite
  expect(run.pressed).toEqual([]);
  expect(made.devices.serviceBinding()).toBeNull();
  expect(made.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: list.id });
  const held = made.account.accountList(OWNER)!;
  expect(held.state.pcs[endpoint]).toMatchObject({ how: "joined", invite: invite.key });
  // with its name sealed and the names' key wrapped for it
  expect(readKind(readBody(entryFromText(held.entries.at(-1)!).body))).toMatchObject({ kind: "join", sealed: { epoch: 0 } });
  expect(held.wraps.some((wrap) => wrap.member === held.state.pcs[endpoint]!.enc)).toBe(true);
  // nothing of the line went to this PC's server, into its files or onto the screen
  for (const text of [run.out, run.err, ...run.sent, ...stateFiles(made.stateDir)]) for (const secret of secrets(invite.line)) expect(text.includes(secret)).toBe(false);
});

test("a plain invite of an account that keeps a signed list: the PC posts its card, a device of the account adds it, and it joins by the list", async () => {
  const { made, list, endpoint, posts } = await listed();
  const invite = await list.invite({ auto: false });
  const serverId = made.app.context.services.relay.currentIdentity()!.server_id;
  const run = await joiningList(made, invite.line, async (count) => {
    if (count !== 2) return;
    // a device of the account chooses Add on the card of the PC that joined with its invite
    const admitted = await made.account.fetch(new Request(`${SERVICE}/v1/pcs/${serverId}/admit`, { method: "POST", headers: { authorization: `Bearer ${made.account.issueToken(OWNER, { twoStep: true })}` }, body: "{}" }));
    expect(admitted.status).toBe(200);
    await list.addPostedPc(endpoint);
  });
  expect(run.err).not.toContain("Could not add");
  expect(run.code).toBe(0);
  expect(run.pressed).toEqual([]);
  expect(made.devices.account()).toBe(OWNER);
  expect(made.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in", list: list.id });
  expect(made.account.accountList(OWNER)!.state.pcs[endpoint]).toMatchObject({ how: "added" });
  // its post carried the line's proof for the very card it posted, which a device of the account checks by itself
  const line = await readJoinLine(invite.line, { service: SERVICE, followsLists: true });
  expect(posts.length).toBeGreaterThan(0);
  for (const post of posts) {
    expect(post.invite).toBe(line.key);
    expect(await verifyLineProof({ account: OWNER, server_id: serverId, list: list.id, card: { key: post.key as string, enc: post.enc as string, endpoint } }, post.invite_proof, line.key)).toBe(true);
  }
  for (const text of [run.out, run.err, ...run.sent, ...stateFiles(made.stateDir)]) for (const secret of secrets(invite.line)) expect(text.includes(secret)).toBe(false);
});

test("a line that names no list, for an account that keeps one, adds this PC nowhere: the account service's word is not taken", async () => {
  const { made } = await listed();
  const line = await inviteFor(made, true);
  const run = await joining(made, line);
  expect(run.code).toBe(JOIN_EXIT.not_added);
  // The account service itself redeems no invite its list does not hold (Part D11.5), so it ends there. A service that
  // took the redeem all the same would meet this PC's own refusal at the take: an account with a list takes no PC on
  // its word (`list_add`, list-join.contract.test.ts "without the person's yes at the PC nothing is joined…")
  expect(run.err).toContain("invite_not_in_list");
  expect(run.err).toContain("This PC was not added.");
  expect(made.devices.account()).toBeNull();
});

test("stopped while it waits, the PC takes itself off the account's list by its own proof, and keeps nothing of the invite", async () => {
  const made = await fresh();
  const line = await inviteFor(made);
  const run = await joining(made, line, (text, act) => { if (text.includes("Waiting…")) setTimeout(act.stop, 0); });
  expect(run.code).toBe(JOIN_EXIT.stopped);
  expect(JSON.parse(run.out)).toMatchObject({ ok: false, error: "stopped", listed: false });
  expect(made.devices.account()).toBeNull();
  expect(made.account.pcs(OWNER)).toEqual([]);
  // the account it named for the relay pass is forgotten again: there was none before
  expect((await made.local("/api/relay")).body.relay_account).toBeNull();
  for (const text of [run.out, run.err, ...stateFiles(made.stateDir)]) for (const secret of secrets(line)) expect(text.includes(secret)).toBe(false);
});

test("past a plain invite's ten minutes this PC answers one press with listing_expired, not as an account service that does not answer", async () => {
  const made = await fresh();
  const line = await inviteFor(made);
  const identity = made.app.context.services.relay.currentIdentity()!;
  const proof = await made.local("/api/account/pc-proof", { method: "POST", headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, body: {} });
  const offer = await made.local("/api/relay/link", { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-local-only": "1" } });
  expect(offer.status).toBe(200);
  const read = await readJoinLine(line, { service: SERVICE, followsLists: false });
  const publicKey = bytesToHex(importPublicKey(identity.public_key));
  const redeemed = await made.account.fetch(new Request(`${SERVICE}/v1/pc-invites/redeem`, { method: "POST", body: JSON.stringify({
    invite_key: read.key, invite_signature: await signInviteRedeem(read, { server_id: identity.server_id, public_key: publicKey, challenge_id: proof.body.challenge_id as string }),
    server_id: identity.server_id, public_key: publicKey, relay: "wss://relay.test", label: "PC", challenge_id: proof.body.challenge_id, proof: proof.body.proof,
  }) }));
  expect(redeemed.status).toBe(200);
  const named = await made.local("/api/account/relay-account", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: OWNER } });
  expect(named.status).toBe(204);
  const press = () => made.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, body: { account: OWNER } });
  expect((await press()).body.error?.code).toBe("no_admission");
  expect((await made.status()).waiting_for_add).toBe(true);
  // the service's clock moves past the card's ten minutes
  const later = Date.now() + 11 * 60_000;
  Object.assign(made.account, { now: () => later });
  const expired = await press();
  expect([expired.status, expired.body.error?.code]).toEqual([409, "listing_expired"]);
  expect((await made.status()).waiting_for_add).toBe(false);
});

test("GET /api/relay names this PC's ID and its named account to its own window and CLI only, as dispatch decides", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true, token: "the-token" }, startRelay: false });
  pcs.push(made);
  const base = `http://127.0.0.1:${made.app.port}`;
  const ask = (path: string, extra: Record<string, string> = {}, body?: unknown) => fetch(base + path, {
    method: body === undefined ? "GET" : "POST", headers: { origin: base, authorization: "Bearer the-token", "x-herdr-machine": "1", "x-herdr-update": "1", ...body === undefined ? {} : { "content-type": "application/json" }, ...extra },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  });
  expect((await ask("/api/relay/start", {}, {})).status).toBe(200);
  expect((await ask("/api/account/relay-account", {}, { account: OWNER })).status).toBe(204);
  const serverId = made.app.context.services.relay.currentIdentity()!.server_id;
  // this PC's own CLI: loopback, its token, nothing forwarded
  expect(await (await ask("/api/relay")).json()).toMatchObject({ server_id: serverId, relay_account: OWNER });
  // the same token through a proxy is not this PC's own window
  const forwarded = await (await ask("/api/relay", { "x-forwarded-for": "100.64.0.9" })).json() as Record<string, unknown>;
  expect(forwarded.phase).toBeDefined();
  expect(Object.keys(forwarded)).not.toContain("server_id");
  expect(Object.keys(forwarded)).not.toContain("relay_account");
  // null forgets the named account, from this PC only
  expect((await ask("/api/account/relay-account", {}, { account: null })).status).toBe(204);
  expect(await (await ask("/api/relay")).json()).toMatchObject({ relay_account: null, account_named: false });
});
