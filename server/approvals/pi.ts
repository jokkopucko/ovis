/**
 * pi's adapter to the approval hub (server/approvals/hub.ts). pi has no approvals of its own: it runs every tool call.
 * Its extension (server/approvals/extension.ts) holds a shell command before it runs (a `tool_call` handler, which may
 * block the call) and asks it twice at once: on pi's own screen, as a dialog drawn like OmO's permission dialog
 * (`Permission required: bash`, then `Command: $ <command>`, which dialogs/pi.ts reads), and through the hub, for
 * Ovis's card. Whichever answers first wins and closes the other. The dialog is what keeps a request Ovis can no longer
 * answer (stopped, or restarted with other keys) from being lost: it waits in pi's terminal, and on Ovis's card read
 * from the screen. Outside pi's terminal UI (`ctx.mode` other than "tui": its print mode, and its RPC mode, whose
 * dialogs wait on the RPC client) the extension holds nothing, as pi without it. Measured on pi 1.4.0 (`tool_call`'s
 * `{ block, reason }`, `ctx.ui.select` with a signal, `ctx.signal`, `ctx.mode`).
 *
 * The extension also tells the pane's context as pi itself counts it (`ctx.getContextUsage()`), at startup, after a run,
 * a model switch, a move in its tree (/tree) and a compaction: the session file records what a request filled but not the window, which a reader
 * of pi's catalogs on disk (pi-models.ts) cannot know for a model pi has built in.
 */
import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import { ALLOW_LABEL, DENY_LABEL, contextUsage, extensionApprovals } from "./extension.ts";

export const PI_HOOK_MIN_VERSION = "1.4.0";

const GLUE = `
export default function ovisApprovals(pi) {
  for (const event of ["session_start", "agent_end", "model_select", "session_compact", "session_tree"]) pi.on(event, tellContext);
  pi.on("tool_call", async (event, ctx) => {
    const command = event?.input?.command;
    if (event?.toolName !== "bash" || typeof command !== "string" || ctx?.mode !== "tui") return undefined;
    const closing = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([closing.signal, ctx.signal]) : closing.signal;
    let decision;
    try {
      decision = await Promise.race([
        ctx.ui.select(${JSON.stringify("Permission required: bash\n\nCommand: $ ")} + command, ${JSON.stringify([ALLOW_LABEL, DENY_LABEL])}, { signal })
          .then((choice) => choice === ${JSON.stringify(ALLOW_LABEL)} ? "allow" : "deny"),
        hubDecision({ tool: "bash", command, description: null }, signal),
      ]);
    } finally {
      closing.abort();
    }
    return decision === "allow" ? undefined : { block: true, reason: "The user declined this command." };
  });
}
`;

/** pi 1.x from the one measured on: a later major may change the extension API under the hook. */
export const piApprovals = {
  ...extensionApprovals("pi", (version) => meetsMinVersion(version, PI_HOOK_MIN_VERSION) && version.split(".")[0] === "1", GLUE),
  context: contextUsage,
};
