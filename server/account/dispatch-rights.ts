import type { ServerContext } from "../dispatch.ts";
import { jsonResponse } from "../http.ts";
import { dispatchMutationRegistered } from "../dispatch-routes.ts";
import { accountReadAllowed, accountRouteAction, accountRouteGuard, accountRowMay } from "./account-row-rights.ts";

// A local alias is scoped exactly once. No catalog, nested machine route, or
// selector in either transport may widen it (including a second selector).
function localAccountPath(request: Request): string | null {
  const { pathname, searchParams } = new URL(request.url);
  // the roster read is answered with this PC's own row (machine-api.ts accountRoster); proving a PC's boot is not
  const roster = pathname === "/api/machines" && request.method === "GET" && !searchParams.has("verify_source_boot");
  const local = pathname.replace(/^\/api\/machines\/local\//, "/api/");
  if (!roster && /^\/api\/machines(?:\/|$)/.test(local)) return null;
  const selector = /(?:^|[-_])(?:machine|pc)(?:[-_]?id)?$/i;
  for (const [name, value] of searchParams) {
    if (selector.test(name.replace(/([a-z])([A-Z])/g, "$1-$2")) && value !== "local") return null;
  }
  for (const [name, value] of request.headers) {
    // This header's "1" is the app's same-origin control marker, not an ID.
    if (name === "x-herdr-machine" && value === "1") continue;
    if (selector.test(name) && value !== "local") return null;
  }
  return local;
}

/** The account-session gate runs before a handler or a cross-PC forward can act. */
/** R1: a refusal says where the act can be done instead. */
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  older_device: "removing an older device is done from that PC or from an older device",
};

export function accountDispatchRefusal(request: Request, ctx: ServerContext): Response | null {
  if (ctx.peer.kind !== "relay" || !ctx.services.devices.isAccountRow(ctx.peer.device.id)) return null;
  const { device, key } = ctx.peer;
  const rows = ctx.services.accountRows;
  const access = rows?.access(device.id);
  const row = rows?.row(device.id);
  const fail = (code: string) => jsonResponse({ error: { code, message: REFUSAL_MESSAGES[code] ?? "An account-joined device cannot do this from afar" } }, 403);
  if (access === undefined || row === null || row === undefined || row.key !== key) return fail("not_listed");
  if ("refused" in access) return fail(access.refused);

  const localPath = localAccountPath(request);
  if (localPath === null) return fail("local_only");
  if (request.method !== "GET" && !dispatchMutationRegistered(request.method, localPath)) return fail("account_route_denied");
  if (accountRouteGuard(request.method, localPath)) return null;
  // where the account's signed list stands, and its entries: only a PC that follows a list a person named takes them
  // from an account row; one that follows none answers as it always did
  if (request.method === "POST" && (localPath === "/api/account/list/head" || localPath === "/api/account/list/page") && (ctx.services.accountList?.peerHead() ?? null) === null) return fail("account_route_denied");
  // the joins that wait at this PC, on a PC pinned to its account's list alone: its handler says which of them a
  // device of the list may see (relay/routes.ts). A PC that follows no list answers as it always did
  if (request.method === "GET" && localPath === "/api/relay/pairings" && ctx.services.accountList?.pinned() === true) return null;
  const action = accountRouteAction(request.method, localPath)
    ?? (accountReadAllowed(request.method, localPath) ? { action: "read" as const } : null);
  if (action === null) return fail("account_route_denied");
  const verdict = accountRowMay({ rowId: row.id, key: row.key, state: row.state,
    mayRevoke: target => ctx.services.devices.remoteRevoke(row.id, target) === "allowed" }, action);
  return "refused" in verdict ? fail(verdict.refused) : null;
}
