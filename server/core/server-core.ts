import type { WebSocketHandler } from "bun";
import type { PaneContext, SessionSnapshot } from "../../shared/protocol.ts";
import type { DeviceStore } from "../devices.ts";
import type { AcpChildren } from "../acp/children.ts";
import { acpPrompt } from "../approvals/acp.ts";
import { ping } from "../herdr/client.ts";
import { capabilities } from "../runtime/capabilities.ts";
import type { PreferenceStore } from "../preferences.ts";
import { type OmpLookups, OpenCodePromptState, shownPromptText } from "../prompt.ts";
import { attachableIdentity, sidecarAvailable } from "../pty/sidecar.ts";
import type { UsageLoginService } from "../usage-login.ts";
import type { UsageService } from "../usage.ts";
import { claudeBoxReads, createSubmitText } from "./composer.ts";
import { claudeInputEmpty } from "../claude-input.ts";
import { type Client, createConnections, send, type SocketData } from "./connections.ts";
import { createInputLane } from "./input.ts";
import { createPendingDelivery } from "./pending.ts";
import { createPromptWatch } from "./prompt-watch.ts";
import { createSocket } from "./socket.ts";
import { createStatusHub } from "./status.ts";
import { ATTACH_HELD_RETRY_MS, ATTACH_HOLD_MS, ATTACH_RELOOKUP_FOR_MS, ATTACH_RETRY_FOR_MS } from "./terminal-process.ts";
import { createTerminalRegistry } from "./terminals.ts";

type CoreOptions = Parameters<typeof createTerminalRegistry>[0]["options"] & Parameters<typeof createSubmitText>[0]["options"]
  & Parameters<typeof createPendingDelivery>[0]["options"] & Parameters<typeof createStatusHub>[0]["options"] & {
    acp?: AcpChildren | null;
    terminalAttach?: boolean | (() => Promise<boolean>);
    sidecar?: boolean | (() => boolean);
    attachRetryForMs?: number;
    attachHeldRetryMs?: number;
    attachRelookupForMs?: number;
    attachHoldMs?: number;
    accountOpensAll?: boolean;
  };

