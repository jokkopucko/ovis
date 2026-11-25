import { useEffect, useId, useRef, useState } from "react";
import type { AccountList } from "../lib/account/accountList.ts";
import { endPendingServiceInvites, INVITE_S, invitesOf, makeInvite, revokeInvite, type InviteOutcome, type MadeInvite, pendingInvite, type ShownInvite } from "../lib/account/listInvite.ts";
import { copyText } from "../lib/clipboard.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { Toggle } from "./SettingsControls.tsx";

import "./InvitePc.css";

/**
 * The one line an agent runs on the PC: the one-line installer, then `ovis join` with the invite's line in a file and
 * the account named (docs/relay.md, `ovis join --invite-file`). The installer puts `ovis` in `~/.local/bin`.
 */
export const agentCommand = (account: string): string => `curl -fsSL https://ovis.sh/install.sh | sh && ~/.local/bin/ovis join --invite-file ~/ovis-invite.txt --account ${account}`;

/** How long after its end an invite is still listed. */
const SHOWN_AFTER_MS = 60 * 60_000;

function refusal(t: Translate, outcome: Extract<InviteOutcome, { readonly made: false }>): string {
  if (outcome.why === "service") {
    switch (outcome.code) {
      case "invites_full": return t("Your account has as many open invites as it can. Revoke one first.");
      case "pc_add_cap": return t("This account has added as many PCs as it can today. Try again later.");
      case "session_not_fresh": case "own_sign_in_required": return t("Sign in again on this device to make an invite.");
      default: return t("The invite could not be made. Try again.");
    }
  }
  switch (outcome.why) {
    case "unknown": return t("It is not known yet whether the invite was made. Press Make an invite to check.");
    case "clock_behind": return t("This device's clock is behind. Check its date and time, then make the invite again.");
    case "stopped": return t("The account service cannot change the list right now.");
    case "clock": return t("This device's clock looks wrong. Check its date and time, then try again.");
    case "blocked": case "no_list": return t("This device cannot change your account's list right now.");
    default: return t("The invite could not be made. Try again.");
  }
}

/**
 * Invites for a PC, on a device that may write its account's signed list (docs/account-list.md, "Invites"). **Make an
 * invite** makes one a PC joins with by itself: a line that works once and ends within fifteen minutes, shown here and
 * nowhere else, with the one line an agent runs on the PC. Under it, the invites the list holds, each with how it
 * stands and, while it is open, **Revoke**. `now`: this device's clock; a test's own.
 */
