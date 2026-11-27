import { useCallback, useEffect, useState } from "react";
import { readAppUpdate, type AppUpdate, type DesktopAppUpdate } from "./desktopUpdate.ts";
import { callNative, hasNativeMethod } from "./nativeApp.ts";

type PreviewAction = "state" | "check" | "install";

/**
 * Settings → About's row for the phone's preview app (the Android build type "preview", PreviewUpdater): its version,
 * a check that downloads a newer preview, and Restart to Update, which hands it to the system installer. Null in a
 * browser, in every other app build (they answer "off"), and in an app from before the method.
 */
export function usePreviewAppUpdate(): DesktopAppUpdate | null {
  const [native] = useState(() => hasNativeMethod("HerdrShell", "previewUpdate"));
  const [state, setState] = useState<AppUpdate | null>(null);
  const ask = useCallback(async (action: PreviewAction) => {
    const answer = readAppUpdate(await callNative<unknown>("HerdrShell", "previewUpdate", { action }));
    if (answer) setState(answer);
    return answer;
  }, []);
  // a check already running (the one when the app opens) is joined, so the row hears when it ends
  useEffect(() => {
    if (!native) return;
    void ask("state").then((now) => {
      if (now?.phase === "checking" || now?.phase === "downloading") return ask("check");
    }).catch(() => {});
  }, [native, ask]);
  // the native check answers once it and any download are over: until then the row says it is checking
  const check = useCallback(() => {
    setState((now) => now && { ...now, phase: "checking", error: null });
    // a refused check ends the checking phase, so the row can be tried again
    void ask("check").catch((error: unknown) => {
      setState((now) => now && { ...now, phase: "failed", error: error instanceof Error ? error.message : String(error) });
    });
  }, [ask]);
  const install = useCallback(() => { void ask("install").catch(() => {}); }, [ask]);
  return native && state && state.phase !== "off" ? { state, installing: false, check, install } : null;
}
