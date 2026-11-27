import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { act, useEffect } from "react";
import { useAccessState, usePairFromAddress } from "../lib/useAccess.ts";
import { AccessGate } from "./AccessGate.tsx";

describe("pairing link access gate", () => {
  let page: Page;
  let access: ReturnType<typeof useAccessState>;
  let gateKey = 0;
  let pairRequests: number;
  let pairStatus: number;
  let initiallyOpen: boolean;

  beforeEach(() => {
    initiallyOpen = false;
    pairRequests = 0;
    pairStatus = 204;
    gateKey = 0;
    page = openPage("https://ovis.example/?pair=123456");
    Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
    const fetch = async (input: string | URL | Request) => {
      if (String(input).includes("/api/devices/pair")) {
        pairRequests++;
        return pairStatus === 204 && pairRequests === 1 ? new Response(null, { status: 204 })
          : Response.json({ error: { code: "invalid_code", message: "spent" } }, { status: 401 });
      }
      return Response.json({ ok: true, auth: { required: !initiallyOpen, authenticated: false }, bridge_protocol: 1 });
    };
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await page.close();
    mock.restore();
  });

  function Probe() {
    access = useAccessState();
    usePairFromAddress({ ...access, loadHealth: access.readBridgeHealth });
    useEffect(() => { if (initiallyOpen) void access.readBridgeHealth(); }, []);
    if (access.locked === false || (initiallyOpen && access.locked === null)) return null;
    return <AccessGate key={gateKey} reason={access.lockReason} initialCode={access.pairCode}
      consumePairCode={access.consumePairCode} pairingUnconfirmed={access.pairingUnconfirmed}
      onPaired={access.onPaired} onUnlocked={() => access.setLocked(false)} />;
  }
  const view = () => <SettingsProvider><Probe /></SettingsProvider>;

  it("does not let the App effect submit a code already sent by the gate after unlock", async () => {
    await page.render(view());
    expect(access!.locked).toBe(false);
    expect(pairRequests).toBe(1);
    expect(access!.pairCode).toBe("");
  });

  it("leaves no link code in the field after a failed automatic attempt", async () => {
    pairStatus = 401;
    await page.render(view());
    expect(pairRequests).toBe(1);
    expect(page.one<HTMLInputElement>("#access-gate-code").value).toBe("");
  });

  it("pairs an already-open browser from the address once, without mounting the gate", async () => {
    initiallyOpen = true;
    await page.render(view());
    expect(access!.locked).toBe(false);
    expect(pairRequests).toBe(1);
    expect(access!.pairCode).toBe("");
    expect(page.container.childNodes).toHaveLength(0);
    await act(async () => { await access!.readBridgeHealth(); });
    expect(pairRequests).toBe(1);
  });

  it("does not replay a successful link when health rejects the cookie, and explains the relock", async () => {
    await page.render(view());
    expect(pairRequests).toBe(1);
    expect(access!.locked).toBe(false);
    await act(async () => { await access!.readBridgeHealth(); });
    expect(access!.locked).toBe(true);
    expect(pairRequests).toBe(1);
    const alerts = [...page.container.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
    expect(alerts).toContain("Could not confirm this browser is paired. Check that cookies are enabled, then try again.");
    expect(alerts.join(" ")).not.toContain("That code is wrong");
    const input = page.one<HTMLInputElement>("#access-gate-code");
    expect(input.value).toBe("");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("does not replay a failed link when the gate remounts", async () => {
    pairStatus = 401;
    await page.render(view());
    expect(pairRequests).toBe(1);
    gateKey++;
    await page.render(view());
    expect(pairRequests).toBe(1);
    expect(page.one<HTMLInputElement>("#access-gate-code").value).toBe("");
  });
});
