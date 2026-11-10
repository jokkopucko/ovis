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
const CTRL_C = "\x03";
/** a run of install.sh ends in about a second alone, in many on a PC busy with other checks */
const RUN_ENDS_WITHIN_MS = 45_000;
setDefaultTimeout(RUN_ENDS_WITHIN_MS + 15_000);

/** one top-level shell function from install.sh, by name, as written there (one line or a block) */
function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(INSTALLER) ?? new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const CONSTANTS = ["REPO", "BIN_DIR", "LAUNCHER_MARK"].map((name) => {
  const line = new RegExp(`^${name}=.*$`, "m").exec(INSTALLER)?.[0];
  if (!line) throw new Error(`install.sh sets no ${name}`);
  return line;
}).join("\n");
const FUNCTIONS = ["say", "link", "launcher_text", "find_other_ovis", "write_launcher", "ovis_command", "find_add_name", "add_reads_answers", "add_command", "in_foreground", "discard_typed", "add_pc", "token_line", "closing_lines", "release_js", "running_code", "quoted"].map(fn).join("\n");

const dir = mkdtempSync(join(tmpdir(), "ovis-install-command-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The plugin's script, as a stand-in: it says where it ran from, what it was given and the dirs it
 * was handed. `add` (and `link`) leave a record, with whether their input is a terminal (and, on a PC
 * flagged `add-reads`, the line already typed there when they start), and like the
 * real one they fail while the app is not running. `status` says "running" while the PC's `running`
 * flag is set. `knows` is the release: one with `add`, one from before it (only `link`), or one from
 * before both, which answers a name it does not know with its usage and exit 2 as the real one does
 * (in single quotes there: the installer tells a release by the words `"link"` and COMMAND_ALIASES).
 */
function pluginScript(knows: "add" | "link" | "neither" = "add"): string {
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
  return `${knows === "add" ? "// COMMAND_ALIASES: this release knows add and login\n" : ""}const [command = "status", ...rest] = process.argv.slice(2);
if (command === "phone") console.log("the phone step");
else if (command === "status" && (await import("node:fs")).existsSync(process.env.SCRATCH + "/running")) console.log("running http://127.0.0.1:7317 (pid 1234)");
else if (['add', 'login', 'link'].includes(command) && ${knows === "neither" ? "true" : knows === "link" ? `command !== "link"` : "false"}) { console.error("usage: bun scripts/plugin.ts <start|stop|status|pair|phone|phone-setup>"); process.exit(2); }
else if (${knows === "neither" ? "false" : knows === "add" ? `["add", "login", "link"].includes(command)` : `command === "link"`}) ${record}
else console.log(JSON.stringify({ root: import.meta.dir, command, rest, config: process.env.HERDR_PLUGIN_CONFIG_DIR ?? null, state: process.env.HERDR_PLUGIN_STATE_DIR ?? null }));
`;
}

/**
 * scripts/plugin-link.ts, as a stand-in: the code that asks about the device that adds the PC. `new` tells a line
 * typed ahead from an answer, by the function install.sh knows such a release by; `old` is v0.5.2's, which asks
 * [y/N] and takes the next line the terminal hands it (the words are its own).
 */
function readerScript(reader: "new" | "old"): string {
  return reader === "new"
    ? `export function answerOf(line: string, digits: string, whole = false): "approve" | "decline" | null { return null; }\n`
    : `export function approves(answer: string, digits: string): boolean { return false; }\n// Type the last three digits to approve [y/N]; nothing here is called answerOf (the word alone, in a comment, is not the function)\n`;
}

const STAND_INS: Record<string, string> = {
  // the plugin installed already, under the id (and at the root) the test's files name; herdr runs while the PC's app does
  herdr: `case "$*" in
  --version) echo "herdr 0.9.3" ;;
  "plugin list") echo "$(cat "$SCRATCH/plugin-id") 0.0.0" ;;
  "plugin list --json") printf '{"result":{"plugins":[{"plugin_id":"someone.else","plugin_root":"/nowhere"},{"plugin_id":"%s","plugin_root":"%s"}]}}\\n' "$(cat "$SCRATCH/plugin-id")" "$(cat "$SCRATCH/plugin-root")" ;;
  "plugin config-dir "*) echo "$SCRATCH/herdr-config/$3" ;;
  "status server --json") if [ -e "$SCRATCH/running" ]; then echo '{"running":true}'; else echo '{"running":false}'; fi ;;
  "plugin action invoke "*) ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`,
  node: `case "$1" in -p) case "$(uname -m)" in aarch64 | arm64) echo "22 arm64" ;; *) echo "22 x64" ;; esac ;; *) echo v22.0.0 ;; esac`,
  // a rerun fetches nothing
  curl: `echo "unexpected curl $*" >&2; exit 1`,
};

/** One PC per test: a home directory, and a PATH that holds only what install.sh and the launcher run. */
class Pc {
  readonly scratch: string;
  readonly bin: string;
  readonly launcher: string;
  readonly app: string;

  /** `herdr: false`: a PC without herdr (Ovis on herdr-core, or nothing installed); `home`: how its home directory's name begins */
  constructor(options: { herdr?: boolean; home?: string } = {}) {
    this.scratch = mkdtempSync(join(dir, options.home ?? "pc-"));
    this.bin = join(this.scratch, "bin");
    this.launcher = join(this.scratch, ".local", "bin", "ovis");
    this.app = join(this.scratch, ".local", "share", "ovis", "app");
    mkdirSync(this.bin);
    // (no perl: the add step empties the terminal with stty and dd, and finds its foreground with ps)
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

  /** herdr lists the plugin at `name` under `id`; `knows` is what its script does, `reader` how its add step reads an answer */
  plugin(name: string, knows: "add" | "link" | "neither" = "add", id = "devswha.ovis", reader: "new" | "old" = "new"): string {
    const root = join(this.scratch, name);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "plugin.ts"), pluginScript(knows));
    // a release from before link has no such file
    if (knows !== "neither") writeFileSync(join(root, "scripts", "plugin-link.ts"), readerScript(reader));
    writeFileSync(join(this.scratch, "plugin-id"), id);
    writeFileSync(join(this.scratch, "plugin-root"), root);
    return root;
  }
  /** herdr lists no Ovis plugin */
  noPlugin(): this { writeFileSync(join(this.scratch, "plugin-id"), "someone.other"); return this; }
  /** Ovis on herdr-core: its own checkout, where install.sh puts it */
  core(): string {
    mkdirSync(join(this.app, "scripts"), { recursive: true });
    writeFileSync(join(this.app, "scripts", "plugin.ts"), pluginScript());
    writeFileSync(join(this.app, "scripts", "plugin-link.ts"), readerScript("new"));
    return this.app;
  }
  /** herdr's checkout at `name` as a git checkout with one commit, whose script `knows` what it is given: its root */
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
  /**
   * A release Settings → Updates installed for the checkout at `root` while its server ran on `port`,
   * kept in `state` as server/updater.ts keeps it: in the folder named after the checkout and the
   * port (updateStateDir), with a current.json that names the checkout's commit. `label` is what its
   * add step records as the release that ran; `checkout` is another checkout at the same commit that
   * keeps its releases in the same state dir.
   */
  release(root: string, knows: "add" | "link" | "neither", options: { port?: number | string; state?: string; label?: string; checkout?: string; reader?: "new" | "old" } = {}): string {
    const state = options.state ?? join(this.scratch, ".config", "ovis");
    const updates = join(state, "updates", createHash("sha256").update(`${options.checkout ?? root}:${options.port ?? 7317}`).digest("hex").slice(0, 16));
    const release = join(updates, "release-1");
    mkdirSync(join(release, "scripts"), { recursive: true });
    writeFileSync(join(release, "scripts", "plugin.ts"), `process.env.RELEASE = ${JSON.stringify(options.label ?? "updated")};\n${pluginScript(knows)}`);
    if (knows !== "neither") writeFileSync(join(release, "scripts", "plugin-link.ts"), readerScript(options.reader ?? "new"));
    writeFileSync(join(updates, "current.json"), JSON.stringify({ source_revision: this.git(root, "rev-parse", "HEAD"), directory: release }));
    return release;
  }
  /**
   * herdr's checkout at `name` is a git checkout from before `link`, and Settings → Updates has since
   * installed a release (what it `knows`), which is the code that runs.
   */
  updated(name: string, knows: "add" | "link" | "neither"): string {
    return this.release(this.checkout(name), knows);
  }
  /** a settings file of the plugin (`env` or `.env`), in the folder herdr gives it */
  settings(name: "env" | ".env", text: string, id = "devswha.ovis"): this {
    mkdirSync(join(this.scratch, "herdr-config", id), { recursive: true });
    writeFileSync(join(this.scratch, "herdr-config", id, name), text);
    return this;
  }
  flag(name: "add-fails" | "add-waits" | "add-reads" | "running"): this { writeFileSync(join(this.scratch, name), ""); return this; }
  /** what the add step was run with, one record per run */
  addCalls(): { command: string; rest: string[]; terminal: boolean; typed?: string | null; release?: string }[] {
    const log = join(this.scratch, "add.calls");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  }
  environment(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: this.bin, HOME: this.scratch, SCRATCH: this.scratch, SHELL: "/bin/sh", TERM: "xterm", ...extra };
  }

  /** runs `call` after install.sh's constants and functions under sh with `set -eu`, as the script runs */
  sh(call: string, extra?: Record<string, string>): { code: number; out: string } {
    const run = Bun.spawnSync(["/bin/sh", "-c", `set -eu\n${CONSTANTS}\n${FUNCTIONS}\n${call}`], { cwd: this.scratch, env: this.environment(extra), stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString() };
  }
  /** the launcher install.sh writes, written */
  written(): this {
    const { code, out } = this.sh("write_launcher");
    if (code !== 0 || !existsSync(this.launcher)) throw new Error(`write_launcher wrote no launcher: ${out}`);
    return this;
  }
  /** runs the written launcher as a shell would, by its path */
  ovis(args: string[], extra?: Record<string, string>): { code: number; out: string } {
    const run = Bun.spawnSync([this.launcher, ...args], { cwd: this.scratch, env: this.environment(extra), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString() };
  }

  /** the whole installer as a script or an agent runs it: the script on stdin, and no terminal */
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
    // nothing of the write is left beside it
    expect(readdirSync(join(pc.scratch, ".local", "bin"))).toEqual(["ovis"]);
    expect(Bun.spawnSync(["/bin/sh", "-n", pc.launcher]).exitCode).toBe(0);
  });

  it("holds no path of the install that wrote it", () => {
    const pc = new Pc().written();
    const text = readFileSync(pc.launcher, "utf8");
    expect(text).not.toContain(pc.scratch);
    // the same words whichever PC wrote it
    expect(readFileSync(new Pc().written().launcher, "utf8")).toBe(text);
  });

  it("finds the herdr plugin each time it runs, and hands on the command and its flags", () => {
    const pc = new Pc().written();
    const first = pc.ovis(["pair", "--approve"]);
    expect(first.code, first.out).toBe(0);
    expect(JSON.parse(first.out)).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), command: "pair", rest: ["--approve"] });
    // the plugin reinstalled somewhere else: the same launcher follows it
    const moved = pc.plugin("plugin-moved");
    expect(JSON.parse(pc.ovis([]).out)).toMatchObject({ root: join(moved, "scripts"), command: "status", rest: [] });
  });

  it("finds a plugin still installed under the id before the rename", () => {
    const pc = new Pc().written();
    const root = pc.plugin("legacy-plugin", "add", "devswha.herdr-web-ui");
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ root: join(root, "scripts") });
  });

  it("runs Ovis on herdr-core from its checkout, with the dirs its service gives it", () => {
    // with herdr on the PC or without it, while herdr lists no Ovis plugin
    const without = new Pc({ herdr: false }).written();
    const alone = without.core();
    expect(JSON.parse(without.ovis(["status"]).out)).toMatchObject({ root: join(alone, "scripts") });
    const pc = new Pc().noPlugin().written();
    const app = pc.core();
    const ran = JSON.parse(pc.ovis(["status"]).out);
    expect(ran).toMatchObject({ root: join(app, "scripts"), config: join(pc.scratch, ".config", "ovis"), state: join(pc.scratch, ".local", "state", "ovis") });
    // the names from before the rename, while only those exist
    mkdirSync(join(pc.scratch, ".config", "herdr-web-ui"), { recursive: true });
    mkdirSync(join(pc.scratch, ".local", "state", "herdr-web-ui"), { recursive: true });
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ config: join(pc.scratch, ".config", "herdr-web-ui"), state: join(pc.scratch, ".local", "state", "herdr-web-ui") });
    // dirs that are given are kept
    expect(JSON.parse(pc.ovis(["status"], { HERDR_PLUGIN_CONFIG_DIR: "/given/config", HERDR_PLUGIN_STATE_DIR: "/given/state" }).out)).toMatchObject({ config: "/given/config", state: "/given/state" });
  });

  it("runs the herdr plugin where an earlier herdr-core checkout is still there beside it", () => {
    // OVIS_RUNTIME=herdr over an earlier herdr-core install: the installer's own steps run the plugin, so the command does
    const pc = new Pc().written();
    pc.core();
    const ran = JSON.parse(pc.ovis(["status"]).out);
    expect(ran).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), config: null, state: null });
    pc.flag("running");
    expect(pc.ovis(["add"]).code).toBe(0);
    expect(pc.addCalls()).toEqual([{ command: "add", rest: [], terminal: false }]);
    // the plugin removed: the checkout is the install again
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
    for (const [name, pattern] of [["find_add_name", "grep -qs 'COMMAND_ALIASES' "], ["find_add_name", `grep -qs '"link"' `], ["launcher_text", "grep -qs COMMAND_ALIASES "], ["launcher_text", `grep -qs '"link"' `]] as const) {
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
      // no herdr at all, and a herdr that lists no Ovis plugin
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
      // what the closing lines name instead of a command that is not there
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
    // another ovis comes first on the PATH: the name would run that one
    writeFileSync(join(pc.bin, "ovis"), "#!/bin/sh\n", { mode: 0o755 });
    expect(named(`${pc.bin}:${join(pc.scratch, ".local", "bin")}`)).toBe(pc.launcher);
  });

  it("on a checkout from before link, runs the release Settings → Updates installed", () => {
    // herdr's checkout stays at the version first installed: its own script answers add with its usage
    const pc = new Pc().written().flag("running");
    pc.updated("first-install", "add");
    for (const name of ["add", "login", "link"]) {
      const ran = pc.ovis([name, "--google"]);
      expect(ran.code, ran.out).toBe(0);
    }
    expect(pc.addCalls().map((call) => [call.release, call.command, ...call.rest])).toEqual([["updated", "add", "--google"], ["updated", "login", "--google"], ["updated", "link", "--google"]]);
    // every other command stays with the checkout, whose script hands on by itself where it needs to
    expect(JSON.parse(pc.ovis(["pair"]).out)).toMatchObject({ root: join(pc.scratch, "first-install", "scripts"), command: "pair" });
    // a running release from before add and login: the name it knows
    pc.updated("first-install-2", "link");
    expect(pc.ovis(["add"]).code).toBe(0);
    expect(pc.addCalls().at(-1)).toMatchObject({ release: "updated", command: "link" });
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

    // a checkout from before link, updated in the app: the launcher's `ovis add` is named, and runs
    const updated = new Pc().written().flag("running");
    const release = updated.updated("first-install", "link");
    const first = join(updated.scratch, "first-install");
    expect(printed(lines(updated, 1, first, release))).toBe(`${updated.launcher} add`);
    expect(runs(updated, printed(lines(updated, 1, first, release)))).toBe(0);
    // an ovis of the user's own there: the running release's script, by the name it knows
    expect(printed(lines(updated, 0, first, release))).toBe(`bun ${release}/scripts/plugin.ts link`);
    expect(runs(updated, printed(lines(updated, 0, first, release)))).toBe(0);
    expect(updated.addCalls().map((call) => call.command)).toEqual(["link", "link"]);

    // no release that can add: the line says to update, and names no command
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
    // a write that fails leaves nothing of its own behind either
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

    // a launcher of the installer's that is there already stays the installer's, and the installer says it comes first
    const kept = new Pc().written();
    const later = other(kept);
    const again = write(kept, `${kept.bin}:${local(kept)}:${join(kept.scratch, "elsewhere")}`);
    expect(again).toContain(`Ovis: ${later} is another ovis on your PATH: ${kept.launcher}, this installer's, comes before it there`);
    expect(again).toContain("ours=1");
    expect(again).toContain("command=ovis");

    // no other ovis: nothing is said
    const alone = new Pc();
    expect(write(alone, `${alone.bin}:${local(alone)}`).trim().split("\n")).toEqual(["ours=1", "command=ovis"]);
  });

  it("on a checkout from before link, runs the release kept for this checkout and port, whatever other folders are there", () => {
    // only a release kept for another port (a start that fell back to 17317, since back on 7317): the
    // server on 7317 runs the checkout itself, which cannot add
    const other = new Pc().written().flag("running");
    const first = other.checkout("first-install");
    other.release(first, "add", { port: 17317, label: "stale" });
    const refused = other.ovis(["add"]);
    expect(refused.code, refused.out).toBe(1);
    expect(refused.out.trim()).toBe("ovis: this Ovis is from before it could add a PC to an account. Update it in Settings → Updates, then run this again");
    expect(other.addCalls()).toEqual([]);
    expect(other.sh(`running_code '${first}'`).out.trim()).toBe(first);

    // many folders name the checkout's commit: other ports of this checkout, and another checkout at
    // the same commit that keeps its releases in the same state dir. Whichever the listing gives last,
    // the one of this checkout and port runs.
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
    // the very folder scripts/plugin.ts hands on to, on this port and on another
    for (const port of [7317, 27317, 8081, 9999]) {
      const active = activePluginScript(root, port, state);
      expect(picked({ PORT: String(port) })).toBe(active === join(root, "scripts", "plugin.ts") ? root : dirname(dirname(active)));
    }
    expect(picked({ PORT: "9999" })).toBe(root);
    // the port a start settled on because 7317 could not be opened (scripts/plugin.ts keeps it in plugin-port)
    writeFileSync(join(state, "plugin-port"), "17317\n");
    expect(ran()).toBe("port-17317");
    expect(picked()).toContain(createHash("sha256").update(`${root}:17317`).digest("hex").slice(0, 16));
    // a PORT that is set is the port, whatever an earlier start settled on
    expect(ran({ PORT: "27317" })).toBe("port-27317");
    expect(picked({ PORT: "27317" })).toContain(createHash("sha256").update(`${root}:27317`).digest("hex").slice(0, 16));
    // a port file that names no port is passed by
    writeFileSync(join(state, "plugin-port"), "not a port\n");
    expect(ran()).toBe("running");
  });

  it("reads the plugin's settings files as scripts/plugin.ts does: the state dir, its old name, PORT and XDG_CONFIG_HOME", () => {
    const pc = () => {
      const made = new Pc().written().flag("running");
      return { pc: made, root: made.checkout("first-install") };
    };
    /** the release `ovis add` runs, and the one the installer finds, which are the same */
    const ran = (made: Pc, root: string, extra?: Record<string, string>) => {
      const run = made.ovis(["add"], extra);
      const release = run.code === 0 ? made.addCalls().at(-1)?.release : `exit ${run.code}: ${run.out.trim()}`;
      const code = made.sh(`running_code '${root}'`, extra).out.trim();
      expect(code === root ? "the checkout" : readFileSync(join(code, "scripts", "plugin.ts"), "utf8").split("\n")[0]).toBe(run.code === 0 ? `process.env.RELEASE = ${JSON.stringify(release)};` : "the checkout");
      return release;
    };

    // OVIS_STATE_DIR in `env`, among a comment, a blank line, a line with no key and quotes around the value
    const moved = pc();
    moved.pc.release(moved.root, "add", { state: join(moved.pc.scratch, "state elsewhere"), label: "in OVIS_STATE_DIR" });
    moved.pc.settings("env", `# the plugin's settings\n\nnot a setting\n=nothing\n  OVIS_STATE_DIR = "${join(moved.pc.scratch, "state elsewhere")}"  \nOVIS_TOKEN=secret\n`);
    expect(ran(moved.pc, moved.root)).toBe("in OVIS_STATE_DIR");

    // the name from before the rename, in a file: it wins over the new name the shell has, as in mergeEnvLayers
    const legacy = pc();
    legacy.pc.release(legacy.root, "add", { state: join(legacy.pc.scratch, "old-name"), label: "in HERDR_WEB_STATE_DIR" });
    legacy.pc.release(legacy.root, "add", { state: join(legacy.pc.scratch, "shell"), label: "in the shell's" });
    legacy.pc.settings("env", `HERDR_WEB_STATE_DIR='${join(legacy.pc.scratch, "old-name")}'\n`);
    expect(ran(legacy.pc, legacy.root, { OVIS_STATE_DIR: join(legacy.pc.scratch, "shell") })).toBe("in HERDR_WEB_STATE_DIR");

    // PORT in `.env`: the folder of that port, not the default's
    const port = pc();
    port.pc.release(port.root, "add", { label: "port 7317" });
    port.pc.release(port.root, "add", { port: 8123, label: "port 8123" });
    port.pc.settings(".env", "PORT=8123\n");
    expect(ran(port.pc, port.root)).toBe("port 8123");
    // and a file's PORT wins over the shell's, as every setting in them does
    expect(ran(port.pc, port.root, { PORT: "7317" })).toBe("port 8123");

    // XDG_CONFIG_HOME in `.env`: the default state dir is under it
    const xdg = pc();
    xdg.pc.release(xdg.root, "add", { label: "under ~/.config" });
    xdg.pc.release(xdg.root, "add", { state: join(xdg.pc.scratch, "xdg", "ovis"), label: "under XDG_CONFIG_HOME" });
    xdg.pc.settings(".env", `XDG_CONFIG_HOME=${join(xdg.pc.scratch, "xdg")}\n`);
    expect(ran(xdg.pc, xdg.root)).toBe("under XDG_CONFIG_HOME");

    // .env wins over env, and env over the shell's own
    const order = pc();
    for (const name of ["shell", "env", "dotenv"]) order.pc.release(order.root, "add", { state: join(order.pc.scratch, name), label: name });
    const shell = { OVIS_STATE_DIR: join(order.pc.scratch, "shell") };
    expect(ran(order.pc, order.root, shell)).toBe("shell");
    order.pc.settings("env", `OVIS_STATE_DIR=${join(order.pc.scratch, "env")}\n`);
    expect(ran(order.pc, order.root, shell)).toBe("env");
    order.pc.settings(".env", `OVIS_STATE_DIR=${join(order.pc.scratch, "dotenv")}\n`);
    expect(ran(order.pc, order.root, shell)).toBe("dotenv");

    // a plugin still under the id before the rename: its folder's files
    const renamed = pc();
    renamed.pc.release(renamed.root, "add", { state: join(renamed.pc.scratch, "old-id"), label: "old id" });
    renamed.pc.settings("env", `OVIS_STATE_DIR=${join(renamed.pc.scratch, "old-id")}\n`, "devswha.herdr-web-ui");
    expect(ran(renamed.pc, renamed.root)).toBe("old id");

    // no settings: the state dir under its name from before the rename while it holds state of its own,
    // and under the new one once only the bridge registry is left there (defaultStateDir)
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
    // the checkout's script hands add on to the release that runs by itself (activePluginScript)
    const pc = new Pc().flag("running");
    const root = pc.checkout("plugin", "add");
    expect(printed(lines(pc, root, pc.release(root, "add")))).toBe(`bun ${root}/scripts/plugin.ts add`);
    // by the name the checkout knows, whatever the release knows
    const older = new Pc().flag("running");
    const linking = older.checkout("plugin", "link");
    expect(printed(lines(older, linking, older.release(linking, "add")))).toBe(`bun ${linking}/scripts/plugin.ts link`);
    // a checkout from before link cannot hand on: the release itself
    const oldest = new Pc().flag("running");
    const before = oldest.checkout("plugin");
    const release = oldest.release(before, "add");
    expect(printed(lines(oldest, before, release))).toBe(`bun ${release}/scripts/plugin.ts add`);
  });

  it("tells the reader of the release that runs, not the checkout's: the checkout's script hands the add on to it", () => {
    const reads = (pc: Pc, root: string, code: string) => pc.sh(`root='${root}'; code='${code}'; if add_reads_answers; then echo new; else echo old; fi`).out.trim();
    const old = (pc: Pc, root: string, code: string) => pc.sh(`add=1; terminal=0; launcher_ours=0; original_path=$PATH; root='${root}'; code='${code}'; add_pc; echo "result=$add_result old=$add_old"; closing_lines`).out;
    // a checkout at v0.5.2 whose app Settings → Updates has since brought to a release with the new reader
    const updated = new Pc().flag("running");
    const first = updated.checkout("plugin", "link");
    writeFileSync(join(first, "scripts", "plugin-link.ts"), readerScript("old"));
    expect(reads(updated, first, updated.release(first, "add"))).toBe("new");
    // the release that runs is the old one: no add step, whatever is said of the name
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
    // and the real script has it, by the words install.sh looks for
    expect(readFileSync(join(ROOT, "scripts", "plugin-link.ts"), "utf8")).toContain("\nexport function answerOf(");
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
    // a path with nothing a shell reads is printed as it is
    expect(pc.sh(`quoted /home/someone/.local/bin/ovis`).out).toBe("/home/someone/.local/bin/ovis");
    // the whole installer there: the line it ends on runs too
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
    // the installer's own goes
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
    // none there: nothing is said
    expect(pasted(new Pc()).stderr.toString()).toBe("");
  });

  it("does not promise that another ovis is never hidden", () => {
    // it keeps the name only while it comes first on the PATH: the changelog and the guide say so
    const fragment = readFileSync(join(ROOT, "changelog.d", "install-ovis-command.md"), "utf8");
    expect(fragment).not.toMatch(/never\s+replaced\s+or\s+hidden/);
    const guide = readFileSync(join(ROOT, "docs", "guide.md"), "utf8");
    expect(guide).toContain("until `~/.local/bin` comes before it on your PATH");
  });
});

