/**
 * `ovis recover` against a real server (device-row-states rows R11, T70, P23, S19): with the release flag on the
 * server opens the recovery socket in its state folder and answers it; with the flag off it opens none. While the
 * log cannot be read, the list still answers and nothing is released.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { newRecordId, signSafetyRecord, type BlockRecord, type SafetyRecord } from "../../shared/account-records.ts";
import { bounded, relayConnection } from "../relay/test-helpers.ts";
import { ask } from "./pairing.test-helpers.ts";
import { provingDevice as proveKey } from "./key-proof.test-helpers.ts";
import { JOURNAL_FILE } from "./device-journal.ts";
import { firstPairingRead, memberRow, pairingPc, phone, provingDevice, setUpFor, type Pc } from "./pairing.test-helpers.ts";
import { pcRecordId } from "./safety-log.ts";
import { PcAccountState } from "./pc-binding.ts";
import { askRecovery, RECOVER_DIR, RECOVER_SOCKET } from "./recovery.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });
const unix = process.platform !== "win32";

test.if(unix)("R11: with the flag on, the server answers ovis recover on its recovery socket", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "list" }))).toEqual({ rows: [], pending: [], standing: [] });
});

test.if(unix)("R11: with the flag off, the server opens no recovery socket", async () => {
  const made = await pairingPc({ server: { accountOpensAll: false } });
  pcs.push(made);
  expect(existsSync(join(made.stateDir, RECOVER_DIR, RECOVER_SOCKET))).toBe(false);
});

test.if(unix)("P23: while the log cannot be read, ovis recover still lists, and releases nothing", async () => {
  const made = await pairingPc({ startRelay: false, server: { accountOpensAll: true },
    prepare: (dir) => { writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 }); } });
  pcs.push(made);
  made.app.context.services.recoveryReleases!.registerRecoverySource(() => [{
    id: "0123456789abcdef", key: "key-a", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up",
    joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, lastSeenAt: null,
  }]);
  const listed = await bounded(askRecovery(made.stateDir, { act: "list" })) as { rows: { id: string; refusal: string | null }[] };
  expect(listed.rows.map((row) => [row.id, row.refusal])).toEqual([["0123456789abcdef", "log_unreadable"]]);
  expect(await bounded(askRecovery(made.stateDir, { act: "release", rows: ["0123456789abcdef"] }))).toEqual({ error: "0123456789abcdef cannot be released: log_unreadable" });
  expect(made.app.context.services.recoveryReleases!.releaseOf("0123456789abcdef")).toBeNull();
});

test.if(unix)("P23/T37/T69/T70/P22: every write refuses a log that turns unreadable after start without changing state", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const releases = made.app.context.services.recoveryReleases!;
  releases.registerRecoverySource(() => [{
    id: "0123456789abcdef", key: "key-a", label: "Phone", origin: { from: "remote", how: "list" }, waiting: "catching_up",
    joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, lastSeenAt: null,
  }]);
  expect(await bounded(askRecovery(made.stateDir, { act: "release", rows: ["0123456789abcdef"] }))).toEqual({ released: ["0123456789abcdef"] });
  const { waiting } = await waitingDevice(made);
  const activeRelease = releases.releaseOf("0123456789abcdef");
  const beforeRows = made.stored();
  const beforeJournal = journal(made);
  const logPath = join(made.stateDir, "account-log.json");
  writeFileSync(logPath, "not json", { mode: 0o600 });

  const error = { error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" };
  for (const action of [
    { act: "remove", targets: [member.row.id] },
    { act: "lift", blocks: ["a".repeat(64)] },
    { act: "revoke_all" },
    { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint },
    { act: "undo", rows: null },
  ]) {
    expect(await bounded(askRecovery(made.stateDir, action))).toEqual(error);
  }
  // The write gate must answer before release looks up a row, even one that does not wait here.
  const missing = "fedcba9876543210";
  expect(await bounded(askRecovery(made.stateDir, { act: "release", rows: [missing] }))).toEqual({ error: `${missing} cannot be released: log_unreadable` });

  const listed = await bounded(askRecovery(made.stateDir, { act: "list" })) as { rows: { refusal: string | null }[]; pending: unknown[] };
  expect(listed.rows.map((row) => row.refusal)).toEqual(["log_unreadable"]);
  expect(listed.pending).toEqual([waiting]);
  expect(made.stored()).toEqual(beforeRows);
  expect(journal(made)).toEqual(beforeJournal);
  expect(readFileSync(logPath, "utf8")).toBe("not json");
  expect(releases.releaseOf("0123456789abcdef")).toEqual(activeRelease);
});

test.if(unix)("T37: remove of a named key over the socket ends its row and records the removal", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "remove", targets: [member.row.id] }))).toEqual({ removed: [member.row.id] });
  expect(made.stored().some((row) => row.id === member.row.id)).toBe(false);
});

test.if(unix)("T69: a lift of a block this log does not hold is refused, and changes nothing", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  const answer = await bounded(askRecovery(made.stateDir, { act: "lift", blocks: ["a".repeat(64)] })) as { error?: string };
  expect(answer.error).toContain("was not lifted");
});

test.if(unix)("T69: a lift recorded in the safety log is reported even if its journal write fails", async () => {
  const target = await phone();
  const made = await pairingPc({ startRelay: false, server: { accountOpensAll: true } });
  pcs.push(made);
  const log = made.app.context.services.safetyLog;
  const id = `f:${"a".repeat(64)}`;
  expect(log?.append({ record: { v: 1, id, kind: "freeze", account: "acct_1", target: target.spki, after: 9, signer: "service", signed_at: new Date().toISOString(), signature: "" }, got: "snapshot" }).outcome).toBe("applied");
  mkdirSync(join(made.stateDir, JOURNAL_FILE));

  const result = await bounded(askRecovery(made.stateDir, { act: "lift", blocks: [id] }));
  expect(log?.state().freezes).toEqual([]);
  expect(result).toMatchObject({ lifted: [id], error: expect.stringContaining("could not be journalled") });
});

test.if(unix)("T70: revoke-all over the socket ends every row", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "revoke_all" }))).toEqual({ revoked: 1 });
  expect(made.stored()).toEqual([]);
});

test.if(unix)("P23: while the log cannot be read, remove, lift, revoke-all and admit all refuse", async () => {
  const made = await pairingPc({ startRelay: false, server: { accountOpensAll: true },
    prepare: (dir) => { writeFileSync(join(dir, "account-log.json"), "not json", { mode: 0o600 }); } });
  pcs.push(made);
  for (const act of [{ act: "remove", targets: ["0123456789abcdef"] }, { act: "lift", blocks: ["a".repeat(64)] }, { act: "revoke_all" },
    { act: "admit", pending: "0123456789abcdef0123456789abcdef", fingerprint: "AB12-CD34" }]) {
    expect(await bounded(askRecovery(made.stateDir, act))).toEqual({ error: "This PC cannot read its safety log, so nothing is changed: log_unreadable" });
  }
});

test.if(unix)("P22: admit of a device that does not wait here admits nobody", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: "0123456789abcdef0123456789abcdef", fingerprint: "AB12-CD34" }))).toEqual({ error: "No such device waits here" });
});

const journal = (made: Pc) => (JSON.parse(readFileSync(join(made.stateDir, JOURNAL_FILE), "utf8")) as { entries: { kind: string; how: string; row: string | null; label: string; by: string | null }[] }).entries;

async function waitingDevice(made: Pc) {
  const paired = await provingDevice(made, await made.offerCode());
  await paired.pending;
  const listed = await bounded(askRecovery(made.stateDir, { act: "list" })) as { pending: { id: string; label: string; fingerprint: string }[] };
  return { paired, waiting: listed.pending.find((entry) => entry.fingerprint === paired.fingerprint)! };
}

for (const later of ["different block", "different freeze", "same freeze", "targeted freeze", "same block after freeze", "different block after freeze"] as const)
test.if(unix).each(["new", "existing"] as const)(`recovery of a %s key is scoped to its admission: ${later}`, async history => {
  const account = "acct_1";
  const member = await memberRow(account);
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const key = await phone();
  const old = history === "existing" ? made.devices.pairRelay(made.devices.startPairing().code, "Old phone", key.spki) : null;
  if (history === "existing" && !old) throw new Error("Could not establish prior pairing");
  const log = made.app.context.services.safetyLog;
  if (!log) throw new Error("Missing safety log");
  const makeBlock = async () => {
    const other = await phone();
    return signSafetyRecord({ v: 1, kind: "block", account, signer: member.key.spki, signer_no: 1,
      target: other.spki, target_no: 2, nonce: newRecordId(), signed_at: new Date().toISOString() }, member.key.keys.privateKey);
  };
  const appendBlock = (record: Awaited<ReturnType<typeof makeBlock>>) => {
    expect(log.append({ got: "handed", record, asof: { signer_no: 0, target_no: 0, joined: 0, after: 0, signer_removed: false } }).outcome).toBe("applied");
  };
  const original = await makeBlock();
  if (later === "same block after freeze" || later === "different block after freeze") {
    expect(log.append({ got: "snapshot", record: { v: 1, kind: "freeze", account, signer: "service", signature: "",
      id: `f:${original.id}`, target: original.target, signed_at: original.signed_at, after: 1 } }).outcome).toBe("applied");
  } else appendBlock(original);
  await firstPairingRead(made);
  if (old) expect(made.devices.catchingUp(old.device.id)).toBe(true);
  const pending = await proveKey(made, made.devices.startPairing().code, {}, key);
  await pending.pending;
  const list = await askRecovery(made.stateDir, { act: "list" }) as { pending: { id: string; fingerprint: string }[] };
  const entry = list.pending.find(row => row.fingerprint === pending.fingerprint);
  if (!entry) throw new Error("Missing exact-key recovery request");
  const answer = await askRecovery(made.stateDir, { act: "admit", pending: entry.id, fingerprint: entry.fingerprint }) as { admitted?: { id: string } };
  expect(answer).toHaveProperty("admitted");
  const id = made.stored().find(row => row.relay_public_key === key.spki)?.id;
  if (!id) throw new Error("Admitted key was not stored");
  const status = async () => {
    const link = await relayConnection(made);
    return bounded(link.auth({ id, keys: key.keys, publicKey: key.spki }).then(async () => (await ask(link, "/api/devices")).status, () => 401));
  };
  const immediately = await status();
  await firstPairingRead(made);
  const afterRead = await status();
  if (later === "same block after freeze") appendBlock(original);
  else if (later === "different block" || later === "different block after freeze") appendBlock(await makeBlock());
  else expect(log.append({ got: "snapshot", record: { v: 1, kind: "freeze", account, signer: "service", signature: "",
    id: `f:${later === "different freeze" ? "a".repeat(64) : original.id}`, signed_at: original.signed_at,
    target: later === "targeted freeze" ? key.spki : original.target, after: 1 } }).outcome).toBe("applied");
  await firstPairingRead(made);
  expect([immediately, afterRead, await status()]).toEqual([200, 200, later === "same freeze" || later === "same block after freeze" ? 200 : 401]);
});

test.if(unix)("recover --admit cannot undo a local Revoke of the exact waiting key", async () => {
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const key = await phone();
  const old = made.devices.pairRelay(made.devices.startPairing().code, "Phone", key.spki);
  if (!old) throw new Error("Missing phone to revoke");
  const pending = await proveKey(made, made.devices.startPairing().code, {}, key);
  await pending.pending;
  const list = await askRecovery(made.stateDir, { act: "list" }) as { pending: { id: string; fingerprint: string }[] };
  const row = list.pending.find(item => item.fingerprint === pending.fingerprint);
  if (!row) throw new Error("Missing pending fingerprint");
  expect(made.devices.removeKey({ target: key.spki, by: "local" })).toEqual({ removed: [old.device.id] });
  expect(await askRecovery(made.stateDir, { act: "admit", pending: row.id, fingerprint: row.fingerprint })).not.toHaveProperty("admitted");
  expect(made.devices.isTombstoned(key.spki)).toBe(true);
  expect(made.devices.sessionRow(old.device.id)).toBeNull();
});

test.if(unix)("a copied screen origin is not a screen confirmation on this PC", async () => {
  const member = await memberRow("acct_1"), copy = await memberRow("acct_1");
  const imported = { ...copy.row, imported: true, origin: { from: "pc", how: "link", by: null, admit_no: 2, at: copy.row.created_at } };
  const made = await pairingPc({ rows: [member.row, imported], prepare(dir) {
    const state = PcAccountState.open(dir);
    state.migrate("acct_1", true);
    state.admit("pc", "link", null, Date.now()); state.admit("pc", "link", null, Date.now());
  },
    server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const { safetyLog, devices } = made.app.context.services;
  expect(devices.admits(copy.key.spki, undefined, { retainId: copy.row.id })).toBe(true);
  expect(safetyLog?.append({ got: "snapshot", record: { v: 1, kind: "freeze", account: "acct_1",
    id: `f:${"b".repeat(64)}`, target: member.key.spki, after: 1, signer: "service", signed_at: new Date().toISOString(), signature: "" } }).outcome).toBe("applied");
  expect(devices.admits(copy.key.spki, undefined, { retainId: copy.row.id })).toBe(false);
});

for (const kind of ["block", "freeze"] as const) {
  test.if(unix)(`P23/T70: admit leaves a waiting key targeted by a standing ${kind} untouched`, async () => {
    const member = await memberRow("acct_1");
    const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true, platform: "linux" } });
    pcs.push(made);
    const { paired, waiting } = await waitingDevice(made);
    const account = "acct_1";
    const target = paired.device.spki;
    const signed_at = new Date().toISOString();
    const log = made.app.context.services.safetyLog;
    if (log === null) throw new Error("Expected a safety log");
    const block = await signSafetyRecord({
      v: 1, kind: "block", account, target, target_no: 9, signer: member.key.spki, signer_no: 1, signed_at, nonce: newRecordId(),
    }, member.key.keys.privateKey);
    const receipt = kind === "block"
      ? log.append({ record: block, got: "handed", asof: { signer_no: 1, target_no: 9, after: 9, joined: 9, signer_removed: false } })
      : log.append({ record: { v: 1, id: `f:${block.id}`, kind: "freeze", account, target, after: 9, signer: "service", signed_at, signature: "" }, got: "snapshot" });
    expect(receipt.outcome).toBe("applied");
    const before = made.stored();

    expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint }))).toEqual({
      error: `New phone cannot be admitted while ${kind} ${receipt.id} stands: lift it first with ovis recover --lift ${receipt.id}`,
    });
    expect(made.stored()).toEqual(before);
    expect(await bounded(askRecovery(made.stateDir, { act: "list" }))).toMatchObject({ pending: [waiting] });
  });
}

test.if(unix)("P22/T70: the fingerprint the terminal showed admits the waiting device once, with origin recover; a wrong one admits nobody", async () => {
  const made = await pairingPc({ rows: [(await memberRow("acct_1")).row], server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const { paired, waiting } = await waitingDevice(made);
  expect(waiting.label).toBe("New phone");
  expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: `${waiting.fingerprint[0] === "0" ? "1" : "0"}${waiting.fingerprint.slice(1)}` }))).toEqual({ error: "The fingerprint does not match the waiting device" });
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
  const admitted = await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint })) as { admitted: string };
  const row = made.stored().find((stored) => stored.relay_public_key === paired.device.spki) as { id: string; origin?: { from: string } } | undefined;
  expect(row?.id).toBe(admitted.admitted);
  expect(row?.origin?.from).toBe("recover");
  expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint }))).toEqual({ error: "No such device waits here" });
});

test.if(unix)("P22: while the PC is locked, the right fingerprint admits nobody, and the waiting device is gone", async () => {
  const made = await pairingPc({ rows: [(await memberRow("acct_1")).row], server: { accountOpensAll: true, platform: "linux" } });
  pcs.push(made);
  const { paired, waiting } = await waitingDevice(made);
  made.app.context.services.safetyLog!.append({ record: { v: 1, id: pcRecordId(), kind: "lock", account: "acct_1", target: null, signer: "pc", signed_at: new Date().toISOString(), signature: "" } as SafetyRecord, got: "pc" });
  expect(await bounded(askRecovery(made.stateDir, { act: "admit", pending: waiting.id, fingerprint: waiting.fingerprint }))).toEqual({ error: "This PC refused to admit the key (locked, frozen, or its log cannot be read)" });
  expect(made.stored().some((row) => row.relay_public_key === paired.device.spki)).toBe(false);
  expect((await bounded(askRecovery(made.stateDir, { act: "list" })) as { pending: unknown[] }).pending).toEqual([]);
});

test.if(unix)("T69/P24: a lift at the PC ends the block, and the journal says recover and this PC's user", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  const [signer, target] = [await phone(), await phone()];
  for (const key of [signer, target]) {
    const id = made.devices.pairRelay(made.devices.startPairing().code, "Phone", key.spki)!.device.id;
    made.devices.linkAccountKey(id, key.spki, key.spki, "acct_1");
  }
  await firstPairingRead(made);
  const block = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: target.spki, target_no: 9, signer: signer.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, signer.keys.privateKey) as BlockRecord;
  await made.devices.applyBlock(block, "handed");
  expect(await bounded(askRecovery(made.stateDir, { act: "lift", blocks: [block.id] }))).toEqual({ lifted: [block.id] });
  expect(made.app.context.services.safetyLog!.state().blocks).toEqual([]);
  expect(journal(made).filter((entry) => entry.kind === "lift")).toEqual([expect.objectContaining({ how: "recover", label: block.id, by: userInfo().username })]);
});

test.if(unix)("T69: a lift ends an active block under the PC's former account", async () => {
  const made = await pairingPc({ server: { accountOpensAll: true } });
  pcs.push(made);
  await setUpFor(made, "acct_1");
  const [signer, target] = [await phone(), await phone()];
  const block = await signSafetyRecord({
    v: 1, kind: "block", account: "acct_old", target: target.spki, target_no: 9, signer: signer.spki,
    signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId(),
  }, signer.keys.privateKey);
  const log = made.app.context.services.safetyLog;
  expect(log?.append({
    record: block, got: "handed", asof: { signer_no: 1, target_no: 9, after: 9, joined: 9, signer_removed: false },
  }).outcome).toBe("applied");
  expect(log?.state().blocks.map((entry) => entry.record.id)).toEqual([block.id]);

  expect(await bounded(askRecovery(made.stateDir, { act: "lift", blocks: [block.id] }))).toEqual({ lifted: [block.id] });
  expect(log?.state().blocks).toEqual([]);
  expect(journal(made).filter((entry) => entry.kind === "lift")).toEqual([
    expect.objectContaining({ label: block.id, account: "acct_old" }),
  ]);
});

test.if(unix)("T70/E48: the list names each standing block and freeze once, and the listed freeze ID can be lifted", async () => {
  const account = "acct_old";
  const member = await memberRow("acct_1");
  const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
  pcs.push(made);
  const [target, frozen] = [await phone(), await phone()];
  const signer = member.key.spki;
  const signed_at = new Date().toISOString();
  const block = await signSafetyRecord({
    v: 1, kind: "block", account, target: target.spki, target_no: 9, signer, signer_no: 1, signed_at, nonce: newRecordId(),
  }, member.key.keys.privateKey);
  const freezeId = `f:${"c".repeat(64)}`;
  const log = made.app.context.services.safetyLog;
  if (log === null) throw new Error("Expected a safety log");
  expect(log.append({ record: block, got: "handed", asof: { signer_no: 1, target_no: 9, after: 9, joined: 9, signer_removed: false } }).outcome).toBe("applied");
  expect(log.append({ record: { v: 1, id: freezeId, kind: "freeze", account, target: frozen.spki, after: 9, signer: "service", signed_at, signature: "" },
    got: "snapshot" }).outcome).toBe("applied");

  const standingBlock = { kind: "block", id: block.id, target: target.spki, account, signer };
  expect(await bounded(askRecovery(made.stateDir, { act: "list" }))).toMatchObject({
    standing: [standingBlock, { kind: "freeze", id: freezeId, target: frozen.spki, account, signer: "service" }],
  });
  expect(await bounded(askRecovery(made.stateDir, { act: "lift", blocks: [freezeId] }))).toEqual({ lifted: [freezeId] });
  expect(await bounded(askRecovery(made.stateDir, { act: "list" }))).toMatchObject({ standing: [standingBlock] });
  expect(journal(made).filter((entry) => entry.kind === "lift")).toEqual([
    expect.objectContaining({ how: "recover", label: freezeId, account }),
  ]);
});

test.if(unix)("T37/P24: remove and revoke-all are journalled with recover and this PC's user", async () => {
  const [first, second] = [await memberRow("acct_1"), await memberRow("acct_1")];
  const made = await pairingPc({ rows: [first.row, second.row], server: { accountOpensAll: true } });
  pcs.push(made);
  await bounded(askRecovery(made.stateDir, { act: "remove", targets: [first.row.id] }));
  await bounded(askRecovery(made.stateDir, { act: "revoke_all" }));
  const lines = journal(made).filter((entry) => entry.kind === "remove");
  expect(lines.map((entry) => entry.row)).toEqual(expect.arrayContaining([first.row.id, second.row.id]));
  expect(lines.every((entry) => entry.how === "recover" && entry.by === userInfo().username)).toBe(true);
});
