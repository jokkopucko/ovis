import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paneSendText, sessionSnapshot, subscribeEvents } from "../server/herdr/client.ts";

export async function startRelayMediaOpenCode(pane: string, dir: string): Promise<void> {
  const standIn = join(dir, "opencode");
  writeFileSync(standIn, "#!/bin/sh\nwhile read -r line; do :; done\n");
  chmodSync(standIn, 0o755);

  const started = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<never>();
  let active = true;
  const fail = (error: unknown): void => {
    active = false;
    failed.reject(error);
  };
  let rosterChanged: (() => void) | undefined;
  let last = "not read";
  const readRoster = async (): Promise<boolean> => {
    const entry = (await sessionSnapshot()).panes.find((candidate) => candidate.pane_id === pane);
    last = entry ? `agent=${JSON.stringify(entry.agent ?? null)}, status=${entry.agent_status}` : "pane missing";
    return entry?.agent === "opencode";
  };

  // Foreground detection can change the roster's agent label without changing the pane name,
  // status, or presentation, so the old pane.updated and pane.agent_status_changed wait missed it.
  const subscription = subscribeEvents([{ type: "pane.agent_detected" }], {
    onStarted: started.resolve,
    onError: fail,
    onClose: () => fail(new Error(`Herdr closed the OpenCode detection subscription for ${pane}`)),
    onEvent: ({ data }) => {
      if (data?.["pane_id"] === pane) rosterChanged?.();
    },
  });
  const timer = setTimeout(() => fail(
    new Error(`Timed out: stand-in OpenCode foreground process for ${pane} (last roster: ${last})`),
  ), 30_000);
  try {
    await Promise.race([started.promise, failed.promise]);
    await Promise.race([readRoster(), failed.promise]);
    await Promise.race([paneSendText(pane, `exec ${JSON.stringify(standIn)}\n`, undefined, () => active), failed.promise]);
    for (;;) {
      const changed = Promise.withResolvers<void>();
      let current = true;
      rosterChanged = () => {
        current = false;
        changed.resolve();
      };
      const ready = await Promise.race([failed.promise, readRoster()]);
      // A detection event during the read calls for a fresh snapshot before using the result.
      if (active && current && ready) return;
      await Promise.race([failed.promise, changed.promise]);
    }
  } finally {
    active = false;
    clearTimeout(timer);
    subscription.close();
  }
}
