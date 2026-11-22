import type { CommandForm, HerdrPane, SlashCommand } from "../shared/protocol.ts";
import { FileBusyError, fileTask } from "./file-pool.ts";
import type { FileTask } from "./file-tasks.ts";
import { AGENT_SOURCES } from "./skills/index.ts";
import type { AgentCommandSource, ProcessRoots } from "./skills/index.ts";
import { ancestorsToRepoRoot } from "./skills/walk.ts";
import { userHome } from "./user-home.ts";

const DESCRIPTIONS: Record<string, string> = {
  clear: "Clear the conversation", compact: "Compact conversation context", config: "Open configuration",
  cost: "Show token usage and cost", help: "Show available commands", init: "Initialize project instructions",
  memory: "Edit agent memory", model: "Choose a model", permissions: "Manage tool permissions", review: "Review changes",
  status: "Show session status", doctor: "Check the installation", login: "Sign in", logout: "Sign out",
  "pr-comments": "Fetch pull request comments", "release-notes": "Show release notes", "terminal-setup": "Configure terminal integration",
  vim: "Toggle Vim mode", new: "Start a new session", sessions: "List sessions", exit: "Exit the agent",
  diff: "Show the current diff", quit: "Exit the agent",
  goal: "[condition|clear] — Keep working until a condition is met",
  effort: "Set effort level for model usage",
};

const UNKNOWN_FORMS: readonly CommandForm[] = [{ match: "bare", interaction: "unknown" }];

const majorMinor = (version: string | null | undefined): string | null => version?.match(/^(\d+)\.(\d+)(?:\D|$)/)?.slice(1, 3).join(".") ?? null;

function visibility(source: AgentCommandSource, name: string): NonNullable<SlashCommand["visibility"]> {
  if (source.terminalBound?.includes(name)) return "terminal";
  if (source.agentHidden?.includes(name)) return "agent-hidden";
  return "offered";
}

export function builtinCommands(agent: string | null | undefined, version?: string | null): SlashCommand[] {
  if (!agent || !Object.hasOwn(AGENT_SOURCES, agent)) return [];
  const source = AGENT_SOURCES[agent];
  if (!source) return [];
  const running = majorMinor(version);
  const verified = running !== null && [source.pin ?? []].flat().some((pin) => majorMinor(pin) === running);
  const builtinNames = [...new Set([...source.builtins, ...(source.terminalBound ?? []), ...(source.agentHidden ?? [])])];
  return builtinNames.map((name) => ({
    name, description: source.descriptions?.[name] ?? DESCRIPTIONS[name] ?? `Run /${name}`, source: "builtin",
    forms: [...(source.forms?.[name] ?? UNKNOWN_FORMS)], visibility: visibility(source, name), provenance: { transport: "static", verified },
  }));
}

const paneCatalogs = new Map<string, { identity: string; agent: string | null; commands: SlashCommand[] }>();
const catalogIdentity = (pane: HerdrPane): string => JSON.stringify([pane.terminal_id, pane.agent_session, pane.agent, pane.foreground_cwd ?? pane.cwd]);

export function rememberPaneCommands(pane: HerdrPane, agent: string | null, commands: SlashCommand[]): void {
  paneCatalogs.delete(pane.pane_id);
  paneCatalogs.set(pane.pane_id, { identity: catalogIdentity(pane), agent, commands });
  if (paneCatalogs.size > 128) paneCatalogs.delete(paneCatalogs.keys().next().value!);
}

export function cachedPaneCommands(pane: HerdrPane): { agent: string | null; commands: SlashCommand[] } | undefined {
  const cached = paneCatalogs.get(pane.pane_id);
  return cached?.identity === catalogIdentity(pane) ? cached : undefined;
}

/**
 * How long one request waits for its scan, counted from when the request arrived (its herdr lookups
 * included), before it is answered 503: under the minute a signed-in API request may go without a
 * byte before Bun closes it (`index.ts`), with room for what the route does after the scan.
 */
export const COMMANDS_WAIT_MS = 45_000;
export const UNCLAIMED_SCAN_MS = 35_000;
let waitMs = COMMANDS_WAIT_MS;

export function setCommandsWait(ms = COMMANDS_WAIT_MS): void {
  waitMs = ms;
}

interface Scan { result: Promise<SlashCommand[]>; waiters: number; running: boolean; abort: AbortController }
const scans = new Map<string, Scan>();
const unclaimed = new Map<string, { commands: SlashCommand[]; size: number; timer: ReturnType<typeof setTimeout> }>();
const UNCLAIMED_LIMITS = { entries: 16, chars: 8 * 1024 * 1024 };
let unclaimedLimits = UNCLAIMED_LIMITS;
let unclaimedChars = 0;

export function setUnclaimedLimits(limits: Partial<typeof UNCLAIMED_LIMITS> = {}): void {
  unclaimedLimits = { ...UNCLAIMED_LIMITS, ...limits };
  for (const key of [...unclaimed.keys()]) dropUnclaimed(key);
}

function dropUnclaimed(key: string): SlashCommand[] | undefined {
  const kept = unclaimed.get(key);
  if (kept === undefined) return undefined;
  unclaimed.delete(key);
  clearTimeout(kept.timer);
  unclaimedChars -= kept.size;
  return kept.commands;
}

