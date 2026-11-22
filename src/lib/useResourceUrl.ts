import { useEffect, useMemo, useState } from "react";

import { getTransport, serverResourceUrl } from "./transport.ts";

export interface ResourceUrlState {
  readonly url: string | null;
  readonly error: unknown;
}

/**
 * Change `retry` only when the caller has authorized another load of a failed resource.
 */
export function useResourceUrlState(path: string | null, retry = 0): ResourceUrlState {
  const transport = getTransport();
  const target = useMemo(() => ({ path, transport }), [path, transport, retry]);
  const direct = path === null || !path.startsWith("/api/") || transport.kind === "native";
  const [resolved, setResolved] = useState<{ target: typeof target; state: ResourceUrlState } | null>(null);
  useEffect(() => {
    const path = target.path;
    if (direct || path === null) return;
    let live = true;
    const abort = new AbortController();
    let owned: string | null = null;
    const load = async (): Promise<void> => {
      try {
        const url = await serverResourceUrl(path, target.transport, abort.signal);
        if (url.startsWith("blob:")) {
          if (!live) { URL.revokeObjectURL(url); return; }
          owned = url;
        }
        if (live) setResolved({ target, state: { url, error: null } });
      } catch (error) {
        if (live) setResolved({ target, state: { url: null, error } });
      }
    };
    // Start effects, not render-time requests: StrictMode may discard a render or replay an effect.
    void load();
    return () => { live = false; abort.abort(); if (owned) URL.revokeObjectURL(owned); };
  }, [target, direct]);
  if (direct) return { url: path, error: null };
  return resolved?.target === target ? resolved.state : { url: null, error: null };
}

export function useResourceUrl(path: string | null): string | null {
  return useResourceUrlState(path).url;
}
