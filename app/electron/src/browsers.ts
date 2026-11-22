/**
 * The browsers this computer has, for Settings → Browser for links: a web link the server's page
 * opens (`kind` link, src/lib/externalLink.ts) goes to the one chosen, every other address to the
 * system default (openOutside.ts). A page names a browser by its id alone; what runs is only what
 * this file found, started without a shell with the address as one argument.
 *
 * Linux: the .desktop files that take https (XDG data dirs). Windows: StartMenuInternet in the
 * registry. macOS: the apps LaunchServices opens https with. agent-browser, when its program is on
 * this computer, in a session of its own so an agent's tab is never taken.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";

export interface LinkBrowser {
  id: string;
  name: string;
  command(url: string): string[];
}

export interface FoundBrowsers {
  browsers: LinkBrowser[];
  systemDefault: string | null;
}

/** an http(s) address, as the URL parser writes it (a quote or a space in it is percent-encoded), or null */
export function webAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}


export interface DesktopEntry {
  name: string;
  exec: string;
  icon: string | null;
  /** the .desktop file's path, for %k */
  location: string | null;
  web: boolean;
  shown: boolean;
}

/** a value of a .desktop file, its escapes undone (Desktop Entry Specification, "Possible value types") */
function unescapeValue(value: string): string {
  return value.replace(/\\([sntr\\])/g, (_match, code: string) => ({ s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" })[code]!);
}

/** the [Desktop Entry] group of a .desktop file, or null when it is no application */
export function parseDesktopEntry(text: string): DesktopEntry | null {
  const values = new Map<string, string>();
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntry || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at > 0) {
      const key = line.slice(0, at).trim();
      if (!values.has(key)) values.set(key, line.slice(at + 1).trim());
    }
  }
  const name = values.get("Name");
  const exec = values.get("Exec");
  if (values.get("Type") !== "Application" || !name || !exec) return null;
  const types = (values.get("MimeType") ?? "").split(";");
  return {
    name: unescapeValue(name),
    exec: unescapeValue(exec),
    icon: values.has("Icon") ? unescapeValue(values.get("Icon")!) : null,
    location: null,
    web: types.includes("x-scheme-handler/https") || types.includes("x-scheme-handler/http"),
    shown: values.get("NoDisplay") !== "true" && values.get("Hidden") !== "true",
  };
}

/** an Exec line in arguments, each with whether it was quoted: double quotes group, and inside them a backslash keeps the next character */
function execWords(exec: string): { text: string; quoted: boolean }[] | null {
  const words: { text: string; quoted: boolean }[] = [];
  let word = "";
  let quoted = false;
  let wasQuoted = false;
  let started = false;
  for (let i = 0; i < exec.length; i++) {
    const char = exec[i]!;
    if (quoted) {
      if (char === "\\" && i + 1 < exec.length) word += exec[++i];
      else if (char === "\"") quoted = false;
      else word += char;
    } else if (char === "\"") {
      quoted = true;
      wasQuoted = true;
      started = true;
    } else if (char === " " || char === "\t") {
      if (started) words.push({ text: word, quoted: wasQuoted });
      word = "";
      wasQuoted = false;
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quoted) return null;
  if (started) words.push({ text: word, quoted: wasQuoted });
  return words;
}

/**
 * A program that would read the address as code, not as a page to open: a shell or another
 * interpreter, or a script Windows hands to one. A registration that names one is not offered.
 */
export function runsInterpreter(program: string): boolean {
  const name = program.split(/[\\/]/).pop()!.toLowerCase();
  return /^(?:[a-z]*sh|env|python[\d.]*|perl|ruby|node|bun|deno|php|lua|osascript|pwsh|powershell|cmd|wscript|cscript|mshta|rundll32)(?:\.exe)?$/.test(name)
    || /\.(?:bat|cmd|vbs|vbe|js|jse|wsf|wsh|ps1|hta)$/.test(name);
}

/**
 * The arguments an Exec line runs for `url`, its field codes filled in here and never by a shell:
 * %u %U %f %F, a word of their own, become the address (one argument), %c the name, %k the file's
 * path, %i the icon, %% a percent sign; the deprecated ones are dropped. An Exec line with no field
 * for the address gets it at the end. Refused (null): the address inside a larger or quoted word
 * (`sh -c "browser %u"`, `--url=%u`), which the program would read as part of something else;
 * two address fields; %k with no file; and a program that is an interpreter.
 */
export function desktopCommand(entry: Pick<DesktopEntry, "exec" | "name" | "icon"> & { location?: string | null }, url: string): string[] | null {
  const words = execWords(entry.exec);
  // the program is a fixed path: no field code fills it in
  if (words === null || words.length === 0 || words[0]!.text.includes("%") || runsInterpreter(words[0]!.text)) return null;
  const command: string[] = [];
  let given = false;
  for (const { text, quoted } of words) {
    if (!quoted && /^%[uUfF]$/.test(text)) {
      if (given) return null;
      command.push(url);
      given = true;
      continue;
    }
    if (!quoted && text === "%i") {
      if (entry.icon !== null) command.push("--icon", entry.icon);
      continue;
    }
    let refused = false;
    let dropped = false;
    const filled = text.replace(/%(.)/g, (_match, code: string) => {
      if (code === "%") return "%";
      if (code === "c") return entry.name;
      if (code === "k" && entry.location) return entry.location;
      if ("uUfFk".includes(code)) refused = true;
      dropped = true;
      return "";
    });
    if (refused) return null;
    if (!(dropped && filled === "")) command.push(filled);
  }
  if (!given) command.push(url);
  return command;
}

function applicationDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const dataHome = env["XDG_DATA_HOME"] || join(home, ".local", "share");
  const dataDirs = (env["XDG_DATA_DIRS"] || "/usr/local/share:/usr/share").split(":").filter(Boolean);
  return [dataHome, ...dataDirs].map((dir) => join(dir, "applications"));
}

function desktopFiles(dir: string): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return desktopFiles(path);
    return entry.name.endsWith(".desktop") ? [path] : [];
  });
}

