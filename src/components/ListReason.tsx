import { useEffect, useState } from "react";

import { fetchListReason } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";

/** How often Settings reads again why this PC lets nobody of its account's list in. */
const LIST_REASON_POLL_MS = 15_000;

/**
 * Why this PC lets no device of its account in by the account's signed list, or no new one, as the PC says it
 * (docs/account.md: a pinned PC's `reason`, and a PC that cannot read its own account state): a row of its own in
 * Devices and PCs while there is something to say, and nothing otherwise. Read while the page shows, and at once when it
 * shows again.
 */
export function ListReason() {
  const t = useT();
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    // a read that answers after a newer one was applied is older news
    let issued = 0;
    let applied = 0;
    const read = (): void => {
      if (document.hidden) return;
      const seq = ++issued;
      fetchListReason().then((said) => {
        if (!live || seq < applied) return;
        applied = seq;
        setReason(said);
      }, () => undefined);
    };
    read();
    const timer = setInterval(read, LIST_REASON_POLL_MS);
    document.addEventListener("visibilitychange", read);
    return () => { live = false; clearInterval(timer); document.removeEventListener("visibilitychange", read); };
  }, []);
  if (reason === null) return null;
  return (
    <div className="settings-item list-reason" data-testid="list-reason" role="status">
      <span className="settings-label">{t("Your account's list on this PC")}
        <span className="settings-description"> · {reason}</span>
      </span>
    </div>
  );
}
