import type { HerdrPane, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import { AttachOutputTail, AttachStartupProbes, isTakeoverExit } from "../attach-output.ts";
import { AttachBatch } from "./attach-batch.ts";
import { checkedHerdrSocket, faultOf, HerdrError, type HerdrFailureView, herdrSocketPath, paneRead, paneSendText, sessionSnapshot } from "../herdr/client.ts";
import type { WindowsControl } from "../windows-control.ts";
import { CoreAttachSession } from "../herdr-core/attach-session.ts";
import { coreConnection, HC_MOVED, hcBin } from "../herdr-core/runtime.ts";
import { capabilities } from "../runtime/capabilities.ts";
import { MirrorSession } from "../mirror.ts";
import { ReplayBuffer } from "../output-window.ts";
import { PtySession, type PtySessionOptions } from "../pty/session.ts";
import { type Client, connectionOf, send } from "./connections.ts";

const MAX_REPLAY_BYTES = 128 * 1024;

/**
 * herdr's refusal of an attach while a read of the same terminal is in progress; it asks
 * for a retry. A read of more lines than an idle alt-screen agent (Codex) shows, like the
 * transcript match's 400, makes herdr scroll the agent's history back with wheel events:
 * up to 15 s, and 5 more to restore it (herdr 0.9, src/server/alt_screen_read.rs). A
 * 400-line read of an idle Codex pane took about a second, refusing every attach meanwhile.
 */
export const ATTACH_READ_RACE_RE = /has a read in progress; retry/;
/**
 * herdr's refusal when another client holds the terminal's one attach slot. It is the attach's
 * last line, after its teardown: the same words earlier in the pane's own output are not it.
 */
const ATTACH_HELD_RE = /terminal attach failed: [^\r\n]*(?:already has an attached client|retry with --takeover)[^\r\n]*\s*$/;
/** how long refused attaches are retried: herdr's longest read of that kind */
export const ATTACH_RETRY_FOR_MS = 20_000;
export const ATTACH_RETRY_MS = 50;
export const ATTACH_RETRY_MAX_MS = 500;
/** a refused attach says so within milliseconds of its first bytes: those are held this long */
export const ATTACH_HOLD_MS = 100;
/**
 * What `herdr terminal attach` writes itself before herdr has answered, and as the teardown of a
 * refused one: terminal modes set and reset (mouse reporting off, the alternate screen on, then
 * off) and the cursor style restored (`ESC [ 0 SP q`), the last one maybe cut short. The answer
 * can come any time after them, later than the hold on a busy PC, and herdr writes its refusal
 * apart from the teardown before it, so they say nothing about whether the attach took and do
 * not start the hold. A refusal and a screen both begin with something else.
 */
const ATTACH_PREAMBLE_RE = /^(?:\x1b\[(?:\?[\d;]+[hl]|\d* q))*(?:\x1b(?:\[(?:\?[\d;]*|\d+ ?| )?)?)?$/;
const ATTACH_CONTROL_HEAD_RE = /^(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_X][^\x1b]*\x1b\\|\x1b(?![[\]P^_X])[ -/]*[0-~]|[\x00-\x1a\x1c-\x1f\x7f])*/;
/** how herdr's refusal line starts: its CLI's error prefix, or the bare words */
const ATTACH_REFUSAL_LEADS = ["herdr: ", "terminal attach"];

export function attachScreenStarted(held: string): boolean {
  const rest = held.replace(ATTACH_CONTROL_HEAD_RE, "");
  if (rest === "" || rest.startsWith("\x1b")) return false;
  // herdr's words anywhere in it (a sequence cut short can swallow the line's first letter) wait out the hold
  return !ATTACH_REFUSAL_LEADS.some((lead) => rest.includes(lead) || lead.startsWith(rest));
}

/**
 * Where a refusal line may begin in output that came after an early release: the refusal is the
 * attach's last line, so only a line herdr's words start and nothing follows, or the start of those
 * words at the very end.
 */
export function refusalLineStart(text: string): number {
  let at = -1;
  for (const lead of ATTACH_REFUSAL_LEADS) {
    for (let found = text.indexOf(lead); found !== -1; found = text.indexOf(lead, found + 1)) {
      if (/^[^\r\n]*[\r\n]*$/.test(text.slice(found))) {
        at = at === -1 ? found : Math.min(at, found);
        break;
      }
    }
    for (let length = Math.min(text.length, lead.length - 1); length > 0; length--) {
      if (text.endsWith(lead.slice(0, length))) {
        at = at === -1 ? text.length - length : Math.min(at, text.length - length);
        break;
      }
    }
  }
  return at;
}
/**
 * herdr draws its first screen at the grid the attach started at and redraws for a new grid
 * about 50 ms after the resize (herdr 0.9.5): a hold that ran out before that redraw sent the old-size
 * screen as the first frame (#2289).
 */
export const ATTACH_RESIZE_REDRAW_MS = 1_000;
/**
 * The most output any hold keeps: it goes out as one frame, and a frame over a client's output window
 * (OUTPUT_HARD_BYTES, 1 MiB) ends that client as stalled. A busy pane fills it well within the wait,
 * and can in the 100 ms hold too. A refusal is a line, so it is never this long.
 */
export const ATTACH_HOLD_MAX_BYTES = 256 * 1024;
export const SYNC_START = "\x1b[?2026h";
export const SYNC_END = "\x1b[?2026l";
const ROW_START_RE = /\x1b\[(\d+);1H/g;
const PLAIN_ROW_RE = /^[\x20-\x7e]*$/;

/**
 * The grid of a whole herdr screen, from the body of one synchronized update; null when it is not one.
 * herdr (0.9.5) draws a whole screen, its first and the redraw for each new grid, as one update that
 * moves to the start of each row, 1 to the last, and fills each row to the width. The width is read
 * from the rows of plain ASCII only, whose width no table disagrees on (herdr and Bun count spacing
 * marks differently): an update with none, or whose plain rows differ, is not taken for a screen.
 */
export function screenGrid(update: string): { cols: number; rows: number } | null {
  // each row's first move only: herdr places the cursor before the update ends, and at column 1 that is
  // one more move to a row's start, with no text after it
  const moves = new Map<number, RegExpExecArray>();
  for (const move of update.matchAll(ROW_START_RE)) if (!moves.has(Number(move[1]))) moves.set(Number(move[1]), move);
  const rows = moves.size;
  if (rows === 0) return null;
  let cols: number | null = null;
  for (let row = 1; row <= rows; row++) {
    const move = moves.get(row);
    if (!move) return null;
    const text = Bun.stripANSI(update.slice(move.index + move[0].length, moves.get(row + 1)?.index ?? update.length));
    if (!PLAIN_ROW_RE.test(text)) continue;
    if (cols !== null && cols !== text.length) return null;
    cols = text.length;
  }
  return cols === null ? null : { cols, rows };
}
export const ATTACH_HELD_RETRY_MS = 3_000;
const ATTACH_REFUSING_RE = /terminal attach failed[^\r\n]*\s*$/;
const ATTACH_REFUSAL_EXIT_MS = 2_000;
/**
 * how long herdr's whole takeover diagnostic waits for the exit that confirms it: a busy host's
 * exit comes after ATTACH_HOLD_MS, and the displaced tab would show herdr's words.
 */
export const ATTACH_TAKEOVER_EXIT_MS = 2_000;
export const ATTACH_HELD_MESSAGE = "Another web bridge has this pane open. It connects here as soon as that bridge lets go.";
/**
 * How `herdr terminal attach` is asked to leave by itself: at `ctrl+b q` it detaches and exits (herdr's CLI
 * reference, "Direct terminal attach"), once it has sent herdr every key it read before the chord. Hung up, it quits
 * with what it had not read yet: input this server already answered for (#4174). After the chord's first key alone
 * (typed raw, or as a kitty or modifyOtherKeys report), which still waits for its second, the `q` would not be the
 * chord's: herdr would type it into the pane.
 */
export const ATTACH_LEAVE = { keys: "\x02q", notAfter: /(?:\x02|\x1b\[98[;:][\d;:]*u|\x1b\[27;\d+;98~)$/ };
/**
 * How long a pane whose attach herdr ended is looked up again before its terminal is taken for
 * ended. A live handoff (`herdr update --handoff`, `herdr server live-handoff`) moves every pane
 * to a new server under a new terminal id and cuts each attach with "server shut down", the
 * words a pane that exited gets too. Measured on herdr 0.9.3: the socket answers
 * server_unavailable for ~200 ms, then the pane is back under its new terminal; an exited
 * pane is gone from the snapshot within ~30 ms.
 */
export const ATTACH_RELOOKUP_FOR_MS = 5_000;
const ATTACH_RELOOKUP_MS = 100;
const ATTACH_RELOOKUP_MAX_MS = 500;
const PANE_GONE_CODES = new Set(["pane_not_found", "pane_not_restored", "no_terminal"]);

interface AttachmentState {
  ready: boolean;
  clients: Set<Client>;
  cols: number;
  rows: number;
  grids: Map<Client, { cols: number; rows: number }>;
  driver?: Client;
  replay: ReplayBuffer;
  stalled: Map<Client, number>;
  /** another web bridge holds herdr's one attach slot for this terminal: waiting for it to let go */
  held?: boolean;
  recovering?: boolean;
  retry?: ReturnType<typeof setTimeout>;
  relookup?: ReturnType<typeof setTimeout>;
  recovery?: ReturnType<typeof setTimeout>;
  repaint?: ReturnType<typeof setTimeout>;
  repaintedAt?: number;
}

export interface PtyAttachment extends AttachmentState {
  readonly kind: "pty";
  process: PtySession | CoreAttachSession;
  history?: AttachBatch;
  takeOver?: (client: Client) => void;
  resizes?: number;
  resizedTo?: string[];
}

export interface MirrorAttachment extends AttachmentState {
  readonly kind: "mirror";
  process: MirrorSession;
  unscreened: Set<Client>;
  fit?: {
    command: string; terminal: string; socket: string;
    lease?: { owner: Client; session?: WindowsControl; granted: boolean; cols: number; rows: number };
    retiring?: Promise<void>;
    epoch: number;
    slot?: "held" | "uncertain";
    blocked: Map<Client, "local" | "external" | "retrying">;
    passiveMirrors: Set<Client>;
  };
}

export type PaneAttachment = PtyAttachment | MirrorAttachment;

/**
 * A pane's grid in cells: herdr's layout rect, or on herdr-core the terminal's own grid, where
 * layout rects are shares of a fixed area (server/herdr-core/layout-doc.ts); null when neither says.
 */
export function paneGrid(snapshot: Pick<SessionSnapshot, "layouts">, pane: Pick<HerdrPane, "pane_id" | "grid">): { width: number; height: number } | null {
  if (pane.grid) return { width: pane.grid.cols, height: pane.grid.rows };
  const rect = snapshot.layouts.flatMap((layout) => layout.panes).find((entry) => entry.pane_id === pane.pane_id)?.rect ?? null;
  return rect ? { width: rect.width, height: rect.height } : null;
}

export function createSpawnAttachment({ attachments, retiringAttachments, terminalAttach, nativeControl, isStopped, closeAttachment, broadcast, sendOutput, reconcileOutput, holdPendingPane, inputReady, holdFor, heldRetry, retryFor, relookupFor, herdrFailure }: {
  nativeControl?: (socket: string) => Promise<string | null>;
  herdrFailure?: HerdrFailureView;
  attachments: Map<string, PaneAttachment>;
  retiringAttachments: Map<string, Promise<void>>;
  terminalAttach: () => Promise<boolean>;
  isStopped: () => boolean;
  closeAttachment: (paneId: string) => void;
  broadcast: (paneId: string, message: ServerMessage) => void;
  sendOutput: (client: Client, paneId: string, data: string, replay?: boolean) => void;
  reconcileOutput: (paneId: string) => void;
  holdPendingPane: (paneId: string, fault: { code: string; message: string }) => void;
  inputReady: (paneId: string) => void;
  holdFor: number;
  heldRetry: number;
  retryFor: number;
  relookupFor: number;
}) {
  async function terminalInfoFor(paneId: string, timeoutMs?: number): Promise<{ terminalId: string; rect: { width: number; height: number } | null }> {
    const snapshot = await sessionSnapshot(undefined, timeoutMs);
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) throw new HerdrError("pane_not_found", `pane ${paneId} not found`);
    // herdr (0.9.3+) could not restore it after a restart: its terminal has no process
    // and an attach would only die with "not found".
    if (pane.restore_error) throw new HerdrError("pane_not_restored", pane.restore_error, false, true);
    const terminalId = (pane as HerdrPane & { terminal_id?: string }).terminal_id;
    if (!terminalId) throw new HerdrError("no_terminal", `pane ${paneId} has no terminal`);
    // the pane's grid as the operator's layout holds it: an observe connection must
    // create the pty at THIS size, never at the observer's own viewport
    return { terminalId, rect: paneGrid(snapshot, pane as HerdrPane) };
  }

  async function spawnAttachment(paneId: string, cols: number, rows: number, forObserver: boolean): Promise<PaneAttachment> {
    await retiringAttachments.get(paneId);
    const mirrored = !(await terminalAttach());
    const { terminalId, rect } = await terminalInfoFor(paneId);
    await retiringAttachments.get(paneId);
    if (isStopped()) throw new HerdrError("server_stopped", "the web bridge stopped during attachment creation");
    // an observer-first attachment spawns at the pane's own grid (fallback 80x24 when
    // the layout has no rect for it): the attach must not seed the shared pty with a
    // watching phone's viewport
    const spawnCols = forObserver || mirrored ? (rect?.width ?? 80) : cols;
    const spawnRows = forObserver || mirrored ? (rect?.height ?? 24) : rows;
    const state = {
      clients: new Set<Client>(),
      cols: spawnCols,
      rows: spawnRows,
      replay: new ReplayBuffer(MAX_REPLAY_BYTES),
      stalled: new Map(),
      grids: new Map(),
    };

    if (mirrored) {
      const socket = checkedHerdrSocket(herdrSocketPath());
      const command = nativeControl ? await nativeControl(socket) : null;
      if (isStopped()) throw new HerdrError("server_stopped", "the web bridge stopped during attachment creation");
      const attachment: MirrorAttachment = { kind: "mirror", ready: true, process: undefined as unknown as MirrorSession, unscreened: new Set(), ...state };
      if (command) attachment.fit = { command, terminal: terminalId, socket, epoch: 0, blocked: new Map(), passiveMirrors: new Set() };
      attachments.set(paneId, attachment);
      const mirror = new MirrorSession({
        cols: spawnCols,
        rows: spawnRows,
        size: async () => {
          if (attachment.fit?.lease?.granted) return { cols: attachment.cols, rows: attachment.rows };
          const now = (await terminalInfoFor(paneId)).rect;
          return now ? { cols: now.width, rows: now.height } : null;
        },
        onResize: (cols, rows) => {
          if (attachments.get(paneId) !== attachment || attachment.fit?.lease?.granted) return;
          attachment.cols = cols;
          attachment.rows = rows;
          for (const client of attachment.clients) {
            const offered = !!attachment.fit && !!client.data.attached.get(paneId)?.fitGrid;
            send(client, { type: "pane-geometry", pane_id: paneId, cols, rows, fixed: true, ...(offered ? { windows_fit: true } : {}) });
          }
        },
        read: async () => (await paneRead({ paneId, source: "visible", format: "ansi" })).text,
        retryRead: () => !!attachment.fit?.lease?.granted,
        write: (data) => paneSendText(paneId, data),
        onData: (frame) => {
          if (attachments.get(paneId) !== attachment) return;
          const recipients = attachment.fit?.lease?.granted ? attachment.fit.passiveMirrors : attachment.clients;
          for (const client of recipients) sendOutput(client, paneId, frame, attachment.unscreened.delete(client));
          reconcileOutput(paneId);
        },
        onExit: (code) => {
          if (attachments.get(paneId) !== attachment) return;
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        },
      });
      attachment.process = mirror;
      return attachment;
    }

    const attachment: PtyAttachment = { kind: "pty", ready: false, process: undefined as unknown as PtySession, ...state };
    attachments.set(paneId, attachment);

    // No --takeover unless asked: another web bridge may own the exclusive attach slot.
    // Report that conflict without displacing it or the user's own TUI; a client here may
    // still take it on purpose (`take-over`), and the other bridge then waits in turn.
    // herdr also refuses an attach while a read of the same terminal is in progress ("has a
    // read in progress; retry"), and this server reads panes all the time (prompt polls,
    // transcript matches): an attach that races one, typically a phone reconnecting just as
    // Codex finished an answer, is started again for the same clients, for as long as such
    // a read can last, instead of ending their terminal.
    const forward = (data: string): void => {
      if (attachments.get(paneId) !== attachment) return;
      attachment.replay.append(data);
      for (const client of attachment.clients) sendOutput(client, paneId, data);
      reconcileOutput(paneId);
    };
    let retries = 0;
    let refusedSince: number | null = null;
    let takeover: Client | null = null;
    let takeoverWanted: Client | null = null;
    /** A click counts only while its client is still here and may type: no later start acts for one that left or observes. */
    const mayTakeOver = (client: Client | null): client is Client =>
      client !== null && attachment.clients.has(client) && connectionOf(client).mode === "interact" && !connectionOf(client).closing;
    let trying = false;
    const again = (): void => {
      if (attachments.get(paneId) !== attachment || trying) return;
      clearTimeout(attachment.retry);
      attachment.retry = undefined;
      if (attachment.clients.size === 0) {
        closeAttachment(paneId);
        return;
      }
      try {
        attachment.process = start();
      } catch (error) {
        spawnFailure(paneId, error);
        const fault = faultOf(error, "command_failed", herdrFailure);
        broadcast(paneId, { type: "error", code: fault.code, message: fault.message, pane_id: paneId });
        broadcast(paneId, { type: "pty-exit", pane_id: paneId, code: null });
        closeAttachment(paneId);
      }
    };
    let attachedTerminal = terminalId;
    let recoveryDeadline: number | null = null;
    let recoveryRetries = 0;
    const start = (): PtySession | CoreAttachSession => {
      const onCore = capabilities().attach === "hc";
      let takingOver = mayTakeOver(takeover) ? takeover : null;
      takeover = null;
      trying = true;
      let output = "";
      let held: string | null = "";
      let heldBytes = 0;
      let heldSince = 0;
      let holding = false;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      const probes = onCore ? null : new AttachStartupProbes();
      const history = onCore ? new AttachBatch(forward) : null;
      if (history) attachment.history = history;
      const outputTail = new AttachOutputTail();
      let tailTimer: ReturnType<typeof setTimeout> | undefined;
      let tailDeadline: number | null = null;
      const flushTail = (taken = false): void => {
        clearTimeout(tailTimer);
        tailDeadline = null;
        const data = outputTail.flush(taken);
        if (data) forward(data);
      };
      const publish = (data: string): void => {
        clearTimeout(tailTimer);
        const visible = outputTail.push(data);
        if (visible) forward(visible);
        if (!outputTail.pending) tailDeadline = null;
        else {
          tailDeadline ??= Date.now() + ATTACH_TAKEOVER_EXIT_MS;
          tailTimer = setTimeout(() => { if (!guarded) flushTail(); }, Math.max(0, tailDeadline - Date.now()));
        }
      };
      let guardUntil = 0;
      let guarded = "";
      let guardTimer: ReturnType<typeof setTimeout> | undefined;
      const flushGuard = (): void => {
        clearTimeout(guardTimer);
        const data = guarded;
        guarded = "";
        if (data) publish(data);
      };
      const guard = (data: string): void => {
        clearTimeout(guardTimer);
        const text = guarded + data;
        const at = Date.now() < guardUntil ? refusalLineStart(text) : -1;
        guarded = at === -1 ? "" : text.slice(at);
        const visible = at === -1 ? text : text.slice(0, at);
        if (visible) publish(visible);
        if (guarded) guardTimer = setTimeout(flushGuard, Math.max(0, guardUntil - Date.now()));
      };
      let retired = false;
      let endedOnce = false;
      const release = (): void => {
        clearTimeout(holdTimer);
        if (held === null) return;
        const data = held + (probes?.flush() ?? "");
        held = null;
        update = null;
        if (data) guard(data);
      };
      const took = (): void => {
        // a closed attachment's kill skips onExit, which would clear this timer: a newer
        // attachment on the pane must not hear this one's resume
        if (attachments.get(paneId) !== attachment) return;
        // a refusal whose exit comes late (a busy PC) is not an attach: resuming would free
        // the input to a pane another bridge may hold. Only output after it is an attach's.
        if (ATTACH_REFUSING_RE.test(output)) {
          if (Date.now() - heldSince < ATTACH_REFUSAL_EXIT_MS) {
            holdTimer = setTimeout(took, holdFor);
            return;
          }
          retired = true;
          session.kill();
          ended(null);
          return;
        }
        // A click is consumed by success, including an ordinary retry that won the slot.
        takeoverWanted = null;
        takeover = null;
        takingOver = null;
        if (attachment.held) {
          attachment.held = false;
          broadcast(paneId, { type: "attach-resumed", pane_id: paneId });
        }
        attachment.ready = true;
        attachment.recovering = false;
        broadcast(paneId, { type: "input-ready", pane_id: paneId });
        inputReady(paneId);
        release();
        // A replacement that only flashes ready before exiting must not create an endless series
        // of fresh recovery windows.
        if (recoveryDeadline !== null) {
          clearTimeout(attachment.recovery);
          const recovered = session;
          attachment.recovery = setTimeout(() => {
            attachment.recovery = undefined;
            if (attachments.get(paneId) !== attachment || attachment.process !== recovered || !attachment.ready) return;
            recoveryDeadline = null;
            recoveryRetries = 0;
          }, relookupFor);
        }
      };
      const ended = (code: number | null): void => {
        if (endedOnce) return;
        endedOnce = true;
        history?.end();
        trying = false;
        clearTimeout(holdTimer);
        clearTimeout(tailTimer);
        clearTimeout(guardTimer);
        clearTimeout(attachment.recovery);
        attachment.recovery = undefined;
        if (attachments.get(paneId) !== attachment) return;
        if (code !== 0 && (ATTACH_REFUSING_RE.test(output) || isTakeoverExit(output))) guarded = "";
        else flushGuard();
        if (attachment.ready) {
          attachment.recovering = true;
          broadcast(paneId, { type: "input-ready", pane_id: paneId, ready: false });
          holdPendingPane(paneId, { code: "input_not_ready", message: "The pane's attachment is restarting; review pending messages before sending them" });
        }
        attachment.ready = false;
        const finish = (): void => {
          broadcast(paneId, { type: "pty-exit", pane_id: paneId, code });
          closeAttachment(paneId);
        };
        const now = Date.now();
        const displaced = code !== 0 && isTakeoverExit(output);
        const readRace = !displaced && code !== 0 && ATTACH_READ_RACE_RE.test(output);
        if (readRace) {
          if (recoveryDeadline !== null && now >= recoveryDeadline) {
            held = null;
            return finish();
          }
          const refusedDeadline = (refusedSince ??= now) + retryFor;
          const retryDeadline = recoveryDeadline ?? refusedDeadline;
          if (now < Math.min(refusedDeadline, retryDeadline)) {
            held = null;
            retries += 1;
            // An explicit request survives a read race only until an attach succeeds.
            takeover = mayTakeOver(takingOver) ? takingOver : takeoverWanted;
            takeoverWanted = null;
            const delay = Math.min(ATTACH_RETRY_MS * 2 ** (retries - 1), ATTACH_RETRY_MAX_MS, retryDeadline - now);
            attachment.retry = setTimeout(() => {
              attachment.retry = undefined;
              // The timer can run after its deadline. Do not start one more attach then wait for
              // that process to exit before applying the recovery limit.
              if (recoveryDeadline !== null && Date.now() >= recoveryDeadline) return finish();
              again();
            }, delay);
            return;
          }
        }
        if (displaced || (code !== 0 && ATTACH_HELD_RE.test(output))) {
          flushTail(displaced);
          held = null;
          refusedSince = null;
          retries = 0;
          // Another web bridge holds herdr's one attach slot (two bridges on one herdr, e.g. a
          // second install beside the first). Its attach is left alone; this pane waits for it
          // to let go, trying again while anyone here still has it open, instead of ending.
          if (!attachment.held) broadcast(paneId, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: paneId });
          attachment.held = true;
          // Displaced after attaching: a click this attach waited on is spent, only a new one takes it back.
          if (!displaced && mayTakeOver(takeoverWanted)) {
            takeover = takeoverWanted;
            takeoverWanted = null;
            again();
          } else {
            takeoverWanted = null;
            attachment.retry = setTimeout(again, heldRetry);
          }
          return;
        }
        takeoverWanted = null;
        takeover = null;
        takingOver = null;
        trying = true;
        release();
        flushTail();
        // herdr ended the attach, maybe not the pane: after a live handoff the pane lives on under
        // a new terminal, and a transient attach EOF may leave the same terminal live. One deadline
        // and exponential backoff span every replacement that also exits, so a broken attach command
        // cannot reset itself into an unbounded spawn loop.
        const firstRecovery = recoveryDeadline === null;
        const deadline = recoveryDeadline ??= Date.now() + relookupFor;
        const retryLookup = (): void => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) return finish();
          const delay = Math.min(ATTACH_RELOOKUP_MS * 2 ** Math.min(recoveryRetries++, 8), ATTACH_RELOOKUP_MAX_MS, remaining);
          attachment.relookup = setTimeout(relookup, delay);
        };
        const relookup = (): void => {
          if (attachment.clients.size === 0) {
            closeAttachment(paneId);
            return;
          }
          if (Date.now() >= deadline) return finish();
          // a herdr that takes the request and never answers must not hold the terminal past the
          // deadline: the lookup gets what is left of it, not the RPC's own 10 s
          terminalInfoFor(paneId, Math.max(1, deadline - Date.now())).then(({ terminalId: now }) => {
            if (attachments.get(paneId) !== attachment) return;
            if (Date.now() >= deadline) return finish();
            if (attachment.clients.size === 0) {
              closeAttachment(paneId);
              return;
            }
            if (now !== attachedTerminal) {
              attachedTerminal = now;
              refusedSince = null;
              retries = 0;
            }
            // The exact same terminal id is positive liveness too: the attach process, not the pane,
            // ended. Restart its stream rather than waiting out the window and claiming the pane died.
            try {
              attachment.process = start();
            } catch (error) {
              spawnFailure(paneId, error);
              const fault = faultOf(error, "command_failed", herdrFailure);
              broadcast(paneId, { type: "error", code: fault.code, message: fault.message, pane_id: paneId });
              finish();
            }
          }, (error: unknown) => {
            if (attachments.get(paneId) !== attachment) return;
            if (error instanceof HerdrError && PANE_GONE_CODES.has(error.code)) return finish();
            retryLookup();
          });
        };
        if (firstRecovery) relookup();
        else retryLookup();
      };
      // herdr-core shares a terminal among its viewers: `hc attach` has no slot to take over
      const command = onCore ? hcBin() : process.env["OVIS_HERDR_BIN"] || "herdr";
      // the PTY host reports a command it cannot exec only as its own exit, which reads as an
      // ended attach (#925): look it up on the PATH and from the home directory the host uses.
      if (!Bun.which(command, { PATH: process.env["PATH"] ?? "", cwd: process.env["HOME"] ?? "/" })) {
        throw new HerdrError("attach_failed", onCore
          ? command === HC_MOVED
            ? "herdr-core moved (an update?), and Ovis is looking for it again: try again in a moment"
            : `hc could not be started: ${command} is not an executable on the server's PATH (set OVIS_HC_BIN to hc's full path)`
          : `herdr could not be started: ${command} is not an executable on the server's PATH (set OVIS_HERDR_BIN to herdr's full path)`);
      }
      // A resize since this attach started, even one back to its first grid, makes herdr's screens
      // until its redraw for the pty's current grid the wrong size (#2289). Only an update that began
      // after the latest resize can be that redraw, and only the latest whole screen counts: a read can
      // bring the old grid's screen queued from before a resize and a redraw for a grid in between.
      let resizes = attachment.resizes ?? 0;
      const startGrid = `${attachment.cols}x${attachment.rows}`;
      let resized = false;
      let screenAtGrid = false;
      let update: string[] | null = null;
      let edge = "";
      const noteResize = (): void => {
        if ((attachment.resizes ?? 0) === resizes) return;
        resizes = attachment.resizes ?? 0;
        resized = true;
        screenAtGrid = false;
        update = null;
        edge = "";
      };
      const look = (data: string): void => {
        const near = edge + data;
        edge = near.slice(-(SYNC_START.length - 1));
        if (update) {
          update.push(data);
          if (!near.includes(SYNC_END)) return;
        } else {
          const start = near.indexOf(SYNC_START);
          if (start === -1) return;
          update = [near.slice(start)];
        }
        const text = update.join("");
        let start = text.indexOf(SYNC_START);
        for (let end = text.indexOf(SYNC_END, start); start !== -1 && end !== -1; end = text.indexOf(SYNC_END, start)) {
          const grid = screenGrid(text.slice(start + SYNC_START.length, end));
          if (grid && grid.cols === attachment.cols && grid.rows === attachment.rows) screenAtGrid = true;
          else if (grid && (`${grid.cols}x${grid.rows}` === startGrid || attachment.resizedTo?.includes(`${grid.cols}x${grid.rows}`))) screenAtGrid = false;
          start = text.indexOf(SYNC_START, end);
        }
        update = start === -1 ? null : [text.slice(start)];
      };
      const atGrid = (): boolean => {
        noteResize();
        return !resized || screenAtGrid;
      };
      let redrawWait = false;
      const holdEnded = (): void => {
        if (!atGrid()) {
          redrawWait = true;
          holdTimer = setTimeout(took, Math.max(0, ATTACH_RESIZE_REDRAW_MS - holdFor));
          return;
        }
        took();
      };
      const options: PtySessionOptions = {
        command,
        // --takeover goes after the id: before it, herdr reads the id as an unknown option
        args: ["terminal", "attach", attachedTerminal, ...(takingOver ? ["--takeover"] : [])],
        // herdr's CLI reads HERDR_SOCKET_PATH, not HERDR_SOCKET: the stream must reach
        // the same session the RPCs talk to, or a named session's terminals are
        // looked up on the default socket and the attach dies.
        env: { HERDR_SOCKET_PATH: checkedHerdrSocket(herdrSocketPath()) },
        cols: attachment.cols,
        rows: attachment.rows,
        // herdr's attach reads the chord on Unix only: elsewhere its keys would be typed into the pane
        ...(process.platform === "win32" ? {} : { leaveAt: ATTACH_LEAVE }),
        onData: (data) => {
          if (retired || attachments.get(paneId) !== attachment) return;
          // herdr's startup queries are the bridge's to answer: never readiness, broadcast or replay
          if (probes && !holding && held !== null) {
            const before = held;
            const taken = probes.take(data, (text) => ATTACH_PREAMBLE_RE.test(before + text));
            if (taken.replies) session.write(taken.replies);
            data = taken.output;
          } else data = (probes?.flush() ?? "") + data;
          if (!data) return;
          output = (output + data).slice(-1024);
          if (held === null) return guard(data);
          noteResize();
          held += data;
          heldBytes += Buffer.byteLength(data);
          if (resized) look(data);
          if (holding && heldBytes > ATTACH_HOLD_MAX_BYTES) {
            clearTimeout(holdTimer);
            guardUntil = heldSince + holdFor;
            took();
            return;
          }
          if (!holding && !ATTACH_PREAMBLE_RE.test(held)) {
            holding = true;
            heldSince = Date.now();
            holdTimer = setTimeout(holdEnded, holdFor);
          }
          // A pane another bridge held keeps the whole hold: a displacement right after its screen spends no click.
          // A pane resized since the attach started waits for herdr's screen at its current grid:
          // input sent before it would reach the program before that grid
          if (holding && (redrawWait || !attachment.held) && atGrid() && attachScreenStarted(held)) {
            clearTimeout(holdTimer);
            if (!redrawWait) guardUntil = heldSince + holdFor;
            took();
          }
        },
        onExit: ended,
      };
      // on herdr-core the stream is a channel on the server's own hc connection: no `hc attach`, no PTY host
      const session: PtySession | CoreAttachSession = history
        ? new CoreAttachSession({
          hc: coreConnection(), terminal: attachedTerminal, cols: options.cols, rows: options.rows, onExit: ended,
          onData: (data, source) => {
            if (attachments.get(paneId) !== attachment) return;
            const fromCore = source === undefined;
            const recovering = attachment.recovering;
            if (!attachment.ready && !recovering) {
              held = null;
              took();
            }
            history.push(data, fromCore);
            // A display query does not replace the old screen. Publish the actual replacement
            // bytes before its ready transition, both to current viewers and to the replay tail.
            if (recovering && fromCore) {
              history.flush();
              held = null;
              took();
            }
          },
        })
        : new PtySession(options);
      return session;
    };
    attachment.takeOver = (client) => {
      if (attachments.get(paneId) !== attachment || !attachment.held) return;
      if (trying) {
        takeoverWanted = client;
        return;
      }
      clearTimeout(attachment.retry);
      takeover = client;
      again();
    };
    try {
      attachment.process = start();
    } catch (error) {
      // Bun.spawn throws synchronously (node missing from PATH, fd or process limits): the
      // placeholder must go with it, or the next attach joins a record with no pty and
      // its close dereferences one (#154).
      attachments.delete(paneId);
      spawnFailure(paneId, error);
      throw error;
    }

    return attachment;
  }

  /** The server's log line for an attach that could not start: the error's own words, which stay on this PC. */
  function spawnFailure(paneId: string, error: unknown): void {
    console.error(`terminal attach for pane ${paneId} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { spawnAttachment };
}
