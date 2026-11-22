export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function safeAreaInsets(): SafeAreaInsets {
  const style = getComputedStyle(document.documentElement);
  const inset = (side: keyof SafeAreaInsets): number => parseFloat(style.getPropertyValue(`--safe-area-${side}`)) || 0;
  return { top: inset("top"), right: inset("right"), bottom: inset("bottom"), left: inset("left") };
}
