import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ComponentProps, type FocusEvent } from "react";

export interface ChatRowMemory {
  readonly toggles: Map<string, boolean | null>;
  readonly outputs: Map<string, string>;
  readonly runs: Map<number, string>;
  readonly dormant: Map<number, string>;
  focused?: { readonly key: string };
}

export const ChatRowMemoryContext = createContext<ChatRowMemory | null>(null);

export function chatRowMemory(memories: Map<string, ChatRowMemory>, key: string): ChatRowMemory {
  let memory = memories.get(key);
  if (!memory) {
    memory = { toggles: new Map(), outputs: new Map(), runs: new Map(), dormant: new Map() };
    memories.set(key, memory);
  }
  return memory;
}

export function useChatRowToggle(key: string, initial: boolean | null) {
  const memory = useContext(ChatRowMemoryContext);
  const [value, setValue] = useState(() => memory?.toggles.has(key) ? memory.toggles.get(key) ?? null : initial);
  const update = useCallback((next: boolean | null) => {
    memory?.toggles.set(key, next);
    setValue(next);
  }, [key, memory]);
  return [value, update] as const;
}

export function useRowFocus<T extends HTMLElement>(key: string, from: readonly string[] = []) {
  const memory = useContext(ChatRowMemoryContext);
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const focused = memory?.focused;
    const head = ref.current;
    if (head !== null && focused !== undefined && (focused.key === key || from.includes(focused.key))) {
      const active = document.activeElement;
      if (active === null || active === document.body) head.focus({ preventScroll: true });
      // a new record for the head that holds it, which the cleanups below leave alone. Here, not only
      // in onFocus: with the window in the background the browser moves the focus but sends the
      // focus event only when the reader comes back
      if (memory && document.activeElement === head) memory.focused = { key };
    }
    return () => {
      // the heads drawn in its place in this render have run the effect above by the time this
      // microtask runs; a record none of them took is ended. A head still on the page (StrictMode's
      // rehearsed unmount keeps the element) has not left.
      const left = memory?.focused;
      if (memory && left !== undefined && left.key === key) queueMicrotask(() => { if (memory.focused === left && head?.isConnected !== true) memory.focused = undefined; });
    };
  }, []);
  const onFocus = useCallback(() => { if (memory) memory.focused = { key }; }, [memory, key]);
  // a head that leaves the page takes no blur from it, and the window losing the focus is no move
  // away: the record stays for the head that replaces it while the reader is in another app
  const onBlur = useCallback((event: FocusEvent<T>) => {
    if (memory && memory.focused?.key === key && event.currentTarget.isConnected && document.hasFocus()) memory.focused = undefined;
  }, [memory, key]);
  return { ref, onFocus, onBlur };
}

export function ChatDetails({ memoryKey, onToggle, defaultOpen = false, ...props }: ComponentProps<"details"> & { memoryKey: string; defaultOpen?: boolean }) {
  const [chosen, setChosen] = useChatRowToggle(memoryKey, null);
  const open = chosen ?? defaultOpen;
  return <details {...props} open={open} onToggle={(event) => {
    // the toggle a render's own `open` fires (on mount, or as the default changes) is no choice of the reader's
    if (event.currentTarget.open !== open) setChosen(event.currentTarget.open);
    onToggle?.(event);
  }} />;
}
