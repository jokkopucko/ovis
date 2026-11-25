import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { FakeAccountService, WEB_REDIRECT } from "../../shared/account-service-fake.ts";
import { accountList, type AccountList } from "../lib/account/accountList.ts";
import { askingPc, pcComparing, postPcKeys, type AskingPc } from "../lib/account/accountList.test-helpers.ts";
import { postedPcs, type PostedPc } from "../lib/account/listAdd.ts";
import { memoryListLock, memoryListStore } from "../lib/account/listStore.ts";
import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { readSeenPcs } from "../lib/account/seenPcs.ts";
import { AccountService } from "../lib/account/service.ts";
import { beginSignIn, finishSignIn, signInReturn } from "../lib/account/signin.ts";
import { memoryAccountStore, memoryLock, newKey, type AccountStore } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AddPcByNumber } from "./AddPcByNumber.tsx";

const ORIGIN = "https://account.ovis.sh";
const ACCOUNT = "acct_owner";

const globals = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let fake: FakeAccountService;
let store: AccountStore;
let changes = 0;

const textOf = (node: ReactTestInstance): string => node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const buttons = (): string[] => renderer!.root.findAll((node) => node.type === "button").map((node) => textOf(node).trim());
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const press = async (label: string): Promise<void> => {
  const found = renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === label);
  if (found.length !== 1) throw new Error(`${found.length} buttons say ${label}`);
  await act(async () => { await found[0]!.props.onClick(); });
  await settle();
};
const text = (): string => textOf(renderer!.root.find((node) => node.props["data-testid"] === "add-pc-number"));
/** Settles once `holds`, looking every 10 ms for two seconds at most: a wait for the PC runs on the real clock. */
const until = async (holds: () => boolean): Promise<void> => {
  for (let looks = 0; looks < 200 && !holds(); looks++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
};
const digitsShown = (): string => textOf(renderer!.root.findByProps({ className: "relay-shell-digits" })).replaceAll(" ", "");

beforeEach(() => {
  const events = new EventTarget();
  events.addEventListener(ACCOUNT_PCS_CHANGED_EVENT, () => { changes++; });
  for (const [name, value] of Object.entries({
    window: Object.assign(events, { location: new URL("https://app.ovis.sh/"), history: { state: null, pushState() {}, replaceState() {}, back() {} }, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) }),
    IS_REACT_ACT_ENVIRONMENT: true,
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"] },
    localStorage: (() => { const kept = new Map<string, string>(); return { getItem: (name: string) => kept.get(name) ?? null, setItem: (name: string, value: string) => { kept.set(name, value); }, removeItem: (name: string) => { kept.delete(name); } }; })(),
  })) {
    globals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  fake = new FakeAccountService();
  fake.opensAll = true;
  fake.listAccounts = "*";
  fake.signInAs("github", ACCOUNT);
  store = memoryAccountStore();
  changes = 0;
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  globals.clear();
});

/**
 * This device is in its account's list, and a PC the account lists already (an own sign-in listed it, before the
 * account had a list) posted its keys and its card for that list.
 */
async function listedPc(): Promise<{ pc: AskingPc; play: ReturnType<typeof pcComparing>; list: AccountList; post: PostedPc; admits: () => number; opened: () => number; held: () => NonNullable<ReturnType<FakeAccountService["accountList"]>> }> {
  const start = await beginSignIn("github", { store, service: ORIGIN, redirectUri: WEB_REDIRECT });
  const returned = signInReturn(new URL((await fake.fetch(start)).headers.get("location") ?? "").hash);
  if (returned === null) throw new Error("no sign-in came back");
  await finishSignIn(returned, { store, fetch: fake.fetch });
  const session = (await store.get("session"))!;
  const made = await newKey();
  await store.set("signin_key", { account: ACCOUNT, sign_in_id: session.sign_in_id!, key: made, no: fake.registerSessionKey(session.access_token, made.public_spki, "Phone") });
  const pc = await askingPc();
  let play: ReturnType<typeof pcComparing> | undefined;
  // every comparison this device opened: an attempt with no reveal
  let opened = 0;
  // the PC answers as soon as the account service holds this device's commitment
  const service = new AccountService({ store, lock: memoryLock(), fetch: async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/attempt") && (await request.clone().json() as { reveal?: string }).reveal === undefined) opened++;
    const answer = await fake.fetch(request.clone());
    if (request.method === "POST" && new URL(request.url).pathname.endsWith("/attempt")) await play?.answer();
    return answer;
  } });
  const list = accountList({ service, accountStore: store, listStore: memoryListStore(), lock: memoryListLock(), genesis: () => "always", durable: async () => true, names: () => ({ label: "Phone", os: "ios" }) });
  await list.sync();
  const held = () => fake.accountList(ACCOUNT)!;
  await postPcKeys(fake.fetch, ORIGIN, fake.issueToken(ACCOUNT), pc, held().id);
  play = pcComparing({ fake, origin: ORIGIN } as unknown as Parameters<typeof pcComparing>[0], pc, held().id);
  const post = (await postedPcs(list)).find((each) => each.server_id === pc.server_id);
  if (post === undefined) throw new Error("the PC's post was not read");
  return { pc, play, list, post, held, opened: () => opened, admits: () => fake.requests.filter((line) => line === `POST /v1/pcs/${pc.server_id}/admit`).length };
}

