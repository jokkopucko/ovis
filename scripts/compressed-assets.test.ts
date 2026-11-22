import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync } from "node:zlib";
import { build } from "vite";

test("a production build produces exact compressed JS/CSS sidecars and leaves the shell alone", async () => {
  const output = mkdtempSync(join(tmpdir(), "herdr-compressed-build-"));
  try {
    await build({ root: join(import.meta.dir, ".."), logLevel: "silent", build: { outDir: output, emptyOutDir: true,
      rollupOptions: { output: { entryFileNames: "assets/nested/[name]-[hash].js", chunkFileNames: "assets/nested/[name]-[hash].js", assetFileNames: "assets/nested/[name]-[hash][extname]" } },
    } });
    const assets = join(output, "assets");
    const names = readdirSync(assets, { recursive: true }).filter((name) => /\.(?:js|css)$/.test(name));
    expect(names.some((name) => name.endsWith(".js"))).toBe(true);
    expect(names.some((name) => name.endsWith(".css"))).toBe(true);
    for (const name of names) {
      const path = join(assets, name);
      expect(existsSync(`${path}.br`)).toBe(true);
      expect(existsSync(`${path}.gz`)).toBe(true);
      expect(brotliDecompressSync(readFileSync(`${path}.br`))).toEqual(readFileSync(path));
      expect(gunzipSync(readFileSync(`${path}.gz`))).toEqual(readFileSync(path));
    }
    const html = readFileSync(join(output, "index.html"), "utf8");
    const startup = new Set([...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="[^"]*?(assets\/[^"]+)"/g)].map((match) => match[1]!.slice("assets/".length)));
    expect([...startup].some((name) => name.endsWith(".js")) && [...startup].some((name) => name.endsWith(".css"))).toBe(true);
    const at = (quality: number, name: string) => brotliCompressSync(readFileSync(join(assets, name)), { params: { [constants.BROTLI_PARAM_QUALITY]: quality } });
    for (const name of names) {
      const best = startup.has(name);
      expect(readFileSync(join(assets, `${name}.br`)).equals(at(best ? 11 : 5, name)), `${name} at quality ${best ? 11 : 5}`).toBe(true);
    }
    expect(names.some((name) => !startup.has(name) && name.endsWith(".js"))).toBe(true);
    expect(existsSync(join(output, "index.html.br"))).toBe(false);
    expect(existsSync(join(output, "index.html.gz"))).toBe(false);
    expect(existsSync(join(output, "sw.js.gz"))).toBe(false);
    expect(readFileSync(join(output, "sw.js"), "utf8")).toMatch(/^const BUILD = "[0-9a-f]{12}";$/m);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
// a whole production build, beside the other unit files CI runs four at a time: it took 23 s there
}, 120_000);
