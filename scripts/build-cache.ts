/**
 * `bun run build`: the client build (`vite build` into dist/), reused from a cache the self-hosted
 * runner's jobs share when OVIS_BUILD_CACHE_DIR names one (scripts/self-hosted-runner/run.sh
 * --build-cache). Fast checks, Integration and both browser jobs build the same commit; with the
 * cache only the first pays for it. Without the variable this is `vite build`, nothing else.
 *
 * An entry is named after everything the build reads: the commit (every tracked file, bun.lock and
 * the patches included; the client also embeds its hash), Bun's version, the platform, the build's
 * arguments, the variables Vite or vite.config.ts read, and any .env file. A checkout with changes
 * git has not committed, or with ignored files where Vite reads, never reads or writes the cache.
 * node_modules is what `bun install --frozen-lockfile` makes of bun.lock.
 *
 * On the runner the cache is read-only: a build goes to OVIS_BUILD_CACHE_OUTBOX, and the launcher
 * moves it in only for a trusted run (build-cache-promote.sh), writing the manifest of every file's
 * sha256 that a restore checks. Without an outbox (a cache of one's own) the build is stored
 * directly. Any cache failure builds.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Raise when the entry layout or what the key covers changes: older entries then simply miss. */
const FORMAT = "2";
const MANIFEST = ".manifest";

export type Key = { key: string } | { bypass: string };

const git = (root: string, args: string[]): string | null => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout : null;
};

/** The variables that change what Vite writes: its VITE_* (import.meta.env), NODE_ENV, and vite.config.ts's own. */
const buildVariable = (name: string): boolean => name.startsWith("VITE_") || name === "NODE_ENV" || name === "HERDR_TEST_HOOKS";

export function cacheKey(root: string, env: Record<string, string | undefined>, args: readonly string[]): Key {
  // pull requests and main's pushes; the CI a Release run runs itself and manual runs always build
  // (a release validated by main's push run took that run's jobs, restored builds included)
  if (env["GITHUB_ACTIONS"] === "true" && env["GITHUB_EVENT_NAME"] !== "pull_request" && !(env["GITHUB_EVENT_NAME"] === "push" && env["GITHUB_REF"] === "refs/heads/main")) {
    return { bypass: "only pull request runs and pushes to main use it" };
  }
  const head = git(root, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
  if (!head) return { bypass: "no git commit" };
  const status = git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status === null) return { bypass: "git status failed" };
  if (status !== "") return { bypass: "the checkout has uncommitted changes" };
  // files git ignores where Vite reads (public/ is copied whole): not the commit's either
  const read = ["index.html", "vite.config.ts", "public", "scripts", "src", "shared"];
  // a link git tracks is unchanged to git when what it points at changes, and Vite follows it
  const staged = git(root, ["ls-files", "-s", "--", ...read]);
  if (staged === null) return { bypass: "git ls-files failed" };
  if (staged.split("\n").some((line) => line.startsWith("120000 "))) return { bypass: "a tracked link where the build reads" };
  const ignored = git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...read]);
  if (ignored === null) return { bypass: "git ls-files failed" };
  // the type declarations typecheck emits (shared/vendor/paseo-e2ee/dist) are never bundled
  if (ignored.split("\n").some((path) => path !== "" && !/^shared\/vendor\/[^/]+\/dist\/.+(?:\.d\.ts(?:\.map)?|\.tsbuildinfo)$/.test(path))) return { bypass: "ignored files where the build reads" };
  const hash = createHash("sha256");
  const part = (label: string, value: string | Buffer): void => { hash.update(`${label}\0${value.length}\0`).update(value); };
  part("format", FORMAT);
  part("commit", head);
  part("bun", `${Bun.version} ${Bun.revision}`);
  part("platform", `${process.platform} ${process.arch}`);
  part("args", JSON.stringify(args));
  for (const name of Object.keys(env).filter(buildVariable).sort()) part(`env ${name}`, env[name] ?? "");
  // Vite's envDir is the root: .env, .env.local, .env.<mode> and .env.<mode>.local (.env is ignored by git)
  for (const name of readdirSync(root).filter((entry) => entry.startsWith(".env")).sort()) {
    const content = readFileSync(join(root, name));
    // Vite expands $NAME from the environment, which the key does not cover
    if (content.includes("$")) return { bypass: `${name} refers to other variables` };
    part(`file ${name}`, content);
  }
  return { key: hash.digest("hex") };
}

