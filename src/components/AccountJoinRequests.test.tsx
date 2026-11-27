import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { FakeAccountService, WEB_REDIRECT } from "../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { keepShellAccount } from "../lib/account/hostedSignIn.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountService } from "../lib/account/service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "../lib/account/signin.ts";
import { memoryAccountStore, memoryLock, type AccountStore } from "../lib/account/store.ts";
import type { AccountList } from "../lib/account/accountList.ts";
import type { RelayDevice } from "../lib/relay/device.ts";
import { SettingsProvider } from "../lib/settings.ts";

const { AccountJoinRequests } = await import("./AccountJoinRequests.tsx");
type ListAdds = Awaited<ReturnType<NonNullable<Parameters<typeof AccountJoinRequests>[0]["listOf"]>>>;

const ORIGIN = "https://account.ovis.sh";
const ACCOUNT = "acct_owner";
const MINUTE = 60_000;
const desk = generateKeyPair().publicKey;
const mac = generateKeyPair().publicKey;
const DESK = deriveServerId(desk);
const MAC = deriveServerId(mac);

const globals = new Map<string, PropertyDescriptor | undefined>();
let page: Page;
let now = Date.now();
let fake: FakeAccountService;
let store: AccountStore;
let service: AccountService;
let paired: RelayDevice[] = [];
let opened: string[] = [];
/** what this phone knows of the account's signed list (AccountJoinRequests `listOf`): null, none (the default) */
let lists: ListAdds = null;

const buttons = (): string[] => [...page.window.document.body.querySelectorAll("button")].map((node) => node.textContent.trim());
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const text = (): string => [...document.body.querySelectorAll("div")]
  .filter((node) => node !== page.container).map((node) => node.textContent).join(" ");
const press = async (label: string): Promise<void> => {
  const found = [...page.window.document.body.querySelectorAll("button")].filter((node) => node.textContent.trim() === label);
  if (found.length !== 1) throw new Error(`${found.length} buttons say ${label}`);
  await act(async () => { found[0]!.click(); });
  await settle();
};

async function signIn(): Promise<void> {
  const start = await beginSignIn("github", { store, service: ORIGIN, redirectUri: WEB_REDIRECT });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  await finishSignIn(returned, { store, fetch: fake.fetch });
}

