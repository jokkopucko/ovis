import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, posix, win32 } from "node:path";

/**
 * The `ovis` command of the desktop app: the app's own command line (scripts/plugin.ts, compiled into its server as
 * `ovis-server plugin`) aimed at the server this app runs, as install.sh's launcher aims it at a plugin install's. The
 * app writes the launcher on each start, since an AppImage's folder and an update can move the server; Settings links
 * it onto the PATH (Settings → About → Terminal command) and never over an `ovis` it did not put there.
 */

export interface LauncherPlaces {
  /** the server's binary inside the app (children.ts layout) */
  serverBinary: string;
  /** desktop.json, where the app keeps the port its server runs on */
  desktopJson: string;
  /** the server's state dir (OVIS_STATE_DIR) */
  stateDir: string;
  /** the command line's own settings dir, so a plugin install's ~/.config/ovis never names the port or the token */
  configDir: string;
  /** the core session the desktop app started; the terminal screen runs on macOS and Linux */
  coreSession: string;
  /** OVIS_ACCOUNT_SERVICE_URL the app was started with (a staging app), which `ovis login` and `ovis logout` read themselves */
  accountService: string | null;
}

export const launcherName = (platform: NodeJS.Platform): string => platform === "win32" ? "ovis.cmd" : "ovis";

/** what a shell is told before the app's server ran: the launcher says it, not the command line, which would try port 7317 */
const NOT_RUNNING = "ovis: open the Ovis app first, then run this again";

const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
/** inside a .cmd file's `set "NAME=value"` and quoted paths: only % is read there */
const cmdQuote = (value: string): string => value.replaceAll("%", "%%");

export function launcherText(platform: NodeJS.Platform, places: LauncherPlaces): string {
  if (platform === "win32") {
    const lines = [
      "@echo off",
      "rem The Ovis desktop app's command line (ovis login, ovis status, ovis approve). The app writes this file each time it starts.",
      "setlocal",
      'set "PORT="',
      // desktop.json is one line, {"port":<port>,"server":...}; the plugin checks the server record before using the port
      `if exist "${cmdQuote(places.desktopJson)}" for /f "usebackq tokens=2 delims=:,}" %%p in ("${cmdQuote(places.desktopJson)}") do if not defined PORT set "PORT=%%p"`,
      "if not defined PORT goto closed",
      'if "%PORT%"=="null" goto closed',
      `if not exist "${cmdQuote(places.serverBinary)}" goto closed`,
      `set "OVIS_STATE_DIR=${cmdQuote(places.stateDir)}"`,
      'set "HC_SESSION=ovis"',
      'set "OVIS_DESKTOP_COMMAND=1"',
      `set "OVIS_DESKTOP_COMMAND_RECORD=${cmdQuote(places.desktopJson)}"`,
      `set "HERDR_PLUGIN_CONFIG_DIR=${cmdQuote(places.configDir)}"`,
      'set "HOST=127.0.0.1"',
      'set "HC_SOCKET="',
      'set "HERDR_PLUGIN_ROOT="',
      'set "HERDR_PLUGIN_STATE_DIR="',
      ...(places.accountService === null ? [] : [`set "OVIS_ACCOUNT_SERVICE_URL=${cmdQuote(places.accountService)}"`]),
      `"${cmdQuote(places.serverBinary)}" plugin %*`,
      "exit /b %ERRORLEVEL%",
      ":closed",
      `echo ${NOT_RUNNING} 1>&2`,
      "exit /b 1",
    ];
    return `${lines.join("\r\n")}\r\n`;
  }
  const lines = [
    "#!/bin/sh",
    "# The Ovis desktop app's command line (ovis login, ovis status, ovis approve). The app writes this file each time it starts.",
    `port=$(sed -n 's/.*"port":\\([0-9][0-9]*\\).*/\\1/p' ${shQuote(places.desktopJson)} 2>/dev/null)`,
    // an AppImage's server is in its mount, which is there only while the app runs
    `if [ ! -x ${shQuote(places.serverBinary)} ]; then echo ${shQuote(NOT_RUNNING)} >&2; exit 1; fi`,
    // a herdr pane's or another core's settings must not turn the command to them
    "unset HC_SOCKET HERDR_PLUGIN_ROOT HERDR_PLUGIN_STATE_DIR",
    `OVIS_STATE_DIR=${shQuote(places.stateDir)}`,
    `HC_SESSION=${shQuote(places.coreSession)}`,
    // `ovis start` and `ovis stop` say the app runs its server (scripts/plugin.ts)
    "OVIS_DESKTOP_COMMAND=1",
    `OVIS_DESKTOP_COMMAND_RECORD=${shQuote(places.desktopJson)}`,
    `HERDR_PLUGIN_CONFIG_DIR=${shQuote(places.configDir)}`,
    "HOST=127.0.0.1",
    'PORT="$port"',
    "export OVIS_STATE_DIR HC_SESSION OVIS_DESKTOP_COMMAND OVIS_DESKTOP_COMMAND_RECORD HERDR_PLUGIN_CONFIG_DIR HOST PORT",
    ...(places.accountService === null ? [] : [`OVIS_ACCOUNT_SERVICE_URL=${shQuote(places.accountService)}`, "export OVIS_ACCOUNT_SERVICE_URL"]),
    `exec ${shQuote(places.serverBinary)} plugin "$@"`,
  ];
  return `${lines.join("\n")}\n`;
}

