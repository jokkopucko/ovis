import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { FakeAccountService, PC_NEW_MS, WEB_REDIRECT } from "../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { isNewAccountPc, type MyPc } from "../lib/account/myPcs.ts";
import { newPcNoticeKey } from "../lib/account/newPcNotice.ts";
import { accountList } from "../lib/account/accountList.ts";
import { askingPc, pcComparing, postPcKeys } from "../lib/account/accountList.test-helpers.ts";
import { listView, signCard } from "../../shared/account-list.ts";
import { readJoinLine } from "../../shared/account-list-join.ts";
import { makeInvite } from "../lib/account/listInvite.ts";
import { memoryListLock, memoryListStore } from "../lib/account/listStore.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { AccountService } from "../lib/account/service.ts";
import type { AccountOs } from "../../shared/account-asker.ts";
import { beginSignIn, finishSignIn, signInReturn } from "../lib/account/signin.ts";
import { memoryAccountStore, memoryLock, newKey, type AccountProvider, type AccountStore } from "../lib/account/store.ts";
import { accountOpenablePcs } from "../lib/relay/pcPick.ts";
import { readSeenPcs } from "../lib/account/seenPcs.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { keepShellAccount } from "../lib/account/hostedSignIn.ts";
import { translate } from "../lib/i18n.ts";
import { invitedTitle, UnconfirmedPcNotices } from "./UnconfirmedPcNotices.tsx";

const ORIGIN = "https://account.ovis.sh";
const ACCOUNT = "acct_owner";
const LABEL = "devswha-ThinkStation-P620";
const key = generateKeyPair().publicKey;
const PC = deriveServerId(key);
const MINUTE = 60_000;

const globals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let now = Date.now();
let fake: FakeAccountService;
let store: AccountStore;
let service: AccountService;
let signInsAgain: AccountProvider[] = [];

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map((node) => textOf(node).trim());
const press = async (label: string): Promise<void> => {
  const found = renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === label);
  if (found.length !== 1) throw new Error(`${found.length} buttons say ${label}`);
  await act(async () => { await found[0]!.props.onClick(); });
  await until(cardsIdle, "the card's press is done");
};
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
/** settles until `done` holds: a press's work (signing, the list's write) takes as many turns as the machine's load makes it */
const until = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  for (await settle(); !done(); await settle()) if (Date.now() > deadline) throw new Error(`still not so after 10 s: ${what}`);
};
/** a card's buttons are disabled while a press of it is at work */
const cardsIdle = (): boolean => renderer!.root.findAll((card) => card.props["data-unconfirmed-pc"] !== undefined)
  .every((card) => card.findAll((node) => node.type === "button" && node.props.disabled === true).length === 0);
const text = (): string => renderer === undefined ? "" : renderer.root.findAll((node) => node.type === "div").map(textOf).join(" ");
/** the one-press admissions this device asked the account service for, for the PC on the card */
const admits = (): number => fake.requests.filter((line) => line === `POST /v1/pcs/${PC}/admit`).length;

async function signIn(provider: AccountProvider = "github"): Promise<void> {
  fake.signInAs(provider, ACCOUNT);
  const start = await beginSignIn(provider, { store, service: ORIGIN, redirectUri: WEB_REDIRECT, now: () => now });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  await finishSignIn(returned, { store, fetch: fake.fetch, now: () => now });
}

/** the key this sign-in registered with the account service, kept as signInKey.ts keeps it */
async function registerKey(): Promise<void> {
  const session = (await store.get("session"))!;
  const made = await newKey();
  const no = fake.registerSessionKey(session.access_token, made.public_spki, "Phone");
  await store.set("signin_key", { account: ACCOUNT, sign_in_id: session.sign_in_id!, key: made, no });
}

