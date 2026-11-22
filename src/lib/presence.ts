export function pageInUse(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

export function watchPageInUse(listener: (active: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const update = (): void => listener(pageInUse());
  update();
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  window.addEventListener("pagehide", update);
  document.addEventListener("visibilitychange", update);
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    window.removeEventListener("pagehide", update);
    document.removeEventListener("visibilitychange", update);
  };
}
