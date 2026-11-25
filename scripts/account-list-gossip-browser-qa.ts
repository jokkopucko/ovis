/**
 * A removal the account service withholds from a PC reaches it from a device of the account that opens it
 * (src/lib/account/listGossip.ts; docs/account-list.md, "Meeting a PC"), end to end in real browsers: two devices of the
 * account, each in a Chromium profile of its own with its keys in IndexedDB (scripts/account-list-gossip-page.ts); two
 * real PCs (createServer) pinned to the account's signed list; the Bun relay between them, the browsers bridged to it
 * by Playwright's WebSocket routing; and the account service in memory, made to withhold the removal from one PC.
 *
 * The first browser starts the list and adds both PCs to it, the second is allowed in by the first, then the first puts
 * the second out. The PC the service tells keeps the second out; the PC it withholds the removal from still lets the
 * second in, until the first device opens that PC: then the PC is handed the removal over that session, and the
 * second device is in at neither PC.
 *
 *   UI_EVIDENCE_DIR=<dir> bun scripts/account-list-gossip-browser-qa.ts
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "@noble/hashes/utils.js";
import { chromium, type BrowserContext, type Page as BrowserPage } from "playwright-core";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { importPublicKey } from "../shared/relay-e2ee.ts";
import { decodeOffer, type RelayOffer } from "../shared/relay-offer.ts";
import { startBunRelay } from "../relay/bun.ts";
import type { AccountSession } from "../src/lib/account/store.ts";
import { chromePath } from "./chrome-path.ts";
import { relayBrowserSocket, relayServerTree } from "./relay-browser-bridge.ts";

type Page = typeof import("./account-list-gossip-page.ts");
const MODULE = "/account-list-gossip-page.js";
const ACCOUNT = "acct_gossip";
const RELAY = "wss://relay.test";
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence) mkdirSync(evidence, { recursive: true });
const report: string[] = [];
const pass = (line: string): void => { report.push(`PASS ${line}`); console.log(`PASS ${line}`); };

/** Polls `check` until it holds, to a deadline: what a PC or a page does next is not announced to this script. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`${what}: not within ${ms} ms`);
    await Bun.sleep(50);
  }
}

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("./account-list-gossip-page.ts", import.meta.url))], target: "browser",
  define: { __APP_VERSION__: JSON.stringify("1.0.0"), __APP_REVISION__: JSON.stringify("qa"), __HERDR_TEST_HOOKS__: "false", "process.env.NODE_ENV": JSON.stringify("production") },
});
const [module] = build.outputs;
if (!build.success || module === undefined || build.outputs.length !== 1) throw new AggregateError(build.logs, "Could not build the page's module");

const fake = new FakeAccountService();
fake.opensAll = true;
fake.listAccounts = "*";
const site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (request) => {
  const { pathname } = new URL(request.url);
  if (pathname === MODULE) return new Response(module, { headers: { "content-type": "text/javascript" } });
  if (!pathname.startsWith("/v1/") && !pathname.startsWith("/v2/")) return new Response("<!doctype html><title>List gossip</title>", { headers: { "content-type": "text/html" } });
  return fake.fetch(request);
} });
const origin = `http://127.0.0.1:${site.port}`;
const relay = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
const relayUrl = (url: string): string => { const target = new URL(url); return `ws://127.0.0.1:${relay.port}${target.pathname}${target.search}`; };
const { createServer, RelayService } = await relayServerTree();
const cleanups: (() => Promise<void> | void)[] = [];

/** A PC of the account, admitted to it by one press (before the account had a list), its relay up: its offer and its parts. */
async function accountPc(name: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `ovis-gossip-qa-${name}-`));
  let synced = Promise.withResolvers<void>();
  const relayService = new RelayService({ stateDir, relay: RELAY, connect: (url) => {
    const socket = new WebSocket(relayUrl(url));
    socket.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"sync"')) synced.resolve(); });
    return socket;
  } });
  const herdrConfigPath = join(stateDir, "config.toml");
  writeFileSync(herdrConfigPath, "[ui]\ncopy_on_select = true\n");
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", tailscaleOwner: null, sidecar: false, relay: relayService, herdrConfigPath,
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: (request) => fake.fetch(request) } });
  cleanups.push(async () => { await relayService.shutdown(); app.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  const at = `http://127.0.0.1:${app.port}`;
  const local = (path: string, header: string, body?: unknown) => fetch(`${at}${path}`, {
    method: "POST", headers: { origin: at, [header]: "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await local("/api/relay/start", "x-herdr-update")).status, 200, `${name}: the relay starts`);
  await synced.promise;
  synced = Promise.withResolvers<void>();
  const { services } = app.context;
  const identity = services.relay.currentIdentity();
  assert.ok(identity, `${name} has a relay identity`);
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  assert.equal((await local("/api/account/relay-account", "x-herdr-machine", { account: ACCOUNT })).status, 204, `${name}: the account is named`);
  const token = fake.issueToken(ACCOUNT, { twoStep: true });
  const call = (path: string, method: string, body: unknown = {}) => fake.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: name, public_key: endpoint, relay: RELAY });
  await call(`/v1/pcs/${identity.server_id}/admit`, "POST");
  const pressed = await local("/api/account/one-press", "x-herdr-machine", { account: ACCOUNT });
  assert.equal(pressed.status, 200, `${name}: one press adds it to the account (${await pressed.clone().text()})`);
  const offered = await local("/api/relay/offer", "x-herdr-update");
  assert.equal(offered.status, 200, `${name}: an offer`);
  const { code: _code, ...offer } = decodeOffer((await offered.json() as { url: string }).url)!;
  const list = services.accountList!;
  return {
    name, endpoint, serverId: identity.server_id, offer: offer as RelayOffer, list,
    /** Reads its mailbox and its list, as it does by its clock. */
    pull: async (): Promise<void> => { await services.accountMailbox.pull(); await list.settled(); },
  };
}

const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
try {
  /** A Chromium profile of its own, its relay sockets bridged to the Bun relay, with the page's module loaded. */
  const profile = async (): Promise<{ context: BrowserContext; page: BrowserPage }> => {
    const context = await browser.newContext();
    await context.routeWebSocket(/^wss:\/\/relay\.test\//, (ws) => { relayBrowserSocket(ws, () => relayUrl(ws.url())); });
    const page = await context.newPage();
    await page.goto(origin);
    return { context, page };
  };
  /** One of the page module's functions, called in that page with `args` (plain data). */
  const call = <Name extends keyof Page>(page: BrowserPage, name: Name, ...args: Parameters<Page[Name]>): Promise<Awaited<ReturnType<Page[Name]>>> =>
    page.evaluate(async ({ path, name, args }) => {
      const module = await import(path) as Record<string, (...given: unknown[]) => unknown>;
      return await module[name]!(...args);
    }, { path: MODULE, name: name as string, args: args as unknown[] }) as Promise<Awaited<ReturnType<Page[Name]>>>;
  /** A sign-in in that page, its key registered by the account service as it does after a real one (`n`: which browser). */
  const signIn = async (page: BrowserPage, n: number): Promise<void> => {
    const session: AccountSession = { service: origin, account: ACCOUNT, provider: "github", access_token: fake.issueToken(ACCOUNT), refresh_token: `refresh-${n}`,
      expires_at: Date.now() + 3_600_000, sign_in_id: `qa-${n}`, signed_in_at: Date.now() };
    const key = await call(page, "signIn", session);
    await call(page, "registered", fake.registerSessionKey(session.access_token, key, `QA browser ${n}`));
  };

  // Two PCs of the account, added before it had a list.
  const desk = await accountPc("desk");
  const attic = await accountPc("attic");

  // The first browser starts the list; the second is let in by it, from the place it is handed.
  const first = await profile();
  await signIn(first.page, 1);
  const started = await call(first.page, "sync");
  assert.equal(started.status.at, "following", "the first browser starts the account's list");
  const listId = fake.accountList(ACCOUNT)!.id;
  const second = await profile();
  await signIn(second.page, 2);
  const waiting = await call(second.page, "sync");
  assert.deepEqual(waiting.status, { at: "not_in", list: listId, why: "not_mine", claim: "claimed" }, "the second browser waits to be let in");
  const secondKey = await call(second.page, "memberKey");
  const allowed = await call(first.page, "allow", { key: secondKey, label: "QA browser 2", os: "linux" });
  assert.ok(allowed.allowed, "the first browser lets the second in");
  const adopted = await call(second.page, "adopt", allowed.offer);
  assert.equal(adopted.status.at === "following" ? adopted.status.standing : adopted.status.at, "in", "the second browser follows the list");

  // Both PCs post their keys for the list and the first browser adds each: they pin it.
  for (const pc of [desk, attic]) await pc.list.wantList(listId);
  const posts = (await (await fake.fetch(new Request(`https://account.test/v2/lists/${listId}/posts`, { headers: { authorization: `Bearer ${fake.issueToken(ACCOUNT, { twoStep: true })}` } }))).json() as { posts: { endpoint: string; key: string; enc: string; card: string }[] }).posts;
  for (const pc of [desk, attic]) {
    const post = posts.find((each) => each.endpoint === pc.endpoint);
    assert.ok(post, `${pc.name} posted its keys and its card`);
    assert.ok(await call(first.page, "addPostedPc", post), `the first browser adds ${pc.name}`);
    await pc.pull();
    await until(() => pc.list.status().pinned === true && pc.list.status().standing === "in", `${pc.name} pins the list`);
  }
  for (const pc of [desk, attic]) assert.equal(await call(second.page, "opens", pc.offer), "in", `the second browser opens ${pc.name} with its list key`);
  pass("two browsers in the account's list, two PCs pinned to it, each browser opens each PC with the key the list holds for it");

  // The account service withholds from the attic whatever comes after where it stands now.
  const before = attic.list.status().head!;
  fake.tamperList(listId, { reader: { server_id: attic.serverId }, withholdAfter: before.seq });
  // The first browser puts the second out.
  assert.ok(await call(first.page, "remove", secondKey), "the first browser places the removal");
  const removed = fake.accountList(ACCOUNT)!.head;
  for (const pc of [desk, attic]) await pc.pull();
  await until(() => desk.list.status().head?.seq === removed.seq, "the desk reads the removal");
  assert.equal(await call(second.page, "opens", desk.offer), "auth_failed", "the desk keeps the second browser out");
  assert.deepEqual(attic.list.status().head, before, "the attic was shown nothing after its head");
  assert.equal(await call(second.page, "opens", attic.offer), "in", "the residual the docs name: the attic still lets the removed browser in");
  pass("a removal the account service withholds from a PC: that PC still lets the removed device in, the other one does not");

  // The first browser opens the attic: over that session the attic is handed the removal.
  assert.equal(await call(first.page, "meet", attic.offer), true, "the attic selects the list for the first browser's session");
  await until(() => attic.list.status().head?.seq === removed.seq, "the attic is handed the removal over the first browser's session");
  assert.deepEqual(attic.list.status().head, { seq: removed.seq, hash: removed.hash });
  await call(first.page, "leave");
  assert.equal(await call(second.page, "opens", attic.offer), "auth_failed", "the attic keeps the second browser out now");
  // and it keeps it out though the account service still withholds the removal
  await attic.pull();
  assert.equal(await call(second.page, "opens", attic.offer), "auth_failed");
  pass("the device that placed the removal opens the withheld PC: the PC is handed the removal over that session and lets the removed device in no more");
  if (evidence) writeFileSync(join(evidence, "account-list-gossip.txt"), `${report.join("\n")}\n`);
} finally {
  await browser.close();
  for (const cleanup of cleanups.reverse()) await cleanup();
  await relay.stop();
  site.stop(true);
}
