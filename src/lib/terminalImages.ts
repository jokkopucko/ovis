import { useEffect } from "react";
import type { GhosttyTerminal } from "./ghostty/terminal.ts";
import type { PictureLimits } from "./itermPictures.ts";

/** Caps on inline picture payloads and decoded pixels; a phone WebView gets a smaller budget. */
export function terminalImageOptions(coarse: boolean): PictureLimits {
  return coarse
    ? { pixelLimit: 2048 * 2048, sixelSizeLimit: 8_000_000, sizeLimit: 8_000_000 }
    : { pixelLimit: 4096 * 4096, sixelSizeLimit: 25_000_000, sizeLimit: 20_000_000 };
}

export function useTerminalImages(terminal: GhosttyTerminal | null, enabled: boolean, coarse: boolean): void {
  useEffect(() => {
    if (terminal) terminal.pictureLimits = enabled ? terminalImageOptions(coarse) : null;
  }, [terminal, enabled, coarse]);
}
