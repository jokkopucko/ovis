import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./ci-runner-route.sh", import.meta.url));
const labels = '["self-hosted","linux","x64","herdr-ci"]';
const repo = "devswha/ovis";

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-runner-route-"));
  created.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// A fake `gh` that answers the Actions API from the JSON files in $FAKE_GH and logs each call; a
// missing file makes it fail like an API error.
const bin = tempDir();
writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "$FAKE_GH/calls"
[ "$1" = api ] && [ "$2" = --paginate ] || exit 1
case "$3" in
  */jobs*) id=\${3#*/runs/}; f=jobs-\${id%%/*} ;;
  *status=in_progress*) f=in_progress ;;
  *status=queued*) f=queued ;;
  *) exit 1 ;;
esac
cat "$FAKE_GH/$f.json"
`);
chmodSync(join(bin, "gh"), 0o755);

type Job = { status: string; labels: string[] };
const ovis = ["self-hosted", "self-hosted-ovis"];
const running = (count: number, labels = ovis): Job[] => Array.from({ length: count }, () => ({ status: "in_progress", labels }));
const waiting = (count: number, labels = ovis): Job[] => Array.from({ length: count }, () => ({ status: "queued", labels }));

/** Writes the API state: runs by status, each run's id mapped to its jobs. */
function actions(state: { in_progress?: Record<number, Job[]>; queued?: Record<number, Job[]> }): string {
  const dir = tempDir();
  for (const status of ["in_progress", "queued"] as const) {
    const runs = state[status] ?? {};
    writeFileSync(join(dir, `${status}.json`), JSON.stringify({ workflow_runs: Object.keys(runs).map((id) => ({ id: Number(id) })) }));
    for (const [id, jobs] of Object.entries(runs)) writeFileSync(join(dir, `jobs-${id}.json`), JSON.stringify({ jobs }));
  }
  return dir;
}

function route(env: Record<string, string>) {
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 5_000,
    env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_GH: tempDir(), REPOSITORY: repo, ...env },
  });
  expect(result.error).toBeUndefined();
  return result;
}

function routed(env: Record<string, string>): unknown {
  const result = route(env);
  expect(result.status).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines.length).toBe(1);
  expect(lines[0]).toStartWith("linux=");
  return JSON.parse(lines[0]!.slice("linux=".length));
}

describe.skipIf(process.platform === "win32")("CI runner route", () => {
  it("routes a push to the maintainer PC's runners without the variable", () => {
    expect(routed({ EVENT_NAME: "push" })).toEqual(["self-hosted", "self-hosted-ovis"]);
  });

  it("keeps any other event hosted without the variable", () => {
    for (const event of ["workflow_dispatch", "workflow_run", "merge_group", "schedule", ""]) {
      expect(routed({ EVENT_NAME: event, HEAD_REPO: repo })).toBe("ubuntu-24.04");
    }
  });

  describe("a same-repository pull request without the variable", () => {
    const pr = { EVENT_NAME: "pull_request", HEAD_REPO: repo };

    it("goes to the self-hosted runners while they have room for its jobs", () => {
      expect(routed({ ...pr, FAKE_GH: actions({}) })).toEqual(ovis);
      // 6 of 10 busy leaves exactly the 4 Linux jobs one run needs
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(4) }, queued: { 2: waiting(2) } }) })).toEqual(ovis);
    });

    it("goes hosted when queued and running jobs leave too little room", () => {
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(4), 3: [...running(1), ...waiting(1)] }, queued: { 2: waiting(1) } }) }))
        .toBe("ubuntu-24.04");
      // stops asking once the runners are known to be full: run 2's jobs are never read
      const full = actions({ in_progress: { 1: running(7), 2: running(1) } });
      rmSync(join(full, "jobs-2.json"));
      const result = route({ ...pr, FAKE_GH: full });
      expect(result.stdout).toBe('linux="ubuntu-24.04"\n');
      expect(result.stderr).not.toContain("::warning::");
    });

    it("counts only unfinished jobs on the pull requests' runners", () => {
      const others: Job[] = [
        ...running(3, ["self-hosted", "self-hosted-ovis-main"]),
        ...running(3, ["ubuntu-24.04"]),
        { status: "completed", labels: ovis },
        { status: "completed", labels: ovis },
      ];
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [...others, ...running(5, ["Self-Hosted", "self-hosted-ovis"])] } }) }))
        .toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [...others, ...running(7)] } }) })).toBe("ubuntu-24.04");
      // a job asking for fewer labels can take those runners too
      for (const labels of [["self-hosted"], ["self-hosted", "linux", "x64"]]) {
        expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(7, labels) } }) })).toBe("ubuntu-24.04");
      }
    });

    it("counts the jobs on every page", () => {
      const state = actions({ in_progress: { 1: running(1) } });
      const page = (jobs: Job[]) => JSON.stringify({ jobs });
      writeFileSync(join(state, "jobs-1.json"), `${page(running(4))}\n${page(running(3))}\n`);
      writeFileSync(join(state, "in_progress.json"), `{"workflow_runs":[]}\n{"workflow_runs":[{"id":1}]}\n`);
      // counted, not a failed count falling back to hosted
      const result = route({ ...pr, FAKE_GH: state });
      expect(result.stdout).toBe('linux="ubuntu-24.04"\n');
      expect(result.stderr).toContain("at least 7 of 10");
      expect(result.stderr).not.toContain("::warning::");
    });

    it("takes the capacity from CI_SELF_HOSTED_CAPACITY", () => {
      expect(routed({ ...pr, FAKE_GH: actions({}), SELF_HOSTED_CAPACITY: "4" })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({}), SELF_HOSTED_CAPACITY: "3" })).toBe("ubuntu-24.04");
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(10) } }), SELF_HOSTED_CAPACITY: "14" })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({}), SELF_HOSTED_CAPACITY: "08" })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(6) } }), SELF_HOSTED_CAPACITY: "010" })).toEqual(ovis);
      for (const value of ["ten", "-1", "4.5", "99999999999999999999"]) {
        const result = route({ ...pr, FAKE_GH: actions({}), SELF_HOSTED_CAPACITY: value });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("::error::repository variable CI_SELF_HOSTED_CAPACITY");
      }
    });

    it("stays hosted when the jobs cannot be counted", () => {
      const result = route(pr);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('linux="ubuntu-24.04"\n');
      expect(result.stderr).toContain("::warning::");
      const broken = actions({ in_progress: { 1: running(1) } });
      rmSync(join(broken, "jobs-1.json"));
      expect(routed({ ...pr, FAKE_GH: broken })).toBe("ubuntu-24.04");
    });

    it("never asks the API for a fork, a configured label set or the hosted override", () => {
      for (const env of [
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" },
        { ...pr, CONFIGURED_LABELS: labels },
        { ...pr, CONFIGURED_LABELS: '"ubuntu-24.04"' },
      ]) {
        const state = actions({});
        route({ ...env, FAKE_GH: state });
        expect(existsSync(join(state, "calls"))).toBe(false);
      }
      expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", FAKE_GH: actions({}) })).toBe("ubuntu-24.04");
    });
  });

  it("keeps everything on the GitHub-hosted image when the variable names it", () => {
    const hosted = '"ubuntu-24.04"';
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: hosted })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "push", CONFIGURED_LABELS: hosted })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels, CONFIGURED_LABELS: hosted })).toEqual(JSON.parse(labels));
  });

  it("keeps a fork pull request hosted without the variable", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork" })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request" })).toBe("ubuntu-24.04");
  });

  it("routes a same-repository pull request to the configured labels", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps a fork pull request on the GitHub-hosted image", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels })).toBe("ubuntu-24.04");
  });

  it("lets the dispatch input override the variable", () => {
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: '["self-hosted","other"]', CONFIGURED_LABELS: labels }))
      .toEqual(["self-hosted", "other"]);
    expect(routed({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps a fork pull request hosted even with requested labels", () => {
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", REQUESTED_LABELS: labels, CONFIGURED_LABELS: labels }))
      .toBe("ubuntu-24.04");
  });

  it("routes a push to main to the configured labels", () => {
    expect(routed({ EVENT_NAME: "push", CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("routes a push to main to CI_MAIN_SELF_HOSTED_LABELS over CI_SELF_HOSTED_LABELS", () => {
    const main = '["self-hosted","self-hosted-ovis-main"]';
    const push = { EVENT_NAME: "push", REF: "refs/heads/main" };
    expect(routed({ ...push, MAIN_LABELS: main })).toEqual(["self-hosted", "self-hosted-ovis-main"]);
    expect(routed({ ...push, MAIN_LABELS: main, CONFIGURED_LABELS: labels })).toEqual(["self-hosted", "self-hosted-ovis-main"]);
    expect(routed({ ...push, MAIN_LABELS: '"ubuntu-24.04"' })).toBe("ubuntu-24.04");
    expect(routed({ ...push, MAIN_LABELS: '"ubuntu-24.04"', CONFIGURED_LABELS: labels })).toBe("ubuntu-24.04");
    // unset or blank: main shares the pull requests' runners, as before
    expect(routed(push)).toEqual(["self-hosted", "self-hosted-ovis"]);
    expect(routed({ ...push, MAIN_LABELS: " " })).toEqual(["self-hosted", "self-hosted-ovis"]);
    expect(routed({ ...push, MAIN_LABELS: " ", CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps every run but a push to main off main's runners", () => {
    const main = '["self-hosted","self-hosted-ovis-main"]';
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, REF: "refs/pull/1/merge", MAIN_LABELS: main })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, MAIN_LABELS: main, CONFIGURED_LABELS: labels })).toEqual(JSON.parse(labels));
    expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", MAIN_LABELS: main })).toBe("ubuntu-24.04");
    for (const ref of ["refs/heads/other", "refs/tags/v1.0.0", ""]) {
      expect(routed({ EVENT_NAME: "push", REF: ref, MAIN_LABELS: main })).toEqual(["self-hosted", "self-hosted-ovis"]);
    }
    expect(routed({ EVENT_NAME: "workflow_dispatch", REF: "refs/heads/main", MAIN_LABELS: main })).toBe("ubuntu-24.04");
    expect(routed({ EVENT_NAME: "workflow_dispatch", REF: "refs/heads/main", MAIN_LABELS: main, REQUESTED_LABELS: labels })).toEqual(JSON.parse(labels));
  });

  it("keeps main hosted too when CI_SELF_HOSTED_LABELS names the GitHub-hosted image", () => {
    expect(routed({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]', CONFIGURED_LABELS: '"ubuntu-24.04"' }))
      .toBe("ubuntu-24.04");
  });

  it("refuses a CI_MAIN_SELF_HOSTED_LABELS that is not self-hosted labels or the hosted image", () => {
    for (const value of ['["self-hosted",', '["self-hosted-ovis-main"]', '"self-hosted"', "[]"]) {
      const result = route({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: value });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("::error::repository variable CI_MAIN_SELF_HOSTED_LABELS");
    }
  });

  it("refuses malformed JSON", () => {
    const result = route({ EVENT_NAME: "push", CONFIGURED_LABELS: '["self-hosted",' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("::error::");
  });

  it("refuses labels without self-hosted", () => {
    for (const value of ['["linux","x64"]', '"self-hosted"', '[]', '["self-hosted", 1]']) {
      const result = route({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: value });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("::error::");
    }
  });
});
