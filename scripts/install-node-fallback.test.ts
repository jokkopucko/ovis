import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * install.sh's Rust PTY host check and its Node fallback, as the script defines them: the functions are
 * cut out of install.sh itself and run under /bin/sh with stand-in hosts, curl and tar, so nothing is
 * downloaded or installed.
 */

const INSTALLER = readFileSync(join(import.meta.dir, "..", "install.sh"), "utf8");
/** one top-level shell function from install.sh, by name, as written there */
function fn(name: string): string {
  const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}$`, "m").exec(INSTALLER);
  if (!match) throw new Error(`install.sh defines no ${name}()`);
  return match[0];
}
const FUNCTIONS = ["say", "sha256", "kill_tree", "bounded", "rust_host_runs", "install_node", "server_arch", "node_fits", "node_link"].map(fn).join("\n");
/** main()'s choice of whether to install Node, as written there: from `needs_node=""` to its node_link call */
const NODE_DECISION = /^ {2}needs_node=""[\s\S]*?^ {2}node_link "\$code" "\$needs_node"$/m.exec(INSTALLER)?.[0] ?? "";

const dir = mkdtempSync(join(tmpdir(), "ovis-install-node-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function script(name: string, body: string): string {
  const path = join(dir, `${crypto.randomUUID()}-${name}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** runs `call` after install.sh's functions under /bin/sh with `set -eu`, as the script runs */
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
    // the watcher kills the tree before rust_host_runs returns
    expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.toString().trim()).toBe("");
  });

  it("refuses another program and a missing file", () => {
    expect(sh(`rust_host_runs ${script("other", "exit 0")} || echo REFUSED`).out).toContain("REFUSED");
    expect(sh(`rust_host_runs ${join(dir, "absent")} || echo REFUSED`).out).toContain("REFUSED");
  });
});

describe("install_node", () => {
  /** a PC for one install: stand-in curl and tar on PATH, and where Node would go */
  function pc(curl: string, tar: string): Record<string, string> {
    const root = mkdtempSync(join(dir, "pc-"));
    const bin = join(root, "tools");
    mkdirSync(bin);
    writeFileSync(join(bin, "curl"), `#!/bin/sh\n${curl}\n`, { mode: 0o755 });
    writeFileSync(join(bin, "tar"), `#!/bin/sh\n${tar}\n`, { mode: 0o755 });
    return { PATH: `${bin}:${process.env["PATH"]}`, NODE_DIR: join(root, "node"), BIN_DIR: join(root, "bin"), NODE_VERSION: "v22.23.2", platform: "linux-x64" };
  }
  /** curl that writes `body` to its -o file */
  const download = (body: string) => `while [ "$#" -gt 0 ]; do [ "$1" = -o ] && { printf '%s' '${body}' > "$2"; exit 0; }; shift; done; exit 1`;
  /** install_node as install.sh runs it, a subshell in a condition, where set -e does nothing */
  const attempt = (env: Record<string, string>) => sh(`if ( install_node ); then echo INSTALLED; else echo FAILED; fi`, env);

  it("fails when tar fails, and leaves no half-made Node behind", () => {
    // a platform install_node has no digest for keeps the node_sha given here: the download passes its check, tar fails
    const env = { ...pc(download("x"), "exit 42"), platform: "fixture", node_sha: new Bun.CryptoHasher("sha256").update("x").digest("hex") };
    const result = attempt(env);
    expect(result.out).toContain("FAILED");
    expect(existsSync(env["NODE_DIR"]!)).toBe(false);
  });

  it("keeps an existing install when the new unpack fails", () => {
    const env = { ...pc(download("x"), `mkdir -p "$4/bin" && : > "$4/bin/node"; exit 42`), platform: "fixture", node_sha: new Bun.CryptoHasher("sha256").update("x").digest("hex") };
    const nodeDir = env["NODE_DIR"]!;
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    writeFileSync(join(nodeDir, "bin", "node"), "old node");
    expect(attempt(env).out).toContain("FAILED");
    expect(readFileSync(join(nodeDir, "bin", "node"), "utf8")).toBe("old node");
  });

  it("installs when every step succeeds, and puts no node on the user's PATH (#596)", () => {
    const env = { ...pc(download("x"), `mkdir -p "$4/bin" && : > "$4/bin/node" && chmod +x "$4/bin/node"`), platform: "fixture", node_sha: new Bun.CryptoHasher("sha256").update("x").digest("hex") };
    expect(attempt(env).out).toContain("INSTALLED");
    expect(existsSync(join(env["NODE_DIR"]!, "bin", "node"))).toBe(true);
    expect(existsSync(env["BIN_DIR"]!)).toBe(false);
  });

  it("fails when the download fails", () => {
    expect(attempt(pc("exit 22", "exit 0")).out).toContain("FAILED");
  });

  it("fails when the download does not match its SHA-256", () => {
    const result = attempt(pc(download("not node"), "exit 0"));
    expect(result.out).toContain("FAILED");
    expect(result.out).toContain("does not match its published SHA-256");
  });
});

