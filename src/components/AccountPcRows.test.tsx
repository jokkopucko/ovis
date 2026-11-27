import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { MyPc } from "../lib/account/myPcs.ts";
import { SignedOutError, type AccountService } from "../lib/account/service.ts";
import type { AccountSession } from "../lib/account/store.ts";
import { SettingsProvider } from "../lib/settings.ts";

import { AccountPcRows, NoAccountPcHint, signInOfAccount } from "./AccountPcs.tsx";

const DESK = "a".repeat(32);
const LAPTOP = "b".repeat(32);
// a PC in the account (it took its place there), which this device is not paired with
const pc = (server_id: string, name: string): MyPc => ({ server_id, name, state: "needs-approval", last_seen_at: null, added_at: null, listed: true, joined: true, paired: false, linked: false });

const NOW = Date.parse("2026-11-11T00:00:00Z");
const gone = (server_id: string, name: string): MyPc => ({ ...pc(server_id, name), state: "offline", last_seen_at: "2026-11-01T00:00:00Z", added_at: "2026-10-01T00:00:00Z" });

const textOf = (node: Element): string => node.textContent ?? "";

describe("the account's PCs in a PC's own Settings", () => {
  let page: Page;
  beforeEach(() => { page = openPage("https://pc.example/"); });
  afterEach(async () => { await page.close(); });

  const mount = async (node: ReactNode): Promise<HTMLElement> => {
    await page.render(createElement(SettingsProvider, { children: node }));
    return page.container;
  };

  it("gives the rows no action of their own (an offline one is removed in Manage account), and no sentence or link under them", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [pc(DESK, "Desk"), gone(LAPTOP, "Laptop")], now: NOW, onChanged: () => {} }));
    expect(root.querySelectorAll("a")).toHaveLength(0);
    const [desk, laptop] = [...root.querySelectorAll("li")].map(textOf);
    expect(desk).toBe("DeskPCIn your account");
    expect(laptop).toStartWith("LaptopPCOffline · ");
    expect(root.querySelectorAll("button")).toHaveLength(0);
  });

  it("draws nothing when the account lists no other PC", async () => {
    const root = await mount(createElement(AccountPcRows, { pcs: [], now: NOW, onChanged: () => {} }));
    expect(root.querySelectorAll("a, li")).toHaveLength(0);
  });

  it("says an account with no PC has none, in words that hold for every way of signing in", async () => {
    const root = await mount(createElement(NoAccountPcHint, { provider: "apple" }));
    expect(textOf(root)).toBe("No PC in this account yet. Signed in with Apple: each way of signing in is a separate Ovis account until you link them.");
  });
});

describe("signInOfAccount", () => {
  const session = (account: string): AccountSession => ({ service: "https://account.example", account, provider: "github", access_token: "a", refresh_token: "r", expires_at: 0, sign_in_id: `id-${account}` });
  const serviceWith = (stored: AccountSession | undefined): Pick<AccountService, "session"> => ({ session: async () => stored });

  it("is the sign-in whose list is shown", async () => {
    expect(await signInOfAccount(serviceWith(session("acct-1")), "acct-1")).toEqual(session("acct-1"));
  });

  it("is none once another sign-in, or none, is stored", async () => {
    await expect(signInOfAccount(serviceWith(session("acct-2")), "acct-1")).rejects.toBeInstanceOf(SignedOutError);
    await expect(signInOfAccount(serviceWith(undefined), "acct-1")).rejects.toBeInstanceOf(SignedOutError);
  });
});

describe("Settings → Devices and PCs", () => {
  it("draws the Account group above the device list, outside More settings", () => {
    const source = readFileSync(new URL("./SettingsDevicesPage.tsx", import.meta.url), "utf8");
    const page = source.slice(source.indexOf("function DevicesPage("), source.indexOf("function UseRelayHere("));
    const account = page.indexOf("<AccountSection ");
    const fold = page.indexOf('<SettingsFold kind="more"');
    expect(account).toBeGreaterThan(-1);
    expect(page.indexOf("<AccountSection ", account + 1)).toBe(-1);
    expect(account).toBeLessThan(page.indexOf('<SettingsGroup section="devices">'));
    expect(account).toBeLessThan(fold);
    expect(page.slice(page.indexOf("const openAccount"), page.indexOf("const accountService"))).not.toContain("details");
  });

  it("closes Settings after a sign-in on Add a connection only where closedBySignIn says so", () => {
    const source = readFileSync(new URL("./SettingsDevicesPage.tsx", import.meta.url), "utf8");
    const page = source.slice(source.indexOf("function DevicesPage("), source.indexOf("function UseRelayHere("));
    const start = page.indexOf("onSignedIn:");
    const signedIn = page.slice(start, page.indexOf("...(opensAll", start));
    expect(signedIn).toContain("closedBySignIn(home, connectAsked)");
    expect(page.match(/onHome\(\)/g)).toHaveLength(1);
    expect(signedIn).toMatch(/=== "settings"\) onHome\(\)/);
  });
});
