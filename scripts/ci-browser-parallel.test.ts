import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processStart } from "./check.ts";
import { parseLaneLog } from "./ci-flakes.ts";
import { demoOnlyScripts, programName, processName, failureSite, longestFirst, quarantineNote, quarantineStatus, scriptTimeoutSeconds, serialBrowserScripts, shardScripts, stopReport, stopRun } from "./ci-browser-parallel.ts";
import { QUARANTINE, QUARANTINE_MAX_DAYS } from "./ci-browser-quarantine.ts";
import type { StopIo } from "./ci-browser-parallel.ts";

/** A killed process that its parent (a subreaper, say) has not reaped yet is a zombie: not alive. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "")[0] !== "Z"; } catch { return true; }
};

const STAND_IN = ["sleep", "1000"];

const commandLine = (pid: number): string[] | null => {
  if (process.platform === "linux") {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1); } catch { return null; }
  }
  const ps = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  return ps.status === 0 ? ps.stdout.trim().split(/\s+/) : null;
};

/**
 * The stand-in a record names, while that very process still runs, else null. The stub writes the
 * record, "<pid> <start>", as soon as it has started the stand-in: its own child, which it has not
 * reaped, so that pid cannot belong to anything else yet. A pid alone proves nothing later: once the
 * stand-in has ended, its number may be given to any other process of this user. So the process
 * must still have started when the record says (processStart: the boot and clock tick on Linux),
 * not be a zombie, and run the stand-in's command.
 */
function standIn(record: string): number | null {
  const match = /^(\d+) (.+)\n$/.exec(record);
  if (!match) throw new Error(`not a stand-in record: ${JSON.stringify(record)}`);
  const pid = Number(match[1]);
  // the start last: it is what tells this process from a later one, so it is read nearest the signal
  return alive(pid) && commandLine(pid)?.join(" ") === STAND_IN.join(" ") && processStart(pid) === match[2] ? pid : null;
}

/** Ends the stand-in a record names, only when standIn proves it is still that process. */
function stopStandIn(record: string): void {
  const pid = standIn(record);
  if (pid !== null) process.kill(pid, "SIGKILL");
}

/**
 * The stub's shell function that prints what processStart says of pid $1 (here a child of the
 * stub's own): on Linux the boot id and the start in clock ticks, /proc/<pid>/stat's field 22,
 * read after the command name in parentheses; on macOS ps's start, in its clock and words.
 */
const STARTED = [
  "started() {",
  "  if [ -r /proc/$1/stat ]; then printf '%s:%s\\n' \"$(cat /proc/sys/kernel/random/boot_id)\" \"$(sed 's/.*) //' /proc/$1/stat | cut -d' ' -f20)\"",
  "  else LC_ALL=C TZ=UTC ps -o lstart= -p $1 | sed 's/^ *//;s/ *$//'; fi",
  "}",
].join("\n");

