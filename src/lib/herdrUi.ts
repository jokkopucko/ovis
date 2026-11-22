/**
 * herdr's `[ui] copy_on_select` on the PC serving this page (GET /api/herdr-ui), which a drag in the
 * terminal follows as herdr's own TUI does (#1559), for local and remote panes alike. Until a read
 * answers, letting go of a drag copies nothing: copying that was turned off must not happen once.
 * Only an older server, which has no such route (404 not_found), stands for herdr's default (on).
 */
import { HERDR_PREFIX_ACTIONS, type HerdrKeys } from "../../shared/herdr-keys.ts";
import { apiFetch } from "./api-request-id.ts";

let known: boolean | null = null;
let keys: HerdrKeys | null = null;
let loading: Promise<void> | null = null;

/** Whether letting go of a drag copies: herdr's copy_on_select, off until it is known. */
export function copyOnSelect(): boolean {
  return known === true;
}

export function herdrUiKnown(): boolean {
  return known !== null;
}

/** herdr's `[keys]` prefix bindings as the last read answered them (lib/herdrKeys.ts); null before one, or from an older server. */
export function herdrKeys(): HerdrKeys | null {
  return keys;
}

function readKeys(value: unknown): HerdrKeys | null {
  if (typeof value !== "object" || value === null) return null;
  const { prefix, prefixes, bindings } = value as { prefix?: unknown; prefixes?: unknown; bindings?: unknown };
  if (typeof prefix !== "string" || typeof bindings !== "object" || bindings === null) return null;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((key) => typeof key === "string");
  const read = bindings as Record<string, unknown>;
  if (!HERDR_PREFIX_ACTIONS.every((action) => strings(read[action]))) return null;
  // a server from before prefix lists sends its one prefix
  return {
    prefix,
    prefixes: strings(prefixes) && prefixes.length > 0 ? prefixes : [prefix],
    bindings: Object.fromEntries(HERDR_PREFIX_ACTIONS.map((action) => [action, read[action]])) as HerdrKeys["bindings"],
  };
}

export function loadHerdrUi(read: (url: string, init?: RequestInit) => Promise<Response> = apiFetch): Promise<void> {
  if (loading !== null) return loading;
  // a transport that throws at once is a refused read: the attempt below then still waits a turn, so
  // its `finally` clears `loading` after it is set rather than before (which kept it cached for good)
  let request: Promise<Response>;
  try { request = read("/api/herdr-ui", { cache: "no-store" }); } catch (error) { request = Promise.reject(error); }
  loading = (async () => {
    try {
      const response = await request;
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const value = typeof body === "object" && body !== null ? (body as { copy_on_select?: unknown }).copy_on_select : undefined;
        if (typeof value === "boolean") known = value;
        keys = readKeys((body as { keys?: unknown } | null)?.keys);
      } else if (response.status === 404 && (body as { error?: { code?: unknown } } | null)?.error?.code === "not_found") {
        known = true;
      }
    } catch {}
    finally { loading = null; }
  })();
  return loading;
}

export function forgetHerdrUi(): void {
  known = null;
  keys = null;
  loading = null;
}
