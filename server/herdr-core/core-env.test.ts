import { describe, expect, it } from "bun:test";
import { coreLaunchEnv } from "./core-env.ts";

describe("coreLaunchEnv", () => {
  const user = { HOME: "/home/me", PATH: "/usr/bin", LANG: "ko_KR.UTF-8", SHELL: "/bin/zsh", HC_SOCKET: "/run/me/hc.sock", HC_SESSION: "work", XDG_RUNTIME_DIR: "/run/user/1000", XDG_CONFIG_HOME: "/home/me/.config", XDG_STATE_HOME: "/home/me/.local/state" };

  it.each([
    ["the Ovis server's token and address", { OVIS_TOKEN: "secret", OVIS_URL: "http://127.0.0.1:7317" }],
    ["the server's port, host and plugin launch", { PORT: "7317", HOST: "127.0.0.1", HERDR_PLUGIN_ID: "devswha.ovis", HERDR_PLUGIN_STATE_DIR: "/s" }],
    ["the herdr pane Ovis runs in", { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1", HERDR_SOCKET_PATH: "/h.sock", HERDR_AGENT: "claude", HERDR_BIN_PATH: "/usr/bin/herdr" }],
    ["Bun's switch to run as bare Bun", { BUN_BE_BUN: "1" }],
    ["the pane of another core: its terminal, that core's socket for its panes and its scope", { HC_TERMINAL_ID: "t-1", HC_TERMINAL_SOCKET: "/run/other/hc.sock", HC_SCOPE: "w1" }],
    ["an SSH login, its agent socket with it", { SSH_TTY: "/dev/pts/3", SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22", SSH_CLIENT: "10.0.0.2 5000 22", SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1" }],
    ["an SSH login's forwarded X11 display", { SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22", DISPLAY: "localhost:10.0", XAUTHORITY: "/home/me/.Xauthority" }],
    ["tmux, screen and the X window", { TMUX: "/tmp/tmux-1000/default,1,0", TMUX_PANE: "%1", STY: "1.pts-1.host", WINDOWID: "4194311" }],
    ["Ovis's SSH askpass: its token and socket, the helper ssh was told to use with them and its stand-in display", { HERDR_ASKPASS_TOKEN: "t0ken", HERDR_ASKPASS_SOCKET: "/run/ovis/ask", SSH_ASKPASS: "/ovis/askpass", SSH_ASKPASS_REQUIRE: "force", DISPLAY: "herdr:0" }],
    ["Ovis's askpass socket alone, with the helper that goes with it", { HERDR_ASKPASS_SOCKET: "/run/ovis/ask", SSH_ASKPASS: "/ovis/askpass", SSH_ASKPASS_REQUIRE: "force" }],
  ])("drops %s and keeps HOME, the chosen core's HC_* and XDG_*", (_, dropped) => {
    expect(coreLaunchEnv({ ...user, ...dropped })).toEqual(user);
  });

  it("keeps the agent socket of a local login", () => {
    expect(coreLaunchEnv({ ...user, SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh" })).toEqual({ ...user, SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh" });
  });

  it("keeps the local login's display and X authority", () => {
    const local = { ...user, DISPLAY: ":0", XAUTHORITY: "/home/me/.Xauthority" };
    expect(coreLaunchEnv(local)).toEqual(local);
  });
  it("keeps the user's own askpass helper and display, set without Ovis's token or socket, and a real display beside them", () => {
    const own = { SSH_ASKPASS: "/usr/libexec/openssh/gnome-ssh-askpass", SSH_ASKPASS_REQUIRE: "prefer", DISPLAY: ":0" };
    expect(coreLaunchEnv({ ...user, ...own })).toEqual({ ...user, ...own });
    expect(coreLaunchEnv({ ...user, DISPLAY: ":0", HERDR_ASKPASS_TOKEN: "t0ken" })).toEqual({ ...user, DISPLAY: ":0" });
  });

  it("leaves out names that are unset and changes nothing it is given", () => {
    const base = { ...user, HC_SOCKET: undefined, OVIS_TOKEN: "secret" };
    const copy = { ...base };
    expect(coreLaunchEnv(base)).not.toHaveProperty("HC_SOCKET");
    expect(base).toEqual(copy);
  });
});
