/**
 * The Rust PTY host (crates/pty-sidecar) and the ACP keeper (crates/acp-keeper) as a release ships them, on Linux and macOS:
 *
 *   bun scripts/pty-sidecar.ts build <linux-x64|linux-arm64|darwin-universal> <dir>   CI: each binary's asset into <dir>
 *   bun scripts/pty-sidecar.ts manifest <dir>   CI: ovis-pty-sidecar.json, ovis-acp-keeper.json and SHA256SUMS for the assets in <dir>
 *   bun scripts/pty-sidecar.ts install [--strict]   this checkout: the release's binaries into bin/ovis-pty-sidecar and bin/ovis-acp-keeper
 *
 * Each binary has its own crate tree, assets, manifest and record, and installs on its own: one that cannot be installed
 * never keeps the other out. Both are published beside each other, in the release and in the beta prerelease named
 * after both crate trees. What follows says "host"; the keeper is checked the same way.
 *
 * Linux assets are static (musl), so they run on any distribution; the macOS one is universal
 * (arm64 and x86_64) and ad-hoc signed. `install` runs at every herdr plugin install, every update
 * the app installs and every install.sh run. It takes the binary of the release named by
 * package.json's version, only when that release was built from this checkout's crate sources
 * (their git tree), checks its SHA-256 against the release's manifest and that it runs here, and
 * moves it into place in one rename. A checkout whose crate sources no release was built from (a beta
 * build of main, .github/workflows/beta.yml) takes the host of the `pty-sidecar-<host tree>-<keeper tree>` prerelease
 * the beta workflow publishes for those sources instead, checked the same way. Without one, it says
 * why and exits 0: the server then mirrors herdr's panes and runs no ACP keeper. `--strict` exits 1 instead.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const RELEASES = "https://github.com/devswha/ovis/releases/download";

export const ASSETS: Record<string, string[]> = {
  "linux-x64": ["x86_64-unknown-linux-musl"],
  "linux-arm64": ["aarch64-unknown-linux-musl"],
  "darwin-universal": ["aarch64-apple-darwin", "x86_64-apple-darwin"],
};
export const PLATFORM_ASSET: Record<string, string> = {
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "darwin-x64": "darwin-universal",
  "darwin-arm64": "darwin-universal",
};

/** a binary a release ships from a crate of its own, how it answers when run without arguments, and what runs without it */
export interface Part { crate: string; name: string; usage: string; label: string; without: string }
export const PTY_HOST: Part = {
  crate: "crates/pty-sidecar", name: "ovis-pty-sidecar", usage: "pty-sidecar: usage:", label: "Rust PTY host",
  without: "herdr's terminals are mirrored until a host runs here: build one with cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml (a checkout of main whose crates/pty-sidecar no release was built from gets one from the next daily beta's prerelease), or set OVIS_PTY_SIDECAR_BIN to a built one",
};
export const ACP_KEEPER: Part = {
  crate: "crates/acp-keeper", name: "ovis-acp-keeper", usage: "Usage: ovis-acp-keeper ", label: "ACP keeper",
  without: "Ovis runs no ACP agent through a keeper of its own",
};
export const PARTS = [PTY_HOST, ACP_KEEPER] as const;
const manifestOf = (part: Part): string => `${part.name}.json`;

