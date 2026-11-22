import { describe, expect, it } from "bun:test";
import { aggregateFailures, flaggedJobs, isMainRun, parseLaneLog } from "./ci-flakes.ts";

describe("Browser lane log parsing", () => {
  it("reads a pre-retry final failure", () => {
    const log = `FAILED scripts/terminal-input-regression.ts (exit 1), full log: /tmp/input.log
AssertionError: input regression timed out
  at /w/repo/scripts/terminal-input-regression.ts:65:32`;
    expect(parseLaneLog(log)).toEqual([{ script: "scripts/terminal-input-regression.ts", outcome: "failed", site: "scripts/terminal-input-regression.ts:65", message: "AssertionError: input regression timed out" }]);
  });
  it("separates flaky and twice-failed sections after stripping timestamps and ANSI", () => {
    const log = [
      "\u001b[33mFLAKY scripts/ui-regression.ts: failed, then passed when run again; first log: /tmp/ui.log\u001b[0m",
      "TimeoutError: waitFor: Timeout 30000ms exceeded.",
      "  at /w/repo/node_modules/playwright-core/lib/coreBundle.js:57694:13",
      "  at checkSplitView (/w/repo/scripts/split-view-regression.ts:509:13)",
      "FAILED scripts/deep-link-demo-regression.ts (exit 1, twice), full log: /tmp/deep.log",
      "AssertionError: broken link",
      "  at /w/repo/scripts/deep-link-demo-regression.ts:12:1",
    ].map((line) => `2026-10-14T00:03:56.1234567Z ${line}`).join("\n");
    expect(parseLaneLog(log)).toEqual([
      { script: "scripts/ui-regression.ts", outcome: "flaky", site: "scripts/split-view-regression.ts:509", message: "TimeoutError: waitFor: Timeout 30000ms exceeded." },
      { script: "scripts/deep-link-demo-regression.ts", outcome: "failed", site: "scripts/deep-link-demo-regression.ts:12", message: "AssertionError: broken link" },
    ]);
  });
  it("reads no failures from a clean log", () => {
    expect(parseLaneLog("PASS scripts/ui-regression.ts\nTotal: 1/1 passed")).toEqual([]);
  });
  it("keeps unrecognised failures without borrowing another section's site", () => {
    expect(parseLaneLog(`FLAKY scripts/ui-regression.ts: failed once
FAILED scripts/deep-link-demo-regression.ts (exit 1, twice), full log: /tmp/deep.log
TypeError: broken`)).toEqual([
      { script: "scripts/ui-regression.ts", outcome: "flaky", site: null, message: null },
      { script: "scripts/deep-link-demo-regression.ts", outcome: "failed", site: null, message: "TypeError: broken" },
    ]);
  });
});

describe("A script the lane stopped at its time limit", () => {
  it("has the limit as its message and no site, whatever error its log ends with", () => {
    expect(parseLaneLog(`FAILED scripts/ui-contexts-regression.ts (exit 124), full log: /tmp/ui.log; Timed out after 600s
HerdrError: server is shutting down
    at stop (/w/ovis/scripts/alert-sound-regression.ts:273:9)
FAILED scripts/a-regression.ts (exit 124, twice), full log: /tmp/a.log
TypeError: closed
    at end (/w/ovis/scripts/a-regression.ts:9:1)
FAILED scripts/b-regression.ts (exit 1), full log: /tmp/b.log
TypeError: closed
    at end (/w/ovis/scripts/b-regression.ts:9:1)
`)).toEqual([
      { script: "scripts/ui-contexts-regression.ts", outcome: "failed", site: null, message: "Timed out after 600s (the lane's limit)" },
      { script: "scripts/a-regression.ts", outcome: "failed", site: null, message: "Timed out (the lane's limit)" },
      { script: "scripts/b-regression.ts", outcome: "failed", site: "scripts/b-regression.ts:9", message: "TypeError: closed" },
    ]);
  });
});

describe("Failure ranking", () => {
  it("takes only the default branch's own runs as main's, never a pull request from a branch of that name", () => {
    const runs = [{ event: "push", head_branch: "main" }, { event: "pull_request", head_branch: "main" }, { event: "push", head_branch: "fix/x" }];
    expect(runs.map((run) => isMainRun(run, "main"))).toEqual([true, false, false]);
  });

  it("ranks combined frequency, counts the default branch's own runs and keeps the most recent run and branch", () => {
    const common = { script: "scripts/ui-regression.ts", site: "scripts/ui-regression.ts:10", message: "AssertionError: broken" };
    const rows = aggregateFailures([
      { ...common, outcome: "flaky", main: false, runId: 3, branch: "new", createdAt: "2026-10-14T03:00:00Z" },
      { ...common, outcome: "failed", main: true, runId: 1, branch: "main", createdAt: "2026-10-14T01:00:00Z" },
      { ...common, site: null, outcome: "failed", main: false, runId: 4, branch: "other", createdAt: "2026-10-14T04:00:00Z" },
    ]);
    expect(rows.map((row) => [row.site, row.failed, row.flaky, row.main, row.runId, row.branch])).toEqual([
      ["scripts/ui-regression.ts:10", 1, 1, 1, 3, "new"], [null, 1, 0, 0, 4, "other"],
    ]);
  });
});

describe("Flaky warnings read from check suites", () => {
  it("flags each job by its warning, and leaves out a job whose warning may be past the annotations read", () => {
    const run = (databaseId: number, titles: (string | null)[], totalCount = titles.length) => ({ databaseId, annotations: { totalCount, nodes: titles.map((title) => ({ title })) } });
    const flagged = flaggedJobs({ data: { nodes: [
      { checkRuns: { nodes: [run(1, ["Flaky browser script: scripts/ui-regression.ts"]), run(2, [null, "Node.js 20 is deprecated"])] } },
      null,
      { checkRuns: { nodes: [run(3, ["Something else"], 20), run(4, ["Something else", "Flaky browser script: scripts/a.ts"], 20)] } },
    ] } });
    expect([...flagged].sort(([a], [b]) => a - b)).toEqual([[1, true], [2, false], [4, true]]);
  });
});
