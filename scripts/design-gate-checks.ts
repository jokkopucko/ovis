/**
 * The design gate's decisions that do not need a browser (scripts/design-gate-qa.ts): the focus walk's
 * cycle, the layout comparison and the effective target square. `targetVerdict` is also handed to the
 * page as source text, so it stays self-contained (no imports, no outer names).
 */

export interface Rect { x: number; y: number; w: number; h: number }
export type Layout = Record<string, Record<string, Rect>>;

export type FocusStop<Verdict> = { id: null } | { id: number; verdict: Verdict };
export interface FocusDriver<Verdict> {
  current(): Promise<FocusStop<Verdict>>;
  tab(): Promise<FocusStop<Verdict>>;
}
export interface FocusWalk<Verdict> {
  verdicts: Map<number, Verdict>;
  complete: boolean;
  presses: number;
}

export async function walkFocus<Verdict>(driver: FocusDriver<Verdict>, ceiling: number): Promise<FocusWalk<Verdict>> {
  const verdicts = new Map<number, Verdict>();
  const start = await driver.current();
  if (start.id !== null) verdicts.set(start.id, start.verdict);
  let outside = 0;
  for (let presses = 1; presses <= ceiling; presses += 1) {
    const stop = await driver.tab();
    if (stop.id === null) {
      // past the last stop focus leaves the page once; twice in a row means the page has nothing to stop on
      outside += 1;
      if (outside >= 2) return { verdicts, complete: true, presses };
      continue;
    }
    outside = 0;
    const seen = verdicts.has(stop.id);
    verdicts.set(stop.id, stop.verdict);
    if (seen) return { verdicts, complete: true, presses };
  }
  return { verdicts, complete: false, presses: ceiling };
}

export function moves(before: Layout, now: Layout, scope: { requested: ReadonlySet<string>; narrowed: boolean; tolerance: number }): string[] {
  const lines: string[] = [];
  for (const [visitKey, was] of Object.entries(before)) {
    const anchors = now[visitKey];
    const where = visitKey.split("|").join(" ");
    if (!anchors) {
      if (scope.narrowed && !scope.requested.has(visitKey)) continue;
      for (const name of Object.keys(was)) lines.push(`MOVED ${name} ${where} missing missing`);
      continue;
    }
    for (const [name, rect] of Object.entries(was)) {
      const at = anchors[name];
      if (!at) { lines.push(`MOVED ${name} ${where} missing missing`); continue; }
      const dx = Math.round((at.x - rect.x) * 10) / 10, dy = Math.round((at.y - rect.y) * 10) / 10;
      if (Math.abs(dx) > scope.tolerance || Math.abs(dy) > scope.tolerance) lines.push(`MOVED ${name} ${where} ${dx} ${dy}`);
    }
    for (const name of Object.keys(anchors)) if (!was[name]) lines.push(`MOVED ${name} ${where} added added`);
  }
  for (const [visitKey, anchors] of Object.entries(now)) {
    if (before[visitKey]) continue;
    const where = visitKey.split("|").join(" ");
    for (const name of Object.keys(anchors)) lines.push(`MOVED ${name} ${where} added added`);
  }
  return lines;
}

export interface RingRead { outline: string; boxShadow: string; border: string }
export type RingOwner = { on: "self" } | { on: "ancestor"; index: number; changed: (keyof RingRead)[] } | { on: null };

export function ringOwner(selfDrawn: boolean, wrappers: readonly { focused: RingRead; blurred: RingRead; drawn: Record<keyof RingRead, boolean> }[]): RingOwner {
  if (selfDrawn) return { on: "self" };
  for (const [index, wrapper] of wrappers.entries()) {
    const changed = (["outline", "boxShadow", "border"] as const).filter((part) => wrapper.drawn[part] && wrapper.focused[part] !== wrapper.blurred[part]);
    if (changed.length) return { on: "ancestor", index, changed };
  }
  return { on: null };
}

export function targetVerdict(box: { left: number; top: number; width: number; height: number }, min: number, owns: (x: number, y: number) => boolean): { method: "box" | "effective" | null; hits: number } {
  if (box.width >= min - 0.5 && box.height >= min - 0.5) return { method: "box", hits: 5 };
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2, near = min / 2 - 1;
  const reach = (dx: number, dy: number): number => {
    let step = 0;
    while (step < min && owns(cx + dx * (step + 1), cy + dy * (step + 1))) step += 1;
    // Bracket each edge to 0.25px and use its midpoint (at most 0.25px error per axis).
    // Do not add the box rule's tolerance: browser hit testing already rounds at edges.
    while (step + 0.25 <= min && owns(cx + dx * (step + 0.25), cy + dy * (step + 0.25))) step += 0.25;
    return Math.min(step + 0.125, min);
  };
  const left = reach(-1, 0), right = reach(1, 0), top = reach(0, -1), bottom = reach(0, 1);
  const reachesFloor = left + right >= min && top + bottom >= min;
  const mx = cx + (right - left) / 2, my = cy + (bottom - top) / 2;
  const points: [number, number][] = [[mx - near, my - near], [mx + near, my - near], [mx - near, my + near], [mx + near, my + near], [mx, my]];
  const hits = points.filter(([x, y]) => owns(x, y)).length;
  return { method: reachesFloor && hits === points.length ? "effective" : null, hits };
}
