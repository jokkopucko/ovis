import { describe, expect, it } from "bun:test";

import { translate, type Translate } from "../lib/i18n.ts";
import { changePcDescription } from "./SettingsDevicesPage.tsx";

const t: Translate = (key, vars) => translate("en", key, vars);

describe("the app's Change PC row", () => {
  it("calls the page the demo only where the demo build marked it", () => {
    expect(changePcDescription(t, true, "localhost")).toBe("This is the demo. Go back to the app's list of PCs to open yours.");
  });

  it("names the address of any other page, the iOS app's own copy at capacitor://app.ovis.sh included", () => {
    expect(changePcDescription(t, false, "app.ovis.sh")).toBe("This app shows app.ovis.sh. Go back to its list of PCs to open another.");
    expect(changePcDescription(t, false, "192.168.0.10:7317")).toBe("This app shows 192.168.0.10:7317. Go back to its list of PCs to open another.");
  });
});
