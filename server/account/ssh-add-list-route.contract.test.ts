/**
 * The adding PC's half of an add over SSH to an account that keeps a signed list (docs/account.md, "Adding a PC over SSH
 * to an account that keeps a list"). Its own window lists and admits the other PC as before, then POST
 * /api/account/ssh-add: this PC, pinned to the list and a full signer of it, names the list and its own list key to the
 * other PC over the SSH channel, takes that PC's card back over the same channel, signs the `pc` entry with it and
 * places it, and has that PC join by the list. An account with no list is added exactly as before. SSH itself is stood
 * in for (ssh-account-add.test.ts runs real OpenSSH); both PCs are real Ovis servers on one fake account service.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { startBunRelay } from "../../relay/bun.ts";
import { entryFromText, readBody } from "../../shared/account-list-entry.ts";
import type { FakeAccountService } from "../../shared/account-service-fake.ts";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type SetupJob } from "../../shared/machines.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import type { BridgeDescriptor } from "../bridge.ts";
import { MachineManager } from "../machines.ts";
import { posixHost } from "../remote-host.ts";
import { SshConnection } from "../ssh.ts";
import { TestList } from "./list.test-helpers.ts";
import { pairingPc, type Pc } from "./pairing.test-helpers.ts";
import { askRecovery, openRecoverySocket } from "./recovery.ts";

const ACCOUNT = "acct_1";
const REMOTE_SOCKET = "/home/fixture/.local/state/ovis/recover/recover.sock";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function localRelay(): number {
  const relay = startBunRelay({ port: 0 });
  cleanups.push(() => relay.stop());
  return relay.port;
}

const endpointOf = (pc: Pc): string => bytesToHex(importPublicKey(pc.app.context.services.relay.currentIdentity()!.public_key));

/** The adding PC: in the account by one press; with `list`, the account then made its list and this PC follows it as a PC a person added. */
async function addingPc(options: { list: boolean; hook?: (request: Request, forward: () => Promise<Response>) => Promise<Response> }): Promise<{ pc: Pc; list: TestList | null; ownKey: string | null }> {
  const hook = options.hook;
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" }, startRelay: false,
    ...(hook === undefined ? {} : { accountFetch: (request: Request, service: FakeAccountService) => hook(request, () => service.fetch(request)) }) });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  cleanups.push(() => made.close());
  const call = (path: string, body: unknown, header: string) => made.local(path, { method: "POST", headers: { [header]: "1" }, body });
  if ((await call("/api/relay/start", undefined, "x-herdr-update")).status !== 200) throw new Error("The relay did not start");
  if ((await call("/api/account/relay-account", { account: ACCOUNT }, "x-herdr-machine")).status !== 204) throw new Error("The account was not named");
  await listAndAdmit(made.account, made.app.context.services.relay.currentIdentity()!);
  if ((await call("/api/account/one-press", { account: ACCOUNT }, "x-herdr-machine")).status !== 200) throw new Error("The adding PC was not added");
  if (!options.list) return { pc: made, list: null, ownKey: null };
  const { services } = made.app.context;
  const list = await TestList.start(made.account, ACCOUNT);
  const accountList = services.accountList!;
  const pull = async () => { await services.accountMailbox.pull(); await accountList.settled(); };
  await pull();
  await accountList.wantList(list.id);
  await list.addPostedPc(endpointOf(made));
  await pull();
  expect(accountList.status()).toMatchObject({ pinned: true, standing: "in" });
  list.refresh();
  return { pc: made, list, ownKey: made.account.accountList(ACCOUNT)!.state.pcs[endpointOf(made)]!.key! };
}

/** The other PC, installed over SSH: in no account, its relay never turned on, on the adding PC's account service. */
async function otherPc(service: FakeAccountService): Promise<Pc> {
  const made = await pairingPc({ relayPort: localRelay(), startRelay: false, server: { accountOpensAll: true }, accountFetch: (request) => service.fetch(request) });
  cleanups.push(() => made.close());
  return made;
}

/** What the window does with its own sign-in before the take: lists that PC, then admits it. */
async function listAndAdmit(service: FakeAccountService, fields: { server_id: string; public_key: string }): Promise<void> {
  const token = service.issueToken(ACCOUNT, { twoStep: true });
  const call = (path: string, method: string, body: unknown) =>
    service.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  const listed = await call(`/v1/pcs/${fields.server_id}`, "PUT", { label: "Other PC", public_key: bytesToHex(importPublicKey(fields.public_key)), relay: "wss://relay.ovis.sh" });
  if (!listed.ok) throw new Error(`Not listed: ${listed.status} ${await listed.text()}`);
  const admitted = await call(`/v1/pcs/${fields.server_id}/admit`, "POST", {});
  if (!admitted.ok) throw new Error(`Not admitted: ${admitted.status} ${await admitted.text()}`);
}

