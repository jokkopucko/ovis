import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIntegration } from "./install-gjc-integration.ts";
import { binaryName, type ServerPlatform } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const packageJson = (): { version: string; dependencies: Record<string, string> } => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

export { binaryName };

const PTY_PACKAGE: Record<ServerPlatform, string> = {
  "linux-x64": "node-pty-linux-x64",
  "linux-arm64": "node-pty-linux-arm64",
  "darwin-x64": "node-pty-darwin-x64",
  "darwin-arm64": "node-pty-darwin-arm64",
  "windows-x64": "node-pty-win32-x64",
};
// sha256 of the registry tarballs for the @lydell/node-pty version package.json pins; a bump must update these
// (windows-x64: the tarball whose sha512 bun.lock records)
export const PTY_PINS: Record<ServerPlatform, string> = {
  "linux-x64": "8d2e043026672f11aafd5f1a831f794a90d8fdd9d5e3255e8bc121df64b9d8e4",
  "linux-arm64": "c4ace306e4099a7919c7852fe29a6a9052f9d9b9eaf36617bf7c6cb72cd16118",
  "darwin-x64": "2a45297cec01dffa282f39cc1f87d1f2fa42e5c186e261ff88bfcfbce0186c00",
  "darwin-arm64": "937a533814ddeb3eb1d6d7a84f5aa2302d73ffe69332a34a94ae05e9e203eab3",
  "windows-x64": "f418f20ec3141320b78548330bd177ebfbe0c0ee7830309a5ba5392a205cea5f",
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * `bun build --compile` of server/main.ts for `platform` into `outfile`: minified JavaScript and Bun bytecode, no
 * source maps. The source is not published with it, but anyone who unpacks the file can read that code.
 * `--format=esm` because the entries await at top level, which bytecode allows only in an ES module.
 */
export async function buildBinary(platform: ServerPlatform, outfile: string, entry = "server/main.ts"): Promise<void> {
  const statusline = Object.fromEntries(["statusline-context.ts", "statusline-capture.ts"].map((name) => [name, readFileSync(join(root, "server", name), "utf8")]));
  const build = Bun.spawn([
    process.execPath, "build", "--compile", "--minify", "--bytecode", "--format=esm", `--target=bun-${platform}`,
    "--define", `OVIS_STATUSLINE_SOURCES=${JSON.stringify(statusline)}`,
    entry, "server/file-worker.ts", "--outfile", outfile,
  ], { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await build.exited;
  if (code !== 0) throw new Error(`bun build --compile for ${platform} exited with ${code}`);
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * node-pty's prebuilt package for `platform`: the one installed in `modules` when it is the version package.json pins
 * (whatever native files it holds: pty.node on Linux and macOS, conpty.node on Windows), else the pinned tarball.
 */
async function ptyPackage(platform: ServerPlatform, into: string, downloads: string, modules: string, fetchTarball: (url: string) => Promise<Uint8Array>, pins: Record<ServerPlatform, string>): Promise<void> {
  const name = PTY_PACKAGE[platform];
  const version = packageJson().dependencies["@lydell/node-pty"]!;
  const installed = join(modules, "@lydell", name);
  try {
    if ((JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version?: unknown }).version === version) {
      cpSync(installed, into, { recursive: true });
      return;
    }
  } catch {}
  const url = `https://registry.npmjs.org/@lydell/${name}/-/${name}-${version}.tgz`;
  const bytes = await fetchTarball(url);
  if (sha256(bytes) !== pins[platform]) throw new Error(`Checksum mismatch: ${url}`);
  mkdirSync(downloads, { recursive: true });
  const archive = join(downloads, `${name}.tgz`);
  writeFileSync(archive, bytes);
  mkdirSync(into, { recursive: true });
  const tar = Bun.spawnSync(["tar", "xzf", archive, "-C", into, "--strip-components=1"], { stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(`Could not unpack ${archive}: ${tar.stderr.toString()}`);
}

async function integrations(dir: string): Promise<void> {
  mkdirSync(join(dir, "integrations"), { recursive: true });
  writeFileSync(join(dir, "integrations", "gjc.js"), await buildIntegration("gjc", "bun"));
  writeFileSync(join(dir, "integrations", "pi-ask.js"), await buildIntegration("pi-ask", "node"));
  for (const name of ["install-gjc-integration", "install-pi-integration"]) {
    const result = await Bun.build({ entrypoints: [join(root, "scripts", `${name}.ts`)], target: "bun", format: "esm", outdir: join(dir, "scripts"), naming: `${name}.js` });
    if (!result.success) throw new Error(`Could not build ${name}: ${result.logs.map((entry) => entry.message).join("\n")}`);
  }
}

export interface ArtifactOptions {
  platform: ServerPlatform;
  dir: string;
  /**
   * node-pty and the Node sidecar beside the binary, as main shipped them: in every desktop app (the build host's own
   * package; on Windows the server's sign-in terminals run on it where the PC has Node) and in every remote bundle but
   * Windows', which carries no Node to run them
   */
  nodePty: boolean;
  ptySidecar?: { binary: string; record?: string };
  downloads?: string;
  build?: (platform: ServerPlatform, outfile: string) => Promise<void>;
  nodeModules?: string;
  fetchTarball?: (url: string) => Promise<Uint8Array>;
  pins?: Record<ServerPlatform, string>;
  dist?: string;
}

export async function stageServerArtifact(options: ArtifactOptions): Promise<void> {
  const { platform, dir } = options;
  const dist = options.dist ?? join(root, "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("Run bun run build first: the server artifact carries dist/");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await (options.build ?? buildBinary)(platform, join(dir, binaryName(platform)));
  chmodSync(join(dir, binaryName(platform)), 0o755);
  cpSync(dist, join(dir, "dist"), { recursive: true });
  copyFileSync(join(root, "server", "pty", "pty-host.mjs"), join(dir, "pty-host.mjs"));
  if (options.nodePty) {
    copyFileSync(join(root, "server", "pty", "smoke.mjs"), join(dir, "pty-smoke.mjs"));
    const modules = join(dir, "node_modules", "@lydell");
    const installed = options.nodeModules ?? join(root, "node_modules");
    cpSync(join(installed, "@lydell", "node-pty"), join(modules, "node-pty"), { recursive: true, filter: (path) => !path.endsWith(".d.ts") });
    await ptyPackage(platform, join(modules, PTY_PACKAGE[platform]), options.downloads ?? join(dir, "..", `downloads-${platform}`), installed, options.fetchTarball ?? download, options.pins ?? PTY_PINS);
    if (platform.startsWith("darwin-")) chmodSync(join(modules, PTY_PACKAGE[platform], "spawn-helper"), 0o755);
  }
  await integrations(dir);
  if (options.ptySidecar) {
    const host = join(dir, "bin", "ovis-pty-sidecar");
    mkdirSync(join(dir, "bin"), { recursive: true });
    copyFileSync(options.ptySidecar.binary, host);
    chmodSync(host, 0o755);
    // the record server/pty/host.ts checks before it runs the host: in the binary, for the version compiled into it
    const record = options.ptySidecar.record ? JSON.parse(readFileSync(options.ptySidecar.record, "utf8")) as Record<string, unknown> : { crate: null };
    writeFileSync(`${host}.json`, `${JSON.stringify({ ...record, sha256: sha256(readFileSync(host)), version: packageJson().version })}\n`);
  }
}
