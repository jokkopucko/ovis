import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activePluginScript } from "./plugin-runtime.ts";
/**
 * install.sh's `ovis` command and its `--add` step. The launcher's functions are cut out of install.sh
 * itself and run under /bin/sh with a HOME of their own; the whole script is run as `curl … | sh` runs
 * it, on a PATH that holds only what it needs. herdr, node, curl and the plugin's script are stand-ins,
 * so nothing is installed, no herdr is touched, nothing is fetched and no account is asked.
 */

const ROOT = join(import.meta.dir, "..");
const INSTALLER = readFileSync(join(ROOT, "install.sh"), "utf8");
const MARK = "# ovis launcher, written by install.sh";
const ADD_LINE = "to add this PC to your Ovis account: ";
const HINT_LINE = "to add this PC to your Ovis account, run in a terminal on this PC: ";
const WAITS_LINE = "the app is not running yet, so this PC was not added to your Ovis account. Once it runs, run in a terminal on this PC: ";
const OLD_READER_LINE = "this Ovis release would take a line typed ahead as its answer about the device that adds this PC, so the installer does not start that step for it. Update Ovis in Settings → Updates, then run in a terminal on this PC: ";
const UPDATE_LINE = "this Ovis is from before it could add a PC to an account from its terminal: update it in Settings → Updates, then run this installer again";
const TOKEN_LINE = "on a PC other people log in to, set OVIS_TOKEN first: without it any local user counts as this PC";
const USAGE = "usage: curl -fsSL https://ovis.sh/install.sh | sh -s -- [--add | --join-file <path>] [--account <id>] [--no-service] [--help]";
const ACCOUNT = "acct_1a2b3c4d5e6f";
const NOT_ADDED_LINE = "this PC was not added to your Ovis account; what the add said is above. To try again: ";
const NO_ACCOUNT_CHECK_LINE = "this Ovis release does not check the account --account names, so the installer does not add this PC with it. Update Ovis in Settings → Updates, then run on this PC: ";
/** after the app's address, which a terminal shows as a link */
const STARTED_LINE = ", in herdr, which was started in the background: this PC has no user service manager, so after a restart run this installer again";
const CTRL_C = "\x03";
/** a run of install.sh ends in about a second alone, in many on a PC busy with other checks */
const RUN_ENDS_WITHIN_MS = 45_000;
setDefaultTimeout(RUN_ENDS_WITHIN_MS + 15_000);

function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(INSTALLER) ?? new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const CONSTANTS = ["REPO", "BIN_DIR", "LAUNCHER_MARK", "OVIS_HOME", "HERDR_SERVICE", "HERDR_AGENT_LABEL", "ACCOUNT_SINCE", "JOIN_SINCE", "JOIN_PREFIX", "JOIN_MAX"].map((name) => {
  const line = new RegExp(`^${name}=.*$`, "m").exec(INSTALLER)?.[0];
  if (!line) throw new Error(`install.sh sets no ${name}`);
  return line;
}).join("\n");
const FUNCTIONS = ["say", "link", "launcher_text", "find_other_ovis", "write_launcher", "ovis_command", "find_add_name", "add_reads_answers", "add_command", "in_foreground", "discard_typed", "add_pc", "token_line", "closing_lines", "release_js", "running_code", "quoted", "add_takes_account", "running_lines", "unit_gone_line", "mac_agent_line", "herdr_command", "ovis_cli", "at_least", "join_takes", "join_answerable", "join_command", "join_pc", "join_lines"].map(fn).join("\n");

