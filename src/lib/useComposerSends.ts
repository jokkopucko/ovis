import { useCallback, useMemo, type MutableRefObject } from "react";
import { ApiError } from "./api.ts";
import { answerFromText, answerRefusal, needsConfirmation, type TypedAnswer } from "./promptAnswer.ts";
import { composerDelivery, pendingActionUncertain, submitNote, submitNotTyped, submitRefusal, type DraftRefusal } from "./compose.ts";
import type { PaneSubmitRetention } from "./paneSubmitRetention.ts";
import { pendingMessages, UNCONFIRMED_SEND } from "./pendingMessages.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { composerDrafts } from "./composerDraft.ts";
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
  draftHeldForRef: MutableRefObject<string | null>;
  ended: boolean;
  heldByOpenQueue: boolean;
  heldRef: MutableRefObject<boolean>;
  inputRowNow: () => string | null;
  /** whether the cursor's agent can take a message now, whatever herdr reports (lib/compose.ts) */
  inputAtRest?: () => boolean;
  knownOutcomes: (pane: string | null) => readonly string[] | null;
  observeRef: MutableRefObject<boolean>;
  paneId: string | null;
  paneRef: MutableRefObject<string | null>;
  /** the typed pick waiting in the card for Confirm (useChatCallbacks) */
  pendingAnswer: { pane: string; promptId: string; answer: TypedAnswer } | null;
  pendingScopeRef: MutableRefObject<string | null>;
  /** the chat's navigation generation, read as a message goes out (ChatView `navigation`) */
  chatNavigation: MutableRefObject<number>;
  /** advanced once this browser's own message from the box was accepted at once (ChatView `localSend`) */
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
  submitComposerMessage: (text: string, delivery: SubmitDelivery, clearDraft?: string, sendAnyway?: boolean, pendingId?: string, resendGeneration?: number, agentOnly?: boolean) => Promise<SubmitResult> | null;
  submitRetention: PaneSubmitRetention | null;
  t: Translate;
}

