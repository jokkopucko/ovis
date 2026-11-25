/**
 * Independent adversarial review of P8 (adding a PC over SSH signs its `pc` entry, for an account that keeps a signed
 * list), at feat/account-list-ssh-pc e7b5143d7. Written as if it lived in server/account/ of that head, beside
 * ssh-add-list-route.contract.test.ts, whose stand-ins it copies (SSH itself is stood in for; both PCs are real Ovis
 * servers on one fake account service). Each `finding` test FAILS on e7b5143d7 and says what should hold; each `pin`
 * test passes there and holds a guard that a mutant of the step's own code got past the step's tests.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Socket } from "bun";
import { startBunRelay } from "../../relay/bun.ts";
import { entryFromText, readBody } from "../../shared/account-list-entry.ts";
import { signCard } from "../../shared/account-list.ts";
import type { FakeAccountService } from "../../shared/account-service-fake.ts";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type SetupJob } from "../../shared/machines.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../shared/relay-e2ee.ts";
import type { BridgeDescriptor } from "../bridge.ts";
import { MachineManager } from "../machines.ts";
import { posixHost } from "../remote-host.ts";
import { SshConnection } from "../ssh.ts";
import { ListFollow, type AddedPc } from "./list-follow.ts";
import { listMember, TestList } from "./list.test-helpers.ts";
import { pairingPc, setUpFor, type Pc } from "./pairing.test-helpers.ts";
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

/** The account's list made now, and the adding PC pinned to it as a PC a person added (as the step's addingPc does). */
async function pinToNewList(made: Pc): Promise<{ list: TestList; ownKey: string }> {
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
  return { list, ownKey: made.account.accountList(ACCOUNT)!.state.pcs[endpointOf(made)]!.key! };
}

/** The adding PC: in the account by one press; with `list`, the account then made its list and this PC follows it. */
async function addingPc(options: { list: boolean }): Promise<{ pc: Pc; list: TestList | null; ownKey: string | null }> {
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux" }, startRelay: false });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  cleanups.push(() => made.close());
  const call = (path: string, body: unknown, header: string) => made.local(path, { method: "POST", headers: { [header]: "1" }, body });
  if ((await call("/api/relay/start", undefined, "x-herdr-update")).status !== 200) throw new Error("The relay did not start");
  if ((await call("/api/account/relay-account", { account: ACCOUNT }, "x-herdr-machine")).status !== 204) throw new Error("The account was not named");
  await listAndAdmit(made.account, made.app.context.services.relay.currentIdentity()!);
  if ((await call("/api/account/one-press", { account: ACCOUNT }, "x-herdr-machine")).status !== 200) throw new Error("The adding PC was not added");
  if (!options.list) return { pc: made, list: null, ownKey: null };
  const { list, ownKey } = await pinToNewList(made);
  return { pc: made, list, ownKey };
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

/** That PC in the account already on the account service's word, from before the account had its list: one press. */
async function boundBefore(b: Pc, service: FakeAccountService): Promise<void> {
  await askRecovery(b.stateDir, { act: "account_add_inspect" });
  await setUpFor(b, ACCOUNT);
  await listAndAdmit(service, b.app.context.services.relay.currentIdentity()!);
  const pressed = await b.local("/api/account/one-press", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account: ACCOUNT } });
  if (pressed.status !== 200) throw new Error(`Not added in one press: ${pressed.status} ${JSON.stringify(pressed.body)}`);
}

/** That PC's owner socket behind a stand-in that records what reaches it; `answer` stands in for another Ovis there. */
function recorded(pc: Pc, answer: (request: unknown, said: unknown) => unknown = (_request, said) => said): { path: string; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rv-"));
  const proxy = openRecoverySocket({ stateDir: dir, handle: async (request) => { seen.push(request as Record<string, unknown>); return answer(request, await askRecovery(pc.stateDir, request)); } });
  if ("refused" in proxy) throw new Error(proxy.refused);
  cleanups.push(() => { proxy.stop(); rmSync(dir, { recursive: true, force: true }); });
  return { path: proxy.path, seen };
}

