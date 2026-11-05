import { useEffect, useMemo, useState } from "react";

import { getTransport, serverResourceUrl } from "./transport.ts";

/** A resolved address, or why it could not be had (`url` stays null then). */
export interface ResourceUrlState {
  readonly url: string | null;
  readonly error: unknown;
}

/**
 * The address to give the browser for a server path (lib/transport.ts). The native transport
 * answers at once with the path itself; a transport that answers later leaves it null meanwhile,
 * and one that refuses leaves it null with the refusal in `error`, so a caller can show a failure.
 * data:, blob: and other origins' URLs come back as they are.
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
