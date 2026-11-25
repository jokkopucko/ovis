/**
 * The ACP children this server runs: each agent Ovis drives over ACP runs under its own keeper (crates/acp-keeper) in a
 * herdr-core terminal of this PC, which sits under its parent's terminal (G1) and is labelled `ovis.acp` with the
 * child's id. The keeper's ROOT is `<state>/acp/<id>`, private to this user, and this server is the keeper's ACP client
 * (KeeperClient). Stopping the server closes the clients but leaves the keepers: a keeper keeps its turn across an Ovis
 * restart, and the next start re-attaches to it (`restore`). Only this server's own ROOTs and the terminals they name are
 * ever touched.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HcMethods } from "../herdr-core/hc-api.generated.ts";
import { PANE_NAME_LABEL, TAB_NAME_LABEL } from "../herdr-core/snapshot.ts";
import { coreConnection, hcMachine } from "../herdr-core/runtime.ts";
import { capabilities } from "../runtime/capabilities.ts";
import { KeeperClient } from "./client.ts";
import { keeperRunning } from "./keeper-process.ts";
import { acpKeeperBin } from "./keeper-bin.ts";

type AcpHcMethod = "terminal.run" | "terminal.kill" | "terminal.list" | "terminal.label";
/** The hc calls the registry makes (HcConnection, or a test's stand-in). */
export interface AcpHc {
  call<M extends AcpHcMethod>(method: M, params: HcMethods[M]["params"]): Promise<HcMethods[M]["result"]>;
}

export interface AcpStart {
  /** the agent kind, as a card names it */
  harness: string;
  /** the agent's command line, passed to the keeper as it is */
  argv: readonly string[];
  cwd: string;
  /** the terminal (pane) the child sits under */
  parentPane?: string;
  /** the keeper's name for the agent, on its status line (default the harness) */
  name?: string;
  /** `_meta` of the keeper's `session/new` (the Claude adapter takes its model and settings this way) */
  sessionMeta?: unknown;
  /** `configOptions` of the keeper's `session/new`, set before the agent answers it */
  configOptions?: readonly unknown[];
  /** environment variables, each naming a file of that name in the child's private ROOT */
  privateFiles?: Record<string, string>;
  /** the terminal's environment over the core's */
  env?: Record<string, string>;
  runId?: string;
  mcpServers?: readonly { name: string; command: string; args: readonly string[]; env: readonly { name: string; value: string }[] }[];
  announceSubagents?: boolean;
  askEveryTime?: boolean;
}

export interface AcpChild {
  id: string;
  harness: string;
  root: string;
  /** the keeper's terminal, which is its pane */
  terminal: string;
  client: KeeperClient;
}

export class AcpUnavailable extends Error {
  constructor(readonly reason: "not_local" | "no_keeper" | "path_too_long", message: string) {
    super(message);
    this.name = "AcpUnavailable";
  }
}

export class AcpStartFailed extends Error {
  constructor(readonly reason: "no_socket" | "no_session" | "agent_exited" | "refused", message: string, readonly agentCode?: number) {
    super(message);
    this.name = "AcpStartFailed";
  }
}

export interface AcpChildrenOptions {
  /** default this server's core (coreConnection) */
  hc?: AcpHc;
  keeperBin?: () => string | null;
  /** how long a start waits for the keeper's socket */
  socketMs?: number;
  /** how long a start waits for the agent's session (its answers to `initialize` and `session/new`) */
  sessionMs?: number;
}

const LABEL = "ovis.acp";
const CHILD_FILE = "child.json";
/** Under the shortest limit on a socket's path (104 bytes on macOS), with room for its terminating byte. */
const SOCKET_PATH_MAX = 100;
const SOCKET_MS = 10_000;
const SESSION_MS = 30_000;
/** How long a stop waits for a keeper to end after its terminal was killed (it ends its agent within 1.5 s). */
const KEEPER_END_MS = 3_000;

/**
 * Waits, bounded, for the keeper in `root` to exit. It is no child of this server, so nothing signals its end: its pid is
 * looked at again every 20 ms.
 */
async function keeperEnds(root: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (keeperRunning(root)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(20);
  }
  return true;
}

/** Waits, bounded, for the keeper to create its socket in `root`: a file it makes, watched rather than polled. */
function socketAppears(root: string, ms: number): Promise<boolean> {
  const socket = join(root, "acp.sock");
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const watcher = watch(root, () => { if (existsSync(socket)) done(true); });
  const timer = setTimeout(() => done(false), ms);
  function done(appeared: boolean) {
    clearTimeout(timer);
    watcher.close();
    resolve(appeared);
  }
  if (existsSync(socket)) done(true);
  return promise;
}

/**
 * Waits, bounded, for the agent's session and the end of the client's replay (a child whose client still replays is
 * "unknown" and takes no prompt), or for the agent to end first: an end the replay already shows wins over its session.
 */
