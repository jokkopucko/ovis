/**
 * The Rust PTY host (crates/pty-sidecar) as a release ships it, on Linux and macOS:
 *
 *   bun scripts/pty-sidecar.ts build <linux-x64|linux-arm64|darwin-universal> <dir>   CI: one asset into <dir>
 *   bun scripts/pty-sidecar.ts manifest <dir>   CI: ovis-pty-sidecar.json and SHA256SUMS for the assets in <dir>
 *   bun scripts/pty-sidecar.ts install [--strict]   this checkout: the release's binary into bin/ovis-pty-sidecar
 *
 * Linux assets are static (musl), so they run on any distribution; the macOS one is universal
 * (arm64 and x86_64) and ad-hoc signed. `install` runs at every herdr plugin install, every update
 * the app installs and every install.sh run. It takes the binary of the release named by
 * package.json's version, only when that release was built from this checkout's crate sources
 * (their git tree), checks its SHA-256 against the release's manifest and that it runs here, and
 * moves it into place in one rename. A checkout whose crate sources no release was built from (a beta
 * build of main, .github/workflows/beta.yml) takes the host of the `pty-sidecar-<crate tree>` prerelease
 * the beta workflow publishes for those sources instead, checked the same way. Without one, it says
 * why and exits 0: the server then runs the Node sidecar where the PC has Node, or mirrors its panes. `--strict` exits 1 instead.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const CRATE = "crates/pty-sidecar";
export const NAME = "ovis-pty-sidecar";
export const MANIFEST = `${NAME}.json`;
/** where `install` puts the host, and where server/pty/host.ts looks first */
export const INSTALLED = join(root, "bin", NAME);
const RELEASES = "https://github.com/devswha/ovis/releases/download";

/** Each release asset and the Rust targets it is built from. */
export const ASSETS: Record<string, string[]> = {
  "linux-x64": ["x86_64-unknown-linux-musl"],
  "linux-arm64": ["aarch64-unknown-linux-musl"],
  "darwin-universal": ["aarch64-apple-darwin", "x86_64-apple-darwin"],
};
/** The asset each platform (`process.platform-process.arch`) runs. */
export const PLATFORM_ASSET: Record<string, string> = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "darwin-universal",
  "darwin-arm64": "darwin-universal",
};

