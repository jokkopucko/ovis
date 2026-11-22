/**
 * Claude Code's inline `--settings` JSON on a Windows PC (#2232). herdr starts an agent there
 * through a PowerShell script, and when `claude` is a PowerShell script (the shim an npm global
 * install puts in front of claude.exe) Windows PowerShell 5.1 strips the JSON's double quotes on
 * the way to claude.exe, which then exits with "Invalid JSON provided to --settings". A settings
 * file's path, spaces included, arrives intact through every route herdr takes, and Claude Code
 * reads a `--settings` value that is not `{…}` as one. Linux and macOS quote each word for a POSIX
 * shell and take the JSON as it is.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";

/**
 * Where the files go: `ovis\claude settings` in this Windows user's %LOCALAPPDATA%, the profile's
 * own folder for what stays on this PC, which only this user and the administrators can reach.
 * Not %TEMP%: TEMP can name a folder other accounts write to (C:\Temp, or C:\Windows\Temp for a
 * service), where another account could make this folder first and, a file being named by its
 * text's hash, swap hooks into it between the check below and Claude Code's read. A file holds only
 * the JSON a launch already put on Claude Code's command line (the dialog's is {"ultracode":true}).
 * Claude Code keeps what it read from it at start (2.1.311 pins a settings file's content), so one
 * removed later costs nothing and the next launch writes it again. The space in the folder's name
 * has PowerShell quote the path for a `.cmd` agent it starts, so a profile folder holding `&`
 * (`R&D`) reaches it whole and herdr-core's start takes it (powershellNativeArgs, #3084).
 */
export function claudeSettingsDir(env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(env["LOCALAPPDATA"] || join(home, "AppData", "Local"), "ovis", "claude settings");
}

/** Claude Code's own test for reading a `--settings` value as JSON rather than as a file's path. */
const inlineJson = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
};

/**
 * `args` with each inline JSON `--settings` value, `--settings <json>` or `--settings=<json>`,
 * replaced by the path `write` gives a file holding that text. Every other argument is kept, and
 * nothing after a bare `--` is read as a flag.
 */
export function settingsFileArgs(args: readonly string[], write: (json: string) => string): string[] {
  const rewritten: string[] = [];
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--") {
      rewritten.push(...args.slice(at));
      break;
    }
    if (arg === "--settings" && at + 1 < args.length) {
      const value = args[++at]!;
      rewritten.push(arg, inlineJson(value) ? write(value) : value);
    }
    else if (arg.startsWith("--settings=") && inlineJson(arg.slice("--settings=".length))) {
      rewritten.push(`--settings=${write(arg.slice("--settings=".length))}`);
    }
    else rewritten.push(arg);
  }
  return rewritten;
}

/** Make each component without traversing a link; retain identities to check around file operations. */
const cacheDirectory = (dir: string): (() => void) => {
  const absolute = resolve(dir);
  let folder = parse(absolute).root;
  const folders: { path: string; dev: bigint; ino: bigint }[] = [];
  const check = () => {
    for (const folder of folders) {
      const now = lstatSync(folder.path, { bigint: true });
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== folder.dev || now.ino !== folder.ino) {
        throw new Error("Claude settings cache directory changed");
      }
    }
  };
  for (const component of absolute.slice(folder.length).split(sep).filter(Boolean)) {
    check();
    folder = join(folder, component);
    try { mkdirSync(folder, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(folder, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Redirected Claude settings cache directory");
    folders.push({ path: folder, dev: stat.dev, ino: stat.ino });
  }
  return check;
};

/** Read only a regular, non-linked entry whose opened and named identities still agree. */
const holds = (path: string, text: string, checkDirectory: () => void): boolean => {
  checkDirectory();
  const named = lstatSync(path, { bigint: true });
  if (!named.isFile() || named.isSymbolicLink()) throw new Error("Redirected Claude settings cache entry");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile()) throw new Error("Non-regular Claude settings cache entry");
    const again = lstatSync(path, { bigint: true });
    checkDirectory();
    if (opened.ino === 0n || opened.dev !== named.dev || opened.ino !== named.ino
      || !again.isFile() || again.dev !== opened.dev || again.ino !== opened.ino) {
      throw new Error("Claude settings cache entry changed");
    }
    const content = readFileSync(fd, "utf8");
    const after = lstatSync(path, { bigint: true });
    checkDirectory();
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error("Claude settings cache entry changed");
    }
    return content === text;
  } finally {
    closeSync(fd);
  }
};

/**
 * The path of a file in `dir` holding `json`, named by its sha256: the same text is one file, written
 * once. The first launch makes it new, with no rename that Defender or the indexer could hold up for
 * a moment on Windows, and a later one finds it there. Only a file under its name that holds other
 * text (cut short, or edited) is replaced, written under a temporary name and renamed into place so
 * nothing reads half of it.
 */
export function settingsFile(json: string, dir: string = claudeSettingsDir()): string {
  dir = resolve(dir);
  const path = join(dir, `${createHash("sha256").update(json).digest("hex")}.json`);
  const checkDirectory = cacheDirectory(dir);
  const writeNew = (file: string): void => {
    checkDirectory();
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      checkDirectory();
      const opened = fstatSync(fd, { bigint: true });
      const named = lstatSync(file, { bigint: true });
      if (!opened.isFile() || !named.isFile() || opened.dev !== named.dev || opened.ino !== named.ino) {
        throw new Error("Claude settings cache entry changed");
      }
      writeFileSync(fd, json);
    } finally {
      closeSync(fd);
    }
  };
  try {
    writeNew(path);
    if (!holds(path, json, checkDirectory)) throw new Error("Claude settings cache write changed");
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  if (holds(path, json, checkDirectory)) return path;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeNew(temporary);
    checkDirectory();
    // Refuse an entry changed to a link while its replacement was being written.
    holds(path, json, checkDirectory);
    renameSync(temporary, path);
  } catch (error) {
    // the scanner that refused the rename can refuse the delete too: its error must not stand in
    // for the rename's, or skip the check below
    try { rmSync(temporary, { force: true }); } catch {}
    // another launch put the same text there first: Windows refuses a rename over a file a
    // starting Claude has open
    if (!holds(path, json, checkDirectory)) throw error;
  }
  if (!holds(path, json, checkDirectory)) throw new Error("Claude settings cache write changed");
  return path;
}

/**
 * `args` as herdr's agent.start should get them for a `kind` agent on `platform`: on Windows, a
 * Claude Code's inline JSON `--settings` goes as a file's path (see the top of this file). When the
 * file cannot be written the JSON goes as it is: a claude.exe (the native installer's) or a
 * claude.cmd takes it intact, and only an npm install's PowerShell shim would lose it, so a full
 * disk or a folder that cannot be made must not fail every launch.
 */
export function agentStartArgs(kind: string, args: string[], options: { platform?: string; dir?: string } = {}): string[] {
  if ((options.platform ?? process.platform) !== "win32" || kind !== "claude") return args;
  try {
    return settingsFileArgs(args, (json) => settingsFile(json, options.dir));
  } catch (error) {
    console.error(`claude --settings file: ${error instanceof Error ? error.message : String(error)}`);
    return args;
  }
}
