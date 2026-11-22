import { afterEach, beforeEach, expect, it, jest, spyOn } from "bun:test";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { generateKeyPair } from "../../shared/relay-e2ee.ts";
import { deriveServerId } from "../../shared/relay-server-proof.ts";
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
let renderer: ReactTestRenderer | undefined;
let browser: EventTarget;
let service: FakeAccountService;
let store: ReturnType<typeof memoryAccountStore>;
let restore: () => void;
let expired = false;
let rejectDelete = false;
/** what GET /v1/pcs answers instead of the fake, when set */
let listed: unknown[] | null = null;

beforeEach(async () => {
  browser = new EventTarget();
  const storage = new Map<string, string>();
  for (const [key, value] of Object.entries({
    window: browser, location: new URL("https://app.ovis.sh/"), IS_REACT_ACT_ENVIRONMENT: true,
    document: Object.assign(new EventTarget(), {
      visibilityState: "visible", querySelector: () => null,
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    navigator: { languages: ["en"] },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  store = memoryAccountStore();
  service = new FakeAccountService();
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
    if (listed !== null && init?.method === "GET") return Response.json({ pcs: listed });
    if (expired && init?.method === "GET") return Response.json({ pcs: [
      { server_id: PC, label: "Desk", added_at: new Date(0).toISOString(), last_seen_at: null, new_until: new Date(1).toISOString() },
    ] });
    return service.fetch(input, init);
  }, { preconnect: fetch.preconnect }));
  restore = () => { get.mockRestore(); update.mockRestore(); send.mockRestore(); };
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  jest.useRealTimers();
  renderer = undefined;
  restore?.();
  for (const [key, descriptor] of globals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
  globals.clear();
});

/** `null`: a window that is no PC's own (a phone, the relay page); the default is another PC's own window */
async function mount(ownWindowOf: string | null = OTHER, onRemoved?: () => void, enabled = true) {
  await act(async () => {
    renderer?.unmount();
    renderer = create(<SettingsProvider><NewPcNotices enabled={enabled} ownWindowOf={ownWindowOf ?? undefined} onRemoved={onRemoved} /></SettingsProvider>);
  });
  if (renderer === undefined) throw new TypeError("Notice did not mount");
  return renderer.root;
}

it("A2: a new PC is announced in every window but the PC's own local window, a window into that PC through the relay included", async () => {
  const other = await mount();
  expect(other.findByProps({ role: "status" }).findAllByType("span").some(({ children }) => children.includes("New PC added to your account: Desk"))).toBe(true);
  // a phone that opened the new PC through the relay is another device: it is told
  Object.defineProperty(globalThis, "location", { value: new URL(`https://app.ovis.sh/s/${PC}/`), configurable: true });
  expect((await mount(null)).findAllByProps({ role: "status" })).toHaveLength(1);
  // the PC's own local window added it
  expect((await mount(PC)).findAllByProps({ role: "status" })).toHaveLength(0);
});

it("A2: Not me deletes the PC once, clears the card, and refreshes the account list", async () => {
  const refreshed = Promise.withResolvers<void>();
  const root = await mount(OTHER, refreshed.resolve);
  const remove = root.findAllByType("button").find(({ children }) => children.includes("I didn't add this"));
  if (remove === undefined) throw new TypeError("Missing removal action");
  await act(async () => { await remove.props.onClick(); await refreshed.promise; });
  expect(service.requests.filter((request) => request.startsWith("DELETE"))).toEqual([`DELETE /v1/pcs/${PC}`]);
  expect(root.findAllByProps({ role: "status" })).toHaveLength(0);
});

it("A2: a failed removal leaves the notice in place with a retryable alert", async () => {
  rejectDelete = true;
  const root = await mount();
  const remove = root.findAllByType("button").find(({ children }) => children.includes("I didn't add this"));
  if (remove === undefined) throw new TypeError("Missing removal action");
  await act(async () => { await remove.props.onClick(); });
  expect(root.findByProps({ role: "alert" }).children).toEqual(["The PC could not be removed. Try again."]);
  expect(remove.props.disabled).toBe(false);
});

it("A2: Close hides the notice on this device and keeps it hidden after remount", async () => {
  const root = await mount();
  await act(async () => root.findByProps({ "aria-label": "Close" }).props.onClick());
  expect(root.findAllByProps({ role: "status" })).toHaveLength(0);
  expect((await mount()).findAllByProps({ role: "status" })).toHaveLength(0);
  expect(service.requests.filter((request) => request.startsWith("DELETE"))).toEqual([]);
});

it("A2: a PC whose new-until timestamp has passed is not announced", async () => {
  expired = true;
  expect((await mount()).findAllByProps({ role: "status" })).toHaveLength(0);
});

it("A2: ending the sign-in clears the previous account's notices", async () => {
  const root = await mount();
  expect(root.findAllByProps({ role: "status" })).toHaveLength(1);
  await store.update("session", () => undefined);
  await act(async () => { browser.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT)); });
  expect(root.findAllByProps({ role: "status" })).toHaveLength(0);
});

it("A2: the refresh timer updates a visible page every minute and skips hidden pages", async () => {
  const visibility = (state: "visible" | "hidden") => Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  jest.useFakeTimers();
  const root = await mount();
  expect(root.findAllByProps({ role: "status" })).toHaveLength(1);
  expired = true;
  visibility("hidden");
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(root.findAllByProps({ role: "status" })).toHaveLength(1);

  visibility("visible");
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(root.findAllByProps({ role: "status" })).toHaveLength(0);
});

it("C3 (first PC): a PC added under the first-PC exemption before this device joined is shown once after its 24 h, with the same removal", async () => {
  const admittedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
  listed = [{ server_id: PC, label: "Desk", added_at: admittedAt, last_seen_at: null, new_until: null, admitted_at: admittedAt, admitted_before_you: true }];
  const root = await mount();
  expect(root.findByProps({ role: "status" }).findAllByType("span").some(({ children }) => children.includes("New PC added to your account: Desk"))).toBe(true);
  await act(async () => root.findByProps({ "aria-label": "Close" }).props.onClick());
  expect((await mount()).findAllByProps({ role: "status" })).toHaveLength(0);
  // a lapsed PC this device was told about (or that needed two-step) is not shown again
  listed = [{ server_id: PC, label: "Desk", added_at: admittedAt, last_seen_at: null, new_until: null, admitted_at: admittedAt, admitted_before_you: false }];
  localStorage.setItem = () => {};
  expect((await mount()).findAllByProps({ role: "status" })).toHaveLength(0);
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
  for (let tab = 0; tab < 5; tab++) await act(async () => { browser.dispatchEvent(new Event("focus")); });
  expect(reads()).toBe(before);
  await act(async () => { jest.advanceTimersByTime(60_000); });
  await act(async () => { browser.dispatchEvent(new Event("focus")); });
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
  await act(async () => { jest.advanceTimersByTime(10 * 60_000); browser.dispatchEvent(new Event("focus")); });
  expect(reads()).toBe(0);
});

it("PADD-11: a dismissed notice is nothing left to tell: focus reads come at most once a minute again", async () => {
  jest.useFakeTimers();
  const root = await mount();
  await act(async () => root.findByProps({ "aria-label": "Close" }).props.onClick());
  await act(async () => { jest.advanceTimersByTime(60_000); });
  const reads = () => (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls.filter(([, init]) => init?.method === "GET").length;
  const before = reads();
  for (let tab = 0; tab < 5; tab++) await act(async () => { browser.dispatchEvent(new Event("focus")); });
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
