import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_PREFIX, serveDemo } from "./demo-server.ts";

const root = mkdtempSync(join(tmpdir(), "demo-server-test-"));
const app = join(root, "app");
mkdirSync(join(app, "assets"), { recursive: true });
writeFileSync(join(app, "index.html"), "<p>app</p>");
writeFileSync(join(app, "assets", "a b.js"), "a();");
writeFileSync(join(root, "secret.txt"), "outside");
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const server of servers) server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

async function get(server: ReturnType<typeof Bun.serve>, path: string): Promise<[number, string]> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`);
  return [response.status, await response.text()];
}

describe("serveDemo", () => {
  it("serves the app under the site's demo path on loopback, index.html for a directory", async () => {
    const server = serveDemo(app);
    servers.push(server);
    expect(server.hostname).toBe("127.0.0.1");
    expect(await get(server, DEMO_PREFIX)).toEqual([200, "<p>app</p>"]);
    expect(await get(server, `${DEMO_PREFIX}?pane=1`)).toEqual([200, "<p>app</p>"]);
    expect(await get(server, `${DEMO_PREFIX}assets/a%20b.js`)).toEqual([200, "a();"]);
    expect((await get(server, `${DEMO_PREFIX}missing.js`))[0]).toBe(404);
    expect((await get(server, "/index.html"))[0]).toBe(404);
  });

  it("refuses a path that leaves the app or does not decode", async () => {
    const server = serveDemo(app);
    servers.push(server);
    for (const path of [`${DEMO_PREFIX}..%2Fsecret.txt`, `${DEMO_PREFIX}assets%2F..%2F..%2Fsecret.txt`, `${DEMO_PREFIX}..%5Csecret.txt`, `${DEMO_PREFIX}%E0%A4%A`]) {
      expect(await get(server, path)).toEqual([400, "bad path"]);
    }
  });

  it("serves under another prefix, the root included", async () => {
    const other = serveDemo(app, { prefix: "/app/" });
    const top = serveDemo(app, { prefix: "/" });
    servers.push(other, top);
    expect(await get(other, "/app/")).toEqual([200, "<p>app</p>"]);
    expect((await get(other, DEMO_PREFIX))[0]).toBe(404);
    expect(await get(top, "/")).toEqual([200, "<p>app</p>"]);
    expect(await get(top, "/assets/a%20b.js")).toEqual([200, "a();"]);
  });
});
