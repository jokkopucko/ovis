import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { ApiError, authenticate, pairDevice } from "./api.ts";
import { ConnectionTrace } from "./connectionTrace.ts";

let status = 204;
const calls: { url: string; init?: RequestInit }[] = [];
const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: URL | RequestInfo, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  return status === 204 ? new Response(null, { status }) : Response.json({ error: { code: "invalid_token", message: "fictional refusal" } }, { status });
}, { preconnect: globalThis.fetch.preconnect }));
const opened: ConnectionTrace[] = [];
afterAll(() => fetchSpy.mockRestore());
afterEach(() => { status = 204; calls.length = 0; fetchSpy.mockClear(); for (const trace of opened.splice(0)) trace.close(); });

const context = () => ({ connection: 1, socket_state: 1, visibility: "visible" as const, online: true });
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function signedOutTrace() {
  let now = 1000; let reports = 0;
  const trace = new ConnectionTrace("ws://fixture/ws", context, async () => { reports++; return 401; }, () => now);
  opened.push(trace);
  trace.record("close", {}, true); await settle();
  now += 60_000; trace.record("close", {}, true);
  expect(reports).toBe(1);
  return { reported: () => reports, incident: () => { now += 60_000; trace.record("close", {}, true); } };
}

describe("sign-in calls", () => {
  const signIns = [
    { name: "authenticate", url: "/api/auth", call: () => authenticate("fictional-token"), body: { token: "fictional-token" } },
    { name: "pairDevice", url: "/api/devices/pair", call: () => pairDevice("fictional-code", "fictional-label"), body: { code: "fictional-code", label: "fictional-label" } },
  ];

  for (const { name, url, call, body } of signIns) {
    it(`${name} posts its JSON body and lets reporting paused by a 401 resume`, async () => {
      const trace = await signedOutTrace();
      await call();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(url);
      expect(calls[0]!.init?.method).toBe("POST");
      expect(new Headers(calls[0]!.init?.headers).get("content-type")).toBe("application/json");
      expect(new Headers(calls[0]!.init?.headers).get("x-herdr-machine")).toBe("1");
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(body);
      trace.incident();
      expect(trace.reported()).toBe(2);
    });

    it(`${name} throws the server's refusal and leaves reporting paused`, async () => {
      const trace = await signedOutTrace();
      status = 401;
      const error = await call().then(() => null, (reason: unknown) => reason);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 401, code: "invalid_token" });
      trace.incident();
      expect(trace.reported()).toBe(1);
    });
  }
});
