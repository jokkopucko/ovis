import { describe, expect, it } from "bun:test";
import { panelUrl, shouldOpenWebPage, wantsPanel } from "./webPanel.ts";

const lan = { protocol: "http:", hostname: "100.123.228.51", origin: "http://100.123.228.51:7317" };
const local = { protocol: "http:", hostname: "localhost", origin: "http://localhost:7317" };

describe("panelUrl", () => {
  it("names a loopback dev server under the host the browser used for the app", () => {
    expect(panelUrl("http://localhost:5173/", lan)).toBe("http://100.123.228.51:5173/");
    expect(panelUrl("http://127.0.0.1:3000/docs?x=1#top", lan)).toBe("http://100.123.228.51:3000/docs?x=1#top");
    expect(panelUrl("http://0.0.0.0:8080", lan)).toBe("http://100.123.228.51:8080/");
    expect(panelUrl("http://[::1]:4000/", lan)).toBe("http://100.123.228.51:4000/");
    expect(panelUrl("http://app.localhost:5173/", lan)).toBe("http://100.123.228.51:5173/");
    expect(panelUrl("http://localhost:5173/", local)).toBe("http://localhost:5173/");
  });

  it("frames another port of the app's own host as it is", () => {
    expect(panelUrl("http://100.123.228.51:5174/page", lan)).toBe("http://100.123.228.51:5174/page");
  });

  it("leaves every other host to a tab", () => {
    expect(panelUrl("https://github.com/devswha/ovis", lan)).toBeNull();
    expect(panelUrl("http://192.168.0.10:5173/", lan)).toBeNull();
    expect(panelUrl("http://localhost.example.com:5173/", lan)).toBeNull();
  });

  it("never frames the app itself, another scheme, or a malformed address", () => {
    expect(panelUrl("http://localhost:7317/", lan)).toBeNull();
    expect(panelUrl("http://100.123.228.51:7317/settings", lan)).toBeNull();
    expect(panelUrl("javascript:alert(1)", lan)).toBeNull();
    expect(panelUrl("file:///etc/hosts", lan)).toBeNull();
    expect(panelUrl("http://", lan)).toBeNull();
  });

  it("leaves an http page to a tab when the app is https: the browser blocks it as mixed content", () => {
    const tls = { protocol: "https:", hostname: "pc.tail.ts.net", origin: "https://pc.tail.ts.net" };
    expect(panelUrl("http://localhost:5173/", tls)).toBeNull();
    expect(panelUrl("https://localhost:5173/", tls)).toBe("https://pc.tail.ts.net:5173/");
  });
});

describe("wantsPanel", () => {
  it("follows the setting, and Shift turns it around", () => {
    expect(wantsPanel("tab", false)).toBe(false);
    expect(wantsPanel("tab", true)).toBe(true);
    expect(wantsPanel("panel", false)).toBe(true);
    expect(wantsPanel("panel", true)).toBe(false);
  });
});

describe("shouldOpenWebPage", () => {
  it("lets only plain and Shift left-clicks follow the app setting", () => {
    const calls: Array<[string, boolean, string]> = [];
    const open = (uri: string, shiftKey: boolean, machineId: string) => { calls.push([uri, shiftKey, machineId]); return true; };
    const click = (values: Partial<MouseEvent> = {}) => ({ button: 0, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...values }) as MouseEvent;

    expect(shouldOpenWebPage(click(), "https://pc.tail.ts.net:9000/report", open, "local")).toBe(true);
    expect(shouldOpenWebPage(click({ shiftKey: true }), "https://pc.tail.ts.net:9000/report", open, "local")).toBe(true);
    for (const modifier of ["metaKey", "ctrlKey", "altKey"] as const) {
      expect(shouldOpenWebPage(click({ [modifier]: true }), "https://pc.tail.ts.net:9000/report", open, "local")).toBe(false);
    }
    expect(shouldOpenWebPage(click({ button: 1 }), "https://pc.tail.ts.net:9000/report", open, "local")).toBe(false);
    expect(calls).toEqual([
      ["https://pc.tail.ts.net:9000/report", false, "local"],
      ["https://pc.tail.ts.net:9000/report", true, "local"],
    ]);
  });
});
