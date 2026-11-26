import { checkedHerdrSocket, type HerdrFailureView } from "../herdr/client.ts";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";
import { RECEIPT_RESUME_ID } from "../../shared/receipt-resume.ts";
import { ConversationMonitor } from "../conversation-monitor.ts";
import { CoreAttachSession } from "../herdr-core/attach-session.ts";
import { type SightingFacts, sightingFacts } from "../input-guard.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS, OutputWindow, ReplayBuffer, wireBytes } from "../output-window.ts";
import { backlog, type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE, ATTACH_READ_RACE_RE, ATTACH_RETRY_MAX_MS, ATTACH_RETRY_MS, createSpawnAttachment, type MirrorAttachment, type PaneAttachment, type PtyAttachment } from "./terminal-process.ts";
import { WindowsControl } from "../windows-control.ts";

const DETACHED_CONVERSATION_WATCHES = 32;

const REPAINT_COALESCE_MS = 50;
const REPAINT_MIN_INTERVAL_MS = 1000;

type Frame<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

export type AttachmentView = { readonly cols: number; readonly rows: number; readonly held?: boolean };

export interface TerminalSighting {
  readonly origin: unknown;
  readonly pty: unknown;
  readonly claim: unknown;
  facts(): SightingFacts;
  /** `automatic`: the viewer's terminal made the bytes itself; only a herdr-core stream can tell hc so. */
  write(data: string, automatic?: boolean): boolean | void;
}

export function validGeometry(cols: unknown, rows: unknown): { cols: number; rows: number } | null {
  if (typeof cols !== "number" || typeof rows !== "number" || !Number.isInteger(cols) || !Number.isInteger(rows)) {
    return null;
  }
  if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) return null;
  return { cols, rows };
}

