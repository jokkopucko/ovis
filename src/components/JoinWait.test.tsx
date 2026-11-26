import { afterEach, beforeEach, describe, expect, it, jest, mock } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import { ItsMeButton, JoinWait } from "./JoinWait.tsx";

const NOW = Date.parse("2026-11-20T04:00:00.000Z");

describe("the new device's wait", () => {
  let page: Page;

  beforeEach(() => { page = openPage(); });
  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
  });

  const text = () => page.container.textContent ?? "";
  const mount = async (element: React.ReactElement) => {
    await page.render(<SettingsProvider>{element}</SettingsProvider>);
    return text();
  };

  it("T53: counts down to the PC's own deadline, in whole seconds", async () => {
    expect(await mount(<JoinWait pc="Desk" hold={{ reason: "join_hold", until: "2026-11-20T04:00:07.400Z" }} now={NOW} />)).toContain("8");
  });

  it("T53: the live wait changes seconds without a fresh refusal from the PC", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const hold = { reason: "join_hold", until: "2026-11-20T04:00:07.400Z" } as const;
    expect(await mount(<JoinWait pc="Desk" hold={hold} />)).toContain("8");
    await act(async () => { jest.advanceTimersByTime(1000); });
    expect(text()).toContain("7");
  });

  it("T53: a hold with no deadline shows no countdown", async () => {
    expect(await mount(<JoinWait pc="Desk" hold={{ reason: "catching_up" }} now={NOW} />)).not.toMatch(/\d/);
  });

  it("P17: before the PC has told the other devices, it says so and shows no number", async () => {
    const shown = await mount(<JoinWait pc="Desk" hold={{ reason: "join_hold", until: null }} now={NOW} />);
    expect(shown).toContain("telling your other devices");
    expect(shown).not.toMatch(/\d/);
  });

  it("T67: a PC that holds nothing shows no wait", async () => {
    expect(await mount(<JoinWait pc="Desk" hold={undefined} now={NOW} />)).toBe("");
  });

  it("T53/T67: dismissal leaves the same hold hidden without answering, and a new reason shows", async () => {
    const onPress = mock();
    const screen = (wait: React.ReactElement) => <SettingsProvider>{wait}<ItsMeButton sending={false} onPress={onPress} /></SettingsProvider>;
    const hold = { reason: "join_hold", until: null } as const;
    await page.render(screen(<JoinWait pc="Desk" hold={hold} now={NOW} />));
    await act(async () => { page.one('button[aria-label="Dismiss"]').click(); });
    expect([...page.container.querySelectorAll('[role="status"]')]).toEqual([]);
    expect(onPress).not.toHaveBeenCalled();
    await page.render(screen(<JoinWait pc="Desk" hold={{ ...hold, until: "2026-11-20T04:00:07.400Z" }} now={NOW + 1000} />));
    expect([...page.container.querySelectorAll('[role="status"]')]).toEqual([]);
    await page.render(screen(<JoinWait pc="Desk" hold={{ reason: "catching_up" }} now={NOW} />));
    expect(page.one('[role="status"]').textContent).toContain("checking your account");
    expect(onPress).not.toHaveBeenCalled();
  });

  it("T53: It's me is one press, held while it goes to each PC", async () => {
    let presses = 0;
    await mount(<ItsMeButton sending={false} onPress={() => { presses += 1; }} />);
    await act(async () => { page.one("button").click(); });
    expect(presses).toBe(1);
    await page.render(<SettingsProvider><ItsMeButton sending onPress={() => {}} /></SettingsProvider>);
    expect(page.one<HTMLButtonElement>("button").disabled).toBe(true);
  });
});
