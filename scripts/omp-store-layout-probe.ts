/**
 * Where the installed omp keeps its sessions and terminal breadcrumbs under each routing option,
 * and whether the bridge's resolver (server/omp.ts ompStoreLayout) finds that pane's transcript
 * there. Starts omp in a temporary HOME and fictional project for each case, waits for its terminal
 * breadcrumb, reads the process's argv and routing environment through the bridge's own helper,
 * records the breadcrumb and the session path it names, then writes a synthetic header at that path
 * and asks the resolver for it. No prompt is sent, and provider and update traffic goes to a closed
 * local port.
 *
 *   bun scripts/omp-store-layout-probe.ts [--fixture server/fixtures/omp-<version>-store-layouts.json]
 *
 * Prints one JSON line per case; --fixture also writes the observed roots, with every temporary
 * path as $CASE, for server/omp.test.ts. Exits 1 when a case cannot be observed or lacks proof: no
 * argv and environment read from the process, a secret in the helper's answer, a supported layout
 * whose roots differ from omp's or that does not find omp's own session, or an unsupported one
 * that resolves.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { heldTranscript } from "../server/gjc-runtime.ts";
import { ompStoreLayout } from "../server/omp.ts";
import { createOmpProcessProbe } from "../server/omp-process.ts";

const STARTUP_MS = 30_000;
/** The bridge's 1 s helper bound is for a live pane; a loaded host may need longer to answer here. */
const ompProcessMemory = createOmpProcessProbe({ timeoutMs: 15_000 });
/** Directories omp resolves against one nothing records (it changes into its --cwd): the resolver must give nothing. */
const UNSUPPORTED = new Set(["relative PI_CODING_AGENT_DIR", "relative session-dir", "relative cwd and relative session-dir"]);
const omp = Bun.which("omp");
const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-store-layout-")));
const closed = "http://127.0.0.1:9";

interface Case { name: string; args: string[]; env?: Record<string, string>; mkdirs?: string[] }
interface FixtureCase {
  name: string; args: string[]; env: Record<string, string>; mkdirs: string[];
  observed: { sessions: string | null; depth: 1 | 2 | null; terminalSessions: string | null; cwd: string | null };
}
interface Observed {
  name: string; outcome: string; pid: number; argv: string[] | null; routingEnv: string[] | null;
  breadcrumb: string | null; sessionPath: string | null;
  layout: { sessions: string; terminalSessions: string; depth: 1 | 2 } | null; held: string | null;
  fixture: FixtureCase;
  proof: string | null;
}

function breadcrumbs(dir: string, depth = 0, found: string[] = []): string[] {
  if (depth > 9) return found;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== "natives") breadcrumbs(path, depth + 1, found);
    else if (entry.isFile() && dir.endsWith("/terminal-sessions")) found.push(path);
  }
  return found;
}

