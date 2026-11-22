/**
 * Nothing in the install changes until the
 * manifest's signature by the committed key (RELEASE_PUBLIC_KEY), its version, and the size and SHA-256 of every file
 * it names have been checked; then one rename makes the new release the one that runs:
 *
 *   <home>/bin -> releases/<version>-<id>   the release that runs: ovis-server(.exe), dist/, the manifest and its
 *                                           signature as they were checked, and bin/ovis-pty-sidecar(.json): the
 *                                           Rust PTY host the signed manifest names, when it runs here
 *   <home>/releases/.stage-<id>             a download in progress; one an interrupted run left is removed first
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runsHere } from "./pty-sidecar.ts";
import { binaryName, checkManifest, DIST_ARCHIVE, MANIFEST, oldShapeRelease, ptyAssetFor, RELEASE_PUBLIC_KEY, type ReleaseAsset, releaseFile, SERVER_PLATFORMS, type ServerPlatform, SIGNATURE } from "./server-manifest.ts";

export const DEFAULT_RELEASES = "https://github.com/devswha/ovis/releases/download";
const MANIFEST_LIMIT = 64 * 1024;
const SIGNATURE_LIMIT = 1024;
const WINDOWS = process.platform === "win32";

export function releasesBase(value: string | undefined): string {
  const base = (value === undefined || value === "" ? DEFAULT_RELEASES : value).replace(/\/+$/, "");
  if (/^https:\/\/[^/]/.test(base) || base.startsWith("file:///")) return base;
  throw new Error(`OVIS_RELEASES_URL must be an https:// address or a file:// folder (file:///path); ${base} is neither`);
}

export function hostPlatform(): ServerPlatform | null {
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  return (SERVER_PLATFORMS as readonly string[]).includes(platform) ? platform as ServerPlatform : null;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The release of this version ships no compiled server: its ovis-server.json is not there (HTTP 404, or no such file in
 * a file:// folder). Only this, never a manifest that exists and fails a check, a server error or a network failure,
 * lets a caller fall back to building from source.
 */
export class NoBinaryRelease extends Error {}

/**
 * The bytes at `url`, refused once they pass `limit` (a file larger than its manifest says is never read whole), or
 * null where there is no such file (HTTP 404). Redirects are followed by hand: one to anything but https is refused
 * before a request is made to it.
 */
