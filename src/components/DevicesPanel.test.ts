import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HealthAuth, PairedDevice } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { DevicesPanel, offersAccountRemove } from "./DevicesPanel.tsx";

function render(auth: HealthAuth): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(DevicesPanel, { auth }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("who may disconnect a device from every PC", () => {
  const row = (id: string, extra: Partial<PairedDevice> = {}): PairedDevice => ({ id, label: id, role: "drive", created_at: "", last_seen_at: "", current: false, ...extra });
  const phone = row("phone", { account: "acct", account_key: "phone-key" });

  const offered = (devices: PairedDevice[], key: string | null, target = phone) => offersAccountRemove(devices, target, "acct", key);

  it("is offered to a drive member of the same account on this PC", () => {
    expect(offered([phone, row("me", { current: true, account: "acct", account_key: "my-key" })], "my-key")).toBe(true);
  });

  it("is not offered to a browser whose account key no row of this PC holds (signed in on the PC's own address, paired by cookie)", () => {
    expect(offered([phone, row("me", { current: true })], "my-key")).toBe(false);
    expect(offered([phone], null)).toBe(false);
  });

  it("is not offered to a member of another account, nor to one that only watches", () => {
    expect(offered([phone, row("me", { account: "other", account_key: "my-key" })], "my-key")).toBe(false);
    expect(offered([phone, row("me", { role: "watch", account: "acct", account_key: "my-key" })], "my-key")).toBe(false);
  });

  it("is not offered for a row with this client's own key, which leaves with Leave the account instead", () => {
    const older = row("older", { account: "acct", account_key: "my-key" });
    expect(offered([phone, older, row("me", { current: true })], "my-key", older)).toBe(false);
  });
});

describe("how this browser got in", () => {
  it("says who Portal's sign-in let in, and how", () => {
    const wallet = "0x52908400098527886E0F7030069857D2E4169EE7";
    const html = render({ required: false, authenticated: true, via: "portal", role: "drive", portal: { user: wallet, method: "siwe" } });
    expect(html).toContain("You are in through Portal&#x27;s sign-in.");
    expect(html).toContain(`Signed in as ${wallet} with Ethereum wallet.`);
    expect(render({ required: false, authenticated: true, via: "portal", role: "drive", portal: { user: "me@example.com", method: "oidc" } })).toContain("Signed in as me@example.com with Google or company login.");
  });

  it("tells a visitor Portal signed in that pairing and revoking are for the token or a paired device", () => {
    const visitor = render({ required: false, authenticated: true, via: "portal", role: "drive", portal: { user: "alice", method: "credential" } });
    expect(visitor).toContain("Pairing and revoking devices are for the access token or a paired device.");
    const owner = render({ required: false, authenticated: true, via: "token", role: "drive" });
    expect(owner).not.toContain("Pairing and revoking devices are for the access token");
  });

  it("says nothing of Portal to a browser that got in another way", () => {
    const html = render({ required: false, authenticated: true, via: "token", role: "drive" });
    expect(html).toContain("You are in with the access token.");
    expect(html).not.toContain("Signed in as");
  });
});
