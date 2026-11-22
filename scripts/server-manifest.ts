/**
 * The release's server binaries and what vouches for them: `ovis-server.json` (the version, the git trees of server/
 * and shared/ they were built from, the SHA-256 and size of each platform's file and of the built client,
 * `ovis-dist.tar.gz`), `ovis-server.SHA256SUMS`, and `ovis-server.json.sig`, an Ed25519 signature over the
 * manifest's exact bytes, base64 on one line.
 *
 * The private key lives only in the secret OVIS_SERVER_SIGNING_KEY (a PKCS#8 PEM) of the environment release-signing, which
 * only main may use, never in a repository secret, and with the owner
 * offline; the public key is 32 raw bytes in base64. This file imports Node's built-ins alone, so the release job
 * that signs runs it without installing a single package next to the key.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SERVER_PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64", "windows-x64"] as const;
export type ServerPlatform = typeof SERVER_PLATFORMS[number];
export const MANIFEST = "ovis-server.json";
export const SIGNATURE = `${MANIFEST}.sig`;
/** not plain SHA256SUMS: the release also carries the Rust PTY host's, under that name */
export const SUMS = "ovis-server.SHA256SUMS";
/** the environment release-signing's secret, and the variable the sign step reads it from */
export const SIGNING_KEY_VARIABLE = "OVIS_SERVER_SIGNING_KEY";
export const KEY_FILE = "ovis-server-signing-key.pem";
export const DIST_ARCHIVE = "ovis-dist.tar.gz";
/**
 * The public half of OVIS_SERVER_SIGNING_KEY: the release's sign and publish jobs refuse a manifest it does not verify,
 * and install.sh, install.ps1 and scripts/plugin-launch.ts trust no other key. A new key changes this line and the two
 * installers' copies of it (scripts/server-manifest.test.ts holds them equal).
 */
export const RELEASE_PUBLIC_KEY = "C8+dOD0gpFHoy008ZqHO89vXutaLqlt5uWyIh250OiY=";

export const releaseFile = (platform: ServerPlatform): string => `ovis-server-${platform}${platform === "windows-x64" ? ".exe" : ""}`;
export const PTY_ASSETS = ["linux-x64", "linux-arm64", "darwin-universal"] as const;
export type PtyAsset = typeof PTY_ASSETS[number];
export const ptyFile = (asset: PtyAsset): string => `ovis-pty-sidecar-${asset}`;
/** The PTY host build a server platform runs, or null where there is none (Windows mirrors its panes). */
export const ptyAssetFor = (platform: ServerPlatform): PtyAsset | null =>
  platform === "windows-x64" ? null : platform.startsWith("darwin-") ? "darwin-universal" : platform as PtyAsset;

export const binaryName = (platform: ServerPlatform): string => (platform === "windows-x64" ? "ovis-server.exe" : "ovis-server");

export interface ReleaseAsset { file: string; sha256: string; size: number }
/** the manifest's shape: a reader refuses any other, so a later shape can never be read as this one */
export const MANIFEST_SCHEMA = 1;
export interface ServerManifest {
  schema: typeof MANIFEST_SCHEMA;
  version: string;
  sources: { server: string; shared: string };
  assets: Record<ServerPlatform, ReleaseAsset>;
  dist: ReleaseAsset;
  /** the Rust PTY hosts, signed with the server: an installer runs no host but the one named here */
  pty: Record<PtyAsset, ReleaseAsset>;
}
const RELEASE_FILES = (): string[] => [...SERVER_PLATFORMS.map(releaseFile), DIST_ARCHIVE, ...PTY_ASSETS.map(ptyFile)];

const root = resolve(import.meta.dir, "..");
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The git trees of server/ and shared/ in this checkout, or why there are none to name: outside a git checkout, or
 * with changes there that are not committed, a manifest would name sources the binaries were not built from. The trees
 * are this folder's own (`./`), also where it sits inside another repository: a tree id names the content wherever it is,
 * while `HEAD:server` would name the server/ at that repository's top level. Without git on PATH nothing can tie them
 * either: that is said as a reason too, not thrown, so the launcher still runs every command that needs no release.
 */