describe.skipIf(platform() === "win32")("install.sh --add", () => {
  it.concurrent("fails on an option it does not know, with the usage, before it installs anything", async () => {
    for (const args of [["--ad"], ["--add", "extra"], ["add"]]) {
      const pc = new Pc();
      const { out, exitCode } = await pc.unattended(args);
      expect(exitCode, out).toBe(1);
      expect(out.trim()).toBe(`Ovis: does not know the option '${args.at(-1)}'. usage: curl -fsSL https://ovis.sh/install.sh | sh -s -- [--add]`);
      expect(existsSync(pc.launcher)).toBe(false);
    }
  });

  it.concurrent("installs the launcher and names ovis add, with nothing asked", async () => {
    const pc = new Pc();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("the phone step");
    // ~/.local/bin is not on this PC's PATH, so the line gives the path
    expect(out).toContain(`Ovis: ${ADD_LINE}${pc.launcher} add\n`);
    expect(out).not.toContain(HINT_LINE);
    expect(out).toContain(`Ovis: ${TOKEN_LINE} (https://github.com/devswha/ovis/blob/main/docs/relay.md#a-pc-with-no-screen)`);
    expect(pc.addCalls()).toEqual([]);
    // the launcher it wrote runs this PC's plugin
    expect(JSON.parse(pc.ovis(["status"]).out)).toMatchObject({ root: join(pc.scratch, "plugin", "scripts"), command: "status" });
    // and where the PATH has ~/.local/bin, the line names the command alone
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
      // added: the line that says how to add it is not printed
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
        // typed as soon as the installer says its first word, long before the add step
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
      // y and Enter, typed over and over from the installer's first word on, as during the old sign-in
      const { out, exitCode } = await pc.atTerminal("--add", {}, { after: "Ovis", text: "y\n" });
      expect(exitCode, out).toBe(0);
      expect(pc.addCalls()).toEqual([]);
      expect(out).not.toContain("the add step");
      expect(out).toContain(`Ovis: ${OLD_READER_LINE}${pc.launcher} add`);
      expect(out).not.toContain(HINT_LINE);
      // the same release, with the reader of the next one: its add step runs
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
      // no command of this release adds a PC, so none is named: neither `ovis add` nor the script
      expect(out).toContain(`Ovis: ${UPDATE_LINE}`);
      expect(out).not.toContain("to add this PC to your Ovis account");
      expect(out).not.toContain(" add\r\n");
      expect(pc.ovis(["add"]).code).toBe(1);
    });

    it.concurrent("does not start the add step while the app is not running, and says what to run once it is", async () => {
      // a fresh PC: this install put herdr there but cannot start it, so the app the add step asks is down
      const pc = new Pc();
      const { out, exitCode } = await pc.atTerminal("--add");
      expect(exitCode, out).toBe(0);
      expect(out).toContain("herdr is not running, so neither is the app yet");
      // the real add fails there ("Ovis is not running …; start it first"), and so does the stand-in
      expect(out).not.toContain("start it first");
      expect(out).not.toContain("the add step");
      expect(pc.addCalls()).toEqual([]);
      expect(out).toContain(`Ovis: ${WAITS_LINE}${pc.launcher} add`);
      expect(out.split(TOKEN_LINE)).toHaveLength(2);
      // the app up: the command the line names adds the PC
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
