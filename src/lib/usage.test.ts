import { describe, expect, it } from "bun:test";
import type { ProviderUsage, UsageWindow } from "../../shared/protocol.ts";
import { agedReport, canSignInAgain, composerUsage, creditsText, formatPercent, formatResetIn, glanceWindow, goneBy, heldReport, isCurrent, isSignIn, meterPercent, meterText, moveInOrder, orderProviders, planForPane, providerForAgent, recordedBy, recordedNote, statusWindows, tightestWindow, usageName, windowLabel, type DeviceTime, type HeldReport } from "./usage.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const window = (used_percent: number, kind: UsageWindow["kind"] = "week", scope: string | null = null): UsageWindow => ({ kind, scope, used_percent, resets_at: null, starts_at: null });
const provider = (id: ProviderUsage["id"], windows: UsageWindow[], account: string | null = null): ProviderUsage => ({
  id, key: account ? `${id}:${account}` : id, account, plan: null, windows, problem: null, checked_at: null,
});

describe("usage meters", () => {
  it("says credits as the provider counts them: money in its currency, Codex's in whole credits", () => {
    expect(creditsText({ kind: "spend", currency: "EUR", used: 12.19, limit: 15.39, used_percent: 79.2 })).toBe("€12.19 / €15.39");
    expect(creditsText({ kind: "spend", currency: "JPY", used: 830, limit: null, used_percent: null })).toBe("¥830 spent");
    expect(creditsText({ kind: "spend", currency: "USD", used: null, limit: null, used_percent: null })).toBe("Unlimited");
    expect(creditsText({ kind: "balance", balance: 1231.84, unlimited: false })).toBe("1,232 credits");
    expect(creditsText({ kind: "balance", balance: null, unlimited: false })).toBe("Available");
    expect(creditsText({ kind: "balance", balance: null, unlimited: true })).toBe("Unlimited");
  });

  it("uses the agent's provider and the first visible account in Settings order", () => {
    const accounts = [provider("claude", [window(40)]), provider("codex", [window(20)], "a@x"), provider("codex", [window(80)], "b@x")];
    expect(composerUsage(accounts, "codex", ["codex:b@x"], [])?.account).toBe("b@x");
    expect(composerUsage(accounts, "codex", ["codex:b@x"], ["codex:b@x"])?.account).toBe("a@x");
    expect(composerUsage(accounts, "pi", [], [])).toBeUndefined();
    expect(composerUsage(accounts, null, [], [])).toBeUndefined();
    expect(providerForAgent("agy")).toBe("antigravity");
    expect(providerForAgent("opencode")).toBe("opencode");
  });

  it("looks up a pi-family pane's plan by the provider its conversation runs at", () => {
    const accounts = [provider("claude", [window(40)], "c@x"), provider("codex", [window(20)], "a@x"), provider("codex", [window(80)], "b@x")];
    for (const agent of ["gjc", "omp", "omo", "pi"]) {
      expect(planForPane(agent, "anthropic-subscription")).toBe("claude");
      expect(planForPane(agent, "openai-codex")).toBe("codex");
      expect(composerUsage(accounts, agent, [], [], "anthropic-subscription")?.account).toBe("c@x");
      expect(composerUsage(accounts, agent, ["codex:b@x"], [], "openai-codex")?.account).toBe("b@x");
      expect(composerUsage(accounts, agent, ["codex:b@x"], ["codex:b@x"], "openai-codex")?.account).toBe("a@x");
      // a plain `anthropic` may be an API key, as `openai` is: no plan, and none is guessed without one
      for (const other of ["anthropic", "openai", "zai", "__proto__", null, undefined]) {
        expect(planForPane(agent, other)).toBeNull();
        expect(composerUsage(accounts, agent, [], [], other)).toBeUndefined();
      }
    }
    expect(planForPane("codex", "anthropic-subscription")).toBe("codex");
    expect(planForPane(null, "anthropic-subscription")).toBe("claude");
  });

  it("prioritizes the plan-wide five-hour session, with weekly fallback only", () => {
    expect(statusWindows(provider("claude", [window(99, "week", "Sonnet"), window(84), window(22, "session")]))).toEqual([window(22, "session"), window(84)]);
    expect(statusWindows(provider("codex", [window(84)]))).toEqual([window(84)]);
    expect(statusWindows(provider("claude", [window(22, "session", "Opus"), window(84)]))).toEqual([window(84)]);
    expect(statusWindows(provider("cursor", [window(80, "month")]))).toEqual([]);
  });
  it("shows the limit closest to running out", () => {
    expect(tightestWindow(provider("codex", [window(12, "session"), window(77)]))).toEqual(window(77));
    expect(tightestWindow(provider("claude", []))).toBeNull();
  });

  it("shows the chosen limit of the whole plan, and the closest to running out where a plan has none", () => {
    const claude = provider("claude", [window(80, "session"), window(30), window(95, "week", "Sonnet")]);
    expect(glanceWindow(claude, "week")).toEqual(window(30));
    expect(glanceWindow(claude, "session")).toEqual(window(80, "session"));
    expect(glanceWindow(provider("codex", [window(30)]), "session")).toEqual(window(30));
    expect(glanceWindow(provider("cursor", [window(20, "month"), window(60, "month", "Premium")]), "week")).toEqual(window(60, "month", "Premium"));
    expect(glanceWindow(provider("grok", []), "week")).toBeNull();
  });

  it("keeps the server's order until the user arranges the accounts", () => {
    const order = orderProviders([provider("claude", []), provider("codex", [window(40)]), provider("copilot", [window(90, "month")])]);
    expect(order.map((usage) => usage.id)).toEqual(["claude", "codex", "copilot"]);
  });

  it("follows the user's order first, then the server's", () => {
    const providers = [provider("claude", [window(10)]), provider("codex", [window(40)], "a@x"), provider("codex", [window(90)], "b@x"), provider("grok", [window(50)])];
    const keys = (order: string[]) => orderProviders(providers, order).map((usage) => usage.key);
    expect(keys([])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
    expect(keys(["claude", "codex:a@x", "gone"])).toEqual(["claude", "codex:a@x", "codex:b@x", "grok"]);
  });

  it("moves an account one place and keeps accounts not reported now", () => {
    expect(moveInOrder(["a", "b", "c"], ["x", "b"], "c", -1)).toEqual(["a", "c", "b", "x"]);
    expect(moveInOrder(["a", "b", "c"], [], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveInOrder(["a", "b"], [], "a", 1)).toEqual(["b", "a"]);
  });

  it("says of another tool's record who recorded it and when, and that it may have moved once that tool stopped reading", () => {
    const at = (minutesAgo: number, stale: boolean): ProviderUsage => ({ ...provider("claude", [window(40)]), checked_at: new Date(NOW - minutesAgo * 60_000).toISOString(), recorded: { by: "omp", stale, signed_in: false } });
    expect(recordedNote(at(4, false), NOW)).toEqual(["Recorded by Oh My Pi, 4 min ago"]);
    expect(recordedNote(at(180, true), NOW)).toEqual(["Recorded by Oh My Pi, 3 h ago", "It may have changed since."]);
    expect(recordedBy(at(4, false))).toBe("Recorded by Oh My Pi");
    const own: ProviderUsage = { ...provider("claude", [window(40)]), checked_at: new Date(NOW - 180 * 60_000).toISOString() };
    expect(recordedNote(own, NOW)).toBeNull();
    expect(recordedBy(own)).toBeNull();
    const unknown: ProviderUsage = { ...at(4, false), recorded: { by: "a-tool-not-known-yet" as "omp", stale: false, signed_in: false } };
    expect(recordedNote(unknown, NOW)).toEqual(["Recorded by a-tool-not-known-yet, 4 min ago"]);
    expect(recordedBy(unknown)).toBe("Recorded by a-tool-not-known-yet");
  });

  it("ages what the PC last said by the time gone by on this device, never by comparing its clock with the PC's", () => {
    const PC = NOW + 40 * 60_000;
    const record = (minutesBefore: number, by: string, stale = false): ProviderUsage => ({ ...provider("claude", [window(40)], `${by}-${minutesBefore}`), checked_at: new Date(PC - minutesBefore * 60_000).toISOString(), recorded: { by: by as "omp", stale, signed_in: false } });
    const own: ProviderUsage = { ...provider("claude", [window(40)], "own"), checked_at: new Date(PC - 180 * 60_000).toISOString() };
    const heardAt: DeviceTime = { wall: NOW, running: 5_000 };
    const held: HeldReport = { report: { providers: [record(4, "omp"), record(10, "gjc"), record(10, "a-tool-not-known-yet"), record(180, "omp", true), own] }, serverTime: new Date(PC).toISOString(), heardAt };
    const stale = (from: HeldReport, minutes: number) => agedReport(from, minutes * 60_000).providers.map((usage) => usage.recorded?.stale ?? null);
    expect(stale(held, 0)).toEqual([false, false, false, true, null]);
    expect(stale(held, 5)).toEqual([false, false, false, true, null]);
    expect(stale(held, 6)).toEqual([false, true, true, true, null]);
    expect(stale(held, 12)).toEqual([true, true, true, true, null]);
    expect(agedReport(held, 5 * 60_000)).toBe(held.report);
    expect(agedReport(held, 6 * 60_000).providers.map(isCurrent)).toEqual([true, false, false, false, true]);
    const older: HeldReport = { ...held, serverTime: undefined };
    expect(stale(older, 15)).toEqual([false, false, false, true, null]);
    expect(stale(older, 16)).toEqual([true, true, true, true, null]);
  });

  it("takes the time gone by as the longer of the device's two clocks: a sleep stops one, a correction sets the other back", () => {
    const from: DeviceTime = { wall: NOW, running: 1_000 };
    expect(goneBy(from, { wall: NOW + 600_000, running: 601_000 })).toBe(600_000);
    expect(goneBy(from, { wall: NOW + 720_000, running: 1_200 })).toBe(720_000);
    expect(goneBy(from, { wall: NOW - 300_000, running: 601_000 })).toBe(600_000);
    expect(goneBy(from, { wall: NOW + 2_400_000, running: 601_000 })).toBe(2_400_000);
    expect(goneBy(from, { wall: NOW - 300_000, running: 500 })).toBe(0);
  });

  it("asks this device's clock for a record's age where an older server says no time, and believes it only where it agrees with the PC", () => {
    const record = (readAt: number): ProviderUsage => ({ ...provider("claude", [window(40)], "recorded"), checked_at: new Date(readAt).toISOString(), recorded: { by: "omp", stale: false, signed_in: false } });
    const stale = (readAt: number, minutes: number) => agedReport({ report: { providers: [record(readAt)] }, serverTime: undefined, heardAt: { wall: NOW, running: 0 } }, minutes * 60_000).providers[0]?.recorded?.stale;
    expect([1, 2].map((minutes) => stale(NOW - 14 * 60_000, minutes))).toEqual([false, true]);
    expect([2, 15, 16].map((minutes) => stale(NOW - 34 * 60_000, minutes))).toEqual([false, false, true]);
    expect([2, 15, 16].map((minutes) => stale(NOW + 5 * 60_000, minutes))).toEqual([false, false, true]);
  });

  it("holds the report object in hand while the PC says the same but for its time, and always the PC's latest time and arrival", () => {
    const record = (readAt: number): ProviderUsage => ({ ...provider("claude", [window(40)], "recorded"), checked_at: new Date(readAt).toISOString(), recorded: { by: "omp", stale: false, signed_in: false } });
    const answer = (minute: number, usage: ProviderUsage) => ({ server_time: new Date(NOW + minute * 60_000).toISOString(), providers: [usage] });
    const at = (minute: number): DeviceTime => ({ wall: 1_000 + minute * 60_000, running: minute * 60_000 });
    const first = heldReport(null, answer(1, record(NOW)), at(1));
    expect(first).toEqual({ report: { providers: [record(NOW)] }, serverTime: answer(1, record(NOW)).server_time, heardAt: at(1) });
    const again = heldReport(first, answer(14, record(NOW)), at(14));
    expect(again.report).toBe(first.report);
    expect(again).toEqual({ report: first.report, serverTime: answer(14, record(NOW)).server_time, heardAt: at(14) });
    expect([1, 2].map((minutes) => agedReport(again, minutes * 60_000).providers[0]?.recorded?.stale)).toEqual([false, true]);
    const reread = record(NOW + 14 * 60_000);
    expect(heldReport(again, answer(15, reread), at(15))).toEqual({ report: { providers: [reread] }, serverTime: answer(15, reread).server_time, heardAt: at(15) });
  });

  const withProblem = (problem: ProviderUsage["problem"], recorded?: ProviderUsage["recorded"]): ProviderUsage => ({ ...provider("claude", [window(40)]), problem, ...(recorded ? { recorded } : {}) });

  it("takes a number as what is used now when the server read it without a problem, or a tool still records it", () => {
    expect(isCurrent(withProblem(null))).toBe(true);
    expect(isCurrent(withProblem("expired"))).toBe(false);
    expect(isCurrent(withProblem(null, { by: "omp", stale: false, signed_in: false }))).toBe(true);
    expect(isCurrent(withProblem(null, { by: "omp", stale: true, signed_in: false }))).toBe(false);
    expect(isCurrent(withProblem("expired", { by: "omp", stale: false, signed_in: true }))).toBe(true);
    expect(isCurrent(withProblem("rate_limited", { by: "omp", stale: true, signed_in: true }))).toBe(false);
  });

  it("takes an account as a sign-in of this PC's unless it is known from another tool's record alone", () => {
    expect(isSignIn(withProblem(null))).toBe(true);
    expect(isSignIn(withProblem("expired"))).toBe(true);
    expect(isSignIn(withProblem("expired", { by: "omp", stale: false, signed_in: true }))).toBe(true);
    expect(isSignIn(withProblem(null, { by: "omp", stale: false, signed_in: false }))).toBe(false);
  });

  it("offers signing in again for an expired sign-in whose numbers a record stands in for, never for a record alone", () => {
    const account = (recorded: ProviderUsage["recorded"], problem: ProviderUsage["problem"]): ProviderUsage => ({ ...withProblem(problem, recorded), key: "claude:team" });
    expect(canSignInAgain(account({ by: "omp", stale: false, signed_in: true }, "expired"))).toBe(true);
    expect(canSignInAgain(account({ by: "omp", stale: false, signed_in: true }, "failed"))).toBe(false);
    expect(canSignInAgain(account({ by: "omp", stale: false, signed_in: false }, null))).toBe(false);
  });

  it("offers signing in again only for an expired sign-in this PC's own CLI holds", () => {
    const expired = (id: ProviderUsage["id"], key: string, problem: ProviderUsage["problem"] = "expired"): ProviderUsage => ({ ...provider(id, []), key, problem });
    expect(canSignInAgain(expired("claude", "claude:team"))).toBe(true);
    expect(canSignInAgain(expired("codex", "codex@0123456789ab"))).toBe(true);
    expect(canSignInAgain(expired("codex", "codex:cliproxy:hub-1"))).toBe(false);
    expect(canSignInAgain(expired("antigravity", "antigravity@keychain"))).toBe(false);
    expect(canSignInAgain(expired("cursor", "cursor:c1"))).toBe(false);
    expect(canSignInAgain(expired("opencode", "opencode@0123456789ab"))).toBe(false);
    expect(canSignInAgain(expired("claude", "claude:team", null))).toBe(false);
    expect(canSignInAgain(expired("claude", "claude:team", "failed"))).toBe(false);
  });

  it("counts a meter as used or left, and names the account", () => {
    expect(meterPercent(window(77.4), "used")).toBe(77.4);
    expect(meterPercent(window(77.4), "left")).toBe(22.6);
    expect(meterText(window(77), "used")).toBe("77%");
    expect(meterText(window(77), "left")).toBe("23% left");
    expect(usageName(provider("codex", [], "me@example.com"))).toBe("Codex · me@example.com");
    expect(usageName(provider("grok", []))).toBe("Grok");
  });

  it("formats the time to a reset, and nothing for a past or unknown one", () => {
    const at = (ms: number) => new Date(NOW + ms).toISOString();
    expect(formatResetIn(at(12 * 60_000), NOW)).toBe("12m");
    expect(formatResetIn(at(3 * 3600_000 + 5 * 60_000), NOW)).toBe("3h 5m");
    expect(formatResetIn(at(23 * 3600_000 + 59 * 60_000), NOW)).toBe("23h 59m");
    expect(formatResetIn(at(50 * 3600_000), NOW)).toBe("2d 2h");
    expect(formatResetIn(at(-1000), NOW)).toBeNull();
    expect(formatResetIn(null, NOW)).toBeNull();
  });

  it("keeps a sliver above zero visible and rounds the rest", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.4)).toBe("0.4%");
    expect(formatPercent(2.2)).toBe("2%");
    expect(formatPercent(99.6)).toBe("100%");
  });

  it("names a window by its span and its scope", () => {
    expect(windowLabel(window(1, "session"))).toBe("Session");
    expect(windowLabel(window(1, "week", "Sonnet"))).toBe("Weekly · Sonnet");
    expect(windowLabel(window(1, "month", "Premium"))).toBe("Monthly · Premium");
    expect(windowLabel(window(1, "month", "Cursor models"))).toBe("Monthly · Cursor models");
  });
});
