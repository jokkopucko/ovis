import { describe, expect, it } from "bun:test";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { beginSignIn, finishSignIn, SIGN_IN_MS, signInReturn, takePendingSignIn } from "./signin.ts";
import { memoryAccountStore, type PendingPairing } from "./store.ts";

const SERVICE = "https://account.example";
const offer: RelayOffer = { v: 1, server_id: "a".repeat(32), server_public_key: "key", relay: "wss://relay.example", name: "Desk", code: "123456", admission: 1 };

// The offer a marked pairing scanned rides in the record of the sign-in started for it: only that sign-in's return takes
// it, and it leaves the store with the sign-in however the sign-in ends.
describe("a pairing that waits on a sign-in", () => {
  async function started(now = Date.now) {
    const fake = new FakeAccountService();
    fake.signInAs("github", "acct_1");
    const store = memoryAccountStore();
    const pairing: PendingPairing = { offer, at: 1_000 };
    const url = await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT, now, pairing });
    const state = new URL(url).searchParams.get("state") ?? "";
    const back = async () => signInReturn(new URL((await fake.fetch(url)).headers.get("location") ?? "").hash) ?? { error: "none", state };
    return { fake, store, pairing, state, back };
  }

  it("is kept in that sign-in's record, and nowhere else in the store", async () => {
    const { store, pairing, state } = await started();
    expect((await store.get("pending"))?.[state]?.pairing).toEqual(pairing);
    expect(await store.get("session")).toBeUndefined();
    expect(Object.keys((await store.get("pending")) ?? {})).toEqual([state]);
  });

  it("is gone once the sign-in succeeds", async () => {
    const { fake, store, state, back } = await started();
    await finishSignIn(await back(), { store, fetch: fake.fetch });
    expect((await store.get("pending"))?.[state]).toBeUndefined();
  });

  it("is gone once the sign-in is denied", async () => {
    const { fake, store, state } = await started();
    await expect(finishSignIn({ error: "access_denied", state }, { store, fetch: fake.fetch })).rejects.toMatchObject({ code: "denied" });
    expect((await store.get("pending"))?.[state]).toBeUndefined();
  });

  it("is gone once the sign-in comes back too late", async () => {
    let now = 5_000;
    const { fake, store, state, back } = await started(() => now);
    const returned = await back();
    now += SIGN_IN_MS + 1;
    await expect(finishSignIn(returned, { store, fetch: fake.fetch, now: () => now })).rejects.toMatchObject({ code: "expired" });
    expect((await store.get("pending"))?.[state]).toBeUndefined();
  });

  it("goes with a sign-in that never came back at the next sign-in, once more than 10 minutes old", async () => {
    let now = 5_000;
    const { store, state } = await started(() => now);
    now += SIGN_IN_MS + 1;
    await beginSignIn("github", { store, service: SERVICE, redirectUri: WEB_REDIRECT, now: () => now });
    expect((await store.get("pending"))?.[state]).toBeUndefined();
  });

  it("cannot be taken without that sign-in's state, and only once with it", async () => {
    const { fake, store, pairing, state } = await started();
    expect(await takePendingSignIn(store, "another-state")).toBeUndefined();
    await expect(finishSignIn({ code: "x", state: "another-state" }, { store, fetch: fake.fetch })).rejects.toMatchObject({ code: "no_sign_in" });
    expect((await takePendingSignIn(store, state))?.pairing).toEqual(pairing);
    expect(await takePendingSignIn(store, state)).toBeUndefined();
  });
});