async function observe(spec: Case, index: number): Promise<Observed> {
  const caseRoot = join(root, `case-${index}`);
  const home = join(caseRoot, "home");
  const project = join(home, "project");
  mkdirSync(join(project, "sub"), { recursive: true });
  const fill = (value: string) => value.replaceAll("$CASE", caseRoot);
  for (const dir of spec.mkdirs ?? []) mkdirSync(fill(dir), { recursive: true });
  const env: Record<string, string> = {
    HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin", TERM: "xterm-256color", LANG: "C.UTF-8",
    HTTP_PROXY: closed, HTTPS_PROXY: closed, http_proxy: closed, https_proxy: closed, NO_PROXY: "", OLLAMA_BASE_URL: closed, PI_NO_TITLE: "1",
    SECRET_TOKEN: "SECRET_TOKEN_synthetic_value",
  };
  for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = fill(value);
  let output = "";
  let settled!: () => void;
  const ready = new Promise<void>((resolve) => { settled = resolve; });
  const child = Bun.spawn([omp!, ...spec.args.map(fill)], {
    cwd: project, env,
    terminal: { cols: 120, rows: 40, data(_terminal, data) { output += new TextDecoder().decode(data); if (breadcrumbs(caseRoot).length > 0) settled(); } },
  });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      ready.then(() => "breadcrumb written"),
      child.exited.then((code) => `exited ${code}: ${Bun.stripANSI(output).replace(/\s+/g, " ").slice(-300)}`),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("no breadcrumb before the startup deadline"), STARTUP_MS); }),
    ]);
    clearTimeout(timer);
    // the helper refuses a process in disk sleep, where omp sits while it pages its binary in
    let memory = await ompProcessMemory(child.pid, true);
    for (const deadline = Date.now() + 15_000; memory === null && child.exitCode === null && Date.now() < deadline;) {
      await Bun.sleep(100);
      memory = await ompProcessMemory(child.pid, true);
    }
    const found = breadcrumbs(caseRoot);
    let breadcrumbCwd: string | null = null, sessionPath: string | null = null;
    if (found.length === 1) [breadcrumbCwd = null, sessionPath = null] = readFileSync(found[0]!, "utf8").split("\n");
    const absolute = sessionPath?.startsWith("/") ?? false;
    if (absolute && breadcrumbCwd) {
      // the header omp writes with its first answer, so the resolver has a transcript to find
      mkdirSync(dirname(sessionPath!), { recursive: true });
      if (!existsSync(sessionPath!) || statSync(sessionPath!).size === 0) writeFileSync(sessionPath!, `${JSON.stringify({ type: "session", version: 3, id: "probe", cwd: breadcrumbCwd })}\n`);
    }
    const layout = memory === null ? null : ompStoreLayout(memory.argv, memory.environ, "linux");
    const held = layout !== null && breadcrumbCwd !== null ? heldTranscript(layout, breadcrumbCwd, [child.pid], () => memory!.environ).path : null;
    const placeholder = (path: string | null) => path === null ? null : path.replaceAll(caseRoot, "$CASE");
    // a managed store keeps each directory's sessions in a folder named after it, which omp always
    // starts with "-" (`-tmp-<path>`, `-<path under home>`, `--<absolute path>--`)
    const managed = absolute && basename(dirname(sessionPath!)).startsWith("-");
    const observed: FixtureCase["observed"] = {
      sessions: absolute ? placeholder(managed ? dirname(dirname(sessionPath!)) : dirname(sessionPath!)) : null,
      depth: absolute ? managed ? 2 : 1 : null,
      terminalSessions: found.length === 1 ? placeholder(dirname(found[0]!)) : null,
      cwd: placeholder(breadcrumbCwd),
    };
    let proof: string | null = null;
    if (memory === null) proof = "no argv or environment read from the process";
    else if (JSON.stringify(memory).includes("SECRET_TOKEN")) proof = "a secret reached the helper's answer";
    else if (UNSUPPORTED.has(spec.name)) { if (layout !== null) proof = "an unsupported layout resolved"; }
    else if (layout === null) proof = "the resolver found no layout";
    else if (placeholder(layout.sessions) !== observed.sessions || placeholder(layout.terminalSessions) !== observed.terminalSessions || layout.depth !== observed.depth) proof = "the resolver's roots are not omp's";
    else if (held !== sessionPath) proof = "the resolver did not find omp's own session";
    return {
      name: spec.name, outcome, pid: child.pid, argv: memory?.argv.map((word) => placeholder(word)!) ?? null, routingEnv: memory?.environ.map((word) => placeholder(word)!) ?? null,
      breadcrumb: placeholder(found[0] ?? null), sessionPath: placeholder(sessionPath),
      layout: layout && { sessions: placeholder(layout.sessions)!, terminalSessions: placeholder(layout.terminalSessions)!, depth: layout.depth }, held: placeholder(held),
      fixture: { name: spec.name, args: spec.args, env: spec.env ?? {}, mkdirs: spec.mkdirs ?? [], observed }, proof,
    };
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}

