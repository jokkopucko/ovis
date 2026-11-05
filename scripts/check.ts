/**
 * The checks, from one entry point: CI's jobs call it, and so does a developer or an agent
 * before pushing, so both run the same thing.
 *
 *   bun run check fast                  what CI's "Fast checks" job runs: workflow syntax, generated
 *                                       types, typecheck, build, unit tests. No herdr needed.
 *   bun run check integration browser   CI's "Integration and browser" job: a build, then the named
 *                                       lanes side by side (either name alone runs that lane)
 *   bun run check full                  fast, then both lanes
 *   bun run check concurrent            the steps of full, with the unit tests run side by side
 *                                       with both lanes instead of before them
 *   bun run check run [--build] <command…>  any command on the same isolated herdr; --build builds
 *                                           dist/ first (a run without it does not build)
 *
 * Whatever needs herdr runs on a herdr of its own. Its config, its plugin state and the web UI's
 * state live in a directory made for this run (XDG_CONFIG_HOME, XDG_STATE_HOME,
 * OVIS_STATE_DIR), under a session name made for this run. Nothing reads the user's herdr
 * config, so no plugin installed there starts with the test servers, and two runs on one PC
 * share no socket and no file. The run stops its herdr servers and removes the directory when
 * it ends, also when it is interrupted. CHECK_DIR names a directory to use and keep instead.
 * CHECK_REPORT overrides the durable JSON report path; otherwise the report is in CHECK_DIR or
 * node_modules/.cache/check/<run-id>. The report and streamed logs are outside ephemeral isolation.
 *
 * A few herdr-backed runs at a time on this PC (CHECK_MAX_RUNS, see maxRuns): contract and browser
 * tests are bound by timing, so too many side by side fail each other. Each run holds a slot, a
 * loopback port it listens on (CHECK_LOCK_PORT, default 41737, and the ports after it: the slots,
 * the admission port, the queue's ticket desk and its ticket ports, MAX_RUNS_LIMIT + 2 + QUEUE_TICKETS
 * in all), so a run that died holds nothing.
 * A run that finds every slot taken names the holders and exits, and so does a second run in the
 * same checkout, which would share its dist/ and generated types. `fast` takes no slot, but it claims
 * its checkout all the same: it rewrites the generated types file while it checks it and builds into
 * dist/, so it and any other mode refuse each other in one checkout.
 *
 * What a run still shares with the PC: the checkout with whatever else writes there outside a check
 * (a `bun run build` beside it), herdr's worktree root, and Playwright's browser cache. `run` does
 * not rebuild dist/ unless asked with `--build`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";
import { DISPOSABLE_CONFIG_ENV, DISPOSABLE_CONFIG_FILE } from "./disposable-config.ts";
import { testShellEnv } from "./test-shell.ts";
import {
  artifactIdentity,
  artifactUnchangedAfterBuild,
  createRunId,
  initialReport,
  persistReport,
  reportExitCode,
  reportPaths,
  revisionDetails,
  sourceIdentity,
  verificationResult,
  type CheckReport,
  type CheckStep,
  type SourceIdentity,
} from "./check-report.ts";

export const MODES = ["fast", "integration", "browser", "full", "concurrent", "run"] as const;
export type Mode = (typeof MODES)[number];
const LANES = { integration: "bun run test:integration", browser: "bash scripts/ci-browser.sh" } as const;
type Lane = keyof typeof LANES;

const USAGE = "Usage: bun run check fast | integration | browser | integration browser | full | concurrent | run [--build] <command…>";

/** What to run, from the arguments: the fast steps, the lanes, or one command. */
export function plan(args: readonly string[]): { fast: boolean; lanes: Lane[]; command: string[] | null; build: boolean; concurrent: boolean } {
  const [first, ...rest] = args;
  if (first === "run") {
    const build = rest[0] === "--build";
    const command = rest.slice(build ? 1 : 0);
    if (command[0] === "--") command.shift();
    if (command.length === 0) throw new Error(USAGE);
    return { fast: false, lanes: [], command, build, concurrent: false };
  }
  if (args.length === 0 || args.some((arg) => arg === "run" || !(MODES as readonly string[]).includes(arg))) throw new Error(USAGE);
  const concurrent = args.includes("concurrent");
  const full = args.includes("full");
  const lanes = (Object.keys(LANES) as Lane[]).filter((lane) => full || concurrent || args.includes(lane));
  return { fast: (full || args.includes("fast")) && !concurrent, lanes, command: null, build: false, concurrent };
}

/** Herdr-backed commands share the existing per-PC lane lock, including `run` commands. */
export function needsLock(todo: ReturnType<typeof plan>): boolean {
  return todo.lanes.length > 0 || todo.command !== null || todo.concurrent;
}

/** Keep command arguments useful without persisting common inline credentials. Environment values are never serialized. */
export function sanitizeCommand(command: readonly string[]): string[] {
  const sensitive = /token|secret|password|passwd|api[-_]?key|auth|cookie|credential|bearer/i;
  let redactNext = false;
  const sanitized = command.map((argument) => {
    if (redactNext) { redactNext = false; return "[REDACTED]"; }
    if (/^(?:authorization|cookie):\s*/i.test(argument)) return argument.replace(/:.*/, ":[REDACTED]");
    if (/^--?[^=]+$/.test(argument) && sensitive.test(argument)) { redactNext = true; return argument; }
    const equals = argument.indexOf("=");
    if (equals > 0 && sensitive.test(argument.slice(0, equals))) return `${argument.slice(0, equals)}=[REDACTED]`;
    return argument.replace(/([?&][^=]*(?:token|secret|password|key|auth|credential)[^=]*=)[^&]*/gi, "$1[REDACTED]");
  });
  let remaining = 8_192;
  const bounded: string[] = [];
  for (const argument of sanitized) {
    if (remaining <= 0) { bounded.push("[ARGUMENTS TRUNCATED]"); break; }
    if (argument.length > remaining) {
      bounded.push(`${argument.slice(0, Math.max(0, remaining - 14))}[TRUNCATED]`);
      break;
    }
    bounded.push(argument);
    remaining -= argument.length;
  }
  return bounded;
}

/** actionlint as CI pins it. The archive is checked against its SHA-256 before it is unpacked. */
const ACTIONLINT = { version: "1.7.12", sha256: "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8" };

/** A unix socket's path holds about 104 bytes on macOS and 108 on Linux. */
export const SOCKET_PATH_MAX = 100;

/**
 * What a shell inside a herdr pane carries of that herdr, and what names the user's own herdr
 * config: nothing in a run may reach either by these.
 */
const LIVE_HERDR = ["HERDR_SOCKET", "HERDR_SOCKET_PATH", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_CONFIG_PATH"];

export interface Isolation {
  env: Record<string, string>;
  /** the absolute directory that holds the run's config and state */
  dir: string;
  /** where the run's herdr keeps its sessions */
  sessions: string;
  /** removes the directory, unless the caller named it */
  remove: () => void;
}

/**
 * A herdr of the run's own: the environment that points herdr, its plugins and the web UI at one
 * directory, and a session name no other run has.
 */
export function isolate(base: Record<string, string | undefined>, kept: string | undefined = base["CHECK_DIR"]): Isolation {
  if (base["HERDR_TEST_LIVE"] === "1") throw new Error("HERDR_TEST_LIVE=1 runs tests in the herdr you work in; unset it for `bun run check`");
  // short on purpose: the session's socket path has to fit a unix socket address
  const dir = kept ? resolve(kept) : mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "hwc-"));
  const session = `check-${randomBytes(3).toString("hex")}`;
  const config = join(dir, "config");
  for (const path of [config, join(dir, "state"), join(dir, "web-state")]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`isolated state path is not a real directory: ${path}`);
    if (process.platform !== "win32") chmodSync(path, 0o700);
  }
  // what lets a test write to herdr's per-user plugin registry: this one is the run's own
  writeFileSync(join(config, DISPOSABLE_CONFIG_FILE), "", { mode: 0o600 });
  const sessions = join(config, "herdr", "sessions");
  // the integration lane's workers are `<session>-<n>`
  const socket = join(sessions, `${session}-9`, "herdr.sock");
  if (socket.length > SOCKET_PATH_MAX) {
    if (!kept) rmSync(dir, { recursive: true, force: true });
    throw new Error(`${socket} is too long for a unix socket (${socket.length} > ${SOCKET_PATH_MAX}); set CHECK_DIR to a shorter path`);
  }
  const env: Record<string, string> = {};
  // not what names the herdr this was started from (a pane of the user's): its socket, its pane,
  // and the user's own herdr config
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !LIVE_HERDR.includes(name)) env[name] = value;
  Object.assign(env, {
    ...testShellEnv(dir),
    // the browser scripts assert the English copy, and headless Chromium takes its locale from
    // LANGUAGE first: a desktop set to another language would draw the app in that one
    LANGUAGE: "en_US:en",
    XDG_CONFIG_HOME: config,
    [DISPOSABLE_CONFIG_ENV]: config,
    // the run's own session (where scripts/test-herdr.ts starts it), so a server started by hand
    // inside `check run` never falls back to the herdr the user works in
    HERDR_SOCKET: join(sessions, session, "herdr.sock"),
    XDG_STATE_HOME: join(dir, "state"),
    OVIS_STATE_DIR: join(dir, "web-state"),
    HERDR_TEST_SESSION: session,
    // One integration file at a time: four at once made the timing-bound contract tests fail in
    // turn on CI's four cores. HERDR_TEST_SHARDS raises it (scripts/ci-tests.ts).
    HERDR_TEST_SHARDS: base["HERDR_TEST_SHARDS"] || "1",
  });
  return { env, dir, sessions, remove: () => { if (!kept) rmSync(dir, { recursive: true, force: true }); } };
}

/**
 * Stops every herdr server the run's sessions directory holds, trying each one even after another
 * failed, and throws what failed. A crash or SIGKILL can leave a stale socket behind: after a
 * failed stop, only a missing socket or a refused connection proves the session stopped.
 */