const dir = mkdtempSync(join(tmpdir(), "ovis-install-command-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function pluginScript(knows: "add" | "link" | "neither" = "add", tui = false): string {
  const record = `{
  const { appendFileSync, existsSync } = await import("node:fs");
  if (!existsSync(process.env.SCRATCH + "/running")) { console.error("Ovis is not running at http://127.0.0.1:7317; start it first"); process.exit(1); }
  console.log("the add step");
  // what is already typed at its terminal when it starts: the line a question it asks later would take for its answer
  const typed = existsSync(process.env.SCRATCH + "/add-reads") ? { typed: await Promise.race([new Promise((resolve) => process.stdin.once("data", (line) => resolve(String(line)))), Bun.sleep(1500).then(() => null)]) } : {};
  appendFileSync(process.env.SCRATCH + "/add.calls", JSON.stringify({ command, rest, terminal: process.stdin.isTTY === true, ...typed, ...(process.env.RELEASE ? { release: process.env.RELEASE } : {}) }) + "\\n");
  if (existsSync(process.env.SCRATCH + "/add-waits")) { console.log("waiting for an approval"); await Bun.sleep(60_000); }
  process.exit(existsSync(process.env.SCRATCH + "/add-fails") ? 1 : 0);
}`;
  return `${tui ? '// "tui": this release knows ovis tui\n' : ""}${knows === "add" ? "// COMMAND_ALIASES: this release knows add and login\n" : ""}const [command = "status", ...rest] = process.argv.slice(2);
// an invite's line reaches ovis join alone, in its environment: any other run that is given it says so
if (process.env.OVIS_JOIN || (command !== "join" && process.env.OVIS_INVITE)) (await import("node:fs")).appendFileSync(process.env.SCRATCH + "/leaked", command + "\\n");
if (command === "phone") console.log("the phone step");
else if (command === "status" && (await import("node:fs")).existsSync(process.env.SCRATCH + "/running")) console.log("running http://127.0.0.1:7317 (pid 1234)");
else if (['add', 'login', 'link'].includes(command) && ${knows === "neither" ? "true" : knows === "link" ? `command !== "link"` : "false"}) { console.error("usage: bun scripts/plugin.ts <start|stop|status|pair|phone|phone-setup>"); process.exit(2); }
else if (${knows === "neither" ? "false" : knows === "add" ? `["add", "login", "link"].includes(command)` : `command === "link"`}) ${record}
else if (command === "join") {
  const { appendFileSync, existsSync, readFileSync } = await import("node:fs");
  if (!existsSync(process.env.SCRATCH + "/running")) { console.error("Ovis is not running on this PC."); process.exit(13); }
  console.log("the join step");
  // what is already typed at its terminal when it starts: the line its question (type yes) would take for an answer
  const typed = existsSync(process.env.SCRATCH + "/add-reads") ? { typed: await Promise.race([new Promise((resolve) => process.stdin.once("data", (line) => resolve(String(line)))), Bun.sleep(1500).then(() => null)]) } : {};
  appendFileSync(process.env.SCRATCH + "/join.calls", JSON.stringify({ rest, terminal: process.stdin.isTTY === true, invite: process.env.OVIS_INVITE ?? null, ...typed, ...(process.env.RELEASE ? { release: process.env.RELEASE } : {}) }) + "\\n");
  process.exit(existsSync(process.env.SCRATCH + "/join-exit") ? Number(readFileSync(process.env.SCRATCH + "/join-exit", "utf8")) : 0);
}
else console.log(JSON.stringify({ root: import.meta.dir, command, rest, config: process.env.HERDR_PLUGIN_CONFIG_DIR ?? null, state: process.env.HERDR_PLUGIN_STATE_DIR ?? null }));
`;
}

/**
 * scripts/plugin-link.ts, as a stand-in: the code that asks about the device that adds the PC. `new` tells a line
 * typed ahead from an answer, by the function install.sh knows such a release by; `old` is v0.5.2's, which asks
 * [y/N] and takes the next line the terminal hands it (the words are its own).
 */
function readerScript(reader: "new" | "old" | "before-account"): string {
  const answerOf = `export function answerOf(line: string, digits: string, whole = false): "approve" | "decline" | null { return null; }\n`;
  return reader === "new"
    ? `${answerOf}export const flags = ["--account"];\n`
    : reader === "before-account"
    ? answerOf
    : `export function approves(answer: string, digits: string): boolean { return false; }\n// Type the last three digits to approve [y/N]; nothing here is called answerOf (the word alone, in a comment, is not the function)\n`;
}

const STAND_INS: Record<string, string> = {
  herdr: `case "$*" in
  --version) echo "herdr 0.9.3" ;;
  "plugin list") echo "$(cat "$SCRATCH/plugin-id") 0.0.0" ;;
  "plugin list --json") printf '{"result":{"plugins":[{"plugin_id":"someone.else","plugin_root":"/nowhere"},{"plugin_id":"%s","plugin_root":"%s"}]}}\\n' "$(cat "$SCRATCH/plugin-id")" "$(cat "$SCRATCH/plugin-root")" ;;
  "plugin config-dir "*) echo "$SCRATCH/herdr-config/$3" ;;
  "status server --json") if [ -e "$SCRATCH/running" ]; then echo '{"running":true}'; else echo '{"running":false}'; fi ;;
  "plugin action invoke "*) ;;
  # a headless server that comes up only on a PC whose herdr can start, and starts the app with it (its startup hook)
  server) [ -e "$SCRATCH/herdr-starts" ] || { echo "herdr: cannot start here" >&2; exit 1; }; [ -z "\${OVIS_JOIN:-}\${OVIS_INVITE:-}" ] || : >"$SCRATCH/herdr-has-invite"; : >"$SCRATCH/running" ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`,
  node: `case "$1" in -p) case "$(uname -m)" in aarch64 | arm64) echo "22 arm64" ;; *) echo "22 x64" ;; esac ;; *) echo v22.0.0 ;; esac`,
  curl: `echo "unexpected curl $*" >&2; exit 1`,
};

class Pc {
  readonly scratch: string;
  readonly bin: string;
  readonly launcher: string;
  readonly app: string;

  constructor(options: { herdr?: boolean; home?: string } = {}) {
    this.scratch = mkdtempSync(join(dir, options.home ?? "pc-"));
    this.bin = join(this.scratch, "bin");
    this.launcher = join(this.scratch, ".local", "bin", "ovis");
    this.app = join(this.scratch, ".local", "share", "ovis", "app");
    mkdirSync(this.bin);
    for (const tool of ["sh", "cat", "uname", "ldd", "grep", "git", "tar", "awk", "sed", "mktemp", "rm", "sleep", "mv", "mkdir", "cp", "chmod", "ps", "tail", "readlink", "stty", "dd"]) {
      const real = Bun.which(tool);
      if (real) symlinkSync(real, join(this.bin, tool));
    }
    symlinkSync(process.execPath, join(this.bin, "bun"));
    for (const name of options.herdr === false ? ["node", "curl"] : ["herdr", "node", "curl"]) {
      writeFileSync(join(this.bin, name), `#!/bin/sh\n${STAND_INS[name]!}\n`, { mode: 0o755 });
    }
    this.plugin("plugin");
  }

  /** `joins`: the release has `ovis join` (scripts/plugin-join.ts, the file install.sh knows it by) */
  plugin(name: string, knows: "add" | "link" | "neither" = "add", id = "devswha.ovis", reader: "new" | "old" | "before-account" = "new", joins = knows !== "neither"): string {
    const root = join(this.scratch, name);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "plugin.ts"), pluginScript(knows));
    if (knows !== "neither") writeFileSync(join(root, "scripts", "plugin-link.ts"), readerScript(reader));
    rmSync(join(root, "scripts", "plugin-join.ts"), { force: true });
    if (joins) writeFileSync(join(root, "scripts", "plugin-join.ts"), "export async function join() {}\n");
    writeFileSync(join(this.scratch, "plugin-id"), id);
    writeFileSync(join(this.scratch, "plugin-root"), root);
    return root;
  }
  noPlugin(): this { writeFileSync(join(this.scratch, "plugin-id"), "someone.other"); return this; }
  core(): string {
    mkdirSync(join(this.app, "scripts"), { recursive: true });
    writeFileSync(join(this.app, "scripts", "plugin.ts"), pluginScript());
    writeFileSync(join(this.app, "scripts", "plugin-link.ts"), readerScript("new"));
    return this.app;
  }
  checkout(name: string, knows: "add" | "link" | "neither" = "neither"): string {
    const root = this.plugin(name, knows);
    this.git(root, "init", "--quiet");
    this.git(root, "add", "-A");
    this.git(root, "commit", "--quiet", "-m", "the version first installed");
    return root;
  }
  private git(root: string, ...args: string[]): string {
    const run = Bun.spawnSync(["git", "-C", root, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { env: { ...this.environment(), GIT_CONFIG_NOSYSTEM: "1" }, stdout: "pipe", stderr: "pipe" });
    if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
    return run.stdout.toString().trim();
  }
  release(root: string, knows: "add" | "link" | "neither", options: { port?: number | string; state?: string; label?: string; checkout?: string; reader?: "new" | "old" | "before-account"; tui?: boolean; joins?: boolean } = {}): string {
    const state = options.state ?? join(this.scratch, ".config", "ovis");
    const updates = join(state, "updates", createHash("sha256").update(`${options.checkout ?? root}:${options.port ?? 7317}`).digest("hex").slice(0, 16));
    const release = join(updates, "release-1");
    mkdirSync(join(release, "scripts"), { recursive: true });
    writeFileSync(join(release, "scripts", "plugin.ts"), `process.env.RELEASE = ${JSON.stringify(options.label ?? "updated")};\n${pluginScript(knows, options.tui)}`);
    if (knows !== "neither") writeFileSync(join(release, "scripts", "plugin-link.ts"), readerScript(options.reader ?? "new"));
    if (options.joins ?? knows !== "neither") writeFileSync(join(release, "scripts", "plugin-join.ts"), "export async function join() {}\n");
    writeFileSync(join(updates, "current.json"), JSON.stringify({ source_revision: this.git(root, "rev-parse", "HEAD"), directory: release }));
    return release;
  }
  updated(name: string, knows: "add" | "link" | "neither"): string {
    return this.release(this.checkout(name), knows);
  }
  settings(name: "env" | ".env", text: string, id = "devswha.ovis"): this {
    mkdirSync(join(this.scratch, "herdr-config", id), { recursive: true });
    writeFileSync(join(this.scratch, "herdr-config", id, name), text);
    return this;
  }
  flag(name: "add-fails" | "add-waits" | "add-reads" | "running" | "herdr-starts"): this { writeFileSync(join(this.scratch, name), ""); return this; }
  /** what `ovis join` exits with (scripts/plugin-join.ts, JOIN_EXIT) */
  joinExits(code: number): this { writeFileSync(join(this.scratch, "join-exit"), String(code)); return this; }
  joinCalls(): { rest: string[]; terminal: boolean; invite: string | null; typed?: string | null; release?: string }[] {
    const log = join(this.scratch, "join.calls");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  }
  /** the runs of Ovis's command line, and herdr's server, that were given an invite's line they must not have */
  leaked(): string[] {
    const log = join(this.scratch, "leaked");
    return [...existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [], ...existsSync(join(this.scratch, "herdr-has-invite")) ? ["herdr server"] : []];
  }
  addCalls(): { command: string; rest: string[]; terminal: boolean; typed?: string | null; release?: string }[] {
    const log = join(this.scratch, "add.calls");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  }
  environment(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: this.bin, HOME: this.scratch, SCRATCH: this.scratch, SHELL: "/bin/sh", TERM: "xterm", OVIS_FROM_SOURCE: "1", ...extra };
  }

  sh(call: string, extra?: Record<string, string>): { code: number; out: string } {
    const run = Bun.spawnSync(["/bin/sh", "-c", `set -eu\n${CONSTANTS}\n${FUNCTIONS}\n${call}`], { cwd: this.scratch, env: this.environment(extra), stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString() };
  }
  written(): this {
    const { code, out } = this.sh("write_launcher");
    if (code !== 0 || !existsSync(this.launcher)) throw new Error(`write_launcher wrote no launcher: ${out}`);
    return this;
  }
  ovis(args: string[], extra?: Record<string, string>): { code: number; out: string } {
    const run = Bun.spawnSync([this.launcher, ...args], { cwd: this.scratch, env: this.environment(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString() };
  }

  async unattended(args: string[] = [], extra?: Record<string, string>): Promise<{ out: string; exitCode: number }> {
    const child = Bun.spawn(["sh", "-s", "--", ...args], { cwd: this.scratch, env: this.environment(extra), stdin: Bun.file(join(ROOT, "install.sh")), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_ENDS_WITHIN_MS);
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    clearTimeout(timer);
    return { out: out + err, exitCode };
  }

  /**
   * The whole installer at a terminal (script(1) gives one), the script on stdin as under `curl … | sh`.
   * `typed` goes to the terminal once `after` is on it, again and again until the run ends, or `once`.
   * The wrapping shell survives Ctrl-C as the user's own shell does, and reports the installer's exit code.
   */
  async atTerminal(args: string, extra?: Record<string, string>, typed?: { after: string; text: string; once?: boolean }, background = false): Promise<{ out: string; exitCode: number }> {
    const install = `cat "${join(ROOT, "install.sh")}" | sh -s -- ${args}`;
    // in the background as an interactive shell runs `… &`: with job control, so in a process group that is not the terminal's
    const command = background ? `"${Bun.which("bash")}" -c 'set -m; ${install} & wait $!; echo "exit=$?"'` : `trap : INT; ${install}; echo "exit=$?"`;
    const child = Bun.spawn([Bun.which("script")!, "-qec", command, "/dev/null"], { cwd: this.scratch, env: this.environment(extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), RUN_ENDS_WITHIN_MS);
    let out = "";
    let again: ReturnType<typeof setInterval> | undefined;
    // as script(1) exits, a write to its pipe throws EPIPE: nobody is left to read the keys
    const type = (text: string) => {
      try { child.stdin.write(text); child.stdin.flush(); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
      }
    };
    const decoder = new TextDecoder();
    try {
      for await (const chunk of child.stdout) {
        out += decoder.decode(chunk, { stream: true });
        if (again !== undefined || typed === undefined || !out.includes(typed.after)) continue;
        // Ctrl-C is a signal, and the add step's own handlers come a moment after its first words: pressed until it lands
        type(typed.text);
        again = setInterval(() => { if (!typed.once) type(typed.text); }, 100);
      }
      await child.exited;
    } finally {
      clearInterval(again);
      clearTimeout(timer);
    }
    child.stdin.end();
    return { out, exitCode: Number(/exit=(\d+)/.exec(out)?.[1] ?? -1) };
  }
}

// install.sh is the Linux and macOS installer: Windows has install.ps1, and no launcher yet
describe.skipIf(platform() === "win32")("the ovis launcher install.sh writes", () => {
  it("is an executable sh script with the installer's mark on its second line", () => {
    const pc = new Pc().written();
    const text = readFileSync(pc.launcher, "utf8");
    expect(text.split("\n").slice(0, 2)).toEqual(["#!/bin/sh", MARK]);
    expect(statSync(pc.launcher).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(pc.scratch, ".local", "bin"))).toEqual(["ovis"]);
    expect(Bun.spawnSync(["/bin/sh", "-n", pc.launcher]).exitCode).toBe(0);
  });

  it("holds no path of the install that wrote it", () => {
    const pc = new Pc().written();
    const text = readFileSync(pc.launcher, "utf8");
    expect(text).not.toContain(pc.scratch);
    expect(readFileSync(new Pc().written().launcher, "utf8")).toBe(text);
  });

  it("finds the herdr plugin each time it runs, and hands on the command and its flags", () => {
    const pc = new Pc().written();
    const first = pc.ovis(["pair", "--approve"]);
    expect(first.code, first.out).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), command: "pair", rest: ["--approve"] });
    const moved = pc.plugin("plugin-moved");
    expect(JSON.parse(pc.ovis([]).out)).toMatchObject({ root: join(moved, "scripts"), command: "status", rest: [] });
  });

  it("finds a plugin still installed under the id before the rename", () => {
    const pc = new Pc().written();
    const root = pc.plugin("legacy-plugin", "add", "devswha.herdr-web-ui");
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ root: join(root, "scripts") });
  });

  it("runs Ovis on herdr-core from its checkout, with the dirs its service gives it", () => {
    const without = new Pc({ herdr: false }).written();
    const alone = without.core();
    expect(JSON.parse(without.ovis(["status"]).out)).toMatchObject({ root: join(alone, "scripts") });
    const pc = new Pc().noPlugin().written();
    const app = pc.core();
    const ran = JSON.parse(pc.ovis(["status"]).out);
    expect(ran).toMatchObject({ root: join(app, "scripts"), config: join(pc.scratch, ".config", "ovis"), state: join(pc.scratch, ".local", "state", "ovis") });
    mkdirSync(join(pc.scratch, ".config", "herdr-web-ui"), { recursive: true });
    mkdirSync(join(pc.scratch, ".local", "state", "herdr-web-ui"), { recursive: true });
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ config: join(pc.scratch, ".config", "herdr-web-ui"), state: join(pc.scratch, ".local", "state", "herdr-web-ui") });
    expect(JSON.parse(pc.ovis(["status"], { HERDR_PLUGIN_CONFIG_DIR: "/given/config", HERDR_PLUGIN_STATE_DIR: "/given/state" }).out)).toMatchObject({ config: "/given/config", state: "/given/state" });
  });

  it("runs the herdr plugin where an earlier herdr-core checkout is still there beside it", () => {
    const pc = new Pc().written();
    pc.core();
    const ran = JSON.parse(pc.ovis(["status"]).out);
    expect(ran).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), config: null, state: null });
    pc.flag("running");
    expect(pc.ovis(["add"]).code).toBe(0);
    expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: false }]);
    pc.noPlugin();
    expect(JSON.parse(pc.ovis(["pair"]).out)).toMatchObject({ root: join(pc.app, "scripts") });
  });

  it("tells a release by words the real scripts/plugin.ts has", () => {
    // install.sh and the launcher grep the installed script for these: a refactor that drops them would
    // make --add print its hint, and the launcher say link, with every stand-in here still passing
    const real = readFileSync(join(ROOT, "scripts", "plugin.ts"), "utf8");
    expect(real).toContain("COMMAND_ALIASES");
    expect(real).toContain('"link"');
    expect(real).toContain('"phone"');
    expect(real).toContain('"tui"');
    for (const [name, pattern] of [["find_add_name", "grep -qs 'COMMAND_ALIASES' "], ["find_add_name", `grep -qs '"link"' `], ["launcher_text", "grep -qs COMMAND_ALIASES "], ["launcher_text", `grep -qs '"link"' `], ["launcher_text", `grep -qs '"tui"' `]] as const) {
      expect(fn(name)).toContain(pattern);
    }
  });

  it("a launcher that cannot be written does not end the install", () => {
    const readOnly = new Pc();
    mkdirSync(join(readOnly.scratch, ".local", "bin"), { recursive: true });
    chmodSync(join(readOnly.scratch, ".local", "bin"), 0o555);
    const noFolder = new Pc();
    writeFileSync(join(noFolder.scratch, ".local"), "");
    for (const pc of [readOnly, noFolder]) {
      const { code, out } = pc.sh(`root=/plugin/root; original_path=$PATH; write_launcher; echo "ours=$launcher_ours"; echo "command=$(ovis_command)"`);
      expect(code, out).toBe(0);
      expect(out).toContain(`Ovis: could not write ${pc.launcher}, so no ovis command was installed`);
      expect(out).toContain("ours=0");
      expect(out).toContain("command=bun /plugin/root/scripts/plugin.ts");
      expect(existsSync(pc.launcher)).toBe(false);
    }
    chmodSync(join(readOnly.scratch, ".local", "bin"), 0o755);
  });

  it("runs add on a release that knows it, and as link on a checkout from before add", () => {
    const pc = new Pc().written().flag("running");
    expect(pc.ovis(["add", "--google"]).code).toBe(0);
    expect(pc.ovis(["login"]).code).toBe(0);
    pc.plugin("old-plugin", "link");
    expect(pc.ovis(["add", "--google"]).code).toBe(0);
    expect(pc.ovis(["login"]).code).toBe(0);
    expect(pc.addCalls().map((call) => [call.command, ...call.rest])).toEqual([["add", "--google"], ["login"], ["link", "--google"], ["link"]]);
  });

  it("finds herdr and Bun where the installer puts them, on a PATH without either", () => {
    const pc = new Pc().written();
    const tools = join(pc.scratch, "tools");
    mkdirSync(tools);
    for (const tool of ["sh", "cat", "grep"]) symlinkSync(Bun.which(tool)!, join(tools, tool));
    symlinkSync(join(pc.bin, "herdr"), join(pc.scratch, ".local", "bin", "herdr"));
    mkdirSync(join(pc.scratch, ".bun", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(pc.scratch, ".bun", "bin", "bun"));
    const ran = pc.ovis(["status"], { PATH: tools });
    expect(ran.code, ran.out).toBe(0);
    expect(JSON.parse(ran.out)).toMatchObject({ command: "status" });
  });

  it("says so in one line when Ovis is not installed", () => {
    for (const pc of [new Pc({ herdr: false }).written(), new Pc().written()]) {
      pc.noPlugin();
      const ran = pc.ovis(["add"]);
      expect(ran.code).toBe(1);
      expect(ran.out.trim().split("\n")).toEqual(["ovis: Ovis is not installed on this PC. Install it with: curl -fsSL https://ovis.sh/install.sh | sh"]);
      expect(pc.addCalls()).toEqual([]);
    }
  });

  it("is written again over a launcher of the installer's own", () => {
    const pc = new Pc().written();
    writeFileSync(pc.launcher, `#!/bin/sh\n${MARK}\necho "an older launcher"\n`, { mode: 0o700 });
    const { out } = pc.sh(`write_launcher; echo "ours=$launcher_ours"`);
    expect(out).toContain("ours=1");
    expect(readFileSync(pc.launcher, "utf8")).not.toContain("an older launcher");
    expect(statSync(pc.launcher).mode & 0o777).toBe(0o755);
  });

  it("leaves an ovis the installer did not write as it is, and says so", () => {
    const own = "#!/bin/sh\necho \"someone's own ovis\"\n";
    const file = new Pc();
    mkdirSync(join(file.scratch, ".local", "bin"), { recursive: true });
    writeFileSync(file.launcher, own, { mode: 0o755 });
    // a link is never followed: what it points at is not the installer's to replace, mark or not
    const linked = new Pc();
    mkdirSync(join(linked.scratch, ".local", "bin"), { recursive: true });
    writeFileSync(join(linked.scratch, "elsewhere"), `#!/bin/sh\n${MARK}\n`, { mode: 0o755 });
    symlinkSync(join(linked.scratch, "elsewhere"), linked.launcher);
    const folder = new Pc();
    mkdirSync(folder.launcher, { recursive: true });
    for (const pc of [file, linked, folder]) {
      const { code, out } = pc.sh(`root=/plugin/root; original_path=$PATH; write_launcher; echo "ours=$launcher_ours"; echo "command=$(ovis_command)"`);
      expect(code, out).toBe(0);
      expect(out).toContain(`Ovis: ${pc.launcher} is there already and is not this installer's, so it is left as it is and no ovis command was installed`);
      expect(out).toContain("ours=0");
      expect(out).toContain("command=bun /plugin/root/scripts/plugin.ts");
    }
    expect(readFileSync(file.launcher, "utf8")).toBe(own);
    expect(lstatSync(linked.launcher).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(linked.scratch, "elsewhere"), "utf8")).toBe(`#!/bin/sh\n${MARK}\n`);
    expect(lstatSync(folder.launcher).isDirectory()).toBe(true);
  });

  it("is named ovis where the user's PATH finds it, and by its path where it does not", () => {
    const pc = new Pc().written();
    const named = (path: string) => pc.sh(`launcher_ours=1; root=/plugin/root; original_path='${path}'; ovis_command`).out;
    expect(named(`${pc.bin}:${join(pc.scratch, ".local", "bin")}`)).toBe("ovis");
    expect(named(pc.bin)).toBe(pc.launcher);
    writeFileSync(join(pc.bin, "ovis"), "#!/bin/sh\n", { mode: 0o755 });
    expect(named(`${pc.bin}:${join(pc.scratch, ".local", "bin")}`)).toBe(pc.launcher);
  });

  it("on a checkout from before link, runs the release Settings → Updates installed", () => {
    const pc = new Pc().written().flag("running");
    pc.updated("first-install", "add");
    for (const name of ["add", "login", "link"]) {
      const ran = pc.ovis([name, "--google"]);
      expect(ran.code, ran.out).toBe(0);
    }
    expect(pc.addCalls().map((call) => [call.release, call.command, ...call.rest])).toEqual([["updated", "add", "--google"], ["updated", "login", "--google"], ["updated", "link", "--google"]]);
    expect(JSON.parse(pc.ovis(["pair"]).out)).toMatchObject({ root: join(pc.scratch, "first-install", "scripts"), command: "pair" });
    pc.updated("first-install-2", "link");
    expect(pc.ovis(["add"]).code).toBe(0);
    expect(pc.addCalls().at(-1)).toMatchObject({ release: "updated", command: "link" });
  });

  it("hands tui on from a checkout from before it to the release that knows it, and says to update where none does", () => {
    const pc = new Pc().written();
    const release = pc.release(pc.checkout("first-install"), "add", { tui: true });
    expect(JSON.parse(pc.ovis(["tui", "--session", "s"]).out)).toMatchObject({ root: join(release, "scripts"), command: "tui", rest: ["--session", "s"] });
    const stale = new Pc().written();
    stale.updated("first-install", "add");
    const ran = stale.ovis(["tui"]);
    expect(ran.code).toBe(1);
    expect(ran.out.trim().split("\n")).toEqual(["ovis: this Ovis is from before ovis tui. Update it in Settings → Updates, then run this again"]);
  });

  it("runs tui on a checkout that knows it, from that checkout", () => {
    const pc = new Pc().written();
    const root = pc.checkout("current");
    writeFileSync(join(root, "scripts", "plugin.ts"), pluginScript("add", true));
    expect(JSON.parse(pc.ovis(["tui"]).out)).toMatchObject({ root: join(root, "scripts"), command: "tui" });
  });

  it("says to update, in one line, where no installed release can add a PC", () => {
    const never = new Pc().written().flag("running");
    never.plugin("plugin", "neither");
    const stale = new Pc().written().flag("running");
    stale.updated("first-install", "neither");
    for (const pc of [never, stale]) {
      for (const name of ["add", "login", "link"]) {
        const ran = pc.ovis([name]);
        expect(ran.code).toBe(1);
        expect(ran.out.trim().split("\n")).toEqual(["ovis: this Ovis is from before it could add a PC to an account. Update it in Settings → Updates, then run this again"]);
      }
      expect(pc.addCalls()).toEqual([]);
    }
  });

  it("the installer names a command that adds the PC, whichever release runs and whoever owns ovis", () => {
    const lines = (pc: Pc, ours: 0 | 1, root: string, code: string) =>
      pc.sh(`add=0; terminal=0; launcher_ours=${ours}; original_path=$PATH; root='${root}'; code='${code}'; add_pc; closing_lines`).out;
    const printed = (out: string) => new RegExp(`${ADD_LINE}(.*)$`, "m").exec(out)?.[1] ?? "";
    const runs = (pc: Pc, command: string) => Bun.spawnSync(["/bin/sh", "-c", command], { cwd: pc.scratch, env: pc.environment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 }).exitCode;

    const updated = new Pc().written().flag("running");
    const release = updated.updated("first-install", "link");
    const first = join(updated.scratch, "first-install");
    expect(printed(lines(updated, 1, first, release))).toBe(`${updated.launcher} add`);
    expect(runs(updated, printed(lines(updated, 1, first, release)))).toBe(0);
    expect(printed(lines(updated, 0, first, release))).toBe(`bun ${release}/scripts/plugin.ts link`);
    expect(runs(updated, printed(lines(updated, 0, first, release)))).toBe(0);
    expect(updated.addCalls().map((call) => call.command)).toEqual(["link", "link"]);

    const stale = new Pc().written().flag("running");
    const old = stale.plugin("plugin", "neither");
    for (const ours of [0, 1] as const) {
      const out = lines(stale, ours, old, old);
      expect(out).toContain(`Ovis: ${UPDATE_LINE}\n`);
      expect(out).not.toContain(ADD_LINE);
    }
  });

  it("is written beside the launcher under a name of its own, so a file called ovis.new is not touched", () => {
    const linked = new Pc();
    const bin = join(linked.scratch, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(linked.scratch, "notes.txt"), "the user's notes\n", { mode: 0o600 });
    symlinkSync(join(linked.scratch, "notes.txt"), `${linked.launcher}.new`);
    const plain = new Pc();
    mkdirSync(join(plain.scratch, ".local", "bin"), { recursive: true });
    writeFileSync(`${plain.launcher}.new`, "the user's own file\n", { mode: 0o400 });
    for (const pc of [linked, plain]) {
      const { code, out } = pc.sh(`write_launcher; echo "ours=$launcher_ours"`);
      expect(code, out).toBe(0);
      expect(out).toContain("ours=1");
      expect(readdirSync(join(pc.scratch, ".local", "bin")).sort()).toEqual(["ovis", "ovis.new"]);
    }
    expect(readFileSync(join(linked.scratch, "notes.txt"), "utf8")).toBe("the user's notes\n");
    expect(statSync(join(linked.scratch, "notes.txt")).mode & 0o777).toBe(0o600);
    expect(lstatSync(`${linked.launcher}.new`).isSymbolicLink()).toBe(true);
    expect(readFileSync(`${plain.launcher}.new`, "utf8")).toBe("the user's own file\n");
    const failing = new Pc();
    mkdirSync(failing.launcher.replace(/ovis$/, ""), { recursive: true });
    const { out } = failing.sh(`launcher_text() { return 1; }; write_launcher; echo "ours=$launcher_ours"`);
    expect(out).toContain("ours=0");
    expect(readdirSync(join(failing.scratch, ".local", "bin"))).toEqual([]);
  });

  it("never takes the name of another ovis on the PATH, and says which one the name runs", () => {
    const other = (pc: Pc) => {
      const elsewhere = join(pc.scratch, "elsewhere");
      mkdirSync(elsewhere, { recursive: true });
      writeFileSync(join(elsewhere, "ovis"), "#!/bin/sh\necho \"another program\"\n", { mode: 0o755 });
      return join(elsewhere, "ovis");
    };
    const write = (pc: Pc, path: string) => pc.sh(`root=/plugin/root; original_path='${path}'; write_launcher; echo "ours=$launcher_ours"; echo "command=$(ovis_command)"`).out;
    const local = (pc: Pc) => join(pc.scratch, ".local", "bin");

    // ~/.local/bin first: a launcher there would hide the other program, so none is written
    const hidden = new Pc();
    const theirs = other(hidden);
    const refused = write(hidden, `${hidden.bin}:${local(hidden)}:${join(hidden.scratch, "elsewhere")}`);
    expect(refused).toContain(`Ovis: ${theirs} is another ovis on your PATH, and ${local(hidden)} comes before it there: an ovis command of this installer's would take its name, so none was installed`);
    expect(refused).toContain("ours=0");
    expect(refused).toContain("command=bun /plugin/root/scripts/plugin.ts");
    expect(existsSync(hidden.launcher)).toBe(false);

    // the other one first, or ~/.local/bin not on the PATH: the launcher is written, and named by its path
    for (const path of [(pc: Pc) => `${pc.bin}:${join(pc.scratch, "elsewhere")}:${local(pc)}`, (pc: Pc) => `${pc.bin}:${join(pc.scratch, "elsewhere")}`]) {
      const pc = new Pc();
      const first = other(pc);
      const out = write(pc, path(pc));
      // theirs keeps the name only while it comes first: the line says what putting ~/.local/bin before it does
      expect(out).toContain(`Ovis: ovis on your PATH runs ${first}, another program: this installer's is ${pc.launcher}, which takes the name once ${local(pc)} comes before it on your PATH`);
      expect(out).toContain("ours=1");
      expect(out).toContain(`command=${pc.launcher}`);
    }

    const kept = new Pc().written();
    const later = other(kept);
    const again = write(kept, `${kept.bin}:${local(kept)}:${join(kept.scratch, "elsewhere")}`);
    expect(again).toContain(`Ovis: ${later} is another ovis on your PATH: ${kept.launcher}, this installer's, comes before it there`);
    expect(again).toContain("ours=1");
    expect(again).toContain("command=ovis");

    const alone = new Pc();
    expect(write(alone, `${alone.bin}:${local(alone)}`).trim().split("\n")).toEqual(["ours=1", "command=ovis"]);
  });

  it("on a checkout from before link, runs the release kept for this checkout and port, whatever other folders are there", () => {
    const other = new Pc().written().flag("running");
    const first = other.checkout("first-install");
    other.release(first, "add", { port: 17317, label: "stale" });
    const refused = other.ovis(["add"]);
    expect(refused.code, refused.out).toBe(1);
    expect(refused.out.trim()).toBe("ovis: this Ovis is from before it could add a PC to an account. Update it in Settings → Updates, then run this again");
    expect(other.addCalls()).toEqual([]);
    expect(other.sh(`running_code '${first}'`).out.trim()).toBe(first);

    const pc = new Pc().written().flag("running");
    const root = pc.checkout("first-install");
    const state = join(pc.scratch, ".config", "ovis");
    for (const port of [17317, 27317]) pc.release(root, "add", { port, label: `port-${port}` });
    pc.release(root, "add", { checkout: join(pc.scratch, "a-clone"), label: "another-checkout" });
    const right = pc.release(root, "add", { label: "running" });
    for (const port of [37317, 47317, 8080, 8081, 8082]) pc.release(root, "add", { port, label: `port-${port}` });
    pc.release(root, "add", { checkout: join(pc.scratch, "b-clone"), label: "another-checkout" });
    expect(readdirSync(join(state, "updates"))).toHaveLength(10);
    const ran = (extra?: Record<string, string>) => {
      const run = pc.ovis(["add", "--google"], extra);
      expect(run.code, run.out).toBe(0);
      return pc.addCalls().at(-1)?.release;
    };
    const picked = (extra?: Record<string, string>) => pc.sh(`running_code '${root}'`, extra).out.trim();
    expect(ran()).toBe("running");
    expect(picked()).toBe(realpathSync(right));
    for (const port of [7317, 27317, 8081, 9999]) {
      const active = activePluginScript(root, port, state);
      expect(picked({ PORT: String(port) })).toBe(active === join(root, "scripts", "plugin.ts") ? root : dirname(dirname(active)));
    }
    expect(picked({ PORT: "9999" })).toBe(root);
    writeFileSync(join(state, "plugin-port"), "17317\n");
    expect(ran()).toBe("port-17317");
    expect(picked()).toContain(createHash("sha256").update(`${root}:17317`).digest("hex").slice(0, 16));
    expect(ran({ PORT: "27317" })).toBe("port-27317");
    expect(picked({ PORT: "27317" })).toContain(createHash("sha256").update(`${root}:27317`).digest("hex").slice(0, 16));
    writeFileSync(join(state, "plugin-port"), "not a port\n");
    expect(ran()).toBe("running");
  });

  it("reads the plugin's settings files as scripts/plugin.ts does: the state dir, its old name, PORT and XDG_CONFIG_HOME", () => {
    const pc = () => {
      const made = new Pc().written().flag("running");
      return { pc: made, root: made.checkout("first-install") };
    };
    const ran = (made: Pc, root: string, extra?: Record<string, string>) => {
      const run = made.ovis(["add"], extra);
      const release = run.code === 0 ? made.addCalls().at(-1)?.release : `exit ${run.code}: ${run.out.trim()}`;
      const code = made.sh(`running_code '${root}'`, extra).out.trim();
      expect(code === root ? "the checkout" : readFileSync(join(code, "scripts", "plugin.ts"), "utf8").split("\n")[0]).toBe(run.code === 0 ? `process.env.RELEASE = ${JSON.stringify(release)};` : "the checkout");
      return release;
    };

    const moved = pc();
    moved.pc.release(moved.root, "add", { state: join(moved.pc.scratch, "state elsewhere"), label: "in OVIS_STATE_DIR" });
    moved.pc.settings("env", `# the plugin's settings\n\nnot a setting\n=nothing\n  OVIS_STATE_DIR = "${join(moved.pc.scratch, "state elsewhere")}"  \nOVIS_TOKEN=secret\n`);
    expect(ran(moved.pc, moved.root)).toBe("in OVIS_STATE_DIR");

    const legacy = pc();
    legacy.pc.release(legacy.root, "add", { state: join(legacy.pc.scratch, "old-name"), label: "in HERDR_WEB_STATE_DIR" });
    legacy.pc.release(legacy.root, "add", { state: join(legacy.pc.scratch, "shell"), label: "in the shell's" });
    legacy.pc.settings("env", `HERDR_WEB_STATE_DIR='${join(legacy.pc.scratch, "old-name")}'\n`);
    expect(ran(legacy.pc, legacy.root, { OVIS_STATE_DIR: join(legacy.pc.scratch, "shell") })).toBe("in HERDR_WEB_STATE_DIR");

    const port = pc();
    port.pc.release(port.root, "add", { label: "port 7317" });
    port.pc.release(port.root, "add", { port: 8123, label: "port 8123" });
    port.pc.settings(".env", "PORT=8123\n");
    expect(ran(port.pc, port.root)).toBe("port 8123");
    expect(ran(port.pc, port.root, { PORT: "7317" })).toBe("port 8123");

    const xdg = pc();
    xdg.pc.release(xdg.root, "add", { label: "under ~/.config" });
    xdg.pc.release(xdg.root, "add", { state: join(xdg.pc.scratch, "xdg", "ovis"), label: "under XDG_CONFIG_HOME" });
    xdg.pc.settings(".env", `XDG_CONFIG_HOME=${join(xdg.pc.scratch, "xdg")}\n`);
    expect(ran(xdg.pc, xdg.root)).toBe("under XDG_CONFIG_HOME");

    const order = pc();
    for (const name of ["shell", "env", "dotenv"]) order.pc.release(order.root, "add", { state: join(order.pc.scratch, name), label: name });
    const shell = { OVIS_STATE_DIR: join(order.pc.scratch, "shell") };
    expect(ran(order.pc, order.root, shell)).toBe("shell");
    order.pc.settings("env", `OVIS_STATE_DIR=${join(order.pc.scratch, "env")}\n`);
    expect(ran(order.pc, order.root, shell)).toBe("env");
    order.pc.settings(".env", `OVIS_STATE_DIR=${join(order.pc.scratch, "dotenv")}\n`);
    expect(ran(order.pc, order.root, shell)).toBe("dotenv");

    const renamed = pc();
    renamed.pc.release(renamed.root, "add", { state: join(renamed.pc.scratch, "old-id"), label: "old id" });
    renamed.pc.settings("env", `OVIS_STATE_DIR=${join(renamed.pc.scratch, "old-id")}\n`, "devswha.herdr-web-ui");
    expect(ran(renamed.pc, renamed.root)).toBe("old id");

    const named = pc();
    named.pc.release(named.root, "add", { state: join(named.pc.scratch, ".config", "herdr-web-ui"), label: "old name" });
    expect(ran(named.pc, named.root)).toBe("old name");
    named.pc.release(named.root, "add", { label: "new name" });
    expect(ran(named.pc, named.root)).toBe("old name");
    rmSync(join(named.pc.scratch, ".config", "herdr-web-ui", "updates"), { recursive: true });
    mkdirSync(join(named.pc.scratch, ".config", "herdr-web-ui", "bridges"));
    expect(ran(named.pc, named.root)).toBe("new name");

    // a settings file is read, never run
    const inert = pc();
    inert.pc.release(inert.root, "add", { label: "default" });
    inert.pc.settings("env", `OVIS_TOKEN=$(touch "${join(inert.pc.scratch, "ran")}")\ntouch "${join(inert.pc.scratch, "ran")}"\nX=\`touch "${join(inert.pc.scratch, "ran")}"\`\n`);
    expect(ran(inert.pc, inert.root)).toBe("default");
    expect(existsSync(join(inert.pc.scratch, "ran"))).toBe(false);
  });

  it("the installer adds through the checkout's own script where that knows link, and through the running release only before it", () => {
    const lines = (pc: Pc, root: string, code: string) => pc.sh(`add=0; terminal=0; launcher_ours=0; original_path=$PATH; root='${root}'; code='${code}'; add_pc; closing_lines`).out;
    const printed = (out: string) => new RegExp(`${ADD_LINE}(.*)$`, "m").exec(out)?.[1] ?? "";
    const pc = new Pc().flag("running");
    const root = pc.checkout("plugin", "add");
    expect(printed(lines(pc, root, pc.release(root, "add")))).toBe(`bun ${root}/scripts/plugin.ts add`);
    const older = new Pc().flag("running");
    const linking = older.checkout("plugin", "link");
    expect(printed(lines(older, linking, older.release(linking, "add")))).toBe(`bun ${linking}/scripts/plugin.ts link`);
    const oldest = new Pc().flag("running");
    const before = oldest.checkout("plugin");
    const release = oldest.release(before, "add");
    expect(printed(lines(oldest, before, release))).toBe(`bun ${release}/scripts/plugin.ts add`);
  });

  it("tells the reader of the release that runs, not the checkout's: the checkout's script hands the add on to it", () => {
    const reads = (pc: Pc, root: string, code: string) => pc.sh(`root='${root}'; code='${code}'; if add_reads_answers; then echo new; else echo old; fi`).out.trim();
    const old = (pc: Pc, root: string, code: string) => pc.sh(`add=1; terminal=0; launcher_ours=0; original_path=$PATH; root='${root}'; code='${code}'; add_pc; echo "result=$add_result old=$add_old"; closing_lines`).out;
    const updated = new Pc().flag("running");
    const first = updated.checkout("plugin", "link");
    writeFileSync(join(first, "scripts", "plugin-link.ts"), readerScript("old"));
    expect(reads(updated, first, updated.release(first, "add"))).toBe("new");
    const stale = new Pc().flag("running");
    const root = stale.checkout("plugin", "link");
    const release = stale.release(root, "link", { reader: "old" });
    expect(reads(stale, root, release)).toBe("old");
    const said = old(stale, root, release);
    expect(said).toContain("result=none old=1");
    expect(said).toContain(`${OLD_READER_LINE}bun ${root}/scripts/plugin.ts link`);
    expect(stale.addCalls()).toEqual([]);
    // the word in a comment is not the function
    expect(readerScript("old")).toContain("answerOf");
    expect(readFileSync(join(ROOT, "scripts", "plugin-link.ts"), "utf8")).toContain("\nexport function answerOf(");
  });

  // the checkout's script hands the add on to the release that runs, which Settings → Updates may have moved either way
  it("gates --account on the release that runs, not the checkout's: the checkout's script hands the add on to it", () => {
    const takes = (pc: Pc, root: string, code: string) => pc.sh(`binary=0; root='${root}'; code='${code}'; find_add_name; if add_takes_account; then echo takes; else echo not; fi`).out.trim();
    const updated = new Pc().flag("running");
    const first = updated.checkout("plugin", "link");
    writeFileSync(join(first, "scripts", "plugin-link.ts"), readerScript("before-account"));
    expect(takes(updated, first, updated.release(first, "add"))).toBe("takes");
    const stale = new Pc().flag("running");
    const root = stale.checkout("plugin", "link");
    const release = stale.release(root, "link", { reader: "before-account" });
    expect(takes(stale, root, release)).toBe("not");
    const said = stale.sh(`add=1; account=${ACCOUNT}; terminal=0; launcher_ours=0; original_path=$PATH; root='${root}'; code='${release}'; add_pc; echo "result=$add_result old=$add_old"; closing_lines`).out;
    expect(said).toContain("result=none old=1");
    expect(said).toContain(NO_ACCOUNT_CHECK_LINE);
    expect(stale.addCalls()).toEqual([]);
  });

  it("prints commands that run from a home directory with a space in its name", async () => {
    const pc = new Pc({ home: "john o'smith " }).written().flag("running");
    expect(pc.scratch).toContain(" ");
    const root = join(pc.scratch, "plugin");
    const escaped = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
    const printed = (ours: 0 | 1) => new RegExp(`${ADD_LINE}(.*)$`, "m").exec(pc.sh(`add=0; terminal=0; launcher_ours=${ours}; original_path=$PATH; root=${escaped(root)}; code=$root; add_pc; closing_lines`).out)?.[1] ?? "";
    expect(printed(1)).toBe(`${escaped(pc.launcher)} add`);
    expect(printed(0)).toBe(`bun ${escaped(`${root}/scripts/plugin.ts`)} add`);
    for (const ours of [1, 0] as const) {
      const run = Bun.spawnSync(["/bin/sh", "-c", printed(ours)], { cwd: pc.scratch, env: pc.environment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
      expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
    }
    expect(pc.addCalls()).toHaveLength(2);
    expect(pc.sh(`quoted /home/someone/.local/bin/ovis`).out).toBe("/home/someone/.local/bin/ovis");
    const whole = new Pc({ home: "john smith " }).flag("running");
    const { out, exitCode } = await whole.unattended();
    expect(exitCode, out).toBe(0);
    expect(out).toContain(`Ovis: ${ADD_LINE}'${whole.launcher}' add\n`);
    expect(Bun.spawnSync(["/bin/sh", "-c", `'${whole.launcher}' add`], { cwd: whole.scratch, env: whole.environment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 }).exitCode).toBe(0);
    expect(whole.addCalls()).toHaveLength(1);
  });

  it("the guide's Uninstall removes the installer's launcher, and no other ovis", () => {
    const guide = readFileSync(join(ROOT, "docs", "guide.md"), "utf8");
    const uninstall = guide.slice(guide.indexOf("### Uninstall"), guide.indexOf("## Supported agents"));
    const line = uninstall.split("\n").find((text) => text.includes("~/.local/bin/ovis")) ?? "";
    expect(line).toContain("rm -f ~/.local/bin/ovis");
    const pasted = (pc: Pc) => Bun.spawnSync(["/bin/sh", "-c", line], { cwd: pc.scratch, env: pc.environment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const ours = new Pc().written();
    expect(pasted(ours).stderr.toString()).toBe("");
    expect(existsSync(ours.launcher)).toBe(false);
    // an ovis of the user's own stays: a file, and a link (which the installer never takes for its own, mark or not)
    const own = new Pc();
    mkdirSync(join(own.scratch, ".local", "bin"), { recursive: true });
    writeFileSync(own.launcher, "#!/bin/sh\necho \"someone's own ovis\"\n", { mode: 0o755 });
    pasted(own);
    expect(readFileSync(own.launcher, "utf8")).toBe("#!/bin/sh\necho \"someone's own ovis\"\n");
    const linked = new Pc();
    mkdirSync(join(linked.scratch, ".local", "bin"), { recursive: true });
    writeFileSync(join(linked.scratch, "elsewhere"), `#!/bin/sh\n${MARK}\n`, { mode: 0o755 });
    symlinkSync(join(linked.scratch, "elsewhere"), linked.launcher);
    pasted(linked);
    expect(lstatSync(linked.launcher).isSymbolicLink()).toBe(true);
    expect(pasted(new Pc()).stderr.toString()).toBe("");
  });
});

describe.skipIf(platform() === "win32")("install.sh --add", () => {
  it.concurrent("fails on an option it does not know, with the usage, before it installs anything", async () => {
    for (const args of [["--ad"], ["--add", "extra"], ["add"]]) {
      const pc = new Pc();
      const { out, exitCode } = await pc.unattended(args);
      expect(exitCode, out).toBe(1);
      expect(out.trim()).toBe(`Ovis: does not know the option '${args.at(-1)}'. ${USAGE}`);
      expect(existsSync(pc.launcher)).toBe(false);
    }
  });

  it.concurrent("installs the launcher and names ovis add, with nothing asked", async () => {
    const pc = new Pc();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("the phone step");
    expect(out).toContain(`Ovis: ${ADD_LINE}${pc.launcher} add\n`);
    expect(out).not.toContain(HINT_LINE);
    expect(out).toContain(`Ovis: ${TOKEN_LINE} (https://github.com/devswha/ovis/blob/main/docs/relay.md#a-pc-with-no-screen)`);
    expect(pc.addCalls()).toEqual([]);
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), command: "status" });
    const onPath = await pc.unattended([], { PATH: `${pc.bin}:${join(pc.scratch, ".local", "bin")}` });
    expect(onPath.out).toContain(`Ovis: ${ADD_LINE}ovis add\n`);
  });

  it.concurrent("without a terminal, --add and OVIS_ADD=1 say what to run and add nothing", async () => {
    for (const [args, extra] of [[["--add"], {}], [[], { OVIS_ADD: "1" }]] as const) {
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.unattended([...args], extra);
      expect(exitCode, out).toBe(0);
      expect(out).toContain(`Ovis: ${HINT_LINE}${pc.launcher} add\n`);
      expect(out).not.toContain(ADD_LINE);
      expect(out).toContain(TOKEN_LINE);
      expect(pc.addCalls()).toEqual([]);
    }
  });

  it.concurrent("refuses --account without an id, before it installs anything", async () => {
    for (const args of [["--account"], ["--account="], ["--add", "--account", "--add"]]) {
      const pc = new Pc();
      const { out, exitCode } = await pc.unattended(args);
      expect(exitCode, out).toBe(1);
      expect(out.trim()).toBe(`Ovis: --account takes your Ovis account's id (ovis status on a PC already in it shows it). ${USAGE}`);
      expect(existsSync(pc.launcher)).toBe(false);
    }
    const pc = new Pc();
    const { out, exitCode } = await pc.unattended([], { OVIS_ADD_ACCOUNT: "--add" });
    expect(exitCode, out).toBe(1);
    expect(out.trim()).toBe(`Ovis: OVIS_ADD_ACCOUNT takes your Ovis account's id (ovis status on a PC already in it shows it). ${USAGE}`);
    expect(existsSync(pc.launcher)).toBe(false);
  });

  it.concurrent("--no-service and OVIS_NO_SERVICE=1 still start herdr, once, and say what starts it again", async () => {
    for (const [args, extra] of [[["--no-service"], {}], [[], { OVIS_NO_SERVICE: "1" }]] as const) {
      const pc = new Pc().flag("herdr-starts");
      const { out, exitCode } = await pc.unattended([...args], extra);
      expect(exitCode, out).toBe(0);
      expect(out).toContain(", in herdr, which was started for now, with no service (--no-service): after a restart herdr starts when you open it\n");
    }
  });

  // a script's or a coding agent's add: nobody is there to type yes, so the account is named in advance
  it.concurrent("with --account, adds with no terminal and reads nothing, and its exit status says whether the PC was added", async () => {
    for (const [args, extra] of [[["--add", "--account", ACCOUNT], {}], [[`--account=${ACCOUNT}`], {}], [[], { OVIS_ADD_ACCOUNT: ACCOUNT }]] as const) {
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.unattended([...args], extra);
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([{ command: "add", rest: ["--account", ACCOUNT], terminal: false }]);
      expect(out).not.toContain(HINT_LINE);
      expect(out.split(TOKEN_LINE)).toHaveLength(2);
      expect(out.indexOf(TOKEN_LINE)).toBeLessThan(out.indexOf("the add step"));
    }
    const failing = new Pc().flag("running").flag("add-fails");
    const failed = await failing.unattended(["--add", "--account", ACCOUNT]);
    expect(failed.exitCode, failed.out).toBe(1);
    expect(failed.out).toContain(`Ovis: ${NOT_ADDED_LINE}${failing.launcher} add --account ${ACCOUNT}\n`);
  });

  it.concurrent("with --account on a fresh PC, starts herdr and adds the PC, all in one run", async () => {
    const pc = new Pc().flag("herdr-starts");
    const { out, exitCode } = await pc.unattended(["--add", "--account", ACCOUNT]);
    expect(exitCode, out).toBe(0);
    expect(pc.addCalls()).toEqual([{ command: "add", rest: ["--account", ACCOUNT], terminal: false }]);
    expect(out).toContain(STARTED_LINE);
  });

  it.concurrent("with --account, does not start the add of a release that would not check that account, and exits non-zero", async () => {
    const pc = new Pc().flag("running");
    pc.plugin("plugin", "add", "devswha.ovis", "before-account");
    const { out, exitCode } = await pc.unattended(["--add", "--account", ACCOUNT]);
    expect(exitCode, out).toBe(1);
    expect(pc.addCalls()).toEqual([]);
    expect(out).toContain(`Ovis: ${NO_ACCOUNT_CHECK_LINE}${pc.launcher} add --account ${ACCOUNT}\n`);
  });

  it.concurrent("with --account where the app does not come up, says what to run once it does, and exits non-zero", async () => {
    const pc = new Pc();
    const { out, exitCode } = await pc.unattended(["--add", "--account", ACCOUNT]);
    expect(exitCode, out).toBe(1);
    expect(pc.addCalls()).toEqual([]);
    expect(out).toContain(`Ovis: ${WAITS_LINE}${pc.launcher} add --account ${ACCOUNT}\n`);
  });

  it("does not run at a screen that shows its words when there is no terminal to answer at", () => {
    // stdout a terminal, as the installer found it, in a session with no controlling terminal: /dev/tty does not open
    const pc = new Pc().flag("running");
    symlinkSync(Bun.which("perl")!, join(pc.bin, "perl"));
    const call = `add=1; terminal=1; launcher_ours=1; original_path=$PATH; root='${join(pc.scratch, "plugin")}'; code=$root; add_pc; echo "result=$add_result"; closing_lines`;
    const run = Bun.spawnSync(["perl", "-MPOSIX", "-e", "if (fork) { wait; exit($? >> 8) } POSIX::setsid(); exec @ARGV or exit 127", "/bin/sh", "-c", `set -eu\n${CONSTANTS}\n${FUNCTIONS}\n${call}`],
      { cwd: pc.scratch, env: pc.environment(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const out = run.stdout.toString() + run.stderr.toString();
    expect(run.exitCode, out).toBe(0);
    expect(out).toContain("result=none");
    expect(out).toContain(HINT_LINE);
    expect(pc.addCalls()).toEqual([]);
  });

  // script(1) as util-linux has it
  describe.skipIf(platform() !== "linux" || Bun.which("script") === null)("at a terminal", () => {
    it.concurrent("ends the install with the add step, reading from the terminal itself", async () => {
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      // under `curl | sh` stdin is the script: the add step's input is the terminal all the same
      expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: true }]);
      expect(out.indexOf("the phone step")).toBeLessThan(out.indexOf("the add step"));
      expect(out).not.toContain("to add this PC to your Ovis account");
      // who counts as this PC is said once, before the add starts: "set OVIS_TOKEN first" can still be done
      expect(out.split(TOKEN_LINE)).toHaveLength(2);
      expect(out.indexOf(TOKEN_LINE)).toBeGreaterThan(out.indexOf("the phone step"));
      expect(out.indexOf(TOKEN_LINE)).toBeLessThan(out.indexOf("the add step"));
    });

    // What was typed while the installer worked, or pasted after its command, is still in the terminal when the
    // add step starts: it must not be there to answer what the add asks later (a device's approval, y/N).
    for (const how of ["perl", "stty and dd"] as const) {
      it.concurrent(`discards what was typed before the add step starts (${how})`, async () => {
        const pc = new Pc().flag("running").flag("add-reads");
        if (how === "perl") { symlinkSync(Bun.which("perl")!, join(pc.bin, "perl")); rmSync(join(pc.bin, "stty")); }
        const { out, exitCode } = await pc.atTerminal("--add", {}, { after: "Ovis", text: "y\n", once: true });
        expect(exitCode, out).toBe(0);
        expect(out.indexOf("y\r\n")).toBeLessThan(out.indexOf(TOKEN_LINE));
        expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: true, typed: null }]);
      });
    }

    it.concurrent("what is typed once the add step runs still reaches it", async () => {
      const pc = new Pc().flag("running").flag("add-reads");
      const { out, exitCode } = await pc.atTerminal("--add", {}, { after: "the add step", text: "y\n" });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: true, typed: "y\n" }]);
    });

    it.concurrent("does not run the add step where what was typed cannot be discarded, and says what to run", async () => {
      // neither perl nor stty: nothing here can empty the terminal, so nothing typed before is taken for an answer
      const pc = new Pc().flag("running").flag("add-reads");
      rmSync(join(pc.bin, "stty"));
      const { out, exitCode } = await pc.atTerminal("--add", {}, { after: "Ovis", text: "y\n", once: true });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(`Ovis: ${HINT_LINE}${pc.launcher} add`);
    });

    it.concurrent("OVIS_ADD=1 means the same as --add", async () => {
      const pc = new Pc().flag("running");
      const { exitCode, out } = await pc.atTerminal("", { OVIS_ADD: "1" });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: true }]);
    });

    it.concurrent("adds nothing without --add", async () => {
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.atTerminal("");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(ADD_LINE);
    });

    it.concurrent("never runs the add step under OVIS_NO_OPEN=1, and says what to run", async () => {
      // the app's own SSH installer sets it: that terminal is not the person's to answer at
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.atTerminal("--add", { OVIS_NO_OPEN: "1" });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(HINT_LINE);
    });

    it.concurrent("runs a release from before add by the name it knows, link", async () => {
      const pc = new Pc().flag("running");
      pc.plugin("plugin", "link");
      const { exitCode, out } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([{ command: "link", rest: [], terminal: true }]);
    });

    // install.sh is served from main, and installs the latest release: until that one has the reader that tells a
    // line typed ahead from an answer, a "y" and Enter typed during its sign-in would approve the first device that asks
    it.concurrent("does not run the add step of a release whose reader takes a line typed ahead (v0.5.2), and says to update first", async () => {
      const pc = new Pc().flag("running").flag("add-reads");
      pc.plugin("plugin", "link", "devswha.ovis", "old");
      const { out, exitCode } = await pc.atTerminal("--add", {}, { after: "Ovis", text: "y\n" });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).not.toContain("the add step");
      expect(out).toContain(`Ovis: ${OLD_READER_LINE}${pc.launcher} add`);
      expect(out).not.toContain(HINT_LINE);
      const next = new Pc().flag("running");
      next.plugin("plugin", "link", "devswha.ovis", "new");
      const ran = await next.atTerminal("--add");
      expect(ran.exitCode, ran.out).toBe(0);
      expect(next.addCalls()).toEqual([{ command: "link", rest: [], terminal: true }]);
      expect(ran.out).not.toContain(OLD_READER_LINE);
    });

    it.concurrent("says what to run on a release from before both", async () => {
      const pc = new Pc().flag("running");
      pc.plugin("plugin", "neither");
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(`Ovis: ${UPDATE_LINE}`);
      expect(out).not.toContain("to add this PC to your Ovis account");
      expect(out).not.toContain(" add\r\n");
      expect(pc.ovis(["add"]).code).toBe(1);
    });

    it.concurrent("starts herdr where it is not running, so the app runs now and the add step goes on", async () => {
      const pc = new Pc().flag("herdr-starts");
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: true }]);
      expect(out).toContain(STARTED_LINE);
      expect(out).toContain(`see them: ${pc.launcher} status, herdr status server. Stop Ovis: ${pc.launcher} stop (it starts again with herdr). Stop herdr and every terminal in it: herdr server stop`);
      expect(out).not.toContain(WAITS_LINE);
    });

    it.concurrent("does not start the add step where herdr does not come up, and says what to run once it does", async () => {
      const pc = new Pc();
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(out).toContain(`herdr did not start, so neither did the app; to see why: run ${join(pc.bin, "herdr")} server`);
      expect(out).not.toContain("Ovis runs now");
      expect(out).not.toContain("start it first");
      expect(out).not.toContain("the add step");
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(`Ovis: ${WAITS_LINE}${pc.launcher} add`);
      expect(out.split(TOKEN_LINE)).toHaveLength(2);
      pc.flag("running");
      expect(pc.ovis(["add"]).code).toBe(0);
      expect(pc.addCalls()).toHaveLength(1);
    });

    it.skipIf(Bun.which("bash") === null).concurrent("does not read the terminal from the background, where that would stop the install", async () => {
      // `curl … | sh -s -- --add &`: the terminal shows its words and /dev/tty opens, but a read there stops a background job
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.atTerminal("--add", {}, undefined, true);
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(`Ovis: ${HINT_LINE}${pc.launcher} add`);
    });

    it.concurrent("an add that fails does not fail the install, and the way to add stays on the screen", async () => {
      const pc = new Pc().flag("running").flag("add-fails");
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toHaveLength(1);
      expect(out).toContain(ADD_LINE);
      expect(out.split(TOKEN_LINE)).toHaveLength(2);
    });

    it.concurrent("Ctrl-C ends the add, not the install", async () => {
      const pc = new Pc().flag("running").flag("add-waits");
      const { out, exitCode } = await pc.atTerminal("--add", {}, { after: "waiting for an approval", text: CTRL_C });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toHaveLength(1);
      expect(out).toContain(ADD_LINE);
      expect(out).toContain(TOKEN_LINE);
    });
  });
});

