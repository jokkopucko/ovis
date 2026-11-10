import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, root, type Workflow } from "./shell-workflow-rules.ts";

const dir = join(root, ".github/workflows");
const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();

const STATUS = /\b(always|cancelled|failure|success)\s*\(/i;

/** A job-level `if` as GitHub's expression reads it: without `${{ }}`, and with what it quotes left out (a status function named in a string is not called). */
const expression = (condition: unknown): string =>
  String(condition ?? "").trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").replace(/'(?:[^']|'')*'/g, "''").trim();

/** The parts an expression's top level joins with `&&`; null when it has an `||` there, or a bracket left open. */
function conjuncts(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && text.startsWith("||", at)) return null;
    else if (depth === 0 && text.startsWith("&&", at)) { parts.push(text.slice(start, at)); start = at + 2; at += 1; }
  }
  return depth === 0 ? [...parts, text.slice(start)].map((part) => part.trim()) : null;
}

/**
 * Whether a job with this `if` may run although a job before it was skipped. A status function in
 * the condition replaces GitHub's implied `success()`, so it may, unless success() is one of the
 * parts the whole condition joins with `&&`: that is the implied rule written out. A condition this
 * cannot read counts as one that may, so the job behind it is named rather than missed.
 */
function mayRunAfterSkipped(condition: unknown): boolean {
  const text = expression(condition);
  return STATUS.test(text) && !(conjuncts(text) ?? []).some((part) => /^success\s*\(\s*\)$/i.test(part));
}

/**
 * Whether a job with this `if` says for itself when it runs: it calls a status function, and no
 * success() that is not negated. With a plain success() anywhere, however it is bracketed or
 * joined, a skipped job before it still keeps the condition false in every way this can read, so
 * such a job counts as not saying: it is named rather than missed.
 */
