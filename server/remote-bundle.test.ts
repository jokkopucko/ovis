import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_BUNDLE_VERSION } from "../shared/machines.ts";
import { bundleFile, bundleManifestSource } from "./remote-bundle.ts";
import { RemoteResponseTooLarge } from "./remote-json.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(platform: string) {
  const directory = mkdtempSync(join(tmpdir(), "herdr-bundle-source-")); roots.push(directory);
  const bytes = Buffer.from(`private runtime for ${platform}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(directory, "bundle.tgz"), bytes);
  const manifest = join(directory, `manifest-${platform}.json`);
  writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { [platform]: { url: "bundle.tgz", sha256 } } }));
  return { directory, manifest, bytes, sha256 };
}

function served(value: unknown, total: number, status = 200) {
  const json = JSON.stringify(value);
  const receipt = { sent: 0, cancelled: false };
  let left = total - json.length;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (receipt.sent === total) { controller.close(); return; }
      const chunk = receipt.sent === 0 ? Buffer.from("{") : left > 0 ? Buffer.alloc(Math.min(left, 64 * 1024), 0x20) : Buffer.from(json.slice(1));
      if (receipt.sent > 0 && left > 0) left -= chunk.byteLength;
      receipt.sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { receipt.cancelled = true; },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { status }), receipt };
}

describe("remote bundle sources", () => {
  it("caps the release manifest and cancels an answer it will not read", async () => {
    const { bytes, sha256, directory } = fixture("linux-x64");
    const cacheDir = join(directory, "cache"); mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, `${sha256}.tgz`), bytes);
    const manifest = { version: REMOTE_BUNDLE_VERSION, assets: { "linux-x64": { url: "https://bundles.invalid/bundle.tgz", sha256 } } };
    const options = { manifest: "https://releases.invalid/manifest.json", cacheDir };
    let next = served(manifest, 1024 * 1024);
    const release = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => next.response, { preconnect: fetch.preconnect }));
    try {
      expect((await bundleFile("linux-x64", new AbortController().signal, options)).path).toBe(join(cacheDir, `${sha256}.tgz`));
      next = served(manifest, 1024 * 1024 + 1);
      await expect(bundleFile("linux-x64", new AbortController().signal, options)).rejects.toBeInstanceOf(RemoteResponseTooLarge);
      expect(next.receipt).toEqual({ sent: 1024 * 1024 + 1, cancelled: true });
      next = served({ error: "missing" }, 4 * 1024 * 1024, 404);
      await expect(bundleFile("linux-x64", new AbortController().signal, options)).rejects.toThrow("unavailable (HTTP 404)");
      expect(next.receipt).toEqual({ sent: 0, cancelled: true });
    } finally { release.mockRestore(); }
  });

  it("installs each Mac architecture from local manifests without a published release", async () => {
    for (const platform of ["darwin-arm64", "darwin-x64"]) {
      const { directory, manifest, bytes, sha256 } = fixture(platform);
      const options = { directory, manifest: "" };
      expect(await bundleManifestSource(platform, options)).toBe(manifest);
      const asset = await bundleFile(platform, new AbortController().signal, options);
      expect(readFileSync(asset.path)).toEqual(bytes);
      expect(asset.size).toBe(bytes.length);
      expect(asset.sha256).toBe(sha256);
    }
  });

  it("keeps explicit manifest configuration ahead of automatic discovery", async () => {
    const local = fixture("darwin-arm64");
    const override = fixture("darwin-arm64");
    expect(await bundleManifestSource("darwin-arm64", { directory: local.directory, manifest: override.manifest })).toBe(override.manifest);
    await expect(bundleFile("darwin-arm64", new AbortController().signal, { directory: local.directory, manifest: join(local.directory, "missing.json") })).rejects.toThrow("ENOENT");
  });

  it("uses the release only when the requested platform has no local manifest", async () => {
    const { directory } = fixture("linux-x64");
    expect(await bundleManifestSource("darwin-arm64", { directory, manifest: "" })).toBe(`https://github.com/devswha/ovis/releases/download/remote-v${REMOTE_BUNDLE_VERSION}/manifest.json`);
    await expect(bundleManifestSource("../linux-x64", { directory })).rejects.toThrow("Unsupported bundle platform");
  });

  it("rejects corrupted local bytes instead of silently falling back to another source", async () => {
    const { directory } = fixture("darwin-arm64");
    writeFileSync(join(directory, "bundle.tgz"), "changed after manifest creation");
    await expect(bundleFile("darwin-arm64", new AbortController().signal, { directory, manifest: "" })).rejects.toThrow("checksum mismatch");
  });

  it("rejects incompatible manifests, path traversal and cancelled setup", async () => {
    const { directory, manifest, sha256 } = fixture("darwin-arm64");
    const options = { directory, manifest: "" };
    writeFileSync(manifest, JSON.stringify({ version: "incompatible", assets: {} }));
    await expect(bundleFile("darwin-arm64", new AbortController().signal, options)).rejects.toThrow("version mismatch");
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "darwin-arm64": { url: "../bundle.tgz", sha256 } } }));
    await expect(bundleFile("darwin-arm64", new AbortController().signal, options)).rejects.toThrow("Bundle URL must use HTTPS");
    const controller = new AbortController(); controller.abort(new Error("test cancelled"));
    await expect(bundleFile("darwin-arm64", controller.signal, options)).rejects.toThrow("test cancelled");
  });

  it("reuses a cached release bundle by checksum and never trusts a changed one", async () => {
    const { directory, manifest, bytes, sha256 } = fixture("linux-x64");
    writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { "linux-x64": { url: "https://bundles.invalid/bundle.tgz", sha256 } } }));
    const cacheDir = join(directory, "cache"); mkdirSync(cacheDir);
    writeFileSync(join(cacheDir, `${sha256}.tgz`), bytes);
    const options = { directory, manifest: "", cacheDir };
    const cached = await bundleFile("linux-x64", new AbortController().signal, options);
    expect(cached.path).toBe(join(cacheDir, `${sha256}.tgz`));
    writeFileSync(join(cacheDir, `${sha256}.tgz`), "tampered");
    await expect(bundleFile("linux-x64", new AbortController().signal, options)).rejects.toThrow();
    await expect(bundleFile("linux-x64", new AbortController().signal, { directory, manifest: "" })).rejects.toThrow("No bundle cache directory");
  });
});
