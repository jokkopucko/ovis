import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RelayStatus } from "../../shared/protocol.ts";
import { translate } from "../lib/i18n.ts";
import { relayNoticeFromStatus, relayNoticeOf } from "../lib/relayNotice.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { RelayNotice, relayNoticeText } from "./RelayNotice.tsx";

const baseRelay: RelayStatus = {
  phase: "online",
  relay: "wss://relay.ovis.sh",
  app: "https://app.ovis.sh",
  sessions: 0,
  blocked: null,
  error: null,
};

describe("relayNoticeFromStatus", () => {
  it("stays hidden when the relay is off, self-hosted, or signed in with a valid pass", () => {
    expect(relayNoticeFromStatus(undefined)).toBeUndefined();
    expect(relayNoticeFromStatus(null)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, phase: "off" })).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, relay: "wss://relay.example.com" }, false)).toBeNull();
    expect(relayNoticeFromStatus(baseRelay, true)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "ok", relay: "ok", enforce_at: null, refused: false } }, false)).toBeNull();
    expect(relayNoticeOf({ auth: { required: true, authenticated: false } })).toBeUndefined();
  });

  it("stays hidden until the relay announces a date or refuses", () => {
    expect(relayNoticeFromStatus(baseRelay, false)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "no_account", relay: "missing", enforce_at: null, refused: false } }, false)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "not_listed", relay: "missing", enforce_at: null, refused: false } }, true)).toBeNull();
    // a server from before it said whether passes are enforced refuses no device with no date passed
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "ok", relay: "ok", enforce_at: null, refused: false, new_sessions: false } }, true)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "ok", relay: "ok", enforce_at: null, refused: false, enforced: false, new_sessions: false } }, true)).toBeNull();
  });

  it("shows the limit on new devices while the PC says passes are enforced, with no date or one far ahead", () => {
    const now = Date.parse("2030-01-01T00:00:00.000Z");
    const limit = { kind: "data-limit", enforceAt: null } as const;
    // a relay in `enforce` names no date, or one far ahead: the PC refuses new devices all the same
    for (const at of [null, "2099-01-01T00:00:00.000Z", "soon"]) {
      expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "ok", relay: "ok", enforce_at: at, refused: false, enforced: true, new_sessions: false } }, true, now)).toEqual(limit);
    }
    // a PC the relay refuses for its pass is told why instead: it is not on the relay at all
    expect(relayNoticeFromStatus({ ...baseRelay, phase: "error", pass: { state: "limit", relay: "ok", enforce_at: null, refused: true, enforced: true, new_sessions: false } }, true, now))
      .toEqual({ kind: "pc-limit", enforceAt: null });
    // enforced with a pass that allows new sessions: nothing is refused
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "ok", relay: "ok", enforce_at: null, refused: false, enforced: true } }, true, now)).toBeNull();
    // the PC says passes are not enforced yet: nothing is refused, even past the date by this browser's clock
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "ok", relay: "ok", enforce_at: "2001-02-03T00:00:00.000Z", refused: false, enforced: false, new_sessions: false } }, true, now)).toBeNull();
  });

  it("derives grace, required, not-listed, pc-limit and data-limit states from the relay status", () => {
    expect(relayNoticeFromStatus({
      ...baseRelay,
      pass: { state: "no_account", relay: "missing", enforce_at: "2001-02-03T00:00:00.000Z", refused: false },
    }, false)).toEqual({ kind: "sign-in-grace", enforceAt: "2001-02-03T00:00:00.000Z" });
    expect(relayNoticeFromStatus({
      ...baseRelay,
      phase: "error",
      pass: { state: "no_account", relay: null, enforce_at: null, refused: true },
    }, false)).toEqual({ kind: "sign-in-required", enforceAt: null });
    expect(relayNoticeFromStatus({
      ...baseRelay,
      pass: { state: "not_listed", relay: "missing", enforce_at: "2001-02-03T00:00:00.000Z", refused: true },
    }, true)).toEqual({ kind: "not-listed", enforceAt: null });
    expect(relayNoticeFromStatus({
      ...baseRelay,
      pass: { state: "limit", relay: null, enforce_at: null, refused: true },
    }, true)).toEqual({ kind: "pc-limit", enforceAt: null });
    expect(relayNoticeFromStatus({
      ...baseRelay,
      pass: { state: "ok", relay: "ok", enforce_at: "2001-02-03T00:00:00.000Z", refused: false, new_sessions: false },
    }, true)).toEqual({ kind: "data-limit", enforceAt: null });
  });
});

