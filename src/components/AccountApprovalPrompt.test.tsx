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

  async function approveButton(asker: Asker | undefined): Promise<{ disabled: boolean; numbersDisabled: boolean }> {
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
    try {
      let renderer: ReturnType<typeof create> | undefined;
      await act(async () => {
        renderer = create(createElement(SettingsProvider, null, createElement(AccountApprovalCard, { request, pcName: "p620", pcCount: 2, asker, onDecide: async () => {} })),
          { createNodeMock: () => ({ focus() {}, contains: () => true, querySelectorAll: () => [] }) });
      });
      const root = renderer!.root;
      await act(async () => { root.findAll((node) => node.props.role === "radio")[0]!.props.onClick(); });
      const approve = root.findAll((node) => node.type === "button" && node.props.className === "btn btn-primary")[0]!;
      const disabled = approve.props.disabled === true;
      const numbersDisabled = root.findAll((node) => node.props.role === "radio").every((node) => node.props.disabled === true);
      await act(async () => { renderer!.unmount(); });
      return { disabled, numbersDisabled };
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }

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
