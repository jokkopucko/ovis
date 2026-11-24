import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";

import type { AccountAsker as Asker } from "../../shared/account-asker.ts";
import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AccountApprovalCard, AccountAsker } from "./AccountApprovalPrompt.tsx";
import { restsOnAdmission } from "./AccountApprovals.tsx";

function render(asker: Asker, language: string): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(AccountAsker, { asker, language })));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

// The approval card's last line of defence against a phished device code (RFC 8628 section 5.4):
// what the account service saw of the device asking, so a request from a stranger looks like one.
describe("who is asking, on the approval card", () => {
  it("names the system the device sent and the place its request came from, in the app's language", () => {
    const html = render({ os: "ios", country: "KR", city: "Seoul" }, "en");
    expect(html).toContain("iOS");
    expect(html).toContain("Seoul, South Korea");
    expect(html).toContain('data-place="known"');
    expect(render({ os: null, country: "JP", city: null }, "ko")).toContain("일본");
  });

  it("says when the place is unknown instead of leaving it out", () => {
    const html = render({ os: "windows", country: null, city: null }, "en");
    expect(html).toContain("Windows");
    expect(html).toContain('data-place="unknown"');
  });
});

describe("approving a device that asks to join the account", () => {
  const request: RemotePairingRequest = { id: "r1", label: "Hako's iPhone", intent: "account", choices: ["111111", "222222", "333333"], expires_at: "", key: "k" };

  type Decision = [decision: "approve" | "decline", digits?: string];
  async function onCard<T>(asker: Asker | undefined, decided: Decision[], walk: (root: ReturnType<typeof create>["root"]) => Promise<T>, pc?: { name?: string }, told: { list?: true; confirmed?: true } = {}, followsList = false): Promise<T> {
    const keys = ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"];
    const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null, querySelectorAll: () => [], activeElement: null,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
    let renderer: ReturnType<typeof create> | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(SettingsProvider, null, createElement(AccountApprovalCard, { request: pc ? { ...request, intent: "pc", vouched: true } : { ...request, ...told }, vouchedName: pc?.name, pcName: "p620", pcCount: 2, asker, followsList, onDecide: async (...decision: Decision) => { decided.push(decision); } })),
          { createNodeMock: () => ({ focus() {}, contains: () => true, querySelectorAll: () => [] }) });
      });
      return await walk(renderer!.root);
    } finally {
      // a walk that throws still unmounts the card, so its focus trap leaves before the globals go back
      if (renderer) await act(async () => { renderer!.unmount(); });
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }

  const radios = (root: ReturnType<typeof create>["root"]) => root.findAll((node) => node.type === "button" && node.props.role === "radio");
  const approveOf = (root: ReturnType<typeof create>["root"]) => root.findAll((node) => node.type === "button" && node.props.className === "btn btn-primary")[0]!;
  const approveButton = (asker: Asker | undefined) => onCard(asker, [], async (root) => {
    await act(async () => { radios(root)[0]!.props.onClick(); });
    return { disabled: approveOf(root).props.disabled === true, numbersDisabled: radios(root).every((node) => node.props.disabled === true) };
  });

  it.each([false, true])("a vouched card offers no digit pick and allows only a verified name: %s", async verified => {
    const decided: Decision[] = [];
    await onCard(undefined, decided, async root => {
      expect(radios(root)).toHaveLength(0);
      const buttons = root.findAllByType("button");
      expect(buttons.map(button => button.children.join(""))).toEqual(verified ? ["Deny", "Allow"] : ["Deny"]);
      const lead = root.findByProps({ className: "account-approval-ask" }).children.join("");
      if (verified) expect(lead).toBe("Trusted listing");
      expect(lead).not.toContain(request.label);
      await act(async () => { buttons[verified ? 1 : 0]!.props.onClick(); });
    }, verified ? { name: "Trusted listing" } : {});
    expect(decided).toEqual([[verified ? "approve" : "decline", undefined]]);
  });

  it("keeps the number pick: three numbers, none picked, Approve held until one is, and the picked one sent", async () => {
    const decided: Decision[] = [];
    const seen = await onCard({ os: null, country: null, city: null }, decided, async (root) => {
      const before = { labels: radios(root).map((node) => node.props["aria-label"]), shown: radios(root).map((node) => node.children.join("")), checked: radios(root).map((node) => node.props["aria-checked"]), approveHeld: approveOf(root).props.disabled === true };
      await act(async () => { radios(root)[1]!.props.onClick(); });
      const after = { checked: radios(root).map((node) => node.props["aria-checked"]), approveHeld: approveOf(root).props.disabled === true };
      await act(async () => { approveOf(root).props.onClick(); });
      return { before, after };
    });
    expect(seen).toEqual({
      before: { labels: request.choices.map((choice) => choice.split("").join(" ")), shown: ["111 111", "222 222", "333 333"], checked: [false, false, false], approveHeld: true },
      after: { checked: [false, true, false], approveHeld: false },
    });
    expect(decided).toEqual([["approve", "222222"]]);
  });

  it("holds Approve for a join into the account's list until the new device's person said that the numbers match, and says what to press there", async () => {
    const held = (told: { list?: true; confirmed?: true }) => onCard({ os: null, country: null, city: null }, [], async (root) => {
      await act(async () => { radios(root)[1]!.props.onClick(); });
      return { approveHeld: approveOf(root).props.disabled === true, says: root.findAll((node) => node.props.className === "account-approval-hint" && node.props.role === "status").map((node) => node.children.join("")) };
    }, undefined, told);
    expect(await held({ list: true })).toEqual({ approveHeld: true, says: ["First press “The numbers match” on Hako's iPhone"] });
    expect(await held({ list: true, confirmed: true })).toEqual({ approveHeld: false, says: [] });
    // any other join is approved as before, whether or not the device confirmed yet
    expect(await held({})).toEqual({ approveHeld: false, says: [] });
  });

  it("holds Approve for a join that brought no card on a PC that lets devices in by the list, and says to approve it on that PC's own screen", async () => {
    const held = (told: { list?: true; confirmed?: true }, followsList: boolean) => onCard({ os: null, country: null, city: null }, [], async (root) => {
      await act(async () => { radios(root)[1]!.props.onClick(); });
      return { approveHeld: approveOf(root).props.disabled === true, says: root.findAll((node) => node.props.className === "account-approval-hint" && node.props.role === "status").map((node) => node.children.join("")) };
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