/** a PC types its device code into the owner's account and lists itself: unconfirmed (PCL-1), naming its system when `os` is given */
async function listedByDeviceCode(os?: AccountOs): Promise<void> {
  const token = fake.issueToken(ACCOUNT, { device: true });
  const response = await fake.fetch(`${ORIGIN}/v1/pcs/${PC}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label: LABEL, public_key: Buffer.from(key).toString("hex"), relay: "wss://relay.ovis.sh", ...(os === undefined ? {} : { os }) }),
  });
  expect(response.ok).toBe(true);
}

const challenges = (): number => fake.requests.filter((line) => line === "POST /v1/pcs/challenge").length;

/** another PC the account already has, listed by an own sign-in: the account is no longer never-used */
async function listedByItsOwnSignIn(): Promise<void> {
  const other = generateKeyPair().publicKey;
  const token = fake.issueToken(ACCOUNT);
  const response = await fake.fetch(`${ORIGIN}/v1/pcs/${deriveServerId(other)}`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label: "Desk", public_key: Buffer.from(other).toString("hex"), relay: "wss://relay.ovis.sh" }),
  });
  expect(response.ok).toBe(true);
}

async function mount(more: { numberWaitMs?: number } = {}): Promise<void> {
  if (renderer !== undefined) await act(async () => { renderer!.unmount(); });
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(UnconfirmedPcNotices, { service, now: () => now, onSignInAgain: (provider: AccountProvider) => { signInsAgain.push(provider); }, ...more }) }));
  });
  await settle();
}

beforeEach(async () => {
  const events = new EventTarget();
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  const storage = (map: Map<string, string>) => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); } });
  for (const [name, value] of Object.entries({
    window: Object.assign(events, { location: new URL("https://app.ovis.sh/"), localStorage: storage(local), sessionStorage: storage(session) }),
    IS_REACT_ACT_ENVIRONMENT: true,
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"] },
    localStorage: storage(local),
    sessionStorage: storage(session),
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  now = Date.now();
  fake = new FakeAccountService(() => now);
  fake.opensAll = true;
  fake.signInAs("github", ACCOUNT);
  store = memoryAccountStore();
  service = new AccountService({ store, fetch: fake.fetch, lock: memoryLock(), now: () => now });
  signInsAgain = [];
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [name, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  globals.clear();
});

describe("a PC the account lists unconfirmed", () => {
  it("is named only by the name it gave itself, quoted, with when and why, and offers Add and No under ten minutes", async () => {
    await signIn();
    await listedByDeviceCode();
    await mount();
    expect(text()).toContain(`Name the PC gave itself: "${LABEL}"`);
    expect(text()).toContain("A PC was added to your account with a sign-in code at ");
    expect(text()).toContain("Add it only if you started adding that PC yourself and entered the code it showed. If someone else gave you the code, or you did not start this, press No.");
    // the label is never said as a fact: only inside its quotes
    expect(text().split(`"${LABEL}"`).join("")).not.toContain(LABEL);
    expect(buttons()).toEqual(["Add", "No"]);
  });

  it("says the request ran out once the listing is older than ten minutes, and offers only No, which removes it", async () => {
    await listedByDeviceCode();
    now += 11 * MINUTE;
    await signIn();
    await mount();
    expect(text()).toContain(`Name the PC gave itself: "${LABEL}"`);
    expect(text()).toContain("This request ran out. To add this PC, start again on the PC.");
    expect(text()).not.toContain("Add this PC to your account?");
    expect(buttons()).toEqual(["No"]);
    await press("No");
    expect(fake.requests).toContain(`DELETE /v1/pcs/${PC}`);
    expect(fake.pcs(ACCOUNT)).toEqual([]);
  });

  it("says who is asking under the PC's name, the system and the place the account service saw, and the time left", async () => {
    fake.requestPlace = { country: "KR", city: "Seoul" };
    await signIn();
    await listedByDeviceCode("linux");
    now += 3 * MINUTE + 10_000;
    await mount();
    expect(text()).toContain(`Name the PC gave itself: "${LABEL}"Linux · Seoul, South Korea`);
    expect(text()).toContain("Expires in 7 min");
    expect(buttons()).toEqual(["Add", "No"]);
  });

  it("names only what the account service knows of who is asking, and nothing when it knows nothing", async () => {
    await signIn();
    await listedByDeviceCode("macos");
    await mount();
    expect(text()).toContain(`"${LABEL}"macOS`);
    expect(text()).not.toContain("macOS ·");
    fake.pcAddProofs = false;
    await mount();
    expect(text()).not.toContain("macOS");
    expect(text()).not.toContain("Expires in");
  });

  for (const [what, setUp] of [
    ["one a sign-in code listed while Step 2 was off (asking_until null: no window applies, and it may be a PC in use)", () => { fake.opensAll = false; }],
    ["one from an account service that names no window (no asking_until)", () => { fake.pcAddProofs = false; }],
  ] as const) {
    it(`keeps the card as it was for ${what}: Add and No for ten minutes, then Remove from my account, never that a request ran out`, async () => {
      await signIn();
      setUp();
      await listedByDeviceCode();
      fake.opensAll = true;
      await mount();
      expect(buttons()).toEqual(["Add", "No"]);
      expect(text()).not.toContain("Expires in");
      now += 11 * MINUTE;
      await mount();
      expect(buttons()).toEqual(["Remove from my account"]);
      expect(text()).not.toContain("This request ran out");
      expect(text()).toContain(`Name the PC gave itself: "${LABEL}"`);
    });
  }

  it("never says more than ten minutes are left, whatever the two clocks say", async () => {
    await signIn();
    await listedByDeviceCode();
    // the account service's clock runs three minutes ahead of this device's
    const row = fake.pcs(ACCOUNT)[0]!;
    row.added_at = new Date(now + 3 * MINUTE).toISOString();
    row.asking_since = now + 3 * MINUTE;
    await mount();
    expect(text()).toContain("Expires in 10 min");
  });

  it("shows the name the PC gave itself as one plain line, with no bidi controls", async () => {
    await signIn();
    const token = fake.issueToken(ACCOUNT, { device: true });
    const response = await fake.fetch(`${ORIGIN}/v1/pcs/${PC}`, {
      method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ label: "desk\u202etxt.exe", public_key: Buffer.from(key).toString("hex"), relay: "wss://relay.ovis.sh" }),
    });
    expect(response.ok).toBe(true);
    await mount();
    expect(text()).toContain('Name the PC gave itself: "desktxt.exe"');
  });

  it("goes by the account service's own window: past its asking_until the request ran out, whatever this device's clock says of the listing", async () => {
    await signIn();
    await listedByDeviceCode();
    // the listing's window runs from the sign-in that made it; here that sign-in was made five minutes before it listed
    fake.pcs(ACCOUNT)[0]!.asking_since = now - 5 * MINUTE;
    now += 6 * MINUTE;
    await mount();
    expect(text()).toContain("This request ran out. To add this PC, start again on the PC.");
    expect(buttons()).toEqual(["No"]);
  });

  it("turns to the request ran out when the account service answers listing_expired to Add", async () => {
    await signIn();
    await listedByDeviceCode();
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/admit")) return Response.json({ error: { code: "listing_expired", message: "x" } }, { status: 409 });
      return fake.fetch(request);
    } });
    await mount();
    await press("Add");
    expect(text()).toContain("This request ran out. To add this PC, start again on the PC.");
    expect(text()).not.toContain("The PC could not be added.");
    expect(buttons()).toEqual(["No"]);
  });

  it("reads the listing again when the account service answers listing_changed to Add, and shows the one there now", async () => {
    await signIn();
    await listedByDeviceCode();
    let refuse = true;
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (refuse && new URL(request.url).pathname.endsWith("/admit")) {
        refuse = false;
        return Response.json({ error: { code: "listing_changed", message: "x" } }, { status: 409 });
      }
      return fake.fetch(request);
    } });
    await mount();
    const reads = fake.requests.filter((line) => line === "GET /v1/pcs").length;
    await press("Add");
    expect(fake.requests.filter((line) => line === "GET /v1/pcs").length).toBeGreaterThan(reads + 1);
    expect(text()).not.toContain("The PC could not be added.");
    expect(buttons()).toEqual(["Add", "No"]);
  });

  it("an own sign-in made days ago adds the PC with its registered key in one press: no Sign in again", async () => {
    await signIn();
    await registerKey();
    now += 3 * 24 * 60 * MINUTE;
    await listedByDeviceCode();
    await mount();
    await press("Add");
    expect(admits()).toBe(1);
    expect(challenges()).toBe(1);
    expect(text()).not.toContain("Sign in again");
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(false);
    expect(text()).toContain(`New PC added to your account: ${LABEL}`);
  });

  it("a fresh sign-in adds as before: no challenge is asked", async () => {
    await signIn();
    await registerKey();
    await listedByDeviceCode();
    await mount();
    await press("Add");
    expect(admits()).toBe(1);
    expect(challenges()).toBe(0);
    expect(text()).toContain(`New PC added to your account: ${LABEL}`);
  });

  it("with an account service from before key proofs, an old sign-in with a key still gets Sign in again, asked once", async () => {
    fake.pcAddProofs = false;
    await signIn();
    await registerKey();
    now += 3 * 24 * 60 * MINUTE;
    await listedByDeviceCode();
    await mount();
    await press("Add");
    expect(text()).toContain("Sign in again to add it: your sign-in is more than ten minutes old.");
    expect(buttons()).toContain("Sign in again");
    expect(admits()).toBe(1);
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
  });

  it("an own sign-in of any age says No: the listing goes, with no Sign in again", async () => {
    await signIn();
    now += 3 * 24 * 60 * MINUTE;
    await listedByDeviceCode();
    await mount();
    await press("No");
    expect(text()).not.toContain("Sign in again");
    expect(fake.pcs(ACCOUNT)).toEqual([]);
  });

it("PCR-1: with an account service from before, a removal from a sign-in older than ten minutes removes nothing, and says to sign in again", async () => {
    fake.pcAddProofs = false;
    await listedByDeviceCode();
    await signIn();
    now += 11 * MINUTE;
    await mount();
    await press("Remove from my account");
    expect(text()).toContain("Sign in again to remove it: your sign-in is more than ten minutes old.");
    expect(fake.pcs(ACCOUNT)).toHaveLength(1);
    // no sign-in in place here (no app, no PC window, no hosted shell): nothing to press but the removal again
    expect(buttons()).toEqual(["Remove from my account"]);
  });

  it("PCR-1: with an account service from before, Sign in again signs in fresh in place and removes the same PC", async () => {
    fake.pcAddProofs = false;
    await listedByDeviceCode();
    await signIn();
    now += 11 * MINUTE;
    keepShellAccount({ signOut() {}, signOutEverywhere: async () => null, leave: async () => ({ left: true, message: null }), deleteAccount: async () => null,
      freshSignIn: async () => { await signIn(); return (await store.get("session")) ?? null; } });
    try {
      await mount();
      await press("Remove from my account");
      expect(fake.pcs(ACCOUNT)).toHaveLength(1);
      await press("Sign in again");
      expect(fake.requests.filter((request) => request === `DELETE /v1/pcs/${PC}`)).toHaveLength(2);
      expect(fake.pcs(ACCOUNT)).toEqual([]);
    } finally {
      keepShellAccount(null);
    }
  });

  it("admits the PC with this own sign-in on Add: listed as the account's, new for 24 hours, told as new, and never opened by itself", async () => {
    await signIn();
    await listedByDeviceCode();
    await mount();
    let changed = 0;
    window.addEventListener("ovis:account-pcs-changed", () => { changed += 1; });
    await press("Add");
    // the account's PCs are read again wherever they are listed (the front page's Your PCs among them)
    expect(changed).toBeGreaterThan(0);
    // the account's admission, which the PC then takes with its own key's proof (ovis add waits for it): no confirm PUT
    expect(admits()).toBe(1);
    expect(fake.requests.filter((line) => line === `PUT /v1/pcs/${PC}`)).toHaveLength(1);
    expect(fake.pcs(ACCOUNT)[0]?.admitted_at).toBe(new Date(now).toISOString());
    const [listed] = await service.forSignIn((await service.session())!).listPcs();
    expect(listed?.server_id).toBe(PC);
    expect(listed?.unconfirmed).toBeUndefined();
    expect(Date.parse(listed!.new_until!)).toBe(now + PC_NEW_MS);
    expect(isNewAccountPc(listed!, now)).toBe(true);
    const row: MyPc = { server_id: PC, name: LABEL, state: "needs-approval", last_seen_at: new Date(now).toISOString(), added_at: listed!.added_at, new_until: listed!.new_until,
      listed: true, paired: false, linked: false, accountOpen: true, join: { server_public_key: "k", relay: "wss://relay.ovis.sh" } };
    expect(accountOpenablePcs([row], { account: ACCOUNT, devices: [], now })).toEqual([]);
    // the new-PC card with its one-tap removal takes the question's place
    expect(text()).toContain(`New PC added to your account: ${LABEL}`);
    expect(buttons()).toContain("I didn't add this");
    expect(buttons()).not.toContain("Add");
    // One press, with no number compared and no QR code scanned, proves nothing about whose PC it is: the account
    // service could have listed a PC of its own at that moment. This device's record of its PCs keeps nothing of it.
    await settle();
    expect(readSeenPcs(ACCOUNT).pcs).toEqual({});
  });

  it("keeps the new-PC card closed under the service's admission time, not this device's clock", async () => {
    await signIn();
    await listedByDeviceCode();
    // the admit's answer takes a second to come back: this device's clock has moved on by then
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const answer = await fake.fetch(request);
      if (new URL(request.url).pathname.endsWith("/admit")) now += 1_000;
      return answer;
    } });
    await mount();
    await press("Add");
    const close = renderer!.root.findAll((node) => node.type === "button" && node.props["aria-label"] === "Close");
    expect(close).toHaveLength(1);
    await act(async () => { close[0]!.props.onClick(); });
    // the directory's own row names the same admission, so the card closed here is closed for it too
    const [row] = await service.forSignIn((await service.session())!).listPcs();
    expect(row?.admitted_at).toBe(new Date(now - 1_000).toISOString());
    expect(localStorage.getItem(newPcNoticeKey(ACCOUNT, row!))).toBe("1");
  });

  it("removes the listing from the account on No and hides it, for good after a reload", async () => {
    await signIn();
    await listedByDeviceCode();
    await mount();
    await press("No");
    expect(fake.requests).toContain(`DELETE /v1/pcs/${PC}`);
    expect(fake.pcs(ACCOUNT)).toEqual([]);
    expect(buttons()).toEqual([]);
    await mount();
    expect(buttons()).toEqual([]);
    expect(text()).not.toContain(LABEL);
  });

  it("says why a sign-in too old cannot add it, signs in again on Sign in again, and adds it after", async () => {
    await signIn();
    now += 11 * MINUTE;
    await listedByDeviceCode();
    await mount();
    await press("Add");
    expect(text()).toContain("Sign in again to add it: your sign-in is more than ten minutes old.");
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
    // asked once, and refused
    expect(admits()).toBe(1);
    await press("Sign in again");
    expect(signInsAgain).toEqual(["github"]);
    // the sign-in comes back as a page load: the add it was for goes on by itself, once
    await signIn();
    await mount();
    expect(admits()).toBe(2);
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(false);
    expect(text()).toContain(`New PC added to your account: ${LABEL}`);
    await mount();
    expect(admits()).toBe(2);
  });

  it("admits the PC for a sign-in without two-step in a used account (a Google sign-in never says): Add is offered from the start", async () => {
    await signIn("google");
    await listedByItsOwnSignIn();
    await listedByDeviceCode();
    await mount();
    expect(buttons()).toEqual(["Add", "No"]);
    expect(text()).toContain("Add this PC to your account?");
    expect(text()).not.toContain("two-step");
    await press("Add");
    expect(admits()).toBe(1);
    expect(fake.pcs(ACCOUNT).find((pc) => pc.server_id === PC)?.listed_by_device).toBe(false);
    expect(text()).toContain(`New PC added to your account: ${LABEL}`);
  });

  it("says when the account added as many PCs as it may today, and admits nothing", async () => {
    await signIn();
    // three PCs added in one press today, the most an account adds in a day
    const token = fake.issueToken(ACCOUNT);
    for (let i = 0; i < 3; i++) {
      const other = generateKeyPair().publicKey;
      const id = deriveServerId(other);
      const put = await fake.fetch(`${ORIGIN}/v1/pcs/${id}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ label: `Desk ${i}`, public_key: Buffer.from(other).toString("hex"), relay: "wss://relay.ovis.sh" }) });
      expect(put.ok).toBe(true);
      const admitted = await fake.fetch(`${ORIGIN}/v1/pcs/${id}/admit`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
      expect(admitted.ok).toBe(true);
    }
    await listedByDeviceCode();
    await mount();
    await press("Add");
    expect(text()).toContain("This account has added as many PCs as it can today. Try again later.");
    expect(text()).not.toContain("The PC could not be added.");
    expect(buttons()).toEqual(["Add", "No"]);
    expect(fake.pcs(ACCOUNT).find((pc) => pc.server_id === PC)?.listed_by_device).toBe(true);
  });

  it("says a refused or failed admit could not add the PC, and keeps Add and No", async () => {
    await signIn();
    await listedByDeviceCode();
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/admit")) return Response.json({ error: { code: "internal_error", message: "down" } }, { status: 500 });
      return fake.fetch(request);
    } });
    await mount();
    await press("Add");
    expect(text()).toContain("The PC could not be added. Try again.");
    expect(buttons()).toEqual(["Add", "No"]);
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
  });

  it("says what an account service that still asks for two-step answered, never to sign in again, and admits nothing", async () => {
    fake.admitAsksTwoStep = true;
    await signIn();
    await listedByItsOwnSignIn();
    await listedByDeviceCode();
    await mount();
    await press("Add");
    expect(text()).toContain("This account has no two-step sign-in to add it here. Add it with the number on the PC's screen.");
    expect(buttons()).not.toContain("Sign in again");
    expect(buttons()).toContain("No");
    expect(fake.pcs(ACCOUNT).find((pc) => pc.server_id === PC)?.listed_by_device).toBe(true);
    expect(text()).toContain(`Name the PC gave itself: "${LABEL}"`);
  });

  /** another device said No to the listing this card shows, and the PC listed itself again: a new listing behind the same card */
  async function replacedBehindTheCard(): Promise<string> {
    const shown = fake.pcs(ACCOUNT)[0]!.listing_id!;
    const removed = await fake.fetch(`${ORIGIN}/v1/pcs/${PC}`, { method: "DELETE", headers: { authorization: `Bearer ${fake.issueToken(ACCOUNT)}` } });
    expect(removed.status).toBe(204);
    await listedByDeviceCode();
    expect(fake.pcs(ACCOUNT)[0]!.listing_id).not.toBe(shown);
    return shown;
  }

  /** the account service as this device calls it, each write to /v1/pcs recorded with what it named */
  function recorded(): { method: string; url: URL; body: Record<string, unknown> | null }[] {
    const sent: { method: string; url: URL; body: Record<string, unknown> | null }[] = [];
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== "GET" && url.pathname.startsWith("/v1/pcs/")) {
        const text = await request.clone().text();
        sent.push({ method: request.method, url, body: text === "" ? null : JSON.parse(text) as Record<string, unknown> });
      }
      return fake.fetch(request);
    } });
    return sent;
  }

  it("account#67: Add admits only the listing its card showed: a replacement is not admitted, and the card shows it as it is now", async () => {
    fake.completions = true;
    await signIn();
    await listedByDeviceCode();
    const sent = recorded();
    await mount();
    await replacedBehindTheCard();
    await press("Add");
    // the admit names no listing, so the listing is read first: one that is not the card's is not admitted
    expect(sent).toEqual([]);
    expect(admits()).toBe(0);
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
    expect(text()).not.toContain("The PC could not be added.");
    expect(text()).not.toContain("New PC added to your account");
    expect(buttons()).toEqual(["Add", "No"]);
  });

  it("an Add refused as the sign-in's age because the listing was replaced meanwhile reads the listing again, and asks no sign-in", async () => {
    fake.completions = true;
    await signIn();
    await listedByDeviceCode();
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      // a key proof signs the listing it read: another one in its place by the time it arrives is refused as session_not_fresh
      if (new URL(request.url).pathname.endsWith("/admit")) { await replacedBehindTheCard(); return Response.json({ error: { code: "session_not_fresh", message: "x" } }, { status: 403 }); }
      return fake.fetch(request);
    } });
    await mount();
    await press("Add");
    expect(text()).not.toContain("Sign in again");
    expect(buttons()).toEqual(["Add", "No"]);
    expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
  });

  it("account#67: No names the listing its card showed: a replacement is not removed, and the card shows it as it is now", async () => {
    fake.completions = true;
    await signIn();
    await listedByDeviceCode();
    const sent = recorded();
    await mount();
    const shown = await replacedBehindTheCard();
    await press("No");
    expect(sent.filter((each) => each.method === "DELETE").map((each) => `${each.url.pathname}${each.url.search}`)).toEqual([`/v1/pcs/${PC}?listing_id=${shown}`]);
    expect(fake.pcs(ACCOUNT)).toHaveLength(1);
    expect(fake.pcs(ACCOUNT)[0]!.listing_id).not.toBe(shown);
    expect(fake.requests.lastIndexOf("GET /v1/pcs")).toBeGreaterThan(fake.requests.lastIndexOf(`DELETE /v1/pcs/${PC}`));
    expect(text()).not.toContain("The PC could not be removed.");
    expect(buttons()).toEqual(["Add", "No"]);
  });

  for (const [saved, kept] of [["no listing (an older Ovis saved it)", {}], ["another listing", { listing_id: "0".repeat(32) }]] as const) {
    it(`C1: an Add kept across Sign in again for ${saved} never confirms the listing there now: it waits for a fresh press`, async () => {
      fake.completions = true;
      await signIn();
      await listedByDeviceCode();
      sessionStorage.setItem("ovis:confirm-pc", JSON.stringify({ account: ACCOUNT, server_id: PC, ...kept }));
      await mount();
      expect(fake.requests.filter((line) => line === `PUT /v1/pcs/${PC}`)).toHaveLength(1);
      expect(admits()).toBe(0);
      expect(fake.pcs(ACCOUNT)[0]?.listed_by_device).toBe(true);
      expect(buttons()).toEqual(["Add", "No"]);
    });
  }

  it("offers nothing to press to a device code's sign-in", async () => {
    await listedByDeviceCode();
    const token = fake.issueToken(ACCOUNT, { device: true });
    await store.set("session", { account: ACCOUNT, service: ORIGIN, provider: "github", sign_in_id: "device", access_token: token, refresh_token: "r", expires_at: now + 60 * MINUTE });
    await mount();
    expect(buttons()).toEqual([]);
    expect(fake.requests.filter((line) => line.startsWith("PUT ") || line.startsWith("DELETE "))).toHaveLength(1);
  });
});