/**
 * That PC's owner socket behind a forward that can drop: for each request, `fate` says whether it reaches that PC and is
 * answered (`answer`), reaches it and the forward then drops before the answer comes back (`lost`), or drops before it
 * reaches that PC at all (`dropped`). A dropped forward is what the take's own catch in MachineManager.accountTake is for.
 */
function droppy(pc: Pc, fate: (request: Record<string, unknown>, index: number) => "answer" | "lost" | "dropped"): { path: string; seen: { request: Record<string, unknown>; fate: string }[] } {
  const seen: { request: Record<string, unknown>; fate: string }[] = [];
  const dir = mkdtempSync(join(tmpdir(), "rv-"));
  const path = join(dir, "s.sock");
  const listener = Bun.listen<{ buffered: string; done: boolean }>({ unix: path, socket: {
    open(socket) { socket.data = { buffered: "", done: false }; },
    data(socket: Socket<{ buffered: string; done: boolean }>, chunk) {
      if (socket.data.done) return;
      socket.data.buffered += chunk.toString();
      const newline = socket.data.buffered.indexOf("\n");
      if (newline < 0) return;
      socket.data.done = true;
      const request = JSON.parse(socket.data.buffered.slice(0, newline)) as Record<string, unknown>;
      const said = fate(request, seen.length);
      seen.push({ request, fate: said });
      if (said === "dropped") { socket.end(); return; }
      void askRecovery(pc.stateDir, request).then((answer) => {
        if (said === "answer") socket.write(`${JSON.stringify(answer)}\n`);
        socket.end();
      }, () => socket.end());
    },
  } });
  cleanups.push(() => { listener.stop(true); rmSync(dir, { recursive: true, force: true }); });
  return { path, seen };
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

/** Whether the adding PC's own copy of its list holds that PC, in. */
const aHolds = (a: Pc, b: Pc): boolean => a.app.context.services.accountList!.holdsPc(endpointOf(b));

/** The `pc` entries of the list as the account service holds it that add the PC at `endpoint`. */
const pcEntriesFor = (service: FakeAccountService, endpoint: string): number =>
  service.accountList(ACCOUNT)!.entries.map((text) => readBody(entryFromText(text).body)).filter((body) => {
    const field = body.own.find((own) => own.name === "endpoint");
    return body.kind === "pc" && field !== undefined && (bytesToHex(field.value) === endpoint || new TextDecoder().decode(field.value) === endpoint);
  }).length;

// ---------------------------------------------------------------------------------------------------------------------
// Findings: each FAILS on e7b5143d7.
// ---------------------------------------------------------------------------------------------------------------------

test.skipIf(process.platform === "win32")("finding M1: a PC the list removed, which has not read its removal yet, is not said added when the person adds it over SSH again", async () => {
  const a = await addingPc({ list: true });
  const list = a.list!;
  const b = await otherPc(a.pc.account);
  const socket = recorded(b);
  sshTo(socket.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  expect((await sshAdd(a.pc, job)).status).toBe(200);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
  // a member removes that PC from the list (Not me, or the person changed their mind); this PC reads it, that one not yet
  list.refresh();
  await list.remove(a.pc.account.accountList(ACCOUNT)!.state.pcs[endpointOf(b)]!.key!);
  await a.pc.app.context.services.accountMailbox.pull();
  await a.pc.app.context.services.accountList!.settled();
  expect(aHolds(a.pc, b)).toBe(false);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
  // Add PC over SSH again: that PC answers the first take as joined from its stale copy
  const again = await connected(a.pc);
  const second = await sshAdd(a.pc, again);
  // On e7b5143d7 the route answers 200 `{ account, relay }` and the window says "Added", while this PC's own copy shows
  // that PC removed for good. It should say added only once its own copy holds that PC (as the lead's ac10f7b58 does)
  expect(second.status, JSON.stringify(second.body)).not.toBe(200);
});

test.skipIf(process.platform === "win32")("finding M1 (a B that lies): the first take answered `{ account, relay }` is not taken as added while this PC's copy does not hold that PC", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  // That PC answers the take that names the list as joined, at once: a B that lies, or one whose copy is stale (above)
  const lying = recorded(b, (request, said) => (request as Record<string, unknown>).list !== undefined ? { account: ACCOUNT, relay: { phase: "online", blocked: null } } : said);
  sshTo(lying.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const added = await sshAdd(a.pc, job);
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  expect(aHolds(a.pc, b)).toBe(false);
  // e7b5143d7: 200 added, nothing signed and that PC in no list
  expect(added.status, JSON.stringify(added.body)).not.toBe(200);
});

test.skipIf(process.platform === "win32")("finding M2a: a lost answer to the first take, for a PC in the account from before its list, is not said added: nothing was signed and that PC follows no list", async () => {
  const a = await addingPc({ list: false });
  const b = await otherPc(a.pc.account);
  await boundBefore(b, a.pc.account);
  await pinToNewList(a.pc);
  // the forward drops while that PC answers the first take (it posted its keys and read the list: a few seconds)
  const forward = droppy(b, (request) => request.act === "account_add_take" && request.list !== undefined ? "lost" : "answer");
  sshTo(forward.path);
  const job = await connected(a.pc);
  expect(job.account_add!.account).toBe(ACCOUNT);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const added = await sshAdd(a.pc, job);
  // (since the ruling on M2b, a take that names a list asks no second inspect: what that PC says of its account is no
  // answer for the list)
  expect(forward.seen.map((seen) => `${seen.request.act} ${seen.fate}`)).toEqual(["account_add_inspect answer", "account_add_take lost"]);
  // nothing signed, that PC not pinned, this PC's copy without it
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: false });
  expect(aHolds(a.pc, b)).toBe(false);
  // e7b5143d7: 200 `{ account, relay: null, unanswered: true }` (MachineManager.accountTake's catch: inspectAgain found
  // that PC "in the account", which a PC bound on the service's word before the list always is)
  expect(added.status, JSON.stringify(added.body)).not.toBe(200);
  // nothing signed and its answer lost: whether it follows the list is not known (PR #4645 review)
  expect([added.status, added.body.error?.code]).toEqual([409, "take_unanswered"]);
});

