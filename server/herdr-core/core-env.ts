/**
 * The environment a herdr-core that `ovis tui` starts runs in, after the user said yes (scripts/plugin-tui.ts). A core
 * hands the environment it started with to every pane for as long as it lives, so what names the launching terminal
 * or this program would outlive both in every later pane.
 */

import { SERVER_ENV } from "./hc-connect.ts";

/**
 * What names the launching terminal or session rather than the user: Bun's own switch to run as bare Bun, the pane of
 * another core this runs in (its terminal, that core's socket for its panes, its scope: a new core must not pass on
 * another core's pane), an SSH login's terminal and address, tmux, screen and an X window. A core started over SSH
 * would give every pane that login's agent socket and forwarded display, gone once the login ends; a local one
 * keeps the user's.
 */
const LAUNCH_BOUND = new Set(["BUN_BE_BUN", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET", "HC_SCOPE", "SSH_TTY", "SSH_CONNECTION", "SSH_CLIENT", "TMUX", "TMUX_PANE", "STY", "WINDOWID"]);

/**
 * Ovis's own SSH askpass, as server/ssh.ts hands it to the ssh it starts (`askEnv`): the token and the socket that let
 * a helper answer one connection's prompts. With them ssh is told to use that helper (SSH_ASKPASS, forced) through a
 * display that stands in for one.
 */
const ASKPASS_OWN = new Set(["HERDR_ASKPASS_TOKEN", "HERDR_ASKPASS_SOCKET"]);
const ASKPASS_DISPLAY = "herdr:0";

/**
 * `env` without Ovis's askpass: its token and socket, and where they are set, the helper ssh was told to use with them
 * and Ovis's stand-in display. A user's own SSH_ASKPASS or DISPLAY, set without them, stays.
 */
export function withoutAskpass(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const ours = [...ASKPASS_OWN].some((name) => (env[name] ?? "") !== "");
  return Object.fromEntries(Object.entries(env).filter(([name, value]) =>
    !ASKPASS_OWN.has(name) && !(ours && (name === "SSH_ASKPASS" || name === "SSH_ASKPASS_REQUIRE" || (name === "DISPLAY" && value === ASKPASS_DISPLAY)))));
}

/**
 * `base` without this program's own variables (SERVER_ENV, as the server keeps them from `hc connect`), without Ovis's
 * askpass and without what names the launching terminal. HOME, the chosen core's HC_* and XDG_* stay: they say which
 * core starts. It is also what hc is looked for and asked its version in (scripts/plugin-tui.ts).
 */
export function coreLaunchEnv(base: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const overSsh = (base["SSH_CONNECTION"] ?? "") !== "";
  return Object.fromEntries(Object.entries(withoutAskpass(base)).filter((entry): entry is [string, string] => {
    const [name, value] = entry;
    return value !== undefined && !SERVER_ENV.test(name) && !LAUNCH_BOUND.has(name)
      && !(overSsh && (name === "SSH_AUTH_SOCK" || name === "DISPLAY" || name === "XAUTHORITY"));
  }));
}
