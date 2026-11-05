import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh's last step, the GitHub star: the whole script, run as `curl … | sh` runs it, on a
 * PATH that holds only what it needs. herdr, node, curl and gh are stand-ins, so nothing is
 * installed, no herdr is touched, nothing is fetched, and no star is read or given.
 */

const ROOT = join(import.meta.dir, "..");
const MENTION = "a GitHub star helps other herdr users find it";
const QUESTION = "star it now with the GitHub account gh is signed in to? [y/N]";
const CTRL_C = "\x03";
/** the read install.sh asks its question with, which the bash stand-in recognises (see Pc.answerRead) */
const QUESTION_READ = "read -r -t 20";
/**
 * When a run of install.sh counts as hung: it ends in about a second alone, in many on a PC busy
 * with other checks, and 20 seconds later when its question waits out an answer. Each test waits
 * for the installer's own end (and for its question before typing), bounded by this.
 */
const RUN_ENDS_WITHIN_MS = 45_000;
// only a backstop, above the bound: what a test waits for is the installer, not a set time
setDefaultTimeout(RUN_ENDS_WITHIN_MS + 15_000);

/** Ends `child` once it has run RUN_ENDS_WITHIN_MS. The function it returns stops that clock and tells whether it ran out. */
function deadline(child: { kill: (signal?: NodeJS.Signals) => void }): () => boolean {
  let hung = false;
  const timer = setTimeout(() => { hung = true; child.kill("SIGKILL"); }, RUN_ENDS_WITHIN_MS);
  return () => { clearTimeout(timer); return hung; };
}
/** what the stand-in gh answers: the status line `gh api --include` prints, what it says on stderr, and its exit code */
type Gh = "starred" | "not" | "refuses" | "denied" | "upstream" | "signed-out" | "hangs" | "stubborn" | "lingering";
const STAND_INS: Record<string, string> = {
  herdr: `case "$*" in
  --version) echo "herdr 0.9.3" ;;
  "plugin list") [ ! -e "$SCRATCH/installed" ] || echo "devswha.ovis 0.0.0"; [ ! -e "$SCRATCH/legacy" ] || echo "devswha.herdr-web-ui 0.0.0" ;;
  "plugin list --json")
    printf '{"result":{"plugins":['
    [ ! -e "$SCRATCH/installed" ] || printf '{"plugin_id":"devswha.ovis","plugin_root":"%s"},' "$SCRATCH/plugin"
    [ ! -e "$SCRATCH/legacy" ] || printf '{"plugin_id":"devswha.herdr-web-ui","plugin_root":"%s"},' "$SCRATCH/legacy-plugin"
    printf '{"plugin_id":"someone.else","plugin_root":"/nowhere"}]}}\\n' ;;
  # under the id the ref's manifest names
  "plugin install "*)
    if [ "$(cat "$SCRATCH/ref-id" 2>/dev/null)" = devswha.herdr-web-ui ]; then
      : > "$SCRATCH/legacy"
      mkdir -p "$SCRATCH/legacy-plugin/scripts"
      cp "$SCRATCH/plugin/scripts/plugin.ts" "$SCRATCH/legacy-plugin/scripts/plugin.ts"
      echo "Installed devswha.herdr-web-ui"
    else
      : > "$SCRATCH/installed"; echo "Installed devswha.ovis"
    fi ;;
  "plugin config-dir "*) echo "$SCRATCH/herdr-config/$3" ;;
  "plugin uninstall devswha.herdr-web-ui") echo "$*" >> "$SCRATCH/herdr.calls"; rm "$SCRATCH/legacy" ;;
  "status server --json") if [ -e "$SCRATCH/running" ]; then echo '{"running":true}'; else echo '{"running":false}'; fi ;;
  "plugin action invoke "*) ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`,
  // a Node 22 for this PC: --version, and the probe install.sh's node_fits makes (version and architecture)
  node: `case "$1" in -p) case "$(uname -m)" in aarch64 | arm64) echo "22 arm64" ;; *) echo "22 x64" ;; esac ;; *) echo v22.0.0 ;; esac`,
  // only the manifest of the ref being installed: what its id is, or a network that blocks the host
  curl: `echo "$*" >> "$SCRATCH/curl.calls"
case "$*" in
  *" https://raw.githubusercontent.com/devswha/ovis/$OVIS_REF/herdr-plugin.toml")
    [ ! -e "$SCRATCH/manifest-blocked" ] || { echo "curl: (7) Failed to connect to raw.githubusercontent.com port 443" >&2; exit 7; }
    printf 'id = "%s"\\nname = "Ovis"\\n' "$(cat "$SCRATCH/ref-id" 2>/dev/null || echo devswha.ovis)" ;;
  *) echo "unexpected curl $*" >&2; exit 1 ;;
esac`,
  // a desktop's openers, which only write down what they were asked to open (renamed into place: a reader never sees half a line)
  "xdg-open": `echo "$*" > "$SCRATCH/open.tmp" && mv "$SCRATCH/open.tmp" "$SCRATCH/open.calls"`,
  open: `echo "$*" > "$SCRATCH/open.tmp" && mv "$SCRATCH/open.tmp" "$SCRATCH/open.calls"`,
  gh: `echo "$*" >> "$SCRATCH/gh.calls"
mode=$(cat "$SCRATCH/gh.mode")
# the gh that never answers leaves its pid, for the test to see it was ended rather than done
[ "$mode" != hangs ] || { echo $$ > "$SCRATCH/gh.pid"; exec sleep 60; }
[ "$mode" != stubborn ] || { echo $$ > "$SCRATCH/gh.pid"; trap '' TERM; exec sleep 60; }
# a child that keeps gh's output open after gh itself has answered and gone
[ "$mode" != lingering ] || { sleep 60 & echo $! > "$SCRATCH/gh-child.pid"; }
case "$*" in
  *"--method PUT"*) [ "$mode" != refuses ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }; exit 0 ;;
esac
case "$mode" in
  starred) printf 'HTTP/2.0 204 No Content\\n\\n' ;;
  not | refuses | lingering) printf 'HTTP/2.0 404 Not Found\\n\\n{"message":"Not Found"}\\n'; echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;
  denied) printf 'HTTP/2.0 403 Forbidden\\n\\n'; echo "gh: Resource not accessible by personal access token (HTTP 403)" >&2; exit 1 ;;
  upstream) printf 'HTTP/2.0 500 Internal Server Error\\n\\n'; echo "gh: upstream answered HTTP 404 (HTTP 500)" >&2; exit 1 ;;
  signed-out) echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4 ;;
esac`,
};

