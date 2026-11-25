import { useEffect, useRef, useState } from "react";
import { accountLabel } from "../../shared/account-asker.ts";
import type { AccountList } from "../lib/account/accountList.ts";
import { addPostedPc, NUMBER_TRIES, numberWith, type AddNumber, type PostedPc } from "../lib/account/listAdd.ts";
import { listNames } from "../lib/account/listGenesis.ts";
import { ACCOUNT_PCS_CHANGED_EVENT } from "../lib/account/myPcs.ts";
import { noteAct } from "../lib/account/seenPcs.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { addRefusal, numberRefusal } from "./pcAddRefusals.ts";

import "./AccountApprovalPrompt.css";
import "./RelayShell.css";

/**
 * Adds a PC the account names already to the account's signed list, from a device that is in the list
 * (docs/account-list.md, "Adding a PC"). The PC posted its keys and its card for the list: this device and the PC work
 * out one number from that card, the person confirms it at the PC and then presses Add here, and this device signs
 * the PC's entry with exactly the card the number came from. Nothing is admitted: the account lists the PC already.
 *
 * `waitMs`: how long it waits for the PC's answer before it says the PC did not answer; a test's own. `now`: this
 * device's clock, in ms; a test's own. It asks for NUMBER_TRIES numbers at most (Try again, and Add after one ran out).
 */
export function AddPcByNumber({ list, account, post, name, waitMs, now = Date.now, onClose, onAdded }: {
  readonly list: AccountList; readonly account: string; readonly post: PostedPc;
  /** The PC's name as the account has it. */
  readonly name: string;
  readonly waitMs?: number | undefined;
  readonly now?: () => number;
  readonly onClose: () => void; readonly onAdded: () => void;
}) {
  const t = useT();
  const words = useRef(t);
  words.current = t;
  const [number, setNumber] = useState<AddNumber | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // the person said the numbers differ: nothing more is offered for this PC here
  const [differed, setDiffered] = useState(false);
  const [busy, setBusy] = useState(false);
  // the PC takes a yes for a number only so long: after that a new one is asked for, by a press
  const [ranOut, setRanOut] = useState(false);
  // the numbers asked for so far, less one: the first is asked for when the dialog opens
  const [asks, setAsks] = useState(0);
  const lastTry = asks + 1 >= NUMBER_TRIES;
  const asking = useRef<AbortController | null>(null);
  // Back closes it, as Close does, unless the entry is being signed
  usePhoneSheetBack(() => { if (busy) return false; onClose(); });

  useEffect(() => {
    const ask = new AbortController();
    asking.current = ask;
    setNumber(null);
    setProblem(null);
    setRanOut(false);
    void numberWith(list, post, { signal: ask.signal, now, ...(waitMs === undefined ? {} : { waitMs }) }).then((outcome) => {
      if (ask.signal.aborted) return;
      if (outcome.shown) setNumber(outcome.number);
      else setProblem(numberRefusal(words.current, asks + 1 >= NUMBER_TRIES ? "spent" : outcome.why));
    }, (error: unknown) => {
      if (ask.signal.aborted) return;
      console.warn("Ovis: no number came for the PC", error instanceof Error ? error.name : error);
      setProblem(words.current("The PC could not be added. Try again."));
    });
    return () => { ask.abort(new DOMException("The number is no longer asked for", "AbortError")); };
  }, [list, post, waitMs, asks, now]);

  const ranOutNow = (): void => {
    setNumber(null);
    setRanOut(true);
    setProblem(lastTry ? numberRefusal(words.current, "spent") : words.current("That number ran out. Press Add for a new one."));
  };
  useEffect(() => {
    if (number === null || busy) return;
    const timer = setTimeout(ranOutNow, Math.max(0, number.until - now()));
    return () => clearTimeout(timer);
  });

  const add = async (shown: AddNumber): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      // the number lives so long: a press after it adds nothing, whatever the timer did not draw yet
      if (now() >= shown.until) { ranOutNow(); return; }
      const outcome = await addPostedPc(list, shown.post, listNames(accountLabel(name), null), { expect: { account, list: shown.post.list }, member: shown.member, admit: async () => {} });
      if (!outcome.added) { setProblem(addRefusal(t, outcome).text); return; }
      // Add where a number was compared on both screens: kept in this device's own record of its PCs (seenPcs.ts)
      // written before the dialog goes: a tab closed right after keeps it
      await noteAct(account, shown.post.endpoint, "added").catch(() => undefined);
      window.dispatchEvent(new Event(ACCOUNT_PCS_CHANGED_EVENT));
      onAdded();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.warn("Ovis: the PC was not added to the account's list", error.name);
      setProblem(t("The PC could not be added. Try again."));
    } finally { setBusy(false); }
  };
  const notTheSame = (): void => {
    asking.current?.abort(new DOMException("The numbers were not the same", "AbortError"));
    setNumber(null);
    setDiffered(true);
    setProblem(t("The numbers did not match. This PC was not added."));
  };
  const title = t("Add this PC to your account?");
  return (
    <div className="modal-scrim">
      <div className="modal account-approval" role="dialog" aria-modal="true" aria-label={title} data-testid="add-pc-number" data-pc-id={post.server_id}>
        <h2 className="account-approval-title">{title}</h2>
        <p className="account-approval-lead">{name}</p>
        {number !== null ? (
          <>
            <p className="account-approval-note">{t("Check that the PC shows this number and confirm it there, then Add")}</p>
            <p className="relay-shell-digits" aria-label={number.digits.split("").join(" ")}>{`${number.digits.slice(0, 3)} ${number.digits.slice(3)}`}</p>
          </>
        ) : problem === null && <p className="account-approval-note" role="status">{t("Waiting for the PC…")}</p>}
        {problem !== null && <p className="account-approval-error" role="alert">{problem}</p>}
        <div className="account-approval-actions">
          {number !== null ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
              <button type="button" className="btn" disabled={busy} onClick={notTheSame}>{t("Not the same")}</button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void add(number)}>{t("Add|account pc")}</button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>{problem === null ? t("Cancel") : t("Close")}</button>
              {problem !== null && !differed && !lastTry && <button type="button" className="btn btn-primary" onClick={() => setAsks((count) => count + 1)}>{ranOut ? t("Add|account pc") : t("Try again")}</button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
