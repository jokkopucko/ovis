import { useCallback, useEffect, useState } from "react";

import { currentLocale, useT } from "../lib/i18n.ts";
import type { HealthAuth } from "../../shared/access.ts";
import { ApiError } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { SettingsRow, Toggle } from "./SettingsControls.tsx";
import { CONFIRM_MS, fetchLockState, requestLock, requestUnlock, type LockState } from "../lib/account/lock.ts";

/** An act this window asked for, waiting on this PC's screen until `until` (ms). */
interface Asked { readonly kind: "lock" | "unlock"; readonly until: number }

/** Why the PC refused a request (server/account/lock-routes.ts codes, folded). */
interface Refusal { readonly kind: "local_required" | "already" | "no_screen_proof" | "lock_removals_pending" | "other"; readonly detail: string | null }

function refusalOf(error: unknown): Refusal {
  const code = error instanceof ApiError ? error.code : null;
  const detail = error instanceof ApiError ? error.detail : null;
  if (code === "local_required" || code === "no_screen_proof" || code === "lock_removals_pending") return { kind: code, detail };
  return { kind: code === "already_locked" || code === "not_locked" ? "already" : "other", detail };
}

/**
 * One status at a time for a lock request: the approve-by line from the moment it is sent (the deadline is taken
 * before sending, so a slow answer never shows a later time than the PC's), or the PC's refusal instead. The line
 * goes at its deadline; the state is read again then and whenever this window comes back from the confirm page.
 */
function useLockRequest(read: () => void) {
  const [status, setStatus] = useState<{ readonly asked: Asked } | { readonly refused: Refusal } | null>(null);
  const asked = status !== null && "asked" in status ? status.asked : null;
  useEffect(() => {
    if (asked === null) return;
    const back = () => { read(); };
    window.addEventListener("focus", back);
    const timer = setTimeout(() => { setStatus(null); read(); }, Math.max(0, asked.until - Date.now()));
    return () => { window.removeEventListener("focus", back); clearTimeout(timer); };
  }, [asked, read]);
  const ask = (kind: Asked["kind"], request: () => Promise<string>) => {
    const until = Date.now() + CONFIRM_MS;
    void request().then(() => { setStatus({ asked: { kind, until } }); read(); }, (error: unknown) => {
      console.warn("Ovis: strict mode was not asked for", error instanceof Error ? error.name : error);
      setStatus({ refused: refusalOf(error) });
      read();
    });
  };
  // the lock changed: what this window asked for is settled; a refusal it was told stays
  const settled = useCallback(() => setStatus((now) => now !== null && "asked" in now ? null : now), []);
  return { status, ask, settled };
}

