import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh on a PC where herdr is not running (installed just now, or installed and stopped): it starts herdr's server
 * headless, so the app runs now, and on a PC used without a desktop a user service starts it again: on Linux only where
 * lingering is on, since without it logind ends the user's service manager, and herdr in it, with the last session.
 * It says what runs. The functions are cut
 * out of install.sh itself and run under /bin/sh with a HOME of their own and stand-in herdr, systemctl, loginctl,
 * launchctl and id, so nothing on this PC is started or registered. scripts/install-service-docker.ts runs the real
 * thing in a container with systemd.
 */

// a case runs install.sh's start on a few PCs, a second or so each, more under a busy check
setDefaultTimeout(60_000);
const ROOT = join(import.meta.dir, "..");
const INSTALLER = readFileSync(join(ROOT, "install.sh"), "utf8");
function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(INSTALLER) ?? new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const CONSTANTS = ["BIN_DIR", "OVIS_HOME", "HERDR_SERVICE", "HERDR_UNIT_DESCRIPTION", "HERDR_AGENT_LABEL"].map((name) => {
  const line = new RegExp(`^${name}=.*$`, "m").exec(INSTALLER)?.[0];
  if (!line) throw new Error(`install.sh sets no ${name}`);
  return line;
}).join("\n");
const FUNCTIONS = ["say", "fail", "link", "quoted", "xml_text", "unit_text", "herdr_running", "keep_lingering", "desktop_pc", "service_path", "utf8_locale", "herdr_unit_ours", "forget_herdr_unit", "unit_not_wanted", "start_herdr", "herdr_failed", "running_lines", "unit_gone_line", "mac_agent_line", "herdr_command", "stop_plugin_server"].map(fn).join("\n");

const dir = mkdtempSync(join(tmpdir(), "ovis-install-herdr-"));
afterAll(() => {
  // a stand-in herdr left running by a test that failed midway
  for (const file of readdirSync(dir).filter((name) => name.startsWith("home-")).map((home) => join(dir, home, "herdr.pid")).filter((file) => existsSync(file))) {
    try { process.kill(Number(readFileSync(file, "utf8")), "SIGKILL"); } catch {}
  }
  rmSync(dir, { recursive: true, force: true });
});

const SYSTEM = join(dir, "system");
mkdirSync(SYSTEM);
const own = new Set(["herdr", "systemctl", "loginctl", "launchctl", "id"]);
for (const from of ["/usr/bin", "/bin"].filter((system) => existsSync(system))) {
  for (const name of readdirSync(from)) {
    if (own.has(name) || !existsSync(join(from, name))) continue;
    own.add(name);
    symlinkSync(join(from, name), join(SYSTEM, name));
  }
}

/**
 * herdr as the installer sees it: `status server --json` answers from $HOME/up, and `server` comes up (or not, with
 * $HOME/broken) and stays, writing its pid where the test ends it, and a line on its output the installer must not carry.
 */
const HERDR = `case "$*" in
  "status server --json") if [ -e "$HOME/up" ]; then echo '{"running":true}'; else echo '{"running":false}'; fi ;;
  server)
    echo "herdr server $$" >> "$HOME/calls"
    [ ! -e "$HOME/broken" ] || { echo "herdr: broken" >&2; exit 1; }
    echo $$ > "$HOME/herdr.pid"
    echo "herdr server running"
    touch "$HOME/up"
    exec sleep 600 ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`;
const recorder = (name: string, body = "") => `echo "${name} $*" >> "$HOME/calls"\n${body}`;
/** systemctl --user as a user manager answers it; its restart starts the unit's herdr as systemd would */
const SYSTEMCTL = recorder("systemctl", `case "$*" in
  "--user restart ovis-herdr.service") [ -e "$HOME/systemd-refuses" ] && exit 1; "$HOME/tools/herdr" server >/dev/null 2>&1 </dev/null & ;;
  "--user is-active ovis-herdr.service") if [ -e "$HOME/unit-ran" ]; then echo active; else echo inactive; exit 3; fi ;;
  "is-enabled --quiet display-manager.service") [ -e "$HOME/display-manager" ] || exit 1 ;;
esac
exit 0`);

