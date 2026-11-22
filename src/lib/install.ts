import { useCallback, useSyncExternalStore } from "react";
import { inMacApp, inNativeApp } from "./nativeApp.ts";
import { t } from "./i18n.ts";

interface InstallChoice {
  outcome: "accepted" | "dismissed";
  platform: string;
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<InstallChoice>;
}

type Listener = () => void;

let pendingPrompt: BeforeInstallPromptEvent | null = null;
let installedByEvent = false;
let relatedInstalled = false;
let lastInstalled = false;
let lastAppWindow = false;
let revision = 0;
const listeners = new Set<Listener>();

function emitChange(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): number {
  return revision;
}

const INSTALLED_DISPLAY_MODES = ["standalone", "minimal-ui", "window-controls-overlay", "tabbed", "unframed"].map((mode) => `(display-mode: ${mode})`);
const FULLSCREEN_DISPLAY = "(display-mode: fullscreen)";

export interface InstalledStateInput {
  matches(query: string): boolean;
  iosStandalone: boolean;
  installedByEvent: boolean;
  relatedInstalled: boolean;
  previous: boolean;
}

/** Fullscreen (F11, the macOS green button) reports no window mode of its own, so it keeps the
 * previous verdict instead of guessing from the display mode. */
export function installedState(input: InstalledStateInput): boolean {
  const signalled = input.iosStandalone || input.installedByEvent || input.relatedInstalled;
  if (input.matches(FULLSCREEN_DISPLAY)) return input.previous || signalled;
  return signalled || INSTALLED_DISPLAY_MODES.some((query) => input.matches(query));
}

function isStandalone(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  lastInstalled = installedState({
    matches: (query) => window.matchMedia?.(query).matches === true,
    iosStandalone: iosNavigator.standalone === true || inNativeApp() || inMacApp(),
    installedByEvent,
    relatedInstalled,
    previous: lastInstalled,
  });
  return lastInstalled;
}

/**
 * Whether this window itself is the installed app's, not a tab of a browser that has the app
 * installed. A link that opens a new tab of this origin (`target="_blank"`) lands in another app
 * window there, since the app's scope is the whole origin and no page can send it to the browser.
 */
export function isAppWindow(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const iosNavigator = navigator as Navigator & { standalone?: boolean };
  lastAppWindow = installedState({
    matches: (query) => window.matchMedia?.(query).matches === true,
    iosStandalone: iosNavigator.standalone === true,
    installedByEvent: false,
    relatedInstalled: false,
    previous: lastAppWindow,
  });
  return lastAppWindow;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    pendingPrompt = event as BeforeInstallPromptEvent;
    emitChange();
  });
  window.addEventListener("appinstalled", () => {
    installedByEvent = true;
    pendingPrompt = null;
    emitChange();
  });
  for (const query of [...INSTALLED_DISPLAY_MODES, FULLSCREEN_DISPLAY]) window.matchMedia?.(query).addEventListener("change", emitChange);
  // Chrome and Edge 140+ tell a tab of the same origin that the app is installed
  if (window.top === window) {
    const related = (navigator as Navigator & { getInstalledRelatedApps?: () => Promise<{ platform?: string }[]> }).getInstalledRelatedApps;
    const refreshRelated = () => {
      related?.call(navigator).then(
        (apps) => {
          relatedInstalled = apps.some((app) => app.platform === "webapp");
          if (!relatedInstalled) installedByEvent = false;
          emitChange();
        },
        () => {},
      );
    };
    refreshRelated();
    window.addEventListener("focus", refreshRelated);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") refreshRelated();
    });
  }
}

export interface InstallEnvironment {
  userAgent: string;
  /** window.isSecureContext: browsers only offer installation over HTTPS or localhost */
  secure: boolean;
  /** iPadOS reports a Mac user agent; touch points tell the two apart */
  maxTouchPoints: number;
}

/** How to install when the browser offers no prompt of its own (iOS never does). */
export function installHelp(env: InstallEnvironment): string {
  const ua = env.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1);
  if (ios) return t("Tap the Share button, then Add to Home Screen.");
  if (!env.secure) return t("Open this page over HTTPS (or on localhost) to install it.");
  if (/Firefox\//.test(ua) && !/Android/.test(ua)) return t("Firefox on desktop can't install web apps. Open this page in Chrome or Edge.");
  if (/Android/.test(ua)) return t("Open the browser menu, then Install app or Add to Home screen.");
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) return t("Choose File, then Add to Dock.");
  return t("Use the install icon in the address bar, or the browser menu's Install option.");
}

function currentInstallHelp(): string {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "";
  return installHelp({ userAgent: navigator.userAgent, secure: window.isSecureContext, maxTouchPoints: navigator.maxTouchPoints ?? 0 });
}

export interface InstallPromptState {
  canInstall: boolean;
  installed: boolean;
  install(): Promise<void>;
  help: string;
}

export function useInstallPrompt(): InstallPromptState {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const installed = isStandalone();
  const install = useCallback(async (): Promise<void> => {
    const prompt = pendingPrompt;
    if (prompt === null || isStandalone()) return;
    await prompt.prompt();
    await prompt.userChoice;
    if (pendingPrompt === prompt) pendingPrompt = null;
    emitChange();
  }, []);
  return { canInstall: pendingPrompt !== null && !installed, installed, install, help: currentInstallHelp() };
}

export function useAppWindow(): boolean {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return isAppWindow();
}
