import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "../lib/i18n.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SignOutRow, wayBackIn } from "./SignOutRow.tsx";

/** English, whatever the machine running the test prefers. */
function render(viaPortal: boolean): string {
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(SignOutRow, { viaPortal, onSignOut: async () => undefined }) }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("Sign out in Settings → Devices", () => {
  it("is a Sign out button, and for a visitor Portal let in says the way back is Portal's sign-in", () => {
    const portal = render(true);
    expect(portal).toContain(">Sign out</button>");
    expect(portal).toContain("Getting back in means signing in through Portal again.");
    expect(portal).not.toContain("access token or a pairing code");
  });

  it("says what it always said to a browser that got in with a token or a pairing", () => {
    const html = render(false);
    expect(html).toContain(">Sign out</button>");
    expect(html).toContain("Getting back in takes the access token or a pairing code.");
    expect(html).not.toContain("Portal");
  });

  it("tells the way back in its confirmation too: Portal's sign-in, or the token and a pairing code", () => {
    const english = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
    expect(wayBackIn(english, true).confirm).toBe("Getting back in means signing in through Portal again.");
    // a Google or company login lets a browser still signed in there straight back in, so it says to sign out there too
    expect(wayBackIn(english, true, true).confirm).toContain("sign out there too");
    expect(wayBackIn(english, true, true).row).toBe(wayBackIn(english, true).row);
    expect(wayBackIn(english, false, true).confirm).not.toContain("Portal");
    expect(wayBackIn(english, false).confirm).toContain("access token, or a pairing code from the PC");
    expect(wayBackIn(english, false).confirm).not.toContain("Portal");
  });
});

