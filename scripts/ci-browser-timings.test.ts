import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serialBrowserScripts } from "./ci-browser-parallel.ts";
import { firstRunSeconds, lastAttemptArtifacts, median, refreshRequest, refreshTimings } from "./ci-browser-timings.ts";

describe("browser timings refresh", () => {
  it("reads the seconds of the scripts that passed on their first run", () => {
    expect(firstRunSeconds({
      workers: 6, seconds: 100, passed: 3, total: 4, flaky: ["scripts/flaky.ts"],
      scripts: [
        { script: "scripts/a.ts", seconds: 12.4, code: 0, log: "/ci/a.log" },
        // both runs are in its seconds
        { script: "scripts/flaky.ts", seconds: 90, code: 0, log: "/ci/flaky.log", firstLog: "/ci/flaky.attempt-1.log" },
        { script: "scripts/failed.ts", seconds: 30, code: 1, log: "/ci/failed.log", firstLog: "/ci/failed.attempt-1.log" },
        { script: "scripts/timed-out.ts", seconds: 600, code: 124, log: "/ci/timed-out.log" },
        { script: "scripts/b.ts", seconds: 0.4, code: 0, log: "/ci/b.log" },
      ],
    })).toEqual({ "scripts/a.ts": 12.4, "scripts/b.ts": 0.4 });
    expect(firstRunSeconds({ scripts: [] })).toEqual({});
  });

  it("refuses a file that is not the lane's summary", () => {
    for (const other of [null, [], "summary", { rows: [] }, { scripts: {} }]) expect(() => firstRunSeconds(other)).toThrow("not a browser-logs summary.json");
    // an entry it cannot read times nothing; the others still do
    expect(firstRunSeconds({ scripts: [null, { script: "scripts/a.ts", code: 0 }, { script: "scripts/b.ts", seconds: "3", code: 0 }, { script: "scripts/c.ts", seconds: 3, code: 0 }] }))
      .toEqual({ "scripts/c.ts": 3 });
  });

  it("reads each job's logs of a run's last attempt only", () => {
    // a run whose ui-regression job failed once and was run again keeps both attempts' artifacts
    expect(lastAttemptArtifacts([
      "browser-main-42754144490-1", "browser-main-42754144490-2", "browser-other-1-42754144490-1",
      "check-fast-42754144490-1", "integration-logs-42754144490-1",
    ])).toEqual(["browser-main-42754144490-2", "browser-other-1-42754144490-1"]);
    // a hosted run's four shards, one of them run three times
    expect(lastAttemptArtifacts(["browser-other-2-7-1", "browser-other-10-7-1", "browser-other-2-7-3", "browser-other-2-7-2", "browser-other-1-7-1"]))
      .toEqual(["browser-other-1-7-1", "browser-other-10-7-1", "browser-other-2-7-3"]);
    expect(lastAttemptArtifacts(["dist-shell", "browser-main-7", "browser-other-7-1-extra", "xbrowser-main-7-1"])).toEqual([]);
  });

  it("takes the middle of the measurements", () => {
    expect(median([7])).toBe(7);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
    // one slow run does not move it
    expect(median([18, 300, 17, 19, 18])).toBe(18);
  });

  it("writes each listed script's median in whole seconds, longest first", () => {
    const listed = ["scripts/short.ts", "scripts/long.ts", "scripts/middle.ts"];
    const table = refreshTimings(listed, { "scripts/short.ts": 99, "scripts/long.ts": 1, "scripts/middle.ts": 1 }, [
      { "scripts/short.ts": 2.6, "scripts/long.ts": 280.2, "scripts/middle.ts": 40.4 },
      { "scripts/short.ts": 3.2, "scripts/long.ts": 317.9, "scripts/middle.ts": 41.5 },
      { "scripts/short.ts": 2.9, "scripts/long.ts": 286.4 },
    ]);
    expect(table).toEqual({ "scripts/long.ts": 286, "scripts/middle.ts": 41, "scripts/short.ts": 3 });
    expect(Object.keys(table)).toEqual(["scripts/long.ts", "scripts/middle.ts", "scripts/short.ts"]);
  });

  it("keeps the seconds of a listed script no summary holds, and drops a script the list no longer holds", () => {
    const table = refreshTimings(
      ["scripts/kept.ts", "scripts/timed.ts", "scripts/new.ts"],
      { "scripts/kept.ts": 50, "scripts/timed.ts": 50, "scripts/renamed-away.ts": 200 },
      // a summary still names the script that left the list
      [{ "scripts/timed.ts": 8.2, "scripts/renamed-away.ts": 201 }],
    );
    expect(table).toEqual({ "scripts/kept.ts": 50, "scripts/timed.ts": 8 });
    // neither measured nor in the table: it gets no entry, and so starts first
    expect("scripts/new.ts" in table).toBe(false);
  });

  it("keeps the listed order between scripts of the same seconds, and only sorts and drops without a summary", () => {
    const listed = ["scripts/a.ts", "scripts/b.ts", "scripts/c.ts", "scripts/d.ts"];
    const table = refreshTimings(listed, { "scripts/d.ts": 5, "scripts/gone.ts": 9, "scripts/c.ts": 5, "scripts/a.ts": 5, "scripts/b.ts": 70 }, []);
    expect(Object.entries(table)).toEqual([["scripts/b.ts", 70], ["scripts/a.ts", 5], ["scripts/c.ts", 5], ["scripts/d.ts", 5]]);
    expect(Object.entries(refreshTimings(listed, table, []))).toEqual(Object.entries(table));
  });

  it("reads how many runs to fetch and which summaries are on disk", () => {
    expect(refreshRequest([])).toEqual({ runs: 0, summaries: [] });
    expect(refreshRequest(["--runs", "5"])).toEqual({ runs: 5, summaries: [] });
    expect(refreshRequest(["a/summary.json", "--runs=2", "b/summary.json"])).toEqual({ runs: 2, summaries: ["a/summary.json", "b/summary.json"] });
    for (const bad of ["0", "-1", "1.5", "some", ""]) expect(() => refreshRequest([`--runs=${bad}`])).toThrow("--runs must be a whole number of runs");
    expect(() => refreshRequest(["--run", "5"])).toThrow();
  });

  // Hand-edited entries are fine; this only keeps the file in the one shape the tool writes, so a
  // refresh shows the seconds that changed and nothing else.
  it("finds scripts/ci-browser-timings.json as it would write it", () => {
    const text = readFileSync(join(import.meta.dir, "ci-browser-timings.json"), "utf8");
    const rewritten = JSON.stringify(refreshTimings(serialBrowserScripts(), JSON.parse(text) as Record<string, number>, []), null, 2) + "\n";
    if (rewritten !== text) throw new Error("scripts/ci-browser-timings.json is not sorted longest first, or names a script scripts/ci-browser.sh no longer lists: run `bun scripts/ci-browser-timings.ts`, which rewrites it without changing any listed script's seconds.");
  });
});
