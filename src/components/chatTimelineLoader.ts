import { useSyncExternalStore } from "react";

import type { ChatTimeline as ChatTimelineComponent } from "./ChatTimeline.tsx";

type Timeline = typeof ChatTimelineComponent;

let loaded: Timeline | null = null;
let pending: Promise<Timeline> | null = null;
const listeners = new Set<() => void>();

export function loadChatTimeline(): Promise<Timeline> {
  if (loaded !== null) return Promise.resolve(loaded);
  pending ??= import("./ChatTimeline.tsx").then((module) => {
    loaded = module.ChatTimeline;
    for (const listener of listeners) listener();
    return loaded;
  }, (cause: unknown) => {
    pending = null;
    throw cause;
  });
  return pending;
}

export function loadedChatTimeline(): Timeline | null {
  return loaded;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useChatTimeline(): Timeline | null {
  return useSyncExternalStore(subscribe, loadedChatTimeline, loadedChatTimeline);
}

loadChatTimeline().catch(() => undefined);
