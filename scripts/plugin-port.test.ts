import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canBind, canServe, FALLBACK_PORTS, freePort, savedPort } from "./plugin-port.ts";

let scratch: string;

beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "herdr-plugin-port-")); });
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("savedPort", () => {
  it("reads the port an earlier start kept", () => {
    writeFileSync(join(scratch, "port"), "17317\n");
    expect(savedPort(join(scratch, "port"))).toBe(17317);
  });

  it("is null with no file, and for a file that holds no port", () => {
    expect(savedPort(join(scratch, "missing"))).toBeNull();
    for (const text of ["", "abc", "0", "70000", "73.17"]) {
      writeFileSync(join(scratch, "port"), text);
      expect(savedPort(join(scratch, "port"))).toBeNull();
    }
  });
});

describe("canBind", () => {
  it("is false while a server holds the port, and true once it lets go", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = holder.port!;
    expect(await canBind("127.0.0.1", port)).toBe(false);
    await holder.stop(true);
    expect(await canBind("127.0.0.1", port)).toBe(true);
  });
});

describe("canServe", () => {
  it("counts a port taken on ::1 as taken only when the server would open ::1 too", async () => {
    let holder: ReturnType<typeof Bun.serve> | undefined;
    // a port held on ::1 whose number is free on 127.0.0.1: the OS picks ::1's number alone, and a test running
    // beside this one may hold the same number on 127.0.0.1, which would say nothing about canServe
    for (let attempt = 0; attempt < 20 && holder === undefined; attempt++) {
      let held: ReturnType<typeof Bun.serve>;
      try {
        held = Bun.serve({ hostname: "::1", port: 0, fetch: () => new Response() });
      } catch {
        return;
      }
      if (await canBind("127.0.0.1", held.port!)) holder = held;
      else await held.stop(true);
    }
    if (holder === undefined) throw new Error("no ::1 port whose number was free on 127.0.0.1 in 20 tries");
    const port = holder.port!;
    try {
      expect(await canServe("127.0.0.1", port, false)).toBe(true);
      expect(await canServe("127.0.0.1", port, true)).toBe(false);
    } finally { await holder.stop(true); }
    expect(await canServe("127.0.0.1", port, true)).toBe(true);
  });
});

describe("freePort", () => {
  it("takes the default first when a kept port stopped opening", async () => {
    expect(await freePort(17317, 7317, async () => true)).toBe(7317);
  });

  it("skips the port that failed and every port that does not open", async () => {
    const tried: number[] = [];
    const opens = async (port: number) => { tried.push(port); return port === FALLBACK_PORTS[1]; };
    expect(await freePort(7317, 7317, opens)).toBe(FALLBACK_PORTS[1]!);
    expect(tried).toEqual([FALLBACK_PORTS[0]!, FALLBACK_PORTS[1]!]);
  });

  it("is null when none opens", async () => {
    expect(await freePort(7317, 7317, async () => false)).toBeNull();
  });
});
