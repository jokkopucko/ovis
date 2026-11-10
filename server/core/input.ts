/**
 * Each pane's input order: the one queue its input waits in, and when its attach pty was last
 * typed into, which input sent around the pty waits on. The terminal input frames a connection
 * sends (`input`, `keys`, `secret`) are typed in that order.
 */
import { type Client, connectionOf, send } from "./connections.ts";
import { ATTACH_HELD_MESSAGE } from "./terminal-process.ts";
import { paneAgentOf } from "../pane-context.ts";
import type { TerminalSighting } from "./terminals.ts";
import type { ClientMessage } from "../../shared/protocol.ts";
import { isMouseReport, isTerminalReply, typingGuards } from "../input-guard.ts";
import { HerdrError, paneRead, paneSendKeys, paneSendText } from "../herdr/client.ts";
import { secretPrompt, validSecret } from "../../shared/secret-prompt.ts";
import { insertTextProblem } from "../../shared/terminal-insert.ts";
import { mirrorInput } from "../mirror-input.ts";

/** Keys that may wait to join one `pane.send_keys` while herdr answers the one before (a held arrow repeats ~30/s). */
const MAX_WAITING_KEYS = 256;
/** One terminal answer: a CSI report (parameters, intermediates, final byte), an OSC reply or a DCS string. */
const REPLY_RE = /^\x1b(?:\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)$/;
/** An insert that waited this long behind earlier input is refused rather than typed late (as SUBMIT_DEADLINE_MS for a message). */
const INSERT_DEADLINE_MS = 45_000;

type Frame<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

/**
 * `mayType` and `authorizeSocket` belong to the connections, which are built after the lane, so
 * they are called through: only a frame calls them. herdr's attach answer comes later than the
 * lane too, so `terminalAttachKnown` reads it as it is now.
 */
