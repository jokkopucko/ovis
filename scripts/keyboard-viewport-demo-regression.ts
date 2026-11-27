import { join } from "node:path";
import panes from "../site/demo/fixtures/panes.json";
import { checkMobileViewport } from "./mobile-viewport-regression.ts";
import { withDemoBrowser } from "./demo-browser.ts";

const repo = join(import.meta.dir, "..");
await withDemoBrowser({ tempPrefix: "herdr-viewport-demo-" }, async ({ browser, origin }) => {
  await checkMobileViewport(browser, `${origin}/herdr-web-ui/demo/app`, panes.api);
});
