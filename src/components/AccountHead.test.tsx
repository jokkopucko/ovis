import { afterEach, beforeEach, expect, it, jest, spyOn } from "bun:test";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { keepShellSignOut, useHostedSignIn } from "../lib/account/hostedSignIn.ts";
import { ACCOUNT_SIGN_OUT_EVENT } from "../lib/account/service.ts";
import { ACCOUNT_SESSION_EVENT, indexedAccountStore, memoryAccountStore, type AccountStore } from "../lib/account/store.ts";
import { translate } from "../lib/i18n.ts";
import type { RowMenuItem } from "./RowMenu.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { HostedAccountGroup, hostedSignOutItems } from "./AccountHead.tsx";

const session = { account: "acct", provider: "github", service: "https://account.example", sign_in_id: "test", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600_000 } as const;
const english = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

let store: AccountStore;
let renderer: ReactTestRenderer | null = null;
let more: RowMenuItem[] = [];
const replaced = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
  store = memoryAccountStore();
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location: new URL("https://app.ovis.sh/pc/abc"), setTimeout, clearTimeout, setInterval, clearInterval }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    replaced.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  spyOn(indexedAccountStore, "get").mockImplementation((name) => store.get(name));
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = null;
  more = [];
  keepShellSignOut(null);
  jest.restoreAllMocks();
  for (const [key, descriptor] of replaced) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  replaced.clear();
});

function Page() {
  const signIn = useHostedSignIn();
  more = hostedSignOutItems(signIn, english);
  return <HostedAccountGroup signIn={signIn} />;
}

async function render(): Promise<void> {
  await act(async () => { renderer = create(<SettingsProvider><Page /></SettingsProvider>); });
}

const buttons = (): ReactTestInstance[] => renderer?.root.findAll((node) => node.type === "button") ?? [];

async function fire(name: string): Promise<void> {
  await act(async () => { window.dispatchEvent(new Event(name)); });
}

it("Settings shows the hosted sign-in with Sign out, which runs the overview's own Sign out", async () => {
  const signOut = jest.fn();
  keepShellSignOut(signOut);
  await store.set("session", session);
  await render();
  const [button] = buttons();
  expect(buttons()).toHaveLength(1);
  expect(button?.props["aria-label"]).toBe("Sign out of GitHub");
  expect(button?.children).toEqual(["Sign out"]);
  await act(async () => { button?.props.onClick(); });
  expect(signOut).toHaveBeenCalledTimes(1);
});

it("the phone More lists Sign out last, which runs the overview's own Sign out", async () => {
  const signOut = jest.fn();
  keepShellSignOut(signOut);
  await store.set("session", session);
  await render();
  expect(more.map((item) => [item.id, item.label])).toEqual([["sign-out", "Sign out"]]);
  more[0]?.run();
  expect(signOut).toHaveBeenCalledTimes(1);
});

it("shows neither while signed out, and follows a sign-in and a sign-out made meanwhile", async () => {
  keepShellSignOut(jest.fn());
  await render();
  expect(buttons()).toHaveLength(0);
  expect(more).toEqual([]);
  await store.set("session", session);
  await fire(ACCOUNT_SESSION_EVENT);
  expect(buttons()).toHaveLength(1);
  expect(more).toHaveLength(1);
  await store.set("session", undefined);
  await fire(ACCOUNT_SIGN_OUT_EVENT);
  expect(buttons()).toHaveLength(0);
  expect(more).toEqual([]);
});

it("shows neither off the hosted app, whatever sign-in is stored", async () => {
  await store.set("session", session);
  await render();
  expect(buttons()).toHaveLength(0);
  expect(more).toEqual([]);
});
