/**
 * GitHub Copilot CLI's adapter to the approval hub (server/approvals/hub.ts): the session it runs and its turns, told by
 * its own hooks. The hooks come in a plugin of Ovis's own, mounted read-only for this launch alone with `--plugin-dir`
 * (a folder in the hub's private one), never in the user's settings, hooks folder or installed plugins. Copilot then
 * keeps only an empty data folder for it under its own home (`plugin-data/_direct/<hash>`).
 *
 * Measured on Copilot CLI 1.0.109 in its interactive terminal UI (fixtures/copilot-1.0.109-hooks.jsonl):
 * - SessionStart comes with the first prompt of a session, not when the UI opens: `new`, or `resume` for `--resume`;
 *   `/clear` ends the session (SessionEnd `user_exit`) and the next prompt starts another;
 * - UserPromptSubmit comes as each prompt is taken in: one typed while a turn runs comes after that turn's Stop;
 * - Stop ends the turn, with the session's transcript; a turn that fails on the model's error tells no Stop;
 * - the hook runs with no shell between, its parent being the Copilot process itself.
 * Each hook is told only: it asks nothing, and prints nothing. Its approvals stay the terminal's.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import type { ApprovalAdapter } from "./hub.ts";

/** The first Copilot CLI whose hooks from a `--plugin-dir` plugin were measured in its terminal UI. */
export const COPILOT_HOOK_MIN_VERSION = "1.0.109";

/** Seconds Copilot waits on such a hook at most (its default is 30): the hub answers them at once. */
const TOLD_TIMEOUT_S = 10;

/** The events in their VS Code compatible names, whose payload names its event (`hook_event_name`). */
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const;

const text = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;

const eventOf = (event: unknown): { name: unknown; session: string | null; transcript: string | null } | null => {
  if (typeof event !== "object" || event === null) return null;
  const input = event as { hook_event_name?: unknown; session_id?: unknown; transcript_path?: unknown };
  return { name: input.hook_event_name, session: text(input.session_id), transcript: text(input.transcript_path) };
};

export const copilotApprovals: ApprovalAdapter = {
  kind: "copilot",
  toldOnly: true,

  supports: (version) => meetsMinVersion(version, COPILOT_HOOK_MIN_VERSION) && version.split(".")[0] === "1",

  /** A `--plugin-dir` of its own: the launch's other plugin folders, the user's among them, load as before. */
  launchArgs(args, hook, dir) {
    const plugin = join(dir, `${randomUUID()}.plugin`);
    mkdirSync(plugin, { mode: 0o700 });
    // exec form: no shell between Copilot and the relay, on any platform
    const told = [{ type: "command", exec: hook.command, args: hook.args, timeoutSec: TOLD_TIMEOUT_S }];
    const write = (name: string, value: unknown) => writeFileSync(join(plugin, name), JSON.stringify(value), { mode: 0o600, flag: "wx" });
    write("plugin.json", { name: "ovis-hooks", version: "1.0.0", description: "Tells Ovis the session and turns of a Copilot it started." });
    write("hooks.json", { version: 1, hooks: Object.fromEntries(EVENTS.map((event) => [event, told])) });
    return ["--plugin-dir", plugin, ...args ?? []];
  },

  toCard: () => null,

  /** Copilot names no prompt: a Stop ends the oldest prompt still open (server/core/status.ts). */
  turn(event) {
    const input = eventOf(event);
    if (input?.name === "UserPromptSubmit") return { turn: "began", prompt: null };
    if (input?.name !== "Stop") return null;
    return { turn: "ended", prompt: null, ...(input.transcript === null ? {} : { transcript: input.transcript }) };
  },

  session(event) {
    const input = eventOf(event);
    if (input === null || input.session === null) return null;
    if (input.name === "SessionEnd") return { ended: input.session };
    return EVENTS.includes(input.name as typeof EVENTS[number]) ? { session: input.session } : null;
  },

  decision: () => null,

  toAnswer: () => "",
};
