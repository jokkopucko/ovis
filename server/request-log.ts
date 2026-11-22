import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { errorResponse, requestIdContext } from "./http.ts";

const FILE_BYTES = 1024 * 1024;
const CLIENT_ID = /^[A-Za-z0-9._-]{1,64}(?![\s\S])/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);

export const clientRequestId = (value: string | null): string | undefined => value !== null && CLIENT_ID.test(value) ? value : undefined;
export const requestMethod = (value: string): string => METHODS.has(value) ? value : "OTHER";

export class RequestLog {
  private fd: number | undefined;
  private warned = false;
  private readonly path: string;

  constructor(stateDir: string) {
    this.path = join(stateDir, "http-requests.jsonl");
    try {
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      this.open();
    } catch (error) {
      this.disable(error);
    }
  }

  private open(): void {
    this.fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    const stat = fstatSync(this.fd);
    if (!stat.isFile()) {
      this.disable({ code: "NOT_REGULAR_FILE" });
      return;
    }
    fchmodSync(this.fd, 0o600);
  }

  private disable(error: unknown): void {
    this.close();
    if (this.warned) return;
    this.warned = true;
    const code = typeof error === "object" && error !== null && "code" in error
      && typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "UNKNOWN";
    try {
      console.warn(`Request log disabled: http-requests.jsonl (${code})`);
    } catch { /* A diagnostic failure must not change the response or recurse. */ }
  }

  close(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* Best-effort telemetry must not break a response or shutdown. */ }
    }
  }

  async handle(request: Request, dispatch: (headers: Headers) => Promise<Response | undefined>): Promise<Response | undefined> {
    const requestId = crypto.randomUUID();
    const started = performance.now();
    const clientId = clientRequestId(request.headers.get("x-request-id"));
    const headers = new Headers({
      "x-request-id": requestId,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    const context = { id: requestId, route: "unmatched" };
    return requestIdContext.run(context, async () => {
      let response: Response | undefined;
      try {
        response = await dispatch(headers);
      } catch (error) {
        response = errorResponse(error);
      }
      if (response !== undefined) {
        // Only correlation is authoritative. Route-authored security and cache headers win.
        response.headers.set("x-request-id", requestId);
        for (const name of ["x-content-type-options", "referrer-policy"]) {
          const value = headers.get(name);
          if (!response.headers.has(name) && value !== null) response.headers.set(name, value);
        }
      }
      const line = JSON.stringify({
        request_id: requestId,
        ...(clientId === undefined ? {} : { client_request_id: clientId }),
        method: requestMethod(request.method),
        route: context.route,
        status: response?.status ?? 101,
        latency_ms: Math.round((performance.now() - started) * 1000) / 1000,
      }) + "\n";
      try {
        if (this.fd !== undefined && Buffer.byteLength(line) <= 1024) {
          if (fstatSync(this.fd).size + Buffer.byteLength(line) > FILE_BYTES) {
            this.close();
            renameSync(this.path, `${this.path}.1`);
            this.open();
          }
          if (this.fd !== undefined) {
            const bytes = Buffer.from(line);
            let written = 0;
            while (written < bytes.length) written += writeSync(this.fd, bytes, written);
          }
        }
      } catch (error) {
        // Never change the answer or recursively log a writer failure.
        this.disable(error);
      }
      return response;
    });
  }
}
