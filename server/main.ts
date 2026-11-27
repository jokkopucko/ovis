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
  "agent-mcp": () => import("./agent-tools/mcp.ts").then((entry) => entry.runAgentMcp()),
  "approval-hook": () => import("./approvals/relay.ts").then((entry) => entry.runApprovalRelay()),
  tui: () => import("../scripts/tui-entry.ts"),
};

const USAGE = `usage: ovis-server <${Object.keys(ENTRIES).join("|")}> [arguments]`;
// these answer -h and --help themselves, each with its own usage; askpass's argument is the prompt ssh asks, never a flag
const OWN_HELP: ReadonlySet<string> = new Set<EntryName>(["askpass", "plugin", "remote", "tui"]);
const isHelp = (argument: string | undefined) => argument === "-h" || argument === "--help";

const name = process.argv[2];
if (name === undefined || !Object.hasOwn(ENTRIES, name)) {
  console.error(USAGE);
  process.exit(2);
}
const rest = process.argv.slice(3);
// an entry that does not read -h or --help would run instead: `serve --help` started a listening server. Only serve,
// which takes no value, is asked anywhere; the others only first, where no option's value can be (`--token-file --help`)
if (!OWN_HELP.has(name) && (name === "serve" ? rest.some(isHelp) : isHelp(rest[0]))) {
  console.log(USAGE);
  process.exit(0);
}
if (name === "serve") {
  const unknown = (await import("./account/local-confirm.ts")).unknownServeArgument(rest);
  if (unknown !== undefined) {
    console.error(`ovis-server serve: unknown argument ${unknown}\n${USAGE}`);
    process.exit(2);
  }
}
process.argv.splice(2, 1);
await RUN[name as EntryName]();
