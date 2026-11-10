import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, PanePromptResponse, SlashCommand } from "../shared/protocol.ts";
import * as client from "./herdr/client.ts";
import * as conversation from "./conversation.ts";
import * as omo from "./omo.ts";
import * as processStart from "./process-start.ts";
import { bindCommandProcess, commandSendFrom, handlePromptRequest, noteSubmitted } from "./prompt.ts";

const roots: string[] = [];
afterEach(() => { mock.restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Foreground = { pid: number; name: string; argv: string[] };
/**
 * The pids the fake herdr reports are above any pid_max (Linux allows none over 2 ** 22), so no
 * process or thread of this host is at one. herdr gives these processes no cwd of their own, and
 * the server then reads /proc/<pid>/cwd: a live one there would place the OmO in its own folder,
 * not in the pane's, and its holder would not be its.
 */
const PID = 2 ** 22 + 41000;

/**
 * An OmO pane whose session holders are `holderPids`, with herdr giving no per-process cwd (macOS), so the pane's
 * own directory places them. Each listed process runs under `state.start`, and is gone once it is not listed.
 */
function omoPane(holderPids: number[]) {
  const root = mkdtempSync(join(tmpdir(), "ovis-outcome-omo-holder-")); roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  const holders = join(agentDir, "sessions", omo.omoSessionFolder(cwd), "session-holders", "sess-1");
  mkdirSync(holders, { recursive: true });
  for (const pid of holderPids) writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, processStartedAtMs: 1_000, cwd }));
  // `readStart`: what a synchronous start read finds instead, as when the pid changed hands after the holder check
  const state = { foreground: [] as Foreground[], start: 1_000, readStart: undefined as number | undefined };
  const listed = (pid: number) => state.foreground.some((entry) => entry.pid === pid);
  spyOn(processStart, "processStartedAtAsync").mockImplementation(async (pid) => listed(pid) ? state.start : null);
  spyOn(processStart, "processStartedAt").mockImplementation((pid) => listed(pid) ? state.readStart ?? state.start : null);
  spyOn(processStart, "processAlive").mockImplementation((pid) => listed(pid));
  spyOn(omo, "processEnviron").mockReturnValue([`OMO_CODING_AGENT_DIR=${agentDir}`]);

  const pane = { pane_id: "outcome-omo-holder", terminal_id: "term", workspace_id: "w", tab_id: "t", focused: false, revision: 0,
    agent: "omo", agent_status: "idle", cwd, agent_session: null } as HerdrPane;
  const info = () => ({ pane_id: pane.pane_id, shell_pid: PID, foreground_processes: state.foreground });
  spyOn(client, "sessionSnapshot").mockImplementation(async () => ({ panes: [pane], layouts: [], agents: [], workspaces: [], tabs: [], protocol: 22, version: "fixture" }));
  spyOn(client, "paneRead").mockResolvedValue({ ...pane, text: "", source: "detection", format: "text", truncated: false } as Awaited<ReturnType<typeof client.paneRead>>);
  spyOn(client, "paneProcessInfo").mockImplementation(async () => info());
  spyOn(client, "herdrRpc").mockImplementation((async (method: string) => {
    if (method === "agent.get") return { agent: pane };
    if (method === "pane.process_info") return { process_info: info() };
    throw new Error(`fixture: unexpected ${method}`);
  }) as typeof client.herdrRpc);
  spyOn(conversation, "readCommandTranscript").mockResolvedValue(null);
  const served = async (): Promise<string[] | undefined> => {
    const url = new URL(`http://localhost/api/pane/prompt?pane_id=${pane.pane_id}`);
    return (await (await handlePromptRequest(new Request(url), url))?.json() as PanePromptResponse).outcomes?.map(({ id }) => id);
  };
  const send = async () => {
    const row: SlashCommand = { name: "context", source: "builtin", description: "", forms: [{ match: "bare", interaction: "none" }, { match: "other", interaction: "none" }] };
    const command = commandSendFrom(pane, "omo", [row], "/context");
    if (!command) throw new Error("fixture command was not recorded");
    bindCommandProcess(pane.pane_id, command, info(), pane);
    await command.visibility?.binding;
    noteSubmitted(pane.pane_id, command.text, command);
    return command;
  };
  // herdr reports the session the OmO started, under the label it gives an OmO pane
  const reportSession = () => { pane.agent_session = { agent: "pi", kind: "path", source: "herdr:pi", value: join(root, "omo-first.jsonl") }; };
  return { state, served, send, reportSession };
}

