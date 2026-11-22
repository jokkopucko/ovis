/**
 * "Not me" on the notice's own PC (device table T60; Track A S2-09): the answer goes over that PC's socket, and only
 * that PC's notice-answer-result for this notice id counts as its receipts. A PC that does not offer it, or does not
 * answer in time, is not reached, so the caller retries it with the same blocks.
 */
import type { DeviceNotice, NoticeAnswer } from "../../../shared/account-devices-api.ts";
import type { BlockRecord } from "../../../shared/account-records.ts";
import type { ServerMessage } from "../../../shared/protocol.ts";
import { confirmsAdmission } from "../deviceNotices.ts";
import type { BlockSend } from "./fleet-block.ts";

export interface AnswerSocket {
  on(handler: (message: ServerMessage) => void): () => void;
  sendNotice(message: NoticeAnswer): boolean;
}

export function answerOnPc(socket: AnswerSocket, request: NoticeAnswer | {
  readonly answer: Extract<NoticeAnswer, { answer: "its_me" }>;
  readonly notice: DeviceNotice;
}, timeoutMs: number): Promise<readonly unknown[]> {
  return new Promise((resolve, reject) => {
    const off = socket.on((message) => {
      if ("notice" in request) {
        const notices = message.type === "device-notice" ? [message.notice]
          : message.type === "device-notice-replay" ? message.replay.notices : [];
        if (!notices.some((decision) => confirmsAdmission(decision, request.notice))) return;
        clearTimeout(timer);
        off();
        resolve([]);
        return;
      }
      const frame = message as { type?: unknown; id?: unknown; receipts?: unknown };
      if (frame.type !== "notice-answer-result" || frame.id !== request.id || !Array.isArray(frame.receipts)) return;
      clearTimeout(timer);
      off();
      resolve(frame.receipts);
    });
    const timer = setTimeout(() => { off(); reject(new Error("The PC did not answer")); }, timeoutMs);
    if (!socket.sendNotice("notice" in request ? request.answer : request)) { clearTimeout(timer); off(); reject(new Error("The PC does not take account answers")); }
  });
}

/**
 * The account's other PCs (Track A S2-09): the blocks go to the PC's existing records route over the transport the app
 * already uses for it; with the release on, its answer carries a receipt per block. An answer without receipts (the
 * release off there, or an older PC) or a failed request is not a receipt, so that PC stays not reached.
 */
export async function recordsOnPc(post: (path: string, body: unknown) => Promise<Response>, blocks: readonly BlockRecord[]): Promise<readonly unknown[]> {
  const response = await post("/api/account/records", { records: blocks });
  if (!response.ok) throw new Error(`The PC answered ${response.status}`);
  const answer = await response.json() as { receipts?: unknown };
  if (!Array.isArray(answer.receipts)) throw new Error("The PC took no blocks");
  return answer.receipts;
}

/**
 * Where a Not me on `notice` from PC `own` goes: the answer on that PC's own socket, whose receipts count, and every other
 * PC's records route through the page's PC, which delivers the blocks but is not that PC's own word (relay-hub ruling on T60).
 */
export function notMeTransports(notice: DeviceNotice, own: string, pcs: readonly string[], deps: {
  socket: (pc: string) => AnswerSocket | undefined;
  post: (pc: string) => (path: string, body: unknown) => Promise<Response>;
  /** that PC's own relay channel, when this device has one: authenticated to that PC itself, so its receipts count */
  channel?: (pc: string) => ((path: string, body: unknown) => Promise<Response>) | undefined;
  timeoutMs: number;
}): { pcs: Map<string, BlockSend>; relayed: Map<string, BlockSend> } {
  const answer: BlockSend = (blocks) => {
    const socket = deps.socket(own);
    if (socket === undefined) return Promise.reject(new Error("The PC is not connected"));
    return answerOnPc(socket, { type: "notice-answer", id: notice.id, answer: "not_me", blocks } as NoticeAnswer, deps.timeoutMs);
  };
  const counted = new Map<string, BlockSend>(pcs.includes(own) ? [[own, answer]] : []);
  const relayed = new Map<string, BlockSend>();
  for (const pc of pcs) {
    if (pc === own) continue;
    const channel = deps.channel?.(pc);
    if (channel !== undefined) counted.set(pc, (blocks) => recordsOnPc(channel, blocks));
    else relayed.set(pc, (blocks) => recordsOnPc(deps.post(pc), blocks));
  }
  return { pcs: counted, relayed };
}