test.skipIf(process.platform === "win32")("finding M2b: a take lost after the entry is placed, for a PC in the account from before its list, is not said added while that PC has not taken the list", async () => {
  const a = await addingPc({ list: false });
  const b = await otherPc(a.pc.account);
  await boundBefore(b, a.pc.account);
  await pinToNewList(a.pc);
  // the first take is answered (waiting, with the card); the forward drops before the second take reaches that PC
  let takes = 0;
  const forward = droppy(b, (request) => {
    if (request.act !== "account_add_take") return "answer";
    takes++;
    return takes === 1 ? "answer" : "dropped";
  });
  sshTo(forward.path);
  const job = await connected(a.pc);
  const added = await sshAdd(a.pc, job);
  // the entry is in, signed by this PC, and this PC's copy holds that PC
  expect(pcEntriesFor(a.pc.account, endpointOf(b))).toBe(1);
  expect(aHolds(a.pc, b)).toBe(true);
  // that PC never got the take that would have pinned it: it is in the account on the service's word alone
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: false, want: null });
  // e7b5143d7 (and ac10f7b58, whose check of this PC's own copy passes here): 200 unanswered, "Added". It should say the
  // add stopped with the entry placed and that PC not following the list (`list_unbound` on ac10f7b58's words)
  expect(added.status, JSON.stringify(added.body)).not.toBe(200);
  // the entry is in the list, and that PC did not take it: said where the add stopped (PR #4645 review)
  expect([added.status, added.body.error?.code]).toEqual([409, "list_unbound"]);
});

