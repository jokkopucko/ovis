import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

const listenerPath = (record: string) => `${record}.listening`;

/** The desktop CLI needs the listener to still be open, not just its shutting-down process. */
export function desktopListenerMatches(record: string, pid: number): boolean {
  try { return readFileSync(listenerPath(record), "utf8") === String(pid); } catch { return false; }
}

export function recordDesktopListener(record: string, pid: number): () => void {
  writeFileSync(listenerPath(record), String(pid), { mode: 0o600 });
  return () => {
    if (desktopListenerMatches(record, pid)) unlinkSync(listenerPath(record));
  };
}