/** That PC's owner socket behind a stand-in that records what reaches it; `answer` stands in for an older Ovis there. */
function recorded(pc: Pc, answer: (request: unknown, said: unknown) => unknown = (_request, said) => said): { path: string; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-list-"));
  const proxy = openRecoverySocket({ stateDir: dir, handle: async (request) => { seen.push(request as Record<string, unknown>); return answer(request, await askRecovery(pc.stateDir, request)); } });
  if ("refused" in proxy) throw new Error(proxy.refused);
  cleanups.push(() => { proxy.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { path: proxy.path, seen };
}

/**
 * That PC's owner socket behind a stand-in that keeps the exact bytes of each request as they arrive, and answers with
 * that PC's own answers: what an add with no list sends must be main's, byte for byte.
 */
function rawRecorded(pc: Pc): { path: string; lines: string[] } {
  const lines: string[] = [];
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-raw-"));
  const path = join(dir, "r.sock");
  const listener = Bun.listen<{ buffered: string }>({ unix: path, socket: {
    open(socket) { socket.data = { buffered: "" }; },
    async data(socket, chunk) {
      socket.data.buffered += new TextDecoder().decode(chunk);
      const newline = socket.data.buffered.indexOf("\n");
      if (newline < 0) return;
      const line = socket.data.buffered.slice(0, newline + 1);
      lines.push(line);
      socket.write(`${JSON.stringify(await askRecovery(pc.stateDir, JSON.parse(line)))}\n`);
    },
  } });
  cleanups.push(() => { listener.stop(true); rmSync(dir, { recursive: true, force: true }); });
  return { path, lines };
}

/** SSH stood in for: the job reaches that PC's own Ovis, whose registration names its owner socket, forwarded to `socket`. */
function sshTo(socket: string): void {
  const herdr = "/home/fixture/.config/herdr/herdr.sock";
  const descriptor = (): BridgeDescriptor => ({ pid: 12345, port: 17317, token: "a".repeat(64), socket_path: herdr, bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, managed_remote: false, recover_socket: REMOTE_SOCKET });
  const mocks: { mockRestore(): void }[] = [
    spyOn(SshConnection.prototype, "run").mockImplementation(async (script) => {
      if (script.includes("uname")) return `Linux\nx86_64\n/home/fixture\n/home/fixture/.config\n/usr/bin/herdr\n\n${JSON.stringify(descriptor())}\n`;
      if (script.startsWith("socket=")) return herdr;
      if (script.includes("--version")) return "herdr 0.9.5";
      if (script.startsWith("kill -0")) return "live";
      throw new Error(`Unexpected remote command: ${script}`);
    }),
    spyOn(SshConnection.prototype, "start").mockImplementation(async () => {}),
    spyOn(SshConnection.prototype, "close").mockImplementation(() => {}),
    spyOn(SshConnection.prototype, "connected").mockReturnValue(true),
    spyOn(SshConnection.prototype, "forwardSocket").mockImplementation(async () => socket),
    spyOn(SshConnection.prototype, "closeSocketForward").mockImplementation(async () => {}),
    spyOn(MachineManager.prototype as unknown as { verify(): Promise<unknown> }, "verify").mockImplementation(async () => ({
      endpoint: { url: "http://127.0.0.1:1", token: "fixture-token" },
      identity: { ...descriptor(), managed_remote: false, socket_id: "fixture-socket", herdr: { version: "0.9.5", protocol: 22 } } satisfies BridgeIdentity,
    })),
    spyOn(MachineManager.prototype as unknown as { observe(): Promise<void> }, "observe").mockResolvedValue(undefined),
    spyOn(posixHost, "installBundle").mockImplementation(async () => { throw new Error("must not install a bridge"); }),
    spyOn(posixHost, "start").mockImplementation(async () => { throw new Error("must not start a bridge"); }),
  ];
  cleanups.push(() => { for (const mock of mocks) mock.mockRestore(); });
}

/** The adding PC's own window: Add PC over SSH with "Add it to my account", connected to that PC. */
async function connected(a: Pc): Promise<SetupJob> {
  const machines = a.app.context.services.core.machines!;
  return await new Promise<SetupJob>((resolve, reject) => {
    let job: SetupJob | undefined;
    const timeout = setTimeout(() => { off(); reject(new Error(`setup did not settle: ${JSON.stringify(job)}`)); }, 5000);
    const off = machines.subscribe(() => {
      if (job && ["failed", "connected", "cancelled"].includes(job.phase)) { clearTimeout(timeout); off(); resolve(job); }
    });
    job = machines.setup({ destination: "fixture-pc", account_add: true });
  });
}

const sshAdd = (a: Pc, job: SetupJob) => a.local("/api/account/ssh-add", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { job_id: job.id, server_id: job.account_add!.server_id } });

test.skipIf(process.platform === "win32")("on a list account the adding PC names its list and its own key over SSH, signs the other PC's `pc` entry with the card it took back, and the other PC joins by the list", async () => {
  const a = await addingPc({ list: true });
  const list = a.list!;
  const b = await otherPc(a.pc.account);
  const socket = recorded(b);
  sshTo(socket.path);
  const job = await connected(a.pc);
  expect(job.phase).toBe("connected");
  await listAndAdmit(a.pc.account, job.account_add!);
  const added = await sshAdd(a.pc, job);
  // it joined the account's list by this add, which the window keeps as this device's own add
  expect([added.status, added.body]).toEqual([200, { account: ACCOUNT, server_id: job.account_add!.server_id, relay: { phase: "online", blocked: null }, list_joined: true }]);
  // the other PC is in the account by the list, pinned from its first moment
  expect(b.devices.account()).toBe(ACCOUNT);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, pinned_list: list.id, standing: "in" });
  // its entry is a `pc` the adding PC signed with its own list key, for the other PC's key at its relay key
  const held = a.pc.account.accountList(ACCOUNT)!;
  const row = held.state.pcs[endpointOf(b)]!;
  expect(row).toMatchObject({ how: "added", removed: null });
  expect(held.state.signers[row.key!]).toMatchObject({ by: a.ownKey, power: "full" });
  const entry = readBody(entryFromText(held.entries.at(-1)!).body);
  expect([entry.kind, entry.signer]).toEqual(["pc", a.ownKey!]);
  // what went over SSH: the inspect, then the take that names the list and this PC's key, until that PC joined
  expect(socket.seen.map((request) => request.act)).toEqual(["account_add_inspect", "account_add_take", "account_add_take"]);
  for (const take of socket.seen.slice(1)) expect(take).toEqual({ act: "account_add_take", account: ACCOUNT, server_id: job.account_add!.server_id, list: list.id, adder: a.ownKey! });
});

