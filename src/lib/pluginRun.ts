import type { PluginActionRequest, PluginActionResult } from "../../shared/protocol.ts";

export const PLUGIN_POLL_MS = 1_000;

export interface PluginRunApi {
  runPluginAction(request: PluginActionRequest): Promise<PluginActionResult>;
  fetchPluginActionStatus(pluginId: string, logId: string): Promise<PluginActionResult>;
}

/**
 * Who may still act on an answer: one opening of one PC's palette. An answer can arrive after the
 * palette closed, or after it was unmounted for another PC, and must then select no pane and close
 * nothing there: a pane ID of the PC that answered means another pane, or none, on the PC shown.
 */
export class Ownership {
  private epoch = 0;

  end(): void {
    this.epoch += 1;
  }

  claim(): () => boolean {
    const mine = this.epoch;
    return () => this.epoch === mine;
  }
}

export async function runPluginActionToEnd(
  api: PluginRunApi,
  request: PluginActionRequest,
  alive: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PluginActionResult | null> {
  let result = await api.runPluginAction(request);
  while (alive() && result.status === "running") {
    await wait(PLUGIN_POLL_MS);
    if (!alive()) return null;
    result = await api.fetchPluginActionStatus(request.plugin_id, result.log_id);
  }
  return alive() ? result : null;
}
