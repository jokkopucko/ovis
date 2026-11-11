/**
 * Messages a connection sends to wait for the agent: queued for its next turn, or held for the
 * sender's Send now. Each carries a lease on the pane's terminal and on the sender's authority,
 * checked again before every write, so a message is typed only into the attach it was sent from
 * while that connection may still type. A turn's end sends the pane's next message; losing the
 * lease holds it for the sender to review instead of sending it.
 *
 * A create request's first message (POST /api/workspace/create and /api/tab/create `first_message`)
 * is listed by the bridge (FIRST_MESSAGE_OWNER), so every connection attached to the pane sees it among
 * its pending messages and may discard or send it now; one pane holds one. It is typed on its own only
 * through the page connection that sent the request (`first_message_connection`), while that connection
 * has the pane attached, with the same checks as its own queued messages. Once that connection closes
 * or leaves the pane before it went, or when the request named none, it is held: nothing the user typed
 * goes automatically after a disconnect, another device attaching later never types it on its own, and
 * the pane's other messages are not left behind it. It is bound to the agent the launch brought up: the
 * process and session in front when it is queued, and what herdr says of that agent at each event of the
 * pane after, so another session or process of the same kind gets none.
 * First messages live in memory: a restart of the bridge loses those not sent yet.
 */
import { closeBackslash, closeMention, type createSubmitText, freeClaudeBox, freeHermesInput, InputDraftError, modelSwitchText, OMP_REPORT_POLL_MS, OMP_STARTUP_MS, ompStartingUntil, pendingFault, pendingIdentity, pendingText, submitFraming, untilOmpReported } from "./composer.ts";
import { type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE } from "./terminal-process.ts";
import type { AttachmentView, TerminalSighting } from "./terminals.ts";
import type { ClientMessage, HerdrPane, PendingMessage, PendingRemoval, SessionSnapshot } from "../../shared/protocol.ts";
import { typingGuards } from "../input-guard.ts";
import { claudeForegroundSession, isClaudeProcess } from "../claude-store.ts";
import { HerdrError, paneGet, paneProcessInfo, paneRead, paneSendKeys, paneSendText, type ProcessInfo } from "../herdr/client.ts";
import { bindCommandProcess, claudeHeldIsGrey, codexQuestionsCollapsed, isClaudeHeld, heldCandidate, noteSubmitted, parseInteractivePrompt, piRunsCommand, piListsTemplate, prepareCommandSend, shownInputBox } from "../prompt.ts";
import { registry } from "../dialogs/registry.ts";
import { codexOwnScreenOpen, CODEX_OWN_SCREEN_MESSAGE } from "../dialogs/codex.ts";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { PendingInputs, samePendingIdentity, type PendingIdentity, type PendingRecord } from "../pending-input.ts";
import { NO_AGENT_MESSAGE, PASTED_NOT_SENT_MESSAGE, submitNotTyped } from "../../shared/submit-outcome.ts";
import { processStartedAtAsync } from "../process-start.ts";
import { agentProcessInFront } from "../agent-process.ts";
import { agentProcesses } from "../conversation.ts";
import { isShellAgentKind, SHELL_AGENTS } from "../shell-agent.ts";
import { capturePiDeliveryAnchorRetrying, matchPiDeliveries, PiReceiptCapacity, piRecordText, type PiDeliveryAnchor, type PiReceiptReservation } from "../pi-delivery.ts";
import { isPiProcess, piTranscriptPath, piUnwrittenHeaderId } from "../pi.ts";
import { PendingRequestBook } from "../pending-requests.ts";
import { interruptCodexSteering } from "../codex-steering.ts";
import type { OmoStatus } from "../omo-status.ts";
import { heldOmoProcess } from "../omo.ts";
import { startOpenCodeWatch, openCodeSkillsToType, type OpenCodeWatch, skillsNotAttached } from "../opencode-native.ts";
import { herdrSkillAttachIo, type PromptPiece, typeWithSkills } from "../opencode-skill-attach.ts";

type Frame<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

type PendingLease = { sighting: TerminalSighting; authority: object };
/** The bridge, as the owner of the first messages create requests queued for new panes' agents. */
export type FirstMessageOwner = { readonly firstMessages: true };
export const FIRST_MESSAGE_OWNER: FirstMessageOwner = { firstMessages: true };
export type PendingOwner = Client | FirstMessageOwner;
const isClient = (owner: PendingOwner): owner is Client => owner !== FIRST_MESSAGE_OWNER;
/** A visible screen's text without its colour and cursor escapes, as the masked-prompt check reads a screen. */
const withoutEscapes = (screen: string): string => screen.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
/** a first message's lease is the delivering connection's, taken at each attempt: none is kept on the record */
type PendingItem = PendingRecord<PendingOwner, PendingLease | null>;
/** `refusal`: a queued request's own input_draft refusal, kept for its submit-result's draft actions; never sent as is */
type SubmitReply = { ok: boolean; pending?: PendingMessage; sending_at?: string; code?: string; message?: string; refusal?: { draft: string | null; box: string | null; identity: PendingIdentity };
  /** refused for something no status event will tell the end of (CodexOwnScreenRefusal): never queued again by itself */ unannounced?: true };
/**
 * `agent_blocked` for one of Codex's own screens (dialogs/codex.ts codexOwnScreenOpen). herdr reports Codex at rest
 * under it and says nothing when it closes. So a queued message refused for it is held with this reason, for its
 * Send now: queued again it would wait with no reason shown while Codex sits idle, and go out by itself at whatever
 * status event comes next, which may be the end of a turn the user started since.
 */
class CodexOwnScreenRefusal extends HerdrError {
  constructor() { super("agent_blocked", CODEX_OWN_SCREEN_MESSAGE); }
}
/** Codex's question whether to trust the folder it was started in, by its card's title (0.167, and as older versions asked it). */
const CODEX_FOLDER_QUESTION_RE = /^(?:Trust this folder\?|Do you trust the contents)/i;
/**
 * What a screen of Codex's own that has the input (codexOwnScreenOpen) is refused as, given the card the chat reads
 * of it, if any; null when the composer has the input.
 * - A screen the user opened is not reported by herdr, and neither is its end (CodexOwnScreenRefusal): one with no
 *   card, and /model's levels, which the chat reads as a card (registry.waits).
 * - A prompt Codex asks (an approval, a question: a card) is one herdr reports, maybe a moment after the screen: the
 *   refusal of a waiting menu, after whose end a status event drains the queue again. So is anything herdr already
 *   calls blocked.
 * - The folder question is a card herdr reports on a wide pane only (blocked at 80 columns and up, at rest at 60
 *   and under, Codex 0.167 under herdr 0.9.5). Where herdr is known not to report it (`herdr` is "rest"), nothing
 *   tells its end either, and it is refused as a screen the user opened; a caller that has not read the pane's
 *   status ("unknown") leaves it to the waiting-menu refusal.
 */
function codexScreenRefusal(screen: string, card: { title: string | null } | null, herdr: "blocked" | "rest" | "unknown"): HerdrError | null {
  if (!codexOwnScreenOpen(screen)) return null;
  const waiting = (): HerdrError => new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
  if (herdr === "blocked") return waiting();
  if (card === null || registry.waits("codex", screen)) return new CodexOwnScreenRefusal();
  return herdr === "rest" && CODEX_FOLDER_QUESTION_RE.test(card.title ?? "") ? new CodexOwnScreenRefusal() : waiting();
}
type PiTypedReceipt = { owner: Client; resumeKey?: string; message: PendingMessage; match: string; template: boolean; identity: PendingIdentity; anchor: PiDeliveryAnchor | null };
/** a first message refused before anything was typed because its connection could not type it yet stays queued for its next attach or turn */
const FIRST_MESSAGE_RETRY_CODES = new Set(["input_not_ready", "pending_lease_lost", "disconnected", "read_only"]);
/** a first message whose page left before it went, or that named none: held for an explicit Send now or Discard */
const FIRST_MESSAGE_UNATTENDED = { code: "first_message_unattended", message: "The page that sent this first message is gone; send it now or discard it" };
/** a message for an agent alone (submit `agent_only`, #511) refused where no agent is in front */
const AGENT_NOT_READY = { code: "agent_not_ready", message: NO_AGENT_MESSAGE };
/**
 * An agent runs where herdr names one and its own program is in front (#511): herdr can keep naming an agent that
 * has exited, and a shell, the pane's own or one started since, is no agent for a message whose `> quote` lines it
 * would run as redirects.
 */
/** `entry` runs `agent`'s own program: its binary or a runtime running it, Claude's native build, Pi's npm entry, or a shell-started agent's own process (SHELL_AGENTS). */
function runsAgentProgram(entry: { name?: string | null; argv0?: string | null; argv?: readonly string[] | null }, agent: string | null): boolean {
  if (agent === null) return false;
  if (agentProcesses([entry], agent).length > 0) return true;
  // a shell-started agent is known by its own test (DeepSeek Harness's dsh-tui runs as node …/host-entry.js)
  if (isShellAgentKind(agent) && SHELL_AGENTS[agent]!(entry.argv ?? [])) return true;
  // Claude's native build titles itself `Claude`, or by its version on macOS (claude-store.ts)
  if (agent === "claude") return isClaudeProcess({ name: entry.name ?? undefined, argv0: entry.argv0 ?? undefined, argv: entry.argv ?? undefined });
  return agent === "pi" && isPiProcess(entry.argv ?? []);
}
/**
 * `entry` is known to run another program than `agent`'s: its argv (or argv0) shows one, or its name is a program's
 * (a child such as git, gh or security) rather than a runtime's. A listing with no argv and only a runtime's name, or
 * none, does not say what it runs.
 */
function runsOtherProgram(entry: { name?: string | null; argv0?: string | null; argv?: readonly string[] | null }, agent: string | null): boolean {
  if (runsAgentProgram(entry, agent)) return false;
  if ((entry.argv?.length ?? 0) > 0 || entry.argv0) return true;
  const name = entry.name?.trim() ?? "";
  return name !== "" && !["node", "bun", "python", "python3"].includes(name);
}
const agentRuns = (identity: PendingIdentity, recognized: boolean): boolean => identity.agent !== null && identity.processPid !== null && recognized;
/** a first message whose pane runs something other than the agent launched for it, found at a pane's event */
const TARGET_CHANGED = { code: "pending_target_changed", message: "The pane's terminal or agent session changed; review the message before sending it again" };
/** a first message whose launched agent came up and left before it went: held for an explicit Send now or Discard */
const LAUNCH_GONE = { code: "first_message_launch_ended", message: "The agent started for this message has ended; review the message before sending it" };
/** why a message that waited for a starting omp is held: its paste would follow what was typed into omp's input box meanwhile, and its Enter send both */
const TYPED_WHILE_WAITING = { code: "typed_while_waiting", message: "Something was typed in this terminal while omp was starting. Check its input line there, then send this message" };
/** receipts of first messages kept per pane, so a connection that attaches later drops a stale copy */
const FIRST_MESSAGE_RECEIPTS = 8;

/**
 * The server's pending messages. `authorizeSocket`, `clientSnapshot`, `omo` and `queueHeld` belong to the
 * connections and the status hub, which are built after this (they take its store), so they are
 * called through: only a frame or a turn calls them, after `createServer` has returned.
 */