test.skipIf(process.platform === "win32")("an account with no list is added exactly as before: the take names the account alone, and the other PC takes the admission", async () => {
  const a = await addingPc({ list: false });
  const b = await otherPc(a.pc.account);
  const raw = rawRecorded(b);
  sshTo(raw.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const added = await sshAdd(a.pc, job);
  // the answer to the window is today's, field for field
  expect([added.status, added.body]).toEqual([200, { account: ACCOUNT, server_id: job.account_add!.server_id, relay: { phase: "online", blocked: null } }]);
  expect(b.devices.account()).toBe(ACCOUNT);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: false });
  // the bytes on that PC's owner socket are the very lines main sends for this add
  expect(raw.lines).toEqual(['{"act":"account_add_inspect"}\n', `{"act":"account_add_take","account":"${ACCOUNT}","server_id":"${job.account_add!.server_id}"}\n`]);
});

test.skipIf(process.platform === "win32")("an Ovis on the other PC from before this cannot be named a list: the add says to update it there, and nothing is signed", async () => {
  const a = await addingPc({ list: true });
  const list = a.list!;
  const b = await otherPc(a.pc.account);
  // as an Ovis from before this reads a take that names a list: a field it does not know, and no code
  const older = recorded(b, (request, said) => (request as Record<string, unknown>).list !== undefined ? { error: "Unexpected field list" } : said);
  sshTo(older.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const added = await sshAdd(a.pc, job);
  expect([added.status, added.body.error?.code]).toEqual([409, "that_pc_old"]);
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  expect(b.devices.account()).toBeNull();
  expect(list.id).toEqual(expect.any(String));
});

test.skipIf(process.platform === "win32")("the other PC already in the list by an entry of this PC's: nothing more is signed, and it joins by the list", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  const socket = recorded(b);
  sshTo(socket.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  // a first add whose last answer was lost: the entry is in, that PC never heard it was
  const first = await sshAdd(a.pc, job);
  expect(first.status).toBe(200);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const again = await connected(a.pc);
  const second = await sshAdd(a.pc, again);
  expect([second.status, second.body.account]).toEqual([200, ACCOUNT]);
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
});

test.skipIf(process.platform === "win32")("a PC the window did not list and admit is not placed: the account service asks its own post and an own sign-in's listing, and the forward closes", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  const socket = recorded(b);
  sshTo(socket.path);
  const job = await connected(a.pc);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const added = await sshAdd(a.pc, job);
  expect([added.status, added.body.error?.code]).toEqual([409, "list_not_added"]);
  expect(added.body.error?.message).toContain("not_posted");
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  expect(b.devices.account()).toBeNull();
  // one take named the list, and nothing went after the entry was refused
  expect(socket.seen.map((request) => request.act)).toEqual(["account_add_inspect", "account_add_take"]);
});

