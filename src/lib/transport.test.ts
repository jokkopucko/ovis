import { afterEach, expect, it } from "bun:test";
import { apiFetch } from "./api-request-id.ts";
import { fetchHealth, requestRelay } from "./api.ts";
import type { RelayStatus } from "../../shared/protocol.ts";
import { getTransport, nativeTransport, serverResourceUrl, setTransport, type Transport } from "./transport.ts";

function testTransport(fetch: Transport["fetch"]): Transport {
  return {
    kind: "relay",
    fetch,
    openSocket: () => { throw new Error("no socket in this test"); },
    openEventSource: () => { throw new Error("no event stream in this test"); },
    resourceUrl: (path) => `relay:${path}`,
  };
}

afterEach(() => setTransport(nativeTransport));

it("the native transport loads a server path from the path itself", () => {
  expect(getTransport()).toBe(nativeTransport);
  expect(nativeTransport.resourceUrl("/api/fs/file?path=a")).toBe("/api/fs/file?path=a");
  expect(serverResourceUrl("/api/fs/file?path=a")).toBe("/api/fs/file?path=a");
});

it("only server paths go to the transport for an address", () => {
  const transport = testTransport(() => Promise.reject(new Error("unused")));
  expect(serverResourceUrl("/api/fs/file?path=a", transport)).toBe("relay:/api/fs/file?path=a");
  for (const url of ["data:image/png;base64,AAAA", "blob:http://localhost/1", "https://other.example/api/x.png", "/?read=a.md"]) {
    expect(serverResourceUrl(url, transport)).toBe(url);
  }
});

it("setTransport swaps what apiFetch sends through", async () => {
  // Given
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  setTransport(testTransport(async (input, init) => { calls.push({ input, init }); return Response.json({ ok: true }); }));
  // When
  const response = await apiFetch("/api/session", { cache: "no-store" });
  // Then
  expect(await response.json()).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(String(calls[0]?.input)).toBe("/api/session");
  expect(calls[0]?.init?.cache).toBe("no-store");
  expect(new Headers(calls[0]?.init?.headers).get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
});

it("a transport that refuses makes the API call reject with its error", async () => {
  // Given
  const refused = new Error("relay unreachable");
  setTransport(testTransport(() => Promise.reject(refused)));
  // When / Then
  await expect(fetchHealth()).rejects.toBe(refused);
});

it("relay controls use the selected transport even for a refusal carrying relay status", async () => {
  // Given
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const status: RelayStatus = { phase: "off", relay: "wss://relay.test", app: "https://app.test", sessions: 0, blocked: "serve_only", error: null };
  setTransport(testTransport(async (input, init) => {
    calls.push({ input, init });
    return Response.json(status, { status: 409 });
  }));
  // When
  const result = await requestRelay("start");
  // Then
  expect(result).toEqual(status);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.input).toBe("/api/relay/start");
  expect(calls[0]?.init?.method).toBe("POST");
  expect(new Headers(calls[0]?.init?.headers).get("x-herdr-update")).toBe("1");
});
