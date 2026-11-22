import { useEffect, useState } from "react";
import { X } from "lucide-react";

import "./JoinWait.css";

import type { HoldState } from "../../shared/account-devices-api.ts";
import { holdWaitMs } from "../lib/relay/joinHold.ts";
import { useT } from "../lib/i18n.ts";

/** The new device's wait on one PC (device table P17, T53, T67): that PC's own deadline, nothing when it holds nothing. */
export function JoinWait({ pc, hold, now }: { readonly pc: string; readonly hold: HoldState | undefined; readonly now?: number | undefined }) {
  if (hold === undefined) return null;
  return <HoldLine key={JSON.stringify([pc, hold.reason])} pc={pc} hold={hold} now={now} />;
}

function HoldLine({ pc, hold, now }: { readonly pc: string; readonly hold: HoldState; readonly now: number | undefined }) {
  const t = useT();
  const [hidden, setHidden] = useState(false);
  const [clock, setClock] = useState(Date.now);
  const until = hold.reason === "join_hold" ? hold.until : null;
  useEffect(() => {
    if (now !== undefined || until === null || hidden) return;
    const end = Date.parse(until);
    const tick = () => setClock(Date.now());
    tick();
    if (end <= Date.now()) return;
    const timer = setInterval(() => {
      tick();
      if (Date.now() >= end) clearInterval(timer);
    }, 1_000);
    return () => clearInterval(timer);
  }, [hidden, now, until]);
  if (hidden) return null;
  const left = holdWaitMs(hold, now ?? clock);
  const line = left !== null ? t("{pc} opens in {seconds} s", { pc, seconds: Math.ceil(left / 1000) })
    : hold.reason === "join_hold" ? t("{pc} is telling your other devices first", { pc })
    : hold.reason === "frozen" ? t("{pc} holds this device after a Not me from another device", { pc })
    : t("{pc} is checking your account first", { pc });
  return (
    <div className="join-wait" role="status">
      <span>{line}</span>
      {hold.reason === "join_hold" && <span className="settings-hint">{t("Your other devices are told first. One of them can let this device in now.")}</span>}
      <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => setHidden(true)}><X /></button>
    </div>
  );
}

/**
 * "It's me" on an undecided admission (device table T53): one press, held while it goes to the PC; `refusedBy` names
 * the PC that took none of it, which answers a refusal with nothing.
 */
export function ItsMeButton({ sending, onPress, refusedBy = null }: { sending: boolean; onPress: () => void; refusedBy?: string | null }) {
  const t = useT();
  return <>
    <button type="button" className="btn" disabled={sending} onClick={onPress}>{t("It's me")}</button>
    {refusedBy !== null && <p className="settings-hint its-me-refused" role="status">{t("{pc} did not accept It's me from this device.", { pc: refusedBy })}</p>}
  </>;
}
