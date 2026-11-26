/**
 * The screen's one way to the Ovis server, for what only the server does: herdr's New worktree and Delete worktree
 * checkout... (git runs there, never in the screen). Two calls, the routes the web's dialogs use, on the address the
 * launcher handed over (start.ts `SCREEN_SERVER`), as `ovis status` reaches the app over TCP: with no token and no
 * cookie, so the server's own access rules decide (server/access.ts); a server that asks for more is said so, and nothing
 * else changes. The address must be this PC's loopback (127.0.0.0/8, ::1, localhost), plain http with no path; any other is
 * refused before a request leaves. A request goes to that origin and those two routes only, straight to it: never through a
 * proxy the environment names (HTTP_PROXY, HTTPS_PROXY, ALL_PROXY), which would receive the request and could answer
 * for the server; a redirect is not followed (a 3xx is a refusal), and only an answer in the route's own shape counts as
 * done.
 */
import { loopbackOrigin } from "../../shared/loopback-origin.ts";
import type { WorktreeTarget } from "../model/effects.ts";
import { SCREEN_DESKTOP_IDENTITY, SCREEN_DESKTOP_RECORD } from "../start.ts";

/** What a call came to: the server's answer, or why there was none (`no_server`: no server answered at that address). */
export type ServerAnswer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string; readonly message: string };

export interface OvisServer {
  /** a checkout of `branch` made from the repository the workspace is on, and a workspace opened on it, grouped as the web's */
  createWorktree(workspace: string, branch: string, target?: WorktreeTarget): Promise<ServerAnswer<{ readonly workspace: string; readonly pane: string; readonly path: string }>>;
  /** the linked checkout the workspace is on removed with git, and its workspace closed */
  removeWorktree(workspace: string, target?: WorktreeTarget): Promise<ServerAnswer<{ readonly path: string }>>;
}

/** A request's options with Bun's `proxy: false` (no proxy the environment names), which Bun's types do not list. */
type DirectInit = RequestInit & { readonly proxy: false };

/** How long a call may take: git can take a while on a large repository (the routes allow 75 s) */
const CALL_MS = 80_000;

function fields(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The server at `given`, or none. A desktop launcher also pins calls to the listener it verified at startup. */
export function ovisServer(
  given: string | null,
  send: (url: string, init: DirectInit) => Promise<Response> = (url, init) => fetch(url, init),
  env: Readonly<Record<string, string | undefined>> = {},
): OvisServer {
  const origin = given === null ? null : loopbackOrigin(given);
  const record = env[SCREEN_DESKTOP_RECORD];
  const identity = env[SCREEN_DESKTOP_IDENTITY];
  const call = async <T>(route: "create" | "remove", body: Record<string, unknown>, read: (value: Record<string, unknown>) => T | null): Promise<ServerAnswer<T>> => {
    if (record !== undefined && identity === undefined) return { ok: false, code: "ovis_desktop_not_running", message: "" };
    if (given === null) return { ok: false, code: "no_server", message: "" };
    if (origin === null) return { ok: false, code: "server_not_loopback", message: given };
    const init: DirectInit = {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS), redirect: "manual", proxy: false,
    };
    if (record !== undefined) {
      const { desktopCommandListener } = await import("../../shared/desktop-command-listener.ts");
      const current = await desktopCommandListener(record);
      if (current === null || current.identity !== identity || `http://127.0.0.1:${current.port}` !== origin) {
        return { ok: false, code: "ovis_desktop_changed", message: "" };
      }
    }
    let response: Response;
    try {
      response = await send(`${origin}/api/worktree/${route}-checked`, init);
    } catch {
      return { ok: false, code: "no_server", message: origin };
    }
    // a redirect would carry the request to another route or another server: it is not followed
    if (response.status >= 300 && response.status < 400) return { ok: false, code: "server_redirected", message: `${response.status}` };
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error: Record<string, unknown> = fields(value) && fields(value["error"]) ? value["error"] : {};
      return { ok: false, code: typeof error["code"] === "string" ? error["code"] : `http_${response.status}`, message: typeof error["message"] === "string" ? error["message"] : "" };
    }
    const read_ = fields(value) ? read(value) : null;
    // a 200 in another shape is another program on the port
    return read_ === null ? { ok: false, code: "no_server", message: origin } : { ok: true, value: read_ };
  };
  const text = (value: unknown): string | null => typeof value === "string" ? value : null;
  return {
    // the create route's answer names the workspace, its pane, the checkout and the branch asked for
    createWorktree: (workspace, branch, target) => call("create", { workspace_id: workspace, branch, expected_core: target?.core, expected_repo: target?.repository }, (value) => {
      const [made, pane, path] = [text(value["workspace_id"]), text(value["pane_id"]), text(value["path"])];
      return made !== null && pane !== null && path !== null && value["branch"] === branch && typeof value["already_open"] === "boolean" ? { workspace: made, pane, path } : null;
    }),
    // the remove route's answer: ok, the checkout removed and whether it was forced
    removeWorktree: (workspace, target) => call("remove", { workspace_id: workspace, expected_core: target?.core, expected_repo: target?.repository, expected_checkout: target?.checkout?.path, expected_git_id: target?.checkout?.gitId }, (value) => {
      const path = text(value["path"]);
      return value["ok"] === true && path !== null && typeof value["forced"] === "boolean" ? { path } : null;
    }),
  };
}
