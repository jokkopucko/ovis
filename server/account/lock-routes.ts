/**
 * /api/account/lock and /api/account/unlock (docs/account.md, "Strict mode"): a window on this PC asks, the act goes on
 * this PC's screen (server/account/local-confirm.ts), and only the screen's approval writes the lock or unlock record.
 * Nothing from afar asks: a request through the relay or from a paired device is refused local_required. A PC in no
 * account offers no lock, and neither does one with no screen proof (macOS and Windows this release).
 */
import type { Access } from "../access.ts";
import { jsonResponse, readJsonObject, setRequestRoute } from "../http.ts";
import { sameOrigin } from "../machine-security.ts";
import { CONFIRM_MS, type LocalConfirms, type ScreenAction } from "./local-confirm.ts";

export interface LockPreview {
  rows: { id: string; label: string; origin: { from: string; how: string } | null; file: "devices" | "account" }[];
  grants: ("token" | "portal" | "tailscale" | "open_lan" | "loopback")[];
}

/** The lock as this PC's log holds it (Track A's safety log), and what writes to it. */
export interface LockStore {
  bound(): boolean;
  state(): { lock: string | null; strict: boolean };
  preview(): LockPreview;
  lock(): void;
  unlock(lockId: string): void;
  /** this run could not write the removals of a standing lock (Track A's pendingLockRemovals): no unlock until it can */
  removalsPending(): boolean;
}

export function lockRoutes(options: { confirms: LocalConfirms; store: LockStore; platform?: NodeJS.Platform }) {
  const { confirms, store } = options;
  const confirmable = (options.platform ?? process.platform) === "linux";
  const reply = (body: unknown, status = 200) => jsonResponse(body, status, { "cache-control": "no-store" });
  const fail = (code: string, message: string, status: number) => reply({ error: { code, message } }, status);

  const onScreen = (action: ScreenAction, title: string, lines: string[], write: () => void) => {
    const by = new Date(Date.now() + CONFIRM_MS).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const { id } = confirms.request(action, { title, lines: [...lines, "A browser on this PC asked for this.", `Approve by ${by}, or it lapses.`] });
    void confirms.answer(id).then((answer) => {
      if (answer === "approved" && confirms.consume(id, action)) write();
    });
    return reply({ confirm: id }, 202);
  };

  /** `ownWindow`: dispatch's "this PC's own window" (local, or the token from loopback with no proxy); nothing else asks */
  return async (request: Request, pathname: string, access: Access, ownWindow: boolean): Promise<Response> => {
    setRequestRoute(pathname);
    if (access.level !== "full" || access.role !== "drive") return fail("read_only", "this device can only watch", 403);
    const { lock, strict } = store.state();
    if (request.method === "GET" && pathname === "/api/account/lock") {
      return reply({
        bound: store.bound(), locked: lock, strict, confirm: confirmable ? "available" : "unsupported",
        ...(lock === null && store.bound() ? { preview: store.preview() } : {}),
      });
    }
    if (request.method !== "POST") return fail("method_not_allowed", "use POST", 405);
    if (!ownWindow) return fail("local_required", "Turn the lock on or off on this PC's own screen.", 403);
    if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1") return fail("invalid_origin", "Ask from this app", 403);
    if (!confirmable) return fail("no_screen_proof", "This PC has no screen confirmation in this release, so it cannot be locked.", 409);
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    if (pathname === "/api/account/lock") {
      if (!store.bound()) return fail("not_bound", "Sign this PC in to an account before locking it.", 409);
      if (lock !== null) return fail("already_locked", "This PC is locked already.", 409);
      const preview = store.preview();
      return onScreen({ kind: "lock" }, "Turn strict mode ON", [`${preview.rows.length} device(s) will be signed out`], () => {
        if (store.bound() && store.state().lock === null) store.lock();
      });
    }
    if (pathname === "/api/account/unlock") {
      if (lock === null || body.lock !== lock) return fail("not_locked", "That lock is not in force on this PC.", 409);
      // an unlock is written only after the lock's removals are: else the rows it ended would come back
      const removalsPending = "Repair this PC's state folder first: the devices this lock signs out are not written yet.";
      if (store.removalsPending()) return fail("lock_removals_pending", removalsPending, 409);
      return onScreen({ kind: "unlock", lock }, "Turn strict mode OFF", [], () => { if (!store.removalsPending()) store.unlock(lock); });
    }
    return fail("not_found", "no such route", 404);
  };
}