function saysWhenItRuns(condition: unknown): boolean {
  const text = expression(condition);
  return STATUS.test(text) && ![...text.matchAll(/\bsuccess\s*\(/gi)].some((call) => !text.slice(0, call.index).trimEnd().endsWith("!"));
}

/**
 * The jobs that wait for a job deciding for itself without deciding for themselves. A job whose `if`
 * names no status function runs only when no job its `needs` lead back to failed or was skipped,
 * however far back. Behind a deciding job that is the wrong rule: the deciding job ran and passed
 * although one before it was skipped, and the job after it is skipped all the same. The two
 * questions are asked apart, each so that a condition it cannot read names a job rather than
 * misses one: the job before may run (mayRunAfterSkipped), the job itself does not say (saysWhenItRuns).
 */
function skippedBehindDecidingJobs(workflow: Workflow): string[] {
  const needs = (id: string): string[] => [workflow.jobs[id]?.needs ?? []].flat();
  return Object.keys(workflow.jobs).filter((id) => {
    if (saysWhenItRuns(workflow.jobs[id]!.if)) return false;
    const seen = new Set<string>();
    // true once a job is reached through one that decides for itself
    const reaches = (from: string, behind: boolean): boolean => needs(from).some((need) => {
      if (behind) return true;
      if (seen.has(need)) return false;
      seen.add(need);
      return reaches(need, mayRunAfterSkipped(workflow.jobs[need]?.if));
    });
    return reaches(id, false);
  });
}

const workflowOf = (jobs: Workflow["jobs"]): Workflow => ({ on: {}, jobs });

test("a job behind one that decides for itself is found, however far behind, unless it decides too", () => {
  const beta = (publish: string | undefined) => workflowOf({
    host: { if: "needs.pick.outputs.host == 'build'" },
    tag: { needs: "host", if: "always() && needs.pick.outputs.tag != ''" },
    build: { needs: ["tag"], if: "always() && needs.tag.result == 'success'" },
    publish: { needs: ["build"], ...(publish === undefined ? {} : { if: publish }) },
    after: { needs: "publish" },
  });
  expect(skippedBehindDecidingJobs(beta(undefined))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("needs.build.result == 'success'"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("success() && needs.build.result == 'success'"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("${{ needs.build.result == 'success' && Success() }}"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("${{ !Cancelled() && needs.build.result == 'success' }}"))).toEqual(["after"]);
  expect(skippedBehindDecidingJobs(beta("${{ !cancelled() && needs.build.result == 'success' }}"))).toEqual(["after"]);
  // a success() this cannot place still keeps the job waiting on every job before it: bracketed, or beside an ||
  expect(skippedBehindDecidingJobs(beta("(success() && needs.build.result == 'success')"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("(inputs.tag != '') && (success())"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("success() && inputs.a || success() && inputs.b"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("always() && success()"))).toEqual(["publish", "after"]);
  // a status function named in a string is not called
  expect(skippedBehindDecidingJobs(beta("contains(github.event.head_commit.message, 'always()')"))).toEqual(["publish", "after"]);
  expect(skippedBehindDecidingJobs(beta("${{ !cancelled() && needs.build.result == 'it''s success()' }}"))).toEqual(["after"]);
  // a negated success() decides too: recover runs after the skipped gate, and publish behind it does not
  const recovering = (recover: string) => workflowOf({ gate: { if: "github.event_name != 'pull_request'" }, recover: { needs: "gate", if: recover }, publish: { needs: "recover" } });
  expect(skippedBehindDecidingJobs(recovering("!success()"))).toEqual(["publish"]);
  expect(skippedBehindDecidingJobs(recovering("${{ !success() && inputs.tag != '' }}"))).toEqual(["publish"]);
  expect(skippedBehindDecidingJobs(recovering("success() || failure()"))).toEqual(["publish"]);
  expect(skippedBehindDecidingJobs(recovering("(success() || inputs.force) && inputs.tag != ''"))).toEqual(["publish"]);
  expect(skippedBehindDecidingJobs(recovering("success() && inputs.tag != '||'"))).toEqual([]);
  expect(skippedBehindDecidingJobs(recovering("contains(needs.gate.result, 'success') && success()"))).toEqual([]);
  expect(skippedBehindDecidingJobs(recovering("contains(github.event.head_commit.message, 'failure()')"))).toEqual([]);
  // a deciding job with nothing before it hides nothing, and a plain chain is GitHub's own rule
  expect(skippedBehindDecidingJobs(workflowOf({ first: { if: "always()" }, second: { needs: "first" }, third: { needs: ["second"] } }))).toEqual([]);
  expect(skippedBehindDecidingJobs(workflowOf({ first: { if: "inputs.tag != ''" }, second: { needs: "first" } }))).toEqual([]);
});

test("no workflow leaves a job to be skipped behind one that ran", () => {
  const found = files.flatMap((file) => skippedBehindDecidingJobs(parseWorkflow(join(dir, file))).map((job) => `${file}: ${job}`));
  expect(found).toEqual([
    // its own condition leaves out the pull request, the one event that skips the gate before its build
    "windows-app.yml: attach",
  ]);
});

test("Beta uploads the desktop builds whenever they passed, whatever became of the host's own jobs", () => {
  const beta = parseWorkflow(join(dir, "beta.yml"));
  // host-publish has no condition: it is skipped with host-build, every time the host was built before
  expect(beta.jobs["host-build"]!.if).toBe("needs.pick.outputs.host == 'build'");
  expect(beta.jobs["host-publish"]!.if).toBeUndefined();
  const publish = beta.jobs["desktop-publish"]!;
  expect(publish.needs).toEqual(["pick", "desktop"]);
  expect(publish.if).toBe("${{ !cancelled() && needs.desktop.result == 'success' }}");
  // the last job: nothing waits for it
  expect(Object.entries(beta.jobs).filter(([, job]) => [job.needs ?? []].flat().includes("desktop-publish"))).toEqual([]);
});
