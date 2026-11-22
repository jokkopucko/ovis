/**
 * /api/devices/pending (docs/account.md, "Confirmed on this PC"): the devices waiting for this PC's screen, for whoever
 * may drive this PC, and a decline of one, which only narrows. No route approves one: that is a confirm of its key on
 * this PC's screen.
 */
import type { Access } from "../access.ts";
import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import type { PendingRedemptions } from "./pending.ts";

export async function handlePendingRequest(request: Request, pathname: string, pending: PendingRedemptions, access: Access): Promise<Response> {
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);
  setRequestRoute(pathname === "/api/devices/pending" ? pathname : "/api/devices/pending/*");
  if (access.level !== "full" || access.role !== "drive") return fail("read_only", "this device can only watch", 403);
  if (pathname === "/api/devices/pending") {
    if (request.method !== "GET") return fail("method_not_allowed", "use GET", 405);
    return reply({ pending: pending.view() });
  }
  if (pathname !== "/api/devices/pending/decline") return fail("not_found", "no such route", 404);
  if (request.method !== "POST") return fail("method_not_allowed", "use POST", 405);
  if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Decline from this app", 403);
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (typeof body.id !== "string" || !/^[0-9a-f]{32}$/.test(body.id)) return fail("request_invalid", "Name the waiting device by its id", 400);
  pending.decline(body.id);
  return reply({ pending: pending.view() });
}
