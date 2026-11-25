/**
 * The approvals an agent Ovis starts on this PC asks through its own hook, held open while a card shows them: one hub
 * for every agent, with a small adapter per agent (ApprovalAdapter) for what differs.
 *
 * The hub owns the channel and everything about a request once it arrives: the listener (a unix socket in a 0700
 * folder of this server's state, a named pipe on Windows), a key per launch that names the pane the agent was started
 * in, the held requests and their ids, releasing them, and answering them. The hook runs `ovis-server approval-hook`
 * (server/approvals/relay.ts), which seals its request with the launch's key and takes only an answer sealed with it.
 * A loopback port would not do: once this server stopped, another account could take the port and answer for it; a
 * named pipe's name can be taken the same way, which the sealing covers. The unix socket's path stays the same
 * across restarts; a request under a key a restarted server does not know gets no decision.
 *
 * Whatever the hub cannot be sure of gets no decision, and the agent's own terminal dialog stands: an agent without an
 * adapter, a version its adapter does not support (or none read), an event its adapter does not take, a command a card
 * could not show whole, and any failure of the channel.
 *
 * A held request is kept apart from any screen: `held` lists a pane's requests and `settle` answers one by its id. A
 * card is built from the request alone (`shown`, `holds`, `answer`); the agent's dialog on the screen (Claude's
 * permission dialog, dialogs/claude.ts; OmO's permission dialog and the one Ovis's pi extension draws like it, dialogs/pi.ts)
 * only says whether the request is still open: one the screen shows no dialog for, or a dialog showing another request's
 * subject whole, was answered in the terminal. An adapter may also read the turns its agent's hook tells of
 * (`onTurn`) and the commands it says the agent ran (`onCommand`), which ask nothing and get no answer. The adapters: Claude Code (claude.ts), pi (pi.ts) and OmO (omo.ts).
 *
 * Codex asks no hook: Ovis is a client of its own app server (codex.ts), whose requests are held with `hold` and
 * released when Codex says they were answered, never by a read of the screen.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { settingsFile } from "../claude-settings-file.ts";
import { COMPILED, projectSafeCommand, ROOT } from "../entries.ts";
import { isNonce, keyDigest, LINE_MAX, lineObject, seal, unseal } from "./relay.ts";

export type ApprovalDecision = "allow" | "deny";

/** One approval an agent asks, as a card shows it. */
export interface ApprovalRequest {
  command: string;
  description: string | null;
  /**
   * What the agent's dialog shows of this request, whole, to tell it from another: its command unless set (Claude's
   * file dialogs show the file's path, not the text the card shows).
   */
  subject?: string;
  /** which of the agent's dialogs shows it, where it has several (Codex's command, edit, grant): no other is its */
  dialog?: string;
}

/**
 * What a read of the screen found of the agent's approval dialog: the subject of the request it asks (its command),
 * whole, or null where the screen does not show it whole (a panel taller than the pane).
 */
export interface ApprovalDialog {
  command: string | null;
  /** which of the agent's dialogs it is, where it has several (ApprovalRequest.dialog) */
  kind?: string;
}

/** A turn of the agent's that its hook told began (its prompt) or ended, with the prompt's id where the agent gives one. */
export interface TurnEvent {
  turn: "began" | "ended";
  prompt: string | null;
}

/**
 * A command the agent's hook told it ran: one of its own (`builtin`), or a skill or custom command it expanded, with the
 * argument it was given where the hook names it.
 */
export interface CommandEvent {
  name: string;
  builtin: boolean;
  args?: string;
}

/** A permission mode an agent's hook told, with the session it told it in. */
export interface ToldMode {
  mode: string;
  session: string;
}

export interface HeldApproval extends ApprovalRequest {
  /** what a card built on this request carries in its id, so that its answer settles this request and no other */
  id: string;
  /** the adapter's agent kind */
  kind: string;
}

