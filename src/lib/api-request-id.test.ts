import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { apiFetch } from "./api-request-id.ts";
import { authenticate, cliProxyRequest, fetchSession, pairDevice, revokeDevice, signOut, signOutOfPortal } from "./api.ts";

const calls: { url: string; init?: RequestInit }[] = [];
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  return Response.json({ snapshot: {}, ok: true });
}, { preconnect: globalThis.fetch.preconnect }));
afterAll(() => fetchSpy.mockRestore());
afterEach(() => { calls.length = 0; fetchSpy.mockClear(); });

it("same-origin API ids preserve explicit headers", async () => {
  // Given: all HeadersInit shapes, including an explicit id.
  const headers = new Headers({ "x-request-id": "explicit", "x-herdr-machine": "1" });
  const signal = new AbortController().signal;
  // When
  await apiFetch("/api/session", { headers, signal, cache: "no-store" });
  await apiFetch("/api/session", { headers: [["x-herdr-machine", "1"]] });
  await apiFetch("/api/session", { headers: { "content-type": "application/json" } });
  // Then
  expect(new Headers(calls[0]?.init?.headers).get("x-request-id")).toBe("explicit");
  expect(calls[0]?.init?.signal).toBe(signal);
  expect(calls[0]?.init?.cache).toBe("no-store");
  expect(new Headers(calls[1]?.init?.headers).get("x-herdr-machine")).toBe("1");
  expect(new Headers(calls[2]?.init?.headers).get("content-type")).toBe("application/json");
  const ids = calls.slice(1).map((call) => new Headers(call.init?.headers).get("x-request-id"));
  for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(ids[0]).not.toBe(ids[1]);
  expect([...headers.entries()]).toEqual([["x-herdr-machine", "1"], ["x-request-id", "explicit"]]);
});

it("never stamps external or non-API requests", async () => {
  // Given / When
  for (const url of ["https://other.example/api/session", "//other.example/api/session", "/assets/app.js"]) await apiFetch(url);
  // Then
  for (const call of calls) expect(call.init).toBeUndefined();
});

it("generates UUIDs on plain-HTTP LAN origins without secure-context randomUUID", async () => {
  // Given: randomUUID is unavailable on plain HTTP, but getRandomValues works.
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("not a secure context"); });
  try {
    // When
    await apiFetch("/api/session");
    // Then
    expect(new Headers(calls[0]?.init?.headers).get("x-request-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { uuid.mockRestore(); }
});

it("covers JSON reads, writes, auth and pairing at their existing call sites", async () => {
  // Given / When
  await fetchSession();
  await cliProxyRequest("", { method: "POST", headers: { "x-herdr-machine": "1" } });
  await pairDevice("fictional-code", "fictional-label");
  await authenticate("fictional-token");
  await revokeDevice("fictional-device");
  await signOut();
  // Then
  expect(calls).toHaveLength(6);
  const ids = calls.map((call) => new Headers(call.init?.headers).get("x-request-id"));
  expect(new Set(ids).size).toBe(6);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
});

it("ends a Portal sign-in with Portal's own POST, which is no call of this app's API", async () => {
  // Given / When
  await signOutOfPortal();
  // Then: Portal's gateway answers a same-origin POST to this path; it takes no body and no correlation header
  expect(calls).toEqual([{ url: "/_portal/auth/logout", init: { method: "POST" } }]);
  // and a refusal is an error the caller can tell
  fetchSpy.mockImplementationOnce(Object.assign(async () => Response.json({ error: { code: "forbidden", message: "logout requires a same-origin POST" } }, { status: 403 }), { preconnect: globalThis.fetch.preconnect }));
  await expect(signOutOfPortal()).rejects.toMatchObject({ status: 403, detail: "logout requires a same-origin POST" });
});
