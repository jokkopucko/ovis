import { agentProcesses } from "./conversation.ts";
import type { ProcessInfo } from "./herdr/client.ts";

type ForegroundProcess = NonNullable<ProcessInfo["foreground_processes"]>[number];

/**
 * `bound` (the process a send was bound to, or the one its launch reported) while herdr still lists it, else
 * `held` (the OmO process that holds a session, heldOmoProcess, which an argv-silent custom OmO is known by alone),
 * else the agent's own program (agentProcesses: its native binary before an interpreter or launcher running it),
 * else none. Never the shell.
 */
export function agentProcessInFront(info: ProcessInfo | null | undefined, agent: string | null | undefined, bound?: number | null, held?: number | null): ForegroundProcess | null {
  const foreground = info?.foreground_processes ?? [];
  const listed = (pid: number | null | undefined) => pid == null ? undefined : foreground.find((entry) => entry.pid === pid);
  return listed(bound) ?? listed(held) ?? (agent ? agentProcesses(foreground, agent)[0] ?? null : null);
}
