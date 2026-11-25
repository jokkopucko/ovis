import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow, root, runScript } from "./shell-workflow-rules.ts";

const workflow = (name: string) => parseWorkflow(join(root, ".github/workflows", name));
const ATTESTS = { contents: "read", "id-token": "write", attestations: "write" };

test("release and repair runs attest every Rust PTY host and ACP keeper binary; pull requests and the build jobs get no signing token", () => {
  const sidecar = workflow("pty-sidecar.yml");
  expect(sidecar.permissions).toEqual({ contents: "read" });
  for (const name of ["build", "manifest"]) expect(sidecar.jobs[name]!.permissions).toBeUndefined();
  const attest = sidecar.jobs["attest"]!;
  expect(attest.needs).toBe("manifest");
  expect(attest.if).toBe("github.event_name != 'pull_request' && (inputs.ref == github.sha || inputs.ref == github.ref)");
  expect(attest.permissions).toEqual(ATTESTS);
  const download = attest.steps!.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  expect(download?.with).toEqual({ name: "ovis-pty-sidecar", path: "pty-sidecar" });
  const step = attest.steps!.find((step) => step.uses?.startsWith("actions/attest-build-provenance@"));
  expect(step?.uses).toMatch(/^actions\/attest-build-provenance@[0-9a-f]{40}$/);
  expect(step?.with).toEqual({ "subject-path": "pty-sidecar/ovis-pty-sidecar-*\npty-sidecar/ovis-acp-keeper-*\n" });
});

test("CI runs both crates' unit tests, and the release build runs the script that builds both binaries", () => {
  const runs = workflow("ci.yml").jobs["rust-pty-host"]!.steps!.map((step) => step.run ?? "");
  for (const crate of ["pty-sidecar", "acp-keeper"]) expect(runs).toContain(`cargo test --locked --manifest-path crates/${crate}/Cargo.toml`);
  const jobs = workflow("ci.yml").jobs;
  const keeper = jobs["rust-pty-host"]!.steps!;
  const acp = keeper.findIndex((step) => step.run === "bun test ./server/acp ./server/agent-tools/turns.test.ts ./server/agent-tools/child.contract.test.ts ./server/agent-tools/pane.test.ts ./server/agent-tools/stop.contract.test.ts ./server/approvals/acp.test.ts ./server/core/acp-composer.test.ts");
  expect(keeper[acp]?.env?.["OVIS_REQUIRE_ACP_KEEPER"]).toBe("1");
  expect(runs.slice(0, acp)).toContain("cargo build --release --locked --manifest-path crates/acp-keeper/Cargo.toml --examples --bins");
  const live = jobs["herdr-core-live"]!.steps!;
  const hc = live.findIndex((step) => step.run?.includes("./server/acp/children.live.test.ts"));
  expect(hc).toBeGreaterThan(-1);
  const build = workflow("pty-sidecar.yml").jobs["build"]!.steps!.map((step) => step.run ?? "");
  expect(build).toContain("bun scripts/pty-sidecar.ts build ${{ matrix.asset }} pty-sidecar");
});

test("every caller grants the attest job its permissions, and Release publishes only after it", () => {
  const release = workflow("release.yml");
  expect(release.jobs["pty-sidecar"]!.permissions).toEqual(ATTESTS);
  expect(release.jobs["publish"]!.needs).toContain("pty-sidecar");
  expect(workflow("pty-sidecar-attach.yml").jobs["build"]!.permissions).toEqual(ATTESTS);
  expect(workflow("beta.yml").jobs["host-build"]!.permissions).toEqual(ATTESTS);
});

test("no job that checks out the ref it was given takes a local action: a repair build checks out an older tag, whose actions differ", () => {
  const jobs = Object.entries(workflow("pty-sidecar.yml").jobs).filter(([, job]) => job.steps?.some((step) => step.uses?.startsWith("actions/checkout@") && String(step.with?.["ref"] ?? "").includes("inputs.ref")));
  expect(jobs.map(([id]) => id)).toEqual(["build", "manifest"]);
  for (const [id, job] of jobs) expect([id, job.steps!.filter((step) => step.uses?.startsWith("./")).map((step) => step.uses)]).toEqual([id, []]);
});

test("beta rebuilds both binaries until the prerelease carries the current keeper", async () => {
  const pick = workflow("beta.yml").jobs["pick"]?.steps?.find((step) => step.id === "host")?.run;
  if (!pick) throw new Error("missing beta host decision");
  const releases = `GITHUB_OUTPUT=$(mktemp)
  trap 'rm -f "$GITHUB_OUTPUT"' EXIT
  git() {
    case "$2" in ref:crates/pty-sidecar) echo host;; ref:crates/acp-keeper) echo keeper;; ref:package.json) echo '{"version":"1"}';; *) return 1;; esac
  }
  gh() {
    case "$3:$5" in
      pty-sidecar-host-keeper:ovis-pty-sidecar.json) echo '{"crate":"host"}';;
      pty-sidecar-host-keeper:ovis-acp-keeper.json) [ "$KEEPER" != missing ] && printf '{"crate":"%s"}' "$KEEPER";;
      *) return 1;;
    esac
  }
  `;
  for (const [keeper, expected] of [["missing", "build"], ["old", "build"], ["keeper", "ready"]] as const) {
    const result = await runScript(releases + pick + '\ncat "$GITHUB_OUTPUT"', root, { SHA: "ref", TMPDIR: tmpdir(), KEEPER: keeper });
    expect(result.code, result.output).toBe(0);
    expect(result.output.split("\n")).toContain(`host=${expected}`);
  }
});
