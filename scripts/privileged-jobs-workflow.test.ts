import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_HOSTED_LABELS, parseWorkflow, root, topLevelTerms, unreadWorkflowFiles, workflowFileProblems, type Job, type Step } from "./shell-workflow-rules.ts";

const SECRET = /(?<![\w.-])secrets\b(?!\s*\.\s*GITHUB_TOKEN\b)(?:\s*\.\s*(?:\w+|\*)|\s*\[[^\]]*\])?/giu;
/**
 * The actions a privileged job, or any job of a whole-run run, may use, each at the exact reference reviewed, and whether
 * it fetches an artifact (a privileged job that uses one makes its run whole-run).
 */
const REVIEWED_ACTIONS: Record<string, { fetchesArtifact: boolean }> = {
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1": { fetchesArtifact: false },
  "./.github/actions/setup-ci": { fetchesArtifact: false },
  "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9": { fetchesArtifact: false },
  "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9": { fetchesArtifact: false },
  "actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9": { fetchesArtifact: false },
  "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346": { fetchesArtifact: true },
  "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333": { fetchesArtifact: true },
  "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8": { fetchesArtifact: false },
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6": { fetchesArtifact: false },
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1": { fetchesArtifact: false },
};
const reviewed = (uses: string): boolean => Object.hasOwn(REVIEWED_ACTIONS, uses);
/** The actions setup-ci's own steps may use, each at the exact reference reviewed. */
const SETUP_CI_ACTIONS = [
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
  "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
];
// the whole value is one expression with the reviewed prefix: no second `${{ }}` and no text around it
const LABEL_FORM = /^\$\{\{ inputs\.hosted_only && '([^']+)' \|\| (?:(?!\$\{\{|\}\}).)+ \}\}$/s;
const NO_CACHE_FORM = /^\$\{\{ inputs\.hosted_only && 'none' \|\| (?:(?!\$\{\{|\}\}).)+ \}\}$/s;
const MAC_PULL_REQUEST = "${{ fromJSON(matrix.os == 'macos-15' && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && vars.CI_MAC_LABELS || toJSON(matrix.os)) }}";
const NOT_FOR_PULL_REQUESTS = [/^github\.event_name != 'pull_request'$/, /^startsWith\(github\.ref, 'refs\/tags\/[^']*'\)$/];

type Permissions = Record<string, string> | "read-all" | "write-all";
type Matrix = Record<string, unknown> & { include?: Record<string, unknown>[] };
type AnyStep = Omit<Step, "with"> & { with?: Record<string, unknown> };
type AnyJob = Omit<Job, "permissions" | "steps"> & { permissions?: Permissions; strategy?: { matrix?: Matrix | string }; secrets?: "inherit" | Record<string, string>; with?: Record<string, unknown>; steps?: AnyStep[] };
type AnyWorkflow = { name?: string; on: unknown; env?: Record<string, string>; permissions?: Permissions; jobs: Record<string, AnyJob> };
type Workflows = Record<string, AnyWorkflow>;

const events = (on: unknown): Record<string, { inputs?: Record<string, { type?: string; default?: unknown }> } | null> =>
  (typeof on === "string" ? { [on]: null } : Array.isArray(on) ? Object.fromEntries(on.map((event: string) => [event, null])) : (on as Record<string, null>));
const calledFile = (job: AnyJob): string | undefined => /^\.\/\.github\/workflows\/(.+\.yml)$/.exec(job.uses ?? "")?.[1];
/**
 * An action's identity as GitHub splits it: the path before `@` split on `/` and `\\`, empty and `.` pieces dropped,
 * without regard to case (actions/runner's WorkflowTemplateConverter). The reviewed lists stay the exact strings, so any
 * other spelling is still refused in a covered run once the run is found.
 */
const action = (uses: string): string => {
  const path = uses.trim().replace(/@.*/, "");
  const pieces = path.split(/[\\/]/).filter((piece) => piece !== "" && piece !== ".").map((piece) => piece.toLowerCase());
  return `${path.startsWith("./") ? "./" : ""}${pieces.join("/")}`;
};
const actionRepo = (uses: string): string => action(uses).split("/").slice(0, 2).join("/");
const PAGES_ACTIONS = ["actions/deploy-pages", "actions/upload-pages-artifact"];
/** The actions that fetch an artifact, by the identity GitHub resolves, so another spelling of one is still found (and then refused as unreviewed). */
const FETCHING = Object.entries(REVIEWED_ACTIONS).filter(([, { fetchesArtifact }]) => fetchesArtifact).map(([uses]) => actionRepo(uses));
/** The write scopes a permissions value grants: anything but an exact read-only form (`read-all`, `{}`, a scope's `read` or `none`) counts as write, so `Write`, `WRITE-ALL`, a typo or an expression do. */
const writes = (permissions: Permissions): string[] => {
  const value: unknown = permissions;
  if (value === "read-all") return [];
  if (value === "write-all") return ["write-all"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [`permissions ${JSON.stringify(value)} (counted as write)`];
  return Object.entries(value)
    .filter(([, access]) => access !== "read" && access !== "none")
    .map(([scope, access]) => (access === "write" ? `${scope}: write` : `${scope}: ${JSON.stringify(access)} (counted as write)`));
};

/**
 * The write scopes `job`'s token can hold: its own permissions, else its workflow's. With neither, the repository's
 * default for a run of the workflow itself (a setting outside the repository, so counted as write), and each caller's
 * for a call (a called workflow's token is capped by its caller's, and inherits it when the workflow sets none).
 */
function writeScopes(workflows: Workflows, file: string, job: AnyJob): string[] {
  const workflow = workflows[file]!;
  const own = job.permissions ?? workflow.permissions;
  if (own !== undefined) return writes(own);
  const scopes = new Set<string>();
  if (Object.keys(events(workflow.on)).some((event) => event !== "workflow_call")) scopes.add("default permissions (counted as write)");
  for (const [callerFile, caller] of Object.entries(workflows)) {
    for (const callerJob of Object.values(caller.jobs).filter((candidate) => calledFile(candidate) === file)) {
      for (const scope of writeScopes(workflows, callerFile, callerJob)) scopes.add(scope);
    }
  }
  return [...scopes];
}

/**
 * The secrets-context references `value` makes where GitHub evaluates expressions: in a string with `${{`, everything from
 * its first `${{` to its last `}}` (a `run:` script's included), and a whole brace-free `if:` value, which is an
 * expression. The span is greedy so that a `}}` inside a quoted string (`${{ format('}}', secrets.X) }}`) cannot end it
 * early; prose between two expressions of one value then counts too, which errs on the safe side. A string without `${{`
 * (a step's name) is prose, not a reference.
 */
function secretReferences(value: unknown, key = ""): string[] {
  if (typeof value === "string") {
    const start = value.indexOf("${{");
    const end = value.lastIndexOf("}}");
    const span = start >= 0 ? value.slice(start + 3, end > start ? end : value.length) : key === "if" ? value : "";
    // JavaScript and GitHub may fold a character outside ASCII differently (U+017F for s): such an expression counts as one
    const folded = /[^\x00-\x7f]/.test(span) ? ["an expression with a character outside ASCII"] : [];
    return [...[...span.matchAll(SECRET)].map((match) => match[0].replace(/\s+/g, "")), ...folded];
  }
  if (Array.isArray(value)) return value.flatMap((entry) => secretReferences(entry));
  // a mapping's keys are scanned as well as its values: GitHub evaluates an expression in a key of `env`, say
  if (typeof value === "object" && value !== null) return Object.entries(value).flatMap(([name, entry]) => [...secretReferences(name), ...secretReferences(entry, name)]);
  return [];
}

function privileges(workflows: Workflows, file: string, job: AnyJob): string[] {
  const reasons = writeScopes(workflows, file, job);
  if (job.environment !== undefined) reasons.push("environment");
  return [...reasons, ...new Set([...secretReferences(workflows[file]!.env ?? {}), ...secretReferences(job)])];
}

/**
 * The values `matrix.<axis>` can take. GitHub matches the axis's name case-insensitively in the matrix and in every
 * include entry (an `OS` entry fills the `os` axis), and exclude never narrows what this lists. Null when the matrix can
 * give anything else: the matrix, an axis or include from an expression, an include entry without the axis where the
 * matrix has none, `include`/`exclude` in another case, or two keys of one mapping that differ only in case.
 */
function matrixValues(matrix: unknown, axis: string): unknown[] | null {
  const mapping = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const twins = (value: Record<string, unknown>): boolean => new Set(Object.keys(value).map((key) => key.toLowerCase())).size !== Object.keys(value).length;
  const same = (key: string): boolean => key.toLowerCase() === axis.toLowerCase();
  const outsideAscii = (value: Record<string, unknown>): boolean => Object.keys(value).some((key) => /[^\x00-\x7f]/.test(key));
  if (!mapping(matrix) || twins(matrix) || outsideAscii(matrix)) return null;
  if (Object.keys(matrix).some((key) => ["include", "exclude"].includes(key.toLowerCase()) && key !== key.toLowerCase())) return null;
  const include = matrix.include ?? [];
  if (!Array.isArray(include) || !include.every((entry) => mapping(entry) && !outsideAscii(entry))) return null;
  const bases = Object.entries(matrix).filter(([key]) => key !== "include" && key !== "exclude" && same(key)).map(([, values]) => values);
  if (!bases.every((values) => Array.isArray(values))) return null;
  // an include entry without the axis adds a combination of its own when the matrix has no such axis to merge into
  if (bases.length === 0 && include.some((entry) => !Object.keys(entry).some(same))) return null;
  return [...(bases as unknown[][]).flat(), ...include.flatMap((entry) => Object.entries(entry).filter(([key]) => same(key)).map(([, value]) => value))];
}

function hostedAxis(job: AnyJob, axis: string): boolean {
  const values = matrixValues(job.strategy?.matrix, axis);
  return values !== null && values.length > 0 && values.every((value) => typeof value === "string" && GITHUB_HOSTED_LABELS.includes(value));
}

function hostedLiteral(job: AnyJob): boolean {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return false;
  if (GITHUB_HOSTED_LABELS.includes(runsOn)) return true;
  const axis = /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(runsOn)?.[1];
  return axis !== undefined && hostedAxis(job, axis);
}

function privilegeProblems(workflows: Workflows): string[] {
  return Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs).flatMap(([id, job]) => {
      if (job.uses !== undefined) {
        const callee = calledFile(job);
        return callee !== undefined && workflows[callee] !== undefined ? [] : [`${file} ${id}: calls ${job.uses}, which this test cannot read: only a workflow in ./.github/workflows/<name>.yml of this repository`];
      }
      if (job["runs-on"] === undefined || hostedLiteral(job)) return [];
      const reasons = privileges(workflows, file, job);
      return reasons.length === 0 ? [] : [`${file} ${id}: runs-on ${JSON.stringify(job["runs-on"])} with ${reasons.join(", ")}`];
    }),
  );
}

