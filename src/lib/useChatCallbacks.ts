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
  const chatOutputRef = useRef<(() => void) | null>(null);
  const onTerminalOutput = useCallback((listener: (() => void) | null) => {
    chatOutputRef.current = listener;
  }, []);
  const [chatSent, setChatSent] = useState(0);
  const [chatUnsent, setChatUnsent] = useState(0);
  const [chatMetadata, setChatMetadata] = useState<{ pane: string; value: ConversationMetadata | null } | null>(null);
  const [, redrawGreeting] = useReducer((count: number) => count + 1, 0);
  const onChatRead = useCallback((pane: string, read: ChatRead | null) => {
    if (read !== null) {
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
  const [greetingRoom, setGreetingRoom] = useState(true);
  const greetingRef = useRef<HTMLDivElement | null>(null);
  const [chatPrompt, setChatPrompt] = useState<{ pane: string; value: InteractivePrompt; answered: boolean } | null>(null);
  const [promptRefresh, setPromptRefresh] = useState(0);
  const [chatSuggestion, setChatSuggestion] = useState<{ pane: string; value: string } | null>(null);
  const onChatSuggestion = useCallback((pane: string, value: string | null) => {
    setChatSuggestion((current) => value !== null
      ? (current?.pane === pane && current.value === value ? current : { pane, value })
      : current?.pane === pane ? null : current);
  }, []);
  const [chatRestored, setChatRestored] = useState<{ pane: string; value: string } | null>(null);
  const onChatRestored = useCallback((pane: string, value: string | null) => {
    setChatRestored((current) => value !== null
      ? (current?.pane === pane && current.value === value ? current : { pane, value })
      : current?.pane === pane ? null : current);
  }, []);
  const [pendingAnswer, setPendingAnswer] = useState<{ pane: string; promptId: string; answer: TypedAnswer } | null>(null);
  const [promptDock, setPromptDock] = useState<HTMLDivElement | null>(null);
  const onPromptAnswered = useCallback((toMessageBox: boolean) => {
    if (activeRef.current && toMessageBox && (chatViewRef.current || !findOpenRef.current)) stackRef.current?.querySelector<HTMLTextAreaElement>(".composer-text")?.focus({ preventScroll: true });
  }, []);
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
    setChatMetadata((previous) => previous?.pane === pane && previous.value?.model === value?.model
      && previous.value?.reasoning_effort === value?.reasoning_effort
      && previous.value?.provider === value?.provider
      && previous.value?.permission_mode === value?.permission_mode
      && previous.value?.context?.used === value?.context?.used
      && previous.value?.context?.window === value?.context?.window ? previous : { pane, value });
  }, []);

  return { conversationPushes, setConversationPushes, onConversationWatch, chatOutputRef, onTerminalOutput, chatSent, setChatSent, chatUnsent, setChatUnsent, chatMetadata, redrawGreeting, onChatRead, greetingRoom, setGreetingRoom, greetingRef, chatPrompt, promptRefresh, setPromptRefresh, chatSuggestion, chatRestored, pendingAnswer, setPendingAnswer, promptDock, setPromptDock, onPromptAnswered, clearPendingAnswer, onChatPrompt, onChatMetadata, onChatSuggestion, onChatRestored };
}
