import type { Machine } from "../../shared/machines.ts";

const KEY = "ovis:pc-notice-dismissed";

export function noticeKey(machine: Pick<Machine, "id" | "action_required">): string {
  return `${machine.id}:${machine.action_required ?? ""}`;
}

export function waitingMachines(machines: Machine[], dismissed: readonly string[]): Machine[] {
  return machines.filter((machine) => machine.action_required && machine.action_required !== "connect" && !dismissed.includes(noticeKey(machine)));
}

export function keepDismissed(dismissed: readonly string[], machines: Machine[]): string[] {
  const connected = machines.filter((machine) => machine.state === "connected").map((machine) => `${machine.id}:`);
  return dismissed.filter((key) => !connected.some((prefix) => key.startsWith(prefix)));
}

export function readDismissed(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}

export function writeDismissed(dismissed: readonly string[]): void {
  try {
    if (dismissed.length) window.localStorage.setItem(KEY, JSON.stringify(dismissed));
    else window.localStorage.removeItem(KEY);
  } catch {}
}
