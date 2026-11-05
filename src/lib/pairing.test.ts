import { describe, expect, it, spyOn } from "bun:test";
import { pairThisBrowser, singleFlight } from "./pairing.ts";

// This browser pairing itself (the guide's Connect your phone, Settings → Phone's Pair this device
// now): two at once could leave the later, already void, cookie in place of the good one.
describe("singleFlight", () => {
  it("lets every view that asks while one runs join it", async () => {
    let runs = 0;
    const done = Promise.withResolvers<string>();
    const pair = singleFlight(() => { runs += 1; return done.promise; });
    const guide = pair();
    const settings = pair();
    expect(runs).toBe(1);
    done.resolve("paired");
    expect(await Promise.all([guide, settings])).toEqual(["paired", "paired"]);
  });

  it("runs again once the one before finished, failed or not", async () => {
    let runs = 0;
    const pair = singleFlight(() => { runs += 1; return runs === 1 ? Promise.reject(new Error("offline")) : Promise.resolve("paired"); });
    await expect(pair()).rejects.toThrow("offline");
    expect(await pair()).toBe("paired");
    expect(await pair()).toBe("paired");
    expect(runs).toBe(3);
  });
});

describe("pairThisBrowser", () => {
  it("asks for no code when the server already lists this browser as paired (paired in Settings, or the app's access facts are behind)", async () => {
    const asked: string[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
      asked.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response(JSON.stringify({ devices: [{ id: "d1", label: "Linux · Chrome", current: true, created_at: 1, last_seen_at: 1 }] }), { headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    try {
      const list = await pairThisBrowser();
      expect(list.map((device) => device.id)).toEqual(["d1"]);
      expect(asked).toEqual(["GET /api/devices"]);
    } finally {
      fetch.mockRestore();
    }
  });
});
