import { expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { systemUsageContext, UsageService } from "./usage.ts";

const guard = { "x-herdr-machine": "1", "content-type": "application/json" };

it("turns Claude's status-line reading on and off from a boolean only, and a watching device only reads it", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-statusline-switch-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const settings = join(home, ".claude", "settings.json");
  const original = '{\n    "theme": "dark",\n    "statusLine": { "type": "command", "command": "printf hi" }\n}\n';
  writeFileSync(settings, original);
  const store = new DeviceStore(join(root, "state"));
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const usage = new UsageService({ ...systemUsageContext(), home, env: {} }, []);
  const server = createServer({ port: 0, stateDir: join(root, "state"), token: "test-statusline", tailscaleOwner: null, machines: false, usage });
  const base = `http://127.0.0.1:${server.port}`;
  const owner = { ...guard, authorization: "Bearer test-statusline" };
  const watching = { ...guard, cookie: `ovis_device=${watch.token}` };
  const post = (headers: Record<string, string>, body: unknown, path = "usage/statusline") =>
    fetch(`${base}/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  try {
    expect(await (await fetch(`${base}/api/usage/statusline`, { headers: watching })).json()).toEqual({ installed: false, supported: true });
    // a watching device reads the switch and cannot turn it, on this PC or through a PC's route
    for (const path of ["usage/statusline", "machines/pc1/usage/statusline"]) {
      const refused = await post(watching, { enabled: true }, path);
      expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
    }
    expect(readFileSync(settings, "utf8")).toBe(original);
    // the body is on or off and nothing else: no path, no command
    for (const body of [{ enabled: true, command: "touch /tmp/x" }, { enabled: "yes" }, { path: "/tmp" }, null]) {
      expect((await post(owner, body)).status).toBe(400);
    }
    expect(existsSync(join(home, ".claude", "herdr-statusline"))).toBe(false);

    expect(await (await post(owner, { enabled: true })).json()).toEqual({ installed: true, supported: true });
    expect(JSON.parse(readFileSync(settings, "utf8")).statusLine.command).toContain("herdr-statusline");
    expect(await (await fetch(`${base}/api/usage/statusline`, { headers: owner })).json()).toEqual({ installed: true, supported: true });
    expect(await (await post(owner, { enabled: false })).json()).toEqual({ installed: false, supported: true });
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(existsSync(join(home, ".claude", "herdr-statusline"))).toBe(false);
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
