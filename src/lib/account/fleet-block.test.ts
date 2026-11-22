import { describe, expect, it } from "bun:test";
import { exportAccountKey, newRecordId, verifySafetyRecord } from "../../../shared/account-records.ts";
import type { DeviceNotice } from "../../../shared/account-devices-api.ts";
import { notMeBlocks, sendBlocks, withBlockReceipt, type BlockSend, type FleetBlock } from "./fleet-block.ts";

const P256 = { name: "ECDSA", namedCurve: "P-256" } as const;
async function heldKey(no: number) {
  const pair = await crypto.subtle.generateKey(P256, false, ["sign", "verify"]);
  return { public_spki: await exportAccountKey(pair.publicKey), private_key: pair.privateKey, no };
}

const admitted = (key: string, no: number, row: string | null = "row-1"): DeviceNotice => ({
  seq: 9, id: newRecordId(), at: "2026-11-20T04:00:00.000Z", kind: "admit", how: "list", key, no, row, label: "New phone", by: null, account: "acct_1", open: true, method: "github", two_step: "set",
});

describe("Not me", () => {
  it("T51: one tap signs a block of the named key with this device's own key, even once its row is gone", async () => {
    const own = await heldKey(2);
    const target = await heldKey(7);
    const blocks = await notMeBlocks({ ...admitted(target.public_spki, 7), row: null }, own, { now: () => Date.parse("2026-11-20T04:00:05.000Z") });
    expect(blocks.map((block) => [block.signer, block.signer_no, block.target, block.target_no, block.signed_at])).toEqual([
      [own.public_spki, 2, target.public_spki, 7, "2026-11-20T04:00:05.000Z"],
    ]);
    expect(await verifySafetyRecord(blocks[0]!)).toBe(true);
  });

  it("T51: a notice with no key, or one not newer than this device in the account, signs nothing", async () => {
    const own = await heldKey(8);
    expect(await notMeBlocks({ ...admitted("", 3), key: null, no: null }, own)).toEqual([]);
    expect(await notMeBlocks(admitted((await heldKey(3)).public_spki, 3), own)).toEqual([]);
    expect(await notMeBlocks(admitted(own.public_spki, 8), own)).toEqual([]);
  });
});

describe("each PC's answer to a block", () => {
  const sent = (ids: string[], pcs: string[]): FleetBlock => ({ ids, outcomes: new Map(pcs.map((server_id) => [server_id, { server_id, state: "waiting" as const }])) });
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  const id = "c".repeat(64);

  it("T60: only that PC's own receipt for a block sent marks it done", () => {
    const fleet = sent([id], [A, B]);
    const done = withBlockReceipt(fleet, A, { outcome: "applied", id, n: 3 });
    expect(done.outcomes.get(A)).toEqual({ server_id: A, state: "applied", receipt: { outcome: "applied", id, n: 3 } });
    expect(done.outcomes.get(B)?.state).toBe("waiting");
    expect(withBlockReceipt(fleet, A, { outcome: "applied", id: "d".repeat(64), n: 3 }).outcomes.get(A)?.state).toBe("waiting");
    expect(withBlockReceipt(fleet, A, { outcome: "applied", id }).outcomes.get(A)?.state).toBe("waiting");
  });

  it("T51: a PC that refuses by its own admission order shows its reason and is never done", () => {
    const refused = withBlockReceipt(sent([id], [A]), A, { outcome: "refused", id, reason: "signer_not_older" });
    expect(refused.outcomes.get(A)).toEqual({ server_id: A, state: "refused", receipt: { outcome: "refused", id, reason: "signer_not_older" } });
  });

  it("T60: a repeat answers already_applied and stays done", () => {
    const once = withBlockReceipt(sent([id], [A]), A, { outcome: "applied", id, n: 3 });
    expect(withBlockReceipt(once, A, { outcome: "already_applied", id }).outcomes.get(A)?.state).toBe("already_applied");
  });

  it("T65: a PC with no receipt of its own is never shown done, whatever another PC answered", () => {
    const fleet = withBlockReceipt(sent([id], [A, B]), B, { outcome: "applied", id, n: 1 });
    expect([...fleet.outcomes.values()].filter((outcome) => outcome.state === "applied").map((outcome) => outcome.server_id)).toEqual([B]);
    expect(withBlockReceipt(fleet, "e".repeat(32), { outcome: "applied", id, n: 1 }).outcomes.has("e".repeat(32))).toBe(false);
  });
});

