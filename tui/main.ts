/**
 * The terminal screen's entry: `ovis tui [--session NAME] | -h | -V`. It answers its arguments before it loads anything
 * heavy, works out the core to join and refuses to run inside a pane of that same core, then wires the real host
 * terminal, the clock and the loop together and turns how the loop ended into its lines and an exit code. Every error it
 * prints carries a stable code. It starts no process: with no core listening it says so and ends.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { version } from "../package.json";
import { ending, EXIT_CRASH, EXIT_FAILED, EXIT_OK, EXIT_USAGE, insideOwnCore, parseArgs, SCREEN_SERVER, screenFolder, stateFolder, targetEnv, USAGE } from "./start.ts";

const say = (code: string, text: string) => process.stderr.write(`ovis tui: ${code}: ${text}\n`);

const args = parseArgs(process.argv.slice(2));
if (args.kind === "help") {
  process.stdout.write(`${USAGE}\n\nThe herdr-core screen. --session NAME joins that hc session (else HC_SESSION, else default).\nThe detach key of herdr leaves it; the agents keep running in herdr-core.\n`);
  process.exit(EXIT_OK);
}
if (args.kind === "version") {
  process.stdout.write(`${version}\n`);
  process.exit(EXIT_OK);
}
if (args.kind === "bad") {
  say("usage", `${args.message}\n${USAGE}`);
  process.exit(EXIT_USAGE);
}

const env = process.env;
const { coreSocket } = await import("../server/herdr-core/core-socket.ts");
const { sameSocket } = await import("../server/herdr/test-session.ts");
const target = coreSocket({ env: targetEnv(env, args.session) });
if (insideOwnCore(env, target.path, coreSocket({ env }).path, sameSocket)) {
  say("inside_own_core", `this runs inside a pane of herdr-core session ${target.session}; open the screen from a terminal outside it, or join another session with --session NAME`);
  process.exit(EXIT_FAILED);
}

const { herdrConfigPath, readHerdrConfig } = await import("../server/herdr-sidebar.ts");
const { userHome } = await import("../server/user-home.ts");
const { createUnixHost } = await import("./host/unix.ts");
const { startLoop } = await import("./loop.ts");
const { ovisServer } = await import("./core/ovis-server.ts");
const { crashRecord, recordCrash } = await import("./crash.ts");
const { ViewStore } = await import("./view-store.ts");

const home = userHome(env) || homedir();
const states = stateFolder(env, home);
/** the home as the folder the screen was started from reads it (process.cwd() is a real path); itself when it cannot be read */
const realHome = (() => {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
})();

const readKeys = (): unknown => {
  const config = readHerdrConfig(herdrConfigPath(env));
  return config !== null && typeof config === "object" ? (config as Record<string, unknown>)["keys"] : undefined;
};

const host = createUnixHost();
const loop = startLoop({
  host,
  clock: { now: () => performance.now(), arm: (at, fire) => { const timer = setTimeout(fire, Math.max(0, at - performance.now())); return () => clearTimeout(timer); } },
  socket: target.path,
  session: target.session,
  cwd: screenFolder(env, process.cwd()),
  server: ovisServer(env[SCREEN_SERVER] ?? null, undefined, env),
  home: realHome,
  keys: readKeys(),
  readKeys,
  views: new ViewStore(states),
});

/** An error nothing expected: the terminal back first, then the record, its path, and the crash's exit code. */
const crash = (error: unknown): never => {
  let where = "";
  try {
    where = recordCrash(() => host.leave(), states, crashRecord(version, loop.report(), error, new Date()), process.pid);
  } catch {
    // the folder cannot be written: the line below says so
  }
  say("crashed", where ? `the screen stopped on an unexpected error; a record is in ${where}` : "the screen stopped on an unexpected error; no record could be written");
  process.exit(EXIT_CRASH);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

const end = await loop.done;
const said = end.kind === "crashed" ? crash(end.error) : ending(end, target);
if (said.leave) {
  try {
    host.leave();
  } catch {
    // the terminal that refused a write refuses its restore too: the lines below still go to stderr
  }
}
if (said.out !== null) {
  // a terminal that refused the restore may refuse this line too: the exit code stands either way
  process.stdout.on("error", () => {});
  try {
    process.stdout.write(`${said.out}\n`);
  } catch {
    // the line could not be written: nothing else to say it with
  }
}
for (const [code, text] of said.err) say(code, text);
if (said.exit !== null) process.exit(said.exit);
