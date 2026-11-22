import { runOnOwnHerdr } from "./own-herdr.ts";

await runOnOwnHerdr("ui-regression's terminal part", async () => {
  process.env["UI_REGRESSION_PART"] = "terminal";
  await import("./ui-regression.ts");
});
