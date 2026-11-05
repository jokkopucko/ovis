import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { Clock } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { shouldFoldUserMessage } from "../lib/userMessageFold.ts";
import { currentWaitingSends, forgetMachineWaitingSends, subscribeWaitingSends, WAITING_HINT_MS, waitingKey, type WaitingSend } from "../lib/sentWaiting.ts";

/**
 * The sends this browser made to a pane that its transcript does not hold yet. A lost connection
 * lets the PC's go, before paint: what became of them is the transcript's to say once it is read
 * again, and nothing is sent again.
 */
export function useWaitingSends(machineId: string, paneId: string, connected: boolean): readonly WaitingSend[] {
  const key = waitingKey(machineId, paneId);
  useLayoutEffect(() => {
    if (!connected) forgetMachineWaitingSends(machineId);
  }, [connected, machineId]);
  return useSyncExternalStore(subscribeWaitingSends, () => currentWaitingSends(key));
}

/**
 * Sent, and the agent has not written it as a turn yet: the user's bubble where the turn will be,
 * faded, with nothing under it, as a messenger shows a message at once on Send. Its turn takes its
 * place when the transcript has it; a clock joins it, where the turn's time will be, only when that
 * takes longer than WAITING_HINT_MS.
 */
export function SentWaitingList({ sends }: { sends: readonly WaitingSend[] }) {
  const t = useT();
  const [now, setNow] = useState(Date.now);
  const nextHint = sends.reduce((soonest, send) => {
    const due = send.at + WAITING_HINT_MS;
    return due > now && due < soonest ? due : soonest;
  }, Number.POSITIVE_INFINITY);
  useEffect(() => {
    if (nextHint === Number.POSITIVE_INFINITY) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, nextHint - Date.now()));
    return () => clearTimeout(timer);
  }, [nextHint]);
  const late = t("Sent · waiting for the agent's next turn");
  // no live region of its own: the chat footer has one, and the user's own words need no announcing
  return <div className="chat-sent-waiting-list">
    {sends.map((send) => {
      // capped at the lines its turn's card shows (UserMessage, ChatView.tsx), so the turn takes its
      // place at about its height; the card's fade and Show full message come with the turn
      const capped = shouldFoldUserMessage(send.text);
      return <div key={send.id} className="chat-turn chat-turn-user chat-turn-waiting">
        <div className="chat-user-row">
          <div className={capped ? "chat-bubble is-capped" : "chat-bubble"}><div className="chat-bubble-body">{send.text}</div></div>
          {now - send.at >= WAITING_HINT_MS && <div className="chat-turn-meta">
            <span className="chat-sent-late" role="img" aria-label={late} title={late}><Clock aria-hidden="true" /></span>
          </div>}
        </div>
      </div>;
    })}
  </div>;
}
