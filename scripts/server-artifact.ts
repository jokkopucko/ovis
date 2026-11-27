import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIntegration } from "./install-gjc-integration.ts";
import { binaryName, type ServerPlatform } from "./server-manifest.ts";

const root = resolve(import.meta.dir, "..");
const packageJson = (): { version: string } => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

export { binaryName };

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * `bun build --compile` of server/main.ts for `platform` into `outfile`: minified JavaScript and Bun bytecode, no
 * source maps. The source is not published with it, but anyone who unpacks the file can read that code.
 * `--format=esm` because the entries await at top level, which bytecode allows only in an ES module. It reads no
 * bunfig.toml or .env from the folder it runs in: an agent runs `ovis-server approval-hook` in the project, where a
 * model may write files, and a preload there could answer for the hook.
 */
export async function buildBinary(platform: ServerPlatform, outfile: string, entry = "server/main.ts"): Promise<void> {
  const statusline = Object.fromEntries(["statusline-context.ts", "statusline-capture.ts"].map((name) => [name, readFileSync(join(root, "server", name), "utf8")]));
  const build = Bun.spawn([
    process.execPath, "build", "--compile", "--minify", "--bytecode", "--format=esm", `--target=bun-${platform}`,
    "--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv",
    "--define", `OVIS_STATUSLINE_SOURCES=${JSON.stringify(statusline)}`,
    entry, "server/file-worker.ts", "--outfile", outfile,
  ], { cwd: root, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const code = await build.exited;
  if (code !== 0) throw new Error(`bun build --compile for ${platform} exited with ${code}`);
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
  ptySidecar?: { binary: string; record?: string; sha256?: string };
  /** the ACP keeper (crates/acp-keeper), carried and vouched for as the PTY host is */
  acpKeeper?: { binary: string; record?: string; sha256?: string };
  build?: (platform: ServerPlatform, outfile: string) => Promise<void>;
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
  await integrations(dir);
  for (const [name, carried] of [["ovis-pty-sidecar", options.ptySidecar], ["ovis-acp-keeper", options.acpKeeper]] as const) {
    if (!carried) continue;
    const binary = join(dir, "bin", name);
    mkdirSync(join(dir, "bin"), { recursive: true });
    copyFileSync(carried.binary, binary);
    chmodSync(binary, 0o755);
    // the record the server checks before it runs the binary (server/native-binary.ts): in the binary, for the version compiled into it
    const digest = sha256(readFileSync(binary));
    if (carried.sha256 !== undefined && digest !== carried.sha256) throw new Error(`Staged ${name} does not match its verified SHA-256`);
    const record = carried.record ? JSON.parse(readFileSync(carried.record, "utf8")) as Record<string, unknown> : { crate: null };
    writeFileSync(`${binary}.json`, `${JSON.stringify({ ...record, sha256: digest, version: packageJson().version })}\n`);
  }
}