export async function stopSessions(
  sessions: string,
  stop: (session: string) => { error?: Error; status: number | null; signal: NodeJS.Signals | null; stderr?: string | null },
  probe: (socket: string) => Promise<void> = (socket) => new Promise((resolve, reject) => {
    const client = connect(socket);
    client.once("connect", () => { client.destroy(); resolve(); });
    client.once("error", reject);
    client.setTimeout(2_000, () => client.destroy(new Error("session socket probe timed out")));
  }),
): Promise<void> {
  const failed: string[] = [];
  for (const session of existsSync(sessions) ? readdirSync(sessions).sort() : []) {
    const socket = join(sessions, session, "herdr.sock");
    if (!existsSync(socket)) continue;
    const result = stop(session);
    if (!result.error && !result.signal && result.status === 0) continue;
    try { await probe(socket); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOENT") continue;
      failed.push(`${session} (stop failed and socket state is unproven: ${errorText(error)})`);
      continue;
    }
    const said = result.stderr?.trim().replace(/\s+/g, " ").slice(0, 200);
    if (result.error) failed.push(`${session} (${result.error.message})`);
    else if (result.signal) failed.push(`${session} (herdr server stop was terminated by ${result.signal})`);
    else if (result.status !== 0) failed.push(`${session} (herdr server stop exited with code ${result.status}${said ? `: ${said}` : ""})`);
  }
  if (failed.length > 0) throw new Error(`could not stop herdr session ${failed.join(", ")}`);
}

/** What a run's teardown found wrong, and the directory it kept for diagnosis because of it. */
export interface Teardown { failures: string[]; retained: string | null }

/**
 * Stops what the run started, then removes its isolated state. Every stop is tried even after one
 * fails. The directory is removed only when nothing failed, `earlier` (process groups that would
 * not end) included; otherwise it is kept, and named, so what was left behind can be looked at.
 */
export async function teardown(stops: readonly (() => void | Promise<void>)[], isolation: Pick<Isolation, "dir" | "remove"> | null, earlier: readonly string[] = []): Promise<Teardown> {
  const failures: string[] = [];
  for (const stop of stops) {
    try { await stop(); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  if (!isolation) return { failures, retained: null };
  if (earlier.length > 0 || failures.length > 0) return { failures, retained: isolation.dir };
  try { isolation.remove(); } catch (error) {
    failures.push(`could not remove ${isolation.dir}: ${error instanceof Error ? error.message : String(error)}`);
    return { failures, retained: isolation.dir };
  }
  return { failures, retained: null };
}

/** The first loopback port a herdr-backed run listens on while it runs: slot 1. */
export const DEFAULT_LOCK_PORT = 41737;
export function lockPort(env: Record<string, string | undefined>): number {
  const asked = env["CHECK_LOCK_PORT"];
  if (asked === undefined || asked === "") return DEFAULT_LOCK_PORT;
  const port = /^\d+$/.test(asked) ? Number(asked) : Number.NaN;
  if (!(port >= 1024 && port <= MAX_LOCK_PORT)) throw new Error(`CHECK_LOCK_PORT must be a whole number from 1024 to ${MAX_LOCK_PORT}, not "${asked}"`);
  return port;
}
/** The most slots CHECK_MAX_RUNS may ask for; every run looks at all of them for its own checkout. */
export const MAX_RUNS_LIMIT = 8;
/** How many runs can hold a place in the queue for a slot at once (ticket ports above the admission port). */
export const QUEUE_TICKETS = 24;
/**
 * The highest lock base: acquire() listens on the slots and on the admission port above them, up to
 * base + MAX_RUNS_LIMIT, then the ticket desk and a waiting run on a ticket port above that, up to
 * 1 + QUEUE_TICKETS more.
 */
export const MAX_LOCK_PORT = 65535 - MAX_RUNS_LIMIT - 1 - QUEUE_TICKETS;

/**
 * How many herdr-backed runs may share this PC: CHECK_MAX_RUNS (1 to 8), else one per eight cores,
 * at least one and at most two. On a 32-core PC two side by side stayed green; with three,
 * machine-conflict-regression.ts lost Chromium screenshots, and with four integration tests
 * that wait on live processes failed (measured for the PR that added slots).
 */
export function maxRuns(env: Record<string, string | undefined>, cores = availableParallelism()): number {
  const asked = env["CHECK_MAX_RUNS"];
  if (asked === undefined || asked === "") return Math.max(1, Math.min(2, Math.floor(cores / 8)));
  const count = /^\d+$/.test(asked) ? Number(asked) : Number.NaN;
  if (!(count >= 1 && count <= MAX_RUNS_LIMIT)) throw new Error(`CHECK_MAX_RUNS must be a whole number from 1 to ${MAX_RUNS_LIMIT}, not "${asked}"`);
  return count;
}

/**
 * What a CI host says it can take, each over the workflow's own value: a self-hosted runner's launcher
 * puts these in its containers' environment (scripts/self-hosted-runner/run.sh --env-file), which the
 * workflow's expressions cannot read. Every runner of a host shares its slots, so the host, not a job,
 * knows how many fit. Unset or empty leaves the workflow's value; the named variable's own check
 * still applies.
 */
export const HOST_LIMITS = {
  CHECK_HOST_MAX_RUNS: "CHECK_MAX_RUNS",
  CHECK_HOST_TEST_SHARDS: "HERDR_TEST_SHARDS",
  CHECK_HOST_BROWSER_WORKERS: "BROWSER_WORKERS",
  CHECK_HOST_UNIT_WORKERS: "UNIT_TEST_WORKERS",
} as const;
export function applyHostLimits(env: Record<string, string | undefined>): void {
  for (const [host, name] of Object.entries(HOST_LIMITS)) {
    const value = env[host];
    if (value) env[name] = value;
  }
}

/**
 * What a run calls its checkout to the runs that share its slots. A self-hosted CI runner shares its
 * loopback with the other runner containers of its PC (scripts/self-hosted-runner/run.sh), and every
 * one of them checks out to the same path, so there the runner's name (RUNNER_NAME, set by the
 * Actions runner) is part of it: two runners are two checkouts.
 */
export function checkoutIdentity(checkout: string, env: Record<string, string | undefined> = process.env): string {
  const runner = env["RUNNER_NAME"];
  return runner ? `${runner}:${checkout}` : checkout;
}

/** The most CHECK_WAIT_SECONDS may ask for: two hours, past any CI job's timeout. */
export const MAX_WAIT_SECONDS = 7200;

/**
 * How long a run waits for a slot when the run limit is reached: CHECK_WAIT_SECONDS (0 to 7200),
 * else 0, which refuses at once. CI sets it: a job that finds the PC busy waits its turn instead
 * of failing. A run in the same checkout, or a held resource, is still refused at once.
 */
export function waitSeconds(env: Record<string, string | undefined>): number {
  const asked = env["CHECK_WAIT_SECONDS"];
  if (asked === undefined || asked === "") return 0;
  const seconds = /^\d+$/.test(asked) ? Number(asked) : Number.NaN;
  if (!(seconds >= 0 && seconds <= MAX_WAIT_SECONDS)) throw new Error(`CHECK_WAIT_SECONDS must be a whole number from 0 to ${MAX_WAIT_SECONDS}, not "${asked}"`);
  return seconds;
}

/** The Node major CI's runners use (scripts/self-hosted-runner/Dockerfile's NODE_VERSION; a test keeps them equal). */
export const CI_NODE_MAJOR = 22;
export function warnNodeVersionMismatch(version: string | null, warn: (message: string) => void, ciMajor = CI_NODE_MAJOR): void {
  const major = version?.match(/^v(\d+)\./)?.[1];
  if (major !== undefined && Number(major) !== ciMajor) {
    warn(`check: warning: local Node ${version} differs from CI Node ${ciMajor}`);
  }
}

/** What a slot's holder says: its pid (NaN when what listens there is no run) and its checkout, when it names one. */
export type Holder = { heldBy: number; checkout?: string };

/** Asks the holder of a port who it is; null when nothing listens there. */
function ask(port: number): Promise<Holder | null> {
  return new Promise((resolve) => {
    let said = "";
    let refused = false;
    const client = connect(port, "127.0.0.1");
    client.setTimeout(2_000, () => client.destroy());
    client.on("data", (chunk) => { said += chunk.toString(); });
    client.on("error", (error: NodeJS.ErrnoException) => { refused = error.code === "ECONNREFUSED"; });
    client.on("close", () => {
      if (refused) { resolve(null); return; }
      // `<pid>` from a run before slots, `<pid>\n<checkout>` from one since
      const match = /^(\d+)(?:\n([^]+))?$/.exec(said);
      resolve(!match ? { heldBy: Number.NaN } : match[2] ? { heldBy: Number(match[1]), checkout: match[2] } : { heldBy: Number(match[1]) });
    });
  });
}

/**
 * One slot. The lock is a listening loopback port: taking it is one step, and it is free again the
 * moment its run is gone, however it ended, so there is no lock left behind to take over. Whoever
 * holds it answers a connection with its pid and checkout. Resolves with the release, or with who
 * holds it (NaN when something else listens there).
 */
export function lock(port = DEFAULT_LOCK_PORT, pid = process.pid, checkout?: string): Promise<{ release: () => void } | Holder> {
  return new Promise((resolve, reject) => {
    const answer = checkout === undefined ? String(pid) : `${pid}\n${checkout}`;
    const server = createServer((socket) => { socket.on("error", () => undefined); socket.end(answer); });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") { reject(error); return; }
      void ask(port).then((holder) => resolve(holder ?? { heldBy: Number.NaN }));
    });
    server.listen(port, "127.0.0.1", () => {
      // the lock must not keep the run alive once its work is done
      server.unref();
      resolve({ release: () => { server.close(); } });
    });
  });
}

/** A slot's holder, or a run waiting ahead in the queue (`queuedAt`, ms since 1970: when it first found the PC busy). */
export type SlotHolder = Holder & { port: number; queuedAt?: number };
/** Who holds a claim: its pid, its checkout and, where the system can say, when that process started (processStart). */
type MarkerOwner = { pid: number; checkout: string; start?: string };

/** A waiting run's place in the queue: when it first found the PC busy, and the ticket port it holds. */
export type Ticket = { at: number; port: number };

/** The port a run holds while it takes a place, just above the admission port: one run at a time. */
export function ticketDesk(base: number, slots: number, scan: number): number {
  return base + Math.max(slots, scan) + 1;
}

/** The ticket ports, above the ticket desk: the same for every run of a base whatever its slot count. */
export function ticketPorts(base: number, slots: number, scan: number): number[] {
  const first = ticketDesk(base, slots, scan) + 1;
  return Array.from({ length: QUEUE_TICKETS }, (_, index) => first + index);
}

/** How long one ticket lookup may take in all: a run holding the admission port asks every ticket port. */
const TICKET_LOOKUP_MS = 1_500;
/** How long a run waits for the ticket desk: a run there holds it for one ticket lookup and a bind. */
export const DESK_WAIT_MS = 2 * TICKET_LOOKUP_MS;

