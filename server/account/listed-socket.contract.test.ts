import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { accountDeviceId, newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import * as herdr from "../herdr/client.ts";
import { privateStateFs, writePrivateState } from "../private-state.ts";
import { bounded, relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE } from "./account-devices.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0).reverse()) close(); });

async function listedSocketPc() {
  const initial = await createListedPc(close => closes.push(close));
  const { fixture, service, serverId, member } = initial;
  const newer = await phone();
  service.registerDevice(ACCOUNT, newer.spki, "Tablet");
  expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  fixture.app.stop();
  // S2-25 can restore a live registry. S2-29 owns the transition that makes a held row live.
  const path = join(fixture.stateDir, ACCOUNT_DEVICES_FILE);
  const file = parseAccountDevicesFile(JSON.parse(readFileSync(path, "utf8")));
  writePrivateState(path, { ...file, devices: file.devices.map(row => ({ ...row, state: "live", hold_until: null })) });
  const pc = relayFixture(false, { stateDir: fixture.stateDir, accountOpensAll: true,
    accountService: { url: "https://account.test", fetch: service.fetch } });
  closes.push(() => pc.close());
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
    panes: [], agents: [], workspaces: [], tabs: [], layouts: [], version: "fixture", protocol: 22,
  });
  closes.push(() => snapshot.mockRestore());
  const services = pc.app.context.services;
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const device = { id: accountDeviceId(serverId, newer.spki), keys: newer.keys, publicKey: newer.spki };
  return { pc, services, device, older: initial.device, service, member, serverId };
}

test.each(["block", "freeze", "lock", "removal", "failed deny"] as const)(
  "a live listed drive row receives machine events; %s closes its socket with 1008", async change => {
    const { pc, services, device, older, service, member, serverId } = await listedSocketPc();
    const { core, devices, safetyLog, accountMailbox } = services;
    const link = await relayConnection(pc, { serverId, websocket: core.socketHandlers });
    expect((await link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE])).role).toBe("drive");
    const socket = link.openSocket();
    await socket.opened;
    await socket.until(message => message.type === "features");
    socket.send({ type: "machine-events", enabled: true });
    expect((await socket.until(message => message.type === "machine-event")).type).toBe("machine-event");
    switch (change) {
      case "block":
      case "freeze": {
        const target = change === "block" ? device.publicKey : older.publicKey;
        const record = await signSafetyRecord({ v: 1, kind: "block", account: ACCOUNT, target, target_no: change === "block" ? 3 : 2,
          signer: member.publicKey, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, member.keys.privateKey);
        expect(await devices.applyBlock(record, "handed")).toMatchObject({ outcome: "applied" });
        break;
      }
      case "lock":
        expect(safetyLog?.appendLock({ account: ACCOUNT })).toMatchObject({ outcome: "applied" });
        devices.endUnlockedRows();
        break;
      case "removal":
        service.removeDevice(ACCOUNT, device.publicKey);
        expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
        break;
      case "failed deny": {
        const rename = privateStateFs.renameSync;
        const fault = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
          if (String(to).endsWith("/account-removed.json")) throw new Error("evidence unavailable");
          rename(from, to);
        });
        try { expect(() => devices.revoke(member.id)).toThrow("evidence unavailable"); }
        finally { fault.mockRestore(); }
        expect(devices.failsClosed).toBe(true);
        expect(devices.canDrive(device.id)).toBe(false);
        break;
      }
    }
    expect(await bounded(socket.closed)).toMatchObject({ code: 1008 });
    expect(devices.sessionRow(device.id)).toBeNull();
    expect(devices.canDrive(device.id)).toBe(false);
    const retry = await relayConnection(pc, { serverId, websocket: core.socketHandlers });
    expect(await bounded(Promise.race([retry.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]), retry.serverError]))).toBe("auth_failed");
  },
);

test("a held listed device cannot open a drive event stream", async () => {
  const { fixture, device, serverId } = await createListedPc(close => closes.push(close));
  const { devices, core } = fixture.app.context.services;
  expect(devices.has(device.id)).toBe(true);
  expect(devices.canDrive(device.id)).toBe(false);
  const link = await relayConnection(fixture, { serverId, websocket: core.socketHandlers });
  expect(await bounded(Promise.race([link.auth(device, [ACCOUNT_OPENS_ALL_FEATURE]), link.serverError]))).toBe("held");
});
