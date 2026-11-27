/**
 * Commands sent through an agent's own API instead of typed into its terminal, where the agent has a route for that
 * command and the pane's own session can be reached (docs/agent-commands.md, "The three contracts"). Everything else
 * is typed as before. Once a request may have reached the agent, the command is never typed as well. A Codex on the
 * server Ovis started for it also takes a plain message at rest this way (sendCodexTextAsData).
 */
import type { HerdrPane, SlashCommand } from "../shared/protocol.ts";
import { servedPlan, servedStatus, servedTurn, servesCommands } from "./approvals/codex.ts";
import { paneProcessRoots } from "./conversation.ts";
import { HerdrError, paneGet } from "./herdr/client.ts";
import { omoControlCall, omoControlSocket } from "./omo-control.ts";
import { opencodeSessionId } from "./opencode.ts";
import { openCodePaneService } from "./opencode-native.ts";
import { compactOpenCodeSession, openCodePermissionsRead, runOpenCodeCommand } from "./opencode-service.ts";
import type { CommandSend } from "./outcome.ts";
import { openCodeTuiCommand } from "./skills/opencode.ts";

/**
 * A command a data route can carry: OpenCode 2's `/compact` or one of its server commands by name, the bare `/plan`
 * of a Codex on the server Ovis started for it, or OmO's `/efforts <level>` on its control socket.
 */
export type CommandDataRoute = { agent: "opencode"; kind: "compact" } | { agent: "opencode"; kind: "command"; name: string; text: string }
  | { agent: "codex"; kind: "plan" } | { agent: "omo"; kind: "effort"; level: string };

/** The data route for a chat send that is exactly one command, or null to type it. */
export function commandDataRoute(command: CommandSend, text: string): CommandDataRoute | null {
  if (!["codex", "opencode", "omo", "pi"].includes(command.agent) || command.invocations.length !== 1) return null;
  if (command.agent === "codex") {
    // the slash first, as Codex's composer reads a command
    // Codex's /compact stays typed: compacting through its server aborts a turn Ovis may not have heard of yet
    return /^\/plan\s*$/u.test(text) && command.invocations[0]!.name === "plan" ? { agent: "codex", kind: "plan" } : null;
  }
  if (command.agent === "omo" || command.agent === "pi") {
    // herdr names an OmO pane `pi`; a plain pi has no control socket, so it is typed. OmO's own parse: the name, a
    // space, then a single argument (reasoning extension parseSingleArgument)
    const level = /^\/efforts +(\S+) *$/u.exec(text)?.[1];
    return level !== undefined && command.invocations[0]!.name === "efforts" ? { agent: "omo", kind: "effort", level } : null;
  }
  // an @skill rides with the typed text, where the TUI attaches it (opencode-skill-attach.ts)
  if (/(?:^|\s)@\S/u.test(text)) return null;
  // as OpenCode's TUI reads it (parseSlashHead): the slash first, the name up to the first white space, the rest as is
  const head = /^\/(\S+)(?:\s([\s\S]*))?$/u.exec(text);
  if (!head || head[1] !== command.invocations[0]!.name) return null;
  const [, name, argument = ""] = head as unknown as [string, string, string | undefined];
  if (name === "compact") return argument.trim() === "" ? { agent: "opencode", kind: "compact" } : null;
  return openCodeTuiCommand(name) ? null : { agent: "opencode", kind: "command", name, text: argument };
}

/**
 * A pane's catalog with the rows Chat leaves out of its palette for want of a result (`chatPaletteHidden`) offered again
 * where their command goes as data and its answer is the result: `/plan` of a Codex on Ovis's own server.
 */
export function withDataRoutes(agent: string | null, paneId: string, commands: SlashCommand[]): SlashCommand[] {
  if (agent !== "codex" || !servesCommands(paneId)) return commands;
  return commands.map((command) => {
    if (!command.chatPaletteHidden || command.source !== "builtin" || command.name !== "plan") return command;
    const { chatPaletteHidden: _, ...offered } = command;
    return offered;
  });
}

/** A command sent by data: when it went, and whether the answer itself shows it ran (an OpenCode command's callback, Codex's settings, OmO's control answer). */
export interface DataSent { at: number; ran: boolean }

/**
 * Sends a routed command through the pane's own agent session. Null when nothing reached the agent (no verified
 * session, the connection never opened, or a refusal before anything ran): the caller types it. Throws when the
 * request may have run without an answer, or ran and failed, so the command is not typed again.
 * `mayWrite` asks the sender once more right before the request's bytes leave; false sends nothing (null).
 */
