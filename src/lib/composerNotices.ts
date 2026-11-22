/**
 * An activity is never dismissed: it holds input the user typed while offline, and its Send and
 * Discard are the only way to deal with it.
 */

export type NoticePriority = "activity" | "urgent" | "notice";

export interface ComposerNotice {
  readonly id: string;
  readonly priority: NoticePriority;
  readonly revision: string;
}

export type DismissedNotices = ReadonlyMap<string, string>;

export const NO_DISMISSALS: DismissedNotices = new Map();

const RANK: Record<NoticePriority, number> = { activity: 0, urgent: 1, notice: 2 };

export function isDismissible(notice: ComposerNotice): boolean {
  return notice.priority !== "activity";
}

export function arrangeNotices<T extends ComposerNotice>(notices: readonly T[], dismissed: DismissedNotices): T[] {
  return notices
    .filter((notice) => !isDismissible(notice) || dismissed.get(notice.id) !== notice.revision)
    .sort((a, b) => RANK[b.priority] - RANK[a.priority]);
}

export function dismissNotice(dismissed: DismissedNotices, notice: ComposerNotice): DismissedNotices {
  if (!isDismissible(notice)) return dismissed;
  const next = new Map(dismissed);
  next.set(notice.id, notice.revision);
  return next;
}

export function settleDismissed(dismissed: DismissedNotices, notices: readonly ComposerNotice[]): DismissedNotices {
  const next = new Map<string, string>();
  for (const notice of notices) {
    const revision = dismissed.get(notice.id);
    if (revision === notice.revision) next.set(notice.id, revision);
  }
  return next.size === dismissed.size ? dismissed : next;
}