function RequestStatus({ status }: { status: ReturnType<typeof useLockRequest>["status"] }) {
  const t = useT();
  if (status === null) return null;
  if ("asked" in status) {
    const { kind, until } = status.asked;
    return <p className="settings-hint" role="status">{t(kind === "lock"
      ? "Strict mode is not on yet. Approve it on this PC's screen by {time}. To open that screen, run ovis confirm on this PC."
      : "Strict mode stays on until you approve turning it off on this PC's screen by {time}. To open that screen, run ovis confirm on this PC.",
    { time: new Date(until).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" }) })}</p>;
  }
  const { kind, detail } = status.refused;
  return <p className="settings-hint" role="status">{{
    local_required: t("Turn strict mode on or off in a browser on this PC itself."),
    already: t("Strict mode changed already. This shows it as it is now."),
    no_screen_proof: t("Strict mode needs a confirmation on this PC's screen, which only Linux has for now."),
    lock_removals_pending: t("Strict mode stays on until this PC finishes signing out the devices it ended. Try again shortly."),
    other: t("This PC did not take the request. Try again."),
  }[kind]}{/* the PC's own words come after: a state folder it cannot write does not get better by trying again */}
    {kind === "lock_removals_pending" && detail !== null && <> {detail}</>}</p>;
}

/**
 * A locked PC's own window, in place of the pairing gate (T47, N4): the one thing it may do is ask to turn strict mode
 * off, which the PC's screen then approves. The server lets only this PC's own window read the lock.
 */
export function StrictUnlockAsk() {
  const t = useT();
  const [lock, setLock] = useState<string | null>(null);
  const read = useCallback(() => {
    void fetchLockState().then((state) => setLock(state.locked), () => setLock(null));
  }, []);
  // read now, and again whenever this window comes back (the confirm page is another window)
  useEffect(() => {
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, [read]);
  const request = useLockRequest(read);
  if (lock === null) return null;
  return (
    <div className="strict-mode">
      <p>{t("This PC is in strict mode.")}</p>
      <button type="button" className="btn" onClick={() => request.ask("unlock", () => requestUnlock(lock))}>{t("Ask to turn strict mode off")}</button>
      <RequestStatus status={request.status} />
    </div>
  );
}

/**
 * Strict mode (device table P11, T46, T47, T49, N7, R10; hub rule: only on a PC bound to an account), as one row of
 * More settings: its switch, on this PC's own window only, and at most one line of why it is off or what being on
 * means. The switch only asks: the PC's screen confirms it. Turning it on first names, in a confirmation, every row and
 * grant it ends and what it cannot cover; turning it off asks for that lock at once.
 */
export function StrictModePanel({ state, local, status = null, onTurnOn, onTurnOff }: { state: LockState; local: boolean; status?: ReturnType<typeof useLockRequest>["status"]; onTurnOn: () => void; onTurnOff: (lock: string) => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const unbound = !state.bound && state.locked === null;
  const unsupported = state.confirm === "unsupported" && state.locked === null;
  const description = unbound ? t("Strict mode needs this PC signed in to an Ovis account.")
    : unsupported ? t("Strict mode needs a confirmation on this PC's screen, which only Linux has for now.")
    : state.locked !== null ? t("While it is on, use this PC through the Ovis desktop app or a terminal on it.")
    : state.strict ? t("This PC could not read its safety log, so it stays locked.")
    : undefined;
  const grantName = { token: t("access token"), portal: "Portal", tailscale: "Tailscale", open_lan: t("open local network"), loopback: t("this PC's browser without proof") } as const;
  const ends = [...(state.preview?.rows.map((row) => row.label) ?? []), ...(state.preview?.grants.map((grant) => grantName[grant]) ?? [])];
  const confirmBody = [
    t("Only devices added on this PC's own screen or terminal can come in."),
    ...(ends.length > 0 ? [t("Turning it on ends: {list}.", { list: ends.join(", ") })] : []),
    t("It does not cover anyone signed in to this computer as you, and cannot stop an older Ovis installed by hand."),
  ].join(" ");
  // no switch where this PC's screen cannot confirm it: the PC refuses both ways there (no_screen_proof)
  const switchable = local && !unbound && state.confirm !== "unsupported";
  return (
    <>
      <SettingsRow label={t("Strict mode (Linux)")} description={description}>
        {switchable && <Toggle label={t("Strict mode (Linux)")} checked={state.locked !== null} onChange={(on) => { if (on) setConfirming(true); else onTurnOff(state.locked!); }} />}
      </SettingsRow>
      <RequestStatus status={status} />
      {confirming && (
        <ConfirmDialog title={t("Turn on strict mode?")} body={confirmBody} confirmLabel={t("Turn on strict mode")}
          onClose={() => setConfirming(false)} onConfirm={async () => { setConfirming(false); onTurnOn(); }} />
      )}
    </>
  );
}

/** Settings → Devices: strict mode on a PC that offers it (account-opens-all/1), read again after each request. */
export function StrictModeSection({ offered, auth }: { offered: boolean; auth: HealthAuth | null }) {
  const [state, setState] = useState<LockState | null>(null);
  const read = useCallback(() => {
    void fetchLockState().then(setState, (error: unknown) => {
      console.warn("Ovis: strict mode could not be read", error instanceof Error ? error.name : error);
      setState(null);
    });
  }, []);
  useEffect(() => { if (offered) read(); }, [offered, read]);
  const request = useLockRequest(read);
  const lock = state?.locked ?? null;
  const { settled } = request;
  // the lock changed (approved, or by another window): what this window asked for is settled
  useEffect(() => { settled(); }, [lock, settled]);
  if (!offered || state === null) return null;
  // the server's own-window rule for this request (/api/health auth.own_window): the lock routes enforce it themselves
  return <StrictModePanel state={state} local={auth?.own_window === true} status={request.status}
    onTurnOn={() => request.ask("lock", requestLock)} onTurnOff={(id) => request.ask("unlock", () => requestUnlock(id))} />;
}
