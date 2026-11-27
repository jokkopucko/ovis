import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { DeviceNotice } from "../../shared/account-devices-api.ts";
import { keyFingerprint } from "../lib/deviceNotices.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { DeviceNotices } from "./DevicePairedNotice.tsx";

const KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(87);
const notice = (over: Partial<DeviceNotice>): DeviceNotice => ({
  seq: 1, id: "1".padStart(32, "0"), at: "2026-11-20T04:00:00.000Z", kind: "admit", how: "list", key: KEY, no: 4, row: "r1", label: "Galaxy S30",
  by: null, account: "acct", open: true, method: "github", two_step: "set", ...over,
});

describe("device notices", () => {
  let page: Page;

  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

  const text = (node: Element): string => node.textContent ?? "";
  const cards = () => [...page.container.querySelectorAll('[data-testid="device-notice"]')];
  const mount = async (notices: readonly DeviceNotice[], dismissed: DeviceNotice[] = [], cut = 0) => {
    await page.render(<SettingsProvider><DeviceNotices pc="Desk" notices={notices} cut={cut} onDismiss={(item) => dismissed.push(item)} /></SettingsProvider>);
    return cards();
  };

  it("T34: an admission names the PC, the device, its key and how it signed in", async () => {
    const [card] = await mount([notice({})]);
    const shown = text(card!);
    expect(shown).toContain("joined Desk: Galaxy S30");
    expect(shown).toContain("GitHub");
    expect(shown).toContain(keyFingerprint(KEY));
  });

  it("T58: Apple's two-step sign-in is said to be set on the account, never that this sign-in used it", async () => {
    const [card] = await mount([notice({ kind: "method", method: "apple", two_step: "set", open: false })]);
    const shown = text(card!);
    expect(shown).toContain("Apple");
    expect(shown).toContain("set");
    expect(shown.toLowerCase()).not.toContain("used");
  });

  it("an admission whose two-step nobody knows says nothing of two-step, and still names the device, its sign-in and its key", async () => {
    const [unnamed, google] = await mount([
      notice({ method: null, two_step: "unknown", label: "Chrome (Android)" }),
      notice({ seq: 2, id: "2".padStart(32, "0"), method: "google", two_step: "unknown" }),
    ]);
    const lines = (card: Element) => [...card.querySelectorAll('[class="settings-hint"]')].map(text);
    expect(text(unnamed!)).toContain("a new device was added on Desk: Chrome (Android)");
    expect(lines(unnamed!)).toEqual([`Key ${keyFingerprint(KEY)}`]);
    expect(lines(google!)).toEqual(["Google sign-in", `Key ${keyFingerprint(KEY)}`]);
  });

  it("T57: hiding an undecided admission neither records a dismissal nor answers or acknowledges it again", async () => {
    const onDismiss = mock();
    const onShown = mock();
    const answer = mock();
    const told = notice({ kind: "method", open: false });
    const open = notice({ seq: 2, id: "2".padStart(32, "0"), row: null });
    await page.render(<SettingsProvider><DeviceNotices pc="Desk" notices={[told, open]} onDismiss={onDismiss} onShown={onShown}
      actions={() => <button type="button" onClick={answer}>Answer</button>} /></SettingsProvider>);
    const dismiss = (card: Element) => {
      const buttons = card.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss"]');
      if (buttons.length !== 1) throw new Error("Expected one Dismiss button");
      return buttons[0]!;
    };
    const [closedCard, openCard] = cards();
    if (closedCard === undefined || openCard === undefined) throw new Error("Expected two notices");
    expect(onShown.mock.calls).toEqual([[2]]);
    await act(async () => { dismiss(openCard).click(); });
    expect(cards()).toEqual([closedCard]);
    expect(onDismiss).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(onShown.mock.calls).toEqual([[2]]);
    await act(async () => { dismiss(closedCard).click(); });
    expect(onDismiss.mock.calls).toEqual([[told]]);
  });

  it("G5: shows nothing for journal kinds this release does not tell here", async () => {
    expect(await mount([notice({ kind: "merge", open: false })])).toEqual([]);
  });

  it("P15: the PC's trimmed line shows the count even with no card left", async () => {
    await mount([], [], 12);
    expect(text(page.container)).toBe("12 older notices from Desk were cleared before this device saw them.");
    await mount([], [], 0);
    expect(text(page.container)).toBe("");
  });

  it("P15: one trimmed notice reads in the singular", async () => {
    await mount([], [], 1);
    const shown = text(page.container);
    expect(shown).toContain("An older notice from Desk");
    expect(shown).not.toContain("1 older notices");
  });
});

describe("keyFingerprint", () => {
  it("T34: four groups of four hex digits of the key's SHA-256, the same key the same every time", () => {
    expect(keyFingerprint(KEY)).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(keyFingerprint(KEY)).toBe(keyFingerprint(KEY));
    expect(keyFingerprint(KEY)).not.toBe(keyFingerprint(KEY.slice(0, -1) + "B"));
  });
});
