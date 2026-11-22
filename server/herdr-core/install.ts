/**
 * Installing herdr-core (`hc`) for a person who asked for it in Settings, the way its own installer
 * does (releases.herdr.dev/core/install.sh): the release archive for this PC, checked against its
 * SHA-256, then `herdr-core` copied into ~/.local/bin, with `hc` linked beside it only when no `hc`
 * is there. No sudo, and nothing of herdr's TUI is touched.
 *
 * Unlike that installer, the version and its checksums are pinned here (the desktop app carries the
 * same hc: app/electron/scripts/runtimes.ts), so a click never runs whatever the release server
 * hands out that day. Nothing already installed is replaced: a `herdr-core` in ~/.local/bin, even
 * one that does not answer, refuses the install. A failure leaves ~/.local/bin as it was.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hcVersion } from "./discovery.ts";

type Env = Record<string, string | undefined>;

export interface HcRelease {
  version: string;
  /** per `<platform>-<arch>` as Node names them: the archive and its SHA-256 (releases.herdr.dev/core/<version>/manifest.json) */
  targets: Partial<Record<string, { url: string; sha256: string }>>;
}

const file = (name: string) => `https://releases.herdr.dev/core/0.1.17/herdr-core-${name}.tar.gz`;
export const HC_RELEASE: HcRelease = {
  version: "0.1.17",
  targets: {
    "linux-x64": { url: file("linux-x86_64"), sha256: "82ec44043f6894bfdb716b979b87cda43fd7fa46b0104e7b7bd93e64d1a9b877" },
    "linux-arm64": { url: file("linux-aarch64"), sha256: "3a37a454ec63494cf4306db26481fe9db96673d888723701d24f8a992ae8ab8c" },
    "darwin-x64": { url: file("macos-x86_64"), sha256: "e2dc3211edb1f1c77d0e73dd76c1426636d71050f34a5303916a56d363d7062b" },
    "darwin-arm64": { url: file("macos-aarch64"), sha256: "cedbd4d4d9ba1385588198dd4d3c67d2654478f33add5b6445d4d0eb9da5fcf3" },
  },
};

/** an hc archive is about 3 MB: anything far larger is not the release */
const ARCHIVE_LIMIT = 64 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface InstallHcOptions {
  home: string;
  env?: Env;
  platform?: NodeJS.Platform;
  arch?: string;
  release?: HcRelease;
  fetch?: typeof fetch;
}

export function hcInstallTarget(release: HcRelease = HC_RELEASE, platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  return release.targets[`${platform}-${arch}`] ?? null;
}

export interface InstalledHc {
  path: string;
  undo: () => void;
}

export async function installHc(options: InstallHcOptions): Promise<InstalledHc> {
  const release = options.release ?? HC_RELEASE;
  const env = options.env ?? process.env;
  const target = hcInstallTarget(release, options.platform, options.arch);
  if (target === null) throw new Error(`herdr-core has no build for ${options.platform ?? process.platform}-${options.arch ?? process.arch}`);
  if (options.home === "") throw new Error("no home folder to install herdr-core into (HOME is not set)");
  const bin = join(options.home, ".local", "bin");
  const dest = join(bin, "herdr-core");
  if (present(dest)) throw new Error(`${dest} is already there; Ovis does not replace it`);

  const response = await (options.fetch ?? fetch)(target.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`downloading herdr-core failed (HTTP ${response.status})`);
  const archive = await boundedBody(response, ARCHIVE_LIMIT);
  if (createHash("sha256").update(archive).digest("hex") !== target.sha256) throw new Error("the herdr-core download does not match its checksum");

  const work = mkdtempSync(join(tmpdir(), "ovis-hc-"));
  let mark: string;
  try {
    // unzipped here: GNU tar would need a gzip on the PATH
    writeFileSync(join(work, "hc.tar"), Bun.gunzipSync(archive));
    // the member named, nothing else: the archive's other files are its license and notices
    // a service's PATH may be bare: tar is in /usr/bin on every Linux and macOS
    const tarBin = Bun.which("tar", { PATH: env["PATH"] ?? "" }) ?? "/usr/bin/tar";
    const tar = Bun.spawn([tarBin, "-xf", join(work, "hc.tar"), "-C", work, "herdr-core"], { stdin: "ignore", stdout: "ignore", stderr: "pipe", env });
    const [code, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
    if (code !== 0) throw new Error(`unpacking herdr-core failed: ${stderr.trim() || `tar exited ${code}`}`);
    const unpacked = join(work, "herdr-core");
    chmodSync(unpacked, 0o755);
    // `--version` is the only hc command that never starts a core
    const answered = (version: string | null) => `it answered ${version === null ? "nothing" : `hc ${version}`}`;
    const version = await hcVersion(unpacked, env, 10_000);
    if (version !== release.version) throw new Error(`the downloaded herdr-core does not run here (${answered(version)})`);

    mkdirSync(bin, { recursive: true, mode: 0o755 });
    // copied in beside its place and asked again there (a home mounted noexec runs nothing), then linked
    // there: a herdr-core that appeared meanwhile is never replaced
    const staged = join(bin, `.herdr-core.ovis-${randomUUID().slice(0, 8)}`);
    try {
      writeFileSync(staged, await Bun.file(unpacked).bytes(), { mode: 0o755 });
      chmodSync(staged, 0o755);
      const there = await hcVersion(staged, env, 10_000);
      if (there !== release.version) throw new Error(`herdr-core does not run from ${bin} (${answered(there)})`);
      linkSync(staged, dest);
      mark = identity(dest);
    } finally {
      try { unlinkSync(staged); } catch {}
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  // `hc` beside it, as hc's installer links it, only where no `hc` is (some window managers ship one)
  let linked = false;
  const hc = join(bin, "hc");
  if (!present(hc) && Bun.which("hc", { PATH: env["PATH"] ?? "" }) === null) {
    try { symlinkSync("herdr-core", hc); linked = true; } catch {}
  }
  return {
    path: dest,
    undo: () => {
      try { if (identity(dest) === mark) unlinkSync(dest); } catch {}
      try { if (linked && readlinkSync(hc) === "herdr-core") unlinkSync(hc); } catch {}
    },
  };
}

/** The whole body, refused as soon as it passes `limit`: a server that sends more is never held in memory. */
async function boundedBody(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      throw new Error("the herdr-core download is far larger than a release");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { body.set(chunk, at); at += chunk.length; }
  return body;
}

/** an inode number alone is reused by the next file made: with its size and mtime it names this one file (its ctime moves as the staged link goes) */
function identity(path: string): string {
  const { dev, ino, size, mtimeMs } = lstatSync(path);
  return `${dev}:${ino}:${size}:${mtimeMs}`;
}

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
