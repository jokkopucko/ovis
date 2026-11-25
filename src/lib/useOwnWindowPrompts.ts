import { useEffect, useMemo, useState } from "react";

import type { OwnJoinRequest, PendingKey, RelayPairingRequest } from "../../shared/machines.ts";
import { useOwnJoins } from "../components/OwnJoins.tsx";
import { firstJoinPrompts, listAddPrompts, pendingKeyPrompts, tailnetPrompts, type PromptPairing } from "../components/RelayPairingPrompt.tsx";
import { listNumberHeld, onListNumbersHeld } from "./account/addThisPc.ts";
import { useListAdd } from "./useListAdd.ts";
import { useTailnetNodes } from "./useTailnetNodes.ts";

/**
 * What this PC's window asks in one place (RelayPairingPrompt): devices waiting with digits, and, in the PC's own window
 * alone, a first join with Allow beside its digits, a key waiting for its screen beside a button that opens the confirm
 * page, a removed Tailscale device asking to get back in (server/tailnet-nodes.ts), and the number of a running add
 * of this PC by its account's signed list (`ovis add`), with **The numbers match**. `ownWindow` is a display hint
 * only: the routes and the confirm page enforce their own rules. `joins`: the account joins waiting for the own window
 * (OwnJoinCard takes those without digits), read only while `unlocked`, and `reread` reads them, and the add, again at once.
 */
export function useOwnWindowPrompts(relayPairings: readonly RelayPairingRequest[], pendingKeys: readonly PendingKey[], ownWindow: boolean, unlocked = true): { readonly prompts: readonly PromptPairing[]; readonly joins: readonly OwnJoinRequest[]; readonly reread: () => void } {
  const [reads, setReads] = useState(0);
  // a locked PC refuses the list: it is read again once the lock is gone
  const joins = useOwnJoins(ownWindow && unlocked, reads);
  // a first join's deadline is counted from its own read: an unrelated update rebuilds the list, never that deadline
  const firstJoins = useMemo(() => firstJoinPrompts(joins), [joins]);
  const tailnet = useTailnetNodes(ownWindow)?.pending ?? null;
  const tailnetAsks = useMemo(() => tailnetPrompts(tailnet), [tailnet?.id, tailnet?.asked_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const listAdd = useListAdd(ownWindow && unlocked, reads);
  // a number a wait shows in the dialog it was pressed in is that wait's to answer: one place alone takes the yes
  const [holds, setHolds] = useState(0);
  useEffect(() => onListNumbersHeld(() => setHolds((count) => count + 1)), []);
  const addAsks = useMemo(() => listAddPrompts(listAdd).filter((ask) => !listNumberHeld(ask.run)), [listAdd?.state, listAdd !== null && listAdd.state === "number" ? `${listAdd.run} ${listAdd.digits} ${listAdd.until}` : null, holds]); // eslint-disable-line react-hooks/exhaustive-deps
  const prompts = useMemo(() => [...relayPairings, ...firstJoins, ...(ownWindow ? [...addAsks, ...pendingKeyPrompts(pendingKeys), ...tailnetAsks] : [])], [relayPairings, firstJoins, ownWindow, addAsks, pendingKeys, tailnetAsks]);
  const reread = useMemo(() => () => setReads((count) => count + 1), []);
  return { prompts, joins, reread };
}