describe("node_fits", () => {
  /** whether install.sh takes the node first on PATH, one that answers the probe with `answer`, on a PC of `arch` */
  const fits = (answer: string, arch = "arm64") => {
    const bin = mkdtempSync(join(dir, "fits-"));
    writeFileSync(join(bin, "node"), `#!/bin/sh\necho '${answer}'\n`, { mode: 0o755 });
    return sh(`if node_fits node; then echo FITS; else echo NO; fi`, { PATH: `${bin}:/usr/bin:/bin`, arch }).out.trim();
  };

  it("takes Node 18 or newer built for this PC", () => {
    expect(fits("22 arm64")).toBe("FITS");
    expect(fits("18 x64", "x64")).toBe("FITS");
  });

  it("refuses an older Node, Bun, a Node of another architecture and a node that does not answer", () => {
    expect(fits("16 arm64")).toBe("NO");
    expect(fits("bun arm64")).toBe("NO");
    // an x64 Node from a Rosetta shell on an arm64 Mac, which the server's node-pty cannot load (#2100 review)
    expect(fits("22 x64")).toBe("NO");
    expect(fits("")).toBe("NO");
    // a preload's line before the real answer, an x64 Node's on an arm64 PC: never the preload's line alone (#2100 review)
    expect(fits("22 arm64\n24 x64")).toBe("NO");
    expect(fits("preload says hi\n22 arm64")).toBe("NO");
    expect(sh(`if node_fits /nonexistent/node; then echo FITS; else echo NO; fi`, { arch: "arm64" }).out.trim()).toBe("NO");
  });

  it("gives up on a node that answers and then keeps running, within its bound (#2100 review: a NODE_OPTIONS preload)", () => {
    const bin = mkdtempSync(join(dir, "fits-"));
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho '22 arm64'\nexec sleep 60\n", { mode: 0o755 });
    const result = sh(`if node_fits ${join(bin, "node")}; then echo FITS; else echo NO; fi`, { arch: "arm64" });
    expect(result.out.trim()).toBe("NO");
    expect(result.ms).toBeLessThan(10_000);
  });

  it("reads the answer of a node that exits but leaves a child holding its output, without waiting for that child", () => {
    const bin = mkdtempSync(join(dir, "fits-"));
    // the child keeps the output open for 20 s: a $( ) capture would wait for it, past the probe's bound
    writeFileSync(join(bin, "node"), "#!/bin/sh\necho '22 arm64'\nsleep 20 &\n", { mode: 0o755 });
    const result = sh(`if node_fits ${join(bin, "node")}; then echo FITS; else echo NO; fi`, { arch: "arm64" });
    expect(result.out.trim()).toBe("FITS");
    expect(result.ms).toBeLessThan(10_000);
  });

  it("asks a real Node the same way", () => {
    const real = Bun.which("node");
    if (real === null) throw new Error("this test needs Node");
    // what this node itself says, not this Bun's own process.versions
    const [version, arch] = Bun.spawnSync([real, "-p", "process.versions.node + ' ' + process.arch"]).stdout.toString().trim().split(" ");
    expect(sh(`if node_fits ${real}; then echo FITS; else echo NO; fi`, { arch: arch! }).out.trim()).toBe(Number(version!.split(".")[0]) >= 18 ? "FITS" : "NO");
  });
});

