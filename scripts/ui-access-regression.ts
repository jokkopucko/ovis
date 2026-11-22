import { runOnOwnHerdr } from "./own-herdr.ts";

await runOnOwnHerdr("ui-regression's access part", async () => {
  process.env["UI_REGRESSION_PART"] = "access";
  await import("./ui-regression.ts");
});