// An invite a device of the account made (shared/account-list-join.ts): the stand-in never reads past its shape
const JOIN_PAYLOAD = Buffer.from(JSON.stringify({ v: 1, service: "https://accounts.ovis.test", account: "TEST-ONLY-account", list: "", secret: "TEST-ONLY-secret" })).toString("base64url");
const JOIN_LINE = `ovis-join:1:${JOIN_PAYLOAD}`;
const JOINED_LINE = "this PC is in the Ovis account the invite is for. Check: ";
const NOT_AN_INVITE = "Ovis: that is not an Ovis invite: an invite is one line that starts with ovis-join:1:, made on a device signed in to your account. Nothing was installed. ";
const UNCONFIRMED_LINE = "nobody here can confirm the account the invite is for, so this PC did not join it, and the invite was not used. Name that account: run this again with --account <id> (the id shown with the invite, or ovis status --json on a PC already in it), or run in a terminal on this PC: ";
const JOIN_WAITS_LINE = "the app is not running, so this PC did not join your Ovis account. Once it runs, run on this PC: ";
const NOBODY_TO_ANSWER = "Ovis: a join where nobody can answer needs the account the invite is for: add --account <id> (the id shown with the invite, or ovis status --json on a PC already in it; OVIS_ADD_ACCOUNT=<id> where arguments cannot be given). Nothing was installed. ";
const NO_JOIN_LINE = "this Ovis release has no ovis join (it came in 0.5.10), so this PC did not join your Ovis account. Update Ovis in Settings → Updates, then run on this PC: ";
/** the closing line for each way `ovis join` ends (scripts/plugin-join.ts, JOIN_EXIT): the ones a person meets most, word for word */
const JOIN_FAILED: Record<number, string> = {
  3: "the invite did not work: it is mistyped, used or expired (an invite works once, for 15 minutes), or for another account service. Ask for a new one on a device signed in to your account",
  5: "the invite is for another Ovis account than --account names, so this PC did not join it, and the invite was not used",
  10: "the account service did not answer, so this PC did not join your Ovis account. Try again in a moment (the invite works for 15 minutes): ",
  14: "nobody pressed Add for this PC while its card showed, so it did not join your Ovis account. Ask for a new invite",
};