describe("a PC that asks to be added to an account with a signed list", () => {
  /** This device is in its account's list, and a PC listed itself with a device code and posted its keys and its card for that list. */
  /** what the account service carries with a PC's post, for a PC that joined with an invite: the invite's key and the line's own signature */
  let carried: { invite: string; invite_proof: string; key?: string; enc?: string; card?: string } | null = null;
  async function listAccount(lies: {
    /** the account service's own answer to the admission, in place of the fake's */
    admit?: () => Response;
    /** the account service shows no posts any more */
    noPosts?: boolean;
    /** the account service's own answer to a placement, in place of the fake's (null: the fake's) */
    entries?: () => Response | null | Promise<Response | null>;
    /** runs once the account service admitted the PC */
    onAdmit?: () => void;
    /** runs at each read of the posts; a Response in place of the service's answer */
    onPosts?: () => Response | undefined;
    /** the PC lists itself and posts only when the test says (`postNow`) */
    deferPost?: true;
  } = {}) {
    fake.listAccounts = "*";
    carried = null;
    await signIn();
    await registerKey();
    const pc = await askingPc();
    let play: ReturnType<typeof pcComparing> | undefined;
    // the PC answers as soon as the account service holds this device's commitment
    // every comparison this device opened: an attempt with no reveal
    const opened: string[] = [];
    service = new AccountService({ store, lock: memoryLock(), now: () => now, fetch: async (input: Request | string | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (lies.admit !== undefined && path.endsWith("/admit")) return lies.admit();
      if (lies.noPosts && request.method === "GET" && path.endsWith("/posts")) return Response.json({ posts: [] });
      if (request.method === "GET" && path.endsWith("/posts")) { const said = lies.onPosts?.(); if (said !== undefined) return said; }
      if (lies.onAdmit !== undefined && request.method === "POST" && path.endsWith("/admit")) { const answer = await fake.fetch(request.clone()); if (answer.ok) lies.onAdmit(); return answer; }
      if (request.method === "POST" && path.endsWith("/entries")) { const said = await lies.entries?.(); if (said) return said; }
      if (request.method === "POST" && path.endsWith("/attempt") && (await request.clone().json() as { reveal?: string }).reveal === undefined) opened.push(path);
      const answer = await fake.fetch(request.clone());
      if (request.method === "POST" && path.endsWith("/attempt")) await play?.answer();
      if (carried !== null && request.method === "GET" && path.endsWith("/posts") && answer.ok) {
        const body = await answer.json() as { posts: Record<string, unknown>[] };
        return Response.json({ ...body, posts: body.posts.map((post) => post.endpoint === pc.endpoint ? { ...post, ...carried } : post) });
      }
      return answer;
    } });
    const list = accountList({ service, accountStore: store, listStore: memoryListStore(), lock: memoryListLock(), now: () => now, genesis: () => "always", durable: async () => true, names: () => ({ label: "Phone", os: "ios" }) });
    await list.sync();
    setPageAccountList(list);
    const held = () => fake.accountList(ACCOUNT)!;
    const postNow = async (): Promise<void> => { await postPcKeys(fake.fetch, ORIGIN, fake.issueToken(ACCOUNT, { device: true }), pc, held().id); };
    if (lies.deferPost !== true) await postNow();
    play = pcComparing({ fake, origin: ORIGIN } as unknown as Parameters<typeof pcComparing>[0], pc, held().id);
    const pcAdmits = (): number => fake.requests.filter((line) => line === `POST /v1/pcs/${pc.server_id}/admit`).length;
    return { pc, play, list, held, pcAdmits, postNow, opened: () => opened.length };
  }
  const digitsShown = (): string => textOf(renderer!.root.findByProps({ className: "relay-shell-digits" })).replaceAll(" ", "");

  it("shows the number both screens have before anything is added, and signs the PC into the list at the second Add", async () => {
    const { pc, play, list, held, pcAdmits } = await listAccount();
    try {
      await mount();
      await press("Add");
      // the number, with what to do with it; nothing is admitted or signed yet
      expect(await play.digits()).toBe(digitsShown());
      expect(text()).toContain("Check that the PC shows this number and confirm it there, then Add");
      expect(buttons()).toEqual(["Add", "Not the same"]);
      expect([pcAdmits(), held().entries.length]).toEqual([0, 1]);
      await press("Add");
      expect([pcAdmits(), held().entries.length]).toEqual([1, 2]);
      expect(list.view().pcs.map((row) => [row.endpoint, row.name?.label])).toEqual([[pc.endpoint, "PC"]]);
      // a number was compared on both screens: this device's own record of its PCs says that it added this one
      await settle();
      expect(readSeenPcs(ACCOUNT).pcs[pc.endpoint]).toEqual({ how: "added" });
      // the card is gone
      expect(renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === pc.server_id)).toEqual([]);
    } finally { setPageAccountList(null); }
  });

  it("adds nothing where the person says the numbers are not the same", async () => {
    const { held, pcAdmits } = await listAccount();
    try {
      await mount();
      await press("Add");
      await press("Not the same");
      expect(text()).toContain("The numbers did not match. This PC was not added.");
      expect([pcAdmits(), held().entries.length]).toEqual([0, 1]);
      expect(readSeenPcs(ACCOUNT).pcs).toEqual({});
      expect(renderer!.root.findAllByProps({ className: "relay-shell-digits" })).toEqual([]);
    } finally { setPageAccountList(null); }
  });

  it("adds a PC that joined with this account's invite at one press, with no number, where the line itself signed for it, and ends the invite", async () => {
    const { pc, list, held, pcAdmits } = await listAccount();
    try {
      const made = await makeInvite(list, { auto: false });
      if (!made.made) throw new Error(`no invite was made: ${made.why}`);
      const line = await readJoinLine(made.invite.line, { service: ORIGIN, followsLists: true });
      carried = { invite: made.invite.key, invite_proof: await line.signLineProof({ server_id: pc.server_id, card: pc }) };
      await mount();
      // the card says where the PC comes from, by the device's own check of the line's signature: this device made the invite
      expect(text()).toContain("Add this PC to your account? (joined with your invite)");
      const before = held().entries.length;
      await press("Add");
      expect(renderer!.root.findAllByProps({ className: "relay-shell-digits" })).toEqual([]);
      expect([pcAdmits(), held().entries.length - before]).toEqual([1, 2]);
      expect(list.view().pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
      expect(listView(held().state).invites.map((row) => row.refusal)).toEqual(["invite_revoked"]);
      // the line's own signature is evidence the account service could not make: the device's record of its PCs says where this one came from
      await settle();
      expect(readSeenPcs(ACCOUNT).pcs[pc.endpoint]).toEqual({ how: "invited" });
    } finally { setPageAccountList(null); }
  });

  it("says whose invite the PC joined with: this device's, another device's by its name, or the account's where no name can be read", () => {
    const t = (key: string, vars?: Record<string, string | number>): string => translate("en", key, vars);
    const members = [{ key: "mine", self: true, name: { label: "Dana's Mac" } }, { key: "phone", self: false, name: { label: "Dana's phone" } }, { key: "unnamed", self: false, name: null }];
    expect(invitedTitle(t, { by: "mine" }, members)).toBe("Add this PC to your account? (joined with your invite)");
    expect(invitedTitle(t, { by: "phone" }, members)).toBe("Add this PC to your account? (joined with the invite from Dana's phone)");
    for (const by of ["unnamed", "gone", null]) expect(invitedTitle(t, { by }, members)).toBe("Add this PC to your account? (joined with an invite of your account)");
  });

  /** An invite this device made, and the line's own proof for the PC's card, carried with the PC's post. */
  async function invitedBy(list: Awaited<ReturnType<typeof listAccount>>["list"], pc: Awaited<ReturnType<typeof listAccount>>["pc"]) {
    const made = await makeInvite(list, { auto: false });
    if (!made.made) throw new Error(`no invite was made: ${made.why}`);
    const line = await readJoinLine(made.invite.line, { service: ORIGIN, followsLists: true });
    carried = { invite: made.invite.key, invite_proof: await line.signLineProof({ server_id: pc.server_id, card: pc }) };
    return { invite: made.invite, line };
  }
  const title = (): string => textOf(renderer!.root.find((node) => node.props["data-unconfirmed-pc"] !== undefined).findAll((node) => node.type === "span")[1]!);
  const focus = async (): Promise<void> => { await act(async () => { window.dispatchEvent(new Event("focus")); }); await settle(); };

  it("is drawn again when the line's proof comes after the card, and when the invite is over: it says so only while it holds", async () => {
    const { pc, list } = await listAccount();
    try {
      await mount();
      expect(title()).toBe("Add this PC to your account?");
      const { invite } = await invitedBy(list, pc);
      await focus();
      expect(title()).toBe("Add this PC to your account? (joined with your invite)");
      // a PC that joined with an invite came with no sign-in code: the card says nothing of one
      expect(text()).not.toContain("entered the code it showed");
      now = (invite.exp + 1) * 1000;
      await focus();
      expect(title()).toBe("Add this PC to your account?");
    } finally { setPageAccountList(null); }
  });

  it("signs for the card that was shown and no other: a post with other keys under the same relay key is drawn again, and nothing is added at that press", async () => {
    const { pc, list, held, pcAdmits } = await listAccount();
    try {
      const { invite, line } = await invitedBy(list, pc);
      await mount();
      expect(title()).toBe("Add this PC to your account? (joined with your invite)");
      // the PC posted again, with other keys and a proof of the line for them, after the card was drawn
      const other = await askingPc();
      const card = await signCard({ key: other.key, enc: other.enc, list: held().id, endpoint: pc.endpoint, invite: null }, other.signs);
      carried = { invite: invite.key, invite_proof: await line.signLineProof({ server_id: pc.server_id, card: { key: other.key, enc: other.enc, endpoint: pc.endpoint } }), key: other.key, enc: other.enc, card };
      const before = held().entries.length;
      await press("Add");
      expect([pcAdmits(), held().entries.length]).toEqual([0, before]);
      expect(list.view().pcs).toEqual([]);
    } finally { setPageAccountList(null); }
  });

  it("writes the invited record before the card goes: a card is never dismissed while the record waits for another tab", async () => {
    const { pc, list } = await listAccount();
    const locks = Promise.withResolvers<void>();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { ...navigator, locks: { request: async (_name: string, work: () => Promise<void>) => { await locks.promise; return work(); } } }, configurable: true });
    try {
      await invitedBy(list, pc);
      await mount();
      const add = renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === "Add")[0]!;
      await act(async () => { void add.props.onClick(); });
      await until(() => list.view().pcs.length > 0, "the PC is in the list");
      // another tab holds the record's lock: the PC is in the list, and the card stays until its record is written
      expect(list.view().pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
      expect(renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === pc.server_id)).toHaveLength(1);
      locks.resolve();
      await until(cardsIdle, "the Add is done");
      expect(readSeenPcs(ACCOUNT).pcs[pc.endpoint]).toEqual({ how: "invited" });
      expect(renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === pc.server_id)).toEqual([]);
    } finally {
      if (saved) Object.defineProperty(globalThis, "navigator", saved);
      setPageAccountList(null);
    }
  });

  it("ends the invite at the account service too once its PC was added at one press, and stays with Try again where the list did not take the entry", async () => {
    let stopped = false;
    const { pc, list, held, pcAdmits } = await listAccount({ entries: () => stopped ? Response.json({ error: { code: "list_stopped", message: "stopped" } }, { status: 503 }) : null });
    try {
      await invitedBy(list, pc);
      stopped = true;
      await mount();
      await press("Add");
      // admitted, and the list did not take the entry: the card stays, and says so
      expect(text()).toContain("is not in your account's list yet. Try again.");
      await focus();
      expect(renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === pc.server_id)).toHaveLength(1);
      stopped = false;
      await press("Try again");
      expect([pcAdmits(), list.view().pcs.map((row) => row.endpoint), listView(held().state).invites.map((row) => row.refusal)]).toEqual([1, [pc.endpoint], ["invite_revoked"]]);
      expect(readSeenPcs(ACCOUNT).pcs[pc.endpoint]).toEqual({ how: "invited" });
      await settle();
      const open = await (await fake.fetch(`${ORIGIN}/v1/pc-invites`, { headers: { authorization: `Bearer ${fake.issueToken(ACCOUNT)}` } })).json() as { invites: unknown[] };
      expect(open.invites).toEqual([]);
    } finally { setPageAccountList(null); }
  });

  it("stops offering the one-press Add at the invite's end by its own clock, also where the posts cannot be read then", async () => {
    let down = false;
    const { pc, list, postNow } = await listAccount({ deferPost: true, onPosts: () => down ? Response.json({ error: { code: "unavailable", message: "" } }, { status: 503 }) : undefined });
    try {
      const { invite } = await invitedBy(list, pc);
      // the PC listed itself a minute before the invite ends, and the card is drawn ten milliseconds before it ends:
      // the card's own timer is armed for a second after that end
      now = (invite.exp - 60) * 1000;
      await postNow();
      now = invite.exp * 1000 - 10;
      await mount();
      expect(title()).toBe("Add this PC to your account? (joined with your invite)");
      down = true;
      now = (invite.exp + 5) * 1000;
      // the card's own timer, armed for the invite's end and a second after it: waited for by the title, within a deadline
      const deadline = Date.now() + 5_000;
      while (title() !== "Add this PC to your account?" && Date.now() < deadline) await settle();
      expect(title()).toBe("Add this PC to your account?");
    } finally { setPageAccountList(null); }
  });

  it("offers no Try again on a kept card whose invite ended after the admission: only No, which removes the PC", async () => {
    let end: (() => void) | null = null;
    const { pc, list, held } = await listAccount({ onAdmit: () => end?.() });
    try {
      const { invite } = await invitedBy(list, pc);
      // the invite runs out while the admission is on its way
      end = () => { now = (invite.exp + 5) * 1000; };
      await mount();
      await press("Add");
      expect(text()).toContain("This request ran out. To add this PC, start again on the PC.");
      expect(buttons()).toEqual(["No"]);
      expect(held().state.pcs[pc.endpoint]).toBeUndefined();
    } finally { setPageAccountList(null); }
  });

  it("adds nothing where the number ran out while the press looked up the PC's invite", async () => {
    let late = false;
    const { pc, held, pcAdmits } = await listAccount({ onPosts: () => { if (late) now += 121_000; return undefined; } });
    try {
      await mount();
      await press("Add");
      expect(buttons()).toEqual(["Add", "Not the same"]);
      late = true;
      await press("Add");
      expect(text()).toContain("That number ran out. Press Add for a new one.");
      expect([pcAdmits(), held().entries.length, readSeenPcs(ACCOUNT).pcs[pc.endpoint]]).toEqual([0, 1, undefined]);
    } finally { setPageAccountList(null); }
  });

  it("asks for the number, as for any PC that asks, where the invite's proof is another PC's", async () => {
    const { list } = await listAccount();
    try {
      const made = await makeInvite(list, { auto: false });
      if (!made.made) throw new Error(`no invite was made: ${made.why}`);
      const line = await readJoinLine(made.invite.line, { service: ORIGIN, followsLists: true });
      const other = await askingPc();
      carried = { invite: made.invite.key, invite_proof: await line.signLineProof({ server_id: other.server_id, card: other }) };
      await mount();
      expect(text()).not.toContain("joined with your invite");
      await press("Add");
      expect(text()).toContain("Check that the PC shows this number and confirm it there, then Add");
      expect(list.view().pcs).toEqual([]);
    } finally { setPageAccountList(null); }
  });

  it("asks for three numbers at most per card, counted across Not the same: then only No is offered", async () => {
    const { held, pcAdmits, opened } = await listAccount();
    try {
      await mount();
      for (let round = 0; round < 3; round++) {
        await press("Add");
        expect(buttons()).toEqual(["Add", "Not the same"]);
        await press("Not the same");
      }
      expect(text()).toContain("Too many tries for this PC. Start again on the PC in a few minutes.");
      expect(buttons()).toEqual(["No"]);
      expect([opened(), pcAdmits(), held().entries.length]).toEqual([3, 0, 1]);
    } finally { setPageAccountList(null); }
  });

  it("adds nothing at a press after the number ran out, whatever the timer did not draw yet", async () => {
    const { held, pcAdmits } = await listAccount();
    try {
      await mount();
      await press("Add");
      expect(buttons()).toEqual(["Add", "Not the same"]);
      now += 121_000;
      await press("Add");
      expect(text()).toContain("That number ran out. Press Add for a new one.");
      expect([pcAdmits(), held().entries.length]).toEqual([0, 1]);
    } finally { setPageAccountList(null); }
  });

  it("turns to the request ran out where the account service answers listing_expired to the Add beside the number", async () => {
    const { held } = await listAccount({ admit: () => Response.json({ error: { code: "listing_expired", message: "x" } }, { status: 409 }) });
    try {
      await mount();
      await press("Add");
      await press("Add");
      expect(text()).toContain("This request ran out. To add this PC, start again on the PC.");
      expect(text()).not.toContain("The PC could not be added. Try again.");
      expect(held().entries.length).toBe(1);
    } finally { setPageAccountList(null); }
  });

  it("never falls through to the directory's admission alone where the account has a list and the PC's post is gone", async () => {
    const { held, pcAdmits } = await listAccount({ noPosts: true });
    try {
      await mount();
      await press("Add");
      expect(text()).toContain("The PC did not answer. Start again on the PC.");
      expect([pcAdmits(), held().entries.length]).toEqual([0, 1]);
    } finally { setPageAccountList(null); }
  });

  it("stays, once the account admitted the PC and the list did not take its entry, and Try again places it with no second admission", async () => {
    let stopped = true;
    const { pc, list, held, pcAdmits } = await listAccount({ entries: () => stopped ? Response.json({ error: { code: "list_stopped", message: "stopped" } }, { status: 503 }) : null });
    try {
      await mount();
      await press("Add");
      await press("Add");
      expect(text()).toContain("The account service cannot change the list right now.");
      expect(text()).toContain("is not in your account's list yet. Try again.");
      expect(buttons()).toEqual(["Try again", "No"]);
      // the directory lists the PC as admitted now: the card stays all the same
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      await settle();
      expect(renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === pc.server_id)).toHaveLength(1);
      stopped = false;
      await press("Try again");
      expect([pcAdmits(), held().entries.length, list.view().pcs.map((row) => row.endpoint)]).toEqual([1, 2, [pc.endpoint]]);
      expect(readSeenPcs(ACCOUNT).pcs[pc.endpoint]).toEqual({ how: "added" });
      expect(renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === pc.server_id)).toEqual([]);
    } finally { setPageAccountList(null); }
  });

  it("keeps what it places across a read of the account's PCs that comes while the entry goes out: Try again stays", async () => {
    let stopped = true;
    const { pc, list } = await listAccount({ entries: async () => {
      if (!stopped) return null;
      // the page comes to the front while the entry is on its way: the account's PCs are read again, and the PC,
      // admitted by now, is no longer one that asks
      window.dispatchEvent(new Event("focus"));
      for (let turns = 0; turns < 50; turns++) await new Promise((resolve) => setTimeout(resolve, 0));
      return Response.json({ error: { code: "list_stopped", message: "stopped" } }, { status: 503 });
    } });
    try {
      await mount();
      await press("Add");
      await press("Add");
      // the entry's answer comes after the read of the account's PCs: waited for by its words, within a deadline
      const deadline = Date.now() + 5_000;
      while (!text().includes("The account service cannot change the list right now.") && Date.now() < deadline) await settle();
      expect(renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === pc.server_id)).toHaveLength(1);
      expect(buttons()).toEqual(["Try again", "No"]);
      stopped = false;
      await press("Try again");
      expect(list.view().pcs.map((row) => row.endpoint)).toEqual([pc.endpoint]);
    } finally { setPageAccountList(null); }
  });

  it("removes the admitted PC from the account at No on a card kept after the list did not take its entry", async () => {
    const { pc } = await listAccount({ entries: () => Response.json({ error: { code: "list_stopped", message: "stopped" } }, { status: 503 }) });
    try {
      await mount();
      await press("Add");
      await press("Add");
      expect(buttons()).toEqual(["Try again", "No"]);
      await press("No");
      // the account no longer lists the PC, and the card is gone
      expect([fake.pcs(ACCOUNT).map((row) => row.server_id), renderer!.root.findAll((node) => node.props["data-unconfirmed-pc"] === pc.server_id)]).toEqual([[], []]);
    } finally { setPageAccountList(null); }
  });

  it("says so where the PC does not answer, and shows no number", async () => {
    const { play, held, pcAdmits } = await listAccount();
    try {
      play.answer = async () => false;
      await mount({ numberWaitMs: 0 });
      await press("Add");
      expect(text()).toContain("The PC did not answer. Start again on the PC.");
      expect(renderer!.root.findAllByProps({ className: "relay-shell-digits" })).toEqual([]);
      expect([pcAdmits(), held().entries.length]).toEqual([0, 1]);
    } finally { setPageAccountList(null); }
  });
});