describe("relayNoticeFromStatus before the announced date", () => {
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const future = "2030-02-01T00:00:00.000Z";

  it("shows only the reminder naming the date while the relay refuses nothing", () => {
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "no_account", relay: "missing", enforce_at: future, refused: false } }, false, now))
      .toEqual({ kind: "sign-in-grace", enforceAt: future });
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "ok", relay: "ok", enforce_at: future, refused: false, new_sessions: false } }, true, now)).toBeNull();
  });

  it("shows a refusal by the relay whatever this browser's clock says of the date", () => {
    expect(relayNoticeFromStatus({ ...baseRelay, phase: "error", pass: { state: "no_account", relay: null, enforce_at: future, refused: true } }, false, now))
      .toEqual({ kind: "sign-in-required", enforceAt: null });
    expect(relayNoticeFromStatus({ ...baseRelay, phase: "error", pass: { state: "not_listed", relay: "missing", enforce_at: future, refused: true } }, true, now))
      .toEqual({ kind: "not-listed", enforceAt: null });
    expect(relayNoticeFromStatus({ ...baseRelay, phase: "error", pass: { state: "limit", relay: null, enforce_at: future, refused: true } }, true, now))
      .toEqual({ kind: "pc-limit", enforceAt: null });
  });

  it("does not read the refused flag as a refusal before the date while the relay lets this PC in", () => {
    // a regional relay's refusal sets the flag too; the status is the global relay's, which is online
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "no_account", relay: "missing", enforce_at: future, refused: true } }, false, now))
      .toEqual({ kind: "sign-in-grace", enforceAt: future });
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "not_listed", relay: "missing", enforce_at: future, refused: true } }, true, now)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "limit", relay: null, enforce_at: future, refused: true } }, true, now)).toBeNull();
  });

  it("keeps the data limit for the date even when the relay refused this PC", () => {
    expect(relayNoticeFromStatus({ ...baseRelay, phase: "error", pass: { state: "ok", relay: "ok", enforce_at: future, refused: true, new_sessions: false } }, true, now)).toBeNull();
  });

  it("shows the limit notices once the date has passed", () => {
    const after = Date.parse("2030-03-01T00:00:00.000Z");
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "limit", relay: null, enforce_at: future, refused: true } }, true, after)).toEqual({ kind: "pc-limit", enforceAt: null });
  });

  it("shows no limit notice when only this browser's clock is past the date and the relay refuses nothing", () => {
    const after = Date.parse("2030-03-01T00:00:00.000Z");
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "limit", relay: "ok", enforce_at: future, refused: false } }, true, after)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "not_listed", relay: "missing", enforce_at: future, refused: false } }, true, after)).toBeNull();
  });

  it("treats a date that does not parse as not yet enforced", () => {
    const after = Date.parse("2030-03-01T00:00:00.000Z");
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "limit", relay: null, enforce_at: "soon", refused: true } }, true, after)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "ok", relay: "ok", enforce_at: "soon", refused: false, new_sessions: false } }, true, after)).toBeNull();
    expect(relayNoticeFromStatus({ ...baseRelay, pass: { state: "no_account", relay: "missing", enforce_at: "soon", refused: false } }, false, after))
      .toEqual({ kind: "sign-in-grace", enforceAt: null });
  });

  it("shows a refusal by the relay beside a date that does not parse", () => {
    expect(relayNoticeFromStatus({ ...baseRelay, phase: "error", pass: { state: "limit", relay: null, enforce_at: "soon", refused: true } }, true, now))
      .toEqual({ kind: "pc-limit", enforceAt: null });
    expect(relayNoticeFromStatus({ ...baseRelay, phase: "error", pass: { state: "no_account", relay: null, enforce_at: "soon", refused: true } }, false, now))
      .toEqual({ kind: "sign-in-required", enforceAt: null });
  });
});