export function createTerminalRegistry({ options, clients, stopped, terminalAttach, nativeControl, holdFor, heldRetry, retryFor, relookupFor, holdPending, holdPendingPane, attached, transcriptChanged, inputReady, end }: {
  nativeControl?: (socket: string) => Promise<string | null>;
  options: { codexHome?: string; devinDbPath?: string; opencodeDb?: string; hermesHome?: string; grokHome?: string; museData?: string;
    herdrFailure?: HerdrFailureView };
  clients: Set<Client>;
  stopped: () => boolean;
  terminalAttach: () => Promise<boolean>;
  holdFor: number;
  heldRetry: number;
  retryFor: number;
  relookupFor: number;
  holdPending: (owner: Client, paneId?: string) => void;
  holdPendingPane: (paneId: string, fault: { code: string; message: string }) => void;
  attached: (client: Client, paneId: string) => void;
  transcriptChanged?: (paneId: string) => void;
  inputReady: (paneId: string) => void;
  end: (client: Client, reason: "stalled" | "revoked" | "closed") => void;
}) {
  const attachments = new Map<string, PaneAttachment>();

  const pendingAttachments = new Map<string, Promise<PaneAttachment>>();
  // herdr releases its exclusive attach slot only after the old process exits.
  const retiringAttachments = new Map<string, Promise<void>>();
  // A viewer that gave up its claim still owns any input its attach is draining.
  const drainingAttachments = new Map<string, { readonly owner: Client; readonly process: PtyAttachment["process"] | WindowsControl }>();

  function follows(client: Client, paneId: string): boolean {
    return !connectionOf(client).closing && client.readyState === WebSocket.OPEN
      && ((client.data.attached.has(paneId) && client.data.conversationInterests.has(paneId)) || client.data.conversationWatches.has(paneId));
  }

  function notifyConversation(paneId: string, signature: string): void {
    for (const client of clients) {
      if (follows(client, paneId)) send(client, { type: "conversation-changed", pane_id: paneId, signature });
    }
  }

  const conversations = new ConversationMonitor((paneId, signature) => {
    transcriptChanged?.(paneId);
    notifyConversation(paneId, signature);
  }, options.codexHome, options.devinDbPath, options.opencodeDb, options.hermesHome, options.grokHome, options.museData);

  function releaseConversation(paneId: string): void {
    for (const client of clients) if (follows(client, paneId)) return;
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
        // A PTY host gives up an exited attach's unread output 15 s into a pause (crates/pty-sidecar EXIT_PAUSED_LIMIT):
        // only a herdr-core attach, paused by withholding hc's credit, may be held for the longer bound.
        const alone = attachment.clients.size === 1 && attachment.process instanceof CoreAttachSession;
        const verdict = window.check(buffered, Date.now(), client.getBufferedAmount() - buffered, alone);
        if (verdict === "stop") end(client, "stalled");
        else if (verdict === "pause") paused = true;
        continue;
      }
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
    const stream = attachment.kind === "mirror" ? attachment.fit?.lease?.session : undefined;
    if (paused) { attachment.process.pause(); stream?.pause(); }
    else { attachment.process.resume(); stream?.resume(); }
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

  const { spawnAttachment } = createSpawnAttachment({ herdrFailure: options.herdrFailure, attachments, retiringAttachments, terminalAttach, nativeControl, isStopped: stopped, closeAttachment, broadcast, sendOutput, reconcileOutput, holdPendingPane, inputReady, holdFor, heldRetry, retryFor, relookupFor });

  function fitInputUnavailable(client: Client, pane: string): void {
    send(client, { type: "error", code: "input_not_ready", pane_id: pane,
      message: "Windows terminal control could not be confirmed. Open the terminal to retry input." });
  }

  function retireFit(pane: string, a: MirrorAttachment, owner?: Client, afterFailure?: () => void, own = false): void {
    const fit = a.fit, lease = fit?.lease;
    if (!fit || !lease || (owner && owner !== lease.owner)) return;
    delete fit.lease;
    clearTimeout(a.retry);
    a.retry = undefined;
    fit.epoch++;
    fit.passiveMirrors.clear();
    a.process.suspendScreen(true);
    holdPending(lease.owner, pane);
    const resumeMirror = () => {
      if (attachments.get(pane) !== a || fit.lease || fit.retiring) return;
      a.process.suspendScreen(false);
      if (afterFailure) afterFailure();
      else resumeWaiting(pane, a);
      if (fit.lease) return;
      for (const member of a.clients) {
        if (connectionOf(member).mode !== "interact") continue;
        if (fit.slot === "uncertain") fitInputUnavailable(member, pane);
        else if (!fit.slot && !fit.blocked.has(member)) send(member, { type: "input-ready", pane_id: pane });
      }
    };
    if (lease.session) {
      const draining = own && lease.granted ? { owner: lease.owner, process: lease.session } : undefined;
      const retired = lease.session.exited.finally(() => {
        if (fit.retiring === retired) delete fit.retiring;
        if (draining && drainingAttachments.get(pane) === draining) drainingAttachments.delete(pane);
        resumeMirror();
      });
      fit.retiring = retired;
      if (draining) {
        drainingAttachments.set(pane, draining);
        draining.process.leave();
      } else lease.session.kill();
    } else queueMicrotask(resumeMirror);
  }

  function fitHeld(a: MirrorAttachment, client: Client, pane: string, holder: "local" | "external"): void {
    a.fit!.blocked.set(client, holder);
    holdPending(client, pane);
    send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: pane });
  }

  function resumeWaiting(pane: string, a: MirrorAttachment): void {
    for (const [waiting, holder] of a.fit!.blocked) {
      if (holder === "retrying") continue;
      fitPane(pane, a, waiting);
      if (a.fit!.lease) break;
    }
  }

  function fitPane(pane: string, a: MirrorAttachment, owner: Client, takeover = false, retryFailure = true): void {
    const fit = a.fit, claim = owner.data.attached.get(pane);
    if (!fit || !claim?.fitGrid?.drives || claim.keepSize || !a.clients.has(owner) || owner.data.readOnly
      || connectionOf(owner).closing || connectionOf(owner).mode !== "interact") return;
    if (takeover && !fit.blocked.has(owner)) return;
    if (!takeover && fit.lease && fit.lease.owner !== owner) {
      fitHeld(a, owner, pane, "local");
      return;
    }
    if (fit.lease?.owner === owner) {
      const { cols, rows } = claim.fitGrid;
      if (fit.lease.cols !== cols || fit.lease.rows !== rows) {
        fit.lease.cols = cols; fit.lease.rows = rows;
        fit.lease.session?.resize(cols, rows);
      }
      return;
    }
    clearTimeout(a.retry);
    a.retry = undefined;
    // Taking our own slot needs no --takeover after release. If a third party gets it
    // in the gap, that is a different holder, not the one the user asked to displace.
    const knownExternal = fit.blocked.get(owner) === "external";
    let takeExternal = takeover && !fit.lease && fit.slot === "held" && knownExternal;
    if (fit.blocked.has(owner)) fit.blocked.set(owner, "retrying");
    if (fit.lease) {
      fitHeld(a, fit.lease.owner, pane, "local");
      retireFit(pane, a);
    }
    const lease: NonNullable<typeof fit.lease> = { owner, granted: false, cols: claim.fitGrid.cols, rows: claim.fitGrid.rows };
    fit.lease = lease;
    fit.epoch++;
    const valid = () => attachments.get(pane) === a && fit.lease === lease && a.clients.has(owner)
      && owner.data.attached.get(pane) === claim && !claim.keepSize && !connectionOf(owner).closing && connectionOf(owner).mode === "interact";
    for (const member of a.clients) {
      holdPending(member, pane);
      if (connectionOf(member).mode !== "interact") continue;
      if (member === owner) send(member, { type: "input-ready", pane_id: pane, ready: false });
      // Revoke input without marking another viewer's independently usable screen stale.
      else if (!fit.slot && !fit.blocked.has(member)) send(member, { type: "error", code: "input_not_ready", pane_id: pane,
        message: "Another viewer is opening this Windows terminal for input." });
    }
    let readDeadline: number | undefined;
    let readRetries = 0;
    const failed = (held: boolean, reason?: string) => {
      if (!valid()) return;
      if (!lease.granted && lease.session && reason && ATTACH_READ_RACE_RE.test(reason)) {
        const now = Date.now();
        const deadline = readDeadline ??= now + retryFor;
        if (now < deadline) {
          // A read refusal says nothing about who owns the slot. Probe without
          // takeover, retaining the current claim but letting its fixed screen draw.
          takeExternal = false;
          a.process.suspendScreen(false);
          void lease.session.exited.then(() => {
            if (!valid()) return;
            const delay = Math.min(ATTACH_RETRY_MS * 2 ** readRetries++, ATTACH_RETRY_MAX_MS, deadline - Date.now());
            a.retry = setTimeout(() => {
              a.retry = undefined;
              if (!valid()) return;
              if (Date.now() < deadline) start(); else failed(false, reason);
            }, Math.max(0, delay));
          });
          return;
        }
        // The known read race already used its whole retry window.
        retryFailure = false;
      }
      fit.slot = held ? "held" : "uncertain";
      if (held) {
        if (knownExternal && !lease.granted) fit.blocked.set(owner, "external");
        else fitHeld(a, owner, pane, "external");
      }
      retireFit(pane, a, owner, () => {
        // A lost stream doesn't prove contention or a free slot. Probe once with
        // the still-current claim, never replay a takeover or bypass it with RPC.
        if (held) {
          a.retry = setTimeout(() => {
            a.retry = undefined;
            resumeWaiting(pane, a);
          }, heldRetry);
          return;
        }
        if ((retryFailure || lease.granted) && owner.data.attached.get(pane) === claim)
          fitPane(pane, a, owner, false, false);
        if (!fit.lease) resumeWaiting(pane, a);
      });
    };
    const start = () => {
      if (!valid()) return;
      try {
        a.process.suspendScreen(true);
        const initial = { cols: lease.cols, rows: lease.rows };
        lease.session = new WindowsControl({ command: fit.command, socket: checkedHerdrSocket(fit.socket), target: fit.terminal, takeover: takeExternal, ...initial,
          onFrame: (data, grid, full) => {
            if (!valid()) return;
            const first = !lease.granted;
            lease.granted = true;
            delete fit.slot;
            if (first || a.cols !== grid.cols || a.rows !== grid.rows) {
              a.cols = grid.cols; a.rows = grid.rows;
              for (const member of a.clients) send(member, { type: "pane-geometry", pane_id: pane, ...grid, fixed: member !== owner, windows_fit: true });
            }
            // End the owner's output recovery before its first paint can be parsed.
            if (first && valid()) {
              if (fit.blocked.delete(owner)) send(owner, { type: "attach-resumed", pane_id: pane });
              send(owner, { type: "input-ready", pane_id: pane });
            }
            if (full) {
              a.replay = new ReplayBuffer(128 * 1024);
              fit.passiveMirrors.clear();
              a.process.suspendScreen(true);
            }
            a.replay.append(data);
            for (const member of a.clients) {
              if (!fit.passiveMirrors.has(member)) sendOutput(member, pane, data, a.unscreened.delete(member));
            }
            reconcileOutput(pane);
            if (first && valid()) {
              inputReady(pane);
              if (lease.cols !== initial.cols || lease.rows !== initial.rows) lease.session?.resize(lease.cols, lease.rows);
            }
          }, onEnd: failed });
      } catch { failed(false); }
    };
    if (fit.retiring) void fit.retiring.then(start); else start();
  }

  function releaseFit(client: Client): void {
    for (const draining of drainingAttachments.values()) {
      if (draining.owner === client && draining.process instanceof WindowsControl) draining.process.kill();
    }
    for (const pane of client.data.attached.keys()) {
      const a = attachments.get(pane);
      const grid = client.data.attached.get(pane)?.fitGrid;
      if (grid) grid.drives = false;
      if (a?.kind === "mirror") retireFit(pane, a, client);
    }
  }

  /**
   * `leftBy`: its last viewer left on its own. What that viewer typed and was answered for may still be on its way
   * through the attach, which a kill would end with it unread, so the attach is asked to leave by itself, after all
   * of it. Nothing more is written to it either way, and the next attach waits for its exit as after a kill.
   */
  function closeAttachment(paneId: string, leftBy?: Client): void {
    if (!leftBy) {
      const draining = drainingAttachments.get(paneId);
      if (draining) {
        drainingAttachments.delete(paneId);
        draining.process.kill();
      }
    }
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    for (const member of attachment.clients) holdPending(member, paneId);
    attachments.delete(paneId);
    if (attachment.kind === "pty") attachment.history?.cancel();
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
    if (attachment.kind === "mirror") retireFit(paneId, attachment);
    // Only a ready attach this bridge holds took any typing.
    const draining = leftBy && attachment.kind === "pty" && attachment.ready && !attachment.held
      ? { owner: leftBy, process: attachment.process } : undefined;
    const retired = Promise.all([attachment.process.exited, attachment.kind === "mirror" ? attachment.fit?.retiring : undefined]).then(() => {}).finally(() => {
      if (retiringAttachments.get(paneId) === retired) retiringAttachments.delete(paneId);
      if (draining && drainingAttachments.get(paneId) === draining) drainingAttachments.delete(paneId);
    });
    retiringAttachments.set(paneId, retired);
    if (draining) {
      drainingAttachments.set(paneId, draining);
      draining.process.leave();
    } else attachment.process.kill();
  }

  function closeAttachments(): void {
    for (const paneId of attachments.keys()) closeAttachment(paneId);
    for (const paneId of drainingAttachments.keys()) closeAttachment(paneId);
  }

  /**
   * herdr moved the pane under a new ID: the attach made as `from` ends for its clients (`pty-exit`), and the
   * first attach as `to` waits for that process to exit, as it holds herdr's one attach slot until then (#1503).
   */
  function paneMoved(from: string, to: string): void {
    if (from === to) return;
    if (drainingAttachments.has(from)) closeAttachment(from);
    const retire = (): Promise<void> | undefined => {
      const attachment = attachments.get(from);
      if (attachment) {
        if (attachment.kind === "pty") attachment.history?.flush();
        broadcast(from, { type: "pty-exit", pane_id: from, code: null });
        closeAttachment(from);
      }
      return retiringAttachments.get(from);
    };
    const creating = pendingAttachments.get(from);
    const exited = creating ? creating.then(retire, () => retiringAttachments.get(from)) : retire();
    if (!exited) return;
    const earlier = retiringAttachments.get(to);
    const waited: Promise<void> = Promise.all([earlier, exited]).then(() => undefined, () => undefined).finally(() => {
      if (retiringAttachments.get(to) === waited) retiringAttachments.delete(to);
    });
    retiringAttachments.set(to, waited);
  }

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
    if (!attachment || attachment.kind === "mirror" || (attachment.cols === cols && attachment.rows === rows)) return;
    attachment.history?.flush();
    if (attachments.get(paneId) !== attachment) return;
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

  /** `own`: the client asked to leave (its `detach`), where a closed, stalled or revoked connection is taken out. */
  function detach(paneId: string, client: Client, own = false): void {
    holdPending(client, paneId);
    client.data.conversationInterests.delete(paneId);
    client.data.output.delete(paneId);
    releaseConversation(paneId);
    const attachment = attachments.get(paneId);
    if (!attachment) return;
    const wasAttached = attachment.clients.delete(client);
    attachment.stalled.delete(client);
    attachment.grids.delete(client);
    if (attachment.kind === "mirror") {
      attachment.unscreened.delete(client);
      attachment.fit?.blocked.delete(client);
      if (attachment.fit?.passiveMirrors.delete(client) && !attachment.fit.passiveMirrors.size && attachment.fit.lease?.granted)
        attachment.process.suspendScreen(true);
      retireFit(paneId, attachment, client, undefined, own && wasAttached);
    }
    if (attachment.driver === client) attachment.driver = undefined;
    if (attachment.clients.size === 0) closeAttachment(paneId, own && wasAttached ? client : undefined);
    else reconcileOutput(paneId);
  }

  function detachClaimed(client: Client): void {
    for (const paneId of client.data.attached.keys()) detach(paneId, client);
    for (const draining of drainingAttachments.values()) if (draining.owner === client) draining.process.kill();
  }

  function dropClaims(client: Client): void {
    client.data.attached.clear();
    client.data.conversationInterests.clear();
    const followed = [...client.data.conversationWatches];
    client.data.conversationWatches.clear();
    for (const paneId of followed) releaseConversation(paneId);
    client.data.output.clear();
  }

  function releaseUnclaimed(paneId: string, attachment: PaneAttachment): void {
    if (attachments.get(paneId) !== attachment || attachment.clients.size > 0) return;
    for (const other of clients) if (other.data.attached.has(paneId)) return;
    closeAttachment(paneId);
  }

  function sight(client: Client, paneId: string): TerminalSighting {
    const attachment = attachments.get(paneId);
    const member = attachment?.clients.has(client) === true;
    const fit = attachment?.kind === "mirror" ? attachment.fit : undefined;
    const lease = fit?.lease, epoch = fit?.epoch;
    const process = attachment?.process;
    const claim = client.data.attached.get(paneId);
    const seen = { attachment, process, claim, member };
    return {
      origin: member ? attachment : undefined,
      pty: member ? lease?.session ?? process : undefined,
      claim,
      facts: () => {
        const now = attachments.get(paneId);
        const facts = sightingFacts(seen, { attachment: now, claim: client.data.attached.get(paneId) }, client);
        const active = now?.kind === "mirror" ? now.fit : undefined;
        if (active && (active.lease || active.retiring || active.slot || active.blocked.has(client) || active.epoch !== epoch)) {
          const own = active.lease?.owner === client && active.lease.granted;
          facts.samePty &&= active === fit && active.epoch === epoch;
          facts.sameClaim &&= facts.samePty;
          facts.ready &&= own;
          facts.member &&= own;
          facts.held = facts.currentHeld = !own;
          facts.mirror = false;
        }
        return facts;
      },
      write: (data, automatic) => {
        if (fit && (fit.epoch !== epoch || fit.retiring || fit.slot || fit.blocked.has(client))) return false;
        if (lease) return fit?.lease === lease && lease.owner === client && lease.session?.write(data) === true;
        return process instanceof CoreAttachSession ? process.write(data, automatic) : process!.write(data);
      },
    };
  }

  function poke(paneId: string): void {
    const attachment = attachments.get(paneId);
    if (attachment?.kind === "mirror") attachment.process.poke();
  }

  function drainOutput(client: Client): void {
    for (const paneId of client.data.attached.keys()) reconcileOutput(paneId);
  }

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
      if (message.windows_fit === true) claim.fitGrid = { ...geometry, drives: !claim.keepSize && connectionOf(client).mode === "interact" };
      else delete claim.fitGrid;
      // An opaque, bounded presentation correlator only: never used by input guards.
      if (typeof message.receipt_resume_id === "string" && RECEIPT_RESUME_ID.test(message.receipt_resume_id)) claim.receiptResumeId = message.receipt_resume_id;
      if (!client.data.attached.has(message.pane_id)) client.data.attached.set(message.pane_id, claim);
      let attachment: PaneAttachment;
      try {
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
      const alreadyAttached = attachment.clients.has(client);
      if (!alreadyAttached && attachment.kind === "pty" && attachments.get(message.pane_id) === attachment) {
        // Keep already received bytes live for existing viewers and replay-only for the newcomer.
        attachment.history?.flush();
      }
      if (connectionOf(client).closing || client.data.attached.get(message.pane_id) !== claim) return;
      if (attachments.get(message.pane_id) !== attachment) {
        client.data.attached.delete(message.pane_id);
        client.data.conversationInterests.delete(message.pane_id);
        releaseConversation(message.pane_id);
        send(client, { type: "pty-exit", pane_id: message.pane_id, code: null });
        return;
      }
      attachment.clients.add(client);
      if (!alreadyAttached && message.flow_control === "ack") client.data.output.set(message.pane_id, new OutputWindow());
      if (attachment.kind === "mirror" && attachment.fit) {
        if (!claim.fitGrid?.drives || claim.keepSize) retireFit(message.pane_id, attachment, client);
        else fitPane(message.pane_id, attachment, client);
      }
      // a mirrored screen is drawn for the pane's own grid: the client takes that size
      // before the screen, or the rows would wrap in a grid of another width
      const fitting = attachment.kind === "mirror" ? attachment.fit?.lease : undefined;
      if (attachment.kind === "mirror" && (fitting?.owner !== client || fitting.granted)) {
        const offered = !!attachment.fit && !!claim.fitGrid;
        send(client, { type: "pane-geometry", pane_id: message.pane_id, cols: attachment.cols, rows: attachment.rows,
          fixed: fitting?.owner !== client, ...(offered ? { windows_fit: true } : {}) });
      }
      // A late viewer cannot reconstruct an ANSI diff without its initial screen. Until
      // the controller sends a full paint, keep that viewer on its own fixed mirror;
      // an observer must never request a resize just to provoke a repaint.
      if (!alreadyAttached && fitting?.granted && fitting.owner !== client && attachment.kind === "mirror" && attachment.replay.truncated) {
        attachment.fit!.passiveMirrors.add(client);
        attachment.process.suspendScreen(false);
      }
      const tail = attachment.kind === "mirror" && (!fitting?.granted || attachment.fit?.passiveMirrors.has(client))
        ? attachment.process.current ?? "" : attachment.replay.text();
      // so is a herdr-core pty's screen, for a client that does not size it: its replay is the program's bytes for this grid
      const drives = connectionOf(client).mode === "interact" && !claim.keepSize;
      if (attachment.kind !== "mirror" && !drives) send(client, { type: "pane-geometry", pane_id: message.pane_id, cols: attachment.cols, rows: attachment.rows });
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
        if (attachment.kind !== "mirror" && attachment.ready && !attachment.held && attachment.replay.truncated) requestRepaint(message.pane_id);
      }
      if (!alreadyAttached && !replay && attachment.kind === "mirror") attachment.unscreened.add(client);
      if (!alreadyAttached && attachment.held) send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
      reconcileOutput(message.pane_id);
      if (connectionOf(client).closing) return;
      if (attachment.ready && !attachment.held && (!fitting || (fitting.owner === client && fitting.granted))
        && !(attachment.kind === "mirror" && (attachment.fit?.retiring || attachment.fit?.slot || attachment.fit?.blocked.has(client))))
        send(client, { type: "input-ready", pane_id: message.pane_id });
      else if (attachment.kind === "mirror" && attachment.fit?.slot === "uncertain" && !fitting
        && !attachment.fit.retiring && connectionOf(client).mode === "interact")
        fitInputUnavailable(client, message.pane_id);
      if (!alreadyAttached) attached(client, message.pane_id);
      if (attachment.kind === "mirror") return;
      if (drives) drivePty(message.pane_id, client, geometry.cols, geometry.rows);
      else attachment.grids.delete(client);
      return;
    },
    "take-over"(client: Client, message: Frame<"take-over">): void {
      if (connectionOf(client).mode === "observe") {
        send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
        return;
      }
      const attachment = attachments.get(message.pane_id);
      if (attachment?.kind === "pty" && attachment.clients.has(client)) attachment.takeOver?.(client);
      if (attachment?.kind === "mirror") fitPane(message.pane_id, attachment, client, true);
      return;
    },
    detach(client: Client, message: Frame<"detach">): void {
      client.data.attached.delete(message.pane_id);
      detach(message.pane_id, client, true);
      return;
    },
    "conversation-watch"(client: Client, message: Frame<"conversation-watch">): void {
      if (typeof message.pane_id !== "string" || message.pane_id.trim() === "" || typeof message.enabled !== "boolean"
        || (message.detached !== undefined && typeof message.detached !== "boolean")) {
        send(client, { type: "error", code: "invalid_conversation_watch", message: "pane_id must be a nonempty string, enabled a boolean and detached a boolean when given" });
        return;
      }
      if (message.detached === true) {
        const watches = client.data.conversationWatches;
        if (!message.enabled) {
          watches.delete(message.pane_id);
          releaseConversation(message.pane_id);
          return;
        }
        if (!watches.has(message.pane_id) && watches.size >= DETACHED_CONVERSATION_WATCHES) {
          send(client, { type: "error", code: "too_many_conversation_watches", message: `at most ${DETACHED_CONVERSATION_WATCHES} detached conversation watches per connection`, pane_id: message.pane_id });
          return;
        }
        watches.add(message.pane_id);
        conversations.watch(message.pane_id);
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
      const fitAttachment = attachments.get(message.pane_id);
      if (fitAttachment?.kind === "mirror" && fitAttachment.fit) {
        if (claim?.fitGrid?.drives && !claim.keepSize && fitAttachment.clients.has(client)) {
          // A held viewer may update its requested grid, not the live console.
          Object.assign(claim.fitGrid, geometry);
          if (fitAttachment.fit.lease?.owner === client) fitPane(message.pane_id, fitAttachment, client);
        }
        return;
      }
      if (claim) claim.keepSize = false;
      const creating = attachments.has(message.pane_id) ? undefined : pendingAttachments.get(message.pane_id);
      if (creating && client.data.attached.has(message.pane_id)) {
        const grid = claim?.fitGrid;
        try { await creating; } catch { return; }
        if (connectionOf(client).closing || connectionOf(client).mode !== "interact" || client.data.attached.get(message.pane_id) !== claim || claim?.keepSize) return;
        const made = attachments.get(message.pane_id);
        if (made?.kind === "mirror" && made.fit) {
          if (grid?.drives && claim?.fitGrid === grid) {
            Object.assign(grid, geometry);
            if (made.fit.lease?.owner === client) fitPane(message.pane_id, made, client);
          }
          return;
        }
      }
      drivePty(message.pane_id, client, geometry.cols, geometry.rows);
      return;
    },
    "release-size"(client: Client, message: Frame<"release-size">): void {
      if (connectionOf(client).mode !== "interact") return;
      const claim = client.data.attached.get(message.pane_id);
      if (!claim) return;
      // Remember the release before looking up the attachment: its initial creation can
      // still be awaiting herdr, and must not revive this hidden grid when it completes.
      claim.keepSize = true;
      if (claim.fitGrid) claim.fitGrid.drives = false;
      const attachment = typeof message.pane_id === "string" ? attachments.get(message.pane_id) : undefined;
      if (attachment?.kind === "mirror") retireFit(message.pane_id, attachment, client);
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

  const views: ReadonlyMap<string, AttachmentView> = attachments;
  return { attachments: views, conversations, notifyConversation, reconcileOutput, closeAttachment, closeAttachments, paneMoved, detachClaimed, dropClaims, releaseFit, sight, poke, drainOutput, terminalFrames };
}
