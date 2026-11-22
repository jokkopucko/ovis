/**
 * Browser scripts whose pass on the lane's second run still counts as a pass, each until its end
 * date (inclusive, UTC) and with an issue about it. Any other script that fails and
 * then passes when run again fails the lane (scripts/ci-browser-parallel.ts). An entry ends at most
 * QUARANTINE_MAX_DAYS ahead; once a script has stopped flaking, its entry goes.
 */
export interface QuarantineEntry {
  readonly until: string;
  readonly issue: number;
}

export const QUARANTINE_MAX_DAYS = 30;

export const QUARANTINE: Readonly<Record<string, QuarantineEntry>> = {
  // cause unknown; on a timeout the script logs the browser's roster status, the selected pane, the chat key,
  // the scroll gap and the badge, so the next CI failure names the stage
  "scripts/gjc-status-browser-regression.ts": { until: "2026-12-19", issue: 4184 },
  // waits on #4131's design change, owned by another lane
  "scripts/pane-mute-demo-regression.ts": { until: "2026-12-19", issue: 4131 },
  // a long press on a pinned row in checkPinned's touch pass sometimes never lifts it (#4343)
  "scripts/workspace-touch-reorder-demo-regression.ts": { until: "2026-12-20", issue: 4343 },
  // cause unknown (no failure in 53 runs, CI image included); on a timeout openPhoneSettings now names the page's
  // header chip, terminals, dialogs and every WebSocket it opened, so the next CI failure names the stage (#4357)
  "scripts/ui-access-regression.ts": { until: "2026-12-20", issue: 4357 },
};
