/**
 * What the adapters of pi's line of agents (pi, server/approvals/pi.ts; OmO, server/approvals/omo.ts) share: their
 * hook is an extension Ovis writes for the launch (0600, in the hub's own folder) and adds with `-e <file>`, which loads
 * it for that run only, next to whatever the user installed; nothing of theirs is edited.
 *
 * The extension asks through the same relay as Claude's hook (`ovis-server approval-hook`, server/approvals/relay.ts),
 * one run per request with the request on its stdin, while the agent's own dialog for the request stays on the screen,
 * and whichever answers first wins. The dialog answered in the terminal ends the relay, which releases the held request
 * at once. A relay that gave no answer at all (it could not start, or found no hub) is run again a few times; a hub
 * that gives no decision (it does not take the request, or released it) is not asked again. A restarted Ovis knows no
 * earlier launch's key, so it answers no request of an agent started before it: that dialog is answered in the terminal,
 * or by its card's keys, as one of an agent Ovis did not start.
 *
 * The hub's events and answers are this file's own: `{ tool: "bash", command, description }` and `{ decision }`.
 */
import { settingsFile } from "../claude-settings-file.ts";
import type { PaneContext } from "../../shared/protocol.ts";
import type { ApprovalAdapter, ApprovalDecision, ApprovalRequest, TurnEvent } from "./hub.ts";

/** The options of the dialogs these extensions answer that are a decision; any other goes to the dialog as its keys. */
export const ALLOW_LABEL = "Allow once";
export const DENY_LABEL = "Deny";

/** How long the extension waits before running a relay that gave no answer again, attempt by attempt. */
export const RELAY_RETRY_MS = [250, 500, 1_000, 2_000, 4_000, 4_000, 4_000];

/**
 * `ask(event, signal)` in the extension: the hub's decision, "allow" or "deny", or null for none, after which the
 * agent's own dialog stands. Plain JavaScript, run by the agent: it may use only what the file imports.
 */
const ASK = `
const RETRY_MS = ${JSON.stringify(RELAY_RETRY_MS)};

function relayOnce(event, signal) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (decision) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", stop);
      resolve(decision);
    };
    const child = spawn(HOOK.command, HOOK.args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    const stop = () => child.kill();
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stdin.on("error", () => {});
    // no answer at all (undefined) is a failure, and the relay is run again; {"decision":null} is the hub's own
    child.on("error", () => finish(undefined));
    child.on("close", () => {
      let answer;
      try { answer = JSON.parse(out); } catch { return finish(undefined); }
      const decision = answer?.decision;
      finish(decision === "allow" || decision === "deny" || decision === null ? decision : undefined);
    });
    child.stdin.end(JSON.stringify(event));
  });
}

const pause = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

async function ask(event, signal) {
  for (let attempt = 0; attempt <= RETRY_MS.length && !signal.aborted; attempt++) {
    if (attempt > 0) await pause(RETRY_MS[attempt - 1], signal);
    if (signal.aborted) break;
    const decision = await relayOnce(event, signal);
    if (decision !== undefined) return decision;
  }
  return null;
}

/** The hub's decision, or a promise that never settles where it gives none: the dialog's answer is then the only one. */
const hubDecision = (event, signal) => ask(event, signal).then((decision) => decision ?? new Promise(() => {}));

let telling = Promise.resolve();

/**
 * Tells the hub what asks nothing (a run of the agent's began or ended): one relay run, its answer not read, each after
 * the one told before it, so that the hub hears them in their order. One that fails, or takes longer than TELL_MS, is not
 * told again; nor does one keep the agent from exiting.
 */
const TELL_MS = 5000;
function tell(event) {
  telling = telling.then(() => new Promise((resolve) => {
    const child = spawn(HOOK.command, HOOK.args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), TELL_MS);
    timer.unref?.();
    child.unref();
    const done = () => { clearTimeout(timer); resolve(); };
    child.on("error", done);
    child.on("close", done);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(event));
  }));
}

/**
 * The live session knows both the used tokens and the current model's window. OmO can know the window but not the
 * used tokens after compacting: tell that as unknown, not zero, so an earlier exact sample stops taking precedence.
 */
function tellContext(_event, ctx) {
  if (typeof ctx?.getContextUsage !== "function") return;
  const usage = ctx.getContextUsage();
  tell({ contextUsage: usage?.tokens == null ? null : { used: usage.tokens, window: usage.contextWindow } });
}
`;

/**
 * `args` with `-e` and the extension written for this launch: `glue`, which hooks the agent and answers its dialog
 * with `hubDecision(event, signal)`, and may `tell(event)` of its runs, after the relay it runs (`HOOK`) and `ask`.
 */
export function extensionArgs(args: readonly string[] | undefined, hook: { command: string; args: string[] }, dir: string, glue: string): string[] {
  const source = [
    "// Ovis's approval hook for one launch of this agent (server/approvals/extension.ts). Written by Ovis, read once at start.",
    'import { spawn } from "node:child_process";',
    `const HOOK = ${JSON.stringify(hook)};`,
    ASK,
    glue,
  ].join("\n");
  return ["-e", settingsFile(source, dir, ".js"), ...args ?? []];
}

/** A shell command's request, as the extension sends it, or null for anything else. */
function toCard(event: unknown): ApprovalRequest | null {
  const input = event as { tool?: unknown; command?: unknown; description?: unknown } | null;
  if (typeof input !== "object" || input === null || input.tool !== "bash" || typeof input.command !== "string" || input.command.trim() === "") return null;
  return { command: input.command, description: typeof input.description === "string" && input.description.trim() !== "" ? input.description : null };
}

/** A run of the agent's an extension told began or ended (`tell({ run })`), or null for any other event. */
export function runTurn(event: unknown): TurnEvent | null {
  const run = (event as { run?: unknown } | null)?.run;
  return run === "began" || run === "ended" ? { turn: run, prompt: null } : null;
}

/** Undefined is not a context event; null is a report that the agent cannot measure its context yet. */
export function contextUsage(event: unknown): PaneContext | null | undefined {
  if (typeof event !== "object" || event === null || !("contextUsage" in event)) return undefined;
  const usage = event.contextUsage;
  if (usage === null) return null;
  if (typeof usage !== "object" || !("used" in usage) || !("window" in usage)) return undefined;
  const { used, window } = usage;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0
    || typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined;
  return { used, window };
}

export function permissionDecision(label: string): ApprovalDecision | null {
  return label === ALLOW_LABEL ? "allow" : label === DENY_LABEL ? "deny" : null;
}

/** The adapter of an agent of pi's line whose extension is `glue`, for the versions `supports` takes. */
export function extensionApprovals(kind: string, supports: (version: string) => boolean, glue: string): ApprovalAdapter {
  return {
    kind,
    supports,
    launchArgs: (args, hook, dir) => extensionArgs(args, hook, dir, glue),
    toCard,
    decision: permissionDecision,
    toAnswer: (decision) => JSON.stringify({ decision }),
  };
}
