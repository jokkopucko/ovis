import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from "react";
import { RefreshCw } from "lucide-react";

import "./UsageMeters.css";

import type { ProviderUsage, UsageCredits, UsageWindow } from "../../shared/protocol.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useSettings, type UsageCount, type UsageGlance } from "../lib/settings.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { canSignInAgain, creditsText, formatPercent, formatResetIn, glanceWindow, HIGH_PERCENT, meterPercent, meterText, orderProviders, PROVIDER_MARK, PROVIDER_NAME, recordedNote, usageName, useStatuslineSwitch, useUsage, windowLabel } from "../lib/usage.ts";
import { AgentMark } from "./AgentMark.tsx";
import { UsageSignInAgain } from "./UsageLocalLogin.tsx";
import { UsageSignInDialog } from "./UsageSignInDialog.tsx";
import type { UsageLoginRequest } from "../../shared/usage-login.ts";

const FALLBACK_CHIPS = 4;

function level(window: UsageWindow | null): string {
  return window !== null && window.used_percent >= HIGH_PERCENT ? " is-high" : "";
}

function problemText(t: Translate, usage: ProviderUsage, offered: boolean): string | null {
  const name = PROVIDER_NAME[usage.id];
  if (usage.recorded && (usage.problem === "failed" || usage.problem === "rate_limited")) return null;
  return usage.problem === "expired" ? offered ? t("Sign-in expired.") : t("Sign-in expired. Open {name} to renew it.", { name })
    : usage.problem === "rate_limited" ? t("{name} asked to slow down. These are the last numbers.", { name })
    : usage.problem === "failed" ? failureText(t, usage, name)
    : usage.problem === "locked" ? t("The server cannot open the keychain holding this sign-in.")
    : null;
}

function failureText(t: Translate, usage: ProviderUsage, name: string): string {
  switch (usage.failure) {
    case "upstream": return t("{name} is busy or down. Try again later.", { name });
    case "timeout": return t("{name} took too long to answer.", { name });
    case "bad_response": return t("{name} sent an answer Ovis cannot read.", { name });
    case "network": return t("This PC could not connect to {name}.", { name });
    case "hub": return t("Hub could not read this account.");
    case undefined: return t("{name} could not be reached.", { name });
  }
}

function isError(usage: ProviderUsage): boolean {
  return usage.problem === "expired" || usage.problem === "failed";
}

function otherHigh(usage: ProviderUsage, shown: UsageWindow | null): UsageWindow | null {
  return usage.windows.find((window) => window !== shown && window.used_percent >= HIGH_PERCENT) ?? null;
}

function Chip({ usage, count, glance }: { usage: ProviderUsage; count: UsageCount; glance: UsageGlance }) {
  const window = glanceWindow(usage, glance);
  return (
    <span className={`usage-chip${level(window)}${usage.problem && !usage.recorded ? " has-problem" : ""}${usage.recorded ? " is-recorded" : ""}${usage.recorded?.stale ? " is-stale" : ""}`}>
      <AgentMark agent={PROVIDER_MARK[usage.id]} size={14} />
      <span className="usage-chip-value">{window ? formatPercent(meterPercent(window, count)) : "—"}</span>
      <span className="usage-chip-bar" style={{ "--fill": `${window ? meterPercent(window, count) : 0}%` } as CSSProperties} />
    </span>
  );
}

function CreditsRow({ credits, count }: { credits: UsageCredits; count: UsageCount }) {
  const t = useT();
  const label = credits.kind === "spend" ? t("Usage credits") : t("Credits");
  const text = creditsText(credits);
  const used = credits.kind === "spend" ? credits.used_percent : null;
  const value = used === null ? null : count === "left" ? Math.round((100 - used) * 10) / 10 : used;
  return (
    <div className={`usage-row${used !== null && used >= HIGH_PERCENT ? " is-high" : ""}`}>
      <span className="usage-row-label">{label}</span>
      <span className="usage-row-value">{text}</span>
      {value !== null && <span className="usage-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={text}>
        <span style={{ width: value > 0 ? `max(4px, ${value}%)` : 0 }} />
      </span>}
    </div>
  );
}

