import { useCallback, useEffect, useRef, useState } from "react";

export interface DesktopUpdate {
  readonly version: string;
  readonly closed: boolean;
}

export interface DesktopUpdateBridge {
  current(): Promise<unknown>;
  onChange(listener: (update: unknown) => void): () => void;
  /** Restart to Update: settles only when Ovis keeps running after it (a .deb's password prompt cancelled) */
  install(): Promise<void>;
  close(version: string): void;
}

export function desktopUpdateBridge(): DesktopUpdateBridge | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisUpdate?: Partial<DesktopUpdateBridge> }).ovisUpdate;
  return bridge && typeof bridge.current === "function" && typeof bridge.onChange === "function" && typeof bridge.install === "function" && typeof bridge.close === "function"
    ? bridge as DesktopUpdateBridge : null;
}

export function readDesktopUpdate(value: unknown): DesktopUpdate | null {
  const update = value as { version?: unknown; closed?: unknown } | null;
  return typeof update?.version === "string" && update.version !== "" ? { version: update.version, closed: update.closed === true } : null;
}

export function watchDesktopUpdate(bridge: DesktopUpdateBridge, listener: (update: DesktopUpdate | null) => void): () => void {
  let changed = false;
  let stopped = false;
  const stop = bridge.onChange((update) => {
    changed = true;
    if (!stopped) listener(readDesktopUpdate(update));
  });
  void bridge.current().then((update) => { if (!changed && !stopped) listener(readDesktopUpdate(update)); }, () => {});
  return () => {
    stopped = true;
    stop();
  };
}

export interface DesktopUpdateLine {
  version: string;
  installing: boolean;
  install(): void;
  close(): void;
}

export function useDesktopUpdate(): DesktopUpdateLine | null {
  const [bridge] = useState(desktopUpdateBridge);
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
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
