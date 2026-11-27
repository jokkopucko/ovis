import { describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { AccountAsker as Asker } from "../../shared/account-asker.ts";
import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AccountApprovalCard, AccountAsker } from "./AccountApprovalPrompt.tsx";
import { restsOnAdmission } from "./AccountApprovals.tsx";

async function render(asker: Asker, language: string): Promise<string> {
  const page = openPage();
  try {
    await page.render(createElement(SettingsProvider, null, createElement(AccountAsker, { asker, language })));
    return page.container.innerHTML;
  } finally {
    await page.close();
  }
}

// The approval card's last line of defence against a phished device code (RFC 8628 section 5.4):
// what the account service saw of the device asking, so a request from a stranger looks like one.
describe("who is asking, on the approval card", () => {
  it("names the system the device sent and the place its request came from, in the app's language", async () => {
    const html = await render({ os: "ios", country: "KR", city: "Seoul" }, "en");
    expect(html).toContain("iOS");
    expect(html).toContain("Seoul, South Korea");
    expect(html).toContain('data-place="known"');
    expect(await render({ os: null, country: "JP", city: null }, "ko")).toContain("일본");
  });

  it("says when the place is unknown instead of leaving it out", async () => {
    const html = await render({ os: "windows", country: null, city: null }, "en");
    expect(html).toContain("Windows");
    expect(html).toContain('data-place="unknown"');
  });
});