function pc(tools: Record<string, string> = {}): { home: string; bin: string; env: Record<string, string>; calls: () => string[]; stop: () => void } {
  const home = mkdtempSync(join(dir, "home-"));
  const bin = join(home, "tools");
  mkdirSync(bin);
  for (const [name, body] of Object.entries({ herdr: HERDR, ...tools })) writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const calls = () => existsSync(join(home, "calls")) ? readFileSync(join(home, "calls"), "utf8").trim().split("\n") : [];
  const stop = () => {
    if (!existsSync(join(home, "herdr.pid"))) return;
    try { process.kill(Number(readFileSync(join(home, "herdr.pid"), "utf8")), "SIGKILL"); } catch {}
  };
  return { home, bin, calls, stop, env: { HOME: home, PATH: `${bin}:${SYSTEM}`, XDG_CONFIG_HOME: "", TERM: "dumb" } };
}

function sh(call: string, env: Record<string, string>): { code: number; out: string; ms: number } {
  const started = performance.now();
  const run = Bun.spawnSync(["/bin/sh", "-c", `set -eu\n${CONSTANTS}\nterminal=0\n${FUNCTIONS}\n${call}`], { env, stdout: "pipe", stderr: "pipe", timeout: 40_000 });
  return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString(), ms: performance.now() - started };
}

const id = `case "$1" in -u) echo 501 ;; -un) echo alice ;; esac`;

/**
 * loginctl as logind answers it: Linger as given ("" for a read that fails), enable-linger allowed or refused, and a
 * graphical session only where the test made one ($HOME/graphical: Display; $HOME/x11-session: a session of Type x11).
 */
const logind = (linger: "yes" | "no" | "", enable = false) => recorder("loginctl", `case "$*" in
  "show-user "*" -p Linger --value") ${linger ? `echo ${linger}` : "exit 1"} ;;
  "show-user "*" -p Display --value") [ ! -e "$HOME/graphical" ] || echo c2 ;;
  "list-sessions --no-legend") echo "c1 1000 alice - pts/0 active no -"; [ ! -e "$HOME/x11-session" ] || echo "c3 1001 bob seat0 tty2 active no -" ;;
  "show-session c1 -p Type --value") echo tty ;;
  "show-session c3 -p Type --value") echo x11 ;;
  "--no-ask-password enable-linger "*) ${enable ? "exit 0" : "exit 1"} ;;
  disable-linger*) ;;
  *) exit 1 ;;
esac`);
const LINGERS = logind("yes");
const unitOf = (home: string) => join(home, ".config", "systemd", "user", "ovis-herdr.service");
const NOTE = (home: string) => join(home, ".local", "share", "ovis", "lingering");
/** an SSH login's session, which says it is no desktop's */
const SSH = { XDG_SESSION_TYPE: "tty" };

