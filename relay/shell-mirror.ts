/**
 * Keeps a regional copy of the hosted app (`app.ovis.sh`) on a relay box, for the regional app
 * address (`app-ap.ovis.sh`, shared/relay-regions.ts). Each run asks `app.ovis.sh` which commit it
 * serves (its build.json), finds the GitHub release tagged on that commit, checks the release's
 * dist-shell.tar.gz against the SHA-256 published with it and against that commit, then checks
 * every file it would serve, byte for byte, against the same file fetched from `app.ovis.sh`, and
 * makes it current only if `app.ovis.sh` still serves that commit. A release asset replaced after
 * the deploy is refused, so what this copy serves is what `app.ovis.sh` served. The box itself
 * still delivers the code, so whoever controls it is a trust root too (docs/relay.md).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export const APP = "https://app.ovis.sh";
export const REPOSITORY = "devswha/ovis";
const KEEP = 3;
/** Files the Pages build writes for Pages itself, which it never serves. */
const PAGES_ONLY = new Set(["_headers", "_redirects"]);
const COMPARE_AT_ONCE = 8;
/** How long a commit no release was found for is not searched again (GitHub allows 60 unauthenticated calls an hour). */
const MISS_MS = 60 * 60 * 1000;
const LOCK_MS = 60 * 60 * 1000;
const TAG_PAGES = 10;
const REVISION = /^[0-9a-f]{40}$/;

interface ReleaseAsset { readonly name: string; readonly browser_download_url: string }
interface Release { readonly tag_name: string; readonly assets: readonly ReleaseAsset[] }

export interface MirrorOptions {
  readonly dir: string;
  readonly fetch?: typeof fetch;
  readonly unpack?: (tarball: string, into: string) => Promise<void>;
}

export type MirrorResult = { readonly kind: "current"; readonly revision: string } | { readonly kind: "updated"; readonly tag: string; readonly revision: string };

