import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessBirth } from "../../server/process-owner.ts";
import { fresh } from "../testing/entry-pty.ts";
import { runOnPty, runSupervised, stopAllPtyRuns, type SupervisedRun } from "../testing/pty.ts";

/**
 * `restore`: the real host (tui/host/unix.ts) in a fixture entry on a real pseudo-terminal that this
 * test creates (server/pty/session.ts, on the Rust PTY host). The entry runs
 * under the harness's supervisor, which started it and alone signals it, through its own handle.
 * After a normal exit, a thrown error and each signal, the terminal is cooked again and the last
 * bytes written are the exact undo of the setup, written once.
 */
const FIXTURE = join(import.meta.dir, "..", "testing", "host-fixture.ts");
const LAUNCHER = join(import.meta.dir, "..", "testing", "launcher-fixture.ts");
const TEST_MS = 30_000;
const ESC = "\x1b";
const ST = `${ESC}\\`;
const ENTER = `${ESC}[?1049h${ESC}[?25l${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[>1u`;
const LEAVE = `${ESC}[<u${ESC}[?1006l${ESC}[?1003l${ESC}[?1002l${ESC}[?2004l${ESC}[?1004l${ESC}[?25h${ESC}[?1049l`;
const AGAIN = `${ESC}[?1004h${ESC}[?2004h${ESC}[?1002h${ESC}[?1003h${ESC}[?1006h${ESC}[=1;1u`;
const PROBE = `${ESC}[?u${ESC}[?2026$p${ESC}]10;?${ST}${ESC}]11;?${ST}${ESC}]12;?${ST}${ESC}[16t${ESC}[c`;
const ANSWER = `${ESC}[?1u${ESC}[?2026;2$y${ESC}]10;rgb:1111/2222/3333${ST}${ESC}]11;rgb:ffff/ffff/ffff${ST}${ESC}]12;rgb:0000/0000/0000${ST}${ESC}[6;18;9t${ESC}[?62;22c`;

const BASE_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME: process.env["HOME"] ?? "/",
  TMPDIR: process.env["TMPDIR"] ?? "",
  TERM: "xterm-256color",
};

afterAll(() => stopAllPtyRuns(), TEST_MS);

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;
// the fixture ends its report lines with CR LF; the tty's output processing (left on by Bun's raw
// mode) may turn the LF into CR LF again, so the tests match a line up to its first CR

function start(mode: "exit" | "linger" | "process-exit" | "throw" | "wait" | "leave-fails" | "fail-wait", env: Record<string, string> = {}): SupervisedRun {
  return runSupervised({ entry: [process.execPath, FIXTURE, mode], env: { ...BASE_ENV, ...env }, cols: 80, rows: 24 });
}

/** Starts the entry, answers its probe at once, and waits until it says READY. */
async function ready(mode: Parameters<typeof start>[0], env: Record<string, string> = {}): Promise<SupervisedRun> {
  const run = start(mode, env);
  await run.until(PROBE);
  run.type(ANSWER);
  await run.until("READY\r");
  return run;
}

function probeLine(output: string): { ms: number; result: Record<string, unknown> } {
  const match = output.match(/PROBE (\d+) (\{[^\r]*\})\r/);
  if (!match) throw new Error(`no PROBE line in ${JSON.stringify(output)}`);
  return { ms: Number(match[1]), result: JSON.parse(match[2]!) as Record<string, unknown> };
}

function inputLines(output: string): string[] {
  return [...output.matchAll(/INPUT ([^\r]*)\r/g)].map((match) => match[1]!);
}

/** The terminal after the entry ended: cooked again, and the leave sequence last and once. */
async function expectRestored(run: SupervisedRun, code: number | number[]) {
  const end = await run.ended;
  const output = run.output();
  const codes = Array.isArray(code) ? code : [code];
  expect({ code: codes.includes(end.code) ? codes[0] : end.code, before: [end.before.canonical, end.before.echo], after: [end.after?.canonical, end.after?.echo] })
    .toEqual({ code: codes[0], before: [true, true], after: [true, true] });
  expect(output.startsWith(ENTER + PROBE)).toBe(true);
  expect(count(output, ENTER)).toBe(1);
  expect(count(output, LEAVE)).toBe(1);
  expect(output.endsWith(LEAVE)).toBe(true);
  return end;
}

