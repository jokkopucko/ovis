/**
 * Each pane's terminal and who shows it: the attachment every client of a pane shares, the one
 * still being created, the one whose process is still exiting, and the output each client is
 * sent. The pane's agent conversation is watched while a client that shows the pane asks for it.
 */
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";
import { RECEIPT_RESUME_ID } from "../../shared/receipt-resume.ts";
import { ConversationMonitor } from "../conversation-monitor.ts";
import { CoreAttachSession } from "../herdr-core/attach-session.ts";
import { type SightingFacts, sightingFacts } from "../input-guard.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS, OutputWindow, wireBytes } from "../output-window.ts";
import { backlog, type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE, createSpawnAttachment, type PaneAttachment } from "./terminal-process.ts";

/** joins this close together share one repaint: a reconnect brings every tab back at once */
const REPAINT_COALESCE_MS = 50;
/**
 * The least time between two repaints of one pane: each costs every client of it a whole screen,
 * and a joiner in the cooldown is served by the next one instead (a flapping phone, quick switches).
 */
const REPAINT_MIN_INTERVAL_MS = 1000;

type Frame<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

/** What the server outside the registry reads of a pane's attachment: its grid, and whether another web bridge holds its terminal. */
export type AttachmentView = { readonly cols: number; readonly rows: number; readonly held?: boolean };

/**
 * What a connection saw of a pane's terminal before an await, held as references and never
 * copied: `facts()` compares them with the pane's terminal now, so an attach or a session that
 * replaced the one seen never passes for it.
 */
export interface TerminalSighting {
  /**
   * The attachment the connection was in when it saw the pane, that attachment's session, and the
   * connection's claim then. For comparing two sightings with `===` only.
   */
  readonly origin: unknown;
  readonly pty: unknown;
  readonly claim: unknown;
  facts(): SightingFacts;
  /**
   * Writes into the session seen, as typing into its pty does (a mirror sends it through herdr).
   * `automatic`: the viewer's terminal made the bytes itself; only a herdr-core stream can tell hc so.
   */
  write(data: string, automatic?: boolean): boolean | void;
}

/** Clamp surface for the shared pty, mirroring the sidecar's own limits. */
export function validGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
    return null;
  }
  if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return null;
  return { cols, rows };
}

/**
 * The server's terminals. `stopped` is read through a getter, as `stop()` sets it later, and `end`
 * is called through one, as the connections are built after the terminals.
 */