type Opening = "open" | "exited" | "late" | "refused";
function sessionOpens(client: KeeperClient, ms: number): Promise<Opening> {
  const state = () => client.sessionError ? "refused" : client.agentGone || client.keeperGone ? "exited" : client.session !== null && client.connected ? "open" : null;
  const now = state();
  if (now !== null) return Promise.resolve(now);
  const { promise, resolve } = Promise.withResolvers<Opening>();
  const timer = setTimeout(() => { off(); resolve("late"); }, ms);
  const off = client.onChange(() => {
    const reached = state();
    if (reached === null) return;
    clearTimeout(timer);
    off();
    resolve(reached);
  });
  return promise;
}

function owned(path: string, kind: "directory" | "file"): boolean {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat !== undefined && (process.getuid === undefined || stat.uid === process.getuid()) && (kind === "directory" ? stat.isDirectory() : stat.isFile());
}

function harnessOf(root: string): string | null {
  try {
    if (!owned(root, "directory") || !owned(join(root, CHILD_FILE), "file")) return null;
    const harness = (JSON.parse(readFileSync(join(root, CHILD_FILE), "utf8")) as { harness?: unknown }).harness;
    return typeof harness === "string" && harness !== "" ? harness : null;
  } catch {
    return null;
  }
}

export class AcpChildren {
  private readonly listeners = new Set<(child: AcpChild) => void>();

  onStatus(listener: (child: AcpChild) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private readonly children = new Map<string, AcpChild>();

  constructor(private readonly dir: string, private readonly options: AcpChildrenOptions = {}) {}

  private hc(): AcpHc {
    return this.options.hc ?? coreConnection();
  }

  /** ACP children run only on this PC's own herdr-core: hc's terminals elsewhere are another machine's. */
  private refusal(): AcpUnavailable | null {
    return capabilities().acpChildren && hcMachine() === null ? null : new AcpUnavailable("not_local", "ACP children run only on this PC's herdr-core");
  }

  /** The folder the ROOTs live in, made private to this user; one that is there already must be this user's own. */
  private folder(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!owned(this.dir, "directory")) throw new Error(`${this.dir} is not a folder of this account`);
    chmodSync(this.dir, 0o700);
  }

