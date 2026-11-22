/**
 * Saving a picture where a download link would not save it (#3118). The iOS app's web view has no
 * download handler, so Capacitor lets a link to the PC's own address in as a page, and a
 * home-screen web app follows it the same way: the picture replaced the app, with no way back.
 * There the picture goes to the share sheet instead, whose Save Image keeps it. The Android app's
 * WebView drops a download link without a word and has no share sheet (#3153): there the app saves
 * the picture's bytes to Downloads itself. Everywhere else the link downloads as before.
 */
import { drawnPng } from "./clipboard.ts";
import { callNative, hasNativePlugin, inAndroidApp, inNativeApp } from "./nativeApp.ts";
import { getTransport } from "./transport.ts";

export function downloadLeavesApp(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || (inNativeApp() && !inAndroidApp());
}

/**
 * The picture `src` as a file named `name`. A PC path is read through the transport, as the page's
 * CSP lets no fetch reach a blob: or data: URL (a relay PC's pictures are blob: URLs once shown);
 * any other picture is the decoded `shown` one, encoded as PNG.
 */
export async function imageFile(src: string, name: string, shown: HTMLImageElement | null, signal?: AbortSignal): Promise<File> {
  if (src.startsWith("/api/")) {
    const response = await getTransport().fetch(src, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return new File([blob], name, { type: blob.type });
  }
  if (shown === null) throw new Error("picture not shown");
  return new File([await drawnPng(shown)], name, { type: "image/png" });
}

export const SAVE_PLUGIN = "OvisSave";

/** The app's limit (SavedImage.MAX_BYTES), checked here before the bytes are copied into base64. */
export const SAVE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * How Download saves the picture here: a download link, the share sheet, or the Android app. An
 * Android app built before its plugin has neither a working link nor a share sheet, so Download
 * there says it could not save rather than doing nothing.
 */
export function saveRoute(): "link" | "share" | "app" {
  if (hasNativePlugin(SAVE_PLUGIN)) return "app";
  return downloadLeavesApp() || inAndroidApp() ? "share" : "link";
}

export type ShareOutcome = "shared" | "cancelled" | "failed";

/**
 * Hands `file` to the Android app, which puts it in Downloads ("saved"), or on Android 8 and 9, which
 * give an app no Downloads of its own without the storage permission, opens the share sheet with it
 * ("shared").
 */
export async function saveInApp(file: File): Promise<"saved" | "shared" | "failed"> {
  if (file.size === 0 || file.size > SAVE_MAX_BYTES) return "failed";
  try {
    const { saved } = await callNative<{ saved?: string }>(SAVE_PLUGIN, "saveImage", { name: file.name, type: file.type, data: base64(new Uint8Array(await file.arrayBuffer())) });
    return saved === "downloads" ? "saved" : "shared";
  } catch {
    return "failed";
  }
}

function base64(bytes: Uint8Array): string {
  let text = "";
  // in slices, as one call with every byte as an argument overflows the stack
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/**
 * Offers `file` to the share sheet. WebKit opens it only within the tap that asked, so the file
 * must be in hand before the tap: call this first thing in the click.
 */
export async function shareFile(file: File): Promise<ShareOutcome> {
  const data = { files: [file] };
  if (typeof navigator.share !== "function" || navigator.canShare?.(data) === false) return "failed";
  try {
    await navigator.share(data);
    return "shared";
  } catch (error) {
    return error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
  }
}
