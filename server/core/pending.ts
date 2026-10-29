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
import { closeBackslash, closeMention, type createSubmitText, freeClaudeBox, freeHermesInput, InputDraftError, modelSwitchText, pendingFault, pendingIdentity, pendingText, submitFraming } from "./composer.ts";
import { type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE } from "./terminal-process.ts";
import type { AttachmentView, TerminalSighting } from "./terminals.ts";
import type { ClientMessage, HerdrPane, PendingMessage, SessionSnapshot } from "../../shared/protocol.ts";
import { typingGuards } from "../input-guard.ts";
import { claudeForegroundSession } from "../claude-store.ts";
import { HerdrError, paneProcessInfo, paneRead, paneSendKeys, paneSendText, type ProcessInfo } from "../herdr/client.ts";
import { bindCommandProcess, claudeHeldIsGrey, codexQuestionsCollapsed, isClaudeHeld, heldCandidate, noteSubmitted, parseInteractivePrompt, prepareCommandSend, shownInputBox } from "../prompt.ts";
import { registry } from "../dialogs/registry.ts";
import { secretPrompt } from "../../shared/secret-prompt.ts";
import { PendingInputs, samePendingIdentity, type PendingIdentity, type PendingRecord } from "../pending-input.ts";
import { processStartedAtAsync } from "../process-start.ts";
import { agentProcessInFront } from "../agent-process.ts";
import { capturePiDeliveryAnchorRetrying, matchPiDeliveries, PiReceiptCapacity, type PiDeliveryAnchor, type PiReceiptReservation } from "../pi-delivery.ts";
import { piTranscriptPath, piUnwrittenHeaderId } from "../pi.ts";
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
/** a first message's lease is the delivering connection's, taken at each attempt: none is kept on the record */
type PendingItem = PendingRecord<PendingOwner, PendingLease | null>;
type SubmitReply = { ok: boolean; pending?: PendingMessage; code?: string; message?: string };
type PiTypedReceipt = { owner: Client; resumeKey?: string; message: PendingMessage; identity: PendingIdentity; anchor: PiDeliveryAnchor | null };
/** a first message refused before anything was typed because its connection could not type it yet stays queued for its next attach or turn */
const FIRST_MESSAGE_RETRY_CODES = new Set(["input_not_ready", "pending_lease_lost", "disconnected", "read_only"]);
/** a first message whose page left before it went, or that named none: held for an explicit Send now or Discard */
const FIRST_MESSAGE_UNATTENDED = { code: "first_message_unattended", message: "The page that sent this first message is gone; send it now or discard it" };
/** a message for an agent alone (submit `agent_only`, #511) refused where no agent is in front */
const AGENT_NOT_READY = { code: "agent_not_ready", message: "No agent is in front of this pane now; nothing was typed" };
/** a first message whose pane runs something other than the agent launched for it, found at a pane's event */
const TARGET_CHANGED = { code: "pending_target_changed", message: "The pane's terminal or agent session changed; review the message before sending it again" };
/** a first message whose launched agent came up and left before it went: held for an explicit Send now or Discard */
const LAUNCH_GONE = { code: "first_message_launch_ended", message: "The agent started for this message has ended; review the message before sending it" };
/** receipts of first messages kept per pane, so a connection that attaches later drops a stale copy */
const FIRST_MESSAGE_RECEIPTS = 8;

/**
 * The server's pending messages. `authorizeSocket`, `clientSnapshot`, `omo` and `queueHeld` belong to the
 * connections and the status hub, which are built after this (they take its store), so they are
 * called through: only a frame or a turn calls them, after `createServer` has returned.
 */
