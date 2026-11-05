import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { paneTranscript, toolOutput, forgetPaneTranscriptState, forgetTranscriptState } from "./conversation.ts";
import * as gjc from "./gjc-runtime.ts";
import * as processProbe from "./omp-process.ts";
import { forgetDshProcesses } from "./dsh.ts";
import * as herdr from "./herdr/client.ts";
import { handlePaneRequest } from "./pane-routes.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;
/** What herdr reports for a TUI launched through the npm-installed launcher. */
const DSH_ARGV = ["node", "/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js", "--profile", "tui"];

for (const mode of ["mixed", "gjc-only", "gjc-under-shell", "dsh-only"] as const) linuxTest(`preserves the unlabeled pane route for ${mode}`, async () => {
  const root = await mkdtemp(join(tmpdir(), "ovis-dsh-gjc-route-"));
  const folder = join(root, "sessions", "12345678-1234-1234-1234-123456789abc");
  await mkdir(folder, { recursive: true });
  const dshPath = join(folder, "session.v4.jsonl");
  await writeFile(dshPath, "");
  const lock = await open(join(folder, "session.lock"), "w");
  const gjcPath = join(root, "gjc.jsonl");
  const pane = { pane_id: `dsh-gjc-${mode}`, cwd: root };
  const foreground = {
    shell_pid: process.ppid,
    foreground_processes: [
      ...(mode === "gjc-only" ? [] : [{ pid: process.pid, argv: DSH_ARGV }]),
      ...(mode === "mixed" || mode === "gjc-only" ? [{ pid: process.ppid, argv: ["gjc"] }] : []),
    ],
  };
  const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string) => {
    if (method === "pane.process_info") return { process_info: foreground };
    throw new Error(`unexpected herdr RPC ${method}`);
  }) as typeof herdr.herdrRpc);
  const memory = spyOn(processProbe, "ompProcessMemory").mockResolvedValue({ argv: [], environ: [`DSH_HOME=${root}`] });
  // Keep real routing and dsh binding; isolate only GJC's separate native-record resolver.
  const nativeGjc = spyOn(gjc, "gjcTranscriptForPane").mockResolvedValue(gjcPath);
  const underShell = spyOn(gjc, "gjcPidUnderShell").mockResolvedValue(mode === "gjc-under-shell" ? { pid: process.ppid, started: null } : null);
  try {
    const route = await paneTranscript(pane.pane_id, undefined, { panes: [pane], agents: [] } as unknown as SessionSnapshot);
    expect(route).toMatchObject(mode === "dsh-only"
      ? { source: "dsh-transcript", path: dshPath }
      : { source: "gjc-transcript", path: gjcPath });
    if (mode !== "dsh-only") expect(nativeGjc).toHaveBeenCalledWith(pane.pane_id, root, undefined);
  } finally {
    underShell.mockRestore();
    nativeGjc.mockRestore();
    memory.mockRestore();
    rpc.mockRestore();
    forgetDshProcesses();
    forgetPaneTranscriptState(pane.pane_id);
    forgetTranscriptState();
    await lock.close();
    await rm(root, { recursive: true, force: true });
  }
});

