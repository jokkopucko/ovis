import { runOnOwnHerdr } from "./own-herdr.ts";
import type { UiContextGroup } from "./ui-contexts-checks.ts";

export async function runIsolatedUiContextChecks(group: UiContextGroup): Promise<void> {
  await runOnOwnHerdr("UI context checks", async () => {
    const { runUiContextChecks } = await import("./ui-contexts-checks.ts");
    await runUiContextChecks(group);
  });
}
