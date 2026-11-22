import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientRequestId, RequestLog, requestMethod } from "./request-log.ts";
import { errorResponse, setRequestRoute } from "./http.ts";

const roots: string[] = [];
const writers: RequestLog[] = [];
afterEach(() => {
  for (const writer of writers.splice(0)) writer.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "herdr-request-log-"));
  roots.push(root);
  const writer = new RequestLog(root);
  writers.push(writer);
  const path = join(root, "http-requests.jsonl");
  const records = (): Record<string, unknown>[] => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { root, writer, path, records };
}

it.skipIf(process.platform === "win32")("preserves an existing state directory's permissions", () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-request-permissions-"));
  roots.push(root);
  chmodSync(root, 0o750);
  const writer = new RequestLog(root);
  writers.push(writer);
  expect(statSync(root).mode & 0o777).toBe(0o750);
  expect(statSync(join(root, "http-requests.jsonl")).mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform === "win32")("neither follows nor writes a symlinked log path", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-request-symlink-"));
  roots.push(root);
  const target = join(root, "untouched.txt");
  writeFileSync(target, "unchanged", { mode: 0o640 });
  symlinkSync(target, join(root, "http-requests.jsonl"));
  const writer = new RequestLog(root);
  writers.push(writer);
  const response = await writer.handle(new Request("http://localhost/api/preferences"), async () => new Response("still works"));
  expect(await response?.text()).toBe("still works");
  expect(readFileSync(target, "utf8")).toBe("unchanged");
  expect(statSync(target).mode & 0o777).toBe(0o640);
});

it("validates client correlation without trusting uniqueness", async () => {
  const { writer, records } = fixture();
  for (const value of ["", "a".repeat(65), "é", "a b", "a\n", "a\r\nInjected: secret", null]) expect(clientRequestId(value)).toBeUndefined();
  for (const value of ["abc._-123", "a".repeat(64)]) expect(clientRequestId(value)).toBe(value);
  for (let i = 0; i < 2; i++) await writer.handle(new Request("http://localhost/api/session", { headers: { "x-request-id": "repeated" } }), async () => Response.json({}));
  const rows = records();
  expect(rows.map((row) => row.client_request_id)).toEqual(["repeated", "repeated"]);
  expect(rows[0]?.request_id).not.toBe(rows[1]?.request_id);
  for (const row of rows) {
    expect(row.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(row).sort()).toEqual(["client_request_id", "latency_ms", "method", "request_id", "route", "status"]);
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
  }
});

