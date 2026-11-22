import type { WebSocketHandler } from "bun";
import { ACCOUNT_OPENS_ALL_CAPABILITY, accountOpensAll } from "../../shared/account-devices-api.ts";
import type { BlockReceipt, NoticeReplay } from "../../shared/account-devices-api.ts";
import type { ClientMessage, ClientRole, ServerFeature, SessionSnapshot } from "../../shared/protocol.ts";
import { ConnectionDiagnostics } from "../connection-diagnostics.ts";
import { faultOf, HerdrError, type HerdrFailureView, LARGE_REPLY_BYTES } from "../herdr/client.ts";
import { OUTPUT_HARD_BYTES } from "../output-window.ts";
import { pasteDirectoryForAll } from "../paste.ts";
import { type Client, connectionOf, presenceOf, relayClient, send, setMachineEvents, type SocketData } from "./connections.ts";
import { type AttachmentView, validGeometry } from "./terminals.ts";
import type { TelemetryIngress, TelemetrySurface } from "../../shared/telemetry.ts";

const SERVER_FEATURES: ServerFeature[] = ["submit", "pending-input", "pending-hold", "secret-input", "input-ready", "take-over", "watch", "conversation-watch", "ping", "terminal-insert", "agent-only", "input-receipt", "conversation-search", "conversation-watch-detached", "prompt-watch", "secret-prompts-2", "secret-prompts-3"];

type Frame<K extends ClientMessage["type"]> = Extract<ClientMessage, { type: K }>;

/**
 * Device notice frames (feature "account-opens-all/1"): typed in the protocol, with no handler until the PC's journal
 * answers them, so until then they are dropped like any frame this server does not know.
 */
type AccountNoticeFrame = "notice-seen" | "notice-answer";

export type FrameHandlers = { [K in Exclude<ClientMessage["type"], "presence" | AccountNoticeFrame>]: (client: Client, message: Frame<K>) => void | Promise<void> };

export type SocketHandler = Omit<WebSocketHandler<SocketData>, "open" | "message" | "close" | "drain"> & {
  open(client: Client): void | Promise<void>;
  message(client: Client, message: string | Buffer): void | Promise<void>;
  close(client: Client, code: number, reason: string): void;
  drain(client: Client): void;
};

type ConnectionFrame = "ping" | "watch" | "unwatch" | "role" | "machine-events";

const INVALID_WATCH = "pane_id must be a pane's id: a string of at most 256 characters that is not blank, holds no control character and does not begin with a hyphen";

/**
 * A `watch` or `unwatch` frame's pane, checked before anything is started for it. An id that is no string would be
 * another Map key at every frame: a watch that no later frame replaces and no unwatch names. One that begins with a
 * hyphen (blanks before it aside) would be read as an option by herdr's own command line, which is handed the id as
 * it came (watch.ts). And an id is written to the server's log and sent back when its watch cannot start: no pane's
 * id is longer than a few dozen characters, or holds a control character.
 */
function watchablePane(paneId: unknown): paneId is string {
  return typeof paneId === "string" && paneId.length <= 256 && paneId.trim() !== "" && !paneId.trim().startsWith("-") && !/[\u0000-\u001f\u007f]/.test(paneId);
}