/** the http(s) handlers of the XDG data dirs by desktop file id, the first dir's file winning as the spec says */
export function linuxEntries(dirs: string[], read: (path: string) => string = (path) => readFileSync(path, "utf8"), list: (dir: string) => string[] = desktopFiles): Map<string, DesktopEntry> {
  const seen = new Set<string>();
  const entries = new Map<string, DesktopEntry>();
  for (const dir of dirs) {
    for (const path of list(dir)) {
      const id = relative(dir, path).split(sep).join("-");
      if (seen.has(id)) continue;
      seen.add(id);
      let entry: DesktopEntry | null;
      try { entry = parseDesktopEntry(read(path)); } catch { entry = null; }
      if (entry?.web) entries.set(id, { ...entry, location: path });
    }
  }
  return entries;
}

/** the shown entries, one per name (a browser often ships the same entry under two ids, one of them hidden) */
export function linuxBrowsers(entries: Map<string, DesktopEntry>, defaultId: string | null): FoundBrowsers {
  const names = new Set<string>();
  const browsers: LinkBrowser[] = [];
  for (const [id, entry] of entries) {
    if (!entry.shown || names.has(entry.name) || desktopCommand(entry, "https://example.com/") === null) continue;
    names.add(entry.name);
    browsers.push({ id: `desktop:${id}`, name: entry.name, command: (url) => desktopCommand(entry, url)! });
  }
  return { browsers, systemDefault: defaultId === null ? null : entries.get(defaultId)?.name ?? null };
}


/** `reg query <key> /s`, as each key and its values (the default value's name is in the system's language, so it is not read) */
export function parseRegQuery(output: string): Map<string, Map<string, string>> {
  const keys = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      current = new Map();
      keys.set(line.trim(), current);
      continue;
    }
    const value = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (current && value) current.set(value[1]!, value[3] ?? "");
  }
  return keys;
}

