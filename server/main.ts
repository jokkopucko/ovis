import { ENTRIES, type EntryName, ROOT } from "./entries.ts";

const RUN: Record<EntryName, () => Promise<unknown>> = {
  serve: () => import("./index.ts").then((entry) => entry.serve()),
  managed: () => import("./managed.ts").then((entry) => entry.runManaged()),
  supervisor: () => import("./supervisor.ts").then((entry) => entry.runSupervisor(process.env["OVIS_SOURCE_ROOT"] || ROOT)),
  remote: () => import("./remote-entry.ts"),
  machine: () => import("./herdr-core/machine-entry.ts"),
  plugin: () => import("../scripts/plugin.ts").then((entry) => entry.runPlugin()),
  askpass: () => import("./ssh-askpass.ts"),
  "windows-launch": () => import("./windows-launch.ts"),
  "browser-mcp": () => import("./browser-mcp.ts").then((entry) => entry.runBrowserMcp()),
};

const name = process.argv[2];
if (name === undefined || !Object.hasOwn(ENTRIES, name)) {
  console.error(`usage: ovis-server <${Object.keys(ENTRIES).join("|")}> [arguments]`);
  process.exit(2);
}
process.argv.splice(2, 1);
await RUN[name as EntryName]();
