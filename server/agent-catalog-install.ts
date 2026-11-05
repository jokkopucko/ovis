/**
 * POST /api/agent-catalog/install and /api/agent-catalog/sign-in: an agent's official install
 * command, or its sign-in, run where the user sees it. The server picks the command from the catalog
 * by the agent's id and this PC's platform; a request never carries a command. It opens a terminal
 * tab and types the command into its shell, so every line shows and Ctrl+C stops it; nothing is run
 * in the background. What was installed is read again through GET /api/agent-catalog.
 * The dispatcher in index.ts runs the access gate first: a watching device cannot reach these.
 */
import { homedir } from "node:os";
import { AGENT_CATALOG, catalogPlatform, commandProblems, type AgentCatalogEntry, type AgentTabStarted, type CatalogPlatform } from "../shared/agent-catalog.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { paneProcessInfo, paneSendKeys, paneSendText, sessionSnapshot, tabClose, tabCreate, workspaceCreate } from "./herdr/client.ts";
import { badRequest, conflictResponse, errorResponse, jsonResponse, readJsonObject, setRequestRoute } from "./http.ts";
import { paneShell, shellCommandLine, type PaneShell } from "./shell-agent.ts";
import { descendantProcesses, windowsProcessTable, type ProcessRow } from "./windows-processes.ts";

export const INSTALL_PATH = "/api/agent-catalog/install";
export const SIGN_IN_PATH = "/api/agent-catalog/sign-in";

async function openTab(label: string, home: string): Promise<{ paneId: string; tabId: string; workspaceId: string }> {
  const snapshot = await sessionSnapshot();
  const workspace = snapshot.workspaces[0];
  const options = { cwd: home, label };
  const created = workspace ? await tabCreate({ ...options, workspaceId: workspace.workspace_id }) : await workspaceCreate(options);
  return { paneId: created.root_pane.pane_id, tabId: created.tab.tab_id, workspaceId: created.tab.workspace_id };
}

/** How long, in all, a new Windows tab's shell has to come in front before nothing is typed there. */
const SHELL_WAIT_MS = 10_000;
/** How long a typed install command has to show a program running in its tab before it counts as ended. */
const INSTALL_START_MS = 120_000;
/** The longest one install holds its agent, whatever its tab shows. */
const INSTALL_CAP_MS = 30 * 60_000;

/** Time as the install routes read it; tests drive their own. A sleep whose signal aborts never ends. */
export interface InstallClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
const realClock: InstallClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }),
};

const TIMED_OUT = Symbol("timed out");
/** `work`'s answer, or TIMED_OUT when it has not come within `ms`; a rejection before then is passed on. */
async function within<T>(work: Promise<T>, ms: number, clock: InstallClock): Promise<T | typeof TIMED_OUT> {
  const settled = new AbortController();
  try {
    return await Promise.race([work, clock.sleep(ms, settled.signal).then((): typeof TIMED_OUT => TIMED_OUT)]);
  } finally {
    settled.abort();
  }
}

/**
 * The shell running in a new pane: POSIX off Windows; on Windows the one herdr reports in front once
 * it starts, or null when herdr names neither PowerShell nor cmd.exe within `waitMs` in all, slow
 * answers included. Nothing is typed into a shell that is not known.
 */
async function shellOf(paneId: string, platform: CatalogPlatform, waitMs: number, clock: InstallClock): Promise<PaneShell | null> {
  if (platform !== "windows") return "posix";
  const deadline = clock.now() + waitMs;
  for (;;) {
    const left = deadline - clock.now();
    if (left <= 0) return null;
    const info = await within(paneProcessInfo(paneId), left, clock);
    if (info === TIMED_OUT) return null;
    const argv0 = info?.foreground_processes?.[0]?.argv?.[0];
    const shell = argv0 === undefined ? null : paneShell(argv0);
    if (shell !== null && shell !== "posix") return shell;
    const pause = Math.min(250, deadline - clock.now());
    if (pause <= 0) return null;
    await clock.sleep(pause);
  }
}

/** Closes a tab this route opened and could not finish starting; a close that fails leaves the first error to report. */
async function closeUnstarted(tabId: string): Promise<void> {
  await tabClose(tabId).catch(() => undefined);
}

