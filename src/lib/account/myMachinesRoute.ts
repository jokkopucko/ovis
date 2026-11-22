/** The hosted shell's signed-in machine list and the address of an open machine's details. */
import { useSyncExternalStore } from "react";

export interface MyMachinesRoute {
  readonly machineId: string | null;
}

const HASH = "#my-machines";

export function parseMyMachinesHash(hash: string | null | undefined): MyMachinesRoute | null {
  if (hash === HASH) return { machineId: null };
  if (!hash?.startsWith(`${HASH}?`)) return null;
  const params = new URLSearchParams(hash.slice(HASH.length + 1));
  return { machineId: params.get("machine") || null };
}

export function formatMyMachinesHash({ machineId }: MyMachinesRoute): string {
  return machineId === null ? HASH : `${HASH}?${new URLSearchParams({ machine: machineId })}`;
}

function subscribe(changed: () => void): () => void {
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  return () => { window.removeEventListener("hashchange", changed); window.removeEventListener("popstate", changed); };
}

/** The address's fragment, kept up with Back, Forward and links. */
export function useLocationHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash, () => typeof window === "undefined" ? "" : window.location.hash ?? "");
}
