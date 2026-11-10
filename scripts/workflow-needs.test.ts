import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { parseWorkflow, root, type Workflow } from "./shell-workflow-rules.ts";

const dir = join(root, ".github/workflows");
const files = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort();

/** The parts a condition's top level joins with `&&`; null when it has an `||` there, or brackets or a quote left open. */
function conjuncts(condition: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let at = 0; at < condition.length; at += 1) {
    const char = condition[at];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && condition.startsWith("||", at)) return null;
    else if (depth === 0 && condition.startsWith("&&", at)) { parts.push(condition.slice(start, at)); start = at + 2; at += 1; }
  }
  return depth === 0 && !quoted ? [...parts, condition.slice(start)].map((part) => part.trim()) : null;
}

/**
 * A job-level `if` that calls a status function replaces GitHub's implied `success()`: the job says
 * for itself when it runs, and may run although a job before it was skipped. Not so when success()
 * is one of the parts the whole condition joins with `&&`: that is the implied rule written out.
 * A negated success(), or one beside an `||`, does decide. A condition this cannot read counts as
 * deciding, so the job behind it is named rather than missed.
 */
function decides(condition: unknown): boolean {
  const text = String(condition ?? "").trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  if (!/\b(always|cancelled|failure|success)\s*\(/i.test(text)) return false;
  return !(conjuncts(text) ?? []).some((part) => /^success\s*\(\s*\)$/i.test(part));
}

/**
 * The jobs that wait for a job deciding for itself without deciding for themselves. A job whose `if`
 * names no status function runs only when no job its `needs` lead back to failed or was skipped,
 * however far back. Behind a deciding job that is the wrong rule: the deciding job ran and passed
 * although one before it was skipped, and the job after it is skipped all the same.
 */
function skippedBehindDecidingJobs(workflow: Workflow): string[] {
  const needs = (id: string): string[] => [workflow.jobs[id]?.needs ?? []].flat();
  return Object.keys(workflow.jobs).filter((id) => {
    if (decides(workflow.jobs[id]!.if)) return false;
    const seen = new Set<string>();
    // true once a job is reached through one that decides for itself
    const reaches = (from: string, behind: boolean): boolean => needs(from).some((need) => {
      if (behind) return true;
      if (seen.has(need)) return false;
      seen.add(need);
      return reaches(need, decides(workflow.jobs[need]?.if));
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
  // a negated success() decides too: recover runs after the skipped gate, and publish behind it does not
  const recovering = (recover: string) => workflowOf({ gate: { if: "github.event_name != 'pull_request'" }, recover: { needs: "gate", if: recover }, publish: { needs: "recover" } });
  expect(skippedBehindDecidingJobs(recovering("!success()"))).toEqual(["publish"]);
  expect(skippedBehindDecidingJobs(recovering("${{ !success() && inputs.tag != '' }}"))).toEqual(["publish"]);
  expect(skippedBehindDecidingJobs(recovering("success() || failure()"))).toEqual(["publish"]);
  expect(skippedBehindDecidingJobs(recovering("(success() || inputs.force) && inputs.tag != ''"))).toEqual(["publish"]);
  expect(skippedBehindDecidingJobs(recovering("success() && inputs.tag != '||'"))).toEqual([]);
  expect(skippedBehindDecidingJobs(recovering("contains(needs.gate.result, 'success') && success()"))).toEqual([]);
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
