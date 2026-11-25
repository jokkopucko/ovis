import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { ApiError } from "./api.ts";
import { answerFromText, answerRefusal, needsConfirmation, type TypedAnswer } from "./promptAnswer.ts";
import { composerDelivery, pendingActionUncertain, submitNote, submitNotTyped, submitRefusal, type DraftRefusal } from "./compose.ts";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";
import { pendingMessages, UNCONFIRMED_SEND } from "./pendingMessages.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { rememberWaitingSend, stampedBaseline, waitingBaseline, waitingKey } from "./sentWaiting.ts";
import { composerDraftKey, composerDrafts } from "./composerDraft.ts";
import type { AgentStatus, InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import type { HerdrSocket, SubmitDelivery, SubmitResult } from "./ws.ts";
import { plainError } from "./paneTerminalShared.ts";
import type { Translate } from "./i18n.ts";
import type { MachineSession } from "./machineSession.ts";

export interface ComposerSendsDeps {
  agent: string | null;
  agentStatus: AgentStatus | undefined;
  answerPanePrompt: (answer: { pane_id: string; prompt_id: string }) => Promise<unknown>;
  answering: InteractivePrompt | null;
  answerPending: boolean;
  draftHeldForRef: MutableRefObject<string | null>;
  dropSecondEscape: () => void;
  ended: boolean;
  heldByOpenQueue: boolean;
  heldRef: MutableRefObject<boolean>;
  inputRowNow: () => string | null;
  inputAtRest?: () => boolean;
  knownOutcomes: (pane: string | null) => readonly string[] | null;
  observeRef: MutableRefObject<boolean>;
  paneId: string | null;
  paneRef: MutableRefObject<string | null>;
  pendingAnswer: { pane: string; promptId: string; answer: TypedAnswer } | null;
  pendingScopeRef: MutableRefObject<string | null>;
  chatNavigation: MutableRefObject<number>;
  setChatLocalSend: (update: (current: { key: number; navigationGeneration: number }) => { key: number; navigationGeneration: number }) => void;
  sessionRef: MutableRefObject<MachineSession | null>;
  queueOwner: string | null;
  queueStore: unknown;
  machineId: string;
  secretRef: MutableRefObject<string | null>;
  setPendingAnswer: (answer: { pane: string; promptId: string; answer: Pick<PromptAnswer, "option_index" | "option_indices" | "custom_text"> } | null) => void;
  setPromptRefresh: (update: (key: number) => number) => void;
  settings: { autoSendQueued: boolean };
  showSentCommand: (pane: string, text: string, known: readonly string[] | null, seen: boolean) => void;
  socketRef: MutableRefObject<HerdrSocket | null>;
  stillOpenNote: (open: { pane: string; agent: string; command: string; named: boolean; history: string | undefined }) => string;
  stillOpenNotedRef: MutableRefObject<boolean>;
  stillOpenRef: MutableRefObject<{ pane: string; agent: string; command: string; named: boolean; history: string | undefined } | null>;
  submitComposerMessage: (text: string, delivery: SubmitDelivery, clearDraft?: string, sendAnyway?: boolean, pendingId?: string, resendGeneration?: number, agentOnly?: boolean, holdOnly?: boolean, commandKey?: string) => Promise<SubmitResult> | null;
  submitRetention: PaneSubmitRetention | null;
  t: Translate;
}

export function useComposerSends(deps: ComposerSendsDeps) {
  const { agent, agentStatus, answerPanePrompt, answering, answerPending, chatNavigation, draftHeldForRef, dropSecondEscape, ended, heldByOpenQueue, heldRef, inputAtRest, inputRowNow, knownOutcomes, observeRef, paneId, paneRef, pendingAnswer, pendingScopeRef, queueOwner, queueStore, machineId, secretRef, sessionRef, setChatLocalSend, setPendingAnswer, setPromptRefresh, settings, showSentCommand, socketRef, stillOpenNote, stillOpenNotedRef, stillOpenRef, submitComposerMessage, submitRetention, t } = deps;

  const sendAnswer = useCallback((pane: string, prompt: InteractivePrompt, choice: TypedAnswer): Promise<boolean | string> => {
    setPendingAnswer(null);
    return answerPanePrompt({ pane_id: pane, prompt_id: prompt.id, ...choice }).then(
      () => { setPromptRefresh((key) => key + 1); return true; },
      (cause: unknown) => {
        setPromptRefresh((key) => key + 1);
        if (cause instanceof ApiError && cause.code === "reply_unconfirmed") return t("OpenCode did not confirm the answer. Check the question before sending again.");
        return cause instanceof ApiError && cause.status === 409 ? t("The question on screen changed; check it and answer again.") : plainError(cause);
      },
    );
  }, [answerPanePrompt, setPendingAnswer, setPromptRefresh, t]);

  const waitingAnswer = useMemo(() => {
    if (answerPending || paneId === null || answering === null || pendingAnswer === null || pendingAnswer.pane !== paneId || pendingAnswer.promptId !== answering.id) return null;
    const pane = paneId, choice = pendingAnswer.answer;
    return {
      confirm: (): Promise<boolean | string> => sendAnswer(pane, answering, choice),
      cancel: (): void => setPendingAnswer(null),
    };
  }, [answering, answerPending, paneId, pendingAnswer, sendAnswer, setPendingAnswer]);

  const sendNowRef = useRef<(id: string) => Promise<void>>(async () => {});

  const composerSend = useCallback(
    // `hold`: Alt+Enter, kept in the queued list for its Send now alone, whatever automatic sending or the agent's state says
    (text: string, clearDraft?: string, sendAnyway = false, agentOnly = false, now = false, hold = false): boolean | string | DraftRefusal | Promise<boolean | string | DraftRefusal> => {
      const pane = paneRef.current;
      if (pane !== null && answerPending) return false;
      // Codex's queue open in the terminal holds the input: a message would become the answer
      if (pane !== null && heldByOpenQueue) {
        return t("Codex has a question open in the terminal: answer it above, or close it there (alt+↓) to message Codex.");
      }
      // Send it: the draft a refusal named goes as the message, over itself (the server clears it, then
      // sends the same text). A menu opened since would take it as a choice, so it is never an answer
      const asDraft = clearDraft !== undefined && text === clearDraft;
      if (pane !== null && asDraft && answering !== null) return submitNote("agent_blocked", "");
      // a hold is typed into nothing now: it is never an answer, and its Send now checks the menu then
      if (pane !== null && answering !== null && !hold) {
        // never typed into the agent's menu: only as one of its options, or its own reply row
        const choice = answerFromText(answering, text);
        if (choice === null) return answerRefusal(answering);
        if (needsConfirmation(answering, choice)) {
          setPendingAnswer({ pane, promptId: answering.id, answer: choice });
          return true;
        }
        return sendAnswer(pane, answering, choice);
      }
      if (!socketRef.current?.connected || heldRef.current || secretRef.current !== null) return false;
      // A screen a peek left open in the terminal would take the message: Send says so and keeps it,
      // and the note's Send anyway sends it once (the recognizer may be wrong), as a plain send: it
      // answers this guard, never a box the server showed
      const notedStillOpen = stillOpenNotedRef.current;
      stillOpenNotedRef.current = false;
      const open = stillOpenRef.current;
      if (sendAnyway && notedStillOpen) sendAnyway = false;
      else if (!sendAnyway && !hold && open !== null && open.pane === pane) {
        stillOpenNotedRef.current = true;
        return { note: stillOpenNote(open), anyway: true, plain: true };
      }
      // herdr reads an idle Claude with a live subagent as working (a braille title spinner, and
      // "Waiting for N background agents to finish"); its own box at rest says it can take the message
      // a herdr-core server (`terminal-modes`) also shows a pane blocked while it reads a card its agent did not report.
      // Until this connection's features are known that cannot be told apart: a blocked pane is then taken as one
      const listening = socketRef.current;
      const cardWaits = listening?.featuresListed?.() === true ? listening.typesArrows() : true;
      const settled = composerDelivery(agent, agentStatus, cardWaits);
      const queued = settled === "queue" && inputAtRest?.() === true ? "immediate" : settled;
      const delivery: SubmitDelivery = hold ? "hold" : queued === "queue" && !settings.autoSendQueued ? "hold" : queued;
      // Send anyway answered a box seen at once: an agent that started working since would queue it unchecked.
      // Send it too: queued, the draft's text could go again after the draft itself was sent in the terminal
      if ((sendAnyway || asDraft) && delivery !== "immediate") return t("Not sent: the agent started working since. Check the terminal, then send again.");
      const known = knownOutcomes(pane);
      const seen = inputRowNow() === "ready";
      const navigation = chatNavigation.current;
      const socket = socketRef.current, session = sessionRef.current;
      const sentAt = Date.now();
      const sentAfter = pane === null ? null : waitingBaseline(waitingKey(machineId, pane));
      // a PC that cannot hold refuses a hold rather than queuing it to go on its own (HerdrSocket `holdOnly`)
      const command = pane === null ? undefined : composerDrafts.commandKey(composerDraftKey(paneStorageId(machineId, pane)), text);
      const result = submitComposerMessage(text, delivery, delivery === "immediate" ? clearDraft : undefined, sendAnyway, undefined, undefined, agentOnly, hold, command);
      return result === null ? false : result.then((answer) => {
        // Neither a dropped connection nor a cleared old draft proves this message was typed.
        // Without a receipt, leave the retryable composer text and report the uncertainty.
        if (!answer.ok) return submitRefusal(answer.code, answer.message, answer.draft, answer.box, agent);
        if (answer.unconfirmed && pane !== null) pendingMessages.keepUnconfirmed(paneStorageId(machineId, pane), text);
        // A queued follow-up was typed now only when its receipt says so: an ok with no `pending` also
        // answers a replayed id, or a row sent or discarded since
        const typedNow = answer.pending === undefined && !answer.unconfirmed && !answer.replayed && (delivery === "immediate" || answer.typedNow === true);
        if (typedNow) {
          if (paneRef.current === pane && socketRef.current === socket && sessionRef.current === session) {
            setChatLocalSend((current) => ({ key: current.key + 1, navigationGeneration: navigation }));
          }
          if (pane !== null) rememberWaitingSend(waitingKey(machineId, pane), text, sentAt, stampedBaseline(sentAfter, answer.sendingAt, sentAt));
        }
        if (pane !== null && typedNow) showSentCommand(pane, text, known, seen);
        if (now && !answer.replayed && answer.pending !== undefined) void sendNowRef.current(answer.pending.id);
        return true;
      });
    },
    [agent, agentStatus, answering, answerPending, heldByOpenQueue, sendAnswer, submitComposerMessage, queueStore, machineId, settings.autoSendQueued, showSentCommand, inputAtRest, inputRowNow, stillOpenNote],
  );

  const actOnPending = useCallback(async (id: string, action: "steer" | "discard" | "edit" | "dismiss"): Promise<void> => {
    const perform = async (): Promise<void> => {
      const owner = queueOwner, pane = paneId;
      const socket = socketRef.current, scope = pendingScopeRef.current;
      if (owner === null || pane === null || paneRef.current !== pane) return;
      pendingMessages.refresh(owner);
      const message = pendingMessages.read(owner).find((item) => item.id === id);
      if (!message || message.state === "sending") return;
      // The X on an uncertain row dismisses only that copy, even offline, and never
      // turns into a queue discard if a later publish changed the row to queued/held.
      const dismiss = action === "dismiss" || action === "discard" && message.state === "uncertain";
      if (dismiss && message.state !== "uncertain") return;
      // This connection's own record goes to the bridge: its discard of an uncertain record is a "dismissed"
      // outcome (no withdrawal, no draft restore) and lifts that record's hold on the pane's queue. A copy no
      // live connection here owns, or one the bridge cannot dismiss, is hidden on this page alone.
      if (dismiss && !(message.serverOwned && socket?.connected && pendingMessages.isOwned(owner, id, scope))) {
        pendingMessages.dismissCopy(owner, id);
        return;
      }
      let hideLocally = false;
      // Editing needs this connection's withdrawal authority, not just a saved held copy.
      if (action === "edit" && (!message.serverOwned || message.state !== "queued" && message.state !== "held" || message.resendInFlight)) return;
      if (action === "steer" && (message.state === "uncertain" || !socket?.connected || heldRef.current || secretRef.current !== null || observeRef.current || ended || heldByOpenQueue || answering !== null)) return;
      if (message.serverOwned && !pendingMessages.isOwned(owner, id, scope)) return;
      // keys held back in the terminal draft would run in front of the message: the server pastes a
      // server-owned row's text and sends Enter without looking for a partial line (only Claude's box
      // is checked there). The row stays as it is, so Send now after the draft is settled, or Discard, still works.
      if (action === "steer" && draftHeldForRef.current === pane) {
        pendingMessages.fail(owner, id, { code: "held_input", message: "send or discard the held input first" }, false);
        return;
      }
      const open = stillOpenRef.current;
      if (action === "steer" && open !== null && open.pane === pane) {
        pendingMessages.fail(owner, id, { code: "still_open", message: stillOpenNote(open) }, false);
        return;
      }
      if (!pendingMessages.begin(owner, id)) return;
      try {
        if (message.serverOwned) {
          // A successful action can replay a prior discard. Only the matching sent removal,
          // published before the action result, proves that this explicit Send now ran anything.
          let delivered = false, edited = false;
          const off = socket?.on((frame) => {
            if (frame.type !== "pending-messages" || frame.pane_id !== pane) return;
            if (frame.removed?.some((item) => item.id === id && item.outcome === "sent")) delivered = true;
            // The serialized discard receipt, not an ok result (which can replay a send),
            // is the atomic withdrawal authority. Restore immediately even if WS closes
            // before pending-result arrives. A concurrent delivery never restores text.
            if (action === "edit" && !edited && frame.removed?.some((item) => item.id === id && item.outcome === "discarded")) {
              edited = true;
              composerDrafts.restorePending(`ovis:composer-draft:${owner}`, message.text, message.agent_only === true);
            }
          });
          try {
            const known = knownOutcomes(pane);
            const seen = inputRowNow() === "ready";
            const generation = message.resendGeneration ?? 0;
            const result = action === "steer"
              ? socket?.pendingAction(pane, id, "steer", generation, false, () => {
                if (paneRef.current === pane && socketRef.current === socket) dropSecondEscape();
              })
              : socket?.pendingAction(pane, id, "discard", generation, action === "edit");
            if (!result && dismiss) { hideLocally = true; return; }
            if (!result) {
              pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, pendingActionUncertain("not_transmitted", message.state));
              return;
            }
            const releaseSubmit = submitRetention?.retain(pane);
            const answer = await result.finally(() => releaseSubmit?.());
            if (answer.ok && action === "steer" && delivered) showSentCommand(pane, message.text, known, seen);
            // still in flight on the bridge, no longer there, or its connection ended (the bridge settles that one's
            // records itself): the copy goes from this page only
            if (!answer.ok && dismiss && ["pending_uncertain", "pending_not_found", "disconnected", "not_transmitted"].includes(answer.code)) hideLocally = true;
            else if (!answer.ok) pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, pendingActionUncertain(answer.code, message.state),
              action === "steer" ? message.resendGeneration ?? 0 : undefined);
          } finally {
            off?.();
          }
          // Only the matching server removal receipt removes an authoritative item.
        } else if (action === "discard") {
          pendingMessages.removeCopy(owner, id);
        } else if (message.state === "held") {
          if (!pendingMessages.unconfirm(owner, id)) {
            return;
          }
          const known = knownOutcomes(pane);
          const seen = inputRowNow() === "ready";
          const sentAt = Date.now(), sentAfter = waitingBaseline(waitingKey(machineId, pane));
          const result = submitComposerMessage(message.text, "immediate", undefined, false, id, message.resendGeneration ?? 0, message.agent_only === true);
          if (!result) {
            pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, false);
            return;
          }
          const answer = await result;
          // an older bridge's raw input has no receipt: the copy stays, not confirmed, rather than going as sent
          if (answer.ok && answer.unconfirmed) pendingMessages.fail(owner, id, UNCONFIRMED_SEND, true, message.resendGeneration ?? 0);
          else if (answer.ok) {
            pendingMessages.removeCopy(owner, id);
            if (answer.pending === undefined) {
              if (answer.typedNow === true) rememberWaitingSend(waitingKey(machineId, pane), message.text, sentAt, stampedBaseline(sentAfter, answer.sendingAt, sentAt));
              showSentCommand(pane, message.text, known, seen);
            }
          }
          // A concurrent Edit can remove storage while this copy is busy. Its exact
          // withdrawal refusal settles that copy instead of recreating a held row.
          else if (answer.code === "pending_discarded") pendingMessages.removeCopy(owner, id);
          else pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, !submitNotTyped(answer.code), message.resendGeneration ?? 0);
        }
      } catch {
        if (dismiss) hideLocally = true;
        else pendingMessages.fail(owner, id, { code: "disconnected", message: t("Not confirmed. Check the terminal before sending again.") }, true);
      } finally {
        const now = pendingMessages.end(owner, id);
        if (hideLocally) pendingMessages.dismissCopy(now, id);
      }
    };
    // Web Locks reduce contention where supported; the bridge's stable resend ID is the
    // authority on LAN HTTP and when two tabs have already read the same held copy.
    if (navigator.locks) await navigator.locks.request(`pending:${queueOwner}:${id}`, perform);
    else await perform();
  }, [answering, dropSecondEscape, ended, heldByOpenQueue, paneId, queueOwner, submitComposerMessage, submitRetention, showSentCommand, inputRowNow, stillOpenNote]);

  sendNowRef.current = (id) => actOnPending(id, "steer");

  return { composerSend, actOnPending, waitingAnswer };
}