/** a command line of the registry in arguments, as Windows splits it (CommandLineToArgvW): a quote may sit inside a word */
export function windowsCommandWords(line: string): string[] {
  // the program comes first and is read as it stands, backslashes and all: to the next quote when it
  // starts with one, else to the first space or tab
  if (line.length === 0) return [];
  const close = line.indexOf("\"", 1);
  const quotedProgram = line.startsWith("\"");
  const program = quotedProgram ? line.slice(1, close === -1 ? line.length : close) : /^[^ \t]*/.exec(line)![0];
  let i = quotedProgram ? (close === -1 ? line.length : close + 1) : program.length;
  const words: string[] = [program];
  while (line[i] === " " || line[i] === "\t") i++;
  let word = "";
  let quoted = false;
  let started = false;
  while (i < line.length) {
    const char = line[i]!;
    if (char === "\\") {
      let count = 0;
      while (line[i + count] === "\\") count++;
      i += count;
      if (line[i] === "\"") {
        word += "\\".repeat(count >> 1);
        if (count % 2 === 1) { word += "\""; i++; }
      } else word += "\\".repeat(count);
      started = true;
    } else if (char === "\"") {
      // inside quotes, "" is a quote of its own and ends the quotes, as shell32 reads it
      if (quoted && line[i + 1] === "\"") {
        word += "\"";
        quoted = false;
        i += 2;
      } else {
        quoted = !quoted;
        i++;
      }
      started = true;
    } else if (!quoted && (char === " " || char === "\t")) {
      if (started) words.push(word);
      word = "";
      started = false;
      i++;
    } else {
      word += char;
      started = true;
      i++;
    }
  }
  if (started) words.push(word);
  return words;
}

/**
 * The arguments a registry command runs for `url`: %1 (or %L), a word of its own, becomes the
 * address in its place, %* is dropped, and a command with no placeholder gets the address at the
 * end. Refused (null): the placeholder inside a larger word, and a program that is an interpreter.
 */
export function windowsCommand(words: string[], url: string): string[] | null {
  if (words.length === 0 || words[0]!.includes("%") || runsInterpreter(words[0]!)) return null;
  const command: string[] = [];
  let given = false;
  for (const word of words) {
    if (/^%[1lL]$/.test(word)) {
      if (given) return null;
      command.push(url);
      given = true;
    } else if (word !== "%*") {
      if (/%[1lL*]/.test(word)) return null;
      command.push(word);
    }
  }
  if (!given) command.push(url);
  return command;
}

/** the registry's StartMenuInternet clients, the current user's before the machine's */
export function windowsBrowsers(trees: Map<string, Map<string, string>>[], userChoice: string | null): FoundBrowsers {
  const browsers = new Map<string, LinkBrowser>();
  let systemDefault: string | null = null;
  for (const tree of trees) {
    for (const [key] of tree) {
      const client = /\\Clients\\StartMenuInternet\\([^\\]+)$/i.exec(key)?.[1];
      if (client === undefined) continue;
      const id = `windows:${client.toLowerCase()}`;
      const values = (path: string) => tree.get(`${key}\\${path}`);
      const open = values("shell\\open\\command");
      const line = open ? [...open.values()][0] : undefined;
      const words = line ? windowsCommandWords(line) : [];
      if (windowsCommand(words, "https://example.com/") === null || browsers.has(id)) continue;
      const appName = values("Capabilities")?.get("ApplicationName");
      const name = appName && !appName.startsWith("@") ? appName : client;
      browsers.set(id, { id, name, command: (url) => windowsCommand(words, url)! });
      const https = values("Capabilities\\URLAssociations")?.get("https");
      if (userChoice !== null && https !== undefined && https.toLowerCase() === userChoice.toLowerCase()) systemDefault ??= name;
    }
  }
  return { browsers: [...browsers.values()], systemDefault };
}


/** asks LaunchServices for the apps that open https (macOS 12 and later) and the one that does by default */
export const MAC_HANDLERS_SCRIPT = `ObjC.import("AppKit");
const workspace = $.NSWorkspace.sharedWorkspace;
const url = $.NSURL.URLWithString("https://example.com/");
const apps = workspace.URLsForApplicationsToOpenURL(url);
const found = [];
for (let i = 0; i < apps.count; i++) {
  const app = apps.objectAtIndex(i);
  const bundle = $.NSBundle.bundleWithURL(app);
  const info = (key) => { const value = bundle.objectForInfoDictionaryKey(key); return value.isNil() ? null : ObjC.unwrap(value); };
  found.push({ path: ObjC.unwrap(app.path), id: ObjC.unwrap(bundle.bundleIdentifier), name: info("CFBundleDisplayName") || info("CFBundleName") });
}
const preferred = workspace.URLForApplicationToOpenURL(url);
JSON.stringify({ apps: found, preferred: preferred.isNil() ? null : ObjC.unwrap(preferred.path) });`;

