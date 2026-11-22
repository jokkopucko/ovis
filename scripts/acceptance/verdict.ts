/**
 * The verdicts of an acceptance run (scripts/acceptance/first-run.ts): each step is decided once, in order, and only by
 * what it showed.
 *
 * - PASS: the step ran and its check held; its detail says what it saw.
 * - FAIL: the step threw, or did not finish within its time.
 * - BLOCKED: a step it needs did not pass, or an earlier step ran out of time and may still be changing what the
 *   steps share; it is not run, and it names that step.
 * - NOT BUILT YET: the step is written but waits for a change that is not on this checkout yet; it is not run.
 *
 * The run exits 0 only when every step passed: a step that is not built yet is not a pass.
 */

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "NOT BUILT YET";

export interface Step<C> {
  readonly id: string;
  readonly title: string;
  readonly needs?: readonly string[];
  /** set while the step waits for a change this checkout does not have: what that change is */
  readonly notBuilt?: string;
  readonly timeoutMs?: number;
  /** throws when the check does not hold; answers what it saw */
  readonly run: (ctx: C) => Promise<string>;
}

export interface StepResult {
  readonly id: string;
  readonly title: string;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly ms: number;
}

const STEP_MS = 120_000;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Decides every step in order; a failing step never stops the run. `decided` hears each result as it is known. */
export async function runSteps<C>(steps: readonly Step<C>[], ctx: C, decided: (result: StepResult) => void | Promise<void> = () => {}): Promise<StepResult[]> {
  const results: StepResult[] = [];
  const passed = new Set<string>();
  let timedOut: string | null = null;
  for (const step of steps) {
    const started = Date.now();
    const keep = async (verdict: Verdict, detail: string): Promise<void> => {
      const result = { id: step.id, title: step.title, verdict, detail, ms: Date.now() - started };
      results.push(result);
      if (verdict === "PASS") passed.add(step.id);
      await decided(result);
    };
    const unknown = (step.needs ?? []).find((id) => !steps.some((other) => other.id === id) || results.every((done) => done.id !== id));
    if (unknown !== undefined) throw new Error(`${step.id} needs ${unknown}, which is not an earlier step`);
    if (timedOut !== null) { await keep("BLOCKED", `${timedOut} ran out of time and may still be running`); continue; }
    const blocker = (step.needs ?? []).find((id) => !passed.has(id));
    if (blocker !== undefined) { await keep("BLOCKED", `${blocker} did not pass (${results.find((done) => done.id === blocker)?.verdict})`); continue; }
    if (step.notBuilt !== undefined) { await keep("NOT BUILT YET", `waits for ${step.notBuilt}`); continue; }
    const ms = step.timeoutMs ?? STEP_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: [Verdict, string];
    try {
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { timedOut = step.id; reject(new Error(`not finished within ${ms} ms`)); }, ms); });
      outcome = ["PASS", await Promise.race([step.run(ctx), late])];
    } catch (error) {
      outcome = ["FAIL", message(error)];
    } finally {
      clearTimeout(timer);
    }
    await keep(...outcome);
  }
  return results;
}

export function exitCode(results: readonly StepResult[]): number {
  return results.length > 0 && results.every((result) => result.verdict === "PASS") ? 0 : 1;
}

const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");

export function table(heading: string, results: readonly StepResult[]): string {
  const counts = new Map<Verdict, number>();
  for (const result of results) counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1);
  return [
    `# ${heading}`,
    "",
    [...counts].map(([verdict, count]) => `${verdict}: ${count}`).join(", "),
    "",
    "| Step | Verdict | What it checks | Detail | ms |",
    "|---|---|---|---|---|",
    ...results.map((result) => `| ${result.id} | ${result.verdict} | ${cell(result.title)} | ${cell(result.detail)} | ${result.ms} |`),
    "",
  ].join("\n");
}