describe("relayNoticeOf", () => {
  const relay: RelayStatus = { ...baseRelay, phase: "error", pass: { state: "limit", relay: null, enforce_at: null, refused: true } };

  it("shows nothing to a watch-only or Portal session", () => {
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "device", role: "drive" }, relay })).toEqual({ kind: "pc-limit", enforceAt: null });
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "device", role: "watch" }, relay })).toBeNull();
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "portal", role: "drive" }, relay })).toBeNull();
  });

  it("shows nothing to a relay driver or a Portal visitor signed in with the token or a device", () => {
    const portal = { token_configured: true, pairing_gate: "closed", bind_scope: "loopback", observed_ingress: "portal", public_exposure: "unknown" } as const;
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "local", role: "drive" }, relay })).toEqual({ kind: "pc-limit", enforceAt: null });
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "relay", role: "drive" }, relay })).toBeNull();
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "token", role: "drive" }, relay, security: portal })).toBeNull();
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "device", role: "drive" }, relay, security: portal })).toBeNull();
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "device", role: "drive" }, relay, security: { ...portal, observed_ingress: "relay" } })).toBeNull();
  });

  it("shows nothing to a visitor let in by an open server, and still shows where the answer names no way in", () => {
    const open = { token_configured: false, pairing_gate: "open", bind_scope: "other", observed_ingress: "direct", public_exposure: "unknown" } as const;
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "open", role: "drive" }, relay, security: open })).toBeNull();
    // the PC itself on that open server is "local", and an answer without `via` (the demo's) hides nothing
    expect(relayNoticeOf({ auth: { required: false, authenticated: true, via: "local", role: "drive" }, relay, security: open })).toEqual({ kind: "pc-limit", enforceAt: null });
    expect(relayNoticeOf({ auth: { required: false, authenticated: true }, relay })).toEqual({ kind: "pc-limit", enforceAt: null });
  });
});

describe("RelayNotice", () => {
  const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

  it("renders the sign-in notice and dismiss button for an unsigned PC on the Ovis relay", () => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, {
        children: createElement(RelayNotice, {
          notice: { kind: "sign-in-grace", enforceAt: null },
          onOpen: () => undefined,
          onDismiss: () => undefined,
        }),
      }));
      expect(html).toContain(`data-testid="relay-notice"`);
      expect(html).toContain(`data-relay-notice="sign-in-grace"`);
      expect(html).toContain("Sign-in will be required for the Ovis relay.");
      expect(html).toContain(">Sign in</button>");
      expect(html).toContain(`aria-label="Dismiss"`);
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it("maps each notice kind to its action label and direct connection guidance", () => {
    expect(relayNoticeText(t, { kind: "sign-in-required", enforceAt: null })).toEqual({
      text: "The Ovis relay needs an Ovis account. Sign in, or connect over the same Wi-Fi or Tailscale.",
      actionLabel: "Sign in",
    });
    expect(relayNoticeText(t, { kind: "not-listed", enforceAt: null }).actionLabel).toBe("Account");
    expect(relayNoticeText(t, { kind: "pc-limit", enforceAt: null }).actionLabel).toBe("Devices and PCs");
    expect(relayNoticeText(t, { kind: "data-limit", enforceAt: null }).actionLabel).toBe("Devices and PCs");
  });
});
