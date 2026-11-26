import { unlinkSync, writeFileSync } from "node:fs";
import { desktopListenerMatches, desktopListenerPath } from "../shared/desktop-command-listener.ts";

export function recordDesktopListener(record: string, pid: number): () => void {
  const path = desktopListenerPath(record);
  writeFileSync(path, String(pid), { mode: 0o600 });
  return () => {
    if (desktopListenerMatches(record, pid)) unlinkSync(path);
  };
}