/**
 * Who waits on a ticket port: null when nothing listens there, or when what listens is no ticket. A
 * ticket answers with one short message and closes; a listener that says anything else is dropped at
 * once, and none is waited on past TICKET_LOOKUP_MS, however it keeps talking.
 */
function askTicket(port: number): Promise<(SlotHolder & { queuedAt: number }) | null> {
  return new Promise((resolve) => {
    let said = "";
    const client = connect(port, "127.0.0.1");
    const deadline = setTimeout(() => client.destroy(), TICKET_LOOKUP_MS);
    client.on("data", (chunk) => {
      said += chunk.toString();
      if (!"ticket\n".startsWith(said.slice(0, 7)) || said.length > 4_096) client.destroy();
    });
    client.on("error", () => undefined);
    client.on("close", () => {
      clearTimeout(deadline);
      const match = /^ticket\n(\d+)\n(\d+)\n([^]+)$/.exec(said);
      resolve(match ? { port, queuedAt: Number(match[1]), heldBy: Number(match[2]), checkout: match[3]! } : null);
    });
  });
}

/**
 * Takes a place in the queue: the first free ticket port, listened on for as long as the run waits,
 * so a run that dies leaves no place behind. Null when every ticket port is taken, or when the ticket
 * desk stayed taken for `deskWaitMs`; the run then waits without one, behind every run that holds one,
 * and tries again on its next round.
 */
export async function takeTicket(
  { base, slots, scan = MAX_RUNS_LIMIT, at, pid = process.pid, checkout, deskWaitMs = DESK_WAIT_MS }: { base: number; slots: number; scan?: number; at: number; pid?: number; checkout: string; deskWaitMs?: number },
): Promise<{ ticket: Ticket; release: () => void } | null> {
  // One run at a time looks at the places taken and takes its own: two that looked at once could
  // each miss the other, and the later one rank ahead on a clock stepped back between them.
  // Bound directly: whoever holds it is never asked who it is, so nothing on that port can keep
  // this run talking.
  const bindDesk = (): Promise<{ release: () => void } | null> => new Promise((resolve, reject) => {
    const server = createServer((socket) => { socket.destroy(); });
    server.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE") resolve(null); else reject(error); });
    server.listen(ticketDesk(base, slots, scan), "127.0.0.1", () => { server.unref(); resolve({ release: () => { server.close(); } }); });
  });
  // A run at the desk holds it for one look at the tickets: wait for it, not for a whole round, in
  // which a run that came later could take its place first and so rank ahead of this one. Runs that
  // reach a free desk within one retry of each other (10 ms) may still swap places: their order is
  // that of the desk, not of when they first found the PC busy.
  // on the monotonic clock: a wall clock stepped back would stretch the wait by the step
  const deadline = performance.now() + deskWaitMs;
  let desk = await bindDesk();
  while (desk === null && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    desk = await bindDesk();
  }
  if (desk === null) return null;
  try {
    // after every place already taken, whatever the clock says: a clock stepped back must not put a
    // run that came later ahead of one that waits
    const waiting = await Promise.all(ticketPorts(base, slots, scan).map(askTicket));
    for (const run of waiting) if (run !== null && run.queuedAt >= at) at = run.queuedAt + 1;
    for (const port of ticketPorts(base, slots, scan)) {
      const taken = await new Promise<{ release: () => void } | null>((resolve, reject) => {
        const answer = `ticket\n${at}\n${pid}\n${checkout}`;
        const server = createServer((socket) => { socket.on("error", () => undefined); socket.end(answer); });
        server.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE") resolve(null); else reject(error); });
        server.listen(port, "127.0.0.1", () => { server.unref(); resolve({ release: () => { server.close(); } }); });
      });
      if (taken) return { ticket: { at, port }, release: taken.release };
    }
    return null;
  } finally {
    desk.release();
  }
}

/** Whether queue place `a` comes before `b`: the earlier first refusal, then the lower ticket port. */
const ahead = (a: Ticket, b: Ticket): boolean => a.at < b.at || (a.at === b.at && a.port < b.port);

/** The runs waiting ahead of `ticket` (every waiting run, for a run without one), oldest first. */
async function queuedAhead(base: number, slots: number, scan: number, ticket: Ticket | undefined): Promise<SlotHolder[]> {
  const mine = ticket ?? { at: Number.POSITIVE_INFINITY, port: Number.POSITIVE_INFINITY };
  const waiting = await Promise.all(ticketPorts(base, slots, scan).filter((port) => port !== ticket?.port).map(askTicket));
  return waiting
    .filter((run): run is SlotHolder & { queuedAt: number } => run !== null && ahead({ at: run.queuedAt, port: run.port }, mine))
    .sort((a, b) => a.queuedAt - b.queuedAt || a.port - b.port);
}

/** Whether a pid names a live process. Any error but ESRCH (a pid this run may not signal) is thrown. */
function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

const BOOT_ID = "/proc/sys/kernel/random/boot_id";
let bootId: string | null | undefined;

/** This boot's id, or null when it cannot be read: then starts are not named and the pid check stands alone. */
function readBootId(path: string): string | null {
  try { return readFileSync(path, "utf8").trim() || null; }
  catch { return null; }
}

/** A Linux process's state letter and start in clock ticks since boot (/proc/<pid>/stat, fields 3 and 22), or null when it cannot be read. */
function procStat(pid: number): { state: string; ticks: string } | null {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch { return null; }
  // the command name before the fields is in parentheses and may hold spaces or parentheses itself
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return fields[0] && fields[19] ? { state: fields[0], ticks: fields[19] } : null;
}

/**
 * When a process started, as this system names it, or null when that cannot be read (the process is
 * gone, /proc hides it, or the system has no way to say). With the pid it tells a claim's run from a
 * process that was given the same pid later, after a crash or a reboot. Linux: the boot id and the
 * start time in clock ticks since boot (/proc/<pid>/stat, field 22). macOS: ps's start time.
 */
export function processStart(pid: number, platform: NodeJS.Platform = process.platform, bootIdPath = BOOT_ID): string | null {
  if (platform === "linux") {
    const boot = bootIdPath === BOOT_ID ? (bootId ??= readBootId(BOOT_ID)) : readBootId(bootIdPath);
    const stat = procStat(pid);
    return boot && stat ? `${boot}:${stat.ticks}` : null;
  }
  if (platform === "darwin") {
    // one clock and one language whoever asks: ps writes the start in the caller's TZ and locale
    const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
    const started = ps.status === 0 ? ps.stdout.trim() : "";
    return started || null;
  }
  return null;
}

/**
 * Whether a claim's run still runs: its pid is alive and has not exited (a zombie on Linux), and, when
 * the claim recorded when it started and that can be read now, it is the same process, not a later one
 * given the same pid.
 */
function ownerAlive(owner: MarkerOwner): boolean {
  // a run that has exited and waits for its parent to reap it holds nothing, whatever its claim says
  if (process.platform === "linux" && /^[ZX]$/.test(procStat(owner.pid)?.state ?? "")) return false;
  if (typeof owner.start === "string") {
    const now = processStart(owner.pid);
    if (now !== null) return now === owner.start;
  }
  return pidAlive(owner.pid);
}

/**
 * Where a claim's marker is. A report is written by renaming over its name (check-report.ts), which
 * replaces a symlink there whatever it points to: its lock is the name in its real directory, never
 * the target. Null when the claim's directory does not exist yet (nothing can hold it).
 */
function claimTarget(path: string, report: boolean): { canonical: string; marker: string } | null {
  const absolute = resolve(path);
  if (!existsSync(dirname(absolute))) return null;
  const isDir = !report && existsSync(absolute) && statSync(absolute).isDirectory();
  const canonical = isDir ? realpathSync(absolute) : join(realpathSync(dirname(absolute)), basename(absolute));
  return { canonical, marker: isDir ? join(canonical, ".check-lock") : `${canonical}.check-lock` };
}

/** The live run a marker names, without claiming it; null when it is gone, half written or dead. */
function liveMarkerOwner(marker: string): MarkerOwner | null {
  let owner: MarkerOwner;
  try { owner = JSON.parse(readFileSync(marker, "utf8")) as MarkerOwner; } catch { return null; }
  return owner !== null && typeof owner === "object" && Number.isSafeInteger(owner.pid) && owner.pid > 0 && ownerAlive(owner) ? owner : null;
}

/**
 * The lock a run holds on Linux while it takes over a dead run's claim at `marker`: an abstract socket
 * named after the marker. The kernel lets go of it however its holder ends, as it does the slots'
 * loopback ports, so a run killed while taking over leaves nothing behind; like them it is shared by
 * the processes of one network namespace. Its holder answers a connection with `owner` (its claim)
 * once its event loop turns, which a run taking over (synchronous work) mostly does only after it has
 * let go: then the asker hears nothing and tries again. Resolves with the release, with the run that
 * holds it, or with "again" when no claim came back within the wait.
 */
export function takeoverLock(marker: string, owner: string): Promise<{ release: () => void } | { holder: MarkerOwner } | "again"> {
  const name = `\0ovis-check-takeover-${createHash("sha256").update(marker).digest("hex").slice(0, 40)}`;
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => { socket.on("error", () => undefined); socket.end(owner); });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") { reject(error); return; }
      let said = "";
      const client = connect(name);
      client.setTimeout(2_000, () => client.destroy());
      client.on("data", (chunk) => { said += chunk.toString(); });
      client.on("error", () => undefined);
      client.on("close", () => {
        let holder: MarkerOwner | null = null;
        try { holder = JSON.parse(said) as MarkerOwner; } catch { /* let go, or closed before it answered */ }
        resolve(holder !== null && typeof holder === "object" && Number.isSafeInteger(holder.pid) && holder.pid > 0 ? { holder } : "again");
      });
    });
    server.listen(name, () => {
      server.unref();
      resolve({ release: () => { server.close(); } });
    });
  });
}

/**
 * Claims `marker` for this run, or names the live run that holds it. A marker a dead run left, or one
 * an older check cut short, is taken over only by the run holding the takeover lock, which reads the
 * marker again under it: runs on other CHECK_LOCK_PORT bases are not serialized by this run's
 * admission port. That lock is takeoverLock on Linux; elsewhere (`fileTakeover`) the file
 * `<marker>.reclaim`, which a run killed while holding it leaves behind and the next run clears. A
 * marker that is gone is created again. Files are written beside and linked into place, so a reader
 * never sees one half written, and each names its run's pid, its start (processStart) and a nonce.
 */
