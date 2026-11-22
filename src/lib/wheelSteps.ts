/**
 * Lines herdr scrolls a pane per wheel report: its `ui.mouse_scroll_lines` default. The browser
 * cannot read the PC's herdr config, so a changed value only changes how far one report goes.
 */
export const HERDR_MOUSE_SCROLL_LINES = 3;

export function wheelSteps(pixels: number, stepPixels: number): { steps: number; rest: number } {
  if (!(stepPixels > 0) || !Number.isFinite(pixels)) return { steps: 0, rest: 0 };
  const steps = Math.trunc(pixels / stepPixels);
  return { steps, rest: pixels - steps * stepPixels };
}

export function finalStep(rest: number, stepPixels: number): -1 | 0 | 1 {
  if (!(stepPixels > 0) || !Number.isFinite(rest)) return 0;
  return Math.abs(rest) >= stepPixels / 2 ? (Math.sign(rest) as -1 | 1) : 0;
}
