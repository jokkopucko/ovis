import { expect, test } from "bun:test";
import { exitCode, runSteps, table, type Step } from "./verdict.ts";

const pass = (id: string, needs?: string[]): Step<null> => ({ id, title: id, ...(needs ? { needs } : {}), run: async () => `${id} held` });

test("a step that throws fails, the steps that need it are blocked and name it, and the others still run", async () => {
  const results = await runSteps<null>([
    pass("a"),
    { id: "b", title: "b", needs: ["a"], run: async () => { throw new Error("b did not hold"); } },
    pass("c", ["b"]),
    pass("d", ["a"]),
  ], null);
  expect(results.map((result) => [result.id, result.verdict, result.detail])).toEqual([
    ["a", "PASS", "a held"],
    ["b", "FAIL", "b did not hold"],
    ["c", "BLOCKED", "b did not pass (FAIL)"],
    ["d", "PASS", "d held"],
  ]);
  expect(exitCode(results)).toBe(1);
});

test("a step not built yet is not run, blocks what needs it, and keeps the exit code from 0", async () => {
  let ran = false;
  const results = await runSteps<null>([
    { id: "held", title: "held", notBuilt: "a change in review", run: async () => { ran = true; return "ran"; } },
    pass("after", ["held"]),
  ], null);
  expect(ran).toBe(false);
  expect(results.map((result) => [result.verdict, result.detail])).toEqual([["NOT BUILT YET", "waits for a change in review"], ["BLOCKED", "held did not pass (NOT BUILT YET)"]]);
  expect(exitCode(results)).toBe(1);
});

test("a step that does not finish in its time fails with how long it had, and every later step is blocked by it", async () => {
  const results = await runSteps<null>([{ id: "slow", title: "slow", timeoutMs: 1, run: () => new Promise<string>(() => {}) }, pass("after")], null);
  expect(results.map((result) => [result.verdict, result.detail])).toEqual([["FAIL", "not finished within 1 ms"], ["BLOCKED", "slow ran out of time and may still be running"]]);
});

test("a step may need only an earlier step", async () => {
  await expect(runSteps<null>([pass("a", ["b"]), pass("b")], null)).rejects.toThrow("a needs b, which is not an earlier step");
});

test("only a run whose every step passed exits 0, and its table counts each verdict", async () => {
  const results = await runSteps<null>([pass("a"), pass("b", ["a"])], null);
  expect(exitCode(results)).toBe(0);
  expect(exitCode([])).toBe(1);
  expect(table("run", results)).toContain("PASS: 2");
  expect(table("run", [{ id: "x", title: "t | u", verdict: "FAIL", detail: "a\nb", ms: 0 }])).toContain("| x | FAIL | t \\| u | a b | 0 |");
});
