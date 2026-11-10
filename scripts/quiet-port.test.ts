import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { quietPort, quietRange } from "./quiet-port.ts";

it("picks from a stretch that holds none of the ports the system hands out", () => {
  // Linux's default, and macOS's and Windows's
  expect(quietRange(32768, 60999)).toEqual([20_000, 32_767]);
  expect(quietRange(49152, 65535)).toEqual([20_000, 49_151]);
  // a host set to hand out the ports a fixed pick would have taken
  expect(quietRange(15_000, 65_000)).toEqual([1024, 14_999]);
  expect(quietRange(20_500, 40_000)).toEqual([40_001, 65_535]);
  expect(quietRange(1024, 30_000)).toEqual([30_001, 65_535]);
  // nearly every port handed out: no stretch of a thousand is left
  expect(quietRange(1024, 65_535)).toBeNull();
  expect(quietRange(1500, 65_000)).toBeNull();
  for (const [first, last] of [[32768, 60999], [15_000, 65_000], [20_500, 40_000], [1024, 30_000]] as const) {
    const [from, to] = quietRange(first, last)!;
    expect(to < first || from > last).toBe(true);
    expect(from).toBeGreaterThanOrEqual(1024);
    expect(to).toBeLessThanOrEqual(65_535);
  }
});

it("gives a free port outside this host's own, and never the same one twice", () => {
  const ports = Array.from({ length: 40 }, () => quietPort());
  expect(new Set(ports).size).toBe(40);
  let first = 32768, last = 65535;
  try { [first, last] = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number) as [number, number]; } catch { /* not Linux */ }
  // a host that hands out nearly every port has none to give: nothing to hold it to
  if (quietRange(first, last) === null) return;
  for (const port of ports) {
    expect(port < first || port > last).toBe(true);
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    server.stop(true);
  }
});
