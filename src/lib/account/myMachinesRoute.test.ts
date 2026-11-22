import { describe, expect, test } from "bun:test";
import { isDashboardHash } from "../relay/dashboardRoute.ts";
import { formatMyMachinesHash, parseMyMachinesHash } from "./myMachinesRoute.ts";

describe("the My machines address", () => {
  test("a route comes back from its address", () => {
    for (const route of [{ machineId: null }, { machineId: "0123456789abcdef0123456789abcdef" }]) {
      const hash = formatMyMachinesHash(route);
      expect(parseMyMachinesHash(hash)).toEqual(route);
      expect(isDashboardHash(hash)).toBe(false);
    }
  });

  test("the dashboard's views, a sign-in's return and a pairing link are not its addresses", () => {
    for (const hash of [undefined, null, "", "#", "#overview", "#pcs?filter=needs", "#devices", "#machines", "#invites", "#code=abc&state=xyz", "#offer=eyJ2IjoxfQ", "#my-machinesx", "#my-machines/devices", "#my-machines/invites", "#my-machines/other"]) {
      expect(parseMyMachinesHash(hash)).toBeNull();
    }
  });
});