describe("restore", () => {
  it("after a normal exit (leave, then the loop runs dry)", async () => {
    const run = await ready("exit");
    const during = await run.stty();
    expect([during.canonical, during.echo, during.signals]).toEqual([false, false, false]);
    run.type("q");
    await expectRestored(run, 0);
  }, TEST_MS);

  it("after process.exit with no leave (the exit hook)", async () => {
    const run = await ready("process-exit");
    run.type("q");
    await expectRestored(run, 0);
  }, TEST_MS);

  it("after a thrown error", async () => {
    const run = await ready("throw");
    run.type("q");
    const end = await expectRestored(run, 1);
    expect(end.stderr).toContain("fixture: thrown on purpose");
  }, TEST_MS);

  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    it(`after ${signal}`, async () => {
      const run = await ready("wait");
      run.signal(signal);
      await expectRestored(run, 128 + constants.signals[signal]);
    }, TEST_MS);
  }

  it("after the pseudo-terminal hangs up (the PTY host ends the session)", async () => {
    const run = await ready("wait");
    await run.stop();
    const end = await run.ended;
    expect(end.code).toBe(129);
    expect(count(run.output(), LEAVE)).toBeLessThanOrEqual(1);
    if (end.after) expect([end.after.canonical, end.after.echo]).toEqual([true, true]);
  }, TEST_MS);

  it("two signals in a row: restored once, and one of them decides the exit code", async () => {
    // both are pending before the handler runs, and Linux hands over the lower number first: which
    // one the host sees first is the kernel's choice (tui/host/host.test.ts pins first-wins in order)
    const run = await ready("wait");
    run.signal("SIGTERM");
    run.signal("SIGINT");
    await expectRestored(run, [143, 130]);
  }, TEST_MS);

  it("a signal while the probe waits for replies", async () => {
    const run = start("wait");
    await run.until(PROBE);
    run.signal("SIGTERM");
    await expectRestored(run, 143);
    expect(run.output()).not.toContain("PROBE ");
  }, TEST_MS);

  it("a signal as the entry starts: either nothing was entered, or all of it is undone once", async () => {
    const run = start("wait");
    await run.started;
    run.signal("SIGTERM");
    const end = await run.ended;
    const output = run.output();
    expect(end.code).toBe(143);
    expect([end.after?.canonical, end.after?.echo]).toEqual([true, true]);
    expect(count(output, LEAVE)).toBe(count(output, ENTER));
    if (output.includes(ENTER)) expect(output.endsWith(LEAVE)).toBe(true);
  }, TEST_MS);
});

