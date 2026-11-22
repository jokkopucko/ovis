import { shell } from "electron";

/** The addresses the desktop app hands to the system browser: http(s) and mailto, never a scheme an OS handler runs. */
export function opensOutside(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export function openOutside(url: string): void {
  try {
    if (opensOutside(url)) void shell.openExternal(url);
  } catch {}
}