async function mount(list: AccountList, post: PostedPc, more: { waitMs?: number; now?: () => number } = {}): Promise<{ closed: () => number; added: () => number }> {
  let closed = 0, added = 0;
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(AddPcByNumber, { list, account: ACCOUNT, post, name: "Desk", onClose: () => { closed++; }, onAdded: () => { added++; }, ...more }) }));
  });
  await settle();
  return { closed: () => closed, added: () => added };
}

describe("a PC the account names that its signed list does not hold yet", () => {
  it("shows the number the PC shows, and signs the PC into the list at Add, with no admission asked for", async () => {
    const { pc, play, list, post, held, admits } = await listedPc();
    const told = await mount(list, post);
    expect(await play.digits()).toBe(digitsShown());
    expect(text()).toContain("Add this PC to your account?");
    expect(text()).toContain("Desk");
    expect(text()).toContain("Check that the PC shows this number and confirm it there, then Add");
    expect(buttons()).toEqual(["Cancel", "Not the same", "Add"]);
    // nothing is signed before the press
    expect(held().entries.length).toBe(1);
    await press("Add");
    expect([admits(), held().entries.length, told.added(), changes]).toEqual([0, 2, 1, 1]);
    expect(list.view().pcs.map((row) => [row.endpoint, row.name?.label])).toEqual([[pc.endpoint, "Desk"]]);
    // a number was compared on both screens: this device's own record of its PCs says that it added this one
    await settle();
    expect(readSeenPcs(ACCOUNT).pcs[pc.endpoint]).toEqual({ how: "added" });
  });

  it("closes at Cancel while the number is shown, and adds nothing", async () => {
    const { list, post, held } = await listedPc();
    const told = await mount(list, post);
    expect(renderer!.root.findAllByProps({ className: "relay-shell-digits" })).toHaveLength(1);
    await press("Cancel");
    expect([told.closed(), told.added(), held().entries.length]).toEqual([1, 0, 1]);
  });

  it("adds nothing where the person says the numbers are not the same, and offers no other try", async () => {
    const { list, post, held } = await listedPc();
    const told = await mount(list, post);
    await press("Not the same");
    expect(text()).toContain("The numbers did not match. This PC was not added.");
    expect(buttons()).toEqual(["Close"]);
    expect(renderer!.root.findAllByProps({ className: "relay-shell-digits" })).toEqual([]);
    await press("Close");
    expect([held().entries.length, told.added(), told.closed()]).toEqual([1, 0, 1]);
    expect(readSeenPcs(ACCOUNT).pcs).toEqual({});
  });

  it("says so where the PC does not answer, shows no number, and asks again at Try again", async () => {
    const { play, list, post, held } = await listedPc();
    const answer = play.answer;
    play.answer = async () => false;
    await mount(list, post, { waitMs: 100 });
    await until(() => text().includes("The PC did not answer"));
    expect(text()).toContain("The PC did not answer. Start again on the PC.");
    expect(renderer!.root.findAllByProps({ className: "relay-shell-digits" })).toEqual([]);
    expect(buttons()).toEqual(["Close", "Try again"]);
    play.answer = answer;
    await press("Try again");
    await until(() => renderer!.root.findAllByProps({ className: "relay-shell-digits" }).length > 0);
    expect(await play.digits()).toBe(digitsShown());
    expect(held().entries.length).toBe(1);
  });

  it("writes the added record before the dialog says it is done: never while another tab holds the record", async () => {
    const { pc, list, post } = await listedPc();
    const locks = Promise.withResolvers<void>();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { ...navigator, locks: { request: async (_name: string, work: () => Promise<void>) => { await locks.promise; return work(); } } }, configurable: true });
    try {
      const told = await mount(list, post);
      const add = renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === "Add")[0]!;
      await act(async () => { void add.props.onClick(); });
      await settle();
      expect([list.view().pcs.map((row) => row.endpoint), told.added()]).toEqual([[pc.endpoint], 0]);
      locks.resolve();
      await settle();
      expect([told.added(), readSeenPcs(ACCOUNT).pcs[pc.endpoint]]).toEqual([1, { how: "added" }]);
    } finally {
      locks.resolve();
      if (saved) Object.defineProperty(globalThis, "navigator", saved);
    }
  });

  it("asks for three numbers at most: after the third, no Try again", async () => {
    const { play, list, post, held, opened } = await listedPc();
    play.answer = async () => false;
    await mount(list, post, { waitMs: 100 });
    for (let more = 0; more < 2; more++) {
      await until(() => buttons().includes("Try again"));
      expect(buttons()).toEqual(["Close", "Try again"]);
      await press("Try again");
    }
    await until(() => text().includes("Too many tries"));
    expect(text()).toContain("Too many tries for this PC. Start again on the PC in a few minutes.");
    expect(buttons()).toEqual(["Close"]);
    expect([opened(), held().entries.length]).toEqual([3, 1]);
  });

  it("adds nothing at a press after the number ran out, whatever the timer did not draw yet", async () => {
    const { list, post, held } = await listedPc();
    let clock = Date.now();
    await mount(list, post, { now: () => clock });
    expect(buttons()).toEqual(["Cancel", "Not the same", "Add"]);
    clock += 121_000;
    await press("Add");
    expect(text()).toContain("That number ran out. Press Add for a new one.");
    expect([held().entries.length, readSeenPcs(ACCOUNT).pcs]).toEqual([1, {}]);
  });
});
