import type { HerdrPane } from "../shared/protocol.ts";
import { labelledAgent } from "../shared/supported-agents.ts";
import { storeAgentVersion, type VersionSource } from "./agent-version.ts";
import { type NativeTranscript, paneProcessRoots } from "./conversation.ts";
import { HerdrError, paneGet } from "./herdr/client.ts";

export type PaneRoots = { omo: unknown } | null | undefined;

/**
 * herdr labels an omo pane `pi` while it waits and `claude` while its claude-sdk child runs, so a pane
 * whose `roots` find omo is omo whatever the label says.
 */
export function resolveAgent(
  pane: Pick<HerdrPane, "agent" | "agent_session">,
  roots?: PaneRoots,
  store: VersionSource | null = null,
): { agent: string | null; version: string | null } {
  const agent = roots?.omo ? "omo" : labelledAgent(pane.agent ?? pane.agent_session?.agent ?? null);
  return { agent, version: storeAgentVersion(agent, store) };
}

export function versionSourceOf(transcript: NativeTranscript): VersionSource | null {
  if (transcript.source === "opencode-transcript") return { path: transcript.path, sessionId: transcript.session };
  if (transcript.source === "claude-transcript" || transcript.source === "codex-transcript") return { path: transcript.path };
  return null;
}

/**
 * For what is typed into a pane, omo outranks herdr's label only when an omo process there holds a
 * session (omo's own holder record). A script that merely runs from an omo-ai checkout, beside Claude or
 * in a shell, is no omo: herdr's label keeps its draft checks and its paste mode.
 */
export function typingRoots(roots: { omo: { held: boolean } | null }): PaneRoots {
  return roots.omo?.held ? roots : null;
}

export async function paneAgentOf(paneId: string): Promise<string | null> {
  return (await paneContext(paneId, typingRoots(await paneProcessRoots(paneId, null)))).agent;
}

export async function paneContext(paneId: string, roots?: PaneRoots): Promise<{ agent: string | null; cwd: string; pane: Awaited<ReturnType<typeof paneGet>> }> {
  const pane = await paneGet(paneId);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  if (!cwd) throw new HerdrError("cwd_not_found", `pane ${paneId} has no working directory`);
  return { agent: resolveAgent(pane, roots).agent, cwd, pane };
}
