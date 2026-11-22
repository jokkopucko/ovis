import { homedir } from "node:os";

/**
 * The user's home, where agents keep their stores and skills. On Windows that is USERPROFILE (else
 * HOME, else the OS's answer): the agent CLIs ask the OS for it (Node's os.homedir(), Python's
 * Path.home(), Rust's home_dir), which reads USERPROFILE even when a user sets HOME for Git or
 * Emacs. Elsewhere it is HOME, and USERPROFILE means nothing, so a missing HOME stays missing there.
 * Read, never written back to the environment: Git and the other tools the server starts pick their
 * own home on Windows (HOMEDRIVE/HOMEPATH first).
 */
export function userHome(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  return environmentHome(env, platform) || (platform === "win32" ? homedir() : "");
}

export function environmentHome(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  return (platform === "win32" ? env["USERPROFILE"] || env["HOME"] : env["HOME"]) || "";
}
