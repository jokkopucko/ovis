import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { ENTRIES } from "../server/entries.ts";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { type Held, LEAVE, LEAVE_ALL } from "../tui/host/guard.ts";
import * as libc from "./libc.ts";
import { waiterCommand } from "./plugin-tui-waiter.ts";
import { importClosure, read } from "./source-scan.ts";
import { answersWithin, callerEnv, launchBareTui, launchTui, readLine, screenStart, shellEnv, systemParts, tuiEnv, WINDOWS_MESSAGE, type LaunchParts, type Probe } from "./plugin-tui.ts";

const ROOT = join(import.meta.dir, "..");
let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovis-plugin-tui-"));
});

afterEach(() => {
  // a test that made a folder read-only gives it back first, so it can be removed
  for (const dir of [join(scratch, "config")]) if (existsSync(dir)) chmodSync(dir, 0o755);
  rmSync(scratch, { recursive: true, force: true });
});

const SAVED = new Uint8Array([1, 2, 3]);
const SOCKET = "/scratch/hc.sock";
/** the hold file the fake launcher names to its screen */
const HOLD = "/scratch/held";
/** a home with nothing in it: hc's own config.toml is looked for under it, never under the real one */
const HOME = "/nonexistent-home";
const APP_ORIGIN = `http://127.0.0.1:${DEFAULT_PORT}`;

