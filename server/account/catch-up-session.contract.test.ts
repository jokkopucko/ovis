import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { FrameType, type MuxFrame, ACCOUNT_OPENS_ALL_FEATURE } from "../../shared/relay-mux.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayAccountFixture, relayConnection } from "../relay/test-helpers.ts";
import { ask } from "./pairing.test-helpers.ts";
import { legacyOrigin } from "./admission-order.ts";
import { PcAccountState } from "./pc-binding.ts";

const ACCOUNT = "acct_1";
const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

/** A PC in ACCOUNT started with a pre-Step-2 or remotely admitted Step-2 member. */
async function startedPc(legacy = false) {
  // the service answers no snapshot yet: the PC's own reads after its start cannot end the wait
  const service = new FakeAccountService();
  const { fixture, member } = await relayAccountFixture("drive", ACCOUNT, {
    accountOpensAll: true, accountService: { url: "https://account.test", fetch: service.fetch },
    prepare: stateDir => {
      const pc = PcAccountState.open(stateDir);
      pc.migrate(ACCOUNT, true);
      if (!legacy) pc.admit("remote", "code", null, Date.now());
    },
    origin: legacy ? legacyOrigin : at => ({ from: "remote", how: "code", by: null, admit_no: 1, at }),
  });
  closes.push(() => fixture.close());
  rotateRelayIdentity(fixture.stateDir);
  const identity = fixture.app.context.services.relay.currentIdentity()!;
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${service.issueToken(ACCOUNT)}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  return { fixture, member, service, serverId: identity.server_id };
}

async function signIn(pc: Awaited<ReturnType<typeof startedPc>>, features: readonly string[]) {
  const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
  let failed: Extract<MuxFrame, { type: typeof FrameType.SESSION_ERROR }>["payload"] | undefined;
  let ok = false;
  link.onFrame = (frame) => {
    if (frame.type === FrameType.SESSION_ERROR) failed = frame.payload;
    if (frame.type === FrameType.AUTH_OK) ok = true;
  };
  await bounded(link.auth(pc.member, features).then(() => undefined, () => undefined));
  return ok ? "ok" : failed;
}

describe("S2-27 a devices.json row not paired at this PC waits for the first whole read after a start (T41, T42)", () => {
  test("P7/S22: a waiting Step 2 row's sign-in reads the ready service before the periodic pull", async () => {
    const pc = await startedPc();
    // Drain the failed startup pull before the service recovers, so it cannot race this sign-in.
    await pc.fixture.app.context.services.accountMailbox.pull();
    pc.service.opensAll = true;
    // No manual read and no timer advance: this attempt must fetch and apply the first whole read itself.
    expect(await signIn(pc, [ACCOUNT_OPENS_ALL_FEATURE])).toBe("ok");
    const link = await relayConnection(pc.fixture, { serverId: pc.serverId });
    await link.auth(pc.member, [ACCOUNT_OPENS_ALL_FEATURE]);
    expect((await ask(link, "/api/account/status")).status).toBe(200);
  });

  test("T41: a remotely admitted Step 2 row is held before a whole read; an old app gets auth_failed", async () => {
    const pc = await startedPc();
    expect(pc.fixture.app.context.services.devices.originOf(pc.member.id)?.from).toBe("remote");
    expect(await signIn(pc, [ACCOUNT_OPENS_ALL_FEATURE])).toEqual({ code: "held", message: "This PC waits for the account's list before letting this device in", hold: { reason: "catching_up" } });
    expect(await signIn(pc, [])).toEqual({ code: "auth_failed", message: "auth_failed" });
    expect(pc.fixture.app.context.services.devices.sessionRow(pc.member.id)).toBeNull();
  });

  test("a legacy credential signs in before a whole read with both old and new clients", async () => {
    const pc = await startedPc(true);
    expect(pc.fixture.app.context.services.devices.originOf(pc.member.id)?.from).toBe("legacy");
    expect(await signIn(pc, [ACCOUNT_OPENS_ALL_FEATURE])).toBe("ok");
    expect(await signIn(pc, [])).toBe("ok");
  });

  test("T42: the first whole read ends the wait for a row the admission guard passes", async () => {
    const pc = await startedPc();
    pc.service.opensAll = true;
    expect(await pc.fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(await signIn(pc, [ACCOUNT_OPENS_ALL_FEATURE])).toBe("ok");
  });

  test("T42: a changed admission decision takes effect at the next whole read", async () => {
    const pc = await startedPc();
    const { devices, accountMailbox } = pc.fixture.app.context.services;
    await accountMailbox.pull();
    pc.service.opensAll = true;
    const frozen = spyOn(devices, "admits").mockReturnValue(false);
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(devices.catchingUp(pc.member.id)).toBe(true);
    frozen.mockRestore();
    expect(devices.catchingUp(pc.member.id)).toBe(true);
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(devices.catchingUp(pc.member.id)).toBe(false);
  });

  test("S22/P7: a legacy member has neither signer nor approval authority until judged", async () => {
    const pc = await startedPc(true);
    const { devices, accountMailbox } = pc.fixture.app.context.services;
    const authority = () => [
      devices.accountSigner(pc.member.publicKey, ACCOUNT)?.id,
      devices.accountSigner(pc.member.publicKey, ACCOUNT, true)?.id,
      devices.isAccountApproverSession(pc.member.id, pc.member.publicKey),
    ];
    expect(authority()).toEqual([undefined, undefined, false]);
    pc.service.opensAll = true;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(authority()).toEqual([pc.member.id, pc.member.id, true]);
  });

  test("S22/P7: a waiting cookie credential has no principal until the whole read", async () => {
    const pc = await startedPc();
    const { devices, accountMailbox } = pc.fixture.app.context.services;
    const cookie = devices.pair(devices.startPairing().code, "Browser", "watch");
    if (!cookie) throw new Error("No paired browser");
    expect(devices.catchingUp(cookie.device.id)).toBe(true);
    expect(devices.match(cookie.token)).toBeNull();
    pc.service.opensAll = true;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(devices.match(cookie.token)).toEqual(cookie.device);
  });
});