function labelsOf(job: AnyJob): string[] {
  const runsOn = job["runs-on"];
  if (typeof runsOn !== "string") return [];
  if (!runsOn.includes("${{")) return [runsOn];
  const prefixed = LABEL_FORM.exec(runsOn);
  if (prefixed !== null) return [prefixed[1]!];
  const axis = runsOn === MAC_PULL_REQUEST ? "os" : /^\$\{\{\s*matrix\.([\w-]+)\s*\}\}$/.exec(runsOn)?.[1];
  return ((axis === undefined ? null : matrixValues(job.strategy?.matrix, axis)) ?? []).filter((value): value is string => typeof value === "string");
}

/** GitHub reads many keys and contexts without regard to case; these tests do not. */
const READ_KEYS = [
  "on", "jobs", "permissions", "actions", "attestations", "checks", "contents", "deployments", "discussions", "id-token", "issues", "models", "packages",
  "pages", "pull-requests", "repository-projects", "security-events", "statuses", "runs-on", "environment", "secrets", "uses", "with", "env", "if",
  "steps", "strategy", "matrix", "include", "exclude", "needs", "name", "run", "container", "services", "cache", "no-cache", "package-manager-cache",
  "hosted_only", "inputs", "outputs", "runs", "default", "type", "workflow_call", "id",
];

const READ_INPUTS = ["cache", "no-cache", "package-manager-cache", "hosted_only", "artifact-ids", "run-id", "github-token", "repository"];

/**
 * A map of the user's own names (a job id, an environment variable, an output, an input or secret definition, a
 * service, a matrix axis) is decided by its full place in the file, never by its parent's name alone: a job whose id
 * is `env` is still a job.
 */
function readKeysAt(path: string[]): string[] {
  const shape = path.map((part) => (/^\d+$/.test(part) ? "#" : part));
  const at = (...pattern: string[]): boolean => pattern.length === shape.length && pattern.every((part, index) => part === "*" || part === shape[index]);
  if (at("jobs", "*", "with") || at("jobs", "*", "steps", "#", "with") || at("runs", "steps", "#", "with")) return READ_INPUTS;
  if (at("jobs", "*", "strategy", "matrix")) return ["include", "exclude"];
  const names = [
    ["jobs"], ["env"], ["jobs", "*", "env"], ["jobs", "*", "steps", "#", "env"], ["jobs", "*", "outputs"], ["jobs", "*", "secrets"], ["jobs", "*", "services"],
    ["jobs", "*", "services", "*", "env"], ["jobs", "*", "container", "env"], ["on", "*", "inputs"], ["on", "*", "secrets"], ["on", "*", "outputs"],
    ["jobs", "*", "strategy", "matrix", "include", "#"], ["jobs", "*", "strategy", "matrix", "exclude", "#"], ["inputs"], ["outputs"], ["runs", "steps", "#", "env"],
  ];
  return names.some((pattern) => at(...pattern)) ? [] : READ_KEYS;
}

/**
 * Keys these tests would misread, whatever GitHub makes of them: a key they read written in another case (`Runs-On`,
 * `Permissions`, `ID-Token`, an input `Hosted_Only`), and two sibling keys that differ only in case (job ids included).
 */
const matrixAxes = new Map<string, string[]>();
function keyProblems(file: string, value: unknown, path: string[] = []): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => keyProblems(file, entry, [...path, String(index)]));
  if (typeof value !== "object" || value === null) return [];
  const keys = Object.keys(value);
  const exact = readKeysAt(path);
  const where = (key: string): string => `${file} ${[...path, key].join(".")}`;
  const problems: string[] = [];
  keys.forEach((key, index) => {
    if (/[^\x00-\x7f]/.test(key)) problems.push(`${where(key)}: a key with a character outside ASCII, which GitHub and these tests may fold differently`);
    const read = exact.find((candidate) => candidate !== key && candidate.toLowerCase() === key.toLowerCase());
    if (read !== undefined) problems.push(`${where(key)}: ${read} written in another case, which these tests read exactly`);
    const twin = keys.slice(0, index).find((other) => other.toLowerCase() === key.toLowerCase());
    if (twin !== undefined) problems.push(`${where(key)}: differs from its sibling ${twin} only in case`);
  });
  // an include entry's key that names a matrix axis in another case fills that axis on GitHub: name it
  if (path.length === 6 && path[0] === "jobs" && path[2] === "strategy" && path[3] === "matrix" && path[4] === "include") {
    for (const key of keys) {
      const axis = matrixAxes.get(`${file} ${path.slice(0, 4).join(".")}`)?.find((candidate) => candidate !== key && candidate.toLowerCase() === key.toLowerCase());
      if (axis !== undefined) problems.push(`${where(key)}: names the matrix axis ${axis} in another case, which GitHub reads as that axis`);
    }
  }
  if (path.length === 4 && path[0] === "jobs" && path[2] === "strategy" && path[3] === "matrix") matrixAxes.set(`${file} ${path.join(".")}`, keys.filter((key) => key !== "include" && key !== "exclude"));
  return [...problems, ...Object.entries(value).flatMap(([key, entry]) => keyProblems(file, entry, [...path, key]))];
}

function runRoots(workflows: Workflows, file: string): string[] {
  const roots = Object.keys(events(workflows[file]!.on)).some((event) => event !== "workflow_call") ? [file] : [];
  for (const [callerFile, caller] of Object.entries(workflows)) {
    if (Object.values(caller.jobs).some((job) => calledFile(job) === file)) roots.push(...runRoots(workflows, callerFile));
  }
  return [...new Set(roots)];
}

function runJobs(workflows: Workflows, root: string): { file: string; id: string; job: AnyJob; hostedOnly: boolean }[] {
  const jobs: { file: string; id: string; job: AnyJob; hostedOnly: boolean }[] = [];
  const visit = (file: string, hostedOnly: boolean): void => {
    for (const [id, job] of Object.entries(workflows[file]!.jobs)) {
      const callee = calledFile(job);
      if (callee !== undefined && workflows[callee] !== undefined) visit(callee, job.with?.["hosted_only"] === true);
      else jobs.push({ file, id, job, hostedOnly });
    }
  };
  visit(root, false);
  return jobs;
}

/**
 * Whether a condition mixes an expression with text: after stripping one whole-value `${{ }}`, anything still holding `${{`
 * or `}}` is a string for GitHub (`${{ a }} && !inputs.hosted_only`), and a non-empty string is always true.
 */
