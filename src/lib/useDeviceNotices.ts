import { useCallback, useEffect, useRef, useState } from "react";

import type { DeviceNotice, NoticeAnswer, NoticeSeen } from "../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { noticeSeen, withNoticeAcked, withNoticeDecided, withNoticeReplay, type PcNotices } from "./deviceNotices.ts";

/** What this hook needs of a PC's socket (HerdrSocket): its frames, and a send that only a PC offering it takes. */
export interface NoticeSocket {
  on(handler: (message: ServerMessage) => void): () => void;
  onDisconnect(handler: () => void): () => void;
  accountOpensAll(): boolean;
  sendNotice(message: NoticeSeen | NoticeAnswer): boolean;
}

/**
 * Each PC's journal notices (device table P15, T57): kept per PC as its socket replays and adds them, acknowledged
 * up to the newest one shown once that PC takes it, and dismissed here only; a dismiss sends nothing, and an open
 * admission is not dismissed (it stays until its PC says it was decided).
 */
export function useDeviceNotices(
  sockets: readonly { id: string; socket: NoticeSocket }[],
  selectedPcId: string,
  onClose?: (pcId: string, noticeId: string) => void,
) {
  // Process each frame against the latest feed, not the snapshot React last rendered.
  const latest = useRef<ReadonlyMap<string, PcNotices>>(new Map());
  const [retained, setRetained] = useState<ReadonlyMap<string, PcNotices>>(new Map());
  const updatePc = useCallback((id: string, update: (was: PcNotices | undefined) => PcNotices | undefined) => {
    const was = latest.current.get(id);
    const next = update(was);
    if (next === undefined || next === was) return;
    latest.current = new Map(latest.current).set(id, next);
    setRetained(latest.current);
  }, []);
  useEffect(() => {
    const offs = sockets.flatMap(({ id, socket }) => {
      const hide = () => updatePc(id, (notices) => notices === undefined ? undefined :
        { ...notices, notices: notices.notices.filter((item) => item.kind === "admit" && item.open), cut: 0 });
      return [socket.onDisconnect(hide), socket.on((message) => {
        if (message.type === "features" || message.type === "snapshot") {
          if (socket.accountOpensAll()) {
            if (latest.current.has(id)) setRetained(new Map(latest.current));
          } else hide();
          return;
        }
        if (!socket.accountOpensAll()) {
          return;
        }
        if (message.type !== "device-notice-replay" && message.type !== "device-notice") return;
        updatePc(id, (was) => {
          const live = message.type === "device-notice";
          const replay = live ? { notices: [message.notice], cut: 0 } : message.replay;
          const next = withNoticeReplay(was, replay);
          if (onClose !== undefined && was !== undefined) {
            const open = new Set(next.notices.filter((notice) => notice.open).map((notice) => notice.id));
            const closed = new Set(replay.notices.filter((notice) => !notice.open).map((notice) => notice.id));
            for (const notice of was.notices) {
              if (notice.open && (!open.has(notice.id) || closed.has(notice.id))) onClose(id, notice.id);
            }
          }
          return live && was !== undefined ? { ...next, cut: was.cut } : next;
        });
      })];
    });
    return () => { for (const off of offs) off(); };
  }, [sockets, onClose, updatePc]);
  const selectedSocket = sockets.find(({ id }) => id === selectedPcId)?.socket;
  const byPc = new Map<string, PcNotices>();
  for (const { id, socket } of sockets) {
    const notices = retained.get(id);
    if (notices !== undefined && socket.accountOpensAll()) byPc.set(id, notices);
  }
  const shown = byPc.get(selectedPcId);
  const acknowledgeShown = useCallback((seq: number) => {
    const seen = shown === undefined ? null : noticeSeen(shown, seq);
    if (seen === null || !selectedSocket?.sendNotice(seen)) return;
    updatePc(selectedPcId, (notices) => notices === undefined ? undefined : withNoticeAcked(notices, seen.seq));
  }, [shown, selectedPcId, selectedSocket, updatePc]);
  const dismiss = useCallback((id: string, notice: DeviceNotice) => {
    updatePc(id, (notices) => notices?.notices.some((item) => item.id === notice.id && !item.open) === true
      ? withNoticeDecided(notices, notice.id) : notices);
  }, [updatePc]);
  return { byPc, dismiss, acknowledgeShown, cut: shown?.cut ?? 0 };
}
