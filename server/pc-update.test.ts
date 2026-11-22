import { afterEach, describe, expect, it } from "bun:test";
import { unmanagedUpdateStatus, type UpdateStatus } from "../shared/update.ts";
import { followOwnUpdate, offerFromStatus } from "./pc-update.ts";

const OFFERED = "a".repeat(40);
const CURRENT = "c".repeat(40);
const TOKEN = "d".repeat(64);
const offered = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true,
  current_version: "0.5.0", latest_version: "0.5.1", current_revision: CURRENT, latest_revision: OFFERED, revision_bound_install: true, ...patch });

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });

function remote(before: UpdateStatus, after: Partial<UpdateStatus>[], install: { status: number; code?: string } = { status: 202 }) {
  const installs: unknown[] = [];
  let reads = 0;
  let asked = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path === "/api/updates" && request.method === "GET") return Response.json(asked ? { ...before, ...after[Math.min(reads++, after.length - 1)] } : before);
    if (path === "/api/updates/install" && request.method === "POST") {
      expect(request.headers.get("x-herdr-update")).toBe("1");
      installs.push(await request.json());
      if (install.status !== 202) return Response.json({ error: { code: install.code, message: "refused here" } }, { status: install.status });
      asked = true;
      return new Response(null, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  } });
  servers.push(server);
  return { endpoint: { url: `http://127.0.0.1:${server.port}`, token: TOKEN }, installs };
}

const fast = { pollMs: 5, startMs: 200, checkMs: 200 };

describe("offerFromStatus", () => {
  it("offers a release the PC's own updater installs by its revision", () => {
    expect(offerFromStatus(offered())).toEqual({ how: "own", current_version: "0.5.0", latest_version: "0.5.1", updatable: true, reason: null });
  });

  it("offers nothing when no newer release is on offer or the PC tells nothing", () => {
    expect(offerFromStatus(offered({ available: false }))).toBeNull();
    expect(offerFromStatus(offered({ latest_revision: "not a commit" }))).toBeNull();
    expect(offerFromStatus(null)).toBeNull();
    expect(offerFromStatus("nonsense")).toBeNull();
  });

  it("says in plain words why a PC cannot take the update it has on offer", () => {
    expect(offerFromStatus(offered({ managed: false, blocked_reason: null }))).toMatchObject({ updatable: false, reason: expect.stringContaining("does not update itself") });
    expect(offerFromStatus(offered({ blocked_reason: "The source checkout has local changes." }))).toMatchObject({ updatable: false, reason: expect.stringContaining("local changes") });
    expect(offerFromStatus(offered({ revision_bound_install: undefined }))).toMatchObject({ updatable: false, reason: expect.stringContaining("too old") });
  });
});

