import { INSTALL_ID, noInstalledNotes, noUpdateNotes, readInstalledNotes, readUpdateNotes, REVISION, unmanagedUpdateStatus, updateIpcMessage, type InstalledNotes, type UpdateNotes, type UpdateRequest, type UpdateStatus } from "../shared/update.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isJsonObject, jsonResponse, setRequestRoute } from "./http.ts";
import { ASSETS, COMPILED } from "./entries.ts";

export interface UpdateService {
  status(): UpdateStatus;
  notes(): UpdateNotes;
  installed(): InstalledNotes;
  request(request: UpdateRequest): void;
  servedRevision?(): Promise<string | null>;
}

export function servedRevision(directory: string, since = Date.now()): () => Promise<string | null> {
  const file = join(directory, "dist", "build.json");
  return async () => {
    try {
      const build = Bun.file(file);
      if (build.lastModified < since) return null;
      const revision = (await build.json() as { revision?: unknown }).revision;
      return typeof revision === "string" && /^[0-9a-f]{40,64}$/.test(revision) ? revision : null;
    } catch { return null; }
  };
}

export interface SupervisorChannel {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
}

export function connectUpdater(channel?: SupervisorChannel): UpdateService {
  let status = unmanagedUpdateStatus(process.env["OVIS_DESKTOP_APP"] === "1");
  let notes = noUpdateNotes();
  let installed = noInstalledNotes();
  const managed = Boolean(process.send) && process.env["OVIS_MANAGED"] === "1";
  const supervisor = channel ?? (managed ? { send: (message: unknown) => process.send?.(message), onMessage: (listener: (message: unknown) => void) => process.on("message", listener) } : null);
  if (supervisor) {
    supervisor.onMessage((message: unknown) => {
      const value = message as { type?: string; status?: UpdateStatus; notes?: unknown; installed?: unknown };
      if (value?.type !== "update-status" || !value.status) return;
      // installs are offered only where the supervisor says itself that it installs the exact
      // revision asked for: an older one would install whatever its own check finds
      const { revision_bound_install: bound, ...told } = value.status;
      status = bound === true ? { ...told, revision_bound_install: true } : told;
      notes = readUpdateNotes(value.notes);
      installed = readInstalledNotes(value.installed);
    });
    supervisor.send({ type: "update-status-request" });
  }
  return {
    status: () => status,
    notes: () => notes,
    installed: () => installed,
    request: (request) => supervisor?.send(updateIpcMessage(request)),
    ...(managed ? { servedRevision: servedRevision(COMPILED ? ASSETS : process.cwd()) } : {}),
  };
}

/**
 * Whether an update POST came from this app's own controls. A custom header is not
 * submit-able by an HTML form. Cross-origin preflights are refused (no CORS headers);
 * Sec-Fetch-Site also rejects browser CSRF.
 */
export function updateRequestAllowed(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  let sameHost = true;
  try { if (origin) sameHost = new URL(origin).host === url.host; } catch { sameHost = false; }
  return request.headers.get("x-herdr-update") === "1" && sameHost && (site === null || site === "same-origin") && !url.search;
}

/**
 * The status with `served_revision`: the commit of the client build a reload loads, once it differs
 * from the revision the server runs; null while they match or the build names none.
 */
async function withServed(status: UpdateStatus, service?: UpdateService): Promise<UpdateStatus> {
  if (!status.managed || !status.current_revision || !service?.servedRevision) return status;
  const served = await service.servedRevision();
  return { ...status, served_revision: served !== null && served !== status.current_revision ? served : null };
}

/** An install's body is one revision: more than this is not one. */
const INSTALL_BODY_LIMIT = 1024;

async function expectedRevision(request: Request): Promise<string | null> {
  const revision = (await smallBody(request))?.["expected_revision"];
  return typeof revision === "string" && REVISION.test(revision) ? revision : null;
}

async function cancelledInstall(request: Request): Promise<string | null> {
  const id = (await smallBody(request))?.["install_id"];
  return typeof id === "string" && INSTALL_ID.test(id) ? id : null;
}

async function smallBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > INSTALL_BODY_LIMIT) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    return isJsonObject(body) ? body : null;
  } catch { return null; }
}