/** Every file under `dir` by its path from there (`./a/b`), with its sha256; throws on anything but files and directories. */
function hashes(dir: string, at = "."): Map<string, string> {
  const found = new Map<string, string>();
  for (const name of readdirSync(join(dir, at))) {
    const path = `${at}/${name}`;
    const stat = lstatSync(join(dir, path));
    if (stat.isDirectory()) for (const [inner, sum] of hashes(dir, path)) found.set(inner, sum);
    else if (stat.isFile()) found.set(path, createHash("sha256").update(readFileSync(join(dir, path))).digest("hex"));
    else throw new Error(`${path} is not a file or a directory`);
  }
  return found;
}

/** The manifest's lines, as `sha256sum` writes them: `<sha256>  ./path`. */
const manifestOf = (sums: Map<string, string>): string => [...sums].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, sum]) => `${sum}  ${path}\n`).join("");

function parseManifest(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}(\.\/.+)$/.exec(line);
    if (!match) throw new Error("the entry's manifest is malformed");
    sums.set(match[2]!, match[1]!);
  }
  return sums;
}

/**
 * Puts the entry's files at `dist`, replacing what is there, once every file matches its manifest
 * (and nothing else is there: no link, no file it does not name). False when there is no entry.
 */
export function restore(cacheDir: string, key: string, dist: string, outbox?: string): boolean {
  const entry = join(cacheDir, key);
  if (!existsSync(join(entry, MANIFEST))) return false;
  // beside dist/ (one file system, for the rename), under a directory git ignores: a crash leaves the checkout clean
  const scratch = join(dirname(dist), "node_modules", ".cache");
  mkdirSync(scratch, { recursive: true });
  const staging = mkdtempSync(join(scratch, "ovis-build-cache-restore-"));
  try {
    cpSync(entry, staging, { recursive: true, verbatimSymlinks: true });
    const expected = parseManifest(readFileSync(join(staging, MANIFEST), "utf8"));
    rmSync(join(staging, MANIFEST), { force: true });
    if (manifestOf(hashes(staging)) !== manifestOf(expected)) throw new Error("the entry's files do not match its manifest");
    // mkdtemp's 0700, which a fresh build's dist/ does not have
    chmodSync(staging, 0o755);
    rmSync(dist, { recursive: true, force: true });
    renameSync(staging, dist);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  // its last use, which eviction goes by: a read-only cache hears of it through the job's own outbox,
  // never a directory other jobs write (a link planted there would be written through)
  const now = new Date();
  try {
    if (outbox) writeFileSync(join(outbox, `used-${key}`), "");
    else utimesSync(entry, now, now);
  } catch { /* evicted or unwritable: the use goes unrecorded */ }
  return true;
}

const treeBytes = (dir: string): number => readdirSync(dir).reduce((total, name) => {
  const stat = lstatSync(join(dir, name));
  return total + (stat.isDirectory() ? treeBytes(join(dir, name)) : stat.size);
}, 0);

/** Copies `dist` in as the entry for `key`, with its manifest (unless another job has written it first), then evicts. */
export function store(cacheDir: string, key: string, dist: string, maxBytes: number): void {
  mkdirSync(cacheDir, { recursive: true });
  const entry = join(cacheDir, key);
  // its own file of that name would be taken for the manifest: such a build is not cached
  if (existsSync(join(dist, MANIFEST))) return;
  if (!existsSync(entry)) {
    const staging = mkdtempSync(join(cacheDir, `.new-${process.pid}-`));
    try {
      cpSync(dist, staging, { recursive: true, verbatimSymlinks: true });
      writeFileSync(join(staging, MANIFEST), manifestOf(hashes(staging)));
      renameSync(staging, entry);
    } catch {
      // another job renamed the same entry into place first, or the cache is full: theirs stands
      rmSync(staging, { recursive: true, force: true });
    }
  }
  evict(cacheDir, maxBytes);
}

/**
 * Leaves `dist` in `outbox` for the launcher to take in for `key`: `<key>.tar`, then `<key>.claim`
 * naming the run, which the launcher checks with GitHub before it trusts the build.
 */
export function deliver(outbox: string, key: string, dist: string, run: string, attempt: string): void {
  const tar = join(outbox, `${key}.tar`);
  const partial = join(outbox, `.${key}.tar-${process.pid}`);
  const packed = spawnSync("tar", ["-cf", partial, "-C", dist, "."], { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (packed.status !== 0) { rmSync(partial, { force: true }); throw new Error(`tar failed: ${packed.stderr.trim()}`); }
  renameSync(partial, tar);
  writeFileSync(join(outbox, `.${key}.claim-${process.pid}`), `${run} ${attempt}\n`);
  renameSync(join(outbox, `.${key}.claim-${process.pid}`), join(outbox, `${key}.claim`));
}

/** Removes the least recently used entries until the rest fit in `maxBytes`, and staging left by a crash. */
export function evict(cacheDir: string, maxBytes: number): void {
  const entries: { path: string; used: number; size: number }[] = [];
  for (const name of readdirSync(cacheDir)) {
    const path = join(cacheDir, name);
    try {
      const stat = statSync(path);
      if (name.startsWith(".new-") || name.startsWith(".lock-")) {
        if (Date.now() - stat.mtimeMs > 3_600_000) rmSync(path, { recursive: true, force: true });
        continue;
      }
      if (!existsSync(join(path, MANIFEST))) continue;
      entries.push({ path, used: stat.mtimeMs, size: treeBytes(path) });
    } catch { /* removed by another job meanwhile */ }
  }
  entries.sort((a, b) => b.used - a.used);
  let total = 0;
  for (const entry of entries) {
    total += entry.size;
    if (total > maxBytes) rmSync(entry.path, { recursive: true, force: true });
  }
}

/**
 * Takes the build of `key` for this job (a directory made atomically), so the jobs of one commit that
 * start together do not all build it. A lock older than `staleMs` was left by a job that died: taken over.
 */
/** Longer than a build under load takes, shorter than a waiter's default wait (300 s); the holder refreshes it. */
export const STALE_LOCK_MS = 240_000;
const OWNER = "owner";

/**
 * Takes the build of `key` for this job (a directory made atomically, holding a token of its own), so
 * the jobs of one commit that start together do not all build it. A lock not refreshed for `staleMs`
 * was left by a job that died: taken over. Returns the token, or null when another job holds it.
 */
export function takeLock(lockDir: string, key: string, staleMs = STALE_LOCK_MS): string | null {
  const lock = join(lockDir, `.lock-${key}`);
  const token = `${process.pid}-${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, OWNER), token);
      return token;
    } catch (error) {
      // a full or broken lock directory is no lock another job holds: build without waiting
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs <= staleMs) return null;
        rmSync(lock, { recursive: true, force: true });
      } catch { /* released meanwhile: try again */ }
    }
  }
  return null;
}

const holds = (lockDir: string, key: string, token: string): boolean => {
  try { return readFileSync(join(lockDir, `.lock-${key}`, OWNER), "utf8") === token; } catch { return false; }
};

/** Keeps the lock this job holds from going stale while it builds and hands the build over. */
export function refreshLock(lockDir: string, key: string, token: string): void {
  const now = new Date();
  try { if (holds(lockDir, key, token)) utimesSync(join(lockDir, `.lock-${key}`), now, now); } catch { /* gone: nothing to refresh */ }
}

/** Removes the lock if this job still holds it, never one another job took over. Never fails the build. */
export function releaseLock(lockDir: string, key: string, token: string): void {
  try { if (holds(lockDir, key, token)) rmSync(join(lockDir, `.lock-${key}`), { recursive: true, force: true }); } catch (error) {
    console.log(`build cache: could not release the lock of ${key.slice(0, 12)} (${(error as Error).message})`);
  }
}

/**
 * Waits until the entry for `key` is in the cache, or `ms` pass, or: with `lock`, that lock is gone or
 * stale; with `verdict`, the launcher has made that directory, once it took the build in or refused it.
 */
export async function awaitBuild(cacheDir: string, key: string, ms: number, until: { lock?: string; verdict?: string; staleMs?: number }): Promise<void> {
  const { lock, verdict, staleMs = STALE_LOCK_MS } = until;
  // a lock left by a job that was killed goes stale long before the wait ends: takeLock takes it over
  const unlocked = (): boolean => { try { return Date.now() - statSync(lock!).mtimeMs > staleMs; } catch { return true; } };
  const settled = (): boolean => existsSync(join(cacheDir, key, MANIFEST)) || (lock !== undefined && unlocked()) || (verdict !== undefined && existsSync(verdict));
  const deadline = Date.now() + ms;
  while (!settled() && Date.now() < deadline) await Bun.sleep(200);
}

/**
 * Whether the launcher could take in this job's build: a push to main, or a pull request of this
 * repository that `writer` opened and started (build-cache-promote.sh decides; this only spares an
 * untrusted run the wait for a build that would be refused). Outside GitHub Actions: yes.
 */
export function mayWrite(env: Record<string, string | undefined>, writer: string | undefined): boolean {
  if (env["GITHUB_ACTIONS"] !== "true") return true;
  if (env["GITHUB_EVENT_NAME"] === "push") return env["GITHUB_REF"] === "refs/heads/main";
  if (env["GITHUB_EVENT_NAME"] !== "pull_request" || !writer || env["GITHUB_TRIGGERING_ACTOR"] !== writer) return false;
  try {
    const event = JSON.parse(readFileSync(env["GITHUB_EVENT_PATH"] ?? "", "utf8")) as { pull_request?: { user?: { login?: string }; head?: { repo?: { full_name?: string } } } };
    return event.pull_request?.user?.login === writer && event.pull_request?.head?.repo?.full_name === env["GITHUB_REPOSITORY"];
  } catch {
    return false;
  }
}

function viteBuild(args: readonly string[]): number {
  const result = spawnSync(process.execPath, ["--bun", "vite", "build", ...args], { stdio: "inherit" });
  return result.status ?? 1;
}

/** `vite build` without blocking this process, so the lock's heartbeat keeps running meanwhile. */
async function viteBuildAsync(args: readonly string[]): Promise<number> {
  return Bun.spawn([process.execPath, "--bun", "vite", "build", ...args], { stdio: ["inherit", "inherit", "inherit"] }).exited;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cacheDir = process.env["OVIS_BUILD_CACHE_DIR"];
  if (!cacheDir) process.exit(viteBuild(args));
  const outbox = process.env["OVIS_BUILD_CACHE_OUTBOX"];
  const lockDir = process.env["OVIS_BUILD_CACHE_LOCKS"] ?? cacheDir;
  const root = process.cwd();
  const dist = join(root, "dist");
  const maxBytes = Number(process.env["OVIS_BUILD_CACHE_MAX_MB"] ?? "2048") * 1024 * 1024;
  const keyNow = (): Key => {
    try { return cacheKey(root, process.env, args); } catch (error) { return { bypass: `no key (${(error as Error).message})` }; }
  };
  // only the build into dist/: another outDir or mode is built as asked
  const key: Key = args.length === 0 ? keyNow() : { bypass: "build arguments given" };
  if ("bypass" in key) {
    console.log(`build cache: not used (${key.bypass})`);
    process.exit(viteBuild(args));
  }
  const name = key.key.slice(0, 12);
  const restored = (): boolean => {
    try {
      if (!restore(cacheDir, key.key, dist, outbox)) return false;
      console.log(`build cache: hit ${name}, dist/ restored without building`);
      return true;
    } catch (error) {
      console.log(`build cache: could not restore ${name} (${(error as Error).message})`);
      return false;
    }
  };
  if (restored()) process.exit(0);
  if (!mayWrite(process.env, process.env["OVIS_BUILD_CACHE_WRITER"])) {
    // nothing this run builds is taken in, so none of its jobs waits for another's
    console.log(`build cache: miss ${name}; building (this run does not write the cache)`);
    process.exit(viteBuild(args));
  }
  let owner: string | null = null;
  try {
    mkdirSync(lockDir, { recursive: true });
    owner = takeLock(lockDir, key.key);
    if (!owner) {
      // another job of this commit is building it: a wait costs no CPU, a second build does
      console.log(`build cache: another job is building ${name}; waiting for it`);
      await awaitBuild(cacheDir, key.key, Number(process.env["OVIS_BUILD_CACHE_WAIT_SECONDS"] ?? "300") * 1000, { lock: join(lockDir, `.lock-${key.key}`) });
      if (restored()) process.exit(0);
      owner = takeLock(lockDir, key.key);
    }
  } catch (error) {
    console.log(`build cache: could not lock ${name} (${(error as Error).message})`);
  }
  console.log(`build cache: miss ${name}; building`);
  const heartbeat = owner ? setInterval(() => refreshLock(lockDir, key.key, owner!), 30_000) : undefined;
  const code = await viteBuildAsync(args);
  // the checkout changed while Vite read it: this dist/ may not be the key's
  const after = code === 0 ? keyNow() : key;
  if (code === 0 && (!("key" in after) || after.key !== key.key)) console.log("build cache: the checkout changed during the build; not stored");
  else if (code === 0 && outbox) {
    const run = process.env["GITHUB_RUN_ID"] ?? "";
    const attempt = process.env["GITHUB_RUN_ATTEMPT"] ?? "";
    try {
      if (!/^\d+$/.test(run) || !/^\d+$/.test(attempt)) throw new Error("no GitHub run to name");
      deliver(outbox, key.key, dist, run, attempt);
      // the jobs waiting on the lock restore once the launcher has taken it in; its verdict says it decided
      await awaitBuild(cacheDir, key.key, Number(process.env["OVIS_BUILD_CACHE_PROMOTE_SECONDS"] ?? "60") * 1000, { verdict: join(outbox, `judged-${key.key}`) });
      console.log(existsSync(join(cacheDir, key.key, MANIFEST)) ? `build cache: stored ${name}` : `build cache: ${name} was not taken in (only trusted runs write the cache)`);
    } catch (error) {
      console.log(`build cache: could not hand ${name} over (${(error as Error).message})`);
    }
  } else if (code === 0) {
    try { store(cacheDir, key.key, dist, maxBytes); } catch (error) { console.log(`build cache: could not store (${(error as Error).message})`); }
  }
  clearInterval(heartbeat);
  if (owner) releaseLock(lockDir, key.key, owner);
  process.exit(code);
}
