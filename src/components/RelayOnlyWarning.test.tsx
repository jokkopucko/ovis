import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import { RelayOnlyWarning } from "./RelayOnlyWarning.tsx";

describe("the relay-only warning", () => {
  let page: Page;
  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

  it("T70: a PC whose account opens every PC says to keep SSH or a screen, since one stolen older device could lock it", async () => {
    await page.render(<SettingsProvider><RelayOnlyWarning opensAll relayOnly /></SettingsProvider>);
    const shown = page.container.textContent;
    expect(shown).toContain("SSH");
    expect(shown).toContain("older device");
  });

  it("T70: the warning's only action dismisses the line", async () => {
    await page.render(<SettingsProvider><RelayOnlyWarning opensAll relayOnly /></SettingsProvider>);
    const dismiss = page.one<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect([...page.container.querySelectorAll("button")]).toEqual([dismiss]);
    await act(async () => { dismiss.click(); });
    expect(page.container.childNodes).toHaveLength(0);
  });

  it("T70: once dismissed on this device it stays dismissed when the setup screen is opened again", async () => {
    await page.render(<SettingsProvider><RelayOnlyWarning opensAll relayOnly /></SettingsProvider>);
    const dismiss = page.one<HTMLButtonElement>('button[aria-label="Dismiss"]');
    await act(async () => { dismiss.click(); });
    await page.render(null);
    await page.render(<SettingsProvider><RelayOnlyWarning opensAll relayOnly /></SettingsProvider>);
    expect(page.container.childNodes).toHaveLength(0);
  });

  it("T70: says nothing on a PC that other devices also reach without the relay", async () => {
    await page.render(<SettingsProvider><RelayOnlyWarning opensAll relayOnly={false} /></SettingsProvider>);
    expect(page.container.childNodes).toHaveLength(0);
  });

  it("G5: says nothing on a PC with the release off", async () => {
    await page.render(<SettingsProvider><RelayOnlyWarning opensAll={false} relayOnly /></SettingsProvider>);
    expect(page.container.childNodes).toHaveLength(0);
  });
});
