/**
 * The journal notices one PC sends this device (device table P15, T57): replayed on each connect until
 * acknowledged, in journal order. An acknowledgment only says what was shown; an `open` admission stays
 * answerable here until the PC says it was decided or a replay with missing history no longer lists it as open.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { DeviceNotice, NoticeReplay, NoticeSeen } from "../../shared/account-devices-api.ts";

/** The notice kinds this release tells on screen (device table P10, T58). */
export const TOLD_KINDS: ReadonlySet<DeviceNotice["kind"]> = new Set(["admit", "method"]);

/** A key as people compare it: the first 16 hex digits of its SHA-256, in groups of four. */
export function keyFingerprint(key: string): string {
  return bytesToHex(sha256(utf8ToBytes(key))).slice(0, 16).match(/.{4}/g)!.join(" ");
}

export interface PcNotices {
  readonly notices: readonly DeviceNotice[];
  readonly dismissed: ReadonlySet<string>;
  /** how many notices the PC trimmed before this device saw them */
  readonly cut: number;
  /** the newest `seq` this device acknowledged */
  readonly acked: number;
}

/** A PC journals the confirmation under a new ID, after the open admission and before its replay-only close. */
export function confirmsAdmission(decision: DeviceNotice, admission: DeviceNotice): boolean {
  return admission.kind === "admit" && admission.row !== null && admission.key !== null &&
    admission.no !== null && admission.account !== null && decision.kind === "confirm" && decision.how === "its_me" &&
    !decision.open && (admission.open ? decision.seq > admission.seq : decision.seq < admission.seq) && decision.row === admission.row &&
    decision.key === admission.key && decision.no === admission.no && decision.account === admission.account;
}

export function withNoticeReplay(current: PcNotices | undefined, replay: NoticeReplay): PcNotices {
  const dismissed = current?.dismissed ?? new Set<string>();
  // A reconnect replay includes every eligible open admission, even when its decision history was trimmed.
  const notices = new Map(current?.notices.filter((item) => replay.cut === 0 || !item.open).map((item) => [item.id, item]));
  for (const item of replay.notices) {
    if (!dismissed.has(item.id)) notices.set(item.id, item);
  }
  const rows = [...notices.values()];
  const confirmations = rows.filter((item) => item.kind === "confirm" && item.how === "its_me");
  return {
    notices: rows.filter((item) => !confirmations.some((decision) => confirmsAdmission(decision, item))).sort((a, b) => a.seq - b.seq),
    dismissed,
    cut: replay.cut,
    acked: current?.acked ?? 0,
  };
}

export function noticeSeen(current: PcNotices, renderedThrough: number): NoticeSeen | null {
  return renderedThrough > current.acked ? { type: "notice-seen", seq: renderedThrough } : null;
}

export function withNoticeAcked(current: PcNotices, seq: number): PcNotices {
  return { ...current, acked: Math.max(current.acked, seq) };
}

export function withNoticeDecided(current: PcNotices, id: string): PcNotices {
  return { ...current, notices: current.notices.filter((item) => item.id !== id), dismissed: new Set([...current.dismissed, id]) };
}