describe.skipIf(process.platform === "win32")("start_herdr on Linux, with a user systemd", () => {
  it("where lingering is on, registers ovis-herdr.service, which starts herdr and never stops it, enables it and starts it now", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: LINGERS, id });
    try {
      const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept lingering=$lingering"`, { ...linux.env, ...SSH });
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("kept=systemd lingering=on");
      expect(readFileSync(unitOf(linux.home), "utf8")).toBe(`[Unit]
Description=herdr for Ovis: herdr's server, headless, which starts Ovis

[Service]
Type=oneshot
RemainAfterExit=yes
KillMode=process
WorkingDirectory=~
Environment="PATH=${linux.env["PATH"]}:${linux.home}/.local/bin:${linux.home}/.bun/bin"
Environment="LC_CTYPE=C.UTF-8"
ExecStart=/bin/sh -c '"$$0" server </dev/null &' "${linux.bin}/herdr"

[Install]
WantedBy=default.target
`);
      expect(linux.calls().filter((call) => call.startsWith("systemctl"))).toEqual([
        "systemctl is-enabled --quiet display-manager.service", "systemctl --user show-environment", "systemctl --user daemon-reload", "systemctl --user enable ovis-herdr.service", "systemctl --user restart ovis-herdr.service",
      ]);
      // what herdr prints goes to the journal, never to the installer's own output
      expect(result.out).not.toContain("herdr server running");
    } finally { linux.stop(); }
  });

  it("gives the unit the user's PATH in its order, the installer's folders after it, and a UTF-8 locale and herdr session as the installer had them", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: LINGERS, id });
    try {
      const own = `${linux.bin}:${linux.home}/.local/bin:${SYSTEM}`;
      expect(sh(`os=linux; original_path='${own}'; start_herdr`, { ...linux.env, LANG: "ko_KR.UTF-8", HERDR_SESSION: "work" }).code).toBe(0);
      const unit = readFileSync(unitOf(linux.home), "utf8");
      expect(unit).toContain(`Environment="PATH=${own}:${linux.home}/.bun/bin"\n`);
      expect(unit).toContain('Environment="LC_CTYPE=ko_KR.UTF-8"\nEnvironment="LANG=ko_KR.UTF-8"\nEnvironment="HERDR_SESSION=work"\n');
    } finally { linux.stop(); }
    const plain = pc({ systemctl: SYSTEMCTL, loginctl: LINGERS, id });
    try {
      expect(sh("os=linux; start_herdr", { ...plain.env, LANG: "C", LC_CTYPE: "en_US.utf8" }).code).toBe(0);
      const unit = readFileSync(unitOf(plain.home), "utf8");
      expect(unit).toContain('Environment="LC_CTYPE=en_US.utf8"\n');
      expect(unit).not.toContain("LANG=");
    } finally { plain.stop(); }
  });

  it("writes the same unit byte for byte on a second run", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: LINGERS, id });
    try {
      expect(sh("os=linux; start_herdr", linux.env).code).toBe(0);
      const first = readFileSync(unitOf(linux.home), "utf8");
      linux.stop();
      rmSync(join(linux.home, "up"));
      expect(sh("os=linux; start_herdr", linux.env).code).toBe(0);
      expect(readFileSync(unitOf(linux.home), "utf8")).toBe(first);
      expect(readdirSync(join(linux.home, ".config", "systemd", "user"))).toEqual(["ovis-herdr.service"]);
    } finally { linux.stop(); }
  });

  it("turns lingering on where it is off and no password is asked, notes that it did, and then registers the unit", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: logind("no", true), id });
    try {
      const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept lingering=$lingering"`, linux.env);
      expect(result.out).toContain("kept=systemd lingering=turned-on");
      expect(linux.calls()).toContain("loginctl --no-ask-password enable-linger alice");
      expect(readFileSync(NOTE(linux.home), "utf8")).toBe("alice\n");
      expect(existsSync(unitOf(linux.home))).toBe(true);
    } finally { linux.stop(); }
  });

  // logind stops a user's service manager with the last session when lingering is off, and a unit's herdr with it
  it("where lingering stays off or cannot be read, writes no unit and starts herdr once in a session of its own, which outlives a logout", () => {
    for (const [loginctl, state] of [[logind("no"), "off"], [logind(""), "unknown"]] as const) {
      const linux = pc({ systemctl: SYSTEMCTL, loginctl, id });
      try {
        const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept lingering=$lingering"`, linux.env);
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain(`kept=linger-off lingering=${state}`);
        expect(existsSync(unitOf(linux.home))).toBe(false);
        expect(existsSync(NOTE(linux.home))).toBe(false);
        expect(linux.calls().filter((call) => call.startsWith("systemctl --user"))).toEqual(["systemctl --user show-environment"]);
        expect(linux.calls().filter((call) => call.startsWith("herdr server"))).toHaveLength(1);
        if (process.platform === "linux" && Bun.which("setsid")) {
          const pid = Number(readFileSync(join(linux.home, "herdr.pid"), "utf8"));
          expect(Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[3])).toBe(pid);
        }
      } finally { linux.stop(); }
    }
  });

  // what a desktop looks like from this login and from the machine; none of it touches lingering or writes a unit
  const DESKTOPS: [string, Record<string, string>, string, string][] = [
    ["a Wayland session", { XDG_SESSION_TYPE: "wayland" }, "", "a desktop session"],
    ["an X display with no session type", { WAYLAND_DISPLAY: "wayland-0" }, "", "a desktop session"],
    ["an SSH login into a PC with a display manager", SSH, "display-manager", "a display manager (a desktop's login screen)"],
    ["an SSH login of a user with a graphical session open", SSH, "graphical", "a graphical session of yours"],
    ["an SSH login into a PC where someone has an X session", SSH, "x11-session", "a graphical session"],
  ];
  for (const [what, environment, flag, found] of DESKTOPS) {
    it(`counts ${what} as a desktop: no unit, lingering untouched, herdr started once`, () => {
      const linux = pc({ systemctl: SYSTEMCTL, loginctl: logind("no", true), id });
      if (flag) writeFileSync(join(linux.home, flag), "");
      try {
        const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept found=$desktop_found"`, { ...linux.env, ...environment });
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain(`kept=desktop found=${found}`);
        expect(existsSync(unitOf(linux.home))).toBe(false);
        expect(linux.calls().filter((call) => /systemctl --user|enable-linger|-p Linger/.test(call))).toEqual([]);
        expect(linux.calls().filter((call) => call.startsWith("herdr server"))).toHaveLength(1);
      } finally { linux.stop(); }
    });
  }

  it("does not count X forwarded into an SSH login on a server as a desktop: the unit is written", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: LINGERS, id });
    try {
      const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept"`, { ...linux.env, XDG_SESSION_TYPE: "tty", DISPLAY: "localhost:10.0" });
      expect(result.out).toContain("kept=systemd");
      expect(existsSync(unitOf(linux.home))).toBe(true);
    } finally { linux.stop(); }
  });

  it("with --no-service sets up nothing and does not touch lingering: herdr starts once", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: logind("no", true), id });
    try {
      const result = sh(`os=linux; no_service=1; start_herdr; echo "kept=$herdr_kept"`, linux.env);
      expect(result.out).toContain("kept=declined");
      expect(existsSync(unitOf(linux.home))).toBe(false);
      expect(linux.calls().filter((call) => call.startsWith("systemctl") || call.startsWith("loginctl"))).toEqual([]);
      expect(linux.calls().filter((call) => call.startsWith("herdr server"))).toHaveLength(1);
    } finally { linux.stop(); }
  });

  /** a PC where an earlier run wrote the unit and turned lingering on, herdr stopped since */
  const earlier = (tools: Record<string, string> = {}) => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: logind("no", true), id, ...tools });
    expect(sh("os=linux; start_herdr", linux.env).code).toBe(0);
    expect(existsSync(unitOf(linux.home)) && existsSync(NOTE(linux.home))).toBe(true);
    linux.stop();
    rmSync(join(linux.home, "up"));
    return linux;
  };
  const setLogind = (linux: { bin: string }, body: string) => writeFileSync(join(linux.bin, "loginctl"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  // the unit an earlier run wrote is not wanted any more: removed, disabled, never stopped; anyone else's stays
  it("removes the unit an earlier run wrote where lingering is off now, --no-service is given, or this PC has a desktop, and stops nothing", () => {
    for (const [why, change, call, note] of [["linger-off", "lingering", "", false], ["declined", "", "no_service=1; ", true], ["desktop", "display-manager", "", true]] as const) {
      const linux = earlier();
      try {
        if (change === "lingering") setLogind(linux, logind("no"));
        else setLogind(linux, logind("yes"));
        if (change === "display-manager") writeFileSync(join(linux.home, "display-manager"), "");
        const before = linux.calls().length;
        const result = sh(`os=linux; ${call}start_herdr; echo "kept=$herdr_kept gone=$herdr_unit_gone"`, { ...linux.env, ...SSH });
        expect(result.code, result.out).toBe(0);
        expect(result.out).toContain(`kept=${why} gone=${why}`);
        expect(existsSync(unitOf(linux.home))).toBe(false);
        // the note goes only when lingering is off: otherwise it is still on, and the Uninstall turns it off
        expect(existsSync(NOTE(linux.home))).toBe(note);
        const calls = linux.calls().slice(before).filter((line) => line.startsWith("systemctl --user"));
        expect(calls.filter((line) => line !== "systemctl --user show-environment")).toEqual(["systemctl --user disable ovis-herdr.service", "systemctl --user daemon-reload"]);
      } finally { linux.stop(); }
    }
    const theirs = pc({ systemctl: SYSTEMCTL, loginctl: logind("no"), id });
    try {
      mkdirSync(join(theirs.home, ".config", "systemd", "user"), { recursive: true });
      writeFileSync(unitOf(theirs.home), "[Unit]\nDescription=my own herdr\n");
      expect(sh(`os=linux; start_herdr; echo "gone=[$herdr_unit_gone]"`, { ...theirs.env, herdr_unit_gone: "" }).out).toContain("gone=[]");
      expect(readFileSync(unitOf(theirs.home), "utf8")).toBe("[Unit]\nDescription=my own herdr\n");
    } finally { theirs.stop(); }
  });

  // after a reboot with lingering off, the unit starts herdr at the login the installer then runs in: herdr runs
  it("where herdr runs, removes the unit where none is wanted now, says when this herdr is the one it started without lingering, and stops nothing", () => {
    for (const [why, change, call, ran, doomed] of [["linger-off", "lingering", "", true, "1"], ["linger-off", "lingering", "", false, "0"], ["declined", "", "no_service=1; ", true, "0"], ["desktop", "graphical", "", true, "0"]] as const) {
      const linux = pc({ systemctl: SYSTEMCTL, loginctl: LINGERS, id });
      try {
        expect(sh("os=linux; start_herdr", { ...linux.env, ...SSH }).code).toBe(0);
        if (ran) writeFileSync(join(linux.home, "unit-ran"), "");
        if (change === "lingering") setLogind(linux, logind("no"));
        if (change === "graphical") writeFileSync(join(linux.home, "graphical"), "");
        const before = linux.calls().length;
        const result = sh(`os=linux; herdr_unit_gone=; herdr_doomed=0; ${call}unit_not_wanted; echo "gone=$herdr_unit_gone doomed=$herdr_doomed"`, { ...linux.env, ...SSH });
        expect(result.out).toContain(`gone=${why} doomed=${doomed}`);
        expect(existsSync(unitOf(linux.home))).toBe(false);
        const calls = linux.calls().slice(before);
        expect(calls.some((line) => / (stop|restart|kill)\b/.test(line) || line.includes("enable-linger"))).toBe(false);
        expect(() => process.kill(Number(readFileSync(join(linux.home, "herdr.pid"), "utf8")), 0)).not.toThrow();
      } finally { linux.stop(); }
    }
    const lingered = pc({ systemctl: SYSTEMCTL, loginctl: LINGERS, id });
    try {
      expect(sh("os=linux; start_herdr", lingered.env).code).toBe(0);
      expect(sh(`os=linux; herdr_unit_gone=; herdr_doomed=0; unit_not_wanted; echo "gone=[$herdr_unit_gone]"`, { ...lingered.env, ...SSH }).out).toContain("gone=[]");
      expect(existsSync(unitOf(lingered.home))).toBe(true);
    } finally { lingered.stop(); }
  });

  it("starts herdr once in the background where systemd does not take the unit, and says so", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: LINGERS, id });
    writeFileSync(join(linux.home, "systemd-refuses"), "");
    try {
      const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept"`, linux.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("systemd did not take");
      expect(result.out).toContain("kept=once");
      expect(linux.calls().filter((call) => call.startsWith("herdr server"))).toHaveLength(1);
    } finally { linux.stop(); }
  });
});