/** a PC lists itself in the account from its own Settings with an own sign-in: Add this PC to my account */
async function listedByItsOwner(key: Uint8Array, label: string): Promise<void> {
  const token = fake.issueToken(ACCOUNT);
  const response = await fake.fetch(`${ORIGIN}/v1/pcs/${deriveServerId(key)}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label, public_key: Buffer.from(key).toString("hex"), relay: "wss://relay.ovis.sh" }),
  });
  expect(response.ok).toBe(true);
}

async function mount(): Promise<void> {
  await page.render(null);
  await page.render(createElement(SettingsProvider, { children: createElement(AccountJoinRequests, { service, devices: async () => paired, now: () => now, open: (serverId: string) => { opened.push(serverId); }, listOf: async () => lists }) }));
  await settle();
}

beforeEach(async () => {
  page = openPage("https://app.ovis.sh/");
  for (const [name, value] of Object.entries({ Event: page.window.Event, CustomEvent: page.window.CustomEvent, HTMLElement: page.window.HTMLElement, localStorage: page.window.localStorage, sessionStorage: page.window.sessionStorage })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  now = Date.now();
  fake = new FakeAccountService(() => now);
  fake.opensAll = true;
  fake.signInAs("github", ACCOUNT);
  store = memoryAccountStore();
  service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: () => now });
  opened = [];
  lists = null;
  await signIn();
  // the phone is paired with the account's first PC, so a launch goes straight into it
  await listedByItsOwner(desk, "Desk");
  fake.pcs(ACCOUNT)[0]!.last_seen_at = new Date(now).toISOString();
  paired = [{ server_id: DESK, name: "Desk", device_id: "d".repeat(16) } as RelayDevice];
});

afterEach(async () => {
  await page.close();
  for (const [name, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  globals.clear();
});

describe("a PC that asks to join the account, on a signed-in phone", () => {
  describe("on an account that keeps a signed list", () => {
    /** this phone's list, as far as the card asks it: a stand-in that the number dialog asks in vain */
    const list = { writer: () => null, view: () => ({ account: ACCOUNT, status: { at: "off" }, reached: false, devices: [], pcs: [] }), subscribe: () => () => {} } as unknown as AccountList;
    const postOf = (key: Uint8Array) => ({ list: "f".repeat(64), endpoint: Buffer.from(key).toString("hex"), server_id: deriveServerId(key), key: "member-key", enc: "enc-key", card: "card", for: { kind: "add" as const } });

    it("Allow on a PC that posted its keys for the list asks for the number, and never opens the PC's own page", async () => {
      await listedByItsOwner(mac, "hasang-MacBookPro");
      lists = { account: ACCOUNT, list, posts: [postOf(mac)] };
      await mount();
      expect(text()).toContain("\"hasang-MacBookPro\" asks to join your account");
      await press("Allow");
      expect(opened).toEqual([]);
      const dialog = [...page.window.document.body.querySelectorAll('[data-testid="add-pc-number"]')];
      expect(dialog.map((node) => node.getAttribute("data-pc-id"))).toEqual([MAC]);
      // nothing is written to the account by the press: the number, confirmed at the PC, is what adds it
      expect(fake.requests.filter((line) => !line.startsWith("GET ") && !line.startsWith("POST /v1/token"))).toEqual([`PUT /v1/pcs/${DESK}`, `PUT /v1/pcs/${MAC}`]);
    });

    it("drops the number dialog an Allow opened once another account is signed in to here", async () => {
      await listedByItsOwner(mac, "hasang-MacBookPro");
      lists = { account: ACCOUNT, list, posts: [postOf(mac)] };
      await mount();
      await press("Allow");
      const dialogs = () => [...page.window.document.body.querySelectorAll('[data-testid="add-pc-number"]')];
      expect(dialogs()).toHaveLength(1);
      // another tab signs in to another account, which keeps a list of its own with the same PC's post
      const other = "acct_other";
      fake.signInAs("github", other);
      await store.set("session", { ...(await store.get("session"))!, account: other, access_token: fake.issueToken(other) });
      lists = { account: other, list, posts: [postOf(mac)] };
      await act(async () => { page.window.dispatchEvent(new page.window.Event(ACCOUNT_SIGN_OUT_EVENT)); });
      await settle();
      expect(dialogs().length).toBe(0);
    });

    it("shows no card for a PC that posted nothing for the list: no way into the directory's admission alone", async () => {
      await listedByItsOwner(mac, "hasang-MacBookPro");
      lists = { account: ACCOUNT, list, posts: [] };
      await mount();
      expect(text()).not.toContain("hasang-MacBookPro");
      expect(buttons()).toEqual([]);
    });
  });

  it("is shown by the name it gave itself, quoted, with Allow and Decline", async () => {
    await listedByItsOwner(mac, "hasang-MacBookPro");
    await mount();
    expect(text()).toContain("\"hasang-MacBookPro\" asks to join your account");
    expect(buttons()).toEqual(["Allow", "Decline"]);
  });

  it("opens that PC's own page on Allow, where its join takes the number the PC's screen shows", async () => {
    await listedByItsOwner(mac, "hasang-MacBookPro");
    await mount();
    await press("Allow");
    expect(opened).toEqual([MAC]);
    // nothing is written to the account by the press itself: the join on the PC's page is the approval
    expect(fake.requests.filter((line) => !line.startsWith("GET ") && !line.startsWith("POST /v1/token"))).toEqual([`PUT /v1/pcs/${DESK}`, `PUT /v1/pcs/${MAC}`]);
  });

  it("denies that request on Decline: removed from the account for every device, the PC not added, and a new request shows again", async () => {
    await listedByItsOwner(mac, "hasang-MacBookPro");
    await mount();
    await press("Decline");
    expect(fake.requests).toContain(`DELETE /v1/pcs/${MAC}`);
    expect(fake.pcs(ACCOUNT).map((pc) => pc.server_id)).toEqual([DESK]);
    expect(opened).toEqual([]);
    expect(buttons()).toEqual([]);
    // the PC asks again: a new listing from its own Settings
    await listedByItsOwner(mac, "hasang-MacBookPro");
    await mount();
    expect(buttons()).toEqual(["Allow", "Decline"]);
  });

  it("PCR-1: Decline from a sign-in older than ten minutes declines nothing and says to sign in again", async () => {
    now -= 11 * MINUTE;
    await signIn();
    now += 11 * MINUTE;
    await listedByItsOwner(mac, "hasang-MacBookPro");
    await mount();
    await press("Decline");
    expect(text()).toContain("Sign in again to remove it: your sign-in is more than ten minutes old.");
    expect(fake.pcs(ACCOUNT).map((pc) => pc.server_id)).toEqual([DESK, MAC]);
    expect(buttons()).toEqual(["Allow", "Decline"]);
  });

  it("PCR-1: Sign in again after a refused Decline signs in fresh in place and declines that request", async () => {
    now -= 11 * MINUTE;
    await signIn();
    now += 11 * MINUTE;
    await listedByItsOwner(mac, "hasang-MacBookPro");
    keepShellAccount({ signOut() {}, signOutEverywhere: async () => null, leave: async () => ({ left: true, message: null }), deleteAccount: async () => null,
      freshSignIn: async () => { await signIn(); return (await store.get("session")) ?? null; } });
    try {
      await mount();
      await press("Decline");
      await press("Sign in again");
      expect(fake.requests.filter((line) => line === `DELETE /v1/pcs/${MAC}`)).toHaveLength(2);
      expect(fake.pcs(ACCOUNT).map((pc) => pc.server_id)).toEqual([DESK]);
      expect(buttons()).toEqual([]);
    } finally {
      keepShellAccount(null);
    }
  });

  it("account#67: Decline names the listing it showed; one let in meanwhile is not removed, and the card shows the account as it is now", async () => {
    fake.completions = true;
    await listedByItsOwner(mac, "hasang-MacBookPro");
    const shown = fake.pcs(ACCOUNT).find((pc) => pc.server_id === MAC)!.listing_id!;
    const declines: string[] = [];
    // another device lets the PC in after this card's own re-read, just before its removal reaches the service
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "DELETE") {
        declines.push(request.url);
        const pc = fake.pcs(ACCOUNT).find((each) => each.server_id === MAC)!;
        pc.completed_at = pc.last_seen_at = new Date(now).toISOString();
      }
      return fake.fetch(request);
    } });
    await mount();
    await press("Decline");
    expect(declines).toEqual([`${ORIGIN}/v1/pcs/${MAC}?listing_id=${shown}`]);
    // the service's 409 listing_changed removed nothing and is no failure to show: the PCs are read again instead
    expect(fake.pcs(ACCOUNT).map((pc) => pc.server_id)).toEqual([DESK, MAC]);
    expect(fake.requests.lastIndexOf("GET /v1/pcs")).toBeGreaterThan(fake.requests.indexOf(`DELETE /v1/pcs/${MAC}`));
    expect(text()).not.toContain("The request could not be declined.");
    expect(buttons()).toEqual([]);
  });

  it("asks nothing for a PC paired here, one whose request is over ten minutes old, or one that already joined", async () => {
    await listedByItsOwner(mac, "hasang-MacBookPro");
    now += 11 * MINUTE;
    await signIn();
    await mount();
    expect(buttons()).toEqual([]);
    now -= 11 * MINUTE;
    fake.pcs(ACCOUNT).find((pc) => pc.server_id === MAC)!.last_seen_at = new Date(now).toISOString();
    await mount();
    expect(buttons()).toEqual([]);
    fake.pcs(ACCOUNT).find((pc) => pc.server_id === MAC)!.last_seen_at = null;
    paired = [...paired, { server_id: MAC, name: "Mac", device_id: "e".repeat(16) } as RelayDevice];
    await mount();
    expect(buttons()).toEqual([]);
  });
});
