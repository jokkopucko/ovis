import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { exportAccountKey } from "../../shared/account-records.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { DeviceStore } from "../devices.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { AccountMailbox } from "./mailbox.ts";
import { readSnapshot, type SnapshotPorts, type StagedRead } from "./snapshot-read.ts";

const ACCOUNT = "acct_1";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function spki(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return await exportAccountKey(pair.publicKey);
}

async function setup(opensAll: boolean, devices: number, wired = true) {
  const stateDir = mkdtempSync(join(tmpdir(), "s2-24-fetch-"));
  dirs.push(stateDir);
  const identity = rotateRelayIdentity(stateDir);
  const service = new FakeAccountService();
  service.opensAll = opensAll;
  // the service serves a snapshot only to a PC the account lists
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  for (let index = 0; index < devices; index++) service.registerDevice(ACCOUNT, await spki(), `Device ${index + 1}`);
  const committed: StagedRead[] = [];
  const used = [{ key: await spki(), day: "2026-11-20" }];
  const bodies: Record<string, unknown>[] = [];
  const ports: SnapshotPorts = {
    scope: () => ({ account: ACCOUNT, serverId: identity.server_id, gen: 0, lock: null }),
    lastVersion: () => null,
    knownBlocks: () => new Set(),
    deny: async () => false,
    liftAuthority: async () => false,
    commit: (stage) => { committed.push(stage); return stage.lifts.length; },
    methodsVersion: () => null,
    journalMethod: () => {},
    requestRead: () => {},
  };
  const mailbox = new AccountMailbox({ devices: new DeviceStore(stateDir), identity: () => identity, service: "https://account.test", fetch: async (request: Request) => {
    if (new URL(request.url).pathname === "/v1/pc/snapshot") bodies.push(await request.clone().json() as Record<string, unknown>);
    return await service.fetch(request);
  }, ...(wired ? { snapshot: { account: () => ACCOUNT, ports: () => ports, used: () => used } } : {}) });
  return { service, mailbox, ports, committed, identity, used, bodies };
}

describe("S2-24 the PC reads the account's snapshot with a proof of its relay key (G1)", () => {
  test("G1: a whole read of several pages comes back through the PC's own proof and commits once", async () => {
    const pc = await setup(true, 250);
    const outcome = await readSnapshot((cursor) => pc.mailbox.snapshotPage(ACCOUNT, cursor), pc.ports);
    expect(outcome.committed).toBe(true);
    expect(pc.committed).toHaveLength(1);
    expect(pc.committed[0]!.snapshot.devices.map((device) => device.no)).toEqual(Array.from({ length: 250 }, (_, index) => index + 1));
    expect(pc.committed[0]!.snapshot.server_id).toBe(pc.identity.server_id);
  });

  test("G1: a snapshot the service no longer holds throws the read away", async () => {
    const pc = await setup(true, 150);
    const outcome = await readSnapshot(async (cursor) => {
      if (cursor.page === 1) pc.service.dropSnapshots();
      return await pc.mailbox.snapshotPage(ACCOUNT, cursor);
    }, pc.ports);
    expect(outcome).toEqual({ committed: false, reason: "snapshot_gone", denials: 0 });
    expect(pc.committed).toEqual([]);
  });

  test("G1: a service with the release flag off has no snapshot, so nothing is committed", async () => {
    const pc = await setup(false, 1);
    expect(await readSnapshot((cursor) => pc.mailbox.snapshotPage(ACCOUNT, cursor), pc.ports)).toEqual({ committed: false, reason: "page_failed", denials: 0 });
    expect(pc.committed).toEqual([]);
  });

  test("G1: a mailbox the server gave no snapshot ports (release flag off) never reads a snapshot", async () => {
    const off = await setup(true, 3, false);
    expect(await off.mailbox.readSnapshot()).toBeNull();
    expect(off.service.requests.some((request) => request.includes("/v1/pc/snapshot"))).toBe(false);
    const on = await setup(true, 3);
    expect(await on.mailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(on.committed.map((stage) => stage.snapshot.devices.length)).toEqual([3]);
  });

  test("P9: page 0 of a read carries the days this PC saw keys used, and no later page does", async () => {
    const pc = await setup(true, 150);
    expect(await pc.mailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(pc.bodies.map((body) => body.used ?? null)).toEqual([pc.used, null]);
  });
});
