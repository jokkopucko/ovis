import type { Translate } from "./i18n.ts";

export interface ChatTimestamp {
  label: string;
  full: string;
}

const DAY_MS = 86_400_000;

export function formatChatTimestamp(ts: string | null, nowMs: number, locale: string, t: Translate): ChatTimestamp | null {
  if (ts === null) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  const full = date.toLocaleString(locale, { dateStyle: "full", timeStyle: "medium" });
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  // rounded so a 23 or 25 hour DST day still counts as one day
  const dayDiff = Math.round((startOfToday - startOfDay) / DAY_MS);
  if (dayDiff <= 0) return { label: time, full };
  if (dayDiff === 1) return { label: t("yesterday at {time}", { time }), full };
  const day = date.toLocaleDateString(locale, date.getFullYear() === now.getFullYear()
    ? { month: "numeric", day: "numeric" }
    : { year: "numeric", month: "numeric", day: "numeric" });
  return { label: `${day} ${time}`, full };
}
