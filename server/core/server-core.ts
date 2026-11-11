/**
 * The core of the server: the terminals, input, pending messages and status of every browser connection,
 * and the WebSocket that carries them. createServer serves HTTP around it (server/index.ts), and reaches it
 * only through server/core/index.ts.
 *
 * Each part is made after the parts it uses, so the order is: the terminal registry, the input lane, the
 * composer, the pending messages, the connections, then the status hub, which opens the collector and then
 * starts OmO, gjc, Claude's agents and plans; last the socket that hands each frame to its owner. A part that
 * calls one made after it gets a same-named wrapper (`end`, `holdPending`, `authorizeSocket`, …). The server
 * listens once this returns, and calls `start` after that.
 */
import type { WebSocketHandler } from "bun";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import type { DeviceStore } from "../devices.ts";
import { ping } from "../herdr/client.ts";
import { capabilities } from "../runtime/capabilities.ts";
import type { PreferenceStore } from "../preferences.ts";
import { type OmpLookups, OpenCodePromptState, shownPromptText } from "../prompt.ts";
import { attachableIdentity, sidecarAvailable } from "../pty/sidecar.ts";
import type { UsageLoginService } from "../usage-login.ts";
import type { UsageService } from "../usage.ts";
import { claudeBoxReads, createSubmitText } from "./composer.ts";
import { claudeInputEmpty } from "../claude-input.ts";
import { type Client, createConnections, type SocketData } from "./connections.ts";
import { createInputLane } from "./input.ts";
import { createPendingDelivery } from "./pending.ts";
import { createPromptWatch } from "./prompt-watch.ts";
import { createSocket } from "./socket.ts";
import { createStatusHub } from "./status.ts";
import { ATTACH_HELD_RETRY_MS, ATTACH_HOLD_MS, ATTACH_RELOOKUP_FOR_MS, ATTACH_RETRY_FOR_MS } from "./terminal-process.ts";
import { createTerminalRegistry } from "./terminals.ts";

/** What the core reads of createServer's options (their meaning is told there). */
type CoreOptions = Parameters<typeof createTerminalRegistry>[0]["options"] & Parameters<typeof createSubmitText>[0]["options"]
  & Parameters<typeof createPendingDelivery>[0]["options"] & Parameters<typeof createStatusHub>[0]["options"] & {
    terminalAttach?: boolean | (() => Promise<boolean>);
    sidecar?: boolean | (() => boolean);
    attachRetryForMs?: number;
    attachHeldRetryMs?: number;
    attachRelookupForMs?: number;
    attachHoldMs?: number;
  };

