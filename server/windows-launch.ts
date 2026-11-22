/**
 * `ovis-server windows-launch <start.ts>`: what `bun <start.ts>` is from source, for the scheduled task that starts
 * herdr in the Windows desktop session (server/windows-herdr-start.ts). The compiled binary runs a script only with
 * BUN_BE_BUN set, which a task action cannot set, so the task names this entry and the launcher file instead.
 */
import { pathToFileURL } from "node:url";

const launcher = process.argv[2];
if (!launcher) {
  console.error("usage: ovis-server windows-launch <launcher file>");
  process.exit(2);
}
await import(pathToFileURL(launcher).href);