describe("followOwnUpdate", () => {
  it("installs the offered revision, tells its steps, and ends once the PC answers on that revision", async () => {
    const pc = remote(offered(), [{ phase: "building", step: "download" }, { phase: "building", step: "build" }, { phase: "idle", available: false, current_revision: OFFERED, current_version: "0.5.1" }]);
    const steps: string[] = [];
    await followOwnUpdate({ endpoint: () => pc.endpoint, signal: new AbortController().signal, onStep: (step) => steps.push(step), ...fast });
    expect(pc.installs).toEqual([{ expected_revision: OFFERED }]);
    expect(steps).toContain("This PC's own Ovis is updating itself to v0.5.1: downloading…");
    expect(steps).toContain("This PC's own Ovis is updating itself to v0.5.1: building…");
  });

  it("waits while the PC is away restarting, and ends once it answers again on the new revision", async () => {
    const pc = remote(offered(), [{ phase: "restarting", step: "restart" }, { phase: "idle", available: false, current_revision: OFFERED }]);
    let away = 0;
    const endpoint = () => pc.installs.length > 0 && away++ < 3 ? undefined : pc.endpoint;
    await followOwnUpdate({ endpoint, signal: new AbortController().signal, onStep: () => {}, ...fast });
    expect(away).toBeGreaterThanOrEqual(3);
  });

  it("fails in the PC's own words when its install fails there", async () => {
    const pc = remote(offered(), [{ phase: "building", step: "build" }, { phase: "error", error: "The build failed." }]);
    await expect(followOwnUpdate({ endpoint: () => pc.endpoint, signal: new AbortController().signal, onStep: () => {}, ...fast }))
      .rejects.toThrow("That PC's Ovis could not update itself: The build failed.");
  });

  it("fails in plain words when the PC refuses the install, or never starts it", async () => {
    const refused = remote(offered(), [], { status: 409, code: "update_offer_changed" });
    await expect(followOwnUpdate({ endpoint: () => refused.endpoint, signal: new AbortController().signal, onStep: () => {}, ...fast }))
      .rejects.toThrow("That PC offers another release now than the one shown. Look at it again, then update.");
    const blocked = remote(offered(), [], { status: 409, code: "update_restart_required" });
    await expect(followOwnUpdate({ endpoint: () => blocked.endpoint, signal: new AbortController().signal, onStep: () => {}, ...fast }))
      .rejects.toThrow("That PC's Ovis refused to update: refused here");
    const idle = remote(offered(), [{ phase: "idle" }]);
    await expect(followOwnUpdate({ endpoint: () => idle.endpoint, signal: new AbortController().signal, onStep: () => {}, ...fast }))
      .rejects.toThrow("did not start its update");
  });

  it("installs only the release the person was shown, never another one on offer since", async () => {
    const pc = remote(offered(), [{ phase: "idle", available: false, current_revision: OFFERED }]);
    await expect(followOwnUpdate({ endpoint: () => pc.endpoint, revision: "b".repeat(40), signal: new AbortController().signal, onStep: () => {}, ...fast }))
      .rejects.toThrow("offers another release now than the one shown");
    expect(pc.installs).toEqual([]);
    await followOwnUpdate({ endpoint: () => pc.endpoint, revision: OFFERED, signal: new AbortController().signal, onStep: () => {}, ...fast });
    expect(pc.installs).toEqual([{ expected_revision: OFFERED }]);
  });

  it("does not follow an install of another release than the one shown that already runs there", async () => {
    const pc = remote(offered({ phase: "building", step: "build", latest_revision: "b".repeat(40) }), []);
    await expect(followOwnUpdate({ endpoint: () => pc.endpoint, revision: OFFERED, signal: new AbortController().signal, onStep: () => {}, ...fast }))
      .rejects.toThrow("offers another release now than the one shown");
    expect(pc.installs).toEqual([]);
  });

  it("asks again once a check for releases that made it answer busy has ended, instead of waiting for an install never asked for", async () => {
    const installs: unknown[] = [];
    let busy = true, asked = false, reads = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/updates/install") {
        installs.push(await request.json());
        if (busy) { busy = false; return Response.json({ error: { code: "update_busy", message: "checking" } }, { status: 409 }); }
        asked = true;
        return new Response(null, { status: 202 });
      }
      if (!asked) return Response.json(installs.length === 1 && reads++ === 0 ? offered({ phase: "checking" }) : offered());
      return Response.json(offered({ phase: "idle", available: false, current_revision: OFFERED }));
    } });
    servers.push(server);
    await followOwnUpdate({ endpoint: () => ({ url: `http://127.0.0.1:${server.port}`, token: TOKEN }), signal: new AbortController().signal, onStep: () => {}, ...fast });
    expect(installs).toEqual([{ expected_revision: OFFERED }, { expected_revision: OFFERED }]);
  });

  it("refuses before asking when nothing can be installed, and stops when the PC is turned away for good", async () => {
    const tooOld = remote(offered({ revision_bound_install: undefined }), []);
    await expect(followOwnUpdate({ endpoint: () => tooOld.endpoint, signal: new AbortController().signal, onStep: () => {}, ...fast })).rejects.toThrow("too old");
    expect(tooOld.installs).toEqual([]);
    await expect(followOwnUpdate({ endpoint: () => undefined, signal: new AbortController().signal, onStep: () => {}, ...fast }))
      .rejects.toThrow("This PC is not connected");
    const pc = remote(offered(), [{ phase: "restarting", step: "restart" }]);
    let gone = false;
    await expect(followOwnUpdate({ endpoint: () => gone ? undefined : pc.endpoint, refused: () => gone ? "This PC uses a newer bridge (v99)." : null,
      signal: new AbortController().signal, onStep: () => { gone = true; }, ...fast })).rejects.toThrow("This PC uses a newer bridge (v99).");
  });
});
