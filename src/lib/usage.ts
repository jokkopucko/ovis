import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProviderUsage, StatuslineState, UsageCredits, UsageProviderId, UsageRecorder, UsageReport, UsageWindow } from "../../shared/protocol.ts";
import { RECORDED_STALE_AFTER_MS } from "../../shared/usage.ts";
import { ApiError, fetchStatusline, fetchUsage, setStatusline } from "./api.ts";
import type { UsageCount, UsageGlance } from "./settings.ts";
import { currentLocale, t } from "./i18n.ts";
import { lastSeen } from "./lastSeen.ts";
import { usePageVisible } from "./visibility.ts";
import { PROVIDER_NAME } from "./usage-provider-names.ts";

export { PROVIDER_NAME } from "./usage-provider-names.ts";

/** The server asks a provider at most every 5 minutes; a minute here only picks that up sooner. */
const POLL_MS = 60_000;
export const HIGH_PERCENT = 80;

export const PROVIDER_MARK: Readonly<Record<UsageProviderId, string>> = {
  claude: "claude", codex: "codex", cursor: "cursor", copilot: "copilot", grok: "grok", antigravity: "agy", opencode: "opencode", devin: "devin", kimi: "kimi",
};

export const WINDOW_LABEL: Readonly<Record<UsageWindow["kind"], string>> = {
  session: "Session",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

export const RECORDER_NAME: Readonly<Record<UsageRecorder, string>> = { omp: "Oh My Pi", gjc: "Gajae Code" };

function recorderName(by: string): string {
  return (RECORDER_NAME as Readonly<Record<string, string | undefined>>)[by] ?? by;
}

export function providerForAgent(agent: string | null | undefined): UsageProviderId | null {
  return (Object.keys(PROVIDER_MARK) as UsageProviderId[]).find((id) => PROVIDER_MARK[id] === agent) ?? null;
}

/**
 * The providers a pi-family harness (gjc, omp, omo, pi) names that only a subscription signs in to:
 * `openai-codex` is ChatGPT's sign-in, `anthropic-subscription` OmO's Claude one (it runs Claude
 * Code). A plain `anthropic` is recorded the same for a Claude sign-in and an API key, so it, like
 * any other provider, is no plan.
 */
const PLAN_PROVIDER: Readonly<Record<string, UsageProviderId>> = { "anthropic-subscription": "claude", "openai-codex": "codex" };

export function planForPane(agent: string | null | undefined, provider: string | null | undefined): UsageProviderId | null {
  return providerForAgent(agent) ?? (provider && Object.hasOwn(PLAN_PROVIDER, provider) ? PLAN_PROVIDER[provider]! : null);
}

export function composerUsage(providers: readonly ProviderUsage[], agent: string | null, order: readonly string[], hidden: readonly string[], provider?: string | null): ProviderUsage | undefined {
  const providerId = planForPane(agent, provider);
  return orderProviders(providers, order).find((usage) => usage.id === providerId && !hidden.includes(usage.key));
}

export function statusWindows(usage: ProviderUsage): UsageWindow[] {
  return (usage.id === "devin" ? ["session", "day", "week"] as const : ["session", "week"] as const)
    .map((kind) => usage.windows.find((window) => window.kind === kind && window.scope === null))
    .filter((window): window is UsageWindow => window !== undefined);
}

export function tightestWindow(usage: ProviderUsage): UsageWindow | null {
  return usage.windows.reduce<UsageWindow | null>((tightest, window) => tightest === null || window.used_percent > tightest.used_percent ? window : tightest, null);
}

export function glanceWindow(usage: ProviderUsage, glance: UsageGlance): UsageWindow | null {
  return usage.windows.find((window) => window.kind === glance && window.scope === null) ?? tightestWindow(usage);
}

export function windowLabel(window: UsageWindow): string {
  const kind = t(WINDOW_LABEL[window.kind]);
  if (window.scope === null) return kind;
  const scope = window.scope === "Other models" ? t("Other models") : window.scope === "Cursor models" ? t("Cursor models") : window.scope;
  return `${kind} · ${scope}`;
}

export function usageName(usage: ProviderUsage): string {
  return usage.account ? `${PROVIDER_NAME[usage.id]} · ${usage.account}` : PROVIDER_NAME[usage.id];
}

/** An account read through the hub: its sign-in lives in the hub, not on this PC. */
export function isHubAccount(usage: ProviderUsage): boolean {
  return usage.key.startsWith(`${usage.id}:cliproxy:`);
}

export function recordedBy(usage: ProviderUsage): string | null {
  return usage.recorded ? t("Recorded by {tool}", { tool: recorderName(usage.recorded.by) }) : null;
}

const LONGEST_STALE_AFTER_MS = Math.max(...Object.values(RECORDED_STALE_AFTER_MS));

/**
 * This device's two clocks, read together. A correction can set the wall clock back or forward; the running one only
 * moves on, but stands still on some devices while they sleep.
 */
export interface DeviceTime {
  readonly wall: number;
  readonly running: number;
}

const deviceTime = (): DeviceTime => ({ wall: Date.now(), running: performance.now() });

export function goneBy(from: DeviceTime, to: DeviceTime): number {
  return Math.max(0, to.wall - from.wall, to.running - from.running);
}

export interface HeldReport {
  readonly report: UsageReport;
  readonly serverTime: string | undefined;
  readonly heardAt: DeviceTime;
}

export function heldReport(held: HeldReport | null, next: UsageReport, heardAt: DeviceTime): HeldReport {
  const { server_time: serverTime, ...said } = next;
  return { report: held !== null && JSON.stringify(held.report) === JSON.stringify(said) ? held.report : said, serverTime, heardAt };
}

function ageWhenHeard(held: HeldReport, checkedAt: string | null, limit: number): number {
  if (checkedAt === null) return 0;
  if (held.serverTime !== undefined) {
    const seen = Date.parse(held.serverTime) - Date.parse(checkedAt);
    return Number.isFinite(seen) ? Math.max(0, seen) : 0;
  }
  const guessed = held.heardAt.wall - Date.parse(checkedAt);
  return guessed >= 0 && guessed <= limit ? guessed : 0;
}

export function agedReport(held: HeldReport, since: number): UsageReport {
  const aged = (usage: ProviderUsage): ProviderUsage => {
    if (!usage.recorded || usage.recorded.stale) return usage;
    const limit = (RECORDED_STALE_AFTER_MS as Readonly<Record<string, number | undefined>>)[usage.recorded.by] ?? LONGEST_STALE_AFTER_MS;
    return ageWhenHeard(held, usage.checked_at, limit) + since > limit ? { ...usage, recorded: { ...usage.recorded, stale: true } } : usage;
  };
  const providers = held.report.providers.map(aged);
  return providers.some((usage, index) => usage !== held.report.providers[index]) ? { ...held.report, providers } : held.report;
}

export function recordedNote(usage: ProviderUsage, now: number): readonly string[] | null {
  if (!usage.recorded) return null;
  const by = t("Recorded by {tool}, {when}", { tool: recorderName(usage.recorded.by), when: lastSeen(usage.checked_at, now) });
  return usage.recorded.stale ? [by, t("It may have changed since.")] : [by];
}

/**
 * Whether the server's PC holds a sign-in of this account. Not so for one known only from another tool's record of
 * it: that is the tool's sign-in, and the agent itself is still to be signed in.
 */
export function isSignIn(usage: ProviderUsage): boolean {
  return usage.recorded?.signed_in !== false;
}

export function isCurrent(usage: ProviderUsage): boolean {
  return usage.recorded ? !usage.recorded.stale : usage.problem === null;
}

/**
 * An expired sign-in this PC's own CLI can renew in a terminal tab, in the account's own home:
 * Claude's and Codex's, whose CLIs sign in to the home they are given. The other CLIs may keep a
 * sign-in apart from the one read here (Cursor's app, Copilot's editor), and a hub's account signs
 * in in the hub.
 */
export function canSignInAgain(usage: ProviderUsage): boolean {
  return usage.problem === "expired" && (usage.id === "claude" || usage.id === "codex") && !isHubAccount(usage);
}

export function meterPercent(window: UsageWindow, count: UsageCount): number {
  return count === "left" ? Math.round((100 - window.used_percent) * 10) / 10 : window.used_percent;
}

export function meterText(window: UsageWindow, count: UsageCount): string {
  const value = formatPercent(meterPercent(window, count));
  return count === "left" ? t("{percent} left", { percent: value }) : value;
}

export function formatResetIn(resetsAt: string | null, now: number): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.ceil((Date.parse(resetsAt) - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 60) return t("{m}m", { m: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{h}h {m}m", { h: hours, m: minutes % 60 });
  return t("{d}d {h}h", { d: Math.floor(hours / 24), h: hours % 24 });
}

export function creditsText(credits: UsageCredits): string {
  const locale = currentLocale();
  const money = (amount: number, currency: string): string => {
    try { return new Intl.NumberFormat(locale, { style: "currency", currency }).format(amount); } catch { return `${amount} ${currency}`; }
  };
  if (credits.kind === "balance") {
    if (credits.unlimited) return t("Unlimited");
    if (credits.balance === null) return t("Available");
    return credits.currency === undefined
      ? t("{n} credits", { n: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(credits.balance) })
      : money(credits.balance, credits.currency);
  }
  if (credits.limit !== null) return `${credits.used === null ? "—" : money(credits.used, credits.currency)} / ${money(credits.limit, credits.currency)}`;
  return credits.used === null ? t("Unlimited") : t("{amount} spent", { amount: money(credits.used, credits.currency) });
}

export function formatPercent(value: number): string {
  return value > 0 && value < 1 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

export function orderProviders(providers: readonly ProviderUsage[], order: readonly string[] = []): ProviderUsage[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...providers].sort((a, b) => {
    const ranked = [rank.get(a.key), rank.get(b.key)];
    if (ranked[0] !== undefined && ranked[1] !== undefined) return ranked[0] - ranked[1];
    if (ranked[0] !== undefined || ranked[1] !== undefined) return ranked[0] !== undefined ? -1 : 1;
    return 0;
  });
}

export function moveInOrder(shown: readonly string[], saved: readonly string[], key: string, by: -1 | 1): string[] {
  const next = [...shown];
  const from = next.indexOf(key);
  const to = from + by;
  if (from < 0 || to < 0 || to >= next.length) return [...shown, ...saved.filter((known) => !shown.includes(known))];
  [next[from], next[to]] = [next[to]!, next[from]!];
  return [...next, ...saved.filter((known) => !shown.includes(known))];
}

export function useUsage(enabled: boolean) {
  const [held, setHeld] = useState<HeldReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [silence, setSilence] = useState<{ readonly since: number; readonly at: DeviceTime; readonly from: DeviceTime }>(() => { const opened = deviceTime(); return { since: 0, at: opened, from: opened }; });
  const visible = usePageVisible();
  const generation = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const current = ++generation.current;
    setLoading(true);
    const askedAt = deviceTime();
    setSilence((before) => ({ since: Math.max(before.since + Math.max(0, askedAt.running - before.at.running), goneBy(before.from, askedAt)), at: askedAt, from: before.from }));
    try {
      const next = await fetchUsage(refresh);
      if (current === generation.current) { const heardAt = deviceTime(); setHeld((previous) => heldReport(previous, next, heardAt)); setSilence({ since: 0, at: heardAt, from: heardAt }); }
    } catch {}
    finally { if (current === generation.current) setLoading(false); }
  }, []);

  useEffect(() => {
    if (!enabled) { generation.current++; setHeld(null); setLoading(false); return; }
    if (!visible) return;
    void load(false);
    const timer = setInterval(() => void load(false), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, visible, load]);

  useEffect(() => {
    if (!enabled) return;
    const changed = () => void load(true);
    window.addEventListener("herdr-usage-changed", changed);
    return () => window.removeEventListener("herdr-usage-changed", changed);
  }, [enabled, load]);

  const refresh = useCallback(() => { if (enabled) void load(true); }, [enabled, load]);
  const report = useMemo(() => held === null ? null : agedReport(held, silence.since), [held, silence.since]);
  return { report, loading, refresh };
}

const STATUSLINE_CHANGED = "herdr-statusline-changed";

export function useStatuslineSwitch(watch: boolean) {
  const [state, setState] = useState<StatuslineState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!watch) return;
    let live = true;
    const read = () => void fetchStatusline().then((next) => { if (live) setState(next); }, () => {});
    read();
    window.addEventListener(STATUSLINE_CHANGED, read);
    return () => { live = false; window.removeEventListener(STATUSLINE_CHANGED, read); };
  }, [watch]);
  const set = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setState(await setStatusline(enabled));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.detail : t("Could not change Claude's status line"));
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event(STATUSLINE_CHANGED));
      window.dispatchEvent(new Event("herdr-usage-changed"));
    }
  }, []);
  return { state, busy, error, set };
}
