import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failureSite, longestFirst, scriptTimeoutSeconds, serialBrowserScripts, shardScripts } from "./ci-browser-parallel.ts";

/** A killed process that its parent (a subreaper, say) has not reaped yet is a zombie: not alive. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z"; } catch { return true; }
};

/**
 * Runs the lane on one stub script whose last step is `end`, after it has started a process that
 * keeps the script's output open (as a stray server would) and one that ignores SIGTERM and writes
 * nowhere, and returns what the lane printed and wrote.
 */
async function runStub(end: string, timeoutSeconds: string) {
  const dir = mkdtempSync(join(tmpdir(), "browser-parallel-test-"));
  const bin = join(dir, "bin");
  const logs = join(dir, "browser-logs");
  const leftover = join(dir, "leftover.pid");
  const stubborn = join(dir, "stubborn.pid");
  const pids = () => [leftover, stubborn].filter(existsSync).map((file) => Number(readFileSync(file, "utf8")));
  mkdirSync(bin);
  writeFileSync(join(bin, "bash"), '#!/bin/sh\nprintf "/stub/chrome\\\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nif [ "$1" = scripts/demo-build.ts ]; then exit 0; fi\nsleep 1000 &\necho $! > ${leftover}\n(trap '' TERM; exec sleep 1000) >/dev/null 2>&1 &\necho $! > ${stubborn}\necho "PASS a step before the end"\necho "the last line it wrote"\n${end}\n`, { mode: 0o755 });
  try {
    const child = Bun.spawn([process.execPath, "scripts/ci-browser-parallel.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BROWSER_SCRIPTS: "scripts/ui-regression.ts",
        BROWSER_SCRIPT_TIMEOUT_SECONDS: timeoutSeconds,
        CHECK_DIR: dir,
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
    });
    const [text, , code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      text, code, signal: child.signalCode,
      retried: existsSync(join(logs, "ui-regression.attempt-1.log")),
      summary: JSON.parse(readFileSync(join(logs, "summary.json"), "utf8")),
      leftAlive: pids().filter(alive),
    };
  } finally {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("parallel browser script deadline", () => {
  it("stops a hung script and what it started at the bound, names it with its last lines, and does not run it again", async () => {
    const run = await runStub("exec sleep 1000", "1");
    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.text).toContain("[worker-0] TIMEOUT scripts/ui-regression.ts: Timed out after 1s; what it started was stopped.");
    expect(run.text).toMatch(/^\[[^\]]+\] the last line it wrote$/m);
    expect(run.text.match(/START scripts\/ui-regression\.ts/g)).toHaveLength(1);
    expect(run.retried).toBe(false);
    expect(run.summary.scripts).toEqual([expect.objectContaining({ script: "scripts/ui-regression.ts", code: 124, message: "Timed out after 1s" })]);
    expect(run.leftAlive).toEqual([]);
  }, 20_000);

  // A process whose parent has exited is found through /proc: Linux only, as CI's runners are.
  it.skipIf(process.platform !== "linux")("fails a script that exits but leaves a process holding its output, without waiting for the bound", async () => {
    // the bound is past the stub run's own 15 s limit: only the exit can end this run in time
    const run = await runStub("exit 0", "60");
    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.text).toContain("[worker-0] STOPPED scripts/ui-regression.ts: Exited 0, but a process it started still held its output; what it started was stopped.");
    expect(run.text).toMatch(/^\[[^\]]+\] the last line it wrote$/m);
    expect(run.retried).toBe(false);
    expect(run.summary.scripts).toEqual([expect.objectContaining({ code: 1, message: "Exited 0, but a process it started still held its output" })]);
    expect(run.leftAlive).toEqual([]);
  }, 20_000);

  it("reads its bound as positive seconds and refuses anything else", () => {
    expect(scriptTimeoutSeconds(undefined)).toBe(600);
    expect(scriptTimeoutSeconds("")).toBe(600);
    expect(scriptTimeoutSeconds("1.5")).toBe(1.5);
    expect(scriptTimeoutSeconds("2147483")).toBe(2147483);
    for (const bad of ["0", "-3", "soon", "Infinity", "2147484"]) expect(() => scriptTimeoutSeconds(bad)).toThrow("BROWSER_SCRIPT_TIMEOUT_SECONDS");
  });
});

