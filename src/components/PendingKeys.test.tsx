import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";

import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import type { PendingKey } from "../../shared/machines.ts";
import { KeyFingerprintWait, PendingKeys } from "./PendingKeys.tsx";

const pending = (id: string, label: string, fingerprint: string): PendingKey => ({ id, label, fingerprint, via: "relay", redeemed_at: "2026-11-20T04:00:00.000Z", slots: { used: 2, of: 5 } });

describe("keys waiting for this PC's screen", () => {
  let page: Page;

  beforeEach(() => {
    page = openPage();
    Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
  });

  afterEach(async () => { await page.close(); });

  const text = (node: Element): string => node.textContent ?? "";

  it("T71: shows each key's fingerprint and says the name is the device's own claim", async () => {
    await page.render(<SettingsProvider><PendingKeys pending={[pending("p1", "Pixel 9", "AB12-CD34")]} onDecline={() => {}} /></SettingsProvider>);
    const shown = text(page.container);
    expect(shown).toContain("AB12-CD34");
    expect(shown).toContain("Pixel 9");
    expect(shown.toLowerCase()).toContain("says");
  });

  it("T72: declines exactly the one key pressed, and approving is left to this PC's screen", async () => {
    const declined: string[] = [];
    await page.render(<SettingsProvider><PendingKeys pending={[pending("p1", "Pixel 9", "AB12-CD34"), pending("p2", "iPad", "EF56-GH78")]} onDecline={(id) => declined.push(id)} /></SettingsProvider>);
    const buttons = [...page.container.querySelectorAll("button")].filter((node) => text(node) === "Decline");
    expect(buttons.map(text)).toEqual(["Decline", "Decline"]);
    expect([...page.container.querySelectorAll('button:not([aria-label="Dismiss"])')]).toEqual(buttons);
    await act(async () => { buttons[1]!.click(); });
    expect(declined).toEqual(["p2"]);
  });

  it("T71/T72: dismisses the list without declining a key until a new key arrives", async () => {
    const onDecline = mock();
    const first = pending("p1", "Pixel 9", "AB12-CD34");
    const screen = (keys: readonly PendingKey[]) => <SettingsProvider><PendingKeys pending={keys} onDecline={onDecline} /></SettingsProvider>;
    await page.render(screen([first]));
    const dismiss = page.one<HTMLButtonElement>('button[aria-label="Dismiss"]');
    await act(async () => { dismiss.click(); });
    expect(page.container.childNodes).toHaveLength(0);
    expect(onDecline).not.toHaveBeenCalled();
    await page.render(screen([{ ...first, label: "Updated phone" }]));
    expect(page.container.childNodes).toHaveLength(0);
    await page.render(screen([first, pending("p2", "iPad", "EF56-GH78")]));
    expect(text(page.container)).toContain("EF56-GH78");
    expect(onDecline).not.toHaveBeenCalled();
  });

  it("T71: the device shows the same fingerprint while it waits for the PC's screen", async () => {
    await page.render(<SettingsProvider><KeyFingerprintWait pc="Desk" fingerprint="AB12-CD34" /></SettingsProvider>);
    expect(text(page.container)).toContain("AB12-CD34");
  });

  it("T71: dismisses the fingerprint wait, with no answer control on the waiting device", async () => {
    await page.render(<SettingsProvider><KeyFingerprintWait pc="Desk" fingerprint="AB12-CD34" /></SettingsProvider>);
    const dismiss = page.one<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect([...page.container.querySelectorAll("button")]).toEqual([dismiss]);
    await act(async () => { dismiss.click(); });
    expect(page.container.childNodes).toHaveLength(0);
  });

  it("P11: where the PC has no screen proof the device says to approve on the PC and asks for no comparison", async () => {
    await page.render(<SettingsProvider><KeyFingerprintWait pc="Desk" fingerprint={null} /></SettingsProvider>);
    const shown = text(page.container);
    expect(shown).toContain("Desk");
    expect(shown).not.toMatch(/[0-9A-Z]{4}-[0-9A-Z]{4}/);
    expect([...page.container.querySelectorAll('[class="pending-key-fingerprint"]')]).toEqual([]);
  });
});