/** Writes the launcher into `dir` whole (a terminal running it meanwhile reads the old one or the new one) and gives its path. */
export function writeLauncher(dir: string, platform: NodeJS.Platform, places: LauncherPlaces): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, launcherName(platform));
  writeFileSync(`${file}.tmp`, launcherText(platform, places), { mode: 0o755 });
  chmodSync(`${file}.tmp`, 0o755);
  renameSync(`${file}.tmp`, file);
  return file;
}

/**
 * Where the command is, for Settings. `taken`: an `ovis` the app did not put there (install.sh's or install.ps1's, of
 * another Ovis) is in the way and stays. `off-path`: the command is in a folder the terminal's PATH lacks. `shadowed`:
 * another `ovis` comes first on that PATH. `profile`: adding it put ~/.local/bin on the PATH in that shell profile, which a
 * new terminal reads.
 */
export interface CommandState {
  installed: boolean;
  at: string | null;
  note: { kind: "taken" | "shadowed" | "profile"; path: string } | { kind: "off-path"; dir: string } | null;
}

export interface CommandHost {
  platform: NodeJS.Platform;
  home: string;
  /** the user's login shell ($SHELL), whose profile a Mac's PATH line goes in */
  shell: string;
  /** the launcher writeLauncher wrote */
  launcher: string;
  /** the PATH a new terminal gets: the login shell's on a Mac or Linux (an app opened from the Dock has launchd's), the user's on Windows */
  terminalPath(): Promise<string>;
  /** a file there (children.ts isFile in the app) */
  isFile(path: string): boolean;
  /** runs a program to its end: its exit code, null when it could not run */
  run(program: string, args: readonly string[], env?: Record<string, string>): Promise<number | null>;
}

/**
 * Where a Mac or Linux links the command: the user's own ~/.local/bin, never a folder every account and root run from
 * (a link there would run a file this user can rewrite, as anyone who types ovis, sudo too).
 */
export const linkPath = (home: string): string => posix.join(home, ".local", "bin", "ovis");

/** the line a Mac's shell profile gets when ~/.local/bin is not on its PATH; its mark keeps it from being added twice */
export const PROFILE_LINE = 'export PATH="$HOME/.local/bin:$PATH" # added by Ovis';

/**
 * the profile a login shell reads: zsh's ~/.zprofile (a Mac's default), else ~/.profile; bash reads the first of
 * ~/.bash_profile, ~/.bash_login and ~/.profile that exists, and creating an earlier one would make it skip that file
 */
export function profileOf(home: string, shell: string): string {
  const name = posix.basename(shell);
  if (name === "bash") return [".bash_profile", ".bash_login", ".profile"].map((file) => posix.join(home, file)).find((file) => existsSync(file)) ?? posix.join(home, ".bash_profile");
  return posix.join(home, name === "zsh" ? ".zprofile" : ".profile");
}