export function createInputLane({ TYPED_SETTLE_MS, KEY_SETTLE_MS, clients, sight, poke, terminalAttach, terminalAttachKnown, mayType, authorizeSocket }: {
  TYPED_SETTLE_MS: number;
  KEY_SETTLE_MS: number;
  clients: Set<Client>;
  sight: (client: Client, paneId: string) => TerminalSighting;
  poke: (paneId: string) => void;
  terminalAttach: () => Promise<boolean>;
  terminalAttachKnown: () => boolean | null;
  mayType: (client: Client) => boolean;
  authorizeSocket: (client: Client) => void;
}) {
  /** each pane's input while a composer message is in flight, one step after another */
  const paneQueues = new Map<string, Promise<unknown>>();
  /** when each pane last got keystrokes through its attach pty */
  const lastTyped = new Map<string, number>();
  /** panes whose last pty keystroke ended in an ESC, which herdr holds ~150ms: a key waits TYPED_SETTLE_MS there */
  const typedEscape = new Set<string>();
  /** per pane, the WS keys still waiting at the tail of the pane's queue: later keys of the same sender join them */
  const waitingKeys = new Map<string, { keys: string[]; client: unknown; origin: unknown; pty: unknown; claim: unknown; roles: number; run: Promise<unknown> | null; sent: boolean }>();

  /**
   * Runs `task` after everything queued for the pane. While a composer message is in
   * flight, the pane's other input (keystrokes, keys, prompt answers) waits behind it:
   * a Stop tapped right after Send must not land between the text and its Enter.
   */
  function serialize<T>(paneId: string, task: () => T | Promise<T>): Promise<T> {
    const run = (paneQueues.get(paneId) ?? Promise.resolve()).catch(() => {}).then(task);
    paneQueues.set(paneId, run);
    run.catch(() => {}).finally(() => { if (paneQueues.get(paneId) === run) paneQueues.delete(paneId); });
    return run;
  }

  /**
   * Waits until input sent through herdr's RPC can no longer overtake the pane's last pty keystroke
   * still on its way through the sidecar and the attach: KEY_SETTLE_MS after it, or TYPED_SETTLE_MS
   * when it ended in an ESC herdr may still be holding.
   */
  async function settleAfterTyping(paneId: string): Promise<void> {
    const settle = typedEscape.has(paneId) ? TYPED_SETTLE_MS : KEY_SETTLE_MS;
    const typed = Date.now() - (lastTyped.get(paneId) ?? 0);
    // fixed wait: a pty keystroke on its way through the sidecar and the attach says nothing when it lands
    if (typed < settle) await Bun.sleep(settle - typed);
  }

  /** The terminal input frames a connection sends, each handled as its `case` in the socket's frame switch was. */
  const inputFrames = {
    input(client: Client, message: Frame<"input">): void {
      // feature "input-receipt": an input with an id is answered once written or refused. A connection
      // that ended before its turn gets nothing: its browser holds what no receipt confirmed
      const id = Number.isSafeInteger(message.id) ? message.id : undefined;
      const receipt = (ok: boolean, code?: string) => {
        if (id !== undefined && clients.has(client)) send(client, { type: "input-result", id, pane_id: message.pane_id, ok, ...(code ? { code } : {}) });
      };
      if (connectionOf(client).mode === "observe") {
        send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
        receipt(false, "read_only");
        return;
      }
      // typing goes straight through the pty, unless a composer message is still in
      // flight: then it waits its turn and goes the message's own way (send_text), since
      // the pty holds a lone ESC ~150ms and a Stop would overtake nothing
      // typing reaches an attached pane only, queued or not
      const sighting = sight(client, message.pane_id);
      const seen = sighting.facts();
      const inputFailed = () => {
        if (clients.has(client)) send(client, { type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: message.pane_id });
        receipt(false, "input_failed");
      };
      // without a pty (Windows: no terminal, or a mirrored one) typing, the key bar's Enter,
      // Stop and arrows go through herdr itself, each in its turn behind a message in flight.
      // The turn is taken before herdr is asked what it can do: a message sent while
      // that answer is on its way must not overtake the typing.
      if (terminalAttachKnown() === false || (!seen.attached && terminalAttachKnown() === null)) {
        // an attach this client is not a member of owns this pane's screen, and typing
        // here would reach past it — the same refusal the pty branch below makes. A
        // pane with no attachment at all is left as it was: that is the key bar, and
        // an older bridge's composer send, neither of which attaches first.
        if (seen.attached && !seen.member) {
          send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
          receipt(false, "input_not_ready");
          return;
        }
        const text = message.text;
        // typed into the attach it saw, or into none: one left meanwhile (even attached again) takes none of it
        const roles = connectionOf(client).roles;
        // checked again right before herdr is written to: its connect is awaited (#545)
        // and into the same attach, or still none: one made while this waited is someone else's (#732)
        const allowed = () => mayType(client) && connectionOf(client).roles === roles && typingGuards.herdrTyping(sighting.facts());
        void serialize(message.pane_id, async () => {
          // a herdr that attaches: typing reaches an attached pane only
          if (await terminalAttach()) { inputFailed(); return; }
          // a pasted block asks herdr what the pane runs, so it is shaped before the checks below
          const shaped = await mirrorInput(text, () => paneAgentOf(message.pane_id));
          if (!typingGuards.herdrTyping(sighting.facts())) { inputFailed(); return; }
          // nothing typed outlives its connection
          if (!clients.has(client)) return;
          authorizeSocket(client);
          await paneSendText(message.pane_id, shaped, undefined, allowed);
          receipt(true);
          // the echo is read at once, not at the mirror's next idle read
          poke(message.pane_id);
        }).catch(inputFailed);
        return;
      }
      // another web bridge has this pane's terminal: nothing typed here reaches it
      if (!seen.member || !seen.ready || seen.held) {
        send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
        receipt(false, "input_not_ready");
        return;
      }
      const typedIntoPty = (text: string) => {
        lastTyped.set(message.pane_id, Date.now());
        if (text.endsWith("\x1b")) typedEscape.add(message.pane_id); else typedEscape.delete(message.pane_id);
        if (lastTyped.size > 64) {
          for (const [pane, at] of lastTyped) if (Date.now() - at > TYPED_SETTLE_MS) { lastTyped.delete(pane); typedEscape.delete(pane); }
        }
      };
      // the composer's Stop: a message sent right after it must not reach the agent first, and a
      // pty write only queues the ESC in the sidecar, so it goes the message's own way (send_text)
      // in the pane's turn. Plain typing, a terminal ESC included, keeps the pty's FIFO order.
      const stop = message.stop === true && message.text === "\u001b";
      // the viewer's terminal answering a query (a herdr-core attach's own, or the program's) is no one
      // typing: it goes to the attach it answers, which takes out what was its own; typed through herdr
      // behind queued input, the program would read those answers as keystrokes. Tagged by a client, so
      // only what one answer looks like: a single CSI report, OSC reply or DCS string, nothing around it.
      const reply = !stop && message.automatic === true && REPLY_RE.test(message.text);
      if ((paneQueues.has(message.pane_id) && !reply) || stop) {
        const text = message.text;
        // a click or a wheel (a click replayed behind a held arrow) is the attach's own mouse:
        // herdr encodes it for the program's mouse mode, send_text would type its bytes (#667).
        // The terminal's answers to its attach's questions go to that attach too, or they are typed (#2816):
        // only what the browser's terminal made itself, so a paste of the same bytes is still typed
        const viaAttach = isMouseReport(text) || (message.automatic === true && isTerminalReply(text));
        // typed into the attach it saw: one that ended meanwhile (and was attached again) takes none of it
        const roles = connectionOf(client).roles;
        const allowed = () => mayType(client) && connectionOf(client).roles === roles && typingGuards.queuedTyping(sighting.facts());
        void serialize(message.pane_id, async () => {
          // behind typing still in the sidecar, as a terminal key waits for it
          if (stop) await settleAfterTyping(message.pane_id);
          // held while this waited its turn: it goes nowhere, as unqueued typing would
          if (!typingGuards.queuedTyping(sighting.facts())) { inputFailed(); return; }
          // nothing typed outlives its connection
          if (!clients.has(client)) return;
          authorizeSocket(client);
          if (viaAttach) {
            if (!allowed() || !sighting.write(text, message.automatic === true)) { inputFailed(); return; }
            typedIntoPty(text);
            receipt(true);
            return;
          }
          await paneSendText(message.pane_id, text, undefined, allowed);
          receipt(true);
          // herdr still holds a lone ESC a moment: a message after the Stop waits out the same
          // settling gap as after a typed one, and checks again for a question before pasting
          if (stop) typedIntoPty(text);
        }).catch(inputFailed);
      } else {
        if (!sighting.write(message.text, message.automatic === true)) { inputFailed(); return; }
        typedIntoPty(message.text);
        receipt(true);
      }
      return;
    },
    async keys(client: Client, message: Frame<"keys">): Promise<void> {
      if (connectionOf(client).mode === "observe") {
        send(client, { type: "error", code: "read_only", message: "this connection is in observe mode" });
        return;
      }
      // Terminal chords belong to the attachment that accepted them, just like input.
      // Unattached RPC keys retain their existing path (including native Windows).
      const sighting = sight(client, message.pane_id);
      const seen = sighting.facts();
      const roles = connectionOf(client).roles;
      if (seen.currentHeld) {
        send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
        return;
      }
      // an attach still being looked up: its chord has no attachment to belong to yet, and must
      // not take the unattached RPC path around the claim it will be checked against
      if (!seen.origin && seen.claimed) {
        send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
        return;
      }
      // A key behind keys of the same sender that have not gone out yet joins them, as long as
      // nothing else was queued since: one RPC carries them all, so keys held faster than herdr
      // answers (a slow herdr, a busy PC) never queue up an RPC each, and keep their order.
      const waiting = waitingKeys.get(message.pane_id);
      if (waiting && !waiting.sent && waiting.client === client && waiting.origin === sighting.origin && waiting.pty === sighting.pty && waiting.claim === sighting.claim
        // a key pressed after the sender watched and came back is checked on its own: joined, the
        // batch's older role would refuse it with the rest
        && waiting.roles === roles
        && waiting.run !== null && paneQueues.get(message.pane_id) === waiting.run) {
        // a herdr that stopped answering does not collect keys without end: past this, they are refused
        if (waiting.keys.length + message.keys.length > MAX_WAITING_KEYS) {
          send(client, { type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: message.pane_id });
          return;
        }
        waiting.keys.push(...message.keys);
        return;
      }
      const batch = { keys: [...message.keys], client: client as unknown, origin: sighting.origin, pty: sighting.pty, claim: sighting.claim, roles, run: null as Promise<unknown> | null, sent: false };
      const run = serialize(message.pane_id, async () => { try {
        // A key goes through herdr's RPC, around the attach pty that typing just went into: it
        // waits for that typing as a composer message does, or it overtakes it (a lone ESC is
        // held there ~150ms). The checks below run after the wait.
        if (seen.origin && !seen.mirror) await settleAfterTyping(message.pane_id);
        // the attach this chord was pressed in is gone (left, replaced, or left and joined again).
        // `input_failed`, as queued typing answers: `input_not_ready` makes the client drop the
        // pane's readiness, and the attach it holds by now has already been told it is ready
        const facts = sighting.facts();
        if (facts.origin && (!facts.sameAttachment || !facts.samePty || !facts.sameClaim || !facts.member)) {
          if (clients.has(client)) send(client, { type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: message.pane_id });
          return;
        }
        if (facts.origin && !facts.ready) {
          if (clients.has(client)) send(client, { type: "error", code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent.", pane_id: message.pane_id });
          return;
        }
        // held while this waited its turn (the attach was refused after the check above)
        if (facts.currentHeld) {
          send(client, { type: "error", code: "attach_held", message: ATTACH_HELD_MESSAGE, pane_id: message.pane_id });
          return;
        }
        // a key pressed by a connection that has gone since is not pressed
        if (!clients.has(client)) return;
        authorizeSocket(client);
        // the same checks once more right before herdr is written to: its connect is awaited (#545)
        const allowed = () => mayType(client) && connectionOf(client).roles === roles && typingGuards.keys(sighting.facts());
        batch.sent = true;
        try {
          await paneSendKeys(message.pane_id, batch.keys, undefined, allowed);
        } catch (error) {
          if (!(error instanceof HerdrError && error.code === "cancelled")) throw error;
          if (clients.has(client)) send(client, { type: "error", code: "input_failed", message: "Terminal input could not be confirmed. Check the terminal before typing again.", pane_id: message.pane_id });
          return;
        }
        poke(message.pane_id);
      } finally {
        batch.sent = true;
        if (waitingKeys.get(message.pane_id) === batch) waitingKeys.delete(message.pane_id);
      } });
      batch.run = run;
      waitingKeys.set(message.pane_id, batch);
      await run;
      return;
    },
    async secret(client: Client, message: Frame<"secret">): Promise<void> {
      // Refuse busy panes instead of retaining the secret behind another send.
      const result = (ok: boolean, code?: string) => send(client, {
        type: "secret-result", id: message.id, pane_id: message.pane_id, ok, ...(code ? { code } : {}),
      });
      try {
        if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string"
          || typeof message.prompt !== "string" || secretPrompt(message.prompt) !== message.prompt || !validSecret(message.secret, message.prompt)) {
          result(false, "invalid_secret"); return;
        }
        if (connectionOf(client).mode === "observe") { result(false, "read_only"); return; }
        // the attach this secret was sent from: leaving it (even joining again) takes the secret back,
        // and so do a new pty or role: a live handoff or a switch away and back during the screen read (#589)
        const sighting = sight(client, message.pane_id);
        const seen = sighting.facts();
        if (!seen.member) { result(false, "not_attached"); return; }
        // Mirrored cleanup uses Backspace on Windows too: only printable ASCII erases reliably.
        if (seen.mirror && /[^\x20-\x7e]/.test(message.secret)) { result(false, "invalid_secret"); return; }
        if (!seen.ready || seen.held) { result(false, "input_not_ready"); return; }
        if (paneQueues.has(message.pane_id)) { result(false, "pane_busy"); return; }
        const roles = connectionOf(client).roles;
        await serialize(message.pane_id, async () => {
          // A viewport scrolled into history can still show an old password prompt.
          // Validate the live screen before typing a secret into the current program.
          const screen = await paneRead({ paneId: message.pane_id, source: "detection", format: "text" });
          if (connectionOf(client).closing || connectionOf(client).mode === "observe" || connectionOf(client).roles !== roles) { result(false, "read_only"); return; }
          authorizeSocket(client);
          const facts = sighting.facts();
          if (!facts.member || !facts.sameAttachment || !facts.sameClaim) { result(false, "not_attached"); return; }
          if (!facts.ready || facts.held || !facts.samePty) { result(false, "input_not_ready"); return; }
          if (secretPrompt(screen.text, facts.cols) !== message.prompt) { result(false, "prompt_changed"); return; }
          if (facts.mirror) {
            // A mirrored pane has no pty to type into: the secret is herdr's text, then the
            // Enter key (a `\r` inside the text is not Enter to every shell). Both are awaited,
            // so a send herdr refused is answered as failed, not as entered.
            const allowed = () => mayType(client) && connectionOf(client).roles === roles && typingGuards.mirrorSecret(sighting.facts());
            try {
              // no passphrase (validSecret): the Enter key alone
              if (message.secret) await paneSendText(message.pane_id, message.secret, undefined, allowed);
            } catch (error) {
              if (error instanceof HerdrError && error.code === "cancelled") { result(false, "not_attached"); return; }
              throw error;
            }
            try {
              // Typing finished; recheck authority after the Enter RPC connects (#900).
              await paneSendKeys(message.pane_id, ["Enter"], undefined, allowed);
            } catch (error) {
              if (!(error instanceof HerdrError && error.code === "cancelled")) throw error;
              // Cleanup is deliberately unguarded: do not leave the secret for another Enter.
              // Raw-mode readers may receive these bytes without erasing their own buffer.
              await paneSendKeys(message.pane_id, Array(message.secret.length).fill("Backspace"));
              result(false, connectionOf(client).closing || connectionOf(client).roles !== roles
                ? "read_only" : "not_attached");
              return;
            }
          } else {
            // Direct attach keystrokes: no agent transcript, RPC payload or delayed Enter.
            if (!sighting.write(`${message.secret}\r`)) { result(false, "input_not_ready"); return; }
          }
          result(true);
        });
      } catch {
        // Never forward an exception that might include submitted bytes.
        result(false, "secret_failed");
      } finally { message.secret = ""; }
      return;
    },
    /**
     * The terminal's input line typed without Enter: herdr's `pane.send_text`, awaited, so the
     * answer says herdr has the bytes (never that the program ran them). It takes the pane's turn
     * like queued typing, behind a message in flight and the last pty keystroke, and the sender's
     * attach, session, claim and role are checked again at every step after an await, and once more
     * by herdr's own guard right before the write. No Enter, key, terminator, focus or take-over
     * follows it, and nothing of it outlives the connection or is tried again.
     */
    async insert(client: Client, message: Frame<"insert">): Promise<void> {
      const result = (ok: boolean, code?: string, text?: string) => {
        if (clients.has(client)) send(client, { type: "insert-result", id: message.id, pane_id: message.pane_id, ok, ...(code ? { code, message: text } : {}) });
      };
      if (!Number.isSafeInteger(message.id) || typeof message.pane_id !== "string" || !message.pane_id) {
        send(client, { type: "error", code: "invalid_insert", message: "id must be an integer and pane_id a string" });
        return;
      }
      const problem = insertTextProblem(message.text);
      if (problem) { result(false, problem.code, problem.message); return; }
      if (connectionOf(client).mode === "observe") { result(false, "read_only", "this connection is in observe mode"); return; }
      const sighting = sight(client, message.pane_id);
      const seen = sighting.facts();
      if (!seen.member) { result(false, "not_attached", "This connection has no terminal attached for the pane; nothing was typed"); return; }
      if (seen.held) { result(false, "attach_held", ATTACH_HELD_MESSAGE); return; }
      if (!seen.ready) { result(false, "input_not_ready", "Terminal input is not ready. Nothing was sent."); return; }
      const roles = connectionOf(client).roles;
      const arrivedAt = Date.now();
      // the same attach, session and claim, still this bridge's, ready and not held: what the pty's queued typing checks
      const standing = (): string | null => {
        if (!clients.has(client) || connectionOf(client).closing || connectionOf(client).roles !== roles || connectionOf(client).mode === "observe") return "read_only";
        const facts = sighting.facts();
        if (!facts.member || !facts.sameAttachment || !facts.sameClaim) return "not_attached";
        if (facts.held) return "attach_held";
        if (!facts.ready || !facts.samePty) return "input_not_ready";
        if (Date.now() - arrivedAt > INSERT_DEADLINE_MS) return "insert_timeout";
        return null;
      };
      const refuse = (code: string): void => result(false, code, code === "insert_timeout" ? "The text waited too long behind earlier input; nothing was typed"
        : code === "attach_held" ? ATTACH_HELD_MESSAGE : code === "read_only" ? "This connection may no longer type into the pane; nothing was typed"
        : "The pane's terminal changed before the text was typed; nothing was typed");
      await serialize(message.pane_id, async () => {
        try {
          // behind typing still in the sidecar, as a key or a message waits for it
          if (!seen.mirror) await settleAfterTyping(message.pane_id);
          let lost = standing();
          if (lost) { refuse(lost); return; }
          // the live screen, not a scrolled-up one: a password prompt takes no pasted text
          const screen = await paneRead({ paneId: message.pane_id, source: "detection", format: "text" }).catch(() => null);
          if (screen === null) { result(false, "pane_read_failed", "The pane's screen could not be read; nothing was typed"); return; }
          lost = standing();
          if (lost) { refuse(lost); return; }
          if (secretPrompt(screen.text, sighting.facts().cols) !== null) { result(false, "secret_prompt", "The terminal is asking for a password; nothing was typed"); return; }
          authorizeSocket(client);
          const allowed = () => mayType(client) && standing() === null && typingGuards.queuedTyping(sighting.facts());
          try {
            // one line, no line break and no escape (insertTextProblem): typed as it came, on an attach or a mirror
            await paneSendText(message.pane_id, message.text, undefined, allowed);
          } catch (error) {
            if (error instanceof HerdrError && error.code === "cancelled") { refuse(standing() ?? "not_attached"); return; }
            throw error;
          }
          poke(message.pane_id);
          result(true);
        } catch {
          // herdr answered with an error or not at all: the bytes may or may not have arrived
          result(false, "insert_failed", "The terminal did not confirm the text. Check it before inserting again.");
        }
      });
      return;
    },
  };

  // `lastTyped` stays the server's to read: a composer message and a pending one wait out the last keystroke too
  return { serialize, settleAfterTyping, lastTyped, inputFrames };
}
