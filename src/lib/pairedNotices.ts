import type { DevicePairedEvent } from "../../shared/protocol.ts";

export const PAIRED_NOTICE_LIMIT = 3;

export function withPairedNotice<T extends Pick<DevicePairedEvent, "event_id">>(list: readonly T[], event: T): readonly T[] {
  if (list.some((item) => item.event_id === event.event_id)) return list;
  return [...list, event].slice(-PAIRED_NOTICE_LIMIT);
}
