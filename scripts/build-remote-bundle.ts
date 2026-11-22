/**
 * A remote PC's runtime: the compiled server and what runs beside it (scripts/server-artifact.ts), plus checksum-pinned
 * Node and herdr. Every platform's bundle is assembled from the compile and verified downloads on any OS; only one built
 * for this PC runs its PTY smoke test here. A Windows bundle is the server alone: herdr has no `terminal attach` there
 * (no Node, no PTY), and herdr itself comes from its own installer, which setup runs (server/remote-host.ts).
 */
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { architectures } from "./pty-sidecar.ts";
import { binaryName, stageServerArtifact } from "./server-artifact.ts";
import type { ServerPlatform } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const hostPlatform = `${process.platform}-${process.arch}`;
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.length > 1) throw new Error("Usage: bun run build:remote [linux-x64|linux-arm64|darwin-x64|darwin-arm64|win32-x64]");
const platform = args[0] ?? hostPlatform;
const herdrPins: Record<string, [string, string]> = {
  "linux-x64": ["herdr-linux-x86_64", "18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7"],
  "linux-arm64": ["herdr-linux-aarch64", "4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0"],
  "darwin-x64": ["herdr-macos-x86_64", "db62d548ff3e832b087a96b1894a08d26be3905f1830309cd556783f215d4054"],
  "darwin-arm64": ["herdr-macos-aarch64", "5173a3e0ae42d5d1ab7ebfa5d5e6329f7c3d23f8e1a3677c7ce3231da2884157"],
};
// Official release digests: nodejs.org/dist/v22.23.2/SHASUMS256.txt.
const nodePins: Record<string, string> = {
  "linux-x64": "b294a556e639d64338823920e5866c21c02741742d2e1529ee1a225c1ec9252a",
  "linux-arm64": "013b59cfd2819703a6f4a14ab891fc46fc2a4e3f5bcd92de3fb4929b43e35b30",
  "darwin-x64": "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
  "darwin-arm64": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
};
const windows = platform === "win32-x64";
const pin = herdrPins[platform];
if (!pin && !windows) throw new Error(`Unsupported platform ${platform}`);
const mac = platform.startsWith("darwin-");
const serverPlatform: ServerPlatform = windows ? "windows-x64" : platform as ServerPlatform;
if (!existsSync(join(root, "dist/index.html"))) throw new Error("Run bun run build before building remote bundles");

const output = resolve(process.env["HERDR_BUNDLE_OUTPUT"] ?? join(root, "remote-bundles"));
const stage = join(output, `stage-${platform}`);
const downloads = join(output, `downloads-${platform}`);
rmSync(stage, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function download(url: string, sha256: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Runtime download failed (${response.status}): ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (digest(bytes) !== sha256) throw new Error(`Runtime checksum mismatch: ${url}`);
  return bytes;
}
function command(argv: string[], cwd = root): void {
  const result = Bun.spawnSync(argv, { cwd, timeout: 120_000 });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.toString()}`);
}
async function archive(): Promise<void> {
  const filename = `herdr-web-ui-${platform}.tgz`;
  const archive = join(output, filename);
  const temporaryArchive = archive + ".tmp";
  const tar = Bun.spawn(["tar", "czf", temporaryArchive, "-C", stage, "."], { stdout: "inherit", stderr: "inherit" });
  if (await tar.exited !== 0) throw new Error("Bundle archive failed");
  const sha256 = digest(readFileSync(temporaryArchive));
  renameSync(temporaryArchive, archive);
  const manifest = join(output, `manifest-${platform}.json`);
  writeFileSync(manifest + ".tmp", JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { [platform]: { url: filename, sha256 } } }, null, 2));
  renameSync(manifest + ".tmp", manifest);
  console.log(`${filename} sha256:${sha256}`);
}
function verifyMachO(path: string): void {
  const bytes = readFileSync(path);
  const cpu = platform === "darwin-arm64" ? 0x0100000c : 0x01000007;
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== cpu) throw new Error(`Wrong macOS architecture: ${path}`);
}

try {
  const ptySidecar = windows ? undefined : process.env["HERDR_BUNDLE_PTY_SIDECAR"];
  if (ptySidecar) {
    const want = `${mac ? "macho" : "elf"}-${platform.endsWith("arm64") ? "aarch64" : "x86_64"}`;
    if (!architectures(ptySidecar).includes(want)) throw new Error(`${ptySidecar} has no ${want} code: ${architectures(ptySidecar).join(", ")}`);
  } else if (!windows) {
    console.log(`${platform}: HERDR_BUNDLE_PTY_SIDECAR is not set, so this bundle has no Rust PTY host`);
  }
  // nothing native on Windows: without Node and node-pty the server finds no PTY sidecar and mirrors panes (server/pty/sidecar.ts)
  await stageServerArtifact({ platform: serverPlatform, dir: stage, nodePty: !windows, downloads, ...(ptySidecar ? { ptySidecar: { binary: ptySidecar } } : {}) });
  const bundle = { version: REMOTE_BUNDLE_VERSION, platform, server: (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version, bun: Bun.version };
  if (windows) {
    writeFileSync(join(stage, "bundle.json"), JSON.stringify({ ...bundle, herdr: null, node: null, native_smoke_tested: false }));
  } else {
    // Use a reproducible LTS runtime instead of the builder's Node: newer local
    // binaries can require extra system libraries absent on an otherwise supported PC.
    const nodeVersion = "v22.23.2";
    mkdirSync(join(stage, "bin"), { recursive: true });
    const nodeArchive = join(downloads, "node.tar.gz");
    writeFileSync(nodeArchive, await download(`https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-${platform}.tar.gz`, nodePins[platform]!));
    command(["tar", "xzf", nodeArchive, "-C", downloads, `node-${nodeVersion}-${platform}/bin/node`]);
    cpSync(join(downloads, `node-${nodeVersion}-${platform}/bin/node`), join(stage, "bin/node"));
    const ptyPackage = join(stage, "node_modules/@lydell", `node-pty-${platform}`);
    if (mac) for (const name of ["pty.node", "spawn-helper"]) verifyMachO(join(ptyPackage, name));
    writeFileSync(join(stage, "bin/herdr"), await download(`https://github.com/herdrdev/herdr/releases/download/v0.9.3/${pin![0]}`, pin![1]), { mode: 0o755 });
    for (const name of ["node", "herdr"]) {
      chmodSync(join(stage, "bin", name), 0o755);
      if (mac) verifyMachO(join(stage, "bin", name));
    }
    if (mac) verifyMachO(join(stage, binaryName(serverPlatform)));
    writeFileSync(join(stage, "bundle.json"), JSON.stringify({ ...bundle, herdr: "0.9.3", node: nodeVersion, pty_sidecar: Boolean(ptySidecar), native_smoke_tested: platform === hostPlatform }));
    if (platform === hostPlatform) command([join(stage, "bin/node"), join(stage, "pty-smoke.mjs")], stage);
    else console.log(`${platform}: verified binary architecture and checksums; PTY execution is checked on the destination before activation`);
  }
  await archive();
} finally {
  rmSync(stage, { recursive: true, force: true });
  rmSync(downloads, { recursive: true, force: true });
}
