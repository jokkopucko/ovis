import { expect, it, spyOn } from "bun:test";
import * as darwinProcess from "./darwin-process.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { heldOmoProcess, heldRuntime, heldSessionIds, isOmoProcess, omoAgentDir, omoPanes, omoProcessIdentity, omoSessionFolder, omoCandidates, omoTranscriptsOfCwd, selectOmoTranscript, withOmoDescendants, type OmoRuntime, type ProcessInfo } from "./omo.ts";
import * as client from "./herdr/client.ts";
import * as omoModule from "./omo.ts";
import * as processStart from "./process-start.ts";
import { processStartedAt } from "./process-start.ts";
import { parseOmpTranscript } from "./transcript-records.ts";
import type { ProcessRow } from "./windows-processes.ts";

const runtime = (paneId: string, startedAt: number | null = 10_000, paths: string[] = [], ids: string[] = []): OmoRuntime => ({ paneId, startedAt, paths, ids });
const files = [
  { path: "/old.jsonl", id: "old-session", createdAt: 100 },
  { path: "/fresh.jsonl", id: "fresh-session", createdAt: 10_000 },
];

const OMO_AI = "/home/u/.nvm/versions/node/v24.18.0/lib/node_modules/omo-ai";

it("takes omo from the program a process runs: its own binary, or the script of node or bun", () => {
  // argv as herdr 0.9.0's pane.process_info reported them for omo 5.1.7 and its MCP child
  expect(isOmoProcess(["/home/u/.bun/bin/bun", `${OMO_AI}/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${OMO_AI}/plugin`])).toBeTrue();
  expect(isOmoProcess(["/home/u/.bun/bin/bun", `${OMO_AI}/plugin/runtime/ast-grep-mcp/cli.js`, "mcp"])).toBeTrue();
  expect(isOmoProcess(["node", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeTrue();
  expect(isOmoProcess(["node", "--enable-source-maps", `${OMO_AI}/bin/omo.js`, "--session-id", "abcdefgh"])).toBeTrue();
  expect(isOmoProcess(["omo"])).toBeTrue();
  expect(isOmoProcess(["/home/u/.local/bin/omo", "--session-id", "abcdefgh"])).toBeTrue();
  expect(isOmoProcess([`${OMO_AI}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`, "--output-format", "stream-json"])).toBeTrue();
});

it("reads a Windows PC's process words: bun.exe, backslashes, and a drive's colon", () => {
  const modules = "C:\\Users\\me\\.bun\\install\\global\\node_modules";
  expect(isOmoProcess(["C:\\Users\\me\\.bun\\bin\\bun.exe", `${modules}\\@code-yeongyu\\senpi\\dist\\bundle\\cli.js`, "--extension", `${modules}\\omo-ai\\plugin`])).toBeTrue();
  expect(isOmoProcess(["bun.exe", `${modules}\\omo-ai\\plugin\\runtime\\ast-grep-mcp\\cli.js`, "mcp"])).toBeTrue();
  expect(isOmoProcess(["node.exe", "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\omo-ai\\bin\\omo.js"])).toBeTrue();
  expect(isOmoProcess(["C:\\Users\\me\\AppData\\Roaming\\npm\\omo.cmd"])).toBeTrue();
  // still only the program: bun.exe running something else, or a PATH list, is not omo
  expect(isOmoProcess(["bun.exe", "C:\\work\\app\\server.js"])).toBeFalse();
  expect(isOmoProcess(["bun.exe", "C:\\a\\omo-ai\\bin;D:\\b"])).toBeFalse();
  expect(isOmoProcess(["/bin/sh", "-c", "a:/x/omo-ai/bin"])).toBeFalse();
});

it("takes the engine a global bun install hoists next to omo-ai for omo when it loads omo-ai's plugin", () => {
  const modules = "/home/u/.bun/install/global/node_modules";
  // omo-ai 5.1.6 installed with `bun add -g omo-ai`: senpi is not under omo-ai
  expect(isOmoProcess(["/home/u/.bun/bin/bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${modules}/omo-ai/plugin`])).toBeTrue();
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/cli.js`, "--extension", `${modules}/omo-ai/plugin`, "--model", "anthropic/claude-opus-4-1", "--thinking", "medium"])).toBeTrue();
  // senpi on its own, or with another extension, is not omo
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`])).toBeFalse();
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", "/home/u/ext/other"])).toBeFalse();
  // an omo-ai plugin path handed to another script, or not as an extension, is still not omo
  expect(isOmoProcess(["bun", "/home/u/tools/watch.js", "--extension", `${modules}/omo-ai/plugin`])).toBeFalse();
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, `${modules}/omo-ai/plugin`])).toBeFalse();
  expect(isOmoProcess([`${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${modules}/omo-ai/plugin`])).toBeFalse();
  // words after `--` are the prompt: senpi loads no extension from them
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--", "Explain", "--extension", `${modules}/omo-ai/plugin`])).toBeFalse();
  expect(isOmoProcess(["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${modules}/omo-ai/plugin`, "--", "Explain"])).toBeTrue();
});

it("does not take an omo path given to another program for omo", () => {
  expect(isOmoProcess(["grep", "-q", `${OMO_AI}/x`])).toBeFalse();
  expect(isOmoProcess(["cat", "/home/u/.nvm/versions/node/v24.18.0/bin/omo"])).toBeFalse();
  expect(isOmoProcess(["ls", "omo"])).toBeFalse();
  expect(isOmoProcess(["node", "/home/u/tools/watch.js", `${OMO_AI}/plugin`])).toBeFalse();
  expect(isOmoProcess(["bun", "--version"])).toBeFalse();
  expect(isOmoProcess(["/home/u/omo-ai-tools/bun", "/home/u/x.js"])).toBeFalse();
  expect(isOmoProcess([])).toBeFalse();
});

it("uses only a unique session created during the sole runtime, never cwd recency", () => {
  expect(selectOmoTranscript("a", files, [runtime("a")], 20_000)).toBe("/fresh.jsonl");
  expect(selectOmoTranscript("a", files, [runtime("a"), runtime("b", 11_000)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a"), runtime("unreadable", null)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", null)], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 10_000, [], ["missing-session"])], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 30_000)], 40_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a")], 5_000)).toBeNull();
  expect(selectOmoTranscript("a", [...files, { path: "/second.jsonl", id: "second", createdAt: 11_000 }], [runtime("a")], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", [{ ...files[1]!, createdAt: null }], [runtime("a")], 20_000)).toBeNull();
});

it("binds explicit sessions independently in one cwd but rejects conflicting claims", () => {
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, [], ["old-session"]), runtime("b", 20_000, ["/fresh.jsonl"])] )).toBe("/old.jsonl");
  expect(selectOmoTranscript("b", files, [runtime("a", 20_000, [], ["old-session"]), runtime("b", 20_000, ["/fresh.jsonl"])] )).toBe("/fresh.jsonl");
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, ["/fresh.jsonl"]), runtime("b", 20_000, [], ["fresh-session"])] )).toBeNull();
  expect(selectOmoTranscript("a", files, [runtime("a", 20_000, ["/fresh.jsonl"], ["old-session"])] )).toBeNull();
});