describe("the start probe on a pseudo-terminal", () => {
  it("ends at 500 ms when the host answers nothing", async () => {
    const run = start("exit");
    await run.until("READY\r");
    const { ms, result } = probeLine(run.output());
    expect(ms).toBeGreaterThanOrEqual(490);
    expect(ms).toBeLessThan(2000);
    expect(result).toMatchObject({ answered: false, background: null, theme: null });
    run.type("q");
    await expectRestored(run, 0);
  }, TEST_MS);

  it("ends at the DA1 reply when the host answers everything, and reads light from OSC 11", async () => {
    const run = await ready("exit");
    const { ms, result } = probeLine(run.output());
    expect(ms).toBeLessThan(490);
    expect(result).toEqual({
      answered: true, kittyFlags: 1, syncOutput: true, foreground: [17, 34, 51], background: [255, 255, 255], cursorColor: [0, 0, 0],
      cellPixels: { width: 9, height: 18 }, deviceAttributes: [62, 22], theme: "light",
    });
    run.type("q");
    await expectRestored(run, 0);
    expect(inputLines(run.output())).toEqual(["1 71"]);
  }, TEST_MS);

  /** Starts an entry, waits for its probe's question, and returns what each INPUT line says. */
  const inputsOf = (output: string) => [...output.matchAll(/INPUT (\d+) ([0-9a-f]*)\r/g)].map((match) => ({ length: Number(match[1]), hex: match[2]! }));
  const hex = (data: string) => Buffer.from(data, "latin1").toString("hex");

  it("swallows late replies, one cut after its ESC across two writes too: only the typed keys are input", async () => {
    const run = start("exit");
    await run.until("READY\r");
    expect(probeLine(run.output()).result).toMatchObject({ answered: false });
    run.type(ESC);
    run.type(`]11;rgb:ffff/ffff/ffff${ST}`);
    run.type(ANSWER);
    run.type("x");
    await run.until("INPUT 1 78\r");
    run.type("q");
    await expectRestored(run, 0);
    expect(inputsOf(run.output()).map((line) => line.hex).join("")).toBe(hex("xq"));
  }, TEST_MS);

  it("a key typed between the replies during the probe is input, and the replies are not", async () => {
    const run = start("exit");
    await run.until(PROBE);
    const cut = ANSWER.indexOf(`${ESC}]11;`);
    run.type(`${ANSWER.slice(0, cut)}k${ANSWER.slice(cut)}`);
    await run.until("READY\r");
    expect(probeLine(run.output()).result).toMatchObject({ answered: true, background: [255, 255, 255] });
    run.type("q");
    await expectRestored(run, 0);
    expect(inputsOf(run.output()).map((line) => line.hex).join("")).toBe(hex("kq"));
  }, TEST_MS);

  for (const [what, answer, held] of [
    ["garbage", `garbage${ESC}[?zz${ESC}]11;`, `${ESC}]11;`],
    ["a partial reply", `${ESC}]11;rgb:ff`, `${ESC}]11;rgb:ff`],
  ] as const) {
    it(`${what} during the probe: the probe ends at its limit, what is no whole reply is input, a broken reply whole at its wait`, async () => {
      const run = start("exit");
      await run.until(PROBE);
      run.type(answer);
      await run.until("READY\r");
      expect(probeLine(run.output()).result).toMatchObject({ answered: false });
      await run.until(`INPUT ${held.length} ${hex(held)}\r`);
      run.type("x");
      await run.until("INPUT 1 78\r");
      run.type("q");
      await expectRestored(run, 0);
      expect(inputsOf(run.output()).map((line) => line.hex).join("")).toBe(hex(`${answer}xq`));
    }, TEST_MS);
  }

  // On macOS the Node PTY host this first ran on could wedge while writing the paste and stop servicing
  // the probe (not yet rechecked on the Rust host). See .omo/evidence/task-39-macos.txt and .omo/evidence/task-68-ovis-tui-own.txt.
  it.skipIf(process.platform === "darwin")("1 MiB of text during the probe: the probe ends at its limit and every byte is input", async () => {
    const run = start("exit", { HOST_FIXTURE_HASH_INPUT: "1" });
    const paste = "A".repeat(1024 * 1024);
    await run.until(PROBE);
    run.type(paste);
    await run.until("READY\r");
    const { ms, result } = probeLine(run.output());
    expect(ms).toBeGreaterThanOrEqual(490);
    expect(ms).toBeLessThan(2000);
    expect(result).toMatchObject({ answered: false });
    run.type("q");
    await expectRestored(run, 0);
    const lines = inputsOf(run.output());
    expect(lines.reduce((sum, line) => sum + line.length, 0)).toBe(paste.length + 1);
    expect(run.output()).toContain(`SHA256 ${new Bun.CryptoHasher("sha256").update(paste).update("q").digest("hex")}\r`);
  }, TEST_MS);
});

describe("the module itself gives cooked mode back", () => {
  it("read while the entry still runs after leave (Bun's own restore at exit does not count here)", async () => {
    const run = await ready("linger");
    run.type("q");
    await run.until(LEAVE);
    const after = await run.stty();
    expect([after.canonical, after.echo, after.signals]).toEqual([true, true, true]);
    expect(run.output().endsWith(LEAVE)).toBe(true);
    run.signal("SIGTERM");
    expect((await run.ended).code).toBe(143);
  }, TEST_MS);

  it("after a write error during leave: the termios equal the ones before, read while the entry still runs", async () => {
    const run = await ready("leave-fails");
    run.type("q");
    await run.until("LEFT EBADF\r");
    const after = await run.stty();
    run.signal("SIGTERM");
    const end = await run.ended;
    expect(end.code).toBe(143);
    expect(after.text).toBe(end.before.text);
    expect(count(run.output(), ENTER)).toBe(1);
    expect(count(run.output(), LEAVE)).toBe(0);
  }, TEST_MS);

  it("SIGTERM while every write fails, the leave write too: cooked again, and the signal's exit code", async () => {
    const run = await ready("fail-wait");
    run.type("q");
    await run.until("INPUT 1 71\r");
    run.signal("SIGTERM");
    const end = await run.ended;
    expect(end.code).toBe(143);
    expect(end.after?.text).toBe(end.before.text);
    expect(count(run.output(), LEAVE)).toBe(0);
  }, TEST_MS);
});