describe("approving a device that asks to join the account", () => {
  const request: RemotePairingRequest = { id: "r1", label: "Hako's iPhone", intent: "account", choices: ["111111", "222222", "333333"], expires_at: "", key: "k" };

  type Decision = [decision: "approve" | "decline", digits?: string];
  async function onCard<T>(asker: Asker | undefined, decided: Decision[], walk: (root: Page) => Promise<T>, pc?: { name?: string }, told: { list?: true; confirmed?: true; list_unknown?: true } = {}, followsList = false): Promise<T> {
    const page = openPage("http://127.0.0.1:7421/");
    const saved = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: page.window.HTMLElement });
    try {
      await page.render(createElement(SettingsProvider, null, createElement(AccountApprovalCard, { request: pc ? { ...request, intent: "pc", vouched: true } : { ...request, ...told }, vouchedName: pc?.name, pcName: "p620", pcCount: 2, asker, followsList, onDecide: async (...decision: Decision) => { decided.push(decision); } })));
      return await walk(page);
    } finally {
      await page.close();
      if (saved) Object.defineProperty(globalThis, "HTMLElement", saved);
      else Reflect.deleteProperty(globalThis, "HTMLElement");
    }
  }

  const radios = (root: Page) => [...root.container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
  const approveOf = (root: Page) => root.one<HTMLButtonElement>('button[class="btn btn-primary"]');
  const approveButton = (asker: Asker | undefined) => onCard(asker, [], async (root) => {
    await act(async () => { radios(root)[0]!.click(); });
    return { disabled: approveOf(root).disabled, numbersDisabled: radios(root).every((node) => node.disabled) };
  });

  it.each([false, true])("a vouched card offers no digit pick and allows only a verified name: %s", async verified => {
    const decided: Decision[] = [];
    await onCard(undefined, decided, async root => {
      expect(radios(root)).toHaveLength(0);
      const buttons = [...root.container.querySelectorAll("button")];
      expect(buttons.map(button => button.textContent)).toEqual(verified ? ["Deny", "Allow"] : ["Deny"]);
      const lead = root.one('[class="account-approval-ask"]').textContent;
      if (verified) expect(lead).toBe("Trusted listing");
      expect(lead).not.toContain(request.label);
      await act(async () => { buttons[verified ? 1 : 0]!.click(); });
    }, verified ? { name: "Trusted listing" } : {});
    expect(decided).toEqual([[verified ? "approve" : "decline", undefined]]);
  });

  it("keeps the number pick: three numbers, none picked, Approve held until one is, and the picked one sent", async () => {
    const decided: Decision[] = [];
    const seen = await onCard({ os: null, country: null, city: null }, decided, async (root) => {
      const before = { labels: radios(root).map((node) => node.getAttribute("aria-label")), shown: radios(root).map((node) => node.textContent), checked: radios(root).map((node) => node.getAttribute("aria-checked")), approveHeld: approveOf(root).disabled };
      await act(async () => { radios(root)[1]!.click(); });
      const after = { checked: radios(root).map((node) => node.getAttribute("aria-checked")), approveHeld: approveOf(root).disabled };
      await act(async () => { approveOf(root).click(); });
      return { before, after };
    });
    expect(seen).toEqual({
      before: { labels: request.choices.map((choice) => choice.split("").join(" ")), shown: ["111 111", "222 222", "333 333"], checked: ["false", "false", "false"], approveHeld: true },
      after: { checked: ["false", "true", "false"], approveHeld: false },
    });
    expect(decided).toEqual([["approve", "222222"]]);
  });

  it("holds Approve for a join into the account's list until the new device's person said that the numbers match, and says what to press there", async () => {
    const held = (told: { list?: true; confirmed?: true }) => onCard({ os: null, country: null, city: null }, [], async (root) => {
      await act(async () => { radios(root)[1]!.click(); });
      return { approveHeld: approveOf(root).disabled, says: [...root.container.querySelectorAll('[class="account-approval-hint"][role="status"]')].map((node) => node.textContent) };
    }, undefined, told);
    expect(await held({ list: true })).toEqual({ approveHeld: true, says: ["First press “The numbers match” on Hako's iPhone"] });
    expect(await held({ list: true, confirmed: true })).toEqual({ approveHeld: false, says: [] });
    // any other join is approved as before, whether or not the device confirmed yet
    expect(await held({})).toEqual({ approveHeld: false, says: [] });
  });

  it("holds Approve for a join the PC cannot let in (an app older than lists), and says to update that app, never to approve it on the PC", async () => {
    const held = (followsList: boolean) => onCard({ os: null, country: null, city: null }, [], async (root) => {
      await act(async () => { radios(root)[1]!.click(); });
      return { approveHeld: approveOf(root).disabled, says: [...root.container.querySelectorAll('[class="account-approval-hint"][role="status"]')].map((node) => node.textContent) };
    }, undefined, { list_unknown: true }, followsList);
    const words = "p620 cannot let Hako's iPhone in: p620 lets devices into your account by its signed list, and Hako's iPhone asked as an Ovis older than 0.5.10 does. Update Ovis on Hako's iPhone, then have it ask to join again.";
    expect(await held(true)).toEqual({ approveHeld: true, says: [words] });
    expect(await held(false)).toEqual({ approveHeld: true, says: [words] });
  });

  it("holds Approve for a join that brought no card on a PC that lets devices in by the list, and says to approve it on that PC's own screen", async () => {
    const held = (told: { list?: true; confirmed?: true }, followsList: boolean) => onCard({ os: null, country: null, city: null }, [], async (root) => {
      await act(async () => { radios(root)[1]!.click(); });
      return { approveHeld: approveOf(root).disabled, says: [...root.container.querySelectorAll('[class="account-approval-hint"][role="status"]')].map((node) => node.textContent) };
    }, undefined, told, followsList);
    expect(await held({}, true)).toEqual({ approveHeld: true, says: ["Approve Hako's iPhone on p620's own screen"] });
    // a carded join there waits for the press as before, and on a PC that follows no list nothing changes
    expect(await held({ list: true, confirmed: true }, true)).toEqual({ approveHeld: false, says: [] });
    expect(await held({}, false)).toEqual({ approveHeld: false, says: [] });
  });

  it("waits to approve until it knows who is asking, then lets a picked number approve", async () => {
    expect(await approveButton(undefined)).toEqual({ disabled: true, numbersDisabled: true });
    expect(await approveButton({ os: null, country: null, city: null })).toEqual({ disabled: false, numbersDisabled: false });
  });
});

// another PC of the account vouched for (pair-intent-pc-vouched) is asked as "pair this PC", so nothing is signed for it,
// yet its card says who is asking and its approval checks the admission, as an account join's does
describe("which requests rest on an admission", () => {
  const request = (extra: Partial<RemotePairingRequest>): RemotePairingRequest => ({ id: "r1", label: "Ovis on Desk", intent: "pc", choices: ["111111", "222222", "333333"], expires_at: "", key: "k", ...extra });
  it("an account join and another PC of the account vouched for do; any other request for this PC does not", () => {
    expect(restsOnAdmission(request({ intent: "account" }))).toBe(true);
    expect(restsOnAdmission(request({ vouched: true }))).toBe(true);
    expect(restsOnAdmission(request({}))).toBe(false);
    expect(restsOnAdmission(undefined)).toBe(false);
  });
});
