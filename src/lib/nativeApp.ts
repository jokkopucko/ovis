/**
 * The iOS app (app/) opens this client as its WebView's first page and puts Capacitor's bridge
 * on it. Only what the client needs of the app is here, through `window.Capacitor` as the app
 * injects it, so the browser build carries no Capacitor code.
 */
interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  nativePromise?: (plugin: string, method: string, options?: Record<string, unknown>) => Promise<unknown>;
  /** the app's native plugins, announced to the page before its first script runs */
  PluginHeaders?: ReadonlyArray<{ name?: unknown }>;
}

export const PUSH_PLUGIN = "OvisPush";

function bridge(): CapacitorBridge | undefined {
  return (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
}

export function inNativeApp(): boolean {
  return bridge()?.isNativePlatform?.() === true;
}

export function inMacApp(): boolean {
  return typeof navigator !== "undefined" && /\bOvisMac\//.test(navigator.userAgent);
}

/** Whether this page runs inside the Android app, whose WebView draws no menu of its own for a long-pressed link. */
export function inAndroidApp(): boolean {
  return inNativeApp() && bridge()?.getPlatform?.() === "android";
}

/**
 * Whether the app around this page has the native plugin `name`. An app built before the plugin
 * existed has not, and on iOS a call to a plugin the app lacks never settles.
 */
export function hasNativePlugin(name: string): boolean {
  return inNativeApp() && (bridge()?.PluginHeaders ?? []).some((header) => header.name === name);
}

/** Calls `method` of the app's plugin `plugin`; a refusal rejects with the plugin's `code` on the error. */
export async function callNative<T>(plugin: string, method: string, options: Record<string, unknown> = {}): Promise<T> {
  const call = bridge()?.nativePromise;
  if (!call) throw new Error(`this page has no ${plugin} plugin`);
  return await call(plugin, method, options) as T;
}

export async function changePc(): Promise<void> {
  await bridge()?.nativePromise?.("HerdrShell", "disconnect", {});
}
