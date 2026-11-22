import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REVISION } from "../shared/update.ts";
import { ASSETS } from "./entries.ts";

/**
 * The commit this app's own server build is, where that can be told: OVIS_REVISION where a supervisor runs a release of
 * it; else, in the desktop app (OVIS_DESKTOP_APP), whose server and client are staged from one build, the build.json vite
 * wrote into dist/ beside the server, only when that build was made from a clean tree (dirty: false). Undefined anywhere
 * else (a checkout run by hand may have rebuilt dist/ apart from the server it runs).
 */
export function buildRevision(root = ASSETS, env: Record<string, string | undefined> = process.env): string | undefined {
  // the desktop app is its own staged build: an OVIS_REVISION it inherited from where it was launched is not its own
  if (env["OVIS_DESKTOP_APP"] !== "1") {
    const named = env["OVIS_REVISION"];
    return named && REVISION.test(named) ? named : undefined;
  }
  try {
    const build = JSON.parse(readFileSync(join(root, "dist", "build.json"), "utf8")) as { revision?: unknown; dirty?: unknown };
    return typeof build.revision === "string" && REVISION.test(build.revision) && build.dirty === false ? build.revision : undefined;
  } catch { return undefined; }
}

/** what it was when this server started: a dist/ rebuilt since is not the server that runs */
const atStart = buildRevision();
export const appBuild = { revision: (): string | undefined => atStart };
