/**
 * Starting `hc connect` as a child process, the one place this side runs hc: the transport a
 * `HcConnection` (connection.ts) reads and writes. It refuses a test process that would reach the
 * user's own core, and keeps this server's own variables out of the environment of a core that
 * `hc connect` starts. connection.ts itself stays free of the server's other code.
 */

import { liveSessionsRefused } from "../herdr/test-session.ts";
import { HcError, type HcTransport } from "./connection.ts";
import { userCore } from "./core-socket.ts";

/**
 * This server's own variables (its port and address, OVIS_* settings and tokens, the plugin launch's):
 * a core that `hc connect` starts keeps its environment for every pane, where a dev server would take
 * Ovis's PORT. So is the herdr pane Ovis was started from (HERDR_ENV, its pane, tab, workspace and
 * socket): an agent in a core's pane would take that pane's reports (#3260). The rest is the user's
 * (LANG, SHELL, SSH_AUTH_SOCK, Windows' own) and stays.
 */
export const SERVER_ENV = /^(?:PORT|HOST|OVIS_.*|HERDR_WEB_.*|HERDR_PLUGIN_.*|HERDR_(?:ENV|PANE_ID|TAB_ID|WORKSPACE_ID|SOCKET_PATH|AGENT|BIN_PATH))$/i;

/** `hc connect` as a child process (in `env`, else this process's, either without SERVER_ENV); a program that cannot be started is an HcError (`closed`). */
export function spawnHcConnect(bin: string, env?: Record<string, string | undefined>): HcTransport {
  // runtime.ts hands out this path that cannot exist while a moved hc is found again
  if (bin === "/dev/null/herdr-core-moved") throw new HcError("closed", "herdr-core moved (an update?), and Ovis is looking for it again: try again in a moment");
  // a process that asked for an isolated herdr never reaches the user's default core, however it is named
  if (liveSessionsRefused(process.env) && userCore(env ?? process.env)) {
    throw new HcError("live_core_refused", "HERDR_TEST_SESSION is set, but hc would reach the user's own herdr-core: give it HC_SOCKET or an HC_SESSION of its own, or set OVIS_ALLOW_LIVE_HERDR=1");
  }
  let child: Bun.Subprocess<"pipe", "pipe", "ignore">;
  try {
    const hcEnv = Object.fromEntries(Object.entries(env ?? process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !SERVER_ENV.test(entry[0])));
    child = Bun.spawn([bin, "connect"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: hcEnv });
  } catch (error) {
    throw new HcError("closed", `hc could not be started (${bin}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    readable: child.stdout,
    write: (bytes) => {
      // a child that just exited takes no more: its end is reported through `exited`
      try {
        child.stdin.write(bytes);
        Promise.resolve(child.stdin.flush()).catch(() => {});
      } catch {
        /* the line ends on `exited` */
      }
    },
    exited: child.exited,
    kill: () => child.kill(),
  };
}
