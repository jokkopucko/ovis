import { expect, it } from "bun:test";
import type { AgentIntegration } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { loadIntegrations, outcomeFor } from "./integrations.ts";

const claude: AgentIntegration = { target: "claude", label: "claude", command: "claude", available: true, state: "current" };

it("answers an unsupported bridge's 404 as unsupported, and any other failure as an error", async () => {
  expect(await loadIntegrations(async () => [claude])).toEqual({ kind: "list", integrations: [claude] });
  expect(await loadIntegrations(async () => { throw new ApiError("/api/machines/pc/integrations", 404, "unknown endpoint", "not_found"); })).toEqual({ kind: "unsupported" });
  expect(await loadIntegrations(async () => { throw new ApiError("/api/machines/pc/integrations", 503, "This PC is disconnected", "machine_offline"); }))
    .toMatchObject({ kind: "error", message: expect.stringContaining("This PC is disconnected") });
  expect(await loadIntegrations(async () => { throw new TypeError("offline"); })).toEqual({ kind: "error", message: "offline" });
});

it("shows an outcome only for the PC it was asked of", () => {
  const failed = { machineId: "pc-a", outcome: { kind: "error", message: "boom" } } as const;
  expect(outcomeFor(failed, "pc-a")).toEqual(failed.outcome);
  expect(outcomeFor(failed, "pc-b")).toBeNull();
  expect(outcomeFor(null, "pc-b")).toBeNull();
});
