/**
 * A herdr-core of a test's own: its session, state, config and runtime folders under `root`, and the
 * environment hc runs in holds nothing of this process's (no inherited HC_*, HOME or XDG_*), so no
 * hc call of the test can reach the user's own core.
 */
export function isolatedHcEnv(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    HOME: `${root}/home`,
    // short names: hc's socket path under a long TMPDIR must stay within the OS's limit (107 bytes)
    HC_SESSION: `t${process.pid}`,
    XDG_STATE_HOME: `${root}/state`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_RUNTIME_DIR: `${root}/run`,
    HC_SOCKET: `${root}/run/hc.sock`,
    ...extra,
  };
}

/** Stops the core `env` names, only when it names one of its own (an HC_SOCKET); run in that environment alone. */
export async function stopIsolatedCore(bin: string, env: Record<string, string>): Promise<void> {
  if (!env["HC_SOCKET"] || !env["HC_SESSION"]) return;
  await Bun.spawn([bin, "server", "stop"], { env, stdout: "ignore", stderr: "ignore" }).exited;
}
