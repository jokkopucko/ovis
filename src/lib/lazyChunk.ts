/**
 * A part of the app fetched the first time it is needed (KaTeX, Mermaid). Its file is named after
 * the build, so a tab still running the build before a server update asks for one the server no
 * longer has, and a phone offline at that moment cannot reach it either. A failed load is not
 * tried again: Chrome keeps a failed import's answer for the page's life without fetching again,
 * and Vite's loader skips a stylesheet it tried before, so a second try could only fail again or
 * draw without its styles.
 */
type Listener = () => void;
const listeners = new Set<Listener>();
let failed = false;

export function onLazyChunkFailure(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function lazyChunkFailed(): boolean {
  return failed;
}

export function reportLazyChunkFailure(): void {
  failed = true;
  for (const listener of [...listeners]) {
    try { listener(); } catch {}
  }
}

/**
 * Hears Vite's loader on `target` (the window): every dynamic import of the bundle goes through it,
 * and it tells `vite:preloadError` of each one that fails, its stylesheets too. That reaches the
 * chunks a lazy part loads on its own, Mermaid's one per diagram type among them, which no
 * `lazyChunk` wraps: Mermaid turns their failure into a failed render, as a diagram that does not
 * parse is. The event is not cancelled, so the import still rejects as it would.
 */
export function watchPreloadErrors(target: EventTarget): () => void {
  const heard = (): void => reportLazyChunkFailure();
  target.addEventListener("vite:preloadError", heard);
  return () => target.removeEventListener("vite:preloadError", heard);
}
if (typeof window !== "undefined") watchPreloadErrors(window);

export function lazyChunk<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      reportLazyChunkFailure();
      throw error;
    });
    return pending;
  };
}