const mixedCondition = (condition: string): boolean => /\$\{\{|\}\}/.test(condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1"));

const MIXED = "mixes an expression with text, which GitHub reads as a string, always true";

/** A step's inputs by name as the runner reads them, without regard to case; null when two of them differ only in case. */
function stepInputs(step: AnyStep): Record<string, unknown> | null {
  const entries = Object.entries(step.with ?? {}).map(([key, value]): [string, unknown] => [key.toLowerCase(), value]);
  return new Set(entries.map(([key]) => key)).size === entries.length ? Object.fromEntries(entries) : null;
}

/** Why the conditions of `job` and its steps are not each one expression or plain text: a mixed `if` is always true. */
function conditionProblems(job: AnyJob): string[] {
  return [
    ...(job.if !== undefined && mixedCondition(job.if) ? [`job if ${JSON.stringify(job.if)} ${MIXED}`] : []),
    ...(job.steps ?? []).flatMap((step, index) => (step.if !== undefined && mixedCondition(step.if) ? [`step ${step.name ?? step.id ?? step.uses ?? index} if ${JSON.stringify(step.if)} ${MIXED}`] : [])),
  ];
}

function cacheStepProblems(step: AnyStep, hostedOnly: boolean): string[] {
  const name = action(step.uses!);
  const inputs = stepInputs(step);
  if (inputs === null) return [`${name} has inputs that differ only in case`];
  const cache = inputs["cache"];
  if (name === "./.github/actions/setup-ci") {
    return cache === "none" || (hostedOnly && typeof cache === "string" && NO_CACHE_FORM.test(cache)) ? [] : [`setup-ci cache ${JSON.stringify(cache ?? "save (default)")} is neither none nor the hosted_only form under a call that passes hosted_only: true`];
  }
  if (name === "actions/cache" || name === "actions/cache/restore") {
    if (mixedCondition(step.if ?? "")) return [];
    return hostedOnly && topLevelTerms(step.if ?? "").includes("!inputs.hosted_only") ? [] : [`${name} if ${JSON.stringify(step.if ?? null)} has no top-level && !inputs.hosted_only term under a call that passes hosted_only: true`];
  }
  if (name === "oven-sh/setup-bun") return inputs["no-cache"] === true ? [] : ["oven-sh/setup-bun without no-cache: true"];
  if (name === "actions/setup-node") return inputs["package-manager-cache"] === false && cache === undefined ? [] : ["actions/setup-node without package-manager-cache: false, or with a cache input"];
  return cache === undefined ? [] : [`${name} has a cache input`];
}

/**
 * A job that calls another workflow has no steps and is not passed to conditionProblems here or in runJobs: its own
 * `if` is held by the repository-wide test "no if in any workflow or in setup-ci mixes an expression with text".
 */
function privilegedJobProblems(workflows: Workflows): string[] {
  return Object.entries(workflows).flatMap(([file, workflow]) =>
    Object.entries(workflow.jobs)
      .filter(([, job]) => job.uses === undefined && privileges(workflows, file, job).length > 0)
      .flatMap(([id, job]) => [
        ...conditionProblems(job).map((problem) => `${file} ${id}: ${problem}`),
        ...(job.steps ?? []).filter((step) => step.uses !== undefined).flatMap((step) => [
          ...(reviewed(step.uses!) ? [] : [`${file} ${id}: uses ${step.uses}, which is not a reviewed action reference`]),
          ...cacheStepProblems(step, false).map((problem) => `${file} ${id}: ${problem}`),
        ]),
      ]),
  );
}

function pullRequestProblems(workflows: Workflows, root: string): string[] {
  if (!Object.keys(events(workflows[root]!.on)).some((event) => event.toLowerCase() === "pull_request")) return [];
  return runJobs(workflows, root)
    .filter(({ file, job }) => privileges(workflows, file, job).length > 0)
    .filter(({ job }) => job.if === undefined || mixedCondition(job.if) || !topLevelTerms(job.if).some((term) => NOT_FOR_PULL_REQUESTS.some((form) => form.test(term))))
    .map(({ file, id }) => `${file} ${id}`);
}

function runProblems(workflows: Workflows, root: string): string[] {
  const problems = new Set<string>();
  for (const { file, id, job, hostedOnly } of runJobs(workflows, root)) {
    const where = `${root}: ${file} ${id}`;
    const runsOn = job["runs-on"];
    const prefixed = typeof runsOn === "string" ? LABEL_FORM.exec(runsOn) : null;
    if (runsOn === MAC_PULL_REQUEST && hostedAxis(job, "os")) {
      for (const privileged of pullRequestProblems(workflows, root)) problems.add(`${where}: runs-on the pull-request Mac form in a run where a pull request can run the privileged job ${privileged}`);
    } else if (!hostedLiteral(job) && !(hostedOnly && prefixed !== null && GITHUB_HOSTED_LABELS.includes(prefixed[1]!))) {
      problems.add(`${where}: runs-on ${JSON.stringify(runsOn)} is neither a listed hosted label nor the hosted_only form under a call that passes hosted_only: true`);
    }
    for (const problem of conditionProblems(job)) problems.add(`${where}: ${problem}`);
    for (const step of job.steps ?? []) {
      if (step.uses === undefined) continue;
      if (!reviewed(step.uses)) problems.add(`${where}: uses ${step.uses}, which is not a reviewed action reference`);
      for (const problem of cacheStepProblems(step, hostedOnly)) problems.add(`${where}: ${problem}`);
      // a whole-run run takes its own artifacts: a download by id, or from another run or repository, is a form it does not use
      if (action(step.uses) === "actions/download-artifact") {
        for (const input of ["artifact-ids", "run-id", "github-token", "repository"]) {
          if (stepInputs(step)?.[input] !== undefined) problems.add(`${where}: actions/download-artifact with ${input}, a form these runs do not use`);
        }
      }
    }
  }
  return [...problems];
}

/** setup-ci's cache steps that can run under `cache: none`: each needs `inputs.cache == 'save'` or `'restore'` as a top-level `&&` term of a condition that is one expression. */
function setupCiCacheProblems(steps: AnyStep[]): string[] {
  return steps
    .filter((step) => step.uses !== undefined && action(step.uses).startsWith("actions/cache"))
    .filter((step) => mixedCondition(step.if ?? "") || !topLevelTerms(step.if ?? "").some((term) => term === "inputs.cache == 'save'" || term === "inputs.cache == 'restore'"))
    .map((step) =>
      mixedCondition(step.if ?? "")
        ? `setup-ci ${step.name ?? step.uses}: if ${JSON.stringify(step.if)} ${MIXED}`
        : `setup-ci ${step.name ?? step.uses}: if ${JSON.stringify(step.if ?? null)} has no top-level && inputs.cache == 'save' or 'restore' term, so it can run under cache: none`,
    );
}

const writesPages = (scopes: string[]): boolean =>
  scopes.some((scope) => scope.toLowerCase().startsWith("pages:") || scope === "write-all" || scope.startsWith("default permissions") || scope.startsWith("permissions "));

/**
 * The workflows whose runs contain a job that deploys Pages, found by any of four signs, so none rests on another: a job
 * that can write Pages (a deployment through Pages' own permission needs it, however it deploys), a job in the
 * `github-pages` environment, a job that holds id-token write together with a secret (a deploy with a supplied token),
 * and a job that uses deploy-pages or upload-pages-artifact (recognised by owner/repo, whatever path follows).
 */
function pagesRoots(workflows: Workflows): string[] {
  const environment = (job: AnyJob): string | undefined => (typeof job.environment === "object" && job.environment !== null ? job.environment.name : job.environment);
  const deploys = (file: string, job: AnyJob): boolean => {
    const scopes = writeScopes(workflows, file, job);
    const secret = secretReferences(workflows[file]!.env ?? {}).length + secretReferences(job).length > 0;
    const pagesEnvironment = environment(job);
    return (
      writesPages(scopes) ||
      (typeof pagesEnvironment === "string" && pagesEnvironment.toLowerCase() === "github-pages") ||
      (scopes.some((scope) => scope.toLowerCase().startsWith("id-token:")) && secret) ||
      (job.steps ?? []).some((step) => step.uses !== undefined && PAGES_ACTIONS.includes(actionRepo(step.uses)))
    );
  };
  return [...new Set(Object.entries(workflows).flatMap(([file, workflow]) => (Object.values(workflow.jobs).some((job) => deploys(file, job)) ? runRoots(workflows, file) : [])))].sort();
}

function consumerRoots(workflows: Workflows): string[] {
  const consumes = (file: string, job: AnyJob): boolean =>
    job.uses === undefined && privileges(workflows, file, job).length > 0 && (job.steps ?? []).some((step) => step.uses !== undefined && FETCHING.includes(actionRepo(step.uses)));
  return [...new Set(Object.entries(workflows).flatMap(([file, workflow]) => (Object.values(workflow.jobs).some((job) => consumes(file, job)) ? runRoots(workflows, file) : [])))].sort();
}

const wholeRunRoots = (workflows: Workflows): string[] => [...new Set([...pagesRoots(workflows), ...consumerRoots(workflows)])].sort();

/** The problems of every whole-run run; each of `deploying` must still deploy Pages, or that check would pass on nothing. */
function wholeRunProblems(workflows: Workflows, deploying: string[] = []): string[] {
  const missing = deploying.filter((file) => !Object.values(workflows[file]?.jobs ?? {}).some((job) => (job.steps ?? []).some((step) => step.uses !== undefined && actionRepo(step.uses) === "actions/deploy-pages")));
  return [
    ...missing.map((file) => `${file}: has no job that deploys Pages (actions/deploy-pages), so no run of it is checked as a whole`),
    ...wholeRunRoots(workflows).flatMap((runRoot) => runProblems(workflows, runRoot)),
  ];
}

function coveredLabels(workflows: Workflows): string[] {
  const privileged = Object.entries(workflows).flatMap(([file, workflow]) => Object.values(workflow.jobs).filter((job) => job.uses === undefined && privileges(workflows, file, job).length > 0));
  const runJobsCovered = wholeRunRoots(workflows).flatMap((runRoot) => runJobs(workflows, runRoot).map(({ job }) => job));
  return [...new Set([...privileged, ...runJobsCovered].flatMap(labelsOf))].sort();
}

const dir = join(root, ".github/workflows");
const repository: Workflows = Object.fromEntries(
  readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => [name, parseWorkflow(join(dir, name)) as unknown as AnyWorkflow]),
);
const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const setupCi = Bun.YAML.parse(readFileSync(join(root, ".github/actions/setup-ci/action.yml"), "utf8")) as { inputs: { cache: { default: string } }; runs: { steps: AnyStep[] } };

const LIGHT = "${{ github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04' || fromJSON(github.ref == 'refs/heads/main' && vars.CI_MAIN_SELF_HOSTED_LABELS || vars.CI_LIGHT_LABELS || vars.CI_SELF_HOSTED_LABELS || '[\"self-hosted\",\"self-hosted-ovis\"]') }}";
const VARIABLE = "${{ vars.CI_SELF_HOSTED_LABELS && fromJSON(vars.CI_SELF_HOSTED_LABELS) || 'ubuntu-24.04' }}";
const HOSTED_ONLY = "${{ inputs.hosted_only && 'ubuntu-24.04' || fromJSON(vars.CI_SELF_HOSTED_LABELS) }}";
const DEPLOY: AnyJob = { "runs-on": "ubuntu-24.04", permissions: { pages: "write", "id-token": "write" }, environment: "github-pages", steps: [{ uses: "actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346" }] };
const one = (job: AnyJob, permissions: Permissions | null = { contents: "read" }, env?: Record<string, string>): Workflows => ({
  "x.yml": { on: { push: {} }, ...(permissions && { permissions }), ...(env && { env }), jobs: { job } },
});
const called = (callerJob: AnyJob, calledJob: AnyJob): Workflows => ({
  "caller.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { call: { uses: "./.github/workflows/called.yml", ...callerJob } } },
  "called.yml": { on: { workflow_call: {} }, jobs: { job: calledJob } },
});
const pages = (sibling: AnyJob, call: Record<string, unknown> | undefined, calledJob: AnyJob): Workflows => ({
  "site.yml": { on: { workflow_dispatch: {} }, permissions: { contents: "read" }, jobs: { validate: { uses: "./.github/workflows/checks.yml", ...(call && { with: call }) }, sibling, deploy: DEPLOY } },
  "checks.yml": { on: { push: {}, workflow_call: { inputs: { hosted_only: { type: "boolean", default: false } } } }, permissions: { contents: "read" }, jobs: { check: calledJob } },
});
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const CACHE = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const HOSTED_JOB: AnyJob = { "runs-on": "ubuntu-24.04", steps: [{ uses: CHECKOUT }] };
const cacheIf = (condition: string): AnyJob => ({ "runs-on": HOSTED_ONLY, steps: [{ uses: CACHE, if: condition, with: { path: "x", key: "k" } }] });