export function InvitePc({ list, now = Date.now }: { readonly list: AccountList; readonly now?: () => number }) {
  const t = useT();
  const [, redraw] = useState(0);
  const [made, setMade] = useState<MadeInvite | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<"line" | "command" | null>(null);
  // Off by default: the PC that joins with the invite asks, and a device of the account presses Add for it. On: the
  // PC joins by itself, so whoever holds the line adds a PC with nobody asked
  const [auto, setAuto] = useState(false);
  const autoId = useId();
  const lineRef = useRef<HTMLElement>(null);
  const commandRef = useRef<HTMLElement>(null);
  // the list moved (a PC joined, another device revoked): the rows are drawn again from it
  useEffect(() => list.subscribe(() => redraw((count) => count + 1)), [list]);
  // an invite the list ended whose end did not reach the account service yet is ended there now (nothing is signed)
  const head = list.writer()?.state.footing.seq ?? null;
  useEffect(() => { void endPendingServiceInvites(list); }, [list, head]);
  // the countdown, and the moment an invite ends
  useEffect(() => {
    const timer = setInterval(() => redraw((count) => count + 1), 15_000);
    return () => clearInterval(timer);
  }, []);
  const writer = list.writer();
  if (writer === null) return null;
  // an invite that ended stays in view for an hour, said as what became of it; the list keeps every one for good
  const rows = invitesOf(list, now()).filter((row) => row.state === "open" || row.exp * 1000 > now() - SHOWN_AFTER_MS);
  const shown = made === null ? undefined : rows.find((row) => row.key === made.key);
  // the line is shown only while its invite is open: a used, revoked or expired one opens nothing
  const line = made !== null && shown?.state === "open" ? made : null;
  const minutes = (row: ShownInvite): number => Math.min(Math.ceil(INVITE_S / 60), Math.max(1, Math.ceil((row.exp * 1000 - now()) / 60_000)));
  const stateWord = (row: ShownInvite): string => row.state === "open" ? t("Expires in {minutes} min", { minutes: minutes(row) })
    : row.state === "expired" ? t("Expired") : row.state === "used" ? t("Used|invite") : row.state === "ended" ? t("Ended|invite") : t("Revoked");

  const make = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setCopied(null);
    try {
      // an invite an earlier press left not known is settled first (listInvite.ts keeps its line for the page's life)
      const outcome = await makeInvite(list, { auto, expect: { account: writer.account, list: writer.list } });
      if (outcome.made) setMade(outcome.invite);
      else setProblem(refusal(t, outcome));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.warn("Ovis: no invite was made", error.name);
      setProblem(t("The invite could not be made. Try again."));
    } finally { setBusy(false); }
  };
  const revoke = async (key: string): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const outcome = await revokeInvite(list, key, { expect: { account: writer.account, list: writer.list } });
      if (!outcome.revoked) setProblem(t("The invite could not be revoked. Try again."));
      else if (made?.key === key) setMade(null);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.warn("Ovis: the invite was not revoked", error.name);
      setProblem(t("The invite could not be revoked. Try again."));
    } finally { setBusy(false); }
  };
  const copy = (what: "line" | "command", text: string, from: HTMLElement | null): void => { void copyText(text, from).then((ok) => { if (ok) setCopied(what); }); };
  const command = agentCommand(writer.account);
  return (
    <section className="invite-pc" aria-label={t("Invite a PC")} data-testid="invite-pc">
      <h3 className="invite-pc-title">{t("Invite a PC")}</h3>
      <p className="relay-shell-detail">{t("An invite adds one PC to your account with no sign-in on that PC. It works once.")}</p>
      <div className="invite-pc-auto">
        <span id={autoId} className="invite-pc-auto-label">{t("Let the PC join by itself")}</span>
        <Toggle checked={auto} label={t("Let the PC join by itself")} onChange={setAuto} disabled={busy} describedBy={`${autoId}-says`} />
        <p id={`${autoId}-says`} className="account-fineprint invite-pc-auto-says">
          {auto ? t("Anyone who gets this line in the next 15 minutes can add a PC to your account without asking you.") : t("After the PC joins with the invite, press Add for it on a device of your account.")}
        </p>
      </div>
      {line !== null && shown !== undefined && (
        <div className="invite-pc-made" data-invite={line.key}>
          <p className="account-fineprint" role="status">{line.auto ? t("Anyone who gets this line in the next 15 minutes can add a PC to your account without asking you.") : t("After the PC joins with the invite, press Add for it on a device of your account.")}</p>
          <span className="invite-pc-label">{t("Invite")} · {stateWord(shown)}</span>
          <code ref={lineRef} className="invite-pc-text" translate="no" data-invite-line="">{line.line}</code>
          <button type="button" className="btn btn-ghost" onClick={() => copy("line", line.line, lineRef.current)}>{copied === "line" ? t("Copied") : t("Copy")}</button>
          <span className="invite-pc-label">{t("For an agent")}</span>
          <p className="account-fineprint">{t("Save the invite as ~/ovis-invite.txt on the PC, then run this there.")}</p>
          <code ref={commandRef} className="invite-pc-text" translate="no" data-invite-command="">{command}</code>
          <button type="button" className="btn btn-ghost" onClick={() => copy("command", command, commandRef.current)}>{copied === "command" ? t("Copied") : t("Copy")}</button>
        </div>
      )}
      {problem !== null ? <p className="account-error" role="alert">{problem}</p>
        : pendingInvite(list) !== null && <p className="account-error" role="alert">{t("It is not known yet whether the invite was made. Press Make an invite to check.")}</p>}
      <button type="button" className="btn" disabled={busy} data-action="make-invite" onClick={() => void make()}>{t("Make an invite")}</button>
      {rows.length > 0 && (
        <ul className="invite-pc-list" data-testid="invites">
          {rows.map((row) => (
            <li key={row.key} className="invite-pc-row" data-invite-state={row.state}>
              <span className="invite-pc-row-text">{t("Invite")} · {stateWord(row)}</span>
              {row.state === "open" && <button type="button" className="btn account-head-btn" disabled={busy} data-action="revoke-invite" onClick={() => void revoke(row.key)}>{t("Revoke")}</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