describe("sending a Not me to every PC", () => {
  const A = "a".repeat(32);
  const B = "b".repeat(32);
  const C = "d".repeat(32);
  const block = { id: "c".repeat(64) } as unknown as import("../../../shared/account-records.ts").BlockRecord;

  it("T60: retries a failed proxy and an unrelated receipt using the same signed record", async () => {
    const proxy: string[][] = [];
    const direct: string[][] = [];
    const receipt = { outcome: "applied", id: block.id, n: 1 };
    const result = await sendBlocks([block], {
      tries: 2,
      pcs: new Map([[A, async (records) => {
        direct.push(records.map(({ id }) => id));
        return [{ ...receipt, id: direct.length === 1 ? "e".repeat(64) : block.id }];
      }]]),
      relayed: new Map([[B, async (records) => {
        proxy.push(records.map(({ id }) => id));
        if (proxy.length === 1) throw new Error("Connection lost");
        return [receipt];
      }]]),
      service: async () => {},
    });
    expect({ proxy, direct }).toEqual({ proxy: [[block.id], [block.id]], direct: [[block.id], [block.id]] });
    expect(result.outcomes.get(A)?.state).toBe("applied");
    expect(result.outcomes.get(B)?.state).toBe("waiting");
  });

  it("T60: goes to every PC and the account service at once, and only each PC's own receipt counts", async () => {
    const order: string[] = [];
    let release = () => {};
    const slow = new Promise<void>((resolve) => { release = resolve; });
    const sending = sendBlocks([block], {
      pcs: new Map<string, BlockSend>([
        [A, async () => { order.push("A"); await slow; return [{ outcome: "applied", id: block.id, n: 1 }]; }],
        [B, async () => { order.push("B"); return [{ outcome: "refused", id: block.id, reason: "signer_not_older" }]; }],
      ]),
      service: async () => { order.push("service"); },
    });
    expect(order.sort()).toEqual(["A", "B", "service"]);
    release();
    const fleet = await sending;
    expect(fleet.outcomes.get(A)?.state).toBe("applied");
    expect(fleet.outcomes.get(B)?.state).toBe("refused");
  });

  it("T60, T65: a PC that cannot be reached is retried with the same block and stays not done", async () => {
    const sent: string[] = [];
    const fleet = await sendBlocks([block], { pcs: new Map<string, BlockSend>([[C, async (records) => { sent.push(records[0]!.id); throw new Error("offline"); }]]), service: async () => {}, tries: 2 });
    expect(sent).toEqual([block.id, block.id]);
    expect(fleet.outcomes.get(C)?.state).toBe("unreachable");
  });

  it("T60: a receipt for another block, or none, leaves a PC waiting", async () => {
    const fleet = await sendBlocks([block], { pcs: new Map<string, BlockSend>([[A, async () => [{ outcome: "applied", id: "e".repeat(64), n: 1 }]], [B, async () => []]]), service: async () => {} });
    expect(fleet.outcomes.get(A)?.state).toBe("waiting");
    expect(fleet.outcomes.get(B)?.state).toBe("waiting");
  });
});

describe("which answers count (relay-hub ruling on T60)", () => {
  const block = { id: "c".repeat(64) } as unknown as import("../../../shared/account-records.ts").BlockRecord;
  const applied = async () => [{ outcome: "applied", id: block.id, n: 1 }];

  it("T60: a receipt relayed by another PC's proxy is delivered but stays waiting; over that PC's own channel it is done", async () => {
    const proxied = await sendBlocks([block], { pcs: new Map(), relayed: new Map([["b".repeat(32), applied]]), service: async () => {} });
    expect(proxied.outcomes.get("b".repeat(32))?.state).toBe("waiting");
    const own = await sendBlocks([block], { pcs: new Map([["b".repeat(32), applied]]), service: async () => {} });
    expect(own.outcomes.get("b".repeat(32))?.state).toBe("applied");
  });

  it("T60: a PC reached both ways is done only by its own channel's receipt", async () => {
    const both = await sendBlocks([block], { pcs: new Map([["b".repeat(32), async () => []]]), relayed: new Map([["b".repeat(32), applied]]), service: async () => {} });
    expect(both.outcomes.get("b".repeat(32))?.state).toBe("waiting");
  });
});
