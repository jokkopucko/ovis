import type { ClientMessage } from "../../shared/protocol.ts";
import { sessionSnapshot } from "../herdr/client.ts";
import { onOpenCodePromptChange } from "../opencode-native.ts";
import { PromptMonitor, type PromptReader } from "../prompt-monitor.ts";
import { type Client, connectionOf, send } from "./connections.ts";

const PROMPT_WATCHES = 32;

export function createPromptWatch({ clients, read }: { clients: Set<Client>; read: PromptReader["read"] }) {
  const open = (client: Client): boolean => !connectionOf(client).closing && client.readyState === WebSocket.OPEN;

  const monitor = new PromptMonitor({ snapshot: () => sessionSnapshot(), read }, (paneId, signature) => {
    for (const client of clients) {
      if (open(client) && client.data.promptWatches.has(paneId)) send(client, { type: "prompt-changed", pane_id: paneId, signature });
    }
  }, (paneId) => {
    for (const client of clients) {
      if (client.data.promptWatches.delete(paneId) && open(client)) {
        send(client, { type: "error", code: "prompt_watch_ended", message: "the pane closed or its screen could not be read", pane_id: paneId });
      }
    }
  });
  // the polling stays: a pane that holds no verified OpenCode stream, or an event the stream missed, is read on the tick
  const stopOpenCodeWakes = onOpenCodePromptChange((paneId) => monitor.wake(paneId));

  function release(paneId: string): void {
    for (const client of clients) if (open(client) && client.data.promptWatches.has(paneId)) return;
    monitor.unwatch(paneId);
  }

  return {
    frames: {
      "prompt-watch"(client: Client, message: Extract<ClientMessage, { type: "prompt-watch" }>): void {
        if (typeof message.pane_id !== "string" || message.pane_id.trim() === "" || typeof message.enabled !== "boolean") {
          send(client, { type: "error", code: "invalid_prompt_watch", message: "pane_id must be a nonempty string and enabled must be a boolean" });
          return;
        }
        const watches = client.data.promptWatches;
        if (!message.enabled) {
          watches.delete(message.pane_id);
          release(message.pane_id);
          return;
        }
        if (!watches.has(message.pane_id) && watches.size >= PROMPT_WATCHES) {
          send(client, { type: "error", code: "too_many_prompt_watches", message: `at most ${PROMPT_WATCHES} prompt watches per connection`, pane_id: message.pane_id });
          return;
        }
        watches.add(message.pane_id);
        const current = monitor.current(message.pane_id);
        if (current !== undefined) send(client, { type: "prompt-changed", pane_id: message.pane_id, signature: current });
        else monitor.watch(message.pane_id);
      },
    },
    drop(client: Client): void {
      const watched = [...client.data.promptWatches];
      client.data.promptWatches.clear();
      for (const paneId of watched) release(paneId);
    },
    stop(): void { stopOpenCodeWakes(); monitor.stop(); },
  };
}
