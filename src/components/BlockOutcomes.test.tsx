import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { PcBlockOutcome } from "../../shared/account-devices-api.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { BlockOutcomes, NotMeButton } from "./BlockOutcomes.tsx";

const id = "c".repeat(64);
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "d".repeat(32);
const D = "e".repeat(32);
const names = new Map([[A, "Desk"], [B, "Lab"], [C, "Away"], [D, "Old box"]]);

describe("a block's outcome on each PC", () => {
  let page: Page;
  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

  it("T60, T65: only a PC's own receipt reads blocked; a refusal says why; a PC not reached promises no time", async () => {
    const outcomes: PcBlockOutcome[] = [
      { server_id: A, state: "applied", receipt: { outcome: "applied", id, n: 2 } },
      { server_id: B, state: "refused", receipt: { outcome: "refused", id, reason: "signer_not_older" } },
      { server_id: C, state: "unreachable" },
      { server_id: D, state: "waiting" },
    ];
    await page.render(<SettingsProvider><BlockOutcomes outcomes={outcomes} names={names} /></SettingsProvider>);
    const lines = [...page.container.querySelectorAll("li")].map((node) => node.textContent ?? "");
    expect(lines[0]).toBe("Desk: blocked");
    expect(lines[1]).toContain("Lab: not blocked");
    expect(lines.slice(1).every((line) => !line.endsWith(": blocked"))).toBe(true);
    expect(lines[2]).toContain("Away");
    expect(lines[2]).not.toMatch(/\d+ (second|minute)/);
  });

  it("T51: Not me answers once and cannot be pressed again while it is sent", async () => {
    let presses = 0;
    await page.render(<SettingsProvider><NotMeButton sending={false} onPress={() => { presses += 1; }} /></SettingsProvider>);
    await act(async () => { page.one("button").click(); });
    expect(presses).toBe(1);
    await page.render(<SettingsProvider><NotMeButton sending onPress={() => { presses += 1; }} /></SettingsProvider>);
    expect(page.one<HTMLButtonElement>("button").disabled).toBe(true);
  });
});
