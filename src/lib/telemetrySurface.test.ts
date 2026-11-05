import { describe, expect, it } from "bun:test";

import { surfaceOf, type SurfaceInput } from "./telemetrySurface.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const input = (overrides: Partial<SurfaceInput>): SurfaceInput => ({ nativeApp: null, macApp: false, installed: false, userAgent: LINUX, maxTouchPoints: 0, ...overrides });

describe("surfaceOf", () => {
  it("names the apps before anything the page looks like", () => {
    expect(surfaceOf(input({ nativeApp: "ios", userAgent: IPHONE, installed: true }))).toBe("ios-app");
    expect(surfaceOf(input({ nativeApp: "android", userAgent: ANDROID }))).toBe("android-app");
    expect(surfaceOf(input({ macApp: true, userAgent: `${MAC} OvisMac/1.0.0`, installed: true }))).toBe("mac-app");
  });

  it("tells an installed web app from a tab, on a phone and on a computer", () => {
    expect(surfaceOf(input({ userAgent: IPHONE, installed: true }))).toBe("mobile-pwa");
    expect(surfaceOf(input({ userAgent: ANDROID }))).toBe("mobile-browser");
    expect(surfaceOf(input({ installed: true }))).toBe("pwa");
    expect(surfaceOf(input({}))).toBe("browser");
  });

  it("counts an iPad asking for desktop pages as a phone or tablet, and a Mac as a computer", () => {
    expect(surfaceOf(input({ userAgent: MAC, maxTouchPoints: 5 }))).toBe("mobile-browser");
    expect(surfaceOf(input({ userAgent: MAC, maxTouchPoints: 0 }))).toBe("browser");
  });
});
