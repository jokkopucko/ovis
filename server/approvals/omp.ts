/**
 * omp's adapter to the approval hub (server/approvals/hub.ts). omp asks its own tool approvals (its approval mode and
 * `tools.approval` rules, the user's) in a dialog of its own, opened through its UI context's `approve`; Ovis makes no
 * policy of its own here. Its extension (server/approvals/extension.ts) wraps that `approve` in omp's terminal UI and,
 * for a shell command, runs omp's own dialog alongside the hub, for Ovis's card. Whichever answers first wins and
 * closes the other; the dialog stays as omp draws it, every option of it, and stays on its own when Ovis can no longer
 * answer (stopped, or restarted with other keys).
 *
 * `approve` is given only the prompt's text (`Allow tool: bash`, an optional `Reason:` line, `Command: <command>`), so
 * the extension ties it to a `bash` call it saw (`tool_call`, the command as omp runs it, after any extension revised
 * it): only a prompt that is exactly that call's goes to the hub, its `Reason:` as the card's words. Any other prompt
 * (another tool, a command omp cut past its length, `[…Nch elided…]`, which another call's whole command could read as,
 * one offering grants to remember, a provider safety check) is left to omp's dialog alone.
 *
 * omp shows one dialog at a time and queues the rest in the order they were asked; so the extension asks the hub for
 * one approval at a time, in that order, each once the one before it is answered: what the hub holds is the dialog on
 * the screen, never one still queued behind it. (A dialog of another kind ahead of it in omp's queue is not seen: the
 * hub then releases the request, and omp's dialog is answered alone, as one Ovis did not start.)
 *
 * Chosen over omp's Collab (a second client of the session, answering its dialogs the same way): Collab needs a relay
 * the session's host connects to, which Ovis would have to run (omp's own is a hosted service) and speak omp's guest
 * protocol to, for what one extension file does here. Measured on omp 18.14.0 and 19.2.1 (19.2.0 moved the extensions'
 * rendering to its own UI library; `ui.approve`, its prompt and the events this uses stayed as they were).
 */
import { meetsMinVersion } from "../../shared/agent-catalog.ts";
import type { ApprovalDecision } from "./hub.ts";
import { contextUsage, extensionApprovals } from "./extension.ts";

export const OMP_HOOK_MIN_VERSION = "18.14.0";

/** The options of omp's approval dialog that are a decision; any other goes to the dialog as its keys. */
const APPROVE_LABEL = "Approve";
const DENY_LABEL = "Deny";

/** The most `bash` calls the extension remembers between their `tool_call` and their approval. */
const CALLS_MAX = 64;

const GLUE = `
const CALLS_MAX = ${CALLS_MAX};

/** The request of a call seen whose approval prompt this is, exactly, or null (see the adapter's header). */
function heldRequest(prompt, calls) {
  if (typeof prompt?.full !== "string" || prompt.grants?.length || /\\[…\\d+ch elided…\\]$/.test(prompt.full)) return null;
  for (const command of calls.values()) {
    const details = "\\nCommand: " + command;
    if (!prompt.full.endsWith(details)) continue;
    const head = /^Allow tool: bash(?:\\nReason: ([^\\n]*))?$/.exec(prompt.full.slice(0, -details.length));
    if (head !== null) return { tool: "bash", command, description: head[1]?.trim() ? head[1] : null };
  }
  return null;
}

export default function ovisApprovals(pi) {
  const calls = new Map();
  const wrapped = new WeakSet();
  pi.on("tool_call", (event) => {
    const command = event?.input?.command;
    if (event?.toolName !== "bash" || typeof command !== "string" || command.trim() === "") return undefined;
    calls.set(event.toolCallId, command);
    if (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value);
    return undefined;
  });
  const done = (event) => { calls.delete(event?.toolCallId); };
  pi.on("tool_approval_resolved", done);
  pi.on("tool_result", done);
  // omp rebinds the extension to its subagents, including depth-zero clones, under the same launch key.
  const reportContext = (event, ctx) => { if (ctx?.agent?.kind === "main") tellContext(event, ctx); };
  pi.on("agent_end", reportContext);
  pi.on("session_compact", reportContext);
  pi.on("session_switch", reportContext);
  pi.on("session_start", (event, ctx) => {
    reportContext(event, ctx);
    const ui = ctx?.ui;
    // omp's terminal UI only: in its RPC mode the dialogs are the RPC client's
    if (ctx?.mode !== "tui" || !ctx.hasUI || typeof ui?.approve !== "function" || wrapped.has(ui)) return;
    wrapped.add(ui);
    const approve = ui.approve.bind(ui);
    // answered when every approval asked before it is, the hub's or not (each takes its place in omp's queue): the turn
    // of the next one
    let asked = Promise.resolve();
    ui.approve = async (prompt, opts) => {
      const request = heldRequest(prompt, calls);
      const before = asked;
      let answered;
      const mine = new Promise((resolve) => { answered = resolve; });
      asked = before.then(() => mine);
      if (request === null) return approve(prompt, opts).finally(answered);
      const closing = new AbortController();
      const signal = opts?.signal ? AbortSignal.any([closing.signal, opts.signal]) : closing.signal;
      try {
        return await Promise.race([
          approve(prompt, { ...opts, signal }),
          before.then(() => hubDecision(request, signal)).then((decision) => decision === "allow" ? "once" : "deny"),
        ]);
      } finally {
        closing.abort();
        answered();
      }
    };
  });
}
`;

function decision(label: string): ApprovalDecision | null {
  return label === APPROVE_LABEL ? "allow" : label === DENY_LABEL ? "deny" : null;
}

/** The majors measured on (omp 18.x from 18.14.0, and 19.x): a later major may change the UI context under the hook. */
const OMP_HOOK_MAJORS = new Set(["18", "19"]);

/**
 * Whether a launch's own arguments, before any `--`, take every extension out (`--no-tools`, or `--no-tools=<any>`,
 * which omp reads the same) or name the only one allowed (`--trusted-extension`): omp 19.2 refuses to start with one beside them (cli/args.ts), so the launch keeps
 * its arguments as they are.
 */
function refusesExtensions(args: readonly string[] | undefined): boolean {
  const own = args === undefined ? [] : args.slice(0, args.includes("--") ? args.indexOf("--") : args.length);
  return own.some((arg) => /^--(?:no-tools|trusted-extension)(?:=|$)/u.test(arg));
}

const adapter = extensionApprovals("omp", (version) => meetsMinVersion(version, OMP_HOOK_MIN_VERSION) && OMP_HOOK_MAJORS.has(version.split(".")[0]!), GLUE);

export const ompApprovals = {
  ...adapter,
  launchArgs: (...launch: Parameters<typeof adapter.launchArgs>) => refusesExtensions(launch[0]) ? null : adapter.launchArgs(...launch),
  decision,
  context: contextUsage,
};
