import { useCallback, useEffect, useReducer, useRef, useState, type MutableRefObject } from "react";
import { afterRead, greetingMemory, rememberGreeting, type ChatRead } from "./greeting.ts";
import { paneStorageId } from "../../shared/machines.ts";
import type { AgentStatus, ConversationMetadata, InteractivePrompt } from "../../shared/protocol.ts";
import type { TypedAnswer } from "./promptAnswer.ts";
import type { HerdrSocket } from "./ws.ts";
import type { StillOpen } from "./paneTerminalShared.ts";

export interface ChatCallbacksDeps {
  activeRef: MutableRefObject<boolean>;
  agentStatus: AgentStatus | undefined;
  chatHistoryRef: MutableRefObject<{ pane: string; history: string | undefined } | null>;
  chatViewRef: MutableRefObject<boolean>;
  findOpenRef: MutableRefObject<boolean>;
  machineId: string;
  pendingOpenRef: MutableRefObject<StillOpen | null>;
  setStillOpen: (next: StillOpen | null) => void;
  socketRef: MutableRefObject<HerdrSocket | null>;
  stackRef: MutableRefObject<HTMLDivElement | null>;
  stillOpenRef: MutableRefObject<StillOpen | null>;
  undecidedOpenRef: MutableRefObject<StillOpen | null>;
}

