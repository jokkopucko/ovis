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
  // waits on #4131's design change, owned by another lane
  "scripts/pane-mute-demo-regression.ts": { until: "2026-12-19", issue: 4131 },
  // cause unknown (one failure, run 44793002896, none in the runs since); on a timeout openPhoneSettings names the
  // page's visibility, header chip and pills, terminals, alerts, dialogs, its console and page errors and every
  // WebSocket it opened with its first frame, so the next CI failure names the stage (#4357)
  "scripts/ui-access-regression.ts": { until: "2026-12-20", issue: 4357 },
};