describe("colour depth and modes on a pseudo-terminal", () => {
  for (const [colorterm, depth] of [["truecolor", "truecolor"], ["24bit", "truecolor"], [null, "256"]] as const) {
    it(`COLORTERM=${colorterm ?? "(unset)"} gives ${depth}`, async () => {
      const run = await ready("exit", colorterm ? { COLORTERM: colorterm } : {});
      expect(run.output()).toContain(`DEPTH ${depth}\r`);
      run.type("q");
      await expectRestored(run, 0);
    }, TEST_MS);
  }

  it("modes again after resize and focus-in", async () => {
    const run = await ready("exit");
    run.resize(100, 30);
    await run.until("RESIZE 100x30\r");
    const afterResize = run.output();
    expect(afterResize.slice(afterResize.indexOf("READY\r"))).toContain(`${AGAIN}RESIZE 100x30\r`);
    run.type(`${ESC}[I`);
    await run.until("INPUT 3 1b5b49\r");
    expect(count(run.output(), AGAIN)).toBe(2);
    run.type("q");
    await expectRestored(run, 0);
  }, TEST_MS);
});

describe("not a terminal", () => {
  it("nothing is entered when stdin or stdout is not a terminal", async () => {
    // a plain child with pipes: the fixture refuses before writing anything
    const child = Bun.spawn([process.execPath, FIXTURE, "exit"], { env: BASE_ENV, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.end();
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, out, err }).toEqual({ code: 3, out: "", err: "host-fixture: not a terminal\n" });
  }, TEST_MS);
});

/**
 * `ovis tui`'s launcher (tui/testing/launcher-fixture.ts) with the host fixture as its screen, on a pseudo-terminal, in a
 * scratch home with no core: what the launcher does when the screen cannot give the terminal back itself, and a stop of
 * the whole job from an interactive shell.
 */
