import { TOOL_SCHEMAS, harnessVerb, refuse } from "../shared/harness-tool.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { mergeEnvLayers } from "../server/legacy-env.ts";
import { callAsPane, callHarness } from "../server/agent-tools/mcp.ts";
import { defaultStateDir } from "../server/update-state.ts";
import { readPluginSettings } from "./plugin-settings.ts";

/**
 * This command has no fallback to the owner's HTTP door or another run. With a launch's token (OVIS_AGENT_SOCKET and
 * OVIS_AGENT_TOKEN_FILE, even one alone) it uses that run only; with neither it asks as the hc pane it runs in, which
 * the server proves and its owner allows once (docs/harness-tool.md).
 */
export async function runAgent(words: readonly string[]): Promise<number> {
  const [word, ...rest] = words;
  const verb = word === "list" ? "ls" : word === "cancel" ? "stop" : word;
  const bad = () => { console.log(JSON.stringify(refuse("bad_request", "Invalid command. See ovis agent --help."))); return 2; };
  if (!harnessVerb(verb)) return bad();
  const args: Record<string, unknown> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) return bad();
    if (arg === "--") { positional.push(...rest.slice(i + 1)); break; }
    if (arg === "--json") continue;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    let name = arg.slice(2).replaceAll("-", "_");
    let value: unknown;
    if (verb === "read" && ["screen","state","result","transcript"].includes(name)) { value = name; name = "what"; }
    else { value = rest[++i]; if (value === undefined) return bad(); }
    if (!Object.hasOwn(TOOL_SCHEMAS[verb].properties, name) || Object.hasOwn(args, name)) return bad();
    args[name] = name === "timeout_s" ? Number(value) : value;
  }
  for (const key of ["session","task"]) if (positional.length && Object.hasOwn(TOOL_SCHEMAS[verb].properties, key) && !(key in args)) args[key] = positional.shift();
  if (positional.length) return bad();
  const socket = process.env["OVIS_AGENT_SOCKET"], tokenFile = process.env["OVIS_AGENT_TOKEN_FILE"];
  const value = socket !== undefined || tokenFile !== undefined
    ? socket && tokenFile ? await callHarness({ socket, tokenFile }, verb, args) : refuse("not_granted", "This shell has no Ovis agent run.")
    // the state folder the running Ovis uses: a settings file may set OVIS_STATE_DIR over the environment, as plugin.ts reads it
    : await callAsPane(join(defaultStateDir(mergeEnvLayers([process.env, readPluginSettings(process.env, homedir())])), "agent-tools", "hub.sock"), verb, args, process.env["HC_TERMINAL_ID"]);
  console.log(JSON.stringify(value));
  return value.kind === "refusal" ? 1 : 0;
}
