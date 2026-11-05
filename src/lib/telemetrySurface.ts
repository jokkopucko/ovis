import type { TelemetrySurface } from "../../shared/telemetry.ts";
import { isAppWindow } from "./install.ts";
import { inAndroidApp, inMacApp, inNativeApp } from "./nativeApp.ts";

export interface SurfaceInput {
  /** the iOS or Android app around this page (lib/nativeApp.ts), or null in a browser */
  nativeApp: "ios" | "android" | null;
  /** Ovis for Mac's own window */
  macApp: boolean;
  /** this window is an installed web app's, not a browser tab (lib/install.ts isAppWindow) */
  installed: boolean;
  userAgent: string;
  maxTouchPoints: number;
}

/**
 * The kind of screen this page runs on, for the daily anonymous usage counts (shared/telemetry.ts
 * TELEMETRY_SURFACES). A phone or tablet is told by its user agent; an iPad that asks for desktop
 * pages names itself a Mac but has a touch screen.
 */
export function surfaceOf(input: SurfaceInput): TelemetrySurface {
  if (input.nativeApp === "ios") return "ios-app";
  if (input.nativeApp === "android") return "android-app";
  if (input.macApp) return "mac-app";
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(input.userAgent) || (/Macintosh/.test(input.userAgent) && input.maxTouchPoints > 1);
  if (input.installed) return mobile ? "mobile-pwa" : "pwa";
  return mobile ? "mobile-browser" : "browser";
}

export function currentSurface(): TelemetrySurface {
  return surfaceOf({
    nativeApp: inNativeApp() ? (inAndroidApp() ? "android" : "ios") : null,
    macApp: inMacApp(),
    installed: isAppWindow(),
    userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent,
    maxTouchPoints: typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints ?? 0,
  });
}