it("reads session identity from bounded headers and rejects foreign cwd and escaped paths", () => {
  // candidates come back canonical; macOS's tmpdir is a symlink into /private
  const home = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-candidates-")));
  try {
    const dir = join(home, ".omo", "agent", "sessions", "--project--");
    mkdirSync(dir, { recursive: true });
    const session = (path: string, cwd: string) => writeFileSync(path, JSON.stringify({ type: "session", id: "session-1", cwd, timestamp: "2026-09-27T00:00:00Z" }) + "\n");
    session(join(dir, "valid.jsonl"), "/project");
    session(join(dir, "foreign.jsonl"), "/elsewhere");
    session(join(home, "outside.jsonl"), "/project");
    symlinkSync(join(home, "outside.jsonl"), join(dir, "escaped.jsonl"));
    writeFileSync(join(dir, "broken.jsonl"), "{");
    expect(omoCandidates("/project", home)).toEqual([{ path: join(dir, "valid.jsonl"), id: "session-1", createdAt: Date.parse("2026-09-27T00:00:00Z"), store: join(home, ".omo", "agent", "sessions") }]);
    expect(omoCandidates("/missing", home)).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("reads only the live process's own holder records, never a reused pid's leftovers", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-omo-holders-"));
  try {
    const hold = (id: string, pid: number, processStartedAtMs: number) => {
      const holders = join(dir, "session-holders", encodeURIComponent(id));
      mkdirSync(holders, { recursive: true });
      writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, bootAtMs: 0, processStartedAtMs, cwd: "/project" }));
    };
    hold("current", 42, 10_000);
    hold("crashed-earlier", 42, 2_000);
    hold("another-process", 7, 10_000);
    hold("odd/id", 43, 10_000);
    expect(heldSessionIds(dir, 42, 10_900)).toEqual(["current"]);
    expect(heldSessionIds(dir, 42, null).sort()).toEqual(["crashed-earlier", "current"]);
    expect(heldSessionIds(dir, 43, 10_000)).toEqual(["odd/id"]);
    expect(heldSessionIds(dir, 99, 10_000)).toEqual([]);
    expect(heldSessionIds(join(dir, "missing"), 42, 10_000)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("keeps a holder whose runtime came up seconds after the kernel started its process (#2281)", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-omo-holders-"));
  try {
    const boot = 50_000;
    const hold = (id: string, pid: number, processStartedAtMs: number, bootAtMs?: number) => {
      const holders = join(dir, "session-holders", encodeURIComponent(id));
      mkdirSync(holders, { recursive: true });
      writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, bootAtMs, processStartedAtMs, cwd: "/project" }));
    };
    // the kernel started each pid at 100s; omo's own clock read its start later on a busy machine
    hold("late-3500", 51, 103_500, boot);
    hold("late-6958", 52, 106_958, boot + 1000);
    hold("far-too-late", 53, 220_000, boot);
    hold("reused-pid", 54, 96_500, boot);
    hold("other-host", 55, 106_958, boot + 600_000);
    hold("no-boot", 56, 106_958);
    hold("no-boot-in-time", 57, 102_000);
    expect(heldSessionIds(dir, 51, 100_000, undefined, boot)).toEqual(["late-3500"]);
    expect(heldSessionIds(dir, 52, 100_000, "/project", boot)).toEqual(["late-6958"]);
    expect(heldSessionIds(dir, 52, 100_000, "/elsewhere", boot)).toEqual([]);
    expect(heldSessionIds(dir, 53, 100_000, undefined, boot)).toEqual([]);
    // a record from before this process's start is a crashed process's whose pid was reused
    expect(heldSessionIds(dir, 54, 100_000, undefined, boot)).toEqual([]);
    // a late record proves nothing unless it names this host's boot: another host sharing the
    // store, a clock step or an omo that writes no boot keeps the 3 s bound
    expect(heldSessionIds(dir, 55, 100_000, undefined, boot)).toEqual([]);
    expect(heldSessionIds(dir, 56, 100_000, undefined, boot)).toEqual([]);
    expect(heldSessionIds(dir, 57, 100_000, undefined, boot)).toEqual(["no-boot-in-time"]);
    // where this host's boot cannot be read, only the strict bound applies
    expect(heldSessionIds(dir, 52, 100_000, undefined, null)).toEqual([]);
    expect(heldSessionIds(dir, 57, 100_000, undefined, null)).toEqual(["no-boot-in-time"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("shows no earlier conversation after /new, while the session held now has no file yet", () => {
  // the process started at 10s and wrote /fresh.jsonl; /new then made it hold a session not written yet
  const afterNew = heldRuntime(runtime("a"), ["new-session"], files);
  expect(selectOmoTranscript("a", files, [runtime("a")], 20_000)).toBe("/fresh.jsonl");
  expect(selectOmoTranscript("a", files, [afterNew], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", files, [heldRuntime(runtime("a", 10_000, [], ["fresh-session"]), ["new-session"], files)], 20_000)).toBeNull();
  // its first message writes the file, and the chat follows it
  const written = [...files, { path: "/new.jsonl", id: "new-session", createdAt: 15_000 }];
  expect(selectOmoTranscript("a", written, [heldRuntime(runtime("a"), ["new-session"], written)], 20_000)).toBe("/new.jsonl");
  // holding nothing changes nothing
  expect(heldRuntime(runtime("a", 10_000, ["/old.jsonl"]), [], files)).toEqual(runtime("a", 10_000, ["/old.jsonl"]));
});

it("does not pin a launch session id after a new unclaimed session appears", () => {
  const newer = [...files, { path: "/new.jsonl", id: "new-session", createdAt: 15_000 }];
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, [], ["old-session"])], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, ["/old.jsonl"], ["old-session"])], 20_000)).toBe("/old.jsonl");
  expect(selectOmoTranscript("a", newer, [runtime("a", 10_000, [], ["old-session"]), runtime("b", 14_000, ["/new.jsonl"])], 20_000)).toBe("/old.jsonl");
});