export function createCore({ options, devices, preferences, usage, usageLogin, browserSnapshot, TYPED_SETTLE_MS, KEY_SETTLE_MS, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS }: {
  options: CoreOptions;
  devices: DeviceStore;
  /** the shared preferences (server/preferences.ts): the status hub's web push reads the muted panes from it */
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
  /** whether this bridge can `terminal attach`: herdr is asked once, and the PTY sidecar has to be runnable here (server/pty/sidecar.ts) */
  /** whether the sidecar can run, settled as the server starts so that attach, /api/health and /api/bridge tell one answer; a forced answer (tests) stands in for it */
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
  /** connections whose page is in use (`presence`), relayed ones included: while any is, no web push goes out */
  const present = new Set<Client>();
  let stopped = false;
  const { attachments, conversations, reconcileOutput, closeAttachment, paneMoved, detachClaimed, dropClaims, sight, poke, drainOutput, terminalFrames } = createTerminalRegistry({ options, clients, stopped: () => stopped, terminalAttach, holdFor, heldRetry, retryFor, relookupFor, holdPending: (owner, paneId) => holdPending(owner, paneId), holdPendingPane: (paneId, fault) => holdPendingPane(paneId, fault), attached: (client, paneId) => attached(client, paneId), transcriptChanged: (paneId) => reconcilePiDeliveries(paneId), inputReady: (paneId) => drainPending(paneId), end: (client, reason) => end(client, reason) });

  const { serialize, settleAfterTyping, lastTyped, typedInto, inputFrames } = createInputLane({ TYPED_SETTLE_MS, KEY_SETTLE_MS, clients, sight, poke, terminalAttach, terminalAttachKnown: () => terminalAttachKnown, mayType: (client) => mayType(client), authorizeSocket: (client) => authorizeSocket(client) });

  const submitText = createSubmitText({ options, lastTyped, attachments, terminalAttach, SUBMIT_DEADLINE_MS, TYPED_SETTLE_MS, DRAFT_CLEAR_WAIT_MS, DRAFT_CLEAR_POLL_MS, SUBMIT_DELAY_MS });

  const { pending, holdPending, holdPendingPane, movePendingPane, drainPending, pendingFrames, queueFirstMessage, attached, closeConnection, reconcilePiDeliveries } = createPendingDelivery({ options, clients, attachments, sight, serialize, lastTyped, typedInto, submitText, authorizeSocket: (client) => authorizeSocket(client), clientSnapshot: () => clientSnapshot(), omo: { sessionOf: (paneId) => omo.sessionOf(paneId) }, queueHeld: (paneId, fresh) => queueHeld(paneId, fresh), SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, TYPED_SETTLE_MS });

  // the watches read OpenCode's forms and omp's sessions into a state of their own: the route's entries, drafts and
  // lookups are its answers' (the route's drafts are only read, for the step an answer moved its card to)
  const watchedOpenCode = new OpenCodePromptState();
  const watchedOmp: OmpLookups = new Map();
  const promptWatch = createPromptWatch({ clients, read: (pane, panes) => shownPromptText(pane, panes, { codexHome: options.codexHome, openCodeStateDir: options.openCodeStateDir, openCodeState: watchedOpenCode, ompLookups: watchedOmp, answers: options.openCodeState }) });

  const { mayType, authorizeSocket, admit, setRole, watchPane, unwatchPane, killWatches, end } = createConnections({ clients, present, pending: { close: closeConnection }, devices, detachClaimed,
    dropClaims: (client) => { dropClaims(client); promptWatch.drop(client); } });
  const { push, alertWebhook, omo, gjc, letta, claudeAgents, opencodeAgents, plans, clientSnapshot, currentHerdrLifetime, queueHeld, countVisit, machines, broadcastAll, logPushError, collector, waitTimer } = createStatusHub({ options, devices, preferences, clients, present, pending, drainPending, holdPendingPane, usage, usageLogin,
    // the messages first: the old ID's terminal closing holds what it still leases
    paneMoved: (from, to) => { movePendingPane(from, to); paneMoved(from, to); } });
  const socketHandlers = createSocket({
    clients, present, stopped: () => stopped, admit, setRole, watchable: () => capabilities().attach === "pty-cli", terminalHistory: () => capabilities().attach !== "pty-cli", watchPane, unwatchPane, end, holdPending, attachments, clientSnapshot, herdrLifetime: currentHerdrLifetime, browserSnapshot, countVisit, drainOutput,
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
  const websocket: WebSocketHandler<SocketData> = {
    ...socketHandlers,
    open: (ws) => socketHandlers.open(ws),
    message: (ws, message) => socketHandlers.message(ws, message),
    close: (ws, code, reason) => socketHandlers.close(ws, code, reason),
    drain: (ws) => socketHandlers.drain(ws),
  };
  let outputTimer: ReturnType<typeof setInterval> | undefined;

  return {
    sidecar, serialize, settleAfterTyping, push, alertWebhook, logPushError, omo, claudeAgents, opencodeAgents, plans, clientSnapshot, machines, broadcastAll, collector, websocket, queueFirstMessage,
    /** a message someone sent through Ovis still waits for the pane (runtime-move.ts) */
    holdsPending: (paneId: string): boolean => pending.holds(paneId),
    /** true: Claude Code's input box reads empty; false: text is in it or it cannot be read whole; null: an agent whose box Ovis cannot read */
    inputEmpty: async (paneId: string, agent: string): Promise<boolean | null> => {
      if (agent !== "claude") return null;
      try { return claudeInputEmpty(...await claudeBoxReads(paneId)); } catch { return false; }
    },
    // The relay uses these same handlers with a SocketLike; websocket above remains Bun's boundary.
    socketHandlers,
    /** once the server listens */
    start(): void {
      // ACKs can stop arriving entirely (a suspended tab). Bound the pause even then.
      outputTimer = setInterval(() => {
        pending.expire();
        for (const paneId of attachments.keys()) reconcileOutput(paneId);
      }, 100);
      outputTimer.unref();
    },
    /** `beforeTerminals` runs once the services are stopped and before the terminals close */
    stop(beforeTerminals: () => void): void {
      stopped = true;
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
      machines?.stop();
      beforeTerminals();
      for (const client of clients) killWatches(client);
      for (const paneId of [...attachments.keys()]) closeAttachment(paneId);
    },
  };
}