export function createPendingDelivery({ options, clients, attachments, sight, serialize, lastTyped, submitText, authorizeSocket, clientSnapshot, omo, queueHeld = () => false, SUBMIT_DEADLINE_MS, SUBMIT_DELAY_MS, TYPED_SETTLE_MS }: {
  options: { pendingStartTimeoutMs?: number; piReceiptLimit?: number; submitDeadlineMs?: number; submitDelayMs?: number; openCodeStateDir?: string };
  clients: Set<Client>;
  attachments: ReadonlyMap<string, AttachmentView>;
  sight: (client: Client, paneId: string) => TerminalSighting;
  serialize: <T>(paneId: string, task: () => T | Promise<T>) => Promise<T>;
  lastTyped: ReadonlyMap<string, number>;
  submitText: ReturnType<typeof createSubmitText>;
  authorizeSocket: (client: Client) => void;
  clientSnapshot: () => Promise<SessionSnapshot>;
  omo: Pick<OmoStatus, "sessionOf">;
  /** a pane shown at rest whose queue a busy signal still holds (server/core/status.ts queueStatus): no automatic send */
  queueHeld?: (paneId: string) => boolean;
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
    if (isClient(owner)) { send(owner, { type: "pending-messages", pane_id: paneId, messages, ...(removed ? { removed } : {}) }); return; }
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
  const resumeKey = (client: Client, paneId: string): string | undefined => {
    const id = client.data.attached.get(paneId)?.receiptResumeId;
    return id ? JSON.stringify([client.data.deviceId ?? null, id]) : undefined;
  };
  const prunePi = (): void => {
    const cutoff = Date.now() - PI_RESUME_MS;
    while (piCompleted.length && (piCompleted[0]!.at < cutoff || piCompleted.length > PI_RESUME_LIMIT)) piCompleted.shift();
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
    reservation?: PiReceiptReservation<Client> | null): void => {
    if (anchor === undefined || !clients.has(owner) || connectionOf(owner).closing) return;
    if (anchor === null) piCapacity.release(reservation);
    else if (!piCapacity.retain(owner, reservation)) return;
    prunePi();
    const receipt: PiTypedReceipt = {
      owner, resumeKey: resumeKey(owner, paneId), identity: { ...identity }, anchor,
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
      const candidates = matching.map((item) => ({ id: item.message.id, text: item.message.text, anchor: item.anchor }));
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
  async function currentIdentity(paneId: string, bound: number | null = null): Promise<{ pane: HerdrPane; identity: PendingIdentity; shellPid: number | null; processes: ProcessInfo | undefined;
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
      return { pid: agentProcessInFront(info, base.agent, bound, held?.pid)?.pid ?? info?.foreground_processes?.[0]?.pid ?? null, held };
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
        return { pane, shellPid: after?.shell_pid ?? null, processes: after, held: processHeld, identity: {
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
  async function stillInFront(paneId: string, pid: number | null | undefined, pinned: PendingIdentity | null = null): Promise<void> {
    const inFront = async (): Promise<NonNullable<ProcessInfo["foreground_processes"]>> => {
      const foreground = (await paneProcessInfo(paneId))?.foreground_processes ?? [];
      if (pid != null && !foreground.some((entry) => entry.pid === pid)) throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
      return foreground;
    };
    // /clear and /resume switch Claude's session in the same process, so its PID in front says nothing of the
    // session the message is pinned to: that is read from Claude's own records (once more for a record caught being
    // rewritten), and the process is then asked for again, as one that left the front still alive keeps its record
    // (#2279). Neither can be compared in the write's own call: a switch during that last herdr read is not seen
    const session = pinned?.agent === "claude" ? pinned.claudeSession ?? null : null;
    if (pid == null && session === null) return;
    const foreground = await inFront();
    if (session === null) return;
    if ((await claudeForegroundSession(foreground) ?? await claudeForegroundSession(foreground)) !== session) throw new HerdrError(TARGET_CHANGED.code, TARGET_CHANGED.message);
    await inFront();
  }
  async function pendingContext(owner: Client, paneId: string, lease: PendingLease, identity?: PendingIdentity, pasted = false): Promise<{ pane: HerdrPane; identity: PendingIdentity; working: boolean; screen: string; processes: ProcessInfo | undefined; held: { pid: number; started: number | null } | null }> {
    authorizePending(owner, paneId, lease);
    let { pane, identity: current, processes, held: holder } = await currentIdentity(paneId, identity?.processPid ?? null);
    // a Claude session known before and unknown now (its PID record or its job's state cannot be read) may be
    // another one: nothing is typed for it (#2125). It is read once more first, as a record being rewritten
    // fails only for a moment. After this delivery's own paste too: an Enter for a session that cannot be told
    // may commit the paste in another one, so the message is left uncertain without it (#2279). A session
    // learned only now is a match
    const unknown = (): boolean => identity?.claudeSession != null && current.claudeSession == null;
    if (unknown()) ({ pane, identity: current, processes, held: holder } = await currentIdentity(paneId, identity?.processPid ?? null));
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
    if (current.agent && (waits || registry.waits(current.agent, screen) || (pane.agent_status === "blocked" && !collapsed))) {
      throw new HerdrError("agent_blocked", "The agent is waiting for an answer in the terminal");
    }
    if (current.agent && !["working", "idle", "done"].includes(pane.agent_status) && !collapsed) {
      throw new HerdrError("agent_not_ready", "The agent's current input state is not known");
    }
    // the screen and card reads above awaited: what they were read for must still be in front
    await stillInFront(paneId, current.processPid, identity ?? null);
    authorizePending(owner, paneId, lease);
    return { pane, identity: current, working: current.agent !== null && (pane.agent_status === "working" || collapsed), screen, processes, held: holder };
  }
  /**
   * The live screen for claudeInputDraft, and the viewport's colors when viewportShowsLive verifies
   * they show it. Read last, the live screen holds anything typed meanwhile. An empty box (or none)
   * needs no colors.
   */

  async function dispatchPendingText(owner: Client, paneId: string, text: string, lease: PendingLease, identity: PendingIdentity,
    automatic: boolean, arrivedAt: number, committing: (working: boolean, restarting?: boolean) => void = () => {}, interruptWorkingCodex = false,
    requestId = 0): Promise<SubmitReply> {
    let wrote = false;
    let watch: OpenCodeWatch | null = null;
    let piReservation: PiReceiptReservation<Client> | null = null;
    // what the checks below read is older than a status event that arrives while they run
    let mark = pending.mark(paneId);
    try {
      const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
      // fixed wait: herdr holds a lone ESC typed into the pty ~150ms, so a Stop tapped just before reaches the pane first
      if (typed < TYPED_SETTLE_MS) await Bun.sleep(TYPED_SETTLE_MS - typed);
      mark = pending.mark(paneId);
      const context = await pendingContext(owner, paneId, lease, identity);
      const sent = closeBackslash(context.identity.agent, modelSwitchText(context.identity.agent, text));
      piReservation = reservePiReceipt(owner, context.identity);
      const receiptText = piReceiptText(context.identity, text);
      if (automatic && (context.working || queueHeld(paneId))) {
        pending.observe(paneId, "working", mark);
        throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
      }
      // a draft typed in the terminal is the user's: the paste would join it and the Enter send both (#609).
      // The box is the live screen's; only the viewport read tells Claude's grey text from a draft. The live
      // read comes after the colors, so text typed between the two is in the box and holds the message.
      if (context.identity.agent === "claude") await freeClaudeBox(paneId, context.working, () => authorizePending(owner, paneId, lease), arrivedAt + (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS));
      else if (context.identity.agent === "hermes") context.screen = await freeHermesInput(paneId, context.identity);
      // OpenCode v2 attaches a skill only through its autocomplete, never from a paste. A first message
      // goes before any Chat read the pane's catalog: the cold send's catalog (bounded reads, within the
      // catalog budget, at the pane's own version) is openCodeSkillsToType's, as for any other send
      const opencode = await openCodeSkillsToType(context.pane, prepareCommandSend(context.pane, text, context.screen), text, context.screen, options.openCodeStateDir);
      let command = opencode.sent;
      // the process this message goes to, from the identity read above: recording reads nothing more before the write,
      // and an OmO's holder is the one checked there, never read again (#2190)
      bindCommandProcess(paneId, command, context.processes, context.pane, context.identity.agent === "omo" ? context.held : undefined);
      const skills = opencode.skills;
      let attached: string[] = [];
      let prompt: PromptPiece[] = [{ pasted: closeMention(sent) }];
      // followed from before the first key: the send's own message can be announced before Enter returns
      watch = startOpenCodeWatch(context.pane, command, options.openCodeStateDir);
      if (Date.now() - arrivedAt > (options.submitDeadlineMs ?? SUBMIT_DEADLINE_MS)) throw new HerdrError("submit_timeout", "The pending message waited too long; nothing was typed");
      // the input-box checks and the catalog above awaited after the check: what it was made for must still be in front
      await stillInFront(paneId, context.identity.processPid, identity);
      authorizePending(owner, paneId, lease);
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
          if (automatic && !typed && (current.working || queueHeld(paneId))) throw new HerdrError("pending_wait", "The agent is working again; this message still waits for its next turn");
        };
        const result = await typeWithSkills(text, skills, typing, herdrSkillAttachIo(paneId), revalidate).catch((error: unknown) => {
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
      let beforeEnter = await pendingContext(owner, paneId, lease, identity, true);
      if (automatic && (beforeEnter.working || queueHeld(paneId))) throw new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed");
      authorizePending(owner, paneId, lease);
      // Capture Pi's exact active transcript position before Enter. Status is deliberately not
      // evidence: Pi can report idle/done while its TUI is staging an automatic-compaction input.
      const beforeCapturePid = beforeEnter.identity.processPid;
      const piAnchor = await preparePiReceipt(paneId, beforeEnter.identity).catch(() => null);
      if (piAnchor !== undefined) {
        beforeEnter = await pendingContext(owner, paneId, lease, identity, true);
        if (automatic && (beforeEnter.working || queueHeld(paneId))) throw new HerdrError("pending_wait", "The agent started another turn before this queued message could be committed");
        await stillInFront(paneId, beforeCapturePid);
      }
      const steering = !automatic && beforeEnter.working;
      committing(steering);
      // Claude Code queues what Enter commits during a turn; Ctrl+Enter sends it now (#737). herdr
      // encodes the key as the pane asked, and as a plain CR for a program that asked for nothing.
      const sentAt = Date.now();
      await paneSendKeys(paneId, [steering && beforeEnter.identity.agent === "claude" ? "ctrl+enter" : "Enter"], undefined, allowed);
      // This proves only that Ovis committed Enter to Pi, not that Pi accepted, queued or recorded
      // the message. Keep a non-resendable receipt until the bound JSONL active branch appends it.
      if (receiptText !== undefined) {
        try { recordPiTyped(owner, paneId, requestId, receiptText, beforeEnter.identity, piAnchor, piReservation); } catch { /* Enter already succeeded; receipt tracking is best-effort. */ }
      }
      // the status the panel was read under; a status event since (a finish, an approval) stales the Escape
      let statusAtRead = pending.current(paneId);
      await interruptCodexSteering(interruptWorkingCodex, closeMention(text), { agent: beforeEnter.identity.agent, working: beforeEnter.working, screen: beforeEnter.screen }, {
        read: async () => {
          const current = await pendingContext(owner, paneId, lease, identity, true);
          statusAtRead = pending.current(paneId);
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
      const fault = error instanceof HerdrError && error.code === "submit_changed" ? pendingFault(error)
        : wrote ? { code: "submit_changed", message: "Pending-message delivery could not be confirmed. Check the terminal before sending again." } : pendingFault(error);
      if (automatic && !wrote && fault.code === "agent_blocked") pending.observe(paneId, "blocked", mark);
      return { ok: false, ...fault };
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
        automatic, arrivedAt, (working, restarting) => pending.committing(item, working, restarting), interruptWorkingCodex, item.message.request_id);
    } catch (error) {
      reply = { ok: false, ...pendingFault(error) };
    }
    const code = reply.code ?? "";
    // a first message its page could not type yet stays queued for that page's next attach or turn. One whose
    // page left or closed during its own automatic send is held as at that leaving, never retried: no page is
    // left to type it, and queued again it would head the pane's queue ahead of the other devices' messages
    const requester = requesters.get(item);
    const unattended = automatic && !isClient(item.owner) && (requester === undefined || !present(requester));
    const retryable = ["pending_wait", "agent_blocked"].includes(code) || (!isClient(item.owner) && FIRST_MESSAGE_RETRY_CODES.has(code));
    const fault = reply.ok ? undefined : unattended && retryable ? FIRST_MESSAGE_UNATTENDED : { code: reply.code!, message: reply.message! };
    pending.settle(item, fault, reply.code === "submit_changed", automatic && retryable && !unattended);
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
      if (!pending.claim(item, true)) return;
      dispatched = true;
      await dispatchPending(item, true, arrivedAt, false, by);
    }).catch((error) => console.warn("pending message:", pendingFault(error).code)).finally(() => {
      pendingDrains.delete(paneId);
      const again = drainAgain.delete(paneId);
      if (dispatched || again) drainPending(paneId);
    });
  }
  const drainAgain = new Set<string>();
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
      // it is not the shell: a replacement of the same kind is not what the message was sent to. Right after
      // a launch herdr may name no agent yet; that binding is completed when it does (bindLaunched)
      const { pane, identity, shellPid, processes } = await currentIdentity(paneId, launchedPid);
      // The launch's own word wins: a shell-started agent's launch says which process it came up as, which
      // may have ended already, and then an agent the user starts later is not the one launched
      const launchedProcess = launchedPid !== null
        ? { processPid: launchedPid, processBirth: identity.processPid === launchedPid ? identity.processBirth : await processStartedAtAsync(launchedPid) }
        : identity.processPid !== null && identity.processPid !== undefined && identity.processPid !== shellPid
          ? { processPid: identity.processPid, processBirth: identity.processBirth } : {};
      // and to the sessions herdr, OmO or Claude's own record already name for that agent: a /resume
      // before the message went is another session
      const sessions = identity.agent === kind
        ? { session: identity.session, omoSession: identity.omoSession ?? null, claudeSession: identity.claudeSession ?? null } : { session: null };
      const item = pending.enqueue(FIRST_MESSAGE_OWNER, paneId, nextFirstRequestId--, text, null,
        { agent: kind, terminalId: pane.terminal_id, ...sessions, ...launchedProcess });
      launchBound.add(item);
      // this read learns as an event's would: an agent it sees in front under its kind is named before it can leave
      learn(item, identity, shellPid, processes);
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
  function learn(item: PendingItem, identity: PendingIdentity, shellPid: number | null, processes: ProcessInfo | undefined): void {
    if (identity.terminalId !== item.identity.terminalId || identity.agent !== item.identity.agent || !samePendingIdentity(item.identity, identity)) return;
    item.identity.session ??= identity.session;
    // the shell itself is never the launched process: with it still in front, the launch is not known yet
    if (identity.processPid !== shellPid) {
      item.identity.processPid ??= identity.processPid;
      item.identity.processBirth ??= identity.processBirth;
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
      const { identity, shellPid, processes } = await currentIdentity(paneId, item.identity.processPid ?? null);
      // its agent came up and left, or what herdr names there is not what was launched for it: held at once, as
      // pendingContext would hold it at a send, which a pane that is not at rest never gets to
      if (launchGone(item, identity, shellPid, processes)) holdFor(item, LAUNCH_GONE);
      else if (targetChanged(item, identity)) holdFor(item, TARGET_CHANGED);
      else learn(item, identity, shellPid, processes);
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
    const { identity, shellPid, processes } = await currentIdentity(item.paneId, item.identity.processPid ?? null);
    if (launchGone(item, identity, shellPid, processes)) return "ended";
    if (identity.terminalId === item.identity.terminalId && identity.agent === null) return "wait";
    learn(item, identity, shellPid, processes);
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
    pending.close(client);
    holdRequested(client);
    requested.delete(client);
    // Keep bounded presentation-only receipts across transient loss, not input authority.
    // Revocation/read-only transitions do not retain a resumable presentation.
    let resumable = true;
    try { authorizeSocket(client); } catch { resumable = false; }
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
        const removed = piCompleted.filter((item) => item.paneId === paneId && item.key === key)
          .map(({ id }) => ({ id, outcome: "consumed" as const }));
        if (removed.length) send(client, { type: "pending-messages", pane_id: paneId, messages: [], removed });
      } catch { /* failed authorization cannot resume even presentation */ }
    }
    return rebound;
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
      const result = (ok: boolean, code?: string, text?: string, accepted?: PendingMessage, draft?: string | null, box?: string | null) => send(client, {
        type: "submit-result", id: message.id, pane_id: message.pane_id, ok, ...(accepted ? { pending: accepted } : {}), ...(code ? { code, message: text } : {}),
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
            if (agentOnly && context.identity.agent === null) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
            // a pane shown at rest whose queue a busy signal still holds is not ready for a queued message
            const held = queueHeld(message.pane_id);
            if (!context.working && !held) {
              // the agent left while the message was on its way: a chat follow-up is not typed into what is there now
              if (context.identity.agent === null) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
              // A request that raced the turn's finish still needs cancellable
              // paste + Enter; agent.prompt commits its key inside herdr. With a message
              // already waiting its turn here, this one takes its place behind it instead.
              // A held message is never typed by arriving after the turn: it waits for Send now.
              if (message.delivery === "queue" && !pending.waiting(message.pane_id)) return dispatchPendingText(client, message.pane_id, text, lease!, context.identity, false, arrivedAt, undefined, false, message.id);
            }
            pending.observe(message.pane_id, held && !context.working ? "working" : context.pane.agent_status, mark);
            // hold: kept for the owner's Send now, never sent by the turn's end
            const item = pending.enqueue(client, message.pane_id, message.id, text, lease!, context.identity, message.delivery === "hold", agentOnly);
            return { ok: true, pending: item.message };
          }).catch((error): SubmitReply => ({ ok: false, ...pendingFault(error) })));
          const answer = await reply;
          const accepted = answer.pending ? pending.get(client, message.pane_id, answer.pending.id)?.message : undefined;
          if (answer.pending && !accepted) replayPendingOutcome(client, message.pane_id, answer.pending.id);
          result(answer.ok, answer.code, answer.message, accepted);
          drainPending(message.pane_id);
          return;
        }
        const dispatch = async () => {
          // held while this waited its turn (the attach was refused after the check above)
          if (attachments.get(message.pane_id)?.held) throw new HerdrError("attach_held", ATTACH_HELD_MESSAGE);
          // A terminal-line send is not an Ovis Chat receipt. For Chat, capture Pi independently of
          // status so an idle/done report during automatic compaction cannot make the bubble vanish.
          const identity = message.typed === true ? null : (await currentIdentity(message.pane_id)).identity;
          if (agentOnly && identity?.agent == null) throw new HerdrError(AGENT_NOT_READY.code, AGENT_NOT_READY.message);
          const reservation = identity === null ? null : reservePiReceipt(client, identity);
          try {
            const receiptText = identity === null ? undefined : piReceiptText(identity, framed.text);
            const piAnchor = identity === null ? null : await preparePiReceipt(message.pane_id, identity).catch(() => null);
            await submitText(message.pane_id, framed.text, framed.payload, arrivedAt, message.typed === true, () => authorizeSocket(client), message.clear_draft,
              draftConfirmations.get(client)?.get(message.pane_id), message.send_anyway === true, agentOnly);
            if (identity !== null && receiptText !== undefined) {
              try { recordPiTyped(client, message.pane_id, message.id, receiptText, identity, piAnchor, reservation); } catch { /* The send succeeded; receipt tracking cannot make it retryable. */ }
            }
          } finally { piCapacity.release(reservation); }
        };
        if (message.resend_id !== undefined) {
          authorizeSocket(client);
          const answer = await serialize(message.pane_id, () => pending.resend(message.pane_id, message.resend_id!,
            new Bun.CryptoHasher("sha256").update(framed.text).digest("hex"), async () => {
              try { await dispatch(); return { ok: true }; }
              catch (error) { return { ok: false, ...pendingFault(error) }; }
            }, message.resend_generation));
          result(answer.ok, answer.code, answer.message);
          return;
        }
        await serialize(message.pane_id, dispatch);
        if (message.clear_draft !== undefined || message.send_anyway) draftConfirmations.get(client)?.delete(message.pane_id);
        result(true);
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
      const known = (reply: SubmitReply): SubmitReply => reply.code === LAUNCH_GONE.code && message.launch_ended !== true ? { ...reply, code: TARGET_CHANGED.code } : reply;
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
        const answer = await serialize(message.pane_id, async (): Promise<SubmitReply> => {
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
          return reply;
        });
        result(answer);
        drainPending(message.pane_id);
      } catch (error) { result({ ok: false, ...pendingFault(error) }); }
      return;
    },
  };

  return { pending, holdPending, holdPendingPane, drainPending, pendingFrames, queueFirstMessage, attached, closeConnection, reconcilePiDeliveries };
}
