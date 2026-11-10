/**
 * The update the desktop app (app/electron) has downloaded. The app updates itself and the server
 * it carries, so this server offers no release (shared/update.ts DESKTOP_APP_UPDATES): the app's
 * preload says when one is ready (`ovisUpdate`, app/electron/src/preload.ts), and Restart to Update
 * here is the tray's. A browser tab has no such bridge, and no line.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** What the app says of its downloaded update: `closed` once its line was closed for this version. */
export interface DesktopUpdate {
  readonly version: string;
  readonly closed: boolean;
}

/** What the desktop app's preload offers its pages. */
export interface DesktopUpdateBridge {
  current(): Promise<unknown>;
  /** returns what stops the listening */
  onChange(listener: (update: unknown) => void): () => void;
  /** Restart to Update: settles only when Ovis keeps running after it (a .deb's password prompt cancelled) */
  install(): Promise<void>;
  /** closes the line of that version, in the app: also for its later starts */
  close(version: string): void;
}

export function desktopUpdateBridge(): DesktopUpdateBridge | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisUpdate?: Partial<DesktopUpdateBridge> }).ovisUpdate;
  return bridge && typeof bridge.current === "function" && typeof bridge.onChange === "function" && typeof bridge.install === "function" && typeof bridge.close === "function"
    ? bridge as DesktopUpdateBridge : null;
}

/** The app's answer as this page reads it: anything but a named version is no update. */
export function readDesktopUpdate(value: unknown): DesktopUpdate | null {
  const update = value as { version?: unknown; closed?: unknown } | null;
  return typeof update?.version === "string" && update.version !== "" ? { version: update.version, closed: update.closed === true } : null;
}

/**
 * Tells `listener` the app's downloaded update, now and as it changes; returns what stops it.
 * Listening starts before the asking, and an answer that arrives after a change is dropped: it
 * was read before that change.
 */
export function watchDesktopUpdate(bridge: DesktopUpdateBridge, listener: (update: DesktopUpdate | null) => void): () => void {
  let changed = false;
  let stopped = false;
  const stop = bridge.onChange((update) => {
    changed = true;
    if (!stopped) listener(readDesktopUpdate(update));
  });
  void bridge.current().then((update) => { if (!changed && !stopped) listener(readDesktopUpdate(update)); }, () => { /* an app that does not answer has no update to show */ });
  return () => {
    stopped = true;
    stop();
  };
}

/** The line a downloaded update shows in this window. */
export interface DesktopUpdateLine {
  version: string;
  /** Restart to Update was pressed and the app has not said it keeps running */
  installing: boolean;
  install(): void;
  close(): void;
}

/** The desktop app's downloaded update, while its line is open; null in a browser, with none, or once closed. */
export function useDesktopUpdate(): DesktopUpdateLine | null {
  const [bridge] = useState(desktopUpdateBridge);
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  // two presses before the button is drawn disabled ask once
  const asked = useRef(false);
  useEffect(() => bridge ? watchDesktopUpdate(bridge, setUpdate) : undefined, [bridge]);
  const install = useCallback(() => {
    if (!bridge || asked.current) return;
    asked.current = true;
    setInstalling(true);
    const over = () => { asked.current = false; setInstalling(false); };
    void bridge.install().then(over, over);
  }, [bridge]);
  const version = update?.version ?? null;
  const close = useCallback(() => { if (version !== null) bridge?.close(version); }, [bridge, version]);
  return bridge && update && !update.closed ? { version: update.version, installing, install, close } : null;
}