it("rotates within two one-MiB files", async () => {
  const { root, writer, path } = fixture();
  const request = new Request("http://localhost/api/session");
  for (let i = 0; i < 16000; i++) await writer.handle(request, async () => new Response(null, { status: 204 }));
  writer.close();
  for (const file of [path, `${path}.1`]) {
    expect(statSync(file).size).toBeLessThanOrEqual(1024 * 1024);
    for (const line of readFileSync(file, "utf8").trim().split("\n")) {
      expect(Buffer.byteLength(line + "\n")).toBeLessThanOrEqual(1024);
      expect(JSON.parse(line).status).toBe(204);
    }
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  expect(existsSync(`${path}.2`)).toBe(false);
  if (process.platform !== "win32") expect(statSync(root).mode & 0o777).toBe(0o700);
  const size = statSync(path).size;
  await writer.handle(request, async () => new Response(null, { status: 204 }));
  expect(statSync(path).size).toBe(size);
});

it("normalizes secret-bearing paths", async () => {
  const { writer, path, records } = fixture();
  expect(requestMethod("private-secret")).toBe("OTHER");
  await writer.handle(new Request("http://localhost/api/fs/file?path=/private-secret&token=private-secret"), async () => {
    setRequestRoute("/api/fs/file");
    return new Response(null, { status: 404 });
  });
  await writer.handle(new Request("http://localhost/api/private-secret"), async () => new Response(null, { status: 404 }));
  await writer.handle(new Request("http://localhost/private-secret"), async () => {
    setRequestRoute("static");
    return new Response(null, { status: 404 });
  });
  expect(readFileSync(path, "utf8")).not.toContain("private-secret");
  expect(records().map((row) => row.route)).toEqual(["/api/fs/file", "unmatched", "static"]);
});

it("rotates at the limit after another writer grows the file", async () => {
  const { writer, path, records } = fixture();
  appendFileSync(path, "x".repeat(1024 * 1024));
  await writer.handle(new Request("http://localhost/api/session"), async () => new Response(null, { status: 204 }));
  expect(statSync(`${path}.1`).size).toBe(1024 * 1024);
  expect(statSync(path).size).toBeLessThanOrEqual(1024 * 1024);
  expect(records()).toHaveLength(1);
  expect(records()[0]?.status).toBe(204);
  expect(existsSync(`${path}.2`)).toBe(false);
});

it.each(["constructor", "open", "rotation", "write"])("warns once with a redacted reason after %s failure", async (failure) => {
  const { root, writer, path } = fixture();
  writer.close();
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  let writeFailure: ReturnType<typeof spyOn<typeof fs, "writeSync">> | undefined;
  try {
    let stateDir = root;
    if (failure === "constructor") {
      stateDir = join(root, "private-state");
      writeFileSync(stateDir, "not a directory");
    } else if (failure === "open") {
      rmSync(path);
      mkdirSync(path);
    } else if (failure === "rotation") {
      writeFileSync(path, "x".repeat(1024 * 1024));
      mkdirSync(`${path}.1`);
    } else {
      writeFailure = spyOn(fs, "writeSync").mockImplementation(() => {
        throw Object.assign(new Error("private exception, route and header"), { code: "ENOSPC" });
      });
    }
    const failing = new RequestLog(stateDir);
    writers.push(failing);
    for (let i = 0; i < 2; i++) {
      const response = new Response("unchanged");
      const result = await failing.handle(new Request("http://localhost/private-route?token=secret", {
        headers: { "x-request-id": "private-client", authorization: "private-header" },
      }), async () => {
        setRequestRoute("/private-route");
        return response;
      });
      expect(result).toBe(response);
      expect(await result?.text()).toBe("unchanged");
    }
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]).toHaveLength(1);
    expect(warning.mock.calls[0]?.[0]).toMatch(/^Request log disabled: http-requests\.jsonl \([A-Z][A-Z0-9_]{0,63}\)$/);
    if (failure === "write") expect(warning.mock.calls[0]?.[0]).toContain("(ENOSPC)");
  } finally {
    writeFailure?.mockRestore();
    warning.mockRestore();
  }
});

it("preserves responses when the disable warning itself fails", async () => {
  const { writer, path } = fixture();
  appendFileSync(path, "x".repeat(1024 * 1024));
  mkdirSync(`${path}.1`);
  const warning = spyOn(console, "warn").mockImplementation(() => { throw new Error("diagnostic sink failed"); });
  try {
    for (let i = 0; i < 2; i++) {
      const response = new Response("unchanged");
      expect(await writer.handle(new Request("http://localhost/api/session"), async () => response)).toBe(response);
    }
    expect(warning).toHaveBeenCalledTimes(1);
  } finally { warning.mockRestore(); }
});

it("write failure preserves response", async () => {
  const { root, writer, path } = fixture();
  writer.close();
  writeFileSync(path, "x".repeat(1024 * 1024));
  mkdirSync(`${path}.1`);
  const failing = new RequestLog(root);
  writers.push(failing);
  const response = new Response("unchanged", { headers: { "referrer-policy": "same-origin", "x-content-type-options": "route-value" } });
  const result = await failing.handle(new Request("http://localhost/api/session"), async () => response);
  expect(result).toBe(response);
  expect(await result?.text()).toBe("unchanged");
  expect(result?.headers.get("referrer-policy")).toBe("same-origin");
  expect(result?.headers.get("x-content-type-options")).toBe("route-value");
  expect(result?.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
});

it("correlates caught and uncaught failures without recording exception text", async () => {
  const { writer, records, path } = fixture();
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const caught of [true, false]) {
      const response = await writer.handle(new Request("http://localhost/api/session"), async () => {
        if (caught) return errorResponse(new Error("private exception"));
        throw new Error("private exception");
      });
      expect(response?.status).toBe(500);
      expect(await response?.json()).toMatchObject({ error: { message: `internal error (${response?.headers.get("x-request-id")})` } });
    }
    expect(records()).toHaveLength(2);
    expect(readFileSync(path, "utf8")).not.toContain("private exception");
  } finally { consoleError.mockRestore(); }
});

it("records an upgrade once without turning it into a Response", async () => {
  const { writer, records } = fixture();
  const result = await writer.handle(new Request("http://localhost/ws"), async (headers) => {
    setRequestRoute("/ws");
    expect(headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    return undefined;
  });
  expect(result).toBeUndefined();
  expect(records()).toHaveLength(1);
  expect(records()[0]).toMatchObject({ status: 101, route: "/ws" });
});
