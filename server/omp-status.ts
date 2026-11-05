import { paneRead, paneScrollInfo } from "./herdr/client.ts";

/**
 * omp draws its own context in its status bar — `⠋ 46s · ◒ deepseek-flash · 📁 ~/coding_agent ·
 * ◫ 48.1%/1M ⟲ · $105.66` — which is the one place both numbers live: its transcript reports the
 * tokens a request filled but never the window, so the chat's context ring had no percent for omp.
 * Read from the screen, the same numbers omp shows.
 */

/** `◫ 48.1%/1M`: percent filled, then the window's size (`200k`, `1M`) */
const BAR = /◫\s*(\d+(?:\.\d+)?)\s*%\s*\/\s*(\d+(?:\.\d+)?)\s*([kKmM])\b/u;

export function ompStatusContext(screen: string): { used: number; window: number } | null {
  let found: RegExpExecArray | null = null;
  for (const line of screen.split("\n")) {
    const match = BAR.exec(line);
    if (match) found = match;
  }
  if (found === null) return null;
  const percent = Number(found[1]);
  const size = Number(found[2]) * (found[3]!.toLowerCase() === "m" ? 1_000_000 : 1_000);
  if (!Number.isFinite(percent) || !Number.isFinite(size) || size <= 0) return null;
  return { used: Math.round(size * Math.min(100, percent) / 100), window: Math.round(size) };
}

/** long enough that one chat push does not cost a screen read each, short enough to follow a turn */
const TTL_MS = 5_000;
const cache = new Map<string, { at: number; history: number; context: { used: number; window: number } | null }>();

/**
 * The pane's context, from its screen; null when the pane is not omp's or its bar is not drawn
 * (a dialog over it, the moment before the first status line).
 */
export async function ompScreenContext(paneId: string, now: number = Date.now()): Promise<{ used: number; window: number } | null> {
  const before = await paneScrollInfo(paneId).catch(() => null);
  if (before?.offset_from_bottom !== 0) return null;
  const hit = cache.get(paneId);
  if (hit !== undefined && now - hit.at < TTL_MS && hit.history === before.max_offset_from_bottom) return hit.context;
  const screen = await paneRead({ paneId, source: "visible", format: "text", timeoutMs: 2_000 }).then((read) => read.text, () => "");
  const after = screen === "" ? null : await paneScrollInfo(paneId).catch(() => null);
  if (after?.offset_from_bottom !== 0 || after.max_offset_from_bottom !== before.max_offset_from_bottom) return null;
  const context = ompStatusContext(screen);
  // a closed pane's entry goes with the next read of any pane, so the cache holds live panes only
  for (const [id, entry] of cache) if (now - entry.at >= TTL_MS) cache.delete(id);
  cache.set(paneId, { at: now, history: before.max_offset_from_bottom, context });
  return context;
}