describe("the launcher and the screen together", () => {
  const scratch = () => {
    const root = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "launcher-"));
    for (const sub of ["home", "run", "config"]) mkdirSync(join(root, sub));
    return {
      ...BASE_ENV, HOME: join(root, "home"), TMPDIR: root, PORT: "1", XDG_RUNTIME_DIR: join(root, "run"),
      HC_SOCKET: join(root, "run", "none.sock"), HERDR_PLUGIN_CONFIG_DIR: join(root, "config"),
    };
  };

  it("gives back every mode the screen can turn on, the colour-scheme watch too, when the screen dies by SIGKILL", async () => {
    const run = runSupervised({ entry: [process.execPath, LAUNCHER, "watch-kill"], env: scratch(), cols: 80, rows: 24 });
    await run.until(PROBE);
    run.type(ANSWER);
    await run.until("READY\r");
    run.type("q");
    const end = await run.ended;
    const output = run.output();
    expect({ code: end.code, after: [end.after?.canonical, end.after?.echo] }).toEqual({ code: 128 + constants.signals.SIGKILL, after: [true, true] });
    expect(output).toContain(`${ESC}[?2031h`);
    expect(output.endsWith(`${ESC}[?2031l${LEAVE}`)).toBe(true);
  }, TEST_MS);

  it("writes nothing to the terminal when the screen dies before it turned its own modes on: the caller's are left as they were", async () => {
    const run = runSupervised({ entry: [process.execPath, LAUNCHER, "kill-first"], env: scratch(), cols: 80, rows: 24 });
    const end = await run.ended;
    expect({ code: end.code, after: [end.after?.canonical, end.after?.echo] }).toEqual({ code: 128 + constants.signals.SIGKILL, after: [true, true] });
    // no escape sequence at all: not the keyboard protocol's pop, not bracketed paste off
    expect(run.output()).not.toContain(ESC);
  }, TEST_MS);

  it("leaves the caller's modes alone when the screen dies before it entered and the shell's TMPDIR is not there: the hold file is made elsewhere", async () => {
    const env = scratch();
    // the supervisor keeps a folder of its own in TMPDIR, so the launcher alone is given the one that is not there
    const run = runSupervised({ entry: ["env", `TMPDIR=${join(env.TMPDIR, "no-such-folder")}`, process.execPath, LAUNCHER, "kill-first"], env, cols: 80, rows: 24 });
    const end = await run.ended;
    expect({ code: end.code, after: [end.after?.canonical, end.after?.echo] }).toEqual({ code: 128 + constants.signals.SIGKILL, after: [true, true] });
    expect(run.output()).not.toContain(ESC);
  }, TEST_MS);

  it("gives the modes back when the screen dies holding them and the shell's TMPDIR is a relative folder: the screen runs in another folder than the launcher", async () => {
    const env = scratch();
    mkdirSync(join(env.TMPDIR, "relative"));
    // the launcher runs where `relative` is there; the screen runs in its own folder, where that name is no folder
    const run = runSupervised({ entry: ["sh", "-c", 'cd "$TMPDIR" && TMPDIR=relative exec "$@"', "launcher", process.execPath, LAUNCHER, "watch-kill"], env, cols: 80, rows: 24 });
    await run.until(PROBE);
    run.type(ANSWER);
    await run.until("READY\r");
    run.type("q");
    const end = await run.ended;
    expect({ code: end.code, after: [end.after?.canonical, end.after?.echo] }).toEqual({ code: 128 + constants.signals.SIGKILL, after: [true, true] });
    expect(run.output().endsWith(`${ESC}[?2031l${LEAVE}`)).toBe(true);
  }, TEST_MS);

  // `ovis tui` hands itself over to the shell waiter; the launcher stays itself where it cannot
  it.skipIf(process.platform === "win32").each(["waiter", "launcher"])("comes back after an interactive shell stopped the whole job and `fg` continued it: the screen takes keys again (the %s waits)", async (via) => {
    const env = { ...scratch(), PS1: "$ ", SHELL: "/bin/bash", OVIS_TEST_BUN: process.execPath, OVIS_TEST_LAUNCHER: LAUNCHER };
    // the shell leads the pty's session with every stream on it, so its prompt shows and its job control works
    const run = runOnPty({ command: ["bash", "--norc", "--noprofile", "-i"], env, cols: 80, rows: 24 });
    const jobMark = /OVIS_TEST_JOB (\d+)\r/;
    const screenMark = /OVIS_TEST_SCREEN (\d+)\r/;
    const pid = (mark: RegExp) => Number(run.output().match(mark)?.[1]);
    const birth = (id: number) => {
      const reading = readProcessBirth(id);
      return reading.state === "identified" ? reading.birth.value : null;
    };
    const own = new Map<number, string>();
    const keep = (mark: RegExp) => {
      const id = pid(mark);
      if (!Number.isSafeInteger(id) || id <= 1) throw new Error("the job did not report its PID");
      const started = birth(id);
      if (started === null) throw new Error(`cannot identify the test's job process ${id}`);
      own.set(id, started);
      return id;
    };
    const ps = async (id: number) => {
      if (process.platform === "linux") {
        try {
          const stat = readFileSync(`/proc/${id}/stat`, "utf8");
          const [state, , group] = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
          return [group, state];
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
          throw error;
        }
      }
      const child = Bun.spawn(["ps", "-o", "pgid=", "-o", "state=", "-p", String(id)], { env: BASE_ENV, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
      return code === 0 ? out.trim().split(/\s+/) : [];
    };

    try {
      await run.until("$ ");
      // Bash gives this foreground command a process group of its own.
      run.type(`"$OVIS_TEST_BUN" "$OVIS_TEST_LAUNCHER" job ${via === "waiter" ? "waiter" : ""}\r`);
      await run.until(jobMark);
      const group = keep(jobMark);
      await run.until(PROBE);
      run.type(ANSWER);
      await run.until(screenMark);
      const screen = keep(screenMark);
      await run.until("READY\r");
      // Ctrl+Z reaches the screen as a byte (raw mode); the fixture then stops its whole process group.
      for (let round = 0; round < 25; round++) {
        let from = run.output().length;
        run.type("\x1a");
        await fresh(run, from, "Stopped");
        await fresh(run, from, "$ ");
        await fresh(run, from, LEAVE);
        // The shell saw the launcher stop. The screen stops itself separately, after writing LEAVE.
        const deadline = performance.now() + 2_000;
        for (;;) {
          const [pgid, state] = await ps(screen);
          if (pgid === String(group) && state?.startsWith("T")) break;
          if (pgid === undefined) throw new Error("the screen exited before fg");
          if (performance.now() >= deadline) throw new Error("the screen did not stop before fg");
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        from = run.output().length;
        run.type("fg\r");
        await fresh(run, from, ENTER);
        from = run.output().length;
        run.type("x");
        await fresh(run, from, "INPUT 1 78\r");
      }
    } finally {
      // Leave the launcher alive to reap its child, and Bash alive to reap the launcher.
      const group = pid(jobMark);
      try {
        const signal = (id: number, name: NodeJS.Signals) => {
          const started = own.get(id);
          if (started === undefined || birth(id) !== started) return;
          try {
            process.kill(id, name);
          } catch (error) {
            if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
          }
        };
        const screen = pid(screenMark);
        if (own.has(screen)) signal(screen, "SIGKILL");
        signal(group, "SIGCONT");
        if (!own.has(screen)) signal(group, "SIGTERM");
        const deadline = performance.now() + 2_000;
        while ([...own].some(([id, started]) => birth(id) === started)) {
          if (performance.now() >= deadline) throw new Error("the fixture's launcher or screen was not reaped");
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        await run.stop();
      }
      for (const [id, started] of own) expect(birth(id)).not.toBe(started);
    }
  }, TEST_MS);

  // The fixture holds still on a FIFO at the point named (host-fixture.ts), and `fg` is typed while it does: `leave`,
  // once the screen gave the terminal back and before it stops; `stop`, once the job's SIGTSTP was sent and before the
  // screen's handler ran. Either way the shell continued the job before the screen could stop, and it takes keys again.
  it.skipIf(process.platform === "win32").each([
    ["waiter", "leave"], ["launcher", "leave"], ["waiter", "stop"], ["launcher", "stop"],
  ] as const)("takes keys again when `fg` comes before the screen could stop (the %s waits; `fg` at %s)", async (via, at) => {
    const base = scratch();
    const gate = join(base.TMPDIR, "gate");
    expect(await Bun.spawn(["mkfifo", gate]).exited).toBe(0);
    const env = { ...base, PS1: "$ ", SHELL: "/bin/bash", HOST_FIXTURE_GATE: gate, HOST_FIXTURE_GATE_AT: at };
    const run = runOnPty({ command: ["bash", "--norc", "--noprofile", "-i"], env, cols: 80, rows: 24 });
    await run.until("$ ");
    run.type(`${process.execPath} ${LAUNCHER} job ${via === "waiter" ? "waiter" : ""}\r`);
    await run.until(PROBE);
    run.type(ANSWER);
    await run.until("READY\r");
    let from = run.output().length;
    run.type("\x1a");
    await fresh(run, from, "Stopped");
    await fresh(run, from, "$ ");
    if (at === "leave") await fresh(run, from, LEAVE);
    from = run.output().length;
    run.type("fg\r");
    // the shell says the job's command when it continues it
    await fresh(run, from, `${LAUNCHER} job`);
    expect(await Bun.spawn(["sh", "-c", 'printf go > "$1"', "sh", gate]).exited).toBe(0);
    // the screen enters again, without stopping first; held still before its handler, it gives the terminal back then
    await fresh(run, from, ENTER);
    run.type("x");
    await fresh(run, from, "INPUT 1 78\r");
    await run.stop();
  }, TEST_MS);
});