// the release's server of the binary before is stopped on an upgrade: only the plugin's own, never Ovis on herdr-core's
// or one started by hand, whose state dir (~/.local/state/ovis) `stop` would take without the plugin's
describe.skipIf(process.platform === "win32")("stop_plugin_server", () => {
  it("stops Ovis by the state dir herdr gives the plugin, and leaves the installer's environment as it was", () => {
    const { env } = pc({ id });
    const call = `PLUGIN=devswha.ovis; ovis_cli() { echo "$* dir=\${HERDR_PLUGIN_STATE_DIR:-none}"; }; stop_plugin_server; stop_plugin_server >/dev/null; echo "after=\${HERDR_PLUGIN_STATE_DIR:-none}"`;
    expect(sh(call, env).out).toBe("after=none\n");
    const shown = `PLUGIN=devswha.ovis; ovis_cli() { echo "$* dir=\${HERDR_PLUGIN_STATE_DIR:-none}" >&3; }; stop_plugin_server 3>&1; echo "after=\${HERDR_PLUGIN_STATE_DIR:-none}"`;
    expect(sh(shown, env).out).toBe(`stop dir=${env["HOME"]}/.local/state/herdr/plugins/devswha.ovis\nafter=none\n`);
    expect(sh(shown, { ...env, XDG_STATE_HOME: "/srv/state" }).out).toBe("stop dir=/srv/state/herdr/plugins/devswha.ovis\nafter=none\n");
  });
});

