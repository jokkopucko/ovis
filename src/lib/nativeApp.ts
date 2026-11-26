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
  PluginHeaders?: ReadonlyArray<{ name?: unknown; methods?: ReadonlyArray<{ name?: unknown }> }>;
}

export const PUSH_PLUGIN = "OvisPush";

function bridge(): CapacitorBridge | undefined {
  return (globalThis as { Capacitor?: CapacitorBridge }).Capacitor;
}

export function inNativeApp(): boolean {
  return bridge()?.isNativePlatform?.() === true;
}

/** An iPhone or iPad: iPadOS reports a Mac user agent, and touch points tell the two apart. */
export function onIos(env: { userAgent: string; maxTouchPoints: number }): boolean {
  return /iPhone|iPad|iPod/.test(env.userAgent) || (/Macintosh/.test(env.userAgent) && env.maxTouchPoints > 1);
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

/** Whether the app's plugin `name` has `method`: an app built before the method was added has the plugin without it. */
export function hasNativeMethod(name: string, method: string): boolean {
  return inNativeApp() && (bridge()?.PluginHeaders ?? []).some((header) => header.name === name && (header.methods ?? []).some((each) => each.name === method));
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

/** The app's connect screen with this PC kept until another is picked; an app built before that leaves this PC for it. */
export async function chooseAnotherPc(): Promise<void> {
  if (hasNativeMethod("HerdrShell", "chooseAnother")) await callNative("HerdrShell", "chooseAnother");
  else await changePc();
}

/**
 * Tells the phone app which PC this page is, for the saved PC the app opened it as (HerdrShell identify): its relay ID,
 * as this PC's own health says it (`web_ui.server_id`), and its name. The app records them for that saved PC alone, so
 * its My PCs puts a PC saved by several ways (the relay, its Tailscale address, SSH) on one row. `serverId` "": the
 * health was read and names none, so the app drops one it kept (the address now reaches another Ovis); undefined: not
 * read yet, nothing said of it. Nothing to an app without identify: on iOS a call to a method the app lacks never settles.
 */
export function tellAppWhichPc(pc: { readonly serverId?: string | undefined; readonly name?: string | undefined }): void {
  const name = pc.name?.replace(/\.local$/i, "").trim();
  if (!hasNativeMethod("HerdrShell", "identify") || (pc.serverId === undefined && !name)) return;
  void callNative("HerdrShell", "identify", { ...(pc.serverId === undefined ? {} : { server_id: pc.serverId }), ...(name ? { name } : {}) }).catch(() => undefined);
}
