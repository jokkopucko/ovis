/** Occurrences are distinct: a quick-reply list can contain the same text more than once. */
function occurrences(list: readonly string[]): Map<string, string> {
  const counts = new Map<string, number>();
  return new Map(list.map((value) => {
    const count = counts.get(value) ?? 0;
    counts.set(value, count + 1);
    return [JSON.stringify([value, count]), value];
  }));
}

export function rebasePreferenceList(base: readonly string[], local: readonly string[], remote: readonly string[]): string[] {
  const sameOrder = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((key, index) => key === b[index]);
  if (sameOrder(base, remote)) return [...local];
  const before = occurrences(base);
  const mine = occurrences(local);
  const theirs = occurrences(remote);
  const kept = [...theirs].filter(([key]) => mine.has(key) || !before.has(key));
  const added = [...mine].filter(([key]) => !before.has(key) && !theirs.has(key));
  const originalOrder = [...before.keys()].filter((key) => mine.has(key) && theirs.has(key));
  const localOrder = [...mine.keys()].filter((key) => before.has(key) && theirs.has(key));
  if (sameOrder(originalOrder, localOrder)) return [...kept, ...added].map(([, value]) => value);
  // An explicit local reorder applies to surviving items, without dropping remote additions.
  return [...mine].filter(([key]) => theirs.has(key) || !before.has(key))
    .concat(kept.filter(([key]) => !mine.has(key))).map(([, value]) => value);
}
