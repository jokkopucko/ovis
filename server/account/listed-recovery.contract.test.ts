import { expect, spyOn, test } from "bun:test";
import { newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { bounded, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { STALE_READ_MS } from "./account-devices.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { askRecovery } from "./recovery.ts";

for (const reason of ["join_hold", "notice_open", "frozen", "blocked", "removed"] as const) {
  test.skipIf(process.platform === "win32")(`T70: recovery refuses a listed row that is ${reason}`, async () => {
    const clock = new TestClock();
    const closes: (() => void)[] = [];
    const epoch = Date.now();
    const time = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
    try {
      const { fixture, device, member, service } = await createListedPc(close => closes.push(close), clock);
      const { devices, safetyLog, accountMailbox, recoveryReleases } = fixture.app.context.services;
      const notice = devices.openNotices().find(entry => entry.row === device.id);
      if (!notice) throw new Error("Missing list admission notice");
      if (reason !== "notice_open") devices.decideNotice(notice.id);
      if (reason !== "join_hold") {
        clock.advance(JOIN_HOLD_MS);
        expect(devices.canDrive(device.id)).toBe(true);
      }
      clock.advance(STALE_READ_MS);
      switch (reason) {
        case "join_hold": case "notice_open": break;
        case "frozen":
          expect(safetyLog?.append({ record: { v: 1, kind: "freeze", id: `f:${"a".repeat(64)}`, target: device.publicKey,
            account: ACCOUNT, after: 1, signer: "service", signed_at: new Date().toISOString(), signature: "" }, got: "snapshot" }).outcome).toBe("applied");
          break;
        case "blocked": {
          const block = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target: device.publicKey, target_no: 2,
            signer: member.publicKey, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
          if (block.kind !== "block") throw new Error("Expected a signed block");
          expect((await devices.applyBlock(block, "handed")).outcome).toBe("applied");
          break;
        }
        case "removed":
          service.removeDevice(ACCOUNT, device.publicKey);
          expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
          break;
      }
      const expected = reason === "removed" || reason === "blocked" ? `${device.id} does not wait here` : `${device.id} cannot be released: ${reason}`;
      expect(await askRecovery(fixture.stateDir, { act: "release", rows: [device.id] })).toEqual({ error: expected });
      expect(recoveryReleases?.releaseOf(device.id)).toBeNull();
      expect(devices.canDrive(device.id)).toBe(false);
    } finally {
      for (const close of closes) close();
      time.mockRestore();
    }
  });
}

test.skipIf(process.platform === "win32")("T70: local release opens a waiting account row until undo or a whole read", async () => {
  const clock = new TestClock();
  const epoch = Date.now();
  const time = spyOn(Date, "now").mockImplementation(() => epoch + clock.now());
  const closes: (() => void)[] = [];
  try {
    const { fixture, service, serverId, device } = await createListedPc(close => closes.push(close), clock);
    const { devices, accountMailbox } = fixture.app.context.services;
    const notice = devices.openNotices().find(entry => entry.row === device.id);
    if (!notice) throw new Error("Missing list admission notice");
    devices.decideNotice(notice.id);
    clock.advance(JOIN_HOLD_MS);
    const connect = () => relayConnection(fixture, { serverId });
    const live = await connect();
    expect((await live.auth(device, [ACCOUNT_OPENS_ALL_FEATURE])).role).toBe("drive");
    service.opensAll = false;
    clock.advance(STALE_READ_MS);
    expect(await bounded(live.serverError)).toBe("auth_changed");
    const release = () => askRecovery(fixture.stateDir, { act: "release", rows: [device.id] });
    expect(await release()).toEqual({ released: [device.id] });
    const released = await connect();
    expect((await released.auth(device, [ACCOUNT_OPENS_ALL_FEATURE])).role).toBe("drive");
    await askRecovery(fixture.stateDir, { act: "undo", rows: [device.id] });
    expect(await bounded(released.serverError)).toBe("auth_changed");
    expect(devices.canDrive(device.id)).toBe(false);

    expect(await release()).toEqual({ released: [device.id] });
    service.removeDevice(ACCOUNT, device.publicKey);
    service.opensAll = true;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(devices.has(device.id)).toBe(false);
    expect(fixture.app.context.services.recoveryReleases?.releaseOf(device.id)).toBeNull();
  } finally {
    for (const close of closes) close();
    time.mockRestore();
  }
});