async function claimMarker(marker: string, pid: number, checkout: string, alive: (owner: MarkerOwner) => boolean, fileTakeover: boolean): Promise<MarkerOwner | null> {
  const start = processStart(pid);
  // beside the claim under a short name of its own: one named after the claim would not fit beside a
  // long report name, under the 255-byte limit on a name
  const workingFile = (path: string, nonce: string, kind: string): string => join(dirname(path), `.check-${pid}-${nonce}.${kind}`);
  // the text written, so this run knows its own file again
  const create = (path: string): string | null => {
    const nonce = randomBytes(8).toString("hex");
    // a name of its own, made new: a draft a killed run left may still be the claim's file under
    // another name, and writing through it would rewrite that claim
    const draft = workingFile(path, nonce, "draft");
    const text = JSON.stringify({ pid, checkout, ...(start === null ? {} : { start }), nonce });
    try {
      writeFileSync(draft, text, { mode: 0o600, flag: "wx" });
      linkSync(draft, path);
      return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
      throw error;
    } finally { rmSync(draft, { force: true }); }
  };
  // who a file names: gone, a live run, or a dead run (a write cut short counts as dead). A file that
  // cannot be read may be a live holder's, so that error is not swallowed
  const state = (path: string): { gone: true } | { owner: MarkerOwner } | { dead: true; text: string } => {
    let text: string;
    try { text = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { gone: true };
      throw error;
    }
    let owner: MarkerOwner;
    try { owner = JSON.parse(text) as MarkerOwner; } catch { return { dead: true, text }; }
    if (owner === null || typeof owner !== "object" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error(`invalid check lock owner: ${path}`);
    return alive(owner) ? { owner } : { dead: true, text };
  };
  // Clears a dead run's file: moves the name aside and drops it only when it is still the file read as
  // `text`. Under takeoverLock no other run clears this name, so what moves is that file. With the
  // `.reclaim` file, two runs may clear one dead file at once: the claim one of them made since is
  // what the other moves, and it goes back; only a third run taking the empty name in that instant
  // would leave two claims.
  const retire = (path: string, text: string): void => {
    const aside = workingFile(path, randomBytes(8).toString("hex"), "retired");
    try { renameSync(path, aside); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      if (readFileSync(aside, "utf8") === text) return;
      try { linkSync(aside, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { rmSync(aside, { force: true }); }
  };
  const reclaim = `${marker}.reclaim`;
  const reclaimFile = (): { release: () => void } | { holder: MarkerOwner } | "again" => {
    const held = create(reclaim);
    if (held === null) {
      const reclaimer = state(reclaim);
      if ("owner" in reclaimer) return { holder: reclaimer.owner };
      // a run killed while it took over left it: clear it and try again
      if ("dead" in reclaimer) retire(reclaim, reclaimer.text);
      return "again";
    }
    return {
      release: () => {
        // only this run's own: removing by name could take a claim another run has made since
        let now: string | null = null;
        try { now = readFileSync(reclaim, "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (now === held) rmSync(reclaim, { force: true });
      },
    };
  };
  // other runs claiming and releasing at the same moment can make one attempt come back empty-handed
  for (let attempt = 0; attempt < 5; attempt++) {
    if (create(marker) !== null) return null;
    const found = state(marker);
    if ("owner" in found) return found.owner;
    if ("gone" in found) continue;
    const lock = fileTakeover ? reclaimFile() : await takeoverLock(marker, JSON.stringify({ pid, checkout }));
    if (lock === "again") continue;
    if ("holder" in lock) return lock.holder;
    try {
      const again = state(marker);
      if ("owner" in again) return again.owner;
      if ("gone" in again) continue;
      // dead under the lock: no other run takes it over until the lock is let go
      retire(marker, again.text);
      if (create(marker) !== null) return null;
      const winner = state(marker);
      if ("owner" in winner) return winner.owner;
    } finally {
      lock.release();
    }
  }
  throw new Error(`could not claim ${marker}`);
}

/**
 * Admission is serialized on the port after the slot range. While holding it, claim explicit
 * resources and take a candidate slot, then scan ALL slots again: an earlier holder may have
 * turned over while we asked it. Zero slots (fast needs no herdr) takes neither the admission port nor
 * a slot: it only claims its resources and checkout, whose markers are taken atomically, so a fast run
 * is never refused because another run is being admitted at that moment.
 * Taking over a dead run's marker is serialized by claimMarker's takeover lock, not by this port, since
 * runs on other CHECK_LOCK_PORT bases do not share it. A busy admission port refuses rather than waits.
 */
export async function acquire(
  { slots, checkout, base = DEFAULT_LOCK_PORT, pid = process.pid, scan = MAX_RUNS_LIMIT, resources = [], reports = [], checkoutLock, ticket, retry = false, fileTakeover = process.platform !== "linux" }: { slots: number; checkout: string; base?: number; pid?: number; scan?: number; resources?: readonly string[]; reports?: readonly string[]; checkoutLock?: string; ticket?: Ticket; retry?: boolean; fileTakeover?: boolean },
): Promise<{ release: () => void; port: number | null } | { refused: "busy" | "same-checkout" | "resource"; holders: SlotHolder[]; resource?: string }> {
  const admissionPort = base + Math.max(slots, scan);
  const claims = [...resources.map((path) => ({ path, report: false, checkout: false })), ...reports.map((path) => ({ path, report: true, checkout: false }))];
  if (checkoutLock) claims.push({ path: checkoutLock, report: true, checkout: true });
  // A waiting run (`retry`, with a ticket or without one when every ticket was held) with an older
  // run ahead of it does not take the admission port at all: holding it only to find the queue would
  // keep the head of the queue out of it, round after round. Its checkout and resources come first
  // all the same, read without claiming them: a second run in its checkout, or a held resource, is
  // told so at once, not after a turn in the queue. A run's first try claims them below.
  if (slots > 0 && (retry || ticket !== undefined)) {
    for (const { path, report, checkout: checkoutClaim } of claims) {
      const target = claimTarget(path, report);
      const owner = target && liveMarkerOwner(target.marker);
      if (!target || !owner) continue;
      if (checkoutClaim) return { refused: "same-checkout", holders: [{ port: admissionPort, heldBy: owner.pid, checkout: owner.checkout }] };
      return { refused: "resource", resource: target.canonical, holders: [{ port: admissionPort, heldBy: owner.pid, checkout: owner.checkout }] };
    }
    const queued = await queuedAhead(base, slots, scan, ticket);
    if (queued.length > 0) return { refused: "busy", holders: queued };
  }
  const admission = slots > 0 ? await lock(admissionPort, pid, checkout) : null;
  if (admission && !("release" in admission)) return { refused: "busy", holders: [{ ...admission, port: admissionPort }] };
  let taken: { release: () => void; port: number } | null = null;
  const markers: string[] = [];
  let admitted = false;
  const release = (): void => {
    taken?.release();
    for (const marker of markers.splice(0)) rmSync(marker);
  };
  try {
    for (const { path, report, checkout: checkoutClaim } of claims) {
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
      const { canonical, marker } = claimTarget(path, report)!;
      if (markers.includes(marker)) continue;
      const owner = await claimMarker(marker, pid, checkout, ownerAlive, fileTakeover);
      if (owner) {
        if (checkoutClaim) return { refused: "same-checkout", holders: [{ port: admissionPort, heldBy: owner.pid, checkout: owner.checkout }] };
        return { refused: "resource", resource: canonical, holders: [{ port: admissionPort, heldBy: owner.pid, checkout: owner.checkout }] };
      }
      markers.push(marker);
    }
    // First come, first served: a run waiting longer than this one gets the next free slot. A run
    // with no ticket comes after every run that holds one, so a newer run cannot take the slot a
    // waiting one is about to. Asked again under the admission port, like the slots below: a run
    // may have started waiting since the look above. Runs asking for different slot counts (only
    // while hosts change their CHECK_HOST_MAX_RUNS) still queue in one line: a head that does not
    // fit yet holds back a later run that would.
    if (slots > 0) {
      const queued = await queuedAhead(base, slots, scan, ticket);
      if (queued.length > 0) return { refused: "busy", holders: queued };
    }
    for (let index = 0; index < slots; index++) {
      const port = base + index;
      const result = await lock(port, pid, checkout);
      if ("release" in result) { taken = { release: result.release, port }; break; }
    }
    const holders: SlotHolder[] = [];
    for (let index = 0; slots > 0 && index < Math.max(slots, scan); index++) {
      const port = base + index;
      if (port === taken?.port) continue;
      const holder = await ask(port);
      if (holder) holders.push({ ...holder, port });
    }
    const same = holders.filter((holder) => holder.checkout === checkout);
    if (same.length > 0) return { refused: "same-checkout", holders: same };
    // a run from before slots names no checkout and counts on having the PC to itself: nothing
    // can say it is not in this checkout, so it is alone until it ends
    const alone = holders.filter((holder) => !Number.isNaN(holder.heldBy) && holder.checkout === undefined);
    if (alone.length > 0) return { refused: "busy", holders: alone };
    if (slots > 0 && (!taken || holders.length >= slots)) return { refused: "busy", holders };
    admitted = true;
    return { release, port: taken?.port ?? null };
  } finally {
    if (!admitted) release();
    admission?.release();
  }
}

/**
 * acquire, asked again every `pollMs` while the only refusal is a busy PC, until `waitMs` has
 * passed. `onWait` hears the first busy refusal, so a waiting run says once whom it waits for.
 * From that refusal on the run holds a ticket (takeTicket), its place in the queue: runs that
 * arrive later wait behind it, so a long wait cannot be lost round after round to newer runs. The
 * ticket goes when the run is admitted, refused for good or out of time. `now` and `sleep` are the
 * clock and the wait between rounds, for tests to drive.
 */
export async function acquireWaiting(
  options: Parameters<typeof acquire>[0],
  // fixed wait: the pause between rounds of a wait bounded by waitMs; other runs hold the slots, so there is no event to wait on
  { waitMs, pollMs = 2_000, onWait, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: {
    waitMs: number; pollMs?: number; onWait?: (holders: SlotHolder[]) => void; now?: () => number; sleep?: (ms: number) => Promise<unknown>;
  },
): ReturnType<typeof acquire> {
  const deadline = now() + waitMs;
  let held = await acquire(options);
  let queued: { ticket: Ticket; release: () => void } | null = null;
  let queuedAt: number | null = null;
  try {
    while ("refused" in held && held.refused === "busy" && now() < deadline) {
      if (queuedAt === null) { queuedAt = now(); onWait?.(held.holders); }
      // a place taken late (every ticket was held) ranks after every run already waiting
      // the desk is waited for within what is left of this run's own wait, never past it
      queued ??= await takeTicket({ base: options.base ?? DEFAULT_LOCK_PORT, slots: options.slots, ...(options.scan === undefined ? {} : { scan: options.scan }), at: queuedAt, ...(options.pid === undefined ? {} : { pid: options.pid }), checkout: options.checkout, deskWaitMs: Math.min(DESK_WAIT_MS, Math.max(0, deadline - now())) });
      if (now() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
      held = await acquire(queued ? { ...options, retry: true, ticket: queued.ticket } : { ...options, retry: true });
    }
    return held;
  } finally {
    queued?.release();
  }
}

/** One line per holder for a refusal. */
export function describeHolders(holders: readonly SlotHolder[]): string {
  return holders.map((holder) => Number.isNaN(holder.heldBy)
    ? `port ${holder.port}: something that is no check run`
    : `port ${holder.port}: pid ${holder.heldBy}${holder.checkout ? ` in ${holder.checkout}` : ""}${holder.queuedAt === undefined ? "" : `, waiting since ${new Date(holder.queuedAt).toISOString()}`}`).join("; ");
}

export async function main(groupSeams: GroupSeams & {
  probeSession?: (socket: string) => Promise<void>;
  scheduleDrainTimeout?: (expire: () => void, ms: number) => () => void;
} = {}): Promise<void> {
  applyHostLimits(process.env);
  let todo: ReturnType<typeof plan>;
  const args = process.argv.slice(2);
  try { todo = plan(args); } catch (error) { console.error((error as Error).message); process.exit(2); }
  const needsHerdr = needsLock(todo);
  const cwd = process.cwd();
  const runId = createRunId();
  const paths = reportPaths(cwd, process.env, runId);
  const resources: string[] = [];
  if (process.env["CHECK_DIR"]) {
    const dir = resolve(cwd, process.env["CHECK_DIR"]!);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    resources.push(dir);
  }
  const reports = process.env["CHECK_REPORT"] || process.env["CHECK_DIR"] ? [paths.reportPath] : [];
  // Teardown: herdr sessions to stop, then the isolated state to remove. What fails here (a process
  // group that would not end included) fails the run and keeps the state for diagnosis.
  const stops: (() => void | Promise<void>)[] = [];
  let isolated: Isolation | null = null;
  const teardownFailures: string[] = [];
  let retained: string | null = null;
  const groupFailed = (outcome: GroupOutcome): void => {
    const message = describeGroup(outcome);
    teardownFailures.push(message);
    console.error(`check: ${message}`);
  };
  let cleaning: Promise<void> | null = null;
  const cleanup = (): Promise<void> => cleaning ??= (async () => {
    const result = await teardown(stops, isolated, teardownFailures);
    for (const failure of result.failures) console.error(`check: teardown failed: ${failure}`);
    teardownFailures.push(...result.failures);
    if (result.retained) {
      retained = result.retained;
      console.error(`check: teardown failed; kept ${result.retained} for diagnosis`);
    }
  })();
  // Every mode claims its checkout, fast included: runs in one checkout share dist/ and the generated types.
  try {
    let slots: number;
    let wait: number;
    try {
      slots = needsHerdr ? maxRuns(process.env) : 0;
      wait = waitSeconds(process.env);
    } catch (error) { console.error(`check: ${(error as Error).message}`); process.exit(2); }
    const waitStarted = Date.now();
    let waited = false;
    let base: number;
    try { base = lockPort(process.env); } catch (error) { console.error(`check: ${(error as Error).message}`); process.exit(2); }
    const checkout = checkoutIdentity(realpathSync(cwd));
    const checkoutLock = join(realpathSync(cwd), "node_modules", ".cache", "check", "checkout.lock");
    mkdirSync(dirname(checkoutLock), { recursive: true, mode: 0o700 });
    const held = await acquireWaiting({ slots, checkout, base, resources, reports, checkoutLock }, {
      waitMs: wait * 1000,
      onWait: (holders) => {
        waited = true;
        const queued = holders.some((holder) => holder.queuedAt !== undefined);
        console.error(`check: ${queued ? `runs that came first are waiting for a slot (${describeHolders(holders)}); waiting in line` : `the ${slots}-run limit is reached (${describeHolders(holders)}); waiting`} up to ${wait}s for a slot`);
      },
    });
    if (waited && !("refused" in held)) console.error(`check: took a slot after ${Math.round((Date.now() - waitStarted) / 1000)}s`);
    if ("refused" in held) {
      const message = held.refused === "same-checkout"
        ? `another \`bun run check\` is running in this checkout, and the two would share dist/ and the generated types (${describeHolders(held.holders)}); wait for it to end or use another worktree`
        : held.refused === "resource"
          ? `check resource ${held.resource} is already held (${describeHolders(held.holders)}); use a different CHECK_DIR / CHECK_REPORT or wait for the holder`
          : held.holders.some((holder) => holder.queuedAt !== undefined)
            ? wait > 0
              ? `runs that came first were still waiting for a slot after ${wait}s (${describeHolders(held.holders)}); try again later, or wait longer with CHECK_WAIT_SECONDS`
              : `runs that came first are waiting for a slot (${describeHolders(held.holders)}); wait your turn with CHECK_WAIT_SECONDS`
            : `herdr-backed check admission is busy or the ${slots}-run limit is reached (${describeHolders(held.holders)}); wait for one to end, or set CHECK_MAX_RUNS (1 to ${MAX_RUNS_LIMIT})`;
      console.error(`check: ${message}`);
      process.exit(1);
    }
    // Keep output ownership through cleanup AND the final report write.
    process.once("exit", held.release);
  } catch (error) {
    console.error(`check: could not acquire the check lock: ${(error as Error).message}`);
    process.exit(1);
  }
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const logDirectory = paths.logDirectory;
  mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(logDirectory, 0o700);
  const sourceExcludes = [paths.reportPath, `${paths.reportPath}.check-lock`, logDirectory];
  if (process.env["CHECK_DIR"]) {
    const checkDirectory = resolve(cwd, process.env["CHECK_DIR"]!);
    const relativeCheckDirectory = relative(cwd, checkDirectory);
    if (relativeCheckDirectory && relativeCheckDirectory !== ".." && !relativeCheckDirectory.startsWith(`..${sep}`) && !isAbsolute(relativeCheckDirectory)) {
      sourceExcludes.push(checkDirectory);
    }
  }
  const bun = process.execPath;
  const specs: { name: string; command: string[] | null }[] = [];
  if (todo.fast || todo.concurrent) {
    specs.push({ name: "workflow syntax", command: null });
    specs.push({ name: "generated types are fresh", command: [bun, "run", "generate:types", "--check"] });
    specs.push({ name: "generated themes are fresh", command: [bun, "run", "generate:themes", "--check"] });
    specs.push({ name: "typecheck", command: [bun, "run", "typecheck"] });
    specs.push({ name: "build", command: [bun, "run", "build"] });
    specs.push({ name: "unit tests", command: [bun, "run", "test:unit"] });
  }
  if (todo.lanes.length > 0) {
    if (!todo.fast && !todo.concurrent) specs.push({ name: "build", command: [bun, "run", "build"] });
    specs.push({ name: "lanes", command: [bun, "scripts/ci-lanes.ts", ...todo.lanes.map((lane) => `${lane}=${LANES[lane]}`)] });
  }
  if (todo.command) {
    if (todo.build) specs.push({ name: "build", command: [bun, "run", "build"] });
    specs.push({ name: "run", command: todo.command });
  }
  const safeFileName = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";
  const reportSteps: CheckStep[] = [];
  const makeStep = (name: string, command: string[] | null): CheckStep => {
    const index = reportSteps.length + 1;
    const prefix = `${String(index).padStart(2, "0")}-${safeFileName(name)}`;
    return {
      name,
      command: command ? sanitizeCommand(command) : null,
      cwd,
      status: "not-run",
      exitCode: null,
      signal: null,
      durationMs: null,
      startedAt: null,
      endedAt: null,
      stdout: join(logDirectory, `${prefix}.stdout.log`),
      stderr: join(logDirectory, `${prefix}.stderr.log`),
      reason: null,
    };
  };
  for (const { name, command } of specs) reportSteps.push(makeStep(name, command));
  const allowedMode = todo.command
    ? ["run", ...(todo.build ? ["--build"] : [])]
    : [...args];
  const unavailableSource = (): SourceIdentity => ({
    head: null,
    branch: null,
    trackedDiffSha256: null,
    untrackedFiles: [],
    untrackedFileCount: null,
    untrackedContentSha256: null,
    untrackedFilesTruncated: null,
    fingerprint: null,
    reason: "source identity has not been captured",
  });
  let sourceStart = unavailableSource();
  const report: CheckReport = initialReport({
    runId,
    mode: allowedMode,
    startedAt,
    source: sourceStart,
    baseBranch: null,
    baseSha: null,
    env: process.env,
    steps: reportSteps,
    logPaths: reportSteps.flatMap((step) => [step.stdout, step.stderr]),
  });
  let reportPersistFailed = false;
  const saveReport = (): void => {
    try { persistReport(paths.reportPath, report, logDirectory); }
    catch (error) {
      reportPersistFailed = true;
      console.error(`check: could not persist report ${paths.reportPath}: ${(error as Error).message}`);
    }
  };
  try { persistReport(paths.reportPath, report, logDirectory); }
  catch (error) {
    console.error(`check: could not create report ${paths.reportPath}: ${(error as Error).message}`);
    await cleanup();
    process.exit(1);
  }
  console.log(`check: report ${paths.reportPath}`);
  const nodeVersion = spawnSync("node", ["--version"], { encoding: "utf8", timeout: 5_000 });
  const nodeVersionLine = nodeVersion.stdout?.trim().split(/\r?\n/, 1)[0] ?? "";
  report.toolchain.nodeVersion = nodeVersion.status === 0 && /^v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(nodeVersionLine) ? nodeVersionLine : null;
  warnNodeVersionMismatch(report.toolchain.nodeVersion, (warning) => console.warn(warning));
  try { sourceStart = sourceIdentity(cwd, sourceExcludes); }
  catch (error) {
    const reason = String((error as Error).message || error).replace(/[\r\n\t]+/g, " ").trim().slice(0, 512) || "source identity could not be captured";
    sourceStart = { ...unavailableSource(), reason };
  }
  report.source.start = sourceStart;
  report.revision = revisionDetails(cwd, process.env, sourceStart);
  if ((process.env["GITHUB_EVENT_NAME"] === "pull_request" || process.env["GITHUB_EVENT_NAME"] === "pull_request_target") && report.revision.headSha === null) {
    report.errors.push("GitHub pull request event did not provide a valid head SHA and branch");
  }
  if (sourceStart.fingerprint === null) {
    report.errors.push(`source identity unavailable at start: ${sourceStart.reason ?? "unknown reason"}`);
  }
  report.browserArtifact.identity = artifactIdentity(join(cwd, "dist"));
  report.browserArtifact.provenance = report.browserArtifact.identity ? "pre-existing-unknown" : "unavailable";
  saveReport();

  // Every step's process group, from its start until it is proved empty. A step's processes can
  // outlive it (a command that exits while something it started runs on, with or without the
  // output pipes): what is left is ended when the step ends, and again before the teardown.
  const owned = new Set<number>();
  const endingGroups = new Map<number, Promise<GroupOutcome>>();
  const endTracked = (group: number, signal: NodeJS.Signals): Promise<GroupOutcome> => {
    const pending = endingGroups.get(group);
    if (pending) return pending;
    const result = endGroup(group, signal, groupSeams).then((outcome) => {
      owned.delete(group);
      endingGroups.delete(group);
      if (outcome.result !== "gone") groupFailed(outcome);
      return outcome;
    });
    endingGroups.set(group, result);
    return result;
  };
  /** Ends what is left in an owned group; true when processes were left in it. */
  const endOwned = async (group: number): Promise<boolean> => {
    if (!owned.has(group)) return false;
    let left = false;
    // Windows has no process groups to signal
    if (process.platform !== "win32") {
      try { (groupSeams.kill ?? process.kill)(-group, 0); left = true; }
      catch (error) { left = (error as NodeJS.ErrnoException).code !== "ESRCH"; }
      if (left) {
        const outcome = await endTracked(group, "SIGTERM");
        if (outcome.result === "gone") console.error(`check: ended processes left running in step process group ${group}`);
      }
    }
    owned.delete(group);
    return left;
  };
  let activeStep: CheckStep | null = null;
  let activeStartedAtMs = 0;
  let activeStepFinished: Promise<void> | null = null;
  let ending = false;
  let interruptedBy: NodeJS.Signals | null = null;
  // `check concurrent` runs the unit tests beside the lanes step.
  let concurrentUnitFinished: Promise<number> | null = null;
  const finalize = (status: CheckReport["status"], exitCode: number): void => {
    for (const failure of teardownFailures) if (!report.errors.includes(`teardown: ${failure}`)) report.errors.push(`teardown: ${failure}`);
    if (retained && !report.evidence.retained.includes(retained)) report.evidence.retained.push(retained);
    const endedAtMs = Date.now();
    let sourceEnd = unavailableSource();
    try { sourceEnd = sourceIdentity(cwd, sourceExcludes); }
    catch (error) {
      const reason = String((error as Error).message || error).replace(/[\r\n\t]+/g, " ").trim().slice(0, 512) || "source identity could not be captured";
      sourceEnd = { ...unavailableSource(), reason };
    }
    if (sourceEnd.fingerprint === null) {
      report.errors.push(`source identity unavailable at end: ${sourceEnd.reason ?? "unknown reason"}`);
    }
    report.status = status;
    report.exitCode = exitCode;
    report.endedAt = new Date(endedAtMs).toISOString();
    report.durationMs = endedAtMs - startedAtMs;
    report.currentStep = null;
    report.source.end = sourceEnd;
    report.source.unchanged = sourceStart.fingerprint !== null
      ? sourceEnd.fingerprint === null ? false : sourceStart.fingerprint === sourceEnd.fingerprint
      : null;
    report.browserArtifact.finalIdentity = artifactIdentity(join(cwd, "dist"));
    if (report.browserArtifact.buildAttempted && report.browserArtifact.buildThisRun) {
      report.browserArtifact.unchangedAfterBuild = artifactUnchangedAfterBuild(report.browserArtifact.identity, report.browserArtifact.finalIdentity);
      report.browserArtifact.provenance = report.browserArtifact.unchangedAfterBuild === true
        ? "built-this-run"
        : report.browserArtifact.unchangedAfterBuild === false
          ? "modified-after-build"
          : "unavailable";
    } else if (!report.browserArtifact.buildAttempted) {
      report.browserArtifact.provenance = report.browserArtifact.identity && report.browserArtifact.identity === report.browserArtifact.finalIdentity
        ? "pre-existing-unknown"
        : report.browserArtifact.identity || report.browserArtifact.finalIdentity
          ? "unknown"
          : "unavailable";
    } else {
      report.browserArtifact.identity = null;
      report.browserArtifact.provenance = "unavailable";
    }
    report.verification = verificationResult(report.source.unchanged, status, report.browserArtifact.unchangedAfterBuild, report.browserArtifact.buildAttempted && report.browserArtifact.buildThisRun);
    if (report.source.unchanged === null) {
      const reason = sourceStart.fingerprint === null ? sourceStart.reason : sourceEnd.reason;
      if (reason) report.verification.reason = `source identity unavailable: ${reason}`;
    }
    if ((report.browserArtifact.identity || report.browserArtifact.finalIdentity) && !report.evidence.artifacts.includes(resolve(cwd, "dist"))) {
      report.evidence.artifacts.push(resolve(cwd, "dist"));
    }
    saveReport();
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (ending) return;
      ending = true;
      interruptedBy = signal;
      report.status = "interrupted";
      report.exitCode = signal === "SIGINT" ? 130 : 143;
      if (activeStep) {
        activeStep.status = "interrupted";
        activeStep.exitCode = null;
        activeStep.signal = signal;
        activeStep.endedAt = new Date().toISOString();
        activeStep.durationMs = Date.now() - activeStartedAtMs;
        activeStep.reason = `interrupted by ${signal}`;
      }
      saveReport();
      void (async () => {
        try {
          // The step runs in a process group of its own, and a lane starts processes of its own
          // in it: the whole group gets the signal, and has ended before the herdr and the
          // directory it uses are taken away.
          const outcomes = await Promise.all([...owned].map((group) => endTracked(group, signal)));
          const stuck = outcomes.filter((outcome) => outcome.result !== "gone");
          // A step whose group ended settles at once. One that could not be stopped may never
          // settle: its failure is recorded, and the run ends without it, keeping its state.
          if (stuck.length === 0) {
            // Even a gone group can leave output held outside it. Never wait indefinitely for
            // step/log completion after interruption; keep evidence if draining cannot finish.
            let cancelTimeout: (() => void) | undefined;
            try {
              await Promise.race([
                Promise.all([activeStepFinished, concurrentUnitFinished]),
                new Promise<never>((_, reject) => {
                  const expire = () => reject(new Error("interrupted step output did not finish draining"));
                  if (groupSeams.scheduleDrainTimeout) {
                    cancelTimeout = groupSeams.scheduleDrainTimeout(expire, OUTPUT_DRAIN_GRACE_MS + END_GRACE_MS + KILL_GRACE_MS);
                  } else {
                    const timer = setTimeout(expire, OUTPUT_DRAIN_GRACE_MS + END_GRACE_MS + KILL_GRACE_MS);
                    cancelTimeout = () => clearTimeout(timer);
                  }
                }),
              ]);
            } finally {
              cancelTimeout?.();
            }
          }
        } catch (error) {
          const failure = `could not end the interrupted steps: ${(error as Error).message}`;
          teardownFailures.push(failure);
          console.error(`check: ${failure}`);
        } finally {
          // interrupted keeps its own code; a teardown failure is in the report beside it
          await cleanup();
          finalize("interrupted", signal === "SIGINT" ? 130 : 143);
          process.exit(signal === "SIGINT" ? 130 : 143);
        }
      })();
    });
  }

  const getStep = (label: string, command: string[] | null = null): CheckStep => {
    let step = report.steps.find((candidate) => candidate.name === label && candidate.status === "not-run" && candidate.startedAt === null);
    if (!step) {
      step = makeStep(label, command);
      report.steps.push(step);
      report.evidence.logs.push(step.stdout, step.stderr);
    } else if (command) step.command = sanitizeCommand(command);
    return step;
  };
  const recordIssue = (label: string, message: string, status: "failure" | "skipped"): void => {
    const step = getStep(label);
    step.status = status;
    step.reason = message;
    step.startedAt = new Date().toISOString();
    step.endedAt = step.startedAt;
    step.durationMs = 0;
    step.exitCode = status === "failure" ? 1 : null;
    step.signal = null;
    mkdirSync(logDirectory, { recursive: true });
    writeFileSync(step.stdout, "", { mode: 0o600 });
    writeFileSync(step.stderr, status === "failure" ? `${message}\n` : "", { mode: 0o600 });
    if (status === "failure") {
      report.errors.push(message);
      console.error(`check: ${message}`);
    } else console.log(`\n=== ${label}: skipped (${message})`);
    saveReport();
  };

  /** Runs one step in a process group, streaming output both to the console and durable log files. */
  const run = (label: string, command: string[], env: Record<string, string | undefined>, commandCwd = cwd): Promise<number> => {
    const step = getStep(label, command);
    step.cwd = resolve(commandCwd);
    const startedAtMs = Date.now();
    activeStartedAtMs = startedAtMs;
    activeStep = step;
    step.startedAt = new Date(startedAtMs).toISOString();
    step.reason = null;
    report.currentStep = label;
    saveReport();
    console.log(`\n=== ${label}: ${sanitizeCommand(command).join(" ")}`);
    return new Promise((done) => {
      let settled = false;
      let resolveStepFinished!: () => void;
      const stepFinished = new Promise<void>((resolve) => { resolveStepFinished = resolve; });
      activeStepFinished = stepFinished;
      let drainTimer: NodeJS.Timeout | null = null;
      let outputIncomplete = false;
      let leftRunning = false;
      const stdout = createWriteStream(step.stdout, { flags: "w", mode: 0o600 });
      const stderr = createWriteStream(step.stderr, { flags: "w", mode: 0o600 });
      let logsFailed = false;
      stdout.on("error", (error) => { logsFailed = true; console.error(`check: stdout log failed: ${error.message}`); });
      stderr.on("error", (error) => { logsFailed = true; console.error(`check: stderr log failed: ${error.message}`); });
      const finish = (code: number | null, signal: NodeJS.Signals | null, launchError?: Error): void => {
        if (settled) return;
        settled = true;
        if (drainTimer) clearTimeout(drainTimer);
        if (launchError) {
          console.error(`check: ${command[0]}: ${launchError.message}`);
          stderr.write(`${launchError.message}\n`);
        }
        stdout.end();
        stderr.end();
        void Promise.all([finished(stdout).catch(() => undefined), finished(stderr).catch(() => undefined)]).then(() => {
          const endedAtMs = Date.now();
          step.endedAt = new Date(endedAtMs).toISOString();
          step.durationMs = endedAtMs - startedAtMs;
          step.exitCode = ending ? null : code;
          step.signal = ending ? interruptedBy ?? signal : signal;
          step.status = ending ? "interrupted" : step.exitCode === 0 && !logsFailed ? "success" : "failure";
          if (ending) step.reason = `interrupted by ${interruptedBy ?? signal ?? "signal"}`;
          else if (signal) step.reason = `process terminated by ${signal}`;
          else if (logsFailed) step.reason = "could not persist command output logs";
          else if (outputIncomplete) step.reason = "output may be incomplete: a process left running still held the output";
          else if (leftRunning) step.reason = "ended processes the command left running";
          report.currentStep = null;
          if (step.status === "failure" && signal) report.errors.push(`${label} terminated by ${signal}`);
          else if (step.status === "failure" && !logsFailed) report.errors.push(`${label} exited with code ${step.exitCode}`);
          if (logsFailed) report.errors.push(`${label} output logs could not be persisted`);
          saveReport();
          activeStep = null;
          activeStepFinished = null;
          resolveStepFinished();
          if (!ending) done(logsFailed && code === 0 ? 1 : step.exitCode ?? 1);
        });
      };
      try {
        const started = spawn(command[0]!, command.slice(1), { stdio: ["inherit", "pipe", "pipe"], env, cwd: commandCwd, detached: true });
        if (started.pid !== undefined) owned.add(started.pid);
        const stdoutStream = started.stdout;
        const stderrStream = started.stderr;
        let stdoutClosed = !stdoutStream;
        let stderrClosed = !stderrStream;
        let exited = false;
        let terminatingGroup = false;
        let exitCode: number | null = null;
        let exitSignal: NodeJS.Signals | null = null;
        // The command has exited: end what it left in its group, closed output or not, then settle.
        const endLeftovers = (): void => {
          if (terminatingGroup) return;
          terminatingGroup = true;
          void (async () => {
            try {
              if (started.pid !== undefined && await endOwned(started.pid)) leftRunning = true;
            } catch (error) {
              teardownFailures.push(`could not end ${label}'s process group: ${(error as Error).message}`);
            } finally {
              finish(exitCode, exitSignal);
            }
          })();
        };
        const maybeFinishAfterExit = (): void => {
          if (!exited || settled || terminatingGroup) return;
          if (stdoutClosed && stderrClosed) {
            endLeftovers();
            return;
          }
          if (drainTimer) return;
          drainTimer = setTimeout(() => {
            drainTimer = null;
            if (settled || terminatingGroup) return;
            outputIncomplete = true;
            stdoutStream?.destroy();
            stderrStream?.destroy();
            endLeftovers();
          }, OUTPUT_DRAIN_GRACE_MS);
        };
        stdoutStream?.on("data", (chunk: Buffer) => { process.stdout.write(chunk); stdout.write(chunk); });
        stderrStream?.on("data", (chunk: Buffer) => { process.stderr.write(chunk); stderr.write(chunk); });
        stdoutStream?.on("end", () => { stdoutClosed = true; maybeFinishAfterExit(); });
        stdoutStream?.on("close", () => { stdoutClosed = true; maybeFinishAfterExit(); });
        stderrStream?.on("end", () => { stderrClosed = true; maybeFinishAfterExit(); });
        stderrStream?.on("close", () => { stderrClosed = true; maybeFinishAfterExit(); });
        started.once("error", (error) => finish(127, null, error));
        started.once("exit", (code, signal) => {
          exited = true;
          exitCode = code;
          exitSignal = signal;
          maybeFinishAfterExit();
        });
      } catch (error) {
        finish(127, null, error as Error);
      }
    });
  };

  const skip = (label: string, reason: string): void => recordIssue(label, reason, "skipped");
  const build = async (env: Record<string, string | undefined>): Promise<number> => {
    report.browserArtifact.buildAttempted = true;
    report.browserArtifact.identity = null;
    report.browserArtifact.provenance = "unavailable";
    saveReport();
    const code = await run("build", [bun, "run", "build"], env);
    if (code === 0) {
      report.browserArtifact.buildThisRun = true;
      report.browserArtifact.identity = artifactIdentity(join(cwd, "dist"));
      report.browserArtifact.finalIdentity = report.browserArtifact.identity;
      report.browserArtifact.provenance = report.browserArtifact.identity ? "built-this-run" : "unavailable";
      saveReport();
    }
    return code;
  };

  // tests make commits in repositories of their own: an identity for a PC (or a runner) that has none
  const identity = spawnSync("git", ["config", "user.email"], { encoding: "utf8" }).stdout?.trim()
    ? {}
    : { GIT_AUTHOR_NAME: "check", GIT_AUTHOR_EMAIL: "check@example.invalid", GIT_COMMITTER_NAME: "check", GIT_COMMITTER_EMAIL: "check@example.invalid" };
  const plain = { ...process.env, ...identity };

  let code = 0;
  try {
    // A run command shares the same herdr and dist state, so it uses the same lock as named lanes.
    if (todo.fast || todo.concurrent) {
      // `concurrent` runs the same pre-steps as `fast`; only the unit tests move beside the lanes.
      const actionlintResult = await actionlint(run, plain, (reason) => skip("workflow syntax", reason), (message) => recordIssue("workflow syntax", message, "failure"));
      code = actionlintResult;
      for (const [label, command] of [
        ["generated types are fresh", [bun, "run", "generate:types", "--check"]],
        ["generated themes are fresh", [bun, "run", "generate:themes", "--check"]],
        ["typecheck", [bun, "run", "typecheck"]],
      ] as const) {
        if (code !== 0 || ending) break;
        code = await run(label, [...command], plain);
      }
      if (code === 0 && !ending) code = await build(plain);
      if (todo.fast && code === 0 && !ending) code = await run("unit tests", [bun, "run", "test:unit"], plain);
    }
    if (todo.concurrent && code === 0 && !ending) {
      const herdr = process.env["OVIS_HERDR_BIN"] || "herdr";
      if (!Bun.which(herdr)) throw new Error("concurrent mode needs herdr on PATH (or OVIS_HERDR_BIN)");
      const herdrVersion = spawnSync(herdr, ["--version"], { encoding: "utf8", env: process.env, timeout: 5_000 });
      const herdrVersionLine = herdrVersion.stdout?.trim().split(/\r?\n/, 1)[0] ?? "";
      report.toolchain.herdrVersion = herdrVersion.status === 0 && /^herdr\s+v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/i.test(herdrVersionLine)
        ? herdrVersionLine
        : null;
      saveReport();
      const isolation = isolate(process.env);
      isolated = isolation;
      const env: Record<string, string | undefined> = { ...isolation.env, ...identity };
      const shards = env["HERDR_TEST_SHARDS"]!;
      const shardCount = /^\d+$/.test(shards) ? Number(shards) : Number.NaN;
      report.toolchain.herdrTestShards = Number.isSafeInteger(shardCount) ? shardCount : null;
      saveReport();
      stops.push(() => stopSessions(isolation.sessions, (session) => spawnSync(herdr, ["--session", session, "server", "stop"], { env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 10_000 }), groupSeams.probeSession));
      console.log(`\ncheck: herdr session ${env["HERDR_TEST_SESSION"]}, config and state in ${isolation.dir}`);
      console.log("check: running unit tests, integration and browser in parallel");

      // The unit tests run beside `run`'s lanes step: their process group is tracked in
      // `concurrentUnit` so an interrupt ends it with the lanes, and the step settles on
      // 'close', once the process has exited and its output pipes have drained.
      const unitStep = getStep("unit tests", [bun, "run", "test:unit"]);
      unitStep.cwd = resolve(cwd);
      const unitStartedAtMs = Date.now();
      unitStep.startedAt = new Date(unitStartedAtMs).toISOString();
      saveReport();
      console.log(`\n=== unit tests: ${sanitizeCommand([bun, "run", "test:unit"]).join(" ")}`);
      const unitStdout = createWriteStream(unitStep.stdout, { flags: "w", mode: 0o600 });
      const unitStderr = createWriteStream(unitStep.stderr, { flags: "w", mode: 0o600 });
      let unitLogsFailed = false;
      unitStdout.on("error", (error) => { unitLogsFailed = true; console.error(`check: unit stdout log failed: ${error.message}`); });
      unitStderr.on("error", (error) => { unitLogsFailed = true; console.error(`check: unit stderr log failed: ${error.message}`); });
      const unit = spawn(bun, ["run", "test:unit"], { stdio: ["inherit", "pipe", "pipe"], env: plain, cwd, detached: true });
      if (unit.pid !== undefined) owned.add(unit.pid);
      unit.stdout?.on("data", (chunk: Buffer) => { process.stdout.write(chunk); unitStdout.write(chunk); });
      unit.stderr?.on("data", (chunk: Buffer) => { process.stderr.write(chunk); unitStderr.write(chunk); });
      concurrentUnitFinished = (async () => {
        const [exitCode, exitSignal] = await new Promise<[number | null, NodeJS.Signals | null]>((done) => {
          unit.once("error", (error) => { unitStderr.write(`${error.message}\n`); done([127, null]); });
          unit.once("close", (closeCode, closeSignal) => done([closeCode, closeSignal]));
        });
        // the unit tests' output has closed, but something they started may still run in their group
        try {
          if (unit.pid !== undefined && await endOwned(unit.pid)) unitStep.reason = "ended processes the unit tests left running";
        } catch (error) {
          teardownFailures.push(`could not end the unit tests' process group: ${(error as Error).message}`);
        }
        unitStdout.end();
        unitStderr.end();
        await Promise.all([finished(unitStdout).catch(() => undefined), finished(unitStderr).catch(() => undefined)]);
        const endedAtMs = Date.now();
        unitStep.endedAt = new Date(endedAtMs).toISOString();
        unitStep.durationMs = endedAtMs - unitStartedAtMs;
        unitStep.exitCode = ending ? null : exitCode;
        unitStep.signal = ending ? interruptedBy ?? exitSignal : exitSignal;
        unitStep.status = ending ? "interrupted" : exitCode === 0 && !unitLogsFailed ? "success" : "failure";
        if (ending) unitStep.reason = `interrupted by ${interruptedBy ?? exitSignal ?? "signal"}`;
        else if (exitSignal) unitStep.reason = `process terminated by ${exitSignal}`;
        else if (unitLogsFailed) unitStep.reason = "could not persist command output logs";
        if (unitStep.status === "failure") {
          report.errors.push(exitSignal ? `unit tests terminated by ${exitSignal}` : unitLogsFailed ? "unit tests output logs could not be persisted" : `unit tests exited with code ${exitCode}`);
        }
        saveReport();
        return unitStep.status === "success" ? 0 : exitCode || 1;
      })();

      const lanesCode = await run("lanes", [bun, "scripts/ci-lanes.ts", ...todo.lanes.map((lane) => `${lane}=${LANES[lane]}`)], env);
      const unitCode = await concurrentUnitFinished;
      code = unitCode !== 0 ? unitCode : lanesCode;
    }
    if (code === 0 && needsHerdr && !ending && !todo.concurrent) {
      const herdr = process.env["OVIS_HERDR_BIN"] || "herdr";
      if (!Bun.which(herdr)) throw new Error("this needs herdr on PATH (or OVIS_HERDR_BIN)");
      const herdrVersion = spawnSync(herdr, ["--version"], { encoding: "utf8", env: process.env, timeout: 5_000 });
      const herdrVersionLine = herdrVersion.stdout?.trim().split(/\r?\n/, 1)[0] ?? "";
      report.toolchain.herdrVersion = herdrVersion.status === 0 && /^herdr\s+v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?$/i.test(herdrVersionLine)
        ? herdrVersionLine
        : null;
      saveReport();
      const isolation = isolate(process.env);
      isolated = isolation;
      const env: Record<string, string | undefined> = { ...isolation.env, ...identity };
      const shards = env["HERDR_TEST_SHARDS"]!;
      const shardCount = /^\d+$/.test(shards) ? Number(shards) : Number.NaN;
      report.toolchain.herdrTestShards = Number.isSafeInteger(shardCount) ? shardCount : null;
      saveReport();
      // every session in the run's own config directory is the run's: the browser scripts leave theirs running
      stops.push(() => stopSessions(isolation.sessions, (session) => spawnSync(herdr, ["--session", session, "server", "stop"], { env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 10_000 }), groupSeams.probeSession));
      console.log(`\ncheck: herdr session ${env["HERDR_TEST_SESSION"]}, config and state in ${isolation.dir}`);
      if (todo.command) {
        if (todo.build) code = await build(env);
        if (code === 0 && !ending) code = await run("run", todo.command, env);
      }
      else {
        // the browser scripts serve dist/, and the fast steps have built it already
        if (!todo.fast) code = await build(env);
        if (code === 0) code = await run("lanes", [bun, "scripts/ci-lanes.ts", ...todo.lanes.map((lane) => `${lane}=${LANES[lane]}`)], env);
      }
    }
  } catch (error) {
    const message = (error as Error).message;
    console.error(`check: ${message}`);
    report.errors.push(message);
    code = 1;
  } finally {
    // an interrupt tears down by itself; otherwise a group no step ended (one whose step threw)
    // is ended before its herdr and directory go
    if (!ending) {
      for (const group of [...owned]) {
        try { await endOwned(group); }
        catch (error) { teardownFailures.push(`could not end step process group ${group}: ${(error as Error).message}`); }
      }
      await cleanup();
    }
  }
  if (ending) return;
  // the commands passed, but what they started was not cleaned up: no green result
  if (code === 0 && teardownFailures.length > 0) code = 1;
  finalize(code === 0 ? "success" : "failure", code);
  const artifactVerificationRequired = report.browserArtifact.buildAttempted && report.browserArtifact.buildThisRun;
  const finalCode = reportExitCode(code, reportPersistFailed, report.source.unchanged, report.browserArtifact.unchangedAfterBuild, artifactVerificationRequired);
  if (finalCode !== code || reportPersistFailed || report.source.unchanged === false || report.browserArtifact.unchangedAfterBuild === false) {
    code = finalCode;
    report.status = "failure";
    report.exitCode = code;
    if (report.source.unchanged === false && !report.errors.includes("source changed during the check; verification was invalidated")) {
      report.errors.push("source changed during the check; verification was invalidated");
    }
    if (report.browserArtifact.unchangedAfterBuild === false && !report.errors.includes("dist changed after the check build; browser artifact verification was invalidated")) {
      report.errors.push("dist changed after the check build; browser artifact verification was invalidated");
    }
    if (artifactVerificationRequired && report.browserArtifact.unchangedAfterBuild === null) {
      report.errors.push("built dist identity unavailable; cannot verify the built artifact");
    }
    if (reportPersistFailed) {
      if (report.source.unchanged !== false) {
        report.verification = verificationResult(report.source.unchanged, "failure", report.browserArtifact.unchangedAfterBuild, artifactVerificationRequired);
      }
      if (!report.errors.includes("report persistence failed during the check")) report.errors.push("report persistence failed during the check");
    }
    saveReport();
  }
  if (report.steps.length > 1) {
    console.log("");
    for (const step of report.steps) {
      const result = step.status === "success" ? "ok    " : step.status === "skipped" ? "SKIP  " : step.status === "not-run" ? "--    " : "FAILED";
      console.log(`${result} ${step.name}${step.durationMs === null ? "" : ` (${(step.durationMs / 1000).toFixed(1)}s)`}`);
    }
  }
  // why a failed run failed: a step's exit code or signal, which its FAILED line does not show, and
  // what no step line shows at all (a source or dist that changed mid-run, a report that could not
  // be saved, ...), which would otherwise end the run with every step ok (#1921); a run that passed
  // says nothing more
  const reasons = code === 0 ? [] : report.errors;
  for (const reason of reasons) console.error(`check: ${reason}`);
  if (reasons.length > 0) console.error(`check: report ${paths.reportPath}`);
  process.exit(code);
}

/** How long a step's processes get to end after a signal before they are killed. */
const END_GRACE_MS = 5_000;
/** How long to drain inherited output pipes after the direct child exits. */
const OUTPUT_DRAIN_GRACE_MS = 2_000;

/** How long a step's processes get to end after SIGKILL before the group counts as surviving. */
const KILL_GRACE_MS = 2_000;
/** How often an ending group is asked whether a process is left in it. */
const GROUP_POLL_MS = 50;

/**
 * What ending a step's process group found. `gone` is proved only by "no such process" (ESRCH);
 * `surviving` is a group with a process left after SIGKILL and its grace, or one that could not be
 * asked (EPERM: a process that may not be signalled is still there); `error` is a signal that could
 * not be sent.
 */
export interface GroupOutcome {
  pgid: number;
  result: "gone" | "surviving" | "error";
  /** every signal tried, in order: the step's own, then SIGKILL if the group outlasted its grace */
  signals: NodeJS.Signals[];
  cause: string | null;
}

/** The seams the tests drive endGroup through; production uses process.kill, the clock and a timer. */
export interface GroupSeams {
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

const errorText = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException).code;
  const message = error instanceof Error ? error.message : String(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
};

/** Signals a process group and waits until no process is left in it, killing what outlasts the grace. */
export async function endGroup(
  group: number,
  signal: NodeJS.Signals,
  { kill = (pid, sent) => { process.kill(pid, sent); }, now = Date.now, wait }: GroupSeams = {},
): Promise<GroupOutcome> {
  const signals: NodeJS.Signals[] = [];
  let cause: string | null = null;
  const outcome = (result: GroupOutcome["result"]): GroupOutcome => ({ pgid: group, result, signals, cause: result === "gone" ? null : cause });
  const noSuchProcess = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ESRCH";
  const send = (sent: NodeJS.Signals): "sent" | "gone" | "failed" => {
    signals.push(sent);
    try { kill(-group, sent); return "sent"; }
    catch (error) {
      if (noSuchProcess(error)) return "gone";
      cause = `${sent} could not be sent: ${errorText(error)}`;
      return "failed";
    }
  };
  const emptied = async (ms: number): Promise<boolean> => {
    for (const deadline = now() + ms; ;) {
      try { kill(-group, 0); }
      catch (error) {
        if (noSuchProcess(error)) return true;
        cause = `the group could not be probed: ${errorText(error)}`;
      }
      if (now() > deadline) return false;
      if (wait) await wait(GROUP_POLL_MS);
      else await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
    }
  };
  const first = send(signal);
  if (first !== "sent") return outcome(first === "gone" ? "gone" : "error");
  if (await emptied(END_GRACE_MS)) return outcome("gone");
  const killed = send("SIGKILL");
  if (killed !== "sent") return outcome(killed === "gone" ? "gone" : "error");
  if (await emptied(KILL_GRACE_MS)) return outcome("gone");
  cause = `still running after SIGKILL${cause ? ` (${cause})` : ""}`;
  return outcome("surviving");
}

/** One line for a group that did not end. */
export function describeGroup(outcome: GroupOutcome): string {
  return `step process group ${outcome.pgid} did not end: ${outcome.cause ?? outcome.result} (sent ${outcome.signals.join(", ")})`;
}

/**
 * Workflow syntax, with the release CI pins. It is fetched once into node_modules/.cache; a
 * platform the pin does not cover leaves the check to CI, and says so.
 */
async function actionlint(
  run: (label: string, command: string[], env: Record<string, string | undefined>, cwd?: string) => Promise<number>,
  env: Record<string, string | undefined>,
  skip: (reason: string) => void,
  fail: (message: string) => void,
): Promise<number> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    skip("actionlint is pinned for Linux x64; CI checks workflow syntax on other platforms");
    return 0;
  }
  const dir = join("node_modules", ".cache", `actionlint-${ACTIONLINT.version}`);
  const binary = join(dir, "actionlint");
  if (!existsSync(binary)) {
    const url = `https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT.version}/actionlint_${ACTIONLINT.version}_linux_amd64.tar.gz`;
    let archive: Uint8Array | null = null;
    for (let attempt = 1; attempt <= 3 && !archive; attempt++) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
        if (response.ok) archive = new Uint8Array(await response.arrayBuffer());
      } catch { /* tried again */ }
    }
    if (!archive) { fail(`could not fetch pinned actionlint ${ACTIONLINT.version}`); return 1; }
    const sha256 = createHash("sha256").update(archive).digest("hex");
    if (sha256 !== ACTIONLINT.sha256) { fail(`actionlint ${ACTIONLINT.version} archive did not match its pinned SHA-256`); return 1; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "actionlint.tgz"), archive);
    const unpacked = await run("unpack actionlint", ["tar", "xzf", "actionlint.tgz", "actionlint"], env, dir);
    rmSync(join(dir, "actionlint.tgz"), { force: true });
    if (unpacked !== 0) return 1;
  }
  return run("workflow syntax", [binary, "-shellcheck="], env);
}

// last: main() uses every constant above
if (import.meta.main) await main();
