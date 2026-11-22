import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { linuxStartTicks, newOwnerRecord, ownerGone, parseBirth, parseLstart, parseOwnerRecord, probeProcess, readProcessBirth } from "./process-owner.ts";

const earlierBirth = { platform: process.platform, value: process.platform === "linux" ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:1` : process.platform === "darwin" ? "Thu Jan 1 00:00:00 1970" : "1" };
const BOOT = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";

const children: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
function unrelated() {
  const child = Bun.spawn([process.execPath, "-e", "for await (const _ of console) break;"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return child;
}
afterEach(async () => {
  for (const child of children.splice(0)) { child.stdin.end(); await child.exited; }
});

/** Signal 0 to `pid` is refused (EPERM), as another user's or a protected process refuses it; every other PID is probed for real. */
function refusing(pid: number) {
  const kill = process.kill.bind(process);
  return spyOn(process, "kill").mockImplementation(((target: number, signal?: NodeJS.Signals | number) => {
    if (target === pid) throw Object.assign(new Error(`kill ${target} EPERM`), { code: "EPERM" });
    return kill(target, signal);
  }) as typeof process.kill);
}

/**
 * A running process that really refuses this one's signal 0: another user's (PID 1 is root's
 * outside a container) or, on Windows, the System process. A container whose processes all belong
 * to this user has none, and /proc mounted with hidepid hides their births.
 */
const refusedPid = process.platform === "win32" ? 4 : (process.platform === "linux" ? readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number) : [1])
  .find((pid) => probeProcess(pid) === "denied" && readProcessBirth(pid).state === "identified");

describe("process birth", () => {
  it("reads Linux start ticks after the last parenthesis, whatever the command name holds", () => {
    const fields = ["S", ...Array.from({ length: 18 }, (_, i) => String(i + 1)), "123456", "0", "0"].join(" ");
    expect(linuxStartTicks(`42 (bun) ${fields}`)).toBe("123456");
    expect(linuxStartTicks(`42 (a) b) (c) ${fields}`)).toBe("123456");
    expect(linuxStartTicks("42 (bun) S 1 2")).toBeNull();
    expect(linuxStartTicks("garbage")).toBeNull();
  });

  it("reads ps's start time only in its C-locale form", () => {
    expect(parseLstart("Wed Oct 21 17:41:40 2026\n")).toBe("Wed Oct 21 17:41:40 2026");
    expect(parseLstart("Thu Oct  1 07:01:02 2026")).toBe("Thu Oct 1 07:01:02 2026");
    expect(parseLstart("")).toBeNull();
    expect(parseLstart("21 oct. 2026 17:41:40")).toBeNull();
  });

  it("identifies a running process by the same birth on every read", () => {
    const child = unrelated();
    const first = readProcessBirth(child.pid);
    expect(first.state).toBe("identified");
    // births are compared only for one PID: on macOS they count whole seconds, so two PIDs may share one
    expect(readProcessBirth(child.pid)).toEqual(first);
  });

  it("proves a free PID absent", () => {
    expect(readProcessBirth(2147483647)).toEqual({ state: "absent" });
    expect(ownerGone({ pid: 2147483647, birth: earlierBirth })).toBe(true);
  });
});

describe("owner records", () => {
  it("records a fresh generation for every acquisition", () => {
    const first = newOwnerRecord(), second = newOwnerRecord();
    expect(first.pid).toBe(process.pid);
    expect(first.generation).not.toBe(second.generation);
    expect(first.birth).toEqual(second.birth!);
    expect(first.birth?.platform).toBe(process.platform);
  });

  it("parses only well-formed records", () => {
    expect(parseOwnerRecord(JSON.stringify({ pid: 7, generation: "g", birth: { platform: "linux", value: `${BOOT}:1` } }))).toEqual({ pid: 7, generation: "g", birth: { platform: "linux", value: `${BOOT}:1` } });
    expect(parseOwnerRecord(JSON.stringify({ pid: 7, generation: "g" }))).toEqual({ pid: 7, generation: "g" });
    for (const text of ["", "{", "null", "7", JSON.stringify({ pid: -1, generation: "g" }), JSON.stringify({ pid: 7 }), JSON.stringify({ pid: 7, generation: "g", birth: "b" }), JSON.stringify({ pid: 7, generation: "g", birth: { platform: "linux" } }), JSON.stringify({ pid: 7, generation: "g", birth: { platform: "linux", value: "b:1" } })]) {
      expect(parseOwnerRecord(text)).toBeNull();
    }
  });

  it("accepts a recorded birth only in its platform's own form", () => {
    expect(parseBirth({ platform: "linux", value: `${BOOT}:123456` })).toEqual({ platform: "linux", value: `${BOOT}:123456` });
    expect(parseBirth({ platform: "darwin", value: "Wed Oct 21 17:41:40 2026" })).toEqual({ platform: "darwin", value: "Wed Oct 21 17:41:40 2026" });
    expect(parseBirth({ platform: "win32", value: "1792000000000" })).toEqual({ platform: "win32", value: "1792000000000" });
    expect(parseBirth(earlierBirth)).toEqual(earlierBirth);
    for (const birth of [undefined, null, "b", 7, {}, { platform: "linux" }, { platform: "linux", value: 7 }, { platform: "linux", value: "" }, { platform: "linux", value: "123456" },
      { platform: "darwin", value: "21 oct. 2026 17:41:40" }, { platform: "win32", value: "-1" }, { platform: "plan9", value: "x" }, { platform: "__proto__", value: "x" }]) {
      expect(parseBirth(birth)).toBeNull();
    }
  });

  it("keeps an owner whose birth matches", () => {
    expect(ownerGone(newOwnerRecord())).toBe(false);
  });

  it("proves an owner gone when another process now holds its PID", () => {
    const child = unrelated();
    expect(ownerGone({ pid: child.pid, birth: earlierBirth })).toBe(true);
    expect(() => process.kill(child.pid, 0)).not.toThrow();
  });

  it("keeps an owner whose recorded birth is malformed", () => {
    const child = unrelated();
    for (const birth of [{ platform: process.platform }, { platform: process.platform, value: 7 }, { platform: process.platform, value: "" }, { platform: process.platform, value: "an earlier process" }, null, "b"]) {
      expect(ownerGone({ pid: child.pid, birth })).toBe(false);
    }
    expect(ownerGone({ pid: child.pid, birth: earlierBirth })).toBe(true);
  });

  it.skipIf(process.platform !== "linux" || !Bun.which("setsid"))("proves an exited, unreaped owner gone, its birth still matching", async () => {
    // the inner shell exits at once; its parent turns into a sleep that never reaps it
    const parent = Bun.spawn(["sh", "-c", "setsid sh -c 'echo $$; exec sleep 0.2' & exec sleep 30"], { stdout: "pipe", stderr: "ignore" });
    try {
      const reader = parent.stdout.getReader();
      const pid = Number(new TextDecoder().decode((await reader.read()).value).trim());
      const reading = readProcessBirth(pid);
      expect(reading.state).toBe("identified");
      const record = { pid, birth: reading.state === "identified" ? reading.birth : undefined };
      const state = () => readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
      const deadline = Date.now() + 5_000;
      while (state() !== "Z" && Date.now() < deadline) await Bun.sleep(20);
      expect(state()).toBe("Z");
      expect(probeProcess(pid), "control: the zombie still answers signal 0").toBe("running");
      expect(ownerGone(record), "regression: a zombie owner with its own birth kept its lock").toBe(true);
      expect(ownerGone({ pid }), "a PID-only record of a zombie").toBe(true);
    } finally { parent.kill("SIGKILL"); }
  }, 30_000);

  it("keeps legacy, foreign-platform and unreadable owners live", () => {
    const child = unrelated();
    expect(ownerGone({ pid: child.pid })).toBe(false);
    expect(ownerGone({ pid: child.pid, birth: { platform: "plan9", value: "x" } })).toBe(false);
  });

  it("compares births when the probe is refused (EPERM)", () => {
    // regression: a refused probe once kept every owner, so a lock or descriptor whose PID another
    // user's process took after a reboot (or a SYSTEM service after a forced Windows shutdown)
    // blocked every start
    const child = unrelated();
    const reading = readProcessBirth(child.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${child.pid}`);
    const refused = refusing(child.pid);
    try {
      expect(probeProcess(child.pid)).toBe("denied");
      expect(ownerGone({ pid: child.pid, birth: earlierBirth })).toBe(true);
      // a refused probe never proves the owner gone by itself: a matching birth, or none, keeps it
      expect(ownerGone({ pid: child.pid, birth: reading.birth })).toBe(false);
      expect(ownerGone({ pid: child.pid })).toBe(false);
    } finally { refused.mockRestore(); }
  });

  it.skipIf(refusedPid === undefined)("reads the birth of a process it may not signal", () => {
    // the same rule against a real refusal: on Windows that birth comes from CIM, which reads
    // processes that Get-Process cannot open
    const pid = refusedPid!;
    const reading = readProcessBirth(pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${pid}`);
    expect(reading.birth.value).not.toBe(earlierBirth.value);
    expect(ownerGone({ pid, birth: earlierBirth })).toBe(true);
    expect(ownerGone({ pid, birth: reading.birth })).toBe(false);
    expect(ownerGone({ pid })).toBe(false);
    expect(probeProcess(pid)).toBe("denied");
  });
});
