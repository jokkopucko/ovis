import { expect, it, spyOn } from "bun:test";
import { processEnviron } from "./omo.ts";
import { PROBE_STARTED, createOmpProcessProbe, ompRoutingEnviron, processStartTicks } from "./omp-process.ts";

// The probe answers null, by design, for a process in uninterruptible sleep or one whose memory
// cannot be read in time. A bun target spends its first milliseconds, longer on a loaded PC, paging
// in its binary (state D). So the targets are a small shell that says when it is up and then waits in a read,
// and the reads that are not about the deadline get one no busy PC reaches.
const READ_MS = 30_000;
/** A stand-in helper's script: it says it runs, as the real one does, then does `js`. */
const helper = (js: string) => [process.execPath, "-e", `console.log(${JSON.stringify(PROBE_STARTED)}); ${js}`];
async function startedShell(args: string[], env?: Record<string, string>) {
  const argv = ["/bin/sh", "-c", "echo READY; read _", "sh", ...args];
  const target = Bun.spawn(argv, { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const reader = target.stdout.getReader();
  const decoder = new TextDecoder();
  let said = "";
  while (!said.includes("READY\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`the target shell exited before it was up: ${said}`);
    said += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  return { argv, target };
}

it.skipIf(process.platform !== "linux")("reads a live process's arguments and only the environment omp lookups need", async () => {
  const env = { PATH: process.env["PATH"] ?? "", OMP_PROFILE: "personal", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3", SECRET_TOKEN: "do-not-pass" };
  const { target } = await startedShell([], env);
  try {
    const read = createOmpProcessProbe({ timeoutMs: READ_MS });
    const result = await read(target.pid, true);
    expect(result?.argv.length).toBeGreaterThan(0);
    expect([...result?.environ ?? []].sort()).toEqual(["OMP_PROFILE=personal", "TMUX=/tmp/tmux-1/default,1,0", "TMUX_PANE=%3"]);
    expect((await createOmpProcessProbe({ timeoutMs: READ_MS })(target.pid, false))?.argv).toEqual([]);
    expect(await read(2147483647, true)).toBeNull();
  } finally { target.kill(); await target.exited; }
});

it.skipIf(process.platform !== "linux")("keeps only the variables omp's store lookup reads, through the helper and the direct read", async () => {
  const routing = {
    HOME: "/r", OMP_PROFILE: "work", PI_PROFILE: "pi", PI_CONFIG_DIR: ".alt", PI_CODING_AGENT_DIR: "/r/agent", PI_CODING_AGENT_SESSION_DIR: "/r/sessions",
    DSH_HOME: "/r/dsh", DSH_TUI_RESUME_SESSION: "1dacc7bc-68e8-4934-baec-ba181b8251f9", XDG_DATA_HOME: "/r/data", XDG_STATE_HOME: "/r/state", TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%3",
  };
  // secrets, look-alike names and the XDG roots omp's store lookup never reads
  const env = { ...routing, PATH: process.env["PATH"] ?? "", SECRET_TOKEN: "SECRET_TOKEN_value", OPENAI_API_KEY: "SECRET_TOKEN_key", PI_CODING_AGENT_DIR_EXTRA: "SECRET_TOKEN_x", HOMEDIR: "SECRET_TOKEN_h", DSH_HOME_EXTRA: "SECRET_TOKEN_dsh", XDG_CONFIG_HOME: "/r/config" };
  const { target } = await startedShell([], env);
  try {
    const expected = Object.entries(routing).map(([key, value]) => `${key}=${value}`).sort();
    const helper = await createOmpProcessProbe({ timeoutMs: READ_MS })(target.pid, true);
    expect([...helper?.environ ?? []].sort()).toEqual(expected);
    const direct = ompRoutingEnviron(processEnviron(target.pid));
    expect([...direct ?? []].sort()).toEqual(expected);
    expect(JSON.stringify([helper, direct])).not.toContain("SECRET_TOKEN");
  } finally { target.kill(); await target.exited; }
  // an environment read empty is a process gone or not ours, not one without the variables
  expect(ompRoutingEnviron(null)).toBeNull();
  expect(ompRoutingEnviron([""])).toBeNull();
  expect(ompRoutingEnviron(["PATH=/bin", ""])).toEqual([]);
});

it.skipIf(process.platform !== "linux")("keeps a process's empty arguments where they stand", async () => {
  const { argv, target } = await startedShell(["--cwd", "", "/B", ""]);
  try {
    expect((await createOmpProcessProbe({ timeoutMs: READ_MS })(target.pid, true))?.argv).toEqual(argv);
  } finally { target.kill(); await target.exited; }
});

it.skipIf(process.platform !== "linux")("keeps a successful read per process start, never a failed one", async () => {
  const start = processStartTicks(process.pid)!;
  let starts = 0, fail = true, ticks = start;
  const read = createOmpProcessProbe({
    timeoutMs: READ_MS,
    startTicks: () => ticks,
    command: () => { starts++; return helper(fail ? "process.exit(1)" : `console.log(JSON.stringify({start:${JSON.stringify(start)},argv:["omp"],environ:[]}))`); },
  });
  expect(await read(process.pid, true)).toBeNull();
  fail = false;
  expect((await read(process.pid, true))?.argv).toEqual(["omp"]);
  expect((await read(process.pid, true))?.argv).toEqual(["omp"]);
  expect((await read(process.pid, false))?.argv).toEqual(["omp"]);
  expect(starts).toBe(2);
  // the pid now names a process that started at another time: the helper's answer is not its
  ticks = `${start}1`;
  expect(await read(process.pid, true)).toBeNull();
  expect(starts).toBe(3);
});

it.skipIf(process.platform !== "linux")("a stalled memory read has a deadline and leaves the event loop responsive", async () => {
  // stalled in its read, and stalled before it ever runs: each has its own deadline
  for (const options of [{ timeoutMs: 100, command: () => helper("setInterval(() => {}, 1000)") }, { startMs: 100, command: () => [process.execPath, "-e", "setInterval(() => {}, 1000)"] }]) {
    const read = createOmpProcessProbe(options);
    const result = read(process.pid, true);
    let settled = false;
    void result.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve("deadline missed"), 1000))])).toBeNull();
  }
});