/**
 * One PC per test, since the tests run side by side: a home directory, and a PATH that holds only
 * what install.sh runs, so that a gh the real PC has is not on it.
 */
class Pc {
  readonly scratch = mkdtempSync(join(tmpdir(), "herdr-install-star-"));

  /** `perl: false`: a PC without perl, which the question needs to empty the typed-ahead input */
  constructor(gh?: Gh, options: { perl?: boolean } = {}) {
    pcs.push(this.scratch);
    const bin = join(this.scratch, "bin");
    mkdirSync(bin);
    mkdirSync(join(this.scratch, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(this.scratch, "plugin", "scripts", "plugin.ts"), `import { existsSync } from "node:fs";\nif (process.argv[2] === "phone") console.log("the phone step");\nif (process.argv[2] === "status" && existsSync(process.env.SCRATCH + "/running")) console.log("running http://127.0.0.1:7317 (pid 1234)");\n`);
    for (const tool of ["sh", "bash", "cat", "uname", "ldd", "grep", "git", "tar", "awk", "sed", "mktemp", "rm", "sleep", "perl", "mv", "mkdir", "cp"]) {
      if (tool === "perl" && options.perl === false) continue;
      const real = Bun.which(tool);
      if (!real) continue;
      if (tool !== "bash") { symlinkSync(real, join(bin, tool)); continue; }
      // Clock both ends beside the real read, independently of the parent's output delivery.
      writeFileSync(join(bin, "bash"), `#!/bin/sh
case "$*" in
  *"${QUESTION_READ}"*)
    perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'print clock_gettime(CLOCK_MONOTONIC) * 1000' > "$SCRATCH/read.started"
    '${real}' "$@"
    status=$?
    perl -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'print clock_gettime(CLOCK_MONOTONIC) * 1000' > "$SCRATCH/read.ended"
    echo "$status" > "$SCRATCH/read.status"
    exit "$status" ;;
esac
exec '${real}' "$@"
`);
      chmodSync(join(bin, "bash"), 0o755);
    }
    symlinkSync(process.execPath, join(bin, "bun"));
    for (const name of gh ? ["herdr", "node", "curl", "xdg-open", "open", "gh"] : ["herdr", "node", "curl", "xdg-open", "open"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${STAND_INS[name]!}\n`);
      chmodSync(join(bin, name), 0o755);
    }
    if (gh) writeFileSync(join(this.scratch, "gh.mode"), gh);
  }

  /** herdr is running, so the app starts and says where it is */
  running(): this { writeFileSync(join(this.scratch, "running"), ""); return this; }
  /** the plugin installed under its id from before the rename, with a token in its config */
  legacy(options: { stopFails?: boolean } = {}): this {
    writeFileSync(join(this.scratch, "legacy"), "");
    mkdirSync(join(this.scratch, "legacy-plugin", "scripts"), { recursive: true });
    writeFileSync(join(this.scratch, "legacy-plugin", "scripts", "plugin.ts"), options.stopFails
      ? `if (process.argv[2] === "stop") process.exit(1);\n`
      : `if (process.argv[2] === "stop") await Bun.write(process.env.SCRATCH + "/legacy-stopped", "");\n`);
    const config = join(this.scratch, "herdr-config", "devswha.herdr-web-ui");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "env"), "OVIS_TOKEN=kept-secret\n", { mode: 0o600 });
    return this;
  }
  /**
   * What the browser opener was asked to open, or null when it never was.
   */
  async opened(wait: boolean): Promise<string | null> {
    const calls = join(this.scratch, "open.calls");
    const readCalls = (): string | null => {
      if (!existsSync(calls)) return null;
      const value = readFileSync(calls, "utf8").trim();
      return value || null;
    };
    const existing = readCalls();
    // The script backgrounds the opener only when it opens.
    if (existing !== null || !wait) return existing;

    // polled, not watched: a PC busy with other checks can be out of inotify instances (EMFILE)
    for (const deadline = Date.now() + RUN_ENDS_WITHIN_MS; ;) {
      const value = readCalls();
      if (value !== null || Date.now() > deadline) return value;
      await Bun.sleep(25);
    }
  }
  /** the plugin id the manifest at the ref names, and herdr installs it under */
  refNames(id: string): this { writeFileSync(join(this.scratch, "ref-id"), id); return this; }
  /** raw.githubusercontent.com does not answer, while github.com (git, herdr) does */
  manifestBlocked(): this { writeFileSync(join(this.scratch, "manifest-blocked"), ""); return this; }
  /** the plugin is there already: this run is a rerun */
  installed(): this { writeFileSync(join(this.scratch, "installed"), ""); return this; }
  ghCalls(): string[] {
    const log = join(this.scratch, "gh.calls");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  }
  stars(): number { return this.ghCalls().filter((call) => call.includes("--method PUT")).length; }
  /** whether the process whose pid the stand-in gh left in `file` still runs */
  alive(file: "gh.pid" | "gh-child.pid"): boolean {
    const pid = Number(readFileSync(join(this.scratch, file), "utf8"));
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  /**
   * How the question's read ended, by its exit status: 0 an answer read, 1 the end of input, 142
   * (128 + SIGALRM) its 20 seconds ran out, 130 a Ctrl-C; null when it never ran or its shell was
   * ended before it could tell. Written before the installer goes on.
   */
  answerRead(): number | null {
    const file = join(this.scratch, "read.status");
    return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : null;
  }
  private environment(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: join(this.scratch, "bin"), HOME: this.scratch, SCRATCH: this.scratch, SHELL: "/bin/sh", TERM: "xterm", OVIS_REF: "v0.0.0", ...extra };
  }

  /** as a script or an agent runs it: the script on stdin, and no terminal */
  async unattended(extra?: Record<string, string>): Promise<{ out: string; exitCode: number }> {
    const child = Bun.spawn(["sh"], { cwd: this.scratch, env: this.environment(extra), stdin: Bun.file(join(ROOT, "install.sh")), stdout: "pipe", stderr: "pipe" });
    const ended = deadline(child);
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (ended()) throw new Error(`install.sh did not end within ${RUN_ENDS_WITHIN_MS} ms; it printed:\n${out + err}`);
    return { out: out + err, exitCode };
  }

  /**
   * At a terminal (script(1) gives one), the script on stdin as under `curl … | sh`. `typed` goes
   * to the terminal once the question is on it; without `typed` nobody is there. `typedAhead` is
   * typed as the install starts, long before the question. The wrapping shell survives Ctrl-C as
   * the user's own shell does, and reports the installer's exit code.
   */
  async atTerminal(typed: string | null, extra?: Record<string, string>, typedAhead?: string, background = false, observeAfterExit = false): Promise<{ out: string; exitCode: number; asked: boolean; readDuration: number | null }> {
    // a background job of a shell with job control: its own process group, not the terminal's foreground
    const install = background ? `bash -c 'set -m; (cat "${join(ROOT, "install.sh")}" | sh) & wait %1'` : `cat "${join(ROOT, "install.sh")}" | sh`;
    const command = `trap : INT; ${install}; echo "exit=$?"`;
    const child = Bun.spawn([Bun.which("script")!, "-qec", command, "/dev/null"], { cwd: this.scratch, env: this.environment(extra), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    let out = "";
    let answered = false;
    let again: ReturnType<typeof setInterval> | undefined;
    // The installer can end before what is typed reaches it (Ctrl-C is pressed until it lands). As
    // script(1) exits it closes its end of the pipe, and until it is reaped a write there throws
    // EPIPE: nobody is left to read the keys, and the test's own checks tell whether that was right.
    const type = (text: string) => {
      try {
        child.stdin.write(text);
        child.stdin.flush();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPIPE") throw error;
      }
    };
    const ended = deadline(child);
    if (typedAhead) type(typedAhead);
    const decoder = new TextDecoder();
    try {
      if (observeAfterExit) await child.exited;
      // the terminal's output ends with the installer (or when deadline() ends script(1))
      for await (const chunk of child.stdout) {
        out += decoder.decode(chunk, { stream: true });
        if (answered || typed === null || !out.includes(QUESTION)) continue;
        answered = true;
        type(typed);
        // The question is on the terminal a moment before the installer reads the answer. Typed text
        // waits in the terminal for that; Ctrl-C is a signal and does not, so it is pressed until it lands.
        if (typed === CTRL_C) again = setInterval(() => type(CTRL_C), 100);
      }
      await child.exited;
    } finally {
      clearInterval(again);
    }
    child.stdin.end();
    if (ended()) throw new Error(`install.sh did not end within ${RUN_ENDS_WITHIN_MS} ms at a terminal; it printed:\n${out}`);
    const readStarted = join(this.scratch, "read.started");
    const readEnded = join(this.scratch, "read.ended");
    const readDuration = existsSync(readStarted) && existsSync(readEnded)
      ? Number(readFileSync(readEnded, "utf8")) - Number(readFileSync(readStarted, "utf8")) : null;
    return { out, exitCode: Number(/exit=(\d+)/.exec(out)?.[1] ?? -1), asked: out.includes(QUESTION), readDuration };
  }
}
const pcs: string[] = [];
afterAll(() => { for (const scratch of pcs) rmSync(scratch, { recursive: true, force: true }); });

it("asks its question with the read the tests' bash stand-in records", () => {
  // otherwise every answered test would read a null status, with nothing to say why
  expect(readFileSync(join(ROOT, "install.sh"), "utf8")).toContain(`bash -c '${QUESTION_READ} answer </dev/tty`);
});

it("extracts only the URL from a PID-bearing Windows status line", () => {
  // Exercise the installer's actual pattern, whose regex syntax is shared by .NET and JavaScript.
  const installer = readFileSync(join(ROOT, "install.ps1"), "utf8");
  const assignment = installer.split("\n").find((line) => line.trimStart().startsWith("$origin = "));
  const pattern = /, '([^']+)'\)\.Groups\[1\]\.Value$/.exec(assignment ?? "")?.[1];
  if (pattern === undefined) throw new Error("Windows installer origin pattern not found");

  const origin = new RegExp(pattern).exec("running http://127.0.0.1:7317 (pid 1234)")?.[1];

  expect(origin).toBe("http://127.0.0.1:7317");
});

// install.sh is the Linux and macOS installer: Windows has install.ps1 and scripts/windows-install.test.ps1
describe.skipIf(platform() === "win32")("install.sh over an install under the old plugin id", () => {
  it.concurrent("stops it, brings its token to the new id and removes it", async () => {
    const pc = new Pc().legacy();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode, out).toBe(0);
    expect(out).toContain("Installed devswha.ovis");
    expect(existsSync(join(pc.scratch, "legacy-stopped"))).toBe(true);
    const moved = join(pc.scratch, "herdr-config", "devswha.ovis", "env");
    expect(readFileSync(moved, "utf8")).toBe("OVIS_TOKEN=kept-secret\n");
    expect(statSync(moved).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(pc.scratch, "herdr.calls"), "utf8")).toBe("plugin uninstall devswha.herdr-web-ui\n");
  });