describe("server_arch", () => {
  /** arch and platform after server_arch, on a PC whose uname said `uname`, with a bun answering `answer` */
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

describe("main's choice to install Node", () => {
  /** runs that choice with the Rust host refused, the app's Node and the user's PATH node answering as given; true when it downloads */
  const downloads = (app: string | null, user: string | null) => {
    const root = mkdtempSync(join(dir, "choice-"));
    const nodeDir = join(root, "share/ovis/node");
    const userBin = join(root, "user-bin");
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    mkdirSync(userBin);
    if (app !== null) writeFileSync(join(nodeDir, "bin/node"), `#!/bin/sh\necho '${app}'\n`, { mode: 0o755 });
    if (user !== null) writeFileSync(join(userBin, "node"), `#!/bin/sh\necho '${user}'\n`, { mode: 0o755 });
    const run = sh(`rust_host_runs() { return 1; }\ninstall_node() { echo DOWNLOADED; }\nnode_link() { :; }\n${NODE_DECISION}`, {
      PATH: `${userBin}:/usr/bin:/bin`, NODE_DIR: nodeDir, LEGACY_NODE_DIR: join(root, "share/herdr-web-ui/node"), BIN_DIR: join(root, "bin"), code: root, arch: "arm64" });
    expect(run.code).toBe(0);
    return run.out.includes("DOWNLOADED");
  };

  it("keeps the app's own Node when it fits, whatever node the PATH has first (#2100 review)", () => {
    expect(NODE_DECISION).not.toBe("");
    expect(downloads("22 arm64", "22 x64")).toBe(false);
    expect(downloads("22 arm64", null)).toBe(false);
  });

  it("takes the PATH's node when the app has none that fits, and downloads only when neither does", () => {
    expect(downloads(null, "20 arm64")).toBe(false);
    expect(downloads("22 x64", "20 arm64")).toBe(false);
    expect(downloads("22 x64", "16 arm64")).toBe(true);
    expect(downloads(null, null)).toBe(true);
  });
});

describe("node_link", () => {
  /**
   * a PC whose ~/.local/bin/node is `bin`, our Node in `ours` (NODE_DIR, or LEGACY_NODE_DIR from before the rename), the
   * user's own PATH holding a node answering `user` (none when unset), and the running code: one that finds the app's
   * Node itself (`finds`), or an older one
   */
  function pc(finds: boolean, bin?: (env: Record<string, string>) => void, ours = "NODE_DIR", user?: string): Record<string, string> {
    const root = mkdtempSync(join(dir, "link-"));
    const userPath = join(root, "user-path");
    mkdirSync(userPath);
    if (user !== undefined) writeFileSync(join(userPath, "node"), `#!/bin/sh\necho ${user}\n`, { mode: 0o755 });
    // node_link probes only Node on original_path: do not let the real PC's /usr/bin/node fill an absent fixture.
    const env: Record<string, string> = { NODE_DIR: join(root, "share/ovis/node"), LEGACY_NODE_DIR: join(root, "share/herdr-web-ui/node"), BIN_DIR: join(root, "bin"), CODE: join(root, "code"), installed_here: "", original_path: userPath };
    mkdirSync(join(env["CODE"]!, "server/pty"), { recursive: true });
    // as the release's server/pty/sidecar.ts names the app's Node, or before it did
    writeFileSync(join(env["CODE"]!, "server/pty/sidecar.ts"), finds ? 'const APP_NODE_DIRS = [".local/share/ovis/node"];' : 'Bun.which("node")');
    mkdirSync(join(env[ours]!, "bin"), { recursive: true });
    writeFileSync(join(env[ours]!, "bin/node"), "app node", { mode: 0o755 });
    mkdirSync(env["BIN_DIR"]!);
    bin?.(env);
    return env;
  }
  const link = (env: Record<string, string>, args = "") => sh(`node_link "$CODE" ${args}\necho "[$installed_here]"`, env);
  const node = (env: Record<string, string>) => join(env["BIN_DIR"]!, "node");

  it("removes the link an older install.sh made, to its Node or to the one from before the rename", () => {
    for (const target of ["NODE_DIR", "LEGACY_NODE_DIR"]) {
      const env = pc(true, (e) => symlinkSync(join(e[target]!, "bin/node"), node(e)));
      const result = link(env);
      expect(result.code).toBe(0);
      expect(lstatSync(node(env), { throwIfNoEntry: false })).toBeUndefined();
      // never silently: it may have been the user's only node
      expect(result.out).toContain(`Ovis: removed ${node(env)}`);
    }
  });

  it("takes this checkout's own server for one that finds the app's Node itself", () => {
    // the real server/pty/sidecar.ts, not a stand-in: a server that stops naming the app's Node must fail here
    const env = { ...pc(true, (e) => symlinkSync(join(e["NODE_DIR"]!, "bin/node"), node(e))), CODE: join(import.meta.dir, "..") };
    expect(link(env).code).toBe(0);
    expect(lstatSync(node(env), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("keeps a node of the user's own there, a link elsewhere or a file", () => {
    const linked = pc(true, (e) => symlinkSync("/usr/bin/env", node(e)));
    const kept = link(linked);
    expect(kept.code).toBe(0);
    expect(kept.out).not.toContain("removed");
    expect(Bun.spawnSync(["readlink", node(linked)]).stdout.toString().trim()).toBe("/usr/bin/env");
    const file = pc(true, (e) => writeFileSync(node(e), "user node"));
    expect(link(file).code).toBe(0);
    expect(readFileSync(node(file), "utf8")).toBe("user node");
  });

  it("links no Node for a release that finds it itself, even one that needs Node", () => {
    const env = pc(true);
    expect(link(env, "needed").out).toContain("[]");
    expect(existsSync(node(env))).toBe(false);
  });

  it("links our Node for a release that finds Node on the PATH only, when it needs one", () => {
    const untouched = pc(false);
    expect(link(untouched).out).toContain("[]");
    expect(existsSync(node(untouched))).toBe(false);
    const needed = pc(false);
    expect(link(needed, "needed").out).toContain("[ node]");
    expect(readFileSync(node(needed), "utf8")).toBe("app node");
  });

  it("links the Node from before the rename back for such a release, and over a user's Node older than 18", () => {
    // the link was removed, and nothing new was downloaded: our Node from before the rename already answered (#596 review)
    const legacy = pc(false, undefined, "LEGACY_NODE_DIR", "v10.24.1");
    expect(link(legacy, "needed").out).toContain("[ node]");
    expect(Bun.spawnSync(["readlink", node(legacy)]).stdout.toString().trim()).toBe(join(legacy["LEGACY_NODE_DIR"]!, "bin/node"));
  });

  it("links nothing for such a release over a Node 18 or newer of the user's own", () => {
    const env = pc(false, undefined, "NODE_DIR", "v20.11.0");
    expect(link(env, "needed").out).toContain("[]");
    expect(existsSync(node(env))).toBe(false);
  });

  it("links the Node it installed after herdr's build found none, whatever Node the user's own PATH has", () => {
    // herdr started outside the user's shell (nvm in .bashrc) has none on its PATH, and the build retries on the link (#596 review)
    const env = pc(false, undefined, "NODE_DIR", "v20.11.0");
    expect(link(env, "installed").out).toContain("[ node]");
    expect(readFileSync(node(env), "utf8")).toBe("app node");
  });

  it("survives a user PATH without sed or node under set -eu", () => {
    const env = { ...pc(false), original_path: "" };
    const result = link(env, "needed");
    expect(result.code).toBe(0);
    expect(result.out).toContain("[ node]");
  });
});
