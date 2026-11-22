import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { FileInfo } from "../../shared/protocol.ts";
import { faviconKey, forgetFaviconProbes, probeFavicon } from "./projectFavicon.ts";

const realFetch = globalThis.fetch;
const icon = (path: string): FileInfo => ({ path, name: path.slice(path.lastIndexOf("/") + 1), size: 3, modified: "2026-01-01T00:00:00.000Z", mime: "image/svg+xml", kind: "image" });
const error = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });

function serve(...responses: (Response | Error)[]): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(url);
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof fetch;
  return asked;
}

describe("project favicon probe", () => {
  beforeEach(forgetFaviconProbes);
  afterEach(() => { globalThis.fetch = realFetch; });

  it("asks the folder's PC once for the best icon, however many places it may be kept", async () => {
    const asked = serve(Response.json({ icon: icon("/work/app/public/favicon.ico") }));
    expect(await probeFavicon("local", "/work/app")).toBe("/work/app/public/favicon.ico");
    expect(asked).toEqual([`/api/fs/favicon?root=${encodeURIComponent("/work/app")}`]);
  });

  it("asks another PC through its own route", async () => {
    const asked = serve(Response.json({ icon: icon("/srv/site/logo.svg") }));
    expect(await probeFavicon("pc 2", "/srv/site")).toBe("/srv/site/logo.svg");
    expect(asked).toEqual([`/api/machines/pc%202/fs/favicon?root=${encodeURIComponent("/srv/site")}`]);
  });

  it("takes a folder without an icon as an answer, and remembers it", async () => {
    const asked = serve(Response.json({ icon: null }));
    expect(await probeFavicon("local", "/x")).toBeNull();
    expect(await probeFavicon("local", "/x")).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it("probes a folder once, also for rows asking at the same time, and once more on another PC", async () => {
    const asked = serve(Response.json({ icon: icon("/x/favicon.svg") }));
    const [first, second] = await Promise.all([probeFavicon("local", "/x"), probeFavicon("local", "/x")]);
    expect([first, second]).toEqual(["/x/favicon.svg", "/x/favicon.svg"]);
    expect(asked).toHaveLength(1);
    expect(await probeFavicon("pc2", "/x")).toBe("/x/favicon.svg");
    expect(asked).toHaveLength(2);
    expect(faviconKey("pc2", "/x")).not.toBe(faviconKey("local", "/x"));
  });

  it("asks again after a check that failed: the PC unreachable, a bridge error, a proxy's rate limit", async () => {
    for (const failure of [new TypeError("Failed to fetch"), error(502, "machine_unavailable"), error(503, "machine_offline"), error(429, "too_many_requests")]) {
      forgetFaviconProbes();
      const asked = serve(failure, Response.json({ icon: icon("/x/favicon.ico") }));
      expect(await probeFavicon("pc2", "/x")).toBeNull();
      expect(await probeFavicon("pc2", "/x")).toBe("/x/favicon.ico");
      expect(asked).toHaveLength(2);
    }
  });

  it("remembers a refusal: a watching device, or a PC whose bridge has no such route", async () => {
    for (const refusal of [error(403, "read_only"), error(404, "not_found")]) {
      forgetFaviconProbes();
      const asked = serve(refusal);
      expect(await probeFavicon("pc2", "/x")).toBeNull();
      expect(await probeFavicon("pc2", "/x")).toBeNull();
      expect(asked).toHaveLength(1);
    }
  });
});
