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

/**
 * The environment the core `hc` reaches hands its terminals: that of its current holder, which
 * starts their shells (live-verified, hc 0.1.17: on macOS the core itself is a launchd job with
 * launchd's environment, its holder has the starter's), else of the core on Linux, where it has
 * the starter's too; null where this PC does not tell it (a macOS core with no terminal yet, so no
 * holder: the caller goes by the environment that starts the core).
 */
export async function coreEnvironment(hc: Pick<HcConnection, "call">, read: (pid: number) => Promise<Env | null> = processEnv, platform: NodeJS.Platform = process.platform): Promise<Env | null> {
  try {
    const status = await hc.call("server.status", {});
    // only the current holder: one an update left draining has the old core's starter's environment
    const pid = status.holder?.pid ?? status.holders.find((holder) => holder.current)?.pid ?? (platform === "darwin" ? null : status.pid);
    return pid === null ? null : await read(pid);
  } catch { return null; }
}

/** A process's environment as it was started (this user's processes only): Linux's /proc, macOS's `ps -E`; else null. */
export async function processEnv(pid: number, platform: NodeJS.Platform = process.platform): Promise<Env | null> {
  if (platform === "linux") {
    try {
      return Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter((entry) => entry.includes("=")).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
    } catch { return null; }
  }
  if (platform !== "darwin") return null;
  const ps = async (format: string): Promise<string> => {
    const child = Bun.spawn(["/bin/ps", format, "-o", "command=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore", signal: AbortSignal.timeout(2000) });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`ps exited ${code}`);
    return out;
  };
  try {
    const [command, withEnv] = await Promise.all([ps("-ww"), ps("-wwE")]);
    return envAfterCommand(command, withEnv);
  } catch { return null; }
}

/**
 * The variables `ps -wwE` prints after a process's command line, the same line `ps -ww` prints
 * alone: each begins at a space followed by `NAME=`. A value holding such a space would be cut there:
 * a name read twice says one was, and which is the real one cannot be told, so nothing is read.
 */
export function envAfterCommand(command: string, withEnv: string): Env | null {
  const line = command.replace(/\n+$/, "");
  const all = withEnv.replace(/\n+$/, "");
  if (line === "" || !all.startsWith(line)) return null;
  const rest = all.slice(line.length).replace(/^ /, "");
  if (rest === "") return {};
  const entries = rest.split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/).map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)] as const);
  const env = Object.fromEntries(entries);
  return Object.keys(env).length === entries.length ? env : null;
}

/**
 * What every shell started on the core `hc` reaches gets: the login environment `terminal` fitted
 * to the environment that core hands its terminals, asked afresh each time (a core restarted since
 * may hand another), or, where that cannot be read, to `starter`'s (the environment that starts the core).
 */
export function terminalEnvFor(hc: Pick<HcConnection, "call">, terminal: Env | Promise<Env>, starter: SourceEnv, core: (hc: Pick<HcConnection, "call">) => Promise<Env | null> = coreEnvironment): () => Promise<Env> {
  return async () => forCore(await terminal, await core(hc) ?? starter);
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
