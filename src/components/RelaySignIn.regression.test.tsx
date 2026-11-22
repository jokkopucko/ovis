import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import type { ReactNode } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { useLinkPageSignIn } from "../lib/account/useLinkPageSignIn.ts";
import { fakeIndexedDB } from "../lib/indexedDB.fake.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AccountSection } from "./AccountSection.tsx";
import { RelayTab } from "./ConnectPhoneDialog.tsx";

const SERVICE = "https://account.ovis.example";
const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let service: FakeAccountService;
let approve: boolean;
let completeUrl: boolean;
let firstPoll: ReturnType<typeof Promise.withResolvers<void>>;
let code: string;
let signal: AbortSignal | null;
let opened: string[];
let openAccount: ReturnType<typeof mock<() => void>>;

const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const button = (name: string) => {
  const found = renderer?.root.findAll((node) => node.type === "button" && text(node) === name)[0];
  if (found === undefined) throw new Error(`Missing button: ${name}`);
  return found;
};
const mount = async (child: ReactNode) => {
  await act(async () => { renderer = create(<SettingsProvider>{child}</SettingsProvider>); });
};
const online = { phase: "online", relay: "wss://relay.ovis.example", app: "https://app.ovis.example", sessions: 0, blocked: null, error: null } as const;
const relay = { status: online, unsupported: false, readFailed: false, pending: false, request: async () => online, reread: () => {} };
const relayView = () => <RelayTab relay={relay} closesGate={false} signedIn={false} joinBySignIn={false} phone={false}
  account={{ service: SERVICE, onOpen: openAccount, onSignedIn() {} }} />;

beforeEach(() => {
  service = new FakeAccountService();
  service.offerLinkPage(["github"]);
  approve = false;
  completeUrl = true;
  firstPoll = Promise.withResolvers<void>();
  code = "";
  signal = null;
  opened = [];
  openAccount = mock(() => undefined);
  const events = new EventTarget();
  const globals = {
    IS_REACT_ACT_ENVIRONMENT: true,
    indexedDB: fakeIndexedDB().factory,
    navigator: { languages: ["en"], userAgent: "Linux", maxTouchPoints: 0 },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    document: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: (selector: string) => selector === 'meta[name="ovis-pc-account-service"]' ? { getAttribute: () => SERVICE } : null,
    },
    window: {
      isSecureContext: true, location: { href: "https://pc.example/" },
      open: (url: string) => { opened.push(url); return { opener: null, location: { href: url }, close() {} }; },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.origin !== SERVICE) return Response.json({}, { status: 404 });
    if (url.pathname === "/v1/token") {
      signal = init?.signal ?? null;
      if (approve) service.approveOnLinkPage(code, "acct_review", "github");
      firstPoll.resolve();
    }
    const response = await service.fetch(input, init);
    if (!url.pathname.startsWith("/v1/signin/") || !response.ok) return response;
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("user_code" in body) || typeof body.user_code !== "string") throw new Error("Missing fixture code");
    code = body.user_code;
    return Response.json({ ...body, interval: 0.001, ...(completeUrl ? {} : { verification_uri_complete: null }) });
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetchImpl, { preconnect: fetch.preconnect }));
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  mock.restore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
  descriptors.clear();
});

it("honors a committed session when cancellation arrives before finish resolves", async () => {
  approve = true;
  let actions: ReturnType<typeof useLinkPageSignIn> | undefined;
  const signedIn = mock(() => undefined);
  const released = Promise.withResolvers<void>();
  Object.defineProperty(navigator, "locks", { value: {
    request: async <T,>(_name: string, work: () => Promise<T>) => {
      const kept = await work();
      actions?.cancel();
      released.resolve();
      return kept;
    },
  } });
  function Harness() {
    actions = useLinkPageSignIn(SERVICE, signedIn);
    return <output>{actions.state.kind}</output>;
  }
  await mount(<Harness />);
  await act(async () => { actions?.start(); await released.promise; });
  expect((await indexedAccountStore.get("session"))?.account).toBe("acct_review");
  expect(renderer?.root.findByType("output").children).toEqual(["signed-in"]);
  expect(signedIn).toHaveBeenCalledTimes(1);
});

it("keeps the active account code and polling when recheck changes", async () => {
  await mount(<AccountSection recheck={0} />);
  await act(async () => { button("Sign in").props.onClick(); await firstPoll.promise; });
  const waitingCode = renderer?.root.findByType("output").children;
  if (waitingCode === undefined) throw new Error("The sign-in has no code");
  await act(async () => { renderer?.update(<SettingsProvider><AccountSection recheck={1} /></SettingsProvider>); });
  expect(renderer?.root.findAllByType("output").map((node) => node.children)).toEqual([waitingCode]);
  expect(signal?.aborted).toBe(false);
});

it("says where to sign in, with no button and no tab, when only a desktop provider is offered", async () => {
  service.offerSignIns(["apple"], []);
  service.offerLinkPage([]);
  await mount(relayView());
  expect(text(renderer!.root)).toContain("Sign in on this PC's own screen, or in the Ovis app.");
  expect(renderer!.root.findAll((node) => node.type === "button" && /Sign in|Continue with/.test(text(node)))).toHaveLength(0);
  expect(openAccount).not.toHaveBeenCalled();
  expect(opened).toEqual([]);
});

it.each([true, false])("requires code entry only when the opened page lacks a complete URL (%s)", async (complete) => {
  completeUrl = complete;
  await mount(relayView());
  await act(async () => { button("Sign in to Ovis").props.onClick(); await firstPoll.promise; });
  const waiting = renderer?.root.findByProps({ "data-testid": "relay-signin-waiting" });
  const description = waiting?.findAllByType("p")[0];
  expect(description === undefined ? false : /enter this code/i.test(text(description))).toBe(!complete);
  expect(waiting?.findByType("a").props.href).toBe(complete ? `${SERVICE}/link?code=${code}` : `${SERVICE}/link`);
});
