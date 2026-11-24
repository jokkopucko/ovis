import { expect, it } from "bun:test";
import { AGENT_CATALOG } from "../../shared/agent-catalog.ts";
import { ASK_EVERY_TIME_HARNESSES, OWN_RULES_HARNESSES } from "../../shared/harness-tool.ts";
import { keepsOwnRules, permissionLaunch } from "./permission-launch.ts";

it("offers in Settings exactly the harnesses a parent that proves no ceiling can start", () => {
  const launchable = AGENT_CATALOG.filter((entry) => permissionLaunch(entry.id, undefined, "run", { argv: [entry.id] }) !== null).map((entry) => entry.id);
  expect(launchable).toEqual(Object.keys(ASK_EVERY_TIME_HARNESSES));
  expect(launchable.filter(keepsOwnRules)).toEqual([...OWN_RULES_HARNESSES]);
});