linuxTest("serves a bound dsh conversation over HTTP and invalidates its ETag after an append", async () => {
  const root = await mkdtemp(join(tmpdir(), "ovis-dsh-http-"));
  const session = "12345678-1234-1234-1234-123456789abc";
  const folder = join(root, "sessions", session);
  await mkdir(folder, { recursive: true });
  const path = join(folder, "session.v4.jsonl");
  const rows = [
    { type: "session", version: 4, id: session, delegationDepth: 0 },
    { type: "user/message", seq: 0, data: { source: { kind: "user" }, content: [{ type: "text", text: "Hello" }] } },
  ];
  const save = () => writeFile(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  await save();
  const lock = await open(join(folder, "session.lock"), "w");
  const pane = { pane_id: "dsh-http-fixture", agent: "dsh", agent_status: "idle", cwd: root };
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane], agents: [] } as unknown as SessionSnapshot);
  const processInfo = spyOn(herdr, "paneProcessInfo").mockResolvedValue({ foreground_processes: [{ pid: process.pid, argv: DSH_ARGV }] } as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  const rpc = spyOn(herdr, "herdrRpc").mockRejectedValue(new Error("herdr RPC must not run in this test"));
  const memory = spyOn(processProbe, "ompProcessMemory").mockResolvedValue({ argv: [], environ: [`HOME=${root}`, `DSH_HOME=${root}`] });
  const url = new URL("http://x/api/pane/conversation?pane_id=" + pane.pane_id);
  const ask = async (etag?: string) => (await handlePaneRequest(new Request(url, { headers: etag ? { "if-none-match": etag } : {} }), url, url.pathname, {}))!;
  try {
    const initial = await ask();
    expect(initial.status).toBe(200);
    const body = await initial.json();
    expect(body.source).toBe("dsh-transcript");
    expect(body.turns[0].parts[0]).toEqual({ kind: "text", text: "Hello" });
    const etag = initial.headers.get("etag")!;
    expect((await ask(etag)).status).toBe(304);
    rows.push({ type: "user/message", seq: 1, data: { source: { kind: "user" }, content: [{ type: "text", text: "Again" }] } });
    await save();
    const appended = await ask(etag);
    expect(appended.status).toBe(200);
    expect((await appended.json()).turns).toHaveLength(2);
    expect(appended.headers.get("etag")).not.toBe(etag);
    memory.mockResolvedValue({ argv: [], environ: [`HOME=${root}`, `DSH_HOME=${join(root, "another-home")}`] });
    expect((await (await ask()).json()).source).toBe("scrollback");
    expect(await toolOutput(pane.pane_id, "missing-output")).toBeNull();
    memory.mockResolvedValue({ argv: [], environ: [`HOME=${root}`, `DSH_HOME=${root}`] });
    processInfo.mockRejectedValue(new Error("process lookup failed"));
    const unavailable = await ask();
    expect(unavailable.status).toBe(200);
    expect((await unavailable.json()).source).toBe("scrollback");
    expect(await toolOutput(pane.pane_id, "missing-output")).toBeNull();
  } finally {
    rpc.mockRestore();
    memory.mockRestore();
    forgetDshProcesses();
    snapshot.mockRestore();
    processInfo.mockRestore();
    forgetPaneTranscriptState(pane.pane_id);
    forgetTranscriptState();
    await lock.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, agent, argv, source] of [
  ["routes a pane herdr leaves unlabeled to the dsh reader through the one process probe", undefined, DSH_ARGV, "dsh-transcript"],
  ["routes herdr's dsh-tui label to the dsh reader", "dsh-tui", DSH_ARGV, "dsh-transcript"],
  ["routes a dsh-tui pane whose host process holds the lock behind its launcher shims", "dsh-tui", ["/usr/bin/node", "/home/user/.dsh/profiles/dsh-tui/node_modules/@deepseek-harness-tui/dsh-tui/lib/types/dsh-adapter/host-entry.js"], "dsh-transcript"],
  ["keeps an unlabeled pane running another node program on the terminal", undefined, ["node", "server.js", "dsh"], "scrollback"],
] as const) linuxTest(label, async () => {
  const root = await mkdtemp(join(tmpdir(), "ovis-dsh-route-"));
  const session = "1dacc7bc-68e8-4934-baec-ba181b8251f9";
  const folder = join(root, "sessions", "--workspace--", session);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "session.v4.jsonl"), [
    { type: "session", version: 4, id: session, delegationDepth: 0 },
    { type: "user/message", seq: 0, data: { source: { kind: "user" }, content: [{ type: "text", text: "Hello" }] } },
  ].map(row => JSON.stringify(row)).join("\n") + "\n");
  const lock = await open(join(folder, "session.lock"), "w");
  const pane = { pane_id: `dsh-route-${agent ?? "none"}-${argv[1]}`, agent, agent_status: agent ? "idle" : "unknown", cwd: root };
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane], agents: [] } as unknown as SessionSnapshot);
  const foreground = { foreground_processes: [{ pid: process.pid, argv: [...argv] }] };
  const processInfo = spyOn(herdr, "paneProcessInfo").mockResolvedValue(foreground as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  const calls: unknown[][] = [];
  const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string, params: unknown) => {
    calls.push([method, params]);
    if (method === "pane.process_info") return { process_info: foreground };
    throw new Error(`unexpected herdr RPC ${method}`);
  }) as typeof herdr.herdrRpc);
  const memory = spyOn(processProbe, "ompProcessMemory").mockResolvedValue({ argv: [], environ: [`HOME=${root}`, `DSH_HOME=${root}`] });
  const url = new URL("http://x/api/pane/conversation?pane_id=" + encodeURIComponent(pane.pane_id));
  try {
    const response = (await handlePaneRequest(new Request(url), url, url.pathname, {}))!;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe(source);
    if (source === "dsh-transcript") expect(body.turns[0].parts[0]).toEqual({ kind: "text", text: "Hello" });
    // a dsh pane costs one process_info per lookup, asked by pane_id, whichever path found its processes
    const asked = calls.filter(([method]) => method === "pane.process_info").length + processInfo.mock.calls.length;
    if (source === "dsh-transcript") expect(asked).toBe(1);
    for (const [, params] of calls) expect(params).toEqual({ pane_id: pane.pane_id });
  } finally {
    rpc.mockRestore();
    memory.mockRestore();
    forgetDshProcesses();
    snapshot.mockRestore();
    processInfo.mockRestore();
    forgetPaneTranscriptState(pane.pane_id);
    forgetTranscriptState();
    await lock.close();
    await rm(root, { recursive: true, force: true });
  }
});
