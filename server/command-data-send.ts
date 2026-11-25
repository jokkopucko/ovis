/**
 * Commands sent through an agent's own API instead of typed into its terminal, where the agent has a route for that
 * command and the pane's own session can be reached (docs/agent-commands.md, "The three contracts"). Everything else
 * is typed as before. Once a request may have reached the agent, the command is never typed as well.
 */
import type { HerdrPane } from "../shared/protocol.ts";
import { HerdrError, paneGet } from "./herdr/client.ts";
import { opencodeSessionId } from "./opencode.ts";
import { openCodePaneService } from "./opencode-native.ts";
import { compactOpenCodeSession, openCodePermissionsRead, runOpenCodeCommand } from "./opencode-service.ts";
import type { CommandSend } from "./outcome.ts";
import { openCodeTuiCommand } from "./skills/opencode.ts";

/** A command a data route can carry: OpenCode 2's `/compact`, or one of its server commands by name. */
export type CommandDataRoute = { agent: "opencode"; kind: "compact" } | { agent: "opencode"; kind: "command"; name: string; text: string };

/** The data route for a chat send that is exactly one command, or null to type it. */
export function commandDataRoute(command: CommandSend, text: string): CommandDataRoute | null {
  if (command.agent !== "opencode" || command.invocations.length !== 1) return null;
  // an @skill rides with the typed text, where the TUI attaches it (opencode-skill-attach.ts)
  if (/(?:^|\s)@\S/u.test(text)) return null;
  // as OpenCode's TUI reads it (parseSlashHead): the slash first, the name up to the first white space, the rest as is
  const head = /^\/(\S+)(?:\s([\s\S]*))?$/u.exec(text);
  if (!head || head[1] !== command.invocations[0]!.name) return null;
  const [, name, argument = ""] = head as unknown as [string, string, string | undefined];
  if (name === "compact") return argument.trim() === "" ? { agent: "opencode", kind: "compact" } : null;
  return openCodeTuiCommand(name) ? null : { agent: "opencode", kind: "command", name, text: argument };
}

/** A command sent by data: when it went, and whether the answer itself shows it ran (an OpenCode command's callback). */
export interface DataSent { at: number; ran: boolean }

/**
 * Sends a routed command through the pane's own agent session. Null when nothing reached the agent (no verified
 * session, the connection never opened, or a refusal before anything ran): the caller types it. Throws when the
 * request may have run without an answer, or ran and failed, so the command is not typed again.
 * `mayWrite` asks the sender once more right before the request's bytes leave; false sends nothing (null).
 */
export async function sendCommandAsData(pane: HerdrPane, route: CommandDataRoute, mayWrite: () => boolean, openCodeStateDir?: string): Promise<DataSent | null> {
  if (process.platform === "win32") return null;
  const bound = await openCodePaneService(pane, undefined, openCodeStateDir);
  // only the 2.x API measured; and only the session the pane shows now, not one an older check bound
  if (!bound || !openCodePermissionsRead(bound.service.version) || bound.sessionID !== opencodeSessionId(pane)) return null;
  if (opencodeSessionId(await paneGet(pane.pane_id)) !== bound.sessionID) return null;
  const at = Date.now();
  const answer = route.kind === "compact"
    ? await compactOpenCodeSession(bound.service.config, bound.sessionID, mayWrite)
    : await runOpenCodeCommand(bound.service.config, bound.sessionID, route.name, route.text, mayWrite);
  if (answer === "unsent") return null;
  if (answer === "unknown") throw new HerdrError("timeout", "OpenCode did not answer the command sent to its session; check the terminal before sending it again");
  // 4xx: refused before anything ran (an unknown command is CommandNotFoundError, 404)
  if (answer.status >= 400 && answer.status < 500) return null;
  if (answer.status < 200 || answer.status >= 300) {
    throw new HerdrError("command_failed", `OpenCode could not run ${route.kind === "compact" ? "/compact" : `/${route.name}`} (HTTP ${answer.status})`);
  }
  return { at, ran: route.kind === "command" };
}
