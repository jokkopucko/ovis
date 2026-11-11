import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { loginEnvProbe, loginShell } from "../shell-agent.ts";
import { SERVER_ENV, type HcConnection } from "./connection.ts";

type Env = Record<string, string>;
type SourceEnv = Record<string, string | undefined>;

/**
 * What the login shell is run with: the session's own variables (who, where, locale, the
 * desktop's agents and buses) and where the shell keeps its settings (zsh's ZDOTDIR, fish's
 * XDG_CONFIG_HOME), nothing else of this process's. A server a service or an agent's shell
 * started carries that one's environment (NO_COLOR, TERM=dumb, tokens filtered out), which the
 * login shell would hand back as the user's.
 */
const SESSION_ENV = /^(?:HOME|USER|LOGNAME|SHELL|PATH|LANG|LC_[A-Z_]+|TZ|TMPDIR|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|ZDOTDIR|XDG_CONFIG_HOME)$/;

/** The shell's own bookkeeping, and what places a process in a terminal or core: never the user's setting. */
const NOT_SETTINGS = /^(?:PWD|OLDPWD|SHLVL|_|TERM|COLORTERM|HC_.*|HERDR_.*)$/;

/**
 * What names the probe's own session, process or tty rather than a setting: a profile that runs
 * `eval $(ssh-agent)` names an agent of the probe's (holding no key), `GPG_TTY` reads "not a tty".
 * Each pane keeps the core's own, as before.
 */
const SESSION_BOUND = /^(?:SSH_AUTH_SOCK|SSH_AGENT_PID|SSH_TTY|SSH_CONNECTION|SSH_CLIENT|GPG_TTY|GPG_AGENT_INFO|TTY|DBUS_SESSION_BUS_ADDRESS|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|XDG_SESSION_.*|XDG_VTNR|TMUX|TMUX_PANE|STY|WINDOWID)$/;

/** Where hc finds its core: a connect that starts one keeps this server's, whatever the profile says. */
const CORE_PLACE = /^(?:HOME|HC_.*|XDG_.*)$/;

/** Ovis's terminal view draws 24-bit colour. */
const COLOUR: Env = { TERM: "xterm-256color", COLORTERM: "truecolor" };

/**
 * The user's login environment for the terminals Ovis starts on herdr-core, given over whatever
 * the core's own is (hc hands every terminal the environment of the process that started the
 * core, herdr-core#86): what the login shell set, without this server's own variables, in colour.
 * A value the login shell left as it was given is left out: a pane keeps the core's own there.
 * With no login environment, only the colour; on Windows nothing (no login shell, and a console
 * takes no TERM). `forCore` then fits it to the core the terminals run on.
 */
export async function loginTerminalEnv(options: TerminalEnvOptions = {}): Promise<Env> {
  return (await readTerminalEnv(options)).env;
}

type TerminalEnvOptions = { env?: SourceEnv; shell?: string | null; timeoutMs?: number };

/** loginTerminalEnv, and whether the login shell answered (a miss is worth asking again) */
async function readTerminalEnv(options: TerminalEnvOptions): Promise<{ env: Env; answered: boolean }> {
  const source = options.env ?? process.env;
  const shell = options.shell === undefined ? loginShell(source) : options.shell;
  if (process.platform === "win32") return { env: {}, answered: true };
  if (shell === null) return { env: { ...COLOUR }, answered: true };
  const base = Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined && SESSION_ENV.test(entry[0])));
  // in the home folder, never this server's: a folder's .env or bunfig.toml is not the user's login
  const login = await loginEnvProbe({ shell, env: { ...base, ...COLOUR }, cwd: homeFolder(base["HOME"]), timeoutMs: options.timeoutMs ?? 3000 })(new AbortController().signal);
  if (login.value === null) {
    console.warn(`[herdr-core] terminals start without the login shell's environment: ${login.reason}`);
    return { env: { ...COLOUR }, answered: false };
  }
  // a value the login shell gave back as it was given (a service's bare PATH, say) is this server's, not the
  // user's: a pane keeps the core's own there, as before
  const kept = Object.entries(login.value).filter(([name, value]) => base[name] !== value && !NOT_SETTINGS.test(name) && !SESSION_BOUND.test(name) && !SERVER_ENV.test(name));
  return { env: { ...Object.fromEntries(kept), ...COLOUR }, answered: true };
}

function homeFolder(home: string | undefined): string {
  try { if (home && statSync(home).isDirectory()) return home; } catch { /* gone */ }
  return homedir();
}

/**
 * The login environment fitted to a core whose own environment is `core`:
 * - NO_COLOR set empty, which turns colour back on, only where the core has a NO_COLOR the login
 *   does not set (hc cannot drop one). An empty one where there is none would turn colour off in
 *   libraries that only ask whether the name is there (consola, colorette, kleur).
 * - PATH: the login's first, then the core's folders it does not name, so a folder only the core
 *   has (an installer's, a running core's tools) stays.
 */
export function forCore(terminal: Env, core: SourceEnv): Env {
  const env = { ...terminal };
  if (!("NO_COLOR" in terminal) && core["NO_COLOR"] !== undefined) env["NO_COLOR"] = "";
  const corePath = core["PATH"];
  if (terminal["PATH"] !== undefined && corePath) {
    const named = new Set(terminal["PATH"].split(":"));
    env["PATH"] = [terminal["PATH"], ...corePath.split(":").filter((dir) => dir !== "" && !named.has(dir) && named.add(dir))].join(":");
  }
  return env;
}

/** The environment of the core `hc` reaches, where this PC tells it (Linux /proc, the core runs as this user), else null. */
export async function coreEnvironment(hc: Pick<HcConnection, "call">): Promise<Env | null> {
  if (process.platform !== "linux") return null;
  try {
    const { pid } = await hc.call("server.status", {});
    return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => entry.includes("=")).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  } catch { return null; }
}

/**
 * What every shell started on the core `hc` reaches gets: `terminal` fitted to that core's own
 * environment, or, where it cannot be read, to `starter`'s (the environment that starts the core).
 * Read once the core first answers, then kept.
 */
export function terminalEnvFor(hc: Pick<HcConnection, "call">, terminal: Env, starter: SourceEnv): () => Promise<Env> {
  let fitted: Promise<Env> | null = null;
  return () => fitted ??= coreEnvironment(hc).then((core) => forCore(terminal, core ?? starter));
}

const read = new Map<string, Env>();

/**
 * loginTerminalEnv for `env` (this process's), kept per user and shell once it was read, for the
 * server's life, as a core keeps its own: a token the profile changes reaches new panes after a
 * restart. One that failed is asked again next time.
 */
export async function userTerminalEnv(env: SourceEnv = process.env): Promise<Env> {
  const key = `${env["HOME"] ?? ""}\0${env["SHELL"] ?? ""}`;
  const kept = read.get(key);
  if (kept) return kept;
  const found = await readTerminalEnv({ env });
  if (found.answered) read.set(key, found.env);
  return found.env;
}

/**
 * What `hc connect` runs in: `base` with the terminal environment, fitted to `base` (a core it
 * starts has that environment), over it; a core it starts is found where `base` says: HOME, HC_*
 * and XDG_* are base's alone, also where base has none.
 */
export function coreStartEnv(base: SourceEnv, terminal: Env): SourceEnv {
  return { ...base, ...Object.fromEntries(Object.entries(forCore(terminal, base)).filter(([name]) => !CORE_PLACE.test(name))) };
}