const shellUnknown = () => conflictResponse("shell_unknown", "Ovis could not tell which shell the new tab runs, so it typed nothing there");

/** The fields each route takes; any other field is refused, so a request cannot carry a command or a platform. */
const FIELDS: Record<string, readonly string[]> = { [INSTALL_PATH]: ["agent", "alternative"], [SIGN_IN_PATH]: ["agent"] };

/**
 * An install this PC has started: its tab's pane once it has one, when its command was typed (null
 * while its own request still starts it), and whether a program was seen running in its tab since.
 */
type Running = { paneId: string | null; typedAt: number | null; seenRunning: boolean };

/** Types `text` into the pane's shell and runs it: a newline on POSIX, the Enter key on Windows (see shell-agent.ts). */
async function typeAndRun(paneId: string, text: string, shell: PaneShell): Promise<void> {
  if (shell === "posix") {
    await paneSendText(paneId, `${text}\n`);
    return;
  }
  await paneSendText(paneId, text);
  await paneSendKeys(paneId, ["Enter"]);
}

export class AgentInstaller {
  constructor(
    private readonly detector: AgentDetector,
    private readonly platform: CatalogPlatform | null = catalogPlatform(process.platform),
    private readonly home: string = homedir(),
    private readonly options: { shellWaitMs?: number; startWindowMs?: number; capMs?: number; processTable?: () => Promise<ProcessRow[]>; clock?: InstallClock } = {},
  ) {}

