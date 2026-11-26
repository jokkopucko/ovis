import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh's Rust PTY host check and its architecture pick, as the script defines them: the functions are
 * cut out of install.sh itself and run under /bin/sh with stand-in hosts, curl and tar, so nothing is
 * downloaded or installed.
 */

const INSTALLER = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const FUNCTIONS = ["say", "sha256", "kill_tree", "bounded", "answers_usage", "rust_host_runs", "server_arch"].map(fn).join("\n");

const dir = mkdtempSync(join(tmpdir(), "ovis-install-node-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function script(name: string, body: string): string {
  const path = join(dir, `${crypto.randomUUID()}-${name}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function sh(call: string, env: Record<string, string> = {}): { code: number; out: string; ms: number } {
  const started = performance.now();
  const run = Bun.spawnSync(["/bin/sh", "-c", `set -eu\n${FUNCTIONS}\n${call}`], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString(), ms: performance.now() - started };
}

const USAGE = `if [ "$#" -eq 0 ]; then echo "pty-sidecar: usage: fixture" >&2; exit 2; fi`;

describe("bounded", () => {
  it("reports a command it timed out as failed, even one that exits 0 as its tree is killed", () => {
    // a host that forks and waits exits 0 once its child is killed, and can do so before its own kill comes:
    // here the tree's kill only tells the command to end, which it does with 0, as such a host would on a slow PC
    const result = sh(`fifo=$(mktemp -u); mkfifo "$fifo"
kill_tree() { echo end > "$fifo"; }
if bounded 1 sh -c 'read line < "$0"; exit 0' "$fifo"; then echo PASSED; else echo "TIMED OUT"; fi
rm -f "$fifo"`);
    expect(result.out).toContain("TIMED OUT");
    expect(result.ms).toBeLessThan(10_000);
  });

  it("passes on the status of a command that ends within its bound", () => {
    expect(sh(`if bounded 5 sh -c 'exit 0'; then echo PASSED; else echo FAILED; fi`).out).toContain("PASSED");
    expect(sh(`bounded 5 sh -c 'exit 3' || echo "STATUS $?"`).out).toContain("STATUS 3");
  });
});

describe("rust_host_runs", () => {
  it("passes a host that answers both legs of the check", () => {
    expect(sh(`rust_host_runs ${script("host", `${USAGE}\nexit 0`)} && echo RUNS`).out).toContain("RUNS");
  });

  it("gives up on a host that hangs on its pty leg, within its deadline", () => {
    const hung = sh(`if rust_host_runs ${script("hangs", `${USAGE}\nexec sleep 60`)}; then echo RUNS; else echo REFUSED; fi`);
    expect(hung.out).toContain("REFUSED");
    expect(hung.ms).toBeLessThan(10_000);
  });

  it("gives up on a host that hangs before it answers at all", () => {
    const hung = sh(`if rust_host_runs ${script("silent", "exec sleep 60")}; then echo RUNS; else echo REFUSED; fi`);
    expect(hung.out).toContain("REFUSED");
    expect(hung.ms).toBeLessThan(10_000);
  });

  it("kills what a hung host started, not only the host", () => {
    const tag = `ovis-probe-child-${crypto.randomUUID()}`;
    // no exec: the child's own command line (its path, with the tag) stays visible to pgrep while it lives
    const child = script(tag, "sleep 60");
    const forking = script("forks", `${USAGE}\n${child} & wait`);
    const hung = sh(`if rust_host_runs ${forking}; then echo RUNS; else echo REFUSED; fi`);
    expect(hung.out).toContain("REFUSED");
    expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.toString().trim()).toBe("");
  });

  it("kills what a hung host starts while its tree is being listed", () => {
    const tag = `ovis-probe-late-${crypto.randomUUID()}`;
    const files = mkdtempSync(join(dir, "late-"));
    const go = join(files, "go"), up = join(files, "up"), hostPid = join(files, "host-pid"), done = join(files, "done");
    for (const fifo of [go, up]) expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const realPs = Bun.which("ps")!;
    // the child says it runs, and stays (no exec: its path, with the tag, stays visible to pgrep)
    const child = script(tag, `echo up > '${up}'\nsleep 60`);
    // the host starts its child only when told to
    const host = script("late", `${USAGE}\necho $$ > '${hostPid}'\nread _ < '${go}'\n${child} & wait`);
    // a ps whose first listing (kill_tree's `ps -A`) is taken before the host, if it still runs, is told to start its
    // child, and is handed over once that child runs (or 5 s passed): a host that can still start one at that moment
    // would leave it out of the list
    const tools = join(files, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "ps"), `#!/bin/sh
listing=$(${realPs} "$@")
if [ "$1" = -A ] && [ ! -e '${done}' ] && [ -s '${hostPid}' ]; then
  : > '${done}'
  case $(${realPs} -o stat= -p "$(cat '${hostPid}')") in T*) ;; *) echo go > '${go}'; timeout 5 sh -c 'read _ < "$0"' '${up}' ;; esac
fi
printf '%s\\n' "$listing"
`, { mode: 0o755 });
    const hung = sh(`if rust_host_runs ${host}; then echo RUNS; else echo REFUSED; fi`, { PATH: `${tools}:${process.env["PATH"]}` });
    expect(hung.out).toContain("REFUSED");
    // the listing came while the host had written its pid: the gap was reached, not passed over by a slow setup
    expect(existsSync(done)).toBe(true);
    expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.toString().trim()).toBe("");
  });

  it("refuses another program and a missing file", () => {
    expect(sh(`rust_host_runs ${script("other", "exit 0")} || echo REFUSED`).out).toContain("REFUSED");
    expect(sh(`rust_host_runs ${join(dir, "absent")} || echo REFUSED`).out).toContain("REFUSED");
  });
});

describe("server_arch", () => {
  const after = (answer: string, uname = "x64") => {
    const bin = mkdtempSync(join(dir, "bun-"));
    writeFileSync(join(bin, "bun"), `#!/bin/sh\necho '${answer}'\n`, { mode: 0o755 });
    return sh(`server_arch\necho "$arch $platform"`, { PATH: `${bin}:/usr/bin:/bin`, arch: uname, os: "darwin", platform: `darwin-${uname}` }).out.trim();
  };

  it("takes the architecture of the Bun that runs the server over uname's, as from a Rosetta shell on an arm64 Mac (#2100 review)", () => {
    expect(after("arm64")).toBe("arm64 darwin-arm64");
    expect(after("x64", "x64")).toBe("x64 darwin-x64");
  });

  it("keeps uname's when Bun does not answer with one it knows", () => {
    expect(after("ia32")).toBe("x64 darwin-x64");
    expect(after("")).toBe("x64 darwin-x64");
    // a preload that prints a line before Bun's own answer (#2100 review)
    expect(after("arm64\nx64")).toBe("x64 darwin-x64");
  });

  it("reads Bun's answer without waiting for a child Bun left holding its output (#2100 review)", () => {
    const bin = mkdtempSync(join(dir, "bun-"));
    writeFileSync(join(bin, "bun"), "#!/bin/sh\necho arm64\nsleep 20 &\n", { mode: 0o755 });
    const result = sh(`server_arch\necho "$arch $platform"`, { PATH: `${bin}:/usr/bin:/bin`, arch: "x64", os: "darwin", platform: "darwin-x64" });
    expect(result.out.trim()).toBe("arm64 darwin-arm64");
    expect(result.ms).toBeLessThan(10_000);
  });
});