async function runStub(end: string, timeoutSeconds: string) {
  const dir = mkdtempSync(join(tmpdir(), "browser-parallel-test-"));
  const bin = join(dir, "bin");
  const logs = join(dir, "browser-logs");
  const leftover = join(dir, "leftover.pid");
  const stubborn = join(dir, "stubborn.pid");
  mkdirSync(bin);
  writeFileSync(join(bin, "bash"), '#!/bin/sh\nprintf "/stub/chrome\\\\n"\n', { mode: 0o755 });
  writeFileSync(join(bin, "bun"), `#!/bin/sh\nif [ "$1" = scripts/demo-build.ts ]; then exit 0; fi\n${STARTED}\n(exec ${STAND_IN.join(" ")}) &\necho "$! $(started $!)" > ${leftover}\n(trap '' TERM; exec ${STAND_IN.join(" ")}) >/dev/null 2>&1 &\necho "$! $(started $!)" > ${stubborn}\necho "PASS a step before the end"\necho "the last line it wrote"\n${end}\n`, { mode: 0o755 });
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
      leftAlive: [leftover, stubborn].map((file) => standIn(readFileSync(file, "utf8"))).filter((pid) => pid !== null),
    };
  } finally {
    try {
      for (const file of [leftover, stubborn]) {
        // a record that cannot be read proves nothing: it is left alone, and the error the run raised for it stands
        try { if (existsSync(file)) stopStandIn(readFileSync(file, "utf8")); } catch { /* unproven: left alone */ }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const ran = Promise.resolve();

function stubIo(parts: Omit<StopIo, "marked" | "now" | "graceMs"> & { marked?: StopIo["marked"] }, graceMs: number): StopIo {
  let clock = 0;
  return { ...parts, processes: async () => { clock += 10; return parts.processes(); }, marked: parts.marked ?? (() => true), now: () => clock, graceMs };
}

describe("parallel browser script deadline", () => {
  it("stops a hung script and what it started at the bound, names it with its last lines, and does not run it again", async () => {
    const run = await runStub("exec sleep 1000", "1");
    expect(run.signal).toBeNull();
    expect(run.code).toBe(1);
    expect(run.text).toMatch(/\[worker-0\] TIMEOUT scripts\/ui-regression\.ts: Timed out after 1s; stopped \d+ processes\. Last/);
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
    expect(run.text).toMatch(/\[worker-0\] STOPPED scripts\/ui-regression\.ts: Exited 0, but a process it started still held its output; stopped \d+ processes\. Last/);
    expect(run.text).toMatch(/^\[[^\]]+\] the last line it wrote$/m);
    expect(run.retried).toBe(false);
    expect(run.summary.scripts).toEqual([expect.objectContaining({ code: 1, message: "Exited 0, but a process it started still held its output" })]);
    expect(run.leftAlive).toEqual([]);
  }, 20_000);

  it("names what SIGKILL did not end within the grace, and says it was NOT stopped", async () => {
    const alive = new Set([11, 12, 13]);
    const sent: string[] = [];
    const io = stubIo({
      processes: async () => [...alive],
      signal: (pids, name) => {
        for (const pid of pids) {
          sent.push(`${name} ${pid}`);
          if (pid === 11 || (pid === 12 && name === "SIGKILL")) alive.delete(pid);
        }
        return [];
      },
      running: (pid) => alive.has(pid),
      command: (pid) => `stub-${pid}`,
    }, 50);
    const stop = await stopRun(io, ran);
    expect(sent).toEqual(["SIGTERM 11", "SIGTERM 12", "SIGTERM 13", "SIGKILL 12", "SIGKILL 13"]);
    expect(stop).toEqual({ stopped: 2, survivors: ["13 (stub-13)"], unsure: false });
    expect(stopReport("Timed out after 5s", stop)).toBe("Timed out after 5s; stopped 2 processes; could NOT stop: 13 (stub-13).");
    // one that ends on SIGKILL only once the kernel runs it again: waited for, and not named
    const late = new Set([21]);
    let killed = false;
    const lateIo = stubIo({
      processes: async () => [...late],
      signal: (_pids, name) => { if (name === "SIGKILL") killed = true; return []; },
      running: (() => { let looks = 0; return (pid: number) => !(killed && ++looks > 1) && late.has(pid); })(),
      command: () => "slow",
    }, 50);
    const lateStop = await stopRun(lateIo, ran);
    expect(lateStop).toEqual({ stopped: 1, survivors: [], unsure: false });
    expect(stopReport("Timed out after 5s", lateStop)).toBe("Timed out after 5s; stopped 1 process.");
  });

  it("kills and names a process the run forks after the first look, and not a pid that was reused", async () => {
    const alive = new Set([12]);
    const marked = new Set([12]);
    const sent: string[] = [];
    const io = stubIo({
      processes: async () => [...marked].filter((pid) => alive.has(pid)),
      signal: (pids, name) => {
        for (const pid of pids) {
          sent.push(`${name} ${pid}`);
          if (name !== "SIGKILL") continue;
          if (pid === 12) { alive.delete(12); alive.add(14); marked.add(14); }
          if (pid === 14) { alive.delete(14); alive.add(15); marked.add(15); }
        }
        return [];
      },
      running: (pid) => alive.has(pid),
      command: (pid) => `stub-${pid}`,
    }, 50);
    const stop = await stopRun(io, ran);
    expect(sent).toEqual(["SIGTERM 12", "SIGKILL 12", "SIGKILL 14", "SIGKILL 15"]);
    expect(stop).toEqual({ stopped: 2, survivors: ["15 (stub-15)"], unsure: false });
    // 31 ends on SIGKILL and its pid is taken by an unrelated process, which is not the run's (no mark)
    let ended = false;
    const reuseIo = stubIo({
      processes: async () => (ended ? [] : [31]),
      signal: (_pids, name) => { if (name === "SIGKILL") ended = true; return []; },
      running: (pid) => pid === 31,
      command: () => "unrelated-daemon",
    }, 50);
    expect(await stopRun(reuseIo, ran)).toEqual({ stopped: 1, survivors: [], unsure: false });
  });

  it("does not take a signal the system refused (EPERM) for a stop", async () => {
    // 41 is refused every signal and its liveness check is refused too, so it reads as not running; 42 ends on SIGTERM
    const alive = new Set([41, 42]);
    const io = stubIo({
      processes: async () => [...alive],
      signal: (pids, name) => {
        if (name === "SIGTERM" && pids.includes(42)) alive.delete(42);
        return pids.filter((pid) => pid === 41);
      },
      running: () => false,
      command: (pid) => `stub-${pid}`,
    }, 50);
    expect(await stopRun(io, ran)).toEqual({ stopped: 1, survivors: ["41 (stub-41)"], unsure: true });
  });

  it("does not signal a process whose mark is gone by the signal, and names it as not stopped", async () => {
    // 12 forks 14 on SIGKILL; by the next signal 14's pid belongs to an unrelated process (its mark is gone)
    const alive = new Set([12]);
    const found = new Set([12]);
    const sent: string[] = [];
    const io = stubIo({
      processes: async () => [...found].filter((pid) => alive.has(pid)),
      signal: (pids, name) => {
        for (const pid of pids) {
          sent.push(`${name} ${pid}`);
          if (name === "SIGKILL" && pid === 12) { alive.delete(12); alive.add(14); found.add(14); }
        }
        return [];
      },
      running: (pid) => alive.has(pid),
      marked: (pid) => pid !== 14,
      command: (pid) => `stub-${pid}`,
    }, 50);
    const stop = await stopRun(io, ran);
    expect(sent).toEqual(["SIGTERM 12", "SIGKILL 12"]);
    expect(stop).toEqual({ stopped: 1, survivors: ["14 (stub-14)"], unsure: true });
  });

  it("does not name a process that ended by itself between the scan and the mark check", async () => {
    const alive = new Set([12]);
    const found = new Set([12]);
    const sent: string[] = [];
    const io = stubIo({
      processes: async () => [...found].filter((pid) => alive.has(pid) || pid === 14),
      signal: (pids, name) => {
        for (const pid of pids) {
          sent.push(`${name} ${pid}`);
          if (name === "SIGKILL" && pid === 12) { alive.delete(12); alive.add(15); found.add(14); found.add(15); }
        }
        return [];
      },
      running: (pid) => alive.has(pid),
      marked: () => false,
      command: (pid) => `stub-${pid}`,
    }, 50);
    const stop = await stopRun(io, ran);
    expect(sent).toEqual(["SIGTERM 12", "SIGKILL 12"]);
    expect(stop.survivors).toEqual(["15 (stub-15)"]);
  });

  it("names at most 20 survivors, then how many more", async () => {
    const pids = Array.from({ length: 27 }, (_, i) => 100 + i);
    const io = stubIo({
      processes: async () => pids,
      signal: () => [],
      running: () => true,
      command: (pid) => `p${pid}`,
    }, 50);
    const stop = await stopRun(io, ran);
    expect(stop.survivors).toHaveLength(21);
    expect(stop.survivors[0]).toBe("100 (p100)");
    expect(stop.survivors[19]).toBe("119 (p119)");
    expect(stop.survivors[20]).toBe("and 7 more");
    expect(stop.stopped).toBe(0);
  });

  it("names a program by its executable's file alone, in plain characters and a short length", () => {
    expect(programName("/usr/bin/curl")).toBe("curl");
    expect(programName("/usr/bin/curl (deleted)")).toBe("curl");
    expect(programName("/opt/x y:z@h/tool")).toBe("tool");
    expect(programName("/opt/user:SECRET@h")).toBe("user?SECRET?h");
    expect(programName(`/opt/${"x".repeat(100)}`)).toBe("x".repeat(64));
    expect(programName("")).toBe("");
  });

  it.skipIf(process.platform !== "linux")("takes a process's name from its executable, never from the argv[0] it sets", async () => {
    // a process this test starts, which calls itself by a credential
    for (const argv0 of ["user:SECRET@host", "curl https://user:SECRET@h", "https://x-access-token:SECRET@h/x"]) {
      const child = Bun.spawn(["cat"], { argv0, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
      try {
        // Spawn can return before /proc/<pid>/exe changes. Only cat can echo the byte after exec.
        const ready = child.stdout.getReader().read();
        child.stdin.write(Uint8Array.of(1));
        child.stdin.flush();
        expect((await ready).value).toEqual(Uint8Array.of(1));
        const name = processName(child.pid);
        expect(name).toBe("cat");
        expect(name).not.toContain("SECRET");
      } finally {
        child.kill("SIGKILL");
        await child.exited;
      }
    }
    // no /proc/<pid>/exe to read (no such process): the pid stands alone
    expect(processName(2 ** 22 + 1)).toBe("");
  });

  it("names a process it cannot read by its pid alone", async () => {
    const io = stubIo({
      processes: async () => [71],
      signal: (pids) => pids,
      running: () => false,
      command: () => "",
    }, 50);
    const stop = await stopRun(io, ran);
    expect(stop.survivors).toEqual(["71"]);
    expect(stopReport("Timed out after 5s", stop)).toContain("could NOT stop: 71;");
  });

  it("lets no command text reach the flake issue's parser, so a stopped row keeps its own failure", () => {
    // hostile program names: the words the parser reads a timeout from, a FAILED header, a path in a stack frame
    const hostile = ["Timed out after 600s", "(exit 124", "FAILED scripts/injected.ts (exit 1)", "x\nFAILED scripts/injected.ts (exit 124)", "/w/ovis/scripts/other.ts:9:1"];
    for (const name of hostile) {
      const detail = stopReport("Exited 1, but a process it started still held its output", { stopped: 1, survivors: [`9 (${programName(`/bin/${name}`)})`], unsure: false });
      const rows = parseLaneLog(`FAILED scripts/c-regression.ts (exit 1), full log: /tmp/c.log; ${detail}
TypeError: closed
    at end (/w/ovis/scripts/c-regression.ts:9:1)
`);
      expect(rows).toEqual([{ script: "scripts/c-regression.ts", outcome: "failed", site: "scripts/c-regression.ts:9", message: "TypeError: closed" }]);
    }
  });

  it("keeps naming a process that refused a signal after a later scan no longer finds it", async () => {
    // 61 is another user's and refuses SIGTERM; 62 ends on it. The script then ends, and no scan finds 61's tree again
    let found = [61, 62];
    const io = stubIo({
      processes: async () => found,
      signal: (pids, name) => {
        if (name === "SIGTERM") found = [];
        return pids.filter((pid) => pid === 61);
      },
      running: () => false,
      command: (pid) => `stub-${pid}`,
    }, 50);
    const stop = await stopRun(io, ran);
    expect(stop).toEqual({ stopped: 1, survivors: ["61 (stub-61)"], unsure: true });
    expect(stopReport("Timed out after 5s", stop)).toBe("Timed out after 5s; stopped 1 process; could NOT stop: 61 (stub-61); processes started at the last moment may not be listed.");
  });

  it("does not say a run was stopped cleanly when a process was forked as the last kill landed", async () => {
    const alive = new Set([12]);
    const marked = new Set([12]);
    const io = stubIo({
      processes: async () => [...marked].filter((pid) => alive.has(pid)),
      signal: (pids, name) => {
        for (const pid of pids) {
          if (name !== "SIGKILL") continue;
          alive.delete(pid);
          if (pid === 12 || pid === 14) { alive.add(pid + (pid === 12 ? 2 : 1)); marked.add(pid + (pid === 12 ? 2 : 1)); }
        }
        return [];
      },
      running: (pid) => alive.has(pid),
      command: (pid) => `stub-${pid}`,
    }, 0);
    const stop = await stopRun(io, ran);
    expect(alive.has(15)).toBe(true);
    expect(stop).toEqual({ stopped: 2, survivors: [], unsure: true });
    expect(stopReport("Timed out after 5s", stop)).toBe("Timed out after 5s; stopped 2 processes; processes started at the last moment may not be listed.");
  });

  // A stand-in the stub records that standIn could never prove would read as gone, and leftAlive would pass unchecked.
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("records a start exactly as processStart names it", () => {
    const own = processStart(process.pid);
    expect(own).not.toBeNull();
    expect(spawnSync("sh", ["-c", `${STARTED}\nstarted ${process.pid}`], { encoding: "utf8" }).stdout).toBe(`${own}\n`);
  });

  // Every process here is one this test started for the purpose, its handle kept: nothing else is signalled.
  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("ends a recorded stand-in only, never another process its pid names", async () => {
    const start = (command: string[]) => Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const recorded = start(STAND_IN);
    const later = start(STAND_IN);
    const other = start(["sleep", "999"]);
    const startOf = (pid: number) => processStart(pid) ?? "";
    const records = [
      `${recorded.pid} ${startOf(recorded.pid)}\n`,
      `${later.pid} ${startOf(later.pid).replace(/\d+$/, (n) => String(Number(n) - 1))}\n`,
      `${other.pid} ${startOf(other.pid)}\n`,
    ];
    try {
      expect(standIn(records[0]!)).toBe(recorded.pid);
      for (const record of records) stopStandIn(record);
      // a SIGKILL sent above would end them before the SIGTERM sent here
      later.kill("SIGTERM");
      other.kill("SIGTERM");
      await Promise.all([recorded.exited, later.exited, other.exited]);
      expect([recorded.signalCode, later.signalCode, other.signalCode]).toEqual(["SIGKILL", "SIGTERM", "SIGTERM"]);
    } finally {
      for (const child of [recorded, later, other]) child.kill("SIGKILL");
    }
  });

  it("reads its bound as positive seconds and refuses anything else", () => {
    expect(scriptTimeoutSeconds(undefined)).toBe(600);
    expect(scriptTimeoutSeconds("")).toBe(600);
    expect(scriptTimeoutSeconds("1.5")).toBe(1.5);
    expect(scriptTimeoutSeconds("2147483")).toBe(2147483);
    for (const bad of ["0", "-3", "soon", "Infinity", "2147484"]) expect(() => scriptTimeoutSeconds(bad)).toThrow("BROWSER_SCRIPT_TIMEOUT_SECONDS");
  });
});

describe("parallel browser script order", () => {
  it("starts the longest scripts first and keeps the listed order on a tie", () => {
    const timings = { "a.ts": 10, "b.ts": 300, "c.ts": 50, "d.ts": 50, "e.ts": 0 };
    expect(longestFirst(["e.ts", "a.ts", "d.ts", "b.ts", "c.ts"], timings)).toEqual(["b.ts", "d.ts", "c.ts", "a.ts", "e.ts"]);
    expect(longestFirst(["a.ts", "b.ts"], {})).toEqual(["a.ts", "b.ts"]);
  });

  // Nobody has measured it: counted as a typical script, relay-e2e (300 s) started 124th of 184
  // and ran on alone for four minutes after every other script had ended.
  it("starts a script the table does not hold before the longest one it does", () => {
    const timings = { "a.ts": 10, "b.ts": 300, "c.ts": 50 };
    expect(longestFirst(["a.ts", "new.ts", "c.ts", "b.ts"], timings)).toEqual(["new.ts", "b.ts", "c.ts", "a.ts"]);
    expect(longestFirst(["a.ts", "new-1.ts", "b.ts", "new-2.ts", "c.ts", "new-3.ts"], timings))
      .toEqual(["new-1.ts", "new-2.ts", "new-3.ts", "b.ts", "c.ts", "a.ts"]);
    expect(longestFirst(["a.ts", "odd.ts", "b.ts"], { ...timings, "odd.ts": Number.NaN })).toEqual(["odd.ts", "b.ts", "a.ts"]);
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
    expect(shardScripts(scripts, timings, "1/2")).toEqual(["a.ts", "d.ts"]);
    expect(shardScripts(scripts, timings, "2/2")).toEqual(["b.ts", "c.ts", "e.ts"]);
    const listed = serialBrowserScripts();
    const table = JSON.parse(readFileSync(join(import.meta.dir, "ci-browser-timings.json"), "utf8")) as Record<string, number>;
    const shards = [1, 2, 3, 4].map((k) => shardScripts(listed, table, `${k}/4`));
    expect(shards.flat().sort()).toEqual([...listed].sort());
  });

  it("counts a script the table does not hold as the median in a shard's load, and deals it out in that place", () => {
    const timings = { "a.ts": 300, "b.ts": 100, "c.ts": 20 };
    expect(shardScripts(["new.ts", "a.ts", "b.ts", "c.ts"], timings, "1/2")).toEqual(["a.ts"]);
    expect(shardScripts(["new.ts", "a.ts", "b.ts", "c.ts"], timings, "2/2")).toEqual(["new.ts", "b.ts", "c.ts"]);
    const even = { "a.ts": 100, "b.ts": 100, "c.ts": 100 };
    expect(shardScripts(["new-1.ts", "new-2.ts", "a.ts"], even, "1/2")).toEqual(["new-1.ts", "a.ts"]);
    expect(shardScripts(["new-1.ts", "new-2.ts", "a.ts"], even, "2/2")).toEqual(["new-2.ts"]);
  });

  it("still deals every script to one shard, in the listed order, when the table holds only some of them", () => {
    const listed = serialBrowserScripts();
    const table = JSON.parse(readFileSync(join(import.meta.dir, "ci-browser-timings.json"), "utf8")) as Record<string, number>;
    const half = Object.fromEntries(Object.entries(table).filter((_, index) => index % 2 === 0));
    for (const total of [1, 2, 3, 4, 7]) {
      const shards = Array.from({ length: total }, (_, k) => shardScripts(listed, half, `${k + 1}/${total}`));
      expect(shards.flat().sort()).toEqual([...listed].sort());
      for (const shard of shards) expect(shard).toEqual(listed.filter((script) => shard.includes(script)));
      expect(shards).toEqual(Array.from({ length: total }, (_, k) => shardScripts(listed, half, `${k + 1}/${total}`)));
    }
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

describe("browser flake quarantine", () => {
  const entry = { until: "2026-12-02", issue: 4026 };

  it("excuses a listed script through its end date, and no longer after it", () => {
    expect(quarantineStatus("scripts/a.ts", {}, "2026-11-18")).toEqual({ state: "unlisted" });
    expect(quarantineStatus("scripts/a.ts", { "scripts/a.ts": entry }, "2026-12-02")).toEqual({ state: "quarantined", entry });
    expect(quarantineStatus("scripts/a.ts", { "scripts/a.ts": entry }, "2026-12-03")).toEqual({ state: "ended", entry });
  });

  it("names the issue of a quarantined script, and the fix for one that fails the lane", () => {
    expect(quarantineNote({ state: "quarantined", entry })).toContain("until 2026-12-02 (#4026)");
    for (const status of [{ state: "unlisted" } as const, { state: "ended", entry } as const]) {
      expect(quarantineNote(status)).toContain("fails the lane");
      expect(quarantineNote(status)).toContain("scripts/ci-browser-quarantine.ts");
    }
    expect(quarantineNote({ state: "ended", entry })).toContain("ran out after 2026-12-02");
  });

  it("lists only scripts the lane runs, each with its issue and an end date at most the limit ahead", () => {
    const lane = serialBrowserScripts();
    const today = new Date().toISOString().slice(0, 10);
    const limit = new Date(Date.parse(`${today}T00:00:00Z`) + QUARANTINE_MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
    const wrong = Object.entries(QUARANTINE).flatMap(([script, { until, issue }]) => [
      ...(lane.includes(script) ? [] : [`${script}: not in scripts/ci-browser.sh`]),
      ...(/^\d{4}-\d\d-\d\d$/.test(until) && !Number.isNaN(Date.parse(`${until}T00:00:00Z`)) && new Date(`${until}T00:00:00Z`).toISOString().startsWith(until) ? [] : [`${script}: until "${until}" is not a YYYY-MM-DD date`]),
      ...(until <= limit ? [] : [`${script}: until ${until} is more than ${QUARANTINE_MAX_DAYS} days ahead (${limit} at most)`]),
      ...(Number.isInteger(issue) && issue > 0 ? [] : [`${script}: issue ${issue} is not an issue number`]),
    ]);
    expect(wrong).toEqual([]);
  });

  it("fails the lane when a script that is not quarantined passes only on its second run", async () => {
    const script = serialBrowserScripts().find((name) => !(name in QUARANTINE))!;
    const name = script.replace(/^scripts\//, "").replace(/\.ts$/, "");
    const dir = mkdtempSync(join(tmpdir(), "browser-parallel-test-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bash"), '#!/bin/sh\nprintf "/stub/chrome\\\\n"\n', { mode: 0o755 });
    writeFileSync(join(bin, "bun"), `#!/bin/sh\nif [ "$1" = scripts/demo-build.ts ]; then exit 0; fi\nif [ -e ${dir}/ran ]; then echo "PASS on the second run"; exit 0; fi\ntouch ${dir}/ran\necho "AssertionError: a stub race"\nexit 1\n`, { mode: 0o755 });
    try {
      const child = Bun.spawn([process.execPath, "scripts/ci-browser-parallel.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BROWSER_SCRIPTS: script, BROWSER_EXCLUDE: "", BROWSER_SHARD: "", BROWSER_RETRY: "", CHECK_DIR: dir, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "" },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
      });
      const [text, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(1);
      expect(text).toContain(`FLAKY ${script} (`);
      expect(text).toContain("It is not quarantined, so it fails the lane");
      expect(parseLaneLog(text)).toEqual([{ script, outcome: "flaky", site: null, message: "AssertionError: a stub race" }]);
      const summary = JSON.parse(readFileSync(join(dir, "browser-logs", "summary.json"), "utf8"));
      expect(summary.flaky).toEqual([script]);
      expect(summary.notQuarantined).toEqual([script]);
      expect(existsSync(join(dir, "browser-logs", `${name}.attempt-1.log`))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the scripts a change to the server alone leaves out", () => {
  /** A repository of `files`, with the demo app's entries unless `files` names them. */
  const repoOf = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "demo-only-"));
    const app = { "scripts/demo-build.ts": "", "vite.config.ts": "import './scripts/plugin.ts';", "scripts/plugin.ts": "", "src/main.tsx": "import '../shared/protocol.ts';", "src/pwa.ts": "", "site/demo/transport.ts": "import '../../src/lib/api';", "src/lib/api.ts": "", "shared/protocol.ts": "" };
    for (const [file, text] of Object.entries({ ...app, ...files })) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), text);
    }
    return root;
  };
  const withRepo = (files: Record<string, string>, check: (root: string) => void): void => {
    const root = repoOf(files);
    try { check(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };

  it("are the demo scripts that load no file of the server through any chain", () => {
    withRepo({
      "scripts/pure-demo-regression.ts": "import { x } from './lib/page.ts'; import '../shared/protocol.ts';",
      "scripts/lib/page.ts": "import '../../src/lib/api';",
      "scripts/deep-demo-regression.ts": "import './lib/helper';",
      "scripts/lib/helper.ts": "export const load = () => import('../../server/http.ts');",
      "scripts/direct-demo-regression.ts": "import { createServer } from '../server/index';",
      "scripts/spawn-demo-regression.ts": "Bun.spawn(['bun', join(repo, 'server', 'index.ts')]);",
      "scripts/path-demo-regression.ts": "const fixture = readFileSync('server/fixtures/a.json');",
      "scripts/missing-demo-regression.ts": "import './lib/gone';",
      "scripts/computed-demo-regression.ts": "const helper = './lib/page.ts'; await import(helper);",
      "scripts/spaced-demo-regression.ts": "const helper = './lib/page.ts'; await import /* loader */ (helper);",
      "scripts/template-demo-regression.ts": "const access = readFileSync(`${process.cwd()}/server/access.ts`);",
      "scripts/rooted-demo-regression.ts": "import { x } from '/server/http.ts';",
      "scripts/glob-demo-regression.ts": "const all = import.meta.glob('../src/*.ts');",
      "scripts/shell-demo-regression.ts": "Bun.spawnSync(['sh', '-c', 'cat server/http.ts']);",
      "scripts/broken-demo-regression.ts": "import { x } from './lib/page.ts'; const = ;",
      "scripts/typed-demo-regression.ts": "const page: typeof import('./lib/page.ts') = await import('./lib/page.ts'); await import(`data:text/javascript;base64,${code}`);",
      "scripts/pure-regression.ts": "",
      "server/http.ts": "", "server/index.ts": "",
    }, (root) => {
      const all = ["pure-demo", "deep-demo", "direct-demo", "spawn-demo", "path-demo", "missing-demo", "computed-demo", "spaced-demo", "template-demo", "rooted-demo", "glob-demo", "shell-demo", "broken-demo", "typed-demo", "pure"].map((name) => `scripts/${name}-regression.ts`);
      expect(demoOnlyScripts(all, root)).toEqual(["scripts/pure-demo-regression.ts", "scripts/typed-demo-regression.ts"]);
    });
  });

  it("are none when the demo app itself loads a file of the server, or one it names as it runs", () => {
    withRepo({ "scripts/pure-demo-regression.ts": "", "site/demo/transport.ts": "import { x } from '../../server/entries';", "server/entries.ts": "" }, (root) => {
      expect(demoOnlyScripts(["scripts/pure-demo-regression.ts"], root)).toEqual([]);
    });
    withRepo({ "scripts/pure-demo-regression.ts": "", "src/pwa.ts": "const worker = './sw.ts'; void import(worker);" }, (root) => {
      expect(demoOnlyScripts(["scripts/pure-demo-regression.ts"], root)).toEqual([]);
    });
    // an entry vite.config.ts's plugin bundles, and a config that reads a server file as it builds
    withRepo({ "scripts/pure-demo-regression.ts": "", "scripts/plugin.ts": "const entry = new URL('../src/boot.ts', import.meta.url);", "src/boot.ts": "import { on } from '../server/flags';", "server/flags.ts": "" }, (root) => {
      expect(demoOnlyScripts(["scripts/pure-demo-regression.ts"], root)).toEqual([]);
    });
    withRepo({ "scripts/pure-demo-regression.ts": "", "scripts/plugin.ts": "const name = '../src/boot.ts'; const entry = new URL(name, import.meta.url);", "src/boot.ts": "" }, (root) => {
      expect(demoOnlyScripts(["scripts/pure-demo-regression.ts"], root)).toEqual([]);
    });
    withRepo({ "scripts/pure-demo-regression.ts": "", "vite.config.ts": "const revision = readFileSync('server/app-revision.ts', 'utf8');" }, (root) => {
      expect(demoOnlyScripts(["scripts/pure-demo-regression.ts"], root)).toEqual([]);
    });
  });

  const lane = (env: Record<string, string>) => spawnSync("bun", ["scripts/ci-browser-parallel.ts"], {
    cwd: join(import.meta.dir, ".."),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, BROWSER_SCRIPTS: "scripts/sidebar-filter-demo-regression.ts,scripts/sidebar-spacing-demo-regression.ts", BROWSER_SHARD: "2/2", BROWSER_LIVE_ONLY: "", ...env },
  });

  it("let a part they leave empty pass without starting a browser, and a part empty before them fail", () => {
    const empty = lane({ BROWSER_LIVE_ONLY: "true" });
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toContain("no script left for this part (shard 2/2)");
    expect(empty.stdout).not.toContain("Building demo app");
    const unexplained = lane({ BROWSER_SCRIPTS: "scripts/sidebar-filter-demo-regression.ts" });
    expect(unexplained.status).toBe(1);
    expect(unexplained.stderr).toContain("No browser scripts selected for shard 2/2");
    const emptyAnyway = lane({ BROWSER_LIVE_ONLY: "true", BROWSER_SHARD: "3/3", BROWSER_SCRIPTS: "scripts/sidebar-filter-demo-regression.ts,scripts/ui-regression.ts" });
    expect(emptyAnyway.status).toBe(1);
    expect(emptyAnyway.stderr).toContain("No browser scripts selected for shard 3/3");
  });
});
