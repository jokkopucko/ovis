import { describe, expect, it } from "bun:test";
import { createUnixHost } from "./unix.ts";

// The real host's wiring over stand-ins for stdin, stdout and the process: never this test's own
// terminal. tui/host/restore.contract.test.ts runs the same host on a real pseudo-terminal.
const ESC = "\x1b";
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[>1u`;
const LEAVE = `${ESC}[<u${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?2004l${ESC}[?1004l${ESC}[?25h${ESC}[?1049l`;

type Listener = (...args: unknown[]) => void;

class Emitter {
  readonly listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener) { (this.listeners.get(event) ?? this.listeners.set(event, new Set()).get(event)!).add(listener); return this; }
  off(event: string, listener: Listener) { this.listeners.get(event)?.delete(listener); return this; }
  emit(event: string, ...args: unknown[]) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); }
  count(event: string) { return this.listeners.get(event)?.size ?? 0; }
}

function standIns(options: { stdinTTY?: boolean; stdoutTTY?: boolean; env?: Record<string, string>; parentStopping?: boolean } = {}) {
  const log: string[] = [];
  const waiting: Buffer[] = [];
  const stdin = Object.assign(new Emitter(), {
    isTTY: options.stdinTTY ?? true,
    setRawMode: (on: boolean) => { log.push(`raw ${on ? "on" : "off"}`); },
    read: () => waiting.shift() ?? null,
    pause: () => { log.push("pause"); },
    unref: () => { log.push("unref"); },
  });
  const stdout = Object.assign(new Emitter(), { isTTY: options.stdoutTTY ?? true, fd: 1, columns: 120, rows: 40 });
  const proc = Object.assign(new Emitter(), { exit: (code: number) => { log.push(`exit ${code}`); }, pid: 4242, ppid: 4241, kill: (pid: number, signal: string) => { log.push(`kill ${pid} ${signal}`); } });
  const failures: string[] = [];
  const refuse = { always: false, pauses: 0 };
  const writeSync = (fd: number, buffer: Uint8Array, offset: number, length: number) => {
    const failure = refuse.always ? "EAGAIN" : failures.shift();
    if (failure) throw Object.assign(new Error(`${failure}: write failed`), { code: failure });
    const part = Math.min(length, 7);
    log.push(`write ${fd} ${new TextDecoder().decode(buffer.subarray(offset, offset + part))}`);
    return part;
  };
  // the stop as the system's would do it, logged: asked whether the job runs again already, then given back and stopped
  const stop = (continuedAlready: () => boolean, giveBack: () => void) => {
    giveBack();
    log.push(continuedAlready() ? "not stopped" : "stopped");
  };
  const stopping = (pid: number) => { log.push(`stopping ${pid}?`); return options.parentStopping ?? true; };
  const host = createUnixHost({ stdin, stdout, process: proc, env: options.env ?? {}, writeSync, pause: () => { refuse.pauses++; }, stop, stopping });
  const written = () => log.filter((entry) => entry.startsWith("write ")).map((entry) => entry.slice(8)).join("");
  return { host, log, waiting, stdin, stdout, proc, failures, refuse, written };
}

describe("the unix host", () => {
  it("SIGTSTP gives the terminal back (every mode off, raw off) before the process stops itself; SIGCONT enters again and asks for a repaint", () => {
    const { host, log, proc, written } = standIns();
    const sizes: unknown[] = [];
    host.onResize((size: unknown) => sizes.push(size));
    host.enter();
    const entered = written();
    proc.emit("SIGTSTP");
    const atStop = log.slice();
    expect(written().slice(entered.length)).toBe(LEAVE);
    expect(atStop.at(-1)).toBe("stopped");
    expect(atStop).not.toContain("stopping 4241?");
    expect(atStop.filter((entry: string) => entry.startsWith("raw")).at(-1)).toBe("raw off");
    proc.emit("SIGCONT");
    expect(written().slice(entered.length + LEAVE.length)).toBe(ENTER);
    expect(log.filter((entry: string) => entry.startsWith("raw")).at(-1)).toBe("raw on");
    expect(sizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it.each([
    ["stopped with it: it stops", true, ["stopping 4241?", "stopped"]],
    ["running again: the shell continued the job before this stop was heard, and it does not stop", false, ["stopping 4241?", "not stopped"]],
  ] as const)("started by a launcher, gives the terminal back at SIGTSTP, then asks whether the launcher, the job's first process, stopped at the same signal: %s", (_, parentStopping, asked) => {
    const { host, log, proc, stdin, written } = standIns({ env: { OVIS_TUI_HOLD: "/nonexistent/held" }, parentStopping });
    host.enter();
    const entered = written();
    const from = log.length;
    proc.emit("SIGTSTP");
    expect(log.slice(from).filter((entry) => entry.startsWith("stopping") || entry.includes("stopped"))).toEqual([...asked]);
    expect(written().slice(entered.length)).toBe(LEAVE);
    proc.emit("SIGCONT");
    expect(written().slice(entered.length + LEAVE.length)).toBe(ENTER);
    expect(stdin.count("readable")).toBe(1);
  });

  it("enters nothing when stdin or stdout is not a terminal", () => {
    for (const ttys of [{ stdinTTY: false }, { stdoutTTY: false }]) {
      const { host, log, proc, stdin, stdout } = standIns(ttys);
      expect(host.enter()).toBe(false);
      expect(log).toEqual([]);
      expect([proc.count("SIGTERM"), proc.count("exit"), stdin.count("readable"), stdout.count("resize")]).toEqual([0, 0, 0, 0]);
    }
  });

  it("hooks the process first, sets raw mode, writes the modes to fd 1 whole across short writes, then reads stdin", () => {
    const { host, log, proc, stdin, stdout, written } = standIns();
    expect(host.enter()).toBe(true);
    expect(log[0]).toBe("raw on");
    expect(written()).toBe(ENTER);
    for (const event of ["SIGINT", "SIGTERM", "SIGHUP", "exit"]) expect([event, proc.count(event)]).toEqual([event, 1]);
    expect([stdin.count("readable"), stdout.count("resize")]).toEqual([1, 1]);
  });

  it("hands every chunk Bun already read to onInput, as bytes", () => {
    const { host, waiting, stdin } = standIns();
    const seen: string[] = [];
    host.onInput((bytes) => seen.push(`${bytes instanceof Uint8Array} ${new TextDecoder().decode(bytes)}`));
    host.enter();
    waiting.push(Buffer.from("ab"), Buffer.from("c"));
    stdin.emit("readable");
    expect(seen).toEqual(["true ab", "true c"]);
  });

  it("retries a write that met EAGAIN and reports gone on EIO", () => {
    const { host, failures, written } = standIns();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    failures.push("EAGAIN");
    expect(host.write("frame")).toBe(true);
    failures.push("EIO");
    expect(host.write("lost")).toBe(false);
    expect(ends).toEqual([{ kind: "gone", why: "write-failed" }]);
    expect(written()).toBe(`${ENTER}frame`);
  });

  it("gives up on a terminal that refuses every write after WRITE_AGAIN_LIMIT pauses, and reports it gone", () => {
    const { host, refuse, written } = standIns();
    const ends: unknown[] = [];
    host.onEnd((end) => { ends.push(end); });
    host.enter();
    refuse.always = true;
    expect(host.write("frame")).toBe(false);
    expect(refuse.pauses).toBe(2000);
    expect(ends).toEqual([{ kind: "gone", why: "write-failed" }]);
    expect(host.write("more")).toBe(false);
    expect(refuse.pauses).toBe(2000);
    expect(written()).toBe(ENTER);
  });

  it("on SIGTERM leaves, unhooks nothing it still needs, and ends the process with 143", () => {
    const { host, log, proc, written } = standIns();
    host.enter();
    proc.emit("SIGTERM");
    expect(written()).toBe(ENTER + LEAVE);
    expect(log.slice(-2)).toEqual(["raw off", "exit 143"]);
    proc.emit("SIGINT");
    expect(log.filter((entry) => entry.startsWith("exit"))).toEqual(["exit 143"]);
  });

  it("leaves on the process's exit event", () => {
    const { host, proc, written } = standIns();
    host.enter();
    proc.emit("exit", 1);
    expect(written()).toBe(ENTER + LEAVE);
  });

  it("leave stops reading, pauses stdin and removes every hook", () => {
    const { host, log, proc, stdin, stdout } = standIns();
    host.enter();
    host.leave();
    expect(log.at(-1)).toBe("raw off");
    expect(log.indexOf("pause")).toBeGreaterThan(log.indexOf("raw on"));
    expect(log.indexOf("pause")).toBeLessThan(log.lastIndexOf("raw off"));
    expect(log.indexOf("unref")).toBe(log.indexOf("pause") + 1);
    expect([proc.count("SIGINT"), proc.count("SIGTERM"), proc.count("SIGHUP"), proc.count("exit"), stdin.count("readable"), stdout.count("resize")]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("reads its size from stdout and reports a resize after sending the modes again", () => {
    const { host, stdout, written } = standIns();
    const sizes: unknown[] = [];
    host.onResize((size) => sizes.push(size));
    host.enter();
    expect(host.size()).toEqual({ cols: 120, rows: 40 });
    Object.assign(stdout, { columns: 100, rows: 30 });
    stdout.emit("resize");
    expect(sizes).toEqual([{ cols: 100, rows: 30 }]);
    expect(written()).toBe(`${ENTER}${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[=1;1u`);
  });

  it("takes the colour depth from COLORTERM", () => {
    expect(standIns({ env: { COLORTERM: "truecolor" } }).host.colorDepth).toBe("truecolor");
    expect(standIns({ env: { COLORTERM: "24bit" } }).host.colorDepth).toBe("truecolor");
    expect(standIns({ env: {} }).host.colorDepth).toBe("256");
  });
});