describe("jobs that hold a write permission, an environment or a secret", () => {
  test("every workflow and action file GitHub loads ends in .yml, so these tests read it, and none is a symlink", () => {
    expect(workflowFileProblems()).toEqual([]);
    expect(unreadWorkflowFiles([
      ".github/workflows/safe.yml", ".github/workflows/unsafe.yaml", ".github/workflows/Upper.YML", ".github/workflows/README.md", ".github/workflows/old/x.yaml",
      ".github/actions/a/action.yml", ".github/actions/b/action.yaml", ".github/actions/c/Action.yml", ".github/actions/a/script.yaml",
    ])).toEqual([".github/workflows/unsafe.yaml", ".github/workflows/Upper.YML", ".github/actions/b/action.yaml", ".github/actions/c/Action.yml"]);
  });

  test("no workflow or action file writes a key these tests read in another case, or two keys that differ only in case", () => {
    const files = [...readdirSync(dir).filter((name) => name.endsWith(".yml")).map((name) => `.github/workflows/${name}`), ".github/actions/setup-ci/action.yml"];
    expect(files.flatMap((file) => keyProblems(file, Bun.YAML.parse(readFileSync(join(root, file), "utf8"))))).toEqual([]);
  });

  test("the discovery reads a real tree: a symlinked workflow, action metadata or action folder is refused, not followed", () => {
    const base = mkdtempSync(join(tmpdir(), "privileged-jobs-"));
    scratch.push(base);
    mkdirSync(join(base, ".github/workflows/old"), { recursive: true });
    mkdirSync(join(base, ".github/actions/real"), { recursive: true });
    mkdirSync(join(base, "elsewhere/action"), { recursive: true });
    for (const file of [".github/workflows/safe.yml", ".github/workflows/unsafe.yaml", ".github/workflows/old/x.yaml", ".github/actions/real/action.yml", "elsewhere/action.yaml", "elsewhere/action/action.yml"]) {
      writeFileSync(join(base, file), "name: x\n");
    }
    symlinkSync(join(base, "elsewhere/action.yaml"), join(base, ".github/workflows/linked.yml"));
    symlinkSync(join(base, "elsewhere/action.yaml"), join(base, ".github/actions/real/action.yaml"));
    symlinkSync(join(base, "elsewhere/action"), join(base, ".github/actions/linked"));
    expect(workflowFileProblems(base)).toEqual([
      ".github/actions/linked: a symlink, which the workflow tests do not follow",
      ".github/actions/real/action.yaml: a symlink, which the workflow tests do not follow",
      ".github/workflows/linked.yml: a symlink, which the workflow tests do not follow",
      ".github/workflows/unsafe.yaml: GitHub loads it, but it does not end in .yml, so the workflow tests would not read it",
    ]);
  });

  test("refuses workflow files or action folders whose names differ only in case: a case-insensitive checkout merges them", () => {
    const base = mkdtempSync(join(tmpdir(), "privileged-jobs-"));
    scratch.push(base);
    mkdirSync(join(base, ".github/workflows"), { recursive: true });
    mkdirSync(join(base, ".github/actions/setup"), { recursive: true });
    mkdirSync(join(base, ".github/actions/Setup"), { recursive: true });
    for (const file of [".github/workflows/pages.yml", ".github/workflows/Pages.yml", ".github/actions/setup/action.yml", ".github/actions/Setup/action.yml"]) writeFileSync(join(base, file), "name: x\n");
    expect(workflowFileProblems(base)).toEqual([
      ".github/actions/setup/action.yml: differs from .github/actions/Setup/action.yml only in case, which a case-insensitive checkout merges",
      ".github/actions/setup: differs from .github/actions/Setup only in case, which a case-insensitive checkout merges",
      ".github/workflows/pages.yml: differs from .github/workflows/Pages.yml only in case, which a case-insensitive checkout merges",
    ]);
  });

  test("every one in .github/workflows names a GitHub-hosted label literally", () => {
    expect(privilegeProblems(repository)).toEqual([]);
  });

  test("no if in any workflow or in setup-ci mixes an expression with text", () => {
    const conditions = [...Object.values(repository).flatMap((workflow) => Object.values(workflow.jobs).flatMap((job) => [job.if, ...(job.steps ?? []).map((step) => step.if)])), ...setupCi.runs.steps.map((step) => step.if)].filter((condition): condition is string => typeof condition === "string");
    expect(conditions.length).toBeGreaterThan(100);
    expect(conditions.filter(mixedCondition)).toEqual([]);
  });

  test("every one uses only reviewed actions at their exact references, and restores no Actions cache", () => {
    expect(privilegedJobProblems(repository)).toEqual([]);
  });

  test("every label on the hosted-label list is one a covered job names", () => {
    // only this direction: a label a job names that is not on the list is refused by the rule itself
    expect(GITHUB_HOSTED_LABELS.filter((label) => !coveredLabels(repository).includes(label))).toEqual([]);
  });

  test("the Pages deploy, the release's publish job and the Mac app's gate count as privileged", () => {
    expect(privileges(repository, "pages.yml", repository["pages.yml"]!.jobs.deploy!)).toEqual(["pages: write", "id-token: write", "environment"]);
    expect(privileges(repository, "release.yml", repository["release.yml"]!.jobs.publish!)).toEqual(["contents: write"]);
    // Release hands the Mac app workflow every secret; its gate reads whether the signing ones are set
    expect(repository["release.yml"]!.jobs["mac-dmg"]!).toMatchObject({ secrets: "inherit" });
    const gate = privileges(repository, "mac-dmg.yml", repository["mac-dmg.yml"]!.jobs.gate!);
    expect(gate).toEqual(["secrets.MAC_DEVELOPER_ID_P12", "secrets.MAC_DEVELOPER_ID_P12_PASSWORD", "secrets.MAC_NOTARY_KEY_P8", "secrets.MAC_NOTARY_KEY_ID", "secrets.MAC_NOTARY_ISSUER"]);
  });

  const cases: [string, Workflows, number][] = [
    ["refuses the light runner expression for a job that deploys Pages", one({ "runs-on": LIGHT, permissions: { contents: "read", pages: "write", "id-token": "write" } }), 1],
    ["refuses a runner variable even with a hosted fallback for a write token", one({ "runs-on": VARIABLE, permissions: { contents: "write" } }), 1],
    ["refuses id-token: write alone", one({ "runs-on": VARIABLE, permissions: { "id-token": "write" } }), 1],
    ["refuses write-all", one({ "runs-on": VARIABLE, permissions: "write-all" }), 1],
    ["refuses self-hosted labels for a job with an environment", one({ "runs-on": ["self-hosted", "self-hosted-ovis"], environment: "production" }), 1],
    ["refuses an input for a job with a secret", one({ "runs-on": "${{ inputs.runner }}", steps: [{ run: "x", env: { KEY: "${{ secrets.KEY }}" } }] }), 1],
    ["refuses a job output for a job that only checks a secret is set", one({ "runs-on": "${{ fromJSON(needs.route.outputs.labels) }}", env: { HAS: "${{ secrets.KEY != '' }}" } }), 1],
    ["refuses a secret its workflow's env hands every job", one({ "runs-on": LIGHT }, { contents: "read" }, { KEY: "${{ secrets.KEY }}" }), 1],
    ["refuses a secret read by index", one({ "runs-on": LIGHT, env: { KEY: "${{ secrets['KEY'] }}" } }), 1],
    ["refuses every secret at once", one({ "runs-on": LIGHT, env: { ALL: "${{ toJSON(secrets) }}" } }), 1],
    ["refuses a hosted label inside an expression", one({ "runs-on": "${{ 'ubuntu-24.04' }}", permissions: { contents: "write" } }), 1],
    ["refuses a lookalike label", one({ "runs-on": "ubuntu-self-hosted", permissions: { contents: "write" } }), 1],
    ["refuses a label of a hosted form that is not on the list", one({ "runs-on": "ubuntu-99.99", permissions: { contents: "write" } }), 1],
    ["refuses a matrix one of whose runners is a variable", one({ "runs-on": "${{ matrix.os }}", permissions: { contents: "write" }, strategy: { matrix: { include: [{ os: "ubuntu-24.04" }, { os: "${{ vars.LABELS }}" }] } } }), 1],
    ["refuses a matrix one of whose runners is not on the list", one({ "runs-on": "${{ matrix.os }}", permissions: { contents: "write" }, strategy: { matrix: { os: ["ubuntu-24.04", "windows-9999"] } } }), 1],
    ["refuses a matrix whose axis is an expression", one({ "runs-on": "${{ matrix.os }}", permissions: { contents: "write" }, strategy: { matrix: { os: "${{ fromJSON(vars.OSES) }}" } } }), 1],
    ["refuses a job with no permissions in a workflow with none: the repository default counts as write", one({ "runs-on": LIGHT }, null), 1],
    ["refuses a job that inherits its workflow's write token", one({ "runs-on": LIGHT }, { contents: "write" }), 1],
    ["refuses a called job that inherits its caller's write token", called({ permissions: { contents: "write" } }, { "runs-on": VARIABLE }), 1],
    ["refuses a called job that reads a secret its caller passes with secrets: inherit", called({ secrets: "inherit" }, { "runs-on": VARIABLE, permissions: { contents: "read" }, env: { KEY: "${{ secrets.KEY }}" } }), 1],
    ["refuses secrets.GITHUB_TOKEN with a write permission", one({ "runs-on": LIGHT, permissions: { contents: "write" }, env: { TOKEN: "${{ secrets.GITHUB_TOKEN }}" } }), 1],
    ["allows hosted labels written literally", one({ "runs-on": "ubuntu-24.04-arm", permissions: { contents: "write", "id-token": "write" }, environment: "production", env: { KEY: "${{ secrets.KEY }}" } }), 0],
    ["allows a matrix of hosted labels only", one({ "runs-on": "${{ matrix.os }}", env: { KEY: "${{ secrets.KEY }}" }, strategy: { matrix: { os: ["windows-2025"], include: [{ os: "macos-15-intel" }, { os: "ubuntu-24.04" }] } } }), 0],
    ["allows any runner for a read-only job without a secret", one({ "runs-on": LIGHT, permissions: { contents: "read", actions: "read" }, env: { TOKEN: "${{ secrets.GITHUB_TOKEN }}", OUT: "${{ steps.secrets.outputs.x }}" } }), 0],
    ["lets a job's read-only permissions override its workflow's write token", one({ "runs-on": LIGHT, permissions: { contents: "read" } }, { contents: "write" }), 0],
    ["allows any runner for a called job whose caller grants only reads", called({ permissions: { contents: "read" } }, { "runs-on": VARIABLE }), 0],
  ];
  for (const [name, workflows, count] of cases) {
    test(name, () => {
      expect(privilegeProblems(workflows)).toHaveLength(count);
    });
  }

  const WRITE = { contents: "write" };
  const named: [string, Workflows, string[]][] = [
    ["refuses the secrets object filter", one({ "runs-on": LIGHT, env: { T: "${{ join(secrets.*, ',') }}" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets.*`]],
    ["refuses a secret handed to an action's input", one({ "runs-on": LIGHT, steps: [{ uses: "x/y@v1", with: { token: "${{ secrets.T }}" } }] }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets.T`]],
    ["refuses a secret in a job's condition", one({ "runs-on": LIGHT, if: "secrets.T != ''" }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets.T`]],
    ["refuses a called job that reads a secret its caller passes by name", called({ secrets: { T: "${{ secrets.T }}" } }, { "runs-on": VARIABLE, permissions: { contents: "read" }, env: { T: "${{ secrets.T }}" } }), [`called.yml job: runs-on ${JSON.stringify(VARIABLE)} with secrets.T`]],
    ["does not count a step's name that says secrets: prose, not a reference", one({ "runs-on": LIGHT, steps: [{ name: "Check the signing secrets", run: "echo the secrets are set" }] }), []],
    ["refuses a secret a run script reads through an expression", one({ "runs-on": LIGHT, steps: [{ run: 'echo "${{ secrets.T }}"' }] }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets.T`]],
    ["refuses a secret after a quoted }} in the same expression", one({ "runs-on": LIGHT, env: { T: "${{ '}}' && secrets.T }}" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets.T`]],
    ["refuses a secret passed to a function after a quoted }}", one({ "runs-on": LIGHT, env: { T: "${{ format('}}', secrets.X) }}" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets.X`]],
    ["refuses a secret in a step's condition, an expression without braces", one({ "runs-on": LIGHT, steps: [{ if: "secrets.T != ''", run: "true" }] }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets.T`]],
    ["refuses a matrix entry that names the runner axis in another case (GitHub fills os from OS)", one({ "runs-on": "${{ matrix.os }}", permissions: WRITE, strategy: { matrix: { os: ["ubuntu-24.04"], include: [{ OS: "self-hosted" }] } } }), [`x.yml job: runs-on ${JSON.stringify("${{ matrix.os }}")} with contents: write`]],
    ["refuses two matrix axes that differ only in case", one({ "runs-on": "${{ matrix.os }}", permissions: WRITE, strategy: { matrix: { os: ["ubuntu-24.04"], OS: ["ubuntu-24.04"] } } }), [`x.yml job: runs-on ${JSON.stringify("${{ matrix.os }}")} with contents: write`]],
    ["refuses include written in another case", one({ "runs-on": "${{ matrix.os }}", permissions: WRITE, strategy: { matrix: { os: ["ubuntu-24.04"], Include: [{ os: "self-hosted" }] } } as unknown as AnyJob["strategy"] }), [`x.yml job: runs-on ${JSON.stringify("${{ matrix.os }}")} with contents: write`]],
    ["refuses the matrix context in another case: only the exact form is read", one({ "runs-on": "${{ MATRIX.os }}", permissions: WRITE, strategy: { matrix: { os: ["ubuntu-24.04"] } } }), [`x.yml job: runs-on ${JSON.stringify("${{ MATRIX.os }}")} with contents: write`]],
    ["refuses a matrix include key with a character outside ASCII", one({ "runs-on": "${{ matrix.os }}", permissions: WRITE, strategy: { matrix: { os: ["ubuntu-24.04"], include: [{ "o\u017f": "self-hosted" }] } } }), [`x.yml job: runs-on ${JSON.stringify("${{ matrix.os }}")} with contents: write`]],
    ["counts the secrets context spelled with U+017F as a secret reference", one({ "runs-on": LIGHT, env: { T: "${{ \u017fecrets.T }}" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with \u017fecrets.T, an expression with a character outside ASCII`]],
    ["does not count prose outside ASCII outside any expression", one({ "runs-on": LIGHT, env: { NOTE: "caf\u00e9 \u2014 na\u00efve" } }), []],
    ["refuses the secrets context in capitals", one({ "runs-on": LIGHT, env: { T: "${{ SECRETS.T }}" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with SECRETS.T`]],
    ["refuses the secrets context in mixed case by index", one({ "runs-on": LIGHT, env: { T: "${{ Secrets['T'] }}" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with Secrets['T']`]],
    ["refuses every secret through TOJSON", one({ "runs-on": LIGHT, env: { T: "${{ TOJSON(secrets) }}" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets`]],
    ["refuses a secret in an env key", one({ "runs-on": LIGHT, env: { "${{ secrets.T }}": "x" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with secrets.T`]],
    ["counts a permission value in another case as write", one({ "runs-on": LIGHT, permissions: { contents: "Write" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with contents: "Write" (counted as write)`]],
    ["counts a permission value from an expression as write", one({ "runs-on": LIGHT, permissions: { contents: "${{ inputs.access }}" } }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with contents: "\${{ inputs.access }}" (counted as write)`]],
    ["counts WRITE-ALL, or any permissions scalar but read-all, as write", one({ "runs-on": LIGHT, permissions: "WRITE-ALL" as Permissions }), [`x.yml job: runs-on ${JSON.stringify(LIGHT)} with permissions "WRITE-ALL" (counted as write)`]],
    ["refuses a runs-on given as a group mapping", one({ "runs-on": { group: "g", labels: ["ubuntu-24.04"] }, permissions: WRITE }), ['x.yml job: runs-on {"group":"g","labels":["ubuntu-24.04"]} with contents: write']],
    ["refuses a runs-on that YAML reads as a number", one({ "runs-on": 22.04, permissions: WRITE }), ["x.yml job: runs-on 22.04 with contents: write"]],
    ["reads a runner and permissions a YAML merge key supplies, and refuses them", { "x.yml": Bun.YAML.parse("on: push\npermissions: { contents: read }\nx-base: &base\n  runs-on: [self-hosted]\n  permissions: { contents: write }\njobs:\n  job:\n    <<: *base\n    steps: [{ run: 'true' }]\n") as AnyWorkflow }, ['x.yml job: runs-on ["self-hosted"] with contents: write']],
    ["refuses a call to another repository's workflow", one({ uses: "owner/repo/.github/workflows/deploy.yml@main", secrets: "inherit", permissions: WRITE }), ["x.yml job: calls owner/repo/.github/workflows/deploy.yml@main, which this test cannot read: only a workflow in ./.github/workflows/<name>.yml of this repository"]],
    ["refuses a full-path call to a workflow of this repository", one({ uses: "devswha/ovis/.github/workflows/ci.yml@main", permissions: WRITE }), ["x.yml job: calls devswha/ovis/.github/workflows/ci.yml@main, which this test cannot read: only a workflow in ./.github/workflows/<name>.yml of this repository"]],
    ["refuses a call to a .yaml workflow", one({ uses: "./.github/workflows/callee.yaml", secrets: "inherit" }), ["x.yml job: calls ./.github/workflows/callee.yaml, which this test cannot read: only a workflow in ./.github/workflows/<name>.yml of this repository"]],
    ["refuses a call to a workflow that is not there", one({ uses: "./.github/workflows/missing.yml" }), ["x.yml job: calls ./.github/workflows/missing.yml, which this test cannot read: only a workflow in ./.github/workflows/<name>.yml of this repository"]],
  ];
  for (const label of ["Ubuntu-24.04", "UBUNTU-LATEST", "Self-Hosted", "ubuntu\u201124.04", "ubuntu-24.04 ", "ubuntu-24.04\u200b", "ubuntu-\uff12\uff14.04"]) {
    test(`refuses the runner label ${JSON.stringify(label)}: only an exact listed label passes`, () => {
      expect(privilegeProblems(one({ "runs-on": label, permissions: WRITE }))).toEqual([`x.yml job: runs-on ${JSON.stringify(label)} with contents: write`]);
    });
  }

  const keyCases: [string, unknown, string[]][] = [
    ["job ids that differ only in case", { jobs: { build: {}, Build: {} } }, ["x.yml jobs.Build: differs from its sibling build only in case"]],
    ["runs-on in another case", { jobs: { a: { "Runs-On": "ubuntu-24.04" } } }, ["x.yml jobs.a.Runs-On: runs-on written in another case, which these tests read exactly"]],
    ["a permission scope in another case", { permissions: { Contents: "read", "ID-Token": "write" } }, ["x.yml permissions.Contents: contents written in another case, which these tests read exactly", "x.yml permissions.ID-Token: id-token written in another case, which these tests read exactly"]],
    ["permissions, environment, secrets and steps in another case", { jobs: { a: { Permissions: {}, Environment: "e", Secrets: "inherit", Steps: [] } } }, ["x.yml jobs.a.Permissions: permissions written in another case, which these tests read exactly", "x.yml jobs.a.Environment: environment written in another case, which these tests read exactly", "x.yml jobs.a.Secrets: secrets written in another case, which these tests read exactly", "x.yml jobs.a.Steps: steps written in another case, which these tests read exactly"]],
    ["a call's input in another case", { jobs: { v: { uses: "./.github/workflows/ci.yml", with: { Hosted_Only: true } } } }, ["x.yml jobs.v.with.Hosted_Only: hosted_only written in another case, which these tests read exactly"]],
    ["an environment variable's own name, but no twins there", { env: { HOSTED_ONLY: "x", A: "1", a: "2" } }, ["x.yml env.a: differs from its sibling A only in case"]],
    ["a job whose id is env is still a job", { jobs: { env: { "runs-on": "x", Permissions: { contents: "write" } } } }, ["x.yml jobs.env.Permissions: permissions written in another case, which these tests read exactly"]],
    ["a job whose id is with is still a job", { jobs: { with: { "Runs-On": "x" } } }, ["x.yml jobs.with.Runs-On: runs-on written in another case, which these tests read exactly"]],
    ["environment variables named like keys, in real env maps", { env: { Permissions: "1" }, jobs: { a: { env: { Steps: "1" }, steps: [{ env: { Uses: "1" } }] } } }, []],
    ["a matrix include key with a character outside ASCII", { jobs: { a: { strategy: { matrix: { os: ["ubuntu-24.04"], include: [{ "o\u017f": "self-hosted" }] } } } } }, ["x.yml jobs.a.strategy.matrix.include.0.o\u017f: a key with a character outside ASCII, which GitHub and these tests may fold differently"]],
    ["include in another case inside a matrix", { jobs: { a: { strategy: { matrix: { os: ["x"], Include: [] } } } } }, ["x.yml jobs.a.strategy.matrix.Include: include written in another case, which these tests read exactly"]],
  ];
  for (const [name, value, problems] of keyCases) {
    test(`refuses keys these tests would misread: ${name}`, () => {
      expect(keyProblems("x.yml", value)).toEqual(problems);
    });
  }

  for (const [name, workflows, problems] of named) {
    test(name, () => {
      expect(privilegeProblems(workflows)).toEqual(problems);
    });
  }


  const ruleTwo: [string, Workflows, string[]][] = [
    ["refuses a mixed if on a signing step", one({ "runs-on": "ubuntu-24.04", environment: "release-signing", steps: [{ name: "Sign", run: "sign", if: "${{ success() }} && true" }] }), [`x.yml job: step Sign if "\${{ success() }} && true" ${MIXED}`]],
    ["refuses a mixed if on a privileged job", one({ "runs-on": "ubuntu-24.04", permissions: WRITE, if: "always() && ${{ github.ref == 'refs/heads/main' }}" }), [`x.yml job: job if "always() && \${{ github.ref == 'refs/heads/main' }}" ${MIXED}`]],
    ["allows a whole-value expression and a brace-free condition", one({ "runs-on": "ubuntu-24.04", permissions: WRITE, if: "${{ github.ref == 'refs/heads/main' }}", steps: [{ name: "Sign", run: "x", if: "success() && github.ref == 'refs/heads/main'" }] }), []],
    ["refuses an action in a privileged job at a tag instead of its reviewed reference", one({ "runs-on": "ubuntu-24.04", permissions: WRITE, steps: [{ uses: "actions/download-artifact@v4" }] }), ["x.yml job: uses actions/download-artifact@v4, which is not a reviewed action reference"]],
    ["refuses an action in a privileged job that is not reviewed at all", one({ "runs-on": "ubuntu-24.04", permissions: WRITE, steps: [{ uses: "someone/fetch-artifact@0123456789012345678901234567890123456789" }] }), ["x.yml job: uses someone/fetch-artifact@0123456789012345678901234567890123456789, which is not a reviewed action reference"]],
    ["refuses setup-ci's default cache in a privileged job", one({ "runs-on": "ubuntu-24.04", permissions: WRITE, steps: [{ uses: "./.github/actions/setup-ci" }] }), ['x.yml job: setup-ci cache "save (default)" is neither none nor the hosted_only form under a call that passes hosted_only: true']],
    ["refuses setup-bun's cache in a privileged job", one({ "runs-on": "ubuntu-24.04", env: { T: "${{ secrets.T }}" }, steps: [{ uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", with: { "bun-version": "1.4.2" } }] }), ["x.yml job: oven-sh/setup-bun without no-cache: true"]],
    ["refuses a cache step in a privileged job", one({ "runs-on": "ubuntu-24.04", permissions: WRITE, steps: [{ uses: CACHE, if: "!inputs.hosted_only", with: { path: "x", key: "k" } }] }), ['x.yml job: actions/cache if "!inputs.hosted_only" has no top-level && !inputs.hosted_only term under a call that passes hosted_only: true']],
    ["holds a read-only job to nothing here", one({ "runs-on": LIGHT, steps: [{ uses: "someone/anything@v1" }, { uses: "./.github/actions/setup-ci" }] }), []],
  ];
  for (const [name, workflows, problems] of ruleTwo) {
    test(name, () => {
      expect(privilegedJobProblems(workflows)).toEqual(problems);
    });
  }

  test("refuses a matrix key outside ASCII beside the runner axis (GitHub may fold it into the axis)", () => {
    expect(privilegeProblems(one({ "runs-on": "${{ matrix.os }}", permissions: WRITE, strategy: { matrix: { os: ["ubuntu-24.04"], "o\u017f": ["self-hosted"] } } }))).toEqual([`x.yml job: runs-on ${JSON.stringify("${{ matrix.os }}")} with contents: write`]);
  });

  test("refuses a matrix whose include entry lacks the runner axis where the matrix has none", () => {
    expect(privilegeProblems(one({ "runs-on": "${{ matrix.os }}", permissions: WRITE, strategy: { matrix: { include: [{ os: "ubuntu-24.04" }, { other: "x" }] } } }))).toEqual([`x.yml job: runs-on ${JSON.stringify("${{ matrix.os }}")} with contents: write`]);
  });

  test("names an include key that names the runner axis in another case", () => {
    expect(keyProblems("x.yml", { jobs: { a: { strategy: { matrix: { os: ["ubuntu-24.04"], include: [{ OS: "self-hosted" }] } } } } })).toEqual(["x.yml jobs.a.strategy.matrix.include.0.OS: names the matrix axis os in another case, which GitHub reads as that axis"]);
  });

  test("takes job ids named like keys the tests read as the user's own names", () => {
    expect(keyProblems("x.yml", { jobs: { Pages: {}, Env: {} } })).toEqual([]);
  });
});

describe("a whole-run run (a Pages run, or one whose privileged job takes an artifact) is GitHub-hosted and cacheless as a whole", () => {
  test("pages.yml's runs, with the ci.yml its validation calls", () => {
    expect(wholeRunProblems(repository, ["pages.yml"])).toEqual([]);
    expect(pagesRoots(repository)).toEqual(["pages.yml"]);
    expect(repository["pages.yml"]!.jobs.validate).toMatchObject({ uses: "./.github/workflows/ci.yml", with: { hosted_only: true } });
  });

  test("setup-ci's `cache: none` restores no cache: its cache steps need another mode, setup-bun is told not to, and it uses only reviewed actions", () => {
    const steps = setupCi.runs.steps;
    expect(setupCi.inputs.cache.default).not.toBe("none");
    const caches = steps.filter((step) => step.uses !== undefined && action(step.uses).startsWith("actions/cache"));
    expect(caches.length).toBeGreaterThan(0);
    expect(setupCiCacheProblems(steps)).toEqual([]);
    const bun = steps.filter((step) => step.uses !== undefined && action(step.uses) === "oven-sh/setup-bun");
    expect(bun.length).toBeGreaterThan(0);
    for (const step of bun) expect(step.with?.["no-cache"]).toBe("${{ inputs.cache == 'none' }}");
    for (const step of steps.filter((candidate) => candidate.uses !== undefined)) {
      expect(SETUP_CI_ACTIONS).toContain(step.uses!);
      // no cache input, and its automatic package-manager cache off whatever package.json's packageManager says
      if (action(step.uses!) === "actions/setup-node") expect(step.with).toMatchObject({ "package-manager-cache": false });
      if (action(step.uses!) === "actions/setup-node") expect(step.with?.["cache"]).toBeUndefined();
    }
  });

  test("a setup-ci cache step with its mode anywhere but a top-level && term can run under cache: none", () => {
    const step = (condition?: string): AnyStep => ({ name: "Cache Bun dependencies", uses: CACHE, ...(condition !== undefined && { if: condition }) });
    const message = (condition: string | null): string => `setup-ci Cache Bun dependencies: if ${JSON.stringify(condition)} has no top-level && inputs.cache == 'save' or 'restore' term, so it can run under cache: none`;
    expect(setupCiCacheProblems([step("runner.environment != 'self-hosted' && inputs.cache == 'save'"), step("inputs.cache == 'restore'")])).toEqual([]);
    for (const condition of [
      "always() || runner.environment != 'self-hosted' && inputs.cache == 'save'",
      "runner.environment != 'self-hosted' && (always() || inputs.cache == 'save')",
      "runner.environment != 'self-hosted'",
    ]) {
      expect(setupCiCacheProblems([step(condition)])).toEqual([message(condition)]);
    }
    expect(setupCiCacheProblems([step()])).toEqual([message(null)]);
  });

  test("a condition's top-level && terms: none when its top level is an ||", () => {
    expect(topLevelTerms("${{ needs.a.outputs.b != 'true' && !inputs.hosted_only }}")).toEqual(["needs.a.outputs.b != 'true'", "!inputs.hosted_only"]);
    expect(topLevelTerms("always() && (failure() || !inputs.hosted_only)")).toEqual(["always()", "(failure() || !inputs.hosted_only)"]);
    expect(topLevelTerms("!inputs.hosted_only || always()")).toEqual([]);
    expect(topLevelTerms("contains('a && b', x) && !inputs.hosted_only")).toEqual(["contains('a && b', x)", "!inputs.hosted_only"]);
  });

  const SIBLING = "site.yml: site.yml sibling";
  const CHECK = "site.yml: checks.yml check";
  const RUNS_ON = "is neither a listed hosted label nor the hosted_only form under a call that passes hosted_only: true";
  const NO_TERM = "has no top-level && !inputs.hosted_only term under a call that passes hosted_only: true";
  const cases: [string, Workflows, string[]][] = [
    ["allows a run whose every job is hosted and cacheless in a reviewed form", pages(HOSTED_JOB, { hosted_only: true }, { "runs-on": HOSTED_ONLY, steps: [{ uses: "./.github/actions/setup-ci", with: { cache: "${{ inputs.hosted_only && 'none' || 'save' }}" } }, { uses: CACHE, if: "always() && !inputs.hosted_only" }] }), []],
    ["refuses a sibling job on the light runner expression", pages({ ...HOSTED_JOB, "runs-on": LIGHT }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on ${JSON.stringify(LIGHT)} ${RUNS_ON}`]],
    ["refuses a runner that is hosted in the test's context only (the event of a workflow_run)", pages({ ...HOSTED_JOB, "runs-on": "${{ github.event.workflow_run.event == 'push' && fromJSON(vars.X) || 'ubuntu-24.04' }}" }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on "\${{ github.event.workflow_run.event == 'push' && fromJSON(vars.X) || 'ubuntu-24.04' }}" ${RUNS_ON}`]],
    ["refuses a runner that is hosted only while a variable is set", pages({ ...HOSTED_JOB, "runs-on": "${{ vars.X && 'ubuntu-24.04' || fromJSON('[\"self-hosted\"]') }}" }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on "\${{ vars.X && 'ubuntu-24.04' || fromJSON('[\\"self-hosted\\"]') }}" ${RUNS_ON}`]],
    ["refuses a label of a hosted form that is not on the list", pages({ ...HOSTED_JOB, "runs-on": "ubuntu-99.99" }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on "ubuntu-99.99" ${RUNS_ON}`]],
    ["refuses the hosted_only form outside a call that passes it", pages({ ...HOSTED_JOB, "runs-on": HOSTED_ONLY }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on ${JSON.stringify(HOSTED_ONLY)} ${RUNS_ON}`]],
    ["refuses a called job whose call does not pass hosted_only", pages(HOSTED_JOB, undefined, { "runs-on": HOSTED_ONLY }), [`${CHECK}: runs-on ${JSON.stringify(HOSTED_ONLY)} ${RUNS_ON}`]],
    ["refuses a matrix entry that names the runner axis in another case, in a Pages run", pages({ "runs-on": "${{ matrix.os }}", strategy: { matrix: { os: ["ubuntu-24.04"], include: [{ OS: "self-hosted" }] } } }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on ${JSON.stringify("${{ matrix.os }}")} ${RUNS_ON}`]],
    ["refuses a label in another case in a Pages run", pages({ ...HOSTED_JOB, "runs-on": "Ubuntu-24.04" }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: runs-on "Ubuntu-24.04" ${RUNS_ON}`]],
    ["refuses the hosted_only form with its context in another case: the reviewed form is exact", pages(HOSTED_JOB, { hosted_only: true }, { "runs-on": "${{ Inputs.Hosted_Only && 'ubuntu-24.04' || 'x' }}" }), [`${CHECK}: runs-on "\${{ Inputs.Hosted_Only && 'ubuntu-24.04' || 'x' }}" ${RUNS_ON}`]],
    ["refuses a cache step's guard in another case", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("always() && !Inputs.hosted_only")), [`${CHECK}: actions/cache if "always() && !Inputs.hosted_only" ${NO_TERM}`]],
    ["refuses an action reference in another case", pages({ ...HOSTED_JOB, steps: [{ uses: "Actions/Checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: uses Actions/Checkout@3d3c42e5aac5ba805825da76410c181273ba90b1, which is not a reviewed action reference`]],
    ["finds a separate Pages workflow whose deploy action is written in another case, and refuses its self-hosted sibling and that reference", { "other.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { other: { "runs-on": "self-hosted" }, deploy: { ...DEPLOY, steps: [{ uses: "Actions/Deploy-Pages@368f82528645a54fb793d4d04e342629a3f51346" }] } } } }, [`other.yml: other.yml other: runs-on "self-hosted" ${RUNS_ON}`, "other.yml: other.yml deploy: uses Actions/Deploy-Pages@368f82528645a54fb793d4d04e342629a3f51346, which is not a reviewed action reference"]],
    ["refuses a cache action written in another case, and reads it as a cache step", pages(HOSTED_JOB, { hosted_only: true }, { "runs-on": HOSTED_ONLY, steps: [{ uses: "ACTIONS/CACHE@55cc8345863c7cc4c66a329aec7e433d2d1c52a9", if: "always()" }] }), [`${CHECK}: uses ACTIONS/CACHE@55cc8345863c7cc4c66a329aec7e433d2d1c52a9, which is not a reviewed action reference`, `${CHECK}: actions/cache if "always()" ${NO_TERM}`]],
    ["refuses the local setup action's path in another case", pages({ ...HOSTED_JOB, steps: [{ uses: "./.github/actions/Setup-CI", with: { cache: "none" } }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: uses ./.github/actions/Setup-CI, which is not a reviewed action reference`]],
    ...["actions//deploy-pages", "actions/deploy-pages/", "actions\\deploy-pages", "/actions/deploy-pages", "actions/deploy-pages/."].map((spelling): [string, Workflows, string[]] => {
      const uses = `${spelling}@368f82528645a54fb793d4d04e342629a3f51346`;
      return [`finds a separate workflow that deploys through ${JSON.stringify(spelling)}, without the pages permission, and refuses its self-hosted sibling and that reference`, { "other.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { other: { "runs-on": "self-hosted" }, deploy: { "runs-on": "ubuntu-24.04", steps: [{ uses }] } } } }, [`other.yml: other.yml other: runs-on "self-hosted" ${RUNS_ON}`, `other.yml: other.yml deploy: uses ${uses}, which is not a reviewed action reference`]];
    }),
    ["finds a workflow that deploys through a local action wrapping deploy-pages, by its pages permission alone", { "other.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { other: { "runs-on": "self-hosted" }, deploy: { "runs-on": "ubuntu-24.04", permissions: { pages: "write" }, steps: [{ uses: "./.github/actions/deploy-site" }] } } } }, [`other.yml: other.yml other: runs-on "self-hosted" ${RUNS_ON}`, "other.yml: other.yml deploy: uses ./.github/actions/deploy-site, which is not a reviewed action reference"]],
    ["finds a workflow that deploys with no action at all, by its pages permission alone", { "other.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { other: { "runs-on": "self-hosted" }, deploy: { "runs-on": "ubuntu-24.04", permissions: { pages: "write" }, steps: [{ run: "curl -X POST https://api.github.com/repos/o/r/pages/deployments" }] } } } }, [`other.yml: other.yml other: runs-on "self-hosted" ${RUNS_ON}`]],
    ["finds a workflow that deploys through a wrapper with a secret token in the github-pages environment", { "other.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { other: { "runs-on": "self-hosted" }, deploy: { "runs-on": "ubuntu-24.04", environment: { name: "GitHub-Pages" }, steps: [{ uses: "./.github/actions/deploy-site", with: { token: "${{ secrets.PAGES_TOKEN }}" } }] } } } }, [`other.yml: other.yml other: runs-on "self-hosted" ${RUNS_ON}`, "other.yml: other.yml deploy: uses ./.github/actions/deploy-site, which is not a reviewed action reference"]],
    ["finds a workflow that calls the Pages API with id-token write and a secret", { "other.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { other: { "runs-on": "self-hosted" }, deploy: { "runs-on": "ubuntu-24.04", permissions: { contents: "read", "id-token": "write" }, steps: [{ run: "curl -H 'Authorization: Bearer ${{ secrets.T }}' https://api.github.com/repos/o/r/pages/deployments" }] } } } }, [`other.yml: other.yml other: runs-on "self-hosted" ${RUNS_ON}`]],
    ...["actions/deploy-pages/x/..@368f82528645a54fb793d4d04e342629a3f51346", "actions/upload-pages-artifact/x/..@fc324d3547104276b827a68afc52ff2a11cc49c9", " actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346 "].map((uses): [string, Workflows, string[]] => {
      return [`finds a Pages action by its owner/repo: ${JSON.stringify(uses)}`, { "other.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { other: { "runs-on": "self-hosted" }, deploy: { "runs-on": "ubuntu-24.04", steps: [{ uses }] } } } }, [`other.yml: other.yml other: runs-on "self-hosted" ${RUNS_ON}`, `other.yml: other.yml deploy: uses ${uses}, which is not a reviewed action reference`]];
    }),
    ["refuses the hosted_only form followed by a second expression", pages(HOSTED_JOB, { hosted_only: true }, { "runs-on": "${{ inputs.hosted_only && 'ubuntu-24.04' || 'x' }}${{ '-evil' }}" }), [`${CHECK}: runs-on "\${{ inputs.hosted_only && 'ubuntu-24.04' || 'x' }}\${{ '-evil' }}" ${RUNS_ON}`]],
    ["refuses the hosted_only form followed by text", pages(HOSTED_JOB, { hosted_only: true }, { "runs-on": "${{ inputs.hosted_only && 'ubuntu-24.04' || 'x' }}-evil" }), [`${CHECK}: runs-on "\${{ inputs.hosted_only && 'ubuntu-24.04' || 'x' }}-evil" ${RUNS_ON}`]],
    ["refuses setup-ci's hosted_only form followed by a second expression", pages(HOSTED_JOB, { hosted_only: true }, { "runs-on": HOSTED_ONLY, steps: [{ uses: "./.github/actions/setup-ci", with: { cache: "${{ inputs.hosted_only && 'none' || 'save' }}${{ '' }}" } }] }), [`${CHECK}: setup-ci cache "\${{ inputs.hosted_only && 'none' || 'save' }}\${{ '' }}" is neither none nor the hosted_only form under a call that passes hosted_only: true`]],
    ["refuses a called job whose call passes hosted_only as an expression", pages(HOSTED_JOB, { hosted_only: "${{ github.ref == 'refs/heads/main' }}" }, { "runs-on": HOSTED_ONLY }), [`${CHECK}: runs-on ${JSON.stringify(HOSTED_ONLY)} ${RUNS_ON}`]],
    ["refuses setup-ci's default cache", pages({ ...HOSTED_JOB, steps: [{ uses: "./.github/actions/setup-ci" }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: setup-ci cache "save (default)" is neither none nor the hosted_only form under a call that passes hosted_only: true`]],
    ["refuses setup-ci's cache taken from a variable", pages({ ...HOSTED_JOB, steps: [{ uses: "./.github/actions/setup-ci", with: { cache: "${{ vars.MODE }}" } }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: setup-ci cache "\${{ vars.MODE }}" is neither none nor the hosted_only form under a call that passes hosted_only: true`]],
    ["refuses a cache step with no condition", pages({ ...HOSTED_JOB, steps: [{ uses: CACHE, with: { path: "x", key: "k" } }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: actions/cache if null ${NO_TERM}`]],
    ["refuses a cache step that runs in every real workflow_run", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("github.event.workflow_run.conclusion == 'success'")), [`${CHECK}: actions/cache if "github.event.workflow_run.conclusion == 'success'" ${NO_TERM}`]],
    ["refuses a cache step gated on a variable", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("vars.CACHE_MODE == 'enabled'")), [`${CHECK}: actions/cache if "vars.CACHE_MODE == 'enabled'" ${NO_TERM}`]],
    ["refuses a cache step that runs after a failure", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("failure()")), [`${CHECK}: actions/cache if "failure()" ${NO_TERM}`]],
    ["refuses a cache step gated on a step's output", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("steps.x.outputs.y == 'true'")), [`${CHECK}: actions/cache if "steps.x.outputs.y == 'true'" ${NO_TERM}`]],
    ["refuses a cache step gated on an input the call never sets (GitHub reads it as true)", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("inputs.missing == false")), [`${CHECK}: actions/cache if "inputs.missing == false" ${NO_TERM}`]],
    ["refuses !inputs.hosted_only inside an ||", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("!inputs.hosted_only || always()")), [`${CHECK}: actions/cache if "!inputs.hosted_only || always()" ${NO_TERM}`]],
    ["refuses !inputs.hosted_only inside parentheses with an ||", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("(always() && !inputs.hosted_only) || failure()")), [`${CHECK}: actions/cache if "(always() && !inputs.hosted_only) || failure()" ${NO_TERM}`]],
    ["refuses a cache step gated on hosted_only outside a call that passes it", pages(HOSTED_JOB, undefined, { "runs-on": "ubuntu-24.04", steps: [{ uses: CACHE, if: "!inputs.hosted_only" }] }), [`${CHECK}: actions/cache if "!inputs.hosted_only" ${NO_TERM}`]],
    ["refuses a reviewed action at another reference", pages({ ...HOSTED_JOB, steps: [{ uses: "actions/checkout@v7" }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: uses actions/checkout@v7, which is not a reviewed action reference`]],
    ["refuses an action that is not reviewed", pages({ ...HOSTED_JOB, steps: [{ uses: "Swatinem/rust-cache@v2" }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: uses Swatinem/rust-cache@v2, which is not a reviewed action reference`]],
    ["refuses a cache input on an action", pages({ ...HOSTED_JOB, steps: [{ uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1", with: { cache: "npm" } }] }, { hosted_only: true }, HOSTED_JOB), [`${SIBLING}: actions/setup-node without package-manager-cache: false, or with a cache input`]],
    ["refuses a run that calls the Pages workflow from a self-hosted one", {
      ...pages(HOSTED_JOB, { hosted_only: true }, HOSTED_JOB),
      "site.yml": { ...pages(HOSTED_JOB, { hosted_only: true }, HOSTED_JOB)["site.yml"]!, on: { workflow_call: {} } },
      "outer.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { light: { "runs-on": LIGHT }, site: { uses: "./.github/workflows/site.yml" } } },
    }, [`outer.yml: outer.yml light: runs-on ${JSON.stringify(LIGHT)} ${RUNS_ON}`]],
  ];
  for (const [name, workflows, problems] of cases) {
    test(name, () => {
      expect(wholeRunProblems(workflows)).toEqual(problems);
    });
  }

  const withDeploy = (deploy: AnyJob, permissions: Permissions | null = { contents: "read" }): Workflows => ({ "x.yml": { on: { push: {} }, ...(permissions && { permissions }), jobs: { other: { "runs-on": "self-hosted", permissions: { contents: "read" } }, deploy } } });
  test("takes write-all, no permissions at all, or a permissions scalar other than read-all for a job that can write Pages", () => {
    expect(pagesRoots(withDeploy({ "runs-on": "ubuntu-24.04", permissions: "write-all" }))).toEqual(["x.yml"]);
    expect(pagesRoots(withDeploy({ "runs-on": "ubuntu-24.04" }, null))).toEqual(["x.yml"]);
    expect(pagesRoots(withDeploy({ "runs-on": "ubuntu-24.04", permissions: "Read-All" as Permissions }))).toEqual(["x.yml"]);
  });

  test("takes a job in the github-pages environment written as a plain string, in any case, by that sign alone", () => {
    expect(pagesRoots(withDeploy({ "runs-on": "ubuntu-24.04", environment: "github-pages" }))).toEqual(["x.yml"]);
    expect(pagesRoots(withDeploy({ "runs-on": "ubuntu-24.04", environment: "GitHub-Pages" }))).toEqual(["x.yml"]);
  });

  test("does not take an attestation job (id-token write, no secret) or a job with a secret and no id-token for a Pages run", () => {
    expect(pagesRoots(withDeploy({ "runs-on": "ubuntu-24.04", permissions: { "id-token": "write", attestations: "write" }, steps: [{ uses: "actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8" }] }))).toEqual([]);
    const secretOnly = withDeploy({ "runs-on": LIGHT, env: { T: "${{ secrets.T }}" } });
    expect(pagesRoots(secretOnly)).toEqual([]);
    expect(privilegeProblems(secretOnly)).toEqual([`x.yml deploy: runs-on ${JSON.stringify(LIGHT)} with secrets.T`]);
  });

  test("does not take a workflow with contents: write only for a Pages run; the privileged-job rule still holds it", () => {
    const workflows: Workflows = { "x.yml": { on: { push: {} }, permissions: { contents: "read" }, jobs: { other: { "runs-on": "self-hosted" }, publish: { "runs-on": LIGHT, permissions: { contents: "write" } } } } };
    expect(pagesRoots(workflows)).toEqual([]);
    expect(privilegeProblems(workflows)).toEqual([`x.yml publish: runs-on ${JSON.stringify(LIGHT)} with contents: write`]);
  });

  test("fails when the workflow that deploys Pages no longer has its deploy step, instead of checking nothing", () => {
    const workflows = pages(HOSTED_JOB, { hosted_only: true }, HOSTED_JOB);
    workflows["site.yml"]!.jobs.deploy!.steps = [{ uses: CHECKOUT }];
    expect(wholeRunProblems(workflows, ["site.yml"])).toEqual(["site.yml: has no job that deploys Pages (actions/deploy-pages), so no run of it is checked as a whole"]);
  });

  test("finds every whole-run run in the repository: Pages, and each run with a privileged job that takes an artifact", () => {
    expect(wholeRunRoots(repository)).toEqual(["beta.yml", "desktop.yml", "pages.yml", "pty-sidecar-attach.yml", "pty-sidecar.yml", "release.yml", "remote-bundles.yml", "shell-preview.yml", "windows-app.yml"]);
  });

  test("does not throw on a null environment", () => {
    expect(pagesRoots(withDeploy({ "runs-on": "ubuntu-24.04", environment: null as unknown as AnyJob["environment"] }))).toEqual([]);
  });

  const DOWNLOAD = "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333";
  const PUBLISH: AnyJob = { "runs-on": "ubuntu-24.04", permissions: { contents: "write" }, steps: [{ uses: DOWNLOAD, with: { pattern: "bundle-*" } }] };
  const release = (build: AnyJob, publish: AnyJob = PUBLISH): Workflows => ({ "rel.yml": { on: { workflow_dispatch: {} }, permissions: { contents: "read" }, jobs: { build, publish } } });
  const GH_PAGES: AnyJob = { "runs-on": "ubuntu-24.04", permissions: { contents: "write" }, steps: [{ uses: DOWNLOAD, with: { name: "site" } }, { run: "git push origin HEAD:gh-pages" }] };
  const consumers: [string, Workflows, string[]][] = [
    ["finds a job that downloads and publishes, and refuses a self-hosted job in its run", release({ "runs-on": LIGHT }), [`rel.yml: rel.yml build: runs-on ${JSON.stringify(LIGHT)} ${RUNS_ON}`]],
    ["allows a pattern download in a run that is hosted and cacheless as a whole", release(HOSTED_JOB), []],
    ["refuses setup-bun's cache in that run", release({ ...HOSTED_JOB, steps: [{ uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", with: { "bun-version": "1.4.2" } }] }), ["rel.yml: rel.yml build: oven-sh/setup-bun without no-cache: true"]],
    ["refuses setup-node's automatic package cache in that run", release({ ...HOSTED_JOB, steps: [{ uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1", with: { "node-version": "22" } }] }), ["rel.yml: rel.yml build: actions/setup-node without package-manager-cache: false, or with a cache input"]],
    ["refuses a download by artifact id or from another run, a form no whole-run run uses", release(HOSTED_JOB, { ...PUBLISH, steps: [{ uses: DOWNLOAD, with: { "artifact-ids": "${{ needs.build.outputs.id }}", "run-id": "1" } }] }), ["rel.yml: rel.yml publish: actions/download-artifact with artifact-ids, a form these runs do not use", "rel.yml: rel.yml publish: actions/download-artifact with run-id, a form these runs do not use"]],
    ["finds a download written in another spelling, and refuses it and the self-hosted sibling", release({ "runs-on": "self-hosted" }, { ...PUBLISH, steps: [{ uses: "actions//download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333" }] }), [`rel.yml: rel.yml build: runs-on "self-hosted" ${RUNS_ON}`, "rel.yml: rel.yml publish: uses actions//download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333, which is not a reviewed action reference"]],
    ["holds a push to gh-pages that takes an artifact as a whole run, though it shows none of the Pages signs", release({ "runs-on": "self-hosted" }, GH_PAGES), [`rel.yml: rel.yml build: runs-on "self-hosted" ${RUNS_ON}`]],
    ["refuses a cache condition that mixes an expression with text: GitHub reads it as a string, always true", pages(HOSTED_JOB, { hosted_only: true }, cacheIf("${{ github.ref == 'refs/heads/main' }} && !inputs.hosted_only")), [`${CHECK}: step ${CACHE} if "\${{ github.ref == 'refs/heads/main' }} && !inputs.hosted_only" ${MIXED}`]],
    ["refuses a publishing job whose own if mixes an expression with text", release(HOSTED_JOB, { ...PUBLISH, if: "${{ github.ref == 'refs/heads/main' }} && always()" }), [`rel.yml: rel.yml publish: job if "\${{ github.ref == 'refs/heads/main' }} && always()" ${MIXED}`]],
    ["reads a download's inputs without regard to case: Run-Id and Github-Token are refused", release(HOSTED_JOB, { ...PUBLISH, steps: [{ uses: DOWNLOAD, with: { "Run-Id": "1", "Github-Token": "${{ secrets.T }}" } }] }), ["rel.yml: rel.yml publish: actions/download-artifact with run-id, a form these runs do not use", "rel.yml: rel.yml publish: actions/download-artifact with github-token, a form these runs do not use"]],
    ["refuses a download with a token or from another repository", release(HOSTED_JOB, { ...PUBLISH, steps: [{ uses: DOWNLOAD, with: { name: "x", "github-token": "${{ secrets.T }}", repository: "o/r" } }] }), ["rel.yml: rel.yml publish: actions/download-artifact with github-token, a form these runs do not use", "rel.yml: rel.yml publish: actions/download-artifact with repository, a form these runs do not use"]],
    ["reads setup-bun's No-Cache: true as the cache off, as the runner does (an exact lookup would refuse it)", release({ ...HOSTED_JOB, steps: [{ uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", with: { "bun-version": "1.4.2", "No-Cache": true } }] }), []],
    ["reads setup-node's Cache: npm as a cache input, and refuses it", release({ ...HOSTED_JOB, steps: [{ uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1", with: { "node-version": "22", "package-manager-cache": false, Cache: "npm" } }] }), ["rel.yml: rel.yml build: actions/setup-node without package-manager-cache: false, or with a cache input"]],
    ["refuses an action's inputs that differ only in case", release({ ...HOSTED_JOB, steps: [{ uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", with: { "no-cache": true, "No-Cache": false } }] }), ["rel.yml: rel.yml build: oven-sh/setup-bun has inputs that differ only in case"]],
  ];
  for (const [name, workflows, problems] of consumers) {
    test(name, () => {
      expect(wholeRunProblems(workflows)).toEqual(problems);
    });
  }

  const MAC_MATRIX = { include: [{ os: "ubuntu-24.04" }, { os: "macos-15" }, { os: "macos-15-intel" }] };
  const macBuild = (runsOn: string = MAC_PULL_REQUEST, matrix: Matrix = MAC_MATRIX): AnyJob => ({ "runs-on": runsOn, strategy: { matrix }, steps: [{ uses: CHECKOUT }] });
  const macRun = (on: unknown, publish: AnyJob, build: AnyJob = macBuild()): Workflows => ({ "rel.yml": { on, permissions: { contents: "read" }, jobs: { build, publish } } });
  const PULL_REQUEST = { pull_request: {}, push: { tags: ["v*"] } };
  const MAC_IN_PR_RUN = (privileged: string): string => `rel.yml: rel.yml build: runs-on the pull-request Mac form in a run where a pull request can run the privileged job ${privileged}`;
  const macCases: [string, Workflows, string[]][] = [
    ["allows the pull-request Mac form where the publishing job never runs for a pull request", macRun(PULL_REQUEST, { ...PUBLISH, if: "github.event_name != 'pull_request' && always()" }), []],
    ["allows it where the publishing job runs for a tag only", macRun(PULL_REQUEST, { ...PUBLISH, if: "startsWith(github.ref, 'refs/tags/remote-v')" }), []],
    ["allows it in a run no pull request starts, whatever its publishing job's condition", macRun({ workflow_dispatch: {}, pull_request_target: {} }, PUBLISH), []],
    ["refuses it where the publishing job has no condition", macRun(PULL_REQUEST, PUBLISH), [MAC_IN_PR_RUN("rel.yml publish")]],
    ["refuses it where the pull request term is inside an ||", macRun(PULL_REQUEST, { ...PUBLISH, if: "github.event_name != 'pull_request' || always()" }), [MAC_IN_PR_RUN("rel.yml publish")]],
    ["refuses it where the guard names a branch, which a pull request's merge ref is not either but nothing proves", macRun(PULL_REQUEST, { ...PUBLISH, if: "github.ref == 'refs/heads/main'" }), [MAC_IN_PR_RUN("rel.yml publish")]],
    ["refuses it where the publishing job's condition mixes an expression with text", macRun(PULL_REQUEST, { ...PUBLISH, if: "${{ github.event_name != 'pull_request' }} && true" }), [MAC_IN_PR_RUN("rel.yml publish"), `rel.yml: rel.yml publish: job if "\${{ github.event_name != 'pull_request' }} && true" ${MIXED}`]],
    ["refuses it where the trigger is written in another case", macRun({ Pull_Request: {} }, PUBLISH), [MAC_IN_PR_RUN("rel.yml publish")]],
    ["refuses the form over a matrix one of whose labels is not hosted", macRun(PULL_REQUEST, { ...PUBLISH, if: "github.event_name != 'pull_request'" }, macBuild(MAC_PULL_REQUEST, { include: [{ os: "macos-15" }, { os: "self-hosted" }] })), [`rel.yml: rel.yml build: runs-on ${JSON.stringify(MAC_PULL_REQUEST)} ${RUNS_ON}`]],
    ...[
      MAC_PULL_REQUEST.replace(" && github.event.pull_request.head.repo.full_name == github.repository", ""),
      MAC_PULL_REQUEST.replace("github.event_name == 'pull_request'", "github.event_name != 'workflow_call'"),
      `${MAC_PULL_REQUEST}-x`,
    ].map((runsOn): [string, Workflows, string[]] => [`refuses another form: ${runsOn}`, macRun({ workflow_dispatch: {} }, PUBLISH, macBuild(runsOn)), [`rel.yml: rel.yml build: runs-on ${JSON.stringify(runsOn)} ${RUNS_ON}`]]),
  ];
  for (const [name, workflows, problems] of macCases) {
    test(name, () => {
      expect(wholeRunProblems(workflows)).toEqual(problems);
    });
  }

  test("no privileged job may take the pull-request Mac form itself", () => {
    expect(privilegeProblems(one({ ...macBuild(), permissions: { contents: "write" }, if: "github.event_name != 'pull_request'" }))).toEqual([`x.yml job: runs-on ${JSON.stringify(MAC_PULL_REQUEST)} with contents: write`]);
  });

  test("the remote bundles and the Rust PTY host take the pull-request Mac form, and their publishing jobs skip pull requests", () => {
    expect(repository["remote-bundles.yml"]!.jobs.bundle!["runs-on"]).toBe(MAC_PULL_REQUEST);
    expect(repository["pty-sidecar.yml"]!.jobs.build!["runs-on"]).toBe(MAC_PULL_REQUEST);
    expect(pullRequestProblems(repository, "remote-bundles.yml")).toEqual([]);
    expect(pullRequestProblems(repository, "pty-sidecar.yml")).toEqual([]);
  });

  test("a push to gh-pages shows none of the Pages signs; the privileged-job rule keeps it hosted", () => {
    expect(pagesRoots(release(HOSTED_JOB, GH_PAGES))).toEqual([]);
    expect(privilegeProblems(release(HOSTED_JOB, { ...GH_PAGES, "runs-on": LIGHT }))).toEqual([`rel.yml publish: runs-on ${JSON.stringify(LIGHT)} with contents: write`]);
  });

  test("refuses a setup-ci cache condition that mixes an expression with text", () => {
    expect(setupCiCacheProblems([{ name: "Cache Bun dependencies", uses: CACHE, if: "${{ always() }} && inputs.cache == 'save'" }])).toEqual([`setup-ci Cache Bun dependencies: if "\${{ always() }} && inputs.cache == 'save'" ${MIXED}`]);
  });
});
