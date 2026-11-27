import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openPage, reactProps, type Page } from "../lib/page.fixture.ts";

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
  let page: Page;
  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

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
    await page.render(
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
    const buttons = page.container.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    for (const btn of buttons) {
      expect(btn.disabled).toBe(true);
      await act(async () => { btn.click(); });
      const { onClick } = reactProps(btn);
      if (typeof onClick !== "function") throw new Error("Missing provider click handler");
      await act(async () => { onClick(); });
    }
    expect(tapped).toEqual([]);
    await page.render(null);
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
    await page.render(
      createElement(SettingsProvider, {
        children: createElement(AccountSignIn, {
          onSignIn: (p) => retried.push(p),
          error: "The sign-in did not finish.",
          providers: ["github", "google"],
        }),
      }),
    );
    const googleBtn = page.one('button[data-provider="google"]');
    await act(async () => { googleBtn.click(); });
    const retryBtn = page.one('button[data-action="retry-signin"]');
    await act(async () => { retryBtn.click(); });
    expect(retried).toEqual(["google", "google"]);
    await page.render(null);

    const redirectRetried: string[] = [];
    await page.render(
      createElement(SettingsProvider, {
        children: createElement(AccountSignIn, {
          onSignIn: (p) => redirectRetried.push(p),
          error: "The sign-in did not finish. Try again.",
          providers: ["github", "google"],
          failedProvider: "google",
        }),
      }),
    );
    const redirectRetryBtn = page.one('button[data-action="retry-signin"]');
    await act(async () => { redirectRetryBtn.click(); });
    expect(redirectRetried).toEqual(["google"]);
    await page.render(null);
  });

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
  const pc = (state: MyPc["state"], paired: boolean, joined = true): MyPc => ({ server_id: "a".repeat(32), name: "Desk", state, last_seen_at: null, added_at: null, listed: true, paired, linked: paired, ...(joined ? { joined: true as const } : {}) });

  it("says a listed PC is in the account where no pairing can tell whether it waits for an approval", () => {
    expect(listedPcStateText(pc("needs-approval", false), t as never)).toBe("In your account");
    expect(accountPcStateText(pc("needs-approval", false), t as never)).toBe("Needs approval");
  });

  // r14b: an SSH add refused for an old sign-in left the PC listed, and this list already said it was in the account
  it("never says in your account for a PC that is only listed or admitted: it has not taken its place there", () => {
    expect(listedPcStateText(pc("needs-approval", false, false), t as never)).toBe("Waiting to be added");
  });

  it("keeps what the directory itself knows", () => {
    expect(listedPcStateText(pc("needs-update", false), t as never)).toBe("Update Ovis on it");
    expect(listedPcStateText(pc("offline", false), t as never)).toBe(accountPcStateText(pc("offline", false), t as never));
    expect(listedPcStateText(pc("paired", true), t as never)).toBe("Ready");
  });
});