export function useComposerSends(deps: ComposerSendsDeps) {
  const { agent, agentStatus, answerPanePrompt, answering, chatNavigation, draftHeldForRef, ended, heldByOpenQueue, heldRef, inputAtRest, inputRowNow, knownOutcomes, observeRef, paneId, paneRef, pendingAnswer, pendingScopeRef, queueOwner, queueStore, machineId, secretRef, sessionRef, setChatLocalSend, setPendingAnswer, setPromptRefresh, settings, showSentCommand, socketRef, stillOpenNote, stillOpenNotedRef, stillOpenRef, submitComposerMessage, submitRetention, t } = deps;

  /** An answer from the message box, not the card: its failure is the box's note. */
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

  /**
   * The typed pick waiting in the card for Confirm, as the message box's keys: Enter in the empty
   * box confirms it and Escape cancels it, as the card's two buttons do. null: none waits for this prompt.
   */
  const waitingAnswer = useMemo(() => {
    if (paneId === null || answering === null || pendingAnswer === null || pendingAnswer.pane !== paneId || pendingAnswer.promptId !== answering.id) return null;
    const pane = paneId, choice = pendingAnswer.answer;
    return {
      confirm: (): Promise<boolean | string> => sendAnswer(pane, answering, choice),
      cancel: (): void => setPendingAnswer(null),
    };
  }, [answering, paneId, pendingAnswer, sendAnswer, setPendingAnswer]);

  const composerSend = useCallback(
    (text: string, clearDraft?: string, sendAnyway = false, agentOnly = false): boolean | string | DraftRefusal | Promise<boolean | string | DraftRefusal> => {
      const pane = paneRef.current;
      // Codex's queue open in the terminal holds the input: a message would become the answer
      if (pane !== null && heldByOpenQueue) {
        return t("Codex has a question open in the terminal: answer it above, or close it there (alt+↓) to message Codex.");
      }
      // Send it: the draft a refusal named goes as the message, over itself (the server clears it, then
      // sends the same text). A menu opened since would take it as a choice, so it is never an answer
      const asDraft = clearDraft !== undefined && text === clearDraft;
      if (pane !== null && asDraft && answering !== null) return submitNote("agent_blocked", "");
      if (pane !== null && answering !== null) {
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
      else if (!sendAnyway && open !== null && open.pane === pane) {
        stillOpenNotedRef.current = true;
        return { note: stillOpenNote(open), anyway: true, plain: true };
      }
      // an older bridge is told apart by the socket, once this connection's snapshot has said what it supports.
      // A draft is cleared only by a send at once: one that waits its turn is checked when it goes
      // with automatic sending off, a follow-up waits for Send now; the socket queues it on a PC too old to hold one
      // herdr reads an idle Claude with a live subagent as working (a braille title spinner, and
      // "Waiting for N background agents to finish"); its own box at rest says it can take the message
      const settled = composerDelivery(agent, agentStatus);
      const queued = settled === "queue" && inputAtRest?.() === true ? "immediate" : settled;
      const delivery: SubmitDelivery = queued === "queue" && !settings.autoSendQueued ? "hold" : queued;
      // Send anyway answered a box seen at once: an agent that started working since would queue it unchecked.
      // Send it too: queued, the draft's text could go again after the draft itself was sent in the terminal
      if ((sendAnyway || asDraft) && delivery !== "immediate") return t("Not sent: the agent started working since. Check the terminal, then send again.");
      const known = knownOutcomes(pane);
      const seen = inputRowNow() === "ready";
      // before the receipt is awaited: navigation while it is on its way cancels the follow
      const navigation = chatNavigation.current;
      const socket = socketRef.current, session = sessionRef.current;
      const result = submitComposerMessage(text, delivery, delivery === "immediate" ? clearDraft : undefined, sendAnyway, undefined, undefined, agentOnly);
      return result === null ? false : result.then((answer) => {
        if (!answer.ok) return submitRefusal(answer.code, answer.message, answer.draft, answer.box, agent);
        // an older bridge took it with no receipt: the box lets it go, a row keeps it as not confirmed
        if (answer.unconfirmed && pane !== null) pendingMessages.keepUnconfirmed(paneStorageId(machineId, pane), text);
        // only a receipt that says the pane took it at once, on the connection and pane it left from
        if (delivery === "immediate" && answer.pending === undefined && !answer.unconfirmed
          && paneRef.current === pane && socketRef.current === socket && sessionRef.current === session) {
          setChatLocalSend((current) => ({ key: current.key + 1, navigationGeneration: navigation }));
        }
        if (pane !== null && delivery === "immediate" && answer.pending === undefined && !answer.unconfirmed) showSentCommand(pane, text, known, seen);
        return true;
      });
    },
    [agent, agentStatus, answering, heldByOpenQueue, sendAnswer, submitComposerMessage, queueStore, machineId, settings.autoSendQueued, showSentCommand, inputAtRest, inputRowNow, stillOpenNote],
  );

  const actOnPending = useCallback(async (id: string, action: "steer" | "discard" | "edit"): Promise<void> => {
    const perform = async (): Promise<void> => {
      const owner = queueOwner, pane = paneId;
      const socket = socketRef.current, scope = pendingScopeRef.current;
      if (owner === null || pane === null || paneRef.current !== pane) return;
      // what another tab saved since: a copy it is sending again is not confirmed here either
      pendingMessages.refresh(owner);
      const message = pendingMessages.read(owner).find((item) => item.id === id);
      if (!message || message.state === "sending") return;
      // Editing needs this connection's withdrawal authority, not just a saved held
      // copy. Uncertain Pi copies are receipts, not queued input.
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
      // a screen a peek left open would take it, as it would the composer's Send
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
            const result = socket?.pendingAction(pane, id, action === "edit" ? "discard" : action, message.resendGeneration ?? 0, action === "edit");
            // offline: no frame left (the row shows submitNote's wording, not this message)
            if (!result) {
              pendingMessages.fail(owner, id, { code: "not_transmitted", message: "the connection dropped before this message was sent" }, pendingActionUncertain("not_transmitted", message.state));
              return;
            }
            // as a composer send: the pane keeps its connection and lease until the receipt settles
            const releaseSubmit = submitRetention?.retain(pane);
            const answer = await result.finally(() => releaseSubmit?.());
            if (answer.ok && action === "steer" && delivered) showSentCommand(pane, message.text, known, seen);
            if (!answer.ok) pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, pendingActionUncertain(answer.code, message.state),
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
            if (answer.pending === undefined) showSentCommand(pane, message.text, known, seen);
          }
          // A concurrent Edit can remove storage while this copy is busy. Its exact
          // withdrawal refusal settles that copy instead of recreating a held row.
          else if (answer.code === "pending_discarded") pendingMessages.removeCopy(owner, id);
          else pendingMessages.fail(owner, id, { code: answer.code, message: answer.message }, !submitNotTyped(answer.code), message.resendGeneration ?? 0);
        }
      } catch {
        pendingMessages.fail(owner, id, { code: "disconnected", message: t("Not confirmed. Check the terminal before sending again.") }, true);
      } finally { pendingMessages.end(owner, id); }
    };
    // Web Locks reduce contention where supported; the bridge's stable resend ID is the
    // authority on LAN HTTP and when two tabs have already read the same held copy.
    if (navigator.locks) await navigator.locks.request(`pending:${queueOwner}:${id}`, perform);
    else await perform();
  }, [answering, ended, heldByOpenQueue, paneId, queueOwner, submitComposerMessage, submitRetention, showSentCommand, inputRowNow, stillOpenNote]);

  return { composerSend, actOnPending, waitingAnswer };
}
