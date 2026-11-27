import { afterEach, beforeEach, expect, it, jest, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { keepShellAccount, useHostedSignIn } from "../lib/account/hostedSignIn.ts";
import { ACCOUNT_SIGN_OUT_EVENT } from "../lib/account/service.ts";
import { ACCOUNT_SESSION_EVENT, indexedAccountStore, memoryAccountStore, type AccountStore } from "../lib/account/store.ts";
import { translate } from "../lib/i18n.ts";
import type { RowMenuItem } from "./RowMenu.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { HostedAccountGroup, hostedAccountItems } from "./AccountHead.tsx";

const session = { account: "acct", provider: "github", service: "https://account.example", sign_in_id: "test", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600_000 } as const;
const english = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

let store: AccountStore;
let page: Page;
let more: RowMenuItem[] = [];
const openAccount = jest.fn();

beforeEach(() => {
  store = memoryAccountStore();
  page = openPage("https://app.ovis.sh/pc/abc");
  spyOn(indexedAccountStore, "get").mockImplementation((name) => store.get(name));
});

afterEach(async () => {
  await page.close();
  more = [];
  openAccount.mockClear();
  keepShellAccount(null);
  jest.restoreAllMocks();
});

function AccountProbe() {
  const signIn = useHostedSignIn();
  more = hostedAccountItems(signIn, english, openAccount);
  return <HostedAccountGroup signIn={signIn} />;
}

async function render(): Promise<void> {
  await page.render(<SettingsProvider><AccountProbe /></SettingsProvider>);
}

const actions = (signOut: () => void) => ({ signOut, leave: jest.fn(), deleteAccount: async () => null, signOutEverywhere: async () => null });

const buttons = () => [...page.container.querySelectorAll("button")];

async function fire(name: string): Promise<void> {
  await act(async () => { page.window.dispatchEvent(new page.window.Event(name)); });
}

it("Settings shows the hosted sign-in with Manage account and Sign out, which runs the hosted app's own Sign out", async () => {
  const signOut = jest.fn();
  keepShellAccount(actions(signOut));
  await store.set("session", session);
  await render();
  expect(buttons().map((node) => node.textContent)).toEqual(["Manage account", "Sign out"]);
  const button = buttons()[1];
  expect(button?.getAttribute("aria-label")).toBe("Sign out of GitHub");
  expect(button?.textContent).toBe("Sign out");
  await act(async () => { button?.click(); });
  expect(signOut).toHaveBeenCalledTimes(1);
  // it names the account it shows: a sign-in another tab stored meanwhile is not the one ended
  expect(signOut).toHaveBeenCalledWith({ account: "acct", scope: null });
});

it("the phone More lists the account, which opens it, then Sign out, which runs the hosted app's own Sign out", async () => {
  const signOut = jest.fn();
  keepShellAccount(actions(signOut));
  await store.set("session", session);
  await render();
  expect(more.map((item) => [item.id, item.label])).toEqual([["account", "Signed in with GitHub"], ["sign-out", "Sign out"]]);
  more[0]?.run();
  expect(openAccount).toHaveBeenCalledTimes(1);
  expect(signOut).not.toHaveBeenCalled();
  more[1]?.run();
  expect(signOut).toHaveBeenCalledTimes(1);
});

it("shows neither while signed out, and follows a sign-in and a sign-out made meanwhile", async () => {
  keepShellAccount(actions(jest.fn()));
  await render();
  expect(buttons()).toHaveLength(0);
  expect(more).toEqual([]);
  await store.set("session", session);
  await fire(ACCOUNT_SESSION_EVENT);
  expect(buttons()).toHaveLength(2);
  expect(more).toHaveLength(2);
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