  it.concurrent("moves nothing while the old id's server will not stop", async () => {
    // removed with its server still up, the old checkout would keep serving: the new start finds the port answering
    const pc = new Pc().legacy({ stopFails: true });
    const { out, exitCode } = await pc.unattended();
    expect(exitCode, out).not.toBe(0);
    expect(out).toContain("could not stop the server of the old id");
    expect(out).not.toContain("Installed devswha.ovis");
    expect(existsSync(join(pc.scratch, "herdr.calls"))).toBe(false);
    expect(existsSync(join(pc.scratch, "herdr-config", "devswha.ovis", "env"))).toBe(false);
  });
});

// releases up to 0.4.13 name the plugin by its old id, and installing one cannot move an install to the new one
describe.skipIf(platform() === "win32")("install.sh with a release from before the rename", () => {
  const LEGACY = "devswha.herdr-web-ui";
  const OLD_RELEASE = { OVIS_REF: "v0.4.13" };
  const manifest = "https://raw.githubusercontent.com/devswha/ovis/v0.4.13/herdr-plugin.toml";

  for (const blocked of [false, true]) {
    const how = blocked ? "by its version when its manifest cannot be read" : "by its manifest";
    it.concurrent(`installs it under the old id on a fresh PC, told ${how}`, async () => {
      const pc = new Pc().refNames(LEGACY);
      if (blocked) pc.manifestBlocked();
      const { out, exitCode } = await pc.unattended(OLD_RELEASE);
      expect(exitCode, out).toBe(0);
      expect(out).toContain("Installed devswha.herdr-web-ui");
      expect(readFileSync(join(pc.scratch, "curl.calls"), "utf8")).toContain(manifest);
      expect(existsSync(join(pc.scratch, "installed"))).toBe(false);
    });

    it.concurrent(`leaves an install under the old id running, told ${how}`, async () => {
      const pc = new Pc().legacy().refNames(LEGACY);
      if (blocked) pc.manifestBlocked();
      const { out, exitCode } = await pc.unattended(OLD_RELEASE);
      expect(exitCode, out).toBe(0);
      expect(out).toContain("already installed as a herdr plugin");
      expect(existsSync(join(pc.scratch, "legacy-stopped"))).toBe(false);
      expect(existsSync(join(pc.scratch, "herdr-config", "devswha.ovis", "env"))).toBe(false);
      expect(existsSync(join(pc.scratch, "herdr.calls"))).toBe(false);
      expect(existsSync(join(pc.scratch, "legacy"))).toBe(true);
    });
  }

  it.concurrent("moves an install under the old id to a release after the rename, told by its version", async () => {
    const pc = new Pc().legacy().manifestBlocked();
    const { out, exitCode } = await pc.unattended({ OVIS_REF: "v0.4.14" });
    expect(exitCode, out).toBe(0);
    expect(out).toContain("Installed devswha.ovis");
    expect(existsSync(join(pc.scratch, "legacy-stopped"))).toBe(true);
    expect(readFileSync(join(pc.scratch, "herdr.calls"), "utf8")).toBe("plugin uninstall devswha.herdr-web-ui\n");
  });

  it.concurrent("stops nothing for a branch whose manifest cannot be read", async () => {
    const pc = new Pc().legacy().manifestBlocked();
    const { out, exitCode } = await pc.unattended({ OVIS_REF: "main" });
    expect(exitCode, out).toBe(0);
    expect(out).toContain("could not read the plugin id at main");
    expect(existsSync(join(pc.scratch, "legacy-stopped"))).toBe(false);
    expect(existsSync(join(pc.scratch, "herdr.calls"))).toBe(false);
  });

  it.concurrent("finds the install of a branch whose manifest cannot be read under the old id it named", async () => {
    const pc = new Pc().refNames(LEGACY).manifestBlocked();
    const { out, exitCode } = await pc.unattended({ OVIS_REF: "old-branch" });
    expect(exitCode, out).toBe(0);
    expect(out).toContain("Installed devswha.herdr-web-ui");
  });
});

