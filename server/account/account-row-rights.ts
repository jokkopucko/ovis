/**
 * Dispatcher policy for an account-joined row on this PC. Row Revoke uses the PC's admission order;
 * signed records, including a signed remove, are independently authorized by their handler.
 */
import { DISPATCH_READS, LOCAL_DRIVE_POSTS, RELAY_CONTROLS } from "../dispatch-routes.ts";

export interface AccountCaller {
  readonly rowId: string;
  readonly key: string;
  readonly state: "live" | "hold" | "expired";
  readonly mayRevoke: (targetId: string) => boolean;
}

export type RowAction =
  | { readonly action: "remove"; readonly key: string }
  | { readonly action: "revoke" | "label"; readonly rowId: string }
  | { readonly action: "block" | "lift"; readonly targetNewer: boolean }
  | { readonly action: "route"; readonly machine: string }
  | { readonly action: "drive" | "records" | "read" | "local_control" | "add" | "revoke_all" | "link" | "pair_start" | "pair_cancel" | "enroll" | "approve" | "relay_account" | "lock" | "unlock" | "leave_account" | "forget" | "confirm" | "push_subscribe" | "webhook" };

export type RowRefusal = "not_yours" | "local_required" | "local_only" | "older_device" | "member_required" | "link_not_owner" | "join_hold";

export type RowVerdict = { readonly ok: true } | { readonly refused: RowRefusal };

const OK: RowVerdict = { ok: true };
const refuse = (refused: RowRefusal): RowVerdict => ({ refused });

export function accountRowMay(caller: AccountCaller, request: RowAction): RowVerdict {
  switch (request.action) {
    case "read":
    case "drive": return caller.state === "live" ? OK : refuse("join_hold");
    // Each signed record is independently authorized at its production owner.
    case "records": return OK;
    case "remove": return request.key === caller.key ? OK : refuse("not_yours");
    case "revoke": return caller.mayRevoke(request.rowId) ? OK : refuse("older_device");
    case "label": return request.rowId === caller.rowId ? OK : refuse("not_yours");
    case "block":
    case "lift":
      // in its join hold a row signs nothing but its own leave
      if (caller.state !== "live") return refuse("join_hold");
      return request.targetNewer ? OK : refuse("older_device");
    case "route": return request.machine === "local" ? OK : refuse("local_only");
    case "push_subscribe": return OK;
    case "add": return refuse("not_yours");
    case "link": return refuse("link_not_owner");
    case "revoke_all":
    case "local_control":
    case "lock":
    case "unlock":
    case "leave_account":
    case "forget":
    case "confirm": return refuse("local_required");
    case "pair_start":
    case "pair_cancel":
    case "enroll":
    case "approve":
    case "relay_account":
    case "webhook": return refuse("member_required");
  }
}

const ROW = /^\/api\/devices\/([0-9a-f]{16})$/;
const ROUTES: Readonly<Record<string, RowAction>> = {
  "POST /api/devices/revoke-all": { action: "revoke_all" },
  "POST /api/devices/pair/start": { action: "pair_start" },
  "POST /api/devices/pair/cancel": { action: "pair_cancel" },
  "POST /api/account/link": { action: "link" },
  "POST /api/account/enroll": { action: "enroll" },
  "POST /api/account/relay-account": { action: "relay_account" },
  "POST /api/account/one-press": { action: "local_control" },
  "POST /api/alerts/webhook": { action: "webhook" },
  "PUT /api/alerts/webhook": { action: "webhook" },
  "DELETE /api/alerts/webhook": { action: "webhook" },
  "POST /api/alerts/webhook/test": { action: "webhook" },
  "POST /api/push/subscribe": { action: "push_subscribe" },
  "DELETE /api/push/subscribe": { action: "push_subscribe" },
  "POST /api/push/status": { action: "push_subscribe" },
  "POST /api/push/test": { action: "push_subscribe" },
  "POST /api/account/records": { action: "records" },
  "POST /api/devices/pair": { action: "pair_start" },
  "POST /api/runtime": { action: "drive" },
  "POST /api/runtime/move": { action: "drive" },
  "DELETE /api/runtime/move": { action: "drive" },
  "POST /api/runtime/move/install": { action: "drive" },
  "POST /api/runtime/move/stop": { action: "drive" },
  "POST /api/runtime/move/stop-all": { action: "drive" },
  "POST /api/updates/install": { action: "drive" },
  "POST /api/updates/check": { action: "drive" },
  "POST /api/updates/cancel": { action: "drive" },
  "POST /api/herdr/update": { action: "drive" },
  "PUT /api/fs/text": { action: "drive" },
  "PUT /api/preferences": { action: "drive" },
  "PUT /api/cliproxy": { action: "drive" },
  "PUT /api/voice/config": { action: "drive" },
  "DELETE /api/usage/accounts": { action: "drive" },
  "DELETE /api/cliproxy": { action: "drive" },
  "DELETE /api/cliproxy/login": { action: "drive" },
  "POST /api/auth": { action: "local_control" },
  "DELETE /api/auth": { action: "local_control" },
  "POST /api/portal/start": { action: "local_control" },
  "POST /api/portal/stop": { action: "local_control" },
  "POST /api/portal/invite": { action: "local_control" },
  "POST /api/account/lock": { action: "lock" },
  "POST /api/account/unlock": { action: "unlock" },
  "POST /api/account/forget": { action: "forget" },
  "POST /api/account/confirm": { action: "confirm" },
  "POST /api/account/leave": { action: "leave_account" },
};

/** These exact mutations already refuse an account-joined principal in their handler. */
export function accountRouteGuard(method: string, pathname: string): boolean {
  return method === "POST" && (pathname === "/api/account/introduce"
    || Object.values(RELAY_CONTROLS).some(path => path === pathname));
}

/** Null means unregistered, never permission. GET needs the separate explicit read list. */
export function accountRouteAction(method: string, pathname: string): RowAction | null {
  if (method === "GET" && pathname === "/ws") return { action: "route", machine: "local" };
  const row = ROW.exec(pathname);
  if (row?.[1] !== undefined && method === "PATCH") return { action: "label", rowId: row[1] };
  if (row?.[1] !== undefined && method === "DELETE") return { action: "revoke", rowId: row[1] };
  const machine = /^\/api\/machines\/([^/]+)\//.exec(pathname);
  if (machine?.[1] !== undefined) return { action: "route", machine: machine[1] };
  if (method === "POST" && LOCAL_DRIVE_POSTS.includes(pathname)) return { action: "drive" };
  return ROUTES[`${method} ${pathname}`] ?? null;
}

export function accountReadAllowed(method: string, pathname: string): boolean {
  const local = pathname.replace(/^\/api\/machines\/local\//, "/api/");
  return method === "GET" && DISPATCH_READS.has(local);
}