function Provider({ usage, now, count, onLocalLogin, onFollow, watching }: { usage: ProviderUsage; now: number; count: UsageCount; onLocalLogin: ((paneId: string) => void) | undefined; onFollow: (request: Extract<UsageLoginRequest, { provider: "claude" | "codex" }>) => void; watching: boolean }) {
  const t = useT();
  const statusline = useStatuslineSwitch(false);
  const name = PROVIDER_NAME[usage.id];
  const offered = onLocalLogin !== undefined && canSignInAgain(usage);
  const problem = problemText(t, usage, offered);
  const recorded = recordedNote(usage, now);
  return (
    <section className={`usage-provider${usage.recorded?.stale ? " is-stale" : ""}`} aria-label={usageName(usage)}>
      <header className="usage-provider-head">
        <AgentMark agent={PROVIDER_MARK[usage.id]} size={16} />
        <span className="usage-provider-name">{name}</span>
        {usage.plan && <span className="usage-plan">{usage.plan}</span>}
        {usage.account && <span className="usage-account" title={usage.account}>{usage.account}</span>}
      </header>
      {recorded && <p className="usage-note usage-recorded">{recorded.map((line) => <span key={line}>{line}</span>)}</p>}
      {problem && <p className={`usage-note${isError(usage) ? " is-problem" : ""}`}>{problem}</p>}
      {offered && <UsageSignInAgain usage={usage} onStarted={onLocalLogin} onFollow={onFollow} />}
      {/* Claude's endpoint refused (a 403 to a token that has not expired), limited or failed: the status line can stand in */}
      {usage.statusline_offer && !watching && <button type="button" className="btn btn-ghost usage-offer" disabled={statusline.busy} onClick={() => void statusline.set(true)}>
        {t("Read from Claude's status line instead")}
      </button>}
      {statusline.error && <p className="usage-note is-problem" role="alert">{statusline.error}</p>}
      {/* turned on here, the numbers come once Claude next draws its line: say so instead of leaving "expired" alone */}
      {statusline.state?.installed && usage.problem !== null && !usage.statusline_offer && <p className="usage-note" role="status">{t("On. Claude's limits show once Claude Code next draws its status line.")}</p>}
      {usage.windows.map((window, index) => {
        const reset = formatResetIn(window.resets_at, now);
        const value = meterPercent(window, count);
        return (
          <div key={index} className={`usage-row${level(window)}`}>
            <span className="usage-row-label">{windowLabel(window)}</span>
            {reset && <span className="usage-row-reset">{t("Resets in {time}", { time: reset })}</span>}
            <span className="usage-row-value">{meterText(window, count)}</span>
            <span className="usage-bar" role="meter" aria-label={windowLabel(window)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={meterText(window, count)}>
              <span style={{ width: value > 0 ? `max(4px, ${value}%)` : 0 }} />
            </span>
          </div>
        );
      })}
      {usage.credits && <CreditsRow credits={usage.credits} count={count} />}
      {usage.resets && (() => {
        const expires = formatResetIn(usage.resets.expires_at, now);
        return (
          <div className="usage-row">
            <span className="usage-row-label">{t("Limit resets")}</span>
            {expires && <span className="usage-row-reset">{t("Expires in {time}", { time: expires })}</span>}
            <span className="usage-row-value">{t("{n} left", { n: usage.resets.available })}</span>
          </div>
        );
      })()}
      {usage.windows.length === 0 && !usage.credits && !usage.resets && !problem && <p className="usage-note">{t("No limits reported")}</p>}
    </section>
  );
}

/** `watching`: a watching device is not offered what it cannot turn on or sign in to */
export function UsageMeters({ onLocalLogin, watching = false }: { /** opens a sign-in tab; a watching device has none */ readonly onLocalLogin?: (paneId: string) => void; readonly watching?: boolean }) {
  const t = useT();
  const { settings } = useSettings();
  const { report, loading, refresh } = useUsage(settings.showUsage);
  const [open, setOpen] = useState(false);
  const shown = report ? orderProviders(report.providers, settings.usageOrder).filter((usage) => !settings.usageHidden.includes(usage.key)) : [];
  const drawn = settings.showUsage && shown.length > 0;
  usePhoneSheetBack(() => setOpen(false), open && drawn);
  const [following, setFollowing] = useState<Extract<UsageLoginRequest, { provider: "claude" | "codex" }> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLButtonElement>(null);
  const [room, setRoom] = useState<{ all: number; folding: number } | null>(null);

  useEffect(() => { if (!drawn) setOpen(false); }, [drawn]);
  useEffect(() => {
    if (!settings.showUsage) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, [settings.showUsage, open]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape" || !open) return;
    event.stopPropagation();
    setOpen(false);
    stripRef.current?.focus();
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };

  // as many chips as the row has room for, judged by the widest chip drawn so far: it only grows,
  // so the count only shrinks and settles, where an average of whichever chips show would swing
  const widestChip = useRef(0);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const measure = (): void => {
      const strip = stripRef.current;
      if (!strip) return;
      for (const chip of strip.querySelectorAll<HTMLElement>(".usage-chip")) widestChip.current = Math.max(widestChip.current, chip.offsetWidth);
      if (widestChip.current === 0) return;
      const style = getComputedStyle(strip);
      const gap = parseFloat(style.columnGap) || 0;
      const chip = widestChip.current + gap;
      const available = root.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) + gap;
      const more = 3 * parseFloat(getComputedStyle(root).fontSize) * 0.45 + gap;
      const all = Math.floor(available / chip), folding = Math.max(1, Math.floor((available - more) / chip));
      setRoom((last) => last?.all === all && last.folding === folding ? last : { all, folding });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  });

  const count = settings.usageCount;
  if (!drawn) return null;
  const fits = room ?? { all: FALLBACK_CHIPS, folding: FALLBACK_CHIPS - 1 };
  const chips = shown.length > fits.all ? shown.slice(0, fits.folding) : shown;
  const folded = shown.length - chips.length;
  const summary = shown.map((usage) => {
    const window = glanceWindow(usage, settings.usageGlance);
    const high = otherHigh(usage, window);
    const recorded = recordedNote(usage, now);
    return `${usageName(usage)} ${window ? meterText(window, count) : "—"}${high ? ` (${windowLabel(high)} ${meterText(high, count)})` : ""}${recorded ? ` (${recorded.join(" · ")})` : ""}`;
  }).join(", ");

  return (
    <div className="usage" ref={rootRef} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={stripRef}
        type="button"
        className="usage-strip"
        aria-expanded={open}
        aria-label={`${t("Subscription usage")}: ${summary}`}
        title={summary}
        onClick={() => setOpen(!open)}
      >
        {chips.map((usage) => <Chip key={usage.key} usage={usage} count={count} glance={settings.usageGlance} />)}
        {folded > 0 && <span className="usage-more">+{folded}</span>}
      </button>
      {open && (
        <div className="usage-popover" role="dialog" aria-label={t("Subscription usage")}>
          <header className="usage-popover-head">
            <span>{t("Subscription usage")}</span>
            {/* busy, not disabled: a disabled button drops focus, and Escape with it */}
            <button type="button" className="icon-button" aria-label={t("Refresh")} title={t("Refresh")} aria-busy={loading} onClick={() => { if (!loading) refresh(); }}>
              <RefreshCw aria-hidden="true" className={loading ? "is-spinning" : undefined} />
            </button>
          </header>
          {shown.map((usage) => <Provider key={usage.key} usage={usage} now={now} count={count} watching={watching} onLocalLogin={onLocalLogin && ((paneId) => { setOpen(false); onLocalLogin(paneId); })}
            onFollow={(request) => { setOpen(false); setFollowing(request); }} />)}
        </div>
      )}
      {following && onLocalLogin && <UsageSignInDialog request={following} onOpenTerminal={(paneId) => { setFollowing(null); onLocalLogin(paneId); }}
        onSignedIn={refresh} onClose={() => { setFollowing(null); stripRef.current?.focus(); }} />}
    </div>
  );
}
