/**
 * The WebSocket of a browser connection: it admits the connection, sends its features and the first snapshot, and hands each
 * frame to the handler of its type. FrameHandlers has one for every type a client sends, so a new frame type
 * without one fails the build instead of being dropped.
 */
import type { WebSocketHandler } from "bun";
import type { ClientMessage, ClientRole, ServerFeature, SessionSnapshot } from "../../shared/protocol.ts";
import { ConnectionDiagnostics } from "../connection-diagnostics.ts";
import { HerdrError, LARGE_REPLY_BYTES } from "../herdr/client.ts";
import { OUTPUT_HARD_BYTES } from "../output-window.ts";
import { pasteDirectoryForAll } from "../paste.ts";
import { type Client, connectionOf, presenceOf, relayClient, send, setMachineEvents, type SocketData } from "./connections.ts";
import { type AttachmentView, validGeometry } from "./terminals.ts";
import type { TelemetryIngress, TelemetrySurface } from "../../shared/telemetry.ts";

const SERVER_FEATURES: ServerFeature[] = ["submit", "pending-input", "pending-hold", "secret-input", "input-ready", "take-over", "watch", "conversation-watch", "ping", "terminal-insert", "agent-only", "input-receipt", "conversation-search", "conversation-watch-detached", "prompt-watch", "secret-prompts-2"];

type Frame<K extends ClientMessage["type"]> = Extract<ClientMessage, { type: K }>;

/** The handler of every frame type a client sends, but `presence`: that one is read before a frame is parsed (presenceOf). */
export type FrameHandlers = { [K in Exclude<ClientMessage["type"], "presence">]: (client: Client, message: Frame<K>) => void | Promise<void> };

export type SocketHandler = Omit<WebSocketHandler<SocketData>, "open" | "message" | "close" | "drain"> & {
  open(client: Client): void | Promise<void>;
  message(client: Client, message: string | Buffer): void | Promise<void>;
  close(client: Client, code: number, reason: string): void;
  drain(client: Client): void;
};

/** The frames of the connection itself: its liveness, its watches and its role. */
type ConnectionFrame = "ping" | "watch" | "unwatch" | "role" | "machine-events";

export function createSocket({ clients, present, stopped, admit, setRole, watchable, terminalHistory, watchPane, unwatchPane, end, holdPending, attachments, clientSnapshot, herdrLifetime, browserSnapshot, countVisit, drainOutput, frames }: {
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
  /** whether attaches replay the pane's scrollback for the client to keep (`terminal-history`) */
  terminalHistory: () => boolean;
  watchPane: (client: Client, paneId: string, geometry: { cols: number; rows: number }) => void;
  unwatchPane: (client: Client, paneId: string) => void;
  end: (client: Client, reason: "closed") => void;
  holdPending: (owner: Client) => void;
  attachments: ReadonlyMap<string, AttachmentView>;
  clientSnapshot: () => Promise<SessionSnapshot>;
  /** the herdr this server reads now, as a snapshot's `herdr_lifetime` names it, known without a herdr call; undefined proves none */
  herdrLifetime: () => string | undefined;
  /** a snapshot as a browser is told it: without the token values the sidebar rows hide (server/herdr-sidebar.ts) */
  browserSnapshot: (snapshot: SessionSnapshot) => SessionSnapshot;
  countVisit: (snapshot?: Promise<SessionSnapshot>, visit?: { surface?: TelemetrySurface; ingress?: TelemetryIngress }) => void;
  drainOutput: (client: Client) => void;
  /** every other frame type's handler, from the module that owns what it changes */
  frames: Omit<FrameHandlers, ConnectionFrame>;
}): SocketHandler {
  const websocketDiagnostics = new ConnectionDiagnostics("websocket");
  // Here and not in connections.ts: watch checks its grid with validGeometry (terminals.ts), and
  // terminals.ts imports connections.ts, which imports none of the core.
  const connectionFrames = {
    "machine-events"(client: Client, message: Frame<"machine-events">): void {
      if (typeof message.enabled !== "boolean") {
        send(client, { type: "error", code: "invalid_subscription", message: "enabled must be a boolean" });
        return;
      }
      setMachineEvents(client, message.enabled);
    },
    // liveness only: any role, no herdr call, nothing to wait behind
    ping(client: Client, message: Frame<"ping">): void {
      if (!Number.isSafeInteger(message.id)) {
        send(client, { type: "error", code: "invalid_ping", message: "id must be an integer" });
        return;
      }
      send(client, { type: "pong", id: message.id });
      return;
    },
    watch(client: Client, message: Frame<"watch">): void {
      const geometry = validGeometry(message.cols, message.rows);
      if (!geometry) {
        send(client, { type: "error", code: "invalid_geometry", message: "cols and rows must be integers in 1..1000" });
        return;
      }
      // a pane the view cannot start for ends at once, before anything is spawned for it
      if (!watchable()) {
        send(client, { type: "watch-end", pane_id: message.pane_id });
        return;
      }
      watchPane(client, message.pane_id, geometry);
      return;
    },
    unwatch(client: Client, message: Frame<"unwatch">): void {
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
        // the fresh observer needs the grid it must adopt
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
      // before the snapshot, which waits on herdr (seconds after a restart or under load, or never when the
      // read fails): a client sends nothing until it knows what this server takes, and that needs no herdr.
      // The herdr it names lets a page that already knows that herdr send before the snapshot proves it
      const lifetime = herdrLifetime();
      // without "watch" a tab out of use stays attached or pauses, and a reconnect attaches at once
      const features: ServerFeature[] = watchable() ? [...SERVER_FEATURES] : SERVER_FEATURES.filter((feature) => feature !== "watch");
      if (terminalHistory()) features.push("terminal-history");
      if (client.data.machineEvents) features.push("machine-events");
      // a folder OVIS_PASTE_DIR names lets the page read an upload's path whole through it (#2771); a
      // watch-only connection, which may list no folder, is not told where it is
      const pasteDir = client.data.readOnly ? undefined : pasteDirectoryForAll();
      send(client, { type: "features", features, connection: client.data.connectionId, server_time: Date.now(), ...(lifetime === undefined ? {} : { herdr_lifetime: lifetime }), ...(pasteDir === undefined ? {} : { paste_dir: pasteDir }) });
      const snapshot = clientSnapshot();
      countVisit(snapshot, { surface: client.data.surface, ingress: client.data.ingress });
      try {
        const read = await snapshot;
        send(client, { type: "snapshot", snapshot: client.data.bridge ? read : browserSnapshot(read), features, connection: client.data.connectionId });
      } catch (error) {
        const code = error instanceof HerdrError ? error.code : "snapshot_failed";
        send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error) });
      }
    },

    async message(client, raw) {
      if (stopped() || connectionOf(client).closing) return;
      // read here for a relayed connection too: alerts for every PC go out from this server
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
      try {
        // a type no handler has is ignored, as the switch on it was: a handler of that very string, or nothing
        const frame = typeof message.type === "string" && Object.hasOwn(handlers, message.type)
          ? handlers[message.type as keyof FrameHandlers] as (client: Client, message: ClientMessage) => void | Promise<void> : undefined;
        await frame?.(client, message);
      } catch (error) {
        const code = error instanceof HerdrError ? error.code : "command_failed";
        // an attach that could not start names its pane: the panes of a PC share this connection, and one
        // without a pane would end every terminal on it
        const failed = code === "attach_failed" && message.type === "attach" ? { pane_id: message.pane_id } : {};
        send(client, { type: "error", code, message: error instanceof Error ? error.message : String(error), ...failed });
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
