import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { binaryName, PTY_PINS, stageServerArtifact } from "./server-artifact.ts";
import { SERVER_PLATFORMS, type ServerPlatform } from "./server-manifest.ts";

// node-pty's package for this PC is installed, so nothing is downloaded; the compile is stood in for (the integration
// lane's server/compiled-server.contract.test.ts runs a real one)
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}` as ServerPlatform;
const root = mkdtempSync(join(tmpdir(), "ovis-artifact-"));
const dir = join(root, "server");
const files = (): string[] => [...new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })].map((path) => path.replaceAll("\\", "/"));

beforeAll(async () => {
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html>");
  const host = join(root, "ovis-pty-sidecar");
  writeFileSync(host, "rust host");
  writeFileSync(`${host}.json`, JSON.stringify({ crate: "c".repeat(40), sha256: "stale", version: "0.0.1" }));
  await stageServerArtifact({ platform, dir, nodePty: true, dist, ptySidecar: { binary: host, record: `${host}.json` }, build: async (_platform, outfile) => writeFileSync(outfile, "binary") });
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the folder that runs the compiled server", () => {
  it("holds the binary, the client and what runs beside it, and no server or shared source", () => {
    const all = files();
    expect(all).toContain(binaryName(platform));
    expect(all).toContain("dist/index.html");
    expect(all).toContain("pty-host.mjs");
    expect(all).toContain("pty-smoke.mjs");
    expect(all).toContain("node_modules/@lydell/node-pty/package.json");
    expect(all.some((path) => path.startsWith("node_modules/@lydell/node-pty-") && path.endsWith("/pty.node"))).toBe(true);
    expect(all.filter((path) => path.startsWith("server/") || path.startsWith("shared/"))).toEqual([]);
    expect(all.filter((path) => path.endsWith(".ts"))).toEqual([]);
  });

  it("vouches for the Rust PTY host with the version compiled into the binary, and its bytes", () => {
    const record = JSON.parse(readFileSync(join(dir, "bin", "ovis-pty-sidecar.json"), "utf8")) as Record<string, unknown>;
    expect(record).toEqual({ crate: "c".repeat(40), sha256: createHash("sha256").update("rust host").digest("hex"), version });
  });

  it("installs an agent integration from what it carries, with no source to build it from", () => {
    expect(existsSync(join(dir, "integrations", "gjc.js"))).toBe(true);
    writeFileSync(join(dir, "integrations", "gjc.js"), "export default function extension() {} // built beside the binary\n");
    const home = join(root, "home");
    mkdirSync(home);
    const run = Bun.spawnSync([process.execPath, join(dir, "scripts", "install-gjc-integration.js")], { cwd: dir, env: { ...process.env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const installed = readFileSync(join(home, ".gjc", "agent", "extensions", "herdr-web-ui.js"), "utf8");
    expect(installed).toContain("built beside the binary");
    expect(existsSync(join(dir, "scripts", "install-pi-integration.js"))).toBe(true);
  });
});

describe("node-pty in the server folder, for each of the five platforms", () => {
  const ptyVersion = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies["@lydell/node-pty"]!;
  const NATIVE: Record<ServerPlatform, { name: string; files: string[] }> = {
    "linux-x64": { name: "node-pty-linux-x64", files: ["pty.node"] },
    "linux-arm64": { name: "node-pty-linux-arm64", files: ["pty.node"] },
    "darwin-arm64": { name: "node-pty-darwin-arm64", files: ["pty.node", "spawn-helper"] },
    "darwin-x64": { name: "node-pty-darwin-x64", files: ["pty.node", "spawn-helper"] },
    "windows-x64": { name: "node-pty-win32-x64", files: ["conpty.node", "conpty_console_list.node"] },
  };
  const work = join(root, "pty");
  function modules(name: string, installed?: { platform: ServerPlatform; version: string }): string {
    const dir = join(work, name, "node_modules", "@lydell");
    mkdirSync(join(dir, "node-pty"), { recursive: true });
    writeFileSync(join(dir, "node-pty", "package.json"), JSON.stringify({ name: "@lydell/node-pty", version: ptyVersion }));
    if (installed) {
      const pkg = join(dir, NATIVE[installed.platform].name);
      mkdirSync(pkg);
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: installed.version }));
      for (const file of NATIVE[installed.platform].files) writeFileSync(join(pkg, file), "installed");
    }
    return join(work, name, "node_modules");
  }
  function tarball(platform: ServerPlatform): { bytes: Uint8Array; pins: typeof PTY_PINS } {
    const pkg = join(work, `tar-${platform}`, "package");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: ptyVersion }));
    for (const file of NATIVE[platform].files) writeFileSync(join(pkg, file), "downloaded");
    const archive = join(work, `${platform}.tgz`);
    expect(Bun.spawnSync(["tar", "czf", archive, "-C", join(work, `tar-${platform}`), "package"]).exitCode).toBe(0);
    const bytes = new Uint8Array(readFileSync(archive));
    return { bytes, pins: { ...PTY_PINS, [platform]: createHash("sha256").update(bytes).digest("hex") } };
  }
  const stage = (platform: ServerPlatform, options: { nodePty: boolean; nodeModules: string; fetchTarball?: (url: string) => Promise<Uint8Array>; pins?: typeof PTY_PINS }) => {
    const out = join(work, `out-${platform}-${Math.random().toString(36).slice(2)}`);
    const dist = join(work, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    return { out, done: stageServerArtifact({ platform, dir: out, dist, downloads: join(out, "..", `dl-${platform}`), build: async (_platform, outfile) => writeFileSync(outfile, "binary"), fetchTarball: options.fetchTarball ?? (async () => { throw new Error("no download expected"); }), ...options }) };
  };
  const noDownload = async (): Promise<Uint8Array> => { throw new Error("no download expected"); };

  it("takes the platform's installed package, whatever its native files, with no download (the Windows desktop build)", async () => {
    for (const platform of SERVER_PLATFORMS) {
      const { out, done } = stage(platform, { nodePty: true, nodeModules: modules(`installed-${platform}`, { platform, version: ptyVersion }), fetchTarball: noDownload });
      await done;
      for (const file of NATIVE[platform].files) expect(readFileSync(join(out, "node_modules", "@lydell", NATIVE[platform].name, file), "utf8")).toBe("installed");
    }
  });

  it("fetches the pinned tarball for a platform this PC has no package for, and for a package of another version", async () => {
    for (const platform of SERVER_PLATFORMS) {
      const { bytes, pins } = tarball(platform);
      const urls: string[] = [];
      const fetchTarball = async (url: string) => { urls.push(url); return bytes; };
      for (const nodeModules of [modules(`none-${platform}`), modules(`old-${platform}`, { platform, version: "0.0.1" })]) {
        const { out, done } = stage(platform, { nodePty: true, nodeModules, fetchTarball, pins });
        await done;
        for (const file of NATIVE[platform].files) expect(readFileSync(join(out, "node_modules", "@lydell", NATIVE[platform].name, file), "utf8")).toBe("downloaded");
      }
      expect(urls).toEqual(Array(2).fill(`https://registry.npmjs.org/@lydell/${NATIVE[platform].name}/-/${NATIVE[platform].name}-${ptyVersion}.tgz`));
    }
  });

  it("refuses a tarball that is not the pinned one, naming it", async () => {
    for (const platform of SERVER_PLATFORMS) {
      const { done } = stage(platform, { nodePty: true, nodeModules: modules(`bad-${platform}`), fetchTarball: async () => new Uint8Array([1, 2, 3]) });
      await expect(done).rejects.toThrow(`Checksum mismatch: https://registry.npmjs.org/@lydell/${NATIVE[platform].name}/`);
    }
  });

  it("leaves node-pty out where nothing runs it (a Windows remote bundle carries no Node)", async () => {
    const { out, done } = stage("windows-x64", { nodePty: false, nodeModules: modules("windows-bundle"), fetchTarball: noDownload });
    await done;
    expect(existsSync(join(out, "node_modules"))).toBe(false);
    expect(existsSync(join(out, "pty-smoke.mjs"))).toBe(false);
  });
});
