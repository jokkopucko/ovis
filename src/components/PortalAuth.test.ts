import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { NO_PORTAL_AUTH } from "../../shared/portal.ts";
import type { PortalAuth, PortalStatus } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { draftOf } from "../lib/portalAuth.ts";
import { PortalAuthChoice, PortalAuthSummary } from "./PortalAuth.tsx";

const status = (patch: Partial<PortalStatus> = {}): PortalStatus => ({
  supported: true, version: "v2.6.1", min_version: "v2.6.1", usable: true, phase: "idle", relay: null, url: null, blocked: null, error: null, output: null,
  auth: NO_PORTAL_AUTH, auth_methods: ["credential", "siwe", "oidc"], oidc_secret: true, ...patch,
});
const OIDC: PortalAuth = { method: "oidc", allow: ["me@example.com", "@example.com"], issuer: "https://accounts.google.com", client_id: "client-1" };

/** English, whatever the machine running the test prefers. */
function render(element: ReturnType<typeof createElement>): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: element }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}
const choice = (current: PortalStatus, auth: PortalAuth = current.auth, disabled = false) =>
  render(createElement(PortalAuthChoice, { status: current, draft: draftOf(auth), disabled, onChange: () => undefined }));

/** The `<input type="radio">` tags of a rendering, in order. */
const radios = (html: string): string[] => html.match(/<input type="radio"[^>]*>/g) ?? [];

describe("the Portal panel's choice of who may open the address", () => {
  it("offers the four choices, token or paired device only first and chosen", () => {
    const html = choice(status());
    expect(html).toContain("Who can open the address");
    for (const label of ["Token or paired device only", "Private link", "Ethereum wallet", "Google or company login"]) expect(html).toContain(label);
    const [none, ...others] = radios(html);
    expect(none).toContain("checked");
    expect(others.every((radio) => !radio.includes("checked") && !radio.includes("disabled"))).toBe(true);
    expect(html).not.toContain("does not support it yet");
  });

  it("says plainly why a choice is unavailable, and offers only what the installed Portal lists", () => {
    const [none, credential, siwe, oidc] = radios(choice(status({ auth_methods: ["credential", "siwe"] })));
    expect([none, credential, siwe].some((radio) => radio!.includes("disabled"))).toBe(false);
    expect(oidc).toContain("disabled");
    const html = choice(status({ auth_methods: [] }));
    expect(radios(html).filter((radio) => radio.includes("disabled"))).toHaveLength(3);
    expect(html.match(/This Portal does not support it yet\./g)).toHaveLength(3);
  });

  it("is off for a device that may only watch", () => {
    expect(choice(status(), NO_PORTAL_AUTH, true)).toContain("<fieldset class=\"settings-item portal-auth\" disabled=\"\"");
  });

  it("shows sign-in guidance and adds an empty-list hint only when no link names are allowed", () => {
    const hints = (html: string): string[] => html.match(/<p class="settings-hint">[^<]+<\/p>/g) ?? [];
    expect(hints(choice(status()))).toHaveLength(0);
    const credential = choice(status(), { method: "credential", allow: [], issuer: null, client_id: null });
    expect(hints(credential)).toHaveLength(2);
    const named = choice(status(), { method: "credential", allow: ["alice"], issuer: null, client_id: null });
    expect(hints(named)).toEqual(hints(credential).slice(0, 1));
    expect(named).toContain("Remove alice");
  });

  it("names the variable that holds the secret, and warns when it is not set", () => {
    const set = choice(status({ auth: OIDC }));
    expect(set).toContain("OVIS_PORTAL_OIDC_CLIENT_SECRET");
    expect(set).toContain("The secret is set on this PC.");
    expect(set).toContain("me@example.com");
    const idle = choice(status({ oidc_secret: false, auth: OIDC }));
    expect(idle).toContain("The secret is not set on this PC.");
    // the address exists only once Portal runs: the choice before Start says so, and the summary shows it
    expect(idle).toContain("It shows here once Portal has started.");
    expect(idle).not.toContain("_portal/auth/callback");
    // the secret itself is never a field here
    expect(idle).not.toMatch(/type="password"|client.secret"/i);
  });

  it("summarizes what runs, read-only", () => {
    const html = render(createElement(PortalAuthSummary, { auth: OIDC, url: null }));
    expect(html).toContain("Google or company login");
    expect(html).toContain("https://accounts.google.com");
    expect(html).toContain("@example.com");
    expect(html).toContain("Stop Portal to change who can open it.");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(render(createElement(PortalAuthSummary, { auth: NO_PORTAL_AUTH, url: null }))).toContain("Token or paired device only");
  });

  it("shows a running Google or company login's redirect address to register, with Copy, and no other sign-in's", () => {
    const url = "https://herdr-test-0123.relay.example";
    const oidc = render(createElement(PortalAuthSummary, { auth: OIDC, url }));
    expect(oidc).toContain("Redirect address to register with the provider");
    expect(oidc).toContain("https://herdr-test-0123.relay.example/_portal/auth/callback");
    expect(oidc.match(/<button/g)).toHaveLength(1);
    expect(oidc).toContain("Copy");
    for (const auth of [NO_PORTAL_AUTH, { method: "credential", allow: [], issuer: null, client_id: null } satisfies PortalAuth]) {
      expect(render(createElement(PortalAuthSummary, { auth, url }))).not.toContain("_portal/auth/callback");
    }
  });

  it("shows the short --name host's redirect address too, since a provider matches each one exactly", () => {
    const url = "https://herdr-test-0123-0xabc.relay.example";
    const shortUrl = "https://herdr-test-0123.relay.example";
    const oidc = render(createElement(PortalAuthSummary, { auth: OIDC, url, shortUrl }));
    expect(oidc).toContain(`${url}/_portal/auth/callback`);
    expect(oidc).toContain(`${shortUrl}/_portal/auth/callback`);
    expect(oidc.match(/<button/g)).toHaveLength(2);
    // one host only (an older server, or no short address): one address
    expect(render(createElement(PortalAuthSummary, { auth: OIDC, url, shortUrl: url })).match(/<button/g)).toHaveLength(1);
  });
});
