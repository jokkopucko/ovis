import { afterEach, describe, expect, it } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CI_JOBS, CI_MATRIX_JOB, CI_SHARD_COUNTS, CI_WORKFLOW, type Finding, type Get, jobsFinding, jobsPath, main, matrixJobs, namesProblem,
  outputLines, pushRun, type Run, reuse, runProblem, runsPath,
} from "./release-ci-reuse.ts";
import { root, runScript } from "./shell-workflow-rules.ts";
import { files, read } from "./source-scan.ts";

const REPO = "devswha/ovis";
const SHA = "c99017754cb330143589afb2f74473828b86615e";
const RUN = 42426987381;
const commit = { repository: REPO, sha: SHA };
const ONE_JOB = "Browser regression (other scripts)";
const split = (names: string[]): string[] => names.flatMap((name) => (name === ONE_JOB ? [1, 2, 3].map((part) => `${ONE_JOB.slice(0, -1)} ${part}/3)`) : [name]));
const SELF_HOSTED = split([
  "Detect changes", "herdr-core live contract", "Browser regression (ui-regression)", "Native macOS session identity",
  ONE_JOB, "Integration tests", "Native Windows install", "Fast checks", "Rust PTY host", "Integration and browser",
]);
const HOSTED = [...SELF_HOSTED.filter((name) => !name.startsWith("Browser regression (other scripts ")), ...[3, 4, 1, 2].map((shard) => `Browser regression (other scripts ${shard}/4)`)];

type Fields = Record<string, unknown>;
const listedRun = (over: Fields = {}): Fields => ({
  id: RUN, name: "CI", path: ".github/workflows/ci.yml", event: "push", head_branch: "main", head_sha: SHA,
  status: "completed", conclusion: "success", run_attempt: 1, repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...over,
});
const runs = (...list: unknown[]) => ({ total_count: list.length, workflow_runs: list });
const listedJob = (name: string, over: Fields = {}): Fields => ({ id: 128567271573, run_id: RUN, run_attempt: 1, head_sha: SHA, status: "completed", conclusion: "success", name, ...over });
const jobs = (list: unknown[]) => ({ total_count: list.length, jobs: list });
const passed = (names: string[], over: Fields = {}) => jobs(names.map((name) => listedJob(name, over)));
const withJob = (names: string[], changed: Record<string, Fields | null>) =>
  jobs(names.flatMap((name) => (changed[name] === null ? [] : [listedJob(name, changed[name] ?? {})])));

const completed: Run = { id: RUN, status: "completed", conclusion: "success", attempt: 1 };
const running: Run = { id: RUN, status: "in_progress", conclusion: null, attempt: 1 };
const yes: Finding = { answer: "yes", run: RUN };
const why = (finding: Finding): string => (finding.answer === "yes" ? "yes" : finding.why);

describe("the run GitHub lists", () => {
  it("takes the one push run of ci.yml on main for the commit", () => {
    expect(pushRun(runs(listedRun()), commit)).toEqual(completed);
    expect(pushRun(runs(listedRun({ status: "in_progress", conclusion: null, run_attempt: 2 })), commit)).toEqual({ id: RUN, status: "in_progress", conclusion: null, attempt: 2 });
  });

  it("asks GitHub for that run only", () => {
    expect(runsPath(commit)).toBe(`/repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${SHA}&event=push&branch=main&per_page=100`);
    expect(jobsPath(commit, RUN)).toBe(`/repos/${REPO}/actions/runs/${RUN}/jobs?filter=latest&per_page=100`);
  });

  it("refuses no run and more than one", () => {
    expect(pushRun(runs(), commit)).toBe("main has no push run of ci.yml for this commit");
    expect(pushRun(runs(listedRun(), listedRun({ id: RUN + 1 })), commit)).toBe("main has 2 push runs of ci.yml for this commit");
  });

  for (const [field, value] of [
    ["path", ".github/workflows/pages.yml"], ["path", undefined],
    ["event", "workflow_dispatch"], ["event", "pull_request"], ["event", "schedule"],
    ["head_branch", "release"], ["head_branch", "refs/heads/main"], ["head_branch", null],
    ["head_sha", "b".repeat(40)], ["head_sha", SHA.slice(0, 12)],
    ["repository", { full_name: "someone/ovis" }], ["repository", null],
    ["head_repository", { full_name: "someone/ovis" }], ["head_repository", null], ["head_repository", { full_name: null }],
  ] as const) {
    it(`refuses a run whose ${field} is ${JSON.stringify(value) ?? "missing"}`, () => {
      const refused = pushRun(runs(listedRun({ [field]: value })), commit);
      expect(typeof refused).toBe("string");
      expect(refused as string).toStartWith(`run ${RUN}: ${field} is `);
    });
  }

  it("refuses a run of another repository's commit with the same id and name", () => {
    expect(pushRun(runs(listedRun()), { repository: "someone/ovis", sha: SHA })).toBe(`run ${RUN}: repository is "${REPO}", not someone/ovis`);
    expect(pushRun(runs(listedRun()), { repository: REPO, sha: "b".repeat(40) })).toBe(`run ${RUN}: head_sha is "${SHA}", not ${"b".repeat(40)}`);
  });

  it("refuses a run without an id, a status, a conclusion or an attempt", () => {
    for (const over of [{ id: undefined }, { id: String(RUN) }, { id: 0 }, { id: 1.5 }]) expect(pushRun(runs(listedRun(over)), commit)).toBe("the run GitHub listed has no id");
    for (const over of [{ status: undefined }, { status: 1 }, { conclusion: undefined }, { conclusion: true }, { run_attempt: undefined }, { run_attempt: "1" }, { run_attempt: -1 }]) {
      expect(pushRun(runs(listedRun(over)), commit)).toBe(`run ${RUN} has no status, conclusion or run_attempt`);
    }
  });

  it("refuses a list it cannot read, or one GitHub cut short", () => {
    for (const answer of [null, undefined, "", [], [listedRun()], {}, { workflow_runs: [listedRun()] }, { total_count: "1", workflow_runs: [listedRun()] }, { total_count: 1, workflow_runs: {} }, { total_count: 1, workflow_runs: null }]) {
      expect(pushRun(answer, commit)).toBe("GitHub's list of runs is not { total_count, workflow_runs }");
    }
    expect(pushRun({ total_count: 2157, workflow_runs: Array.from({ length: 100 }, () => listedRun()) }, commit)).toBe("GitHub listed 100 of 2157 runs");
    expect(pushRun({ total_count: 2, workflow_runs: [listedRun()] }, commit)).toBe("GitHub listed 1 of 2 runs");
    expect(pushRun({ total_count: 0, workflow_runs: [listedRun()] }, commit)).toBe("GitHub listed 1 of 0 runs");
    for (const entry of [null, "run", 7, [listedRun()]]) expect(pushRun(runs(entry), commit)).toBe("the run GitHub listed has no id");
  });
});

describe("the run's state", () => {
  it("leaves a passed run, and one still going, to its jobs", () => {
    expect(runProblem(completed)).toBeNull();
    expect(runProblem({ ...completed, attempt: 2 })).toBeNull();
    expect(runProblem(running)).toBeNull();
    expect(runProblem({ ...running, status: "queued" })).toBeNull();
  });

  it("refuses a run that ended any other way, and says so when main's CI failed", () => {
    for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
      expect(runProblem({ ...completed, conclusion })).toEqual({ answer: "no", why: `main's run ${RUN} ended ${JSON.stringify(conclusion)}`, failed: true });
    }
    for (const conclusion of ["cancelled", "skipped", "action_required", "neutral", "stale", "", null]) {
      expect(runProblem({ ...completed, conclusion })).toEqual({ answer: "no", why: `main's run ${RUN} ended ${JSON.stringify(conclusion)}` });
    }
  });

  it("refuses a third attempt, passed or still going", () => {
    for (const attempt of [3, 4, 0]) {
      for (const run of [completed, running]) expect(runProblem({ ...run, attempt })).toEqual({ answer: "no", why: `main's run ${RUN} is on attempt ${attempt}, and only a first or second attempt counts` });
    }
  });

  it("does not wait for a run that waits behind another run of main", () => {
    for (const status of ["pending", "waiting", "requested", "action_required", "", "COMPLETED"]) {
      expect(runProblem({ ...running, status })).toEqual({ answer: "no", why: `main's run ${RUN} is ${JSON.stringify(status)}, which is not a run to wait for` });
    }
  });
});

