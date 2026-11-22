import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

import { forgetTranscriptState, paneConversation } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import { darwinProcess } from "./claude-store.ts";
import * as darwinKernel from "./darwin-process.ts";
import * as served from "./runtime/capabilities.ts";
import { HERDR, HERDR_CORE } from "./runtime/capabilities.ts";
import { terminalBreadcrumb } from "./gjc-runtime.ts";
import { isOmpHelper, isOmpProcess, ompAgentDir, ompHeldOpen, ompHeldTranscript, ompLaunch, ompLaunchDir, ompLoadsIntegration, ompPaneRoute, ompRouteTranscript, ompStoreLayout, readOmpHeldFilesSetting } from "./omp.ts";
import layouts from "./fixtures/omp-18.8.7-store-layouts.json";
import * as ompProbe from "./omp-process.ts";
import * as omo from "./omo.ts";

it("recognizes native and interpreter-launched omp, not look-alikes", () => {
  expect(isOmpProcess(["omp", "--profile", "personal", "--resume"])).toBe(true);
  expect(isOmpProcess(["/home/u/.local/bin/omp"])).toBe(true);
  expect(isOmpProcess(["bun", "/opt/omp/dist/omp.js"])).toBe(true);
  expect(isOmpProcess(["C:\\Users\\u\\bin\\omp.exe"])).toBe(true);
  expect(isOmpProcess(["omo"])).toBe(false);
  expect(isOmpProcess(["omp-helper"])).toBe(false);
  expect(isOmpProcess(["node", "/tmp/omp/server.js"])).toBe(false);
  expect(isOmpProcess([])).toBe(false);
});