it("finds omo's agent directory where the process's environment moved it", () => {
  expect(omoAgentDir(null, "/home/u", "/project")).toBe("/home/u/.omo/agent");
  expect(omoAgentDir(["PATH=/bin"], "/home/u", "/project")).toBe("/home/u/.omo/agent");
  expect(omoAgentDir(["OMO_CODING_AGENT_DIR=/state/omo/agent"], "/home/u", "/project")).toBe("/state/omo/agent");
  // the brand's own prefix first, then senpi's and pi's, as senpi reads them
  expect(omoAgentDir(["PI_CODING_AGENT_DIR=/pi", "SENPI_CODING_AGENT_DIR=/senpi"], "/home/u", "/project")).toBe("/senpi");
  expect(omoAgentDir(["SENPI_CODING_AGENT_DIR=/senpi", "OMO_CODING_AGENT_DIR=/omo"], "/home/u", "/project")).toBe("/omo");
  expect(omoAgentDir(["OMO_CODING_AGENT_DIR=~/.local/state/omo"], "/home/u", "/project")).toBe("/home/u/.local/state/omo");
  expect(omoAgentDir(["OMO_CODING_AGENT_DIR=rel/agent"], "/home/u", "/project")).toBe("/project/rel/agent");
  // set but empty: senpi keeps its default and looks no further
  expect(omoAgentDir(["OMO_CODING_AGENT_DIR=", "SENPI_CODING_AGENT_DIR=/senpi"], "/home/u", "/project")).toBe("/home/u/.omo/agent");
});

