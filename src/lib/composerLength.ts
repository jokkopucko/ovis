/**
 * The box's maxLength clamps typing and pasting without a word; these say it: the box is full, and
 * how much of a paste did not fit.
 */

export function composerFull(length: number, max: number): boolean {
  return length >= max;
}

export function pasteOverflow(current: string, start: number, end: number, pasted: string, max: number): number {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const room = Math.max(0, max - (current.length - (hi - lo)));
  return Math.max(0, pasted.length - room);
}

export function formatChars(count: number): string {
  return new Intl.NumberFormat().format(count);
}