  async start(start: AcpStart): Promise<AcpChild> {
    const refused = this.refusal();
    if (refused !== null) throw refused;
    const bin = (this.options.keeperBin ?? acpKeeperBin)();
    if (bin === null) throw new AcpUnavailable("no_keeper", "no ACP keeper is installed or built");
    const id = randomBytes(6).toString("hex");
    const root = join(this.dir, id);
    if (Buffer.byteLength(join(root, "acp.sock")) > SOCKET_PATH_MAX) throw new AcpUnavailable("path_too_long", `the keeper's socket under ${this.dir} would pass the OS's limit on a socket's path`);
    this.folder();
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);
    writeFileSync(join(root, CHILD_FILE), JSON.stringify({ harness: start.harness }), { mode: 0o600 });
    const argv = [
      bin, root, "--cwd", start.cwd, "--name", start.name ?? start.harness,
      ...(start.sessionMeta === undefined ? [] : ["--session-meta", JSON.stringify(start.sessionMeta)]),
      ...(start.mcpServers === undefined ? [] : ["--mcp-servers", JSON.stringify(start.mcpServers)]),
      ...(start.configOptions === undefined ? [] : ["--config-options", JSON.stringify(start.configOptions)]),
      ...(start.announceSubagents ? ["--announce-subagents"] : []),
      ...(start.askEveryTime ? ["--ask-every-time"] : []),
      "--", ...start.argv,
    ];
    const displayName = start.name?.trim();
    let terminal: string;
    try {
      ({ address: terminal } = await this.hc().call("terminal.run", {
        argv, cwd: start.cwd,
        ...(start.parentPane === undefined ? { no_parent: true } : { parent: start.parentPane }),
        labels: { [LABEL]: id, ...(start.runId ? { "ovis.run": start.runId } : {}), ...(displayName ? { [PANE_NAME_LABEL]: displayName, [TAB_NAME_LABEL]: displayName } : {}) },
        ...(start.env === undefined && start.privateFiles === undefined ? {} : { env: { ...start.env, ...Object.fromEntries(Object.entries(start.privateFiles ?? {}).map(([name, file]) => [name, join(root, file)])) } }),
      }));
    } catch (error) {
      const live = await this.liveTerminals().catch((lookupError: unknown) => {
        console.warn(`acp: keeping ${root} after terminal lookup failed: ${lookupError instanceof Error ? lookupError.message : String(lookupError)}`);
        return null;
      });
      if (live !== null) {
        const address = live.get(id);
        if (typeof address === "string") await this.endFailedStart(address, root);
        else if (address === undefined) rmSync(root, { recursive: true, force: true });
      }
      throw error;
    }
    const failed = async (reason: AcpStartFailed["reason"], message: string, client?: KeeperClient): Promise<never> => {
      client?.close();
      await this.endFailedStart(terminal, root);
      throw new AcpStartFailed(reason, message, client?.sessionError?.code);
    };
    if (!(await socketAppears(root, this.options.socketMs ?? SOCKET_MS))) return failed("no_socket", "the ACP keeper did not open its socket");
    const client = new KeeperClient(root);
    const opened = await sessionOpens(client, this.options.sessionMs ?? SESSION_MS);
    if (opened === "refused") return failed("refused", "the agent refused to open the ACP session", client);
    if (opened === "late") return failed("no_session", "the agent did not open a session (no answer to initialize or session/new)", client);
    if (opened === "exited") return failed("agent_exited", "the agent ended before its session opened", client);
    return this.add({ id, harness: start.harness, root, terminal, client });
  }

  private async liveTerminals(): Promise<Map<string, string | null>> {
    const terminals = await this.terminals();
    const live = new Map<string, string | null>();
    for (const terminal of terminals) {
      const id = terminal.labels[LABEL];
      if (id === undefined || terminal.state !== "live") continue;
      if (!live.has(id)) live.set(id, terminal.address);
      else if (live.get(id) !== null && live.get(id) !== terminal.address) {
        console.warn(`acp: multiple live terminals for ${id}; leaving it unbound`);
        live.set(id, null);
      }
    }
    return live;
  }

  async terminals() { return (await this.hc().call("terminal.list", {})).terminals; }

  private add(child: AcpChild): AcpChild {
    this.children.set(child.id, child);
    let state = child.client.status;
    let plan = child.client.history.plan;
    let hold = child.client.holdGeneration;
    for (const listener of this.listeners) listener(child);
    // a keeper that ended by itself (Ctrl+Q in its pane, its terminal closed) takes its child along
    const off = child.client.onChange(() => {
      if (this.children.get(child.id) !== child) return;
      if (state !== child.client.status || plan !== child.client.history.plan || hold !== child.client.holdGeneration || child.client.keeperGone) {
        state = child.client.status;
        plan = child.client.history.plan;
        hold = child.client.holdGeneration;
        for (const listener of this.listeners) listener(child);
      }
      if (!child.client.keeperGone) return;
      off();
      this.children.delete(child.id);
      if (!keeperRunning(child.root)) rmSync(child.root, { recursive: true, force: true });
    });
    return child;
  }

  /** The child whose keeper runs in `paneId`'s terminal. */
  forPane(paneId: string): AcpChild | undefined {
    for (const child of this.children.values()) if (child.terminal === paneId) return child;
    return undefined;
  }

  /** This server's children whose keeper's terminal hc runs under `parentPane`. */
  async childrenOf(parentPane: string): Promise<AcpChild[]> {
    const under = (await this.terminals()).filter(terminal => terminal.state === "live" && terminal.parent === parentPane);
    return [...this.children.values()].filter(child => under.some(terminal => terminal.address === child.terminal && terminal.labels[LABEL] === child.id));
  }

  cancelTurn(id: string): void {
    const client = this.children.get(id)?.client;
    if (client?.turn?.running && client.session) client.notify("session/cancel", { sessionId: client.session });
  }

  async markTimeLimit(id: string): Promise<void> {
    const child = this.children.get(id);
    if (child) await this.hc().call("terminal.label", { terminal: child.terminal, labels: { "ovis.limit": "time" } });
  }

  /**
   * Kills the keeper's terminal (the keeper ends its agent with it); ROOT goes once the keeper is gone, as a keeper still
   * ending writes its last rows there. One that outlives the wait leaves ROOT to restore().
   */
  private async end(terminal: string, root: string): Promise<void> {
    await this.hc().call("terminal.kill", { terminal });
    if (await keeperEnds(root, KEEPER_END_MS)) rmSync(root, { recursive: true, force: true });
    else console.warn(`acp: keeping ${root}: its keeper is still running after its terminal was killed`);
  }

  private async endFailedStart(terminal: string, root: string): Promise<void> {
    try {
      await this.end(terminal, root);
    } catch (error) {
      // a ROOT whose terminal may still run stays: restore() removes it once its keeper is gone
      console.warn(`acp: could not end ${terminal}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops a child: the running turn is cancelled, then its terminal is killed and it is forgotten. */
  async stop(id: string): Promise<void> {
    const child = this.children.get(id);
    if (child === undefined) return;
    const { client } = child;
    this.cancelTurn(id);
    await this.end(child.terminal, child.root);
    client.close();
    if (this.children.get(id) === child) this.children.delete(id);
  }

  /**
   * At the server's start: re-attaches to every live terminal labelled with one of this server's ROOTs (the client
   * replays its keeper's log from the start), and removes the ROOTs no live terminal names whose keeper is gone.
   */
  async restore(): Promise<void> {
    if (this.refusal() !== null || !owned(this.dir, "directory")) return;
    const live = await this.liveTerminals();
    for (const id of readdirSync(this.dir)) {
      const root = join(this.dir, id);
      if (!/^[a-f0-9]{12}$/.test(id)) continue;
      const harness = harnessOf(root);
      if (harness === null) continue;
      const terminal = live.get(id);
      if (terminal === null) continue;
      if (terminal !== undefined) {
        if (!this.children.has(id)) this.add({ id, harness, root, terminal, client: new KeeperClient(root) });
      } else if (!keeperRunning(root)) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }

  /** The server stops: its clients close, and the keepers go on with their turns. */
  close(): void {
    for (const child of this.children.values()) child.client.close();
    this.children.clear();
  }
}
