import { useCallback, useEffect, useState } from "react";
import type { RelayStatus } from "../../shared/protocol.ts";
import type { HealthInfo } from "./api.ts";

/**
 * Whether the Ovis relay notice banner (components/RelayNotice.tsx) was dismissed in this browser.
 * Follows the same scoped-key pattern as useDirectNotice (lib/directNotice.ts): one dismissal
 * covers one PC and one notice state, and clears when the relay is off or the state is resolved.
 */
const KEY = "ovis:relay-notice-dismissed";

export type RelayNoticeKind = "sign-in-grace" | "sign-in-required" | "not-listed" | "pc-limit" | "data-limit";

export interface RelayNoticeInfo {
  readonly kind: RelayNoticeKind;
  readonly enforceAt: string | null;
}

const entry = (scope: string, kind: RelayNoticeKind) => `${scope} ${kind}`;

function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function writeDismissed(dismissed: readonly string[]): void {
  try {
    if (dismissed.length) window.localStorage.setItem(KEY, JSON.stringify(dismissed));
    else window.localStorage.removeItem(KEY);
  } catch { /* storage blocked: the dismissal lasts until the page reloads */ }
}

/**
 * Derives the relay notice state from a health or relay status answer:
 * - undefined before a known answer arrives (so stored dismissals are kept), and while an answer cannot
 *   say whether the relay still refuses this PC (below): nothing shows then, and nothing is forgotten
 * - null when the relay is off, not Ovis-hosted, or needs no notice
 * - RelayNoticeInfo when this PC uses the Ovis-hosted relay and needs sign-in or hit a limit
 *
 * Nothing shows until the relay itself announces passes: a date from when they are needed
 * (`enforce_at`, grace) or a refusal. A relay that says neither changes nothing on screen.
 * Before a date still to come, by this browser's clock, only the sign-in reminder that names the date
 * shows, unless the relay already closed this PC for its pass: a refusal is the relay's own word that
 * it enforces, and it shows whatever the date and the clock say. A PC it closed looks again every 30
 * minutes and whenever a pass comes; until the relay answers that attempt, whether it still refuses is
 * not known, so a notice dismissed before is not forgotten for it (undefined, where nothing else shows).
 *
 * The limit on new devices is an exception too: the PC says itself whether the relay enforces passes now
 * (`enforced`), which a relay in `enforce` does with no date or with one far ahead. While it does and the
 * pass says `new_sessions: false`, the PC refuses every new device, so the notice shows whatever the date;
 * while it says it does not, nothing is refused and no such notice shows.
 */
export function relayNoticeFromStatus(relay: RelayStatus | null | undefined, signedIn = false, now = Date.now()): RelayNoticeInfo | null | undefined {
  if (relay === undefined) return undefined;
  if (relay === null || relay.phase === "off" || relay.blocked !== null) return null;
  const pass = relay.pass;
  if (pass === undefined) return null;
  // a PC the relay refuses is not on it: what to say then is why, below
  if (pass.new_sessions === false && pass.enforced === true && !pass.refused) return { kind: "data-limit", enforceAt: null };
  if (pass.enforce_at === null && !pass.refused) return null;
  const remind = pass.state === "no_account" && ((pass.relay !== null && pass.relay !== "ok") || !signedIn);
  const at = pass.enforce_at === null ? null : Date.parse(pass.enforce_at);
  // a date that does not parse names no time at all: nothing counts as enforced on it
  const early = at !== null && (Number.isNaN(at) || now < at);
  // The flag beside the global link in error: how a refusal is read where no date is still to come
  // (components/RelayPanel.tsx statusText reads one so too)
  const refused = pass.refused && relay.phase === "error";
  // The relay closed this PC for its pass, so it enforces already: this browser's clock may run behind
  // the date, or the relay may name a date and enforce before it. The flag does not say so, with the link
  // in error or not: a regional relay's refusal sets it too, while the status is the global link's, which
  // may let the PC in or be down for another reason (`relay_unreachable` while it reconnects). Before the
  // date a refusal is therefore that link's own: an error whose code names the pass. A server from before
  // the codes names none, and its error beside the flag is read as one
  const closed = refused && (relay.error_code === undefined || relay.error_code?.startsWith("pass_") === true);
  if (early && !closed) {
    if (remind) return { kind: "sign-in-grace", enforceAt: Number.isNaN(at) ? null : pass.enforce_at };
    // The flag stands and the global link neither let this PC in nor refused it for its pass: it is trying
    // (a PC the relay closed looks again every 30 minutes and whenever a pass comes, and each attempt reads
    // "connecting"), or it is down for another reason meanwhile. Until the relay answers, nothing says
    // whether it still refuses: no refusal shows, since the flag may be a regional relay's, and none is
    // read as over either, so one dismissed before stays dismissed when the relay refuses again
    return pass.refused && relay.phase !== "online" ? undefined : null;
  }
  // a server that does not say whether passes are enforced: past the date they are. The data limit
  // is no refusal, so before the date it does not show beside one
  if (!early && pass.new_sessions === false && pass.enforced === undefined) {
    return { kind: "data-limit", enforceAt: null };
  }
  // this browser's clock may be off either way: a PC limit shows only once the relay refused this PC
  if (pass.state === "limit" && pass.refused) {
    return { kind: "pc-limit", enforceAt: null };
  }
  if (pass.state === "not_listed" && pass.refused) {
    return { kind: "not-listed", enforceAt: null };
  }
  if (pass.state === "no_account") {
    // before the date only a PC the relay closed gets here, and that one is refused by this reading too
    if (refused) {
      return { kind: "sign-in-required", enforceAt: null };
    }
    if (remind) {
      return { kind: "sign-in-grace", enforceAt: pass.enforce_at };
    }
  }
  return null;
}

export function relayNoticeOf(health: Pick<HealthInfo, "auth" | "relay" | "security"> | null, signedIn = false): RelayNoticeInfo | null | undefined {
  if (health === null || health.auth?.required === true) return undefined;
  // the relay's pass is the PC owner's business: a relay driver, a Portal visitor (whatever signed it in:
  // Portal itself, the token or a paired device), a watch-only session or whoever an open server (no
  // token, nothing paired) let in from its network can act on none of it; the PC itself is "local"
  // there. This turns away the ways in it names and no other: the demo's answer names none. An open
  // server's visitor is turned away a second time here: a relay that is on has closed that way in
  // already (server/relay/service.ts start), so such a visitor reads the relay as off
  const via = health.auth?.via;
  const ingress = health.security?.observed_ingress;
  if (health.auth?.role === "watch" || via === "open" || via === "portal" || via === "relay" || ingress === "portal" || ingress === "relay") return null;
  return relayNoticeFromStatus(health.relay ?? null, signedIn);
}

export function useRelayNotice(scope: string, notice: RelayNoticeInfo | null | undefined): { dismissed: boolean; dismiss: () => void } {
  const kind = notice === undefined ? undefined : notice?.kind ?? null;
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    if (kind === undefined) return;
    const stored = readDismissed();
    const kept = stored.filter((item) => !item.startsWith(`${scope} `) || (kind !== null && item === entry(scope, kind)));
    if (kept.length !== stored.length) writeDismissed(kept);
    setDismissed(kept);
  }, [scope, kind]);
  const dismiss = useCallback(() => {
    if (kind == null) return;
    const next = [...readDismissed().filter((item) => item !== entry(scope, kind)), entry(scope, kind)];
    setDismissed(next);
    writeDismissed(next);
  }, [scope, kind]);
  return { dismissed: kind != null && dismissed.includes(entry(scope, kind)), dismiss };
}
