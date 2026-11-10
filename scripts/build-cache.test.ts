import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitBuild, cacheKey, deliver, entriesOf, evict, mayWrite, refreshLock, releaseLock, restore, store, takeLock } from "./build-cache.ts";

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const dir = mkdtempSync(join(tmpdir(), prefix)); made.push(dir); return dir; };

const identity = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (root: string, ...args: string[]): void => {
  const result = spawnSync("git", args, { cwd: root, env: { ...process.env, ...identity }, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

/** A committed checkout of its own, with dist/ and node_modules/ ignored as in the repository. */
function checkout(): string {
  const root = temp("ovis-build-cache-repo-");
  git(root, "init", "-q");
  writeFileSync(join(root, ".gitignore"), "dist/\nnode_modules/\n.env\n*.log\n");
  writeFileSync(join(root, "main.ts"), "export const a = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  return root;
}

const keyOf = (root: string, env: Record<string, string | undefined> = {}, args: string[] = []): string => {
  const result = cacheKey(root, env, args);
  if (!("key" in result)) throw new Error(`expected a key, got bypass: ${result.bypass}`);
  return result.key;
};

describe("cacheKey", () => {
  it("names the same inputs the same way, whatever variables the build does not read", () => {
    const root = checkout();
    expect(keyOf(root, { PATH: "/a", HOME: "/x" })).toBe(keyOf(root, { PATH: "/b" }));
  });

  it("misses after any change to a build input", () => {
    const root = checkout();
    const base = keyOf(root);
    const keys = new Set([base]);
    const changed = (key: string): void => { expect(keys.has(key)).toBe(false); keys.add(key); };
    changed(keyOf(root, { VITE_FLAG: "1" }));
    changed(keyOf(root, { HERDR_TEST_HOOKS: "1" }));
    changed(keyOf(root, { NODE_ENV: "development" }));
    changed(keyOf(root, {}, ["--mode", "shell"]));
    writeFileSync(join(root, ".env"), "VITE_A=1\n");
    changed(keyOf(root));
    writeFileSync(join(root, ".env"), "VITE_A=2\n");
    changed(keyOf(root));
    rmSync(join(root, ".env"));
    expect(keyOf(root)).toBe(base);
    // a commit that changes a source file, and one that changes the lockfile
    writeFileSync(join(root, "main.ts"), "export const a = 2;\n");
    git(root, "commit", "-q", "-am", "two");
    changed(keyOf(root));
    writeFileSync(join(root, "bun.lock"), "{}\n");
    git(root, "add", "bun.lock");
    git(root, "commit", "-q", "-m", "lock");
    changed(keyOf(root));
    // same tree, new commit: the client embeds the commit's hash, so it is another build
    git(root, "commit", "-q", "--allow-empty", "-m", "empty");
    changed(keyOf(root));
  });

  it("never uses the cache for a checkout git has uncommitted changes in", () => {
    const root = checkout();
    writeFileSync(join(root, "main.ts"), "export const a = 3;\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "the checkout has uncommitted changes" });
    git(root, "checkout", "-q", "--", "main.ts");
    writeFileSync(join(root, "new.ts"), "export {};\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "the checkout has uncommitted changes" });
    rmSync(join(root, "new.ts"));
    git(root, "add", "-A");
    expect("key" in cacheKey(root, {}, [])).toBe(true);
  });

  it("is used in GitHub Actions only by pull request runs and pushes to main", () => {
    const root = checkout();
    expect("key" in cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request" }, [])).toBe(true);
    expect("key" in cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, [])).toBe(true);
    for (const [event, ref] of [["push", "refs/tags/v1.0.0"], ["push", "refs/heads/other"], ["workflow_dispatch", "refs/heads/main"], ["pull_request_target", ""], [undefined, ""]] as const) {
      expect(cacheKey(root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: event, GITHUB_REF: ref }, [])).toEqual({ bypass: "only pull request runs and pushes to main use it" });
    }
  });

  it("never uses the cache when a .env file refers to other variables", () => {
    const root = checkout();
    writeFileSync(join(root, ".env"), "VITE_A=$HOME\n");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: ".env refers to other variables" });
  });

  it("never uses the cache while ignored files sit where the build reads them", () => {
    const root = checkout();
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public/extra.log"), "copied into dist/ by Vite");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "ignored files where the build reads" });
    rmSync(join(root, "public/extra.log"));
    writeFileSync(join(root, "top.log"), "not read by the build");
    expect("key" in cacheKey(root, {}, [])).toBe(true);
    // what typecheck emits for shared/vendor/paseo-e2ee, which Vite never bundles; elsewhere a .d.ts still counts
    mkdirSync(join(root, "public/dist"), { recursive: true });
    writeFileSync(join(root, "public/dist/x.d.ts"), "");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "ignored files where the build reads" });
    rmSync(join(root, "public/dist"), { recursive: true });
    mkdirSync(join(root, "shared/vendor/x/dist"), { recursive: true });
    writeFileSync(join(root, "shared/vendor/x/a.ts"), "export {};\n");
    git(root, "add", "-f", "shared/vendor/x/a.ts");
    git(root, "commit", "-q", "-m", "vendor");
    for (const name of ["a.d.ts", "a.d.ts.map", "tsconfig.tsbuildinfo"]) writeFileSync(join(root, "shared/vendor/x/dist", name), "");
    expect("key" in cacheKey(root, {}, [])).toBe(true);
    writeFileSync(join(root, "shared/vendor/x/dist/a.js"), "");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "ignored files where the build reads" });
  });

  it("never uses the cache while the commit tracks a link where the build reads", () => {
    const root = checkout();
    mkdirSync(join(root, "src"));
    symlinkSync("/etc/hostname", join(root, "src/link"));
    git(root, "add", "src/link");
    git(root, "commit", "-q", "-m", "link");
    expect(cacheKey(root, {}, [])).toEqual({ bypass: "a tracked link where the build reads" });
  });

  it("does not use the cache outside a git checkout", () => {
    expect(cacheKey(temp("ovis-build-cache-nogit-"), {}, [])).toEqual({ bypass: "no git commit" });
  });
});

