import type { PlanStep } from "../../shared/protocol.ts";

export function planWaves(steps: readonly PlanStep[]): PlanStep[][] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (step: PlanStep): number => {
    const known = level.get(step.id);
    if (known !== undefined) return known;
    if (visiting.has(step.id)) return 0;
    visiting.add(step.id);
    let wave = 0;
    for (const id of step.blocked_by) {
      const before = byId.get(id);
      if (before !== undefined) wave = Math.max(wave, depth(before) + 1);
    }
    visiting.delete(step.id);
    level.set(step.id, wave);
    return wave;
  };
  const waves: PlanStep[][] = [];
  for (const step of steps) (waves[depth(step)] ??= []).push(step);
  return waves.filter((wave) => wave !== undefined);
}
