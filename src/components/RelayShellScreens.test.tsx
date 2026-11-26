import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create as createRenderer, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { SettingsProvider } from "../lib/settings.ts";
import {
  INSTALLER_COMMAND,
  PLUGIN_COMMANDS,
  RelayShellCardContent,
  TypedDigits,
} from "./RelayShellScreens.tsx";
import { CodeEntry, RelayShell, type RelayShellProps } from "./RelayShell.tsx";
import { PROVIDER_NAMES } from "./AccountPcs.tsx";
import { relayFailureText } from "./relayFailureText.ts";
import { translate, type Vars } from "../lib/i18n.ts";
import { endPairCodeComposition, typePairCode } from "../lib/pairCodeInput.ts";

/** every tree a test draws, still mounted: the test's end unmounts each one, not only the ones it unmounted itself */
const drawn = new Set<ReactTestRenderer>();
const create = (...args: Parameters<typeof createRenderer>): ReactTestRenderer => {
  const tree = createRenderer(...args);
  const unmount = tree.unmount.bind(tree);
  tree.unmount = () => { drawn.delete(tree); unmount(); };
  drawn.add(tree);
  return tree;
};

const none = () => {};
const baseProps = (state: RelayShellProps["state"]): RelayShellProps => ({
  state,
  scoped: true,
  iosTab: false,
  onPair: none,
  onRetry: none,
  onCancel: none,
  onBack: none,
  onForget: none,
  onUpdate: none,
  onMatch: none,
  onCodeStart: none,
  onCodeSubmit: none,
  onCodeMatch: none,
});

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

const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");

