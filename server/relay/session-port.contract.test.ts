import { expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortalService } from "../portal.ts";
import * as tailscale from "../tailscale.ts";
import { bounded, deferred, relayConnection, relayDevice, relayFixture } from "./test-helpers.ts";

it("starts Portal through a relay session on the server's actual listening port", async () => {
  // Given: a stand-in Portal runner records its expose arguments without reaching a public relay.
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-port-"));
  const bin = join(stateDir, "portal-runner");
  const seen = join(stateDir, "seen.json");
  writeFileSync(bin, [
    `#!${process.execPath}`,
    'import { renameSync, writeFileSync } from "node:fs";',
    'if (process.argv[2] === "version") { console.log("v2.6.1"); }',
    'else if (process.argv[2] === "expose") {',
    `  writeFileSync(${JSON.stringify(seen + ".pending")}, JSON.stringify(process.argv.slice(2)));`,
    `  renameSync(${JSON.stringify(seen + ".pending")}, ${JSON.stringify(seen)});`,
    '  console.log("INF service ready at https://herdr-test.relay.example:443");',
    '  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });',
    '  process.on("SIGTERM", () => process.exit(0));',
    '} else { process.exitCode = 2; }',
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);
  const portal = new PortalService({
    stateDir, bin,
    fetch: Object.assign(async () => Response.json({ data: { release_version: "v2.6.1" } }), { preconnect: fetch.preconnect }),
  });
  const f = relayFixture(false, { token: "relay-port-test", portal, machines: false });
  const exposed = deferred<void>();
  const watcher = watch(stateDir, (_event, filename) => {
    if (filename === "seen.json") exposed.resolve();
  });
  try {
    const link = await relayConnection(f);
    await link.auth(await relayDevice(f));
    // When: a driving device starts Portal over its authenticated relay session.
    const request = link.open("/api/portal/start", {
      method: "POST", headers: [["content-type", "application/json"], ["x-herdr-update", "1"]], body: "stream",
    });
    const upload = request.stream.sendBody(new Response(JSON.stringify({
      relay: "relay.example", auth: { method: "none", allow: [], issuer: null, client_id: null },
    })).body ?? new ReadableStream());
    const response = await request.response;
    await upload;
    expect(response.status).toBe(202);
    await response.text();
    await bounded(exposed.promise);
    // Then: both the upstream route and saved ownership name this listener, not the default port.
    expect(JSON.parse(readFileSync(seen, "utf8"))).toContain(`/=${f.app.port}`);
    expect(JSON.parse(readFileSync(join(stateDir, "portal", "state.json"), "utf8"))).toMatchObject({ port: f.app.port });
  } finally {
    watcher.close();
    await portal.shutdown();
    f.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("reports the server's actual listening port for access over a relay session", async () => {
  // Given: an ephemeral listener and isolated Tailscale discovery.
  const discovery = spyOn(tailscale, "readTailscale").mockResolvedValue(null);
  const f = relayFixture(false, { machines: false });
  try {
    const link = await relayConnection(f);
    await link.auth(await relayDevice(f));
    // When
    const response = await link.open("/api/access").response;
    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ port: f.app.port });
  } finally {
    discovery.mockRestore();
    f.close();
  }
});
