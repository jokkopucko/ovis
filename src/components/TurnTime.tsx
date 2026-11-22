import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { useLocalDay } from "../lib/localDay.ts";

export function TurnTime({ ts }: { ts: string | null }) {
  const t = useT();
  const today = useLocalDay();
  const stamp = formatChatTimestamp(ts, today, currentLocale(), t);
  if (stamp === null) return null;
  return <time className="chat-time" dateTime={ts ?? undefined} title={stamp.full} tabIndex={0}>{stamp.label}</time>;
}