/** The entries the adding PC sent to the account service, as it sent them, and a switch that loses them and its reads. */
function flaky(): { readonly hook: (request: Request, forward: () => Promise<Response>) => Promise<Response>; readonly sent: string[][]; down: boolean } {
  const state = {
    sent: [] as string[][], down: false,
    hook: async (request: Request, forward: () => Promise<Response>): Promise<Response> => {
      const path = new URL(request.url).pathname;
      if (path === "/v2/pc/list/entries") state.sent.push((await request.clone().json() as { entries: string[] }).entries);
      // the connection to the account service drops: the request never arrives, or its answer never comes back
      if (state.down && (path === "/v2/pc/list/entries" || path === "/v2/pc/list/log")) throw new TypeError("connection lost");
      return await forward();
    },
  };
  return state;
}

test.skipIf(process.platform === "win32")("entries lost on the way and a read-back that fails: the add says it may be in; Add again sends the very request this PC signed, and nothing is signed twice", async () => {
  const service = flaky();
  const a = await addingPc({ list: true, hook: service.hook });
  const b = await otherPc(a.pc.account);
  sshTo(recorded(b).path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  service.down = true;
  const first = await sshAdd(a.pc, job);
  expect([first.status, first.body.error?.code]).toEqual([409, "take_unanswered"]);
  expect(b.devices.account()).toBeNull();
  service.down = false;
  // the window's Add again: a new connection to the same PC, the same steps
  const again = await connected(a.pc);
  const second = await sshAdd(a.pc, again);
  expect([second.status, second.body.account]).toEqual([200, ACCOUNT]);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
  // one signature for that place: every request that went out carried the same signed entry, and the list holds it once
  expect(service.sent.length).toBeGreaterThan(1);
  expect(new Set(service.sent.map((entries) => JSON.stringify(entries))).size).toBe(1);
  expect(a.pc.account.accountList(ACCOUNT)!.head.seq).toBe(head.seq + 1);
});

test.skipIf(process.platform === "win32")("a run that stopped after that PC posted and before anything was signed says so, and Add again adds it", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  // that PC's card is spoiled on the way the first time: nothing is signed for it
  let spoil = true;
  const socket = recorded(b, (_request, said) => {
    if (!spoil || said === null || typeof said !== "object" || (said as { state?: unknown }).state !== "waiting") return said;
    spoil = false;
    return { ...said, card: "A".repeat(86) };
  });
  sshTo(socket.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const first = await sshAdd(a.pc, job);
  expect([first.status, first.body.error?.code]).toEqual([409, "list_not_added"]);
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  const second = await sshAdd(a.pc, await connected(a.pc));
  expect([second.status, second.body.account]).toEqual([200, ACCOUNT]);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
});

test.skipIf(process.platform === "win32")("a run that stopped after this PC signed and before that PC took its entry says so, and Add again finishes it with nothing more signed", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  // after its first answer that PC is not reached again in this run: the stand-in repeats that answer
  let first: unknown = null;
  let cut = true;
  const dir = mkdtempSync(join(tmpdir(), "ovis-ssh-list-cut-"));
  const proxy = openRecoverySocket({ stateDir: dir, handle: async (request) => {
    const asked = request as Record<string, unknown>;
    if (cut && asked.act === "account_add_take" && first !== null) return first;
    const said = await askRecovery(b.stateDir, request);
    if (asked.act === "account_add_take") first = said;
    return said;
  } });
  if ("refused" in proxy) throw new Error(proxy.refused);
  cleanups.push(() => { proxy.stop(); rmSync(dir, { recursive: true, force: true }); });
  sshTo(proxy.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const stopped = await sshAdd(a.pc, job);
  expect([stopped.status, stopped.body.error?.code]).toEqual([409, "list_unbound"]);
  expect(b.devices.account()).toBeNull();
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  expect(a.pc.account.accountList(ACCOUNT)!.state.pcs[endpointOf(b)]).toMatchObject({ removed: null });
  cut = false;
  first = null;
  const finished = await sshAdd(a.pc, await connected(a.pc));
  expect([finished.status, finished.body.account]).toEqual([200, ACCOUNT]);
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
// five takes a second apart before it says so
}, 20_000);

test.skipIf(process.platform === "win32")("a PC the add puts in the list: the answer says it joined the list now; added again, it does not", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  sshTo(recorded(b).path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  expect((await sshAdd(a.pc, job)).body.list_joined).toBe(true);
  // the same PC again: the list held it before this add
  const again = await sshAdd(a.pc, await connected(a.pc));
  expect([again.status, again.body.list_joined]).toEqual([200, undefined]);
});