/** What an agent's adapter fills in. Every method may refuse (null): the request is then the terminal's. */
export interface ApprovalAdapter {
  /** the agent kind it serves, as herdr names it */
  readonly kind: string;
  /** whether this version of the agent takes the hook as launchArgs adds it; an unknown version gets none */
  supports(version: string): boolean;
  /**
   * The agent's arguments with the hook added, which runs `hook.command` with `hook.args`. Files it needs go in `dir`,
   * the hub's own private folder. It never edits the user's own settings. Null leaves the launch without the hook.
   */
  launchArgs(args: readonly string[] | undefined, hook: { command: string; args: string[] }, dir: string): string[] | null;
  /** The approval an event the hook sent asks, or null for one the hub gives no decision on. */
  toCard(event: unknown): ApprovalRequest | null;
  /** The turn an event the hook sent tells of, for an agent whose hook tells them (Claude's Stop, OmO's runs), else null. */
  turn?(event: unknown): TurnEvent | null;
  /** The permission mode an event the hook sent was sent under, and the agent's session it was in, else null. */
  mode?(event: unknown): ToldMode | null;
  /** The command an event the hook sent says the agent ran (Claude's PostCompact), else null. */
  command?(event: unknown): CommandEvent | null;
  /** The decision a card option is, or null for an option that goes to the dialog as its keys. */
  decision(label: string): ApprovalDecision | null;
  /** What the hook prints for a decision, or for none (null), after which the agent's own dialog stands. */
  toAnswer(decision: ApprovalDecision | null): string;
}

interface Launch {
  key: string;
  paneId: string;
  adapter: ApprovalAdapter;
}

/** Who asks a held request: the agent kind its card names, and which card option is a decision. */
export type ApprovalSource = Pick<ApprovalAdapter, "kind" | "decision">;

interface Pending extends ApprovalRequest {
  nonce: string;
  adapter: ApprovalSource;
  at: number;
  /** released only by whoever holds it (hold), never by a read of the screen */
  pinned: boolean;
  settle: (decision: ApprovalDecision | null) => void;
}

/** The most of an event the hub reads, in UTF-8 bytes. */
const EVENT_MAX = 256 * 1024;
/** A read of the screen just before the agent draws its dialog must not release the hook it sent with it. */
const GRACE_MS = 3_000;
/**
 * Claude Code's own default for a command hook: past it the agent has stopped waiting on the request. pi's and OmO's
 * extensions wait on as long as their dialog does, which then stands alone.
 */
const HELD_MS = 600_000;
/** Under the shortest limit on a socket's path (104 bytes on macOS), with room for its terminating byte. */
const SOCKET_PATH_MAX = 100;
const LAUNCHES_MAX = 256;
/** The most of a card's body the bridge and the card show (finishPrompt, promptWords). */
const CARD_BODY_MAX = 12_000;
const SOCKET_NAME = "hub.sock";
const KEY_SUFFIX = ".key";

const spaced = (text: string): string => text.trim().replace(/\s+/g, " ");
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a dialog whose panel shows `screen` as its command shows this command, whole. Runs of white space count as
 * one; a line break on the screen is where the pane wrapped, which takes the space it broke at, or breaks a word.
 */
function shows(screen: string, command: string): boolean {
  const lines = screen.split("\n").map(spaced).filter(Boolean);
  return lines.length > 0 && new RegExp(`^${lines.map(literal).join(" ?")}$`).test(spaced(command));
}

/**
 * Whether the card can show this text as it is: no control character but newline and tab, no format character (bidi
 * controls, zero-width ones) or separator that draws a line break, no lone surrogate, and no run of blank lines or of
 * spaces long enough to push the rest out of sight.
 */
