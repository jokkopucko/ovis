import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PortalAuth } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PortalInvite } from "./PortalInvite.tsx";

const credential = (...allow: string[]): PortalAuth => ({ method: "credential", allow, issuer: null, client_id: null });

/** English, whatever the machine running the test prefers. */
function render(auth: PortalAuth): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PortalInvite, { auth }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Invite someone", () => {
  it("asks for a name and a validity of 1, 7, 30 or 90 days, 30 chosen, and issues nothing until asked", () => {
    const html = render(credential());
    expect(html).toContain("Invite someone");
    expect(html).toMatch(/<input id="[^"]*-name" class="input"/);
    expect(html).not.toContain("<select");
    for (const [label, pressed] of [["1 day", false], ["7 days", false], ["30 days", true], ["90 days", false]] as const) {
      expect(html).toContain(`<button type="button" aria-pressed="${pressed}">${label}</button>`);
    }
    // no name yet: nothing to create, and nothing to warn about
    expect(html).toMatch(/<button type="submit" class="btn btn-primary" disabled="">Create link<\/button>/);
    expect(html).not.toContain("portal-warning");
  });

  it("offers only the names on the list when there is one: Portal turns any other link away", () => {
    const html = render(credential("alice", "bob smith"));
    expect(html).toContain('<option value="alice" selected="">alice</option>');
    expect(html).toContain('<option value="bob smith">bob smith</option>');
    expect(html).not.toMatch(/<input id="[^"]*-name"/);
    expect(html).not.toMatch(/<button type="submit"[^>]*disabled/);
  });
});