export function createTerminalRegistry({ options, clients, stopped, terminalAttach, holdFor, heldRetry, retryFor, relookupFor, holdPending, holdPendingPane, attached, transcriptChanged, inputReady, end }: {
  options: { codexHome?: string; devinDbPath?: string; opencodeDb?: string; hermesHome?: string; grokHome?: string; museData?: string };
  clients: Set<Client>;
  stopped: () => boolean;
  terminalAttach: () => Promise<boolean>;
  holdFor: number;
  heldRetry: number;
  retryFor: number;
  relookupFor: number;
  holdPending: (owner: Client, paneId?: string) => void;
  holdPendingPane: (paneId: string, fault: { code: string; message: string }) => void;
  /** a connection joined the pane's attachment: the pending messages queued for the pane are told to it, and may go through it */
  attached: (client: Client, paneId: string) => void;
  /** a native transcript changed: reconcile Ovis-origin Pi receipts before notifying readers */
  transcriptChanged?: (paneId: string) => void;
  /** the pane's terminal takes input again: a pending message waiting for a typist may go now */
  inputReady: (paneId: string) => void;
  end: (client: Client, reason: "stalled" | "revoked" | "closed") => void;
}) {
  const attachments = new Map<string, PaneAttachment>();

  /** attachments still resolving their terminal, so concurrent attaches share one pty */
  const pendingAttachments = new Map<string, Promise<PaneAttachment>>();
  // herdr releases its exclusive attach slot only after the old process exits.
  const retiringAttachments = new Map<string, Promise<void>>();

  const conversations = new ConversationMonitor((paneId, signature) => {
    transcriptChanged?.(paneId);
    for (const client of clients) {
      if (!connectionOf(client).closing && client.readyState === WebSocket.OPEN && client.data.attached.has(paneId) && client.data.conversationInterests.has(paneId)) {
        send(client, { type: "conversation-changed", pane_id: paneId, signature });
      }
    }
  }, options.codexHome, options.devinDbPath, options.opencodeDb, options.hermesHome, options.grokHome, options.museData);

  function releaseConversation(paneId: string): void {
    for (const client of clients) {
      if (!connectionOf(client).closing && client.readyState === WebSocket.OPEN && client.data.attached.has(paneId) && client.data.conversationInterests.has(paneId)) return;
    }
    conversations.unwatch(paneId);
  }

  function reconcileOutput(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment?.process) return;
    let paused = false;
    for (const client of attachment.clients) {
      const window = client.data.output.get(paneId);
      const buffered = backlog(client);
      if (window) {
        // an ACK client: measured by its ACK progress, and a joiner draining its replay never pauses the pty
        const verdict = window.check(buffered, Date.now(), client.getBufferedAmount() - buffered);
        if (verdict === "stop") end(client, "stalled");
        else if (verdict === "pause") paused = true;
        continue;
      }
      // a client without ACKs has only its transport queue to go by
      const blocked = buffered >= OUTPUT_HIGH_BYTES;
      if (!blocked) {
        attachment.stalled.delete(client);
        continue;
      }
      const since = attachment.stalled.get(client) ?? Date.now();
      attachment.stalled.set(client, since);
      if (Date.now() - since >= OUTPUT_STALL_MS || buffered >= OUTPUT_HARD_BYTES) {
        end(client, "stalled");
      } else {
        paused = true;
      }
    }
    if (attachments.get(paneId) !== attachment) return;
    if (paused) attachment.process.pause();
    else attachment.process.resume();
  }

  function sendOutput(client: Client, paneId: string, data: string, replay = false): void {
    const window = client.data.output.get(paneId);
    const bytes = Buffer.byteLength(data);
    if ((window && window.pending + bytes > OUTPUT_HARD_BYTES) || backlog(client) >= OUTPUT_HARD_BYTES) {
      end(client, "stalled");
      return;
    }
    send(client, {
      type: "pty-data", pane_id: paneId, data,
      ...(window ? { flow: { stream_id: window.id, offset: window.write(bytes, wireBytes(data)) } } : {}),
      ...(replay ? { replay: true as const } : {}),
    });
  }

  function broadcast(paneId: string, message: ServerMessage): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const client of attachment.clients) send(client, message);
  }

  const { spawnAttachment } = createSpawnAttachment({ attachments, retiringAttachments, terminalAttach, isStopped: stopped, closeAttachment, broadcast, sendOutput, reconcileOutput, holdPendingPane, inputReady, holdFor, heldRetry, retryFor, relookupFor });

  function closeAttachment(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const member of attachment.clients) holdPending(member, paneId);
    attachments.delete(paneId);
    clearTimeout(attachment.retry);
    clearTimeout(attachment.relookup);
    clearTimeout(attachment.recovery);
    clearTimeout(attachment.repaint);
    // its members hold nothing on this pane any more (a pty that exited leaves them on
    // the "terminal ended" screen): a stale entry would read as a live claim in
    // releaseUnclaimed and keep a later, empty pty on this pane running
    for (const member of attachment.clients) member.data.attached.delete(paneId);
    for (const member of attachment.clients) member.data.conversationInterests.delete(paneId);
    for (const member of attachment.clients) member.data.output.delete(paneId);
    releaseConversation(paneId);
    const retired = attachment.process.exited.finally(() => {
      if (retiringAttachments.get(paneId) === retired) retiringAttachments.delete(paneId);
    });
    retiringAttachments.set(paneId, retired);
    attachment.process.kill();
  }

  /**
   * herdr moved the pane under a new ID: the attach made as `from` ends for its clients (`pty-exit`), and the
   * first attach as `to` waits for that process to exit, as it holds herdr's one attach slot until then (#1503).
   */
  function paneMoved(from: string, to: string): void {
    if (from === to) return;
    // what `from` still retires: an earlier move's wait carried to it included, so A to B to C waits for A
    const retire = (): Promise<void> | undefined => {
      if (attachments.has(from)) {
        broadcast(from, { type: "pty-exit", pane_id: from, code: null });
        closeAttachment(from);
      }
      return retiringAttachments.get(from);
    };
    // one still being created ends once it is; the new ID waits for that from now, not from then
    const creating = pendingAttachments.get(from);
    const exited = creating ? creating.then(retire, () => retiringAttachments.get(from)) : retire();
    if (!exited) return;
    const earlier = retiringAttachments.get(to);
    // a process that failed to exit cleanly still let go: the wait never refuses the attach behind it
    const waited: Promise<void> = Promise.all([earlier, exited]).then(() => undefined, () => undefined).finally(() => {
      if (retiringAttachments.get(to) === waited) retiringAttachments.delete(to);
    });
    retiringAttachments.set(to, waited);
  }

  /** An interact client's terminal sizes the pty: the grid is remembered as this client's, and it drives. */
  function drivePty(paneId: string, client: Client, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    const claim = client.data.attached.get(paneId);
    if (claim) claim.keepSize = false;
    if (attachment && attachment.kind !== "mirror") {
      attachment.grids.delete(client);
      attachment.grids.set(client, { cols, rows });
      attachment.driver = client;
    }
    resizePty(paneId, cols, rows);
  }

  /**
   * herdr's attach stream is a diff against the screen it last sent: what a program drew once
   * (btop's boxes and titles) is gone from a tail that its later updates filled, and a client
   * joining with that tail alone never saw it. Told its window changed (SIGWINCH, the size kept),
   * `herdr terminal attach` sends the whole screen again; every client gets it, as any output.
   */
  function requestRepaint(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (!attachment || attachment.kind === "mirror" || attachment.repaint) return;
    const cooldown = attachment.repaintedAt === undefined ? 0 : attachment.repaintedAt + REPAINT_MIN_INTERVAL_MS - Date.now();
    attachment.repaint = setTimeout(() => {
      attachment.repaint = undefined;
      if (attachments.get(paneId) !== attachment || !attachment.ready || attachment.held) return;
      attachment.repaintedAt = Date.now();
      attachment.process.winch();
    }, Math.max(REPAINT_COALESCE_MS, cooldown));
  }

  function resizePty(paneId: string, cols: number, rows: number): void {
    const attachment = attachments.get(paneId);
    // a mirrored pane's grid is herdr's own: no browser resizes it
    if (!attachment || attachment.kind === "mirror" || (attachment.cols === cols && attachment.rows === rows)) return;
    attachment.cols = cols;
    attachment.rows = rows;
    attachment.resizes = (attachment.resizes ?? 0) + 1;
    attachment.resizedTo = [...(attachment.resizedTo ?? []).slice(-15), `${cols}x${rows}`];
    attachment.process.resize(cols, rows);
    // herdr redraws the whole screen for a new size: a repaint still waiting would send it twice
    clearTimeout(attachment.repaint);
    attachment.repaint = undefined;
    attachment.repaintedAt = Date.now();
    broadcast(paneId, { type: "pane-geometry", pane_id: paneId, cols, rows });
  }

  function ensureAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    const existing = attachments.get(paneId);
    if (existing) return Promise.resolve(existing);
    // a second attach arriving while the first is still resolving the terminal joins
    // that creation: two creations would spawn two ptys, and the orphaned one keeps
    // streaming into the surviving attachment and kills it when it exits
    const pending = pendingAttachments.get(paneId);
    if (pending) return pending;

    const created = spawnAttachment(paneId, cols, rows, forObserver).finally(() => pendingAttachments.delete(paneId));
    pendingAttachments.set(paneId, created);
    return created;
  }

  function detach(paneId: string, client: Client): void {
    holdPending(client, paneId);
    client.data.conversationInterests.delete(paneId);
    client.data.output.delete(paneId);
    releaseConversation(paneId);
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    attachment.clients.delete(client);
    attachment.stalled.delete(client);
    attachment.grids.delete(client);
    if (attachment.kind === "mirror") attachment.unscreened.delete(client);
    if (attachment.driver === client) attachment.driver = undefined;
    if (attachment.clients.size === 0) closeAttachment(paneId);
    else reconcileOutput(paneId);
  }

  /** An ending connection leaves its panes while its claims still count, then drops them (dropClaims). */
  function detachClaimed(client: Client): void {
    for (const paneId of client.data.attached.keys()) detach(paneId, client);
  }

  function dropClaims(client: Client): void {
    client.data.attached.clear();
    client.data.conversationInterests.clear();
    client.data.output.clear();
  }

  /**
   * Closes an attachment whose creating client detached or disconnected before it was
   * ready, unless a client still wants it: every attach records its pane in
   * `attached` before awaiting, so a joiner of the same creation that has not resumed
   * yet still counts and is not left holding a dead record.
   */
  function releaseUnclaimed(paneId: string, attachment: PaneAttachment): void {
    if (attachments.get(paneId) !== attachment || attachment.clients.size > 0) return;
    for (const other of clients) if (other.data.attached.has(paneId)) return;
    closeAttachment(paneId);
  }

  /** What `client` sees of the pane's terminal now, for the checks it makes after an await. */
  function sight(client: Client, paneId: string): TerminalSighting {
    const attachment = attachments.get(paneId);
    const member = attachment?.clients.has(client) === true;
    const process = attachment?.process;
    const claim = client.data.attached.get(paneId);
    const seen = { attachment, process, claim, member };
    return {
      origin: member ? attachment : undefined,
      pty: member ? process : undefined,
      claim,
      facts: () => sightingFacts(seen, { attachment: attachments.get(paneId), claim: client.data.attached.get(paneId) }, client),
      write: (data, automatic) => process instanceof CoreAttachSession ? process.write(data, automatic) : process!.write(data),
    };
  }

  /** Something was typed into the pane: a mirrored screen is read at once for its echo, not at its next idle read. */
  function poke(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (attachment?.kind === "mirror") attachment.process.poke();
  }

  /** A connection whose transport queue drained: its panes' output may flow again. */
  function drainOutput(client: Client): void {
    for (const paneId of client.data.attached.keys()) reconcileOutput(paneId);
  }

  /** The terminal frames a connection sends, each handled as its `case` in the socket's frame switch was. */
  const terminalFrames = {
    async attach(client: Client, message: Frame<"attach">): Promise<void> {
      if (message.flow_control !== undefined && message.flow_control !== "ack") {
        send(client, { type: "error", code: "invalid_flow_control", message: "flow_control must be ack" });
        return;
      }
      const geometry = validGeometry(message.cols, message.rows);
      if (!geometry) {
        send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
        return;
      }
      // record the pane before the await: a detach (switching panes) or a close
      // that lands while the terminal is looked up must cancel this attach, and
      // neither can see a client that only joins the attachment afterwards
      const claim = client.data.attached.get(message.pane_id) ?? { keepSize: false };
      claim.keepSize = message.keep_size === true;
      // An opaque, bounded presentation correlator only: never used by input guards.
      if (typeof message.receipt_resume_id === "string" && RECEIPT_RESUME_ID.test(message.receipt_resume_id)) claim.receiptResumeId = message.receipt_resume_id;
      if (!client.data.attached.has(message.pane_id)) client.data.attached.set(message.pane_id, claim);
      let attachment: PaneAttachment;
      try {
        // a covered grid (keep_size) creates the pty at the pane's own size, as an observer does
        attachment = await ensureAttachment(message.pane_id, geometry.cols, geometry.rows, connectionOf(client).mode === "observe" || message.keep_size === true);
      } catch (error) {
        if (client.data.attached.get(message.pane_id) === claim) {
          client.data.attached.delete(message.pane_id);
          client.data.conversationInterests.delete(message.pane_id);
          releaseConversation(message.pane_id);
        }
        throw error;
      }
      if (stopped() || connectionOf(client).closing || client.data.attached.get(message.pane_id) !== claim) {
        releaseUnclaimed(message.pane_id, attachment);
        return;
      }
      // A pane that ended during creation must not gain clients or revive interest.
      if (attachments.get(message.pane_id) !== attachment) {
        client.data.attached.delete(message.pane_id);
        client.data.conversationInterests.delete(message.pane_id);
        releaseConversation(message.pane_id);
        send(client, { type: "pty-exit", pane_id: message.pane_id, code: null });
        return;
      }
      // An idempotent attach must not replay terminal bytes a second time.
      const alreadyAttached = attachment.clients.has(client);
      attachment.clients.add(client);
      if (!alreadyAttached && message.flow_control === "ack") client.data.output.set(message.pane_id, new OutputWindow());
      // a mirrored screen is drawn for the pane's own grid: the client takes that size
      // before the screen, or the rows would wrap in a grid of another width
      if (attachment.kind === "mirror") send(client, { type: "pane-geometry", pane_id: message.pane_id, cols: attachment.cols, rows: attachment.rows, fixed: true });
      // hand the newcomer the current screen it would otherwise have missed
      // (a mirror keeps its latest screen whole; a pty keeps a bounded tail of its stream)
      const tail = attachment.kind === "mirror" ? attachment.process.current ?? "" : attachment.replay.text();
      // a herdr-core joiner keeps the history it already holds: a tail that lost the attach's clear would double
      // it. A tail on the alternate screen gets the clear where it leaves that screen (leaving it first would blank
      // what the tail restores there), so the main-screen lines after it land once
      const clear = attachment.kind === "pty" && attachment.replay.truncated && "replayPrefix" in attachment.process ? attachment.process.replayPrefix : "";
      const alternate = attachment.kind === "pty" && attachment.replay.alternateScreen;
      const replay = !tail || !clear ? tail : alternate ? tail.replace("\x1b[?1049l", clear) : clear + tail;
      // the members heard `input-ready: false` when the stream ended; a newcomer is told the replay
      // is the screen from before in a frame of its own, as an early negative receipt would pass for
      // the attach-complete barrier queued input waits on
      if (!alreadyAttached && attachment.recovering) send(client, { type: "output-recovering", pane_id: message.pane_id });
      if (!alreadyAttached && replay) {
        const ahead = backlog(client);
        client.data.output.get(message.pane_id)?.join(replay, ahead, Date.now(), client.getBufferedAmount() - ahead);
        // marked as the screen from before: the client draws it but takes no new clipboard write from it
        sendOutput(client, message.pane_id, replay, true);
        // a tail that lost the stream's start may miss what was drawn once: herdr draws it again
        if (attachment.kind !== "mirror" && attachment.ready && !attachment.held && attachment.replay.truncated) requestRepaint(message.pane_id);
      }
      // a mirror not read yet has no screen from before to hand over: its first screen is this client's replay
      if (!alreadyAttached && !replay && attachment.kind === "mirror") attachment.unscreened.add(client);
      // a pane waiting for another web bridge to let go says so to each newcomer, too
      if (!alreadyAttached && attachment.held) send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
      reconcileOutput(message.pane_id);
      if (connectionOf(client).closing) return;
      if (attachment.ready && !attachment.held) send(client, { type: "input-ready", pane_id: message.pane_id });
      if (!alreadyAttached) attached(client, message.pane_id);
      if (attachment.kind === "mirror") return;
      if (connectionOf(client).mode === "interact" && !claim.keepSize) {
        // an operator's viewport owns the shared grid
        drivePty(message.pane_id, client, geometry.cols, geometry.rows);
      } else {
        // a covered grid is not a terminal showing: a release never hands the pty to it
        attachment.grids.delete(client);
        // an observer, or a grid the chat lens covers, adopts the grid the operators left behind
        send(client, {
          type: "pane-geometry",
          pane_id: message.pane_id,
          cols: attachment.cols,
          rows: attachment.rows,
        });
      }
      return;
    },
    "take-over"(client: Client, message: Frame<"take-over">): void {
      if (connectionOf(client).mode === "observe") {
        send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
        return;
      }
      const attachment = attachments.get(message.pane_id);
      if (attachment?.kind === "pty" && attachment.clients.has(client)) attachment.takeOver?.(client);
      return;
    },
    detach(client: Client, message: Frame<"detach">): void {
      client.data.attached.delete(message.pane_id);
      detach(message.pane_id, client);
      return;
    },
    "conversation-watch"(client: Client, message: Frame<"conversation-watch">): void {
      if (typeof message.pane_id !== "string" || message.pane_id.trim() === "" || typeof message.enabled !== "boolean") {
        send(client, { type: "error", code: "invalid_conversation_watch", message: "pane_id must be a nonempty string and enabled must be a boolean" });
        return;
      }
      if (message.enabled) {
        if (!client.data.attached.has(message.pane_id)) {
          send(client, { type: "error", code: "not_attached", message: "conversation interest requires an attached pane", pane_id: message.pane_id });
          return;
        }
        client.data.conversationInterests.add(message.pane_id);
        conversations.watch(message.pane_id);
      } else {
        client.data.conversationInterests.delete(message.pane_id);
        releaseConversation(message.pane_id);
      }
      return;
    },
    "pty-ack"(client: Client, message: Frame<"pty-ack">): void {
      // Observers may acknowledge output, but never input or resize it.
      const window = client.data.output.get(message.pane_id);
      if (window && window.id === message.stream_id && !window.acknowledge(message.stream_id, message.offset)) {
        send(client, { type: "error", code: "invalid_ack", message: "offset must acknowledge bytes already sent" });
        return;
      }
      reconcileOutput(message.pane_id);
      return;
    },
    async resize(client: Client, message: Frame<"resize">): Promise<void> {
      if (connectionOf(client).mode === "observe") {
        send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
        return;
      }
      const geometry = validGeometry(message.cols, message.rows);
      if (!geometry) {
        send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
        return;
      }
      // the pty is still being created (an attach from the chat lens, then the switch to the
      // terminal lens before the terminal was looked up): the resize waits for it. Dropped,
      // it would leave the pty at the pane's own grid under a terminal fitted to another.
      const claim = client.data.attached.get(message.pane_id);
      if (claim) claim.keepSize = false;
      const creating = attachments.has(message.pane_id) ? undefined : pendingAttachments.get(message.pane_id);
      if (creating && client.data.attached.has(message.pane_id)) {
        try { await creating; } catch { return; }
        if (connectionOf(client).closing || connectionOf(client).mode !== "interact" || client.data.attached.get(message.pane_id) !== claim || claim?.keepSize) return;
      }
      drivePty(message.pane_id, client, geometry.cols, geometry.rows);
      return;
    },
    "release-size"(client: Client, message: Frame<"release-size">): void {
      // this client's terminal is hidden, out of use or covered by Chat: if its grid is the pty's, the pty
      // goes back to the latest grid of another interact client still showing the terminal (#472).
      // Nothing to hand it to, or another client drove since: the size stays. Never an error, as
      // an older server ignores the frame.
      if (connectionOf(client).mode !== "interact") return;
      const claim = client.data.attached.get(message.pane_id);
      if (!claim) return;
      // Remember the release before looking up the attachment: its initial creation can
      // still be awaiting herdr, and must not revive this hidden grid when it completes.
      claim.keepSize = true;
      const attachment = typeof message.pane_id === "string" ? attachments.get(message.pane_id) : undefined;
      if (!attachment || attachment.kind === "mirror") return;
      attachment.grids.delete(client);
      if (attachment.driver !== client) return;
      attachment.driver = undefined;
      const next = [...attachment.grids].reverse().find(([other]) => connectionOf(other).mode === "interact"
        && attachment.clients.has(other) && other.data.attached.get(message.pane_id)?.keepSize === false);
      if (next) drivePty(message.pane_id, next[0], next[1].cols, next[1].rows);
      return;
    },
  };

  // the same live records, read through their grid and held state only: the server outside reaches a
  // pane's terminal through `sight`, `poke` and the frames
  const views: ReadonlyMap<string, AttachmentView> = attachments;
  return { attachments: views, conversations, reconcileOutput, closeAttachment, paneMoved, detachClaimed, dropClaims, sight, poke, drainOutput, terminalFrames };
}
