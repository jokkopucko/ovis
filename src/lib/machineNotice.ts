import type { Machine } from "../../shared/machines.ts";
import { readDismissedList, writeDismissedList } from "./dismissedStorage.ts";

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
  return readDismissedList(KEY);
}

export function writeDismissed(dismissed: readonly string[]): void {
  writeDismissedList(KEY, dismissed);
}
