import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
if [ -f "$FAKE_GH/refuse-$f" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi
if [ -f "$FAKE_GH/fail-$f" ]; then rm "$FAKE_GH/fail-$f"; cat "$FAKE_GH/$f.json"; echo "gh: Server Error (HTTP 502)" >&2; exit 1; fi
cat "$FAKE_GH/$f.json"
`);
chmodSync(join(bin, "gh"), 0o755);

type Job = { status: string; labels: string[]; name?: string; created_at?: string; started_at?: string };
const ovis = ["self-hosted", "self-hosted-ovis"];
const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const running = (count: number, labels = ovis, startedAgo = 120): Job[] =>
  Array.from({ length: count }, () => ({ status: "in_progress", labels, created_at: ago(startedAgo + 5), started_at: ago(startedAgo) }));
const waiting = (count: number, seconds: number, labels = ovis): Job[] =>
  Array.from({ length: count }, () => ({ status: "queued", labels, created_at: ago(seconds), started_at: ago(seconds) }));

function actions(state: { in_progress?: Record<number, Job[]>; queued?: Record<number, Job[]> }, updatedAgo = 30): string {
  const dir = tempDir();
  for (const status of ["in_progress", "queued"] as const) {
    const runs = state[status] ?? {};
    writeFileSync(join(dir, `${status}.json`), JSON.stringify({ workflow_runs: Object.keys(runs).map((id) => ({ id: Number(id), updated_at: ago(updatedAgo) })) }));
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

function outputs(env: Record<string, string>): { linux: unknown; fast: unknown } {
  const result = route(env);
  expect(result.status).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines.length).toBe(2);
  expect(lines[0]).toStartWith("linux=");
  expect(lines[1]).toStartWith("fast=");
  return { linux: JSON.parse(lines[0]!.slice("linux=".length)), fast: JSON.parse(lines[1]!.slice("fast=".length)) };
}

function routed(env: Record<string, string>): unknown {
  return outputs(env).linux;
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

    it("goes to the self-hosted runners while no job of theirs has waited four minutes", () => {
      expect(routed({ ...pr, FAKE_GH: actions({}) })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(8) }, queued: { 2: waiting(6, 200) } }) })).toEqual(ovis);
    });

    it("goes hosted once a job of theirs has waited more than four minutes", () => {
      const result = route({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(2) }, queued: { 2: [...waiting(1, 30), ...waiting(1, 300)] } }) });
      expect(result.stdout).toBe('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\n');
      expect(result.stderr).toMatch(/a self-hosted job has waited 30\ds for a runner/);
      expect(result.stderr).not.toContain("::warning::");
      const light: Job = { ...waiting(1, 300)[0]!, name: "Detect changes" };
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [...running(2), light] } }) })).toBe("ubuntu-24.04");
    });

    it("counts only jobs waiting for the pull requests' runners", () => {
      const others: Job[] = [
        ...waiting(3, 600, ["self-hosted", "self-hosted-ovis-main"]),
        ...waiting(3, 600, ["ubuntu-24.04"]),
        ...waiting(1, 600, ["self-hosted", "self-hosted-ovis-mac"]),
        { status: "completed", labels: ovis, created_at: ago(900), started_at: ago(600) },
        { status: "waiting", labels: ovis, created_at: ago(900), started_at: ago(900) },
        ...running(2),
      ];
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: others } }) })).toEqual(ovis);
      // a job asking for fewer labels can take those runners too
      for (const labels of [["Self-Hosted", "self-hosted-ovis"], ["self-hosted-ovis"], ["self-hosted"], ["self-hosted", "linux", "x64"]]) {
        expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: [...others, ...waiting(1, 300, labels)] } }) })).toBe("ubuntu-24.04");
      }
    });

    it("ignores a queued record older than a day, which GitHub has dropped", () => {
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(1) }, queued: { 2: waiting(1, 90_000) } }) })).toEqual(ovis);
    });

    it("does not read the jobs of a run nothing has updated for a day", () => {
      const stale = actions({ queued: { 7: waiting(1, 300) } }, 90_000);
      expect(routed({ ...pr, FAKE_GH: stale })).toEqual(ovis);
      expect(readFileSync(join(stale, "calls"), "utf8")).not.toContain("/runs/7/jobs");
    });

    it("goes hosted after a minute when no job of theirs is running: no runner looks online", () => {
      const result = route({ ...pr, FAKE_GH: actions({ queued: { 1: waiting(1, 90) } }) });
      expect(result.stdout).toBe('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\n');
      expect(result.stderr).toContain("no runner looks online");
      expect(routed({ ...pr, FAKE_GH: actions({ queued: { 1: waiting(1, 30) } }) })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(1) }, queued: { 2: waiting(1, 90) } }) })).toEqual(ovis);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(1, ["self-hosted-ovis"]) }, queued: { 2: waiting(1, 90) } }) })).toEqual(ovis);
      const stale = running(3, ovis, 2 * 86_400);
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: stale }, queued: { 2: waiting(1, 90) } }) })).toBe("ubuntu-24.04");
      const anywhere = [...running(1, ["self-hosted"]), ...running(1, ["self-hosted", "linux", "x64"])];
      expect(routed({ ...pr, FAKE_GH: actions({ in_progress: { 1: anywhere }, queued: { 2: waiting(1, 90) } }) })).toBe("ubuntu-24.04");
    });

    it("reads the jobs on every page", () => {
      const state = actions({ in_progress: { 1: running(1) } });
      const page = (jobs: Job[]) => JSON.stringify({ jobs });
      writeFileSync(join(state, "jobs-1.json"), `${page(running(4))}\n${page(waiting(1, 300))}\n`);
      writeFileSync(join(state, "in_progress.json"), `{"workflow_runs":[]}\n{"workflow_runs":[{"id":1,"updated_at":"${ago(30)}"}]}\n`);
      const result = route({ ...pr, FAKE_GH: state });
      expect(result.stdout).toBe('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\n');
      expect(result.stderr).toMatch(/has waited 30\ds/);
      expect(result.stderr).not.toContain("::warning::");
    });

    it("stays hosted when the jobs cannot be read", () => {
      const result = route(pr);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\n');
      expect(result.stderr).toContain("::warning::");
      const broken = actions({ in_progress: { 1: running(1) } });
      rmSync(join(broken, "jobs-1.json"));
      expect(routed({ ...pr, FAKE_GH: broken })).toBe("ubuntu-24.04");
    });

    it("asks again when one read fails", () => {
      const flaky = actions({ in_progress: { 1: running(5) }, queued: { 2: waiting(5, 30) } });
      for (const file of ["in_progress", "jobs-1", "jobs-2"]) writeFileSync(join(flaky, `fail-${file}`), "");
      expect(routed({ ...pr, FAKE_GH: flaky })).toEqual(ovis);
      const late = actions({ in_progress: { 1: running(5) }, queued: { 2: waiting(1, 300) } });
      writeFileSync(join(late, "fail-jobs-2"), "");
      expect(routed({ ...pr, FAKE_GH: late })).toBe("ubuntu-24.04");
    });

    it("does not ask again what the API refused", () => {
      const refused = actions({ in_progress: { 1: running(1) } });
      writeFileSync(join(refused, "refuse-jobs-1"), "");
      expect(routed({ ...pr, FAKE_GH: refused })).toBe("ubuntu-24.04");
      const calls = readFileSync(join(refused, "calls"), "utf8").trim().split("\n");
      expect(calls.filter((call) => call.includes("/runs/1/jobs"))).toHaveLength(1);
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

  describe("CI_LINUX_SELF_HOSTED_LABELS", () => {
    const vm = '["self-hosted","ovis-vm"]';

    it("moves the Linux jobs of a push and of a same-repository pull request", () => {
      expect(routed({ EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: vm })).toEqual(["self-hosted", "ovis-vm"]);
      expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: repo, LINUX_LABELS: vm })).toEqual(["self-hosted", "ovis-vm"]);
      const result = route({ EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: vm });
      expect(result.stderr).toContain("from repository variable CI_LINUX_SELF_HOSTED_LABELS");
    });

    it("leaves a tag push, a manual run and a workflow that calls ci.yml on CI_SELF_HOSTED_LABELS' routing", () => {
      expect(routed({ EVENT_NAME: "push", REF: "refs/tags/v1.2.3", LINUX_LABELS: vm })).toEqual(["self-hosted", "self-hosted-ovis"]);
      expect(routed({ EVENT_NAME: "workflow_dispatch", LINUX_LABELS: vm })).toBe("ubuntu-24.04");
      expect(routed({ EVENT_NAME: "workflow_dispatch", LINUX_LABELS: vm, CONFIGURED_LABELS: '["self-hosted","self-hosted-ovis"]' })).toEqual(["self-hosted", "self-hosted-ovis"]);
    });

    it("never moves a fork pull request", () => {
      expect(routed({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", LINUX_LABELS: vm })).toBe("ubuntu-24.04");
    });
  });

  describe("Fast checks", () => {
    const vm = '["self-hosted","ovis-vm"]';
    const pc = '["self-hosted","self-hosted-ovis"]';

    it("of a manual run that names ovis-vm stay with the rest", () => {
      expect(outputs({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: vm, FAST_LABELS: pc })).toEqual({ linux: ["self-hosted", "ovis-vm"], fast: ["self-hosted", "ovis-vm"] });
    });

    it("follow the Linux jobs when CI_FAST_SELF_HOSTED_LABELS is unset", () => {
      expect(outputs({ EVENT_NAME: "push", CONFIGURED_LABELS: vm })).toEqual({ linux: ["self-hosted", "ovis-vm"], fast: ["self-hosted", "ovis-vm"] });
    });

    it("take CI_FAST_SELF_HOSTED_LABELS when the Linux jobs go to the VM runners", () => {
      expect(outputs({ EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: vm, FAST_LABELS: pc }))
        .toEqual({ linux: ["self-hosted", "ovis-vm"], fast: ["self-hosted", "self-hosted-ovis"] });
    });

    it("ignore CI_FAST_SELF_HOSTED_LABELS when the Linux jobs do not go to the VM runners", () => {
      expect(outputs({ EVENT_NAME: "push", FAST_LABELS: vm })).toEqual({ linux: ["self-hosted", "self-hosted-ovis"], fast: ["self-hosted", "self-hosted-ovis"] });
    });

    it("of a fork pull request stay hosted whatever CI_FAST_SELF_HOSTED_LABELS says", () => {
      expect(outputs({ EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: vm, FAST_LABELS: pc }))
        .toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
    });

    it("follow the Linux jobs when CI_FAST_SELF_HOSTED_LABELS is not a label list with self-hosted", () => {
      for (const bad of ['"ubuntu-24.04"', '["self-hosted-ovis"]', "[]", "not json"]) {
        expect(outputs({ EVENT_NAME: "push", CONFIGURED_LABELS: vm, FAST_LABELS: bad }).fast).toEqual(["self-hosted", "ovis-vm"]);
      }
    });
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

  describe("hosted_only (pages.yml's call of ci.yml)", () => {
    const vm = '["self-hosted","ovis-vm"]';
    const scenarios = (): Record<string, string>[] => [
      { EVENT_NAME: "push" },
      { EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]' },
      { EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: vm, FAST_LABELS: '["self-hosted","self-hosted-ovis"]' },
      { EVENT_NAME: "push", CONFIGURED_LABELS: '"ubuntu-24.04"' },
      { EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({}) },
      { EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({ queued: { 1: waiting(1, 300) } }) },
      { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels },
      { EVENT_NAME: "workflow_dispatch" },
      { EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels },
      { EVENT_NAME: "workflow_dispatch", CONFIGURED_LABELS: labels },
    ];

    it("changes nothing when it is unset or false", () => {
      for (const env of scenarios()) {
        const before = route(env);
        const withoutWaitTimes = (stderr: string) => stderr.replace(/\d+s\b/g, "<n>s");
        for (const value of ["", "false"]) {
          const after = route({ ...env, HOSTED_ONLY: value });
          expect({ env, value, status: after.status, stdout: after.stdout, stderr: withoutWaitTimes(after.stderr) }).toEqual({ env, value, status: before.status, stdout: before.stdout, stderr: withoutWaitTimes(before.stderr) });
        }
      }
    });

    it("sends the Linux jobs and Fast checks to the hosted image when true, before it reads anything else", () => {
      for (const env of scenarios()) expect(outputs({ ...env, HOSTED_ONLY: "true" })).toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
      expect(outputs({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: '"self-hosted"', HOSTED_ONLY: "true" })).toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
    });
  });

  describe("Browser regression (other scripts)'s parts", () => {
    type CiJob = { "runs-on"?: unknown; strategy?: { matrix?: { shard?: string } } };
    const ci = Bun.YAML.parse(readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8")) as { jobs: Record<string, CiJob> };
    const shard = ci.jobs["browser-other"]!.strategy!.matrix!.shard!;
    const branches = [...shard.matchAll(/contains\(needs\.changes\.outputs\.linux, '([^']+)'\) && '(\[[\d,]*\])'/g)].map((match) => ({ label: match[1]!, parts: match[2]! }));
    const otherwise = /\|\| '(\[[\d,]*\])'\) \}\}$/.exec(shard)![1]!;
    /** The parts ci.yml's matrix gives for the `linux=` output the route printed (contains() compares strings, ignoring case). */
    const parts = (env: Record<string, string>): number[] => {
      const linux = route(env).stdout.split("\n")[0]!.slice("linux=".length).toLowerCase();
      return JSON.parse(branches.find(({ label }) => linux.includes(label.toLowerCase()))?.parts ?? otherwise) as number[];
    };

    it("reads the whole matrix expression", () => {
      expect(`\${{ fromJSON(${branches.map(({ label, parts }) => `contains(needs.changes.outputs.linux, '${label}') && '${parts}' || `).join("")}'${otherwise}') }}`).toBe(shard);
    });

    it("are the four hosted shards for a fork pull request, whatever the variables say", () => {
      const vm = '["self-hosted","ovis-vm"]';
      for (const env of [
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" },
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels, REQUESTED_LABELS: labels, LINUX_LABELS: vm, FAST_LABELS: vm },
        { EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork", CONFIGURED_LABELS: labels },
      ]) {
        expect(parts(env)).toEqual([1, 2, 3, 4]);
      }
    });

    it("are three on the self-hosted PC, four hosted and five on the VM runners", () => {
      expect(parts({ EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({}) })).toEqual([1, 2, 3]);
      expect(parts({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]' })).toEqual([1, 2, 3]);
      expect(parts({ EVENT_NAME: "pull_request", HEAD_REPO: repo, FAKE_GH: actions({ queued: { 1: waiting(1, 300) } }) })).toEqual([1, 2, 3, 4]);
      expect(parts({ EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: '["self-hosted","ovis-vm"]' })).toEqual([1, 2, 3, 4, 5]);
      expect(parts({ EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]', HOSTED_ONLY: "true" })).toEqual([1, 2, 3, 4]);
    });
  });
});