describe("parallel browser script order", () => {
  it("starts the longest scripts first, counts an unlisted one as the median, and keeps the listed order on a tie", () => {
    const timings = { "a.ts": 10, "b.ts": 300, "c.ts": 50, "d.ts": 50 };
    expect(longestFirst(["a.ts", "new.ts", "c.ts", "b.ts", "d.ts"], timings)).toEqual(["b.ts", "new.ts", "c.ts", "d.ts", "a.ts"]);
    expect(longestFirst(["a.ts", "b.ts"], {})).toEqual(["a.ts", "b.ts"]);
    // an even-sized table's median is the mean of its two middle values: 155 s here, below b.ts
    expect(longestFirst(["new.ts", "b.ts", "a.ts"], { "a.ts": 10, "b.ts": 300 })).toEqual(["b.ts", "new.ts", "a.ts"]);
  });

  it("times only scripts the serial lane runs", () => {
    const timings = JSON.parse(readFileSync(join(import.meta.dir, "ci-browser-timings.json"), "utf8")) as Record<string, number>;
    const listed = serialBrowserScripts();
    expect(Object.keys(timings).filter((script) => !listed.includes(script))).toEqual([]);
    expect(Object.values(timings).every((seconds) => Number.isFinite(seconds) && seconds >= 0)).toBe(true);
  });
});

describe("parallel browser shards", () => {
  it("splits the scripts by estimated time into disjoint shards that together hold every script once", () => {
    const scripts = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const timings = { "a.ts": 200, "b.ts": 100, "c.ts": 100, "d.ts": 90, "e.ts": 10 };
    // longest first to the least-loaded shard: a -> 1; b -> 2; c -> 2 (100 < 200); d -> 1 (a tie goes to
    // the first); e -> 2 (200 < 290)
    expect(shardScripts(scripts, timings, "1/2")).toEqual(["a.ts", "d.ts"]);
    expect(shardScripts(scripts, timings, "2/2")).toEqual(["b.ts", "c.ts", "e.ts"]);
    const listed = serialBrowserScripts();
    const table = JSON.parse(readFileSync(join(import.meta.dir, "ci-browser-timings.json"), "utf8")) as Record<string, number>;
    const shards = [1, 2, 3, 4].map((k) => shardScripts(listed, table, `${k}/4`));
    expect(shards.flat().sort()).toEqual([...listed].sort());
  });

  it("deals the scripts out in turn without timings, and keeps every script without a shard", () => {
    expect(shardScripts(["a.ts", "b.ts", "c.ts"], {}, "2/2")).toEqual(["b.ts"]);
    expect(shardScripts(["a.ts", "b.ts"], {}, "1/1")).toEqual(["a.ts", "b.ts"]);
    expect(shardScripts(["a.ts", "b.ts"], {}, undefined)).toEqual(["a.ts", "b.ts"]);
    expect(shardScripts(["a.ts", "b.ts"], {}, " ")).toEqual(["a.ts", "b.ts"]);
  });

  it("refuses a shard that is not k/n with 1 <= k <= n", () => {
    for (const shard of ["0/2", "3/2", "1/0", "2", "a/b", "1/2/3"]) expect(() => shardScripts(["a.ts"], {}, shard)).toThrow("BROWSER_SHARD");
  });
});

describe("parallel browser output timestamps", () => {
  it("timestamps script log lines without changing status output or summary JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-parallel-test-"));
    const bin = join(dir, "bin");
    const logs = join(dir, "browser-logs");
    mkdirSync(bin);
    writeFileSync(join(bin, "bash"), '#!/bin/sh\nprintf "/stub/chrome\\\\n"\n', { mode: 0o755 });
    writeFileSync(join(bin, "bun"), '#!/bin/sh\nif [ "$1" = scripts/demo-build.ts ]; then exit 0; fi\nprintf "PASS stubbed browser step\\\\nFAIL stubbed failure marker\\\\nSERVER listening on 127.0.0.1:4321"\n', { mode: 0o755 });
    try {
      const child = Bun.spawn([process.execPath, "scripts/ci-browser-parallel.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BROWSER_SCRIPTS: "scripts/ui-regression.ts",
          BROWSER_RETRY: "0",
          CHECK_DIR: dir,
        },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
      });
      const [text, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(error).toBe("");
      expect(code).toBe(0);
      expect(text).toContain("[worker-0] PASS scripts/ui-regression.ts");
      const log = readFileSync(join(logs, "ui-regression.log"), "utf8");
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] PASS stubbed browser step$/m);
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] FAIL stubbed failure marker$/m);
      expect(log).toMatch(/^\[\d{4}-\d\d-\d\dT[^\]]+\] SERVER listening on 127\.0\.0\.1:4321$/m);
      expect(failureSite(`${log}[2026-10-23T00:00:00.000Z] AssertionError: stub failure\n[2026-10-23T00:00:00.000Z]     at run (/repo/scripts/ui-regression.ts:1:1)`)).toEqual({
        site: "scripts/ui-regression.ts:1",
        message: "AssertionError: stub failure",
      });
      expect(text).toContain("Total: 1/1 passed");
      const summary = readFileSync(join(logs, "summary.json"), "utf8");
      expect(summary).toContain('"workers": 1');
      expect(summary).toContain('"passed": 1');
      expect(summary).toContain('"total": 1');
      expect(summary).toContain('"flaky": []');
      expect(summary).toContain('"script": "scripts/ui-regression.ts"');
      expect(summary).toContain('"code": 0');
      expect(summary).not.toContain("timestamp");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
