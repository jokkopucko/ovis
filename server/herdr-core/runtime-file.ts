/**
 * The runtime chosen in Settings, saved as `runtime-<port>.json` in the state folder: read by the
 * server on that port as it starts (runtime-choice.ts) and put back by its launcher when a start on
 * it fails (server/supervisor.ts). Every Ovis of this user shares the state folder, so each port
 * keeps its own choice. Files only, so the launcher stays small.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeName as Runtime } from "../../shared/machines.ts";

/** the choice's file for the server on `port` */
export function runtimeFile(port: number): string {
  return `runtime-${port}.json`;
}

export interface SavedRuntime {
  runtime: Runtime;
  /** the runtime served before this choice: what a start that fails goes back to */
  previous: Runtime | null;
  /** the switch that saved it: a failed start puts back only its own choice, never a later one */
  id?: string;
  /** the previous runtime was what the PC's facts chose, not a choice: a failed start goes back to the facts */
  previous_detected?: boolean;
}

/** The choice saved from Settings, or null when there is none or it is not one Ovis knows. */
export function readSavedRuntime(stateDir: string, port: number): SavedRuntime | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(stateDir, runtimeFile(port)), "utf8")); } catch { return null; }
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const known = (input: unknown): Runtime | null => input === "herdr" || input === "herdr-core" || input === "alt-runtime" ? input : null;
  const runtime = known(record["runtime"]);
  if (runtime === null) return null;
  return { runtime, previous: known(record["previous"]), ...(typeof record["id"] === "string" ? { id: record["id"] } : {}), ...(record["previous_detected"] === true ? { previous_detected: true } : {}) };
}

/**
 * Saves the choice whole or not at all: a server that starts meanwhile reads the old one or the new.
 * The temporary file has a name nobody can guess and is created afresh (`wx`), so nothing placed
 * there beforehand, a link included, is written through.
 */
export function saveRuntime(stateDir: string, port: number, saved: SavedRuntime): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, runtimeFile(port));
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(saved)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Puts back the runtime served before the choice `id` saved, after a start on it failed: the
 * previous choice, or no choice at all when the PC's facts had chosen. A choice saved since, or
 * one with nothing to go back to, stays.
 */
export function restoreRuntime(stateDir: string, port: number, id: string): boolean {
  const saved = readSavedRuntime(stateDir, port);
  if (saved?.id !== id || saved.previous === null) return false;
  if (saved.previous_detected) rmSync(join(stateDir, runtimeFile(port)), { force: true });
  else saveRuntime(stateDir, port, { runtime: saved.previous, previous: null });
  return true;
}
