import { afterEach, expect, it } from "bun:test";
import { unmanagedUpdateStatus, type UpdateStatus } from "../shared/update.ts";
import { followOwnUpdate } from "./pc-update.ts";

const OFFERED = "a".repeat(40);
const servers: { stop(): void }[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(); });

function ownOvis(cancellable: boolean) {
  let building = false, cancelled = false;
  const asked: string[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    const { pathname } = new URL(request.url);
    asked.push(`${request.method} ${pathname}`);
    if (pathname === "/api/updates/install") { building = true; return Response.json({ accepted: true, install_id: "11111111-2222-4333-8444-555555555555" }, { status: 202 }); }
    if (pathname === "/api/updates/cancel") {
      if ((await request.json() as { install_id?: string }).install_id !== "11111111-2222-4333-8444-555555555555") return Response.json({ error: { code: "invalid_update_cancel" } }, { status: 400 });
      building = false; cancelled = true; return new Response(null, { status: 202 });
    }
    const status: UpdateStatus = { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true, current_version: "0.5.0", latest_version: "0.5.1",
      latest_revision: OFFERED, revision_bound_install: true, ...(cancellable ? { install_cancellable: true } : {}), ...(building ? { phase: "building", step: "build" } : {}), ...(cancelled ? { phase: "error", error_code: "update_cancelled", error: "The update was cancelled before it was installed." } : {}) };
    return Response.json(status);
  } });
  servers.push(server);
  return { endpoint: { url: `http://127.0.0.1:${server.port}`, token: "fictional" }, asked };
}

for (const cancellable of [true, false]) {
  it(`asks that PC to stop an update cancelled here while it builds${cancellable ? "" : ", and says it finishes there when its Ovis cannot"}`, async () => {
    const pc = ownOvis(cancellable);
    const abort = new AbortController();
    const follow = followOwnUpdate({ endpoint: () => pc.endpoint, revision: OFFERED, signal: abort.signal, cancelled: () => true, pollMs: 5, onStep: (step) => { if (step.includes("updating itself")) abort.abort(); } });
    await expect(follow).rejects.toThrow(cancellable ? "stopped it before it was installed" : "may still finish it there");
    expect(pc.asked.includes("POST /api/updates/cancel")).toBe(cancellable);
  });
}