describe("the run's jobs", () => {
  it("says yes when every job of ci.yml passed, on the self-hosted PC or on GitHub's runners", () => {
    expect(jobsFinding(passed(SELF_HOSTED), completed, commit)).toEqual(yes);
    expect(jobsFinding(passed(HOSTED), completed, commit)).toEqual(yes);
    expect(jobsFinding(passed(SELF_HOSTED, { run_attempt: 2 }), { ...completed, attempt: 2 }, commit)).toEqual(yes);
  });

  for (const conclusion of ["skipped", "failure", "cancelled", "timed_out", "neutral", null]) {
    it(`refuses a job that ended ${conclusion}`, () => {
      const failed = conclusion === "failure" || conclusion === "timed_out" ? { failed: true as const } : {};
      for (const name of SELF_HOSTED) {
        expect(jobsFinding(withJob(SELF_HOSTED, { [name]: { conclusion } }), completed, commit))
          .toEqual({ answer: "no", why: `${JSON.stringify(name)} ended ${JSON.stringify(conclusion)} in main's run ${RUN}`, ...failed });
      }
    });
  }

  it("refuses a run with a job of ci.yml missing, whichever it is", () => {
    for (const name of SELF_HOSTED) {
      const finding = jobsFinding(withJob(SELF_HOSTED, { [name]: null }), completed, commit);
      expect(finding.answer).toBe("no");
      expect(why(finding)).toStartWith(`run ${RUN}: the jobs are not ci.yml's (`);
    }
    expect(why(jobsFinding(withJob(SELF_HOSTED, { "Fast checks": null }), completed, commit))).toBe(`run ${RUN}: the jobs are not ci.yml's (missing "Fast checks")`);
    expect(why(jobsFinding(jobs([]), completed, commit))).toContain(`missing "Detect changes"`);
  });

  it("refuses a job ci.yml does not have, and a job listed twice", () => {
    expect(why(jobsFinding(passed([...SELF_HOSTED, "Deploy"]), completed, commit))).toBe(`run ${RUN}: the jobs are not ci.yml's (not ci.yml's, or there twice: "Deploy")`);
    expect(why(jobsFinding(passed([...SELF_HOSTED, "Fast checks"]), completed, commit))).toBe(`run ${RUN}: the jobs are not ci.yml's (not ci.yml's, or there twice: "Fast checks")`);
    expect(why(jobsFinding(passed(SELF_HOSTED.map((name) => (name === "Fast checks" ? "fast checks" : name))), completed, commit)))
      .toBe(`run ${RUN}: the jobs are not ci.yml's (missing "Fast checks"; not ci.yml's, or there twice: "fast checks")`);
    // a job of a called workflow is listed under its caller's name
    expect(jobsFinding(passed(SELF_HOSTED.map((name) => `validate / ${name}`)), completed, commit).answer).toBe("no");
  });

  it("refuses a job of another run, another attempt or another commit", () => {
    for (const over of [{ run_id: RUN + 1 }, { run_id: String(RUN) }, { run_id: undefined }, { run_attempt: 2 }, { run_attempt: undefined }, { head_sha: "b".repeat(40) }, { head_sha: undefined }]) {
      expect(jobsFinding(withJob(SELF_HOSTED, { "Fast checks": over }), completed, commit))
        .toEqual({ answer: "no", why: `job "Fast checks" is not of attempt 1 of run ${RUN} for this commit` });
    }
    expect(jobsFinding(passed(SELF_HOSTED), { ...completed, attempt: 2 }, commit).answer).toBe("no");
  });

  it("refuses a list of jobs it cannot read, or one GitHub cut short", () => {
    for (const answer of [null, undefined, [], {}, { jobs: [] }, { total_count: 10 }, { total_count: "0", jobs: [] }, { total_count: 0, jobs: {} }]) {
      expect(jobsFinding(answer, completed, commit)).toEqual({ answer: "no", why: `GitHub's list of the jobs of run ${RUN} is not { total_count, jobs }` });
    }
    expect(jobsFinding({ total_count: 104, jobs: passed(SELF_HOSTED).jobs }, completed, commit)).toEqual({ answer: "no", why: `GitHub listed 12 of the 104 jobs of run ${RUN}` });
    expect(jobsFinding({ total_count: 9, jobs: passed(SELF_HOSTED).jobs }, completed, commit).answer).toBe("no");
    for (const entry of [null, "job", { ...listedJob("Fast checks"), name: undefined }, { ...listedJob("Fast checks"), status: undefined }, { ...listedJob("Fast checks"), conclusion: undefined }, { ...listedJob("Fast checks"), conclusion: 0 }]) {
      expect(jobsFinding(jobs([...passed(SELF_HOSTED).jobs.slice(1), entry]), completed, commit)).toEqual({ answer: "no", why: `a job of run ${RUN} has no name, status or conclusion` });
    }
  });

  it("refuses a completed run with a job that is not", () => {
    expect(jobsFinding(withJob(SELF_HOSTED, { "Fast checks": { status: "in_progress", conclusion: null } }), completed, commit))
      .toEqual({ answer: "no", why: `"Fast checks" is "in_progress" although run ${RUN} is completed` });
  });

  it("waits for a run still going while no job of it has ended without passing", () => {
    const wait: Finding = { answer: "wait", why: `main's run ${RUN} is in_progress and no job of it has failed` };
    expect(jobsFinding(jobs([]), running, commit)).toEqual(wait);
    expect(jobsFinding(withJob(SELF_HOSTED, { "Fast checks": { status: "in_progress", conclusion: null }, "Integration and browser": null }), running, commit)).toEqual(wait);
    expect(jobsFinding(withJob(SELF_HOSTED, { "Integration tests": { status: "queued", conclusion: null } }), running, commit)).toEqual(wait);
    expect(jobsFinding(passed(SELF_HOSTED), running, commit)).toEqual(wait);
    expect(jobsFinding(jobs([]), { ...running, status: "queued" }, commit)).toEqual({ answer: "wait", why: `main's run ${RUN} is queued and no job of it has failed` });
  });

  it("stops waiting at the first job that ends without passing", () => {
    for (const conclusion of ["failure", "cancelled", "skipped"]) {
      expect(jobsFinding(withJob(SELF_HOSTED, { "Native macOS session identity": { conclusion }, "Integration tests": { status: "in_progress", conclusion: null } }), running, commit))
        .toEqual({ answer: "no", why: `"Native macOS session identity" ended "${conclusion}" in main's run ${RUN}`, ...(conclusion === "failure" ? { failed: true as const } : {}) });
    }
  });
});

describe("job names", () => {
  const fixed = SELF_HOSTED.filter((name) => !name.startsWith("Browser regression (other scripts "));
  const shards = (...list: string[]) => [...fixed, ...list.map((shard) => `Browser regression (other scripts${shard})`)];

  it("lists the names GitHub gives ci.yml's jobs", () => {
    expect([...CI_JOBS, ...matrixJobs(3)].sort()).toEqual([...SELF_HOSTED].sort());
    expect([...CI_JOBS, ...matrixJobs(4)].sort()).toEqual([...HOSTED].sort());
    expect(matrixJobs(1)).toEqual(["Browser regression (other scripts)"]);
    expect(matrixJobs(3)).toEqual([1, 2, 3].map((shard) => `Browser regression (other scripts ${shard}/3)`));
    expect(matrixJobs(4)).toEqual([1, 2, 3, 4].map((shard) => `Browser regression (other scripts ${shard}/4)`));
    for (const required of ["Fast checks", "Integration and browser", "Native Windows install"]) expect(CI_JOBS).toContain(required);
  });

  it("takes every part of three, four or five", () => {
    expect(namesProblem(shards(" 1/3", " 2/3", " 3/3"))).toBeNull();
    expect(namesProblem(shards(" 3/3", " 1/3", " 2/3"))).toBeNull();
    expect(namesProblem(shards(" 1/4", " 2/4", " 3/4", " 4/4"))).toBeNull();
    expect(namesProblem(shards(" 1/5", " 2/5", " 3/5", " 4/5", " 5/5"))).toBeNull();
    expect(namesProblem(shards(" 4/4", " 2/4", " 1/4", " 3/4").reverse())).toBeNull();
  });

  it("refuses shards that are incomplete, mixed, doubled or of another size", () => {
    const neither = `the jobs are not ci.yml's ("Browser regression (other scripts)" is neither all of 1/3 to 3/3 nor all of 1/4 to 4/4 nor all of 1/5 to 5/5)`;
    expect(namesProblem(shards())).toBe(neither);
    expect(namesProblem(shards(" 1/4", " 2/4", " 3/4"))).toBe(neither);
    expect(namesProblem(shards(" 2/4", " 3/4", " 4/4"))).toBe(neither);
    expect(namesProblem(shards(" 1/3", " 2/3"))).toBe(neither);
    expect(namesProblem(shards(" 1/3", " 2/3", " 3/3", " 1/4", " 2/4", " 3/4", " 4/4"))).toBe(neither);
    expect(namesProblem(shards(" 3/3", " 1/4"))).toBe(neither);
    for (const list of [[""], ["", " 1/3", " 2/3", " 3/3"], [" 1/3", " 2/3", " 3/3", " 3/3"], [" 1/4", " 2/4", " 3/4", " 4/4", " 4/4"], ["", ""], [" 1/2", " 2/2"], [" 1/4", " 2/4", " 3/4", " 4/4", " 5/4"], [" 0/4", " 1/4", " 2/4", " 3/4"], [" 1/1"], ["  1/4", " 2/4", " 3/4", " 4/4"]]) {
      expect(namesProblem(shards(...list))).toStartWith("the jobs are not ci.yml's (not ci.yml's, or there twice: ");
    }
  });
});

function clock() {
  let now = 1_700_000_000_000;
  const slept: number[] = [];
  const logged: string[] = [];
  return { now: () => now, sleep: async (ms: number) => { slept.push(ms); now += ms; }, log: (line: string) => { logged.push(line); }, slept, logged };
}

