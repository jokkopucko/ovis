/**
 * The `{ error: { code, message } }` envelope every Ovis route answers with.
 *
 * It lives outside index.ts because the auth routes must fail in exactly the shape
 * the pane routes fail in: a second copy of this envelope is how one API ends up
 * with two error formats and a client that only handles one of them.
 */

import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

import { FileBusyError } from "./file-pool.ts";
import { faultOf, HerdrError, type HerdrFailureView } from "./herdr/client.ts";

export const requestIdContext = new AsyncLocalStorage<{ readonly id: string; route: string; herdrFailure?: HerdrFailureView; herdrReason?: (reason: string) => string }>();

export function wordHerdrFailures(view: HerdrFailureView, reason: (reason: string) => string): void {
  const context = requestIdContext.getStore();
  if (context === undefined) return;
  context.herdrFailure = view;
  context.herdrReason = reason;
}
/** The headers of an answer that may carry what this request words: never stored inside a request that words them, else none. */
export const wordedHeaders = (): Record<string, string> => requestIdContext.getStore()?.herdrFailure === undefined ? {} : { "cache-control": "no-store" };
/** A layout answer, whose `reason` may be herdr's: never stored, its reason worded, inside a request that words them; else as it is. */
export function layoutResponse<T extends { reason: string | null }>(body: T): Response {
  const word = requestIdContext.getStore()?.herdrReason;
  if (word === undefined) return jsonResponse(body);
  return jsonResponse({ ...body, reason: body.reason === null ? null : word(body.reason) }, 200, wordedHeaders());
}
export const requestFault = (error: unknown, code: string): { code: string; message: string } => faultOf(error, code, requestIdContext.getStore()?.herdrFailure);

/** Call only from a matched dispatch branch, with a fixed template or a finite matched literal. */
export function setRequestRoute(route: string): void {
  const context = requestIdContext.getStore();
  if (context !== undefined) context.route = route;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HerdrError) {
    const status = error.code === "connect_failed" || error.code === "timeout" ? 502 : 404;
    const view = requestIdContext.getStore()?.herdrFailure;
    if (view !== undefined && error.failedCall === true) {
      const { code, message } = view(error);
      return jsonResponse({ error: { code, message } }, status, wordedHeaders());
    }
    return jsonResponse({ error: { code: error.code, message: error.message } }, status);
  }
  if (error instanceof FileBusyError) return jsonResponse({ error: { code: error.code, message: error.message } }, 503, { "retry-after": "1" });
  // A system error carries absolute paths, the herdr socket and whatever a dependency
  // throws; the client is told none of it but a handle to quote in a bug report, and the
  // real exception is logged here beside that handle. Short enough to say out loud, long
  // enough that nobody reads another's.
  const id = requestIdContext.getStore()?.id ?? randomBytes(6).toString("hex");
  console.error(`internal_error ${id}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return jsonResponse({ error: { code: "internal_error", message: `internal error (${id})` } }, 500);
}

export function conflictResponse(code: string, message: string, headers: Record<string, string> = {}): Response {
  return jsonResponse({ error: { code, message } }, 409, headers);
}

export function badRequest(code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, 400);
}

export async function readJsonObject<T extends object = Record<string, unknown>>(request: Request): Promise<T | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_json", "request body must be JSON");
  }
  if (!isJsonObject(body)) return badRequest("invalid_body", "request body must be a JSON object");
  return body as T;
}
