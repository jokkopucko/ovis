import "./BlockOutcomes.css";

import { useState } from "react";
import type { BlockRefusal, PcBlockOutcome } from "../../shared/account-devices-api.ts";
import { useT } from "../lib/i18n.ts";

/** "Not me" on an undecided admission (device table T51): one press, held while the blocks go out. */
export function NotMeButton({ sending, onPress }: { sending: boolean; onPress: () => void }) {
  const t = useT();
  return <button type="button" className="btn" disabled={sending} onClick={onPress}>{t("Not me")}</button>;
}

/**
 * Each PC's own answer to a block (device table T51, T60, T65): blocked only on that PC's receipt; a refusal
 * says why by that PC's own order; a PC not reached applies it at its next check, with no time promised.
 */
export function BlockOutcomes({ outcomes, names, accountRetry, accountFailed = false, onRefusalShown }: {
  readonly outcomes: readonly PcBlockOutcome[];
  readonly names: ReadonlyMap<string, string>;
  readonly accountRetry?: () => Promise<void>;
  /** the account service refused the block for good (S32-1): said once, with nothing to retry */
  readonly accountFailed?: boolean;
  /** its owner's OK on that refusal (S32-1): only this lets the refused block leave the queue */
  readonly onRefusalShown?: () => void;
}) {
  const t = useT();
  const [retrying, setRetrying] = useState(false);
  const refusal = (reason: BlockRefusal): string => ({
    signer_not_older: t("this device joined that PC after it"),
    signer_not_member: t("this device was removed from that PC"),
    frozen: t("this device is frozen on that PC"),
    unknown_target: t("that PC does not know the device"),
    record_invalid: t("that PC could not read the block"),
  })[reason];
  return (
    <ul className="block-outcomes">
      {outcomes.map((outcome) => {
        const pc = names.get(outcome.server_id) ?? outcome.server_id.slice(0, 8);
        const line = outcome.state === "applied" || outcome.state === "already_applied" ? t("{pc}: blocked", { pc })
          : outcome.state === "refused" ? t("{pc}: not blocked, {reason}", { pc, reason: refusal(outcome.receipt.reason) })
          : outcome.state === "waiting" ? t("{pc}: waiting for its answer", { pc })
          : outcome.state === "unreachable" ? t("{pc}: not reached; it applies the block at its next check", { pc })
          : t("{pc}: needs an Ovis update to block", { pc });
        return <li key={outcome.server_id} className="settings-hint" data-state={outcome.state}>{line}</li>;
      })}
      {accountRetry === undefined && accountFailed && <li className="settings-hint" data-account-delivery="failed">{t("The account service did not take this block, so a PC that was off may still let that device in. Block it from an older device, or use Sign out every device.")}
        {onRefusalShown !== undefined && <>{" "}<button type="button" className="btn" onClick={onRefusalShown}>{t("OK")}</button></>}</li>}
      {accountRetry !== undefined && (
        <li className="settings-hint" data-account-delivery="failed">
          {t("The block did not go through yet.")}{" "}
          <button type="button" className="btn" disabled={retrying} onClick={async () => {
            setRetrying(true);
            try { await accountRetry(); } finally { setRetrying(false); }
          }}>{t("Try again")}</button>
        </li>
      )}
    </ul>
  );
}