it("keeps a process's sessions where its profile puts them, and nowhere it cannot tell", () => {
  const home = "/home/u";
  expect(ompAgentDir(["omp", "--continue"], null, home)).toBe("/home/u/.omp/agent");
  expect(ompAgentDir(["omp", "--profile", "personal", "--resume"], null, home)).toBe("/home/u/.omp/profiles/personal/agent");
  expect(ompAgentDir(["omp", "--profile=work"], null, home)).toBe("/home/u/.omp/profiles/work/agent");
  expect(ompAgentDir(["omp"], ["PATH=/bin", "OMP_PROFILE=personal"], home)).toBe("/home/u/.omp/profiles/personal/agent");
  expect(ompAgentDir(["omp", "--profile", "work"], ["OMP_PROFILE=personal"], home)).toBe("/home/u/.omp/profiles/work/agent");
  expect(ompAgentDir(["omp"], ["OMP_PROFILE="], home)).toBe("/home/u/.omp/agent");
  // a store moved anywhere, or a name that leaves the profiles folder, is not trusted
  expect(ompAgentDir(["omp", "--session-dir", "/tmp/s"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--session-dir=/tmp/s"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile", ".."], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile", "a/../../x"], null, home)).toBeNull();
  expect(ompAgentDir(["omp", "--profile"], null, home)).toBeNull();
  // omp ignores a cwd option without its value, so it says nothing about the store
  expect(ompAgentDir(["omp", "--cwd"], null, home)).toBe("/home/u/.omp/agent");
  expect(ompAgentDir(["omp", "--cwd", "--profile", "work"], null, home)).toBe("/home/u/.omp/agent");
});

it("sees herdr's omp integration wherever omp loads extensions from, and only there", () => {
  const home = mkdtempSync(join(tmpdir(), "ovis-omp-integration-"));
  try {
    const install = (...dir: string[]) => {
      mkdirSync(join(home, ...dir), { recursive: true });
      writeFileSync(join(home, ...dir, "herdr-omp-agent-state.ts"), "// installed by herdr\n");
    };
    const project = join(home, "project");
    const loads = (argv: string[], environ: string[] | null = null, cwd: string | null = project) => ompLoadsIntegration(argv, environ, home, cwd);
    expect(loads(["omp"])).toBe(false);
    // a file named on the command line loads even when discovery is off
    expect(loads(["omp", "-e", "/opt/herdr/herdr-omp-agent-state.ts"])).toBe(true);
    expect(loads(["omp", "--no-extensions", "--extension=/opt/herdr/herdr-omp-agent-state.ts"])).toBe(true);
    expect(loads(["omp", "--hook", "herdr-omp-agent-state.ts"])).toBe(true);
    expect(loads(["omp", "-e", "/opt/other.ts"])).toBe(false);
    install("project", ".omp", "extensions");
    expect(loads(["omp"])).toBe(true);
    expect(loads(["omp", "--no-extensions"])).toBe(false);
    expect(loads(["omp"], null, null)).toBe(false);
    install(".omp", "extensions");
    expect(loads(["omp"], null, home)).toBe(false);
    install("custom", "extensions");
    expect(loads(["omp"], [`PI_CODING_AGENT_DIR=${join(home, "custom")}`], home)).toBe(true);
    expect(loads(["omp", "--profile", "work"], [`PI_CODING_AGENT_DIR=${join(home, "custom")}`], home)).toBe(false);
    install(".omp", "profiles", "work", "agent", "extensions");
    expect(loads(["omp"], ["PI_PROFILE=work"], home)).toBe(true);
    expect(loads(["omp"], ["OMP_PROFILE=", "PI_PROFILE=work"], home)).toBe(false);
    install(".omp-custom", "agent", "extensions");
    expect(loads(["omp"], ["PI_CONFIG_DIR=.omp-custom"], home)).toBe(true);
    install(".omp", "agent", "extensions");
    expect(loads(["omp"], null, home)).toBe(true);
    expect(loads(["omp", "--session-dir", "/tmp/s"], null, home)).toBe(true);
    expect(loads(["omp", "--no-extensions"], null, home)).toBe(false);
    // a trusted extension is the only one omp loads
    expect(loads(["omp", "--trusted-extension", "/opt/other.ts"], null, home)).toBe(false);
    expect(loads(["omp", "--trusted-extension=/opt/herdr-omp-agent-state.ts"], null, home)).toBe(true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("reads the extension files and --no-extensions from omp's argv", () => {
  const read = (argv: string[]) => { const launch = ompLaunch(argv); return launch && { extensions: launch.extensions, noExtensions: launch.noExtensions }; };
  expect(read(["omp"])).toEqual({ extensions: [], noExtensions: false });
  expect(read(["omp", "-e", "a.ts", "--extension=b.ts", "--hook", "c.ts", "--no-extensions"])).toEqual({ extensions: ["a.ts", "b.ts", "c.ts"], noExtensions: true });
  expect(read(["omp", "--trusted-extension", "d.ts"])).toEqual({ extensions: ["d.ts"], noExtensions: true });
  expect(read(["omp", "--model", "--no-extensions", "--", "-e", "x.ts"])).toEqual({ extensions: [], noExtensions: false });
});

it("reads omp's cwd and store options from its argv the way omp does", () => {
  const cases: [string[], { profile: string | null; sessionDir: boolean; cwd: string | null; sessionDirValue?: string } | null][] = [
    [["omp"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd", "/a", "--cwd=/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    [["omp", "--cwd=/b", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--cwd", "/a", "--profile=work", "--cwd", "rel/dir", "--profile", "home"], { profile: "home", sessionDir: false, cwd: "rel/dir" }],
    [["omp", "--cwd", "/a", "--", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--", "--cwd=/b", "--session-dir", "/s", "--profile", "work"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd", "/p/with space/$(rm -rf x);*|`y`"], { profile: null, sessionDir: false, cwd: "/p/with space/$(rm -rf x);*|`y`" }],
    [["omp", "--cwd=/a=b c"], { profile: null, sessionDir: false, cwd: "/a=b c" }],
    [["omp", "--cwd", "--profile", "work"], { profile: null, sessionDir: false, cwd: "--profile" }],
    [["omp", "--model", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--system-prompt", "--cwd=/a", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    [["omp", "--cwd", "--", "--cwd", "/b"], { profile: null, sessionDir: false, cwd: "/b" }],
    [["omp", "--plan", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--plan", "--profile", "work", "--cwd", "/a"], { profile: "work", sessionDir: false, cwd: null }],
    [["omp", "--plan", "--", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--resume", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "-r", "abc", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "fix --cwd /x", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["bun", "/opt/omp/dist/omp.js", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--session-dir=/s", "--cwd", "/a"], { profile: null, sessionDir: true, cwd: "/a", sessionDirValue: "/s" }],
    [["omp", "--cwd"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd", "/a", "--cwd"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--cwd="], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd", ""], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd", "/a", "--cwd="], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--cwd=", "--cwd", "/a"], { profile: null, sessionDir: false, cwd: "/a" }],
    [["omp", "--cwd", "", "/b"], { profile: null, sessionDir: false, cwd: null }],
    [["omp", "--profile="], null],
    [["omp", "--profile"], null],
    [["omp", "--profile", "--cwd", "/a"], null],
  ];
  const stores = (launch: ReturnType<typeof ompLaunch>) => launch && {
    profile: launch.profile, sessionDir: launch.sessionDir, cwd: launch.cwd,
    ...launch.sessionDirValue === undefined ? {} : { sessionDirValue: launch.sessionDirValue },
  };
  for (const [argv, expected] of cases) expect([argv, stores(ompLaunch(argv))]).toEqual([argv, expected]);
});

it("names a launch directory only for an absolute cwd, never resolved against the server's own", () => {
  expect(ompLaunchDir(["omp", "--cwd", "/a/b/../c/"])).toBe("/a/c");
  expect(ompLaunchDir(["omp", "--cwd=/a", "--cwd", "rel"])).toBeNull();
  expect(ompLaunchDir(["omp", "--cwd", "../a"])).toBeNull();
  expect(ompLaunchDir(["omp", "--cwd", ""])).toBeNull();
  expect(ompLaunchDir(["omp"])).toBeNull();
});

it("tells omp's own package installs from an omp session", () => {
  expect(isOmpHelper(["/home/u/.bun/bin/omp", "add", "--cwd", "/home/u/.omp/cache/eval-js/environments/e1", "--ignore-scripts", "lodash"])).toBe(true);
  expect(isOmpHelper(["/home/u/.bun/bin/omp", "install", "--cwd", "/home/u/.omp/runtimes/tts", "--production"])).toBe(true);
  expect(isOmpHelper(["/home/u/.bun/bin/omp", "__omp_worker_tts"])).toBe(true);
  expect(isOmpHelper(["bun", "/opt/omp/dist/omp.js", "__omp_worker_stt"])).toBe(true);
  expect(isOmpHelper(["omp", "add", "tests"])).toBe(false);
  expect(isOmpHelper(["omp", "--cwd", "/a", "add"])).toBe(false);
  expect(isOmpHelper(["bun", "add", "--cwd", "/a"])).toBe(false);
  expect(isOmpHelper(["omp", "--cwd", "/a", "__omp_worker_tts"])).toBe(false);
  expect(isOmpHelper(["bun", "__omp_worker_tts"])).toBe(false);
});

it("reads omp's breadcrumb, whose transcript starts with a title record before the header", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "omp-breadcrumb-")));
  try {
    const agent = join(home, ".omp/profiles/personal/agent");
    const store = join(agent, "sessions/-project"), markers = join(agent, "terminal-sessions");
    mkdirSync(join(store, "2026-10-04_session"), { recursive: true }); mkdirSync(markers);
    const session = join(store, "2026-10-04_session.jsonl"), advisor = join(store, "2026-10-04_session", "__advisor.scribe.jsonl");
    const records = [{ type: "title", v: 1, title: "Fix the metrics", pad: " ".repeat(120) }, { type: "session", version: 3, cwd: home }];
    writeFileSync(session, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    writeFileSync(advisor, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
    // omp's breadcrumb carries more lines than the cwd and the path
    writeFileSync(join(markers, "pts-7"), `${home}\n${session}\nfresh\ncwdstat 1 2\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBe(session);
    writeFileSync(join(markers, "pts-7"), `${home}\n${advisor}\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBe(session);
    writeFileSync(session, JSON.stringify(records[0]) + "\n");
    writeFileSync(join(markers, "pts-7"), `${home}\n${session}\n`);
    expect(terminalBreadcrumb(agent, home, "pts-7", 0)).toBeNull();
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("keeps each process's store where native omp put it", () => {
  expect(layouts.provenance.omp).toBe("omp/18.8.7");
  const unsupported = new Set(layouts.provenance.unsupported);
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-layouts-")));
  try {
    for (const [index, entry] of layouts.cases.entries()) {
      const at = join(root, String(index));
      const fill = (value: string) => value.replaceAll("$CASE", at);
      for (const dir of entry.mkdirs) mkdirSync(fill(dir), { recursive: true });
      const env: Record<string, string> = { HOME: join(at, "home"), ...entry.env as Record<string, string> };
      const environ = Object.entries(env).map(([key, value]) => `${key}=${fill(value)}`);
      const layout = ompStoreLayout(["omp", ...entry.args.map(fill)], environ, "linux");
      const { sessions, terminalSessions, depth } = entry.observed;
      const expected = unsupported.has(entry.name) ? null : { sessions: fill(sessions!), terminalSessions: fill(terminalSessions!), depth };
      expect<unknown[]>([entry.name, layout]).toEqual([entry.name, expected]);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("reads a process's store from its own argv and environment, and nothing it cannot prove", () => {
  const home = "/home/u";
  const managed = (agent: string) => ({ sessions: join(agent, "sessions"), terminalSessions: join(agent, "terminal-sessions"), depth: 2 as const });
  const own = (agent: string, sessions: string) => ({ ...managed(agent), sessions, depth: 1 as const });
  const env = (...words: string[]) => [`HOME=${home}`, ...words];
  expect(ompStoreLayout(["omp"], env(), "linux")).toEqual(managed("/home/u/.omp/agent"));
  expect(ompStoreLayout(["omp"], env("PI_CONFIG_DIR=.alt"), "linux")).toEqual(managed("/home/u/.alt/agent"));
  for (const environ of [[], ["HOME="]]) expect(ompStoreLayout(["omp"], environ, "linux")).toEqual(managed(join(userInfo().homedir, ".omp/agent")));
  expect(ompStoreLayout(["omp"], ["HOME=rel"], "linux")).toBeNull();
  expect(ompStoreLayout(["omp"], env("HOME=/other"), "linux")).toBeNull();
  expect(ompStoreLayout(["omp", "--profile", "default"], env("OMP_PROFILE=work"), "linux")).toEqual(managed("/home/u/.omp/agent"));
  expect(ompStoreLayout(["omp", "--profile", " work "], env(), "linux")).toEqual(managed("/home/u/.omp/profiles/work/agent"));
  expect(ompStoreLayout(["omp", "--profile", "work"], env("OMP_PROFILE=Bad!"), "linux")).toEqual(managed("/home/u/.omp/profiles/work/agent"));
  expect(ompStoreLayout(["omp"], env("OMP_PROFILE=", "PI_PROFILE=work"), "linux")).toEqual(managed("/home/u/.omp/agent"));
  for (const name of ["Bad!", "..", "con", "a."]) expect(ompStoreLayout(["omp"], env(`OMP_PROFILE=${name}`), "linux")).toBeNull();
  // a profile ignores PI_CODING_AGENT_DIR, and so does omp when the environment's profile handed it down
  expect(ompStoreLayout(["omp"], env("PI_CODING_AGENT_DIR=/a/../agent/"), "linux")).toEqual(managed("/agent"));
  expect(ompStoreLayout(["omp", "--profile", "work"], env("PI_CODING_AGENT_DIR=/agent"), "linux")).toEqual(managed("/home/u/.omp/profiles/work/agent"));
  expect(ompStoreLayout(["omp"], env("OMP_PROFILE=", "PI_PROFILE=work", "PI_CODING_AGENT_DIR=/home/u/.omp/profiles/work/agent"), "linux")).toEqual(managed("/home/u/.omp/agent"));
  expect(ompStoreLayout(["omp"], env("PI_CODING_AGENT_DIR=rel"), "linux")).toBeNull();
  expect(ompStoreLayout(["omp", "--session-dir=/a", "--session-dir", "/b/"], env("PI_CODING_AGENT_SESSION_DIR=/c"), "linux")).toEqual(own("/home/u/.omp/agent", "/b"));
  expect(ompStoreLayout(["omp"], env("PI_CODING_AGENT_SESSION_DIR=/c", "PI_CODING_AGENT_DIR=/agent"), "linux")).toEqual(own("/agent", "/c"));
  expect(ompStoreLayout(["omp", "--", "--session-dir", "/s"], env("PI_CODING_AGENT_SESSION_DIR="), "linux")).toEqual(managed("/home/u/.omp/agent"));
  for (const argv of [["omp", "--session-dir="], ["omp", "--session-dir"], ["omp", "--session-dir", "rel"]]) expect(ompStoreLayout(argv, env(), "linux")).toBeNull();
  expect(ompStoreLayout(["omp", "--profile"], env(), "linux")).toBeNull();
  // an environment that could not be read proves nothing, not even the default store
  for (const platform of ["linux", "darwin", "win32"] as const) expect(ompStoreLayout(["omp", "--profile", "work"], null, platform)).toBeNull();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-xdg-")));
  try {
    mkdirSync(join(root, "data", "omp"), { recursive: true });
    const xdg = env(`XDG_DATA_HOME=${join(root, "data")}`, `XDG_STATE_HOME=${join(root, "state")}`);
    expect(ompStoreLayout(["omp"], xdg, "linux")).toEqual({ ...managed("/home/u/.omp/agent"), sessions: join(root, "data/omp/sessions") });
    // omp reads XDG roots on macOS too from 18.12, and only an omp that reads them migrates into them (#3746)
    expect(ompStoreLayout(["omp"], xdg, "darwin")).toEqual({ ...managed("/home/u/.omp/agent"), sessions: join(root, "data/omp/sessions") });
    expect(ompStoreLayout(["omp"], xdg, "win32")).toBeNull();
    expect(ompStoreLayout(["omp"], env(), "darwin")).toEqual(managed("/home/u/.omp/agent"));
    expect(ompStoreLayout(["omp"], env("XDG_DATA_HOME=rel"), "linux")).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe("an omp pane's chat", () => {
  let home = "";
  let savedHome: string | undefined;
  let agentSession: unknown;
  let processes: { pid: number; name?: string; argv?: string[] }[] = [];
  let pane: HerdrPane;
  let readProcess: typeof ompProbe.ompProcessMemory;
  const restores: Array<() => void> = [];
  const transcript = (cwd: string) => [
    JSON.stringify({ type: "title", v: 1, title: "t" }),
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd }),
    JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "synthetic question" }] } }),
    JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "synthetic answer" }] } }),
  ].join("\n") + "\n";

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omp-pane-")));
    savedHome = process.env["HOME"];
    process.env["HOME"] = home;
    const cwd = join(home, "project");
    mkdirSync(cwd);
    pane = { pane_id: "pane-omp", cwd, foreground_cwd: cwd, agent: "omp" } as HerdrPane;
    const snapshot = spyOn(herdr, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane] } as SessionSnapshot));
    const rpc = spyOn(herdr, "herdrRpc").mockImplementation(async (method: string) => {
      if (method === "agent.get") return { agent: { agent_session: agentSession } } as never;
      if (method === "pane.process_info") return { process_info: { foreground_processes: processes } } as never;
      throw new Error(`unexpected RPC: ${method}`);
    });
    readProcess = ompProbe.createOmpProcessProbe({ timeoutMs: 30_000 });
    const memory = spyOn(ompProbe, "ompProcessMemory").mockImplementation(readProcess);
    restores.push(() => snapshot.mockRestore(), () => rpc.mockRestore(), () => memory.mockRestore());
  });
  afterEach(() => {
    for (const restore of restores.splice(0)) restore();
    if (savedHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = savedHome;
    rmSync(home, { recursive: true, force: true });
    agentSession = undefined;
    processes = [];
    forgetTranscriptState();
  });

  const storeTranscript = (cwd: string, name = "2026-10-01_s1.jsonl") => {
    const store = join(home, ".omp/agent/sessions", cwd.replaceAll("/", "-"));
    mkdirSync(store, { recursive: true });
    const path = join(store, name);
    writeFileSync(path, transcript(cwd));
    return path;
  };
  const standIn = async (options: string[], held: string[], { cwd, moveTo, env }: { cwd?: string; moveTo?: string; env?: Record<string, string> } = {}) => {
    const script = join(home, "bin", "omp.js");
    mkdirSync(join(home, "bin"), { recursive: true });
    const move = moveTo === undefined ? "" : `process.chdir(${JSON.stringify(moveTo)}); `;
    writeFileSync(script, `${move}for (const file of ${JSON.stringify(held)}) require("node:fs").openSync(file, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const argv = [process.execPath, script, ...options];
    const child = Bun.spawn(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    reaped.push(async () => { child.kill(); await child.exited; });
    const first = await Promise.race([
      child.stdout.getReader().read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
    ]);
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    return { pid: child.pid, argv };
  };
  const reaped: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const reap of reaped.splice(0)) await reap(); });
  const liveDir = (pid: number) => readlinkSync(`/proc/${pid}/cwd`);
  const chat = async () => {
    forgetTranscriptState();
    const answer = await paneConversation(pane.pane_id);
    expect(answer.source).toBe("omp-transcript");
    return answer.turns.map((turn) => turn.parts[0]);
  };
  const synthetic = [{ kind: "text" as const, text: "synthetic question" }, { kind: "text" as const, text: "synthetic answer" }];
  const otherAgent = { agent: "claude", kind: "id", value: "a-claude-session" };

  it.skipIf(process.platform !== "linux")("a relative --cwd finds the session in the directory omp moved into", async () => {
    const a = join(home, "A"), rel = join(a, "rel");
    mkdirSync(rel, { recursive: true });
    const path = storeTranscript(rel);
    const omp = await standIn(["--cwd", "rel"], [path], { cwd: a, moveTo: rel });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    pane.cwd = a;
    pane.foreground_cwd = liveDir(omp.pid);
    expect(pane.foreground_cwd).toBe(rel);
    for (const session of [undefined, otherAgent]) {
      agentSession = session;
      expect(await chat()).toEqual(synthetic);
    }
    pane.foreground_cwd = null;
    agentSession = undefined;
    forgetTranscriptState();
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  });

  it.skipIf(process.platform !== "linux")("an absolute --cwd follows omp into a resumed session's project", async () => {
    const x = join(home, "X"), y = join(home, "Y");
    mkdirSync(x); mkdirSync(y);
    storeTranscript(x, "2026-10-01_first.jsonl");
    const path = storeTranscript(y);
    const omp = await standIn(["--cwd", x], [path], { moveTo: y });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    pane.foreground_cwd = liveDir(omp.pid);
    expect(pane.foreground_cwd).toBe(y);
    expect(await chat()).toEqual(synthetic);
    for (const reap of reaped.splice(0)) await reap();
    const crumb = await standIn(["--cwd", x], [], { moveTo: y, env: { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4244" } });
    mkdirSync(join(home, ".omp/agent/terminal-sessions"));
    writeFileSync(join(home, ".omp/agent/terminal-sessions/tmux-%4244"), `${y}\n${path}\n`);
    processes = [{ pid: crumb.pid, name: "omp", argv: crumb.argv }];
    expect(await chat()).toEqual(synthetic);
  });

  it.skipIf(process.platform !== "linux")("an absolute --cwd finds the session when herdr's directory is not omp's own", async () => {
    const target = join(home, "B");
    mkdirSync(target);
    const path = storeTranscript(target);
    storeTranscript(pane.cwd!, "2026-10-02_decoy.jsonl");
    for (const options of [
      ["--cwd", "/elsewhere", `--cwd=${target}`],
      ["--cwd=/elsewhere", "--cwd", `${target}/`, "--", "--cwd", pane.cwd!],
    ]) {
      const omp = await standIn(options, [path], { moveTo: target });
      processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
      for (const foreground of [pane.cwd, null]) {
        pane.foreground_cwd = foreground;
        for (const session of [undefined, otherAgent]) {
          agentSession = session;
          expect(await chat()).toEqual(synthetic);
        }
      }
      for (const reap of reaped.splice(0)) await reap();
    }
    const omp = await standIn(["--cwd", "/elsewhere", `--cwd=${target}`], [], { moveTo: target, env: { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4243" } });
    mkdirSync(join(home, ".omp/agent/terminal-sessions"));
    writeFileSync(join(home, ".omp/agent/terminal-sessions/tmux-%4243"), `${target}\n${path}\n`);
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    pane.foreground_cwd = pane.cwd;
    agentSession = undefined;
    expect(await chat()).toEqual(synthetic);
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBe(path);
  });

  it.skipIf(process.platform !== "linux")("an empty or trailing --cwd leaves omp where it started", async () => {
    const path = storeTranscript(pane.cwd!);
    for (const options of [["--cwd"], ["--cwd="], ["--cwd", ""], ["--cwd", "/elsewhere", "--cwd="], ["--cwd", "", "/elsewhere"]]) {
      const omp = await standIn(options, [path], { cwd: pane.cwd! });
      // herdr's argv, and none (WSL), where the empty operand is read back from procfs
      for (const argv of [omp.argv, undefined]) {
        processes = [{ pid: omp.pid, name: "omp", argv }];
        expect(await chat()).toEqual(synthetic);
      }
      for (const reap of reaped.splice(0)) await reap();
    }
    const b = join(home, "B");
    mkdirSync(b);
    const omp = await standIn(["--cwd", "", b], [storeTranscript(b)], { cwd: pane.cwd! });
    processes = [{ pid: omp.pid, name: "omp" }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("omp processes that started in different directories show no chat", async () => {
    const b = join(home, "B"), c = join(home, "C");
    mkdirSync(b); mkdirSync(c);
    const first = await standIn(["--cwd", b], [storeTranscript(b)]);
    const second = await standIn([`--cwd=${c}`], [storeTranscript(c)]);
    const plain = await standIn([], []);
    for (const pair of [[first, second], [first, plain]]) {
      processes = pair.map((omp) => ({ pid: omp.pid, name: "omp", argv: omp.argv }));
      forgetTranscriptState();
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
    }
    const one = await standIn([], [storeTranscript(pane.cwd!)]);
    const other = await standIn([], [storeTranscript(pane.cwd!, "2026-10-02_s2.jsonl")]);
    processes = [one, other].map((omp) => ({ pid: omp.pid, name: "omp", argv: omp.argv }));
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("omp's own package installs leave the chat as it was", async () => {
    const binary = join(home, "bin", "omp");
    const env = join(home, ".omp/cache/eval-js/environments/e1"), runtime = join(home, ".omp/runtimes/tts");
    mkdirSync(env, { recursive: true }); mkdirSync(runtime, { recursive: true });
    const install = await standIn([], [], { cwd: env });
    const helpers = [
      { pid: install.pid, name: "omp", argv: [binary, "add", "--cwd", env, "--ignore-scripts", "lodash"] },
      { pid: install.pid, name: "omp", argv: [binary, "install", "--cwd", runtime, "--production"] },
      { pid: install.pid, name: "omp", argv: [binary, "__omp_worker_tts"] },
    ];
    const plain = await standIn([], [storeTranscript(pane.cwd!)]);
    for (const helper of helpers) {
      processes = [{ pid: plain.pid, name: "omp", argv: plain.argv }, helper];
      expect(await chat()).toEqual(synthetic);
    }
    const target = join(home, "B");
    mkdirSync(target);
    const launched = await standIn(["--cwd", target], [storeTranscript(target)], { moveTo: target });
    for (const helper of helpers) {
      processes = [helper, { pid: launched.pid, name: "omp", argv: launched.argv }];
      expect(await chat()).toEqual(synthetic);
    }
  });

  it.skipIf(process.platform !== "linux")("on WSL a helper whose argv only procfs has leaves the chat as it was", async () => {
    const binary = join(home, "bin", "omp");
    const env = join(home, ".omp/cache/eval-js/environments/e1");
    mkdirSync(env, { recursive: true });
    const install = await standIn([], [], { cwd: env });
    const target = join(home, "B");
    mkdirSync(target);
    const launched = await standIn(["--cwd", target], [storeTranscript(target)], { moveTo: target });
    let helperArgv: string[] = [];
    const wsl = spyOn(ompProbe, "isWsl").mockReturnValue(true);
    const probe = spyOn(ompProbe, "ompProcessMemory").mockImplementation(async (pid: number) =>
      ({ argv: pid === install.pid ? helperArgv : launched.argv, environ: [`HOME=${home}`] }));
    restores.push(() => wsl.mockRestore(), () => probe.mockRestore());
    for (const argv of [[binary, "add", "--cwd", env, "--ignore-scripts", "lodash"], [binary, "__omp_worker_tts"]]) {
      helperArgv = argv;
      // herdr leaves out the argv of a process it takes for an agent, so the helper is read back
      processes = [{ pid: install.pid, name: "omp" }, { pid: launched.pid, name: "omp", argv: launched.argv }];
      probe.mockClear();
      expect(await chat()).toEqual(synthetic);
      expect(probe).toHaveBeenCalledWith(install.pid, true);
    }
  });

  it.skipIf(process.platform !== "linux")("two sessions in herdr's directory show no chat, even with one under the --cwd", async () => {
    const target = join(home, "B");
    mkdirSync(target);
    const held = [storeTranscript(pane.cwd!), storeTranscript(pane.cwd!, "2026-10-02_s2.jsonl"), storeTranscript(target)];
    const omp = await standIn(["--cwd", target], held, { moveTo: target });
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    forgetTranscriptState();
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  });

  it("reads the transcript herdr names in an `omp --profile` store", async () => {
    const store = join(home, ".omp/profiles/personal/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, [
      transcript(pane.cwd!),
      JSON.stringify({ type: "model_change", modelId: "claude-opus-5-5" }),
      JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high" }),
    ].join("\n") + "\n");
    agentSession = { agent: "omp", kind: "path", value: path };
    const answer = await paneConversation(pane.pane_id);
    expect(answer.source).toBe("omp-transcript");
    expect(answer.metadata).toEqual({ model: "claude-opus-5-5", reasoning_effort: "high" });
    expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
      { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
    ]);
  });

  it("refuses a transcript in an omp profile store that links outside it", async () => {
    const store = join(home, ".omp/profiles/personal/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const outside = join(home, "elsewhere.jsonl");
    writeFileSync(outside, transcript(pane.cwd!));
    const path = join(store, "2026-10-01_s1.jsonl");
    symlinkSync(outside, path);
    agentSession = { agent: "omp", kind: "path", value: path };
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  });

  it.skipIf(process.platform !== "linux")("reads the transcript the pane's omp process holds open when herdr names none", async () => {
    const store = join(home, ".omp/agent/sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const script = join(bin, "omp.js");
    writeFileSync(script, `require("node:fs").openSync(${JSON.stringify(path)}, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    try {
      const reader = child.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
      ]);
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      processes = [{ pid: child.pid, argv: [process.execPath, script] }];
      for (const session of [undefined, { agent: "claude", kind: "id", value: "a-claude-session" }]) {
        agentSession = session;
        forgetTranscriptState();
        const answer = await paneConversation(pane.pane_id);
        expect(answer.source).toBe("omp-transcript");
        expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
          { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
        ]);
      }
    } finally { child.kill(); await child.exited; }
  });

  // #3365: omp leaves a breadcrumb whose content is unchanged alone, so `omp -c` keeps the earlier run's.
  // On macOS herdr-core only the files an omp holds open (lsof) prove its session
  describe("on macOS herdr-core", () => {
    const pid = 99_999_999;
    const startedAt = Date.now() - 60_000;
    let listing: string | null = "";
    let lsofCalls: string[][] = [];
    let kills: unknown[] = [];
    let lsof: () => unknown;
    let startOf: (asked: number, read: number) => bigint | null;
    let clock = 0;
    let core = true;
    let heldFiles = true;
    let ompHome = "";
    let onEnviron = () => {};
    /** lsof's `-FpDin` listing of `files` for the omp: each file's device and inode as lsof prints them, when the name stats. */
    const listed = (files: string[]) => `p${pid}\nfcwd\nn${pane.cwd}\n${files.map((file, at) => `f${23 + at}\n${fileFields(file)}n${file}\n`).join("")}`;
    const fileFields = (file: string) => { try { const stat = fs.statSync(file); return `D0x${stat.dev.toString(16)}\ni${stat.ino}\n`; } catch { return ""; } };
    const breadcrumb = (session: string, at: number) => {
      const marker = join(home, ".omp/agent/terminal-sessions/ttys000");
      mkdirSync(join(home, ".omp/agent/terminal-sessions"), { recursive: true });
      writeFileSync(marker, `${pane.cwd}\n${session}\n`);
      fs.utimesSync(marker, at / 1000, at / 1000);
    };
    const held = () => { clock += 10_000; return ompHeldTranscript(pane.pane_id, pane.cwd!, true); };
    beforeEach(() => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "darwin" });
      listing = ""; lsofCalls = []; kills = []; core = true; ompHome = home; onEnviron = () => {};
      lsof = () => ({ stdout: new Response(listing ?? "").body, exited: Promise.resolve(listing === null ? 1 : 0), kill: (signal: unknown) => kills.push(signal) });
      startOf = (asked) => asked === pid ? 1_000_000n : null;
      clock += 1_000_000;
      const reads = new Map<number, number>();
      const now = spyOn(performance, "now").mockImplementation(() => clock);
      const terminal = spyOn(darwinKernel, "darwinTerminal").mockImplementation((asked) => asked === pid ? { tty: "ttys000", startedAt } : null);
      const start = spyOn(darwinKernel, "darwinStartTime").mockImplementation((asked) => {
        reads.set(asked, (reads.get(asked) ?? 0) + 1);
        return startOf(asked, reads.get(asked)!);
      });
      const environment = spyOn(darwinProcess, "environment").mockImplementation(() => { onEnviron(); return `HOME=${ompHome}\0`; });
      const serving = spyOn(served, "capabilities").mockImplementation(() => core ? HERDR_CORE : HERDR);
      const spawned = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => { lsofCalls.push(argv); return lsof(); }) as unknown as typeof Bun.spawn);
      processes = [{ pid, name: "omp", argv: ["omp", "-c"] }];
      heldFiles = true;
      readOmpHeldFilesSetting(() => heldFiles);
      restores.push(() => {
        readOmpHeldFilesSetting(() => false);
        now.mockRestore(); spawned.mockRestore(); serving.mockRestore(); environment.mockRestore(); start.mockRestore(); terminal.mockRestore();
        Object.defineProperty(process, "platform", platform);
      });
    });

    it("proves an omp -c by the session it holds open, never by the breadcrumb's session being written", async () => {
      const continued = storeTranscript(pane.cwd!), own = storeTranscript(pane.cwd!, "2026-10-02_own.jsonl");
      breadcrumb(continued, startedAt - 3_600_000);
      // `omp -c` holds the session it continues open from its first write
      listing = listed([continued]);
      expect(await held()).toBe(continued);
      listing = listed([]);
      expect(await held()).toBeNull();
      listing = listed([own]);
      expect(await held()).toBe(own);
      listing = null;
      expect(await held()).toBeNull();
      expect(lsofCalls).toEqual(Array(4).fill(["/usr/sbin/lsof", "-nPbw", "-a", "-p", String(pid), "-FpDin"]));
    });

    it("places a held session under the configured or the canonical store root, and binds nothing for a .jsonl under neither", async () => {
      const linked = join(home, "linked-home");
      symlinkSync(home, linked);
      ompHome = linked;
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      expect(await held()).toBe(continued);
      listing = listed([continued.replace(home, linked)]);
      expect(await held()).toBe(continued);
      const elsewhere = join(home, "elsewhere", "2026-10-02_s2.jsonl");
      mkdirSync(join(home, "elsewhere"));
      writeFileSync(elsewhere, transcript(pane.cwd!));
      listing = listed([elsewhere, continued]);
      expect(await held()).toBeNull();
      const gone = join(linked, ".omp/agent/sessions", pane.cwd!.replaceAll("/", "-"), "2026-10-02_gone.jsonl");
      listing = listed([gone, continued]);
      expect(await held()).toBeNull();
    });

    it("binds nothing when the pid is reused between herdr's sample and the first start read", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      let reused = false;
      onEnviron = () => { reused = true; };
      startOf = (asked) => asked === pid ? (reused ? 2_000_000n : 1_000_000n) : null;
      expect(await held()).toBeNull();
      onEnviron = () => {};
      startOf = (asked) => asked === pid ? 1_000_000n : null;
      expect(await held()).toBe(continued);
    });

    it("drops a listing when the pid's start differs after lsof from before it", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      startOf = (asked, read) => asked === pid ? (read <= 2 ? 1_000_000n : 2_000_000n) : null;
      expect(await held()).toBeNull();
      startOf = (asked) => asked === pid ? 1_000_000n : null;
      expect(await held()).toBe(continued);
    });

    it("binds nothing when lsof fails or lists nothing, even with a fresh, valid breadcrumb", async () => {
      const continued = storeTranscript(pane.cwd!);
      breadcrumb(continued, Date.now());
      listing = "";
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
      listing = null;
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
      expect(lsofCalls).toHaveLength(2);
    });

    it("refuses a held name that decodes to control characters, and reads a plain one", async () => {
      // a session file whose name holds a newline, a tab and a DEL, which lsof's -F n writes as \n, \t and \x7f
      const control = storeTranscript(pane.cwd!, "2026-10-01_s\n1\t\x7f.jsonl");
      listing = listed([control.replaceAll("\n", "\\n").replaceAll("\t", "\\t").replaceAll("\x7f", "\\x7f")]);
      expect(await held()).toBeNull();
      const plain = storeTranscript(pane.cwd!, "2026-10-01_s 1 é.jsonl");
      listing = listed([plain]);
      expect(await held()).toBe(plain);
    });

    it("binds nothing when another pid of the pane has no listing that proves anything, even beside a valid one", async () => {
      const continued = storeTranscript(pane.cwd!);
      const other = pid + 1;
      processes = [{ pid, name: "omp", argv: ["omp", "-c"] }, { pid: other, name: "omp", argv: ["omp"] }];
      // lsof leaves the other omp out, its start cannot be read, or lsof cannot start: it may hold another session
      for (const [otherStart, run] of [
        [5_000_000n, () => listed([continued])],
        [null, () => listed([continued])],
        [5_000_000n, () => { throw new Error("spawn failed"); }],
      ] as const) {
        startOf = (asked) => asked === pid ? 1_000_000n : asked === other ? otherStart : null;
        lsof = () => ({ stdout: new Response(run()).body, exited: Promise.resolve(0), kill: (signal: unknown) => kills.push(signal) });
        expect(await held()).toBeNull();
      }
    });

    it("maps a held subagent file to the parent its listed directory names, and binds nothing through a linked one", async () => {
      const parentA = storeTranscript(pane.cwd!, "2026-10-01_A.jsonl");
      const parentB = storeTranscript(pane.cwd!, "2026-10-01_B.jsonl");
      mkdirSync(parentB.replace(/\.jsonl$/, ""));
      writeFileSync(join(parentB.replace(/\.jsonl$/, ""), "task.jsonl"), "");
      symlinkSync(parentB.replace(/\.jsonl$/, ""), parentA.replace(/\.jsonl$/, ""));
      listing = listed([join(parentA.replace(/\.jsonl$/, ""), "task.jsonl")]);
      expect(await held()).toBeNull();
      listing = listed([join(parentB.replace(/\.jsonl$/, ""), "task.jsonl")]);
      expect(await held()).toBe(parentB);
    });

    it("compares a held session's cwd with the pane's by the directories they resolve to", async () => {
      const alias = join(home, "alias");
      symlinkSync(pane.cwd!, alias);
      const aliased = storeTranscript(alias);
      const plain = storeTranscript(pane.cwd!, "2026-10-02_plain.jsonl");
      listing = listed([aliased]);
      expect(await held()).toBe(aliased);
      listing = listed([aliased, plain]);
      expect(await held()).toBeNull();
      const gone = storeTranscript(join(home, "gone"));
      listing = listed([gone, plain]);
      expect(await held()).toBeNull();
    });

    it("drops a reused listing whose held session path names another file now", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      expect(await held()).toBe(continued);
      const replacement = `${continued}.new`;
      writeFileSync(replacement, transcript(pane.cwd!));
      fs.renameSync(replacement, continued);
      expect(await ompHeldTranscript(pane.pane_id, pane.cwd!, true)).toBeNull();
      expect(lsofCalls).toHaveLength(1);
      listing = listed([continued]);
      expect(await ompHeldTranscript(pane.pane_id, pane.cwd!, true)).toBe(continued);
      expect(lsofCalls).toHaveLength(2);
    });

    it("binds nothing for a pid whose process started after herdr was asked for the pane", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      const later = BigInt(Date.now() + 60_000) * 1000n;
      startOf = (asked) => asked === pid ? later : null;
      expect(await held()).toBeNull();
      expect(lsofCalls).toEqual([]);
    });

    it("times a caller's earlier sample by its own ask, not by when it is read", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      const asked = Date.now() - 60_000;
      const now = spyOn(Date, "now").mockReturnValue(asked);
      try {
        const known = await herdr.paneProcessInfo(pane.pane_id);
        now.mockReturnValue(asked + 60_000);
        const heldBy = async () => {
          clock += 10_000;
          const route = await ompPaneRoute(pane.pane_id, known);
          return route === null || route === "unproved" ? null : ompRouteTranscript(await ompHeldOpen(route, true), pane.cwd!);
        };
        startOf = (asking) => asking === pid ? BigInt(asked + 30_000) * 1000n : null;
        expect(await heldBy()).toBeNull();
        startOf = (asking) => asking === pid ? BigInt(asked - 30_000) * 1000n : null;
        expect(await heldBy()).toBe(continued);
      } finally { now.mockRestore(); }
    });

    it("refuses a process that started in the very instant herdr was asked", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      const asked = Date.now();
      const now = spyOn(Date, "now").mockReturnValue(asked);
      try {
        startOf = (asking) => asking === pid ? BigInt(asked) * 1000n : null;
        expect(await held()).toBeNull();
        startOf = (asking) => asking === pid ? BigInt(asked) * 1000n - 1n : null;
        expect(await held()).toBe(continued);
      } finally { now.mockRestore(); }
    });

    it("binds nothing for a held subagent file whose parent transcript is a link", async () => {
      storeTranscript(pane.cwd!, "2026-10-01_A.jsonl");
      const parentB = storeTranscript(pane.cwd!, "2026-10-01_B.jsonl");
      const parentA = parentB.replace("_B.jsonl", "_A.jsonl");
      fs.rmSync(parentA);
      symlinkSync(parentB, parentA);
      mkdirSync(parentA.replace(/\.jsonl$/, ""));
      const task = join(parentA.replace(/\.jsonl$/, ""), "task.jsonl");
      writeFileSync(task, "");
      listing = listed([task]);
      expect(await held()).toBeNull();
    });

    it("binds nothing when the held session's cwd and the pane's are the same directory that is gone", async () => {
      const removed = join(home, "removed");
      const session = storeTranscript(removed);
      listing = listed([session]);
      clock += 10_000;
      expect(await ompHeldTranscript(pane.pane_id, removed, true)).toBeNull();
    });

    it("checks a held file's inode as lsof prints it, past 2^53", async () => {
      const continued = storeTranscript(pane.cwd!);
      // an inode a double cannot hold: a numeric stat rounds it to ...992
      const inode = 9_007_199_254_740_993n;
      listing = `p${pid}\nfcwd\nn${pane.cwd}\nf23\nD0x1\ni${inode}\nn${continued}\n`;
      const realStat = fs.statSync;
      const stat = spyOn(fs, "statSync").mockImplementation(((path: fs.PathLike, options?: { bigint?: boolean }) => {
        const real = realStat(path, options as never);
        if (path !== continued || real === undefined) return real;
        const big = options?.bigint === true;
        return Object.assign(Object.create(Object.getPrototypeOf(real) as object) as object, real, { dev: big ? 1n : 1, ino: big ? inode : Number(inode) });
      }) as unknown as typeof fs.statSync);
      try { expect(await held()).toBe(continued); } finally { stat.mockRestore(); }
    });

    it("binds nothing when a held session's header cannot be read as one", async () => {
      const continued = storeTranscript(pane.cwd!);
      const malformed = storeTranscript(pane.cwd!, "2026-10-02_bad.jsonl");
      writeFileSync(malformed, "not a session header\n");
      listing = listed([malformed, continued]);
      expect(await held()).toBeNull();
      listing = listed([continued]);
      expect(await held()).toBe(continued);
    });

    it("binds nothing when another pid is gone while lsof lists and lsof exits 1", async () => {
      const continued = storeTranscript(pane.cwd!);
      const gone = pid + 1;
      processes = [{ pid, name: "omp", argv: ["omp", "-c"] }, { pid: gone, name: "omp", argv: ["omp"] }];
      startOf = (asked, read) => asked === pid ? 1_000_000n : asked === gone && read <= 2 ? 5_000_000n : null;
      lsof = () => ({ stdout: new Response(listed([continued])).body, exited: Promise.resolve(1), kill: (signal: unknown) => kills.push(signal) });
      expect(await held()).toBeNull();
      expect(lsofCalls).toEqual([["/usr/sbin/lsof", "-nPbw", "-a", "-p", `${pid},${gone}`, "-FpDin"]]);
    });

    it("lists a process again only once its listing is stale or its start differs", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      expect(await held()).toBe(continued);
      listing = listed([]);
      expect(await ompHeldTranscript(pane.pane_id, pane.cwd!, true)).toBe(continued);
      expect(lsofCalls).toHaveLength(1);
      startOf = (asked) => asked === pid ? 3_000_000n : null;
      expect(await ompHeldTranscript(pane.pane_id, pane.cwd!, true)).toBeNull();
      expect(lsofCalls).toHaveLength(2);
      listing = listed([continued]);
      expect(await held()).toBe(continued);
      expect(lsofCalls).toHaveLength(3);
    });

    it("drops a reused listing whose pid's start changed by the time it is returned", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      expect(await held()).toBe(continued);
      const added = pid + 1;
      processes = [{ pid, name: "omp", argv: ["omp", "-c"] }, { pid: added, name: "omp", argv: ["omp"] }];
      startOf = (asked, read) => asked === added ? 7_000_000n : asked === pid ? (read <= 5 ? 1_000_000n : 2_000_000n) : null;
      listing = `p${added}\nfcwd\nn${pane.cwd}\n`;
      expect(await ompHeldTranscript(pane.pane_id, pane.cwd!, true)).toBeNull();
      expect(lsofCalls.at(-1)).toEqual(["/usr/sbin/lsof", "-nPbw", "-a", "-p", String(added), "-FpDin"]);
    });

    it("binds nothing when any held name is refused, even beside a valid session", async () => {
      const continued = storeTranscript(pane.cwd!);
      const missing = join(home, ".omp/agent/sessions", pane.cwd!.replaceAll("/", "-"), "2026-10-02_gone.jsonl");
      for (const refused of [`${pane.cwd}/a\\x01b`, `${pane.cwd}/a\\qb`, missing]) {
        listing = listed([refused, continued]);
        expect(await held()).toBeNull();
      }
      listing = listed([continued]);
      expect(await held()).toBe(continued);
    });

    it("re-checks a reused listing's start when lsof cannot be spawned", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      expect(await held()).toBe(continued);
      const added = pid + 1;
      processes = [{ pid, name: "omp", argv: ["omp", "-c"] }, { pid: added, name: "omp", argv: ["omp"] }];
      startOf = (asked, read) => asked === added ? 7_000_000n : asked === pid ? (read <= 5 ? 1_000_000n : 2_000_000n) : null;
      lsof = () => { throw new Error("spawn failed"); };
      expect(await ompHeldTranscript(pane.pane_id, pane.cwd!, true)).toBeNull();
      expect(lsofCalls).toHaveLength(2);
    });

    it("with the experimental setting off never runs lsof, and falls back as before", async () => {
      heldFiles = false;
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]);
      breadcrumb(continued, startedAt - 3_600_000);
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
      breadcrumb(continued, Date.now());
      expect(await chat()).toEqual(synthetic);
      expect(lsofCalls).toEqual([]);
    });

    it("kills lsof and binds nothing when its listing passes the byte cap", async () => {
      const continued = storeTranscript(pane.cwd!);
      listing = listed([continued]) + "n/dev/null\n".repeat(110_000);
      expect(await held()).toBeNull();
      expect(kills).toEqual(["SIGKILL"]);
    });

    it("SIGKILLs lsof at its deadline and binds nothing", async () => {
      const continued = storeTranscript(pane.cwd!);
      let close = () => {};
      let exit = (_code: number) => {};
      lsof = () => ({
        stdout: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(listed([continued]))); close = () => controller.close(); } }),
        exited: new Promise<number>((resolve) => { exit = resolve; }),
        kill: (signal: unknown) => { kills.push(signal); close(); exit(137); },
      });
      const realSetTimeout = globalThis.setTimeout;
      let fire: (() => void) | null = null;
      let armed: () => void = () => {};
      const deadlineSet = new Promise<void>((resolve) => { armed = resolve; });
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number) => {
        if (lsofCalls.length === 1 && fire === null) { fire = callback; armed(); return 0; }
        return realSetTimeout(callback, ms);
      }) as unknown as typeof setTimeout);
      try {
        const pending = held();
        await deadlineSet;
        fire!();
        expect(await pending).toBeNull();
        expect(kills).toEqual(["SIGKILL"]);
      } finally { timer.mockRestore(); }
    });

    it("runs lsof only on herdr-core, and only when herdr's report gives no usable session path", async () => {
      const continued = storeTranscript(pane.cwd!);
      breadcrumb(continued, Date.now());
      listing = listed([continued]);
      agentSession = { agent: "omp", kind: "path", value: continued };
      expect(await chat()).toEqual(synthetic);
      expect(lsofCalls).toEqual([]);
      // a report outside the omp's store is rejected: lsof finds the session the omp holds
      agentSession = { agent: "omp", kind: "path", value: join(home, "elsewhere.jsonl") };
      expect(await chat()).toEqual(synthetic);
      expect(lsofCalls).toHaveLength(1);
      agentSession = undefined;
      core = false;
      expect(await chat()).toEqual(synthetic);
      expect(lsofCalls).toHaveLength(1);
    });
  });

  for (const [profile, includeArgv] of [["personal", true], [null, false], ["personal", false]] as const) it.skipIf(process.platform !== "linux")(`reads the open ${profile ?? "default"} omp transcript when herdr ${includeArgv ? "supplies" : "omits"} argv`, async () => {
    const agentDir = profile === null ? join(home, ".omp/agent") : join(home, ".omp/profiles", profile, "agent");
    const store = join(agentDir, "sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    const bin = join(home, "bin");
    mkdirSync(bin);
    const script = join(bin, "omp.js");
    writeFileSync(script, `require("node:fs").openSync(${JSON.stringify(path)}, "a"); console.log("ready"); setInterval(() => {}, 1000);`);
    const argv = [process.execPath, script, ...(profile === null ? [] : ["--profile", profile])];
    const child = Bun.spawn(argv, { env: { ...process.env }, stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    try {
      const reader = child.stdout.getReader();
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("omp stand-in did not start")), 5000)),
      ]);
      expect(new TextDecoder().decode(first.value)).toContain("ready");
      processes = [{ pid: child.pid, name: "omp", ...(includeArgv ? { argv } : {}) }];
      for (const session of [undefined, { agent: "claude", kind: "id", value: "a-claude-session" }]) {
        agentSession = session;
        forgetTranscriptState();
        const answer = await paneConversation(pane.pane_id);
        expect(answer.source).toBe("omp-transcript");
        expect(answer.turns.map((turn) => turn.parts[0])).toEqual([
          { kind: "text", text: "synthetic question" }, { kind: "text", text: "synthetic answer" },
        ]);
      }
    } finally { child.kill(); await child.exited; }
  });

  it.skipIf(process.platform !== "linux")("does not trust the omp name when its argv is inaccessible or belongs to another executable", async () => {
    for (const pid of [2147483647, process.pid]) {
      processes = [{ pid, name: "omp" }];
      await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
    }
  });

  it.skipIf(process.platform !== "linux")("a failed probe with supplied argv never falls back to a synchronous environment read, and shows no chat", async () => {
    const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue(null);
    restores.push(() => probe.mockRestore());
    processes = [{ pid: process.pid, argv: ["omp"] }];
    agentSession = { agent: "omp", kind: "path", value: storeTranscript(pane.cwd!) };
    await unavailable();
    const environ = spyOn(omo, "processEnviron").mockImplementation(() => { throw new Error("unsafe synchronous read"); });
    restores.push(() => environ.mockRestore());
    probe.mockClear();
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    expect(probe).toHaveBeenCalledWith(process.pid, false);
    expect(environ).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== "linux")("a native Linux pane whose argv herdr supplies reads its environment through the bounded helper", async () => {
    const path = storeTranscript(pane.cwd!);
    const omp = await standIn([], [path]);
    const wsl = spyOn(ompProbe, "isWsl").mockReturnValue(false);
    const probe = spyOn(ompProbe, "ompProcessMemory");
    const environ = spyOn(omo, "processEnviron").mockImplementation(() => { throw new Error("unsafe synchronous read"); });
    const read = fs.readFileSync;
    const files = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file).endsWith("/environ")) throw new Error(`unsafe synchronous read of ${String(file)}`);
      return read(file, options as never);
    }) as typeof fs.readFileSync);
    restores.push(() => wsl.mockRestore(), () => probe.mockRestore(), () => environ.mockRestore(), () => files.mockRestore());
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBe(path);
    expect(probe).toHaveBeenCalledWith(omp.pid, false);
    expect(environ).not.toHaveBeenCalled();
    expect(files.mock.calls.some(([file]) => String(file).endsWith("/environ"))).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("a successful probe's environment finds the tmux breadcrumb with no synchronous environ read", async () => {
    const agentDir = join(home, ".omp/agent");
    const store = join(agentDir, "sessions/-project");
    mkdirSync(store, { recursive: true });
    const path = join(store, "2026-10-01_s1.jsonl");
    writeFileSync(path, transcript(pane.cwd!));
    mkdirSync(join(agentDir, "terminal-sessions"));
    writeFileSync(join(agentDir, "terminal-sessions", "tmux-%4242"), `${pane.cwd}\n${path}\n`);
    const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue({ argv: ["omp"], environ: [`HOME=${home}`, "TMUX=/tmp/tmux-1/default,1,0", "TMUX_PANE=%4242"] });
    const environ = spyOn(omo, "processEnviron").mockImplementation(() => { throw new Error("unsafe synchronous read"); });
    const read = fs.readFileSync;
    const files = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (String(file).endsWith("/environ")) throw new Error(`unsafe synchronous read of ${String(file)}`);
      return read(file, options as never);
    }) as typeof fs.readFileSync);
    restores.push(() => probe.mockRestore(), () => environ.mockRestore(), () => files.mockRestore());
    processes = [{ pid: process.pid, name: "omp" }];
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBe(path);
    expect(probe).toHaveBeenCalledWith(process.pid, true);
    expect(environ).not.toHaveBeenCalled();
    expect(files.mock.calls.some(([file]) => String(file).endsWith("/environ"))).toBe(false);
  });

  const writeTranscript = (path: string, cwd: string, { answer = "synthetic answer", version = 3 }: { answer?: string; version?: number } = {}) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, transcript(cwd).replace("synthetic answer", answer).replace('"version":3', `"version":${version}`));
    return path;
  };
  const slug = (cwd: string) => cwd.replaceAll("/", "-");
  const unavailable = async () => {
    forgetTranscriptState();
    await expect(paneConversation(pane.pane_id)).rejects.toThrow("no_session_path");
  };
  const only = async (omp: { pid: number; argv: string[] }) => {
    processes = [{ pid: omp.pid, name: "omp", argv: omp.argv }];
  };
  const reapAll = async () => { for (const reap of reaped.splice(0)) await reap(); };

  it.skipIf(process.platform !== "linux")("finds a moved store's session through the held file, the breadcrumb and herdr's path", async () => {
    const own = join(home, "own-sessions");
    // omp keeps a session directory of its own flat: <id>.jsonl
    const path = writeTranscript(join(own, "2026-10-01_s1.jsonl"), pane.cwd!);
    for (const [options, env] of [[[], { PI_CODING_AGENT_SESSION_DIR: own }], [["--session-dir", own], {}], [[`--session-dir=${own}/`], {}]] as const) {
      await only(await standIn([...options], [path], { env }));
      for (const session of [undefined, otherAgent, { agent: "omp", kind: "path", value: path }]) {
        agentSession = session;
        expect(await chat()).toEqual(synthetic);
      }
      await reapAll();
    }
    const data = join(home, "xdg-data"), state = join(home, "xdg-state");
    mkdirSync(join(data, "omp"), { recursive: true });
    mkdirSync(join(state, "omp", "terminal-sessions"), { recursive: true });
    await only(await standIn([], [], { env: { PI_CODING_AGENT_SESSION_DIR: own, XDG_DATA_HOME: data, XDG_STATE_HOME: state, TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4260" } }));
    agentSession = undefined;
    mkdirSync(join(home, ".omp/agent/terminal-sessions"), { recursive: true });
    writeFileSync(join(home, ".omp/agent/terminal-sessions/tmux-%4260"), `${pane.cwd}\n${path}\n`);
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    writeFileSync(join(state, "omp/terminal-sessions/tmux-%4260"), `${pane.cwd}\n${path}\n`);
    expect(await chat()).toEqual(synthetic);
    await reapAll();
    const custom = join(home, "custom-agent");
    const managed = writeTranscript(join(custom, "sessions", slug(pane.cwd!), "2026-10-02_s2.jsonl"), pane.cwd!);
    const xdgManaged = writeTranscript(join(data, "omp", "sessions", slug(pane.cwd!), "2026-10-03_s3.jsonl"), pane.cwd!);
    for (const [held, env] of [[managed, { PI_CODING_AGENT_DIR: custom }], [xdgManaged, { XDG_DATA_HOME: data }]] as const) {
      await only(await standIn([], [held], { env }));
      for (const session of [undefined, { agent: "omp", kind: "path", value: held }]) {
        agentSession = session;
        expect(await chat()).toEqual(synthetic);
      }
      await reapAll();
    }
  });

  it.skipIf(process.platform !== "linux")("holds herdr's path to the store the pane's omp process writes to", async () => {
    const own = join(home, "own-sessions");
    const mine = writeTranscript(join(own, "2026-10-01_s1.jsonl"), pane.cwd!);
    const decoy = writeTranscript(join(home, ".omp/agent/sessions", slug(pane.cwd!), "2026-10-02_decoy.jsonl"), pane.cwd!, { answer: "decoy answer" });
    const decoyChat = [synthetic[0], { kind: "text" as const, text: "decoy answer" }];
    agentSession = { agent: "omp", kind: "path", value: decoy };
    await only(await standIn(["--session-dir", own], [mine]));
    expect(await chat()).toEqual(synthetic);
    await reapAll();
    await only(await standIn([], [], { env: { PI_CODING_AGENT_SESSION_DIR: own } }));
    await unavailable();
    await reapAll();
    await only(await standIn(["--profile", "other"], []));
    await unavailable();
    await reapAll();
    const elsewhere = writeTranscript(join(own, "2026-10-03_s3.jsonl"), join(home, "elsewhere"), { answer: "decoy answer" });
    await only(await standIn(["--session-dir", own], []));
    agentSession = { agent: "omp", kind: "path", value: elsewhere };
    await unavailable();
    await reapAll();
    await only(await standIn([], []));
    agentSession = { agent: "omp", kind: "path", value: decoy };
    expect(await chat()).toEqual(decoyChat);
    await reapAll();
    processes = [];
    expect(await chat()).toEqual(decoyChat);
  });

  it.skipIf(process.platform !== "linux")("refuses links out of the store and session versions omp does not read", async () => {
    const env = { TMUX: "/tmp/tmux-1/default,1,0", TMUX_PANE: "%4261" };
    const breadcrumb = (path: string) => {
      mkdirSync(join(home, ".omp/agent/terminal-sessions"), { recursive: true });
      writeFileSync(join(home, ".omp/agent/terminal-sessions/tmux-%4261"), `${pane.cwd}\n${path}\n`);
    };
    // a flat store nested in the default store: a link out of it stays out, though it lands in the default store
    const outside = writeTranscript(join(home, ".omp/agent/sessions", slug(pane.cwd!), "2026-10-01_s1.jsonl"), pane.cwd!);
    const nested = join(home, ".omp/agent/sessions/private");
    mkdirSync(nested, { recursive: true });
    const linked = join(nested, "2026-10-01_s1.jsonl");
    symlinkSync(outside, linked);
    await only(await standIn(["--session-dir", nested], [linked], { env }));
    breadcrumb(linked);
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    for (const value of [linked, outside]) {
      agentSession = { agent: "omp", kind: "path", value };
      await unavailable();
    }
    await reapAll();
    const own = join(home, "own-sessions");
    const subagent = writeTranscript(join(own, "2026-10-02_s2", "task.jsonl"), pane.cwd!);
    symlinkSync(outside, join(own, "2026-10-02_s2.jsonl"));
    await only(await standIn(["--session-dir", own], [subagent], { env }));
    breadcrumb(subagent);
    agentSession = undefined;
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    await reapAll();
    const future = writeTranscript(join(own, "2026-10-03_s3.jsonl"), pane.cwd!, { version: 4 });
    await only(await standIn(["--session-dir", own], [future], { env }));
    breadcrumb(future);
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    agentSession = { agent: "omp", kind: "path", value: future };
    await unavailable();
    writeTranscript(future, pane.cwd!);
    expect(await chat()).toEqual(synthetic);
  });

  it.skipIf(process.platform !== "linux")("reads herdr's path in a moved store with nothing held, and waits on one omp has not written", async () => {
    const own = join(home, "own-sessions");
    const path = writeTranscript(join(own, "2026-10-01_s1.jsonl"), pane.cwd!);
    await only(await standIn([], [], { env: { PI_CODING_AGENT_SESSION_DIR: own } }));
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    agentSession = { agent: "omp", kind: "path", value: path };
    expect(await chat()).toEqual(synthetic);
    // omp names its session file at start and writes it with the first answer
    agentSession = { agent: "omp", kind: "path", value: join(own, "2026-10-02_s2.jsonl") };
    forgetTranscriptState();
    expect(await paneConversation(pane.pane_id)).toMatchObject({ source: "omp-transcript", turns: [], history_id: "unwritten:2026-10-02_s2" });
  });

  it.skipIf(process.platform !== "linux")("reads herdr's path in a managed store whose session names a folder that is gone", async () => {
    // omp resumes a session of a deleted folder without moving, so its header and herdr's directory differ
    const gone = join(home, "gone");
    const path = writeTranscript(join(home, ".omp/agent/sessions", slug(gone), "2026-10-01_s1.jsonl"), gone);
    await only(await standIn([], []));
    agentSession = { agent: "omp", kind: "path", value: path };
    expect(await chat()).toEqual(synthetic);
  });

  it.skipIf(process.platform !== "linux")("herdr's path to the launch directory's session never outranks the live directory's", async () => {
    const a = join(home, "A"), b = join(home, "B"), own = join(home, "own-sessions");
    mkdirSync(a); mkdirSync(b);
    const old = writeTranscript(join(own, "2026-10-01_old.jsonl"), a, { answer: "decoy answer" });
    const current = writeTranscript(join(own, "2026-10-02_current.jsonl"), b);
    const omp = await standIn(["--cwd", a, "--session-dir", own], [current], { moveTo: b });
    await only(omp);
    pane.foreground_cwd = liveDir(omp.pid);
    agentSession = { agent: "omp", kind: "path", value: old };
    expect(await chat()).toEqual(synthetic);
    const named = writeTranscript(join(own, "2026-10-03_named.jsonl"), b, { answer: "named answer" });
    agentSession = { agent: "omp", kind: "path", value: named };
    expect(await chat()).toEqual([synthetic[0], { kind: "text", text: "named answer" }]);
  });

  it.skipIf(process.platform !== "linux")("an agent process whose argv cannot be read, alone or beside a readable omp, shows no chat", async () => {
    const plain = await standIn([], [storeTranscript(pane.cwd!)]);
    const unread = await standIn(["--session-dir", join(home, "other")], []);
    // herdr leaves out the argv of a process it takes for an agent; the helper cannot read this one
    const read = readProcess;
    const probe = spyOn(ompProbe, "ompProcessMemory").mockImplementation(async (pid: number, argv: boolean) => pid === unread.pid ? null : read(pid, argv));
    restores.push(() => probe.mockRestore());
    processes = [{ pid: plain.pid, name: "omp", argv: plain.argv }, { pid: unread.pid, name: "omp" }];
    agentSession = { agent: "omp", kind: "path", value: storeTranscript(pane.cwd!) };
    await unavailable();
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    processes = [{ pid: unread.pid, name: "omp" }];
    await unavailable();
    await reapAll();
    await only(await standIn([], [storeTranscript(pane.cwd!)]));
    processes.push({ pid: unread.pid, name: "omp" });
    expect(await chat()).toEqual(synthetic);
  });

  it.skipIf(process.platform !== "linux")("omp processes keeping different stores, or one whose environment cannot be read, show no chat", async () => {
    const a = join(home, "a"), b = join(home, "b");
    const mine = writeTranscript(join(a, "2026-10-01_s1.jsonl"), pane.cwd!);
    const theirs = writeTranscript(join(b, "2026-10-01_s2.jsonl"), pane.cwd!);
    const first = await standIn([], [mine], { env: { PI_CODING_AGENT_SESSION_DIR: a } });
    const second = await standIn([], [theirs], { env: { PI_CODING_AGENT_SESSION_DIR: b } });
    processes = [first, second].map((omp) => ({ pid: omp.pid, name: "omp", argv: omp.argv }));
    expect(await ompHeldTranscript(pane.pane_id, pane.cwd!)).toBeNull();
    for (const value of [mine, theirs]) {
      agentSession = { agent: "omp", kind: "path", value };
      await unavailable();
    }
    await only(first);
    agentSession = undefined;
    expect(await chat()).toEqual(synthetic);
    const probe = spyOn(ompProbe, "ompProcessMemory").mockResolvedValue(null);
    restores.push(() => probe.mockRestore());
    agentSession = { agent: "omp", kind: "path", value: storeTranscript(pane.cwd!) };
    await unavailable();
  });
});
