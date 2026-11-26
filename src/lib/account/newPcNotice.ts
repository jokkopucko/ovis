import type { DirectoryPc } from "./service.ts";

/** Where this device keeps that it closed the notice of one PC new in the account (NewPcNotices.tsx), per admission. */
export const newPcNoticeKey = (account: string, pc: Pick<DirectoryPc, "server_id" | "admitted_at" | "new_until">): string =>
  `ovis:new-pc:${JSON.stringify([account, pc.server_id, pc.admitted_at ?? pc.new_until])}`;

/**
 * Where this device keeps that it closed the notice of one PC a sign-in code listed unconfirmed (UnconfirmedPcNotices.tsx),
 * per listing: the PC listing itself again, or another PC, is told of anew.
 */
export const unconfirmedPcNoticeKey = (account: string, pc: Pick<DirectoryPc, "server_id" | "listing_id" | "added_at">): string =>
  `ovis:unconfirmed-pc:${JSON.stringify([account, pc.server_id, typeof pc.listing_id === "string" ? pc.listing_id : pc.added_at])}`;

export function pcNoticeClosed(key: string): boolean {
  try { return localStorage.getItem(key) !== null; }
  catch (error) { if (error instanceof DOMException) return false; throw error; }
}

export function closePcNotice(key: string): void {
  try { localStorage.setItem(key, "1"); }
  catch (error) { if (!(error instanceof DOMException)) throw error; }
}
