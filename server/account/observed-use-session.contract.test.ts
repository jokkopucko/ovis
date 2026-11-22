import { afterEach, expect, jest, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAccountDevicesFile, parseSnapshotPage } from "../../shared/account-snapshot.ts";
import { newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { bounded, deferred, relayConnection, relayDevice, TestClock } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE, AccountDeviceStore } from "./account-devices.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { ask } from "./pairing.test-helpers.ts";
import { DeviceJournal } from "./device-journal.ts";
import { RemovalEvidence } from "./removal-evidence.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

test("T55: temporary list ineligibility preserves an expired admission", async () => {
  const machine = await pc();
  const { accountMailbox } = machine.fixture.app.context.services;
  const original = machine.row().origin;
  machine.clock.advance(60 * 86_400_000);
  expect(machine.row().state).toBe("expired");
  const fetchPage = accountMailbox.snapshotPage.bind(accountMailbox);
  const restricted = spyOn(accountMailbox, "snapshotPage").mockImplementation(async (...args) => {
    const answer = await fetchPage(...args);
    if (!("page" in answer)) return answer;
    const page = parseSnapshotPage(answer.page);
    return { page: { ...page, devices: page.devices.map(d => d.key === machine.device.publicKey ? { ...d, eligible: false } : d) } };
  });
  try { expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true }); }
  finally { restricted.mockRestore(); }
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(machine.row()).toMatchObject({ state: "expired", origin: original });
});

async function pc() {
  const clock = new TestClock();
  clock.advance(Date.UTC(2026, 0, 1, 12));
  const time = spyOn(Date, "now").mockImplementation(() => clock.now());
  closes.push(() => time.mockRestore());
  const listed = await createListedPc(close => closes.push(close), clock);
  expect(listed.fixture.app.context.services.devices.accountError).toBeNull();
  const row = () => {
    const found = parseAccountDevicesFile(JSON.parse(readFileSync(join(listed.fixture.stateDir, ACCOUNT_DEVICES_FILE), "utf8")))
      .devices.find(candidate => candidate.id === listed.device.id);
    if (!found) throw new Error("Missing listed row");
    return found;
  };
  clock.advance(10_000);
  const link = await relayConnection(listed.fixture, { serverId: listed.serverId, websocket: listed.fixture.app.context.services.core.socketHandlers });
  expect((await link.auth(listed.device, [ACCOUNT_OPENS_ALL_FEATURE])).role).toBe("drive");
  return { ...listed, clock, row, link };
}

test("P9/T54: the PC journals expiry and closes a silent session without a whole read", async () => {
  const machine = await pc();
  const socket = machine.link.openSocket();
  await socket.opened;
  await socket.until(message => message.type === "features");
  machine.service.opensAll = false;
  machine.clock.advance(60 * 86_400_000);
  const drops = DeviceJournal.open(machine.fixture.stateDir).entries()
    .filter(entry => entry.row === machine.device.id && entry.kind === "drop");
  expect(drops.map(entry => entry.how)).toEqual(["expired"]);
  expect(machine.row().state).toBe("expired");
  expect(machine.fixture.app.context.services.devices.canDrive(machine.device.id)).toBe(false);
  expect(await bounded(socket.closed)).toMatchObject({ code: 1008 });
  expect(await bounded(machine.link.serverError)).toBe("auth_changed");
  await bounded(machine.link.closed);
});

test("P9/T54: an idle session cannot refresh its day while whole reads fail", async () => {
  const machine = await pc();
  const { accountMailbox } = machine.fixture.app.context.services;
  const lastDay = machine.row().last_signin_day;
  machine.clock.advance(60 * 86_400_000);
  machine.service.opensAll = false;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: false, reason: "page_failed" });

  const outcome = await bounded(Promise.race([
    ask(machine.link, "/api/devices").then(answer => answer.status, () => machine.link.serverError),
    machine.link.serverError,
  ]));
  expect(outcome).toBe("auth_changed");
  expect(machine.row()).toMatchObject({ state: "expired", last_signin_day: lastDay });
  machine.service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(machine.row()).toMatchObject({ state: "expired", last_signin_day: lastDay });
});