/** the install_id of the install each update service was last asked for here: the only one a cancel may name */
const issued = new WeakMap<UpdateService, string>();

const running = (status: UpdateStatus) => ["checking", "building", "restarting"].includes(status.phase);

/**
 * `where` adds where this server answers to GET /api/updates (UpdateStatus.port, serving_url): passed
 * only for the connection server's bridge token, which cannot read GET /api/access (#2191).
 */
export function handleUpdateRequest(request: Request, pathname: string, service?: UpdateService,
  where?: () => Promise<Pick<UpdateStatus, "port" | "serving_url">>): Response | Promise<Response> {
  const status = service?.status() ?? unmanagedUpdateStatus();
  const reply = (body: unknown, code = 200) => {
    const response = jsonResponse(body, code);
    response.headers.set("cache-control", "no-store");
    return response;
  };
  const fail = (code: string, message: string, http: number) => reply({ error: { code, message } }, http);
  if (pathname === "/api/updates" && request.method === "GET") {
    setRequestRoute(pathname);
    return Promise.all([withServed(status, service), where?.().catch(() => undefined)]).then(([value, at]) => reply(at ? { ...value, ...at } : value));
  }
  if (pathname === "/api/updates/notes" && request.method === "GET") { setRequestRoute(pathname); return reply(service?.notes() ?? noUpdateNotes()); }
  if (pathname === "/api/updates/installed" && request.method === "GET") { setRequestRoute(pathname); return reply(service?.installed() ?? noInstalledNotes()); }
  if (request.method !== "POST" || (pathname !== "/api/updates/check" && pathname !== "/api/updates/install" && pathname !== "/api/updates/cancel")) {
    return fail("method_not_allowed", "Use GET /api/updates, /api/updates/notes or /api/updates/installed, or POST /api/updates/check, /install or /cancel", 405);
  }
  setRequestRoute(pathname);
  if (!updateRequestAllowed(request)) return fail("invalid_update_request", "Use the update controls from this app.", 403);
  if (!service || !status.managed) return fail("updates_unmanaged", status.blocked_reason ?? "Updates unavailable", 409);
  const busy = () => fail("update_busy", "An update operation is already running.", 409);
  // stops an install while it builds; one restarting onto its new release is past stopping
  // only by the one that asked for that install: it names the install_id its 202 gave
  if (pathname.endsWith("/cancel")) {
    return cancelledInstall(request).then((id) => {
      if (id === null) return fail("invalid_update_cancel", "Name the install_id of the install to cancel.", 400);
      if (status.install_cancellable !== true) return fail("update_restart_required", "Restart the app before cancelling an update from here.", 409);
      // only the install this server was last asked for, while it still checks or builds: a wrong or expired id is refused
      // exactly as when no update runs, so the answer tells nothing of another's install (the supervisor checks the id too)
      if (id !== issued.get(service) || (status.phase !== "building" && status.phase !== "checking")) return fail("update_not_cancellable", "No update asked for with that install_id is running here.", 409);
      service.request({ command: "cancel", install_id: id });
      return reply({ accepted: true }, 202);
    });
  }
  if (pathname.endsWith("/check")) {
    if (running(status)) return busy();
    service.request({ command: "check" });
    return reply({ accepted: true }, 202);
  }
  // an install is consent to one release: the one the person was shown, named by its commit
  return expectedRevision(request).then((expected) => {
    if (expected === null) return fail("invalid_update_install", "Name the expected_revision of the update on offer.", 400);
    const now = service.status();
    if (running(now)) return busy();
    if (now.revision_bound_install !== true) return fail("update_restart_required", "Restart the app before installing an update from here.", 409);
    if (now.blocked_reason || !now.available) return fail("update_unavailable", now.blocked_reason ?? "No update is available. Check again first.", 409);
    if (now.latest_revision !== expected) return fail("update_offer_changed", "A different update is on offer now. Review it, then update again.", 409);
    // its own id, for a cancel by the one that asked for it
    const id = randomUUID();
    issued.set(service, id);
    service.request({ command: "install", expected_revision: expected, install_id: id });
    return reply({ accepted: true, install_id: id }, 202);
  });
}