export function createPendingDelivery({ options, clients, attachments, sight, serialize, lastTyped, typedInto = () => 0, submitText, authorizeSocket, clientSnapshot, omo, queueHeld = () => false, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, TYPED_SETTLE_MS }: {
  options: { pendingStartTimeoutMs?: number; piReceiptLimit?: number; submitDeadlineMs?: number; submitDelayMs?: number; ompReportPollMs?: number; ompStartupMs?: number; openCodeStateDir?: string };
  clients: Set<Client>;
  attachments: ReadonlyMap<string, AttachmentView>;
  sight: (client: Client, paneId: string) => TerminalSighting;
  serialize: <T>(paneId: string, task: () => T | Promise<T>) => Promise<T>;
  lastTyped: ReadonlyMap<string, number>;
  /** how many times a person's own input went to the pane (input.ts): a message that waits there asks whether any did meanwhile */
  typedInto?: (paneId: string) => number;
  submitText: ReturnType<typeof createSubmitText>;
  authorizeSocket: (client: Client) => void;
  clientSnapshot: () => Promise<SessionSnapshot>;
  omo: Pick<OmoStatus, "sessionOf">;
  /**
   * a pane shown at rest whose queue a busy signal or a turn Claude resumed by itself still holds, as the pane's
   * last poll left it (server/core/status.ts queueStatus): no automatic send. `fresh`: whether such a resumed
   * turn (a /loop wakeup, a scheduled task, a background task's notice) holds it, read from the pane's
   * transcript now (#3494)
   */
  queueHeld?: (paneId: string, fresh: boolean) => boolean;
  SUBMIT_DEADLINE_MS: number;
  SUBMIT_DELAY_MS: number;
  TYPED_SETTLE_MS: number;
}) {
  const pendingAuthorities = new WeakMap<Client, Map<string, object>>();
  const firstReceipts = new Map<string, Array<{ id: string; outcome: "sent" | "discarded" | "dismissed" }>>();
  /** the connections that could type into the pane now: attached, allowed to type, and with a ready lease */
  const typists = (paneId: string): Client[] => [...clients].filter((client) => {
    if (!client.data.attached.has(paneId)) return false;
    try { authorizeSocket(client); } catch { return false; }
    return typingGuards.pendingLease(sight(client, paneId).facts());
  });
  const pending = new PendingInputs<PendingOwner, PendingLease | null>((owner, paneId, messages, removed) => {
    if (isClient(owner)) {
      send(owner, { type: "pending-messages", pane_id: paneId, messages, ...(removed ? { removed } : {}) });
      keepReceipts(owner, paneId, messages, removed);
      return;
    }
    // a first message: every connection attached to the pane sees it, and keeps the receipt once it went
    if (removed) firstReceipts.set(paneId, [...(firstReceipts.get(paneId) ?? []), ...removed].slice(-FIRST_MESSAGE_RECEIPTS));
    for (const client of clients) {
      if (client.data.attached.has(paneId) && connectionOf(client).mode !== "observe") send(client, { type: "pending-messages", pane_id: paneId, messages, ...(removed ? { removed } : {}) });
    }
  }, Date.now, options.pendingStartTimeoutMs, undefined, (owner) => !isClient(owner));
  let nextFirstRequestId = -1;
  /** first messages still learning the agent launched for them (queueFirstMessage, learnLaunched) */
  const launchBound = new WeakSet<PendingItem>();
  /** the process name of the agent a launch-bound first message is bound to, read while it runs in front: an agent exec'd at the shell's pid keeps it */
  const launchedNames = new WeakMap<PendingItem, string>();
  /** the name one process read gives the foreground process `pid` */
  const processName = (processes: ProcessInfo | undefined, pid: number | null | undefined): string | undefined =>
    pid == null ? undefined : processes?.foreground_processes?.find((entry) => entry.pid === pid)?.name;
  /**
   * The pane's launch-bound first messages that are checked at its events: a queued one, and a held one
   * until it is held for its launched agent having left (first_message_launch_ended) or been replaced
   * (pending_target_changed), the reason its card then gives; past that it reads the pane no more until its
   * Send now (bindLaunched).
   */
  const launchBoundIn = (paneId: string): PendingItem[] => pending.list(FIRST_MESSAGE_OWNER, paneId)
    .map((message) => pending.get(FIRST_MESSAGE_OWNER, paneId, message.id))
    .filter((item): item is PendingItem => item !== undefined && launchBound.has(item)
      && (item.message.state === "queued" || (item.message.state === "held" && item.message.error?.code !== TARGET_CHANGED.code && item.message.error?.code !== LAUNCH_GONE.code)));
  /** A first message held for `fault`: a queued one is held, a held one takes it as its reason. */
  const holdFor = (item: PendingItem, fault: { code: string; message: string }): void => {
    if (item.message.state === "held") pending.rehold(item, fault);
    else pending.holdItem(item, fault);
  };
  /** the page connection that sent each first message: the only one that types it on its own */
  const requesters = new WeakMap<PendingItem, Client>();
  const requested = new WeakMap<Client, Set<PendingItem>>();
  const present = (client: Client): boolean => clients.has(client) && !connectionOf(client).closing;
  const pendingDrains = new Set<string>();
  const pendingRequests = new WeakMap<Client, PendingRequestBook<SubmitReply>>();
  // the last input_draft refusal per pane: its named draft (Clear it and send), or none (Send anyway)
  const draftConfirmations = new WeakMap<Client, Map<string, { draft: string | null; identity: PendingIdentity; box?: string | null }>>();

  /** Ovis-origin text whose Enter reached Pi but whose durable user record has not appeared yet. */
  const piTyped = new Map<string, PiTypedReceipt[]>();
  // Presentation only, bound to both the authenticated device and an opaque browser
  // correlator. Retaining a receipt never retains permission to send input.
  const PI_RESUME_MS = 10 * 60 * 1000, PI_RESUME_LIMIT = 1024;
  const livePiOwner = (owner: Client): boolean => clients.has(owner) && !connectionOf(owner).closing;
  const piCompleted: Array<{ paneId: string; key: string; id: string; at: number }> = [];
  /** a follow-up's sent, discarded or held receipt, kept for its browser's return (#2421): the same bounds and binding as Pi's */
  /**
   * `uncertain`: a Send now of the copy that may have typed it (its Enter was not confirmed). Like `sent` it answers a
   * later resend of the ID, with "not confirmed", and it is never told to a browser as a receipt.
   * `at` is on `elapsed`, a clock that only moves forward: a PC clock set forward must not end a receipt before the
   * proof a page counts on its own clock, and one set back must not stretch it.
   */
  const completed: Array<{ paneId: string; key: string; id: string; outcome: "sent" | "discarded" | "held" | "uncertain" | "sending"; at: number; /** a resend's text, when one sent it */ hash?: string;
    /** a `sending` claim whose pane ended while its send was on its way: its held receipt is not put back */ gone?: true }> = [];
  const elapsed = (): number => performance.now();
  /**
   * When each pane that ended did so (the PC's clock, as a follow-up's `created_at`), by its ID, the latest thousand.
   * herdr may give the ID to another pane: a follow-up taken before that time was written for the pane that ended,
   * and gets no held receipt (keepReceipts), so no browser is offered it with Send now for the pane that has the ID next.
   */
  const endedPanes = new Map<string, number>();
  /** the resume key each follow-up's browser had when the bridge took it, by connection and message id */
  const receiptKeys = new WeakMap<Client, Map<string, string>>();
  const resumeKey = (client: Client, paneId: string): string | undefined => {
    const id = client.data.attached.get(paneId)?.receiptResumeId;
    return id ? JSON.stringify([client.data.deviceId ?? null, id]) : undefined;
  };
  const prunePi = (): void => {
    const cutoff = Date.now() - PI_RESUME_MS;
    while (piCompleted.length && (piCompleted[0]!.at < cutoff || piCompleted.length > PI_RESUME_LIMIT)) piCompleted.shift();
    // A receipt past its window goes, whatever it is. The limit counts held and discarded receipts alone, and past
    // it the oldest of those goes: a held copy that is no longer told, or a discarded one that stays unconfirmed,
    // loses nothing that was typed. A sent or uncertain one stays its whole window (their number is bounded by the
    // sends a pane takes in ten minutes). It is what answers a resend of that ID once its resend record (a minute)
    // is gone, and every held receipt issued for the ID came before the send, so it ends before this does: a tab
    // that still holds its copy on one never types what another tab already sent, or may have sent.
    const ended = elapsed() - PI_RESUME_MS;
    for (let at = 0; at < completed.length && completed[at]!.at < ended;) {
      // a claim lasts as long as its send, whatever that takes
      if (completed[at]!.outcome === "sending") at++; else completed.splice(at, 1);
    }
    const counted = (entry: (typeof completed)[number]): boolean => entry.outcome === "held" || entry.outcome === "discarded";
    for (let over = completed.filter(counted).length - PI_RESUME_LIMIT; over > 0; over--) completed.splice(completed.findIndex(counted), 1);
    let count = 0;
    for (const [paneId, items] of piTyped) {
      const kept = items.filter((item) => {
        if (!livePiOwner(item.owner) && (Date.parse(item.message.created_at) < cutoff || ++count > PI_RESUME_LIMIT)) {
          releasePiSlot(item); return false;
        }
        return true;
      });
      if (kept.length) piTyped.set(paneId, kept); else piTyped.delete(paneId);
      if (!kept.some((item) => item.message.error?.code === "pi_transcript_pending")) piConsumed.delete(paneId);
    }
  };
  /** Shared by every owner until the pane has no receipt that could reuse an earlier append. */
  const piConsumed = new Map<string, Set<string>>();
  const piCapacity = new PiReceiptCapacity<Client>(options.piReceiptLimit ?? 256);
  /** A receipt's identity is its slot token; invalidation and late confirmation cannot release it twice. */
  const piSlots = new WeakSet<PiTypedReceipt>();
  const releasePiSlot = (item: PiTypedReceipt): void => {
    if (piSlots.delete(item)) piCapacity.remove(item.owner);
  };
  const activePiReceipt = (paneId: string, item: PiTypedReceipt): boolean =>
    item.message.error?.code === "pi_transcript_pending" && piSlots.has(item) && piTyped.get(paneId)?.includes(item) === true;
  const reservePiReceipt = (owner: Client, identity: PendingIdentity): PiReceiptReservation<Client> | null => {
    if (identity.agent !== "pi") return null;
    const reservation = piCapacity.reserve(owner);
    if (reservation === null) throw new HerdrError("pending_limit", "Too many Pi transcript receipts are still waiting; dismiss one before sending more");
    return reservation;
  };
  const piReceiptText = (identity: PendingIdentity, text: string): string | undefined => {
    if (identity.agent !== "pi") return undefined;
    try { return closeMention(pendingText(modelSwitchText(identity.agent, text))); }
    catch { return undefined; }
  };
  const piMessages = (paneId: string, owner: Client): PendingMessage[] => (piTyped.get(paneId) ?? [])
    .filter((item) => item.owner === owner)
    .map((item) => ({ ...item.message, ...(item.message.error ? { error: { ...item.message.error } } : {}) }));
  const publishPi = (paneId: string, removed?: Array<{ owner: Client; id: string; outcome: "consumed" | "discarded" }>): void => {
    const owners = new Set((piTyped.get(paneId) ?? []).map((item) => item.owner));
    for (const item of removed ?? []) owners.add(item.owner);
    for (const owner of owners) {
      if (!clients.has(owner) || !owner.data.attached.has(paneId) || connectionOf(owner).mode === "observe") continue;
      const ownRemoved = removed?.filter((item) => item.owner === owner).map(({ id, outcome }) => ({ id, outcome }));
      send(owner, { type: "pending-messages", pane_id: paneId, messages: piMessages(paneId, owner), ...(ownRemoved?.length ? { removed: ownRemoved } : {}) });
    }
  };
  const preparePiReceipt = async (paneId: string, identity: PendingIdentity): Promise<PiDeliveryAnchor | null | undefined> => {
    if (identity.agent !== "pi") return undefined;
    const found = await piTranscriptPath(paneId).catch(() => null);
    if (found === null) return null;
    const path = "unwritten" in found ? found.unwritten.path : found.path;
    if (!("unwritten" in found)) return capturePiDeliveryAnchorRetrying(path);
    // Pi 1.3 names a prospective file `<UTC timestamp>_<session UUID>.jsonl`; its header
    // carries only that UUID. Anything outside the exact contract is confirmation-unavailable.
    const expected = piUnwrittenHeaderId(path);
    return expected === null ? null : capturePiDeliveryAnchorRetrying(path, true, expected);
  };
  const recordPiTyped = (owner: Client, paneId: string, requestId: number, text: string, identity: PendingIdentity, anchor: PiDeliveryAnchor | null | undefined,
    reservation?: PiReceiptReservation<Client> | null, template = false): void => {
    if (anchor === undefined || !clients.has(owner) || connectionOf(owner).closing) return;
    if (anchor === null) piCapacity.release(reservation);
    else if (!piCapacity.retain(owner, reservation)) return;
    prunePi();
    const receipt: PiTypedReceipt = {
      owner, resumeKey: resumeKey(owner, paneId), identity: { ...identity }, anchor,
      // Pi expands pasted tabs and trims its record, including closeMention's space (#2454).
      // Keep that matching value separate from the saved copy of the text sent.
      match: piRecordText(text), template,
      message: { id: `pi:${crypto.randomUUID()}`, request_id: requestId, text, state: "uncertain", created_at: new Date().toISOString(),
        error: anchor === null
          ? { code: "transcript_unconfirmed", message: "Pi's exact transcript could not be resolved before Enter" }
          : { code: "pi_transcript_pending", message: "Waiting for Pi's durable transcript append" } },
    };
    if (anchor !== null) piSlots.add(receipt);
    const items = piTyped.get(paneId) ?? [];
    items.push(receipt); piTyped.set(paneId, items);
    publishPi(paneId);
    void reconcilePiDeliveries(paneId);
  };
  const failPi = (paneId: string, items: readonly PiTypedReceipt[], reason: "changed" | "budget" | "ambiguous" = "changed"): void => {
    let changed = false;
    for (const item of items) {
      if (!activePiReceipt(paneId, item)) continue;
      releasePiSlot(item);
      item.message.error = reason === "budget"
        ? { code: "transcript_unconfirmed", message: "Pi's transcript exceeded the confirmation budget" }
        : reason === "ambiguous"
          ? { code: "transcript_unconfirmed", message: "Pi's transcript shows the same text submitted before this send" }
          : { code: "pi_transcript_target_changed", message: "The Pi terminal or session changed before its transcript append was confirmed" };
      changed = true;
    }
    if (changed) {
      if (!(piTyped.get(paneId) ?? []).some((item) => item.message.error?.code === "pi_transcript_pending")) piConsumed.delete(paneId);
      publishPi(paneId);
    }
  };
  async function reconcilePiDeliveries(paneId: string): Promise<void> {
    prunePi();
    const items = piTyped.get(paneId);
    if (!items?.some((item) => item.message.error?.code === "pi_transcript_pending")) return;
    await serialize(paneId, async () => {
      const currentItems = piTyped.get(paneId)?.filter((item): item is PiTypedReceipt & { anchor: PiDeliveryAnchor } => activePiReceipt(paneId, item) && item.anchor !== null) ?? [];
      if (currentItems.length === 0) return;
      let identity: PendingIdentity;
      try { identity = (await currentIdentity(paneId, currentItems[0]!.identity.processPid ?? null)).identity; }
      catch { return; }
      // a start that reads as unknown for the same PID says nothing either way here: the receipt is read again later,
      // never failed for it (only a write is refused on it)
      if (identity.processBirth == null && currentItems.some((item) => item.identity.processPid === identity.processPid && item.identity.processBirth != null)) return;
      const same = currentItems.filter((item) => activePiReceipt(paneId, item) && samePendingIdentity(item.identity, identity));
      failPi(paneId, currentItems.filter((item) => !same.includes(item)));
      if (same.length === 0) return;
      let found: Awaited<ReturnType<typeof piTranscriptPath>>;
      try { found = await piTranscriptPath(paneId); } catch { return; }
      if (found === null) return;
      const path = "unwritten" in found ? found.unwritten.path : found.path;
      let matching = same.filter((item) => activePiReceipt(paneId, item) && path === item.anchor.path);
      failPi(paneId, same.filter((item) => !matching.includes(item)));
      if (matching.length === 0 || "unwritten" in found) return;
      const candidates = matching.map((item) => ({ id: item.message.id, text: item.match, template: item.template, anchor: item.anchor }));
      const entries = piConsumed.get(paneId) ?? new Set<string>();
      piConsumed.set(paneId, entries);
      let result = matchPiDeliveries(path, candidates, entries);
      // fs.watch may report the first chunk of Pi's append. Retry only an explicitly unstable
      // snapshot, briefly and boundedly; absence of a matching user record is never polled.
      for (let attempt = 0; result.retry && attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        matching = matching.filter((item) => activePiReceipt(paneId, item));
        if (matching.length === 0) return;
        result = matchPiDeliveries(path, candidates.filter((candidate) => matching.some((item) => item.message.id === candidate.id)), entries);
      }
      if (result.retry) return;
      failPi(paneId, matching.filter((item) => result.changed.includes(item.message.id)));
      failPi(paneId, matching.filter((item) => result.unavailable?.includes(item.message.id)), "budget");
      failPi(paneId, matching.filter((item) => result.ambiguous?.includes(item.message.id)), "ambiguous");
      if (result.consumed.length === 0) return;
      const consumed = new Set(matching.filter((item) => activePiReceipt(paneId, item) && result.consumed.includes(item.message.id)).map((item) => item.message.id));
      for (const item of matching) if (consumed.has(item.message.id)) {
        releasePiSlot(item);
        if (item.resumeKey) piCompleted.push({ paneId, key: item.resumeKey, id: item.message.id, at: Date.now() });
      }
      prunePi();
      const retained = (piTyped.get(paneId) ?? []).filter((item) => !consumed.has(item.message.id));
      if (retained.length > 0) piTyped.set(paneId, retained); else piTyped.delete(paneId);
      if (!retained.some((item) => item.message.error?.code === "pi_transcript_pending")) piConsumed.delete(paneId);
      publishPi(paneId, matching.filter((item) => consumed.has(item.message.id)).map((item) => ({ owner: item.owner, id: item.message.id, outcome: "consumed" as const })));
    }).catch(() => { /* a later transcript invalidation retries without inventing delivery */ });
  }
  const discardPiReceipt = (owner: Client, paneId: string, id: string): boolean => {
    const items = piTyped.get(paneId);
    const item = items?.find((candidate) => candidate.owner === owner && candidate.message.id === id);
    if (!item || item.message.error?.code === "pi_transcript_pending") return false;
    const retained = items!.filter((candidate) => candidate !== item);
    if (retained.length > 0) piTyped.set(paneId, retained); else piTyped.delete(paneId);
    publishPi(paneId, [{ owner, id, outcome: "discarded" }]);
    return true;
  };

  function pendingLease(owner: Client, paneId: string): PendingLease {
    const sighting = sight(owner, paneId);
    if (!sighting.facts().attached) throw new HerdrError("input_not_ready", "The pane is not attached and ready");
    let authorities = pendingAuthorities.get(owner);
    if (!authorities) { authorities = new Map(); pendingAuthorities.set(owner, authorities); }
    let authority = authorities.get(paneId);
    if (!authority) { authority = {}; authorities.set(paneId, authority); }
    const lease = { sighting, authority };
    authorizePending(owner, paneId, lease);
    return lease;
  }
  // Losing authority cancels already-running checks too. Rejoining the same shared
  // attachment or returning to interact must never revive a captured lease.
  function holdPending(owner: Client, paneId?: string): void {
    if (paneId === undefined) pendingAuthorities.delete(owner);
    else pendingAuthorities.get(owner)?.delete(paneId);
    pending.hold(owner, paneId);
    holdRequested(owner, paneId);
  }
  /**
   * The first messages `client`'s page sent, in `paneId` or in every pane, that have not gone: once it
   * leaves the pane, may no longer type or closes, each is held for an explicit Send now or Discard, and
   * the pane's other messages go at their turn. One on its way settles held, not retried.
   */
  function holdRequested(client: Client, paneId?: string): void {
    const items = requested.get(client);
    if (!items) return;
    for (const item of [...items]) {
      if (paneId !== undefined && item.paneId !== paneId) continue;
      items.delete(item);
      requesters.delete(item);
      pending.holdItem(item, FIRST_MESSAGE_UNATTENDED);
      drainPending(item.paneId);
    }
  }
  function holdPendingPane(paneId: string, fault: { code: string; message: string }): void {
    for (const owner of clients) pendingAuthorities.get(owner)?.delete(paneId);
    pending.holdPane(paneId, fault);
    // A typed Pi receipt is never re-sent. Losing its exact terminal only stops automatic
    // transcript confirmation and makes the saved receipt dismissible.
    failPi(paneId, piTyped.get(paneId) ?? []);
    // a pane that ended takes its first messages with it: nothing is left to type them into, and no connection closes to expire them
    if (fault.code === "pane_not_found") {
      for (const message of pending.list(FIRST_MESSAGE_OWNER, paneId)) {
        const item = pending.get(FIRST_MESSAGE_OWNER, paneId, message.id);
        if (item) pending.discard(item);
      }
      firstReceipts.delete(paneId);
      // Its held receipts go with it too: herdr may give the ID to another pane, and a browser that attaches there
      // must not be told the old pane's copy is held, with Send now, for a terminal it was never written for.
      // What was sent, or may have been, stays: it only refuses a resend. A Send now on its way keeps its claim, and
      // puts no held receipt back when it ends as not typed. The follow-ups the bridge still holds for the pane get
      // no receipt later either (a connection that closes after its pane ended): endedPanes.
      ompUnknown.delete(paneId);
      forgetOmpStart(paneId);
      endedPanes.delete(paneId);
      endedPanes.set(paneId, Date.now());
      if (endedPanes.size > PI_RESUME_LIMIT) endedPanes.delete(endedPanes.keys().next().value!);
      for (let at = completed.length - 1; at >= 0; at--) {
        const entry = completed[at]!;
        if (entry.paneId !== paneId) continue;
        if (entry.outcome === "held") completed.splice(at, 1);
        else if (entry.outcome === "sending") entry.gone = true;
      }
    }
  }
  /**
   * herdr moved the pane under a new ID: its messages follow it there, held for an explicit send, since the
   * leases and typed Pi receipts they had were for the old ID's terminal (#1503).
   */
  function movePendingPane(from: string, to: string): void {
    if (from === to) return;
    const fault = { code: "pane_moved", message: "The pane moved to another workspace; review this message and send it again" };
    holdPendingPane(from, fault);
    pending.move(from, to, fault);
    // what was known of the old ID's starting omp goes with it: its messages are held now, and sent by hand
    forgetOmpStart(from);
    ompUnknown.delete(from);
    const receipts = firstReceipts.get(from);
    firstReceipts.delete(from);
    if (receipts) firstReceipts.set(to, [...firstReceipts.get(to) ?? [], ...receipts].slice(-FIRST_MESSAGE_RECEIPTS));
    // the follow-ups' receipts follow the pane too: a sent one must still answer a resend under the new ID (a page
    // carries its saved copies there with their proof), a held one still proves a reload there, and the claim of a
    // Send now on its way is settled under the new ID when its send ends
    for (const entry of completed) if (entry.paneId === from) entry.paneId = to;
    // typed Pi receipts, failed above as for a changed terminal, stay dismissible under the new ID
    const typed = piTyped.get(from);
    piTyped.delete(from);
    piConsumed.delete(from);
    if (typed) {
      piTyped.set(to, [...piTyped.get(to) ?? [], ...typed]);
      publishPi(to);
    }
  }
  function authorizePending(owner: Client, paneId: string, lease: PendingLease): void {
    authorizeSocket(owner);
    if (!clients.has(owner) || connectionOf(owner).closing) throw new HerdrError("disconnected", "The pending message's connection closed");
    if (pendingAuthorities.get(owner)?.get(paneId) !== lease.authority) throw new HerdrError("pending_lease_lost", "The pending message's authority changed; review it before sending again");
    const facts = lease.sighting.facts();
    if (facts.currentHeld) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
    if (!typingGuards.pendingLease(facts)) throw new HerdrError("input_not_ready", "The pending message's pane connection changed");
  }
  /**
   * The pane and the identity of what runs in it now, as a pending message is checked against them. Its
   * process is the agent's in front of the pane, as a command outcome picks it (agentProcessInFront): `bound`
   * (the process a message was bound to, or its launch reported) while it is among those in front, else the
   * agent's own program, so a wrapper that does not exec its agent (a shim, a launcher, `sh -c` with more to run)
   * and stays listed before it is not taken for it. For OmO, the process holding its session (heldOmoProcess), as
   * typing picks it, so a custom OmO is not taken for its SDK child. While herdr names no agent, or none of its
   * programs runs there, the first process in front. Its birth is read without holding the event loop (no `ps` on
   * it on macOS); the foreground is then read again, and a process no longer in front by then is not the one that
   * runs now: the reads are made again from what is, so a replacement that came meanwhile is never checked against
   * the old process's birth. While the foreground keeps changing, the latest process with no birth.
   */
  async function currentIdentity(paneId: string, bound: number | null = null, kind: string | null = null): Promise<{ pane: HerdrPane; identity: PendingIdentity; shellPid: number | null; processes: ProcessInfo | undefined;
    /** the process, as the last read shows it, is the agent's own program (runsAgentProgram); a holder record alone is no proof */
    recognized: boolean;
    /** the process is the OmO holding a session, under the start its holder record was checked against */
    held: { pid: number; started: number | null } | null }> {
    // The same normalized snapshot the client sees includes a known Codex finish that
    // herdr reports as unknown. Nothing is inferred from a bare unknown state.
    const pane = (await clientSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    const base = pendingIdentity(pane);
    const pick = async (info: ProcessInfo | undefined): Promise<{ pid: number | null; held: { pid: number; started: number | null } | null }> => {
      // the bound process first while it holds one: two holders listed in another order keep the bound one (#2190)
      const held = base.agent === "omo" ? await heldOmoProcess(pane, info?.foreground_processes ?? [], undefined, bound) : null;
      // the kind launched there stands for herdr's name until herdr gives one; a process that runs the agent's program
      // is picked wherever it is listed, before the first in front: a child it runs as it starts may be listed first (#2525)
      const agent = base.agent ?? kind;
      const foreground = info?.foreground_processes ?? [];
      return { pid: agentProcessInFront(info, agent, bound, held?.pid)?.pid
        ?? foreground.find((entry) => entry.pid !== info?.shell_pid && runsAgentProgram(entry, agent))?.pid
        ?? foreground[0]?.pid ?? null, held };
    };
    const inFront = (info: ProcessInfo | undefined, pid: number | null): boolean =>
      pid === null ? (info?.foreground_processes ?? []).length === 0 : (info?.foreground_processes ?? []).some((entry) => entry.pid === pid);
    let info = await paneProcessInfo(paneId);
    for (let attempt = 1; ; attempt++) {
      const { pid, held } = await pick(info);
      const processBirth = pid === null ? null : await processStartedAtAsync(pid);
      // Claude's own PID record says which session it runs, also without herdr's hook
      const claudeSession = base.agent === "claude" ? await claudeForegroundSession(info?.foreground_processes ?? []) : null;
      const after = await paneProcessInfo(paneId);
      const settled = inFront(after, pid);
      if (settled || attempt === 3) {
        const processPid = settled ? pid : (await pick(after)).pid;
        // a holder only as checked, with the birth read for it since: a pid reused in between is no holder
        const processHeld = settled && held?.pid === pid && held.started !== null && held.started === processBirth ? held : null;
        // what runs at that PID now, by the last read: a process bound earlier may have exec'd a shell since (#511)
        const entry = after?.foreground_processes?.find((candidate) => candidate.pid === processPid);
        // Windows names only the pane's shell in front, whatever runs in it, and has no foreground process group
        // (windows-processes.ts): which program takes the pane's input cannot be told there, so no agent is recognized
        // and a message for an agent alone is refused (#511, a known limit)
        // only positive evidence of the agent's own program counts: a session holder record outlives an exec at its PID,
        // so an argv-silent OmO known by that record alone is refused (fail closed)
        const recognized = process.platform !== "win32" && entry !== undefined && runsAgentProgram(entry, base.agent);
        return { pane, shellPid: after?.shell_pid ?? null, processes: after, held: processHeld, recognized, identity: {
          ...base, processPid, processBirth: settled ? processBirth : null,
          omoSession: omo.sessionOf(paneId)?.sessionId ?? null,
          claudeSession: settled ? claudeSession : null,
        } };
      }
      info = after;
    }
  }
  /**
   * The process a check passed for is still in front, read once more after the awaits that followed it and just
   * before a write: herdr cannot compare and send in one step, so this keeps the window to the write's own call.
   */
  async function stillInFront(paneId: string, current: number | null | undefined, pinned: PendingIdentity | null = null, agentOnly = false): Promise<void> {
    // the process the message is bound to, once known: one no longer in front is not looked past to whatever is there now
    const pid = pinned?.processPid ?? current;
    const inFront = async (): Promise<NonNullable<ProcessInfo["foreground_processes"]>> => {
      if (agentOnly) {
        // a message for an agent alone (#511): by this last read too, the PID it was checked against runs the agent's
        // own program, by the identity check its send started with (currentIdentity's `recognized`). Anything else
        // there, a shell, another program or one not known, is no agent
        const now = await currentIdentity(paneId, pid ?? null);
        if (pid == null || now.identity.processPid !== pid || !agentRuns(now.identity, now.recognized)) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
        return now.processes?.foreground_processes ?? [];
      }
      const foreground = (await paneProcessInfo(paneId))?.foreground_processes ?? [];
      if (pid != null && !foreground.some((entry) => entry.pid === pid)) throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
      return foreground;
    };
    // /clear and /resume switch Claude's session in the same process, so its PID in front says nothing of the
    // session the message is pinned to: that is read from Claude's own records (once more for a record caught being
    // rewritten), and the process is then asked for again, as one that left the front still alive keeps its record
    // (#2279). Neither can be compared in the write's own call: a switch during that last herdr read is not seen
    const session = pinned?.agent === "claude" ? pinned.claudeSession ?? null : null;
    if (pid == null && session === null && !agentOnly) return;
    const foreground = await inFront();
    if (session !== null) {
      if ((await claudeForegroundSession(foreground) ?? await claudeForegroundSession(foreground)) !== session) throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
      await inFront();
    }
    // the PID by its start too, read last, after it was seen in front
    await sameStart(pinned);
  }
  /**
   * The bound process by its start: one that ended and left its PID to another, or whose known start cannot be read any
   * more, is not the one checked (samePendingIdentity). Read from /proc or sysctl, no herdr call.
   */
  async function sameStart(pinned: PendingIdentity | null): Promise<void> {
    if (pinned?.processPid == null || pinned.processBirth == null) return;
    const birth = await processStartedAtAsync(pinned.processPid);
    if (!samePendingIdentity(pinned, { ...pinned, processBirth: birth })) throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
  }
  /**
   * The screen once more, right before a write and after every other check: a masked prompt that came up while those were
   * awaited gets no paste and no Enter, and neither does a screen of Codex's own (a list, a field, a pager), which herdr
   * reports as Codex at rest. Then the bound process's start again, which costs no herdr call: one that took
   * its PID during this read is not written to. herdr cannot compare and write in one step, so what changes during the
   * last reads or herdr's write is still not seen: the window is those reads and the write's own call.
   */
  async function noMaskedPrompt(paneId: string, cols: number | undefined, pinned: PendingIdentity | null): Promise<void> {
    const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
    if (secretPrompt(screen, cols) !== null) {
      throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
    }
    // read as pendingContext reads it: a prompt Codex asks that came up meanwhile is a waiting menu, not a screen the user opened
    const own = pinned?.agent === "codex" ? codexScreenRefusal(screen, parseInteractivePrompt("codex", screen, null, true, [], null), "unknown") : null;
    if (own !== null) throw own;
    await sameStart(pinned);
  }
  async function pendingContext(owner: Client, paneId: string, lease: PendingLease, identity?: PendingIdentity, pasted = false, agentOnly = false): Promise<{ pane: HerdrPane; identity: PendingIdentity; working: boolean; screen: string; processes: ProcessInfo | undefined; held: { pid: number; started: number | null } | null; collapsed: boolean; agentInFront: boolean }> {
    authorizePending(owner, paneId, lease);
    let { pane, identity: current, processes, held: holder, recognized } = await currentIdentity(paneId, identity?.processPid ?? null);
    // a Claude session known before and unknown now (its PID record or its job's state cannot be read) may be
    // another one: nothing is typed for it (#2125). It is read once more first, as a record being rewritten
    // fails only for a moment. After this delivery's own paste too: an Enter for a session that cannot be told
    // may commit the paste in another one, so the message is left uncertain without it (#2279). A session
    // learned only now is a match
    const unknown = (): boolean => identity?.claudeSession != null && current.claudeSession == null;
    if (unknown()) ({ pane, identity: current, processes, held: holder, recognized } = await currentIdentity(paneId, identity?.processPid ?? null));
    const lost = unknown();
    if (identity && (!samePendingIdentity(identity, current) || lost)) {
      throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
    }
    if (identity) {
      // Keep newly learned parts so a replacement before Enter is checked against them too.
      identity.session ??= current.session;
      identity.processPid ??= current.processPid;
      identity.processBirth ??= current.processBirth;
      identity.omoSession ??= current.omoSession;
      identity.claudeSession ??= current.claudeSession;
    }
    // the live screen, not the viewport: a pane scrolled into its history still draws its next
    // menu or password prompt at the bottom (server/prompt.ts liveScreen)
    const screen = (await paneRead({ paneId, source: "detection", format: "text" })).text;
    if (secretPrompt(screen, lease.sighting.facts().cols) !== null) {
      throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
    }
    const collapsed = current.agent === "codex" && codexQuestionsCollapsed(screen);
    // a message Claude Code holds for its invisible characters is a card to answer first, also once its hint has gone.
    // Not so with this delivery's own paste in the box (`pasted`), which the check before the paste found
    // free of a held message: the same words as the message noted before would be taken for that one,
    // and so would any paste under a hint left up from it (typing does not take Claude's hint down)
    const held = !pasted && current.agent === "claude" ? heldCandidate(paneId) : null;
    const prompt = current.agent ? parseInteractivePrompt(current.agent, screen, null, true, [], held) : null;
    // as the card's own reader decides it: Claude's grey text under a hint left behind is no held message
    const waits = prompt !== null && !(pasted && isClaudeHeld(prompt)) && !(await claudeHeldIsGrey(paneId, prompt));
    // One of Codex's own screens (a list, a field, a pager) has the input while herdr reports Codex at rest: as a menu
    // herdr does report, nothing is typed into it (codexScreenRefusal says as which of the two it is refused)
    const own = current.agent === "codex" ? codexScreenRefusal(screen, waits ? prompt : null, pane.agent_status === "blocked" ? "blocked" : "rest") : null;
    if (own !== null) throw own;
    if (current.agent && (waits || registry.waits(current.agent, screen) || (pane.agent_status === "blocked" && !collapsed))) {
      throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
    }
    if (current.agent && !["working", "idle", "done"].includes(pane.agent_status) && !collapsed) {
      throw new HerdrError("agent_not_ready", "The agent's current input state is not known");
    }
    // the screen and card reads above awaited: what they were read for must still be in front
    await stillInFront(paneId, current.processPid, identity ?? null, agentOnly);
    authorizePending(owner, paneId, lease);
    const agentInFront = agentRuns(current, recognized);
    return { pane, identity: current, working: current.agent !== null && (pane.agent_status === "working" || collapsed), screen, processes, held: holder, collapsed, agentInFront };
  }
  /**
   * The live screen for claudeInputDraft, and the viewport's colors when viewportShowsLive verifies
   * they show it. Read last, the live screen holds anything typed meanwhile. An empty box (or none)
   * needs no colors.
   */

  async function dispatchPendingText(owner: Client, paneId: string, text: string, lease: PendingLease, identity: PendingIdentity,
    automatic: boolean, arrivedAt: number, committing: (working: boolean, restarting?: boolean) => void = () => {}, interruptWorkingCodex = false,
    requestId = 0, agentOnly = false, queued = false,
    /** of the row this send is of: whether its Discard came while it was on its way, and its note while it waits */
    row: { withdrawn?: () => boolean; waiting?: (waits: boolean) => void } = {}): Promise<SubmitReply> {
    let wrote = false;
    // a message for an agent alone pasted and then refused its Enter (#511): its text may sit in the input line, so it is
    // held for the user and never pasted again automatically
    let stranded = false;
    let watch: OpenCodeWatch | null = null;
    let piReservation: PiReceiptReservation<Client> | null = null;
    // what the checks below read is older than a status event that arrives while they run
    let mark = pending.mark(paneId);
    try {
      const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
      // fixed wait: herdr holds a lone ESC typed into the pty ~150ms, so a Stop tapped just before reaches the pane first
      if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
      mark = pending.mark(paneId);
      let context = await pendingContext(owner, paneId, lease, identity);
      // omp draws its input box, and herdr shows it at rest, before it takes an Enter: typed then, the message stays in
      // the box and never runs while its row says sent. A send a person makes (Send now, a queue request typed at once)
      // waits here for the session herdr's omp integration reports, as the immediate send does (composer.ts
      // untilOmpReported), within its own deadline and its sender's leave to type. What was read before a wait is read
      // again: by the report the omp may be at work, changed or gone
      let waitedForOmp = false, endsOmpStart = false;
      if (context.identity.agent === "omp" && automatic) {
        // one the queue makes by itself never waits here, with the pane's lane held and every key typed there behind
        // it: it waited before it was taken up (awaitsOmp). Found starting after all (that look was not answered),
        // it goes back to the queue, and the wait is taken up from here
        const until = await ompStartingUntil(paneId, context.pane, options);
        if (until !== null) {
          waitForOmp(paneId, until);
          throw new HerdrError("pending_wait", "omp is still starting; this message waits until it takes input");
        }
      } else if (context.identity.agent === "omp") {
        try {
          const waited = await untilOmpReported(paneId, context.pane, () => {
            authorizePending(owner, paneId, lease);
            // its Discard came while it waited: the pane's lane is this send's until it ends, so the Discard itself
            // runs after it, and would otherwise answer for a message typed meanwhile
            if (row.withdrawn?.()) throw new HerdrError("pending_discarded", "This message was discarded while it waited for omp; nothing was typed");
            if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
          }, options, { strict: true, waiting: () => { waitedForOmp = true; row.waiting?.(true); } });
          // omp takes input: with nothing typed meanwhile, or once it reported and this send's own Enter submits its box
          // as its sender chose, its start is over once that Enter has gone, and what comes after goes as before. A send
          // that fails before it leaves the start as it was: what was typed is still in the box
          endsOmpStart = waited.agent_session?.source === "herdr:omp" || !typedSinceStart(paneId);
          if (waited !== context.pane) {
            mark = pending.mark(paneId);
            context = await pendingContext(owner, paneId, lease, identity);
          }
        } finally { if (waitedForOmp) row.waiting?.(false); }
      }
      // a message for an agent alone (#511) is typed only as the immediate path would: never into no agent, and never
      // past Codex's collapsed question queue, as Codex may exit before the write
      if (agentOnly && !context.agentInFront) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
      if (agentOnly && context.collapsed) throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
      const sent = closeBackslash(context.identity.agent, modelSwitchText(context.identity.agent, text));
      // a command Pi runs is never recorded as sent, so it gets no receipt that could only fail
      const piTracked = context.identity.agent !== "pi" || !piRunsCommand(context.pane, text);
      piReservation = piTracked ? reservePiReceipt(owner, context.identity) : null;
      const receiptText = piTracked ? piReceiptText(context.identity, text) : undefined;
      const piTemplate = piTracked && piListsTemplate(context.pane, text);
      // and a queue request typed at once: its pane was at rest before it waited for omp, which may be at work by its
      // report (started with a prompt of its own). It then waits its turn, as one that arrived at the report would
      if ((automatic || (queued && waitedForOmp)) && (context.working || queueHeld(paneId, false))) {
        pending.observe(paneId, "working", mark);
        throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
      }
      // a draft typed in the terminal is the user's: the paste would join it and the Enter send both (#609).
      // The box is the live screen's; only the viewport read tells Claude's grey text from a draft. The live
      // read comes after the colors, so text typed between the two is in the box and holds the message.
      if (context.identity.agent === "claude") await freeClaudeBox(paneId, context.working, () => authorizePending(owner, paneId, lease), arrivedAt + (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS), automatic || queued)
        .catch((error: unknown) => { throw error instanceof InputDraftError ? new InputDraftError(error.draft, context.identity, error.box) : error; });
      else if (context.identity.agent === "hermes") context.screen = await freeHermesInput(paneId, context.identity);
      // OpenCode v2 attaches a skill only through its autocomplete, never from a paste. A first message
      // goes before any Chat read the pane's catalog: the cold send's catalog (bounded reads, within the
      // catalog budget, at the pane's own version) is openCodeSkillsToType's, as for any other send
      const opencode = await openCodeSkillsToType(context.pane, prepareCommandSend(context.pane, text, context.screen), text, context.screen, options.openCodeStateDir);
      let command = opencode.sent;
      // the process this message goes to, from the identity read above: recording reads nothing more before the write,
      // and an OmO's holder is the one checked there, never read again (#2190)
      bindCommandProcess(paneId, command, context.processes, context.pane, context.identity.agent === "omo" ? context.held : undefined);
      // nor key by key for OpenCode's @skills: a message for an agent alone is one guarded paste, its skills left as text
      const skills = agentOnly ? [] : opencode.skills;
      if (agentOnly && command) command = skillsNotAttached(command, opencode.skills);
      let attached: string[] = [];
      let prompt: PromptPiece[] = [{ pasted: closeMention(sent) }];
      // followed from before the first key: the send's own message can be announced before Enter returns
      watch = startOpenCodeWatch(context.pane, command, options.openCodeStateDir);
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
      // the input-box checks and the catalog above awaited after the check: what it was made for must still be in front
      await stillInFront(paneId, context.identity.processPid, identity, agentOnly);
      await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);
      // the last reads awaited too: a message past its deadline is not typed
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
      authorizePending(owner, paneId, lease);
      // and a /loop wakeup or a scheduled task may have fired, or a background task ended, while they were awaited
      // (#3494): whether the turn Claude resumed on it holds the queue is read from the transcript now, with nothing
      // awaited between this and the paste's own write. A hold found here leaves nothing in the input line and the
      // message waiting; one that comes later is found before the Enter, with the paste made
      if ((automatic || queued) && queueHeld(paneId, true)) {
        pending.observe(paneId, "working", mark);
        throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
      }
      // asked again right before herdr is written to: its connect is awaited (#666)
      const allowed = (): boolean => {
        try { authorizePending(owner, paneId, lease); return true; } catch { return false; }
      };
      // Pending input is a guarded literal paste + Enter, never Codex's native Tab queue.
      // Keep the final key here so a disconnect, pane switch or new menu can cancel it.
      wrote = true;
      if (command && skills.length > 0) {
        let typed = false;
        const typing = (): boolean => { const ok = allowed(); typed ||= ok; return ok; };
        // the lookup above awaited the service: the pane, its session and its state are read again before every key
        const revalidate = async (): Promise<void> => {
          const current = await pendingContext(owner, paneId, lease, identity, typed);
          if (automatic && !typed && (current.working || queueHeld(paneId, false))) throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
          // and the screen last, as before the plain paste: no skill key goes into a masked prompt that came up meanwhile
          await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);
        };
        // the skill-accept key goes on a screen read after revalidate: no masked prompt on it, and still the bound process
        const beforeKey = async (screen: string): Promise<void> => {
          if (secretPrompt(withoutEscapes(screen), lease.sighting.facts().cols) !== null) {
            throw new HerdrError("agent_blocked", "The terminal is waiting for masked input; answer it with the secret-input form first");
          }
          // that screen is the viewport, which may be scrolled: the live screen once more, then the process start
          await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);
        };
        const result = await typeWithSkills(text, skills, typing, herdrSkillAttachIo(paneId), revalidate, beforeKey).catch((error: unknown) => {
          // nothing was written before a refused check or guard: the message is unsent, not uncertain
          if (!typed) {
            wrote = false;
            if (error instanceof HerdrError && error.code === "cancelled") authorizePending(owner, paneId, lease);
          }
          throw error;
        });
        attached = result.attached;
        prompt = result.prompt;
        command = skillsNotAttached(command, result.missed);
      } else {
        await paneSendText(paneId, `\u001b[200~${closeMention(sent)}\u001b[201~`, undefined, allowed).catch((error: unknown) => {
          // a paste the guard refused was never written: the message is unsent, not uncertain
          if (error instanceof HerdrError && error.code === "cancelled") { wrote = false; authorizePending(owner, paneId, lease); }
          throw error;
        });
      }
      // fixed wait: the TUI takes the paste before its Enter, which arriving with it could read as a newline
      await Bun.sleep(options.submitDelayMs ?? SUBMIT_DELAY_MS);
      // a message for an agent alone whose agent is no longer in front by any check before its Enter (#511): the Enter is
      // never sent, and its paste is left for the user, said plainly
      const enterRefused = (error: unknown): never => {
        if (agentOnly && error instanceof HerdrError && [TARGET_CHANGED.code, AGENT_NOT_READY.code, "agent_blocked", "pending_wait"].includes(error.code)) {
          stranded = true;
          throw new HerdrError("pasted_not_sent", PASTED_NOT_SENT_MESSAGE);
        }
        throw error;
      };
      let beforeEnter = await pendingContext(owner, paneId, lease, identity, true, agentOnly).catch(enterRefused);
      if (automatic && (beforeEnter.working || queueHeld(paneId, false))) enterRefused(new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed"));
      authorizePending(owner, paneId, lease);
      // Capture Pi's exact active transcript position before Enter. Status is deliberately not
      // evidence: Pi can report idle/done while its TUI is staging an automatic-compaction input.
      const beforeCapturePid = beforeEnter.identity.processPid;
      const piAnchor = piTracked ? await preparePiReceipt(paneId, beforeEnter.identity).catch(() => null) : undefined;
      if (piAnchor !== undefined) {
        beforeEnter = await pendingContext(owner, paneId, lease, identity, true, agentOnly).catch(enterRefused);
        if (automatic && (beforeEnter.working || queueHeld(paneId, false))) enterRefused(new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed"));
        await stillInFront(paneId, beforeCapturePid, identity, agentOnly).catch(enterRefused);
      }
      // its Enter only into the agent it was pasted for, never once the shell is in front or Codex's queue collapsed
      if (agentOnly && !beforeEnter.agentInFront) enterRefused(new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message));
      if (agentOnly && beforeEnter.collapsed) enterRefused(new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal"));
      await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity).catch(enterRefused);
      // a turn Claude resumed by itself since the paste (a /loop wakeup, a scheduled task, a background task's notice,
      // #3494) holds the queue whatever herdr reads the pane as: read from the transcript after the last of those reads,
      // it turns away an automatic send and one queued and typed at once, whose Enter (Ctrl+Enter, once herdr tells that
      // turn) would go into the turn at work. Asked here, before the message is said to be on its way, and once more as
      // the key is written
      const resumed = (): boolean => (automatic || queued) && queueHeld(paneId, true);
      const refuseResumed = (): never => enterRefused(new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed"));
      if (resumed()) refuseResumed();
      authorizePending(owner, paneId, lease);
      const steering = !automatic && beforeEnter.working;
      committing(steering);
      // Claude Code queues what Enter commits during a turn; Ctrl+Enter sends it now (#737). herdr
      // encodes the key as the pane asked, and as a plain CR for a program that asked for nothing.
      const sentAt = Date.now();
      // the connection to herdr is awaited, and a task may fire meanwhile: the hold is read once more once connected,
      // right before the key's own write. A key refused there was not sent, and its paste is not confirmed. Not seen: a
      // task whose fire Claude has not written by then (the entry reaches the transcript some tens of milliseconds
      // after the task fires), or that fires while herdr hands the key to the pane
      let refused = false;
      await paneSendKeys(paneId, [steering && beforeEnter.identity.agent === "claude" ? "ctrl+enter" : "Enter"], undefined, () => allowed() && !(refused = resumed()))
        .catch((error: unknown) => { if (refused) refuseResumed(); throw error; });
      if (endsOmpStart) forgetOmpStart(paneId);
      // This proves only that Ovis committed Enter to Pi, not that Pi accepted, queued or recorded
      // the message. Keep a non-resendable receipt until the bound JSONL active branch appends it.
      if (receiptText !== undefined) {
        try { recordPiTyped(owner, paneId, requestId, receiptText, beforeEnter.identity, piAnchor, piReservation, piTemplate); } catch { /* Enter already succeeded; receipt tracking is best-effort. */ }
      }
      // the status the panel was read under; a status event since (a finish, an approval) stales the Escape
      let statusAtRead = pending.current(paneId);
      await interruptCodexSteering(interruptWorkingCodex, closeMention(text), { agent: beforeEnter.identity.agent, working: beforeEnter.working, screen: beforeEnter.screen }, {
        read: async () => {
          // the status from before the screen was read: one that changed during the reads after it stales the Escape
          const status = pending.current(paneId);
          const current = await pendingContext(owner, paneId, lease, identity, true);
          // no Escape into a masked prompt that came up during the read's last process check
          await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);
          statusAtRead = status;
          return { agent: current.identity.agent, working: current.working, screen: current.screen };
        },
        restarting: () => committing(true, true),
        // herdr has no compare-and-send: the screen can change between this read and the write, so the
        // write is refused when the lease, the deadline or the pane's status moved meanwhile
        escape: (fresh) => paneSendKeys(paneId, ["Escape"], undefined, () => allowed() && fresh() && pending.current(paneId) === statusAtRead),
      });
      noteSubmitted(paneId, sent, command, sentAt);
      if (command) watch?.commit(command, prompt, attached);
      return { ok: true };
    } catch (error) {
      watch?.cancel();
      // never retried, and uncertain (dispatchPending): the pane's queue waits behind it for the user
      if (stranded) return { ok: false, code: "pasted_not_sent", message: PASTED_NOT_SENT_MESSAGE };
      const fault = error instanceof HerdrError && error.code === "submit_changed" ? pendingFault(error)
        : wrote ? { code: "submit_changed", message: "Pending-message delivery could not be confirmed. Check the terminal before sending again." } : pendingFault(error);
      // a menu herdr reports ends with a status event, which drains again. One of Codex's own screens ends with none:
      // the pane is not noted blocked for it (the queue behind this message is tried too, and held the same way)
      const unannounced = !wrote && error instanceof CodexOwnScreenRefusal;
      if (automatic && !wrote && fault.code === "agent_blocked" && !unannounced) pending.observe(paneId, "blocked", mark);
      // a queued request typed at once is refused as an immediate send is: with the draft (or box) its actions need
      if (queued && !wrote && error instanceof InputDraftError && error.identity) return { ok: false, ...fault, refusal: { draft: error.draft, box: error.box, identity: error.identity } };
      return { ok: false, ...fault, ...(unannounced ? { unannounced } : {}) };
    } finally { piCapacity.release(piReservation); }
  }
  /**
   * `by`: the connection that types the message, the owner's own for a connection's message; for a
   * first message whichever typist the caller found, whose lease is taken here for this attempt alone.
   */
  async function dispatchPending(item: PendingItem, automatic: boolean, arrivedAt: number, interruptWorkingCodex = false, by: Client | null = isClient(item.owner) ? item.owner : null): Promise<SubmitReply> {
    let reply: SubmitReply;
    try {
      if (by === null) throw new HerdrError("input_not_ready", "No connection has the pane attached to type the message");
      const lease = item.lease ?? pendingLease(by, item.paneId);
      reply = await dispatchPendingText(by, item.paneId, item.message.text, lease, item.identity,
        automatic, arrivedAt, (working, restarting) => pending.committing(item, working, restarting), interruptWorkingCodex, item.message.request_id, item.message.agent_only === true, false,
        { withdrawn: () => withdrawn.has(item), waiting: (waits) => pending.sendingWaitsFor(item, waits ? "omp_starting" : undefined) });
    } catch (error) {
      reply = { ok: false, ...pendingFault(error) };
    }
    const code = reply.code ?? "";
    // a first message its page could not type yet stays queued for that page's next attach or turn. One whose
    // page left or closed during its own automatic send is held as at that leaving, never retried: no page is
    // left to type it, and queued again it would head the pane's queue ahead of the other devices' messages
    const requester = requesters.get(item);
    const unattended = automatic && !isClient(item.owner) && (requester === undefined || !present(requester));
    // not one of Codex's own screens: nothing announces its end, so the message is held with that reason instead
    const retryable = (["pending_wait", "agent_blocked"].includes(code) && reply.unannounced !== true) || (!isClient(item.owner) && FIRST_MESSAGE_RETRY_CODES.has(code));
    const fault = reply.ok ? undefined : unattended && retryable ? FIRST_MESSAGE_UNATTENDED : { code: reply.code!, message: reply.message! };
    // a paste left in the input line (#511) is uncertain like a delivery not confirmed: the pane's queue stops behind it, and
    // only the user copies or discards it
    pending.settle(item, fault, reply.code === "submit_changed" || reply.code === "pasted_not_sent", automatic && retryable && !unattended);
    // The messages queued behind one held for a screen of Codex's own are held with it, in the same step: tried one
    // by one, a later one would be typed ahead of it if the screen closed between two tries.
    if (automatic && reply.unannounced === true && fault !== undefined) pending.holdPane(item.paneId, fault);
    return reply;
  }
  function drainPending(paneId: string): void {
    // a first message learns its launched agent at every event of its pane, also while no connection can type it
    const learning = launchBoundIn(paneId).length > 0;
    if (pending.next(paneId) === null && !learning) return;
    if (pendingDrains.has(paneId)) {
      // what the running drain read may predate this event: it runs once more
      if (learning) drainAgain.add(paneId);
      return;
    }
    pendingDrains.add(paneId);
    const arrivedAt = Date.now();
    // drained again only after a dispatch: a message no connection can type yet waits for the next
    // attach, readiness or status event, where draining again at once would spin the event loop
    let dispatched = false;
    void serialize(paneId, async () => {
      if (learning) await learnLaunched(paneId);
      const item = pending.next(paneId);
      if (!item) return;
      // a first message waits for its own page to have the pane attached and ready; a connection's own message has its owner
      const requester = requesters.get(item);
      const by = isClient(item.owner) ? item.owner : requester !== undefined && typists(paneId).includes(requester) ? requester : null;
      if (by === null) return;
      // a launched agent herdr does not name yet is waited for: its next status event drains again. One that
      // came up and left holds its message, and the drain runs once more for the pane's next one
      const bound = await bindLaunched(item);
      if (bound === "wait") return;
      if (bound === "ended") { holdFor(item, LAUNCH_GONE); drainAgain.add(paneId); return; }
      // an omp still starting is waited for with the message still queued: this runs again once it takes input
      if (await awaitsOmp(item)) return;
      if (!pending.claim(item, true)) return;
      dispatched = true;
      await dispatchPending(item, true, arrivedAt, false, by);
      takenWithPane(item, arrivedAt);
    }).catch((error) => console.warn("pending message:", pendingFault(error).code)).finally(() => {
      pendingDrains.delete(paneId);
      const again = drainAgain.delete(paneId);
      if (dispatched || again) drainPending(paneId);
    });
  }
  const drainAgain = new Set<string>();
  /**
   * A first message whose pane ended while it was on its way (since `since`) goes with the pane after all, once its
   * send has ended. The pane's end could not take it then (holdPendingPane discards what is not on its way), and no
   * connection's end expires a first message: left under the pane's id, it is what the next pane herdr gives that
   * id shows, and takes that pane's own first message's place.
   */
  function takenWithPane(item: PendingItem, since: number): void {
    // and no receipt of it is kept for the pane's id, as none is at the pane's end (holdPendingPane)
    if (!isClient(item.owner) && (endedPanes.get(item.paneId) ?? -Infinity) >= since && pending.discard(item)) firstReceipts.delete(item.paneId);
  }
  /** the panes whose queue waits for an omp that is still starting (awaitsOmp) */
  const ompWaits = new Set<string>();
  /** when herdr first did not say whether each pane's omp is starting (awaitsOmp) */
  const ompUnknown = new Map<string, number>();
  /**
   * The start of an omp that the pane's queue waits for: how much a person had typed into the pane when the queue
   * first waited, and when that start is given up on. Kept from the first wait until omp takes input with nothing
   * typed meanwhile, or until the start is given up on: longer than any one wait, since a message can join the queue
   * after a wait has ended.
   */
  const ompStarts = new Map<string, { typed: number; until: number }>();
  /** the lines sent from the terminal's input line to each pane while an omp start is remembered for it: typed by the submit handler here, not by the input lane */
  const linesTyped = new Map<string, number>();
  /** how much a person typed into the pane: through the input lane, and from the terminal's input line */
  const typedCount = (paneId: string): number => typedInto(paneId) + (linesTyped.get(paneId) ?? 0);
  /**
   * Whether a person typed into the pane's terminal while its queue waited for the omp starting there. omp has no
   * check of its input box as Claude and Hermes have, and before it takes input even a line's own Enter leaves the
   * line in the box: pasted behind it, a message would be sent with those words as one. So from then until that
   * start is over, no message goes to the pane unless a person sends it: what waits is held, and so is what comes.
   */
  function typedWhileOmpStarted(paneId: string): boolean {
    const start = ompStarts.get(paneId);
    if (!start) return false;
    // past its end, a wait still on for it reads the typing at its next look (typedSinceStart), and holds for it
    if (Date.now() >= start.until) {
      if (ompWaits.has(paneId) && typedSinceStart(paneId)) return true;
      forgetOmpStart(paneId);
      return false;
    }
    return typedSinceStart(paneId);
  }
  /** typedWhileOmpStarted, also past the start's end: a wait that runs to that end still holds for what was typed before it */
  function typedSinceStart(paneId: string): boolean {
    const start = ompStarts.get(paneId);
    return start !== undefined && typedCount(paneId) !== start.typed;
  }
  function forgetOmpStart(paneId: string): void {
    ompStarts.delete(paneId);
    linesTyped.delete(paneId);
  }
  /** the messages on their way whose Discard came meanwhile: a send that waits for omp ends at its next look (dispatchPendingText) */
  const withdrawn = new WeakSet<PendingItem>();
  /**
   * Whether the pane's queue waits for its omp to take input, for a message the queue would send by itself. That
   * wait is no part of a send (waitForOmp): the message stays queued, with nothing claimed and the pane's lane free,
   * so what is typed into the pane meanwhile goes at once, a pane that ends takes the message with it, and Send now
   * or Discard find it as it is.
   */
  async function awaitsOmp(item: PendingItem): Promise<boolean> {
    const paneId = item.paneId;
    if (ompWaits.has(paneId)) return true;
    if (item.identity.agent !== "omp") return false;
    let until: number | null;
    try {
      const pane = (await clientSnapshot()).panes.find((candidate) => candidate.pane_id === paneId);
      // what herdr names there now is no omp: the send's checks hold the message for it
      until = !pane || pendingIdentity(pane).agent !== "omp" ? null : await ompStartingUntil(paneId, pane, options);
      ompUnknown.delete(paneId);
    } catch {
      // herdr did not say whether omp is starting: not known is not ready, and left at that the message would stay
      // queued with nothing to drain it. It is asked again a moment later, for as long as an omp could still be
      // starting; after that the send's own look decides, and a failure there holds the message with its reason
      const since = ompUnknown.get(paneId) ?? Date.now();
      if (Date.now() - since >= (options.ompStartupMs ?? OMP_STARTUP_MS)) { ompUnknown.delete(paneId); return false; }
      ompUnknown.set(paneId, since);
      // what is typed from now on counts for the wait that follows once herdr answers: omp may be starting
      if (!ompStarts.has(paneId)) ompStarts.set(paneId, { typed: typedCount(paneId), until: since + (options.ompStartupMs ?? OMP_STARTUP_MS) });
      waitForOmp(paneId, null);
      return true;
    }
    if (until === null) {
      // omp takes input (or is no omp any more). Typed into meanwhile, also after the last wait had ended: what is
      // queued is held and nothing is sent; with nothing typed, the start is over
      if (typedWhileOmpStarted(paneId)) { pending.holdQueued(paneId, TYPED_WHILE_WAITING); return true; }
      forgetOmpStart(paneId);
      return false;
    }
    // typed into before this wait (a new pane's, since its first message was queued): held at once
    if (typedWhileOmpStarted(paneId)) { pending.holdQueued(paneId, TYPED_WHILE_WAITING); return true; }
    waitForOmp(paneId, until);
    return true;
  }
  /**
   * Looks at the pane until its omp has reported its session (composer.ts untilOmpReported says why that is when omp
   * takes input), is no omp any more, or `until`, when its start is given up on; then the pane's queue is drained
   * again, and that drain's own checks say what becomes of the message. `until` null: herdr did not say whether omp
   * is starting, and the drain asks again after one pause. One wait per pane. It ends early once no message of the
   * pane's waits to go by itself (it went by hand, is held, or omp is at work), and it outlives a look herdr does not
   * answer: it is no send that could fail, and nothing else would drain the pane at the report.
   *
   * The pane's lane is free meanwhile, so a person can type into omp's input box: once anything was typed into the
   * pane, the messages that wait are held for the person to send, with that reason (typedWhileOmpStarted).
   */
  function waitForOmp(paneId: string, until: number | null): void {
    if (ompWaits.has(paneId)) return;
    ompWaits.add(paneId);
    if (until !== null) {
      // the start is remembered from the pane's first message, when it has one (queueFirstMessage); its end is known now
      const start = ompStarts.get(paneId);
      if (start) start.until = until; else ompStarts.set(paneId, { typed: typedCount(paneId), until });
      // the pane shows omp at rest: the rows say what they wait for
      pending.waitingFor(paneId, "omp_starting");
    }
    const typedMeanwhile = (): boolean => {
      if (!typedSinceStart(paneId)) return false;
      pending.holdQueued(paneId, TYPED_WHILE_WAITING);
      return true;
    };
    void (async () => {
      for (;;) {
        await Bun.sleep(options.ompReportPollMs ?? OMP_REPORT_POLL_MS);
        // nothing waits to go by itself any more: herdr is not asked again about this run of unanswered looks either
        if (pending.next(paneId) === null) {
          ompUnknown.delete(paneId);
          // and with nothing typed, nothing is kept of the start for what comes after: that is sent as before
          if (!typedSinceStart(paneId)) forgetOmpStart(paneId);
          return;
        }
        if (typedMeanwhile() || until === null) return;
        if (Date.now() >= until) {
          console.warn(`[omp] ${paneId}: herdr's omp integration reported no session while omp started; sending anyway`);
          return;
        }
        try {
          const pane = await paneGet(paneId);
          if (pendingIdentity(pane).agent !== "omp" || pane.agent_session?.source === "herdr:omp") return;
        } catch (error) {
          if (pendingFault(error).code === "pane_not_found") return;
        }
      }
    })().finally(() => {
      ompWaits.delete(paneId);
      // typed during the last look too
      typedMeanwhile();
      pending.waitingFor(paneId, undefined);
      // a drain running now read the pane while this wait was on: it runs once more
      if (pendingDrains.has(paneId)) drainAgain.add(paneId); else drainPending(paneId);
    });
  }
  /**
   * A create request's first message for the pane's agent, queued as the request's own send: typed once
   * the agent is ready through `requester`, the id of the page connection that sent the request, while it
   * has the pane attached (drainPending), and listed to every connection attached to the pane. Without a
   * connection of that id it is held from the start. Refused as a submit frame's text would be.
   */
  async function queueFirstMessage(paneId: string, raw: string, kind: string, requester: string | null = null, launchedPid: number | null = null): Promise<PendingMessage> {
    const text = pendingText(raw);
    const page = requester === null ? undefined : [...clients].find((client) => client.data.connectionId === requester && present(client));
    const message = await serialize(paneId, async () => {
      // bound to the terminal and the kind launched there, and to the process the launch left in front when
      // it runs that kind's program: a replacement of the same kind is not what the message was sent to. Right
      // after a launch herdr may name no agent yet, and what is in front may be a child the agent runs as it
      // starts (Claude Code's git and gh); that binding is completed when herdr names it (learn, bindLaunched)
      const { pane, identity, shellPid, processes, held } = await currentIdentity(paneId, launchedPid, kind);
      // The launch's own word wins: a shell-started agent's launch says which process it came up as, which
      // may have ended already, and then an agent the user starts later is not the one launched
      const launchedProcess = launchedPid !== null
        ? { processPid: launchedPid, processBirth: identity.processPid === launchedPid ? identity.processBirth : await processStartedAtAsync(launchedPid) }
        : identity.processPid !== null && identity.processPid !== undefined && identity.processPid !== shellPid
          && runsAgentProgram(processes?.foreground_processes?.find((entry) => entry.pid === identity.processPid) ?? {}, kind)
          ? { processPid: identity.processPid, processBirth: identity.processBirth } : {};
      // and to the sessions herdr, OmO or Claude's own record already name for that agent: a /resume
      // before the message went is another session
      const sessions = identity.agent === kind
        ? { session: identity.session, omoSession: identity.omoSession ?? null, claudeSession: identity.claudeSession ?? null } : { session: null };
      const item = pending.enqueue(FIRST_MESSAGE_OWNER, paneId, nextFirstRequestId--, text, null,
        { agent: kind, terminalId: pane.terminal_id, ...sessions, ...launchedProcess });
      launchBound.add(item);
      // an omp is waited for before this goes (awaitsOmp): what is typed into its pane from now on counts, also
      // before the pane first comes to rest. When its start is given up on is read then; until then, half a minute
      if (kind === "omp" && !ompStarts.has(paneId)) ompStarts.set(paneId, { typed: typedCount(paneId), until: Date.now() + (options.ompStartupMs ?? OMP_STARTUP_MS) });
      // this read learns as an event's would: an agent it sees in front under its kind is named before it can leave
      learn(item, identity, shellPid, processes, held);
      // no page to type it, or one that closed meanwhile: held before any drain could see it queued
      if (page === undefined || !present(page)) pending.holdItem(item, FIRST_MESSAGE_UNATTENDED);
      else {
        requesters.set(item, page);
        requested.set(page, (requested.get(page) ?? new Set()).add(item));
      }
      return item.message;
    });
    drainPending(paneId);
    return { ...message };
  }
  /**
   * What a launch-bound first message learns of the agent launched for it from what runs in its pane now:
   * the parts not known yet (process, sessions), once herdr names the launched kind in its terminal and
   * nothing known disagrees. The first agent seen there is the launched one, and a part once learned is
   * never replaced, so a later session or process of the same kind is another; pendingContext holds the
   * message for it with pending_target_changed.
   */
  function learn(item: PendingItem, identity: PendingIdentity, shellPid: number | null, processes: ProcessInfo | undefined, held: { pid: number } | null = null): void {
    if (identity.terminalId !== item.identity.terminalId || identity.agent !== item.identity.agent || !samePendingIdentity(item.identity, identity)) return;
    item.identity.session ??= identity.session;
    // the shell itself is never the launched process: with it still in front, the launch is not known yet
    if (identity.processPid !== shellPid) {
      // nor is a process known to run another program while something else is in front too: a child the agent runs as
      // it starts (#2525), learned at a later event once the agent's own program is seen or it is alone in front. The
      // process picked for the agent herdr names is trusted when its listing does not say what it runs (no argv)
      const foreground = (processes?.foreground_processes ?? []).filter((entry) => entry.pid !== shellPid);
      const entry = foreground.find((candidate) => candidate.pid === identity.processPid);
      if (identity.processPid == null || held?.pid === identity.processPid
        || (entry !== undefined && (foreground.length === 1 || !runsOtherProgram(entry, item.identity.agent)))) {
        item.identity.processPid ??= identity.processPid;
        item.identity.processBirth ??= identity.processBirth;
      }
      // bound here or at its queueing, the launched process is named as it runs under its kind (an exec renames it)
      const name = identity.processPid === item.identity.processPid ? processName(processes, identity.processPid) : undefined;
      if (name) launchedNames.set(item, name);
    }
    item.identity.omoSession ??= identity.omoSession;
    item.identity.claudeSession ??= identity.claudeSession;
  }
  /** Each launch-bound first message in the pane is checked against a read of it, at each event of the pane (drainPending). */
  async function learnLaunched(paneId: string): Promise<void> {
    const items = launchBoundIn(paneId);
    if (items.length === 0) return;
    // read for each message's own bound process (a pane holds one first message, so one read in practice)
    for (const item of items) {
      const { identity, shellPid, processes, held } = await currentIdentity(paneId, item.identity.processPid ?? null);
      // its agent came up and left, or what herdr names there is not what was launched for it: held at once, as
      // pendingContext would hold it at a send, which a pane that is not at rest never gets to
      if (launchGone(item, identity, shellPid, processes)) holdFor(item, LAUNCH_GONE);
      // a start that reads as unknown for the same PID says nothing either way: the message waits for the next read
      else if (identity.processBirth == null && item.identity.processBirth != null && identity.processPid === item.identity.processPid) continue;
      else if (targetChanged(item, identity)) holdFor(item, TARGET_CHANGED);
      else learn(item, identity, shellPid, processes, held);
    }
  }
  /**
   * A first message before a send. While herdr names no agent in its terminal it waits ("wait") only for a
   * launch still coming up: no process learned yet, or the learned one still in front. A launched agent
   * that came up and left is no longer waited for ("ended"): the message is held with
   * first_message_launch_ended. Otherwise it learns from what runs there (learn) and goes to
   * pendingContext's checks ("bound").
   */
  async function bindLaunched(item: PendingItem): Promise<"bound" | "wait" | "ended"> {
    if (!launchBound.has(item)) return "bound";
    const { identity, shellPid, processes, held } = await currentIdentity(item.paneId, item.identity.processPid ?? null);
    if (launchGone(item, identity, shellPid, processes)) return "ended";
    if (identity.terminalId === item.identity.terminalId && identity.agent === null) return "wait";
    learn(item, identity, shellPid, processes, held);
    return "bound";
  }
  /** Whether what runs in a first message's pane is not what was launched for it: another terminal, or an agent herdr names that disagrees. */
  function targetChanged(item: PendingItem, identity: PendingIdentity): boolean {
    return identity.terminalId !== item.identity.terminalId || (identity.agent !== null && !samePendingIdentity(item.identity, identity));
  }
  /**
   * Whether the agent launched for a first message came up and left: the process learned for it is no longer
   * the one in front, and herdr names no agent in its terminal, or still names the launched kind while the
   * pane's shell itself is back in front (herdr's name can outlast the process). An exec keeps the shell's
   * pid, so the process there counts as the shell only under a name other than the launched agent's. Any
   * other process in front under that name is another agent (targetChanged).
   */
  function launchGone(item: PendingItem, identity: PendingIdentity, shellPid: number | null, processes: ProcessInfo | undefined): boolean {
    const launched = item.identity.processPid;
    if (launched == null || identity.terminalId !== item.identity.terminalId) return false;
    const front = processName(processes, identity.processPid);
    const launchedName = launchedNames.get(item);
    const shellBack = shellPid !== null && identity.processPid === shellPid && identity.agent === item.identity.agent
      && front !== undefined && launchedName !== undefined && front !== launchedName;
    if (identity.agent !== null && !shellBack) return false;
    return identity.processPid !== launched
      // macOS allows a second, as samePendingIdentity does
      || (item.identity.processBirth != null && identity.processBirth != null
        && Math.abs(identity.processBirth - item.identity.processBirth) > (process.platform === "darwin" ? 1000 : 0));
  }
  /** A connection's end: its own messages are held, and so are the first messages its page sent that have not gone yet. */
  function closeConnection(client: Client): void {
    // Keep bounded presentation-only receipts across transient loss, not input authority.
    // Revocation/read-only transitions do not retain a resumable presentation.
    let resumable = true;
    try { authorizeSocket(client); } catch { resumable = false; }
    if (!resumable) {
      // only its held receipts go: the keys stay, so a send still on its way when the connection closed leaves its
      // sent or discarded receipt as before (replayed only to a connection that may resume, resumePi)
      const keys = receiptKeys.get(client);
      if (keys) for (const id of keys.keys()) {
        const at = completed.findIndex((entry) => entry.id === id && entry.outcome === "held");
        if (at >= 0) completed.splice(at, 1);
      }
    }
    pending.close(client);
    holdRequested(client);
    requested.delete(client);
    for (const [paneId, items] of piTyped) {
      const drop = (item: PiTypedReceipt): boolean => item.owner === client && (!resumable || !item.resumeKey);
      for (const item of items) if (drop(item)) releasePiSlot(item);
      const retained = items.filter((item) => !drop(item));
      if (retained.length > 0) piTyped.set(paneId, retained); else piTyped.delete(paneId);
      if (!retained.some((item) => item.message.error?.code === "pi_transcript_pending")) piConsumed.delete(paneId);
      // Reload can attach its successor before the old socket's close reaches us.
      // Rebind presentation only; never call drainPending or recover an input lease.
      for (const successor of clients) if (successor !== client && livePiOwner(successor) && successor.data.attached.has(paneId)) {
        if (resumePi(successor, paneId, client)) {
          publishPi(paneId);
          void reconcilePiDeliveries(paneId);
        }
      }
    }
    prunePi();
  }
  function resumePi(client: Client, paneId: string, closing?: Client): boolean {
    let rebound = false;
    const key = resumeKey(client, paneId);
    if (key && connectionOf(client).mode !== "observe") {
      try {
        authorizeSocket(client);
        for (const item of piTyped.get(paneId) ?? []) {
          if (item.resumeKey !== key || livePiOwner(item.owner) && item.owner !== closing) continue;
          if (piSlots.has(item)) {
            if (!piCapacity.retain(client)) continue;
            piCapacity.remove(item.owner);
          }
          item.owner = client;
          rebound = true;
        }
        const mine = completed.filter((item) => item.paneId === paneId && item.key === key);
        const removed = [
          ...piCompleted.filter((item) => item.paneId === paneId && item.key === key).map(({ id }) => ({ id, outcome: "consumed" as const })),
          ...mine.flatMap(({ id, outcome }) => outcome === "sent" || outcome === "discarded" ? [{ id, outcome, resumed: true as const }] : []),
        ];
        const held = mine.filter(({ outcome }) => outcome === "held");
        if (removed.length || held.length) send(client, { type: "pending-messages", pane_id: paneId, messages: [], ...(removed.length ? { removed } : {}), ...(held.length ? heldPart(held) : {}) });
      } catch { /* failed authorization cannot resume even presentation */ }
    }
    return rebound;
  }
  /** held receipts as a frame tells them: their IDs, and how long the bridge keeps each (the page's proof ends with it) */
  function heldPart(entries: ReadonlyArray<{ id: string; at: number }>): { held: string[]; held_ms: Record<string, number>; held_until: Record<string, number>; server_time: number } {
    // how long is left runs on the forward-only clock; its end is told on the PC's clock as it reads now
    const now = Date.now(), left = (at: number): number => Math.max(0, at + PI_RESUME_MS - elapsed());
    return { held: entries.map(({ id }) => id), held_ms: Object.fromEntries(entries.map(({ id, at }) => [id, left(at)])),
      held_until: Object.fromEntries(entries.map(({ id, at }) => [id, now + left(at)])), server_time: now };
  }
  /** `held`: an exact ID the bridge holds untyped, in its own field so a client that predates it never reads it as a removal. */
  function pushResumed(owner: Client, paneId: string, kept: string, part: { removed: PendingRemoval[] } | ReturnType<typeof heldPart>): void {
    for (const successor of clients) {
      if (successor === owner || !livePiOwner(successor) || !successor.data.attached.has(paneId)
        || resumeKey(successor, paneId) !== kept || connectionOf(successor).mode === "observe") continue;
      try {
        authorizeSocket(successor);
        send(successor, { type: "pending-messages", pane_id: paneId, messages: [], ...part });
      } catch { /* failed authorization cannot resume even presentation */ }
    }
  }
  /**
   * Keeps a follow-up's sent, discarded or held receipt for its browser's return: a socket that drops before the
   * receipt reaches it leaves the browser's copy unconfirmed. Only an exact outcome is kept (never a dismissed
   * uncertain copy), bound to the device and browser that sent it, and it is presentation only: nothing is typed.
   */
  function keepReceipts(owner: Client, paneId: string, messages: PendingMessage[], removed: readonly PendingRemoval[] | undefined): void {
    let resumable = true;
    try { authorizeSocket(owner); } catch { resumable = false; }
    const key = resumable ? resumeKey(owner, paneId) : undefined;
    const keys = receiptKeys.get(owner) ?? new Map<string, string>();
    if (key) for (const message of messages) if (!keys.has(message.id)) keys.set(message.id, key);
    for (const message of messages) {
      const kept = resumable ? keys.get(message.id) : undefined;
      if (!kept) continue;
      const existing = completed.findIndex((entry) => entry.id === message.id && entry.outcome !== "sending");
      if (message.state !== "held") {
        if (existing >= 0 && completed[existing]!.outcome === "held") completed.splice(existing, 1);
        continue;
      }
      if (existing >= 0 && completed[existing]!.outcome === "held" && completed[existing]!.paneId === paneId) continue;
      // only once its connection is gone: while it lives, it alone may send the held copy, and another
      // tab told it is held could offer it again after that send's outcome became uncertain
      if (livePiOwner(owner)) continue;
      // taken before its pane ended: it was written for that pane, not for whatever has the ID now
      const ended = endedPanes.get(paneId);
      if (ended !== undefined && Date.parse(message.created_at) <= ended) continue;
      if (existing >= 0) completed.splice(existing, 1);
      const at = elapsed();
      completed.push({ paneId, key: kept, id: message.id, outcome: "held", at });
      pushResumed(owner, paneId, kept, heldPart([{ id: message.id, at }]));
    }
    for (const item of removed ?? []) {
      const kept = keys.get(item.id);
      keys.delete(item.id);
      const existing = completed.findIndex((entry) => entry.id === item.id && entry.outcome !== "sending");
      // An exact outcome replaces what was known. A dismissed one (an uncertain record that aged out) ends only a
      // held receipt: the note that a Send now may have typed the copy stays its ten minutes, since the record's own
      // disposition can be evicted long before that.
      if (existing >= 0 && (item.outcome !== "dismissed" || completed[existing]!.outcome === "held")) completed.splice(existing, 1);
      if (!kept || (item.outcome !== "sent" && item.outcome !== "discarded")) continue;
      completed.push({ paneId, key: kept, id: item.id, outcome: item.outcome, at: elapsed() });
      // a reload can attach its successor before the Enter's reply settles the send
      pushResumed(owner, paneId, kept, { removed: [{ id: item.id, outcome: item.outcome, resumed: true }] });
    }
    if (keys.size) receiptKeys.set(owner, keys); else receiptKeys.delete(owner);
    prunePi();
  }
  /** A connection that attached the pane: it sees the pane's first messages and their receipts, and may be the one to type them. */
  function attached(client: Client, paneId: string): void {
    prunePi();
    resumePi(client, paneId);
    const messages = [...pending.list(FIRST_MESSAGE_OWNER, paneId), ...piMessages(paneId, client)];
    const removed = firstReceipts.get(paneId) ?? [];
    if ((messages.length > 0 || removed.length > 0) && connectionOf(client).mode !== "observe") {
      send(client, { type: "pending-messages", pane_id: paneId, messages, ...(removed.length > 0 ? { removed } : {}) });
    }
    drainPending(paneId);
    if (piTyped.has(paneId)) void reconcilePiDeliveries(paneId);
  }
  function replayPendingOutcome(owner: Client, paneId: string, id: string): boolean {
    const outcome = pending.outcome(owner, paneId, id) ?? pending.outcome(FIRST_MESSAGE_OWNER, paneId, id);
    if (!outcome) return false;
    send(owner, { type: "pending-messages", pane_id: paneId, messages: pending.list(owner, paneId), removed: [{ id, outcome }] });
    return true;
  }

  /** The pending frames a connection sends, each handled as its `case` in the socket's frame switch was. */
  const pendingFrames = {
    async submit(client: Client, message: Frame<"submit">): Promise<void> {
      // every submit is answered: the composer keeps its text until it hears back
      const result = (ok: boolean, code?: string, text?: string, accepted?: PendingMessage, draft?: string | null, box?: string | null, typedNow = false, sendingAt?: string) => send(client, {
        type: "submit-result", id: message.id, pane_id: message.pane_id, ok, ...(accepted ? { pending: accepted } : {}), ...(typedNow ? { typed_now: true as const } : {}), ...(code ? { code, message: text } : {}),
        ...(ok && sendingAt ? { sending_at: sendingAt } : {}),
        ...(draft ? { draft } : {}), ...(!draft && typeof box === "string" ? { box } : {}),
      });
      if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
        || typeof message.text !== "string" || typeof message.payload !== "string") {
        send(client, { type: "error", code: "invalid_submit", message: "id must be an integer, pane_id, text and payload strings" });
        return;
      }
      const waits = message.delivery === "queue" || message.delivery === "hold";
      if ((message.delivery !== undefined && message.delivery !== "immediate" && !waits)
        || (waits && message.typed !== undefined && message.typed !== false)) {
        result(false, "invalid_delivery", "Use immediate delivery, or queue or hold a chat message");
        return;
      }
      if (message.clear_draft !== undefined && (typeof message.clear_draft !== "string" || !message.clear_draft
        || waits || (message.typed !== undefined && message.typed !== false))) {
        result(false, "invalid_delivery", "Clear a terminal draft only for a chat message sent at once");
        return;
      }
      if (message.send_anyway !== undefined && (message.send_anyway !== true || waits || message.clear_draft !== undefined
        || (message.typed !== undefined && message.typed !== false))) {
        result(false, "invalid_delivery", "Send anyway only a chat message sent at once, without clearing a draft");
        return;
      }
      if (message.resend_id !== undefined && (typeof message.resend_id !== "string" || !message.resend_id || message.resend_id.length > 128
        || waits || message.typed === true || message.clear_draft !== undefined || message.send_anyway !== undefined)) {
        result(false, "invalid_delivery", "Use a held-copy resend id only for an immediate chat message");
        return;
      }
      if (message.resend_generation !== undefined && (!Number.isSafeInteger(message.resend_generation) || message.resend_generation < 0 || message.resend_id === undefined)) {
        result(false, "invalid_delivery", "A resend generation must be a nonnegative integer with a held-copy id");
        return;
      }
      // #511: a chat message for an agent alone (comments on a reply, whose `> quote` lines a shell would run as redirects)
      if (message.agent_only !== undefined && (message.agent_only !== true || message.typed === true)) {
        result(false, "invalid_delivery", "Only a chat message can be for an agent alone, with agent_only true");
        return;
      }
      // a saved copy's resend keeps the rule its accepted message had, even from a page that lost the flag
      const agentOnly = message.agent_only === true
        || (typeof message.resend_id === "string" && pending.agentOnly(message.pane_id, message.resend_id));
      if (connectionOf(client).mode === "observe") {
        result(false, "read_only", "this connection is in observe mode");
        return;
      }
      // another web bridge has this pane's terminal: its user types there, not this one
      if (attachments.get(message.pane_id)?.held) {
        result(false, "attach_held", ATTACH_HELD_MESSAGE);
        return;
      }
      // an immediate submit's framing, checked before a resend id is reserved or anything is typed or cleared
      let framed = { text: message.text, payload: message.payload };
      if (!waits) {
        try { framed = submitFraming(message.text, message.payload, message.typed === true); }
        catch (error) { const fault = pendingFault(error); result(false, fault.code, fault.message); return; }
      }
      const arrivedAt = Date.now();
      try {
        if (waits) {
          let book = pendingRequests.get(client);
          if (!book) { book = new PendingRequestBook((reply: SubmitReply) => reply.pending !== undefined && pending.retains(client, reply.pending.id)); pendingRequests.set(client, book); }
          // a digest, so a receipt kept for replay never holds a large request's bytes
          const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify([message.pane_id, message.text, message.payload, message.delivery, agentOnly])).digest("hex");
          const previous = book.get(message.id, fingerprint);
          const lease = previous ? null : pendingLease(client, message.pane_id);
          const reply = previous ?? book.run(message.id, fingerprint, () => serialize(message.pane_id, async (): Promise<SubmitReply> => {
            const text = pendingText(message.text);
            const mark = pending.mark(message.pane_id);
            const context = await pendingContext(client, message.pane_id, lease!);
            if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "This pending message waited too long; nothing was typed");
            // kept for an agent: its delivery types it only into that same agent (samePendingIdentity)
            if (agentOnly && !context.agentInFront) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
            // a pane shown at rest whose queue a busy signal still holds is not ready for a queued message
            const held = queueHeld(message.pane_id, false);
            // typed at once, but the queue's hold came up before anything was written: it waits its turn after all
            let waited = false;
            if (!context.working && !held) {
              // the agent left while the message was on its way: a chat follow-up is not typed into what is there now
              if (context.identity.agent === null) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
              // A request that raced the turn's finish still needs cancellable
              // paste + Enter; agent.prompt commits its key inside herdr. With a message
              // already waiting its turn here, this one takes its place behind it instead.
              // A held message is never typed by arriving after the turn: it waits for Send now.
              // Queued, it never clears a stopped send Claude put back in its box, as the drain does not (#2546).
              // not behind what was typed into the terminal while omp started: it is held below, with that reason
              if (message.delivery === "queue" && !pending.waiting(message.pane_id) && !typedWhileOmpStarted(message.pane_id)) {
                // before anything is typed: the message's turn is written after this on this PC's clock (src/lib/sentWaiting.ts)
                const sendingAt = new Date().toISOString();
                const typed = await dispatchPendingText(client, message.pane_id, text, lease!, context.identity, false, arrivedAt, undefined, false, message.id, agentOnly, true);
                // pending_wait: the hold was found right before the paste (a /loop wakeup fired, or a background task
                // ended, during the checks, #3494). Nothing was typed, or the code would be submit_changed, so the message
                // is queued as one that arrived a moment later would be; the status that check gave the queue stands
                if (typed.ok || typed.code !== "pending_wait") return typed.ok ? { ...typed, sending_at: sendingAt } : typed;
                waited = true;
              }
            }
            if (!waited) pending.observe(message.pane_id, held && !context.working ? "working" : context.pane.agent_status, mark);
            // hold: kept for the owner's Send now, never sent by the turn's end
            const item = pending.enqueue(client, message.pane_id, message.id, text, lease!, context.identity, message.delivery === "hold", agentOnly);
            // read again after the awaits above: the typing may have come, and ended the wait, meanwhile
            if (typedWhileOmpStarted(message.pane_id)) pending.holdQueued(message.pane_id, TYPED_WHILE_WAITING);
            return { ok: true, pending: item.message };
          }).catch((error): SubmitReply => ({ ok: false, ...pendingFault(error) })));
          const answer = await reply;
          const accepted = answer.pending ? pending.get(client, message.pane_id, answer.pending.id)?.message : undefined;
          if (answer.pending && !accepted) replayPendingOutcome(client, message.pane_id, answer.pending.id);
          // refused over a draft as the immediate path is: confirmed for Clear it and send, or Send anyway
          const refusal = answer.refusal;
          if (refusal && (refusal.draft || refusal.box !== null)) {
            let confirmations = draftConfirmations.get(client);
            if (!confirmations) { confirmations = new Map(); draftConfirmations.set(client, confirmations); }
            confirmations.set(message.pane_id, refusal);
          }
          // typed by this very request: a replayed id, or a row gone since (sent or discarded), answers without it
          const typedNow = !previous && answer.ok && answer.pending === undefined;
          result(answer.ok, answer.code, answer.message, accepted, refusal?.draft ?? null, refusal && refusal.box !== null ? shownInputBox(refusal.box) : null,
            typedNow, typedNow ? answer.sending_at : undefined);
          drainPending(message.pane_id);
          return;
        }
        // the PC's clock before this request types anything, for the browser's waiting copy (src/lib/sentWaiting.ts)
        let sendingAt: string | undefined;
        /** this message as queued behind what waits for omp, rather than typed */
        let behind: PendingMessage | undefined;
        const dispatch = async () => {
          // held while this waited its turn (the attach was refused after the check above)
          if (attachments.get(message.pane_id)?.held) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
          // A chat message sent at once while the pane's queue waits for its omp to take input (a new workspace's first
          // message) would wait for the same report with the pane's lane held, and be typed ahead of what waits there.
          // It takes its place behind it instead, as a queue request that finds a message waiting does. And one sent
          // after the terminal was typed into during that start would be pasted behind those words: it is accepted
          // and held, as what waited was. The terminal's input line is the keyboard and goes as typed; a saved copy's
          // Send now is its sender's own choice
          if (message.typed !== true && message.resend_id === undefined && message.clear_draft === undefined && message.send_anyway !== true
            && ((ompWaits.has(message.pane_id) && pending.waiting(message.pane_id)) || typedWhileOmpStarted(message.pane_id))) {
            const lease = pendingLease(client, message.pane_id);
            const context = await pendingContext(client, message.pane_id, lease);
            behind = pending.enqueue(client, message.pane_id, message.id, pendingText(message.text), lease, context.identity, false, agentOnly).message;
            // read after the await: the typing may have come, and ended the wait, while the pane was read
            if (typedWhileOmpStarted(message.pane_id)) pending.holdQueued(message.pane_id, TYPED_WHILE_WAITING);
            return;
          }
          // the terminal's input line is typed as the keyboard types, with no wait for omp: counted as a person's
          // typing before anything of it can be written, so that what waits for a starting omp is held
          if (message.typed === true && ompStarts.has(message.pane_id)) linesTyped.set(message.pane_id, (linesTyped.get(message.pane_id) ?? 0) + 1);
          // A terminal-line send is not an Ovis Chat receipt. For Chat, capture Pi independently of
          // status so an idle/done report during automatic compaction cannot make the bubble vanish.
          const current = message.typed === true ? null : await currentIdentity(message.pane_id);
          if (agentOnly && (current === null || !agentRuns(current.identity, current.recognized))) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
          // a command Pi runs is never recorded as sent, so it gets no receipt that could only fail
          const identity = current === null || (current.identity.agent === "pi" && piRunsCommand(current.pane, framed.text)) ? null : current.identity;
          const reservation = identity === null ? null : reservePiReceipt(client, identity);
          try {
            const receiptText = identity === null ? undefined : piReceiptText(identity, framed.text);
            const piAnchor = identity === null ? null : await preparePiReceipt(message.pane_id, identity).catch(() => null);
            sendingAt = new Date().toISOString();
            await submitText(message.pane_id, framed.text, framed.payload, arrivedAt, message.typed === true, () => authorizeSocket(client), message.clear_draft,
              draftConfirmations.get(client)?.get(message.pane_id), message.send_anyway === true, agentOnly);
            if (identity !== null && receiptText !== undefined) {
              try { recordPiTyped(client, message.pane_id, message.id, receiptText, identity, piAnchor, reservation, current !== null && piListsTemplate(current.pane, framed.text)); } catch { /* The send succeeded; receipt tracking cannot make it retryable. */ }
            }
          } finally { piCapacity.release(reservation); }
        };
        if (message.resend_id !== undefined) {
          authorizeSocket(client);
          const id = message.resend_id, pane = message.pane_id, key = resumeKey(client, pane);
          const hash = new Bun.CryptoHasher("sha256").update(framed.text).digest("hex");
          // typed by this request: a replayed id, or a copy another connection sent, runs no dispatch here
          let typedNow = false;
          // Every check and claim on the receipts runs in the pane's serialized turn, by the original ID: two
          // resends of one copy (any generations) see each other's claim, so the text is typed once.
          const answer = await serialize(pane, async () => {
            // A Send now of this ID is on its way, under whatever ID its pane has by now (a turn is its pane ID's, so
            // a resend that names the pane's new ID after a move does not wait for it): nothing more is typed for it.
            if (completed.some((entry) => entry.id === id && entry.outcome === "sending")) return { ok: false, code: "pending_busy", message: "This message is already being sent" };
            // sent already to this pane (its resend record may have expired): a replay of it never types it again
            if (completed.some((entry) => entry.id === id && entry.outcome === "sent" && entry.paneId === pane && (entry.hash === undefined || entry.hash === hash))) return { ok: true };
            // a Send now of it that may have typed it (its resend record may have expired): not confirmed, for every tab
            if (completed.some((entry) => entry.id === id && entry.outcome === "uncertain" && entry.paneId === pane)) return { ok: false, code: "pending_uncertain", message: "Check the terminal before sending this message again" };
            // the held receipt is this pane's and this browser's to claim, no other's
            const at = completed.findIndex((entry) => entry.id === id && entry.outcome === "held" && entry.paneId === pane && entry.key === key);
            const held = at >= 0 ? completed.splice(at, 1)[0] : undefined;
            // The claim, before anything is typed. It is among the receipts, so a pane move carries it
            // (movePendingPane): what this send ends as is recorded under the ID the pane has then, where the other
            // tabs' copies went, and the held receipt goes back there when nothing was typed.
            const claim: (typeof completed)[number] = { paneId: pane, key: held?.key ?? key ?? "", id, outcome: "sending", at: elapsed() };
            completed.push(claim);
            const settle = (): void => { const at = completed.indexOf(claim); if (at >= 0) completed.splice(at, 1); };
            const restore = (): void => {
              // not for a pane that ended meanwhile: its ID may be another pane's next (holdPendingPane)
              if (!held || claim.gone) return;
              // a move while it was on its way already told its owner's list under the new ID, with a receipt of its own
              if (completed.some((entry) => entry.id === id && entry.outcome === "held")) return;
              held.paneId = claim.paneId;
              // back in its place by age, as pruning drops expired receipts from the front
              const back = completed.findIndex((entry) => entry.at > held.at);
              completed.splice(back < 0 ? completed.length : back, 0, held);
            };
            let sent: Awaited<ReturnType<typeof pending.resend>>;
            try {
              sent = await pending.resend(pane, id, hash, async () => {
                try { await dispatch(); typedNow = true; return { ok: true }; }
                catch (error) { return { ok: false, ...pendingFault(error) }; }
              }, message.resend_generation);
            } catch (error) {
              // refused before anything was typed (its limit, a reused ID): the receipt stays the copy's
              settle();
              restore();
              throw error;
            }
            settle();
            const now = claim.paneId;
            if (sent.ok && (typedNow || held)) {
              // sent, before the turn ends: a later resend finds it so
              if (!completed.some((entry) => entry.id === id && entry.outcome === "sent" && entry.paneId === now)) completed.push({ paneId: now, key: claim.key, id, outcome: "sent", at: elapsed(), hash });
              if (held) pushResumed(client, now, held.key, { removed: [{ id, outcome: "sent", resumed: true }] });
            } else if (!sent.ok && submitNotTyped(sent.code ?? "")) {
              restore();
            } else if (!sent.ok && !completed.some((entry) => entry.id === id && entry.outcome === "uncertain" && entry.paneId === now)) {
              // its Enter may have arrived: remembered for the receipt's whole window, past the resend record's minute,
              // so a tab that still holds its copy on a held receipt is told "not confirmed" and types nothing
              completed.push({ paneId: now, key: claim.key, id, outcome: "uncertain", at: elapsed() });
            }
            prunePi();
            return sent;
          });
          result(answer.ok, answer.code, answer.message, undefined, undefined, undefined, answer.ok && typedNow, typedNow ? sendingAt : undefined);
          return;
        }
        await serialize(message.pane_id, dispatch);
        if (message.clear_draft !== undefined || message.send_anyway) draftConfirmations.get(client)?.delete(message.pane_id);
        result(true, undefined, undefined, behind, undefined, undefined, false, sendingAt);
        if (behind) drainPending(message.pane_id);
      } catch (error) {
        if (message.clear_draft !== undefined || message.send_anyway) draftConfirmations.get(client)?.delete(message.pane_id);
        // a refusal naming a draft confirms it for Clear it and send; one naming none, for Send anyway
        if (error instanceof InputDraftError && error.identity && (error.draft || error.box !== null)) {
          let confirmations = draftConfirmations.get(client);
          if (!confirmations) { confirmations = new Map(); draftConfirmations.set(client, confirmations); }
          confirmations.set(message.pane_id, { draft: error.draft, identity: error.identity, box: error.box });
        }
        const fault = pendingFault(error);
        result(false, fault.code, fault.message, undefined, error instanceof InputDraftError ? error.draft : null,
          error instanceof InputDraftError && error.identity && error.box !== null ? shownInputBox(error.box) : null);
      }
      return;
    },
    async "pending-action"(client: Client, message: Frame<"pending-action">): Promise<void> {
      // a client that does not tell a launch that ended apart takes its code as maybe typed: it gets the code it knows
      const known = ({ unannounced: _, ...reply }: SubmitReply): SubmitReply => reply.code === LAUNCH_GONE.code && message.launch_ended !== true ? { ...reply, code: TARGET_CHANGED.code } : reply;
      const result = (reply: SubmitReply) => send(client, { type: "pending-result", id: message.id, pane_id: message.pane_id, pending_id: message.pending_id, ...known(reply) });
      if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id
        || typeof message.pending_id !== "string" || !message.pending_id || !["steer", "discard"].includes(message.action)) {
        result({ ok: false, code: "invalid_pending_action", message: "Use steer or discard with a pending-message id" }); return;
      }
      if (message.resend_generation !== undefined && (!Number.isSafeInteger(message.resend_generation) || message.resend_generation < 0)) {
        result({ ok: false, code: "invalid_pending_action", message: "A resend generation must be a nonnegative integer" }); return;
      }
      if (message.withdrawal_only !== undefined && (message.withdrawal_only !== true || message.action !== "discard")) {
        result({ ok: false, code: "invalid_pending_action", message: "Withdrawal-only applies to discarding unsent input" }); return;
      }
      const arrivedAt = Date.now();
      try {
        authorizeSocket(client);
        const lease = message.action === "steer" ? pendingLease(client, message.pane_id) : null;
        let marked: PendingItem | undefined;
        if (message.action === "discard") {
          // on its way now: a send that waits for omp ends at its next look, with nothing typed, and this Discard then
          // finds the message held. One past its wait is typed, and this answers with its receipt, as before
          const sending = pending.get(client, message.pane_id, message.pending_id)
            ?? (client.data.attached.has(message.pane_id) ? pending.get(FIRST_MESSAGE_OWNER, message.pane_id, message.pending_id) : undefined);
          if (sending?.inFlight) { marked = sending; withdrawn.add(sending); }
        }
        const answer = await serialize(message.pane_id, async (): Promise<SubmitReply> => {
          // the mark was for the send ahead of this Discard, which has ended: a message this Discard cannot take
          // (its copy is being sent again elsewhere) is not ended by it at a later Send now
          if (marked) withdrawn.delete(marked);
          authorizeSocket(client);
          if (!clients.has(client) || connectionOf(client).closing) throw new HerdrError("disconnected", "This connection closed");
          // A typed Pi receipt is never sendable again. Once its transcript confirmation became
          // unavailable, Discard dismisses only the receipt. It cannot retract terminal input.
          const piReceipt = client.data.attached.has(message.pane_id)
            ? piTyped.get(message.pane_id)?.find((candidate) => candidate.owner === client && candidate.message.id === message.pending_id) : undefined;
          if (piReceipt) {
            if (message.withdrawal_only) return { ok: false, code: "pending_uncertain", message: "This receipt cannot prove withdrawal" };
            if (message.action === "steer") return { ok: false, code: "pending_sent", message: "This message was already sent to Pi" };
            return discardPiReceipt(client, message.pane_id, message.pending_id)
              ? { ok: true } : { ok: false, code: "pending_busy", message: "Pi transcript confirmation is still pending" };
          }
          // a pane's first message is every attached connection's to send now or discard
          const item = pending.get(client, message.pane_id, message.pending_id)
            ?? (client.data.attached.has(message.pane_id) ? pending.get(FIRST_MESSAGE_OWNER, message.pane_id, message.pending_id) : undefined);
          if (!item) return replayPendingOutcome(client, message.pane_id, message.pending_id)
            ? { ok: true } : { ok: false, code: "pending_not_found", message: "This pending message does not belong to this connection" };
          if (message.action === "discard") return pending.discard(item, message.withdrawal_only) ? { ok: true }
            : item.message.state === "uncertain" ? { ok: false, code: "pending_uncertain", message: "Check the terminal before changing this message" }
            : { ok: false, code: "pending_busy", message: "This message is already being sent" };
          if (item.message.state === "uncertain") return { ok: false, code: "pending_uncertain", message: "Check the terminal before sending this message again" };
          let dispatched = false;
          const reply = await pending.resend(item.paneId, item.message.id,
            new Bun.CryptoHasher("sha256").update(item.message.text).digest("hex"), async (): Promise<SubmitReply> => {
              try {
                const bound = await bindLaunched(item);
                if (bound === "wait") return { ok: false, code: "input_not_ready", message: "The agent started for this message is not up yet" };
                if (bound === "ended") return { ok: false, ...LAUNCH_GONE };
                await pendingContext(client, item.paneId, lease!, item.identity);
                if (!pending.claim(item, false)) return { ok: false, code: "pending_busy", message: "This message is already being sent" };
                if (isClient(item.owner)) item.lease = lease!;
                dispatched = true;
                return await dispatchPending(item, false, arrivedAt, true, client);
              } catch (error) { return { ok: false, ...pendingFault(error) }; }
            }, message.resend_generation, (code) => code === "submit_changed");
          // A saved copy may already have completed this ID on another connection.
          if (!dispatched && pending.get(client, item.paneId, item.message.id) === item && pending.claim(item, false))
            pending.settle(item, reply.ok ? undefined : { code: reply.code!, message: reply.message! }, reply.code === "submit_changed");
          // a pane's first message refused because what runs there is not what was launched for it, or that agent
          // ended: its card says so
          if (!dispatched && !isClient(item.owner) && (reply.code === TARGET_CHANGED.code || reply.code === LAUNCH_GONE.code)) pending.rehold(item, { code: reply.code, message: reply.message! });
          takenWithPane(item, arrivedAt);
          // its Discard came while it waited for omp: nothing was typed, and the message goes now, as discarded. This
          // Send now is answered as settled (its receipt says how, as for a replayed one), and so is the Discard after it
          if (reply.code === "pending_discarded" && withdrawn.has(item) && pending.discard(item)) return { ok: true };
          return reply;
        });
        result(answer);
        drainPending(message.pane_id);
      } catch (error) { result({ ok: false, ...pendingFault(error) }); }
      return;
    },
  };

  return { pending, holdPending, holdPendingPane, movePendingPane, drainPending, pendingFrames, queueFirstMessage, attached, closeConnection, reconcilePiDeliveries };
}
