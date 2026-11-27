/**
 * Independent adversarial review of P8, the window's half (feat/account-list-ssh-app f0cbec794), written as if it lived
 * in src/lib/account/ beside sshAdd.test.ts, whose window stand-in it copies. The finding test FAILS on f0cbec794; the pin
 * passes there.
 */
import { describe, expect, it } from "bun:test";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import type { AccountAddTarget } from "../../../shared/machines.ts";
import { exportPublicKey, generateKeyPair, importPublicKey } from "../../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { readSeenPcs } from "./seenPcs.ts";
import { AccountService } from "./service.ts";
import { addOverSsh, type SshTake } from "./sshAdd.ts";
import { memoryAccountStore } from "./store.ts";

const ACCOUNT = "acct_1";
const SERVICE = "https://account.test";

function pcFields(account: string | null = null): AccountAddTarget {
  const key = generateKeyPair().publicKey;
  return { server_id: deriveServerId(key), public_key: exportPublicKey(key), relay: "wss://relay.example", label: "nuc", account };
}

async function window() {
  const fake = new FakeAccountService();
  fake.opensAll = true;
  const store = memoryAccountStore();
  await store.set("session", { service: SERVICE, account: ACCOUNT, provider: "google", access_token: fake.issueToken(ACCOUNT, { twoStep: true }), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const service = new AccountService({ store, fetch: fake.fetch });
  const own = generateKeyPair().publicKey;
  await service.putPc(deriveServerId(own), { label: "desk", public_key: Array.from(own, (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  return { service };
}

/** Runs `body` with a localStorage of its own, as the window's record of its PCs is kept in. */
async function withStorage<T>(body: () => Promise<T>): Promise<T> {
  const kept = new Map<string, string>();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); } } });
  try { return await body(); }
  finally { if (saved) Object.defineProperty(globalThis, "localStorage", saved); else Reflect.deleteProperty(globalThis, "localStorage"); }
}

const endpointOf = (target: AccountAddTarget): string => Array.from(importPublicKey(target.public_key), (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("P8 review, the window's record of an add over SSH by the account's list", () => {
  // finding L3 (LOW). The window writes `how: "ssh"` once the account service admitted the PC, before this PC's take. On
  // an account that keeps a list, the admit is only the second lock's listing: the add is the `pc` entry this PC signs,
  // and `list_cannot_add` / `that_pc_old` / `list_not_added` say that no entry went in. V4-3's addendum: a row never moves
  // to a stronger value without the act that earns it. (On a list-free account the base pins the record on the admit,
  // "whatever the hand-over then finds of the PC's relay", deliberately; this is about the list's refusals only.)
  for (const refused of ["list_cannot_add", "that_pc_old", "list_not_added"] as const) {
    it(`finding L3: no ssh row for a PC the add by the list ended ${refused} for`, async () => {
      const { service } = await window();
      const target = pcFields();
      const outcome = await withStorage(async () => {
        const said = await addOverSsh(service, { id: "job-1", account_add: target }, { account: ACCOUNT, running: () => true, take: async (): Promise<SshTake> => ({ refused }) });
        // the record is written, when at all, before addOverSsh answers (since the round that fixed L3): nothing to wait for
        return { said, row: readSeenPcs(ACCOUNT).pcs[endpointOf(target)] };
      });
      expect(outcome.said).not.toBe("added");
      expect(outcome.row?.how).not.toBe("ssh");
    });
  }

  it("pin: the two list refusals the step names have words of their own, and no refusal is shown as added", async () => {
    const said: Record<string, string> = {};
    for (const refused of ["list_cannot_add", "that_pc_old", "list_not_added", "other_adder", "take_unanswered"]) {
      // a window of its own each: one account's service admits only so many PCs in a row
      const { service } = await window();
      said[refused] = await withStorage(() => addOverSsh(service, { id: "job-1", account_add: pcFields() }, { account: ACCOUNT, running: () => true, take: async (): Promise<SshTake> => ({ refused }) }));
    }
    expect([said.list_cannot_add, said.that_pc_old]).toEqual(["list-cannot-add", "update-that-pc"]);
    for (const outcome of Object.values(said)) expect(["added", "already", "added-unchecked", "already-unchecked", "added-unanswered", "already-unanswered"]).not.toContain(outcome);
  });
});