describe("bare terminal screen selection", () => {
  it.each([
    { args: [], over: {}, expected: 0, calls: ["probe /scratch/hc.sock", "run screen"] },
    { args: ["--session", "work"], over: {}, expected: 0, calls: ["probe /run/test/herdr-core/work.sock", "run screen"] },
    { args: ["--session=work"], over: {}, expected: 0, calls: ["probe /run/test/herdr-core/work.sock", "run screen"] },
    { args: ["--session"], over: {}, expected: null, calls: [] },
    { args: [], over: { platform: "darwin" as const }, expected: 0, calls: ["probe /scratch/hc.sock", "run screen"] },
    { args: [], over: { platform: "win32" as const }, expected: null, calls: [] },
    { args: [], over: { isTty: false }, expected: null, calls: [] },
    { args: ["--session=work"], over: { isTty: false }, expected: null, calls: [] },
    ...["", "status", "tui", "--help", "--bogus", "--sessions"].map((arg) => ({ args: [arg], over: {}, expected: null, calls: [] })),
  ])("dispatches $args with $over", async ({ args, over, expected, calls }) => {
    const run = fake({ over: { caller: { HOME, HC_SOCKET: SOCKET, XDG_RUNTIME_DIR: "/run/test" }, ...over } });
    expect(await launchBareTui(args, run.parts)).toBe(expected);
    expect(run.calls.filter((call) => /^(probe|run|find|start|discard|line)/u.test(call))).toEqual([...calls]);
  });

  it.each([{ args: [] }, { args: ["--session=work"] }])("returns to status without asking when the selected core does not answer ($args)", async ({ args }) => {
    const run = fake({ probes: [{ kind: "none" }] });
    expect(await launchBareTui(args, run.parts)).toBeNull();
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]).toStartWith("probe ");
    expect(run.said).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("the small terminal waiter", () => {
  function runWaiter(command: string, hold = "", input = "") {
    const child = Bun.spawn(waiterCommand(["/bin/sh", "-c", command], hold), {
      env: { PATH: "/usr/bin:/bin", A: "x=y z" }, cwd: scratch, stdin: new Blob([input]), stdout: "pipe", stderr: "ignore",
    });
    return { child, out: new Response(child.stdout).text() };
  }

  it("preserves the screen's stdin, exported values and exit status", async () => {
    const { child, out } = runWaiter('read line; printf "%s %s" "$A" "$line"; exit 3', "", "typed\n");
    expect(await child.exited).toBe(3);
    expect(await out).toBe("x=y z typed");
  });

  it.each([["0", ""], ["1", LEAVE], ["2", LEAVE_ALL]])("after a crash undoes only the modes recorded by the screen (%s)", async (held, undo) => {
    const dir = mkdtempSync(join(scratch, "held-"));
    const path = join(dir, "held");
    writeFileSync(path, held);
    const { child, out } = runWaiter("kill -KILL $$", path);
    expect(await child.exited).toBe(137);
    expect(await out).toBe(undo);
    expect(existsSync(dir)).toBe(false);
  });

  it.each([["SIGTERM", 143], ["SIGHUP", 129]] as const)("forwards %s immediately after an ignored SIGINT", async (signal, status) => {
    for (let round = 0; round < 20; round++) {
      const child = Bun.spawn(waiterCommand(["/bin/sh", "-c", "echo up; exec /bin/sleep 15"], ""), {
        env: { PATH: "/usr/bin:/bin" }, cwd: scratch, stdin: "ignore", stdout: "pipe", stderr: "ignore",
      });
      const reader = child.stdout.getReader();
      try {
        expect(new TextDecoder().decode((await reader.read()).value)).toBe("up\n");
        child.kill("SIGINT");
        child.kill(signal);
        expect(await child.exited).toBe(status);
      } finally {
        reader.releaseLock();
        if (child.exitCode === null && child.signalCode === null) child.kill(signal);
        await child.exited;
      }
    }
  }, 30_000);
});

type End = { code: number | null; signal: NodeJS.Signals | null };

interface Fake {
  /** what the launcher did, in order: probe, discard, show (the question, then the space after it), line, find, start, answers, run, kill, on and off */
  readonly calls: string[];
  /** each stderr line's stable code */
  readonly codes: () => string[];
  readonly said: string[];
  readonly runs: { command: readonly string[]; env: Record<string, string>; cwd: string | undefined }[];
  readonly restored: Uint8Array[];
  readonly written: string[];
  /** each search for hc: the environment it and its `--version` run in, and what named it */
  readonly finds: { env: Record<string, string>; selector: Readonly<Record<string, string | undefined>> }[];
  /** how many hold files were removed */
  readonly unheld: () => number;
  readonly handlers: Map<string, () => void>;
  readonly parts: LaunchParts;
}

/**
 * The launcher's parts as data: `probes` answer the connects in turn (the last one again after that), `flushed` says
 * for each discard in turn whether it could be done (true after those), `answer` is the line typed at the question,
 * `hc` what the finder finds, `started` the exit of `hc server start`, `answers` whether the core that was started
 * answers in time, `end` the screen's exit, `held` what the screen's hold file says when it ended (null: no hold file
 * could be made).
 */
function fake(options: { flushed?: boolean[]; probes?: Probe[]; answer?: string | null; hc?: string | null; started?: number; answers?: boolean; end?: End | Promise<End>; held?: Held | null; over?: Partial<LaunchParts> } = {}): Fake {
  const calls: string[] = [];
  const said: string[] = [];
  const runs: Fake["runs"] = [];
  const restored: Uint8Array[] = [];
  const written: string[] = [];
  const handlers = new Map<string, () => void>();
  const finds: Fake["finds"] = [];
  const probes = [...options.probes ?? [{ kind: "core" } as const]];
  const flushed = [...options.flushed ?? []];
  let unheld = 0;
  const parts: LaunchParts = {
    platform: "linux",
    isTty: true,
    caller: { HOME, HC_SOCKET: SOCKET, PATH: "/usr/bin" },
    settings: {},
    screen: { command: ["screen"], cwd: "/install", file: null },
    folder: "/home/me/project",
    probe: async (socket) => {
      calls.push(`probe ${socket}`);
      return probes.length > 1 ? probes.shift()! : probes[0]!;
    },
    answers: async (socket, ms) => {
      calls.push(`answers ${socket} within ${ms}`);
      return options.answers ?? true;
    },
    findHc: async (env, selector) => {
      calls.push("find");
      finds.push({ env, selector });
      return options.hc === undefined ? "/bin/hc" : options.hc;
    },
    startCore: async (hc) => {
      calls.push(`start ${hc}`);
      return { code: options.started ?? 0, err: options.started ? "it broke\n" : "" };
    },
    discard: () => {
      calls.push("discard");
      return flushed.shift() ?? true;
    },
    show: (text) => {
      calls.push(text === " " ? "show space" : "show question");
      return true;
    },
    line: () => {
      calls.push("line");
      return options.answer === undefined ? "" : options.answer;
    },
    run: (command, run) => {
      calls.push(`run ${command.join(" ")}`);
      runs.push({ command, ...run });
      return { exited: Promise.resolve(options.end ?? { code: 0, signal: null }), kill: (signal) => { calls.push(`kill ${signal}`); } };
    },
    holdFile: () => options.held === null ? null : { path: HOLD, held: () => options.held ?? "none", remove: () => { unheld++; } },
    terminal: { save: () => SAVED, restore: (saved) => { restored.push(saved); }, write: (bytes) => { written.push(bytes); } },
    on: (signal, handler) => {
      calls.push(`on ${signal}`);
      handlers.set(signal, handler);
      return () => { calls.push(`off ${signal}`); };
    },
    err: (text) => { said.push(text); },
    ...options.over,
  };
  const codes = () => said.flatMap((text) => [...text.matchAll(/^ovis tui: ([a-z_]+): /gm)].map((match) => match[1]!));
  return { calls, codes, said, runs, restored, written, finds, unheld: () => unheld, handlers, parts };
}

/** the launcher's work, without its signal listeners */
const work = (calls: string[]) => calls.filter((call) => !/^(on|off) /.test(call));
const RAN = ["probe /scratch/hc.sock", "run screen"];
/** the question: what was typed is thrown away before it and again once it is written, then the space, then the line */
const ASKED = ["probe /scratch/hc.sock", "discard", "show question", "discard", "show space", "line"];
/** up to the start of a core, and the 30 s it has to answer */
const START = [...ASKED, "find", "start /bin/hc", "answers /scratch/hc.sock within 30000"];
const STARTED = [...START, "run screen"];
const none: Probe = { kind: "none" };
const core: Probe = { kind: "core" };

describe("the launch decision table", () => {
  const rows: [name: string, options: Parameters<typeof fake>[0], argv: string[], exit: number, calls: string[], codes: string[]][] = [
    ["win32 runs nothing", { over: { platform: "win32" } }, [], 1, [], []],
    ["a core answers: the screen, nothing asked", {}, [], 0, RAN, []],
    ["on macOS too", { over: { platform: "darwin" } }, [], 0, RAN, []],
    ["the screen's exit code is the launcher's", { end: { code: 3, signal: null } }, [], 3, RAN, []],
    ["no core, Enter: hc found, a core started, the screen once it answers", { probes: [none] }, [], 0, STARTED, []],
    ["no core, y", { probes: [none], answer: "y" }, [], 0, STARTED, []],
    ["no core, Yes with blanks", { probes: [none], answer: " Yes " }, [], 0, STARTED, []],
    ["a core that was started and does not answer in time: no screen", { probes: [none], answers: false }, [], 1, START, ["no_answer"]],
    ["an Enter typed ahead that cannot be thrown away is no yes: nothing asked, found or started, the start command", { probes: [none], flushed: [false], answer: "" }, [], 1, ["probe /scratch/hc.sock", "discard"], ["no_core"]],
    ["an Enter that came while the question was written and cannot be thrown away is no yes either: no line is read", { probes: [none], flushed: [true, false], answer: "" }, [], 1, ASKED.slice(0, 4), ["no_core"]],
    ["no core, n: the start command, nothing started", { probes: [none], answer: "n" }, [], 1, ASKED, ["no_core"]],
    ["no core, no", { probes: [none], answer: "no" }, [], 1, ASKED, ["no_core"]],
    ["no core, any other answer", { probes: [none], answer: "maybe" }, [], 1, ASKED, ["no_core"]],
    ["no core, the input ended", { probes: [none], answer: null }, [], 1, ASKED, ["no_core"]],
    ["not a terminal, no core: the start command, nothing asked", { probes: [none], over: { isTty: false } }, [], 1, ["probe /scratch/hc.sock"], ["no_core"]],
    ["not a terminal, a core: no screen", { over: { isTty: false } }, [], 1, ["probe /scratch/hc.sock"], ["not_a_terminal"]],
    ["no hc program: one line, nothing started", { probes: [none], hc: null }, [], 1, [...ASKED, "find"], ["no_hc"]],
    ["hc server start fails: no screen", { probes: [none], started: 3 }, [], 1, [...ASKED, "find", "start /bin/hc"], ["start_failed"]],
    ["a connect that fails otherwise: nothing asked or started", { probes: [{ kind: "failed", code: "closed", reason: "EACCES" }] }, [], 1, ["probe /scratch/hc.sock"], ["closed"]],
    ["-h goes to the screen's entry as it is, nothing probed, at a terminal or not", { over: { isTty: false } }, ["-h"], 0, ["run screen -h"], []],
    ["-V and a wrong argument too", {}, ["-V", "--bad"], 0, ["run screen -V --bad"], []],
  ];

  it.each(rows)("%s", async (_, options, argv, exit, calls, codes) => {
    const run = fake(options);
    expect(await launchTui(argv, run.parts)).toBe(exit);
    expect(work(run.calls)).toEqual(calls);
    expect(run.codes()).toEqual(codes);
    if (options?.over?.platform === "win32") expect(run.said).toEqual([WINDOWS_MESSAGE]);
  });

  it.each([
    ["a line sent with Enter", "y\n", "y"],
    ["an empty line: Enter alone", "\n", ""],
    ["only the first of two lines", "n\nyes\n", "n"],
    ["the end of the input with nothing typed", "", null],
    ["a space the end of the input cut short: it was never sent", " ", null],
    ["a y the end of the input cut short", "y", null],
  ])("reads as an answer only a line its newline ended: %s", (_, typed, line) => {
    const bytes = Buffer.from(typed);
    let at = 0;
    expect(readLine((one) => {
      if (at === bytes.length) return 0;
      one[0] = bytes[at++]!;
      return 1;
    })).toBe(line);
  });

  it("reads no line from a terminal that cannot be read", () => {
    expect(readLine(() => { throw Object.assign(new Error("EIO"), { code: "EIO" }); })).toBeNull();
  });

  it("asks a core that was just started again until it answers", async () => {
    const asked: string[] = [];
    const replies: Probe[] = [none, { kind: "failed", code: "closed", reason: "ECONNRESET" }, core];
    // a limit no slow run reaches: only the third reply ends the wait
    expect(await answersWithin(async (socket) => { asked.push(socket); return replies.shift()!; }, SOCKET, 600_000)).toBe(true);
    expect(asked).toEqual([SOCKET, SOCKET, SOCKET]);
  });

  it("gives a core that never answers up once its time is over, never before", async () => {
    let asked = 0;
    const from = performance.now();
    expect(await answersWithin(async () => { asked += 1; return none; }, SOCKET, 150)).toBe(false);
    expect(performance.now() - from).toBeGreaterThanOrEqual(150);
    expect(asked).toBeGreaterThanOrEqual(1);
  });

  it("says once that OVIS_TUI_BIN is no longer used, from the caller or the settings, and runs the screen", async () => {
    for (const over of [{ caller: { HOME, HC_SOCKET: SOCKET, OVIS_TUI_BIN: "/opt/ovis-tui" } }, { settings: { OVIS_TUI_BIN: "~/ovis-tui" } }]) {
      const run = fake({ over });
      expect(await launchTui([], run.parts)).toBe(0);
      expect(run.codes()).toEqual(["tui_bin_unused"]);
      expect(work(run.calls)).toEqual(RAN);
    }
  });
});

describe("core choice", () => {
  const caller = { HC_SOCKET: "/run/me/caller.sock", HC_SESSION: "caller", PATH: "/usr/bin" };
  const settings = { HC_SOCKET: "/run/me/settings.sock", HC_SESSION: "ovis" };
  const picked = (env: Record<string, string | undefined>) => ({ HC_SOCKET: env["HC_SOCKET"], HC_SESSION: env["HC_SESSION"] });

  it.each([
    ["a flag over everything, clearing an inherited HC_SOCKET", "work", caller, settings, { HC_SOCKET: undefined, HC_SESSION: "work" }],
    ["the caller's socket over the settings", null, { HC_SOCKET: "/run/me/caller.sock" }, settings, { HC_SOCKET: "/run/me/caller.sock", HC_SESSION: undefined }],
    ["the caller's session over the settings", null, { HC_SESSION: "caller" }, settings, { HC_SOCKET: undefined, HC_SESSION: "caller" }],
    ["the settings when the caller names no core", null, { PATH: "/usr/bin" }, settings, settings],
    ["a session the settings name alone", null, {}, { HC_SESSION: "ovis" }, { HC_SOCKET: undefined, HC_SESSION: "ovis" }],
    ["hc's default when nobody names one", null, { PATH: "/usr/bin" }, {}, { HC_SOCKET: undefined, HC_SESSION: undefined }],
  ] as const)("%s", async (_, session, from, set, expected) => {
    const run = fake({ over: { caller: { HOME, XDG_RUNTIME_DIR: "/run/test", ...from }, settings: set } });
    expect(await launchTui(session === null ? [] : ["--session", session], run.parts)).toBe(0);
    expect(picked(run.runs[0]!.env)).toEqual(expected);
  });

  it("probes a relative socket from the user's folder and passes that same path to the screen", async () => {
    const run = fake({ over: { caller: { HOME, HC_SOCKET: "./relative.sock" } } });
    expect(await launchTui([], run.parts)).toBe(0);
    expect(work(run.calls)).toEqual(["probe /home/me/project/relative.sock", "run screen"]);
    expect(run.runs[0]?.env["HC_SOCKET"]).toBe("/home/me/project/relative.sock");
  });

  it("is what the screen gets in its environment, without the Ovis server's token", async () => {
    const run = fake({ over: { caller: { HOME, HC_SOCKET: SOCKET, XDG_RUNTIME_DIR: "/run/test", OVIS_TOKEN: "secret", PATH: "/usr/bin" } } });
    expect(await launchTui(["--session", "work"], run.parts)).toBe(0);
    expect(work(run.calls)).toEqual(["probe /run/test/herdr-core/work.sock", "run screen"]);
    expect(run.runs[0]!.env).toEqual({ HOME, HC_SESSION: "work", XDG_RUNTIME_DIR: "/run/test", PATH: "/usr/bin", OVIS_TUI_CWD: "/home/me/project", OVIS_TUI_HOLD: HOLD, OVIS_TUI_SERVER: APP_ORIGIN });
    const fromSettings = fake({ over: { caller: { HOME, XDG_RUNTIME_DIR: "/run/test" }, settings: { HC_SESSION: "ovis", OVIS_TOKEN: "secret" } } });
    expect(await launchTui([], fromSettings.parts)).toBe(0);
    expect(work(fromSettings.calls)).toEqual(["probe /run/test/herdr-core/ovis.sock", "run screen"]);
    expect(fromSettings.runs[0]!.env).toEqual({ HOME, HC_SESSION: "ovis", XDG_RUNTIME_DIR: "/run/test", OVIS_TUI_CWD: "/home/me/project", OVIS_TUI_HOLD: HOLD, OVIS_TUI_SERVER: APP_ORIGIN });
  });

  it("hands off only the local server origin resolved from the configured or saved port", async () => {
    writeFileSync(join(scratch, "plugin-port"), "17551\n");
    for (const [settings, address] of [
      [{ OVIS_STATE_DIR: scratch }, "http://127.0.0.1:17551"],
      [{ OVIS_STATE_DIR: scratch, HOST: "0.0.0.0", PORT: "18555" }, "http://127.0.0.1:18555"],
      [{ OVIS_STATE_DIR: scratch, HOST: "example.test", PORT: "18555" }, ""],
    ] as const) {
      const run = fake({ over: { settings, caller: { HOME, HC_SOCKET: SOCKET, OVIS_TUI_SERVER: "http://evil.test:80" } } });
      expect(await launchTui([], run.parts)).toBe(0);
      expect(run.runs[0]?.env["OVIS_TUI_SERVER"]).toBe(address);
    }
  });

  it.each([
    ["the caller's socket", [], { HC_SOCKET: "/run/me/hc.sock" }, {}, "HC_SOCKET=/run/me/hc.sock hc server start"],
    ["a flag over an inherited socket", ["--session", "work"], { HC_SOCKET: "/run/me/hc.sock" }, {}, "env -u HC_SOCKET HC_SESSION=work hc server start"],
    ["the settings' session", [], {}, { HC_SESSION: "ovis" }, "HC_SESSION=ovis hc server start"],
    ["hc's default", [], {}, {}, "hc server start"],
    ["a path a shell would split", [], { HC_SOCKET: "/run/my core/it's.sock" }, {}, "HC_SOCKET='/run/my core/it'\\''s.sock' hc server start"],
  ])("prints the exact start command for %s", async (_, argv, caller, settings, command) => {
    const run = fake({ probes: [none], answer: "n", over: { caller: { HOME, XDG_RUNTIME_DIR: "/run/test", ...caller }, settings } });
    expect(await launchTui(argv, run.parts)).toBe(1);
    expect(run.said.join("").split("\n")[1]).toBe(`  ${command}`);
  });
});

describe("signals and the terminal", () => {
  it("ignores SIGINT and passes SIGTERM and SIGHUP on, listening from before the screen starts until it ended", async () => {
    let end!: (value: End) => void;
    const run = fake({ end: new Promise<End>((resolve) => { end = resolve; }) });
    const ran = launchTui([], run.parts);
    for (let turns = 0; turns < 50 && !run.calls.includes("run screen"); turns++) await Promise.resolve();
    expect(run.calls).toEqual(["probe /scratch/hc.sock", "on SIGINT", "on SIGTERM", "on SIGHUP", "run screen"]);
    run.handlers.get("SIGINT")!();
    run.handlers.get("SIGTERM")!();
    run.handlers.get("SIGHUP")!();
    end({ code: 143, signal: null });
    expect(await ran).toBe(143);
    expect(run.calls.slice(5)).toEqual(["kill SIGTERM", "kill SIGHUP", "off SIGINT", "off SIGTERM", "off SIGHUP"]);
    expect(run.written).toEqual([]);
  });

  it("stops listening when the screen cannot be started", async () => {
    const run = fake({ over: { run: () => { throw new Error("ENOENT"); } } });
    expect(await launchTui([], run.parts)).toBe(1);
    expect(run.codes()).toEqual(["start_failed"]);
    expect(run.calls.filter((call) => call.startsWith("off ")).sort()).toEqual(["off SIGHUP", "off SIGINT", "off SIGTERM"]);
  });

  /** the real runner, with a screen that ends as told: by its own SIGKILL, or with a code */
  const realRun = (script: string, held?: Held | null) => fake({ ...(held === undefined ? {} : { held }), over: { screen: { command: ["/bin/sh", "-c", script], cwd: scratch, file: null }, run: systemParts({}, scratch).run } });

  it.skipIf(process.platform === "win32").each([
    ["a screen killed before it turned its modes on, or after it undid them: the caller's own modes are left alone", "none", []],
    ["a screen killed while it held its modes", "modes", [LEAVE]],
    ["a screen killed while it also watched the colour scheme", "modes+watch", [LEAVE_ALL]],
    ["a screen that could be given no hold file: nothing is proven held, so the caller's own modes are left alone", null, []],
  ] as const)("after a SIGKILL writes the saved settings back and undoes only what the screen held: %s", async (_, held, written) => {
    const run = realRun("kill -KILL $$", held);
    expect(await launchTui([], run.parts)).toBe(128 + 9);
    expect(run.restored).toEqual([SAVED]);
    expect(run.written).toEqual([...written]);
    expect(run.unheld()).toBe(held === null ? 0 : 1);
  });

  it.skipIf(process.platform === "win32")("writes nothing after the screen exited by itself, whatever its code or what its hold file still says", async () => {
    for (const [script, code] of [["exit 0", 0], ["exit 143", 143]] as const) {
      const run = realRun(script, "modes");
      expect(await launchTui([], run.parts)).toBe(code);
      expect(run.restored).toEqual([]);
      expect(run.written).toEqual([]);
      expect(run.unheld()).toBe(1);
    }
  });

  it.skipIf(process.platform === "win32").each([
    ["the shell's temp folder", () => scratch],
    // the screen runs in another folder than the launcher: a hold file named relative to this one would be another file there
    ["a relative one, which is not used", () => relative(process.cwd(), scratch)],
    ["one that is not there", () => join(scratch, "no-such-folder")],
  ])("names its hold file to the screen, reads there what a screen that died held, and removes it with its folder: TMPDIR is %s", async (_, temp) => {
    // the real hold file, and a screen in a folder of its own that says what it holds as the host does, then dies
    const system = systemParts({ TMPDIR: temp() }, scratch);
    const screen = `import { openHold } from ${JSON.stringify(join(ROOT, "tui", "host", "hold.ts"))}; openHold(process.env.OVIS_TUI_HOLD)("modes+watch"); process.kill(process.pid, "SIGKILL");`;
    let hold = "";
    const holdFile = () => {
      const made = system.holdFile();
      hold = made?.path ?? "";
      return made;
    };
    const run = fake({ over: { screen: { command: [process.execPath, "-e", screen], cwd: scratch, file: null }, run: system.run, holdFile } });
    expect(await launchTui([], run.parts)).toBe(128 + 9);
    expect(run.written).toEqual([LEAVE_ALL]);
    expect(isAbsolute(hold)).toBe(true);
    expect(existsSync(dirname(hold))).toBe(false);
    expect(readdirSync(scratch).filter((name) => name.startsWith("ovis-tui-"))).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("hands the screen a hold file that is there and says nothing is held yet", () => {
    const hold = systemParts({ TMPDIR: scratch }, scratch).holdFile()!;
    try {
      expect([dirname(dirname(hold.path)), existsSync(hold.path), hold.held()]).toEqual([scratch, true, "none"]);
    } finally {
      hold.remove();
    }
  });
});

describe("the shell's environment", () => {
  /** the shell every measured case ran under */
  const SHELL = { PATH: "/usr/bin", HOME: "/home/me", SHELLV: "shell" };

  it("drops the cross-file and nested-default repro, and PATH, HOME and TERM too where the folder names them", async () => {
    writeFileSync(join(scratch, ".env"), [
      "DB_HOST=localhost", "DEFAULT_TOKEN=tok_123", "TOKEN=${TOKEN_OVERRIDE:-$DEFAULT_TOKEN}", 'WINDIR="C:\\repos\\app"',
      "TZ=UTC", "HC_API_KEY=canary", "PATH=/wrong", "HOME=/wrong", "TERM=dumb",
    ].join("\n"));
    writeFileSync(join(scratch, ".env.local"), "DATABASE_URL=postgres://app:canary@$DB_HOST/app\n");
    const shell = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, TERM: "xterm-256color",
      PORT: "1", HERDR_PLUGIN_CONFIG_DIR: join(scratch, "config"), HC_SOCKET: join(scratch, "hc.sock"),
      HERDR_TEST_SESSION: "row60-repro", XDG_RUNTIME_DIR: join(scratch, "run"),
    };
    const child = Bun.spawn([process.execPath, "-e", `
      import { callerEnv } from ${JSON.stringify(join(ROOT, "scripts", "plugin-tui.ts"))};
      const names = ["DB_HOST", "DEFAULT_TOKEN", "TOKEN", "WINDIR", "TZ", "HC_API_KEY", "DATABASE_URL"];
      console.log(JSON.stringify({
        loaded: names.filter(name => Object.hasOwn(process.env, name)),
        caller: callerEnv({ kernel: () => null, env: process.env, cwd: process.cwd() }),
      }));
    `], { cwd: scratch, env: shell, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [text, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(exit, err).toBe(0);
    const { loaded, caller } = JSON.parse(text);
    expect(loaded).toEqual(["DB_HOST", "DEFAULT_TOKEN", "TOKEN", "WINDIR", "TZ", "HC_API_KEY", "DATABASE_URL"]);
    // the shell gave PATH, HOME and TERM and the folder names them too: nothing tells whose value this process holds
    const { PATH: _path, HOME: _home, TERM: _term, ...unnamed } = shell;
    expect(caller).toMatchObject(unnamed);
    expect([...loaded, "PATH", "HOME", "TERM"].filter((name: string) => Object.hasOwn(caller, name))).toEqual([]);
  });

  it.each([
    ["cross-file reference", "K=$LOWER\n"],
    ["nested default", "K=${MISSING:-${OTHER:-$HOME}}\n"],
    ["single quotes", "K='pa$$word'\n"],
    ["carriage returns", 'K="a\\r\\nb"\r\n'],
    ["non-ASCII blanks", "K=\u00a0value\u3000\n"],
    ["Unicode line separator in a value", "K=a\u2028b\n"],
    ["empty braces", "K=${}\n"],
    ["unquoted comment", "K=value#comment\n"],
    ["quoted multiline value", 'K="first\nsecond"\n'],
    ["BOM, export and colon", "\ufeff export K : value\r\n"],
    ["lone CR", "OTHER=value\rK=value\r"],
    ["line break before the delimiter", "export\nK\n = value\n"],
    ["dotted and dashed key", "K=other\nk.dash-key=value\n"],
  ])("fallback drops the name regardless of its value: %s", (_, dotenv) => {
    const env = { ...SHELL, K: "a different shell value", "k.dash-key": "shell" };
    expect(shellEnv({ kernel: null, env, dotenv: [dotenv] })).toEqual(
      dotenv.includes("k.dash-key") ? SHELL : { ...SHELL, "k.dash-key": "shell" },
    );
  });

  it.each(["PATH", "HOME", "TERM", "USER", "LOGNAME", "SHELL"])("fallback drops %s too when a file names it, and keeps it when none does", (name) => {
    expect(shellEnv({ kernel: null, env: { [name]: "/only/from/folder", OTHER: "shell" }, dotenv: [`${name}=/only/from/folder\n`] })).toEqual({ OTHER: "shell" });
    expect(shellEnv({ kernel: null, env: { [name]: "shell" }, dotenv: ["OTHER=file\n"] })).toEqual({ [name]: "shell" });
  });

  it.skipIf(process.platform === "win32")("fallback: a HOME that only the folder's .env gives does not choose Ovis's settings", async () => {
    // a real Bun in the folder takes HOME from its .env, as the launcher's own does; that home holds settings of its own
    const project = join(scratch, "project");
    const named = join(project, "home");
    const account = join(scratch, "account");
    mkdirSync(join(named, ".config", "ovis"), { recursive: true });
    mkdirSync(account);
    writeFileSync(join(project, ".env"), `HOME=${named}\n`);
    writeFileSync(join(named, ".config", "ovis", "env"), "OVIS_TUI_BIN=/named/by/the/folder\n");
    const child = Bun.spawn([process.execPath, "-e", `
      import { runTui } from ${JSON.stringify(join(ROOT, "scripts", "plugin-tui.ts"))};
      process.exit(await runTui([], () => null, () => ${JSON.stringify(account)}));
    `], {
      cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HC_SOCKET: join(scratch, "hc.sock"), HC_SESSION: "row60-home", HERDR_TEST_SESSION: "row60-home", PORT: "1", TMPDIR: scratch },
    });
    const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(1);
    // no core runs and this is no terminal: that alone is said. The folder's settings would add their own line (tui_bin_unused)
    expect([...err.matchAll(/^ovis tui: ([a-z_]+): /gm)].map((match) => match[1])).toEqual(["no_core"]);
  }, 30_000);

  it.skipIf(process.platform === "win32")("looks for hc under the home it is given, never under the working folder when the environment has no HOME", async () => {
    // hc's usual folders are named from the home; with none they would be relative, and so the working folder's.
    // Under root's sticky /tmp, as server/herdr-core/discovery.test.ts: there every folder above the candidate passes
    // the trust check, which a shared TMPDIR need not, so only where it is looked for keeps the folder's hc from running
    const project = mkdtempSync(join("/tmp", "ovis-plugin-tui-"));
    try {
      const ran = join(scratch, "the-folder-s-hc-ran");
      mkdirSync(join(project, ".local", "bin"), { recursive: true, mode: 0o755 });
      mkdirSync(join(scratch, "account"));
      writeFileSync(join(project, ".local", "bin", "hc"), `#!/bin/sh\n: > '${ran}'\necho 'hc 0.1.18'\n`, { mode: 0o755 });
      const child = Bun.spawn([process.execPath, "-e", `
        import { systemParts } from ${JSON.stringify(join(ROOT, "scripts", "plugin-tui.ts"))};
        await systemParts({}, ${JSON.stringify(join(scratch, "account"))}).findHc({ PATH: "/nonexistent" }, {});
      `], { cwd: project, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch } });
      const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      expect(code, err).toBe(0);
      expect(existsSync(ran)).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }, 30_000);

  it("fallback drops every optional setting named by .env, including routing names", () => {
    const env = { HC_SOCKET: "/scratch/file.sock", HC_SESSION: "file", TZ: "UTC", TMPDIR: "/file", HC_API_KEY: "canary", XDG_CONFIG_HOME: "/file-config", LC_SECRET: "canary" };
    const dotenv = Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n");
    expect(shellEnv({ kernel: null, env: { ...SHELL, ...env }, dotenv: [dotenv] })).toEqual(SHELL);
  });

  it("is the kernel's copy where it can be read, whatever Bun added from the folder", () => {
    expect(shellEnv({ kernel: "PATH=/usr/bin\0HOME=/home/me\0DOUBLE=shell\0EMPTY=\0WITH_EQ=a=b\0", env: { ...SHELL, FROM_FILE: "x" }, dotenv: ["FROM_FILE=x\n"] }))
      .toEqual({ PATH: "/usr/bin", HOME: "/home/me", DOUBLE: "shell", EMPTY: "", WITH_EQ: "a=b" });
  });

  it.each([".env", ".env.local", ".env.development", ".env.development.local", ".env.production", ".env.production.local", ".env.test", ".env.test.local"])(
    "rebuilt from the working folder, %s is read",
    (file) => {
      const folder = join(scratch, "project");
      mkdirSync(folder);
      writeFileSync(join(folder, file), "FROM_FILE=x\n");
      expect(callerEnv({ kernel: () => null, env: { ...SHELL, FROM_FILE: "x" }, cwd: folder })).toEqual(SHELL);
      expect(callerEnv({ kernel: () => "ONLY=kernel\0", env: { ...SHELL, FROM_FILE: "x" }, cwd: folder })).toEqual({ ONLY: "kernel" });
    },
  );
});

describe("macOS exec-time environment", () => {
  function procArgs(argc: number, bytes: string): Buffer {
    const header = Buffer.alloc(4);
    header.writeInt32LE(argc);
    // Exercise a view into a larger buffer as well as a buffer allocated at offset zero.
    return Buffer.concat([Buffer.from("prefix"), header, Buffer.from(bytes)]).subarray(6);
  }

  it("reads env after the exec path, NUL padding and exactly argc arguments", () => {
    const bytes = procArgs(3, "/bin/bun\0\0\0bun\0\0ARG=not-env\0EMPTY=\0KEPT=a=b\0\0");
    expect(libc.parseProcArgs(bytes)).toBe("EMPTY=\0KEPT=a=b\0");
  });

  it("accepts a complete block containing no environment", () => {
    expect(libc.parseProcArgs(procArgs(1, "/bin/bun\0\0bun\0\0"))).toBe("");
  });

  it("excludes Darwin startup metadata even when there is no padding after env", () => {
    const bytes = procArgs(1, "/bin/bun\0bun\0pfz=0x111\0KEPT=yes\0pfz=0x123\0stack_guard=0x456\0");
    expect(libc.parseProcArgs(bytes)).toBe("pfz=0x111\0KEPT=yes\0");
  });

  it("keeps a shell name resembling Darwin metadata when the kernel zeroes the first apple records", () => {
    expect(libc.parseProcArgs(procArgs(1, "/bin/bun\0bun\0pfz=0x111\0KEPT=yes\0\0\0main_stack=0x456\0"))).toBe("pfz=0x111\0KEPT=yes\0");
  });

  it.each([
    ["short argc", Buffer.from([1, 0, 0])],
    ["negative argc", procArgs(-1, "/bin/bun\0\0bun\0A=x\0")],
    ["missing exec path", procArgs(1, "\0bun\0A=x\0")],
    ["unterminated exec path", procArgs(1, "/bin/bun")],
    ["missing argv", procArgs(1, "/bin/bun\0\0")],
    ["unterminated argv", procArgs(2, "/bin/bun\0\0bun\0truncated")],
    ["unterminated env", procArgs(1, "/bin/bun\0\0bun\0A=x\0B=y")],
  ])("returns null for %s so callerEnv uses its fallback", (_, bytes) => {
    expect(libc.parseProcArgs(bytes)).toBeNull();
    writeFileSync(join(scratch, ".env"), "DROPPED=yes\n");
    expect(callerEnv({ kernel: () => libc.parseProcArgs(bytes), env: { PATH: "/bin", DROPPED: "yes" }, cwd: scratch })).toEqual({ PATH: "/bin" });
  });
});

describe("the screen's start", () => {
  it("is the entry `tui` in the install's own folder: from source by its file and without a .env, compiled by name", () => {
    expect(ENTRIES.tui).toBe("tui/main.ts");
    expect(existsSync(join(ROOT, ENTRIES.tui))).toBe(true);
    expect(screenStart(false, "/src/ovis")).toEqual({ command: [process.execPath, "--no-env-file", "/src/ovis/tui/main.ts"], cwd: "/src/ovis", file: "/src/ovis/tui/main.ts" });
    expect(screenStart(true, "/home/me/.local/share/ovis/bin")).toEqual({ command: [process.execPath, "tui"], cwd: "/home/me/.local/share/ovis/bin", file: null });
  });

  it("says in one line with a code that the screen's file is missing, and starts nothing", async () => {
    const run = fake({ over: { screen: { command: ["screen"], cwd: "/install", file: join(scratch, "gone", "tui", "main.ts") } } });
    expect(await launchTui([], run.parts)).toBe(1);
    expect(run.codes()).toEqual(["screen_missing"]);
    expect(run.said.join("").trimEnd().split("\n").length).toBe(1);
    expect(run.runs).toEqual([]);
  });

  it("keeps the screen's view, emulator and core link out of the launcher, even through type imports", () => {
    const { reached } = importClosure("scripts/plugin.ts", (path) => existsSync(join(ROOT, path)) ? read(path) : undefined);
    expect(reached).toContain("scripts/plugin-tui.ts");
    expect(reached.filter((file) => /^tui\/(view|emulator|core)\//.test(file))).toEqual([]);
  });

  /** Ovis's own names as a shell that also runs the server exports them: a token, keys and secrets, by the name of today and the one before */
  const SERVER = { OVIS_TOKEN: "exported", OVIS_URL: "http://127.0.0.1:9", OVIS_OPENAI_API_KEY: "sk-canary", OVIS_PORTAL_OIDC_CLIENT_SECRET: "canary", OVIS_HC_BIN: "/bin/hc", HERDR_WEB_TOKEN: "old-name", HERDR_WEB_PASSWORD: "old-name" };

  it("gives the screen the caller's environment with none of Ovis's own names but the two it reads", () => {
    expect(tuiEnv({ TERM: "xterm", HC_SESSION: "s", HERDR_CONFIG_PATH: "/keys.toml", ...SERVER, OVIS_TUI_STATE_DIR: "/state", OVIS_ALLOW_LIVE_HERDR: "1" }))
      .toEqual({ TERM: "xterm", HC_SESSION: "s", HERDR_CONFIG_PATH: "/keys.toml", OVIS_TUI_STATE_DIR: "/state", OVIS_ALLOW_LIVE_HERDR: "1" });
  });

  it("names the screen's folder and hold file itself: the caller's own values for them are not handed on", async () => {
    const caller = { HOME, HC_SOCKET: SOCKET, ...SERVER, OVIS_TUI_STATE_DIR: "/state", OVIS_TUI_CWD: "/from/the/caller", OVIS_TUI_HOLD: "/from/the/caller/held" };
    for (const [held, hold] of [["none", { OVIS_TUI_HOLD: HOLD }], [null, {}]] as const) {
      const run = fake({ held, over: { caller } });
      expect(await launchTui([], run.parts)).toBe(0);
      expect(run.runs[0]!.env).toEqual({ HOME, HC_SOCKET: SOCKET, OVIS_TUI_STATE_DIR: "/state", OVIS_TUI_CWD: "/home/me/project", OVIS_TUI_SERVER: APP_ORIGIN, ...hold });
    }
  });
});

describe.skipIf(process.platform === "win32")("a recording stand-in hc", () => {
  /** an hc that answers --version and records the environment it got for that (`<record>.version`) and for `server start` */
  function standIn(): { bin: string; record: string } {
    const bin = join(scratch, "bin", "hc");
    const record = join(scratch, "hc-env");
    mkdirSync(join(scratch, "bin"), { recursive: true });
    writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n  --version) env > '${record}.version'; echo "hc 0.1.18" ;;\n  server) env > '${record}' ;;\n  *) exit 9 ;;\nesac\n`);
    chmodSync(bin, 0o755);
    return { bin, record };
  }
  const recorded = (file: string) => Object.fromEntries(readFileSync(file, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));

  const launching = { OVIS_TOKEN: "secret", OVIS_URL: "http://127.0.0.1:7317", PORT: "7317", HERDR_PANE_ID: "w1:p1", BUN_BE_BUN: "1", HC_TERMINAL_ID: "t-1", SSH_TTY: "/dev/pts/3", SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22", SSH_CLIENT: "10.0.0.2 5000 22", SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%1", STY: "1.pts-1.host", WINDOWID: "42" };

  function parts(answer: string, caller: Record<string, string>) {
    return fake({ probes: [none], answer, over: { ...withSystem(caller), caller } });
  }
  /** the system's finder and starter for `caller`, as the launcher runs them */
  function withSystem(caller: Record<string, string>): Partial<LaunchParts> {
    const system = systemParts(caller, scratch);
    return { findHc: system.findHc, startCore: system.startCore, settings: system.settings };
  }

  it("is found where the settings name it, and starts its core without the launch's own names", async () => {
    const { bin, record } = standIn();
    mkdirSync(join(scratch, ".config", "ovis"), { recursive: true });
    writeFileSync(join(scratch, ".config", "ovis", "env"), `OVIS_HC_BIN=${bin}\n`);
    const kept = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "run", "hc.sock"), XDG_RUNTIME_DIR: join(scratch, "run"), XDG_STATE_HOME: join(scratch, "state"), LANG: "C.UTF-8" };
    const run = parts("y", { ...kept, ...launching });
    expect(await launchTui([], run.parts)).toBe(0);
    const env = recorded(record);
    expect(Object.keys(launching).filter((name) => name in env)).toEqual([]);
    expect(env).toMatchObject(kept);
    expect(run.runs.length).toBe(1);
  });

  it("gets none of Ovis's own names for its --version or its server start: not a token only the settings hold, not the caller's", async () => {
    const { bin, record } = standIn();
    mkdirSync(join(scratch, ".config", "ovis"), { recursive: true });
    writeFileSync(join(scratch, ".config", "ovis", "env"), `OVIS_HC_BIN=${bin}\nOVIS_TOKEN=only-in-the-settings\nPORT=7317\n`);
    const caller = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "run", "hc.sock"), OVIS_URL: "http://127.0.0.1:7317", HERDR_WEB_TOKEN: "old-name" };
    const run = parts("y", caller);
    expect(await launchTui([], run.parts)).toBe(0);
    for (const file of [`${record}.version`, record]) {
      expect(Object.keys(recorded(file)).filter((name) => /^(?:OVIS_|HERDR_WEB_|PORT$)/.test(name)), file).toEqual([]);
    }
  });

  it("hands Ovis's SSH askpass to none of them: not the screen, not hc's --version, not the core it starts", async () => {
    const { bin, record } = standIn();
    // as server/ssh.ts gives it to the ssh it starts: the token and socket, the helper ssh must use, the stand-in display
    const askpass = { HERDR_ASKPASS_TOKEN: "one-connection-s-token", HERDR_ASKPASS_SOCKET: join(scratch, "ask"), SSH_ASKPASS: "/ovis/askpass", SSH_ASKPASS_REQUIRE: "force", DISPLAY: "herdr:0" };
    const run = parts("y", { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "run", "hc.sock"), OVIS_HC_BIN: bin, ...askpass });
    expect(await launchTui([], run.parts)).toBe(0);
    for (const [who, env] of [["the screen", run.runs[0]!.env], ["--version", recorded(`${record}.version`)], ["server start", recorded(record)]] as const) {
      expect(Object.keys(askpass).filter((name) => name in env), who).toEqual([]);
    }
  });

  it("starts nothing on n", async () => {
    const { bin, record } = standIn();
    const run = parts("n", { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "hc.sock"), OVIS_HC_BIN: bin });
    expect(await launchTui([], run.parts)).toBe(1);
    expect(existsSync(record)).toBe(false);
    expect(run.runs).toEqual([]);
  });

  it("dotenv canary: a .env in the working folder reaches neither the stand-in hc nor the screen, by either path", async () => {
    // a real Bun started in the folder loads its .env as the launcher's own Bun does; the driver then runs the launcher
    // with the kernel's copy (Linux) and with the rebuild (as on macOS), a stand-in hc and a screen that records its env
    const project = join(scratch, "project");
    const out = join(scratch, "out");
    mkdirSync(project);
    mkdirSync(out);
    mkdirSync(join(scratch, ".config", "ovis"), { recursive: true });
    // SHELL: one of the shell's basic names, which only the folder gives here
    writeFileSync(join(project, ".env"), "OVIS_TOKEN=canary\nCANARY_GENERIC=canary\nDOTENV_SECRET='pa$$word'\nH1=a#b\nDOUBLE=fromfile\nSHELL=/only/from/folder\n");
    writeFileSync(join(project, ".env.local"), "LOCAL_ONLY=canary\n");
    const hc = join(scratch, "hc");
    writeFileSync(hc, `#!/bin/sh\ncase "$1" in\n  --version) echo "hc 0.1.18" ;;\n  server) env > "$CANARY_OUT/hc.env" ;;\nesac\n`);
    chmodSync(hc, 0o755);
    writeFileSync(join(scratch, ".config", "ovis", "env"), `OVIS_HC_BIN=${hc}\n`);
    const recorder = join(scratch, "screen.ts");
    writeFileSync(recorder, "await Bun.write(`${process.env.CANARY_OUT}/screen.json`, JSON.stringify(process.env));\n");
    const driver = join(scratch, "driver.ts");
    writeFileSync(driver, `import { renameSync } from "node:fs";
import { callerEnv, kernelEnv, launchTui, systemParts } from ${JSON.stringify(join(ROOT, "scripts", "plugin-tui.ts"))};
const out = process.env.CANARY_OUT;
for (const path of ["kernel", "fallback"]) {
  const kernel = path === "kernel" ? kernelEnv() : null;
  if (path === "kernel" && kernel === null) throw new Error("could not read the exec-time environment");
  const caller = callerEnv({ kernel: () => kernel, env: process.env, cwd: process.cwd() });
  if (path === "kernel" && caller.DOUBLE !== "fromshell") throw new Error("kernel snapshot lost the shell's DOUBLE");
  const code = await launchTui([], {
    ...systemParts(caller, caller.HOME), isTty: true, probe: async () => ({ kind: "none" }), answers: async () => true, discard: () => true, show: () => true, line: () => "y",
    screen: { command: [process.execPath, "--no-env-file", ${JSON.stringify(recorder)}], cwd: out, file: null },
    terminal: { save: () => null, restore() {}, write() {} }, on: () => () => {},
  });
  renameSync(out + "/screen.json", out + "/screen-" + path + ".json");
  renameSync(out + "/hc.env", out + "/hc-" + path + ".env");
  console.log(path + " " + code);
}
`);
    const shell = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "hc.sock"),
      HERDR_TEST_SESSION: "row60-canary", XDG_RUNTIME_DIR: join(scratch, "run"), PORT: "1",
      HERDR_PLUGIN_CONFIG_DIR: join(scratch, ".config", "ovis"), DOUBLE: "fromshell", CANARY_OUT: out, TMPDIR: scratch,
    };
    const child = Bun.spawn([process.execPath, driver], { cwd: project, env: shell, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [said, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    const paths = ["kernel", "fallback"];
    expect(said.trim().split("\n")).toEqual(paths.map((path) => `${path} 0`));
    for (const path of paths) {
      const screen = JSON.parse(readFileSync(join(out, `screen-${path}.json`), "utf8")) as Record<string, string>;
      const core = recorded(join(out, `hc-${path}.env`));
      for (const env of [screen, core]) {
        expect(["OVIS_TOKEN", "CANARY_GENERIC", "DOTENV_SECRET", "H1", "LOCAL_ONLY", "SHELL"].filter((name) => name in env)).toEqual([]);
        expect([env["DOUBLE"], env["HOME"], env["PATH"]]).toEqual([path === "kernel" ? "fromshell" : undefined, scratch, shell.PATH]);
      }
      expect(screen["OVIS_TUI_CWD"]).toBe(project);
    }
  }, 30_000);

  it("from source, the screen loads no .env of the folder it runs in", async () => {
    const folder = join(scratch, "install");
    mkdirSync(folder);
    writeFileSync(join(folder, ".env"), "OVIS_TOKEN=canary\nCANARY_GENERIC=x\n");
    const screenRecord = join(scratch, "screen-env");
    const recorder = join(scratch, "screen.ts");
    writeFileSync(recorder, `await Bun.write(${JSON.stringify(screenRecord)}, [process.env.OVIS_TOKEN, process.env.CANARY_GENERIC].join(","));\n`);
    const caller = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: join(scratch, "hc.sock") };
    const start = screenStart(false, folder);
    const run = fake({ over: { caller, screen: { command: [...start.command.slice(0, -1), recorder], cwd: start.cwd, file: recorder }, run: systemParts(caller, scratch).run } });
    expect(await launchTui([], run.parts)).toBe(0);
    expect(readFileSync(screenRecord, "utf8")).toBe(",");
  }, 30_000);
});

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)("ovis tui through scripts/plugin.ts", () => {
  /** every path and size under `dir`, so a write anywhere shows, but Bun's own cache of the code it ran (`~/.bun`) */
  function listing(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((path) => !/^\.bun(\/|$)/.test(path)).sort().map((path) => `${path} ${statSync(join(dir, path)).size}`);
  }

  /** `bun scripts/plugin.ts tui <args>` with nothing of the user's own: a scratch home, config dir and core socket, where no core listens */
  async function tui(config: string, ...args: string[]) {
    const socket = join(scratch, "run", "hc.sock");
    const env = {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: scratch, HC_SOCKET: socket,
      HERDR_TEST_SESSION: "row60-config", XDG_RUNTIME_DIR: join(scratch, "run"), PORT: "1",
      HERDR_PLUGIN_CONFIG_DIR: join(config, "devswha.ovis"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    };
    const child = Bun.spawn([process.execPath, "scripts/plugin.ts", "tui", ...args], { cwd: ROOT, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, err, code, socket };
  }

  it("screen path writes no config: with the config folder read-only it works, and the folder's listing is unchanged", async () => {
    // an install from before the rename: plugin.ts's own work at import would copy these settings to the new id's dir
    const config = join(scratch, "config");
    mkdirSync(join(config, "devswha.herdr-web-ui"), { recursive: true });
    writeFileSync(join(config, "devswha.herdr-web-ui", ".env"), "OVIS_TOKEN=legacy\n");
    chmodSync(config, 0o555);
    const before = listing(scratch);
    const ran = await tui(config);
    expect(ran.code, ran.err).toBe(1);
    expect(ran.err.split("\n").slice(0, 2)).toEqual([expect.stringMatching(/^ovis tui: no_core: /), `  HC_SOCKET=${ran.socket} hc server start`]);
    expect(listing(scratch)).toEqual(before);
  }, 30_000);

  it("tui --help is the command line's help for it, as every command's: the launcher looks for no core", async () => {
    for (const flag of ["--help", "-h"]) {
      const help = await tui(join(scratch, "config"), flag);
      expect([help.code, help.err, help.out.startsWith("Usage: ovis tui")], flag).toEqual([0, "", true]);
    }
  }, 30_000);

  it("uses the core session from herdr's plugin config directory when called from a shell", async () => {
    const config = join(scratch, "plugin-config");
    const bin = join(scratch, "bin");
    mkdirSync(config);
    mkdirSync(bin);
    writeFileSync(join(config, "env"), "HC_SESSION=work\n");
    writeFileSync(join(bin, "herdr"), "#!/bin/sh\nprintf '%s\\n' \"$HOME/plugin-config\"\n", { mode: 0o755 });
    const result = Bun.spawnSync([process.execPath, "scripts/plugin.ts", "tui"], {
      cwd: ROOT,
      env: {
        HOME: scratch, PATH: bin, TMPDIR: scratch, XDG_CONFIG_HOME: join(scratch, "xdg-config"),
        XDG_RUNTIME_DIR: join(scratch, "run"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("herdr-core session work is not running");
  }, 30_000);
});
