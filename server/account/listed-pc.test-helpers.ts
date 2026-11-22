import { expect } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { accountDeviceId, exportAccountKey } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { relayAccountFixture, relayFixture, type TestClock } from "../relay/test-helpers.ts";

export const ACCOUNT = "acct_1";

export async function registerSnapshotPc(service: FakeAccountService, fixture: { readonly stateDir: string }, identity = rotateRelayIdentity(fixture.stateDir)) {
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  return identity.server_id;
}

/** A PC that can apply its first snapshot once the fixture has established the account binding. */
export function memberSnapshotPc(options: Parameters<typeof relayFixture>[1] = {}) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const fixture = relayFixture(false, { ...options, accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  return { fixture, async firstRead() {
    await registerSnapshotPc(service, fixture);
    expect(await fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  } };
}

/** A bound PC whose whole read has admitted one account row. */
export async function createListedPc(onClose: (close: () => void) => void, clock?: TestClock) {
  const service = new FakeAccountService();
  service.opensAll = true;
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, { accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch } });
  onClose(() => fixture.close());
  const serverId = await registerSnapshotPc(service, fixture);
  const { services } = fixture.app.context;
  if (clock) services.devices.useClock(clock);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = await exportAccountKey(keys.publicKey);
  service.registerDevice(ACCOUNT, spki, "Laptop");
  expect(await services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const device = { keys, publicKey: spki, id: accountDeviceId(serverId, spki) };
  return { fixture, member, device, service, serverId };
}
