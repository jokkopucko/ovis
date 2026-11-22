import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountDeviceId } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { parseAccountDevicesFile } from "../../shared/account-snapshot.ts";
import { ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { writePrivateState } from "../private-state.ts";
import { relayConnection, relayFixture } from "../relay/test-helpers.ts";
import { ACCOUNT_DEVICES_FILE, ACCOUNT_DEVICES_MAX } from "./account-devices.ts";
import { ADMISSION_FILE } from "./admission-order.ts";
import { ACCOUNT, registerSnapshotPc } from "./listed-pc.test-helpers.ts";
import { phone } from "./pairing.test-helpers.ts";

test("T55/S27: a new key at capacity does not prevent a later replacement", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "s2-28-full-"));
  const service = new FakeAccountService();
  service.opensAll = true;
  let fixture: ReturnType<typeof relayFixture> | undefined;
  try {
    const serverId = await registerSnapshotPc(service, { stateDir });
    const extra = await phone();
    service.registerDevice(ACCOUNT, extra.spki, "Not stored");
    const target = await phone();
    const others = await Promise.all(Array.from({ length: ACCOUNT_DEVICES_MAX - 1 }, () => phone()));
    const at = "2025-01-01T00:00:00.000Z";
    const rows = [...others, target].map(({ spki: key }, i) => ({
      id: accountDeviceId(serverId, key), key, no: service.registerDevice(ACCOUNT, key, "Stored"), label: "Stored",
      origin: { from: "remote", how: "list", by: null, admit_no: i + 1, at },
      confirmed_at: at, last_signin_day: null, state: "expired", hold_until: null,
    }));
    const registry = join(stateDir, ACCOUNT_DEVICES_FILE);
    writePrivateState(registry, { v: 1, account: ACCOUNT, server_id: serverId, snapshot: "1".repeat(32), version: 1, devices: rows });
    writePrivateState(join(stateDir, ADMISSION_FILE), { v: 1, binding: { account: ACCOUNT, bind_id: "2".repeat(32) },
      first: null, others_ever: true, clears: [], gen: 0, next_admit: ACCOUNT_DEVICES_MAX + 1 });
    fixture = relayFixture(false, { stateDir, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
    await fixture.app.context.services.accountMailbox.pull();
    const link = await relayConnection(fixture, { serverId });
    const id = accountDeviceId(serverId, target.spki);
    const reply = await link.auth({ keys: target.keys, publicKey: target.spki, id }, [ACCOUNT_OPENS_ALL_FEATURE])
      .then(() => "authenticated", () => link.serverError);

    expect(reply).toBe("held");
    const stored = parseAccountDevicesFile(JSON.parse(readFileSync(registry, "utf8"))).devices;
    expect(stored).toHaveLength(ACCOUNT_DEVICES_MAX);
    expect(stored.some(row => row.key === extra.spki)).toBe(false);
    expect(stored.find(row => row.id === id)).toMatchObject({ state: "hold", origin: { admit_no: ACCOUNT_DEVICES_MAX + 1 } });
  } finally {
    if (fixture) fixture.close();
    else rmSync(stateDir, { recursive: true, force: true });
  }
});