export interface Manifest {
  version: string;
  /** git tree id of crates/pty-sidecar the assets were built from */
  crate: string;
  assets: Record<string, { file: string; sha256: string }>;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const packageVersion = (): string => (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

function command(argv: string[], timeout = 600_000): string {
  const result = Bun.spawnSync(argv, { cwd: root, timeout, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
  return result.stdout.toString().trim();
}

/**
 * The crate's git tree id in this checkout, or why there is none to trust: outside a git checkout, or
 * when its sources differ from HEAD (edited, staged or untracked files; target/ is ignored).
 */
export function crateTree(cwd = root): { tree: string } | { error: string } {
  // bounded: a git that hangs (a stuck fsmonitor) must not hold the plugin build or install.sh
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
  const tree = git("rev-parse", `HEAD:${CRATE}`);
  if (tree.exitCode !== 0) return { error: "not a git checkout, so the release's host cannot be matched to these sources" };
  const status = git("status", "--porcelain", "--untracked-files=all", "--", CRATE);
  if (status.exitCode !== 0 || status.stdout.toString().trim() !== "") return { error: `${CRATE} has changes that are not committed, so a release's host would not be built from them` };
  return { tree: tree.stdout.toString().trim() };
}

/** Whether `path` is the Rust PTY host and runs on this PC: with no arguments it prints its usage and exits 2. */
export function runsHere(path: string): boolean {
  try {
    const result = Bun.spawnSync([path], { stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 5000, killSignal: "SIGKILL" });
    return result.exitCode === 2 && result.stderr.toString().startsWith("pty-sidecar: usage:");
  } catch {
    return false;
  }
}

/** What an executable is for: `elf-<cpu>`, or `macho-<cpu>` for every Mach-O slice. */
export function architectures(path: string): string[] {
  const bytes = readFileSync(path);
  if (bytes.length < 64) return ["unknown"];
  if (bytes.readUInt32BE(0) === 0x7f454c46) return [`elf-${({ 0x3e: "x86_64", 0xb7: "aarch64" } as Record<number, string>)[bytes.readUInt16LE(18)] ?? "unknown"}`];
  const cpu = (value: number) => `macho-${({ 0x01000007: "x86_64", 0x0100000c: "aarch64" } as Record<number, string>)[value] ?? "unknown"}`;
  if (bytes.readUInt32BE(0) === 0xcafebabe) return Array.from({ length: Math.min(bytes.readUInt32BE(4), Math.floor((bytes.length - 8) / 20)) }, (_, i) => cpu(bytes.readUInt32BE(8 + i * 20)));
  if (bytes.readUInt32LE(0) === 0xfeedfacf) return [cpu(bytes.readUInt32LE(4))];
  return ["unknown"];
}

/** What `architectures` says of a working build for these Rust targets. */
export const expectedArchitectures = (targets: string[]): string[] =>
  targets.map((target) => `${target.includes("-apple-") ? "macho" : "elf"}-${target.split("-")[0]}`).sort();

function build(asset: string, out: string): void {
  const targets = ASSETS[asset];
  if (!targets) throw new Error(`Unknown asset ${asset}; one of ${Object.keys(ASSETS).join(", ")}`);
  mkdirSync(out, { recursive: true });
  const built = targets.map((target) => {
    command(["rustup", "target", "add", target]);
    command(["cargo", "build", "--release", "--locked", "--target", target, "--manifest-path", join(CRATE, "Cargo.toml")]);
    const targetDir = process.env["CARGO_TARGET_DIR"] ? resolve(process.env["CARGO_TARGET_DIR"]) : join(root, CRATE, "target");
    return join(targetDir, target, "release", NAME);
  });
  const file = join(out, `${NAME}-${asset}`);
  if (built.length > 1) {
    command(["lipo", "-create", "-output", file, ...built]);
    // each slice keeps the linker's ad-hoc signature; one over the whole file is what Apple silicon checks
    command(["codesign", "--force", "--sign", "-", file]);
    command(["codesign", "--verify", "--strict", "--all-architectures", file]);
  } else {
    writeFileSync(file, readFileSync(built[0]!));
  }
  chmodSync(file, 0o755);
  const want = expectedArchitectures(targets);
  const have = architectures(file).sort();
  if (JSON.stringify(have) !== JSON.stringify(want)) throw new Error(`${file} is for ${have.join("+")}, not ${want.join("+")}`);
  if (!runsHere(file)) throw new Error(`${file} does not run here as the PTY host`);
  console.log(`${file} ${have.join("+")} sha256:${sha256(readFileSync(file))}`);
}

function manifest(dir: string): void {
  const sources = crateTree();
  if ("error" in sources) throw new Error(sources.error);
  const crate = sources.tree;
  const assets: Manifest["assets"] = {};
  const sums: string[] = [];
  for (const asset of Object.keys(ASSETS)) {
    const file = `${NAME}-${asset}`;
    const digest = sha256(readFileSync(join(dir, file)));
    sums.push(`${digest}  ${file}`);
    for (const [platform, runs] of Object.entries(PLATFORM_ASSET)) if (runs === asset) assets[platform] = { file, sha256: digest };
  }
  const extra = readdirSync(dir).filter((name) => name !== MANIFEST && name !== "SHA256SUMS" && !sums.some((line) => line.endsWith(`  ${name}`)));
  if (extra.length > 0) throw new Error(`Unexpected files in ${dir}: ${extra.join(", ")}`);
  const result: Manifest = { version: packageVersion(), crate, assets };
  writeFileSync(join(dir, MANIFEST), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
  console.log(JSON.stringify(result, null, 2));
}

/** the whole install, both downloads and the checks, stays inside the updater's 120 s for the step */
const INSTALL_DEADLINE_MS = 90_000;

async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What was verified of the installed host, kept beside it: only a host that matches its record survives a
 * failed install, and the server runs an installed host only when the record's SHA-256 and version match
 * (server/pty/host.ts), so one that could not be removed is never run.
 */
interface Installed { crate: string; sha256: string; version: string }
const recordOf = (target: string) => `${target}.json`;

function verifiedFor(target: string, crate: string): boolean {
  try {
    const record = JSON.parse(readFileSync(recordOf(target), "utf8")) as Installed;
    return record.crate === crate && record.version === packageVersion() && sha256(readFileSync(target)) === record.sha256;
  } catch {
    return false;
  }
}

/**
 * What `install` did, in one line; `ok` false when this checkout has no Rust host from a release.
 * It never throws. When it fails, a host already in place stays only when it is the one verified
 * for these very sources; any other is removed, so the server never runs a host it would not install.
 */
export async function install(options: { releases?: string; target?: string; platform?: string } = {}): Promise<{ ok: boolean; message: string }> {
  const target = options.target ?? INSTALLED;
  let sources: ReturnType<typeof crateTree> = { error: "the crate sources could not be read" };
  let result: { ok: boolean; message: string; elsewhere?: boolean };
  try {
    sources = crateTree();
    if ("error" in sources) result = { ok: false, message: sources.error };
    else {
      const releases = (options.releases ?? RELEASES).replace(/\/$/, "");
      const version = packageVersion();
      result = await attempt(sources.tree, target, options, { base: `${releases}/v${version}`, name: `release v${version}`, version });
      // sources no release was built from: the host the beta workflow built from these very sources
      if (!result.ok && result.elsewhere) {
        const built = await attempt(sources.tree, target, options,
          { base: `${releases}/${TREE_RELEASE}${sources.tree}`, name: `prerelease ${TREE_RELEASE}${sources.tree.slice(0, 12)}` });
        result = built.ok || !built.elsewhere ? built : { ok: false, message: `${result.message}, and ${built.message}` };
      }
    }
  } catch (error) {
    result = { ok: false, message: `could not install the Rust PTY host (${message(error)})` };
  }
  if (!result.ok && existsSync(target) && !("tree" in sources && verifiedFor(target, sources.tree))) {
    try {
      rmSync(target, { force: true });
      rmSync(recordOf(target), { force: true });
      result.message += `; removed the unverified ${target}`;
    } catch (error) {
      result.message += `; could not remove the unverified ${target} (${message(error)})`;
    }
  }
  return result;
}

/** The prerelease the beta workflow attaches a host built from one crate tree to: `pty-sidecar-<tree>`. */
export const TREE_RELEASE = "pty-sidecar-";

/**
 * One place a host may come from: a release (`version`: its manifest must be that version's) or the
 * prerelease of a crate tree (any version: the crate check is what ties it to these sources).
 * `elsewhere` on a failure: this place has no host for these sources, so another may be tried.
 */
async function attempt(crate: string, target: string, options: { platform?: string }, source: { base: string; name: string; version?: string }): Promise<{ ok: boolean; message: string; elsewhere?: boolean }> {
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const asset = PLATFORM_ASSET[platform];
  if (!asset) return { ok: false, message: `no Rust PTY host for ${platform}` };
  const version = packageVersion();
  const { base, name } = source;
  const signal = AbortSignal.timeout(INSTALL_DEADLINE_MS);
  let found: unknown;
  try {
    found = JSON.parse(new TextDecoder().decode(await download(`${base}/${MANIFEST}`, signal)));
  } catch (error) {
    return { ok: false, message: `${name} has no Rust PTY host (${message(error)})`, elsewhere: true };
  }
  if (!isObject(found) || (source.version !== undefined && found["version"] !== source.version) || typeof found["crate"] !== "string" || !isObject(found["assets"])) {
    return { ok: false, message: `${name}'s ${MANIFEST} is not a manifest for ${source.version === undefined ? "a host" : `v${source.version}`}` };
  }
  if (found["crate"] !== crate) return { ok: false, message: `${name}'s host was built from other ${CRATE} sources than this checkout's`, elsewhere: true };
  const entry = found["assets"][platform];
  if (!isObject(entry) || typeof entry["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(entry["sha256"]) || entry["file"] !== `${NAME}-${asset}`) {
    return { ok: false, message: `${name}'s manifest names no host for ${platform}` };
  }
  const expected = entry["sha256"];
  const file = entry["file"];
  if (verifiedFor(target, crate) && sha256(readFileSync(target)) === expected && runsHere(target)) return { ok: true, message: `Rust PTY host of ${name} already installed at ${target}` };
  let bytes: Uint8Array;
  try {
    bytes = await download(`${base}/${file}`, signal);
  } catch (error) {
    return { ok: false, message: `could not download ${file} (${message(error)})` };
  }
  const digest = sha256(bytes);
  if (digest !== expected) return { ok: false, message: `${file} does not match its SHA-256 in ${name}'s manifest (got ${digest}); nothing was installed` };
  mkdirSync(join(target, ".."), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode: 0o755, flag: "wx" });
    chmodSync(temporary, 0o755);
    if (!runsHere(temporary)) return { ok: false, message: `${file} does not run on this PC; nothing was installed` };
    // the record goes first: a host in place without one is removed by the next failed install, never trusted
    rmSync(recordOf(target), { force: true });
    renameSync(temporary, target);
    writeFileSync(recordOf(target), `${JSON.stringify({ crate, sha256: digest, version } satisfies Installed)}\n`);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { ok: true, message: `installed the Rust PTY host of ${name} (sha256 ${digest}) at ${target}` };
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === "build" && rest.length === 2) build(rest[0]!, resolve(rest[1]!));
  else if (verb === "manifest" && rest.length === 1) manifest(resolve(rest[0]!));
  else if (verb === "install" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--strict"))) {
    const result = await install();
    if (result.ok) console.log(`Ovis: ${result.message}`);
    else console.log(`Ovis: ${result.message}; terminals use the Node PTY sidecar where this PC has Node, or are mirrored`);
    if (!result.ok && rest[0] === "--strict") process.exit(1);
  } else {
    console.error("Usage: bun scripts/pty-sidecar.ts build <linux-x64|linux-arm64|darwin-universal> <dir> | manifest <dir> | install [--strict]");
    process.exit(2);
  }
}
