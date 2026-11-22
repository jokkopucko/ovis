import type { HerdrCoreLayout, HerdrIdentity } from "../../shared/machines.ts";

export interface RuntimeCapabilities {
  /**
   * The runtime's own name. Read only where the question is which program this is (`herdr update`
   * updates herdr; herdr starts two agent kinds without a manifest), never for what it can do.
   */
  readonly runtime: string;
  /**
   * How a live terminal is attached. `pty-cli`: a PTY runs the runtime's own attach command (herdr's
   * `terminal attach`), which scrolls by itself and lets a second viewer watch the one who holds the
   * pane. `hc`: a stream on the server's hc connection, which needs no PTY host; nothing there
   * scrolls, so the browser keeps the history the attach replays, and every viewer shares the stream,
   * so there is no watching.
   */
  readonly attach: "pty-cli" | "hc";
  /**
   * Who works out what runs in a pane. `detected`: the runtime does, from the pane itself: which
   * agent, its status (a guess the server settles) and its session. `reported`: the runtime passes on
   * only what a program reported about itself, so every status is the program's own word, and what an
   * agent does not report (Letta's status, an omp session on macOS) Ovis reads from the agent's own files.
   */
  readonly agents: "detected" | "reported";
  /**
   * Which processes `pane.process_info` names in front: `job`, every process of the foreground job;
   * `leader`, only its first, so an agent below a launcher, or shown by an attach client, is looked for.
   */
  readonly foreground: "job" | "leader";
  /** how a finish read here reaches the runtime's other clients: `label`, a `herdr.seen` label written on its terminal; null, it does not */
  readonly seen: "label" | null;
  readonly pins: boolean;
  readonly machines: boolean;
  /**
   * Which process hands a new terminal its environment: `server`, the one listening on the runtime's
   * socket; `core`, the core hc reports (the socket is this server's own adapter).
   */
  readonly spawner: "server" | "core";
}

export const HERDR: RuntimeCapabilities = {
  runtime: "herdr", attach: "pty-cli", agents: "detected", foreground: "job", seen: null, pins: false, machines: false, spawner: "server",
};

export const HERDR_CORE: RuntimeCapabilities = {
  runtime: "herdr-core", attach: "hc", agents: "reported", foreground: "leader", seen: "label", pins: true, machines: true, spawner: "core",
};

let served: RuntimeCapabilities | null = null;

export function capabilities(): RuntimeCapabilities {
  return served ?? HERDR;
}

export function serveRuntime(runtime: RuntimeCapabilities | null): void {
  served = runtime;
}

/**
 * What a ping's `capabilities` say of the runtime, as a PC's identity tells its viewers
 * (shared/machines.ts HerdrIdentity): herdr-core's name and the layout calls it answers, each one it
 * did not say yes to off. Nothing for herdr's TUI server, which names no runtime and whose
 * workspaces, tabs and splits are its own.
 */
export function runtimeIdentity(said: Record<string, unknown> | undefined): Pick<HerdrIdentity, "runtime" | "layout"> {
  if (said?.["runtime"] !== "herdr-core") return {};
  const offered = said["layout"];
  const yes = (call: keyof HerdrCoreLayout): boolean => typeof offered === "object" && offered !== null && (offered as Record<string, unknown>)[call] === true;
  return { runtime: "herdr-core", layout: { rename: yes("rename"), split: yes("split"), move: yes("move"), arrange: yes("arrange"), worktrees: yes("worktrees") } };
}
