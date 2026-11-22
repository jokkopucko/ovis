/**
 * Keep this file small: it is the one piece
 * an update cannot replace while it runs; only a restart from the source checkout does.
 */
import "./adopt-legacy-env.ts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.ts";
import { entryCommand, ROOT } from "./entries.ts";
import { HANDOVER_EXIT, moveLegacyStateDir, releaseIn, updateStateDir } from "./update-state.ts";

export function releaseSupervisor(root: string, stateDir: string): string | null {
  try {
    const saved = JSON.parse(readFileSync(join(stateDir, "current.json"), "utf8")) as { directory?: unknown; source_revision?: unknown };
    const directory = typeof saved.directory === "string" ? releaseIn(stateDir, saved.directory) : null;
    if (directory === null) return null;
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true, encoding: "utf8" }).stdout.trim();
    if (saved.source_revision !== head) return null;
    const file = join(directory, "server", "supervisor.ts");
    return existsSync(file) ? file : null;
  } catch { return null; }
}

export async function runManaged(root = ROOT) {
  root = resolve(root);
  moveLegacyStateDir();
  const stateDir = updateStateDir(root, Number(process.env["PORT"] ?? DEFAULT_PORT));
  // the compiled binary has no supervisor.ts: there it runs as `ovis-server supervisor`
  const own = entryCommand("supervisor")[1];
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => { stopping = true; child?.kill(signal); };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  let previous: string | null = null;
  let fallback = false;
  for (;;) {
    const file: string = fallback ? previous ?? own : releaseSupervisor(root, stateDir) ?? own;
    let ready = false;
    child = Bun.spawn([process.execPath, file], {
      cwd: root, windowsHide: true, stdin: "ignore", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, OVIS_SOURCE_ROOT: root, OVIS_LAUNCHER: "1", ...(fallback ? { OVIS_SUPERVISOR_FALLBACK: "1" } : {}) },
      ipc(message) { if (message?.type === "supervisor-ready") ready = true; },
    });
    const code = await child.exited;
    if (stopping) process.exit(0);
    if (code === HANDOVER_EXIT) { previous = file; fallback = false; continue; }
    const rescue = previous ?? own;
    if (!ready && !fallback && rescue !== file) {
      console.error(`Supervisor ${file} exited (${code}) before it was ready; falling back to ${rescue}.`);
      fallback = true;
      continue;
    }
    process.exit(code ?? 1);
  }
}

if (import.meta.main) await runManaged();