test("P9/T54: a proved sign-in refuses an idle admission when the service is down", async () => {
  const machine = await pc();
  const lastDay = machine.row().last_signin_day;
  machine.clock.advance(60 * 86_400_000);
  machine.service.opensAll = false;
  const returning = await relayConnection(machine.fixture, { serverId: machine.serverId });
  const result = await bounded(Promise.race([
    returning.auth(machine.device, [ACCOUNT_OPENS_ALL_FEATURE]).then(() => "authenticated", () => returning.serverError),
    returning.serverError,
  ]));
  expect(result).toBe("not_listed");
  expect(machine.row()).toMatchObject({ state: "expired", last_signin_day: lastDay });
  expect(await bounded(machine.link.serverError)).toBe("auth_changed");
});

test("T55/S27: only the expired device's proved attempt gets a new admission, notice and hold", async () => {
  const machine = await pc();
  const { accountMailbox, devices } = machine.fixture.app.context.services;
  const previous = machine.row().origin.admit_no;
  machine.clock.advance(60 * 86_400_000);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(machine.row().state).toBe("expired");
  expect(await bounded(machine.link.serverError)).toBe("auth_changed");
  // A background whole read is not the returning device's proof.
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(machine.row().origin.admit_no).toBe(previous);
  expect(machine.row().state).toBe("expired");

  const returning = await relayConnection(machine.fixture, { serverId: machine.serverId });
  let holdReason: string | undefined;
  returning.onFrame = frame => {
    if (frame.type === FrameType.SESSION_ERROR) holdReason = frame.payload.hold?.reason;
  };
  const result = await bounded(Promise.race([
    returning.auth(machine.device, [ACCOUNT_OPENS_ALL_FEATURE]).then(() => "authenticated", () => returning.serverError),
    returning.serverError,
  ]));
  expect(result).toBe("held");
  expect(holdReason).toBe("join_hold");
  const admitted = machine.row();
  expect(admitted).toMatchObject({
    state: "hold", last_signin_day: null,
    origin: { admit_no: previous + 1 },
    hold_until: new Date(machine.clock.now() + 10_000).toISOString(),
  });
  const history = DeviceJournal.open(machine.fixture.stateDir).entries().filter(entry => entry.row === machine.device.id);
  expect(history.map(({ kind, how, no }) => [kind, how, no]))
    .toEqual([["admit", "list", previous], ["drop", "expired", null], ["admit", "list", previous + 1]]);
  expect(devices.openNotices().filter(notice => notice.row === machine.device.id))
    .toContainEqual(expect.objectContaining({ kind: "admit", no: previous + 1, account: "acct_1" }));
  machine.clock.advance(10_000);
  const ready = await relayConnection(machine.fixture, { serverId: machine.serverId });
  expect((await ready.auth(machine.device, [ACCOUNT_OPENS_ALL_FEATURE])).role).toBe("drive");
  expect((await ask(ready, "/api/devices")).status).toBe(200);
});

test("a returning expired key with a waiting block is refused and the list reports no readmission", async () => {
  const machine = await pc();
  const { devices, safetyLog } = machine.fixture.app.context.services;
  machine.clock.advance(60 * 86_400_000);
  expect(machine.row().state).toBe("expired");
  const target = machine.device.publicKey;
  const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: 2,
    signer: machine.member.publicKey, signer_no: 1, signed_at: new Date(machine.clock.now()).toISOString(), nonce: newRecordId() }, machine.member.keys.privateKey);
  expect(safetyLog?.wait({ record, got: "mailbox", signer_removed: false })).toBe(true);
  const commits = spyOn(AccountDeviceStore.prototype, "commitList");
  try {
    const returning = await relayConnection(machine.fixture, { serverId: machine.serverId });
    expect(await bounded(Promise.race([returning.auth(machine.device, [ACCOUNT_OPENS_ALL_FEATURE]), returning.serverError]))).toBe("auth_failed");
    expect(devices.removedByAccount(target)).toBe(true);
    expect(devices.openNotices().some(notice => notice.key === target)).toBe(false);
    expect(commits.mock.results.map(result => result.value)).toEqual([{ admitted: [], dropped: [] }]);
  } finally { commits.mockRestore(); }
});