function github(answers: { runs: unknown[]; jobs?: unknown[] }) {
  const calls: string[] = [];
  const seen = { runs: 0, jobs: 0 };
  const read = async (path: string): Promise<unknown> => {
    calls.push(path);
    const kind = path === runsPath(commit) ? "runs" : path === jobsPath(commit, RUN) ? "jobs" : null;
    if (!kind) throw new Error(`unexpected path ${path}`);
    const list = answers[kind] ?? [];
    const answer = list[Math.min(seen[kind]++, list.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, calls };
}

const WAIT = 2_400_000;
const going = runs(listedRun({ status: "in_progress", conclusion: null }));
const some = withJob(SELF_HOSTED, { "Integration tests": { status: "in_progress", conclusion: null }, "Integration and browser": null });

describe("waiting for main's run", () => {
  it("takes a run that is already green without waiting", async () => {
    const api = github({ runs: [runs(listedRun())], jobs: [passed(SELF_HOSTED)] });
    const time = clock();
    expect(await reuse(commit, api.read, WAIT, time)).toEqual({ green: true, run: RUN, why: `main's CI run ${RUN} passed this commit` });
    expect(api.calls).toEqual([runsPath(commit), jobsPath(commit, RUN)]);
    expect(time.slept).toEqual([]);
  });

  it("waits for a run still going and takes it once it passed", async () => {
    const api = github({ runs: [runs(listedRun({ status: "queued", conclusion: null })), going, going, runs(listedRun())], jobs: [jobs([]), some, passed(SELF_HOSTED)] });
    const time = clock();
    expect(await reuse(commit, api.read, WAIT, time)).toEqual({ green: true, run: RUN, why: `main's CI run ${RUN} passed this commit` });
    expect(time.slept).toEqual([20_000, 20_000, 20_000]);
    expect(time.logged).toEqual([`main's run ${RUN} is queued and no job of it has failed; asking again`, ...Array.from({ length: 2 }, () => `main's run ${RUN} is in_progress and no job of it has failed; asking again`)]);
  });

  it("runs CI as soon as a job of the run it waits for fails", async () => {
    const failed = withJob(SELF_HOSTED, { "Browser regression (ui-regression)": { conclusion: "failure" }, "Integration and browser": null });
    const api = github({ runs: [going], jobs: [some, some, failed] });
    const time = clock();
    expect(await reuse(commit, api.read, WAIT, time)).toEqual({ green: false, run: null, why: `"Browser regression (ui-regression)" ended "failure" in main's run ${RUN}`, failed: true });
    expect(time.slept).toEqual([20_000, 20_000]);
  });

  it("runs CI when the run it waits for ends without passing", async () => {
    const api = github({ runs: [going, runs(listedRun({ conclusion: "cancelled" }))], jobs: [some] });
    expect(await reuse(commit, api.read, WAIT, clock())).toEqual({ green: false, run: null, why: `main's run ${RUN} ended "cancelled"` });
    const failed = github({ runs: [going, runs(listedRun({ conclusion: "failure" }))], jobs: [some] });
    expect(await reuse(commit, failed.read, WAIT, clock())).toEqual({ green: false, run: null, why: `main's run ${RUN} ended "failure"`, failed: true });
  });

  it("stops waiting at the deadline, after a last look at it", async () => {
    const api = github({ runs: [going], jobs: [some] });
    const time = clock();
    const started = time.now();
    expect(await reuse(commit, api.read, WAIT, time)).toEqual({ green: false, run: null, why: `main's run ${RUN} is in_progress and no job of it has failed, 2400 s after this check began` });
    expect(time.now() - started).toBe(WAIT);
    expect(time.slept).toEqual(Array.from({ length: 120 }, () => 20_000));
    expect(api.calls).toHaveLength(121 * 2);

    const short = clock();
    await reuse(commit, github({ runs: [going], jobs: [some] }).read, 50_000, short);
    expect(short.slept).toEqual([20_000, 20_000, 10_000]);
  });

  it("takes a run that passes at the last look", async () => {
    const api = github({ runs: [going, going, going, runs(listedRun())], jobs: [some, some, some, passed(SELF_HOSTED)] });
    expect((await reuse(commit, api.read, 50_000, clock())).green).toBe(true);
  });

  it("does not wait at all without time to wait, and still takes a run already green", async () => {
    const time = clock();
    expect(await reuse(commit, github({ runs: [going], jobs: [some] }).read, 0, time)).toEqual({ green: false, run: null, why: `main's run ${RUN} is in_progress and no job of it has failed, 0 s after this check began` });
    expect(time.slept).toEqual([]);
    expect((await reuse(commit, github({ runs: [runs(listedRun())], jobs: [passed(SELF_HOSTED)] }).read, 0, clock())).green).toBe(true);
  });

  it("does not wait for a run behind another run of main, for none, or for one it may not take", async () => {
    for (const [answer, reason] of [
      [runs(listedRun({ status: "pending", conclusion: null })), `main's run ${RUN} is "pending", which is not a run to wait for`],
      [runs(), "main has no push run of ci.yml for this commit"],
      [runs(listedRun({ status: "in_progress", conclusion: null, run_attempt: 3 })), `main's run ${RUN} is on attempt 3, and only a first or second attempt counts`],
      [runs(listedRun({ status: "in_progress", conclusion: null, event: "workflow_dispatch" })), `run ${RUN}: event is "workflow_dispatch", not push`],
    ] as const) {
      const api = github({ runs: [answer], jobs: [passed(SELF_HOSTED)] });
      const time = clock();
      expect(await reuse(commit, api.read, WAIT, time)).toEqual({ green: false, run: null, why: reason });
      expect(api.calls).toEqual([runsPath(commit)]);
      expect(time.slept).toEqual([]);
    }
  });

  it("asks again after GitHub fails once or twice", async () => {
    const down = new Error("GitHub answered 502");
    const time = clock();
    expect((await reuse(commit, github({ runs: [down, runs(listedRun())], jobs: [passed(SELF_HOSTED)] }).read, WAIT, time)).green).toBe(true);
    expect(time.slept).toEqual([5_000]);
    expect(time.logged).toEqual(["GitHub could not be read (GitHub answered 502); asking again"]);

    const twice = clock();
    expect((await reuse(commit, github({ runs: [runs(listedRun())], jobs: [down, down, passed(SELF_HOSTED)] }).read, WAIT, twice)).green).toBe(true);
    expect(twice.slept).toEqual([5_000, 5_000]);
  });

  it("runs CI after GitHub fails three times in a row", async () => {
    const down = new Error("The operation timed out.");
    const api = github({ runs: [down] });
    const time = clock();
    expect(await reuse(commit, api.read, WAIT, time)).toEqual({ green: false, run: null, why: "GitHub could not be read (The operation timed out.), 3 times in a row" });
    expect(api.calls).toHaveLength(3);
    expect(time.slept).toEqual([5_000, 5_000]);
    expect((await reuse(commit, github({ runs: [runs(listedRun())], jobs: [down] }).read, WAIT, clock())).why).toEndWith("3 times in a row");
  });

  it("counts only failures in a row", async () => {
    const down = new Error("GitHub answered 503");
    const api = github({ runs: [down, going, down, going, down, going, down, runs(listedRun())], jobs: [some, some, some, passed(SELF_HOSTED)] });
    const time = clock();
    expect((await reuse(commit, api.read, WAIT, time)).green).toBe(true);
    expect(time.slept).toEqual([5_000, 20_000, 5_000, 20_000, 5_000, 20_000, 5_000]);
  });

  it("keeps a failure's text on one line, in what it logs and in its answer", async () => {
    const down = new Error("socket closed\n::error::forged\r\n  by a proxy");
    const time = clock();
    expect(await reuse(commit, github({ runs: [down] }).read, WAIT, time))
      .toEqual({ green: false, run: null, why: "GitHub could not be read (socket closed ::error::forged by a proxy), 3 times in a row" });
    expect(time.logged).toEqual(Array.from({ length: 2 }, () => "GitHub could not be read (socket closed ::error::forged by a proxy); asking again"));
  });

  it("stops asking a GitHub that keeps failing once the time to wait is over", async () => {
    const time = clock();
    expect(await reuse(commit, github({ runs: [new Error("GitHub answered 500")] }).read, 4_000, time))
      .toEqual({ green: false, run: null, why: "GitHub could not be read (GitHub answered 500), 4 s after this check began" });
    expect(time.slept).toEqual([4_000]);
  });
});

function http(answers: Record<string, Array<[number, string] | Error>>) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const seen: Record<string, number> = {};
  const get: Get = async (url, init) => {
    requests.push({ url, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const list = answers[url];
    if (!list) return new Response("Not Found", { status: 404 });
    const answer = list[Math.min(seen[url] = (seen[url] ?? -1) + 1, list.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return new Response(answer[1], { status: answer[0] });
  };
  return { get, requests };
}
const API = "https://api.github.com";
const RUNS_URL = `${API}${runsPath(commit)}`;
const JOBS_URL = `${API}${jobsPath(commit, RUN)}`;
const ok = (body: unknown): [number, string] => [200, JSON.stringify(body)];
const green = { [RUNS_URL]: [ok(runs(listedRun()))], [JOBS_URL]: [ok(passed(SELF_HOSTED))] };
const ENV = { GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GH_TOKEN: "t0ken", REVALIDATE: "false", RELEASE_CI_WAIT_SECONDS: "2400" };

describe("the reuse job's environment", () => {
  it("reads GitHub's API with the job's token and takes a green run", async () => {
    const api = http(green);
    expect(await main(ENV, { ...clock(), get: api.get })).toEqual({ green: true, run: RUN, why: `main's CI run ${RUN} passed this commit` });
    expect(api.requests.map((request) => request.url)).toEqual([RUNS_URL, JOBS_URL]);
    for (const request of api.requests) {
      expect(request.headers.authorization).toBe("Bearer t0ken");
      expect(request.headers.accept).toBe("application/vnd.github+json");
    }
  });

  it("reads the API the runner names, and without a token when it has none", async () => {
    const api = http({ [`http://ghe.test/api/v3${runsPath(commit)}`]: [ok(runs(listedRun()))], [`http://ghe.test/api/v3${jobsPath(commit, RUN)}`]: [ok(passed(HOSTED))] });
    expect((await main({ ...ENV, GITHUB_API_URL: "http://ghe.test/api/v3", GH_TOKEN: "" }, { ...clock(), get: api.get })).green).toBe(true);
    expect(api.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("answers no without asking GitHub when the Release run asks for the whole CI", async () => {
    for (const REVALIDATE of ["true", "True", "1", "yes", " "]) {
      const api = http(green);
      expect(await main({ ...ENV, REVALIDATE }, { ...clock(), get: api.get })).toEqual({ green: false, run: null, why: "the revalidate input asks for the whole CI in this run" });
      expect(api.requests).toEqual([]);
    }
    for (const REVALIDATE of ["false", "", undefined]) expect((await main({ ...ENV, REVALIDATE }, { ...clock(), get: http(green).get })).green).toBe(true);
  });

  it("answers no without a repository and a full commit id to ask about", async () => {
    for (const over of [{ GITHUB_SHA: undefined }, { GITHUB_SHA: SHA.slice(0, 7) }, { GITHUB_SHA: "main" }, { GITHUB_SHA: `${SHA}&event=pull_request` }, { GITHUB_REPOSITORY: undefined }, { GITHUB_REPOSITORY: "ovis" }, { GITHUB_REPOSITORY: `${REPO}/../x` }]) {
      const api = http(green);
      expect(await main({ ...ENV, ...over }, { ...clock(), get: api.get })).toEqual({ green: false, run: null, why: "GITHUB_REPOSITORY or GITHUB_SHA does not name a commit" });
      expect(api.requests).toEqual([]);
    }
  });

  it("answers no after an answer that is not 2xx, or not JSON, three times", async () => {
    for (const [answer, reason] of [
      [[500, "{}"], "GitHub answered 500"], [[403, JSON.stringify({ message: "API rate limit exceeded" })], "GitHub answered 403"], [[404, "{}"], "GitHub answered 404"],
      [[200, "<html>Unicorn!</html>"], "GitHub's answer is not JSON"], [[200, ""], "GitHub's answer is not JSON"], [[200, JSON.stringify(runs(listedRun())).slice(0, 40)], "GitHub's answer is not JSON"],
      [new Error("fetch failed"), "fetch failed"],
    ] as const) {
      const api = http({ [RUNS_URL]: [answer as [number, string] | Error] });
      expect(await main(ENV, { ...clock(), get: api.get })).toEqual({ green: false, run: null, why: `GitHub could not be read (${reason}), 3 times in a row` });
      expect(api.requests).toHaveLength(3);
    }
    const api = http({ [RUNS_URL]: [[502, ""], ok(runs(listedRun()))], [JOBS_URL]: [[200, "{"], ok(passed(SELF_HOSTED))] });
    expect((await main(ENV, { ...clock(), get: api.get })).green).toBe(true);
  });

  it("ends a call GitHub never answers after 20 seconds, and answers no after three of them", async () => {
    const asked: number[] = [];
    const ended: Error[] = [];
    const hung: Get = (_url, init) => new Promise((_resolve, reject) => {
      const { signal } = init;
      if (!signal) { reject(new Error("the call carries no signal")); return; }
      const end = (): void => { ended.push(signal.reason as Error); reject(signal.reason); };
      if (signal.aborted) end(); else signal.addEventListener("abort", end, { once: true });
    });
    const outcome = await main(ENV, { ...clock(), get: hung, timeout: (ms) => { asked.push(ms); return AbortSignal.timeout(5); } });
    expect(asked).toEqual([20_000, 20_000, 20_000]);
    expect(ended.map((reason) => reason.name)).toEqual(["TimeoutError", "TimeoutError", "TimeoutError"]);
    expect(outcome).toEqual({ green: false, run: null, why: `GitHub could not be read (${ended[0]!.message}), 3 times in a row` });

    const api = http(green);
    const signals: Array<AbortSignal | null | undefined> = [];
    expect((await main(ENV, { ...clock(), get: (url, init) => { signals.push(init.signal); return api.get(url, init); } })).green).toBe(true);
    expect(signals.map((signal) => signal instanceof AbortSignal && !signal.aborted)).toEqual([true, true]);
  });

  it("answers no instead of throwing, on one line", async () => {
    const broken = { ...clock(), sleep: async () => { throw new Error("no timer\n::error::forged"); }, get: http({ [RUNS_URL]: [ok(going)], [JOBS_URL]: [ok(some)] }).get };
    expect(await main(ENV, broken)).toEqual({ green: false, run: null, why: "the check itself failed (no timer ::error::forged)" });
  });

  it("answers no at once to JSON that is not what the API answers", async () => {
    for (const body of ["null", "[]", "{}", JSON.stringify({ message: "Not Found" }), JSON.stringify({ total_count: 1 })]) {
      const api = http({ [RUNS_URL]: [[200, body]] });
      expect(await main(ENV, { ...clock(), get: api.get })).toEqual({ green: false, run: null, why: "GitHub's list of runs is not { total_count, workflow_runs }" });
      expect(api.requests).toHaveLength(1);
    }
  });

  it("waits RELEASE_CI_WAIT_SECONDS for a run still going, 40 minutes by default, and not at all for a value it cannot read", async () => {
    const still = { [RUNS_URL]: [ok(going)], [JOBS_URL]: [ok(some)] };
    for (const [seconds, waited] of [[undefined, 2_400_000], ["", 2_400_000], ["2400", 2_400_000], ["1200", 1_200_000], ["60", 60_000], ["0", 0], ["40m", 0], ["-5", 0], ["1e3", 0], ["999999", 0]] as const) {
      const time = clock();
      const outcome = await main({ ...ENV, RELEASE_CI_WAIT_SECONDS: seconds }, { ...time, get: http(still).get });
      expect(outcome.green).toBe(false);
      expect(time.slept.reduce((sum, ms) => sum + ms, 0)).toBe(waited);
    }
    expect((await main({ ...ENV, RELEASE_CI_WAIT_SECONDS: "40m" }, { ...clock(), get: http(green).get })).green).toBe(true);
  });

});

describe("the answer for $GITHUB_OUTPUT", () => {
  it("is a yes with its run, or a no without one", () => {
    expect(outputLines({ green: true, run: RUN, why: "" })).toBe(`green=true\nrun=${RUN}\n`);
    expect(outputLines({ green: false, run: null, why: "" })).toBe("green=false\nrun=\n");
    expect(outputLines({ green: false, run: RUN, why: "" })).toBe("green=false\nrun=\n");
  });

  it("is never a yes without a run id that is a whole number", () => {
    for (const run of [null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "42\ngreen=true" as unknown as number]) {
      expect(outputLines({ green: true, run, why: "" })).toBe("green=false\nrun=\n");
    }
    expect(outputLines({ green: "true" as unknown as boolean, run: RUN, why: "" })).toBe("green=false\nrun=\n");
  });
});

describe("the script as the reuse job runs it", () => {
  const made: string[] = [];
  afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });

  async function run(env: Record<string, string>, respond?: (url: URL, request: Request) => Response) {
    const dir = mkdtempSync(join(tmpdir(), "release-ci-reuse-"));
    made.push(dir);
    const requests: Array<{ path: string; authorization: string | null }> = [];
    const server = respond && Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        requests.push({ path: url.pathname + url.search, authorization: request.headers.get("authorization") });
        return respond(url, request);
      },
    });
    try {
      const child = Bun.spawn([process.execPath, join(root, "scripts/release-ci-reuse.ts")], {
        cwd: dir, stdout: "pipe", stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "", HOME: dir, GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA, GH_TOKEN: "t0ken", GITHUB_SERVER_URL: "https://github.com",
          GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_API_URL: server ? `http://127.0.0.1:${server.port}` : "http://127.0.0.1:1", RELEASE_CI_WAIT_SECONDS: "0", ...env,
        },
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      let summary = "";
      try { summary = readFileSync(join(dir, "summary.md"), "utf8"); } catch { /* none written */ }
      return { stdout, stderr, code, summary, requests, dir };
    } finally {
      await server?.stop(true);
    }
  }
  const answers = (url: URL): Response => Response.json(url.pathname.endsWith("/jobs") ? passed(SELF_HOSTED) : runs(listedRun()));

  it("prints the yes and its run for $GITHUB_OUTPUT, and nothing else on stdout", async () => {
    const result = await run({}, answers);
    expect(result.stdout).toBe(`green=true\nrun=${RUN}\n`);
    expect(result.code).toBe(0);
    expect(result.requests).toEqual([{ path: runsPath(commit), authorization: "Bearer t0ken" }, { path: jobsPath(commit, RUN), authorization: "Bearer t0ken" }]);
    expect(result.stderr).toBe(`::notice title=Release validation::main's CI run ${RUN} passed this commit: this run does not run CI again.\n`);
    expect(result.summary).toBe(`### Release validation\n\nmain's CI run ${RUN} passed this commit: this run does not run CI again.\n\nhttps://github.com/${REPO}/actions/runs/${RUN}\n`);
  }, 30_000);

  it("prints a no, warns that main's run failed and exits 0", async () => {
    const result = await run({}, (url) => Response.json(url.pathname.endsWith("/jobs") ? passed(SELF_HOSTED) : runs(listedRun({ conclusion: "failure" }))));
    expect(result.stdout).toBe("green=false\nrun=\n");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe(`::warning title=Release validation::Running CI in this run: main's run ${RUN} ended "failure".\n`);
    expect(result.summary).toBe(`### Release validation\n\nRunning CI in this run: main's run ${RUN} ended "failure".\n`);
  }, 30_000);

  it("prints a no and exits 0 when GitHub fails, cannot be reached, or the job's own files cannot be written", async () => {
    const failing = await run({}, () => new Response("down", { status: 500 }));
    expect([failing.stdout, failing.code]).toEqual(["green=false\nrun=\n", 0]);
    expect(failing.stderr).toContain("::notice title=Release validation::Running CI in this run: GitHub could not be read (GitHub answered 500)");

    const unreachable = await run({});
    expect([unreachable.stdout, unreachable.code]).toEqual(["green=false\nrun=\n", 0]);
    expect(unreachable.stderr).toContain("GitHub could not be read (");

    const summary = mkdtempSync(join(tmpdir(), "release-ci-reuse-summary-"));
    made.push(summary);
    mkdirSync(join(summary, "summary.md"));
    const unwritable = await run({ GITHUB_STEP_SUMMARY: join(summary, "summary.md") }, answers);
    expect([unwritable.stdout, unwritable.code]).toEqual([`green=true\nrun=${RUN}\n`, 0]);
  }, 30_000);

  it("says that it waits and that it asks again on stderr: stdout holds the answer alone", async () => {
    const second = { RELEASE_CI_WAIT_SECONDS: "1" };
    let failed = false;
    let looks = 0;
    const [retried, waited] = await Promise.all([
      run(second, (url) => {
        if (failed) return answers(url);
        failed = true;
        return new Response("Bad Gateway", { status: 502 });
      }),
      run(second, (url) => {
        const listing = !url.pathname.endsWith("/jobs");
        if (listing) looks += 1;
        if (looks > 1) return answers(url);
        return Response.json(listing ? going : some);
      }),
    ]);
    const taken = `::notice title=Release validation::main's CI run ${RUN} passed this commit: this run does not run CI again.\n`;
    expect(retried.requests.map((request) => request.path)).toEqual([runsPath(commit), runsPath(commit), jobsPath(commit, RUN)]);
    expect(retried.stderr).toBe(`GitHub could not be read (GitHub answered 502); asking again\n${taken}`);
    expect([retried.stdout, retried.code]).toEqual([`green=true\nrun=${RUN}\n`, 0]);
    expect(waited.requests.map((request) => request.path)).toEqual([runsPath(commit), jobsPath(commit, RUN), runsPath(commit), jobsPath(commit, RUN)]);
    expect(waited.stderr).toBe(`main's run ${RUN} is in_progress and no job of it has failed; asking again\n${taken}`);
    expect([waited.stdout, waited.code]).toEqual([`green=true\nrun=${RUN}\n`, 0]);
  }, 30_000);

  it("keeps a name GitHub sent on the one line of its message, where a line of its own could be a workflow command", async () => {
    const forged = "\n::error title=Release validation::forged\r\n::set-output name=green::true";
    const shown = String.raw`\n::error title=Release validation::forged\r\n::set-output name=green::true`;
    const branch = await run({}, (url) => Response.json(url.pathname.endsWith("/jobs") ? passed(SELF_HOSTED) : runs(listedRun({ head_branch: `main${forged}` }))));
    const named = await run({}, (url) => Response.json(url.pathname.endsWith("/jobs") ? withJob(SELF_HOSTED, { "Fast checks": { name: `Fast checks${forged}`, conclusion: "failure" } }) : runs(listedRun())));
    for (const [result, level, message] of [
      [branch, "notice", `Running CI in this run: run ${RUN}: head_branch is "main${shown}", not main.`],
      [named, "warning", `Running CI in this run: "Fast checks${shown}" ended "failure" in main's run ${RUN}.`],
    ] as const) {
      expect([result.stdout, result.code]).toEqual(["green=false\nrun=\n", 0]);
      expect(result.stderr).toBe(`::${level} title=Release validation::${message}\n`);
      expect(result.summary).toBe(`### Release validation\n\n${message}\n`);
      // the same as a rule: the message is one line, and the annotation's own is the only command
      expect(message).not.toMatch(/[\r\n]/);
      expect(result.stderr.match(/^\s*::/gm)).toEqual(["::"]);
      expect(result.summary.match(/^\s*::/gm)).toBeNull();
    }
  }, 30_000);

  it("prints a no without asking GitHub when REVALIDATE is true, or the commit is not named", async () => {
    const forced = await run({ REVALIDATE: "true" }, answers);
    expect([forced.stdout, forced.code, forced.requests]).toEqual(["green=false\nrun=\n", 0, []]);
    expect(forced.stderr).toBe("::notice title=Release validation::Running CI in this run: the revalidate input asks for the whole CI in this run.\n");
    const unnamed = await run({ GITHUB_SHA: "" }, answers);
    expect([unnamed.stdout, unnamed.code, unnamed.requests]).toEqual(["green=false\nrun=\n", 0, []]);
  }, 30_000);
});

describe("runs of devswha/ovis", () => {
  const real = (id: number, sha: string, status: string, conclusion: string | null, attempt: number, listed: Array<[string, string]>) => {
    const at = { repository: REPO, sha };
    const run = pushRun(runs(listedRun({ id, head_sha: sha, status, conclusion, run_attempt: attempt })), at) as Run;
    const answer = jobs(listed.map(([name, ended]) => listedJob(name, { run_id: id, run_attempt: attempt, head_sha: sha, conclusion: ended })));
    return runProblem(run) ?? jobsFinding(answer, run, at);
  };
  const all = (names: string[], changed: Record<string, string> = {}): Array<[string, string]> => names.map((name) => [name, changed[name] ?? "success"]);

  it("takes 42426987381, green on its first attempt", () => {
    expect(real(RUN, SHA, "completed", "success", 1, all(SELF_HOSTED))).toEqual(yes);
  });

  it("takes 42754144490, green on its second attempt: GitHub lists that attempt's jobs", () => {
    const order = split(["Browser regression (ui-regression)", "Detect changes", "Integration tests", "Rust PTY host", ONE_JOB, "Native macOS session identity", "herdr-core live contract", "Fast checks", "Native Windows install", "Integration and browser"]);
    expect(real(42754144490, "6cb6f6c787e6d02b55dfed36173cf9db5c7599c5", "completed", "success", 2, all(order))).toEqual({ answer: "yes", run: 42754144490 });
  });

  it("refuses 42747049603, cancelled before a job started", () => {
    expect(real(42747049603, "6fa11f403f396adeccbdc95553e54b3cbcb1df9d", "completed", "cancelled", 1, [])).toEqual({ answer: "no", why: `main's run 42747049603 ended "cancelled"` });
  });

  it("refuses 42632441834: the three required checks passed, the macOS job was cancelled", () => {
    const order = split(["Detect changes", "Native Windows install", "Native macOS session identity", "Integration tests", ONE_JOB, "Fast checks", "Rust PTY host", "herdr-core live contract", "Browser regression (ui-regression)", "Integration and browser"]);
    const listed = all(order, { "Native macOS session identity": "cancelled" });
    const sha = "2d6f32a1a29dc712815be26a7a0f4fb8ae9d6ea3";
    expect(real(42632441834, sha, "completed", "failure", 1, listed)).toEqual({ answer: "no", why: `main's run 42632441834 ended "failure"`, failed: true });
    expect(real(42632441834, sha, "completed", "success", 1, listed)).toEqual({ answer: "no", why: `"Native macOS session identity" ended "cancelled" in main's run 42632441834` });
  });

  it("does not wait for 42762912773, pending behind the run of the commit before it", () => {
    expect(real(42762912773, "4bb57ec21622336d57deb4e428b4902838dc7cc7", "pending", null, 1, [])).toEqual({ answer: "no", why: `main's run 42762912773 is "pending", which is not a run to wait for` });
  });
});

describe("ci.yml", () => {
  interface CiStep { id?: string; name?: string; if?: string; run?: string; env?: Record<string, string> }
  interface CiJob { name?: string; if?: string; uses?: string; outputs?: Record<string, string>; strategy?: { matrix?: Record<string, unknown> }; steps?: CiStep[] }
  const ci = Bun.YAML.parse(readFileSync(join(root, CI_WORKFLOW), "utf8")) as { on: Record<string, unknown>; jobs: Record<string, CiJob> };
  const UPDATE = "Update CI_JOBS, CI_MATRIX_JOB or CI_SHARD_COUNTS in scripts/release-ci-reuse.ts to ci.yml's jobs, so a Release run can still take main's CI run";

  it("runs on a push to main", () => {
    expect((ci.on["push"] as { branches?: string[] }).branches).toEqual(["main"]);
  });

  it("has exactly the jobs the check requires, under the names its runs list", () => {
    const names = Object.entries(ci.jobs).map(([id, job]) => job.name ?? id);
    expect([...names].sort(), UPDATE).toEqual([...CI_JOBS, CI_MATRIX_JOB].sort());
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((name) => name.includes("${{")), UPDATE).toEqual([CI_MATRIX_JOB]);
  });

  it("has one matrix job, of three, four or five parts", () => {
    const matrix = Object.values(ci.jobs).filter((job) => job.strategy !== undefined);
    expect(matrix.map((job) => job.name), UPDATE).toEqual([CI_MATRIX_JOB]);
    expect(Object.keys(matrix[0]!.strategy!.matrix!), UPDATE).toEqual(["shard"]);
    const shard = matrix[0]!.strategy!.matrix!["shard"] as string;
    const lists = [...shard.matchAll(/'(\[[\d,\s]*\])'/g)].map((match) => JSON.parse(match[1]!) as number[]);
    for (const list of lists) expect(list).toEqual(Array.from({ length: list.length }, (_, index) => index + 1));
    expect(lists.map((list) => list.length).sort(), UPDATE).toEqual([...CI_SHARD_COUNTS].sort());
    expect(shard.replace(/'\[[\d,\s]*\]'/g, "'[]'")).toBe("${{ fromJSON(contains(needs.changes.outputs.linux, 'ovis-vm') && '[]' || contains(needs.changes.outputs.linux, 'self-hosted') && '[]' || '[]') }}");
  });

  it("calls no other workflow, whose jobs a run would list under another name", () => {
    expect(Object.entries(ci.jobs).filter(([, job]) => job.uses !== undefined).map(([id]) => id), UPDATE).toEqual([]);
  });

  it("gives a job only a condition that a push run meets", () => {
    const met = [undefined, "needs.changes.outputs.code == 'true'", "needs.changes.outputs.code == 'true' && needs.changes.outputs.browser != 'false'", "needs.changes.outputs.code == 'true' && needs.changes.outputs.server != 'false'", "always()"];
    const conditional = Object.entries(ci.jobs).filter(([, job]) => !met.includes(job.if)).map(([id, job]) => `${id}: ${job.if}`);
    expect(conditional, "A push run of main may skip these jobs, and a skipped job is not a passed one: a Release run would then never take main's run. Give the job a condition a push always meets, or teach scripts/release-ci-reuse.ts which jobs a push run skips").toEqual([]);
    expect(ci.jobs["changes"]!.if).toBeUndefined();
    expect(ci.jobs["changes"]!.outputs).toMatchObject({ code: "${{ steps.filter.outputs.code }}", browser: "${{ steps.filter.outputs.browser }}", draft: "${{ steps.filter.outputs.draft }}" });
  });

  const HOSTED_ONLY_READS = [
    "${{ inputs.hosted_only && 'ubuntu-24.04' || fromJSON(needs.changes.outputs.fast) }}",
    "${{ inputs.hosted_only && 'ubuntu-24.04' || fromJSON(needs.changes.outputs.linux) }}",
    "${{ inputs.hosted_only && 'ubuntu-24.04' || fromJSON(needs.changes.outputs.integration) }}",
    "${{ inputs.hosted_only && 'ubuntu-24.04' || fromJSON(needs.changes.outputs.rust) }}",
    "${{ inputs.hosted_only && 'windows-latest' || fromJSON(needs.changes.outputs.windows) }}",
    "${{ inputs.hosted_only && 'none' || 'save' }}",
    "${{ inputs.hosted_only && 'none' || 'restore' }}",
    "needs.changes.outputs.draft != 'true' && !inputs.hosted_only",
    "needs.changes.outputs.draft != 'true' && runner.environment != 'self-hosted' && !inputs.hosted_only",
    "${{ inputs.hosted_only }}",
  ];

  it("passes hosted_only: true in a Release run's call, which moves runners and caches only", () => {
    const validate = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/release-validate.yml"), "utf8")) as { jobs: Record<string, { uses?: string; with?: Record<string, unknown> }> };
    const calls = Object.values(validate.jobs).filter((job) => job.uses === "./.github/workflows/ci.yml");
    expect(calls.length).toBe(1);
    expect(calls[0]!.with?.["hosted_only"]).toBe(true);
  });

  it("fetches the ratchets' base on every run that reaches check fast, and before it", () => {
    const steps = ci.jobs["fast"]!.steps!;
    const fetchBase = steps.findIndex((step) => step.name === "Fetch the base the ratchets compare with");
    const checkFast = steps.findIndex((step) => step.run?.trim() === "bun run check fast");
    expect(fetchBase, "Name Fast checks' step that fetches the ratchets' base `Fetch the base the ratchets compare with`").not.toBe(-1);
    expect(checkFast, "Run the check in Fast checks' step `bun run check fast`").not.toBe(-1);
    // no `if:` at all, as every step of this job but the artifact upload has: `always()` and `success()` run on a push too
    expect([undefined, "always()", "success()"], "A condition that may be false leaves the ratchets comparing with nothing while the run still passes: the fetch takes no `if:`, or one a push run meets").toContain(steps[fetchBase]!.if);
    expect(fetchBase, "The fetch hands RATCHET_BASE to check fast, so it has to come before it").toBeLessThan(checkFast);
  });

  it("gives no step a condition on the event, which differs between a push run and Release's own", () => {
    const reading = Object.entries(ci.jobs).flatMap(([id, job]) => (job.steps ?? []).filter((step) => /\b(?:github|inputs)\./.test(step.if ?? "") && !HOSTED_ONLY_READS.includes(step.if!)).map((step) => `${id}: ${step.if}`));
    expect(reading, "A step that runs for some events only makes main's push run check something else than the Release run's own ci.yml: decide in Detect changes instead, as code and draft are").toEqual([]);
  });

  const LIGHT = "${{ inputs.hosted_only && 'ubuntu-24.04' || github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04' || fromJSON(github.ref == 'refs/heads/main' && vars.CI_MAIN_SELF_HOSTED_LABELS || vars.CI_LIGHT_LABELS || vars.CI_SELF_HOSTED_LABELS || '[\"self-hosted\",\"self-hosted-ovis\"]') }}";
  const EVENT_READS: Record<string, string> = {
    "concurrency.group": "validation-${{ github.workflow }}-${{ github.ref }}${{ github.event_name == 'workflow_dispatch' && '-manual' || '' }}",
    "concurrency.cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    "jobs.changes.runs-on": LIGHT,
    // GitHub-hosted unless CI_HC_LIVE_LABELS moves it; the event only keeps a fork's pull request hosted
    "jobs.herdr-core-live.runs-on": "${{ inputs.hosted_only && 'ubuntu-24.04' || github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'ubuntu-24.04' || fromJSON(vars.CI_HC_LIVE_LABELS || '\"ubuntu-24.04\"') }}",
    "jobs.integration-browser.runs-on": LIGHT,
    "jobs.macos-session.runs-on": "${{ inputs.hosted_only && 'macos-15' || github.event.pull_request && github.event.pull_request.head.repo.full_name != github.repository && 'macos-15' || fromJSON(github.workflow == 'CI' && vars.CI_MAC_LABELS || '\"macos-15\"') }}",
    "jobs.changes.steps.route.env.EVENT_NAME": "${{ github.event_name }}",
    "jobs.changes.steps.route.env.HEAD_REPO": "${{ github.event.pull_request.head.repo.full_name }}",
    // only which machine a draft's Native Windows install fails on: empty for a push to main and for a Release run alike
    "jobs.changes.steps.route.env.PR_DRAFT": "${{ github.event.pull_request.draft }}",
    "jobs.changes.steps.route.env.REQUESTED_LABELS": "${{ inputs.self_hosted_labels }}",
    "jobs.changes.steps.filter.env.EVENT_NAME": "${{ github.event_name }}",
    "jobs.changes.steps.filter.env.PR_DRAFT": "${{ github.event.pull_request.draft }}",
    "jobs.changes.steps.filter.env.BASE_SHA": "${{ github.event.pull_request.base.sha }}",
    // which pull request's installer Native Windows install runs for real: empty for a push to main and a Release run alike
    "jobs.changes.steps.filter.env.HEAD_SHA": "${{ github.event.pull_request.head.sha }}",
    "jobs.changes.steps.filter.env.HEAD_REPO": "${{ github.event.pull_request.head.repo.full_name }}",
    "jobs.fast.steps.Release guards.env.BASE_SHA": "${{ github.event.pull_request.base.sha || github.event.before }}",
    "jobs.fast.env.EVENT_BASE": "${{ github.event.pull_request.base.sha || github.event.before }}",
    // the last main commit whose CI passed, for a push to main only: a Release run's caller is no push, so it finds none
    "jobs.changes.steps.ratchet.env.EVENT_NAME": "${{ github.event_name }}",
  };

  it("never runs a Release run's own jobs on the self-hosted Mac: CI_MAC_LABELS is read only in ci.yml's own runs and in pull requests", () => {
    const dir = join(root, ".github/workflows");
    const reads = readdirSync(dir).filter((name) => name.endsWith(".yml"))
      .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n").filter((line) => line.includes("CI_MAC_LABELS") && !line.trimStart().startsWith("#")).map((line) => `${name}: ${line.trim()}`));
    const pullRequestOnly = "runs-on: ${{ fromJSON(matrix.os == 'macos-15' && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && vars.CI_MAC_LABELS || toJSON(matrix.os)) }}";
    expect([...reads].sort()).toEqual([
      `ci.yml: runs-on: ${String((ci.jobs["macos-session"] as CiJob & { "runs-on"?: string })["runs-on"])}`,
      `pty-sidecar.yml: ${pullRequestOnly}`,
      `remote-bundles-platforms.yml: ${pullRequestOnly}`,
      `remote-bundles.yml: ${pullRequestOnly}`,
    ]);
    const ciRead = reads.find((read) => read.startsWith("ci.yml: "))!;
    expect(ciRead).toContain("inputs.hosted_only && 'macos-15' || ");
    expect(ciRead).toContain("fromJSON(github.workflow == 'CI' && vars.CI_MAC_LABELS || '\"macos-15\"')");
  });

  it("reads the event and the run's inputs only where a push run may differ from Release's own", () => {
    const EVENT = /\bgithub\.event\w*|\bgithub\s*\[|\(\s*github\s*\)|\binputs\b/;
    const expressions = (key: string, value: string): string => (key === "if" ? value : [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]).join("\n"));
    const found: Record<string, string> = {};
    const scan = (value: unknown, path: string[]): void => {
      if (typeof value === "string") {
        if (EVENT.test(expressions(path.at(-1)!, value)) && !HOSTED_ONLY_READS.includes(value)) found[path.join(".")] = value;
      } else if (Array.isArray(value)) {
        value.forEach((entry: CiStep | null, index) => scan(entry, [...path, entry?.id ?? entry?.name ?? String(index)]));
      } else if (typeof value === "object" && value !== null) {
        for (const [key, entry] of Object.entries(value)) scan(entry, [...path, key]);
      }
    };
    for (const [key, value] of Object.entries(ci)) if (key !== "on") scan(value, [key]);
    expect(found, "ci.yml reads the event or the run's inputs somewhere new, or no longer where it did. Main's push run and the Release run's own ci.yml differ exactly there: list the place in EVENT_READS with why a Release run may still take main's run, or decide in Detect changes instead, as code and draft are").toEqual(EVENT_READS);
    for (const [key, value, read] of [
      ["if", "github.event_name == 'push'", true], ["if", "needs.changes.outputs.draft != 'true'", false], ["if", "inputs.self_hosted_labels != ''", true],
      ["run", "echo \"${{ github.event.before }}\"", true], ["run", "# where github.event_name is the caller's event\necho inputs.x", false],
      ["env", "${{ github.event_path }}", true], ["env", "${{ github['event_name'] }}", true], ["env", "${{ toJSON(github) }}", true], ["env", "${{ github.sha }}-${{ github.run_id }}", false],
      ["if", "toJSON(inputs.hosted_only) == 'false'", true],
    ] as const) expect([key, value, EVENT.test(expressions(key, value)) && !HOSTED_ONLY_READS.includes(value)]).toEqual([key, value, read]);
  });

  const EVENT_VARIABLE_READS = [
    // A release that takes main's run takes that restored build for
    // the Integration and Browser jobs (docs/development.md#releasing); an entry is one a job of
    // that same run built, named after the commit and everything else the build reads, and a
    // restore checks every file's sha256
    "scripts/build-cache.ts",
    "scripts/check-report.ts", "scripts/check.ts",
    "scripts/self-hosted-runner/job-started.sh",
    "scripts/build-cache.test.ts", "scripts/check-report.test.ts", "scripts/check.test.ts", "scripts/pr-title.test.ts", "scripts/self-hosted-runner.test.ts",
    "scripts/self-hosted-runner/hook-test-harness.sh",
  ];

  it("reads the event from the runner's environment only where a push run may differ from Release's own", () => {
    const reading = files("{src,shared,server,scripts,telemetry,push-relay,relay,integrations,tui}/**/*.{ts,tsx,js,mjs,cjs,sh}")
      .filter((file) => file !== "scripts/release-ci-reuse.test.ts" && /\bGITHUB_EVENT_(?:NAME|PATH)\b/.test(read(file)));
    expect(reading, "A script or a test reads the event from the runner's environment somewhere new, or no longer where it did. What it does with it differs between main's push run and the Release run's own ci.yml: list the file in EVENT_VARIABLE_READS with why a Release run may still take main's run").toEqual([...EVENT_VARIABLE_READS].sort());
    expect(read(".github/actions/setup-ci/action.yml")).not.toMatch(/\bgithub\.event|\bGITHUB_EVENT_/);
  });

  it.skipIf(process.platform === "win32")("runs CI for pushes and server fixture changes and skips heavy checks for docs-only PRs", async () => {
    const filter = ci.jobs["changes"]!.steps!.find((step) => step.id === "filter")!;
    expect(filter.env).toEqual({ EVENT_NAME: "${{ github.event_name }}", PR_DRAFT: "${{ github.event.pull_request.draft }}", BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}", HEAD_REPO: "${{ github.event.pull_request.head.repo.full_name }}", REPOSITORY: "${{ github.repository }}" });
    const dir = mkdtempSync(join(tmpdir(), "release-ci-reuse-filter-"));
    try {
      const git = (...args: string[]): string => {
        const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir } });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
      };
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "code");
      const base = git("rev-parse", "HEAD");
      mkdirSync(join(dir, "scripts"));
      copyFileSync(join(root, "scripts/ci-browser-reach.sh"), join(dir, "scripts/ci-browser-reach.sh"));
      copyFileSync(join(root, "scripts/ci-server-reach.sh"), join(dir, "scripts/ci-server-reach.sh"));
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "docs/guide.md"), "# Guide\n");
      git("add", "docs/guide.md");
      git("commit", "-q", "-m", "docs");
      const decided = async (env: Record<string, string>): Promise<string> => {
        const output = join(dir, "output");
        rmSync(output, { force: true });
        const result = await runScript(filter.run!, dir, { ...env, GITHUB_OUTPUT: output });
        expect(result.code).toBe(0);
        return readFileSync(output, "utf8");
      };
      for (const event of ["push", "workflow_dispatch"]) expect(await decided({ EVENT_NAME: event, PR_DRAFT: "", BASE_SHA: "" })).toBe("draft=false\ncode=true\nbrowser=true\n");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: base })).toBe("draft=false\ncode=false\nbrowser=true\nserver=true\n");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "true", BASE_SHA: base })).toBe("draft=true\ncode=false\nbrowser=true\nserver=true\n");

      const docsCommit = git("rev-parse", "HEAD");
      mkdirSync(join(dir, "server/fixtures"), { recursive: true });
      writeFileSync(join(dir, "server/fixtures/prompt.txt"), "Continue?\n");
      git("add", "server/fixtures/prompt.txt");
      git("commit", "-q", "-m", "update prompt fixture");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: docsCommit })).toBe("draft=false\ncode=true\nbrowser=true\nserver=true\n");

      const fixtureCommit = git("rev-parse", "HEAD");
      git("mv", "server/fixtures/prompt.txt", "docs/prompt.txt");
      git("commit", "-q", "-m", "move prompt to docs");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: fixtureCommit })).toBe("draft=false\ncode=true\nbrowser=true\nserver=true\n");

      const moved = git("rev-parse", "HEAD");
      mkdirSync(join(dir, "server"), { recursive: true });
      writeFileSync(join(dir, "server/store.test.ts"), "export {};\n");
      git("add", "server/store.test.ts");
      git("commit", "-q", "-m", "a unit test");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: moved })).toBe("draft=false\ncode=true\nbrowser=false\nserver=true\n");
      const tested = git("rev-parse", "HEAD");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src/App.tsx"), "export {};\n");
      git("add", "src/App.tsx");
      git("commit", "-q", "-m", "client code");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: tested })).toBe("draft=false\ncode=true\nbrowser=true\nserver=false\n");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: moved })).toBe("draft=false\ncode=true\nbrowser=true\nserver=true\n");

      // The base moved after the pull request last saw it: the run's merge commit is made on the later base, and
      // what another pull request brought there in between is not this one's change.
      const seen = git("rev-parse", "HEAD");
      const merged = (branch: string, path: string, others: string): void => {
        git("switch", "-q", "-c", branch);
        writeFileSync(join(dir, path), "export {};\n");
        git("add", path);
        git("commit", "-q", "-m", "this pull request");
        git("switch", "-q", "-");
        writeFileSync(join(dir, others), "export {};\n");
        git("add", others);
        git("commit", "-q", "-m", "another pull request, merged meanwhile");
        git("merge", "-q", "--no-ff", "-m", "the run's merge commit", branch);
      };
      merged("unit-test-only", "server/other.test.ts", "src/Other.tsx");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: seen })).toBe("draft=false\ncode=true\nbrowser=false\nserver=true\n");
      merged("docs-only", "docs/other.md", "src/Another.tsx");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: seen })).toBe("draft=false\ncode=false\nbrowser=true\nserver=true\n");
      merged("client-code", "src/Mine.tsx", "docs/theirs.md");
      expect(await decided({ EVENT_NAME: "pull_request", PR_DRAFT: "false", BASE_SHA: seen })).toBe("draft=false\ncode=true\nbrowser=true\nserver=false\n");

      // A pull request that changes the Windows installer has Native Windows install run it at its head (installer: that
      // commit); a fork's head is not among the repository's refs herdr's plugin install clones, and other changes run none
      const before = git("rev-parse", "HEAD");
      const pr = { EVENT_NAME: "pull_request", PR_DRAFT: "false", HEAD_SHA: "0123abc", REPOSITORY: "devswha/ovis" };
      expect(await decided({ ...pr, BASE_SHA: seen, HEAD_REPO: "devswha/ovis" })).not.toContain("installer=");
      writeFileSync(join(dir, "install.ps1"), "# the installer\n");
      git("add", "install.ps1");
      git("commit", "-q", "-m", "the installer");
      expect(await decided({ ...pr, BASE_SHA: before, HEAD_REPO: "devswha/ovis" })).toMatch(/^draft=false\ncode=true\nbrowser=(true|false)\ninstaller=0123abc\nserver=(true|false)\n$/);
      expect(await decided({ ...pr, BASE_SHA: before, HEAD_REPO: "someone/ovis" })).not.toContain("installer=");
      for (const event of ["push", "workflow_dispatch"]) expect(await decided({ EVENT_NAME: event, PR_DRAFT: "", BASE_SHA: "", HEAD_SHA: "", HEAD_REPO: "", REPOSITORY: "devswha/ovis" })).not.toContain("installer=");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("gives a push to main the latest passed push run of main in its history as the ratchets' base, and no base otherwise", async () => {
    const ratchet = ci.jobs["changes"]!.steps!.find((step) => step.id === "ratchet")!;
    const fetchBase = ci.jobs["fast"]!.steps!.find((step) => step.name === "Fetch the base the ratchets compare with")!;
    const dir = mkdtempSync(join(tmpdir(), "release-ci-reuse-ratchet-"));
    try {
      const git = (...args: string[]): string => {
        const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: dir } });
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
      };
      const commit = (message: string): string => { git("commit", "-q", "--allow-empty", "-m", message); return git("rev-parse", "HEAD"); };
      git("init", "-q", "-b", "main");
      const [a, b] = [commit("a"), commit("b")];
      // HEAD is a merge commit, as a pull request's checkout is: first parent b, last parent a side commit
      git("checkout", "-q", "-b", "side", a);
      const side = commit("side");
      git("checkout", "-q", "main");
      git("merge", "-q", "--no-ff", "-m", "head", "side");
      const head = git("rev-parse", "HEAD");
      expect(git("rev-list", "--parents", "-n", "1", head).split(" ").slice(1)).toEqual([b, side]);
      git("checkout", "-q", "--orphan", "elsewhere");
      const elsewhere = commit("not in main's history");
      git("checkout", "-q", "main");
      // gh answers the step's own query (passed push runs of ci.yml on main) with PASSED, any other query with ANY: a
      // cancelled run of HEAD itself, which only a query that lost one of its filters would see; sleep returns at once
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "gh"), `#!/bin/sh
echo call >> "$CALLS"
[ -n "$DOWN" ] && exit 1
# the step's own query, argument by argument: an argument holding a separator could not pass for one of its neighbours
asked() {
  [ "$#" -eq 18 ] || return 1
  [ "$1" = run ] && [ "$2" = list ] && [ "$3" = --repo ] && [ "$4" = o/r ] && [ "$5" = --workflow ] && [ "$6" = ci.yml ] &&
  [ "$7" = --branch ] && [ "$8" = main ] && [ "$9" = --event ] && [ "\${10}" = push ] && [ "\${11}" = --status ] && [ "\${12}" = success ] &&
  [ "\${13}" = --limit ] && [ "\${14}" = 100 ] && [ "\${15}" = --json ] && [ "\${16}" = headSha ] && [ "\${17}" = --jq ] && [ "\${18}" = '.[].headSha' ]
}
if asked "$@"; then printf '%s\\n' $PASSED; else printf '%s\\n' $ANY; fi
`, { mode: 0o755 });
      writeFileSync(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const found = async (env: Record<string, string>): Promise<{ base: string; calls: number }> => {
        const [output, calls] = [join(dir, "output"), join(dir, "calls")];
        for (const file of [output, calls]) writeFileSync(file, "");
        const result = await runScript(ratchet.run!, dir, { PATH: `${bin}:${process.env.PATH ?? ""}`, EVENT_NAME: "push", REF: "refs/heads/main", REPOSITORY: "o/r", GITHUB_OUTPUT: output, CALLS: calls, ANY: head, ...env });
        expect(result.code).toBe(0);
        return { base: readFileSync(output, "utf8").trim(), calls: readFileSync(calls, "utf8").split("\n").filter(Boolean).length };
      };
      // the latest passed commit by history, whatever the order of the list; never one outside the push's history
      expect((await found({ PASSED: `${a} ${b}` })).base).toBe(`base=${b}`);
      expect((await found({ PASSED: `${b} ${a}` })).base).toBe(`base=${b}`);
      expect((await found({ PASSED: `${elsewhere} ${a}` })).base).toBe(`base=${a}`);
      expect(await found({ PASSED: elsewhere })).toEqual({ base: "", calls: 1 });
      expect(await found({ PASSED: "" })).toEqual({ base: "", calls: 1 });
      // only a push to main asks; an API that does not answer is asked three times, then gives no base
      const notAPushToMain: Record<string, string>[] = [{ EVENT_NAME: "pull_request" }, { REF: "refs/heads/feature" }];
      for (const env of notAPushToMain) expect(await found({ PASSED: b, ...env })).toEqual({ base: "", calls: 0 });
      expect(await found({ PASSED: b, DOWN: "1" })).toEqual({ base: "", calls: 3 });
      // and a push with no base fails Fast checks' fetch step before it fetches anything
      const fetched = await runScript(fetchBase.run!, dir, { GITHUB_EVENT_NAME: "push", EVENT_BASE: a, LAST_GREEN: "", GITHUB_ENV: join(dir, "env") });
      expect([fetched.code, fetched.output.includes("No passed main commit")]).toEqual([1, true]);
      // a base it has is fetched into a depth-1 checkout of HEAD and handed on: for a push the passed commit, not the one
      // before the push; for a pull request its merge commit's first parent, not the event's base
      git("config", "uploadpack.allowAnySHA1InWant", "true");
      const shallow = join(dir, "shallow");
      expect(Bun.spawnSync(["git", "clone", "-q", "--depth", "1", `file://${dir}`, shallow], { env: { PATH: process.env.PATH ?? "", HOME: dir } }).exitCode).toBe(0);
      const handed = async (env: Record<string, string>): Promise<string> => {
        const file = join(dir, "env");
        writeFileSync(file, "");
        const result = await runScript(fetchBase.run!, shallow, { GITHUB_ENV: file, ...env });
        expect(result.code).toBe(0);
        return readFileSync(file, "utf8").trim();
      };
      expect(await handed({ GITHUB_EVENT_NAME: "push", EVENT_BASE: b, LAST_GREEN: a })).toBe(`RATCHET_BASE=${a}`);
      expect(Bun.spawnSync(["git", "cat-file", "-e", `${a}^{commit}`], { cwd: shallow }).exitCode).toBe(0);
      const has = (sha: string): boolean => Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], { cwd: shallow }).exitCode === 0;
      expect(has(b)).toBe(false);
      expect(await handed({ GITHUB_EVENT_NAME: "pull_request", EVENT_BASE: a, LAST_GREEN: "" })).toBe(`RATCHET_BASE=${b}`);
      expect(has(b)).toBe(true);
      // the base reaches the fetch step from Detect changes' ratchet step
      expect([ci.jobs["changes"]!.outputs?.["ratchet_base"], fetchBase.env?.["LAST_GREEN"]]).toEqual(["${{ steps.ratchet.outputs.base }}", "${{ needs.changes.outputs.ratchet_base }}"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