it.skipIf(process.platform !== "linux")("times only the read, not a helper that is slow to start on a loaded PC (#2648)", async () => {
  // the helper says it runs only after the read deadline has passed since its spawn, then answers in
  // the same write, so the read deadline has nothing left to time but the helper's exit
  const late = `setTimeout(() => console.log(${JSON.stringify(PROBE_STARTED)} + "\\n" + JSON.stringify({ start: "1", argv: ["omp"], environ: [] })), 1500)`;
  const read = createOmpProcessProbe({ timeoutMs: 1000, startTicks: () => "1", command: () => [process.execPath, "-e", late] });
  expect((await read(1, true))?.argv).toEqual(["omp"]);
});

it.skipIf(process.platform !== "linux")("deduplicates reads and bounds outstanding helpers when polling repeats", async () => {
  let starts = 0;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const read = createOmpProcessProbe({ timeoutMs: 100, maxProcesses: 1, startTicks: () => "1", command: () => { starts++; return helper("setInterval(() => {}, 1000)"); } });
    const first = read(1, true);
    expect(read(1, true)).toBe(first);
    expect(await read(2, true)).toBeNull();
    expect(await read(3, true)).toBeNull();
    expect(starts).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await first).toBeNull();
  } finally { warn.mockRestore(); }
});

it.skipIf(process.platform !== "linux")("rejects malformed or excessive helper output and invalid process IDs", async () => {
  for (const script of ["console.log('not JSON')", "console.log(JSON.stringify({argv:[42],environ:[]}))", "console.log(JSON.stringify({start:'0',argv:[],environ:[]}))", "console.log('x'.repeat(1024*1024+1))", "process.exit(1)"]) {
    const read = createOmpProcessProbe({ command: () => helper(script) });
    expect(await read(process.pid, true)).toBeNull();
  }
  let starts = 0;
  const read = createOmpProcessProbe({ command: () => { starts++; return []; } });
  for (const pid of [-1, 0, 1.5, Number.NaN]) expect(await read(pid, true)).toBeNull();
  expect(starts).toBe(0);
});

it.skipIf(process.platform !== "linux")("reads no environment larger than its bound, so an oversized one is no answer", async () => {
  // nine values just under the kernel's per-string limit: about 1.1 MiB of environment
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", DSH_TUI_RESUME_SESSION: "1dacc7bc-68e8-4934-baec-ba181b8251f9" };
  for (let i = 0; i < 9; i++) env[`FILLER_${i}`] = "x".repeat(120 * 1024);
  const { target } = await startedShell([], env);
  try {
    expect(await createOmpProcessProbe({ timeoutMs: READ_MS })(target.pid, false)).toBeNull();
  } finally { target.kill(); await target.exited; }
});