// an argv-silent custom OmO, known by its session holder alone, and the bundled Claude SDK child it runs a turn in,
// which looks like omo by its path and exits when the turn ends while the OmO and its session stay (#1985)
const parent: Foreground = { pid: PID + 1, name: "run", argv: ["/opt/team-ai/bin/run"] };
const sdk: Foreground = { pid: PID + 2, name: "claude", argv: ["/opt/node_modules/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"] };

it("keeps a command's outcome on a custom OmO whose SDK child exits at the end of the turn", async () => {
  const fixture = omoPane([parent.pid]);
  fixture.state.foreground = [parent, sdk];
  const command = await fixture.send();
  expect(command.visibility?.process?.pid).toBe(parent.pid);
  expect(await fixture.served()).toEqual([command.id]);

  // the turn ended: the SDK child is gone, the OmO it went to runs on, and its session is adopted
  fixture.state.foreground = [parent];
  expect(await fixture.served()).toEqual([command.id]);
  fixture.reportSession();
  expect(await fixture.served()).toEqual([command.id]);
  expect(await fixture.served()).toEqual([command.id]);

  // the OmO itself is gone: its row goes with it
  fixture.state.foreground = [];
  expect(await fixture.served()).toBeUndefined();
});

it("keeps the OmO a command was bound to when another holder of the session comes before it, without reading holders on each poll", async () => {
  const peer: Foreground = { pid: PID + 3, name: "run", argv: ["/opt/team-ai/bin/run-peer"] };
  const fixture = omoPane([parent.pid, peer.pid]);
  fixture.state.foreground = [parent, peer, sdk];
  const command = await fixture.send();
  expect(command.visibility?.process?.pid).toBe(parent.pid);
  const holderReads = spyOn(omo, "heldOmoProcess");

  fixture.state.foreground = [peer, parent, sdk];
  fixture.reportSession();
  expect(await fixture.served()).toEqual([command.id]);
  fixture.state.foreground = [peer, parent];
  expect(await fixture.served()).toEqual([command.id]);
  expect(holderReads).not.toHaveBeenCalled();
});

it("binds a command to the OmO its holder check verified, not a process that got its pid before the next start read (#2190)", async () => {
  const fixture = omoPane([parent.pid]);
  fixture.state.foreground = [parent, sdk];
  // the holder check read the OmO's own start; by the next read its pid belongs to a process started later
  fixture.state.readStart = 9_000;
  const command = await fixture.send();
  expect(command.visibility?.process).toEqual({ pid: parent.pid, started: 1_000, held: true });

  // that later process is not the OmO the command went to: its row does not follow it
  fixture.state.start = 9_000;
  fixture.state.readStart = undefined;
  fixture.reportSession();
  expect(await fixture.served()).toBeUndefined();
});

for (const platform of ["linux", "darwin"] as const) {
  it(`does not take another program that got the OmO's pid later for it, on ${platform}`, async () => {
    const real = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      const fixture = omoPane([parent.pid]);
      fixture.state.foreground = [parent, sdk];
      const command = await fixture.send();
      expect(command.visibility?.process?.pid).toBe(parent.pid);
      expect(await fixture.served()).toEqual([command.id]);

      // the OmO exited before herdr reported its session; long after, a Claude Code got its pid in the same terminal
      fixture.state.foreground = [{ pid: parent.pid, name: "claude", argv: ["claude"] }];
      fixture.state.start = 2_000;
      fixture.reportSession();
      expect(await fixture.served()).toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", real);
    }
  });
}
