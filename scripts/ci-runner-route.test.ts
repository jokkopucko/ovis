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

function lines(env: Record<string, string>): string[] {
  const result = route(env);
  expect(result.status).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines.length).toBe(5);
  expect(lines[0]).toStartWith("linux=");
  expect(lines[1]).toStartWith("fast=");
  expect(lines[2]).toStartWith("rust=");
  expect(lines[3]).toStartWith("integration=");
  expect(lines[4]).toStartWith("windows=");
  return lines;
}

function allOutputs(env: Record<string, string>): { linux: unknown; fast: unknown; rust: unknown; integration: unknown; windows: unknown } {
  const [linux, fast, rust, integration, windows] = lines(env).map((line) => JSON.parse(line.slice(line.indexOf("=") + 1)) as unknown);
  return { linux, fast, rust, integration, windows };
}

function outputs(env: Record<string, string>): { linux: unknown; fast: unknown } {
  const { linux, fast } = allOutputs(env);
  return { linux, fast };
}

/** Where the Rust PTY host job goes. */
function rust(env: Record<string, string>): unknown {
  return allOutputs(env).rust;
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
      expect(result.stdout).toStartWith('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\nrust=');
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
      expect(result.stdout).toStartWith('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\nrust=');
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
      expect(result.stdout).toStartWith('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\nrust=');
      expect(result.stderr).toMatch(/has waited 30\ds/);
      expect(result.stderr).not.toContain("::warning::");
    });

    it("stays hosted when the jobs cannot be read", () => {
      const result = route(pr);
      expect(result.status).toBe(0);
      expect(result.stdout).toStartWith('linux="ubuntu-24.04"\nfast="ubuntu-24.04"\nrust=');
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

    it("ignore CI_FAST_SELF_HOSTED_LABELS when the Linux jobs go hosted", () => {
      expect(outputs({ EVENT_NAME: "push", CONFIGURED_LABELS: '"ubuntu-24.04"', FAST_LABELS: pc })).toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
      expect(outputs({ EVENT_NAME: "workflow_dispatch", FAST_LABELS: pc })).toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
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

  describe("the fastest machine's own labels for Fast checks and Integration tests", () => {
    const p620 = ["self-hosted", "self-hosted-ovis-p620"];
    const preferred = { FAST_LABELS: JSON.stringify(p620), INTEGRATION_LABELS: JSON.stringify(p620) };
    const pr = { EVENT_NAME: "pull_request", HEAD_REPO: repo, ...preferred };
    const push = { EVENT_NAME: "push", REF: "refs/heads/topic", ...preferred };
    const both = (env: Record<string, string>) => { const { fast, integration } = allOutputs(env); return { fast, integration }; };

    it("go to those labels while the Linux jobs take the self-hosted runners and theirs wait little", () => {
      expect(both({ ...pr, FAKE_GH: actions({}) })).toEqual({ fast: p620, integration: p620 });
      expect(both({ ...push, FAKE_GH: actions({ in_progress: { 1: running(1, p620) }, queued: { 2: waiting(1, 100, p620) } }) })).toEqual({ fast: p620, integration: p620 });
      expect(allOutputs({ ...pr, FAKE_GH: actions({}) }).linux).toEqual(ovis);
      const one = allOutputs({ EVENT_NAME: "push", INTEGRATION_LABELS: JSON.stringify(p620), FAKE_GH: actions({}) });
      expect({ fast: one.fast, integration: one.integration }).toEqual({ fast: ovis, integration: p620 });
      expect(route({ ...pr, FAKE_GH: actions({}) }).stderr).toContain("Integration tests: self-hosted [\"self-hosted\",\"self-hosted-ovis-p620\"] (from repository variable CI_INTEGRATION_SELF_HOSTED_LABELS, longest wait 0s)");
    });

    it("fall back to the Linux jobs' runners once a job of theirs has waited two minutes, or none of theirs runs", () => {
      const result = route({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(1, p620) }, queued: { 2: waiting(1, 150, p620) } }) });
      expect(result.stdout.split("\n")[1]).toBe('fast=["self-hosted","self-hosted-ovis"]');
      expect(result.stdout.split("\n")[3]).toBe('integration=["self-hosted","self-hosted-ovis"]');
      expect(result.stderr).toMatch(/Fast checks: self-hosted \["self-hosted","self-hosted-ovis"\] \(a job of CI_FAST_SELF_HOSTED_LABELS has waited 15\ds/);
      expect(both({ ...pr, FAKE_GH: actions({ queued: { 1: waiting(1, 90, p620) } }) })).toEqual({ fast: ovis, integration: ovis });
      expect(route({ ...pr, FAKE_GH: actions({ queued: { 1: waiting(1, 90, p620) } }) }).stderr).toContain("none of theirs is running");
      // a stale "in progress" record is no runner
      expect(both({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(1, p620, 2 * 3600) }, queued: { 2: waiting(1, 90, p620) } }) })).toEqual({ fast: ovis, integration: ovis });
      // the pool's other jobs do not count against them
      expect(both({ ...push, FAKE_GH: actions({ queued: { 1: waiting(3, 200) } }) })).toEqual({ fast: p620, integration: p620 });
    });

    it("read past the run that settles the Linux route, while they are still open", () => {
      const state = actions({ queued: { 1: waiting(1, 300), 2: waiting(1, 150, p620) } });
      expect(both({ ...push, FAKE_GH: state })).toEqual({ fast: ovis, integration: ovis });
      expect(readFileSync(join(state, "calls"), "utf8")).toContain("/runs/2/jobs");
    });

    it("read the Actions API once with every route", () => {
      const state = actions({ in_progress: { 1: running(2) }, queued: { 2: waiting(1, 30, p620) } });
      const now = Math.floor(Date.now() / 1000);
      route({ ...pr, FAKE_GH: state, RUST_SELF_HOSTED: "true", RUST_SEEN: String(now), WINVM_READY: String(now - 5) });
      const calls = readFileSync(join(state, "calls"), "utf8").trim().split("\n");
      for (const read of ["status=in_progress", "status=queued", "/runs/1/jobs", "/runs/2/jobs"]) expect(calls.filter((call) => call.includes(read))).toHaveLength(1);
    });

    it("stay on the Linux jobs' runners when the jobs cannot be read", () => {
      const result = route({ ...push, FAKE_GH: tempDir() });
      expect(result.status).toBe(0);
      expect(result.stdout.split("\n").slice(0, 4)).toEqual(['linux=["self-hosted","self-hosted-ovis"]', 'fast=["self-hosted","self-hosted-ovis"]', 'rust="ubuntu-24.04"', 'integration=["self-hosted","self-hosted-ovis"]']);
      expect(result.stderr).toContain("::warning::could not read the self-hosted runners' jobs; Fast checks follow the Linux jobs");
    });

    it("never take a fork, hosted_only, a hosted Linux route or another event there, and ask the API nothing for them", () => {
      for (const env of [
        { ...pr, HEAD_REPO: "someone/fork" },
        { ...pr, HOSTED_ONLY: "true" },
        { ...push, CONFIGURED_LABELS: '"ubuntu-24.04"' },
        { ...pr, EVENT_NAME: "workflow_dispatch" },
        { ...pr, EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork" },
      ]) {
        const state = actions({});
        expect(both({ ...env, FAKE_GH: state })).toEqual({ fast: "ubuntu-24.04", integration: "ubuntu-24.04" });
        expect(existsSync(join(state, "calls"))).toBe(false);
      }
    });

    it("leave main's reserved runners and the VM runners alone, and read no API for them", () => {
      for (const env of [
        { EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]', FAST_LABELS: JSON.stringify(ovis) },
        { EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]', ...preferred },
        { EVENT_NAME: "pull_request", HEAD_REPO: repo, CONFIGURED_LABELS: '["self-hosted","ovis-vm"]', INTEGRATION_LABELS: JSON.stringify(p620) },
      ]) {
        const state = actions({});
        const { linux, fast, integration } = allOutputs({ ...env, FAKE_GH: state });
        expect({ fast, integration }).toEqual({ fast: linux, integration: linux });
        expect(existsSync(join(state, "calls"))).toBe(false);
      }
    });

    it("count a job that asks for the machine's own label alone", () => {
      expect(both({ ...pr, FAKE_GH: actions({ queued: { 1: waiting(1, 180, ["self-hosted-ovis-p620"]) } }) })).toEqual({ fast: ovis, integration: ovis });
    });

    it("do not take a pool job for the machine's own when the labels also name the pool's", () => {
      const mixed = JSON.stringify([...ovis, "self-hosted-ovis-p620"]);
      const env = { ...pr, FAST_LABELS: mixed, INTEGRATION_LABELS: mixed };
      expect(both({ ...env, FAKE_GH: actions({ in_progress: { 1: running(1) }, queued: { 2: waiting(1, 90, JSON.parse(mixed)) } }) })).toEqual({ fast: ovis, integration: ovis });
    });

    it("change nothing while unset, empty or naming the Linux jobs' own labels, and read no API then", () => {
      for (const value of [undefined, "", " ", JSON.stringify(ovis)]) {
        const state = actions({ queued: { 1: waiting(1, 150, p620) } });
        const env: Record<string, string> = { EVENT_NAME: "push", FAKE_GH: state };
        if (value !== undefined) Object.assign(env, { FAST_LABELS: value, INTEGRATION_LABELS: value });
        expect(both(env)).toEqual({ fast: ovis, integration: ovis });
        expect(existsSync(join(state, "calls"))).toBe(false);
      }
    });

    it("follow the Linux jobs, with a warning, when the variable is not a label list with self-hosted", () => {
      for (const bad of ['"ubuntu-24.04"', '["self-hosted-ovis-p620"]', "[]", "not json", '["self-hosted","p620"]\n["self-hosted","other"]']) {
        const result = route({ EVENT_NAME: "push", INTEGRATION_LABELS: bad, FAKE_GH: actions({}) });
        expect(result.stdout.split("\n")[3]).toBe('integration=["self-hosted","self-hosted-ovis"]');
        expect(result.stderr).toContain("::warning::repository variable CI_INTEGRATION_SELF_HOSTED_LABELS must be a JSON array");
      }
    });
  });

  describe("hosted_only (pages.yml's call of ci.yml)", () => {
    const vm = '["self-hosted","ovis-vm"]';
    // one answer of the API for every route of a scenario, which the Rust PTY host's route reads on a push too
    const scenarios = (): Record<string, string>[] => [
      { EVENT_NAME: "push", FAKE_GH: actions({}) },
      { EVENT_NAME: "push", REF: "refs/heads/main", MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]', FAKE_GH: actions({}) },
      { EVENT_NAME: "push", REF: "refs/heads/topic", LINUX_LABELS: vm, FAST_LABELS: '["self-hosted","self-hosted-ovis"]', FAKE_GH: actions({}) },
      { EVENT_NAME: "push", CONFIGURED_LABELS: '"ubuntu-24.04"' },
      { EVENT_NAME: "push", FAKE_GH: actions({ queued: { 1: waiting(1, 90, ["self-hosted", "self-hosted-ovis-rust"]) } }) },
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
      for (const env of scenarios()) expect(rust({ ...env, HOSTED_ONLY: "true", RUST_SELF_HOSTED: "true", RUST_SEEN: String(Math.floor(Date.now() / 1000)) })).toBe("ubuntu-24.04");
      expect(outputs({ EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: '"self-hosted"', HOSTED_ONLY: "true" })).toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04" });
    });
  });

  describe("Native Windows install", () => {
    const winvm = ["self-hosted", "self-hosted-ovis-win"];
    const readyAgo = (seconds: number): string => String(Math.floor(Date.now() / 1000) - seconds);
    const windows = (env: Record<string, string>): unknown => allOutputs({ FAKE_GH: actions({}), ...env }).windows;
    const pr = { EVENT_NAME: "pull_request", HEAD_REPO: repo };

    it("goes to winvm while its runner said within three minutes that it waits for a job", () => {
      for (const env of [pr, { EVENT_NAME: "push", REF: "refs/heads/main" }, { EVENT_NAME: "push", REF: "refs/heads/topic" }]) {
        expect(windows({ ...env, WINVM_READY: readyAgo(5) })).toEqual(winvm);
        expect(windows({ ...env, WINVM_READY: readyAgo(170) })).toEqual(winvm);
      }
      expect(route({ ...pr, FAKE_GH: actions({}), WINVM_READY: readyAgo(5) }).stderr).toMatch(/Windows: self-hosted .*said it was waiting \ds ago/);
    });

    it("takes windows-latest when the mark is missing, 0, stale, from the future or not a time", () => {
      for (const ready of ["", " ", "0", readyAgo(200), readyAgo(86_400), readyAgo(-120), "soon", "1e9", "-5", "12345678901234"]) {
        expect(windows({ ...pr, WINVM_READY: ready })).toBe("windows-latest");
      }
      expect(route({ ...pr, FAKE_GH: actions({}), WINVM_READY: "0" }).stderr).toContain("Windows: windows-latest (winvm's runner is not waiting for a job (CI_WINVM_READY 0))");
    });

    it("takes windows-latest while a job of winvm's label is queued or running, or the jobs cannot be read", () => {
      const ready = readyAgo(5);
      expect(windows({ ...pr, WINVM_READY: ready, FAKE_GH: actions({ queued: { 1: waiting(1, 10, winvm) } }) })).toBe("windows-latest");
      expect(windows({ ...pr, WINVM_READY: ready, FAKE_GH: actions({ in_progress: { 1: running(1, winvm) } }) })).toBe("windows-latest");
      const result = route({ ...pr, WINVM_READY: ready, FAKE_GH: actions({ in_progress: { 1: [...running(1, winvm), ...waiting(1, 10, winvm)] } }) });
      expect(result.stderr).toContain("Windows: windows-latest (2 job(s) of winvm's label already queued or running)");
      expect(windows({ ...pr, WINVM_READY: ready, FAKE_GH: tempDir() })).toBe("windows-latest");
      // a record "in progress" for more than an hour, another runner's jobs and a finished winvm job leave it free
      const free = [...running(1, winvm, 2 * 3600), ...running(2), ...waiting(1, 10, ["self-hosted", "self-hosted-ovis-mac"]), { status: "completed", labels: winvm, created_at: ago(600), started_at: ago(500) }];
      expect(windows({ ...pr, WINVM_READY: ready, FAKE_GH: actions({ in_progress: { 1: free } }) })).toEqual(winvm);
    });

    it("keeps a fork pull request, another event and hosted_only on windows-latest whatever the mark says", () => {
      const ready = readyAgo(5);
      for (const env of [
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" },
        { EVENT_NAME: "pull_request" },
        { EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork" },
        { EVENT_NAME: "pull_request_target", HEAD_REPO: repo },
        { EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels },
        { EVENT_NAME: "workflow_run" },
        { EVENT_NAME: "" },
        { ...pr, HOSTED_ONLY: "true" },
        { EVENT_NAME: "push", REF: "refs/heads/main", HOSTED_ONLY: "true" },
      ]) {
        expect(windows({ ...env, WINVM_READY: ready })).toBe("windows-latest");
      }
    });

    it("keeps a draft pull request on windows-latest: its job fails at its first step and would spend winvm's round", () => {
      const ready = readyAgo(5);
      expect(windows({ ...pr, WINVM_READY: ready, PR_DRAFT: "true" })).toBe("windows-latest");
      expect(route({ ...pr, FAKE_GH: actions({}), WINVM_READY: ready, PR_DRAFT: "true" }).stderr).toContain("Windows: windows-latest (a draft pull request, whose job runs no test)");
      for (const draft of ["false", ""]) expect(windows({ ...pr, WINVM_READY: ready, PR_DRAFT: draft })).toEqual(winvm);
      expect(windows({ EVENT_NAME: "push", REF: "refs/heads/main", WINVM_READY: ready, PR_DRAFT: "" })).toEqual(winvm);
    });

    it("reads the Actions API once for the Linux, Rust and Windows routes", () => {
      const state = actions({ in_progress: { 1: running(2) }, queued: { 2: waiting(1, 30, ["self-hosted", "self-hosted-ovis-rust"]) } });
      const now = Math.floor(Date.now() / 1000);
      expect(allOutputs({ ...pr, FAKE_GH: state, WINVM_READY: readyAgo(5), RUST_SELF_HOSTED: "true", RUST_SEEN: String(now) }))
        .toEqual({ linux: ovis, fast: ovis, rust: ["self-hosted", "self-hosted-ovis-rust"], integration: ovis, windows: winvm });
      const calls = readFileSync(join(state, "calls"), "utf8").trim().split("\n");
      for (const read of ["status=in_progress", "status=queued", "/runs/1/jobs", "/runs/2/jobs"]) {
        expect(calls.filter((call) => call.includes(read))).toHaveLength(1);
      }
    });

    it("reads past the run that sends the Linux jobs hosted until it knows whether winvm is taken", () => {
      const state = actions({ queued: { 1: waiting(1, 300), 2: waiting(1, 10, winvm) } });
      expect(allOutputs({ ...pr, FAKE_GH: state, WINVM_READY: readyAgo(5) })).toMatchObject({ linux: "ubuntu-24.04", windows: "windows-latest" });
      const free = actions({ queued: { 1: [...waiting(1, 300), ...waiting(1, 10, winvm)], 2: waiting(1, 10) } });
      expect(allOutputs({ ...pr, FAKE_GH: free, WINVM_READY: readyAgo(5) })).toMatchObject({ linux: "ubuntu-24.04", windows: "windows-latest" });
      expect(readFileSync(join(free, "calls"), "utf8")).not.toContain("/runs/2/jobs");
    });

    it("checks winvm's mark again after the jobs were read, which may take minutes", () => {
      // a date that moves 100 s on each call: winvm's mark is 100 s old before the read and older after it
      const clock = tempDir();
      const base = Math.floor(Date.now() / 1000);
      writeFileSync(join(clock, "date"), `#!/bin/sh\nn=$(cat "$FAKE_CLOCK/n" 2>/dev/null || echo 0)\necho $((n + 1)) > "$FAKE_CLOCK/n"\necho $((${base} + n * 100))\n`);
      chmodSync(join(clock, "date"), 0o755);
      const result = route({ ...pr, FAKE_GH: actions({}), WINVM_READY: String(base - 100), PATH: `${clock}:${bin}:${process.env.PATH ?? ""}`, FAKE_CLOCK: clock });
      expect(result.stdout.split("\n")[4]).toBe('windows="windows-latest"');
      expect(result.stderr).toMatch(/Windows: windows-latest \(winvm's runner last said it was waiting [2-9]00s ago\)/);
    });

    it("takes windows-latest when the jobs' answer cannot be kept in its temporary file", () => {
      const result = spawnSync("bash", ["-c", `trap '' XFSZ; ulimit -f 0; exec bash "$0"`, script], {
        encoding: "utf8",
        timeout: 5_000,
        env: { PATH: `${bin}:${process.env.PATH ?? ""}`, REPOSITORY: repo, EVENT_NAME: "push", REF: "refs/heads/main", WINVM_READY: readyAgo(5), FAKE_GH: actions({ queued: { 1: waiting(1, 10, winvm) } }) },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.split("\n")[4]).toBe('windows="windows-latest"');
    });

    it("is not kept off winvm by a job of another runner whose times are missing", () => {
      const odd: Job[] = [{ status: "queued", labels: ["self-hosted", "self-hosted-ovis-mac"], created_at: null as unknown as string }];
      expect(windows({ EVENT_NAME: "push", REF: "refs/heads/main", WINVM_READY: readyAgo(5), FAKE_GH: actions({ queued: { 1: odd } }) })).toEqual(winvm);
      const busy: Job[] = [{ status: "in_progress", labels: winvm, created_at: ago(30), started_at: null as unknown as string }];
      expect(windows({ ...pr, WINVM_READY: readyAgo(5), FAKE_GH: actions({ in_progress: { 1: busy } }) })).toBe("windows-latest");
    });

    it("does not follow the Linux jobs' route", () => {
      expect(allOutputs({ ...pr, FAKE_GH: actions({ queued: { 1: waiting(1, 300) } }), WINVM_READY: readyAgo(5) })).toEqual({ linux: "ubuntu-24.04", fast: "ubuntu-24.04", rust: "ubuntu-24.04", integration: "ubuntu-24.04", windows: winvm });
      expect(allOutputs({ EVENT_NAME: "push", CONFIGURED_LABELS: labels })).toEqual({ linux: JSON.parse(labels), fast: JSON.parse(labels), rust: "ubuntu-24.04", integration: JSON.parse(labels), windows: "windows-latest" });
    });
  });

  describe("the Rust PTY host", () => {
    const ours = ["self-hosted", "self-hosted-ovis-rust"];
    // the heartbeat rust-heartbeat.sh writes: a Rust runner was seen online `ago` seconds before ROUTE_NOW
    const now = 2_000_000_000;
    const seen = (ago: number) => ({ ROUTE_NOW: String(now), RUST_SEEN: String(now - ago) });
    const pr = { EVENT_NAME: "pull_request", HEAD_REPO: repo, RUST_SELF_HOSTED: "true", ...seen(30) };
    const push = { EVENT_NAME: "push", REF: "refs/heads/main", RUST_SELF_HOSTED: "true", ...seen(30) };

    it("goes to the Rust runners for a same-repository pull request and a push while none of its jobs has waited a minute", () => {
      expect(rust({ ...pr, FAKE_GH: actions({}) })).toEqual(ours);
      expect(rust({ ...push, FAKE_GH: actions({}) })).toEqual(ours);
      expect(rust({ ...push, MAIN_LABELS: '["self-hosted","self-hosted-ovis-main"]', FAKE_GH: actions({ queued: { 1: waiting(1, 30, ours) } }) })).toEqual(ours);
    });

    it("goes hosted once a job of the Rust runners has waited more than a minute, whoever else waits", () => {
      const result = route({ ...pr, FAKE_GH: actions({ in_progress: { 1: running(1, ours) }, queued: { 2: waiting(1, 90, ours) } }) });
      expect(result.stdout.split("\n")[2]).toBe('rust="ubuntu-24.04"');
      expect(result.stderr).toMatch(/a job has waited 9\ds for the Rust runners/);
      expect(rust({ ...push, FAKE_GH: actions({ queued: { 1: waiting(1, 90, ["Self-Hosted", "self-hosted-ovis-rust"]) } }) })).toBe("ubuntu-24.04");
      expect(rust({ ...pr, FAKE_GH: actions({ queued: { 1: waiting(3, 600) } }) })).toEqual(ours);
      expect(rust({ ...pr, FAKE_GH: actions({ queued: { 1: waiting(1, 90_000, ours) } }) })).toEqual(ours);
    });

    it("goes hosted, before it queues and without asking the API, while no Rust runner has been seen online for five minutes", () => {
      for (const [heartbeat, why] of [
        [{ ROUTE_NOW: String(now) }, /heartbeat CI_RUST_RUNNER_SEEN is unset or not a number/],
        [{ ROUTE_NOW: String(now), RUST_SEEN: "" }, /unset or not a number/],
        [{ ROUTE_NOW: String(now), RUST_SEEN: "soon" }, /unset or not a number/],
        [seen(301), /no Rust runner seen online for 301s/],
        [seen(86_400), /no Rust runner seen online for 86400s/],
        [seen(-121), /heartbeat is 121s ahead of this clock/],
        [{ ROUTE_NOW: String(now), RUST_SEEN: "999999999999" }, /ahead of this clock/],
      ] as const) {
        for (const base of [{ EVENT_NAME: "pull_request", HEAD_REPO: repo, RUST_SELF_HOSTED: "true" }, { EVENT_NAME: "push", REF: "refs/heads/main", RUST_SELF_HOSTED: "true" }]) {
          const state = actions({});
          const result = route({ ...base, ...heartbeat, FAKE_GH: state });
          expect(result.status).toBe(0);
          expect(result.stdout.split("\n")[2]).toBe('rust="ubuntu-24.04"');
          expect(result.stderr).toMatch(why);
          if (base.EVENT_NAME === "push") expect(existsSync(join(state, "calls"))).toBe(false);
        }
      }
      expect(rust({ ...pr, ...seen(300), FAKE_GH: actions({}) })).toEqual(ours);
      expect(rust({ ...pr, ...seen(-120), FAKE_GH: actions({}) })).toEqual(ours);
      expect(rust({ ...pr, ROUTE_NOW: String(now), RUST_SEEN: `00${now - 30}`, FAKE_GH: actions({}) })).toEqual(ours);
    });

    it("reads the Actions API once for both routes", () => {
      const state = actions({ in_progress: { 1: running(2) }, queued: { 2: waiting(1, 30, ours) } });
      expect(rust({ ...pr, FAKE_GH: state })).toEqual(ours);
      const calls = readFileSync(join(state, "calls"), "utf8").trim().split("\n");
      expect(calls.filter((call) => call.includes("/runs/2/jobs"))).toHaveLength(1);
      expect(calls.filter((call) => call.includes("status=queued"))).toHaveLength(1);
    });

    it("stays hosted when the jobs cannot be read", () => {
      const result = route(push);
      expect(result.status).toBe(0);
      expect(result.stdout.split("\n")[2]).toBe('rust="ubuntu-24.04"');
      expect(result.stderr).toContain("::warning::could not read the self-hosted runners' jobs; the Rust PTY host uses ubuntu-24.04");
    });

    it("keeps a fork, a manual run and every run of a hosted CI_SELF_HOSTED_LABELS hosted, without asking the API", () => {
      for (const env of [
        { EVENT_NAME: "pull_request", HEAD_REPO: "someone/fork" },
        { EVENT_NAME: "pull_request_target", HEAD_REPO: "someone/fork", RUST_SELF_HOSTED: "true" },
        { EVENT_NAME: "workflow_dispatch" },
        { EVENT_NAME: "workflow_dispatch", REQUESTED_LABELS: labels },
        { ...pr, CONFIGURED_LABELS: ' "ubuntu-24.04" ' },
        { ...push, CONFIGURED_LABELS: '"ubuntu-24.04"' },
      ]) {
        const state = actions({});
        expect(rust({ ...env, FAKE_GH: state })).toBe("ubuntu-24.04");
        expect(existsSync(join(state, "calls"))).toBe(false);
      }
    });

    it("stays hosted, as before the Rust runners existed, unless CI_RUST_SELF_HOSTED is \"true\", and reads no API then", () => {
      for (const optIn of [undefined, "", "false"]) {
        for (const base of [pr, push]) {
          const state = actions({});
          const env: Record<string, string> = { ...base, FAKE_GH: state };
          if (optIn === undefined) delete env["RUST_SELF_HOSTED"];
          else env["RUST_SELF_HOSTED"] = optIn;
          expect(rust(env)).toBe("ubuntu-24.04");
          if (base === push) expect(existsSync(join(state, "calls"))).toBe(false);
        }
      }
    });

    it("reads no more of the Actions API than the Linux route needs while not opted in", () => {
      const state = (): string => actions({ queued: { 1: waiting(1, 300), 2: waiting(1, 30) } });
      const reads = (env: Record<string, string>): string[] => {
        const fake = state();
        route({ ...env, FAKE_GH: fake });
        return readFileSync(join(fake, "calls"), "utf8").trim().split("\n").filter((call) => call.includes("/jobs"));
      };
      const off: Record<string, string> = { ...pr };
      delete off["RUST_SELF_HOSTED"];
      expect(reads(off).some((call) => call.includes("/runs/2/jobs"))).toBe(false);
      expect(reads(pr).some((call) => call.includes("/runs/2/jobs"))).toBe(true);
    });

    it("routes as before when no temporary file can be made", () => {
      const result = route({ EVENT_NAME: "push", TMPDIR: "/nonexistent/for-this-test" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('linux=["self-hosted","self-hosted-ovis"]\nfast=["self-hosted","self-hosted-ovis"]\nrust="ubuntu-24.04"\nintegration=["self-hosted","self-hosted-ovis"]\nwindows="windows-latest"\n');
    });

    it("refuses any other CI_RUST_SELF_HOSTED, and never lets it pass the rules that keep the job hosted", () => {
      for (const value of ["yes", "TRUE", "1", " true", '"true"']) {
        const result = route({ ...pr, RUST_SELF_HOSTED: value, FAKE_GH: actions({}) });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("::error::repository variable CI_RUST_SELF_HOSTED");
      }
      for (const env of [{ ...push, CONFIGURED_LABELS: '"ubuntu-24.04"' }, { EVENT_NAME: "workflow_dispatch", RUST_SELF_HOSTED: "true" }, { ...pr, HOSTED_ONLY: "true" }]) {
        expect(rust({ ...env, FAKE_GH: actions({}) })).toBe("ubuntu-24.04");
      }
    });

    it("is not moved by the Linux jobs' variables", () => {
      const vm = '["self-hosted","ovis-vm"]';
      expect(rust({ ...pr, CONFIGURED_LABELS: vm, LINUX_LABELS: vm, FAKE_GH: actions({}) })).toEqual(ours);
      expect(rust({ ...push, MAIN_LABELS: '"ubuntu-24.04"', FAKE_GH: actions({}) })).toEqual(ours);
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