async function json(fetcher: typeof fetch, url: string): Promise<unknown> {
  const response = await fetcher(url, { headers: { accept: "application/json", "user-agent": "ovis-shell-mirror" }, cache: "no-store" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function bytes(fetcher: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetcher(url, { headers: { "user-agent": "ovis-shell-mirror" }, redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function revisionOf(buildJson: unknown): string {
  const revision = typeof buildJson === "object" && buildJson !== null ? (buildJson as { revision?: unknown }).revision : undefined;
  if (typeof revision !== "string" || !REVISION.test(revision)) throw new Error("build.json names no commit");
  return revision;
}

function servedRevision(dir: string): string | null {
  try { return revisionOf(JSON.parse(readFileSync(join(dir, "current", "build.json"), "utf8"))); } catch { return null; }
}

async function tarUnpack(tarball: string, into: string): Promise<void> {
  // the same refusals as the Pages deploy (.github/workflows/release.yml): only plain files and folders, all inside
  const listing = await Bun.$`tar -tvzf ${tarball}`.text();
  if (listing.split("\n").some((line) => line !== "" && !/^[-d]/.test(line))) throw new Error("the tarball holds a link or a special file");
  const names = await Bun.$`tar -tzf ${tarball}`.text();
  if (names.split("\n").some((name) => name.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(name))) throw new Error("the tarball holds a path outside it");
  await Bun.$`tar -xzf ${tarball} -C ${into} --no-same-owner --no-same-permissions`.quiet();
}

export async function mirrorOnce(options: MirrorOptions): Promise<MirrorResult> {
  mkdirSync(options.dir, { recursive: true });
  const lock = join(options.dir, ".lock");
  try { mkdirSync(lock); } catch {
    if (Date.now() - statSync(lock).mtimeMs < LOCK_MS) throw new Error(`another run holds ${lock}`);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  try { return await mirror(options); } finally { rmSync(lock, { recursive: true, force: true }); }
}

async function tagsOf(fetcher: typeof fetch, commit: string): Promise<string[]> {
  for (let page = 1; page <= TAG_PAGES; page++) {
    const tags = await json(fetcher, `https://api.github.com/repos/${REPOSITORY}/tags?per_page=100&page=${page}`) as { name?: unknown; commit?: { sha?: unknown } }[];
    const named = tags.filter((tag) => tag.commit?.sha === commit && typeof tag.name === "string" && /^[\w.@+-]+$/.test(tag.name)).map((tag) => tag.name as string);
    if (named.length || tags.length < 100) return named;
  }
  return [];
}

async function mirror(options: MirrorOptions): Promise<MirrorResult> {
  const fetcher = options.fetch ?? fetch;
  const unpack = options.unpack ?? tarUnpack;
  const live = revisionOf(await json(fetcher, `${APP}/build.json`));
  if (servedRevision(options.dir) === live) return { kind: "current", revision: live };
  const miss = join(options.dir, ".missed");
  try {
    const last = JSON.parse(readFileSync(miss, "utf8")) as { revision?: unknown; at?: unknown };
    if (last.revision === live && typeof last.at === "number" && Date.now() - last.at < MISS_MS) throw new Error(`no release was built from ${live} at the last look`);
  } catch (error) { if (error instanceof Error && error.message.startsWith("no release")) throw error; }
  const tags = await tagsOf(fetcher, live);
  if (!tags.length) {
    writeFileSync(miss, JSON.stringify({ revision: live, at: Date.now() }));
    throw new Error(`no release was built from ${live}, the commit ${APP} serves`);
  }
  for (const tag of tags) {
    const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
      { headers: { accept: "application/json", "user-agent": "ovis-shell-mirror" }, cache: "no-store" });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`the release of ${tag} answered ${response.status}`);
    const release = await response.json() as Release;
    const tarball = release.assets.find((asset) => asset.name === "dist-shell.tar.gz");
    const digest = release.assets.find((asset) => asset.name === "dist-shell.tar.gz.sha256");
    if (!tarball || !digest) continue;
    const expected = new TextDecoder().decode(await bytes(fetcher, digest.browser_download_url)).trim().split(/\s+/)[0] ?? "";
    const archive = await bytes(fetcher, tarball.browser_download_url);
    if (!/^[0-9a-f]{64}$/.test(expected) || createHash("sha256").update(archive).digest("hex") !== expected) {
      throw new Error(`${tag}: dist-shell.tar.gz does not match its published SHA-256`);
    }
    return install(options.dir, tag, live, archive, unpack, fetcher);
  }
  throw new Error(`the release of ${live} (${tags.join(", ")}) has no dist-shell.tar.gz yet`);
}

function files(root: string, at = root): string[] {
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(root, join(at, entry.name)) : [relative(root, join(at, entry.name))]);
}

async function compareWithApp(staging: string, fetcher: typeof fetch): Promise<void> {
  const queue = files(staging).filter((path) => !PAGES_ONLY.has(path));
  const worker = async (): Promise<void> => {
    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      const served = await bytes(fetcher, `${APP}/${path.split("/").map(encodeURIComponent).join("/")}`);
      const ours = readFileSync(join(staging, path));
      if (!Buffer.from(served).equals(ours)) throw new Error(`${path} differs from what ${APP} serves`);
    }
  };
  await Promise.all(Array.from({ length: COMPARE_AT_ONCE }, worker));
}

async function install(dir: string, tag: string, revision: string, archive: Uint8Array,
  unpack: NonNullable<MirrorOptions["unpack"]>, fetcher: typeof fetch): Promise<MirrorResult> {
  const releases = join(dir, "releases");
  mkdirSync(releases, { recursive: true });
  const staging = join(releases, `.staging-${tag}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging);
  const tarball = join(dir, `.${tag}.tar.gz`);
  writeFileSync(tarball, archive);
  try {
    await unpack(tarball, staging);
    const unpacked = revisionOf(JSON.parse(readFileSync(join(staging, "build.json"), "utf8")));
    if (unpacked !== revision) throw new Error(`${tag}: its build.json names ${unpacked}, not ${revision}`);
    for (const path of files(staging)) if (/\.(br|gz)$/.test(path)) rmSync(join(staging, path));
    await compareWithApp(staging, fetcher);
    // app.ovis.sh may have moved on while this run fetched: a copy is made current only while it serves the same
    if (revisionOf(await json(fetcher, `${APP}/build.json`)) !== revision) throw new Error(`${APP} changed while ${tag} was being checked`);
    const name = `${tag}+${Date.now().toString(36)}`;
    renameSync(staging, join(releases, name));
    // swapped by a rename, so the web server never sees a missing `current`
    const link = join(dir, ".current-next");
    rmSync(link, { force: true });
    symlinkSync(join("releases", name), link);
    renameSync(link, join(dir, "current"));
    prune(dir, releases, name);
    return { kind: "updated", tag, revision };
  } finally {
    rmSync(tarball, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

function prune(dir: string, releases: string, current: string): void {
  const kept = readdirSync(releases, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, at: Number.parseInt(entry.name.split("+").at(-1) ?? "", 36) || 0 }))
    .sort((a, b) => b.at - a.at);
  const serving = existsSync(join(dir, "current")) ? readlinkSync(join(dir, "current")) : null;
  for (const [index, entry] of kept.entries()) {
    if (index < KEEP || entry.name === current || serving === join("releases", entry.name)) continue;
    rmSync(join(releases, entry.name), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf("--dir");
  const dir = at === -1 ? undefined : process.argv[at + 1];
  if (!dir) throw new Error("Usage: bun relay/shell-mirror.ts --dir <folder>");
  const result = await mirrorOnce({ dir });
  console.log(result.kind === "current" ? `current: ${result.revision}` : `updated to ${result.tag} (${result.revision})`);
}