describe.skipIf(platform() === "win32")("install.sh --join", () => {
  const inviteFile = (pc: Pc, text = `${JOIN_LINE}\n`, name = "ovis-invite.txt"): string => {
    const path = join(pc.scratch, name);
    writeFileSync(path, text, { mode: 0o600 });
    return path;
  };

  it.concurrent("refuses a line of another shape, a missing or second way to give it, and a join with --add, before it installs anything, never repeating it", async () => {
    const cases: { args: (pc: Pc) => string[]; extra?: Record<string, string>; said: string }[] = [
      ...["not-an-invite", "ovis-join:1:", `ovis-join:1:${JOIN_PAYLOAD}==`, `ovis-join:2:${JOIN_PAYLOAD}`, `ovis-join:1:${"a".repeat(1100)}`, `ovis-join:1:${JOIN_PAYLOAD} ${JOIN_PAYLOAD}`].map((line) => ({ args: () => ["--join", line], said: `${NOT_AN_INVITE}${USAGE}` })),
      { args: () => [], extra: { OVIS_JOIN: `x${JOIN_LINE}` }, said: `${NOT_AN_INVITE}${USAGE}` },
      { args: (pc) => ["--join-file", inviteFile(pc, `${JOIN_LINE}\n${JOIN_LINE}\n`)], said: `${NOT_AN_INVITE}${USAGE}` },
      ...[["--join"], ["--join="], ["--join", "--add"]].map((args) => ({ args: () => args, said: `Ovis: --join takes the invite's line, which starts with ovis-join:1:. ${USAGE}` })),
      ...[["--join-file"], ["--join-file", "--account"]].map((args) => ({ args: () => args, said: `Ovis: --join-file takes the path of a file holding the invite's line. ${USAGE}` })),
      ...[(pc: Pc) => join(pc.scratch, "no-such-file"), (pc: Pc) => pc.scratch].map((path) => ({ args: (pc: Pc) => ["--join-file", path(pc)], said: `Ovis: --join-file names no file you can read (a file holding the invite's line). Nothing was installed. ${USAGE}` })),
      { args: (pc) => ["--join", JOIN_LINE, "--join-file", inviteFile(pc)], said: `Ovis: give the invite one way only: --join-file <path>, OVIS_JOIN, or --join <line>. ${USAGE}` },
      { args: () => ["--add", "--join", JOIN_LINE], said: `Ovis: a join adds this PC with an invite, and --add (OVIS_ADD=1) with a sign-in: give one of them. ${USAGE}` },
      { args: () => ["--join", JOIN_LINE, "--add"], said: `Ovis: a join adds this PC with an invite, and --add (OVIS_ADD=1) with a sign-in: give one of them. ${USAGE}` },
      { args: () => [], extra: { OVIS_ADD: "1", OVIS_JOIN: JOIN_LINE }, said: `Ovis: a join adds this PC with an invite, and --add (OVIS_ADD=1) with a sign-in: give one of them. ${USAGE}` },
    ];
    for (const { args, extra, said } of cases) {
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.unattended(args(pc), extra);
      expect(exitCode, out).toBe(1);
      expect(out.trim()).toBe(said);
      expect(out).not.toContain(JOIN_PAYLOAD.slice(0, 24));
      expect(existsSync(pc.launcher)).toBe(false);
      expect(pc.joinCalls()).toEqual([]);
    }
  });

  // a script's or a coding agent's join: the account is named, so nothing is asked and nothing is read
  it.concurrent("with --account, joins with no terminal, the line in ovis join's environment alone; the exit status says whether the PC joined", async () => {
    const forms: { args: (pc: Pc) => string[]; extra?: Record<string, string> }[] = [
      { args: (pc) => ["--join-file", inviteFile(pc), "--account", ACCOUNT] },
      // relative to where the installer runs, with the line as a file a phone's copy or an editor leaves it
      { args: (pc) => { inviteFile(pc, `\r\n  ${JOIN_LINE}\r\n\r\n`, "pasted.txt"); return [`--join-file=pasted.txt`, `--account=${ACCOUNT}`]; } },
      { args: () => ["--join", JOIN_LINE, "--account", ACCOUNT] },
      { args: () => [`--join=${JOIN_LINE}`], extra: { OVIS_ADD_ACCOUNT: ACCOUNT } },
      { args: () => [], extra: { OVIS_JOIN: ` ${JOIN_LINE}\n`, OVIS_ADD_ACCOUNT: ACCOUNT } },
    ];
    for (const { args, extra } of forms) {
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.unattended(args(pc), extra);
      expect(exitCode, out).toBe(0);
      expect(pc.joinCalls()).toEqual([{ rest: ["--account", ACCOUNT], terminal: false, invite: JOIN_LINE }]);
      expect(pc.addCalls()).toEqual([]);
      expect(pc.leaked()).toEqual([]);
      expect(out).toContain(`Ovis: ${JOINED_LINE}${pc.launcher} status --json\n`);
      expect(out).not.toContain(JOIN_PAYLOAD.slice(0, 24));
      expect(out).not.toContain(ADD_LINE);
      expect(out.split(TOKEN_LINE)).toHaveLength(2);
      expect(out.indexOf(TOKEN_LINE)).toBeLessThan(out.indexOf("the join step"));
    }
  });

  it.concurrent("where herdr was not running, starts herdr, which is given no invite, and joins in the same run", async () => {
    const pc = new Pc().flag("herdr-starts");
    const { out, exitCode } = await pc.unattended([], { OVIS_JOIN: JOIN_LINE, OVIS_ADD_ACCOUNT: ACCOUNT });
    expect(exitCode, out).toBe(0);
    expect(out).toContain(STARTED_LINE);
    expect(pc.joinCalls()).toEqual([{ rest: ["--account", ACCOUNT], terminal: false, invite: JOIN_LINE }]);
    expect(pc.leaked()).toEqual([]);
  });

  it.concurrent("says in one line what each way ovis join fails means, and exits non-zero", async () => {
    const said = new Map<number, string>();
    for (let code = 1; code <= 15; code++) {
      const pc = new Pc().flag("running").joinExits(code);
      const file = inviteFile(pc);
      const { out, exitCode } = await pc.unattended(["--join-file", file, "--account", ACCOUNT]);
      expect(exitCode, out).toBe(1);
      expect(pc.joinCalls()).toHaveLength(1);
      expect(out).not.toContain(JOINED_LINE);
      const last = out.trim().split("\n").filter((line) => line.startsWith("Ovis: ") && !line.includes(TOKEN_LINE)).at(-1) ?? "";
      expect(last, out).toMatch(/did not join|did not work/);
      said.set(code, last);
      if (code in JOIN_FAILED) expect(out).toContain(`Ovis: ${JOIN_FAILED[code]}`);
      if (code === 10) expect(out).toContain(`${JOIN_FAILED[10]}${pc.launcher} join --invite-file ${file} --account ${ACCOUNT}\n`);
    }
    // the one PC that is in another account already: named, with the way out of it
    expect(said.get(6)).toContain("this PC is in another Ovis account, so it did not join the invite's, and the invite was not used. To move it: ");
    expect(said.get(6)).toContain(" logout, then run on this PC: ");
    // what a person can do about it differs between these, and so do the lines
    expect(new Set([3, 4, 5, 6, 8, 9, 10, 12, 13, 14].map((code) => said.get(code))).size).toBe(10);
  });

  // nobody would be there to answer whether the invite's account is theirs: refused at once, not after the install
  it.concurrent("without --account where nobody can answer, refuses before it installs anything, naming the flag to add", async () => {
    const cases: { args: (pc: Pc) => string[]; extra?: Record<string, string> }[] = [
      { args: () => [], extra: { OVIS_JOIN: JOIN_LINE } },
      { args: () => [], extra: { OVIS_JOIN: JOIN_LINE, OVIS_NO_OPEN: "1" } },
      { args: (pc) => ["--join-file", inviteFile(pc)] },
      { args: () => ["--join", JOIN_LINE, "--no-service"] },
    ];
    for (const { args, extra } of cases) {
      const pc = new Pc().flag("running").flag("herdr-starts");
      const { out, exitCode } = await pc.unattended(args(pc), extra);
      expect(exitCode, out).toBe(1);
      expect(out.trim()).toBe(`${NOBODY_TO_ANSWER}${USAGE}`);
      expect(existsSync(pc.launcher)).toBe(false);
      expect(pc.joinCalls()).toEqual([]);
    }
  });

  it.concurrent("does not start ovis join on a release without it, nor where the app did not come up, and exits non-zero", async () => {
    const old = new Pc().flag("running");
    old.plugin("plugin", "add", "devswha.ovis", "new", false);
    const file = inviteFile(old);
    const before = await old.unattended(["--join-file", file, "--account", ACCOUNT]);
    expect(before.exitCode, before.out).toBe(1);
    expect(old.joinCalls()).toEqual([]);
    expect(before.out).toContain(`Ovis: ${NO_JOIN_LINE}${old.launcher} join --invite-file ${file} --account ${ACCOUNT}\n`);
    const down = new Pc();
    const { out, exitCode } = await down.unattended(["--join", JOIN_LINE, "--account", ACCOUNT]);
    expect(exitCode, out).toBe(1);
    expect(down.joinCalls()).toEqual([]);
    expect(out).toContain(`Ovis: ${JOIN_WAITS_LINE}${down.launcher} join --invite-file <a file holding the invite> --account ${ACCOUNT}\n`);
  });

  // the checkout's script hands a command on to the release that runs, which Settings → Updates may have moved on
  it("gates the join on the release that runs, through the checkout's script where that has it", () => {
    const takes = (pc: Pc, root: string, code: string, binary = "binary=0") => pc.sh(`${binary}; root='${root}'; code='${code}'; if join_takes; then echo "takes \${join_code:-}"; else echo not; fi`).out.trim();
    const updated = new Pc();
    const first = updated.checkout("plugin", "link");
    rmSync(join(first, "scripts", "plugin-join.ts"));
    const release = updated.release(first, "add");
    expect(takes(updated, first, release)).toBe(`takes ${release}`);
    expect(takes(updated, release, release)).toBe(`takes ${release}`);
    const current = new Pc();
    const root = current.checkout("plugin", "add");
    expect(takes(current, root, current.release(root, "add"))).toBe(`takes ${root}`);
    const stale = new Pc();
    const checkout = stale.checkout("plugin", "add");
    expect(takes(stale, checkout, stale.release(checkout, "add", { joins: false }))).toBe("not");
    expect(takes(stale, "/nowhere", "/nowhere", "binary=1; version=0.5.9")).toBe("not");
    expect(takes(stale, "/nowhere", "/nowhere", "binary=1; version=0.5.10")).toMatch(/^takes/);
    // the file install.sh knows a release with ovis join by
    expect(fn("join_takes")).toContain("/scripts/plugin-join.ts");
  });

  it("on the release's binary, runs its ovis join with the line in its environment, and only from 0.5.10", () => {
    const pc = new Pc();
    const bin = join(pc.scratch, ".local", "share", "ovis", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ovis-server"), `#!/bin/sh
case "$1 $2" in
  "plugin status") echo "running http://127.0.0.1:7317 (pid 1234)" ;;
  "plugin join") shift; printf '%s\\n' "args=$*" "invite=\${OVIS_INVITE:-}" >>"$SCRATCH/binary-join"; exit 10 ;;
  *) echo "unexpected ovis-server $*" >&2; exit 2 ;;
esac
`, { mode: 0o755 });
    const ran = (version: string) => pc.sh(`binary=1; version=${version}; root=/nowhere; terminal=0; launcher_ours=1; original_path=$PATH; account=${ACCOUNT}; join_given=env; join_line='${JOIN_LINE}'; join_pc; echo "result=$join_result"; join_lines`).out;
    const said = ran("0.5.10");
    expect(said).toContain("result=10");
    expect(said).toContain(`Ovis: ${JOIN_FAILED[10]}${pc.launcher} join --invite-file <a file holding the invite> --account ${ACCOUNT}\n`);
    expect(said).not.toContain(JOIN_PAYLOAD.slice(0, 24));
    expect(readFileSync(join(pc.scratch, "binary-join"), "utf8")).toBe(`args=join --account ${ACCOUNT}\ninvite=${JOIN_LINE}\n`);
    rmSync(join(pc.scratch, "binary-join"));
    expect(ran("0.5.9")).toContain(`result=old\nOvis: ${NO_JOIN_LINE}`);
    expect(existsSync(join(pc.scratch, "binary-join"))).toBe(false);
  });

  it("the launcher hands join on from a checkout from before it to the release that has it, and says to update where none does", () => {
    const pc = new Pc().written().flag("running");
    const first = pc.checkout("first-install");
    pc.release(first, "add");
    const ran = pc.ovis(["join", "--invite-file", "x", "--account", ACCOUNT]);
    expect(ran.code, ran.out).toBe(0);
    expect(pc.joinCalls()).toEqual([{ rest: ["--invite-file", "x", "--account", ACCOUNT], terminal: false, invite: null, release: "updated" }]);
    const stale = new Pc().written().flag("running");
    stale.updated("first-install", "neither");
    const refused = stale.ovis(["join", "-"]);
    expect(refused.code).toBe(1);
    expect(refused.out.trim().split("\n")).toEqual(["ovis: this Ovis is from before ovis join. Update it in Settings → Updates, then run this again"]);
    expect(stale.joinCalls()).toEqual([]);
  });

  // ovis join and its line as main has them: this branch started before them, and CI runs it merged with main
  it.skipIf(!existsSync(join(ROOT, "scripts", "plugin-join.ts")))("reads ovis join's exit codes, its line and its variable as scripts/plugin-join.ts and shared/account-list-join.ts have them", () => {
    const exits = readFileSync(join(ROOT, "scripts", "plugin-join.ts"), "utf8");
    for (const [name, code] of [["ok", 0], ["invite_invalid", 3], ["not_confirmed", 4], ["account_mismatch", 5], ["other_account", 6], ["rate_limited", 7], ["pc_add_cap", 8], ["directory_full", 9], ["service_unreachable", 10], ["relay_unavailable", 12], ["not_running", 13], ["no_add", 14]] as const) {
      expect(exits).toMatch(new RegExp(`\\n  ${name}: ${code},\\n`));
    }
    const line = readFileSync(join(ROOT, "shared", "account-list-join.ts"), "utf8");
    expect(line).toContain('export const JOIN_LINE_PREFIX = "ovis-join:1:";');
    expect(line).toContain("export const JOIN_LINE_MAX_CHARS = 1024;");
    expect(INSTALLER).toContain('JOIN_PREFIX="ovis-join:1:"');
    expect(INSTALLER).toContain("JOIN_MAX=1024");
    expect(readFileSync(join(ROOT, "scripts", "plugin.ts"), "utf8")).toContain('process.env["OVIS_INVITE"]');
  });

  it.concurrent("--help says what each option does and which ways keep the line out of the process list, and installs nothing", async () => {
    const pc = new Pc();
    const { out, exitCode } = await pc.unattended(["--help"]);
    expect(exitCode, out).toBe(0);
    expect(out.split("\n")[0]).toBe(USAGE);
    for (const option of ["--add", "--account <id>", "--join-file <path>", "--join <line>", "--no-service", "OVIS_JOIN=<line>"]) expect(out).toContain(option);
    expect(out.replace(/\s+/g, " ")).toContain("shows in the process list to every user of this PC: use --join-file or OVIS_JOIN instead");
    expect(existsSync(pc.launcher)).toBe(false);
    expect(out).not.toContain("the phone step");
  });

  // script(1) as util-linux has it
  describe.skipIf(platform() !== "linux" || Bun.which("script") === null)("at a terminal", () => {
    it.concurrent("without --account, runs ovis join on the terminal, where it asks whether the account is yours, once what was typed before is gone", async () => {
      const pc = new Pc().flag("running").flag("add-reads");
      const file = inviteFile(pc);
      const { out, exitCode } = await pc.atTerminal(`--join-file '${file}'`, {}, { after: "Ovis", text: "yes\n", once: true });
      expect(exitCode, out).toBe(0);
      // a "yes" typed while the installer worked answers nothing: the question takes only what is typed under it
      expect(pc.joinCalls()).toEqual([{ rest: [], terminal: true, invite: JOIN_LINE, typed: null }]);
      expect(out).toContain(`Ovis: ${JOINED_LINE}`);
      expect(out).not.toContain(JOIN_PAYLOAD.slice(0, 24));
      expect(pc.leaked()).toEqual([]);
    });

    it.skipIf(Bun.which("bash") === null).concurrent("without --account in the terminal's background, where a read would stop the install, refuses before it installs anything", async () => {
      const pc = new Pc().flag("running");
      const { out, exitCode } = await pc.atTerminal("", { OVIS_JOIN: JOIN_LINE }, undefined, true);
      expect(exitCode, out).toBe(1);
      expect(out).toContain(NOBODY_TO_ANSWER);
      expect(existsSync(pc.launcher)).toBe(false);
      expect(pc.joinCalls()).toEqual([]);
    });

    it.concurrent("where what was typed cannot be discarded, does not run it, and says how", async () => {
      const pc = new Pc().flag("running");
      rmSync(join(pc.bin, "stty"));
      const { out, exitCode } = await pc.atTerminal("", { OVIS_JOIN: JOIN_LINE });
      expect(exitCode, out).toBe(1);
      expect(pc.joinCalls()).toEqual([]);
      expect(out).toContain(`Ovis: ${UNCONFIRMED_LINE}`);
    });
  });
});