export function macBrowsers(output: string): FoundBrowsers {
  const answer = JSON.parse(output) as { apps?: { path?: unknown; id?: unknown; name?: unknown }[]; preferred?: unknown };
  const browsers: LinkBrowser[] = [];
  let systemDefault: string | null = null;
  for (const app of answer.apps ?? []) {
    if (typeof app.path !== "string" || typeof app.id !== "string") continue;
    const path = app.path;
    const name = typeof app.name === "string" && app.name !== "" ? app.name : path.split("/").pop()!.replace(/\.app$/, "");
    if (path === answer.preferred) systemDefault = name;
    if (browsers.some((browser) => browser.id === `mac:${app.id}`)) continue;
    browsers.push({ id: `mac:${app.id}`, name, command: (url) => ["/usr/bin/open", "-a", path, url] });
  }
  return { browsers, systemDefault };
}


/** where agent-browser's program is: the PATH, then where npm, Bun and Homebrew put it (an app started from the desktop has a short PATH) */
export function findProgram(name: string, env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform, exists: (path: string) => boolean = existsSync): string | null {
  // on Windows only an .exe: npm's .cmd shim would need a shell
  const file = platform === "win32" ? `${name}.exe` : name;
  const dirs = [...(env["PATH"] ?? "").split(delimiter), join(home, ".bun", "bin"), join(home, ".local", "bin"), join(home, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) {
    if (dir === "") continue;
    const path = join(dir, file);
    if (exists(path)) return path;
  }
  return null;
}

export function agentBrowser(program: string): LinkBrowser {
  return { id: "agent-browser", name: "agent-browser", command: (url) => [program, "--session", "ovis-links", "--headed", "open", url] };
}


function run(program: string, args: string[]): Promise<string | null> {
  return new Promise((answer) => {
    execFile(program, args, { timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => answer(error ? null : stdout));
  });
}

export async function findBrowsers(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = env["HOME"] ?? env["USERPROFILE"] ?? ""): Promise<FoundBrowsers> {
  let found: FoundBrowsers = { browsers: [], systemDefault: null };
  try {
    if (platform === "linux") {
      const preferred = (await run("xdg-settings", ["get", "default-web-browser"]))?.trim() || (await run("xdg-mime", ["query", "default", "x-scheme-handler/https"]))?.trim() || null;
      found = linuxBrowsers(linuxEntries(applicationDirs(env, home)), preferred);
    } else if (platform === "win32") {
      const roots = ["HKCU\\SOFTWARE\\Clients\\StartMenuInternet", "HKLM\\SOFTWARE\\Clients\\StartMenuInternet", "HKLM\\SOFTWARE\\WOW6432Node\\Clients\\StartMenuInternet"];
      const trees = (await Promise.all(roots.map((root) => run("reg", ["query", root, "/s"])))).map((output) => parseRegQuery(output ?? ""));
      const choice = parseRegQuery(await run("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"]) ?? "");
      const progId = [...choice.values()][0]?.get("ProgId") ?? null;
      found = windowsBrowsers(trees, progId);
    } else if (platform === "darwin") {
      const output = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_HANDLERS_SCRIPT]);
      if (output !== null) found = macBrowsers(output);
    }
  } catch (error) {
    console.error(`Finding the browsers failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const program = findProgram("agent-browser", env, home, platform);
  return program === null ? found : { ...found, browsers: [...found.browsers, agentBrowser(program)] };
}


export function readLinkBrowser(path: string): string | null {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as { browser?: unknown } | null;
    return typeof saved?.browser === "string" ? saved.browser : null;
  } catch {
    return null;
  }
}

export function writeLinkBrowser(path: string, browser: string | null): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({ browser }));
  renameSync(temporary, path);
}
