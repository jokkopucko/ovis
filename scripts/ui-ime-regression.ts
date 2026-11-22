import { runOnOwnHerdr } from "./own-herdr.ts";

await runOnOwnHerdr("ui-regression's ime part", async () => {
  process.env["UI_REGRESSION_PART"] = "ime";
  await import("./ui-regression.ts");
});
