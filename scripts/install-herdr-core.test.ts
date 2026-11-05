import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh on a PC with herdr-core (hc) and no herdr: which runtime it picks, the settings file it
 * writes and the user service it registers. The functions are cut out of install.sh itself and run
 * under /bin/sh with a HOME of their own and stand-in hc, systemctl, loginctl and launchctl, so
 * nothing on this PC is installed, started or registered.
 */

const ROOT = join(import.meta.dir, "..");
const INSTALLER = readFileSync(join(ROOT, "install.sh"), "utf8");
/** one top-level shell function from install.sh, by name, as written there (one line or a block) */
function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(INSTALLER) ?? new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const CONSTANTS = ["PLUGIN", "LEGACY_PLUGIN", "APP_DIR", "SERVICE", "AGENT_LABEL"].map((name) => {
  const line = new RegExp(`^${name}=.*$`, "m").exec(INSTALLER)?.[0];
  if (!line) throw new Error(`install.sh sets no ${name}`);
  return line;
}).join("\n");
const FUNCTIONS = ["say", "fail", "kill_tree", "bounded", "is_core", "core_dirs", "saved_setting", "find_core", "pick_runtime", "core_settings", "xml_text", "unit_text", "core_service"].map(fn).join("\n");

const dir = mkdtempSync(join(tmpdir(), "ovis-install-core-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** the system's tools without a herdr, herdr-core or hc this PC has in /usr/bin or /bin, so only a test's stand-ins answer */
const SYSTEM = join(dir, "system");
mkdirSync(SYSTEM);
const linked = new Set(["herdr", "herdr-core", "hc"]);
for (const from of ["/usr/bin", "/bin"].filter((system) => existsSync(system))) {
  for (const name of readdirSync(from)) {
    if (linked.has(name) || !existsSync(join(from, name))) continue;
    linked.add(name);
    symlinkSync(join(from, name), join(SYSTEM, name));
  }
}

/** a PC of its own: HOME, and a bin dir of stand-in tools that is the whole PATH besides the system's */
function pc(tools: Record<string, string> = {}): { home: string; bin: string; env: Record<string, string> } {
  const home = mkdtempSync(join(dir, "home-"));
  const bin = join(home, "tools");
  mkdirSync(bin);
  for (const [name, body] of Object.entries(tools)) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { home, bin, env: { HOME: home, PATH: `${bin}:${SYSTEM}`, OVIS_RUNTIME: "", XDG_CONFIG_HOME: "", OVIS_HC_BIN: "", HC_SESSION: "", HC_SOCKET: "" } };
}

/** runs `call` after install.sh's constants and functions under /bin/sh with `set -eu`, as the script runs */
function sh(call: string, env: Record<string, string>): { code: number; out: string; ms: number } {
  const started = performance.now();
  const run = Bun.spawnSync(["/bin/sh", "-c", `set -eu\n${CONSTANTS}\n${FUNCTIONS}\n${call}`], { env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString(), ms: performance.now() - started };
}

const CORE = `[ "$1" = --version ] && echo "hc 0.1.17" || { echo "ran $*" >> "$(dirname "$0")/ran"; exit 1; }`;

describe("find_core", () => {
  it("takes herdr-core that answers `hc <version>`, asking it only --version", () => {
    const { bin, env } = pc({ "herdr-core": CORE });
    const result = sh(`find_core && echo "CORE $core"`, env);
    expect(result.out).toContain(`CORE ${bin}/herdr-core`);
    expect(existsSync(join(bin, "ran"))).toBe(false);
  });

  it("passes over an hc that is another program, and one that hangs, within its bound", () => {
    const other = pc({ hc: `echo "hc 3.2 window manager client" >&2; echo "herbstclient 0.9"` });
    expect(sh(`find_core || echo NONE`, other.env).out).toContain("NONE");
    const hung = pc({ hc: "exec sleep 60" });
    const result = sh(`find_core || echo NONE`, hung.env);
    expect(result.out).toContain("NONE");
    expect(result.ms).toBeLessThan(15_000);
  }, 20_000);

  it("takes hc when there is no herdr-core", () => {
    const { bin, env } = pc({ hc: CORE });
    expect(sh(`find_core && echo "CORE $core"`, env).out).toContain(`CORE ${bin}/hc`);
  });

  it("takes the hc an earlier run saved when the PATH has none, and passes over a saved one that is gone", () => {
    const { home, env } = pc();
    const own = join(home, "own-hc");
    writeFileSync(own, `#!/bin/sh\n${CORE}\n`, { mode: 0o755 });
    mkdirSync(join(home, ".config", "ovis"), { recursive: true });
    writeFileSync(join(home, ".config", "ovis", "env"), `OVIS_RUNTIME=herdr-core\nOVIS_HC_BIN="${own}"\n`);
    expect(sh(`find_core && echo "CORE $core"`, env).out).toContain(`CORE ${own}`);
    writeFileSync(join(home, ".config", "ovis", "env"), `OVIS_HC_BIN=${join(home, "gone")}\n`);
    expect(sh(`find_core || echo NONE`, env).out).toContain("NONE");
  });

  it("passes over one that says `hc <version>` but fails", () => {
    expect(sh(`find_core || echo NONE`, pc({ hc: `echo "hc 0.1.17"; exit 1` }).env).out).toContain("NONE");
  });

  it("takes OVIS_HC_BIN first, and looks where cargo puts it when the PATH has none", () => {
    const { home, env } = pc({ hc: CORE });
    const own = join(home, "own-hc");
    writeFileSync(own, `#!/bin/sh\n${CORE}\n`, { mode: 0o755 });
    expect(sh(`find_core && echo "CORE $core"`, { ...env, OVIS_HC_BIN: own }).out).toContain(`CORE ${own}`);
    const cargo = pc();
    mkdirSync(join(cargo.home, ".cargo", "bin"), { recursive: true });
    writeFileSync(join(cargo.home, ".cargo", "bin", "herdr-core"), `#!/bin/sh\n${CORE}\n`, { mode: 0o755 });
    expect(sh(`find_core && echo "CORE $core"`, cargo.env).out).toContain(`CORE ${cargo.home}/.cargo/bin/herdr-core`);
  });
});

describe("pick_runtime", () => {
  const pick = (env: Record<string, string>) => sh(`pick_runtime; echo "RUNTIME $runtime"`, env);

  it("picks herdr-core where there is no herdr and herdr-core answers", () => {
    expect(pick(pc({ "herdr-core": CORE }).env).out).toContain("RUNTIME herdr-core");
  });

  it("keeps herdr where herdr is installed, and installs it where neither is", () => {
    expect(pick(pc({ "herdr-core": CORE, herdr: "echo herdr 0.9.5" }).env).out).toContain("RUNTIME herdr");
    expect(pick(pc({ "herdr-core": CORE, herdr: "echo herdr 0.9.5" }).env).out).not.toContain("herdr-core");
    expect(pick(pc().env).out).toContain("RUNTIME herdr\n");
  });

  it("keeps herdr-core for an earlier install on it, even once herdr is installed", () => {
    const { home, env } = pc({ "herdr-core": CORE, herdr: "echo herdr 0.9.5" });
    mkdirSync(join(home, ".local", "share", "ovis", "app", ".git"), { recursive: true });
    expect(pick(env).out).toContain("RUNTIME herdr-core");
  });

  it("does not move an earlier install on herdr-core to herdr when hc does not answer this time", () => {
    const { home, env } = pc({ herdr: "echo herdr 0.9.5" });
    mkdirSync(join(home, ".local", "share", "ovis", "app", ".git"), { recursive: true });
    const result = pick(env);
    expect(result.code).toBe(1);
    expect(result.out).toContain("no herdr-core (hc) answers");
    expect(result.out).not.toContain("RUNTIME herdr");
  });

  it("refuses herdr-core where the herdr plugin already runs Ovis, and says where its runtime is set", () => {
    const plugin = `[ "$1 $2" = "plugin list" ] && echo "- devswha.ovis (Ovis) enabled [github:devswha/ovis@v0.4.22]"; exit 0`;
    const result = pick({ ...pc({ "herdr-core": CORE, herdr: plugin }).env, OVIS_RUNTIME: "herdr-core" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("already runs here as a herdr plugin");
    expect(result.out).toContain("herdr plugin config-dir devswha.ovis");
  });

  it("follows OVIS_RUNTIME, and fails on herdr-core without one or on a runtime it does not know", () => {
    expect(pick({ ...pc({ "herdr-core": CORE }).env, OVIS_RUNTIME: "herdr" }).out).toContain("RUNTIME herdr\n");
    expect(pick({ ...pc({ "herdr-core": CORE, herdr: "echo herdr 0.9.5" }).env, OVIS_RUNTIME: "herdr-core" }).out).toContain("RUNTIME herdr-core");
    const missing = pick({ ...pc().env, OVIS_RUNTIME: "herdr-core" });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("no herdr-core (hc) answers");
    const unknown = pick({ ...pc().env, OVIS_RUNTIME: "tmux" });
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("OVIS_RUNTIME=tmux is not a runtime");
  });
});

describe("core_settings", () => {
  it("adds OVIS_RUNTIME=herdr-core to the env file scripts/plugin.ts reads, owner-only, once", () => {
    const { home, env } = pc();
    sh("core_settings; core_settings", env);
    const file = join(home, ".config", "ovis", "env");
    expect(readFileSync(file, "utf8")).toBe("OVIS_RUNTIME=herdr-core\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps a file's own lines and ends its last one first", () => {
    const { home, env } = pc();
    const config = join(home, ".config", "ovis");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "env"), "OVIS_TOKEN=secret", { mode: 0o600 });
    sh("core_settings", env);
    expect(readFileSync(join(config, "env"), "utf8")).toBe("OVIS_TOKEN=secret\nOVIS_RUNTIME=herdr-core\n");
  });

  it("replaces a runtime either file named, keeping the file's mode, and says so", () => {
    const { home, env } = pc();
    const config = join(home, ".config", "ovis");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "env"), "PORT=7400\nOVIS_RUNTIME=herdr-core\n", { mode: 0o600 });
    writeFileSync(join(config, ".env"), "OVIS_TOKEN=secret\nOVIS_RUNTIME=herdr\nHERDR_WEB_RUNTIME=herdr\n", { mode: 0o600 });
    const result = sh("core_settings", env);
    expect(result.out).toContain(".env named another runtime");
    expect(readFileSync(join(config, "env"), "utf8")).toBe("PORT=7400\nOVIS_RUNTIME=herdr-core\n");
    expect(readFileSync(join(config, ".env"), "utf8")).toBe("OVIS_TOKEN=secret\n");
    expect(statSync(join(config, ".env")).mode & 0o777).toBe(0o600);
    expect(sh("core_settings", env).out).not.toContain("another runtime");
  });

  it("records the hc find_core checked, in place of one either file had", () => {
    const { home, env } = pc();
    const config = join(home, ".config", "ovis");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, ".env"), "OVIS_HC_BIN=/gone/hc\nPORT=7400\n", { mode: 0o600 });
    sh("core=/opt/hc/herdr-core; core_settings", env);
    expect(readFileSync(join(config, "env"), "utf8")).toBe("OVIS_RUNTIME=herdr-core\nOVIS_HC_BIN=/opt/hc/herdr-core\n");
    expect(readFileSync(join(config, ".env"), "utf8")).toBe("PORT=7400\n");
    sh("core=/elsewhere/hc; core_settings", env);
    expect(readFileSync(join(config, "env"), "utf8")).toBe("OVIS_RUNTIME=herdr-core\nOVIS_HC_BIN=/elsewhere/hc\n");
    expect(existsSync(join(config, "env.new"))).toBe(false);
  });

  it("keeps the hc session the installer ran with, unless a file names one", () => {
    const { home, env } = pc();
    sh("core_settings", { ...env, HC_SESSION: "work", HC_SOCKET: "/run/hc/work.sock" });
    expect(readFileSync(join(home, ".config", "ovis", "env"), "utf8")).toBe("OVIS_RUNTIME=herdr-core\nHC_SESSION=work\nHC_SOCKET=/run/hc/work.sock\n");
    sh("core_settings", { ...env, HC_SESSION: "other" });
    expect(readFileSync(join(home, ".config", "ovis", "env"), "utf8")).toContain("HC_SESSION=work\n");
    expect(readFileSync(join(home, ".config", "ovis", "env"), "utf8")).not.toContain("other");
  });

  it("writes to the settings dir from before the rename while only that one exists", () => {
    const { home, env } = pc();
    mkdirSync(join(home, ".config", "herdr-web-ui"), { recursive: true });
    sh("core_settings", env);
    expect(readFileSync(join(home, ".config", "herdr-web-ui", "env"), "utf8")).toBe("OVIS_RUNTIME=herdr-core\n");
    expect(existsSync(join(home, ".config", "ovis"))).toBe(false);
  });
});

describe("core_service", () => {
  /** records each call of a stand-in tool, one line of arguments per call */
  const recorder = (name: string, extra = "") => `echo "${name} $*" >> "$HOME/calls"\n${extra}`;
  const bun = "exit 0";

  it("on Linux, registers ovis.service that runs plugin.ts start and stop, enabled and started now", () => {
    const { home, bin, env } = pc({ bun, systemctl: recorder("systemctl"), loginctl: recorder("loginctl", "echo Linger=no") });
    const result = sh("os=linux; core_settings; core_service", env);
    const unit = readFileSync(join(home, ".config", "systemd", "user", "ovis.service"), "utf8");
    const app = join(home, ".local", "share", "ovis", "app");
    expect(unit).toContain("Type=oneshot\nRemainAfterExit=yes\n");
    expect(unit).toContain(`ExecStart="${bin}/bun" "${app}/scripts/plugin.ts" start\n`);
    expect(unit).toContain(`ExecStop="${bin}/bun" "${app}/scripts/plugin.ts" stop\n`);
    expect(unit).toContain(`Environment="PATH=${env["PATH"]}"\n`);
    expect(unit).toContain(`Environment="HERDR_PLUGIN_CONFIG_DIR=${home}/.config/ovis"\nEnvironment="HERDR_PLUGIN_STATE_DIR=${home}/.local/state/ovis"\n`);
    expect(unit).toContain("WantedBy=default.target");
    expect(readFileSync(join(home, "calls"), "utf8")).toContain("systemctl --user enable --now ovis.service");
    expect(result.out).toContain("starts at login (systemd");
    expect(result.out).toContain("loginctl enable-linger");
  });

  it("escapes what systemd and launchd would read as their own syntax", () => {
    const linux = pc({ bun, systemctl: "exit 0" });
    const odd = `${linux.env["PATH"]}:/opt/50% "tools" \\x & $HOME`;
    sh("os=linux; core_settings; core_service", { ...linux.env, PATH: odd });
    const unit = readFileSync(join(linux.home, ".config", "systemd", "user", "ovis.service"), "utf8");
    expect(unit).toContain(`:/opt/50%% \\"tools\\" \\\\x & $HOME"\n`);
    const mac = pc({ bun, launchctl: "exit 0", id: "echo 501" });
    sh("os=darwin; core_settings; core_service", { ...mac.env, PATH: `${mac.env["PATH"]}:/Users/me/tools & <utilities>` });
    const plist = readFileSync(join(mac.home, "Library", "LaunchAgents", "sh.ovis.server.plist"), "utf8");
    expect(plist).toContain(":/Users/me/tools &amp; &lt;utilities&gt;</string>");
  });

  it("refuses a PATH with a newline, which would start a unit directive of its own", () => {
    const { home, env } = pc({ bun, systemctl: "exit 0" });
    const result = sh("os=linux; core_settings; core_service", { ...env, PATH: `${env["PATH"]}:/bin\nExecStartPost=/bin/true` });
    expect(result.code).toBe(1);
    expect(result.out).toContain("a newline in PATH or HOME");
    expect(existsSync(join(home, ".config", "systemd"))).toBe(false);
  });

  it("says how to start the app where there is no user systemd, or it refuses the unit", () => {
    const none = pc({ bun });
    const without = sh("os=linux; core_settings; core_service", none.env);
    expect(without.code).toBe(0);
    expect(without.out).toContain("no user service manager");
    expect(existsSync(join(none.home, ".config", "systemd"))).toBe(false);
    const refusing = pc({ bun, systemctl: `[ "$2" = show-environment ] && exit 0; exit 1` });
    const refused = sh("os=linux; core_settings; core_service", refusing.env);
    expect(refused.code).toBe(0);
    expect(refused.out).toContain("systemd did not take");
  });

  it("on macOS, loads a LaunchAgent that runs plugin.ts start at load and leaves the server it starts running", () => {
    const { home, bin, env } = pc({ bun, launchctl: recorder("launchctl"), id: `[ "$1" = -u ] && echo 501` });
    const result = sh("os=darwin; core_settings; core_service", env);
    const agent = join(home, "Library", "LaunchAgents", "sh.ovis.server.plist");
    const plist = readFileSync(agent, "utf8");
    expect(plist).toContain(`<array><string>${bin}/bun</string><string>${home}/.local/share/ovis/app/scripts/plugin.ts</string><string>start</string></array>`);
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain(`<key>HERDR_PLUGIN_CONFIG_DIR</key><string>${home}/.config/ovis</string>`);
    expect(plist).toContain(`<key>HERDR_PLUGIN_STATE_DIR</key><string>${home}/.local/state/ovis</string>`);
    expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
    expect(readFileSync(join(home, "calls"), "utf8")).toBe(`launchctl bootout gui/501/sh.ovis.server\nlaunchctl bootstrap gui/501 ${agent}\n`);
    expect(result.out).toContain("starts at login (launchd");
    if (Bun.which("plutil")) expect(Bun.spawnSync(["plutil", "-lint", agent]).exitCode).toBe(0);
  });
});

describe("install_core", () => {
  it("builds the app with herdr-plugin.toml's Linux/macOS build steps, the Rust PTY host aside", () => {
    const manifest = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
    const steps = [...manifest.matchAll(/\[\[build\]\]\ncommand = (\[.*\])\nplatforms = \["linux", "macos"\]/g)]
      .map((match) => (JSON.parse(match[1]!) as string[]).join(" "))
      .filter((step) => !step.includes("pty-sidecar"));
    expect(steps.length).toBeGreaterThan(0);
    expect(fn("install_core")).toContain(`(cd "$APP_DIR.new" && ${steps.join(" && ")})`);
  });
});
