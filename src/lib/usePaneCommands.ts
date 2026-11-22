import { useEffect, useState } from "react";

import type { SlashCommand } from "../../shared/protocol.ts";
import { ApiError, paneCommandScope } from "./api.ts";
import { useMachineApi, useMachineId } from "./machineContext.tsx";
import { cachedPaneCommands, onPaneCommandsInvalidated, paneCommandsNow } from "./paneCommandCache.ts";

const EMPTY_COMMANDS: readonly SlashCommand[] = [];
const RETRY_MS = [2_000, 5_000, 15_000, 30_000];

export function usePaneCommands(paneId: string | null, agent?: string | null): readonly SlashCommand[] {
  const { fetchPaneCommands } = useMachineApi();
  const machineId = useMachineId();
  const key = `${machineId}:${paneId}:${agent ?? ""}\u0000${paneId === null ? "" : paneCommandScope(paneId, machineId)}`;
  const [loaded, setLoaded] = useState<{ key: string; commands: readonly SlashCommand[]; failures: number } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => onPaneCommandsInvalidated((pane, machine) => {
    if (pane === paneId && machine === machineId) setVersion((value) => value + 1);
  }), [paneId, machineId]);
  useEffect(() => {
    if (paneId === null) return;
    let live = true;
    void cachedPaneCommands(paneId, machineId, agent, fetchPaneCommands).then(
      (commands) => { if (live) setLoaded({ key, commands, failures: 0 }); },
      // a failed read (a dropped connection, a bridge restarting) keeps the list it had and asks again below:
      // the terminal-command handoff and the menu read this list, so it must not stay empty for good.
      // A device that may only watch is refused the list (#2132): that answer stays, so it is not asked again
      (error: unknown) => {
        if (!live) return;
        if (error instanceof ApiError && error.code === "read_only") { setLoaded({ key, commands: EMPTY_COMMANDS, failures: 0 }); return; }
        setLoaded((previous) => previous?.key === key ? { ...previous, failures: previous.failures + 1 } : { key, commands: EMPTY_COMMANDS, failures: 1 });
      },
    );
    return () => { live = false; };
  }, [paneId, machineId, agent, fetchPaneCommands, key, version]);
  const failures = loaded?.key === key ? loaded.failures : 0;
  useEffect(() => {
    if (failures === 0) return;
    const timer = setTimeout(() => setVersion((value) => value + 1), RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]);
    return () => clearTimeout(timer);
  }, [failures, key]);
  return (paneId === null ? null : paneCommandsNow(paneId, machineId, agent)) ?? (loaded?.key === key ? loaded.commands : EMPTY_COMMANDS);
}