export async function download(url: string, limit: number, name: string, fetchFile: typeof fetch = fetch): Promise<Uint8Array | null> {
  const tooLarge = () => new Error(`${name} is larger than the ${limit} bytes ${MANIFEST} names; nothing was changed`);
  if (url.startsWith("file://")) {
    const path = fileURLToPath(url);
    if (!existsSync(path)) return null;
    if (statSync(path).size > limit) throw tooLarge();
    return readFileSync(path);
  }
  let response: Response;
  let at = url;
  for (let hops = 0; ; hops++) {
    response = await fetchFile(at, { redirect: "manual", signal: AbortSignal.timeout(600_000) });
    if (response.status < 300 || response.status > 399) break;
    const next = new URL(response.headers.get("location") ?? "", at).href;
    if (!next.startsWith("https://")) throw new Error(`${url} redirected to ${next}, which is not https; nothing was changed`);
    if (hops >= 10) throw new Error(`${url} redirected more than 10 times; nothing was changed`);
    at = next;
  }
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error(`${url}: HTTP ${response.status}; nothing was changed`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The Rust PTY host the signed manifest names for `platform`, into `bin` with the record server/pty/host.ts checks, and
 * only after its size and SHA-256 match the manifest and it runs here: no other file's word for a host is taken. Any
 * failure leaves no host, and terminals mirrored; it never fails the install.
 */
async function ptyHost(at: string, hosts: Record<string, ReleaseAsset>, platform: ServerPlatform, version: string, bin: string, options: InstallServerOptions): Promise<string> {
  const build = ptyAssetFor(platform);
  if (!build) return "no Rust PTY host on this platform";
  let bytes: Uint8Array;
  try { bytes = await checked(at, hosts[build]!, options.fetchFile); }
  catch (error) { return `the Rust PTY host was not taken (${(error as Error).message}), so terminals are mirrored`; }
  mkdirSync(bin, { recursive: true });
  const target = join(bin, "ovis-pty-sidecar");
  writeFileSync(target, bytes, { mode: 0o755 });
  chmodSync(target, 0o755);
  if (!(options.ptyRuns ?? runsHere)(target)) {
    rmSync(bin, { recursive: true, force: true });
    return "the Rust PTY host does not run on this PC, so terminals are mirrored";
  }
  writeFileSync(`${target}.json`, `${JSON.stringify({ sha256: hosts[build]!.sha256, version })}\n`);
  return "the Rust PTY host checked against ovis-server.json";
}

/** `asset` from the release at `at`, only when its size and SHA-256 are what the checked manifest names. */
async function checked(at: string, asset: ReleaseAsset, fetchFile?: typeof fetch): Promise<Uint8Array> {
  const bytes = await download(`${at}/${asset.file}`, asset.size, asset.file, fetchFile);
  if (!bytes) throw new Error(`${at}/${asset.file} does not exist; nothing was changed`);
  if (bytes.length !== asset.size) throw new Error(`${asset.file} is ${bytes.length} bytes, not the ${asset.size} ${MANIFEST} names; nothing was changed`);
  const digest = sha256(bytes);
  if (digest !== asset.sha256) throw new Error(`${asset.file} does not match its SHA-256 in ${MANIFEST} (got ${digest}); nothing was changed`);
  return bytes;
}

/**
 * Unpacks the client archive into `into`, after its listing shows only plain files and folders inside it: no absolute
 * path, no `..`, no link, so a crafted archive cannot write outside the release folder.
 */
function unpack(archive: string, into: string): void {
  const tar = (...args: string[]) => {
    const result = Bun.spawnSync(["tar", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 120_000 });
    if (result.exitCode !== 0) throw new Error(`tar ${args[0]} ${DIST_ARCHIVE} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}; nothing was changed`);
    return result.stdout.toString();
  };
  for (const name of tar("-tzf", archive).split("\n").filter(Boolean)) {
    if (/^([/\\]|[A-Za-z]:)/.test(name) || name.split(/[/\\]/).includes("..")) throw new Error(`${DIST_ARCHIVE} holds ${name}, a path outside its folder; nothing was changed`);
  }
  for (const line of tar("-tzvf", archive).split("\n").filter(Boolean)) {
    if (!/^[-d]/.test(line)) throw new Error(`${DIST_ARCHIVE} holds something other than files and folders (${line.trim()}); nothing was changed`);
  }
  mkdirSync(into, { recursive: true });
  tar("-xzf", archive, "-C", into, "--no-same-owner");
  for (const entry of readdirSync(into, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() && !entry.isDirectory()) throw new Error(`${DIST_ARCHIVE} unpacked something other than files and folders; nothing was changed`);
  }
  if (!existsSync(join(into, "index.html"))) throw new Error(`${DIST_ARCHIVE} holds no index.html; nothing was changed`);
}

/** Windows: a run cut off between its two renames left no bin; the release it moved aside is put back. */
function recover(home: string): void {
  const current = join(home, "bin");
  if (existsSync(current)) return;
  const aside = readdirSync(home).filter((name) => name.startsWith("bin.old-")).sort();
  if (aside.length > 0) renameSync(join(home, aside.at(-1)!), current);
}

function swap(home: string, name: string): void {
  const current = join(home, "bin");
  const release = join(home, "releases", name);
  // On Windows, where a link needs rights a user may not have, bin is the release folder itself, moved in by two
  // renames (the old one aside, the new one in); a run cut off between them finds the old one and moves it back.
  if (WINDOWS) {
    const aside = `${current}.old-${randomBytes(4).toString("hex")}`;
    if (existsSync(current)) renameSync(current, aside);
    try {
      renameSync(release, current);
    } catch (error) {
      if (existsSync(aside)) renameSync(aside, current);
      throw error;
    }
    rmSync(aside, { recursive: true, force: true });
    return;
  }
  if (existsSync(current) && !lstatSync(current).isSymbolicLink()) {
    throw new Error(`${current} is a folder this installer did not make, so it was left as it is; move it away and try again. Nothing was changed`);
  }
  const link = join(home, `.bin-${randomBytes(4).toString("hex")}`);
  symlinkSync(join("releases", name), link);
  try {
    renameSync(link, current);
  } catch (error) {
    rmSync(link, { force: true });
    throw error;
  }
}

export const LOCK_WAIT_MS = 600_000;
const UNCLAIMED_MS = 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};
const holderOf = (lock: string): number | null => {
  try {
    const pid = Number(readFileSync(join(lock, "pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};
function stale(lock: string): boolean {
  const pid = holderOf(lock);
  if (pid !== null) return !alive(pid);
  try { return Date.now() - statSync(lock).mtimeMs > UNCLAIMED_MS; } catch { return false; }
}

/**
 * A lock found stale is broken under `.install.lock.break`, so two waiters
 * that both saw it stale cannot both remove it, and the one that comes second sees the new holder's pid and waits.
 */
export async function withInstallLock<T>(home: string, run: () => Promise<T>, waitMs = LOCK_WAIT_MS, onWait?: () => void): Promise<T> {
  mkdirSync(home, { recursive: true });
  const lock = join(home, ".install.lock");
  const breaker = `${lock}.break`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let broke = false;
    try {
      mkdirSync(breaker);
      try {
        // removed only while it still holds the record judged stale: a fresh holder's lock is never taken
        const judged = holderOf(lock);
        if (stale(lock) && holderOf(lock) === judged) {
          rmSync(lock, { recursive: true, force: true });
          broke = true;
        }
      } finally {
        try { rmdirSync(breaker); } catch {}
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(breaker).mtimeMs > UNCLAIMED_MS) rmdirSync(breaker); } catch {}
    }
    if (broke) continue;
    onWait?.();
    if (Date.now() >= deadline) throw new Error(`another install is running in ${home} (pid ${holderOf(lock) ?? "unknown"}); try again once it ends. Nothing was changed`);
    await Bun.sleep(200);
  }
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);
  try {
    return await run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Whether `binary` has the SHA-256 `digest`. Hashing a whole binary costs about 100 ms, on every plugin command, so a
 * match is remembered in <home>/.verified.json with the file's size, mtime and inode: the hash is taken again whenever
 * any of them, or the digest asked for, differs.
 */
function binaryMatches(home: string, binary: string, digest: string): boolean {
  const { size, mtimeMs, ino } = statSync(binary);
  const seen = join(home, ".verified.json");
  const stamp = JSON.stringify({ digest, size, mtimeMs, ino });
  try { if (readFileSync(seen, "utf8") === stamp) return true; } catch {}
  if (sha256(readFileSync(binary)) !== digest) return false;
  remember(home, binary, digest);
  return true;
}

function remember(home: string, binary: string, digest: string): void {
  try {
    const { size, mtimeMs, ino } = statSync(binary);
    writeFileSync(join(home, ".verified.json"), JSON.stringify({ digest, size, mtimeMs, ino }));
  } catch {}
}

/**
 * The binary of the release installed in `home`, when it is `version`'s and still what its manifest vouches for: the
 * manifest kept beside it is signed by `publicKey` and names `version`, and the binary has its SHA-256. A folder that
 * fails any of these is never run.
 */
export function verifiedInstall(home: string, version: string, platform: ServerPlatform, publicKey = RELEASE_PUBLIC_KEY): string | null {
  const current = join(home, "bin");
  try {
    const manifest = checkManifest(readFileSync(join(current, MANIFEST)), readFileSync(join(current, SIGNATURE), "utf8"), publicKey, { version });
    const binary = join(current, binaryName(platform));
    if (typeof manifest !== "string" && binaryMatches(home, binary, manifest.assets[platform].sha256) && existsSync(join(current, "dist", "index.html"))) return binary;
  } catch {}
  return null;
}

export interface InstallServerOptions {
  home: string;
  version: string;
  platform?: ServerPlatform;
  releases?: string;
  /** a test's own key; the launcher passes none, so only RELEASE_PUBLIC_KEY is trusted */
  publicKey?: string;
  ptyRuns?: (path: string) => boolean;
  inWindow?: () => Promise<void>;
  /** the git trees of the checkout that asks (scripts/plugin-launch.ts): its binary only when the manifest names them */
  sources?: { server: string; shared: string } | { error: string };
  lockWaitMs?: number;
  onLockWait?: () => void;
  fetchFile?: typeof fetch;
}

export async function installServer(options: InstallServerOptions): Promise<{ installed: boolean; message: string; binary: string }> {
  const platform = options.platform ?? hostPlatform();
  if (!platform) throw new Error(`no release has a server binary for ${process.platform}-${process.arch}`);
  const base = releasesBase(options.releases ?? process.env["OVIS_RELEASES_URL"]);
  const { home, version } = options;
  const publicKey = options.publicKey ?? RELEASE_PUBLIC_KEY;
  const current = join(home, "bin");
  const binary = join(current, binaryName(platform));
  if (verifiedInstall(home, version, platform, publicKey)) return { installed: false, message: `Ovis ${version} is installed already in ${current}; nothing to do`, binary };
  return await withInstallLock(home, () => installLocked(options, platform, base, publicKey), options.lockWaitMs, options.onLockWait);
}

async function installLocked(options: InstallServerOptions, platform: ServerPlatform, base: string, publicKey: string): Promise<{ installed: boolean; message: string; binary: string }> {
  const { home, version } = options;
  const releases = join(home, "releases");
  mkdirSync(releases, { recursive: true });
  recover(home);
  for (const leftover of readdirSync(releases).filter((name) => name.startsWith(".stage-"))) rmSync(join(releases, leftover), { recursive: true, force: true });
  const current = join(home, "bin");
  const binary = join(current, binaryName(platform));
  if (verifiedInstall(home, version, platform, publicKey)) return { installed: false, message: `Ovis ${version} is installed already in ${current}; nothing to do`, binary };
  // sources nothing ties to a release (no git, no checkout, changes not committed) take no binary whatever the release
  // holds: it is not asked, so one out of reach does not stop them
  const sources = options.sources;
  if (sources && "error" in sources) throw new NoBinaryRelease(`the release's binary is not taken for this checkout (${sources.error})`);

  const at = `${base}/v${version}`;
  const manifestBytes = await download(`${at}/${MANIFEST}`, MANIFEST_LIMIT, MANIFEST, options.fetchFile);
  if (!manifestBytes) throw new NoBinaryRelease(`the release v${version} ships no compiled server (${at}/${MANIFEST} does not exist)`);
  const signature = await download(`${at}/${SIGNATURE}`, SIGNATURE_LIMIT, SIGNATURE, options.fetchFile);
  if (!signature) throw new Error(`${at}/${SIGNATURE} does not exist; nothing was changed`);
  const manifest = checkManifest(Buffer.from(manifestBytes), new TextDecoder().decode(signature), publicKey, { version });
  if (typeof manifest === "string") {
    if (oldShapeRelease(Buffer.from(manifestBytes), new TextDecoder().decode(signature), publicKey, version)) {
      throw new NoBinaryRelease(`the release v${version} ships no compiled server this installer runs (its signed ${MANIFEST} has the shape from before schema 1)`);
    }
    throw new Error(`${manifest}; nothing was changed`);
  }
  if (sources && (sources.server !== manifest.sources.server || sources.shared !== manifest.sources.shared)) {
    throw new NoBinaryRelease(`this checkout's server/ and shared/ are not the ones v${version} was built from (other git trees)`);
  }

  const stage = mkdtempSync(join(releases, ".stage-"));
  const name = `${version}-${randomBytes(4).toString("hex")}`;
  let host = "";
  let previous: string | null = null;
  try {
    writeFileSync(join(stage, binaryName(platform)), await checked(at, manifest.assets[platform], options.fetchFile), { mode: 0o755 });
    chmodSync(join(stage, binaryName(platform)), 0o755);
    writeFileSync(join(stage, DIST_ARCHIVE), await checked(at, manifest.dist, options.fetchFile));
    unpack(join(stage, DIST_ARCHIVE), join(stage, "dist"));
    rmSync(join(stage, DIST_ARCHIVE));
    writeFileSync(join(stage, MANIFEST), manifestBytes);
    writeFileSync(join(stage, SIGNATURE), signature);
    host = `; ${await ptyHost(at, manifest.pty, platform, version, join(stage, "bin"), options)}`;
    await options.inWindow?.();
    // the release bin names now: a server started from it may still run, so it stays until the next install
    try { previous = WINDOWS ? null : realpathSync(join(home, "bin")).split(/[/\\]/).at(-1)!; } catch { previous = null; }
    renameSync(stage, join(releases, name));
    try {
      swap(home, name);
      remember(home, join(home, "bin", binaryName(platform)), manifest.assets[platform].sha256);
    } catch (error) {
      rmSync(join(releases, name), { recursive: true, force: true });
      throw error;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  // the releases that no longer run, never the one bin names; on Linux and macOS a server still running from one keeps
  // its open files
  for (const old of readdirSync(releases).filter((entry) => entry !== name && entry !== previous && !entry.startsWith("."))) {
    try { rmSync(join(releases, old), { recursive: true, force: true }); } catch {}
  }
  return { installed: true, message: `installed Ovis ${version} (${releaseFile(platform)}, sha256 ${manifest.assets[platform].sha256}) in ${current}${host}`, binary };
}
