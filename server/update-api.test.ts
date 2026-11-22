import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_APP_UPDATES, noInstalledNotes, noUpdateNotes, unmanagedUpdateStatus, type UpdateRequest, type UpdateStatus, INSTALL_ID } from "../shared/update.ts";
import { connectUpdater, handleUpdateRequest, servedRevision, type UpdateService } from "./update-api.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("the served build's revision", () => {
  it("reads the build in the folder the supervisor started a source bridge in, as main does", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-cwd-"));
    directories.push(directory);
    const revision = "b".repeat(40);
    const probe = `const { connectUpdater } = await import(${JSON.stringify(join(import.meta.dir, "update-api.ts"))});
      const { mkdirSync, utimesSync, writeFileSync } = await import("node:fs");
      const service = connectUpdater();
      mkdirSync("dist", { recursive: true });
      writeFileSync("dist/build.json", JSON.stringify({ revision: ${JSON.stringify(revision)} }));
      // the file clock is coarser than Date.now(): a build written just now may carry a time before the start
      const later = new Date(Date.now() + 60_000);
      utimesSync("dist/build.json", later, later);
      const read = service.servedRevision;
      console.log(JSON.stringify(read ? await read() : "unmanaged"));
      process.exit(0);`;
    const env: Record<string, string | undefined> = { ...process.env, OVIS_MANAGED: "1" };
    delete env["OVIS_ASSETS"];
    const child = Bun.spawn([process.execPath, "-e", probe], { cwd: directory, env, stdout: "pipe", stderr: "inherit", ipc() {} });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toBe(revision);
  });

  it("reads the commit dist/build.json names, as it is now", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-revision-"));
    directories.push(directory);
    const read = servedRevision(directory, 0);
    expect(await read()).toBeNull();
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "a".repeat(40) }));
    expect(await read()).toBe("a".repeat(40));
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "b".repeat(40) }));
    expect(await read()).toBe("b".repeat(40));
  });

  it("counts only a build written after the server started", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-before-"));
    directories.push(directory);
    mkdirSync(join(directory, "dist"));
    writeFileSync(join(directory, "dist", "build.json"), JSON.stringify({ revision: "a".repeat(40) }));
    expect(await servedRevision(directory, Date.now() + 60_000)()).toBeNull();
    expect(await servedRevision(directory, 0)()).toBe("a".repeat(40));
  });

  it("answers null for a file that names no commit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-served-garbage-"));
    directories.push(directory);
    mkdirSync(join(directory, "dist"));
    const read = servedRevision(directory, 0);
    for (const body of ["not json", "{}", JSON.stringify({ revision: null }), JSON.stringify({ revision: "../../etc" })]) {
      writeFileSync(join(directory, "dist", "build.json"), body);
      expect(await read()).toBeNull();
    }
  });
});

const offered = "a".repeat(40), moved = "b".repeat(40);
const offer = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({ ...unmanagedUpdateStatus(), managed: true, blocked_reason: null, available: true,
  latest_revision: offered, latest_version: "9.9.9", current_revision: "c".repeat(40), revision_bound_install: true, ...patch });
function service(status: () => UpdateStatus): UpdateService & { requests: UpdateRequest[] } {
  const requests: UpdateRequest[] = [];
  return { requests, status, notes: noUpdateNotes, installed: noInstalledNotes, request: (request) => { requests.push(request); } };
}
const install = (body?: string) => new Request("http://127.0.0.1/api/updates/install", { method: "POST",
  headers: { "x-herdr-update": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body }) });
const answer = async (response: Response | Promise<Response>) => {
  const resolved = await response;
  return { status: resolved.status, code: ((await resolved.json()) as { error?: { code?: string } }).error?.code ?? null };
};

describe("a cancel", () => {
  it("stops only an install that builds, and only where its supervisor can", async () => {
    let status = offer();
    const updates = service(() => status);
    // the install it may cancel: the one this server was asked for, by the id its 202 gave
    const granted = await handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates);
    const { install_id: issued } = await granted.json() as { install_id: string };
    updates.requests.splice(0);
    status = offer({ phase: "building", install_cancellable: true });
    const cancel = (id: string | null = issued) => answer(handleUpdateRequest(install(id === null ? "{}" : JSON.stringify({ install_id: id })), "/api/updates/cancel", updates));
    // only by naming the install it stops (its 202's install_id): never another's
    for (const id of [null, "not-an-id", "ABCDEF11-2222-4333-8444-555555555555"]) expect(await cancel(id)).toEqual({ status: 400, code: "invalid_update_cancel" });
    expect(updates.requests).toEqual([]);
    expect(await cancel()).toEqual({ status: 202, code: null });
    expect(updates.requests).toEqual([{ command: "cancel", install_id: issued }]);
    status = offer({ phase: "checking", install_cancellable: true });
    expect(await cancel()).toEqual({ status: 202, code: null });
    updates.requests.splice(1);
    for (const phase of ["restarting", "idle"] as const) { status = offer({ phase, install_cancellable: true }); expect(await cancel()).toEqual({ status: 409, code: "update_not_cancellable" }); }
    status = offer({ phase: "building" });
    expect(await cancel()).toEqual({ status: 409, code: "update_restart_required" });
    expect(updates.requests).toHaveLength(1);
  });
});

