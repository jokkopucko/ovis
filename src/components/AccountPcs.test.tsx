import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { MyPc } from "../lib/account/myPcs.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AccountPcList, AccountSignIn, CheckPcsButton, accountPcStateText, listedPcStateText } from "./AccountPcs.tsx";

const render = (node: ReturnType<typeof createElement>): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: node }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("AccountSignIn", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0", maxTouchPoints: 0 } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      localStorage: storage, matchMedia,
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
      requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    } });
  });
  afterEach(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("renders only the configured providers in order and marks the busy provider without unmounting the stack", () => {
    const idle = render(
      createElement(AccountSignIn, {
        onSignIn: () => {},
        error: null,
        providers: ["github", "google", "apple"],
      }),
    );
    expect(idle).toContain('data-provider="github"');
    expect(idle).toContain('data-provider="google"');
    expect(idle).toContain('data-provider="apple"');
    expect(idle).not.toContain('aria-busy="true"');

    const busy = render(
      createElement(AccountSignIn, {
        onSignIn: () => {},
        error: null,
        providers: ["github", "google", "apple"],
        busy: true,
        busyProvider: "google",
      }),
    );
    expect(busy).toContain('data-provider="google" aria-busy="true" disabled=""');
    expect(busy).toContain("account-provider-spinner");
    expect(busy).toContain("Continue with GitHub");
    expect(busy).toContain("Continue with Google");
    expect(busy).toContain("Continue with Apple");
    expect(busy.match(/disabled=""/g)).toHaveLength(3);
  });

  it("ignores a second provider click while busy", async () => {
    const tapped: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(AccountSignIn, {
              onSignIn: (p) => tapped.push(p),
              error: null,
              providers: ["github", "google"],
              busy: true,
              busyProvider: "github",
            }),
          }),
        );
      });
      const buttons = renderer!.root.findAll((n) => n.type === "button");
      expect(buttons).toHaveLength(2);
      for (const btn of buttons) {
        expect(btn.props.disabled).toBe(true);
        await act(async () => { btn.props.onClick(); });
      }
      expect(tapped).toEqual([]);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("renders an explicit Try again action and saved-pairings reassurance when sign-in fails", async () => {
    const html = render(
      createElement(AccountSignIn, {
        onSignIn: () => {},
        error: "The sign-in did not finish.",
        providers: ["github", "google"],
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The PCs this device is paired with still work.");
    expect(html).toContain(">Try again</button>");

    const retried: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(AccountSignIn, {
              onSignIn: (p) => retried.push(p),
              error: "The sign-in did not finish.",
              providers: ["github", "google"],
            }),
          }),
        );
      });
      // Tap Google first so it becomes the remembered provider, then click Try again
      const googleBtn = renderer!.root.find((n) => n.type === "button" && n.props["data-provider"] === "google");
      await act(async () => { googleBtn.props.onClick(); });
      const retryBtn = renderer!.root.find((n) => n.type === "button" && n.props["data-action"] === "retry-signin");
      await act(async () => { retryBtn.props.onClick(); });
      expect(retried).toEqual(["google", "google"]);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }

    // Remounted after an OAuth redirect failure with failedProvider="google" and no prior click
    const redirectRetried: string[] = [];
    try {
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(AccountSignIn, {
              onSignIn: (p) => redirectRetried.push(p),
              error: "The sign-in did not finish. Try again.",
              providers: ["github", "google"],
              failedProvider: "google",
            }),
          }),
        );
      });
      const retryBtn = renderer!.root.find((n) => n.type === "button" && n.props["data-action"] === "retry-signin");
      await act(async () => { retryBtn.props.onClick(); });
      expect(redirectRetried).toEqual(["google"]);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  // the provider mark's placement outside a provider button (inline in the dashboard's foot) is what the browser
  // computes: scripts/relay-dashboard-browser-qa.ts provider-mark-inline
});

describe("CheckPcsButton", () => {
  it("uses the ghost button primitive and marks aria-busy while checking", () => {
    const idle = render(createElement(CheckPcsButton, { status: new Map(), onCheck: () => {} }));
    expect(idle).toContain('class="btn btn-ghost relay-shell-check-btn"');
    expect(idle).not.toContain("aria-busy");

    const checkingStatus = new Map<string, PcStatus>([["a".repeat(32), { kind: "checking" }]]);
    const busy = render(createElement(CheckPcsButton, { status: checkingStatus, onCheck: () => {} }));
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain("disabled");
  });
});

describe("AccountPcList", () => {
  const pc = (server_id: string, name: string, state: MyPc["state"], paired = state === "paired"): MyPc => ({
    server_id,
    name,
    state,
    last_seen_at: "2026-11-08T00:00:00Z",
    added_at: null,
    listed: true,
    paired,
    linked: paired,
  });

  it("renders the shared StatusDot inline glyph for each PC state instead of a custom dot span", () => {
    const html = render(
      createElement(AccountPcList, {
        pcs: [
          pc("a".repeat(32), "Ready PC", "paired"),
          pc("b".repeat(32), "Approval PC", "needs-approval", false),
          pc("c".repeat(32), "Update PC", "needs-update", true),
          pc("d".repeat(32), "Offline PC", "offline", false),
        ],
      }),
    );
    expect(html).not.toContain("account-pc-dot");
    expect(html).toContain('class="status-dot" data-state="ready" data-size="inline"');
    expect(html).toContain('class="status-dot" data-state="needs-you" data-size="inline"');
    expect(html).toContain('class="status-dot" data-state="offline" data-size="inline"');
  });
});

describe("listedPcStateText", () => {
  const t = (key: string) => key;
  const pc = (state: MyPc["state"], paired: boolean): MyPc => ({ server_id: "a".repeat(32), name: "Desk", state, last_seen_at: null, added_at: null, listed: true, paired, linked: paired });

  it("says a listed PC is in the account where no pairing can tell whether it waits for an approval", () => {
    // a PC's own Settings reads the directory with no pairings, so every listed PC came out as needs-approval
    expect(listedPcStateText(pc("needs-approval", false), t as never)).toBe("In your account");
    expect(accountPcStateText(pc("needs-approval", false), t as never)).toBe("Needs approval");
  });

  it("keeps what the directory itself knows", () => {
    expect(listedPcStateText(pc("needs-update", false), t as never)).toBe("Update Ovis on it");
    expect(listedPcStateText(pc("offline", false), t as never)).toBe(accountPcStateText(pc("offline", false), t as never));
    expect(listedPcStateText(pc("paired", true), t as never)).toBe("Ready");
  });
});