function addToProfile(file: string): void {
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (text.split("\n").some((line) => line.trim() === PROFILE_LINE)) return;
  appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${PROFILE_LINE}\n`);
}

type Place = "ours" | "free" | "taken";

function placeOf(path: string, launcher: string): Place {
  try {
    const entry = lstatSync(path);
    return entry.isSymbolicLink() && readlinkSync(path) === launcher ? "ours" : "taken";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "taken";
  }
}

const samePath = (a: string, b: string): boolean => {
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
};

/** the first `ovis` on `path` that runs: a file a terminal would find before any other */
function firstOnPath(path: string, host: Pick<CommandHost, "platform" | "isFile">): string | null {
  const names = host.platform === "win32" ? ["ovis.exe", "ovis.cmd", "ovis.bat", "ovis.ps1"] : ["ovis"];
  const join_ = host.platform === "win32" ? win32.join : posix.join;
  for (const dir of path.split(host.platform === "win32" ? ";" : delimiter)) {
    if (dir === "") continue;
    for (const name of names) {
      const file = join_(dir, name);
      if (host.isFile(file)) return file;
    }
  }
  return null;
}

const dirKey = (dir: string): string => win32.normalize(dir).replace(/\\+$/, "").toLowerCase();

/** prints the Path a new terminal gets on Windows: the system's, then the user's */
export const READ_TERMINAL_PATH = "[Console]::Out.Write([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))";

/** what a login shell prints for its PATH, after anything its profile prints: `-ilc` reads .zshrc too, where a PATH is often set */
export const SHELL_PATH_SCRIPT = 'printf "\\n__OVIS_PATH__=%s\\n" "$PATH"';

export function shellPath(output: string): string | null {
  const line = output.split("\n").reverse().find((entry) => entry.startsWith("__OVIS_PATH__="));
  return line === undefined ? null : line.slice("__OVIS_PATH__=".length).trim();
}

// as install.ps1 adds its cmd\ folder: appended to the user's Path as stored, once, keeping its %VAR% entries and its
// registry kind (GetEnvironmentVariable expands them, and writing that back flattens them); setting and removing a
// variable through .NET then announces the changed environment to new terminals
const ADD_USER_PATH = "$d=$env:OVIS_COMMAND_DIR; $k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); try { $p=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if (-not (@($p -split ';') -contains $d)) { $t=if ($k.GetValueNames() -contains 'Path') { $k.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }; $k.SetValue('Path', ((@($p -split ';' | Where-Object { $_ }) + $d) -join ';'), $t); [Environment]::SetEnvironmentVariable('OVIS_PATH_CHANGED','1','User'); [Environment]::SetEnvironmentVariable('OVIS_PATH_CHANGED',$null,'User') } } finally { $k.Dispose() }";

export async function commandState(host: CommandHost): Promise<CommandState> {
  const path = await host.terminalPath();
  if (host.platform === "win32") {
    const dir = win32.dirname(host.launcher);
    const installed = path.split(";").some((entry) => entry !== "" && dirKey(entry) === dirKey(dir));
    const first = firstOnPath(path, host);
    const other = first !== null && dirKey(win32.dirname(first)) !== dirKey(dir) ? first : null;
    if (other !== null) return { installed, at: installed ? host.launcher : null, note: { kind: installed ? "shadowed" : "taken", path: other } };
    return { installed, at: installed ? host.launcher : null, note: null };
  }
  const at = linkPath(host.home);
  const place = placeOf(at, host.launcher);
  if (place !== "ours") return { installed: false, at: null, note: place === "free" ? null : { kind: "taken", path: at } };
  const first = firstOnPath(path, host);
  if (first === null) return { installed: true, at, note: { kind: "off-path", dir: posix.dirname(at) } };
  return { installed: true, at, note: samePath(first, host.launcher) ? null : { kind: "shadowed", path: first } };
}

/**
 * Puts the command on the terminal's PATH as this user alone, never over an `ovis` already there and with no
 * administrator step: on a Mac and Linux a link in ~/.local/bin (a .deb's /usr/bin/ovis stays the app), and on a Mac
 * one marked PATH line in the login shell's profile when that PATH lacks ~/.local/bin; on Windows the launcher's folder
 * on the user's Path, unless another Ovis's `ovis` (install.ps1's) is on it.
 */
export async function installCommand(host: CommandHost): Promise<CommandState> {
  const before = await commandState(host);
  if (before.installed || before.note?.kind === "taken") return before;
  if (host.platform === "win32") {
    await host.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ADD_USER_PATH], { OVIS_COMMAND_DIR: win32.dirname(host.launcher) });
    return commandState(host);
  }
  const at = linkPath(host.home);
  mkdirSync(posix.dirname(at), { recursive: true });
  // fails where a file has come since: nothing is replaced
  symlinkSync(host.launcher, at);
  const after = await commandState(host);
  if (host.platform !== "darwin" || after.note?.kind !== "off-path") return after;
  const profile = profileOf(host.home, host.shell);
  addToProfile(profile);
  return { ...after, note: { kind: "profile", path: profile } };
}
