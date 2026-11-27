import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openPage, reactProps, type Page } from "../lib/page.fixture.ts";

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

const render = (node: ReturnType<typeof createElement>): string =>
  renderToStaticMarkup(createElement(SettingsProvider, { children: node }));

const textOf = (node: Element): string => node.textContent ?? "";

describe("RelayShellScreens", () => {
  let page: Page;
  let copiedText: string[];
  const buttons = (label: string) => [...page.container.querySelectorAll("button")].filter((node) => textOf(node).trim() === label);

  beforeEach(() => {
    page = openPage();
    Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
    copiedText = [];
    Object.defineProperty(page.window.navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => { copiedText.push(text); } });
  });

  afterEach(async () => { await page.close(); });

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
    await page.render(
      createElement(SettingsProvider, {
        children: createElement(CodeEntry, {
          failure: null,
          looking: false,
          onSubmit: (code) => submitted.push(code),
          back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
        }),
      }),
    );
    const inputBefore = page.one<HTMLInputElement>("input");
    await page.type(inputBefore, "7K3QD-M2XHA");
    const form = page.one("form");
    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toEqual(["7K3QD-M2XHA"]);
    expect(inputBefore.value).toBe("7K3QD-M2XHA");

    await page.render(
      createElement(SettingsProvider, {
        children: createElement(CodeEntry, {
          failure: null,
          looking: true,
          onSubmit: (code) => submitted.push(code),
          back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
        }),
      }),
    );
    const inputDuring = page.one<HTMLInputElement>("input");
    expect(inputDuring).toBe(inputBefore);
    expect([reactProps(inputBefore).onInput, reactProps(inputBefore).onCompositionEnd]).toEqual([typePairCode, endPairCodeComposition]);

    await page.render(
      createElement(SettingsProvider, {
        children: createElement(CodeEntry, {
          failure: "wrong",
          looking: false,
          onSubmit: (code) => submitted.push(code),
          back: createElement("button", { type: "button", className: "btn" }, "Cancel"),
        }),
      }),
    );
    const inputAfter = page.one<HTMLInputElement>("input");
    expect(inputAfter).toBe(inputBefore);
    expect(inputAfter.value).toBe("7K3QD-M2XHA");
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
    await page.render(createElement(SettingsProvider, { children: createElement(RelayShellCardContent, {
        props: { ...baseProps({ kind: "app-outdated", name: "Desk PC", platform: null }), scoped: false, onCancel: () => cancelled.push("cancel"), onBack: () => cancelled.push("back") },
      }) }));
    const back = buttons("Back");
    expect(back).toHaveLength(1);
    await act(async () => { back[0]!.click(); });
    expect(cancelled).toEqual(["cancel"]);
  });

  it("renders Copy buttons for both manual update command blocks and updates to Copied on click", async () => {
    const shown = baseProps({
      kind: "outdated",
      name: "Desk PC",
      serverVersion: "0.4.0",
      minVersion: "0.5.0",
      update: { phase: "manual" },
    });
    await page.render(
      createElement(SettingsProvider, {
        children: createElement(RelayShellCardContent, {
          props: shown,
        }),
      }),
    );
    const copyBtns = buttons("Copy");
    expect(copyBtns).toHaveLength(2);
    await act(async () => {
      copyBtns[0]!.click();
    });
    expect(copiedText).toEqual([INSTALLER_COMMAND]);
    expect(
      buttons("Copied"),
    ).toHaveLength(1);

    await act(async () => {
      copyBtns[1]!.click();
    });
    expect(copiedText).toEqual([INSTALLER_COMMAND, PLUGIN_COMMANDS]);
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
    await page.render(
      createElement(SettingsProvider, {
        children: createElement(TypedDigits, {
          pc: "Desk PC",
          challenge: 1,
          onSubmit: none,
          cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
        }),
      }),
    );
    await page.type(page.one<HTMLInputElement>("input"), "123456");
    expect(page.one<HTMLInputElement>("input").value).toBe("123456");

    await page.render(
      createElement(SettingsProvider, {
        children: createElement(TypedDigits, {
          pc: "Desk PC",
          challenge: 2,
          onSubmit: none,
          cancel: createElement("button", { type: "button", className: "btn" }, "Cancel"),
        }),
      }),
    );
    expect(page.one<HTMLInputElement>("input").value).toBe("");
  });

  // A marked pairing's sign-in and the confirm it comes back to: what can be pressed, where it goes, and what waits
  describe("the inline sign-in of a marked pairing", () => {
    const en = (key: string, vars?: Vars): string => translate("en", key, vars);
    const failed = { kind: "failed" as const, failure: "sign-in-first" as const, name: "Desk", detail: null, server_id: "a".repeat(32) };
    const offered = { onSignIn: none, accountProviders: ["github", "google"] as const };
    const draw = async (state: RelayShellProps["state"], extra: Partial<RelayShellProps> = {}): Promise<void> => {
      await page.render(null);
      await page.render(createElement(SettingsProvider, { children: createElement(RelayShellCardContent, {
        props: { ...baseProps(state), ...extra },
      }) }));
    };
    const providerButtons = () => [...page.container.querySelectorAll<HTMLButtonElement>('button[data-provider]')];

    it("offers each provider the account service lists, by name, none drawn as the one to pick, and signs in with the one pressed", async () => {
      const pressed: string[] = [];
      await draw(failed, { ...offered, onSignIn: (provider) => { pressed.push(provider); } });
      const buttons = providerButtons();
      expect(buttons.map((button) => button.getAttribute("data-provider"))).toEqual(["github", "google"]);
      expect(buttons.map((button) => textOf(button))).toEqual([PROVIDER_NAMES.github, PROVIDER_NAMES.google]);
      expect(buttons.filter((button) => button.classList.contains("btn-primary"))).toEqual([]);
      await act(async () => { buttons[1]!.click(); });
      expect(pressed).toEqual(["google"]);
      expect([...page.container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["https://ovis.sh/privacy/"]);
    });

    it("holds every provider while one signs in, and offers the sign-in again after a refusal", async () => {
      await draw({ ...failed, account: { kind: "signing-in", provider: "google" } }, offered);
      expect(providerButtons().map((button) => [button.getAttribute("data-provider"), button.getAttribute("aria-busy"), button.disabled])).toEqual([["github", null, true], ["google", "true", true]]);
      await draw({ ...failed, account: { kind: "signed-out", error: "refused", provider: "google" } }, offered);
      expect(page.container.querySelectorAll('button[data-action="retry-signin"]')).toHaveLength(1);
    });

    it("names no provider where the page offers no sign-in, or once the code ran out during one", async () => {
      await draw(failed);
      expect(providerButtons()).toEqual([]);
      expect([...page.container.querySelectorAll('[class="relay-shell-copy"]')].map(textOf)).toEqual([relayFailureText(en, "sign-in-first", "Desk").copy]);
      await draw({ kind: "failed", failure: "scan-expired", name: "Desk", detail: null }, offered);
      expect(providerButtons()).toEqual([]);
      expect(textOf(page.one("h1"))).toBe(relayFailureText(en, "scan-expired", "Desk").title);
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