export function createSocket({ clients, present, stopped, admit, setRole, watchable, terminalHistory, terminalModes, watchPane, unwatchPane, end, holdPending, attachments, clientSnapshot, herdrLifetime, browserSnapshot, countVisit, drainOutput, frames, herdrFailure, accountEnabled = accountOpensAll(), notices: noticeHandlers }: {
  herdrFailure?: HerdrFailureView;
  clients: Set<Client>;
  present: Set<Client>;
  stopped: () => boolean;
  admit: (client: Client) => boolean;
  setRole: (client: Client, mode: ClientRole) => void;
  /**
   * whether a watch can be drawn here: herdr-core has no view drawn for a viewer's grid (`hc attach
   * --observe` streams a terminal at its own size, which a release hands to the Herdr app's window)
   */
  watchable: () => boolean;
  terminalHistory: () => boolean;
  /** whether attaches carry the program's modes, so the client types a plain arrow as its terminal encodes it (`terminal-modes`) */
  terminalModes: () => boolean;
  watchPane: (client: Client, paneId: string, geometry: { cols: number; rows: number }) => void;
  unwatchPane: (client: Client, paneId: string) => void;
  end: (client: Client, reason: "closed") => void;
  holdPending: (owner: Client) => void;
  attachments: ReadonlyMap<string, AttachmentView>;
  clientSnapshot: () => Promise<SessionSnapshot>;
  herdrLifetime: () => string | undefined;
  /** a snapshot as a browser is told it: without the token values the sidebar rows hide (server/herdr-sidebar.ts) */
  browserSnapshot: (snapshot: SessionSnapshot) => SessionSnapshot;
  countVisit: (snapshot?: Promise<SessionSnapshot>, visit?: { surface?: TelemetrySurface; ingress?: TelemetryIngress }) => void;
  drainOutput: (client: Client) => void;
  frames: Omit<FrameHandlers, ConnectionFrame>;
  accountEnabled?: boolean | undefined;
  /** the device journal's notices for a paired device (server/devices.ts), with OVIS_ACCOUNT_OPENS_ALL on */
  notices?: { replay(deviceId: string): NoticeReplay | null; seen(deviceId: string, seq: number): void; block(record: unknown, onApplied: () => void): Promise<BlockReceipt>; mayAnswer(caller: string | undefined, id: string): boolean; open(id: string): { readonly key: string | null; readonly account: string | null } | undefined; decide(id: string, replay: boolean): void; itsMe(deviceId: string, id: string, provedKey: string): boolean };
}): SocketHandler {
  const notices = accountEnabled ? noticeHandlers : undefined;
  const websocketDiagnostics = new ConnectionDiagnostics("websocket");
  const connectionFrames = {
    "machine-events"(client: Client, message: Frame<"machine-events">): void {
      if (typeof message.enabled !== "boolean") {
        send(client, { type: "error", code: "invalid_subscription", message: "enabled must be a boolean" });
        return;
      }
      setMachineEvents(client, message.enabled, message.compact_agents === true);
    },
    ping(client: Client, message: Frame<"ping">): void {
      if (!Number.isSafeInteger(message.id)) {
        send(client, { type: "error", code: "invalid_ping", message: "id must be an integer" });
        return;
      }
      send(client, { type: "pong", id: message.id });
      return;
    },
    watch(client: Client, message: Frame<"watch">): void {
      if (!watchablePane(message.pane_id)) {
        send(client, { type: "error", code: "invalid_watch", message: INVALID_WATCH });
        return;
      }
      const geometry = validGeometry(message.cols, message.rows);
      if (!geometry) {
        send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
        return;
      }
      if (!watchable()) {
        send(client, { type: "watch-end", pane_id: message.pane_id });
        return;
      }
      watchPane(client, message.pane_id, geometry);
      return;
    },
    unwatch(client: Client, message: Frame<"unwatch">): void {
      if (!watchablePane(message.pane_id)) {
        send(client, { type: "error", code: "invalid_watch", message: INVALID_WATCH });
        return;
      }
      unwatchPane(client, message.pane_id);
      return;
    },
    role(client: Client, message: Frame<"role">): void {
      if (message.mode !== "interact" && message.mode !== "observe") {
        send(client, { type: "error", code: "invalid_role", message: "mode must be interact or observe" });
        return;
      }
      if (client.data.readOnly) message.mode = "observe";
      if (message.mode === "observe") holdPending(client);
      setRole(client, message.mode);
      send(client, { type: "role-ack", mode: message.mode });
      if (message.mode === "observe") {
        for (const paneId of client.data.attached.keys()) {
          const attachment = attachments.get(paneId);
          if (attachment) {
            send(client, { type: "pane-geometry", pane_id: paneId, cols: attachment.cols, rows: attachment.rows });
          }
        }
      }
      return;
    },
  };
  const handlers: FrameHandlers = { ...connectionFrames, ...frames };

  return {
    // Only a last guard: send() holds each client to OUTPUT_HARD_BYTES itself, past which Bun would drop
    // the next frame, and the queue may also hold larger frames (connections.ts `backlog`), a snapshot among
    // them, as large as herdr's largest reply together (#2566, #2573).
    backpressureLimit: OUTPUT_HARD_BYTES + LARGE_REPLY_BYTES,
    closeOnBackpressureLimit: true,
    drain(client) {
      drainOutput(client);
    },
    async open(client) {
      if (!admit(client)) return;
      if (client.data.relay) { client.data.relay.bind(relayClient(client)); return; }
      clients.add(client);
      const lifetime = herdrLifetime();
      const features: ServerFeature[] = watchable() ? [...SERVER_FEATURES] : SERVER_FEATURES.filter((feature) => feature !== "watch");
      if (terminalHistory()) features.push("terminal-history");
      if (terminalModes()) features.push("terminal-modes");
      if (client.data.machineEvents || client.data.localRoster) features.push("machine-events");
      if (accountEnabled) features.push(ACCOUNT_OPENS_ALL_CAPABILITY);
      // a folder OVIS_PASTE_DIR names lets the page read an upload's path whole through it (#2771); a
      // watch-only connection, which may list no folder, is not told where it is
      const pasteDir = client.data.readOnly ? undefined : pasteDirectoryForAll();
      send(client, { type: "features", features, connection: client.data.connectionId, server_time: Date.now(), ...(lifetime === undefined ? {} : { herdr_lifetime: lifetime }), ...(pasteDir === undefined ? {} : { paste_dir: pasteDir }) });
      // what this device has not seen, before anything else on its stream (T57)
      const replay = client.data.deviceId === undefined ? null : notices?.replay(client.data.deviceId);
      if (replay) send(client, { type: "device-notice-replay", replay });
      const snapshot = clientSnapshot();
      countVisit(snapshot, { surface: client.data.surface, ingress: client.data.ingress });
      try {
        const read = await snapshot;
        send(client, { type: "snapshot", snapshot: client.data.bridge ? read : browserSnapshot(read), features, connection: client.data.connectionId });
      } catch (error) {
        const fault = faultOf(error, "snapshot_failed", herdrFailure);
        send(client, { type: "error", code: fault.code, message: fault.message });
      }
    },

    async message(client, raw) {
      if (stopped() || connectionOf(client).closing) return;
      const presence = presenceOf(raw);
      if (presence === true) {
        present.add(client);
        if (!client.data.relay) countVisit(undefined, { surface: client.data.surface, ingress: client.data.ingress });
      } else if (presence === false) present.delete(client);
      if (client.data.relay) { client.data.relay.message(raw); return; }
      if (presence !== null) return;
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send(client, { type: "error", code: "invalid_json", message: "message must be JSON" });
        return;
      }
      if (message.type === "notice-seen") {
        // an acknowledgement moves this device's `seen` and decides nothing (T57)
        if (client.data.deviceId !== undefined && Number.isSafeInteger(message.seq)) notices?.seen(client.data.deviceId, message.seq);
        return;
      }
      if (message.type === "notice-answer") {
        // "It's me" is the join hold's to judge (T53), only for the session's proved key, never a bare device id; the
        // confirmation it publishes is the answer. A PC without notices (flag off) ignores it as before.
        if (message.answer === "its_me") {
          if (notices === undefined || typeof message.id !== "string" || client.data.deviceId === undefined || !client.data.provedKey) return;
          try { notices.itsMe(client.data.deviceId, message.id, client.data.provedKey); }
          catch (error) {
            console.error(`[devices] It's me could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
            send(client, { type: "error", code: "notice_decision_failed", message: "The notice could not be closed and remains open." });
          }
          return;
        }
        // "Not me": each block applies at once and is answered with its receipt; one that applied decides the notice (T51).
        if (notices === undefined || typeof message.id !== "string" || message.answer !== "not_me" || !Array.isArray(message.blocks) || message.blocks.length > 2) return;
        const receipts: BlockReceipt[] = [];
        let answered = false;
        let newlyApplied = false;
        for (const block of message.blocks) {
          const notice = notices.open(message.id);
          if (notice && !notices.mayAnswer(client.data.deviceId, message.id)) break;
          let applied = false;
          const receipt = await notices.block(block, () => { applied = true; });
          receipts.push(receipt);
          if (receipt.outcome !== "refused" && notice && notice.key === block.target && notice.account === block.account) {
            answered = true;
            newlyApplied ||= applied;
          }
        }
        if (answered && notices.mayAnswer(client.data.deviceId, message.id)) {
          try { notices.decide(message.id, !newlyApplied); }
          catch (error) {
            console.error(`[devices] the notice could not be decided: ${error instanceof Error ? error.message : String(error)}`);
            send(client, { type: "error", code: "notice_decision_failed", message: "The notice could not be closed and remains open." });
          }
        }
        send(client, { type: "notice-answer-result", id: message.id, receipts });
        return;
      }
      try {
        const frame = typeof message.type === "string" && Object.hasOwn(handlers, message.type)
          ? handlers[message.type as keyof FrameHandlers] as (client: Client, message: ClientMessage) => void | Promise<void> : undefined;
        await frame?.(client, message);
      } catch (error) {
        const code = error instanceof HerdrError ? error.code : "command_failed";
        // an attach that could not start names its pane: the panes of a PC share this connection, and one
        // without a pane would end every terminal on it
        const failed = code === "attach_failed" && message.type === "attach" ? { pane_id: message.pane_id } : {};
        const fault = faultOf(error, code, herdrFailure);
        send(client, { type: "error", code: fault.code, message: fault.message, ...failed });
      }
    },

    close(client, code) {
      if (!stopped() && code !== 1000 && code !== 1001) {
        const operation = client.data.relay ? "remote" : "local";
        websocketDiagnostics.failed(operation, "closed", { operation, close_code: code });
      }
      end(client, "closed");
    },
  };
}
