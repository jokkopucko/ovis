import { afterAll, describe, expect, it } from "bun:test";
import { download, hostTarget, sha256 } from "./runtimes.ts";

const body = new TextEncoder().encode("hc 0.1.17 archive");
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new URL(request.url).pathname === "/missing" ? new Response("no", { status: 404 }) : new Response(body) });
afterAll(() => server.stop(true));
const at = (path: string) => `http://127.0.0.1:${server.port}${path}`;

describe("download", () => {
  it("returns the bytes when they hash to the pinned SHA-256", async () => {
    expect(await download({ url: at("/hc.tar.gz"), sha256: sha256(body) })).toEqual(body);
  });

  it("refuses bytes that do not", async () => {
    await expect(download({ url: at("/hc.tar.gz"), sha256: "0".repeat(64) })).rejects.toThrow(/Checksum mismatch/);
  });

  it("refuses an HTTP error", async () => {
    await expect(download({ url: at("/missing"), sha256: sha256(body) })).rejects.toThrow(/HTTP 404/);
  });
});

describe("hostTarget", () => {
  it("names the four builds, and no other", () => {
    expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(hostTarget("linux", "x64")).toBe("linux-x64");
    expect(() => hostTarget("win32", "x64")).toThrow(/not win32-x64/);
  });
});
