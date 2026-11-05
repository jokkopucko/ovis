import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { HealthAuth } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { DevicesPanel } from "./DevicesPanel.tsx";

/** English, whatever the machine running the test prefers. */
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

describe("how this browser got in", () => {
  it("says who Portal's sign-in let in, and how", () => {
    const wallet = "0x52908400098527886E0F7030069857D2E4169EE7";
    const html = render({ required: false, authenticated: true, via: "portal", role: "drive", portal: { user: wallet, method: "siwe" } });
    expect(html).toContain("You are in through Portal&#x27;s sign-in.");
    expect(html).toContain(`Signed in as ${wallet} with Ethereum wallet.`);
    expect(render({ required: false, authenticated: true, via: "portal", role: "drive", portal: { user: "me@example.com", method: "oidc" } })).toContain("Signed in as me@example.com with Google or company login.");
  });

  it("lets a visitor Portal signed in read the list and offers it no way to pair or revoke", () => {
    const visitor = render({ required: false, authenticated: true, via: "portal", role: "drive", portal: { user: "alice", method: "credential" } });
    expect(visitor).toContain("Pairing and revoking devices are for the access token or a paired device.");
    expect(visitor).not.toContain("Pair a device");
    // a browser that holds the token is offered the pairing the server lets it do
    const owner = render({ required: false, authenticated: true, via: "token", role: "drive" });
    expect(owner).toContain("Pair a device");
    expect(owner).not.toContain("Pairing and revoking devices are for the access token");
  });

  it("says nothing of Portal to a browser that got in another way", () => {
    const html = render({ required: false, authenticated: true, via: "token", role: "drive" });
    expect(html).toContain("You are in with the access token.");
    expect(html).not.toContain("Signed in as");
  });
});