describe.skipIf(process.platform === "win32")("start_herdr without a service manager", () => {
  it("starts herdr in a session of its own, with its output away from the installer's, and ends while herdr runs on", () => {
    const linux = pc();
    try {
      const result = sh(`os=linux; start_herdr; echo "kept=$herdr_kept"`, linux.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("kept=once");
      expect(result.out).not.toContain("herdr server running");
      // the run ended while herdr runs on: herdr holds none of its output, which a script reads to its end
      expect(result.ms).toBeLessThan(15_000);
      const pid = Number(readFileSync(join(linux.home, "herdr.pid"), "utf8"));
      expect(() => process.kill(pid, 0)).not.toThrow();
      if (process.platform === "linux") expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(linux.home);
      if (Bun.which("setsid") && process.platform === "linux") {
        const session = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[3];
        expect(Number(session)).toBe(pid);
      }
    } finally { linux.stop(); }
  });

  it("says at once, not after its bound, when herdr does not come up, and where to see why", () => {
    const linux = pc();
    writeFileSync(join(linux.home, "broken"), "");
    const result = sh("os=linux; start_herdr || herdr_failed", linux.env);
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain(`herdr did not start, so neither did the app; to see why: run ${linux.bin}/herdr server`);
    expect(result.ms).toBeLessThan(10_000);
  });
});

describe.skipIf(process.platform === "win32")("start_herdr on macOS", () => {
  const plistOf = (home: string) => join(home, "Library", "LaunchAgents", "sh.ovis.herdr-server.plist");
  /** launchd that loads the agent (its RunAtLoad starts herdr), or answers that it is loaded already ($HOME/loaded) */
  const LAUNCHCTL = recorder("launchctl", `case "$1" in
  print) [ -e "$HOME/loaded" ] ;;
  bootstrap) [ -e "$HOME/no-gui" ] && exit 5; "$HOME/tools/herdr" server >/dev/null 2>&1 </dev/null & ;;
  kickstart) "$HOME/tools/herdr" server >/dev/null 2>&1 </dev/null & ;;
esac`);

  it("loads the Mac app's LaunchAgent, which runs herdr server at login and leaves the server herdr hands over running", () => {
    const mac = pc({ launchctl: LAUNCHCTL, id });
    try {
      const result = sh(`os=darwin; start_herdr; echo "kept=$herdr_kept"`, mac.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("kept=launchd");
      const plist = readFileSync(plistOf(mac.home), "utf8");
      expect(plist).toContain("<key>Label</key><string>sh.ovis.herdr-server</string>");
      expect(plist).toContain(`<key>ProgramArguments</key><array><string>${mac.bin}/herdr</string><string>server</string></array>`);
      expect(plist).toContain("<key>RunAtLoad</key><true/>");
      expect(plist).toContain("<key>AbandonProcessGroup</key><true/>");
      expect(plist).toContain("<key>LC_CTYPE</key><string>UTF-8</string>");
      expect(plist).toContain(`<key>WorkingDirectory</key><string>${mac.home}</string>`);
      expect(plist).toContain(`<key>StandardOutPath</key><string>${mac.home}/Library/Logs/Ovis/herdr-server.log</string>`);
      expect(mac.calls().filter((call) => call.startsWith("launchctl"))).toEqual([
        "launchctl enable gui/501/sh.ovis.herdr-server", "launchctl print gui/501/sh.ovis.herdr-server", `launchctl bootstrap gui/501 ${plistOf(mac.home)}`,
      ]);
      const lint = process.platform === "darwin" ? ["plutil", "-lint", plistOf(mac.home)] : ["python3", "-c", "import plistlib, sys; plistlib.load(open(sys.argv[1], 'rb'))", plistOf(mac.home)];
      if (Bun.which(lint[0]!)) expect(Bun.spawnSync(lint).exitCode).toBe(0);
    } finally { mac.stop(); }
  });

  it("kicks an agent that is loaded already and never boots one out: it may run herdr with the user's agents", () => {
    const mac = pc({ launchctl: LAUNCHCTL, id });
    writeFileSync(join(mac.home, "loaded"), "");
    try {
      expect(sh("os=darwin; start_herdr", mac.env).code).toBe(0);
      const calls = mac.calls().filter((call) => call.startsWith("launchctl"));
      expect(calls).toEqual(["launchctl enable gui/501/sh.ovis.herdr-server", "launchctl print gui/501/sh.ovis.herdr-server", "launchctl kickstart gui/501/sh.ovis.herdr-server"]);
      expect(calls.some((call) => call.includes("bootout"))).toBe(false);
    } finally { mac.stop(); }
  });

  it("with --no-service writes no agent and asks launchd nothing", () => {
    const mac = pc({ launchctl: LAUNCHCTL, id });
    try {
      const result = sh(`os=darwin; no_service=1; start_herdr; echo "kept=$herdr_kept"`, mac.env);
      expect(result.out).toContain("kept=declined");
      expect(existsSync(plistOf(mac.home))).toBe(false);
      expect(mac.calls().filter((call) => call.startsWith("launchctl"))).toEqual([]);
    } finally { mac.stop(); }
  });

  it("starts herdr in the background where there is no login at the screen, and leaves the agent for the next one", () => {
    const mac = pc({ launchctl: LAUNCHCTL, id });
    writeFileSync(join(mac.home, "no-gui"), "");
    try {
      const result = sh(`os=darwin; start_herdr; echo "kept=$herdr_kept"`, mac.env);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("kept=login");
      expect(existsSync(plistOf(mac.home))).toBe(true);
      expect(mac.calls().filter((call) => call.startsWith("herdr server"))).toHaveLength(1);
    } finally { mac.stop(); }
  });
});

describe.skipIf(process.platform === "win32")("running_lines", () => {
  const ovis = (running: boolean) => `ovis_cli() { ${running ? `echo "running http://127.0.0.1:7317 (pid 4242)"` : "echo stopped"}; }; ovis_command() { printf ovis; }; original_path=$PATH; herdr_bin=$(command -v herdr); runtime=herdr`;
  const lines = (state: string, tools: Record<string, string> = {}) => {
    const { env } = pc({ id, ...tools });
    return sh(`${ovis(true)}; ${state}; running_lines`, env).out;
  };
  const SEE = "Ovis: see them: ovis status, herdr status server. Stop Ovis: ovis stop (it starts again with herdr). Stop herdr and every terminal in it: herdr server stop\n";

  it("says where Ovis runs, what starts it again, how to see it and how to stop it", () => {
    const systemd = lines("herdr_kept=systemd; lingering=turned-on");
    expect(systemd).toBe([
      "Ovis: Ovis runs now at http://127.0.0.1:7317, in herdr, which the user service ovis-herdr starts whenever this PC starts, with nobody logged in\n",
      SEE,
      "Ovis: a herdr that stops or crashes is not started again until this PC starts again, or until this installer runs again\n",
      "Ovis: lingering is on for alice now, so herdr runs with nobody logged in; the guide's Uninstall turns it off again\n",
    ].join(""));
    const off = lines("herdr_kept=linger-off; lingering=off");
    expect(off).toContain("which was started in the background and keeps running after you log out. Nothing starts it after a restart: lingering is off for alice, and turning it on needs an administrator (sudo loginctl enable-linger alice); then run this installer again and herdr starts whenever this PC starts\n");
    expect(off).not.toContain("lingering is on");
    expect(lines("herdr_kept=desktop; lingering=; desktop_found='a graphical session of yours'")).toContain("which was started for now: this PC has a graphical session of yours, so after a restart herdr starts when you open it there, as before\n");
    expect(lines("herdr_kept=declined; lingering=")).toContain("which was started for now, with no service (--no-service): after a restart herdr starts when you open it\n");
    expect(lines("herdr_kept=once; lingering=")).toContain("which was started in the background: this PC has no user service manager, so after a restart run this installer again");
    const launchd = lines("herdr_kept=launchd; lingering=");
    expect(launchd).toContain("which launchd starts at your login (");
    expect(launchd).toContain("not started again until your next login");
    expect(lines("herdr_kept=linger-off; lingering=off; herdr_unit_gone=linger-off")).toContain("Ovis: removed the user service ovis-herdr an earlier run set up: lingering is off for alice now, so it would start herdr at each login inside your service manager, which ends herdr with that login\n");
    expect(lines("herdr_kept=declined; lingering=; herdr_unit_gone=declined")).toContain("Ovis: removed the user service ovis-herdr an earlier run set up, as --no-service asks: nothing starts herdr at boot now; herdr runs on until you stop it\n");
    expect(lines("herdr_kept=; lingering=; herdr_unit_gone=desktop; desktop_found='a graphical session of yours'")).toContain("Ovis: removed the user service ovis-herdr an earlier run set up: this PC has a graphical session of yours, and herdr started at boot would give its terminals no display; herdr runs on until you stop it\n");
    const doomed = lines("herdr_kept=; lingering=; herdr_unit_gone=linger-off; herdr_doomed=1");
    expect(doomed).toContain("Ovis: this herdr was started at this login by the user service ovis-herdr, inside your service manager, and lingering is off for alice: it ends when you log out, with every terminal in it. The installer removed that service. To have herdr outlive the logout, stop it (herdr server stop) and run this installer again; to have it start whenever this PC starts, an administrator turns lingering on (sudo loginctl enable-linger alice), then run this installer again\n");
    expect(doomed).not.toContain("removed the user service");
    expect(lines("herdr_kept=; lingering=; herdr_unit_gone=linger-off; herdr_doomed=0")).toContain("Ovis: removed the user service ovis-herdr an earlier run set up: lingering is off for alice now");
    // --no-service leaves a Mac's LaunchAgent, which the Mac app shares, and says how to remove it
    const { env, home } = pc({ id });
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "sh.ovis.herdr-server.plist"), "<plist/>");
    expect(sh(`${ovis(true)}; os=darwin; no_service=1; herdr_kept=declined; lingering=; running_lines`, env).out).toContain(`Ovis: the LaunchAgent sh.ovis.herdr-server is still there and starts herdr at your login: --no-service leaves it, since the Mac app sets up the same one. To have none: launchctl disable gui/501/sh.ovis.herdr-server; rm ${home}/Library/LaunchAgents/sh.ovis.herdr-server.plist\n`);
    expect(sh(`${ovis(true)}; os=darwin; no_service=0; herdr_kept=launchd; lingering=; running_lines`, env).out).not.toContain("is still there");
    // herdr ran before the install: nothing of it is the installer's to tell how to stop
    const before = lines("herdr_kept=; lingering=");
    expect(before).toBe("Ovis: Ovis runs now at http://127.0.0.1:7317, and starts whenever herdr does. See it: ovis status. Stop it: ovis stop\n");
  });

  it("says nothing of a server that does not run", () => {
    const { env } = pc({ id });
    expect(sh(`${ovis(false)}; herdr_kept=systemd; lingering=on; running_lines`, env).out).toBe("");
  });
});

