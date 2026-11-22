import { expect } from "bun:test";
import { PcAccountState } from "./account/pc-binding.ts";
import type { ServerInstance } from "./index.ts";

export type PcAddMode = "off" | "unbound" | "source-bound" | "target-bound";
export const pcAddCases: PcAddMode[] = ["off", "unbound", "source-bound", "target-bound"];
export function bindTestPc(dir: string) { PcAccountState.open(dir).migrate("acct_pc_add", true); }

export async function expectPcAddRefused(response: Response, mode: "source-bound" | "target-bound", target: ServerInstance) {
  expect(target.context.services.devices.list(null).filter(row => row.via_relay)).toEqual([]);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(response.status).toBeLessThan(500);
  const local = mode === "source-bound";
  expect(await response.json()).toMatchObject({ error: { code: local ? "pc_add_source_bound" : "pc_add_target_bound",
    message: local ? "This PC is in an account. Add PCs from your account." : "That PC is in an account. Add it from that account." } });
}