export function sourceTrees(cwd = root): { server: string; shared: string } | { error: string } {
  // untranslated (LC_ALL=C): git's "not a git repository" and its distrust are told by its words
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, LC_ALL: "C" }, stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
  let status: ReturnType<typeof git>;
  try {
    status = git("status", "--porcelain", "--untracked-files=all", "--", "server", "shared");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { error: "git is not on PATH, so the binaries cannot be tied to their sources" };
  }
  if (status.exitCode !== 0) {
    const err = status.stderr.toString().trim();
    const first = err.split(/\r?\n/)[0] || `git exited with ${status.exitCode}`;
    if (/not a git repository/.test(err)) return { error: "not a git checkout, so the binaries cannot be tied to their sources" };
    if (/^fatal: detected dubious ownership in repository at /.test(first)) return { error: "git does not trust this folder (another account owns it), so the binaries cannot be tied to their sources" };
    return { error: `git could not read this checkout (${first}), so the binaries cannot be tied to their sources` };
  }
  if (status.stdout.toString().trim() !== "") return { error: "server/ or shared/ has changes that are not committed, so the binaries would not be built from HEAD's sources" };
  const [server, shared] = ["server", "shared"].map((dir) => git("rev-parse", `HEAD:./${dir}`).stdout.toString().trim());
  return { server: server!, shared: shared! };
}

/** Writes the manifest and the sums for the five binaries and the client archive in `dir`, and drops a signature an earlier manifest had. */
export function writeManifest(dir: string, release: { version: string; sources: ServerManifest["sources"] }): ServerManifest {
  const names = new Set(RELEASE_FILES());
  const missing = [...names].filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) throw new Error(`${dir} has no ${missing.join(", ")}`);
  const extra = readdirSync(dir).filter((name) => !names.has(name) && name !== MANIFEST && name !== SUMS && name !== SIGNATURE);
  if (extra.length > 0) throw new Error(`Unexpected files in ${dir}: ${extra.join(", ")}`);
  const asset = (file: string): ReleaseAsset => {
    const bytes = readFileSync(join(dir, file));
    return { file, sha256: sha256(bytes), size: bytes.length };
  };
  const assets = Object.fromEntries(SERVER_PLATFORMS.map((platform) => [platform, asset(releaseFile(platform))])) as ServerManifest["assets"];
  const pty = Object.fromEntries(PTY_ASSETS.map((build) => [build, asset(ptyFile(build))])) as ServerManifest["pty"];
  const manifest: ServerManifest = { schema: MANIFEST_SCHEMA, version: release.version, sources: release.sources, assets, dist: asset(DIST_ARCHIVE), pty };
  rmSync(join(dir, SIGNATURE), { force: true });
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(dir, SUMS), sumsOf(manifest));
  return manifest;
}

/** DER prefix of an Ed25519 SubjectPublicKeyInfo: the 32 raw key bytes follow it */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/**
 * `text` as the bytes it encodes, only when `text` is exactly their standard padded base64: no whitespace, no bytes
 * after the padding, nothing a lenient decoder would skip. Anything else is null.
 */
function strictBase64(text: string, length: number): Buffer | null {
  const bytes = Buffer.from(text, "base64");
  return bytes.length === length && bytes.toString("base64") === text ? bytes : null;
}

function publicKeyObject(publicKey: string) {
  const raw = strictBase64(publicKey, 32);
  if (!raw) throw new Error("The public key must be exactly 32 bytes in standard base64, with nothing around it");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" });
}

export function publicKeyOf(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "der", type: "spki" });
  return der.subarray(ED25519_SPKI.length).toString("base64");
}

export function generateKeyPair(): { privateKeyPem: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  return { privateKeyPem, publicKey: publicKeyOf(privateKeyPem) };
}