test("readmission origin and confirmation follow a local Revoke at the same wall time", async () => {
  const machine = await pc();
  machine.clock.advance(60 * 86_400_000);
  const other = await relayDevice(machine.fixture);
  expect(machine.fixture.app.context.services.devices.revoke(other.id)).toBe(true);
  const [revoked] = RemovalEvidence.open(machine.fixture.stateDir, null).standingRevokes(other.publicKey);
  if (!revoked) throw new Error("Missing durable Revoke");
  const returning = await relayConnection(machine.fixture, { serverId: machine.serverId });
  expect(await bounded(Promise.race([returning.auth(machine.device, [ACCOUNT_OPENS_ALL_FEATURE]), returning.serverError]))).toBe("held");
  const row = machine.row();
  expect(Date.parse(row.origin.at)).toBeGreaterThan(Date.parse(revoked.at));
  expect(row.confirmed_at).toBe(row.origin.at);
});

test.each(["wrong proof", "failed read"] as const)("T55/S27: %s cannot authorize later background readmission", async failure => {
  const machine = await pc();
  const { accountMailbox } = machine.fixture.app.context.services;
  const previous = machine.row().origin.admit_no;
  machine.clock.advance(60 * 86_400_000);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  if (failure === "failed read") machine.service.opensAll = false;
  const returning = await relayConnection(machine.fixture, { serverId: machine.serverId });
  const signer = failure === "wrong proof" ? { ...machine.member, id: machine.device.id } : machine.device;
  const result = await bounded(Promise.race([
    returning.auth(signer, [ACCOUNT_OPENS_ALL_FEATURE]).then(() => "authenticated", () => returning.serverError),
    returning.serverError,
  ]));
  expect(result).toBe(failure === "wrong proof" ? "auth_failed" : "not_listed");
  machine.service.opensAll = true;
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(machine.row()).toMatchObject({ state: "expired", origin: { admit_no: previous } });
});

test("T55/S27: a proved sign-in's snapshot can commit after its five-second reply", async () => {
  const machine = await pc();
  const { accountMailbox, devices } = machine.fixture.app.context.services;
  const previous = machine.row().origin.admit_no;
  machine.clock.advance(60 * 86_400_000);
  const returning = await relayConnection(machine.fixture, { serverId: machine.serverId });
  const started = deferred<void>();
  const release = deferred<void>();
  const page = accountMailbox.snapshotPage.bind(accountMailbox);
  const gate = spyOn(accountMailbox, "snapshotPage").mockImplementation(async (...args) => {
    const answer = await page(...args);
    started.resolve();
    await release.promise;
    return answer;
  });
  jest.useFakeTimers();
  jest.setSystemTime(machine.clock.now());
  try {
    const reply = returning.auth(machine.device, [ACCOUNT_OPENS_ALL_FEATURE]).then(() => "authenticated", () => returning.serverError);
    await started.promise;
    const read = accountMailbox.pull(); // join the blocked pull, not another read
    machine.clock.advance(5_001);
    jest.advanceTimersByTime(5_001);
    expect(await reply).toBe("not_listed");
    expect(machine.row().state).toBe("expired");
    release.resolve();
    await read;
    expect(machine.row()).toMatchObject({ state: "hold", origin: { admit_no: previous + 1 },
      hold_until: new Date(Date.now() + 10_000).toISOString() });
    expect(devices.openNotices()).toContainEqual(expect.objectContaining({ row: machine.device.id, kind: "admit", no: previous + 1 }));
  } finally {
    release.resolve();
    gate.mockRestore();
    jest.useRealTimers();
  }
});

test("T55/S27: a failed readmission journal keeps the expired row barred from background reads", async () => {
  const machine = await pc();
  const { accountMailbox } = machine.fixture.app.context.services;
  const previous = machine.row().origin.admit_no;
  machine.clock.advance(60 * 86_400_000);
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const append = DeviceJournal.prototype.append;
  const fault = spyOn(DeviceJournal.prototype, "append").mockImplementation(function (this: DeviceJournal, entry, ...rest) {
    if (entry.kind === "admit" && entry.key === machine.device.publicKey) throw new Error("readmission journal unavailable");
    return append.call(this, entry, ...rest);
  });
  try {
    const returning = await relayConnection(machine.fixture, { serverId: machine.serverId });
    await bounded(Promise.race([
      returning.auth(machine.device, [ACCOUNT_OPENS_ALL_FEATURE]).then(() => "authenticated", () => returning.serverError),
      returning.serverError,
    ]));
    expect(accountMailbox.error).toBe("readmission journal unavailable");
  } finally { fault.mockRestore(); }
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  expect(machine.row()).toMatchObject({ state: "expired", origin: { admit_no: previous } });
});