describe.skipIf(platform() === "win32")("install.sh without a terminal", () => {
  it.concurrent("mentions the star with a link when the PC has no gh", async () => {
    const { out, exitCode } = await new Pc().unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain("Installed devswha.ovis");
    expect(out).toContain(MENTION);
    expect(out).not.toContain(QUESTION);
    // the last thing said, so that a question after it can be left without losing a line
    expect(out.trimEnd().split("\n").at(-1)).toContain(MENTION);
  });

  it.concurrent("says nothing to an account that already starred", async () => {
    const pc = new Pc("starred");
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).not.toContain(MENTION);
    expect(pc.ghCalls()).toEqual(["api --hostname github.com --include user/starred/devswha/ovis"]);
  });

  it.concurrent("gives the link and asks nothing when the account has not starred", async () => {
    const pc = new Pc("not");
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(out).not.toContain(QUESTION);
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("stays quiet on a rerun, and does not ask gh", async () => {
    const pc = new Pc("not").installed();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain("already installed as a herdr plugin");
    expect(out).not.toContain(MENTION);
    expect(pc.ghCalls()).toEqual([]);
  });

  // gh sleeps 60 seconds: the installer ended within RUN_ENDS_WITHIN_MS, so it did not wait for gh, and gh is gone
  it.concurrent("goes on with the link when gh does not answer", async () => {
    const pc = new Pc("hangs");
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(pc.alive("gh.pid")).toBe(false);
  });

  it.concurrent("is not held by a child of gh that keeps its output open after gh answered", async () => {
    const pc = new Pc("lingering");
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    // the installer ended while that child still held gh's output
    expect(pc.alive("gh-child.pid")).toBe(true);
    process.kill(Number(readFileSync(join(pc.scratch, "gh-child.pid"), "utf8")));
  });

  it.concurrent("kills a gh that ignores TERM, and goes on with the link", async () => {
    const pc = new Pc("stubborn");
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    // 10 seconds for gh, then TERM, which it ignores, and KILL 2 seconds later: the installer waited for gh, and gh is gone long before its 60
    expect(pc.alive("gh.pid")).toBe(false);
  });
});

// the browser: opened once, after a first install, on a desktop that has someone at it
describe.skipIf(platform() === "win32")("install.sh and the browser", () => {
  it.concurrent("opens the app after a new install on a desktop", async () => {
    const pc = new Pc().running();
    const { out, exitCode } = await pc.unattended({ DISPLAY: ":0" });
    expect(exitCode).toBe(0);
    expect(out).toContain("opened http://127.0.0.1:7317 in your browser");
    expect(await pc.opened(true)).toBe("http://127.0.0.1:7317");
  });

  it.concurrent("does not open it again on a rerun", async () => {
    const pc = new Pc().running().installed();
    const { out, exitCode } = await pc.unattended({ DISPLAY: ":0" });
    expect(exitCode).toBe(0);
    expect(out).not.toContain("in your browser");
    expect(await pc.opened(false)).toBeNull();
  });

  it.concurrent("over SSH opens nothing and gives the tunnel", async () => {
    const pc = new Pc().running();
    const { out, exitCode } = await pc.unattended({ DISPLAY: ":0", SSH_CONNECTION: "10.0.0.2 50000 10.0.0.3 22" });
    expect(exitCode).toBe(0);
    expect(out).toContain("ssh -L 7317:127.0.0.1:7317");
    expect(await pc.opened(false)).toBeNull();
  });

  for (const [name, env] of [["OVIS_NO_OPEN", { OVIS_NO_OPEN: "1" }], ["CI", { CI: "1" }]] as const) {
    it.concurrent(`opens nothing with ${name} set, and says where the app is`, async () => {
      const pc = new Pc().running();
      const { out, exitCode } = await pc.unattended({ DISPLAY: ":0", ...env });
      expect(exitCode).toBe(0);
      expect(out).toContain("open http://127.0.0.1:7317 in your browser");
      expect(await pc.opened(false)).toBeNull();
    });
  }

  it.concurrent("opens nothing on a PC with no display and no BROWSER", async () => {
    const pc = new Pc().running();
    const { out, exitCode } = await pc.unattended();
    expect(exitCode).toBe(0);
    expect(out).toContain("open http://127.0.0.1:7317 in your browser");
    expect(await pc.opened(false)).toBeNull();
  });

  it.concurrent("opens nothing, and says nothing of it, when the app is not running", async () => {
    const pc = new Pc();
    const { out, exitCode } = await pc.unattended({ DISPLAY: ":0" });
    expect(exitCode).toBe(0);
    expect(out).not.toContain("in your browser");
    expect(await pc.opened(false)).toBeNull();
  });
});

// script(1) as util-linux has it; macOS's takes other arguments
describe.skipIf(platform() !== "linux" || !Bun.which("script"))("install.sh at a terminal", () => {
  it.concurrent("stars once on y", async () => {
    const pc = new Pc("not");
    const { out, exitCode } = await pc.atTerminal("y\n");
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(out).toContain("starred. Thank you!");
    expect(pc.stars()).toBe(1);
  });

  // the read's status tells the answer apart from the 20 seconds running out, which stars nothing either
  for (const [name, typed, read] of [["Enter alone", "\n", 0], ["n", "n\n", 0], ["anything but y or yes", "yy\n", 0], ["the end of input", "\x04", 1]] as const) {
    it.concurrent(`does not star on ${name}`, async () => {
      const pc = new Pc("not");
      const { asked, exitCode } = await pc.atTerminal(typed);
      expect(asked).toBe(true);
      expect(exitCode).toBe(0);
      expect(pc.answerRead()).toBe(read);
      expect(pc.stars()).toBe(0);
    });
  }

  it.concurrent("does not take what was typed before the question for its answer", async () => {
    const pc = new Pc("not");
    const { asked, exitCode } = await pc.atTerminal("\n", {}, "y\n");
    expect(asked).toBe(true);
    expect(exitCode).toBe(0);
    // the Enter typed after the question was read, not the y before it
    expect(pc.answerRead()).toBe(0);
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("asks nothing where what was typed before cannot be discarded: a PC without perl, y typed ahead", async () => {
    const pc = new Pc("not", { perl: false });
    const { out, asked, exitCode } = await pc.atTerminal(null, {}, "y\n");
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(asked).toBe(false);
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("asks nothing from a background job, which the terminal would stop for reaching it", async () => {
    const pc = new Pc("not");
    const { out, asked, exitCode } = await pc.atTerminal(null, {}, undefined, true);
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(asked).toBe(false);
    // nor did it wait on the terminal without asking
    expect(pc.answerRead()).toBeNull();
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("ends well, with no star, when the question is left with Ctrl-C", async () => {
    const pc = new Pc("not");
    const { asked, exitCode } = await pc.atTerminal(CTRL_C);
    expect(asked).toBe(true);
    expect(exitCode).toBe(0);
    // Ctrl-C ended the read (130, SIGINT) or the shell around it first (no status); a question that
    // only ran out its 20 seconds, as when the Ctrl-C never reached the installer, records 142
    expect([null, 130]).toContain(pc.answerRead());
    expect(pc.stars()).toBe(0);
  });

  it.concurrent("says so when gh refuses the star", async () => {
    const pc = new Pc("refuses");
    const { out, exitCode } = await pc.atTerminal("yes\n");
    expect(exitCode).toBe(0);
    expect(out).toContain("gh could not star it");
  });

  // only GitHub's own "not starred" is a reason to ask: its text in another failure is not
  for (const mode of ["denied", "upstream", "signed-out"] as const) {
    it.concurrent(`asks nothing when gh's answer is ${mode}`, async () => {
      const pc = new Pc(mode);
      const { out, asked, exitCode } = await pc.atTerminal(null);
      expect(exitCode).toBe(0);
      expect(out).toContain(MENTION);
      expect(asked).toBe(false);
    });
  }

  it.concurrent("asks nothing in CI, terminal or not", async () => {
    const pc = new Pc("not");
    const { out, asked, exitCode } = await pc.atTerminal(null, { CI: "true" });
    expect(exitCode).toBe(0);
    expect(out).toContain(MENTION);
    expect(asked).toBe(false);
  });

  for (const observeAfterExit of [false, true]) it.concurrent(`goes on by itself when nobody is at the terminal${observeAfterExit ? ", even when its output is read after it exits" : ""}`, async () => {
    const pc = new Pc("not");
    const started = Date.now();
    const { asked, readDuration, exitCode } = await pc.atTerminal(null, {}, undefined, false, observeAfterExit);
    const ended = Date.now();
    expect(asked).toBe(true);
    expect(exitCode).toBe(0);
    expect(pc.answerRead()).toBeGreaterThan(128);
    expect(pc.stars()).toBe(0);
    // Measure the child's read, not when this process got around to receiving its output.
    expect(readDuration).not.toBeNull();
    expect(readDuration!).toBeGreaterThanOrEqual(19_000);
    expect(readDuration!).toBeLessThan(27_000);
    expect(ended - started).toBeLessThan(40_000);
  });
});