describe.skipIf(process.platform === "win32")("the guide's Uninstall", () => {
  const guide = readFileSync(join(ROOT, "docs", "guide.md"), "utf8");
  const uninstall = guide.slice(guide.indexOf("### Uninstall"), guide.indexOf("## How Ovis fits with herdr"));
  const line = (word: string) => uninstall.split("\n").find((text) => text.includes(word) && !text.trimStart().startsWith("#")) ?? "";
  const paste = (text: string, env: Record<string, string>) => Bun.spawnSync(["/bin/sh", "-c", text], { env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });

  it("removes the service the installer made without stopping herdr, and turns lingering off only where the installer turned it on", () => {
    const linux = pc({ systemctl: SYSTEMCTL, loginctl: logind("no", true), id });
    try {
      expect(sh("os=linux; start_herdr", linux.env).code).toBe(0);
      const before = linux.calls().length;
      for (const word of ["ovis-herdr", "lingering"]) expect(paste(line(word), linux.env).exitCode, line(word)).toBe(0);
      const calls = linux.calls().slice(before);
      expect(calls).toContain("systemctl --user disable ovis-herdr");
      expect(calls.some((call) => / (stop|kill)\b/.test(call))).toBe(false);
      expect(calls).toContain("loginctl disable-linger");
      expect(existsSync(join(linux.home, ".config", "systemd", "user", "ovis-herdr.service"))).toBe(false);
      expect(existsSync(join(linux.home, ".local", "share", "ovis", "lingering"))).toBe(false);
      // herdr and its terminals run on
      expect(() => process.kill(Number(readFileSync(join(linux.home, "herdr.pid"), "utf8")), 0)).not.toThrow();
    } finally { linux.stop(); }
    const lingered = pc({ systemctl: SYSTEMCTL, loginctl: logind("yes"), id });
    try {
      expect(sh("os=linux; start_herdr", lingered.env).code).toBe(0);
      paste(line("lingering"), lingered.env);
      expect(lingered.calls().filter((call) => call.includes("disable-linger"))).toEqual([]);
    } finally { lingered.stop(); }
  });

  it("disables and removes the LaunchAgent on macOS without booting it out", () => {
    const mac = pc({ launchctl: recorder("launchctl"), id });
    mkdirSync(join(mac.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(mac.home, "Library", "LaunchAgents", "sh.ovis.herdr-server.plist"), "<plist/>");
    expect(paste(line("sh.ovis.herdr-server"), mac.env).exitCode).toBe(0);
    expect(mac.calls()).toEqual(["launchctl disable gui/501/sh.ovis.herdr-server"]);
    expect(existsSync(join(mac.home, "Library", "LaunchAgents", "sh.ovis.herdr-server.plist"))).toBe(false);
  });
});