export interface Manifest {
  version: string;
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
export function crateTree(cwd = root, crate = PTY_HOST.crate): { tree: string } | { error: string } {
  // bounded: a git that hangs (a stuck fsmonitor) must not hold the plugin build or install.sh
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore", timeout: 10_000, killSignal: "SIGKILL" });
  const tree = git("rev-parse", `HEAD:${crate}`);
  if (tree.exitCode !== 0) return { error: `not a git checkout with ${crate} committed, so the release's binary cannot be matched to these sources` };
  const status = git("status", "--porcelain", "--untracked-files=all", "--", crate);
  if (status.exitCode !== 0 || status.stdout.toString().trim() !== "") return { error: `${crate} has changes that are not committed, so a release's binary would not be built from them` };
  return { tree: tree.stdout.toString().trim() };
}

export function runsHere(path: string, part: Part = PTY_HOST, timeout = 5000): boolean {
  try {
    const result = Bun.spawnSync([path], { env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout, killSignal: "SIGKILL" });
    return result.exitCode === 2 && result.stderr.toString().startsWith(part.usage);
  } catch {
    return false;
  }
}

export function architectures(path: string): string[] {
  const bytes = readFileSync(path);
  if (bytes.length < 64) return ["unknown"];
  if (bytes.readUInt32BE(0) === 0x7f454c46) return [`elf-${({ 0x3e: "x86_64", 0xb7: "aarch64" } as Record<number, string>)[bytes.readUInt16LE(18)] ?? "unknown"}`];
  const cpu = (value: number) => `macho-${({ 0x01000007: "x86_64", 0x0100000c: "aarch64" } as Record<number, string>)[value] ?? "unknown"}`;
  if (bytes.readUInt32BE(0) === 0xcafebabe) return Array.from({ length: Math.min(bytes.readUInt32BE(4), Math.floor((bytes.length - 8) / 20)) }, (_, i) => cpu(bytes.readUInt32BE(8 + i * 20)));
  if (bytes.readUInt32LE(0) === 0xfeedfacf) return [cpu(bytes.readUInt32LE(4))];
  return ["unknown"];
}

export const expectedArchitectures = (targets: string[]): string[] =>
  targets.map((target) => `${target.includes("-apple-") ? "macho" : "elf"}-${target.split("-")[0]}`).sort();

function build(asset: string, out: string): void {
  const targets = ASSETS[asset];
  if (!targets) throw new Error(`Unknown asset ${asset}; one of ${Object.keys(ASSETS).join(", ")}`);
  mkdirSync(out, { recursive: true });
  for (const target of targets) command(["rustup", "target", "add", target]);
  for (const part of PARTS) buildPart(part, { asset, targets, out });
}

function buildPart(part: Part, { asset, targets, out }: { asset: string; targets: string[]; out: string }): void {
  const built = targets.map((target) => {
    command(["cargo", "build", "--release", "--locked", "--target", target, "--manifest-path", join(part.crate, "Cargo.toml")]);
    const targetDir = process.env["CARGO_TARGET_DIR"] ? resolve(process.env["CARGO_TARGET_DIR"]) : join(root, part.crate, "target");
    return join(targetDir, target, "release", part.name);
  });
  const file = join(out, `${part.name}-${asset}`);
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
  if (!runsHere(file, part)) throw new Error(`${file} does not run here as the ${part.label}`);
  console.log(`${file} ${have.join("+")} sha256:${sha256(readFileSync(file))}`);
}

function manifest(dir: string): void {
  const files: string[] = [];
  const sums: string[] = [];
  const results = PARTS.map((part) => {
    const sources = crateTree(root, part.crate);
    if ("error" in sources) throw new Error(sources.error);
    const assets: Manifest["assets"] = {};
    for (const asset of Object.keys(ASSETS)) {
      const file = `${part.name}-${asset}`;
      const digest = sha256(readFileSync(join(dir, file)));
      files.push(file);
      sums.push(`${digest}  ${file}`);
      for (const [platform, runs] of Object.entries(PLATFORM_ASSET)) if (runs === asset) assets[platform] = { file, sha256: digest };
    }
    return { part, manifest: { version: packageVersion(), crate: sources.tree, assets } satisfies Manifest };
  });
  const known = new Set([...PARTS.map(manifestOf), "SHA256SUMS", ...files]);
  const extra = readdirSync(dir).filter((name) => !known.has(name));
  if (extra.length > 0) throw new Error(`Unexpected files in ${dir}: ${extra.join(", ")}`);
  for (const { part, manifest: result } of results) {
    writeFileSync(join(dir, manifestOf(part)), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  }
  writeFileSync(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
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
 * When it fails, a host already in place stays only when it is the one verified
 * for these very sources; any other is removed, so the server never runs a host it would not install.
 */
export async function install(options: { releases?: string; target?: string; platform?: string; part?: Part } = {}): Promise<{ ok: boolean; message: string }> {
  const part = options.part ?? PTY_HOST;
  const target = options.target ?? join(root, "bin", part.name);
  let sources: ReturnType<typeof crateTree> = { error: "the crate sources could not be read" };
  let result: { ok: boolean; message: string; elsewhere?: boolean };
  try {
    sources = crateTree(root, part.crate);
    if ("error" in sources) result = { ok: false, message: sources.error };
    else {
      const releases = (options.releases ?? RELEASES).replace(/\/$/, "");
      const version = packageVersion();
      const local = { ...options, part };
      result = await attempt(sources.tree, target, local, { base: `${releases}/v${version}`, name: `release v${version}`, version });
      if (!result.ok && result.elsewhere) {
        const host = part === PTY_HOST ? sources : crateTree(root, PTY_HOST.crate);
        const keeper = part === ACP_KEEPER ? sources : crateTree(root, ACP_KEEPER.crate);
        if ("tree" in host) {
          const legacy = `${TREE_RELEASE}${host.tree}`;
          const tags = "tree" in keeper ? [`${legacy}-${keeper.tree}`, legacy] : [legacy];
          for (const tag of tags) {
            const built = await attempt(sources.tree, target, local,
              { base: `${releases}/${tag}`, name: `prerelease ${tag.slice(0, TREE_RELEASE.length + 12)}` });
            result = built.ok || !built.elsewhere ? built : { ok: false, message: `${result.message}, and ${built.message}` };
            if (!built.elsewhere) break;
          }
        }
      }
    }
  } catch (error) {
    result = { ok: false, message: `could not install the ${part.label} (${message(error)})` };
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

export const TREE_RELEASE = "pty-sidecar-";

/**
 * One place a host may come from: a release (`version`: its manifest must be that version's) or the
 * prerelease of a crate tree (any version: the crate check is what ties it to these sources).
 */
async function attempt(crate: string, target: string, options: { platform?: string; part: Part }, source: { base: string; name: string; version?: string }): Promise<{ ok: boolean; message: string; elsewhere?: boolean }> {
  const { part } = options;
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const asset = PLATFORM_ASSET[platform];
  if (!asset) return { ok: false, message: `no ${part.label} for ${platform}` };
  const version = packageVersion();
  const { base, name } = source;
  const signal = AbortSignal.timeout(INSTALL_DEADLINE_MS);
  let found: unknown;
  try {
    found = JSON.parse(new TextDecoder().decode(await download(`${base}/${manifestOf(part)}`, signal)));
  } catch (error) {
    return { ok: false, message: `${name} has no ${part.label} (${message(error)})`, elsewhere: true };
  }
  if (!isObject(found) || (source.version !== undefined && found["version"] !== source.version) || typeof found["crate"] !== "string" || !isObject(found["assets"])) {
    return { ok: false, message: `${name}'s ${manifestOf(part)} is not a manifest for ${source.version === undefined ? `a ${part.label}` : `v${source.version}`}` };
  }
  if (found["crate"] !== crate) return { ok: false, message: `${name}'s ${part.label} was built from other ${part.crate} sources than this checkout's`, elsewhere: true };
  const entry = found["assets"][platform];
  if (!isObject(entry) || typeof entry["sha256"] !== "string" || !/^[0-9a-f]{64}$/.test(entry["sha256"]) || entry["file"] !== `${part.name}-${asset}`) {
    return { ok: false, message: `${name}'s manifest names no ${part.label} for ${platform}` };
  }
  const expected = entry["sha256"];
  const file = entry["file"];
  if (verifiedFor(target, crate) && sha256(readFileSync(target)) === expected && runsHere(target, part)) return { ok: true, message: `${part.label} of ${name} already installed at ${target}` };
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
    if (!runsHere(temporary, part)) return { ok: false, message: `${file} does not run on this PC; nothing was installed` };
    // the record goes first: a host in place without one is removed by the next failed install, never trusted
    rmSync(recordOf(target), { force: true });
    renameSync(temporary, target);
    writeFileSync(recordOf(target), `${JSON.stringify({ crate, sha256: digest, version } satisfies Installed)}\n`);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { ok: true, message: `installed the ${part.label} of ${name} (sha256 ${digest}) at ${target}` };
}

if (import.meta.main) {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === "build" && rest.length === 2) build(rest[0]!, resolve(rest[1]!));
  else if (verb === "manifest" && rest.length === 1) manifest(resolve(rest[0]!));
  else if (verb === "install" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--strict"))) {
    const results = await Promise.all(PARTS.map((part) => install({ part })));
    PARTS.forEach((part, i) => console.log(`Ovis: ${results[i]!.message}${results[i]!.ok ? "" : `; ${part.without}`}`));
    if (results.some((result) => !result.ok) && rest[0] === "--strict") process.exit(1);
  } else {
    console.error("Usage: bun scripts/pty-sidecar.ts build <linux-x64|linux-arm64|darwin-universal> <dir> | manifest <dir> | install [--strict]");
    process.exit(2);
  }
}
