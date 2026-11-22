export type DesktopLinks = { onOpen(listener: (query: string) => void): void };

export function desktopLinks(): DesktopLinks | undefined {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisLink?: Partial<DesktopLinks> }).ovisLink;
  return typeof bridge?.onOpen === "function" ? bridge as DesktopLinks : undefined;
}