test.skipIf(process.platform === "win32")("finding L1: a take lost after the entry is placed, for a PC in no account, is not answered `refused` (\"not added, try again\") while that PC's entry is in the list", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  let takes = 0;
  const forward = droppy(b, (request) => {
    if (request.act !== "account_add_take") return "answer";
    takes++;
    return takes === 1 ? "answer" : "dropped";
  });
  sshTo(forward.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const added = await sshAdd(a.pc, job);
  expect(pcEntriesFor(a.pc.account, endpointOf(b))).toBe(1);
  expect(aHolds(a.pc, b)).toBe(true);
  expect(b.devices.account()).toBeNull();
  // e7b5143d7 and ac10f7b58: 409 `refused` "That PC did not take the account" (inspectAgain found it in no account),
  // which the window shows as "It was not added to your account. Try again." It is in the list as a full signer
  expect([added.status, added.body.error?.code]).not.toEqual([409, "refused"]);
  expect([added.status, added.body.error?.code]).toEqual([409, "list_unbound"]);
});

test.skipIf(process.platform === "win32")("finding L2: an error a current Ovis there gives with no code is not taken for an Ovis from before lists", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  const socket = recorded(b);
  sshTo(socket.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  // between the inspect and the take, that PC's safety log turns unreadable (a disk problem): a current Ovis answers its
  // own words with no code, as it does to every act but `list` then
  writeFileSync(join(b.stateDir, "account-log.json"), "not json", { mode: 0o600 });
  const added = await sshAdd(a.pc, job);
  expect(added.status).toBe(409);
  // e7b5143d7: `that_pc_old`, "That PC's Ovis is too old ... Update Ovis there": updating changes nothing
  expect(added.body.error?.code).not.toBe("that_pc_old");
  // its own error, with no code: it could not answer (PR #4645 review)
  expect(added.body.error?.code).toBe("that_pc_error");
});

// ---------------------------------------------------------------------------------------------------------------------
// Pins: each passes on e7b5143d7 and holds a guard the step's own tests let a mutant past.
// ---------------------------------------------------------------------------------------------------------------------

test.skipIf(process.platform === "win32")("pin: this PC signs that PC's `pc` entry at the relay key and with the name its own inspect read, never ones that PC's answer names", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  // another PC's relay key and a card of B's list key for it: what a B that lies would hand over beside its waiting answer
  const elsewhere = bytesToHex(importPublicKey(exportPublicKey(generateKeyPair().publicKey)));
  const lying = recorded(b, (request, said) => {
    const answer = said as Record<string, unknown>;
    if ((request as Record<string, unknown>).list === undefined || answer.state !== "waiting") return said;
    return { ...answer, endpoint: elsewhere, label: "Not the inspect's name", server_id: "f".repeat(32), public_key: "nope" };
  });
  sshTo(lying.path);
  const signed: AddedPc[] = [];
  const realAddPc = ListFollow.prototype.addPc;
  ListFollow.prototype.addPc = function (this: ListFollow, pc: AddedPc) { signed.push(pc); return realAddPc.call(this, pc); };
  cleanups.push(() => { ListFollow.prototype.addPc = realAddPc; });
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const added = await sshAdd(a.pc, job);
  expect(added.status).toBe(200);
  expect(signed.map((pc) => [pc.endpoint, pc.label])).toEqual([[bytesToHex(importPublicKey(job.account_add!.public_key)), job.account_add!.label]]);
  expect(pcEntriesFor(a.pc.account, elsewhere)).toBe(0);
  expect(pcEntriesFor(a.pc.account, endpointOf(b))).toBe(1);
});

