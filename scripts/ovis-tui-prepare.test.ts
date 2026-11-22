import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREPARE = join(import.meta.dir, "..", "crates", "ovis-tui", "prepare.sh");

let scratch = "";

/** git with a fixed identity, local submodules allowed, and none of the user's config */
function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", "-C", cwd, ...args], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, GIT_CONFIG_NOSYSTEM: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

function crate(patches = 0): { dir: string; upstream: string } {
  const ghostty = join(scratch, "ghostty");
  mkdirSync(ghostty);
  git(ghostty, "init", "--quiet");
  writeFileSync(join(ghostty, "build.zig"), "// stand-in\n");
  writeFileSync(join(ghostty, ".gitignore"), "/zig-pkg/\n");
  git(ghostty, "add", "-A");
  git(ghostty, "commit", "--quiet", "-m", "ghostty");
  const hc = join(scratch, "hc-tui");
  mkdirSync(hc);
  git(hc, "init", "--quiet");
  writeFileSync(join(hc, "README.md"), "hc-tui\n");
  writeFileSync(join(hc, ".gitignore"), "/target/\n*.local\n");
  git(hc, "add", "-A");
  git(hc, "submodule", "--quiet", "add", ghostty, "vendor/ghostty");
  git(hc, "commit", "--quiet", "-m", "hc-tui");
  const dir = join(scratch, "crate");
  mkdirSync(join(dir, "patches"), { recursive: true });
  copyFileSync(PREPARE, join(dir, "prepare.sh"));
  writeFileSync(join(dir, "hc-tui.pin"), `HC_TUI_REPO=${hc}\nHC_TUI_TAG=v0\nHC_TUI_COMMIT=${git(hc, "rev-parse", "HEAD")}\nGHOSTTY_COMMIT=${git(ghostty, "rev-parse", "HEAD")}\n`);
  for (let n = 1; n <= patches; n += 1) addPatch(dir, n);
  return { dir, upstream: join(dir, "upstream") };
}

function addPatch(dir: string, n: number): void {
  const work = join(scratch, `patch-${n}`);
  git(scratch, "clone", "--quiet", join(scratch, "hc-tui"), work);
  writeFileSync(join(work, `patch-${n}.txt`), `patch ${n}\n`);
  git(work, "add", "-A");
  git(work, "commit", "--quiet", "-m", `patch ${n}`);
  writeFileSync(join(dir, "patches", `000${n}-patch.patch`), git(work, "format-patch", "-1", "--stdout") + "\n");
}

function bumpPin(dir: string): { ghostty: string } {
  const ghostty = join(scratch, "ghostty");
  writeFileSync(join(ghostty, "next.zig"), "// next\n");
  git(ghostty, "add", "-A");
  git(ghostty, "commit", "--quiet", "-m", "ghostty next");
  const hc = join(scratch, "hc-tui");
  git(join(hc, "vendor", "ghostty"), "pull", "--quiet", "origin", "HEAD");
  git(hc, "add", "vendor/ghostty");
  git(hc, "commit", "--quiet", "-m", "hc-tui next");
  const next = git(ghostty, "rev-parse", "HEAD");
  writeFileSync(join(dir, "hc-tui.pin"), `HC_TUI_REPO=${hc}\nHC_TUI_TAG=v1\nHC_TUI_COMMIT=${git(hc, "rev-parse", "HEAD")}\nGHOSTTY_COMMIT=${next}\n`);
  return { ghostty: next };
}