export function createCore({ options, devices, preferences, usage, usageLogin, browserSnapshot, TYPED_SETTLE_MS, KEY_SETTLE_MS, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS }: {
  options: CoreOptions;
  devices: DeviceStore;
  preferences: PreferenceStore;
  usage: UsageService;
  usageLogin: UsageLoginService;
  /** a snapshot as a browser's /ws is told it (server/herdr-sidebar.ts snapshotWithoutHiddenTokens); a bridge connection gets it whole */
  browserSnapshot: (snapshot: SessionSnapshot) => SessionSnapshot;
  TYPED_SETTLE_MS: number;
  KEY_SETTLE_MS: number;
  SUBMIT_DEADLINE_MS: number;
  SUBMIT_DELAY_MS: number;
  DRAFT_CLEAR_WAIT_MS: number;
  DRAFT_CLEAR_POLL_MS: number;
}) {
  const sidecar = typeof options.sidecar === "function" ? options.sidecar() : options.sidecar ?? (options.terminalAttach === undefined ? sidecarAvailable() : options.terminalAttach !== false);
  let terminalAttachKnown: boolean | null = typeof options.terminalAttach === "boolean" ? options.terminalAttach : null;
  const terminalAttach = async (): Promise<boolean> => {
    if (terminalAttachKnown === null) {
      terminalAttachKnown = typeof options.terminalAttach === "function" ? await options.terminalAttach() : attachableIdentity(await ping(), sidecar).terminal_attach !== false;
    }
    return terminalAttachKnown;
  };
  const retryFor = options.attachRetryForMs ?? ATTACH_RETRY_FOR_MS;
  const heldRetry = options.attachHeldRetryMs ?? ATTACH_HELD_RETRY_MS;
  const relookupFor = options.attachRelookupForMs ?? ATTACH_RELOOKUP_FOR_MS;
  const holdFor = options.attachHoldMs ?? ATTACH_HOLD_MS;
  const clients = new Set<Client>();
  const present = new Set<Client>();
  let stopped = false;
  const { attachments, conversations, notifyConversation, reconcileOutput, closeAttachments, paneMoved, detachClaimed, dropClaims, sight, poke, drainOutput, terminalFrames } = createTerminalRegistry({ options, clients, stopped: () => stopped, terminalAttach, holdFor, heldRetry, retryFor, relookupFor, holdPending: (owner, paneId) => holdPending(owner, paneId), holdPendingPane: (paneId, fault) => holdPendingPane(paneId, fault), attached: (client, paneId) => attached(client, paneId), transcriptChanged: async (paneId) => { await Promise.all([reconcilePiDeliveries(paneId), reconcileCodexDeliveries(paneId)]); }, inputReady: (paneId) => drainPending(paneId), end: (client, reason) => end(client, reason) });

  const { serialize, settleAfterTyping, lastTyped, typedInto, inputFrames } = createInputLane({ TYPED_SETTLE_MS, KEY_SETTLE_MS, clients, acp: options.acp, sight, poke, terminalAttach, terminalAttachKnown: () => terminalAttachKnown, mayType: (client) => mayType(client), authorizeSocket: (client) => authorizeSocket(client) });

  const submitText = createSubmitText({ options, lastTyped, attachments, terminalAttach, SUBMIT_DEADLINE_MS, TYPED_SETTLE_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS, SUBMIT_DELAY_MS });

  const { pending, holdPending, holdPendingPane, movePendingPane, drainPending, pendingFrames, queueFirstMessage, askFirstMessage, attached, closeConnection, reconcilePiDeliveries, reconcileCodexDeliveries } = createPendingDelivery({ options, clients, attachments, sight, serialize, lastTyped, typedInto, submitText, authorizeSocket: (client) => authorizeSocket(client), clientSnapshot: () => deliverySnapshot(), omo: { sessionOf: (paneId) => omo.sessionOf(paneId) }, queueHeld: (paneId, fresh) => queueHeld(paneId, fresh), SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, TYPED_SETTLE_MS });

  const watchedOpenCode = new OpenCodePromptState();
  const watchedOmp: OmpLookups = new Map();
  const promptWatch = createPromptWatch({ clients, read: async (pane, panes) => {
    const child = options.acp?.forPane(pane.pane_id);
    return child ? acpPrompt(child)?.id ?? null : shownPromptText(pane, panes, { codexHome: options.codexHome, openCodeStateDir: options.openCodeStateDir, openCodeState: watchedOpenCode, ompLookups: watchedOmp, answers: options.openCodeState });
  } });

  const stopAcp = options.acp?.onStatus(child => {
    if (child.client.status === "unknown") holdPendingPane(child.terminal, { code: "input_not_ready", message: "The ACP connection changed; review the pending message before sending" });
  });
  const { mayType, authorizeSocket, admit, setRole, watchPane, unwatchPane, killWatches, end } = createConnections({ clients, present, pending: { close: closeConnection }, devices, detachClaimed,
    dropClaims: (client) => { dropClaims(client); promptWatch.drop(client); } });
  const { push, alertWebhook, omo, gjc, letta, claudeAgents, opencodeAgents, plans, clientSnapshot, deliverySnapshot, currentHerdrLifetime, queueHeld, countVisit, machines, broadcastAll, logPushError, collector, waitTimer, hookTurn, contextChanged } = createStatusHub({ options, devices, preferences, clients, present, pending, drainPending, holdPendingPane, usage, usageLogin,
    // the messages first: the old ID's terminal closing holds what it still leases
    paneMoved: (from, to) => { movePendingPane(from, to); paneMoved(from, to); } });
  const socketHandlers = createSocket({
    herdrFailure: options.herdrFailure,
    accountEnabled: options.accountOpensAll,
    clients, present, stopped: () => stopped, admit, setRole, watchable: () => capabilities().attach === "pty-cli", terminalHistory: () => capabilities().attach !== "pty-cli", terminalModes: () => capabilities().attach === "hc", watchPane, unwatchPane, end, holdPending, attachments, clientSnapshot, herdrLifetime: currentHerdrLifetime, browserSnapshot, countVisit, drainOutput,
    notices: { replay: (deviceId) => devices.noticeReplay(deviceId), seen: (deviceId, seq) => devices.noticeSeen(deviceId, seq), block: (record, onApplied) => devices.applyBlock(record, "session", onApplied), open: id => devices.openNotices().find(n => n.id === id), mayAnswer: (caller, id) => devices.mayAnswerNotice(caller, id), decide: (id, replay) => devices.decideNotice(id, replay), itsMe: (deviceId, id, provedKey) => devices.itsMe(deviceId, id, provedKey) },
    // each frame type by name, with the handler of the module that owns it: anything else on a frame object never
    // becomes a frame a client can send, and a type named twice fails the build instead of replacing a handler
    frames: {
      attach: terminalFrames.attach,
      "take-over": terminalFrames["take-over"],
      detach: terminalFrames.detach,
      "conversation-watch": terminalFrames["conversation-watch"],
      "prompt-watch": promptWatch.frames["prompt-watch"],
      "pty-ack": terminalFrames["pty-ack"],
      resize: terminalFrames.resize,
      "release-size": terminalFrames["release-size"],
      input: inputFrames.input,
      keys: inputFrames.keys,
      secret: inputFrames.secret,
      insert: inputFrames.insert,
      submit: pendingFrames.submit,
      "pending-action": pendingFrames["pending-action"],
    },
  });
  // a journal entry goes at once to each connected row it concerns (P10); one not connected hears it at its next connect
  devices.onNotice((entry) => {
    for (const client of clients) {
      const notice = client.data.deviceId === undefined ? null : devices.noticeFor(client.data.deviceId, entry);
      if (notice) send(client, { type: "device-notice", notice });
    }
  });
  const websocket: WebSocketHandler<SocketData> = {
    ...socketHandlers,
    open: (ws) => socketHandlers.open(ws),
    message: (ws, message) => socketHandlers.message(ws, message),
    close: (ws, code, reason) => socketHandlers.close(ws, code, reason),
    drain: (ws) => socketHandlers.drain(ws),
  };
  let outputTimer: ReturnType<typeof setInterval> | undefined;

  return {
    sidecar, serialize, settleAfterTyping, push, alertWebhook, logPushError, omo, claudeAgents, opencodeAgents, plans, clientSnapshot, machines, broadcastAll, collector, websocket, queueFirstMessage, askFirstMessage, hookTurn,
    hookContextChanged(paneId: string, context: PaneContext | null): void {
      contextChanged(paneId, context);
      // A model's window or its live token count can change without a transcript append.
      notifyConversation(paneId, context === null ? "context:unknown" : `context:${context.used}:${context.window}`);
    },
    holdsPending: (paneId: string): boolean => pending.holds(paneId),
    inputEmpty: async (paneId: string, agent: string): Promise<boolean | null> => {
      if (agent !== "claude") return null;
      try { return claudeInputEmpty(...await claudeBoxReads(paneId)); } catch { return false; }
    },
    socketHandlers,
    start(): void {
      // ACKs can stop arriving entirely (a suspended tab). Bound the pause even then.
      outputTimer = setInterval(() => {
        for (const paneId of pending.expire()) drainPending(paneId);
        for (const paneId of attachments.keys()) reconcileOutput(paneId);
      }, 100);
      outputTimer.unref();
    },
    stop(beforeTerminals: () => void): Promise<void> | undefined {
      stopped = true;
      stopAcp?.();
      conversations.stop();
      promptWatch.stop();
      clearInterval(outputTimer);
      collector.stop();
      omo.stop();
      gjc.stop();
      letta.stop();
      claudeAgents.stop();
      opencodeAgents.stop();
      clearInterval(waitTimer);
      plans.stop();
      const stoppingMachines = machines?.stop();
      beforeTerminals();
      for (const client of clients) killWatches(client);
      closeAttachments();
      return stoppingMachines;
    },
  };
}