export function signManifest(dir: string, privateKeyPem: string): string {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${SIGNING_KEY_VARIABLE} is not an Ed25519 private key`);
  const signature = sign(null, readFileSync(join(dir, MANIFEST)), key);
  writeFileSync(join(dir, SIGNATURE), `${signature.toString("base64")}\n`);
  return publicKeyOf(privateKeyPem);
}

const sumsOf = (manifest: ServerManifest): string => [...SERVER_PLATFORMS.map((platform) => manifest.assets[platform]), manifest.dist, ...PTY_ASSETS.map((build) => manifest.pty[build])].map(({ sha256: digest, file }) => `${digest}  ${file}\n`).join("");

const sameKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);

const isAsset = (entry: unknown, file: string): boolean =>
  sameKeys(entry, ["file", "sha256", "size"]) && entry["file"] === file && typeof entry["sha256"] === "string" && /^[0-9a-f]{64}$/.test(entry["sha256"])
  && typeof entry["size"] === "number" && Number.isSafeInteger(entry["size"]) && entry["size"] >= 0;

/**
 * The manifest, only when its bytes are exactly what writeManifest writes for it: its schema, the four fields, the two source
 * trees, the five platforms and the client archive, in that order, each with its file, SHA-256 and size, and nothing else. Comparing the bytes with
 * their own re-serialisation also refuses a duplicate key, which JSON.parse would otherwise settle silently.
 */
function canonicalManifest(bytes: Buffer): ServerManifest | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return `${MANIFEST} is not JSON`;
  }
  if (typeof parsed === "object" && parsed !== null && "schema" in parsed && (parsed as Record<string, unknown>)["schema"] !== MANIFEST_SCHEMA) {
    return `${MANIFEST} is schema ${JSON.stringify((parsed as Record<string, unknown>)["schema"])}, and this reader knows only schema ${MANIFEST_SCHEMA}; a newer installer reads it`;
  }
  if (!sameKeys(parsed, ["schema", "version", "sources", "assets", "dist", "pty"])) return `${MANIFEST} must hold exactly schema, version, sources, assets, dist and pty`;
  if (typeof parsed["version"] !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parsed["version"])) return `${MANIFEST} names no version`;
  const sources = parsed["sources"];
  if (!sameKeys(sources, ["server", "shared"]) || !Object.values(sources).every((tree) => typeof tree === "string" && /^[0-9a-f]{40}$/.test(tree))) return `${MANIFEST} must name exactly the git trees of server and shared`;
  const assets = parsed["assets"];
  if (!sameKeys(assets, SERVER_PLATFORMS)) return `${MANIFEST} must name exactly the platforms ${SERVER_PLATFORMS.join(", ")}`;
  for (const platform of SERVER_PLATFORMS) {
    if (!isAsset(assets[platform], releaseFile(platform))) return `${platform}: ${MANIFEST} must name ${releaseFile(platform)}, its SHA-256 and its size, and nothing else`;
  }
  if (!isAsset(parsed["dist"], DIST_ARCHIVE)) return `${MANIFEST} must name ${DIST_ARCHIVE}, its SHA-256 and its size, and nothing else`;
  const pty = parsed["pty"];
  if (!sameKeys(pty, PTY_ASSETS)) return `${MANIFEST} must name exactly the Rust PTY hosts ${PTY_ASSETS.join(", ")}`;
  for (const build of PTY_ASSETS) {
    if (!isAsset(pty[build], ptyFile(build))) return `${build}: ${MANIFEST} must name ${ptyFile(build)}, its SHA-256 and its size, and nothing else`;
  }
  if (bytes.toString("utf8") !== `${JSON.stringify(parsed, null, 2)}\n`) return `${MANIFEST} is not in its canonical form (a duplicate key, other spacing or another encoding)`;
  return parsed as unknown as ServerManifest;
}

/**
 * Whether `bytes` is a manifest of the shape releases had before schema 1 (todo 5's ovis-server.json: no "schema"), for
 * `version` and signed by `publicKey`: a release whose binaries no installer of this shape runs, so it ships no compiled
 * server for it, as a release without ovis-server.json. The signature is checked first; a manifest with any schema is
 * never one of these.
 */
export function oldShapeRelease(bytes: Buffer, signatureText: string, publicKey: string, version: string): boolean {
  try {
    const signature = signatureText.endsWith("\n") ? strictBase64(signatureText.slice(0, -1), 64) : null;
    if (!signature || !verify(null, bytes, publicKeyObject(publicKey), signature)) return false;
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && !("schema" in parsed) && (parsed as { version?: unknown }).version === version;
  } catch {
    return false;
  }
}

/**
 * The manifest `bytes`, once `signatureText` (one line of strict base64) is `publicKey`'s signature over exactly them,
 * they are in their canonical form, and, when `expected.version` is given, for that version; else the one line that
 * says why not. What an installer checks before it reads a single file the manifest names.
 */
export function checkManifest(bytes: Buffer, signatureText: string, publicKey: string, expected: { version?: string } = {}): ServerManifest | string {
  try {
    const key = publicKeyObject(publicKey);
    const signature = signatureText.endsWith("\n") ? strictBase64(signatureText.slice(0, -1), 64) : null;
    if (!signature) return `${SIGNATURE} is not one line of standard base64 holding a 64-byte signature`;
    if (!verify(null, bytes, key, signature)) return `${SIGNATURE} is not a signature of this ${MANIFEST} by the key ${publicKey}`;
    const manifest = canonicalManifest(bytes);
    if (typeof manifest === "string") return manifest;
    if (expected.version !== undefined && manifest.version !== expected.version) return `${MANIFEST} is for version ${manifest.version}, not the expected ${expected.version}`;
    return manifest;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Checks `dir` as an installer will, and stops at the first part that fails:
 * - the folder holds exactly the five binaries, the manifest, its signature and the sums file;
 * - the signature, by `publicKey`, over the manifest's exact bytes (both strictly base64); only a manifest that passes is read;
 * - the manifest in its canonical form, and, when `expected.version` is given, for that version: a signature alone
 *   does not stop an older release, signed by the same key, from being offered as a newer one;
 * - every binary and the client archive against its SHA-256 and size, and the sums file, which is required, against the manifest.
 * Each problem is one line; a binary's names its platform.
 */
export function verifyRelease(dir: string, publicKey: string, expected: { version?: string } = {}): { ok: boolean; problems: string[] } {
  try {
    publicKeyObject(publicKey);
    const allowed = new Set([...RELEASE_FILES(), MANIFEST, SIGNATURE, SUMS]);
    const present = readdirSync(dir);
    const extra = present.filter((name) => !allowed.has(name));
    if (extra.length > 0) return { ok: false, problems: [`${dir} holds files a release does not: ${extra.join(", ")}`] };
    const missing = [MANIFEST, SIGNATURE, SUMS].filter((name) => !present.includes(name));
    if (missing.length > 0) return { ok: false, problems: [`${dir} has no ${missing.join(", ")}`] };
    const manifest = checkManifest(readFileSync(join(dir, MANIFEST)), readFileSync(join(dir, SIGNATURE), "utf8"), publicKey, expected);
    if (typeof manifest === "string") return { ok: false, problems: [manifest] };
    const problems: string[] = [];
    for (const [name, { file, sha256: digest, size }] of [...SERVER_PLATFORMS.map((platform) => [platform, manifest.assets[platform]] as const), ["client", manifest.dist] as const, ...PTY_ASSETS.map((build) => [`PTY host ${build}`, manifest.pty[build]] as const)]) {
      if (!present.includes(file)) problems.push(`${name}: ${file} is missing`);
      else {
        const bytes = readFileSync(join(dir, file));
        if (bytes.length !== size || sha256(bytes) !== digest) problems.push(`${name}: ${file} does not match its SHA-256 and size in ${MANIFEST}`);
      }
    }
    if (readFileSync(join(dir, SUMS), "utf8") !== sumsOf(manifest)) problems.push(`${SUMS} does not list exactly the sums ${MANIFEST} names`);
    return { ok: problems.length === 0, problems };
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
  }
}
