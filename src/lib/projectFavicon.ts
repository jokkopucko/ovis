import { ApiError, fetchProjectFavicon } from "./api.ts";

export function faviconKey(machineId: string, root: string): string {
  return `${machineId}\u0000${root}`;
}

const probes = new Map<string, Promise<string | null>>();

export function probeFavicon(machineId: string, root: string): Promise<string | null> {
  const key = faviconKey(machineId, root);
  const known = probes.get(key);
  if (known) return known;
  const probe = fetchProjectFavicon(root, machineId).then((icon) => icon?.path ?? null, (error: unknown) => {
    if (error instanceof ApiError && error.status < 500 && error.status !== 429) return null;
    if (probes.get(key) === probe) probes.delete(key);
    return null;
  });
  probes.set(key, probe);
  return probe;
}

export function forgetFaviconProbes(): void {
  probes.clear();
}