export async function sendCommandAsData(pane: HerdrPane, route: CommandDataRoute, mayWrite: () => boolean, openCodeStateDir?: string): Promise<DataSent | null> {
  if (route.agent === "codex") {
    const threadId = servedStatus(pane.pane_id)?.threadId;
    // never a thread herdr says the pane does not show, read again right before the request (herdr-core reports none)
    if (threadId === undefined || codexDisagrees(pane, threadId) || codexDisagrees(await paneGet(pane.pane_id), threadId)) return null;
    const at = Date.now();
    const answer = await servedPlan(pane.pane_id, threadId, mayWrite);
    if (answer === "unsent") return null;
    if (answer === "unknown") throw new HerdrError("timeout", "Codex did not answer the command sent to its server; check the terminal before sending it again");
    return { at, ran: true };
  }
  if (route.agent === "omo") return await omoEffort(pane, route.level, mayWrite);
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

/**
 * The control socket of the OmO process `pane` runs (omo-control.ts), while herdr still reports the pane's terminal and
 * session as `pane` says them; null otherwise.
 */
export async function omoPaneSocket(pane: HerdrPane): Promise<string | null> {
  const roots = await paneProcessRoots(pane.pane_id, "omo");
  const agentDir = roots.omo?.agentDir;
  const socket = roots.pid !== null && agentDir ? omoControlSocket(roots.pid, agentDir) : null;
  if (socket === null) return null;
  // a pane herdr cannot name now is no pane to send to: no socket, as if none were found
  const now = await paneGet(pane.pane_id).catch(() => null);
  return now !== null && now.terminal_id === pane.terminal_id && JSON.stringify(now.agent_session ?? null) === JSON.stringify(pane.agent_session ?? null) ? socket : null;
}

/**
 * What became of a plain chat message at Codex's own server: taken as a turn of the pane's thread (`at`: when it went),
 * or not sent, as that thread runs a turn. `over`: that turn's end, as the server tells it (ServedTurn).
 */
export type CodexTextSent = { readonly turn: "started"; readonly at: number; readonly over: Promise<boolean> }
  | { readonly turn: "running"; readonly over: Promise<boolean> };

/**
 * A plain chat message for a Codex on the server Ovis started for it, as a new turn of the thread the pane shows
 * (Connection.startTurn) rather than typed. Null when nothing reached Codex and its server names no turn in the way
 * (no such thread, a question waiting, another thread loaded): the caller types it. Throws when it went without an
 * answer, so it is not typed again. `clientId` comes back on the thread's user message.
 */
export async function sendCodexTextAsData(pane: HerdrPane, text: string, mayWrite: () => boolean, clientId: string = crypto.randomUUID()): Promise<CodexTextSent | null> {
  const threadId = servedStatus(pane.pane_id)?.threadId;
  if (threadId === undefined || codexDisagrees(pane, threadId)) return null;
  // read again right before the request: the pane may have left Codex (its server's connection outlives that)
  const now = await paneGet(pane.pane_id);
  if (now.agent !== "codex" || codexDisagrees(now, threadId)) return null;
  const at = Date.now();
  const answer = await servedTurn(pane.pane_id, threadId, text, clientId, mayWrite);
  if (answer === "unsent") return null;
  if (answer === "unknown") throw new HerdrError("submit_changed", "The message went to Codex's server, which did not confirm it. Check the terminal before sending again.");
  return answer.turn === "started" ? { turn: "started", at, over: answer.over } : { turn: "running", over: answer.over };
}

/** Whether herdr reports a Codex session in `pane` other than `threadId` (by its id, or by its rollout file's name). */
export function codexDisagrees(pane: Pick<HerdrPane, "agent_session">, threadId: string): boolean {
  const session = pane.agent_session;
  if (session?.agent !== "codex" || !session.value) return false;
  return session.kind === "id" ? session.value !== threadId : !(session.kind === "path" && session.value.endsWith(`-${threadId}.jsonl`));
}

/**
 * `/efforts <level>`: a level the model offers, never `off` (that is `/reasoning off`'s), through `set_thinking_level`
 * on the pane's control socket, for this session only (`scope: "turn"`). Without a scope the socket would also make it
 * the default of every later session, which the typed command never does; the typed one also remembers it as the
 * model's own level, which this does not (interactive-mode.js applyThinkingLevel at senpi 2026.11.19-5). Anything OmO
 * would refuse is typed, so it says why.
 */
async function omoEffort(pane: HerdrPane, level: string, mayWrite: () => boolean): Promise<DataSent | null> {
  if (level === "off") return null;
  const socket = await omoPaneSocket(pane);
  if (socket === null) return null;
  // last before the write: the levels the model offers now (OmO clamps an unoffered level rather than refusing it)
  const offered = await omoControlCall(socket, { type: "get_available_thinking_levels" });
  const levels = typeof offered === "object" && typeof offered["data"] === "object" && offered["data"] !== null ? (offered["data"] as { levels?: unknown }).levels : undefined;
  if (!Array.isArray(levels)) return null;
  // OmO's /efforts refuses a model without reasoning or with one level besides off (thinking-levels.js
  // classifyReasoningCapability): those are typed, so OmO says why
  const graded = levels.filter((offered) => offered !== "off");
  if (!graded.includes(level) || (levels.includes("off") && graded.length < 2)) return null;
  const at = Date.now();
  const answer = await omoControlCall(socket, { type: "set_thinking_level", level, scope: "turn" }, mayWrite);
  if (answer === "unsent") return null;
  if (answer === "unknown" || typeof answer["success"] !== "boolean") throw new HerdrError("timeout", "OmO did not answer the effort sent to its terminal; check the terminal before sending it again");
  return answer["success"] ? { at, ran: true } : null;
}
