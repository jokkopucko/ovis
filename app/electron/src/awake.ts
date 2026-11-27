/**
 * The server the app runs writes how many agents work (server/desktop-activity.ts); while the setting
 * is on, the server runs and one works, the app holds off system sleep (Electron's powerSaveBlocker,
 * `prevent-app-suspension`: the display may still turn off).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { desktopText, type TextKey } from "./text.ts";

export { DESKTOP_ACTIVITY_FILE } from "../../../server/desktop-activity.ts";

export interface AwakeSettings {
  whileWorking: boolean;
  onBattery: boolean;
}

/** Until the user chooses: hold the computer awake while an agent works, on power only. */
const DEFAULTS: AwakeSettings = { whileWorking: true, onBattery: false };

function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

export function readAwakeSettings(path: string): AwakeSettings {
  const saved = readJson(path) as Partial<Record<keyof AwakeSettings, unknown>> | null;
  return {
    whileWorking: typeof saved?.whileWorking === "boolean" ? saved.whileWorking : DEFAULTS.whileWorking,
    onBattery: typeof saved?.onBattery === "boolean" ? saved.onBattery : DEFAULTS.onBattery,
  };
}

export function writeAwakeSettings(path: string, settings: AwakeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(settings));
  renameSync(temporary, path);
}

export function readWorking(path: string): number {
  const working = (readJson(path) as { working?: unknown } | null)?.working;
  return typeof working === "number" && Number.isSafeInteger(working) && working > 0 ? working : 0;
}

export function holdAwake({ settings, working, onBattery, serverRunning }: { settings: AwakeSettings; working: number; onBattery: boolean; serverRunning: boolean }): boolean {
  return settings.whileWorking && serverRunning && working > 0 && (!onBattery || settings.onBattery);
}

export function awakeLabel(working: number, text: (key: TextKey, values?: Record<string, number>) => string = desktopText("en")): string {
  return working === 1 ? text("Keeping this computer awake: 1 agent working") : text("Keeping this computer awake: {count} agents working", { count: working });
}