test.skipIf(process.platform === "win32")("pin: a card of that PC's key for another relay key than the inspect read is not signed: nothing is placed and that PC binds nothing", async () => {
  const a = await addingPc({ list: true });
  const list = a.list!;
  const b = await otherPc(a.pc.account);
  const other = await listMember();
  const elsewhere = bytesToHex(importPublicKey(exportPublicKey(generateKeyPair().publicKey)));
  // a B that hands over a card of a key of its own for another relay key
  const lying = recorded(b, async (request, said) => {
    const answer = said as Record<string, unknown>;
    if ((request as Record<string, unknown>).list === undefined || answer.state !== "waiting") return said;
    return { ...answer, key: other.key, enc: other.enc, card: await signCard({ key: other.key, enc: other.enc, list: list.id, endpoint: elsewhere, invite: null }, other.keys.privateKey) };
  });
  sshTo(lying.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const added = await sshAdd(a.pc, job);
  expect([added.status, added.body.error?.code]).toEqual([409, "list_not_added"]);
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  expect(b.devices.account()).toBeNull();
});

test.skipIf(process.platform === "win32")("pin: two Adds of one job at once place one entry, signed once", async () => {
  const a = await addingPc({ list: true });
  const b = await otherPc(a.pc.account);
  const socket = recorded(b);
  sshTo(socket.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  const [first, second] = await Promise.all([sshAdd(a.pc, job), sshAdd(a.pc, job)]);
  expect([first.status, second.status]).toContain(200);
  expect(pcEntriesFor(a.pc.account, endpointOf(b))).toBe(1);
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, standing: "in" });
});

test.skipIf(process.platform === "win32")("pin: a PC the list removed is not taken for one in it: its card is signed into nothing, and the add says so", async () => {
  const a = await addingPc({ list: true });
  const list = a.list!;
  const b = await otherPc(a.pc.account);
  // honest at first; later it hands over its (removed) card for the list as one that waits for its entry
  let card: { key: string; enc: string; card: string } | null = null;
  const socket = recorded(b, (request, said) => card !== null && (request as Record<string, unknown>).list !== undefined ? { state: "waiting", standing: "waiting", ...card } : said);
  sshTo(socket.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  expect((await sshAdd(a.pc, job)).status).toBe(200);
  list.refresh();
  await list.remove(a.pc.account.accountList(ACCOUNT)!.state.pcs[endpointOf(b)]!.key!);
  await a.pc.app.context.services.accountMailbox.pull();
  await a.pc.app.context.services.accountList!.settled();
  expect(aHolds(a.pc, b)).toBe(false);
  card = (await b.app.context.services.accountList!.cardFor(list.id))!;
  const again = await connected(a.pc);
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const second = await sshAdd(a.pc, again);
  expect([second.status, second.body.error?.code]).toEqual([409, "list_not_added"]);
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
});

test.skipIf(process.platform === "win32")("pin: an account service that refuses every placement head_moved gets nothing said added: nothing is placed, that PC binds nothing and its relay stays off", async () => {
  const a = await addingPc({ list: true });
  const list = a.list!;
  const b = await otherPc(a.pc.account);
  const socket = recorded(b);
  sshTo(socket.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  a.pc.account.tamperList(list.id, { headMoved: true });
  const head = a.pc.account.accountList(ACCOUNT)!.head;
  const added = await sshAdd(a.pc, job);
  expect(added.status).toBe(409);
  expect(["take_unanswered", "list_not_added"]).toContain(added.body.error?.code ?? "");
  expect(a.pc.account.accountList(ACCOUNT)!.head).toEqual(head);
  expect(b.devices.account()).toBeNull();
  expect(b.app.context.services.relay.status().phase).toBe("off");
  // one take named the list; nothing went after the entry was not placed
  expect(socket.seen.map((request) => request.act)).toEqual(["account_add_inspect", "account_add_take"]);
});

test.skipIf(process.platform === "win32")("pin: a PC that follows another list of its account takes no entry by a take that names this one, and posts nothing for it", async () => {
  const a = await addingPc({ list: true });
  const list = a.list!;
  const b = await otherPc(a.pc.account);
  const socket = recorded(b);
  sshTo(socket.path);
  const job = await connected(a.pc);
  await listAndAdmit(a.pc.account, job.account_add!);
  expect((await sshAdd(a.pc, job)).status).toBe(200);
  const other = "e".repeat(64);
  const taken = await askRecovery(b.stateDir, { act: "account_add_take", account: ACCOUNT, server_id: b.app.context.services.relay.currentIdentity()!.server_id, list: other, adder: list.first.key });
  expect(taken).toMatchObject({ code: "pinned" });
  expect(b.app.context.services.accountList!.status()).toMatchObject({ pinned: true, pinned_list: list.id });
});