const XDG = { XDG_DATA_HOME: "$CASE/xdg-data", XDG_STATE_HOME: "$CASE/xdg-state" };
const XDG_OMP = ["$CASE/xdg-data/omp", "$CASE/xdg-state/omp"];
const CASES: Case[] = [
  { name: "default", args: [] },
  { name: "profile flag", args: ["--profile", "work"] },
  { name: "profile flag named default", args: ["--profile", "default"] },
  { name: "profile flag with spaces", args: ["--profile", " work "] },
  { name: "OMP_PROFILE", args: [], env: { OMP_PROFILE: "work" } },
  { name: "OMP_PROFILE named default", args: [], env: { OMP_PROFILE: "default" } },
  { name: "PI_PROFILE", args: [], env: { PI_PROFILE: "work" } },
  { name: "profile flag over OMP_PROFILE", args: ["--profile", "work"], env: { OMP_PROFILE: "other" } },
  { name: "empty OMP_PROFILE with PI_PROFILE", args: [], env: { OMP_PROFILE: "", PI_PROFILE: "work" } },
  { name: "PI_PROFILE and OMP_PROFILE", args: [], env: { PI_PROFILE: "pi", OMP_PROFILE: "omp" } },
  { name: "PI_CONFIG_DIR", args: [], env: { PI_CONFIG_DIR: ".omp-alt" } },
  { name: "PI_CONFIG_DIR with profile flag", args: ["--profile", "work"], env: { PI_CONFIG_DIR: ".omp-alt" } },
  { name: "PI_CODING_AGENT_DIR", args: [], env: { PI_CODING_AGENT_DIR: "$CASE/custom-agent" } },
  { name: "PI_CODING_AGENT_DIR with profile flag", args: ["--profile", "work"], env: { PI_CODING_AGENT_DIR: "$CASE/custom-agent" } },
  { name: "PI_CODING_AGENT_DIR with OMP_PROFILE", args: [], env: { PI_CODING_AGENT_DIR: "$CASE/custom-agent", OMP_PROFILE: "work" } },
  { name: "PI_CODING_AGENT_DIR with PI_PROFILE", args: [], env: { PI_CODING_AGENT_DIR: "$CASE/custom-agent", PI_PROFILE: "work" } },
  { name: "PI_CODING_AGENT_DIR handed down by PI_PROFILE, OMP_PROFILE empty", args: [], env: { OMP_PROFILE: "", PI_PROFILE: "work", PI_CODING_AGENT_DIR: "$CASE/home/.omp/profiles/work/agent" } },
  { name: "PI_CODING_AGENT_DIR handed down by OMP_PROFILE, profile flag named default", args: ["--profile", "default"], env: { OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "$CASE/home/.omp/profiles/work/agent" } },
  { name: "session-dir flag", args: ["--session-dir", "$CASE/custom-sessions"] },
  { name: "session-dir flag, equals form", args: ["--session-dir=$CASE/custom-sessions"] },
  { name: "session-dir flag naming the managed store", args: ["--session-dir", "$CASE/home/.omp/agent/sessions"] },
  { name: "PI_CODING_AGENT_SESSION_DIR", args: [], env: { PI_CODING_AGENT_SESSION_DIR: "$CASE/env-sessions" } },
  { name: "PI_CODING_AGENT_SESSION_DIR with profile flag", args: ["--profile", "work"], env: { PI_CODING_AGENT_SESSION_DIR: "$CASE/env-sessions" } },
  { name: "PI_CODING_AGENT_SESSION_DIR with PI_CODING_AGENT_DIR", args: [], env: { PI_CODING_AGENT_SESSION_DIR: "$CASE/env-sessions", PI_CODING_AGENT_DIR: "$CASE/custom-agent" } },
  { name: "PI_CODING_AGENT_SESSION_DIR with XDG omp roots existing", args: [], env: { PI_CODING_AGENT_SESSION_DIR: "$CASE/env-sessions", ...XDG }, mkdirs: XDG_OMP },
  { name: "session-dir flag over PI_CODING_AGENT_SESSION_DIR", args: ["--session-dir", "$CASE/custom-sessions"], env: { PI_CODING_AGENT_SESSION_DIR: "$CASE/env-sessions" } },
  { name: "session-dir flag with profile flag", args: ["--profile", "work", "--session-dir", "$CASE/custom-sessions"] },
  { name: "PI_CODING_AGENT_DIR with session-dir flag", args: ["--session-dir", "$CASE/custom-sessions"], env: { PI_CODING_AGENT_DIR: "$CASE/custom-agent" } },
  { name: "empty PI_CODING_AGENT_SESSION_DIR", args: [], env: { PI_CODING_AGENT_SESSION_DIR: "" } },
  { name: "empty PI_CODING_AGENT_DIR", args: [], env: { PI_CODING_AGENT_DIR: "" } },
  { name: "XDG roots absent", args: [], env: XDG },
  { name: "XDG roots existing", args: [], env: XDG, mkdirs: ["$CASE/xdg-data", "$CASE/xdg-state"] },
  { name: "XDG omp roots existing", args: [], env: XDG, mkdirs: XDG_OMP },
  { name: "XDG data omp root only", args: [], env: XDG, mkdirs: ["$CASE/xdg-data/omp"] },
  { name: "XDG state omp root only", args: [], env: XDG, mkdirs: ["$CASE/xdg-state/omp"] },
  { name: "XDG omp roots existing with profile flag", args: ["--profile", "work"], env: XDG, mkdirs: XDG_OMP },
  { name: "XDG omp profile roots existing with profile flag", args: ["--profile", "work"], env: XDG, mkdirs: ["$CASE/xdg-data/omp/profiles/work", "$CASE/xdg-state/omp/profiles/work"] },
  { name: "XDG omp roots existing with OMP_PROFILE", args: [], env: { ...XDG, OMP_PROFILE: "work" }, mkdirs: XDG_OMP },
  { name: "XDG omp roots existing with PI_CODING_AGENT_DIR", args: [], env: { ...XDG, PI_CODING_AGENT_DIR: "$CASE/custom-agent" }, mkdirs: XDG_OMP },
  { name: "XDG omp roots existing with PI_CODING_AGENT_DIR naming the default agent", args: [], env: { ...XDG, PI_CODING_AGENT_DIR: "$CASE/home/.omp/agent" }, mkdirs: XDG_OMP },
  { name: "XDG omp roots existing with PI_CODING_AGENT_DIR naming the default agent with a trailing slash", args: [], env: { ...XDG, PI_CODING_AGENT_DIR: "$CASE/home/.omp/agent/" }, mkdirs: XDG_OMP },
  { name: "XDG omp roots existing with session-dir flag", args: ["--session-dir", "$CASE/custom-sessions"], env: XDG, mkdirs: XDG_OMP },
  { name: "XDG unset, default XDG omp roots existing", args: [], mkdirs: ["$CASE/home/.local/share/omp", "$CASE/home/.local/state/omp"] },
  { name: "empty XDG roots, default XDG omp roots existing", args: [], env: { XDG_DATA_HOME: "", XDG_STATE_HOME: "" }, mkdirs: ["$CASE/home/.local/share/omp", "$CASE/home/.local/state/omp"] },
  { name: "relative PI_CODING_AGENT_DIR", args: [], env: { PI_CODING_AGENT_DIR: "rel-agent" } },
  { name: "relative cwd and relative session-dir", args: ["--cwd", "sub", "--session-dir", "rel-sessions"] },
  { name: "relative session-dir", args: ["--session-dir", "rel-sessions"] },
];