function prepare(dir: string, extra: Record<string, string> = {}): { code: number; out: string } {
  const run = Bun.spawnSync(["sh", join(dir, "prepare.sh")], {
    env: { PATH: `${join(scratch, "bin")}:${process.env["PATH"] ?? "/usr/bin:/bin"}`, HOME: scratch, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always", ...extra },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: run.exitCode ?? -1, out: run.stdout.toString() + run.stderr.toString() };
}

function wrapper(): string {
  return `#!/bin/sh\ncase " $* " in *" fetch "*) [ -z "\${WORK_DURING_FETCH:-}" ] || echo mine > "$WORK_DURING_FETCH"; [ -z "\${LOCK_HOLDER_DURING_FETCH:-}" ] || echo "$LOCK_HOLDER_DURING_FETCH" > "$LOCK_DIR/pid"; [ -z "\${SIGNAL_DURING_FETCH:-}" ] || kill -"$SIGNAL_DURING_FETCH" "$PPID" ;; esac\nexec "${Bun.which("git")}" "$@"\n`;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovis-tui-prepare-"));
  mkdirSync(join(scratch, "bin"));
  writeFileSync(join(scratch, "bin", "git"), wrapper(), { mode: 0o755 });
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("crates/ovis-tui/prepare.sh", () => {
  it("makes upstream/ where no file of the crate has that name in another case (macOS folders ignore case)", () => {
    const crateDir = join(import.meta.dir, "..", "crates", "ovis-tui");
    const tracked = Bun.spawnSync(["git", "ls-files", "--", "."], { cwd: crateDir, stdout: "pipe" }).stdout.toString().split("\n");
    expect(tracked.map((path) => path.split("/")[0]!).filter((name) => name.toLowerCase() === "upstream")).toEqual([]);
  });

  it("makes the pin with its patches, and leaves a tree that already is that alone", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    expect(readFileSync(join(upstream, "patch-1.txt"), "utf8")).toBe("patch 1\n");
    const made = git(upstream, "rev-parse", "HEAD");
    expect(prepare(dir).code).toBe(0);
    expect(git(upstream, "rev-parse", "HEAD")).toBe(made);
  });

  it("keeps a commit only the reflog of upstream/ holds when the pin moves", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    const made = git(upstream, "rev-parse", "HEAD");
    writeFileSync(join(upstream, "mine.md"), "mine\n");
    git(upstream, "add", "mine.md");
    git(upstream, "commit", "--quiet", "-m", "mine");
    git(upstream, "reset", "--quiet", "--hard", made);
    bumpPin(dir);
    const ran = prepare(dir);
    expect(ran.code, ran.out).toBe(1);
    expect(git(upstream, "log", "-g", "--format=%s").split("\n")).toContain("mine");
  });

  it("keeps files in a vendor/ghostty that is not initialised", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    git(upstream, "submodule", "--quiet", "deinit", "-f", "vendor/ghostty");
    writeFileSync(join(upstream, "vendor", "ghostty", "mine.zig"), "// mine\n");
    addPatch(dir, 2);
    const ran = prepare(dir);
    expect(ran.code, ran.out).toBe(1);
    expect(existsSync(join(upstream, "vendor", "ghostty", "mine.zig"))).toBe(true);
  });

  it("moves a clean tree to a new pin whose Ghostty commit differs", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    const { ghostty } = bumpPin(dir);
    const ran = prepare(dir);
    expect(ran.code, ran.out).toBe(0);
    expect(git(join(upstream, "vendor", "ghostty"), "rev-parse", "HEAD")).toBe(ghostty);
    expect(existsSync(join(upstream, "patch-1.txt"))).toBe(true);
  });

  describe("never deletes work when the patches change", () => {
    const sub = (upstream: string) => join(upstream, "vendor", "ghostty");
    const commitIn = (repo: string, file: string) => {
      writeFileSync(join(repo, file), "mine\n");
      git(repo, "add", file);
      git(repo, "commit", "--quiet", "-m", "mine");
    };
    const refs = (repo: string) => git(repo, "for-each-ref", "--format=%(refname)");
    const cases: [string, (upstream: string) => void, (upstream: string) => boolean][] = [
      ["a branch", (upstream) => git(upstream, "branch", "mywork"), (upstream) => refs(upstream).includes("refs/heads/mywork")],
      ["a stash", (upstream) => {
        writeFileSync(join(upstream, "README.md"), "edited\n");
        git(upstream, "stash", "--quiet");
      }, (upstream) => refs(upstream).includes("refs/stash")],
      ["an uncommitted change", (upstream) => writeFileSync(join(upstream, "README.md"), "edited\n"), (upstream) => readFileSync(join(upstream, "README.md"), "utf8") === "edited\n"],
      ["an untracked file its git config hides", (upstream) => {
        git(upstream, "config", "status.showUntrackedFiles", "no");
        writeFileSync(join(upstream, "notes.md"), "mine\n");
      }, (upstream) => existsSync(join(upstream, "notes.md"))],
      ["an ignored file that is not a build cache", (upstream) => writeFileSync(join(upstream, "keys.local"), "mine\n"), (upstream) => existsSync(join(upstream, "keys.local"))],
      ["another worktree of it", (upstream) => git(upstream, "worktree", "add", "--quiet", "--detach", join(scratch, "elsewhere")), (upstream) => git(upstream, "worktree", "list").includes("elsewhere")],
      ["an untracked file in the Ghostty submodule", (upstream) => writeFileSync(join(sub(upstream), "mine.zig"), "// mine\n"), (upstream) => existsSync(join(sub(upstream), "mine.zig"))],
      ["a stash in the Ghostty submodule", (upstream) => {
        writeFileSync(join(sub(upstream), "build.zig"), "// edited\n");
        git(sub(upstream), "stash", "--quiet");
      }, (upstream) => refs(sub(upstream)).includes("refs/stash")],
      ["a commit on the Ghostty submodule's detached HEAD", (upstream) => commitIn(sub(upstream), "mine.zig"), (upstream) => git(sub(upstream), "log", "--format=%s", "-1") === "mine"],
      ["a Ghostty branch with a commit no remote has", (upstream) => {
        git(sub(upstream), "switch", "--quiet", "-c", "mywork");
        commitIn(sub(upstream), "mine.zig");
        git(sub(upstream), "switch", "--quiet", "--detach", "HEAD~1");
      }, (upstream) => refs(sub(upstream)).includes("refs/heads/mywork")],
      ["a commit only a tag points to", (upstream) => {
        const made = git(upstream, "rev-parse", "HEAD");
        commitIn(upstream, "mine.md");
        git(upstream, "tag", "mywork");
        git(upstream, "reset", "--quiet", "--hard", made);
      }, (upstream) => git(upstream, "log", "--format=%s", "-1", "mywork") === "mine"],
      ["an edit to a file flagged skip-worktree", (upstream) => {
        git(upstream, "update-index", "--skip-worktree", "README.md");
        writeFileSync(join(upstream, "README.md"), "edited\n");
      }, (upstream) => readFileSync(join(upstream, "README.md"), "utf8") === "edited\n"],
      ["a Ghostty commit only a tag points to", (upstream) => {
        const pin = git(sub(upstream), "rev-parse", "HEAD");
        commitIn(sub(upstream), "mine.zig");
        git(sub(upstream), "tag", "mywork");
        git(sub(upstream), "checkout", "--quiet", "--detach", pin);
      }, (upstream) => git(sub(upstream), "log", "--format=%s", "-1", "mywork") === "mine"],
      ["a Ghostty commit only its reflog holds", (upstream) => {
        const pin = git(sub(upstream), "rev-parse", "HEAD");
        commitIn(sub(upstream), "mine.zig");
        git(sub(upstream), "checkout", "--quiet", "--detach", pin);
      }, (upstream) => git(sub(upstream), "log", "-g", "--format=%s").split("\n").includes("mine")],
      ["a commit in a worktree added from the Ghostty submodule", (upstream) => {
        const other = join(scratch, "ghostty-work");
        git(sub(upstream), "worktree", "add", "--quiet", "--detach", other);
        commitIn(other, "mine.zig");
      }, () => git(join(scratch, "ghostty-work"), "log", "--format=%s", "-1") === "mine"],
    ];
    for (const [name, make, kept] of cases) {
      it(`keeps ${name}`, () => {
        const { dir, upstream } = crate(1);
        expect(prepare(dir).code).toBe(0);
        make(upstream);
        addPatch(dir, 2);
        const ran = prepare(dir);
        expect(ran.code, ran.out).toBe(1);
        expect(ran.out).toContain("has work of its own");
        expect(kept(upstream)).toBe(true);
      });
    }

    it("keeps work in a tree git cannot read (a broken index), and replaces nothing", () => {
      const { dir, upstream } = crate(1);
      expect(prepare(dir).code).toBe(0);
      writeFileSync(join(upstream, "notes.md"), "mine\n");
      writeFileSync(join(upstream, ".git", "index"), "not an index");
      addPatch(dir, 2);
      const ran = prepare(dir);
      expect(ran.code, ran.out).toBe(1);
      expect(ran.out).toContain("git could not inspect it");
      expect(existsSync(join(upstream, "notes.md"))).toBe(true);
    });

    it("keeps work made in it while the new tree was fetched, and replaces nothing", () => {
      const { dir, upstream } = crate(1);
      expect(prepare(dir).code).toBe(0);
      addPatch(dir, 2);
      const ran = prepare(dir, { WORK_DURING_FETCH: join(upstream, "notes.md") });
      expect(ran.code, ran.out).toBe(1);
      expect(ran.out).toContain("nothing was replaced");
      expect(existsSync(join(upstream, "notes.md"))).toBe(true);
      expect(existsSync(join(upstream, "patch-2.txt"))).toBe(false);
      expect(readdirSync(dir).filter((name) => name.startsWith(".upstream.new"))).toEqual([]);
    });
  });

  it("does not count build caches (target/, Ghostty's zig-pkg/) as work", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    mkdirSync(join(upstream, "vendor", "ghostty", "zig-pkg"));
    writeFileSync(join(upstream, "vendor", "ghostty", "zig-pkg", "cache"), "x");
    mkdirSync(join(upstream, "target"));
    writeFileSync(join(upstream, "target", "build"), "x");
    addPatch(dir, 2);
    expect(prepare(dir).code).toBe(0);
    expect(existsSync(join(upstream, "patch-2.txt"))).toBe(true);
  });

  describe("one run at a time", () => {
    const lockOf = (dir: string, pid: string | null) => {
      mkdirSync(join(dir, ".prepare.lock"));
      if (pid !== null) writeFileSync(join(dir, ".prepare.lock", "pid"), `${pid}\n`);
    };

    it("touches nothing while a live run holds the lock", () => {
      const { dir, upstream } = crate(1);
      expect(prepare(dir).code).toBe(0);
      lockOf(dir, String(process.pid));
      addPatch(dir, 2);
      const ran = prepare(dir);
      expect(ran.code, ran.out).toBe(1);
      expect(ran.out).toContain(`another prepare.sh (pid ${process.pid}) is running`);
      expect(existsSync(join(upstream, "patch-2.txt"))).toBe(false);
      expect(readFileSync(join(dir, ".prepare.lock", "pid"), "utf8").trim()).toBe(String(process.pid));
    });

    it("takes over a lock whose run is gone, or one with no pid, and releases it", () => {
      const gone = Bun.spawnSync(["true"]).pid;
      for (const pid of [String(gone), null]) {
        const { dir, upstream } = crate(1);
        lockOf(dir, pid);
        const ran = prepare(dir);
        expect(ran.code, ran.out).toBe(0);
        expect(existsSync(join(upstream, "patch-1.txt"))).toBe(true);
        expect(existsSync(join(dir, ".prepare.lock"))).toBe(false);
        rmSync(scratch, { recursive: true, force: true });
        scratch = mkdtempSync(join(tmpdir(), "ovis-tui-prepare-"));
        mkdirSync(join(scratch, "bin"));
        writeFileSync(join(scratch, "bin", "git"), wrapper(), { mode: 0o755 });
      }
    });

    it("stopped by a signal, leaves a lock another run took meanwhile", () => {
      const { dir } = crate(1);
      const ran = prepare(dir, { LOCK_DIR: join(dir, ".prepare.lock"), LOCK_HOLDER_DURING_FETCH: String(process.pid), SIGNAL_DURING_FETCH: "TERM" });
      expect(ran.code, ran.out).toBe(130);
      expect(readFileSync(join(dir, ".prepare.lock", "pid"), "utf8").trim()).toBe(String(process.pid));
    });

    it("leaves a lock another run took meanwhile", () => {
      const { dir } = crate(1);
      const ran = prepare(dir, { LOCK_DIR: join(dir, ".prepare.lock"), LOCK_HOLDER_DURING_FETCH: String(process.pid) });
      expect(ran.code, ran.out).toBe(0);
      expect(readFileSync(join(dir, ".prepare.lock", "pid"), "utf8").trim()).toBe(String(process.pid));
    });
  });

  for (const signal of ["INT", "TERM", "HUP"]) {
    it(`stopped by SIG${signal}, leaves the old tree, no half-made tree and no lock`, () => {
      const { dir, upstream } = crate(1);
      expect(prepare(dir).code).toBe(0);
      addPatch(dir, 2);
      const ran = prepare(dir, { SIGNAL_DURING_FETCH: signal });
      expect(ran.code, ran.out).toBe(130);
      expect(existsSync(join(upstream, "patch-1.txt"))).toBe(true);
      expect(existsSync(join(upstream, "patch-2.txt"))).toBe(false);
      expect(readdirSync(dir).filter((name) => name.startsWith(".upstream.") || name === ".prepare.lock")).toEqual([]);
    });
  }

  it("clears the half-made and set-aside trees of runs that were killed", () => {
    const { dir } = crate(1);
    mkdirSync(join(dir, ".upstream.new.999", "part"), { recursive: true });
    mkdirSync(join(dir, ".upstream.old.998", "part"), { recursive: true });
    expect(prepare(dir).code).toBe(0);
    expect(readdirSync(dir).filter((name) => name.startsWith(".upstream.new") || name === ".prepare.lock")).toEqual([]);
  });

  it("leaves the old tree as it was when the fetch fails, and no half-made tree beside it", () => {
    const { dir, upstream } = crate(1);
    expect(prepare(dir).code).toBe(0);
    const made = git(upstream, "rev-parse", "HEAD");
    addPatch(dir, 2);
    const ran = prepare(dir, { HC_TUI_REPO_OVERRIDE: join(scratch, "nowhere") });
    expect(ran.code).not.toBe(0);
    expect(git(upstream, "rev-parse", "HEAD")).toBe(made);
    expect(existsSync(join(upstream, "patch-1.txt"))).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith(".upstream.new"))).toEqual([]);
  });
});
