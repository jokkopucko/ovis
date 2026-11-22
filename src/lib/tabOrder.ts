/** herdr's tab.move counts insertion boundaries before removing the source tab. */
export function movedTabOrder(ids: readonly string[], tabId: string, insertIndex: number): string[] | null {
  const source = ids.indexOf(tabId);
  if (source < 0 || !Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > ids.length) return null;
  const target = insertIndex > source ? insertIndex - 1 : insertIndex;
  if (target === source) return null;
  const order = [...ids];
  order.splice(source, 1);
  order.splice(target, 0, tabId);
  return order;
}

export function adjacentTabBoundary(ids: readonly string[], tabId: string, direction: -1 | 1): number | null {
  const source = ids.indexOf(tabId);
  if (source < 0 || source + direction < 0 || source + direction >= ids.length) return null;
  return direction < 0 ? source - 1 : source + 2;
}

export function drawnTabBoundary(places: readonly number[], at: number): number {
  return at === 0 ? places[0]! : places[at - 1]! + 1;
}

export function tabDropBoundary(rects: readonly { left: number; right: number }[], x: number): number {
  const before = rects.findIndex((rect) => x < (rect.left + rect.right) / 2);
  return before < 0 ? rects.length : before;
}