describe("a cancel by its install's id", () => {
  it("refuses a wrong or expired id exactly as it refuses one when no update runs", async () => {
    let status = offer();
    const updates = service(() => status);
    const granted = await handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates);
    const { install_id } = await granted.json() as { install_id: string };
    const cancel = async (id: string) => { const response = await handleUpdateRequest(install(JSON.stringify({ install_id: id })), "/api/updates/cancel", updates); return { status: response.status, body: await response.json() }; };
    // its install builds: another id is refused, as if no update ran
    status = offer({ phase: "building", install_cancellable: true });
    const wrong = await cancel("99999999-2222-4333-8444-555555555555");
    status = offer({ phase: "idle", install_cancellable: true });
    const none = await cancel("99999999-2222-4333-8444-555555555555");
    const expired = await cancel(install_id);
    expect(wrong).toEqual(none);
    expect(expired).toEqual(none);
    expect(none.status).toBe(409);
    // only its own id, while it runs, is passed on
    status = offer({ phase: "building", install_cancellable: true });
    expect((await cancel(install_id)).status).toBe(202);
    expect(updates.requests.filter((request) => request.command === "cancel")).toEqual([{ command: "cancel", install_id }]);
  });
});

describe("a manual install", () => {
  it("rejects unbound manual installs", async () => {
    const updates = service(() => offer());
    for (const body of [undefined, "", "{}", "null", "[]", "not json", JSON.stringify({ expected_revision: null }),
      JSON.stringify({ expected_revision: "a".repeat(39) }), JSON.stringify({ expected_revision: "a".repeat(65) }),
      JSON.stringify({ expected_revision: "A".repeat(40) }), JSON.stringify({ expected_revision: `${"a".repeat(40)}\n` }),
      // more than an install's 1 KiB is not one, whatever it names
      JSON.stringify({ expected_revision: offered, padding: "x".repeat(1024) })]) {
      expect(await answer(handleUpdateRequest(install(body), "/api/updates/install", updates))).toEqual({ status: 400, code: "invalid_update_install" });
    }
    expect(updates.requests).toEqual([]);
  });

  it("installs only the revision it names, while that is the one on offer", async () => {
    let status = offer();
    const updates = service(() => status);
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 202, code: null });
    expect(updates.requests).toEqual([{ command: "install", expected_revision: offered, install_id: expect.stringMatching(INSTALL_ID) }]);
    // another release came on offer since the person was shown this one: refused before anything is asked
    status = offer({ latest_revision: moved });
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_offer_changed" });
    status = offer({ available: false });
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_unavailable" });
    status = offer({ phase: "building" });
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_busy" });
    expect(updates.requests).toHaveLength(1);
    status = offer();
    const check = new Request("http://127.0.0.1/api/updates/check", { method: "POST", headers: { "x-herdr-update": "1" } });
    expect(await answer(handleUpdateRequest(check, "/api/updates/check", updates))).toEqual({ status: 202, code: null });
    expect(updates.requests.at(-1)).toEqual({ command: "check" });
  });

  it("old supervisor cannot receive an unbound install", async () => {
    // an older supervisor tells its status without the capability: the bridge offers no install under it
    const sent: unknown[] = [];
    let deliver: (message: unknown) => void = () => {};
    const updates = connectUpdater({ send: (message) => { sent.push(message); }, onMessage: (listener) => { deliver = listener; } });
    const { revision_bound_install: _, ...older } = offer();
    deliver({ type: "update-status", status: older });
    expect(updates.status().revision_bound_install).toBeUndefined();
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_restart_required" });
    // a capability that is not exactly true is not told
    deliver({ type: "update-status", status: { ...older, revision_bound_install: "yes" } });
    expect(updates.status().revision_bound_install).toBeUndefined();
    expect(await answer(handleUpdateRequest(install(JSON.stringify({ expected_revision: offered })), "/api/updates/install", updates))).toEqual({ status: 409, code: "update_restart_required" });
    expect(sent).toEqual([{ type: "update-status-request" }]);
  });
});

describe("the update status", () => {
  it("tells a server the desktop app runs that the app updates itself, not to start Ovis another way", () => {
    const before = process.env["OVIS_DESKTOP_APP"];
    try {
      delete process.env["OVIS_DESKTOP_APP"];
      expect(connectUpdater().status().blocked_reason).toBe(unmanagedUpdateStatus().blocked_reason);
      process.env["OVIS_DESKTOP_APP"] = "1";
      const status = connectUpdater().status();
      expect(status).toMatchObject({ managed: false, available: false });
      expect(status.blocked_reason).toBe(DESKTOP_APP_UPDATES);
    } finally {
      if (before === undefined) delete process.env["OVIS_DESKTOP_APP"]; else process.env["OVIS_DESKTOP_APP"] = before;
    }
  });

  const read = async (where?: () => Promise<Pick<UpdateStatus, "port" | "serving_url">>) => {
    const response = await handleUpdateRequest(new Request("http://127.0.0.1/api/updates"), "/api/updates", service(() => offer()), where);
    return { status: response.status, body: await response.json() as UpdateStatus };
  };

  it("tells where it answers only when asked to, and still answers when that cannot be read (#2191)", async () => {
    expect(await read(async () => ({ port: 7317, serving_url: "https://pc.example.ts.net" }))).toMatchObject({ status: 200, body: { latest_revision: offered, port: 7317, serving_url: "https://pc.example.ts.net" } });
    const plain = await read();
    expect(plain.status).toBe(200);
    expect("port" in plain.body || "serving_url" in plain.body).toBe(false);
    const failed = await read(async () => { throw new Error("spawn EACCES"); });
    expect(failed.status).toBe(200);
    expect(failed.body.latest_revision).toBe(offered);
    expect("port" in failed.body).toBe(false);
  });
});