it("falls back to the pane cwd when the OS process cwd is unavailable", () => {
  const env = () => ["OMO_CODING_AGENT_DIR=relative-agent"];
  expect(omoProcessIdentity({ pid: 2 ** 30, argv: ["omo"] }, "/pane", "/home/u", env)?.agentDir)
    .toBe("/pane/relative-agent");
  expect(omoProcessIdentity({ pid: 2 ** 30, argv: ["omo"], cwd: "/reported" }, "/pane", "/home/u", env)?.agentDir)
    .toBe("/reported/relative-agent");
});

it("binds an omo pane whose launcher moved its agent directory out of ~/.omo", () => {
  // A launcher profile (OMO_CODING_AGENT_DIR=<state>/.omo/agent) wrote the session and its
  // holder record there, and ~/.omo/agent/sessions had no folder for the cwd: the chat lens
  // answered { source: "scrollback", turns: [] } and showed nothing.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-agent-dir-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const agentDir = join(root, "state", "profile", ".omo", "agent");
    mkdirSync(join(home, ".omo", "agent", "sessions"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const dir = join(agentDir, "sessions", `-${cwd.replaceAll("/", "-")}--`);
    const id = "01a0fd83-0000-7000-8000-000000000001";
    const pid = process.pid;
    mkdirSync(join(dir, "session-holders", id), { recursive: true });
    writeFileSync(join(dir, "session-holders", id, `${pid}.json`), JSON.stringify({ pid, processStartedAtMs: processStartedAt(pid) ?? 0, cwd }));
    // the record shapes of a real omo 5.1.10 session, contents replaced
    const path = join(dir, `2026-10-02T16-47-10-905Z_${id}.jsonl`);
    writeFileSync(path, [
      { type: "session", version: 3, id, timestamp: "2026-10-02T16:47:10.905Z", cwd },
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-02T16:47:11.562Z", provider: "anthropic-subscription", modelId: "model" },
      { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-10-02T16:47:11.563Z", thinkingLevel: "medium" },
      { type: "message", id: "u1", parentId: "t1", timestamp: "2026-10-02T16:47:20.000Z", message: { role: "user", content: [{ type: "text", text: "research the direction" }], timestamp: 1 } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-02T16:47:30.000Z", message: { role: "assistant", content: [{ type: "text", text: "here is the direction" }], stopReason: "stop", timestamp: 2 } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const pane = { pane_id: "w1:p1", cwd } as HerdrPane;
    const argv = ["/usr/bin/bun", "/opt/omo/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js", "--extension", "/opt/omo/node_modules/omo-ai/plugin"];
    const infos = new Map([[pane.pane_id, { process_info: { foreground_processes: [{ pid, argv, cwd }] } }]]);
    const moved = () => ["HOME=" + home, `OMO_CODING_AGENT_DIR=${agentDir}`];

    expect(omoTranscriptsOfCwd(cwd, [pane], infos, home, () => ["HOME=" + home]).get(pane.pane_id)?.path).toBeNull();
    const bound = omoTranscriptsOfCwd(cwd, [pane], infos, home, moved).get(pane.pane_id)?.path;
    expect(bound).toBe(path);
    expect(parseOmpTranscript(readFileSync(bound!, "utf8")).map((turn) => turn.role)).toEqual(["user", "assistant"]);
    // a store the environment names is the only other place a session may come from
    expect(omoCandidates(cwd, home)).toEqual([]);
    expect(omoCandidates(cwd, home, [], [join(home, ".omo", "agent"), agentDir]).map((file) => file.path)).toEqual([path]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("names a cwd's session folder as omo's engine does, a Windows cwd included", () => {
  expect(omoSessionFolder("/home/u/dev/app")).toBe("--home-u-dev-app--");
  expect(omoSessionFolder("C:\\Users\\me\\dev\\app")).toBe("--C--Users-me-dev-app--");
  expect(omoSessionFolder("C:/Users/me/app")).toBe("--C--Users-me-app--");
});

// herdr on Windows names the pane's launcher, not what the launcher starts (windows-processes.ts)
const launcherInfo: ProcessInfo = { process_info: { shell_pid: 10, foreground_processes: [{ pid: 11, argv: ["C:\\tools\\pi.exe"] }] } };
const launcherRows: ProcessRow[] = [
  { pid: 10, parent: 1, path: "C:\\pwsh.exe", commandLine: "pwsh.exe" },
  { pid: 11, parent: 10, path: "C:\\tools\\pi.exe", commandLine: "pi.exe" },
  { pid: 12, parent: 11, path: "C:\\bun.exe", commandLine: 'bun.exe "C:\\node_modules\\omo-ai\\bin\\cli.js" --session-id session-123' },
  // below another pane's shell
  { pid: 13, parent: 2, path: "C:\\bun.exe", commandLine: 'bun.exe "C:\\node_modules\\omo-ai\\bin\\cli.js" --session-id other-session' },
];

it("finds the OmO a Windows launcher started below the pane's shell, with its session arguments", () => {
  const processes = withOmoDescendants(launcherInfo, launcherRows)?.process_info?.foreground_processes ?? [];
  expect(processes.map((entry) => entry.pid)).toEqual([11, 12]);
  expect(isOmoProcess(processes[1]!.argv!)).toBeTrue();
  expect(processes[1]!.argv).toContain("session-123");
  expect(launcherInfo?.process_info?.foreground_processes).toHaveLength(1);
});

it("does not turn an ordinary pi into OmO or borrow another pane's OmO", () => {
  expect(withOmoDescendants(launcherInfo, launcherRows.filter((entry) => entry.pid !== 12))).toEqual(launcherInfo);
  expect(withOmoDescendants(launcherInfo, [])).toEqual(launcherInfo);
  expect(withOmoDescendants({ process_info: { foreground_processes: [] } }, launcherRows)).toEqual({ process_info: { foreground_processes: [] } });
  expect(withOmoDescendants(null, launcherRows)).toBeNull();
});

it("does not list an OmO process twice when herdr already names it", () => {
  const once = withOmoDescendants(launcherInfo, launcherRows);
  expect(withOmoDescendants(once, launcherRows)).toEqual(once);
});

const holdRecord = (dir: string, id: string, pid: number, record: object): void => {
  const holders = join(dir, "session-holders", encodeURIComponent(id));
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, `${pid}.json`), JSON.stringify(record));
};
const writeSession = (dir: string, id: string, cwd: string): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-02T16-47-10-905Z_${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", id, cwd, timestamp: "2026-10-02T16:47:10.905Z" }) + "\n");
  return path;
};

it("identifies an argv-silent omo runtime only through verified native holders", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-custom-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const agentDir = join(root, "state", "custom", "agent");
    const dir = join(agentDir, "sessions", omoSessionFolder(cwd));
    mkdirSync(dir, { recursive: true });
    const pid = process.pid;
    const neutral = ["/opt/team-ai/bin/run", "--profile", "work"];
    const env = [`OMO_CODING_AGENT_DIR=${agentDir}`];
    holdRecord(dir, "sess-1", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    // a launcher whose name and argv say nothing about omo still binds, by its store
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, cwd, home, () => env))
      .toEqual({ agentDir, heldIds: ["sess-1"], custom: true, held: true });
    // the process's own cwd counts when the caller does not supply the pane's
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, "", home, () => env)?.custom).toBeTrue();
    // the same holder in the default store needs no environment entry at all
    const defaultDir = join(home, ".omo", "agent", "sessions", omoSessionFolder(cwd));
    holdRecord(defaultDir, "home-sess", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, cwd, home, () => ["PATH=/bin"]))
      .toEqual({ agentDir: join(home, ".omo", "agent"), heldIds: ["home-sess"], custom: true, held: true });
    // a store moved only by senpi's or pi's variable is not an omo identity
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, cwd, home, () => [`SENPI_CODING_AGENT_DIR=${agentDir}`])).toBeNull();
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, cwd, home, () => [`PI_CODING_AGENT_DIR=${agentDir}`])).toBeNull();
    // recognized argv stays the legacy identity, no holder required
    const legacy = omoProcessIdentity({ pid, argv: ["node", `${OMO_AI}/bin/omo.js`], cwd }, cwd, home, () => null);
    expect(legacy?.custom).toBeFalse();
    expect(legacy?.agentDir).toBe(join(home, ".omo", "agent"));
    // a bun -g hoisted engine is the same legacy identity
    const modules = "/home/u/.bun/install/global/node_modules";
    expect(omoProcessIdentity({ pid, argv: ["bun", `${modules}/@code-yeongyu/senpi/dist/bundle/cli.js`, "--extension", `${modules}/omo-ai/plugin`], cwd }, cwd, home, () => null)?.custom).toBeFalse();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("counts an omo's holder as held only while the process's start is readable", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-held-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const pid = process.pid;
    // the start is the test's own, so the case reads the same on a platform with no readable start (Windows)
    const start = spyOn(processStart, "processStartedAt").mockReturnValue(1_792_000_000_000);
    try {
      holdRecord(join(home, ".omo", "agent", "sessions", omoSessionFolder(cwd)), "sess-1", pid, { pid, processStartedAtMs: 1_792_000_000_000, cwd });
      expect(omoProcessIdentity({ pid, argv: ["omo"], cwd }, cwd, home, () => null)).toMatchObject({ heldIds: ["sess-1"], held: true });
      // no readable start (Windows, a gone pid): the record may name a reused pid, so nothing is held
      start.mockReturnValue(null);
      expect(omoProcessIdentity({ pid, argv: ["omo"], cwd }, cwd, home, () => null)).toMatchObject({ custom: false, held: false });
    } finally { start.mockRestore(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("never takes an env marker, an argv mention, a wrong cwd or a stale start for a custom omo", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-refuse-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const agentDir = join(root, "state", "agent");
    const dir = join(agentDir, "sessions", omoSessionFolder(cwd));
    mkdirSync(dir, { recursive: true });
    const pid = process.pid;
    const neutral = ["/opt/team-ai/bin/run"];
    const env = [`OMO_CODING_AGENT_DIR=${agentDir}`];
    // the environment entry alone proves nothing without a holder
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, cwd, home, () => env)).toBeNull();
    // a holder another pid wrote, a foreign cwd and a start that is not this
    // process's own each fail closed
    holdRecord(dir, "other-pid", pid, { pid: pid + 1, processStartedAtMs: processStartedAt(pid), cwd });
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, cwd, home, () => env)).toBeNull();
    rmSync(join(dir, "session-holders", "other-pid"), { recursive: true });
    holdRecord(dir, "foreign", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd: "/elsewhere" });
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, cwd, home, () => env)).toBeNull();
    rmSync(join(dir, "session-holders", "foreign"), { recursive: true });
    holdRecord(dir, "stale", pid, { pid, processStartedAtMs: (processStartedAt(pid) ?? 0) - 60_000, cwd });
    expect(omoProcessIdentity({ pid, argv: neutral, cwd }, cwd, home, () => env)).toBeNull();
    rmSync(join(dir, "session-holders", "stale"), { recursive: true });
    // a pid nothing runs has no start to match a holder to
    expect(omoProcessIdentity({ pid: 2 ** 30, argv: neutral }, cwd, home, () => env)).toBeNull();
    // argv words that mention omo are still nothing without the holders
    expect(omoProcessIdentity({ pid, argv: ["grep", "-q", `${OMO_AI}/x`], cwd }, cwd, home, () => env)).toBeNull();
    // and without a resolvable cwd a custom identity cannot be verified at all
    expect(omoProcessIdentity({ pid: 2 ** 30, argv: neutral }, "", home, () => env)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("binds same-id sessions in different stores to the pane that owns each store", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-stores-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    mkdirSync(join(home, ".omo", "agent", "sessions"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const storeA = join(root, "a", "agent");
    const storeB = join(root, "b", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const dirB = join(storeB, "sessions", omoSessionFolder(cwd));
    const pidA = process.pid;
    const pidB = process.ppid;
    holdRecord(dirA, "dup", pidA, { pid: pidA, processStartedAtMs: processStartedAt(pidA), cwd });
    holdRecord(dirB, "dup", pidB, { pid: pidB, processStartedAtMs: processStartedAt(pidB), cwd });
    const fileA = writeSession(dirA, "dup", cwd);
    const panes = [{ pane_id: "w:p1", cwd } as HerdrPane, { pane_id: "w:p2", cwd } as HerdrPane];
    const launcher = ["/opt/team-ai/bin/run"];
    const infos = new Map([
      ["w:p1", { process_info: { foreground_processes: [{ pid: pidA, argv: launcher, cwd }] } }],
      ["w:p2", { process_info: { foreground_processes: [{ pid: pidB, argv: launcher, cwd }] } }],
    ]);
    const envOf = (pid: number) => pid === pidA ? [`OMO_CODING_AGENT_DIR=${storeA}`] : pid === pidB ? [`OMO_CODING_AGENT_DIR=${storeB}`] : null;
    const first = omoTranscriptsOfCwd(cwd, panes, infos, home, envOf);
    expect(first.get("w:p1")?.path).toBe(realpathSync(fileA));
    // B's held id is pending in B's store; A's written file of the same id is not B's
    expect(first.get("w:p2")?.path).toBeNull();
    expect(first.get("w:p2")?.pending).toBe("dup");
    // once B writes its own file each pane keeps its own transcript
    const fileB = writeSession(dirB, "dup", cwd);
    const second = omoTranscriptsOfCwd(cwd, panes, infos, home, envOf);
    expect(second.get("w:p1")?.path).toBe(realpathSync(fileA));
    expect(second.get("w:p2")?.path).toBe(realpathSync(fileB));
    // an escaped symlink inside a store is still no candidate
    const outside = join(root, "outside.jsonl");
    writeFileSync(outside, JSON.stringify({ type: "session", id: "dup", cwd, timestamp: "2026-10-02T16:47:10.905Z" }) + "\n");
    symlinkSync(outside, join(dirB, "escaped.jsonl"));
    const third = omoTranscriptsOfCwd(cwd, panes, infos, home, envOf);
    expect(third.get("w:p2")?.path).toBe(realpathSync(fileB));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("fails closed when two panes hold the same session file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-conflict-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const dir = join(agentDir, "sessions", omoSessionFolder(cwd));
    const pidA = process.pid;
    const pidB = process.ppid;
    holdRecord(dir, "contested", pidA, { pid: pidA, processStartedAtMs: processStartedAt(pidA), cwd });
    holdRecord(dir, "contested", pidB, { pid: pidB, processStartedAtMs: processStartedAt(pidB), cwd });
    writeSession(dir, "contested", cwd);
    const panes = [{ pane_id: "w:p1", cwd } as HerdrPane, { pane_id: "w:p2", cwd } as HerdrPane];
    const infos = new Map([
      ["w:p1", { process_info: { foreground_processes: [{ pid: pidA, argv: ["/opt/team-ai/run"], cwd }] } }],
      ["w:p2", { process_info: { foreground_processes: [{ pid: pidB, argv: ["/opt/team-ai/run"], cwd }] } }],
    ]);
    const out = omoTranscriptsOfCwd(cwd, panes, infos, home, () => [`OMO_CODING_AGENT_DIR=${agentDir}`]);
    expect(out.get("w:p1")?.path).toBeNull();
    expect(out.get("w:p2")?.path).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("returns a custom pane's pending session and nothing once its holder is gone", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-pending-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const dir = join(agentDir, "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, { process_info: { foreground_processes: [{ pid, argv: ["/opt/team-ai/run"], cwd }] } }]]);
    const env = () => [`OMO_CODING_AGENT_DIR=${agentDir}`];
    const run = () => omoTranscriptsOfCwd(cwd, [pane], infos, home, env);
    // no holder: the launcher is not omo, and no file inference rescues it
    writeSession(dir, "older-session", cwd);
    expect(run().has(pane.pane_id)).toBeFalse();
    holdRecord(dir, "first-session", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    const pending = run().get(pane.pane_id);
    expect(pending?.path).toBeNull();
    expect(pending?.pending).toBe("first-session");
    const written = writeSession(dir, "first-session", cwd);
    expect(run().get(pane.pane_id)?.path).toBe(realpathSync(written));
    // /new: the next held id is pending; the file it left is not resurrected
    rmSync(join(dir, "session-holders", "first-session"), { recursive: true });
    holdRecord(dir, "after-new", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    const afterNew = run().get(pane.pane_id);
    expect(afterNew?.path).toBeNull();
    expect(afterNew?.pending).toBe("after-new");
    // and with no holder left the launcher is no runtime at all
    rmSync(join(dir, "session-holders", "after-new"), { recursive: true });
    expect(run().has(pane.pane_id)).toBeFalse();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps a scoped runtime's inference and launch-id guard inside its own store", () => {
  const a = { ...runtime("a"), stores: ["/a/sessions"] };
  // a fresh file in another pane's store is not evidence for this pane's runtime,
  // and a file outside every named store counts no more than a missing one
  const foreignFresh = { path: "/b/fresh.jsonl", id: "fresh", createdAt: 10_000, store: "/b/sessions" };
  const ownFresh = { path: "/a/fresh.jsonl", id: "fresh", createdAt: 10_000, store: "/a/sessions" };
  expect(selectOmoTranscript("a", [foreignFresh], [a], 20_000)).toBeNull();
  expect(selectOmoTranscript("a", [ownFresh], [a], 20_000)).toBe("/a/fresh.jsonl");
  expect(selectOmoTranscript("a", [{ path: "/unstored.jsonl", id: "fresh", createdAt: 10_000 }], [a], 20_000)).toBeNull();
  // the /new ambiguity guard of a launch-id hint looks only inside the owned store:
  // a newer foreign file leaves the hint alone, a newer own one unsettles it
  const hinted = { ...a, ids: ["old-session"] };
  const old = { path: "/a/old.jsonl", id: "old-session", createdAt: 1_000, store: "/a/sessions" };
  const foreignNewer = { path: "/b/new.jsonl", id: "new", createdAt: 15_000, store: "/b/sessions" };
  const ownNewer = { path: "/a/new.jsonl", id: "new", createdAt: 15_000, store: "/a/sessions" };
  expect(selectOmoTranscript("a", [old, foreignNewer], [hinted], 20_000)).toBe("/a/old.jsonl");
  expect(selectOmoTranscript("a", [old, ownNewer], [hinted], 20_000)).toBeNull();
});

it("fails closed on distinct holder claims while duplicates of one claim still bind", () => {
  const a = { ...runtime("a"), stores: ["/a/sessions"] };
  const fileA = { path: "/a/one.jsonl", id: "one", createdAt: 10_000, store: "/a/sessions" };
  // two different sessions claimed: ambiguous even though only one has a written file
  const contested = heldRuntime(a, [{ id: "one", store: "/a/sessions" }, { id: "two", store: "/a/sessions" }], [fileA]);
  expect(contested.ambiguous).toBeTrue();
  expect(selectOmoTranscript("a", [fileA], [contested], 20_000)).toBeNull();
  // the same id held under another store is a different claim, not a duplicate
  expect(heldRuntime(a, [{ id: "one", store: "/a/sessions" }, { id: "one", store: "/b/sessions" }], [fileA]).ambiguous).toBeTrue();
  expect(heldRuntime(a, ["one", "two"], [fileA]).ambiguous).toBeTrue();
  // the same claim seen twice (two of the pane's processes hold one session) stays valid
  for (const held of [[{ id: "one", store: "/a/sessions" }, { id: "one", store: "/a/sessions" }], ["one", "one"]] as const) {
    const claimed = heldRuntime(a, held, [fileA]);
    expect(claimed.ambiguous).not.toBeTrue();
    expect(selectOmoTranscript("a", [fileA], [claimed], 20_000)).toBe("/a/one.jsonl");
  }
  // a held id whose store wrote nothing is pending; another store's file of the same id is not its
  const pending = heldRuntime({ ...a, stores: ["/b/sessions"] }, [{ id: "one", store: "/b/sessions" }], [fileA]);
  expect(pending.paths).toEqual([]);
  expect(pending.ids).toEqual([]);
  expect(pending.claims).toEqual([{ id: "one", store: "/b/sessions" }]);
  expect(selectOmoTranscript("a", [fileA], [pending], 20_000)).toBeNull();
});

it("names the OmO process holding a session, not the bundled SDK child beside it (#1545)", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-held-pid-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const pid = 41001;
  const start = spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1_792_000_000_000);
  const environ = spyOn(omoModule, "processEnviron").mockReturnValue([`OMO_CODING_AGENT_DIR=${agentDir}`]);
  try {
    holdRecord(join(agentDir, "sessions", omoSessionFolder(cwd)), "sess-1", pid, { pid, processStartedAtMs: 1_792_000_000_000, cwd });
    // an argv-silent custom OmO, known by its holder alone, and the SDK child it runs a turn in; herdr gives no
    // per-process cwd (macOS), so the pane's own directory places them
    const pane = { pane_id: "p", cwd } as HerdrPane;
    const parent = { pid, argv: ["/opt/team-ai/bin/run"] };
    const sdk = { pid: pid + 1, argv: [`${OMO_AI}/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`] };
    expect(await heldOmoProcess(pane, [parent, sdk], root)).toEqual({ pid, started: 1_792_000_000_000 });
    expect(await heldOmoProcess(pane, [sdk, parent], root)).toEqual({ pid, started: 1_792_000_000_000 });
    expect(await heldOmoProcess(pane, [sdk], root)).toBeNull();
    expect(await heldOmoProcess({ ...pane, cwd: join(root, "elsewhere") }, [parent, sdk], root)).toBeNull();
  } finally { start.mockRestore(); environ.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

// every OmO status refresh reads these, so every snapshot a pending message is checked against does (#1545)
it("reads OmO panes' process starts from the kernel on macOS, with no ps child", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  const home = mkdtempSync(join(tmpdir(), "omo-darwin-starts-"));
  const pane = { pane_id: "omo-darwin", workspace_id: "w", tab_id: "t", terminal_id: "term", focused: false, revision: 0,
    agent: "pi", agent_status: "idle", cwd: home } as HerdrPane;
  spyOn(client, "herdrRpc").mockImplementation((async () => ({ process_info: { pane_id: pane.pane_id,
    foreground_processes: [{ pid: 4242, name: "node", argv: ["node", `${OMO_AI}/bin/omo`], cwd: home }] } })) as unknown as typeof client.herdrRpc);
  const blocking = spyOn(Bun, "spawnSync");
  // the kernel's process record answers; no ps runs, awaited or not (#1404)
  const kernel = spyOn(darwinProcess, "darwinStartTime").mockReturnValue(1_000_000n);
  const awaited = spyOn(Bun, "spawn");
  try {
    // the kernel's start reaches the pane's OmO result: a read that skipped the kernel would leave it unknown
    expect((await omoPanes([pane], home)).get(pane.pane_id)?.startedAt).toBe(1_000);
    expect(kernel).toHaveBeenCalledWith(4242);
    expect(awaited).not.toHaveBeenCalled();
    expect(blocking).not.toHaveBeenCalled();
  } finally {
    awaited.mockRestore();
    blocking.mockRestore();
    kernel.mockRestore();
    (client.herdrRpc as unknown as { mockRestore(): void }).mockRestore();
    Object.defineProperty(process, "platform", platform);
    rmSync(home, { recursive: true, force: true });
  }
});