describe("store and restore", () => {
  const dist = (root: string, files: Record<string, string>): string => {
    const dir = join(root, "dist");
    rmSync(dir, { recursive: true, force: true });
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(dir, name, ".."), { recursive: true });
      writeFileSync(join(dir, name), content);
    }
    return dir;
  };
  const files = (dir: string): Record<string, string> => Object.fromEntries(
    (readdirSync(dir, { recursive: true }) as string[]).sort()
      .filter((name) => !name.endsWith("assets"))
      .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
  );

  it("restores exactly the stored files, replacing whatever dist/ held", () => {
    const root = temp("ovis-build-cache-dist-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), 1 << 30);
    dist(root, { "stale.js": "old" });
    expect(restore(cache, "k", join(root, "dist"))).toBe(true);
    expect(files(join(root, "dist"))).toEqual({ "assets/a.js": "a", "index.html": "<p>" });
  });

  it("misses an entry that is absent or was never finished", () => {
    const root = temp("ovis-build-cache-miss-");
    const cache = join(root, "cache");
    mkdirSync(join(cache, "half"), { recursive: true });
    writeFileSync(join(cache, "half", "index.html"), "partial");
    dist(root, { "index.html": "mine" });
    expect(restore(cache, "absent", join(root, "dist"))).toBe(false);
    expect(restore(cache, "half", join(root, "dist"))).toBe(false);
    expect(files(join(root, "dist"))).toEqual({ "index.html": "mine" });
  });

  it("refuses an entry whose files do not match its manifest: missing, changed or added", () => {
    const root = temp("ovis-build-cache-short-");
    const cache = join(root, "cache");
    const damage: ((entry: string) => void)[] = [
      (entry) => rmSync(join(entry, "assets"), { recursive: true }),
      (entry) => writeFileSync(join(entry, "index.html"), "<p>planted"),
      (entry) => writeFileSync(join(entry, "extra.js"), "planted"),
    ];
    for (const change of damage) {
      rmSync(cache, { recursive: true, force: true });
      store(cache, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), 1 << 30);
      change(join(cache, "k"));
      dist(root, { "index.html": "mine" });
      expect(() => restore(cache, "k", join(root, "dist"))).toThrow("the entry's files do not match its manifest");
      expect(files(join(root, "dist"))).toEqual({ "index.html": "mine" });
    }
    expect(readdirSync(join(root, "node_modules/.cache"))).toEqual([]);
  });

  it("restores dist/ readable by others, as a fresh build leaves it", () => {
    const root = temp("ovis-build-cache-mode-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "<p>" }), 1 << 30);
    rmSync(join(root, "dist"), { recursive: true });
    expect(restore(cache, "k", join(root, "dist"))).toBe(true);
    expect(statSync(join(root, "dist")).mode & 0o777).toBe(0o755);
  });

  it("refuses an entry holding a link, even one its manifest names", () => {
    const root = temp("ovis-build-cache-link-");
    const cache = join(root, "cache");
    writeFileSync(join(root, "secret"), "token");
    const sum = new Bun.CryptoHasher("sha256").update("token").digest("hex");
    mkdirSync(join(cache, "k"), { recursive: true });
    symlinkSync(join(root, "secret"), join(cache, "k", "leak"));
    writeFileSync(join(cache, "k", ".manifest"), `${sum}  ./leak\n`);
    expect(() => restore(cache, "k", join(root, "dist"))).toThrow("./leak is not a file or a directory");
    expect(existsSync(join(root, "dist"))).toBe(false);
  });

  it("hands a build to the outbox without touching the cache", () => {
    const root = temp("ovis-build-cache-outbox-");
    const outbox = join(root, "outbox");
    mkdirSync(outbox);
    deliver(outbox, "k", dist(root, { "index.html": "<p>", "assets/a.js": "a" }), "123", "2");
    expect(readdirSync(outbox).sort()).toEqual(["k.claim", "k.tar"]);
    expect(readFileSync(join(outbox, "k.claim"), "utf8")).toBe("123 2\n");
    const listed = spawnSync("tar", ["-tf", join(outbox, "k.tar")], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
    expect(listed).toEqual(["./", "./assets/", "./assets/a.js", "./index.html"]);
  });

  it("stores no build that holds a file named like the manifest", () => {
    const root = temp("ovis-build-cache-own-manifest-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "<p>", ".manifest": "the app's own" }), 1 << 30);
    expect(existsSync(join(cache, "k"))).toBe(false);
    expect(restore(cache, "k", join(root, "dist"))).toBe(false);
  });

  it("keeps the first entry written for a key", () => {
    const root = temp("ovis-build-cache-first-");
    const cache = join(root, "cache");
    store(cache, "k", dist(root, { "index.html": "first" }), 1 << 30);
    store(cache, "k", dist(root, { "index.html": "second" }), 1 << 30);
    restore(cache, "k", join(root, "dist"));
    expect(files(join(root, "dist"))).toEqual({ "index.html": "first" });
    expect(readdirSync(cache).sort()).toEqual(["k"]);
  });

  it("evicts the least recently used entries past the size limit", () => {
    const root = temp("ovis-build-cache-lru-");
    const cache = join(root, "cache");
    for (const key of ["old", "mid", "new"]) store(cache, key, dist(root, { "a.js": "x".repeat(1000) }), 1 << 30);
    const at = (key: string, seconds: number): void => { const t = new Date(seconds * 1000); utimesSync(join(cache, key), t, t); };
    at("old", 1_000); at("mid", 2_000); at("new", 3_000);
    // a restore counts as a use: "old" becomes the newest
    restore(cache, "old", join(root, "dist"));
    evict(cache, 2_500);
    expect(readdirSync(cache).sort()).toEqual(["new", "old"]);
  });

  it("reads the runner's cache under the job's own run, and a cache of one's own by the key alone", () => {
    expect(entriesOf("/cache", undefined, undefined)).toBe("/cache");
    expect(entriesOf("/cache", undefined, "7")).toBe("/cache");
    expect(entriesOf("/cache", "/outbox", "7")).toBe(join("/cache", "7"));
    expect(entriesOf("/cache", "/outbox", "19234567890")).toBe(join("/cache", "19234567890"));
    // no run, or nothing the launcher would name a run's directory after: no entries to read
    for (const run of [undefined, "", "7a", "-7", "../7", "7/8", " 7", "1".repeat(21)]) expect(entriesOf("/cache", "/outbox", run)).toBeNull();
  });

  it("restores an entry only from where the job's entries are: its own run's directory, not another's", () => {
    const root = temp("ovis-build-cache-run-");
    const cache = join(root, "cache");
    store(join(cache, "7"), "k", dist(root, { "index.html": "built by run 7" }), 1 << 30);
    store(join(cache, "8"), "k", dist(root, { "index.html": "built by run 8" }), 1 << 30);
    const [seven, eight, nine] = ["7", "8", "9"].map((run) => entriesOf(cache, join(root, "outbox"), run)!) as [string, string, string];
    expect(restore(seven, "k", join(root, "dist"))).toBe(true);
    expect(files(join(root, "dist"))).toEqual({ "index.html": "built by run 7" });
    expect(restore(eight, "k", join(root, "dist"))).toBe(true);
    expect(files(join(root, "dist"))).toEqual({ "index.html": "built by run 8" });
    // a run with no entry of its own takes neither, and a reader of the cache's root finds none by the key alone
    expect(restore(nine, "k", join(root, "dist"))).toBe(false);
    expect(restore(cache, "k", join(root, "dist"))).toBe(false);
  });
});

describe("mayWrite", () => {
  const event = (pull: unknown): string => {
    const path = join(temp("ovis-build-cache-event-"), "event.json");
    writeFileSync(path, JSON.stringify({ pull_request: pull }));
    return path;
  };
  const actions = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "owner/repo" };
  const pr = (author: string, actor: string, head = "owner/repo") => ({ ...actions, GITHUB_EVENT_NAME: "pull_request", GITHUB_TRIGGERING_ACTOR: actor, GITHUB_EVENT_PATH: event({ user: { login: author }, head: { repo: { full_name: head } } }) });

  it("expects a build to be taken in only from a run the launcher trusts", () => {
    expect(mayWrite({}, undefined)).toBe(true);
    expect(mayWrite({ ...actions, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" }, undefined)).toBe(true);
    expect(mayWrite({ ...actions, GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/other" }, "w")).toBe(false);
    expect(mayWrite(pr("w", "w"), "w")).toBe(true);
    expect(mayWrite(pr("w", "w"), undefined)).toBe(false);
    expect(mayWrite(pr("other", "w"), "w")).toBe(false);
    expect(mayWrite(pr("w", "other"), "w")).toBe(false);
    expect(mayWrite(pr("w", "w", "fork/repo"), "w")).toBe(false);
    expect(mayWrite({ ...pr("w", "w"), GITHUB_EVENT_PATH: "/nonexistent" }, "w")).toBe(false);
  });
});

describe("one build per key", () => {
  it("releases a lock without failing, even one another job put something unremovable in", () => {
    const dir = temp("ovis-build-cache-release-");
    const token = takeLock(dir, "k")!;
    mkdirSync(join(dir, ".lock-k", "sub"));
    writeFileSync(join(dir, ".lock-k", "sub", "f"), "");
    chmodSync(join(dir, ".lock-k", "sub"), 0o000);
    try {
      expect(() => releaseLock(dir, "k", token)).not.toThrow();
    } finally {
      chmodSync(join(dir, ".lock-k", "sub"), 0o755);
    }
  });

  it("stops waiting on a lock left stale by a job that died", async () => {
    const dir = temp("ovis-build-cache-stale-");
    takeLock(dir, "k");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock-k"), old, old);
    const started = Date.now();
    await awaitBuild(dir, "k", 30_000, { lock: join(dir, ".lock-k"), staleMs: 30_000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(takeLock(dir, "k", 30_000)).toBeTruthy();
  });

  it("releases or refreshes only the lock it holds, never one another job took over", () => {
    const dir = temp("ovis-build-cache-owner-");
    const first = takeLock(dir, "k");
    expect(first).toBeTruthy();
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, ".lock-k"), old, old);
    const second = takeLock(dir, "k", 30_000);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    releaseLock(dir, "k", first as string);
    expect(existsSync(join(dir, ".lock-k"))).toBe(true);
    utimesSync(join(dir, ".lock-k"), old, old);
    refreshLock(dir, "k", first as string);
    expect(statSync(join(dir, ".lock-k")).mtimeMs).toBeLessThan(Date.now() - 30_000);
    refreshLock(dir, "k", second as string);
    expect(statSync(join(dir, ".lock-k")).mtimeMs).toBeGreaterThan(Date.now() - 30_000);
    releaseLock(dir, "k", second as string);
    expect(existsSync(join(dir, ".lock-k"))).toBe(false);
  });

  it("tells a lock it could not make from one another job holds", () => {
    const dir = temp("ovis-build-cache-lockerr-");
    writeFileSync(join(dir, "not-a-directory"), "");
    expect(() => takeLock(join(dir, "not-a-directory"), "k")).toThrow();
  });

  it("lets one job take a key's build, and another once it is released or left stale", () => {
    const cache = temp("ovis-build-cache-lock-");
    const token = takeLock(cache, "k");
    expect(token).toBeTruthy();
    expect(takeLock(cache, "k")).toBeNull();
    expect(takeLock(cache, "other")).toBeTruthy();
    releaseLock(cache, "k", token!);
    expect(takeLock(cache, "k")).toBeTruthy();
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(cache, ".lock-k"), old, old);
    expect(takeLock(cache, "k", 30_000)).toBeTruthy();
  });

  it("waits for the job building a key until its entry is stored", async () => {
    const root = temp("ovis-build-cache-wait-");
    const cache = join(root, "cache");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/index.html"), "built");
    mkdirSync(cache);
    takeLock(cache, "k");
    const waited = awaitBuild(cache, "k", 30_000, { lock: join(cache, ".lock-k") }).then(() => existsSync(join(cache, "k")));
    store(cache, "k", join(root, "dist"), 1 << 30);
    expect(await waited).toBe(true);
  });

  it("waits for one job's build, not for the next job's once the first let go with nothing taken in", async () => {
    const dir = temp("ovis-build-cache-next-");
    const first = takeLock(dir, "k")!;
    const waited = awaitBuild(dir, "k", 30_000, { lock: join(dir, ".lock-k") });
    // released, and taken by the next job before the waiter looks again
    releaseLock(dir, "k", first);
    expect(takeLock(dir, "k")).toBeTruthy();
    const started = Date.now();
    await waited;
    expect(Date.now() - started).toBeLessThan(3_000);
    // a holder that had not written its token when the wait began is still the one waited for
    mkdirSync(join(dir, ".lock-j"));
    const from = Date.now();
    const early = awaitBuild(dir, "j", 1_000, { lock: join(dir, ".lock-j") });
    writeFileSync(join(dir, ".lock-j", "owner"), "its token");
    await early;
    expect(Date.now() - from).toBeGreaterThanOrEqual(900);
  });

  it("stops waiting once the building job gives up, or at its deadline", async () => {
    const cache = temp("ovis-build-cache-giveup-");
    const token = takeLock(cache, "k")!;
    const waited = awaitBuild(cache, "k", 30_000, { lock: join(cache, ".lock-k") });
    releaseLock(cache, "k", token);
    await waited;
    takeLock(cache, "k");
    const started = Date.now();
    await awaitBuild(cache, "k", 300, { lock: join(cache, ".lock-k") });
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("bun scripts/build-cache.ts", () => {
  const script = join(import.meta.dir, "build-cache.ts");

  /** A checkout whose `vite` writes dist/ from main.ts and counts its runs. */
  function project(): { root: string; runs: () => number } {
    const root = checkout();
    const bin = join(root, "node_modules/.bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "vite"), `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync("node_modules/runs", "x");
fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist");
fs.writeFileSync("dist/index.html", fs.readFileSync("main.ts", "utf8") + (process.env.VITE_FLAG ?? ""));
if (process.env.EDIT_DURING_BUILD) fs.writeFileSync("main.ts", process.env.EDIT_DURING_BUILD);
`);
    chmodSync(join(bin, "vite"), 0o755);
    return { root, runs: () => existsSync(join(root, "node_modules/runs")) ? readFileSync(join(root, "node_modules/runs"), "utf8").length : 0 };
  }
  const buildEnv = (cache: string | null, extra: Record<string, string> = {}): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = { ...process.env };
    // the run's own GitHub Actions variables would turn the cache off outside a pull request run
    // and a runner's own cache (its outbox, locks and writer) would take the fixture's builds, under its own run
    for (const name of Object.keys(env)) if (name.startsWith("OVIS_BUILD_CACHE_") || ["GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"].includes(name)) delete env[name];
    Object.assign(env, extra);
    if (cache) env["OVIS_BUILD_CACHE_DIR"] = cache;
    return env;
  };
  /** The key the build in `root` computes with `buildEnv(null)`'s variables (none of the extra ones above touch it). */
  const keyFor = (root: string): string => (cacheKey(root, buildEnv(null), []) as { key: string }).key;
  const build = (root: string, cache: string | null, extra: Record<string, string> = {}): string => {
    const result = spawnSync(process.execPath, [script], { cwd: root, env: buildEnv(cache, extra), encoding: "utf8" });
    expect(result.status).toBe(0);
    return readFileSync(join(root, "dist/index.html"), "utf8");
  };
  /** Another job's checkout of `root`'s commit, with the same `vite`. */
  const clone = (root: string): { copy: string; runs: () => number } => {
    const copy = temp("ovis-build-cache-job-");
    git(copy, "clone", "-q", root, ".");
    spawnSync("cp", ["-a", join(root, "node_modules"), copy]);
    return { copy, runs: () => existsSync(join(copy, "node_modules/runs")) ? readFileSync(join(copy, "node_modules/runs"), "utf8").length : 0 };
  };
  /** A dist/ somebody built, holding `files`. */
  const built = (files: Record<string, string>): string => {
    const dir = temp("ovis-build-cache-built-");
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return dir;
  };

  const promoter = join(import.meta.dir, "self-hosted-runner/build-cache-promote.sh");
  /**
   * The launcher's side of a runner: entries/ (the cache), an outbox per slot, the locks the jobs
   * share, and a `gh` that answers for `runs` by their id. Each has a job running on its `slots`
   * and is a push to main, or with `pull` a pull request the writer ("w") opened and pushed, at its
   * head; the run "any" answers for every run GitHub is asked about and has no answer for.
   * `pass` is one pass of the promoter, as the launcher makes one every second.
   */
  function launcher(slots: string[], runs: Record<string, { slots: string[]; pull?: boolean }>, late = 0) {
    const base = temp("ovis-build-cache-launcher-");
    const [entries, outboxes, locks, bin, github] = ["entries", "outboxes", "locks", "bin", "github"].map((name) => join(base, name)) as [string, string, string, string, string];
    for (const dir of [entries, locks, bin, github, ...slots.map((slot) => join(outboxes, slot))]) mkdirSync(dir, { recursive: true });
    const sha = "5".repeat(40);
    for (const [id, run] of Object.entries(runs)) {
      writeFileSync(join(github, `jobs-${id}.json`), JSON.stringify({ jobs: run.slots.map((slot) => ({ runner_name: slot, status: "in_progress" })) }));
      writeFileSync(join(github, `run-${id}.json`), JSON.stringify(run.pull
        ? { event: "pull_request", head_branch: "feature", head_sha: sha, head_repository: { full_name: "owner/repo" }, triggering_actor: { login: "w" }, pull_requests: [{ number: 5 }] }
        : { event: "push", head_branch: "main", head_repository: { full_name: "owner/repo" } }));
    }
    writeFileSync(join(github, "pull-5.json"), JSON.stringify({ user: { login: "w" }, head: { sha } }));
    writeFileSync(join(bin, "gh"), `#!/bin/sh
github="\${0%/bin/gh}/github"
${late > 0 ? `sleep ${late}` : ":"}
echo "$2" >> "$github/asked"
case "$2" in
  repos/owner/repo) echo main; exit 0 ;;
  repos/owner/repo/actions/runs/*/attempts/*/jobs*) kind=jobs; id="\${2#repos/owner/repo/actions/runs/}"; id="\${id%/attempts/*}" ;;
  repos/owner/repo/actions/runs/*) kind=run; id="\${2#repos/owner/repo/actions/runs/}" ;;
  repos/owner/repo/pulls/*) kind=pull; id="\${2#repos/owner/repo/pulls/}" ;;
  *) kind=none; id=none ;;
esac
file="$github/$kind-$id.json"
[ -f "$file" ] || file="$github/$kind-any.json"
# as GitHub answers for a run that does not exist
[ -f "$file" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
cat "$file"
`);
    chmodSync(join(bin, "gh"), 0o755);
    return {
      base, entries, outboxes, locks,
      pass: (maxMb = "2048") => spawnSync("bash", [promoter, "owner/repo", base, outboxes, "w", maxMb, ...slots], { encoding: "utf8", env: { ...process.env, PATH: [bin, process.env.PATH].join(":") } }),
      /** What a job on `slot` gets from the runner, for a job of `run`. */
      job: (slot: string, run: string, extra: Record<string, string> = {}): Record<string, string> => ({ OVIS_BUILD_CACHE_OUTBOX: join(outboxes, slot), OVIS_BUILD_CACHE_LOCKS: locks, GITHUB_RUN_ID: run, GITHUB_RUN_ATTEMPT: "1", ...extra }),
      /** What entries/ holds, by path from there: a run's directory as `<run id>/`, its entries as `<run id>/<key>`, anything else by its name. */
      filed: (): string[] => readdirSync(entries).sort().flatMap((name) => /^\d+$/.test(name) && lstatSync(join(entries, name)).isDirectory()
        ? [`${name}/`, ...readdirSync(join(entries, name)).sort().map((key) => `${name}/${key}`)] : [name]),
      /** What GitHub was asked. */
      asked: (): string[] => existsSync(join(github, "asked")) ? readFileSync(join(github, "asked"), "utf8").split("\n").filter(Boolean) : [],
    };
  }
  /** Lets `procs` run to their end while the launcher makes one `pass` after another; stops the ones still running after 50 s. */
  async function alongside(procs: { exited: Promise<number>; kill: () => void }[], pass: () => unknown): Promise<void> {
    let ended = false;
    void Promise.all(procs.map((proc) => proc.exited)).then(() => { ended = true; });
    const deadline = Date.now() + 50_000;
    while (!ended && Date.now() < deadline) {
      pass();
      await Bun.sleep(50);
    }
    if (!ended) for (const proc of procs) proc.kill();
  }

  it("builds once per set of inputs and restores the same dist/ for the rest", () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    expect(build(root, cache)).toBe("export const a = 1;\n");
    expect(runs()).toBe(1);
    rmSync(join(root, "dist"), { recursive: true });
    expect(build(root, cache)).toBe("export const a = 1;\n");
    expect(runs()).toBe(1);
    expect(build(root, cache, { VITE_FLAG: "!" })).toBe("export const a = 1;\n!");
    expect(runs()).toBe(2);
    writeFileSync(join(root, "main.ts"), "export const a = 2;\n");
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(3);
    git(root, "commit", "-q", "-am", "two");
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(4);
    expect(build(root, cache)).toBe("export const a = 2;\n");
    expect(runs()).toBe(4);
  }, 60_000);

  it("stores nothing when the checkout changed while it built", () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    expect(build(root, cache, { EDIT_DURING_BUILD: "export const a = 9;\n" })).toBe("export const a = 1;\n");
    git(root, "checkout", "-q", "--", "main.ts");
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
    build(root, cache);
    expect(runs()).toBe(2);
  }, 60_000);

  it("builds a commit once when its jobs start together", async () => {
    const { root, runs } = project();
    const cache = join(temp("ovis-build-cache-dir-"), "cache");
    const env = buildEnv(cache);
    const jobs = [0, 1, 2, 3].map(() => {
      const copy = temp("ovis-build-cache-job-");
      git(copy, "clone", "-q", root, ".");
      spawnSync("cp", ["-a", join(root, "node_modules"), copy]);
      return { copy, proc: Bun.spawn([process.execPath, script], { cwd: copy, env, stdout: "pipe", stderr: "pipe" }) };
    });
    for (const { proc } of jobs) expect(await proc.exited).toBe(0);
    const built = jobs.map(({ copy }) => existsSync(join(copy, "node_modules/runs")) ? readFileSync(join(copy, "node_modules/runs"), "utf8").length : 0);
    expect(built.reduce((a, b) => a + b, 0)).toBe(1);
    for (const { copy } of jobs) expect(readFileSync(join(copy, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
    expect(readdirSync(cache).filter((name) => name.startsWith(".lock-"))).toEqual([]);
    expect(runs()).toBe(0);
  }, 60_000);

  it("on the runner, writes only its own outbox, never the cache", () => {
    const { root, runs } = project();
    const base = temp("ovis-build-cache-runner-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [cache, outbox, locks]) mkdirSync(dir);
    // as the runner mounts it: read-only
    chmodSync(cache, 0o555);
    try {
      expect(build(root, cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_PROMOTE_SECONDS: "0", GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" })).toBe("export const a = 1;\n");
    } finally {
      chmodSync(cache, 0o755);
    }
    expect(runs()).toBe(1);
    expect(readdirSync(cache)).toEqual([]);
    expect(readdirSync(outbox).map((name) => name.replace(/^[0-9a-f]{64}/, "<key>")).sort()).toEqual(["<key>.claim", "<key>.tar"]);
    expect(readdirSync(locks)).toEqual([]);
  }, 60_000);

  it("records a restore only in its own outbox, never through a link another job planted in the shared locks", () => {
    const { root } = project();
    const base = temp("ovis-build-cache-planted-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [outbox, locks]) mkdirSync(dir);
    // an entry for this checkout, as the launcher would have taken it in from a job of this run
    const key = keyFor(root);
    store(join(cache, "7"), key, built({ "index.html": "export const a = 1;\n" }), 1 << 30);
    const victim = join(base, "victim.ts");
    writeFileSync(victim, "process.exit(1);\n");
    symlinkSync(victim, join(locks, `used-${key}`));
    expect(build(root, cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, GITHUB_RUN_ID: "7" })).toBe("export const a = 1;\n");
    expect(readFileSync(victim, "utf8")).toBe("process.exit(1);\n");
    expect(readdirSync(outbox)).toEqual([`used-${key}`]);
  }, 60_000);

  it("builds at once, waiting for no other job, in a run whose build would not be taken in", async () => {
    const { root, runs } = project();
    const base = temp("ovis-build-cache-untrusted-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [cache, outbox, locks]) mkdirSync(dir);
    const key = keyFor(root);
    // another job of the run holds the lock
    mkdirSync(join(locks, `.lock-${key}-7`));
    const started = Date.now();
    expect(build(root, cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_WRITER: "w", GITHUB_RUN_ID: "7", GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_TRIGGERING_ACTOR: "other" })).toBe("export const a = 1;\n");
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(runs()).toBe(1);
    expect(readdirSync(outbox)).toEqual([]);
  }, 60_000);

  it("stops waiting as soon as the launcher has judged its build, taken in or not", async () => {
    const { root } = project();
    const base = temp("ovis-build-cache-refused-");
    const [cache, outbox, locks] = ["cache", "outbox", "locks"].map((name) => join(base, name));
    for (const dir of [cache, outbox, locks]) mkdirSync(dir);
    const env = buildEnv(cache, { OVIS_BUILD_CACHE_OUTBOX: outbox, OVIS_BUILD_CACHE_LOCKS: locks, OVIS_BUILD_CACHE_PROMOTE_SECONDS: "120", GITHUB_RUN_ID: "7", GITHUB_RUN_ATTEMPT: "1" });
    const job = Bun.spawn([process.execPath, script], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
    const claimed = (): string | undefined => readdirSync(outbox).find((name) => name.endsWith(".claim"));
    const deadline = Date.now() + 30_000;
    while (!claimed() && Date.now() < deadline) await Bun.sleep(25);
    // the launcher refuses it: it deletes the claim and the build, then gives its verdict
    const key = claimed()!.slice(0, -".claim".length);
    for (const name of readdirSync(outbox)) rmSync(join(outbox, name));
    mkdirSync(join(outbox, `judged-${key}`));
    const refusedAt = Date.now();
    expect(await job.exited).toBe(0);
    expect(Date.now() - refusedAt).toBeLessThan(10_000);
    expect(await new Response(job.stdout).text()).toContain("was not taken in");
    expect(readdirSync(locks)).toEqual([]);
  }, 60_000);

  it("builds a commit once on the runner when its jobs start together, however slowly GitHub answers the launcher", async () => {
    const { root, runs } = project();
    const slots = ["s1", "s2", "s3", "s4"];
    // a trusted push to main, each answer half a second late
    const runner = launcher(slots, { "7": { slots } }, 0.5);
    const jobs = slots.map((slot) => {
      const job = clone(root);
      return { ...job, proc: Bun.spawn([process.execPath, script], { cwd: job.copy, env: buildEnv(runner.entries, runner.job(slot, "7", { OVIS_BUILD_CACHE_PROMOTE_SECONDS: "30" })), stdout: "pipe", stderr: "pipe" }) };
    });
    await alongside(jobs.map(({ proc }) => proc), () => runner.pass());
    for (const { proc } of jobs) expect(await proc.exited).toBe(0);
    expect(jobs.map((job) => job.runs()).reduce((a, b) => a + b, 0)).toBe(1);
    for (const { copy } of jobs) expect(readFileSync(join(copy, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
    // the one build, under the run GitHub confirmed for the slot that handed it in
    expect(runner.filed()).toEqual(["7/", `7/${keyFor(root)}`]);
    expect(runs()).toBe(0);
  }, 60_000);

  it("on the runner, restores what a job of its own run built and never the same key under another run", () => {
    const { root, runs } = project();
    const runner = launcher(["s1"], {});
    const key = keyFor(root);
    // as the launcher files them: each run's build of this commit under that run
    store(join(runner.entries, "7"), key, built({ "index.html": "built by run 7" }), 1 << 30);
    store(join(runner.entries, "8"), key, built({ "index.html": "built by run 8" }), 1 << 30);
    // no launcher runs here: a job that built would hand its build over and not wait for a verdict
    const job = (run: string) => runner.job("s1", run, { OVIS_BUILD_CACHE_PROMOTE_SECONDS: "0" });
    expect(build(root, runner.entries, job("7"))).toBe("built by run 7");
    expect(build(root, runner.entries, job("8"))).toBe("built by run 8");
    expect(runs()).toBe(0);
    // a run with no entry of its own builds, whatever the others hold
    expect(build(root, runner.entries, job("9"))).toBe("export const a = 1;\n");
    expect(runs()).toBe(1);
    expect(readdirSync(join(runner.outboxes, "s1")).sort()).toEqual([`${key}.claim`, `${key}.tar`, `used-${key}`]);
  }, 60_000);

  it("does not use the runner's cache with no run to read it under", () => {
    const { root, runs } = project();
    const runner = launcher(["s1"], {});
    const key = keyFor(root);
    store(join(runner.entries, "7"), key, built({ "index.html": "built by run 7" }), 1 << 30);
    store(runner.entries, key, built({ "index.html": "filed by the key alone" }), 1 << 30);
    for (const run of [undefined, "", "7/../7", "seven"]) {
      const env = runner.job("s1", "7");
      if (run === undefined) delete env["GITHUB_RUN_ID"]; else env["GITHUB_RUN_ID"] = run;
      const result = spawnSync(process.execPath, [script], { cwd: root, env: buildEnv(runner.entries, env), encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("build cache: not used (on the runner an entry is read under its run");
      expect(readFileSync(join(root, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
    }
    expect(runs()).toBe(4);
    // nothing handed over either, and no lock taken
    expect(readdirSync(join(runner.outboxes, "s1"))).toEqual([]);
    expect(readdirSync(runner.locks)).toEqual([]);
  }, 60_000);

  it("waits on the runner for no build but its own run's: not another run's of the same commit, nor one a job from before locks named the run holds", () => {
    const { root, runs } = project();
    const runner = launcher(["s1"], {});
    const key = keyFor(root);
    mkdirSync(join(runner.locks, `.lock-${key}-8`));
    mkdirSync(join(runner.locks, `.lock-${key}`));
    // a wait for either would outlast this test
    const result = spawnSync(process.execPath, [script], { cwd: root, env: buildEnv(runner.entries, runner.job("s1", "7", { OVIS_BUILD_CACHE_PROMOTE_SECONDS: "0", OVIS_BUILD_CACHE_WAIT_SECONDS: "300" })), encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("waiting for it");
    expect(runs()).toBe(1);
    // its own lock released, theirs left alone
    expect(readdirSync(runner.locks).sort()).toEqual([`.lock-${key}`, `.lock-${key}-8`]);
  }, 60_000);

  it("files a trusted run's build under that run, and nothing for a run GitHub does not confirm for the slot", () => {
    // main's push run 100 has its job on s1 only; run 300 does not exist
    const runner = launcher(["s1", "s2", "s3"], { "100": { slots: ["s1"] } });
    const [mine, theirs, none] = ["a", "b", "c"].map((letter) => letter.repeat(64)) as [string, string, string];
    deliver(join(runner.outboxes, "s1"), mine, built({ "index.html": "<p>" }), "100", "1");
    deliver(join(runner.outboxes, "s2"), theirs, built({ "index.html": "<p>" }), "100", "1");
    deliver(join(runner.outboxes, "s3"), none, built({ "index.html": "<p>" }), "300", "1");
    expect(runner.pass().status).toBe(0);
    expect(runner.filed()).toEqual(["100/", `100/${mine}`]);
    const sum = new Bun.CryptoHasher("sha256").update("<p>").digest("hex");
    expect(readFileSync(join(runner.entries, "100", mine, ".manifest"), "utf8")).toBe(`${sum}  ./index.html\n`);
    // readable by the runners' user, as the entries themselves are
    expect(statSync(join(runner.entries, "100")).mode & 0o777).toBe(0o755);
    expect(statSync(join(runner.entries, "100", mine)).mode & 0o777).toBe(0o755);
    // every claim got its verdict, taken in or not
    expect(["s1", "s2", "s3"].map((slot) => readdirSync(join(runner.outboxes, slot)))).toEqual([[`judged-${mine}`], [`judged-${theirs}`], [`judged-${none}`]]);
    // the same build handed in again for that run: already there, GitHub is not asked
    const asked = runner.asked().length;
    deliver(join(runner.outboxes, "s1"), mine, built({ "index.html": "another" }), "100", "2");
    expect(runner.pass().status).toBe(0);
    expect(runner.asked()).toHaveLength(asked);
    expect(readFileSync(join(runner.entries, "100", mine, "index.html"), "utf8")).toBe("<p>");
  });

  it("never restores, in main's run, a build that a pull request's run handed in under the key of main's commit", async () => {
    const { root } = project();
    const key = keyFor(root);
    // main's push run 100 has its job on s1; the writer's own pull request run 200 has jobs on s2 and s3
    const runner = launcher(["s1", "s2", "s3"], { "100": { slots: ["s1"] }, "200": { slots: ["s2", "s3"], pull: true } });
    // one of its jobs names the key of main's commit for a build of its own, before main's run has built that commit
    deliver(join(runner.outboxes, "s2"), key, built({ "index.html": "not main's client" }), "200", "1");
    // and another names main's run for it as well
    deliver(join(runner.outboxes, "s3"), key, built({ "index.html": "not main's client" }), "100", "1");
    expect(runner.pass().status).toBe(0);
    // the run is trusted, so its build is taken in: where its own jobs read, and nowhere else
    expect(runner.filed()).toEqual(["200/", `200/${key}`]);
    expect(readFileSync(join(runner.entries, "200", key, "index.html"), "utf8")).toBe("not main's client");
    // main's first job finds no entry, builds the commit and hands that in
    const first = clone(root);
    const push = { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main" };
    const proc = Bun.spawn([process.execPath, script], { cwd: first.copy, env: buildEnv(runner.entries, runner.job("s1", "100", push)), stdout: "pipe", stderr: "pipe" });
    await alongside([proc], () => runner.pass());
    expect(await proc.exited).toBe(0);
    expect(first.runs()).toBe(1);
    expect(readFileSync(join(first.copy, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
    expect(runner.filed()).toEqual(["100/", `100/${key}`, "200/", `200/${key}`]);
    expect(readFileSync(join(runner.entries, "100", key, "index.html"), "utf8")).toBe("export const a = 1;\n");
    // and its next job restores main's own build
    const second = clone(root);
    expect(build(second.copy, runner.entries, runner.job("s1", "100", push))).toBe("export const a = 1;\n");
    expect(second.runs()).toBe(0);
  }, 60_000);

  it("builds in every job, with no wait running out, while the installed launcher still files builds by their key alone", async () => {
    const { root } = project();
    const key = keyFor(root);
    const runner = launcher(["s1", "s2"], {});
    // what that launcher took in for this commit: no job of a run reads it
    store(runner.entries, key, built({ "index.html": "filed by the key alone" }), 1 << 30);
    // waits longer than this test may take: one that ran out would fail it
    const waits = { OVIS_BUILD_CACHE_PROMOTE_SECONDS: "300", OVIS_BUILD_CACHE_WAIT_SECONDS: "300" };
    const jobs = ["s1", "s2"].map((slot) => {
      const job = clone(root);
      return { ...job, proc: Bun.spawn([process.execPath, script], { cwd: job.copy, env: buildEnv(runner.entries, runner.job(slot, "7", waits)), stdout: "pipe", stderr: "pipe" }) };
    });
    const started = Date.now();
    // that launcher's pass: the entry is there by its key, so it drops the claim and gives its verdict
    await alongside(jobs.map(({ proc }) => proc), () => {
      for (const slot of ["s1", "s2"]) {
        const outbox = join(runner.outboxes, slot);
        if (!existsSync(join(outbox, `${key}.claim`))) continue;
        for (const name of [`${key}.claim`, `${key}.tar`]) rmSync(join(outbox, name), { force: true });
        mkdirSync(join(outbox, `judged-${key}`), { recursive: true });
      }
    });
    for (const job of jobs) {
      expect(await job.proc.exited).toBe(0);
      expect(job.runs()).toBe(1);
      expect(readFileSync(join(job.copy, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
      // the job's log says why nothing was restored
      expect(await new Response(job.proc.stdout).text()).toContain("was not filed under this run but by its key alone");
    }
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(readdirSync(runner.locks)).toEqual([]);
  }, 60_000);

  it("builds a commit once in a run even where the cache still holds it by its key alone, from before the launcher's update", async () => {
    const { root, runs } = project();
    const key = keyFor(root);
    const slots = ["s1", "s2", "s3"];
    // each of GitHub's answers half a second late: the build is under its run only well after it was handed in
    const runner = launcher(slots, { "7": { slots } }, 0.5);
    store(runner.entries, key, built({ "index.html": "filed by the key alone" }), 1 << 30);
    const jobs = slots.map((slot) => {
      const job = clone(root);
      return { ...job, proc: Bun.spawn([process.execPath, script], { cwd: job.copy, env: buildEnv(runner.entries, runner.job(slot, "7", { OVIS_BUILD_CACHE_PROMOTE_SECONDS: "30" })), stdout: "pipe", stderr: "pipe" }) };
    });
    await alongside(jobs.map(({ proc }) => proc), () => runner.pass());
    for (const { proc } of jobs) expect(await proc.exited).toBe(0);
    // the job that built waited for its build under the run, and the others for that entry: neither took the other for it
    expect(jobs.map((job) => job.runs()).reduce((a, b) => a + b, 0)).toBe(1);
    for (const { copy } of jobs) expect(readFileSync(join(copy, "dist/index.html"), "utf8")).toBe("export const a = 1;\n");
    // and the launcher of now removed what the earlier one had filed by the key alone
    expect(runner.filed().sort()).toEqual(["7/", `7/${key}`].sort());
    expect(runs()).toBe(0);
  }, 60_000);

  it("leaves a job from before entries were kept per run with a miss and its verdict, once the launcher files them per run", async () => {
    const runner = launcher(["s1"], { "7": { slots: ["s1"] } });
    const key = "a".repeat(64);
    const outbox = join(runner.outboxes, "s1");
    // what the launcher before had filed by the key alone, for whichever run handed it in
    store(runner.entries, key, built({ "index.html": "filed by the key alone, by another run" }), 1 << 30);
    deliver(outbox, key, built({ "index.html": "built by run 7" }), "7", "1");
    expect(runner.pass().status).toBe(0);
    expect(runner.filed()).toEqual(["7/", `7/${key}`]);
    // such a job reads the cache's root by the key alone: there is nothing there for it to take
    const dist = join(temp("ovis-build-cache-flat-"), "dist");
    expect(restore(runner.entries, key, dist)).toBe(false);
    expect(existsSync(dist)).toBe(false);
    // and its wait for the launcher ends on the verdict, long before its deadline
    const started = Date.now();
    await awaitBuild(runner.entries, key, 300_000, { verdict: join(outbox, `judged-${key}`) });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("evicts the least recently used entries across runs, with what an older launcher left, and removes a run's directory once it is empty", () => {
    const runner = launcher(["s1"], { "300": { slots: ["s1"] } });
    const [a, b, c, d, left, fresh] = ["a", "b", "c", "d", "e", "f"].map((letter) => letter.repeat(64)) as [string, string, string, string, string, string];
    const big = { "a.js": "x".repeat(600_000) };
    // each with the time its directory was written: run 100 and run 250 hold the same key
    const filed: [string, string, number][] = [["100", a, 1_000], ["250", a, 1_100], ["150", d, 1_200], ["", left, 1_500], ["200", b, 2_000], ["200", c, 2_500]];
    for (const [run, key, seconds] of filed) {
      store(join(runner.entries, run), key, built(big), 1 << 30);
      utimesSync(join(runner.entries, run, key), new Date(seconds * 1000), new Date(seconds * 1000));
    }
    // a stamp from an earlier restore of b
    mkdirSync(join(runner.base, "used"));
    writeFileSync(join(runner.base, "used", b), "");
    utimesSync(join(runner.base, "used", b), new Date(2_100_000), new Date(2_100_000));
    // a job restored a: the marker names the key alone, so it counts for both runs that hold it.
    // What the older launcher left goes at the pass's start, and a marker naming it stamps nothing.
    for (const key of [a, left]) writeFileSync(join(runner.outboxes, "s1", `used-${key}`), "");
    // a new build taken in, which is when the launcher evicts: 2 MiB hold three of the big ones
    deliver(join(runner.outboxes, "s1"), fresh, built({ "index.html": "<p>" }), "300", "1");
    expect(runner.pass("2").status).toBe(0);
    expect(runner.filed()).toEqual(["100/", `100/${a}`, "200/", `200/${c}`, "250/", `250/${a}`, "300/", `300/${fresh}`]);
    expect(readdirSync(join(runner.base, "used"))).toEqual([a]);
    expect(readdirSync(join(runner.outboxes, "s1"))).toEqual([`judged-${fresh}`]);
  });

  it("removes an entry whose directories its job left without the owner's write bit, and goes on to the next slot's build either way", () => {
    const runner = launcher(["s1"], { "9": { slots: ["s1"] } });
    const [left, key] = ["e".repeat(64), "a".repeat(64)];
    // what the launcher before filed by the key alone, holding a directory nothing can be removed from as it is
    store(runner.entries, left, built({ "index.html": "filed by the key alone" }), 1 << 30);
    mkdirSync(join(runner.entries, left, "assets"));
    writeFileSync(join(runner.entries, left, "assets", "app.js"), "export {};\n");
    chmodSync(join(runner.entries, left, "assets"), 0o555);
    deliver(join(runner.outboxes, "s1"), key, built({ "index.html": "built by run 9" }), "9", "1");
    try {
      expect(runner.pass().status).toBe(0);
      // the old entry is gone, and the pass did not end on it: the slot's build was judged and filed
      expect(runner.filed()).toEqual(["9/", `9/${key}`]);
      expect(readdirSync(join(runner.outboxes, "s1"))).toEqual([`judged-${key}`]);
    } finally {
      // were it still there, the test's own cleanup could not remove it either
      if (existsSync(join(runner.entries, left, "assets"))) chmodSync(join(runner.entries, left, "assets"), 0o755);
    }
  });

  it("files nothing for a claim whose run is no plain number, whatever GitHub would say of it", () => {
    const odd = ["../escape", "7/../8", "7/", "/7", "-7", "+7", "0x7", "7.0", "7e1", "1".repeat(21), "7 1"];
    const slots = odd.map((_, index) => `s${index}`);
    // a GitHub that vouches for every run it is asked about, on every slot
    const runner = launcher(slots, { any: { slots } });
    const before = readdirSync(runner.base).sort();
    odd.forEach((run, index) => deliver(join(runner.outboxes, slots[index]!), String(index).padStart(64, "a"), built({ "index.html": "<p>" }), run, "1"));
    expect(runner.pass().status).toBe(0);
    expect(runner.filed()).toEqual([]);
    // nothing beside entries/ either, and GitHub was never asked
    expect(readdirSync(runner.base).sort()).toEqual(before);
    expect(runner.asked()).toEqual([]);
    expect(slots.map((slot) => readdirSync(join(runner.outboxes, slot)))).toEqual(odd.map((_, index) => [`judged-${String(index).padStart(64, "a")}`]));
  });

  it("never files or evicts through a run's directory that is a link", () => {
    const runner = launcher(["s1", "s2"], { "7": { slots: ["s1"] }, "8": { slots: ["s2"] } });
    const [key, other] = ["a".repeat(64), "b".repeat(64)];
    // No job can make one (entries/ is mounted read-only in the runners). What it points at, were it followed:
    const outside = join(runner.base, "outside");
    mkdirSync(join(outside, "kept"), { recursive: true });
    writeFileSync(join(outside, "kept", "a.js"), "x".repeat(2_000_000));
    utimesSync(join(outside, "kept"), new Date(1_000_000), new Date(1_000_000));
    symlinkSync(outside, join(runner.entries, "7"));
    deliver(join(runner.outboxes, "s1"), key, built({ "index.html": "for run 7" }), "7", "1");
    // run 8's build is taken in, so this pass evicts too: down to 1 MiB
    deliver(join(runner.outboxes, "s2"), other, built({ "index.html": "for run 8" }), "8", "1");
    expect(runner.pass("1").status).toBe(0);
    expect(readdirSync(outside)).toEqual(["kept"]);
    expect(readdirSync(join(outside, "kept"))).toEqual(["a.js"]);
    expect(lstatSync(join(runner.entries, "7")).isSymbolicLink()).toBe(true);
    expect(runner.filed()).toEqual(["7", "8/", `8/${other}`]);
    expect(readdirSync(join(runner.outboxes, "s1"))).toEqual([`judged-${key}`]);
  });

  it("always builds without OVIS_BUILD_CACHE_DIR", () => {
    const { root, runs } = project();
    build(root, null);
    build(root, null);
    expect(runs()).toBe(2);
  }, 60_000);
});