export function useChatCallbacks(deps: ChatCallbacksDeps) {
  const { activeRef, agentStatus, chatHistoryRef, chatViewRef, findOpenRef, machineId, pendingOpenRef, setStillOpen, socketRef, stackRef, stillOpenRef, undecidedOpenRef } = deps;
  // an older bridge pushes no transcript changes: the chat reads at the former 2s cadence
  const [conversationPushes, setConversationPushes] = useState(false);
  const onConversationWatch = useCallback((pane: string, enabled: boolean) => {
    socketRef.current?.watchConversation(pane, enabled);
  }, []);
  /** A scrollback stand-in's listener; a ref, so terminal output never re-renders the pane. */
  const chatOutputRef = useRef<(() => void) | null>(null);
  const onTerminalOutput = useCallback((listener: (() => void) | null) => {
    chatOutputRef.current = listener;
  }, []);
  // bumped as a composer message goes out: the chat must not title the turn before it as running
  const [chatSent, setChatSent] = useState(0);
  // bumped as such a message is refused with nothing typed
  const [chatUnsent, setChatUnsent] = useState(0);
  const [chatMetadata, setChatMetadata] = useState<{ pane: string; value: ConversationMetadata | null } | null>(null);
  // What each pane's chat last read, and whether a message went out since: kept per pane here,
  // not in the chat, so a message sent ends the greeting at once and neither another lens, another
  // pane nor a failed read brings it back before the conversation shows a turn or a new history.
  // It lives in lib/greeting.ts, over this component, which another PC's pane mounts again.
  const [, redrawGreeting] = useReducer((count: number) => count + 1, 0);
  const onChatRead = useCallback((pane: string, read: ChatRead | null) => {
    if (read !== null) {
      // another session in the pane (a new history): a screen left open in the old one is no more
      const open = stillOpenRef.current;
      if (open !== null && open.pane === pane && read.history !== undefined && open.history !== undefined && read.history !== open.history) setStillOpen(null);
      const pending = pendingOpenRef.current;
      if (pending !== null && pending.pane === pane && read.history !== undefined && pending.history !== undefined && read.history !== pending.history) pendingOpenRef.current = null;
      const undecided = undecidedOpenRef.current;
      if (undecided !== null && undecided.pane === pane && read.history !== undefined && undecided.history !== undefined && read.history !== undecided.history) undecidedOpenRef.current = null;
      chatHistoryRef.current = { pane, history: read.history };
    }
    const owner = paneStorageId(machineId, pane);
    const memory = greetingMemory(owner);
    const next = afterRead(memory, read);
    if (next === memory) return;
    rememberGreeting(owner, next); redrawGreeting();
  }, [machineId, setStillOpen]);
  // the stack (stackRef, above) holds the composer and the greeting over it (measured below)
  const [greetingRoom, setGreetingRoom] = useState(true);
  const greetingRef = useRef<HTMLDivElement | null>(null);
  // The prompt the chat shows: while it waits, a message from the composer answers it.
  const [chatPrompt, setChatPrompt] = useState<{ pane: string; value: InteractivePrompt; answered: boolean } | null>(null);
  const [promptRefresh, setPromptRefresh] = useState(0);
  // what the agent suggests typing next (Claude's grey input text), for the composer's placeholder
  const [chatSuggestion, setChatSuggestion] = useState<{ pane: string; value: string } | null>(null);
  const onChatSuggestion = useCallback((pane: string, value: string | null) => {
    setChatSuggestion((current) => value !== null
      ? (current?.pane === pane && current.value === value ? current : { pane, value })
      : current?.pane === pane ? null : current);
  }, []);
  // a cancelled send the agent put back in its input box, for the composer to take again
  const [chatRestored, setChatRestored] = useState<{ pane: string; value: string } | null>(null);
  const onChatRestored = useCallback((pane: string, value: string | null) => {
    setChatRestored((current) => value !== null
      ? (current?.pane === pane && current.value === value ? current : { pane, value })
      : current?.pane === pane ? null : current);
  }, []);
  // a typed pick of an approval's option, shown in the card until Confirm or Cancel
  const [pendingAnswer, setPendingAnswer] = useState<{ pane: string; promptId: string; answer: TypedAnswer } | null>(null);
  // where the chat draws its prompt card: on the composer's column, between the held messages and
  // the input card (the stack's order is written once, in the JSX below)
  const [promptDock, setPromptDock] = useState<HTMLDivElement | null>(null);
  // Answered from the card, the card goes and would take the keyboard's focus with it: the message
  // box is the next thing to type in. Not after a tap, which would raise the keyboard: the card
  // tells a key, a mouse and a tap by the press itself (lib/promptAnswer.ts), so a key on a
  // tablet hands the focus on and a tap on a touch-screen laptop does not.
  const onPromptAnswered = useCallback((toMessageBox: boolean) => {
    if (activeRef.current && toMessageBox && (chatViewRef.current || !findOpenRef.current)) stackRef.current?.querySelector<HTMLTextAreaElement>(".composer-text")?.focus({ preventScroll: true });
  }, []);
  // only the pick of that pane and prompt: an answer that comes back late must not take another's
  const clearPendingAnswer = useCallback((pane: string, promptId?: string) => {
    setPendingAnswer((current) => current?.pane === pane && (promptId === undefined || current.promptId === promptId) ? null : current);
  }, []);
  const onChatPrompt = useCallback((pane: string, value: InteractivePrompt | null, answered = false) => {
    setChatPrompt((current) => value !== null ? { pane, value, answered } : current?.pane === pane ? null : current);
    // a typed pick belongs to the prompt it was typed for: once that prompt changes or goes
    // away (a tap in the card, an answer in the terminal), the same question asked again
    // later opens clean, not with the old pick waiting one tap from Confirm
    setPendingAnswer((current) => current?.pane === pane && current.promptId !== value?.id ? null : current);
  }, []);
  // back at work, the agent has had its answer, maybe from the terminal: the same prompt asked
  // again before the chat's next read must not bring the pick back either
  useEffect(() => {
    if (agentStatus === "working") setPendingAnswer(null);
  }, [agentStatus]);
  const onChatMetadata = useCallback((pane: string, value: ConversationMetadata | null) => {
    // the same settings keep the same object: every conversation read would otherwise re-render the composer
    setChatMetadata((previous) => previous?.pane === pane && previous.value?.model === value?.model
      && previous.value?.reasoning_effort === value?.reasoning_effort
      && previous.value?.context?.used === value?.context?.used
      && previous.value?.context?.window === value?.context?.window ? previous : { pane, value });
  }, []);

  return { conversationPushes, setConversationPushes, onConversationWatch, chatOutputRef, onTerminalOutput, chatSent, setChatSent, chatUnsent, setChatUnsent, chatMetadata, redrawGreeting, onChatRead, greetingRoom, setGreetingRoom, greetingRef, chatPrompt, promptRefresh, setPromptRefresh, chatSuggestion, chatRestored, pendingAnswer, setPendingAnswer, promptDock, setPromptDock, onPromptAnswered, clearPendingAnswer, onChatPrompt, onChatMetadata, onChatSuggestion, onChatRestored };
}
