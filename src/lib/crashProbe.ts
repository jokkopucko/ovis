/**
 * The flag is a build-time
 * constant: only the browser lane's demo build (scripts/demo-build.ts) sets it, so `bun run build`
 * and the published demo drop the check altogether.
 */
declare const __HERDR_TEST_HOOKS__: boolean;

export type CrashRegion = "root" | "sidebar" | "pane" | "settings";

export function crashProbe(region: CrashRegion): void {
  if (__HERDR_TEST_HOOKS__ && new URLSearchParams(window.location.search).get("crash") === region) {
    throw new Error(`crash probe: ${region}`);
  }
}