describe("RelayShellScreens", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let copiedText: string[] = [];

  beforeEach(() => {
    copiedText = [];
    for (const key of ["window", "document", "navigator", "localStorage", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    const events = new EventTarget();
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); }, key: () => null, length: 0, clear: () => store.clear() };
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    class HTMLElement { isConnected = true; focus(): void {} }
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: HTMLElement });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        languages: ["en"],
        userAgent: "Mozilla/5.0",
        maxTouchPoints: 0,
        clipboard: {
          writeText: async (text: string) => { copiedText.push(text); },
        },
      },
    });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: storage,
        matchMedia,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        requestAnimationFrame: () => 1,
        cancelAnimationFrame() {},
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
        activeElement: new HTMLElement(),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      },
    });
  });

  afterEach(async () => {
    // every tree goes, then what its unmount left to run on a timer (a sheet leaving its history entry) runs while
    // this window is still here
    await act(async () => { for (const tree of [...drawn]) tree.unmount(); });
    await act(async () => { for (let turn = 0; turn < 3; turn++) await new Promise((resolve) => setTimeout(resolve, 0)); });
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  it("applies the system .input class, visible labels, and keeps the uncontrolled DOM input across lookup failures", async () => {
    const codeHtml = render(
      createElement(CodeEntry, {
        failure: "no-pc",
        looking: false,
        onSubmit: none,
        back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
      }),
    );
    expect(codeHtml).toMatch(/<label[^>]*class="relay-shell-field-label"[^>]*for="[^"]+"/);
    expect(codeHtml).toMatch(/<input[^>]*class="input relay-shell-code-input"/);
    expect(codeHtml).toMatch(/<p[^>]*class="account-error"[^>]*role="alert"/);
    expect(codeHtml).toContain("Settings → Devices and PCs → Add a connection → Ovis relay");
    expect(codeHtml).not.toContain("older Ovis");

    const digitsHtml = render(
      createElement(TypedDigits, {
        pc: "Desk PC",
        onSubmit: none,
        cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
      }),
    );
    expect(digitsHtml).toMatch(/<label[^>]*class="relay-shell-field-label"/);
    expect(digitsHtml).toMatch(/<input[^>]*class="input relay-shell-code-input"/);

    const compactHtml = render(
      createElement(TypedDigits, {
        pc: "Desk PC",
        compact: true,
        onSubmit: none,
        cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
      }),
    );
    expect(compactHtml).not.toContain("<h1");
    expect(compactHtml).not.toContain("relay-shell-copy");

    const submitted: string[] = [];
    const fieldMock = { value: "7K3QD-M2XHA" };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(CodeEntry, {
              failure: null,
              looking: false,
              onSubmit: (code) => submitted.push(code),
              back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
        );
      });
      const inputBefore = renderer!.root.findByType("input");
      const form = renderer!.root.findByType("form");
      await act(async () => {
        form.props.onSubmit({
          preventDefault() {},
          currentTarget: { elements: { namedItem: () => fieldMock } },
        });
      });
      expect(submitted).toEqual(["7K3QD-M2XHA"]);
      expect(fieldMock.value).toBe("7K3QD-M2XHA");

      await act(async () => {
        renderer!.update(
          createElement(SettingsProvider, {
            children: createElement(CodeEntry, {
              failure: null,
              looking: true,
              onSubmit: (code) => submitted.push(code),
              back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
        );
      });
      const inputDuring = renderer!.root.findByType("input");
      expect(inputDuring).toBe(inputBefore);
      expect([inputBefore.props.onInput, inputBefore.props.onCompositionEnd]).toEqual([typePairCode, endPairCodeComposition]);

      await act(async () => {
        renderer!.update(
          createElement(SettingsProvider, {
            children: createElement(CodeEntry, {
              failure: "wrong",
              looking: false,
              onSubmit: (code) => submitted.push(code),
              back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
        );
      });
      const inputAfter = renderer!.root.findByType("input");
      expect(inputAfter).toBe(inputBefore);
      expect(fieldMock.value).toBe("7K3QD-M2XHA");
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("puts up Update the app with the store page of the app's platform, and no way into the PC", () => {
    for (const [platform, page] of [["android", "https://play.google.com/store/apps/details?id=sh.ovis.app"], ["ios", "https://apps.apple.com/app/id6824664162"]] as const) {
      const html = render(createElement(RelayShell, baseProps({ kind: "app-outdated", name: "Desk PC", platform })));
      expect(html).toContain('data-relay-state="app-outdated"');
      expect(html).toContain(">Update the app</h1>");
      expect(html).toContain("Desk PC needs a newer version of this app.");
      expect(html).toContain(`href="${page}"`);
      expect(html).toContain(">Open the store</a>");
      expect(html).toContain(">Back</button>");
      expect(html).not.toContain("Try again");
    }
    const unknown = render(createElement(RelayShell, baseProps({ kind: "app-outdated", name: "Desk PC", platform: null })));
    expect(unknown).not.toContain("Open the store");
    expect(unknown).toContain(">Back</button>");
  });

  it("leaves Update the app for the front page by Cancel where no PC's page is open", async () => {
    const cancelled: string[] = [];
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(SettingsProvider, { children: createElement(RelayShellCardContent, {
          props: { ...baseProps({ kind: "app-outdated", name: "Desk PC", platform: null }), scoped: false, onCancel: () => cancelled.push("cancel"), onBack: () => cancelled.push("back") },
        }) }));
      });
      const back = renderer!.root.findAll((node) => node.type === "button" && textOf(node).trim() === "Back");
      expect(back).toHaveLength(1);
      await act(async () => { back[0]!.props.onClick(); });
      expect(cancelled).toEqual(["cancel"]);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("renders Copy buttons for both manual update command blocks and updates to Copied on click", async () => {
    let renderer: ReactTestRenderer | undefined;
    try {
      const shown = baseProps({
        kind: "outdated",
        name: "Desk PC",
        serverVersion: "0.4.0",
        minVersion: "0.5.0",
        update: { phase: "manual" },
      });
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(RelayShellCardContent, {
              props: shown,
            }),
          }),
        );
      });
      const copyBtns = renderer!.root.findAll(
        (n) => n.type === "button" && textOf(n).trim() === "Copy",
      );
      expect(copyBtns).toHaveLength(2);
      await act(async () => {
        copyBtns[0]!.props.onClick();
      });
      expect(copiedText).toEqual([INSTALLER_COMMAND]);
      expect(
        renderer!.root.findAll((n) => n.type === "button" && textOf(n).trim() === "Copied"),
      ).toHaveLength(1);

      await act(async () => {
        copyBtns[1]!.props.onClick();
      });
      expect(copiedText).toEqual([INSTALLER_COMMAND, PLUGIN_COMMANDS]);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  it("keeps the sign-in column mounted during signing-in with the busy provider marked, and the way past it held too", () => {
    const html = render(
      createElement(RelayShell, {
        ...baseProps({ kind: "empty", account: { kind: "signing-in", provider: "google" } }),
        scoped: false,
        onSignIn: none,
        accountProviders: ["github", "google", "apple"],
      }),
    );
    expect(html).toContain('data-tab-panel="relay"');
    expect(html).toContain('data-provider="google" aria-busy="true" disabled=""');
    expect(html).toMatch(/data-action="add-code" disabled=""/);
    // where the phone app can scan, the QR way is held as well: a scan, or the code a failed one falls back to, waits
    const capacitor = Object.getOwnPropertyDescriptor(globalThis, "Capacitor");
    Object.defineProperty(globalThis, "Capacitor", { configurable: true, value: { isNativePlatform: () => true, PluginHeaders: [{ name: "CapacitorBarcodeScanner" }], nativePromise: async () => ({}) } });
    try {
      const scanning = render(createElement(RelayShell, { ...baseProps({ kind: "empty", account: { kind: "signing-in", provider: "google" } }), scoped: false, onSignIn: none }));
      expect(scanning).toMatch(/data-action="scan-qr" disabled=""/);
    } finally {
      if (capacitor) Object.defineProperty(globalThis, "Capacitor", capacitor);
      else Reflect.deleteProperty(globalThis, "Capacitor");
    }
  });

  describe("the confirm before a link's PC is paired with", () => {
    const offer = { v: 1 as const, server_id: "0123456789abcdef0123456789abcdef", server_public_key: "key", relay: "wss://relay.ovis.sh", name: "Desk PC" };
    const confirm = (account?: "checking" | "unlisted" | "listed", pressed?: "unlisted" | "listed" | "own"): string => render(createElement(RelayShellCardContent, {
      props: baseProps({ kind: "confirm", offer, ...(account ? { account } : {}), ...(pressed ? { pressed } : {}) }),
    }));
    const pcId = '<span class="key-id" role="group" aria-label="ID of the PC this link names"><span class="key-id-group">0123</span>';

    it("signed out, pairs with a key of this device's own and says nothing of an account", () => {
      const html = confirm();
      expect(html).toContain("Pair with Desk PC?");
      expect(html).toContain("This device gets a key of its own for Desk PC.");
      expect(html).toContain('<button type="button" class="btn btn-primary">Pair</button>');
      expect(html).not.toContain("account");
      expect(html).not.toContain(pcId);
    });

    it("signed in with a PC the account does not list, says the pairing adds it to the account and shows the PC's ID", () => {
      const html = confirm("unlisted");
      expect(html).toContain('<h1 class="relay-shell-title">Add Desk PC to your account?</h1>');
      expect(html).toContain("Pairing adds this PC to your Ovis account, so every device of your account can open it. Pair only with a PC you are setting up yourself.");
      expect(html).toContain(pcId);
      expect(html).toContain('<button type="button" class="btn btn-primary">Add and pair</button>');
      expect(html).not.toContain("Pair with Desk PC?");
      expect(html).not.toContain("a key of its own");
    });

    it("signed in with a PC the account lists, says this device joins it with the account's key", () => {
      const html = confirm("listed");
      expect(html).toContain("Pair with Desk PC?");
      expect(html).toContain("This device joins Desk PC with your account&#x27;s key. The PC lists it under Settings → Devices and PCs, where it can be removed.");
      expect(html).toContain('<button type="button" class="btn btn-primary">Pair</button>');
      expect(html).not.toContain("a key of its own");
      expect(html).not.toContain("Add Desk PC to your account?");
    });

    it("until the sign-in is read, claims neither, says it is checking and takes no confirmation", () => {
      const html = confirm("checking");
      expect(html).toContain("Pair with Desk PC?");
      expect(html).toContain('<button type="button" class="btn btn-primary" disabled="" aria-busy="true">Pair</button>');
      expect(html).toContain('<p class="relay-shell-detail" role="status">Checking your account…</p>');
      expect(html).not.toContain("a key of its own");
      expect(html).not.toContain("your account&#x27;s key");
      expect(html).not.toContain("to your account");
    });

    it("keeps the wording a press was made on while the press is checked, with its button held", () => {
      const adds = confirm("checking", "unlisted");
      expect(adds).toContain('<h1 class="relay-shell-title">Add Desk PC to your account?</h1>');
      expect(adds).toContain("Pairing adds this PC to your Ovis account");
      expect(adds).toContain(pcId);
      expect(adds).toContain('<button type="button" class="btn btn-primary" disabled="" aria-busy="true">Add and pair</button>');
      expect(adds).toContain('<p class="relay-shell-detail" role="status">Checking your account…</p>');
      expect(adds).not.toContain("Pair with Desk PC?");
      const joins = confirm("checking", "listed");
      expect(joins).toContain("Pair with Desk PC?");
      expect(joins).toContain("This device joins Desk PC with your account&#x27;s key.");
      expect(joins).toContain('disabled="" aria-busy="true">Pair</button>');
      expect(joins).toContain("Checking your account…");
      const own = confirm("checking", "own");
      expect(own).toContain("This device gets a key of its own for Desk PC.");
      expect(own).toContain('disabled="" aria-busy="true">Pair</button>');
      expect(own).not.toContain("account");
    });
  });

  it("clears the uncontrolled TypedDigits input when a fresh challenge number arrives", async () => {
    const fieldNode = { value: "123456" };
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          createElement(SettingsProvider, {
            children: createElement(TypedDigits, {
              pc: "Desk PC",
              challenge: 1,
              onSubmit: none,
              cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
          {
            createNodeMock: (el) => (el.type === "input" ? fieldNode : null),
          },
        );
      });
      expect(fieldNode.value).toBe("123456");

      await act(async () => {
        renderer!.update(
          createElement(SettingsProvider, {
            children: createElement(TypedDigits, {
              pc: "Desk PC",
              challenge: 2,
              onSubmit: none,
              cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
            }),
          }),
        );
      });
      expect(fieldNode.value).toBe("");
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  // A marked pairing's sign-in and the confirm it comes back to: what can be pressed, where it goes, and what waits
  describe("the inline sign-in of a marked pairing", () => {
    const en = (key: string, vars?: Vars): string => translate("en", key, vars);
    const failed = { kind: "failed" as const, failure: "sign-in-first" as const, name: "Desk", detail: null, server_id: "a".repeat(32) };
    const offered = { onSignIn: none, accountProviders: ["github", "google"] as const };
    const draw = async (state: RelayShellProps["state"], extra: Partial<RelayShellProps> = {}): Promise<ReactTestRenderer> => {
      let renderer: ReactTestRenderer | undefined;
      await act(async () => {
        renderer = create(createElement(SettingsProvider, { children: createElement(RelayShellCardContent, {
          props: { ...baseProps(state), ...extra },
        }) }));
      });
      return renderer!;
    };
    const providerButtons = (renderer: ReactTestRenderer): ReactTestInstance[] => renderer.root.findAll((node) => node.type === "button" && typeof node.props["data-provider"] === "string");

    it("offers each provider the account service lists, by name, none drawn as the one to pick, and signs in with the one pressed", async () => {
      const pressed: string[] = [];
      const screen = await draw(failed, { ...offered, onSignIn: (provider) => { pressed.push(provider); } });
      const buttons = providerButtons(screen);
      expect(buttons.map((button) => button.props["data-provider"])).toEqual(["github", "google"]);
      expect(buttons.map((button) => textOf(button))).toEqual([PROVIDER_NAMES.github, PROVIDER_NAMES.google]);
      expect(buttons.filter((button) => String(button.props.className).split(" ").includes("btn-primary"))).toEqual([]);
      await act(async () => { buttons[1]!.props.onClick(); });
      expect(pressed).toEqual(["google"]);
      expect(screen.root.findAllByType("a").map((link) => link.props.href)).toEqual(["https://ovis.sh/privacy/"]);
    });

    it("holds every provider while one signs in, and offers the sign-in again after a refusal", async () => {
      const busy = await draw({ ...failed, account: { kind: "signing-in", provider: "google" } }, offered);
      expect(providerButtons(busy).map((button) => [button.props["data-provider"], button.props["aria-busy"] ?? null, button.props.disabled])).toEqual([["github", null, true], ["google", "true", true]]);
      const refused = await draw({ ...failed, account: { kind: "signed-out", error: "refused", provider: "google" } }, offered);
      expect(refused.root.findAll((node) => node.type === "button" && node.props["data-action"] === "retry-signin")).toHaveLength(1);
    });

    it("names no provider where the page offers no sign-in, or once the code ran out during one", async () => {
      const noService = await draw(failed);
      expect(providerButtons(noService)).toEqual([]);
      expect(noService.root.findAllByProps({ className: "relay-shell-copy" }).map(textOf)).toEqual([relayFailureText(en, "sign-in-first", "Desk").copy]);
      const expired = await draw({ kind: "failed", failure: "scan-expired", name: "Desk", detail: null }, offered);
      expect(providerButtons(expired)).toEqual([]);
      expect(textOf(expired.root.findByType("h1"))).toBe(relayFailureText(en, "scan-expired", "Desk").title);
    });

    it("keeps the PC's ID of an Add and pair confirm folded under Details, with the account on the PC's card", () => {
      const offer = { v: 1 as const, server_id: "a3f9c2e17b4d5a6c8e9f0b1d2c3a4e5f", server_public_key: "key", relay: "wss://relay.example", name: "Desk", code: "123456" };
      const confirm = (account: "unlisted" | "listed") => render(createElement(RelayShellCardContent, {
        props: baseProps({ kind: "confirm", offer, account }),
      }));
      const adding = confirm("unlisted");
      expect(adding).toContain('<span class="relay-step-card-name">Desk</span><span class="relay-step-card-detail">Your Ovis account</span>');
      expect(adding).toMatch(/<details class="relay-step-details"><summary>Details<\/summary><p class="relay-shell-code-id">/);
      expect(adding).not.toMatch(/<details[^>]*open/);
      expect(adding).toContain("a3f9");
      expect(confirm("listed")).not.toContain("relay-step-details");
    });
  });
});
