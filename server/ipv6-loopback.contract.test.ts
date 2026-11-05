import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

/** a host or container with no IPv6 loopback cannot run the opt-in listener; any other bind error still fails */
const ipv6Available = (() => {
  try {
    Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("ok") }).stop(true);
    return true;
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return false;
    throw error;
  }
})();

test.skipIf(!ipv6Available)("IPv4, IPv6 and localhost share one server without redirecting origins", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-ipv6-loopback-"));
  let app: ReturnType<typeof createServer> | undefined;
  try {
    app = createServer({ hostname: "127.0.0.1", port: 0, stateDir, ipv6Loopback: true });
    let boot: string | undefined;
    for (const host of ["127.0.0.1", "[::1]", "localhost"]) {
      const response = await fetch(`http://${host}:${app.port}/api/health`, { redirect: "manual" });
      expect(response.status).toBe(200);
      const current = (await response.json()).web_ui.boot_id as string;
      expect(current).toBe(boot ?? current);
      boot = current;
      const page = await fetch(`http://${host}:${app.port}/`, { headers: { accept: "text/html" }, redirect: "manual" });
      expect(page.status).toBe(200);
      expect(page.headers.get("location")).toBeNull();
      await page.arrayBuffer();
      const socket = new WebSocket(`ws://${host}:${app.port}/ws`);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("WebSocket did not open")), 3000);
          socket.onopen = () => { clearTimeout(timer); resolve(); };
          socket.onerror = () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); };
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
      } finally { socket.close(); }
    }
  } finally { app?.stop(); rmSync(stateDir, { recursive: true, force: true }); }
  const replacement = Bun.serve({ hostname: "::1", port: app!.port, fetch: () => new Response("ok") });
  replacement.stop(true);
});

test.skipIf(!ipv6Available)("a taken ::1 port fails the start and frees the IPv4 port", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-ipv6-loopback-"));
  const taken = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response("taken") });
  try {
    expect(() => createServer({ hostname: "127.0.0.1", port: taken.port, stateDir, ipv6Loopback: true })).toThrow();
    Bun.serve({ hostname: "127.0.0.1", port: taken.port, fetch: () => new Response("ok") }).stop(true);
  } finally { taken.stop(true); rmSync(stateDir, { recursive: true, force: true }); }
});
