import { afterEach, beforeEach, expect, it, jest, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
import { entryFromText, readBody } from "../../shared/account-list-entry.ts";
import { addListPc, listWorld } from "../lib/account/accountList.test-helpers.ts";
import { allowDevice } from "../lib/account/listAllow.ts";
import { removeListPc } from "../lib/account/listRemove.ts";
import { setPageAccountList } from "../lib/account/pageList.ts";
import { ACCOUNT_SIGN_OUT_EVENT } from "../lib/account/service.ts";
import { indexedAccountStore, memoryAccountStore } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { NewPcNotices } from "./NewPcNotices.tsx";

const ORIGIN = "https://account.ovis.sh";
const ACCOUNT = "acct_notice";
const publicKey = generateKeyPair().publicKey;
const PC = deriveServerId(publicKey);
const OTHER = "a".repeat(32);
const globals = new Map<string, PropertyDescriptor | undefined>();
let page: Page;
let service: FakeAccountService;
let store: ReturnType<typeof memoryAccountStore>;
let restore: () => void;
/** the fake account service's clock: a test moves it on instead of waiting */
let clock = Date.now();
let expired = false;
let rejectDelete = false;
/** what GET /v1/pcs answers instead of the fake, when set */
let listed: unknown[] | null = null;

beforeEach(async () => {
  page = openPage("https://app.ovis.sh/");
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
  for (const [key, value] of Object.entries({
    location: page.window.location, localStorage: page.window.localStorage, Event: page.window.Event,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  store = memoryAccountStore();
  clock = Date.now();
  service = new FakeAccountService(() => clock);
  service.opensAll = true;
  const token = service.issueToken(ACCOUNT, { twoStep: true });
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const url = `${ORIGIN}/v1/pcs/${PC}`;
  expect((await service.fetch(url, {
    method: "PUT", headers, body: JSON.stringify({ label: "Desk", public_key: Buffer.from(publicKey).toString("hex"), relay: "wss://relay.ovis.sh" }),
  })).ok).toBe(true);
  expect((await service.fetch(`${url}/admit`, { method: "POST", headers })).ok).toBe(true);
  await store.set("session", {
    account: ACCOUNT, service: ORIGIN, provider: "github", sign_in_id: "notice-test",
    access_token: token, refresh_token: "refresh", expires_at: Date.now() + 60 * 60_000,
  });
  expired = false;
  rejectDelete = false;
  listed = null;
  const get = spyOn(indexedAccountStore, "get").mockImplementation(store.get);
  const update = spyOn(indexedAccountStore, "update").mockImplementation(store.update);
  const send = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (rejectDelete && init?.method === "DELETE") return new Response(null, { status: 503 });
    if (listed !== null && init?.method === "GET" && new URL(String(input instanceof Request ? input.url : input)).pathname === "/v1/pcs") return Response.json({ pcs: listed });
    if (expired && init?.method === "GET") return Response.json({ pcs: [
      { server_id: PC, label: "Desk", added_at: new Date(0).toISOString(), last_seen_at: null, new_until: new Date(1).toISOString() },
    ] });
    return service.fetch(input, init);
  }, { preconnect: fetch.preconnect }));
  restore = () => { get.mockRestore(); update.mockRestore(); send.mockRestore(); };
});

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
  restore?.();
  for (const [key, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
  globals.clear();
});

/** `null`: a window that is no PC's own (a phone, the relay page); the default is another PC's own window */
async function mount(ownWindowOf: string | null = OTHER, onRemoved?: () => void, enabled = true) {
  await page.render(null);
  await page.render(<SettingsProvider><NewPcNotices enabled={enabled} ownWindowOf={ownWindowOf ?? undefined} onRemoved={onRemoved} /></SettingsProvider>);
  return page.container;
}

const statuses = (root: Element) => [...root.querySelectorAll('[role="status"]')];
const buttons = (root: Element) => [...root.querySelectorAll("button")];
const spans = (root: Element) => [...root.querySelectorAll("span")];
const text = (node: Element) => node.textContent ?? "";

it("A2: a new PC is announced in every window but the PC's own local window, a window into that PC through the relay included", async () => {
  await mount();
  expect(spans(page.one('[role="status"]')).some((node) => text(node) === "New PC added to your account: Desk")).toBe(true);
  // a phone that opened the new PC through the relay is another device: it is told
  page.window.history.replaceState(null, "", `/s/${PC}/`);
  expect(statuses(await mount(null))).toHaveLength(1);
  // the PC's own local window added it
  expect(statuses(await mount(PC))).toHaveLength(0);
});

it("#16: a device that signed in after a PC was added is not told of it as new, while one signed in before is", async () => {
  const admittedAt = new Date(Date.now() - 60 * 60_000).toISOString();
  const newUntil = new Date(Date.now() + 23 * 60 * 60_000).toISOString();
  listed = [{ server_id: PC, label: "Desk", added_at: admittedAt, last_seen_at: null, new_until: newUntil, admitted_at: admittedAt, admitted_before_you: false }];
  // this sign-in (the fake's token, issued in beforeEach) came after the PC's admission
  expect(statuses(await mount())).toHaveLength(0);
  // admitted after this sign-in: told
  const later = new Date(Date.now() + 1_000).toISOString();
  listed = [{ server_id: PC, label: "Desk", added_at: later, last_seen_at: null, new_until: newUntil, admitted_at: later, admitted_before_you: false }];
  expect(statuses(await mount())).toHaveLength(1);
});

it("#16 gate B2: a browser that signs in again to remove the PC (a new, later sign-in) still sees the notice and removes it", async () => {
  const first = await mount();
  expect(statuses(first)).toHaveLength(1);
  // Sign in again leaves the page and comes back with a fresh sign-in, made after the PC was added
  clock += 60_000;
  const again = service.issueToken(ACCOUNT, { twoStep: true });
  await store.update("session", (current) => current === undefined ? undefined : { ...current, access_token: again, sign_in_id: "notice-test-again" });
  const back = await mount();
  expect(statuses(back)).toHaveLength(1);
  const remove = buttons(back).find((node) => text(node) === "I didn't add this");
  if (remove === undefined) throw new TypeError("Missing removal action");
  await act(async () => { remove.click(); });
  expect(service.requests.filter((request) => request.startsWith("DELETE"))).toEqual([`DELETE /v1/pcs/${PC}`]);
  expect(statuses(back)).toHaveLength(0);
});

it("A2: Not me deletes the PC once, clears the card, and refreshes the account list", async () => {
  const refreshed = Promise.withResolvers<void>();
  const root = await mount(OTHER, refreshed.resolve);
  const remove = buttons(root).find((node) => text(node) === "I didn't add this");
  if (remove === undefined) throw new TypeError("Missing removal action");
  await act(async () => { remove.click(); await refreshed.promise; });
  expect(service.requests.filter((request) => request.startsWith("DELETE"))).toEqual([`DELETE /v1/pcs/${PC}`]);
  expect(statuses(root)).toHaveLength(0);
});

it("A2: a failed removal leaves the notice in place with a retryable alert", async () => {
  rejectDelete = true;
  const root = await mount();
  const remove = buttons(root).find((node) => text(node) === "I didn't add this");
  if (remove === undefined) throw new TypeError("Missing removal action");
  await act(async () => { remove.click(); });
  expect(page.one('[role="alert"]').textContent).toBe("The PC could not be removed. Try again.");
  expect(remove.disabled).toBe(false);
});

it("PCR-1: a device code's sign-in removes nothing and is told to sign in on this device", async () => {
  // this device joined the account before the PC was added (its first sign-in); the device code's sign-in comes later
  await mount();
  const token = service.issueToken(ACCOUNT, { device: true });
  await store.update("session", (current) => current === undefined ? undefined : { ...current, access_token: token });
  const root = await mount();
  const remove = buttons(root).find((node) => text(node) === "I didn't add this");
  if (remove === undefined) throw new TypeError("Missing removal action");
  await act(async () => { remove.click(); });
  expect([...root.querySelectorAll('[role="alert"]')].map(text)).toEqual(["Sign in on this device to remove it."]);
  expect(statuses(root)).toHaveLength(1);
});

it("A2: Close hides the notice on this device and keeps it hidden after remount", async () => {
  const root = await mount();
  await act(async () => page.one('button[aria-label="Close"]').click());
  expect(statuses(root)).toHaveLength(0);
  expect(statuses(await mount())).toHaveLength(0);
  expect(service.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
});

it("A2: a PC whose new-until timestamp has passed is not announced", async () => {
  expired = true;
  expect(statuses(await mount())).toHaveLength(0);
});

it("A2: ending the sign-in clears the previous account's notices", async () => {
  const root = await mount();
  expect(statuses(root)).toHaveLength(1);
  await store.update("session", () => undefined);
  await act(async () => { page.window.dispatchEvent(new page.window.Event(ACCOUNT_SIGN_OUT_EVENT)); });
  expect(statuses(root)).toHaveLength(0);
});

it("A2: the refresh timer updates a visible page every minute and skips hidden pages", async () => {
  const visibility = (state: "visible" | "hidden") => Object.defineProperty(page.window.document, "visibilityState", { value: state, configurable: true });
  jest.useFakeTimers();
  const root = await mount();
  expect(statuses(root)).toHaveLength(1);
  expired = true;
  visibility("hidden");
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(statuses(root)).toHaveLength(1);

  visibility("visible");
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(statuses(root)).toHaveLength(0);
});

const beforeYou = (admittedAt: string, newUntil: string | null = null) =>
  [{ server_id: PC, label: "Desk", added_at: admittedAt, last_seen_at: null, new_until: newUntil, admitted_at: admittedAt, admitted_before_you: true }];
const button = (root: Awaited<ReturnType<typeof mount>>, label: string) => {
  const found = buttons(root).find((node) => text(node) === label);
  if (found === undefined) throw new TypeError(`Missing ${label}`);
  return found;
};

it("#29: a PC added before this device joined is asked about in one card naming it, with Yes and No (remove) only; Yes hides it for good and removes nothing", async () => {
  const admittedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  listed = beforeYou(admittedAt, new Date(Date.now() + 3_600_000).toISOString());
  const root = await mount(null);
  const cards = statuses(root);
  expect(cards).toHaveLength(1);
  expect(spans(page.one('[role="status"]')).map(text)).toContain("Desk was added to your account before this device joined. Did you add it?");
  expect(buttons(root).map(text)).toEqual(["Yes", "No (remove)"]);
  await act(async () => button(root, "Yes").click());
  expect(statuses(root)).toHaveLength(0);
  expect(statuses(await mount(null))).toHaveLength(0);
  expect(service.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
});

it("#29: on a phone the card says this phone, in the owner's words", async () => {
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["ko"] });
  Object.defineProperty(page.window.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile" });
  Object.defineProperty(page.window.navigator, "maxTouchPoints", { configurable: true, value: 5 });
  listed = beforeYou(new Date(Date.now() - 86_400_000).toISOString());
  const root = await mount(null);
  expect(spans(page.one('[role="status"]')).map(text)).toContain("Desk가 이 폰이 들어오기 전에 계정에 추가됐어요. 직접 추가하셨나요?");
  expect(buttons(root).map(text)).toEqual(["네", "아니요(빼기)"]);
});

it("#29: No (remove) is the not-me removal: a refusal keeps the card with its alert, the service's confirmation clears it", async () => {
  listed = beforeYou(new Date(Date.now() - 86_400_000).toISOString());
  rejectDelete = true;
  const root = await mount(null);
  await act(async () => { button(root, "No (remove)").click(); });
  expect(page.one('[role="alert"]').textContent).toBe("The PC could not be removed. Try again.");
  expect(statuses(root)).toHaveLength(1);
  rejectDelete = false;
  listed = null;
  await act(async () => { button(root, "No (remove)").click(); });
  expect(service.requests.filter((request) => request.startsWith("DELETE"))).toEqual([`DELETE /v1/pcs/${PC}`]);
  expect(statuses(root)).toHaveLength(0);
});

it("C3 (first PC): a PC added under the first-PC exemption before this device joined is shown once after its 24 h", async () => {
  const admittedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  listed = beforeYou(admittedAt);
  const root = await mount();
  expect(statuses(root)).toHaveLength(1);
  await act(async () => button(root, "Yes").click());
  expect(statuses(await mount())).toHaveLength(0);
  // a lapsed PC this device was told about (or that needed two-step) is not shown again
  listed = [{ server_id: PC, label: "Desk", added_at: admittedAt, last_seen_at: null, new_until: null, admitted_at: admittedAt, admitted_before_you: false }];
  localStorage.clear();
  Object.defineProperty(localStorage, "setItem", { configurable: true, value: () => {} });
  localStorage.setItem("storage-test", "1");
  expect(localStorage.getItem("storage-test")).toBeNull();
  expect(statuses(await mount())).toHaveLength(0);
});

it("C3 (first PC): the fake marks a first-PC admit for a device whose key came later, and never a two-step admit", async () => {
  let clock = Date.now();
  const fresh = new FakeAccountService(() => clock);
  fresh.opensAll = true;
  const pc = async (token: string) => {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    expect((await fresh.fetch(`${ORIGIN}/v1/pcs/${PC}`, { method: "PUT", headers, body: JSON.stringify({ label: "Desk", public_key: Buffer.from(publicKey).toString("hex"), relay: "wss://relay.ovis.sh" }) })).ok).toBe(true);
    return (await fresh.fetch(`${ORIGIN}/v1/pcs/${PC}/admit`, { method: "POST", headers })).status;
  };
  const read = async (token: string) => ((await (await fresh.fetch(`${ORIGIN}/v1/pcs`, { headers: { authorization: `Bearer ${token}` } })).json()) as { pcs: { admitted_before_you: boolean }[] }).pcs[0]?.admitted_before_you;
  expect(await pc(fresh.issueToken("acct_first", { twoStep: null }))).toBe(200);
  const phone = fresh.issueToken("acct_first", { twoStep: null });
  expect(await read(phone)).toBe(false);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  clock += 60_000;
  fresh.registerSessionKey(phone, spki, "Phone");
  expect(await read(phone)).toBe(true);
  const other = new FakeAccountService();
  other.opensAll = true;
  const signed = other.issueToken("acct_twostep", { twoStep: true });
  const headers = { authorization: `Bearer ${signed}`, "content-type": "application/json" };
  await other.fetch(`${ORIGIN}/v1/pcs/${PC}`, { method: "PUT", headers, body: JSON.stringify({ label: "Desk", public_key: Buffer.from(publicKey).toString("hex"), relay: "wss://relay.ovis.sh" }) });
  expect((await other.fetch(`${ORIGIN}/v1/pcs/${PC}/admit`, { method: "POST", headers })).status).toBe(200);
  const later = other.issueToken("acct_twostep", { twoStep: null });
  other.registerSessionKey(later, spki, "Phone");
  expect(((await (await other.fetch(`${ORIGIN}/v1/pcs`, { headers: { authorization: `Bearer ${later}` } })).json()) as { pcs: { admitted_before_you: boolean }[] }).pcs[0]?.admitted_before_you).toBe(false);
});

it("A2: with no PC to tell of, the account's list is not read every minute", async () => {
  listed = [{ server_id: PC, label: "Desk", added_at: new Date(0).toISOString(), last_seen_at: null, new_until: null, admitted_at: null, admitted_before_you: false }];
  jest.useFakeTimers();
  await mount();
  const reads = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(([, init]) => init?.method === "GET").length;
  const before = reads();
  await act(async () => { jest.advanceTimersByTime(180_000); });
  expect(reads()).toBe(before);
});

it("A2: a focus or a page shown again reads the list at most once a minute while no PC is told of", async () => {
  listed = [{ server_id: PC, label: "Desk", added_at: new Date(0).toISOString(), last_seen_at: null, new_until: null, admitted_at: null, admitted_before_you: false }];
  jest.useFakeTimers();
  await mount();
  const reads = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(([, init]) => init?.method === "GET").length;
  const before = reads();
  for (let tab = 0; tab < 5; tab++) await act(async () => { page.window.dispatchEvent(new page.window.Event("focus")); });
  expect(reads()).toBe(before);
  await act(async () => { jest.advanceTimersByTime(60_000); });
  await act(async () => { page.window.dispatchEvent(new page.window.Event("focus")); });
  expect(reads()).toBe(before + 1);
});

it("A2: a page left open with no PC to tell of still reads the list every five minutes, so it hears of a new PC", async () => {
  listed = [];
  jest.useFakeTimers();
  await mount();
  const reads = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(([, init]) => init?.method === "GET").length;
  const before = reads();
  await act(async () => { jest.advanceTimersByTime(4 * 60_000); });
  expect(reads()).toBe(before);
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(reads()).toBe(before + 1);
});

it("PADD-11: where the step-2 switch is off the account's list is never read", async () => {
  jest.useFakeTimers();
  await mount(OTHER, undefined, false);
  const reads = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(([, init]) => init?.method === "GET").length;
  await act(async () => { jest.advanceTimersByTime(10 * 60_000); page.window.dispatchEvent(new page.window.Event("focus")); });
  expect(reads()).toBe(0);
});

it("PADD-11: a dismissed notice is nothing left to tell: focus reads come at most once a minute again", async () => {
  jest.useFakeTimers();
  await mount();
  await act(async () => page.one('button[aria-label="Close"]').click());
  await act(async () => { jest.advanceTimersByTime(60_000); });
  const reads = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(([, init]) => init?.method === "GET").length;
  const before = reads();
  for (let tab = 0; tab < 5; tab++) await act(async () => { page.window.dispatchEvent(new page.window.Event("focus")); });
  expect(reads()).toBeLessThanOrEqual(before + 1);
});

it("PADD-11: the PC whose own window this is, new or not, keeps no minute reads going: only notices shown here count", async () => {
  jest.useFakeTimers();
  // the only new PC is this window's own: nothing is shown, so the list is read only every five minutes
  await mount(PC);
  const reads = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(([, init]) => init?.method === "GET").length;
  const before = reads();
  await act(async () => { jest.advanceTimersByTime(4 * 60_000); });
  expect(reads()).toBe(before);
});

it("on an account with a signed list, tells of a PC another device added by the name the list seals, says which device, and removes it by an entry of the list", async () => {
  const w = listWorld(ACCOUNT, Date.now());
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const let_in = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, { wait: async () => {} });
  if (!let_in.allowed) throw new TypeError("The second device was not let in");
  await second.list.adopt(let_in.offer);
  const desk = await addListPc(w, first, "Desk in the study");
  // a PC only the account service names is none of the account's: nothing tells of it
  const rogue = generateKeyPair().publicKey;
  const headers = { authorization: `Bearer ${second.session.access_token}`, "content-type": "application/json" };
  expect((await w.fake.fetch(`${ORIGIN}/v1/pcs/${deriveServerId(rogue)}`, { method: "PUT", headers, body: JSON.stringify({ label: "Rogue", public_key: Buffer.from(rogue).toString("hex"), relay: "wss://relay.ovis.sh" }) })).ok).toBe(true);
  expect((await w.fake.fetch(`${ORIGIN}/v1/pcs/${deriveServerId(rogue)}/admit`, { method: "POST", headers })).ok).toBe(true);
  await second.list.sync();
  service = w.fake;
  spyOn(indexedAccountStore, "get").mockImplementation(second.store.get);
  spyOn(indexedAccountStore, "update").mockImplementation(second.store.update);
  setPageAccountList(second.list);
  try {
    const refreshed = Promise.withResolvers<void>();
    const root = await mount(null, refreshed.resolve);
    const said = () => statuses(root).flatMap((card) => spans(card).flatMap((node) => [...node.childNodes].filter((child) => child.nodeType === page.window.Node.TEXT_NODE).map((child) => child.nodeValue)));
    expect(statuses(root)).toHaveLength(1);
    expect(said()).toContain("New PC added to your account: Desk in the study");
    expect(said()).toContain("Added from Dana's phone.");
    const remove = buttons(root).find((node) => text(node) === "I didn't add this");
    if (remove === undefined) throw new TypeError("Missing removal action");
    const before = w.held().entries.length;
    await act(async () => { remove.click(); await refreshed.promise; });
    expect(w.fake.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
    expect(w.held().entries.slice(before).map((text) => readBody(entryFromText(text).body).kind)).toEqual(["remove", "epoch"]);
    expect([second.list.holdsPc(desk.endpoint), statuses(root)]).toEqual([false, []]);
    // the device that added it is told nothing
    setPageAccountList(first.list);
    spyOn(indexedAccountStore, "get").mockImplementation(first.store.get);
    const laptop = await addListPc(w, first, "Laptop");
    expect([first.list.holdsPc(laptop.endpoint), statuses(await mount(null))]).toEqual([true, []]);
  } finally { setPageAccountList(null); }
});

it("follows the account's list: the notice of a PC goes when another device puts that PC out, with no reload and no press here (M61)", async () => {
  const w = listWorld(ACCOUNT, Date.now());
  const first = await w.device({ label: "Dana's phone" });
  await first.list.sync();
  const second = await w.device({ label: "Dana's tablet" });
  await second.list.sync();
  const let_in = await allowDevice(first.list, { key: (await second.keys()).key, label: "Dana's tablet", os: "android" }, { wait: async () => {} });
  if (!let_in.allowed) throw new TypeError("The second device was not let in");
  await second.list.adopt(let_in.offer);
  const desk = await addListPc(w, first, "Desk in the study");
  await second.list.sync();
  service = w.fake;
  spyOn(indexedAccountStore, "get").mockImplementation(second.store.get);
  spyOn(indexedAccountStore, "update").mockImplementation(second.store.update);
  setPageAccountList(second.list);
  try {
    const root = await mount(null);
    expect(statuses(root)).toHaveLength(1);
    // the phone removes the PC; the tablet's page reads its list by its own clock, and nothing else tells the notice
    expect(await removeListPc(first.list, desk.endpoint, { wait: async () => {} })).toEqual({ removed: true });
    await act(async () => { await second.list.sync(); for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve)); });
    expect([second.list.holdsPc(desk.endpoint), statuses(root)]).toEqual([false, []]);
  } finally { setPageAccountList(null); }
});
