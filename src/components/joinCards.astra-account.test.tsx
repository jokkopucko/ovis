import { afterEach, beforeEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { AccountService } from "../lib/account/service.ts";
import { memoryAccountStore, memoryLock } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AccountJoinRequests } from "./AccountJoinRequests.tsx";

let page: Page;
const browserGlobals = ["Event", "CustomEvent"] as const;
const savedBrowserGlobals = new Map(browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
beforeEach(() => {
  page = openPage("https://app.ovis.sh/");
  for (const key of browserGlobals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page.window[key] });
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(async () => {
  await page.close();
  for (const [key, descriptor] of savedBrowserGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

async function setup() {
  const account = "acct_1";
  const fake = new FakeAccountService();
  fake.opensAll = true;
  fake.completions = true;
  const store = memoryAccountStore();
  await store.set("session", { account, service: "https://account.ovis.sh", provider: "github", access_token: fake.issueToken(account, { twoStep: true }), refresh_token: "refresh", expires_at: Date.now() + 3_600_000 });
  const service = new AccountService({ store, lock: memoryLock(), fetch: fake.fetch });
  const { publicKey } = generateKeyPair();
  const serverId = deriveServerId(publicKey);
  const list = () => service.putPc(serverId, { label: "Desk", relay: "wss://relay.ovis.sh", public_key: bytesToHex(publicKey) });
  await list();
  await page.render(createElement(SettingsProvider, { children: createElement(AccountJoinRequests, { service, devices: async () => [] }) }));
  const cards = () => page.container.querySelectorAll(`[data-join-request="${serverId}"]`).length;
  expect(cards()).toBe(1);
  const decline = async () => { await act(async () => { [...page.container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Decline")!.click(); }); };
  return { service, list, serverId, decline, cards };
}

test("an already open approving page shows an explicit new request after declining the old one", async () => {
  const { list, decline, cards, service } = await setup();
  await decline();
  expect(await service.listPcs()).toHaveLength(0);
  expect(cards()).toBe(0);
  await list();
  await act(async () => { page.window.dispatchEvent(new page.window.Event("focus")); });
  expect(await service.listPcs()).toHaveLength(1);
  expect(cards(), "cards for the new request after refocus").toBe(1);
});

test("declining a stale request does not remove a PC another window already admitted", async () => {
  const { decline, cards, service, serverId } = await setup();
  await service.admitPc(serverId);
  expect((await service.listPcs())[0]?.admitted_at).toEqual(expect.any(String));
  expect(cards()).toBe(1);
  await decline();
  expect((await service.listPcs()).length, "admitted PCs left after a stale Decline").toBe(1);
});
