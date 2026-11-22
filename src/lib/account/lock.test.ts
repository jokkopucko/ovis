import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { ApiError } from "../api.ts";
import { fetchLockState, requestLock, requestUnlock } from "./lock.ts";

describe("strict mode through this PC's lock routes", () => {
  let requests: { path: string; method: string; body: unknown; machine: string | null }[];
  let answer: (path: string) => Response;

  beforeEach(() => {
    requests = [];
    answer = () => Response.json({ bound: true, locked: null, strict: false, confirm: "available", preview: { rows: [], grants: ["token"] } });
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7318").pathname;
      const headers = new Headers(init?.headers);
      requests.push({ path, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null, machine: headers.get("x-herdr-machine") });
      return answer(path);
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });
  afterEach(() => { mock.restore(); });

  it("T46: reads whether the PC is bound, locked, and what turning it on would end", async () => {
    expect(await fetchLockState()).toEqual({ bound: true, locked: null, strict: false, confirm: "available", preview: { rows: [], grants: ["token"] } });
    expect(requests[0]?.path).toBe("/api/account/lock");
  });

  it("T47: asks the PC to put the lock or the named unlock on its screen, and gets back what it waits on", async () => {
    answer = () => Response.json({ confirm: "c1" }, { status: 202 });
    expect(await requestLock()).toBe("c1");
    expect(await requestUnlock("l1")).toBe("c1");
    expect(requests.map(({ path, method, body, machine }) => [path, method, body, machine])).toEqual([
      ["/api/account/lock", "POST", {}, "1"], ["/api/account/unlock", "POST", { lock: "l1" }, "1"],
    ]);
  });

  it("R10: a window that is not this PC's own is refused, and the app says so rather than retrying", async () => {
    answer = () => Response.json({ error: { code: "local_required", message: "Only on this PC" } }, { status: 403 });
    const error = await requestLock().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: "local_required" });
  });
});