function keepUnclaimed(key: string, commands: SlashCommand[]): void {
  dropUnclaimed(key);
  const size = commands.reduce((sum, command) => sum + JSON.stringify(command).length, 0);
  if (size > unclaimedLimits.chars) return;
  while (unclaimed.size > 0 && (unclaimed.size >= unclaimedLimits.entries || unclaimedChars + size > unclaimedLimits.chars)) dropUnclaimed(unclaimed.keys().next().value!);
  const timer = setTimeout(() => { if (unclaimed.get(key)?.timer === timer) dropUnclaimed(key); }, UNCLAIMED_SCAN_MS);
  timer.unref?.();
  unclaimed.set(key, { commands, size, timer });
  unclaimedChars += size;
}

export async function commandScansSettled(): Promise<void> {
  await Promise.allSettled([...scans.values()].map((scan) => scan.result));
}

/**
 * `paneCommands` run on a file thread (`file-pool.ts`), never on the server's: the scan reads every
 * skill and command folder the agent would, synchronously, and a folder on a slow mount (9p, a
 * network share) took 10-27 s there, stalling every terminal and request with it (#2254).
 *
 * A request waits for its scan until `COMMANDS_WAIT_MS` after it `began`, or until `signal` aborts,
 * and is then refused with `FileBusyError` (503). A scan a thread runs goes on: a request for the
 * same scan made meanwhile (the menu asks again after a failed read) waits for it rather than
 * starting another, and if it finishes after everyone waiting gave up, the next request for it
 * takes that answer (within `UNCLAIMED_SCAN_MS`), so a scan slower than one request's wait still
 * answers. A scan still waiting for a thread when its last request leaves is dropped, so it holds
 * no waiting place. An answer a request received is not kept: the next request scans again, and
 * sees a skill added since. An agent with no scan answers at once, without a thread.
 */
export function scanPaneCommands(agent: string | null | undefined, cwd: string | null | undefined, process: ProcessRoots = {}, version?: string | null, signal?: AbortSignal, began = performance.now()): Promise<SlashCommand[]> {
  if (!agent || !Object.hasOwn(AGENT_SOURCES, agent)) return Promise.resolve([]);
  if (signal?.aborted) return Promise.reject(new FileBusyError("the request was cancelled"));
  const roots: ProcessRoots = { agentDir: process.agentDir ?? null, pluginDir: process.pluginDir ?? null, environ: process.environ ?? null };
  const task: FileTask = { op: "commands", agent, cwd: cwd ?? null, home: userHome(), roots, version: version ?? null, serverEnv: { ...globalThis.process.env } };
  const key = JSON.stringify(task);
  const kept = dropUnclaimed(key);
  if (kept !== undefined) return Promise.resolve(kept);
  let scan = scans.get(key);
  if (scan === undefined) {
    const abort = new AbortController();
    const started: Scan = { result: Promise.resolve([]), waiters: 0, running: false, abort };
    started.result = fileTask<SlashCommand[]>(task, abort.signal, () => { started.running = true; });
    started.result.then((commands) => {
      if (scans.get(key) === started) scans.delete(key);
      if (started.waiters === 0) keepUnclaimed(key, commands);
    }, () => { if (scans.get(key) === started) scans.delete(key); });
    scans.set(key, started);
    scan = started;
  }
  const joined = scan;
  joined.waiters += 1;
  return new Promise<SlashCommand[]>((done, fail) => {
    let waiting = true;
    const leave = (): boolean => {
      if (!waiting) return false;
      waiting = false;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      joined.waiters -= 1;
      if (joined.waiters === 0 && !joined.running) {
        if (scans.get(key) === joined) scans.delete(key);
        joined.abort.abort();
      }
      return true;
    };
    const timer = setTimeout(() => { if (leave()) fail(new FileBusyError("the skill folders did not answer in time")); }, Math.max(0, began + waitMs - performance.now()));
    const cancel = () => { if (leave()) fail(new FileBusyError("the request was cancelled")); };
    signal?.addEventListener("abort", cancel, { once: true });
    joined.result.then((commands) => { if (leave()) done(commands); }, (error: unknown) => { if (leave()) fail(error); });
  });
}

export function paneCommands(agent: string | null | undefined, cwd: string | null | undefined, home = userHome(), process: ProcessRoots = {}, version?: string | null, serverEnv?: Readonly<Record<string, string | undefined>>): SlashCommand[] {
  if (!agent || !Object.hasOwn(AGENT_SOURCES, agent)) return [];
  const source = AGENT_SOURCES[agent];
  if (!source) return [];
  const builtins = new Map(builtinCommands(agent, version).map((command) => [command.name, command]));
  const ancestors = cwd ? ancestorsToRepoRoot(cwd, home) : [];
  const discovered = source.discover({ home, cwd, repoRoot: ancestors.at(-1) ?? null, env: process.environ ?? null, roots: process, version, ...(serverEnv ? { serverEnv } : {}) });
  const commands: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const found of discovered) {
    const trigger = found.trigger ?? "/";
    if (found.id !== undefined) {
      const key = JSON.stringify([trigger, found.name, found.id]);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const command: SlashCommand = { ...found, forms: found.forms ?? [...UNKNOWN_FORMS], visibility: found.visibility ?? "offered", provenance: found.provenance ?? { transport: "scan", verified: false } };
    if (trigger === "/" && source.skillsOverrideBuiltins && builtins.delete(found.name)) command.shadows = "builtin";
    commands.push(command);
  }
  return [...builtins.values(), ...commands].sort((left, right) => left.name.localeCompare(right.name) || left.source.localeCompare(right.source));
}
