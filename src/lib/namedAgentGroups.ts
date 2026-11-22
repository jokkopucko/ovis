import { pruneSidebarPins, sidebarPinKey } from "./sidebarPins.ts";

export const MAX_AGENT_GROUPS = 12;
export const MAX_AGENT_GROUP_NAME = 32;
export const MAX_GROUPED_AGENTS = 300;

export function sanitizeGroupNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names = raw.filter((name): name is string => typeof name === "string").map((name) => name.trim().slice(0, MAX_AGENT_GROUP_NAME)).filter((name) => name !== "");
  return [...new Set(names)].slice(0, MAX_AGENT_GROUPS);
}

export function sanitizeGroupOf(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const entries = Object.entries(raw).filter((entry): entry is [string, string] => entry[0] !== "" && typeof entry[1] === "string" && entry[1].trim() !== "");
  return Object.fromEntries(entries.slice(-MAX_GROUPED_AGENTS).map(([key, name]) => [key, name.trim().slice(0, MAX_AGENT_GROUP_NAME)]));
}

interface GroupedRow { machine: { id: string }; entry: { pane: { pane_id: string; parent_pane_id?: string } } }

const keyOf = ({ machine, entry }: GroupedRow): string => sidebarPinKey(machine.id, entry.pane.pane_id);

export function rowAgentGroup<R extends GroupedRow>(row: R, groupOf: Readonly<Record<string, string>>, names: readonly string[], all: readonly R[]): string | null {
  const byKey = new Map(all.map((candidate) => [keyOf(candidate), candidate]));
  const passed = new Set<R>();
  for (let up: R | undefined = row; up && !passed.has(up); up = up.entry.pane.parent_pane_id === undefined ? undefined : byKey.get(sidebarPinKey(up.machine.id, up.entry.pane.parent_pane_id))) {
    const name = groupOf[keyOf(up)];
    if (name !== undefined && names.includes(name)) return name;
    passed.add(up);
  }
  return null;
}

export function splitNamedGroups<R extends GroupedRow>(rows: readonly R[], groupOf: Readonly<Record<string, string>>, names: readonly string[], all: readonly R[] = rows): { name: string | null; rows: R[] }[] {
  const byName = new Map<string | null, R[]>([...names.map((name): [string, R[]] => [name, []]), [null, []]]);
  for (const row of rows) byName.get(rowAgentGroup(row, groupOf, names, all))!.push(row);
  return [...byName].flatMap(([name, grouped]) => grouped.length === 0 ? [] : [{ name, rows: grouped }]);
}

export function assignAgentGroup(groupOf: Readonly<Record<string, string>>, key: string, name: string | null, kept: (key: string) => boolean = () => true): Record<string, string> | null {
  const next = Object.fromEntries(Object.entries(groupOf).filter(([held]) => held !== key && kept(held)));
  if (name !== null && !(key in groupOf) && Object.keys(next).length >= MAX_GROUPED_AGENTS) return null;
  if (name !== null) next[key] = name;
  return next;
}

/**
 * The grouped keys that may stay with the next change: those whose pane a loaded PC still has (any
 * pane, not only an agent row: a new session's agent may not have started yet), and every key of a
 * PC still loading or hidden on this device, which cannot say its panes are gone.
 */
export function liveGroupKeys(groupOf: Readonly<Record<string, string>>, machines: readonly { id: string; snapshot: { panes: readonly { pane_id: string }[] } | null }[], hidden: readonly string[]): ReadonlySet<string> {
  const live = new Set(machines.flatMap((machine) => machine.snapshot?.panes.map((pane) => sidebarPinKey(machine.id, pane.pane_id)) ?? []));
  return new Set(pruneSidebarPins(Object.keys(groupOf), live, machines, hidden));
}

export function renameAgentGroup(names: readonly string[], groupOf: Readonly<Record<string, string>>, from: string, to: string): { names: string[]; groupOf: Record<string, string> } | null {
  const name = to.trim().slice(0, MAX_AGENT_GROUP_NAME);
  if (name === "" || (name !== from && names.includes(name))) return null;
  return {
    names: names.map((held) => held === from ? name : held),
    groupOf: Object.fromEntries(Object.entries(groupOf).map(([key, held]) => [key, held === from ? name : held])),
  };
}

export function removeAgentGroup(names: readonly string[], groupOf: Readonly<Record<string, string>>, name: string): { names: string[]; groupOf: Record<string, string> } {
  return { names: names.filter((held) => held !== name), groupOf: Object.fromEntries(Object.entries(groupOf).filter(([, held]) => held !== name)) };
}

/** The groups after herdr moved a pane under a new ID (#1503): its group goes with it. */
export function movedAgentGroup(groupOf: Readonly<Record<string, string>>, machineId: string, from: string, to: string): Readonly<Record<string, string>> {
  const before = sidebarPinKey(machineId, from), after = sidebarPinKey(machineId, to);
  const name = groupOf[before];
  if (name === undefined) return groupOf;
  const next: Record<string, string> = Object.fromEntries(Object.entries(groupOf).filter(([key]) => key !== before));
  next[after] = name;
  return next;
}

const FOLDER_GROUPS_KEY = "ovis:agent-group-by-folder";
const MAX_FOLDER_GROUPS = 100;

function folderKey(machineId: string, folder: string): string {
  return `${machineId}\n${folder.trim().replace(/[\\/]+$/, "")}`;
}

function readFolderGroups(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FOLDER_GROUPS_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
  } catch { return {}; }
}

export function folderAgentGroup(machineId: string, folder: string | null, names: readonly string[]): string | null {
  if (folder === null || folder.trim() === "") return null;
  const name = readFolderGroups()[folderKey(machineId, folder)];
  return name !== undefined && names.includes(name) ? name : null;
}

export function rememberFolderAgentGroup(machineId: string, folder: string | null, name: string | null): void {
  if (folder === null || folder.trim() === "") return;
  const key = folderKey(machineId, folder);
  const held = Object.entries(readFolderGroups()).filter(([kept]) => kept !== key);
  if (name !== null) held.push([key, name]);
  try { window.localStorage.setItem(FOLDER_GROUPS_KEY, JSON.stringify(Object.fromEntries(held.slice(-MAX_FOLDER_GROUPS)))); }
  catch { /* storage denied: the next opening starts with no group */ }
}

export function renameDeviceAgentGroup(from: string, to: string | null): void {
  const folders = Object.entries(readFolderGroups()).flatMap(([key, name]): [string, string][] => name !== from ? [[key, name]] : to === null ? [] : [[key, to]]);
  try { window.localStorage.setItem(FOLDER_GROUPS_KEY, JSON.stringify(Object.fromEntries(folders))); }
  catch { /* storage denied: the folders start on no group */ }
  saveFoldedAgentGroups(loadFoldedAgentGroups().flatMap((name) => name !== from ? [name] : to === null ? [] : [to]));
}

const FOLDS_KEY = "ovis:agent-group-folds";

export function loadFoldedAgentGroups(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(FOLDS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
  } catch { return []; }
}

export function saveFoldedAgentGroups(names: readonly string[]): void {
  try { window.localStorage.setItem(FOLDS_KEY, JSON.stringify(names)); }
  catch { /* private mode: this page keeps it */ }
}