export function showable(text: string): boolean {
  return !/(?![\n\t])[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(text) && !/(?:^|\n)(?:[^\S\n]*\n){3}/.test(text) && !/[^\S\n]{40,}/.test(text);
}

/** In the order the agent's dialog draws them. */
export function heldBody(held: ApprovalRequest): string {
  return held.description === null ? held.command : `${held.description}\n${held.command}`;
}

/** Computed from the command and words again at each answer: the card's answer settles a request only while it holds what the card showed. */
const idOf = (entry: Pending): string =>
  createHash("sha256").update(JSON.stringify([entry.nonce, entry.command, entry.description])).digest("hex").slice(0, 16);

const publicOf = (entry: Pending): HeldApproval => ({ id: idOf(entry), kind: entry.adapter.kind, command: entry.command, description: entry.description });

const subjectOf = (entry: Pending): string => entry.subject ?? entry.command;

/**
 * Where the hub listens: the socket in its folder, or on Windows, where a socket is not offered here, a named pipe of a
 * name no other hub has. That name is new each run, so a restarted server is never at an earlier run's.
 */
export function hubAddress(dir: string, platform: string = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\ovis-approvals-${randomBytes(16).toString("hex")}` : join(dir, SOCKET_NAME);
}

/**
 * What the hook runs. The agent runs it in its working folder, the project, where a model may write files, and a Bun
 * there reads that folder's bunfig.toml (whose preload could print an allow) and .env. The compiled binary is built to
 * read neither (scripts/server-artifact.ts); from source, Bun gets Ovis's own config and no env file.
 */
export function relayCommand(root = ROOT, compiled = COMPILED): string[] {
  return projectSafeCommand("approval-hook", root, compiled);
}

export class ApprovalHub {
  private listener: Server | null = null;
  /** stopped with the server: a launch whose version was read after that gets no hook, and opens no listener again */
  private stopped = false;
  private readonly launches = new Map<string, Launch>();
  private readonly pending = new Map<string, Pending[]>();
  /** each pane's agent's permission mode, as its hook last told */
  private readonly modes = new Map<string, ToldMode>();
  private readonly adapters: ReadonlyMap<string, ApprovalAdapter>;
  private readonly platform: string;
  readonly address: string;

  constructor(private readonly dir: string, adapters: readonly ApprovalAdapter[], private readonly options: {
    now?: () => number; heldMs?: number; onHeld?: (paneId: string) => void; onSettled?: (paneId: string) => void; platform?: string;
    /** a turn of the agent started in `paneId` began or ended, as its hook told */
    onTurn?: (paneId: string, kind: string, turn: TurnEvent) => void;
    /** the agent started in `paneId` ran a command, as its hook told */
    onCommand?: (paneId: string, kind: string, command: CommandEvent) => void;
    /** what the hook runs, before its own arguments */
    relay?: readonly string[];
  } = {}) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]));
    this.platform = options.platform ?? process.platform;
    this.address = hubAddress(dir, this.platform);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** The permission mode the hook of the agent started in `paneId` last told, and in which of its sessions, or null. */
  toldMode(paneId: string): ToldMode | null {
    return this.modes.get(paneId) ?? null;
  }

  /** Whether an agent of this kind asks its approvals through the hub. */
  handles(kind: string): boolean {
    return this.adapters.has(kind);
  }

  /**
   * The decision a card option is for the request of `paneId` whose id is `id`, by the adapter of the agent that sent it
   * (herdr may name the pane otherwise: an OmO waiting on its user, pi), or null for one that goes as keys.
   */
  decision(paneId: string, id: string, label: string): ApprovalDecision | null {
    return (this.pending.get(paneId) ?? []).find((entry) => idOf(entry) === id)?.adapter.decision(label) ?? null;
  }

  private listen(): void {
    if (this.listener !== null) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // a folder that was there already is narrowed only when it is this account's own, never through a link
    const folder = lstatSync(this.dir);
    const uid = process.getuid?.();
    if (!folder.isDirectory() || (uid !== undefined && folder.uid !== uid)) throw new Error(`${this.dir} is not a folder of this account`);
    chmodSync(this.dir, 0o700);
    // a settings file, extension or key file is of an earlier run of this server, which nothing here answers any more,
    // and the socket of that run is in the way of this one's
    for (const name of readdirSync(this.dir)) if (/\.(?:js|json|key)$/.test(name) || name === SOCKET_NAME) rmSync(join(this.dir, name), { force: true });
    const listener = createServer((socket) => this.receive(socket));
    // a bind that fails comes as an event on the next tick (a pipe's name taken, a folder it may not bind in): no
    // hook works then, as its relay finds no answer, and the server goes on
    listener.on("error", (error) => console.error(`approval hub: ${error.message}`));
    // the socket gets the umask's mode, and node:net binds it before listen returns
    const umask = this.platform === "win32" ? null : process.umask(0o077);
    try {
      listener.listen(this.address);
      if (umask !== null) chmodSync(this.address, 0o600);
    } catch (error) {
      listener.close();
      throw error;
    } finally {
      if (umask !== null) process.umask(umask);
    }
    this.listener = listener;
  }

  /**
   * `args` for an agent of `kind`, at `version`, started in `paneId`, with its hook. Whatever ran in the pane before is
   * forgotten. An agent with no adapter, a version it does not support or none, a hub that cannot listen, and an
   * adapter that cannot add the hook leave `args` as they are.
   */
  launchArgs(kind: string, paneId: string, args: readonly string[] | undefined, version: string | null): string[] | undefined {
    this.forget(paneId);
    const unchanged = args === undefined ? undefined : [...args];
    const adapter = this.adapters.get(kind);
    if (this.stopped || adapter === undefined || version === null || !adapter.supports(version)) return unchanged;
    if (this.platform !== "win32" && Buffer.byteLength(this.address) > SOCKET_PATH_MAX) return unchanged;
    try {
      this.listen();
    } catch (error) {
      console.error(`approval hub: ${error instanceof Error ? error.message : String(error)}`);
      return unchanged;
    }
    const key = randomBytes(32).toString("base64url");
    const [command, ...relay] = this.options.relay ?? relayCommand();
    let hooked: string[] | null;
    try {
      // the key goes in a file of its own (named by its digest), never on the agent's command line, which Claude Code
      // writes into its transcript (relay.ts)
      const keyFile = settingsFile(key, this.dir, KEY_SUFFIX);
      hooked = adapter.launchArgs(args, { command: command!, args: [...relay, "--socket", this.address, "--launch-file", keyFile] }, this.dir);
    } catch (error) {
      console.error(`approval hub (${kind}): ${error instanceof Error ? error.message : String(error)}`);
      this.dropKey(keyDigest(key));
      return unchanged;
    }
    if (hooked === null) {
      this.dropKey(keyDigest(key));
      return unchanged;
    }
    this.launches.set(keyDigest(key), { key, paneId, adapter });
    if (this.launches.size > LAUNCHES_MAX) this.dropLaunch(this.launches.keys().next().value!);
    return hooked;
  }

  private receive(socket: Socket): void {
    let received = "";
    let read = false;
    socket.setEncoding("utf8");
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: string) => {
      if (read) return;
      received += chunk;
      if (received.length > LINE_MAX) return void socket.destroy();
      const end = received.indexOf("\n");
      if (end < 0) return;
      read = true;
      this.request(socket, received.slice(0, end));
    });
  }

  /** One request: refused (the connection closed, no answer) unless sealed with a known launch's key. */
  private request(socket: Socket, line: string): void {
    const envelope = lineObject(line);
    const nonce = envelope?.["nonce"];
    const launch = typeof envelope?.["launch"] === "string" ? this.launches.get(envelope["launch"]) : undefined;
    if (launch === undefined || !isNonce(nonce)) return void socket.destroy();
    const event = unseal(launch.key, "request", nonce, envelope!["sealed"]);
    if (event === null || Buffer.byteLength(event) > EVENT_MAX) return void socket.destroy();
    const reply = (decision: ApprovalDecision | null) => {
      if (socket.destroyed) return;
      socket.end(`${JSON.stringify({ sealed: seal(launch.key, "answer", nonce, launch.adapter.toAnswer(decision)) })}\n`);
    };
    let parsed: unknown;
    try { parsed = JSON.parse(event); } catch { return void socket.destroy(); }
    const mode = launch.adapter.mode?.(parsed) ?? null;
    if (mode !== null) this.modes.set(launch.paneId, mode);
    // told, not asked: the hook prints nothing, so the agent goes on as it would without it
    const turn = launch.adapter.turn?.(parsed) ?? null;
    const command = turn === null ? launch.adapter.command?.(parsed) ?? null : null;
    if (turn !== null || command !== null) {
      socket.end(`${JSON.stringify({ sealed: seal(launch.key, "answer", nonce, "") })}\n`);
      if (turn !== null) this.options.onTurn?.(launch.paneId, launch.adapter.kind, turn);
      else this.options.onCommand?.(launch.paneId, launch.adapter.kind, command!);
      return;
    }
    const card = launch.adapter.toCard(parsed);
    // an event the adapter does not take, or a command the card could not show whole or as it is, is the terminal's: a
    // Yes allows only what the card showed
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = card === null ? null : this.add(launch.paneId, card, launch.adapter, false, (decision) => { clearTimeout(timer); reply(decision); });
    if (entry === null) return reply(null);
    timer = setTimeout(() => entry.settle(null), this.options.heldMs ?? HELD_MS);
    // the agent ended its hook (answered in the terminal, or timed out)
    socket.on("close", () => entry.settle(null));
  }

  /** A held request of `paneId`, or null for a card that could not show it whole or as it is. */
  private add(paneId: string, card: ApprovalRequest, adapter: ApprovalSource, pinned: boolean, reply: (decision: ApprovalDecision | null) => void): Pending | null {
    const body = heldBody(card);
    if (body.length > CARD_BODY_MAX || !showable(body)) return null;
    let done = false;
    const entry: Pending = {
      ...card, adapter, pinned, nonce: randomBytes(16).toString("hex"), at: this.now(),
      settle: (decision) => {
        if (done) return;
        done = true;
        const left = (this.pending.get(paneId) ?? []).filter((other) => other !== entry);
        if (left.length) this.pending.set(paneId, left);
        else this.pending.delete(paneId);
        reply(decision);
        this.options.onSettled?.(paneId);
      },
    };
    this.pending.set(paneId, [...this.pending.get(paneId) ?? [], entry]);
    this.options.onHeld?.(paneId);
    return entry;
  }

  /**
   * Holds a request an agent asks Ovis directly, rather than through a hook (server/approvals/codex.ts): its card's
   * Yes or No goes to `answer`, and so does no decision (null) when the pane is forgotten or the hub stops. The screen
   * does not release it: the returned function does, once the agent says the request was answered elsewhere. Null when
   * the card could not show it whole or as it is: the agent's own dialog is then the only way to answer it.
   */
  hold(paneId: string, source: ApprovalSource, card: ApprovalRequest, answer: (decision: ApprovalDecision | null) => void): (() => void) | null {
    if (this.stopped) return null;
    let released = false;
    const entry = this.add(paneId, card, source, true, (decision) => { if (!released) answer(decision); });
    return entry === null ? null : () => { released = true; entry.settle(null); };
  }

  /** The requests `paneId` holds, oldest first. */
  held(paneId: string): HeldApproval[] {
    return (this.pending.get(paneId) ?? []).map(publicOf);
  }

  /** Settles the request of `paneId` whose id is `id` (null: no decision). False when no such request is held. */
  settle(paneId: string, id: string, decision: ApprovalDecision | null): boolean {
    const entry = (this.pending.get(paneId) ?? []).find((candidate) => idOf(candidate) === id);
    entry?.settle(decision);
    return entry !== undefined;
  }

  /**
   * The held requests a dialog on the screen leaves open, oldest first: those of its kind, but those showing another
   * command whole. A dialog that does not show its command whole leaves a request an agent asked directly (hold) open
   * only when it is the one of its kind held: of two, the screen cannot tell which it shows.
   */
  private open(paneId: string, dialog: ApprovalDialog | null): Pending[] {
    if (dialog === null) return [];
    const { command, kind } = dialog;
    const open = (this.pending.get(paneId) ?? []).filter((entry) => entry.dialog === kind && (command === null || shows(command, subjectOf(entry))));
    return command === null && open.length > 1 && open.some((entry) => entry.pinned) ? [] : open;
  }

  /**
   * What a read of `paneId` found: the approval dialog on its screen, or null for none. A held request it leaves no
   * longer open (answered in the terminal) is released. The latest open request is returned, for its card to show
   * whole, and an earlier one is the next card's: the latest is the one the agent asks now, as a request answered in
   * the terminal stays held while a dialog of the same command is on the screen.
   */
  shown(paneId: string, dialog: ApprovalDialog | null): HeldApproval | null {
    const open = this.open(paneId, dialog);
    for (const entry of this.pending.get(paneId) ?? []) {
      if (!entry.pinned && !open.includes(entry) && this.now() - entry.at >= GRACE_MS) entry.settle(null);
    }
    return open.length ? publicOf(open.at(-1)!) : null;
  }

  /** The request a card built on `id` showed, while it is still held and still the one `shown` gives that dialog's card. */
  private bound(paneId: string, dialog: ApprovalDialog, id: string): Pending | null {
    const latest = this.open(paneId, dialog).at(-1);
    return latest !== undefined && idOf(latest) === id ? latest : null;
  }

  holds(paneId: string, dialog: ApprovalDialog, id: string): boolean {
    return this.bound(paneId, dialog, id) !== null;
  }

  /**
   * Whether the dialog shows the subject of the request a card built on `id` showed, whole, and of no other held
   * request: only then is that dialog this request's, and the card's options other than a decision go to it as keys.
   * Runs of white space count as one in `shows`, so two requests that differ only in them are both shown. Nor may another
   * held request the dialog shows name another tool or file in its words (two MCP tools called with the same arguments
   * show the same subject).
   */
  showsOnly(paneId: string, dialog: ApprovalDialog, id: string): boolean {
    const open = this.open(paneId, dialog);
    const latest = open.at(-1);
    return dialog.command !== null && latest !== undefined && idOf(latest) === id
      && open.every((entry) => entry.command === latest.command && subjectOf(entry) === subjectOf(latest) && entry.description === latest.description);
  }

  /** Answers the request a card built on `id` showed. False when that request is no longer bound to the card. */
  answer(paneId: string, dialog: ApprovalDialog, id: string, decision: ApprovalDecision): boolean {
    const held = this.bound(paneId, dialog, id);
    if (held === null) return false;
    held.settle(decision);
    return true;
  }

  /**
   * Forgets `paneId`: what an agent started there asks is no longer this pane's (the pane moved to another ID, ended or
   * closed, and herdr reuses IDs; or another agent starts in it). Its held requests are released with no decision,
   * and its launches' requests get none.
   */
  forget(paneId: string): void {
    this.modes.delete(paneId);
    for (const entry of [...(this.pending.get(paneId) ?? [])]) entry.settle(null);
    for (const [digest, launch] of this.launches) if (launch.paneId === paneId) this.dropLaunch(digest);
  }

  /** A launch no request is taken for any more, and its key file, so its hook finds no key and gives no decision. */
  private dropLaunch(digest: string): void {
    this.launches.delete(digest);
    this.dropKey(digest);
  }

  private dropKey(digest: string): void {
    rmSync(join(this.dir, `${digest}${KEY_SUFFIX}`), { force: true });
  }

  stop(): void {
    this.stopped = true;
    // each held request gets its answer (no decision, so the terminal's dialog stands) before the listener closes
    for (const list of [...this.pending.values()]) for (const entry of [...list]) entry.settle(null);
    if (this.listener === null) return;
    this.listener.close();
    this.listener = null;
    // a relay that finds no socket gives no decision at once, rather than waiting on one nothing answers
    if (this.platform !== "win32") rmSync(this.address, { force: true });
  }
}