  get #clock(): InstallClock {
    return this.options.clock ?? realClock;
  }

  /**
   * Types into a tab just opened: `work` returns the response, or null when nothing may be typed
   * there. The tab is closed when nothing was typed, and when `work` fails.
   */
  async #inNewTab(tabId: string, work: () => Promise<Response | null>, refused: () => Response): Promise<Response> {
    let response: Response | null;
    try {
      response = await work();
    } catch (error) {
      await closeUnstarted(tabId);
      throw error;
    }
    if (response === null) {
      await closeUnstarted(tabId);
      return refused();
    }
    return response;
  }

  async handle(request: Request, pathname: string): Promise<Response | null> {
    if (pathname !== INSTALL_PATH && pathname !== SIGN_IN_PATH) return null;
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "use POST");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    const extra = Object.keys(body).filter((field) => !FIELDS[pathname]!.includes(field));
    if (extra.length > 0) return badRequest("unknown_field", `This route does not take ${extra.join(", ")}`);
    const entry = AGENT_CATALOG.find((candidate) => candidate.id === body["agent"]);
    if (!entry) return badRequest("unknown_agent", "Name an agent from GET /api/agent-catalog");
    if (this.platform === null) return conflictResponse("platform_unsupported", "Ovis has no install commands for this operating system");
    try {
      return pathname === INSTALL_PATH ? await this.#install(entry, this.platform, body) : await this.#signIn(entry, this.platform);
    } catch (error) {
      return errorResponse(error);
    }
  }

  /** by agent id: the install of that agent started on this PC, one at a time */
  readonly #running = new Map<string, Running>();

  /**
   * Whether a program other than the shell runs in the pane: one herdr names in front off Windows;
   * on Windows, where herdr names only the shell, one below the shell in the process table. Null
   * when that cannot be read.
   */
  async #programRunning(paneId: string, platform: CatalogPlatform): Promise<boolean | null> {
    const info = await paneProcessInfo(paneId).catch(() => undefined);
    const shellPid = info?.shell_pid;
    if (typeof shellPid !== "number") return null;
    if (platform === "windows") {
      const rows = await (this.options.processTable ?? windowsProcessTable)();
      return rows.length === 0 ? null : descendantProcesses(rows, shellPid).length > 0;
    }
    const front = info?.foreground_processes ?? [];
    return front.length === 0 ? null : front.some((process) => process.pid !== shellPid);
  }

  /**
   * Whether an earlier install still runs. It does while its own request starts it, and while its
   * installer runs in its tab. It ends when its tab closes, when the tab is back at its shell after
   * the installer was seen running (success or failure alike), when no installer was seen running
   * within INSTALL_START_MS of the command being typed, or at INSTALL_CAP_MS whatever the tab shows.
   * Finding the agent installed never ends it: an installer may put its binary in place first.
   */
  async #stillRunning(running: Running, platform: CatalogPlatform): Promise<boolean> {
    if (running.paneId === null || running.typedAt === null) return true;
    const paneId = running.paneId;
    const age = this.#clock.now() - running.typedAt;
    if (age >= (this.options.capMs ?? INSTALL_CAP_MS)) return false;
    if (!(await sessionSnapshot()).panes.some((pane) => pane.pane_id === paneId)) return false;
    const program = await this.#programRunning(paneId, platform);
    // not readable: held, and the cap still ends it
    if (program !== false) {
      if (program) running.seenRunning = true;
      return true;
    }
    return !running.seenRunning && age < (this.options.startWindowMs ?? INSTALL_START_MS);
  }

  async #install(entry: AgentCatalogEntry, platform: CatalogPlatform, body: Record<string, unknown>): Promise<Response> {
    const install = entry.install[platform];
    if (install === null) return conflictResponse("no_install_command", entry.no_install[platform] ?? "No official install command for this operating system");
    const index = body["alternative"];
    if (index !== undefined && !(Number.isInteger(index) && (index as number) >= 0 && (index as number) < install.alternatives.length)) {
      return badRequest("invalid_alternative", "alternative is the index of one of the platform's alternatives");
    }
    const method = index === undefined ? install.primary : install.alternatives[index as number]!;
    // the catalog's own check again, right before the text is typed: a command that fails it never runs
    if (commandProblems(entry).length > 0) return conflictResponse("command_refused", "This install command is not one of the vendor's own; it was not run");
    const held = this.#running.get(entry.id);
    // checked again after the wait: two requests that both saw an ended install do not both start one
    if (held !== undefined && (await this.#stillRunning(held, platform) || this.#running.get(entry.id) !== held)) {
      return conflictResponse("install_running", `${entry.name} is already being installed on this PC. Wait for its tab to finish, or close it.`);
    }
    const running: Running = { paneId: null, typedAt: null, seenRunning: false };
    this.#running.set(entry.id, running);
    let started = false;
    try {
      const { paneId, tabId, workspaceId } = await openTab(`Install ${entry.name}`, this.home);
      running.paneId = paneId;
      let shell: PaneShell | null = null;
      return await this.#inNewTab(tabId, async () => {
        shell = await shellOf(paneId, platform, this.options.shellWaitMs ?? SHELL_WAIT_MS, this.#clock);
        if (shell === null || shell !== method.shell) return null;
        await typeAndRun(paneId, method.command, shell);
        running.typedAt = this.#clock.now();
        started = true;
        return jsonResponse({ pane_id: paneId, workspace_id: workspaceId, command: method.command, shell } satisfies AgentTabStarted);
      }, () => shell === null ? shellUnknown() : conflictResponse("shell_mismatch", `This command is for ${method.shell}; the new tab runs ${shell}. Choose the other command.`));
    } finally {
      if (!started && this.#running.get(entry.id) === running) this.#running.delete(entry.id);
    }
  }

  async #signIn(entry: AgentCatalogEntry, platform: CatalogPlatform): Promise<Response> {
    if (entry.sign_in === null) return conflictResponse("no_sign_in", `${entry.name} needs no sign-in`);
    const [binary, ...args] = entry.sign_in.command ?? [entry.detect.binaries[0]!];
    const dirs = entry.detect.install_dirs?.[platform] ?? [];
    const executable = await this.detector.executable(binary!, dirs, platform);
    if (executable === null) return conflictResponse("not_installed", `${entry.name} is not installed on this PC`);
    // without a program it needs (DeepSeek Harness's dsh) its sign-in cannot start either
    for (const needed of entry.detect.needs ?? []) if ((await this.detector.executable(needed, dirs, platform)) === null) return conflictResponse("not_installed", `${entry.name} is not installed on this PC`);
    const { paneId, tabId, workspaceId } = await openTab(`Sign in to ${entry.name}`, this.home);
    return this.#inNewTab(tabId, async () => {
      const shell = await shellOf(paneId, platform, this.options.shellWaitMs ?? SHELL_WAIT_MS, this.#clock);
      if (shell === null) return null;
      const command = shellCommandLine(shell, executable, args);
      await typeAndRun(paneId, command, shell);
      return jsonResponse({ pane_id: paneId, workspace_id: workspaceId, command, shell } satisfies AgentTabStarted);
    }, shellUnknown);
  }
}