let exit = 0;
const results: Observed[] = [];
try {
  if (!omp) {
    console.log(JSON.stringify({ omp: null, note: "omp is not installed: nothing observed" }));
    exit = 1;
  } else {
    const version = Bun.spawnSync([omp, "--version"], { env: { HOME: root, PATH: process.env["PATH"] ?? "" }, stdout: "pipe", stderr: "pipe" });
    console.log(JSON.stringify({ omp, version: version.stdout.toString().trim(), exit: version.exitCode, root: "$ROOT" }));
    for (const [index, spec] of CASES.entries()) {
      const result = await observe(spec, index);
      results.push(result);
      console.log(JSON.stringify(result));
      if (result.outcome !== "breadcrumb written") exit = 1;
      if (result.proof !== null) { console.error(`PROOF_MISSING ${result.name}: ${result.proof}`); exit = 1; }
    }
    const unsupported = results.filter((result) => UNSUPPORTED.has(result.name));
    console.log(JSON.stringify({
      cases: results.length, resolved: results.filter((result) => !UNSUPPORTED.has(result.name) && result.proof === null).length,
      unsupportedUnavailable: unsupported.filter((result) => result.proof === null).length, missingProof: results.filter((result) => result.proof !== null).length,
    }));
    const fixture = process.argv[process.argv.indexOf("--fixture") + 1];
    if (process.argv.includes("--fixture") && fixture && exit === 0) {
      const provenance = { omp: version.stdout.toString().trim(), platform: process.platform, command: "bun scripts/omp-store-layout-probe.ts --fixture", home: "$CASE/home", start: "$CASE/home/project", unsupported: [...UNSUPPORTED] };
      writeFileSync(fixture, `${JSON.stringify({ provenance, cases: results.map((result) => result.fixture) }, null, 2)}\n`);
      console.log(`fixture: ${fixture}`);
    }
  }
} finally {
  for (const result of results) {
    let gone = false;
    try { process.kill(result.pid, 0); } catch { gone = true; }
    console.log(`cleanup: pid ${result.pid} ${gone ? "gone (kill -0 fails)" : "STILL RUNNING"}`);
    if (!gone) exit = 1;
  }
  rmSync(root, { recursive: true, force: true });
  console.log(`cleanup: ${root} ${existsSync(root) ? "STILL PRESENT" : "removed"}`);
}
process.exit(exit);
