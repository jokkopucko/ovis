import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane, ServerMessage, SessionSnapshot } from "../../shared/protocol.ts";
import * as client from "../herdr/client.ts";
import * as omo from "../omo.ts";
import * as processStart from "../process-start.ts";
import * as prompt from "../prompt.ts";
import { connectionData, type Client } from "./connections.ts";
import { createPendingDelivery } from "./pending.ts";

const roots: string[] = [];
afterEach(() => { mock.restore(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Foreground = { pid: number; name: string; argv: string[] };

// An argv-silent custom OmO is known by its session holder alone; the bundled Claude SDK child it runs a turn in
// looks like omo by its path and exits when the turn ends, while the OmO and its session stay (#1545).
const parent: Foreground = { pid: 41001, name: "run", argv: ["/opt/team-ai/bin/run"] };
const sdk: Foreground = { pid: 41002, name: "claude", argv: ["/opt/node_modules/omo-ai/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"] };

/** A working OmO pane whose session holders are `holderPids`, all started at 1 000, with herdr giving no per-process cwd (macOS). */
function omoPane(holderPids: number[], foreground: Foreground[]) {
  const root = mkdtempSync(join(tmpdir(), "ovis-pending-omo-holder-")); roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  const holders = join(agentDir, "sessions", omo.omoSessionFolder(cwd), "session-holders", "sess-1");
  mkdirSync(holders, { recursive: true });
  for (const pid of holderPids) writeFileSync(join(holders, `${pid}.json`), JSON.stringify({ pid, processStartedAtMs: 1_000, cwd }));
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1_000);
  spyOn(processStart, "processStartedAt").mockReturnValue(1_000);
  spyOn(omo, "processEnviron").mockReturnValue([`OMO_CODING_AGENT_DIR=${agentDir}`]);
  // herdr gives no per-process cwd here (macOS): the pane's own directory places the OmO
  const state = { foreground };
  spyOn(client, "paneProcessInfo").mockImplementation(async () => ({ pane_id: "p", shell_pid: 41000, foreground_processes: state.foreground }));
  spyOn(client, "paneRead").mockResolvedValue({ text: "" } as Awaited<ReturnType<typeof client.paneRead>>);
  const writes: string[] = [];
  spyOn(client, "paneSendText").mockImplementation(async (_pane: string, text: string) => { writes.push(text); });
  spyOn(client, "paneSendKeys").mockResolvedValue(undefined);

  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "omo", agent_status: "working", cwd, focused: false, revision: 0 } as HerdrPane;
  const frames: ServerMessage[] = [];
  const owner = { data: connectionData({ deviceId: undefined, readOnly: false }), getBufferedAmount: () => 0, send: (value: string) => { frames.push(JSON.parse(value)); return 1; } } as Client;
  owner.data.attached.set("p", { keepSize: false });
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(_pane: string, task: () => T | Promise<T>): Promise<T> => { const run = tail.catch(() => {}).then(task); tail = run; return run; };
  const facts = { attached: true, origin: true, sameAttachment: true, samePty: true, sameClaim: true, claimed: true, member: true, ready: true, held: false, currentHeld: false, mirror: false, cols: 120 };
  const delivery = createPendingDelivery({
    options: { submitDelayMs: 0 }, clients: new Set([owner]), attachments: new Map(),
    sight: (() => ({ facts: () => facts, write: () => {} })) as unknown as Parameters<typeof createPendingDelivery>[0]["sight"],
    serialize, lastTyped: new Map(), submitText: async () => {}, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [pane] }) as unknown as SessionSnapshot,
    omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1_000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  });
  const settle = async () => { for (let turn = 0; turn < 6; turn++) { await tail.catch(() => {}); await new Promise(setImmediate); } };
  const queue = async (text: string, agentOnly = false) => {
    await delivery.pendingFrames.submit(owner, { type: "submit", id: 1, pane_id: "p", text, payload: text, delivery: "queue", ...(agentOnly ? { agent_only: true } : {}) });
    await settle();
    const queued = frames.find((frame) => frame.type === "submit-result") as Extract<ServerMessage, { type: "submit-result" }> | undefined;
    return delivery.pending.get(owner, "p", queued!.pending!.id)!;
  };
  const drain = async () => {
    pane.agent_status = "idle";
    delivery.pending.status("p", "idle");
    delivery.drainPending("p");
    await settle();
  };
  return { state, writes, queue, drain };
}

it("delivers a queued follow-up to a custom OmO whose SDK child exits at the end of the turn", async () => {
  const fixture = omoPane([parent.pid], [parent, sdk]);
  const item = await fixture.queue("FOLLOWUP");
  expect(item.identity.processPid).toBe(parent.pid);

  fixture.state.foreground = [parent];
  await fixture.drain();
  expect(item.message.error?.code).toBeUndefined();
  expect(fixture.writes).toEqual(["\x1b[200~FOLLOWUP\x1b[201~"]);
});

it("binds a queued command's outcome to the OmO it was queued for when another holder comes before it, without reading holders again (#2190)", async () => {
  const peer: Foreground = { pid: 41003, name: "run", argv: ["/opt/team-ai/bin/run-peer"] };
  const fixture = omoPane([parent.pid, peer.pid], [parent, peer, sdk]);
  const item = await fixture.queue("/context");
  expect(item.identity.processPid).toBe(parent.pid);

  const holderReads = spyOn(omo, "heldOmoProcess");
  const realBind = prompt.bindCommandProcess;
  const bound: Parameters<typeof prompt.bindCommandProcess>[1][] = [];
  spyOn(prompt, "bindCommandProcess").mockImplementation((...args: Parameters<typeof prompt.bindCommandProcess>) => {
    bound.push(args[1]);
    realBind(...args);
  });
  // herdr lists the other holder first by the time the turn ends
  fixture.state.foreground = [peer, parent];
  await fixture.drain();
  expect(item.message.error?.code).toBeUndefined();
  expect(fixture.writes).toEqual(["\x1b[200~/context\x1b[201~"]);
  expect(bound).toHaveLength(1);
  await bound[0]?.visibility?.binding;
  expect(bound[0]?.visibility?.process).toEqual({ pid: parent.pid, started: 1_000, held: true });
  // the pending checks read the holders for the queued process; the binding reads none of its own
  expect(holderReads.mock.calls.map((call) => call[3])).toEqual(holderReads.mock.calls.map(() => parent.pid));
  expect(holderReads).toHaveBeenCalled();
});

// #511: a session holder record outlives an exec at its PID (same PID, start and cwd), so it is no proof of the agent for a
// message only an agent may take: after the OmO execs ash under its paste, the Enter is held back
it("holds back the Enter of an agent-only message when the OmO holding its session execs ash after the paste", async () => {
  const omoProgram: Foreground = { pid: 41001, name: "omo", argv: ["/usr/local/bin/omo"] };
  const fixture = omoPane([omoProgram.pid], [omoProgram]);
  const enter = client.paneSendKeys as unknown as { mock: { calls: unknown[] } };
  (client.paneSendText as unknown as { mockImplementation: (run: (pane: string, text: string) => Promise<void>) => void }).mockImplementation(async (_pane, text) => {
    fixture.writes.push(text);
    fixture.state.foreground = [{ pid: 41001, name: "ash", argv: ["ash"] }];
  });
  const item = await fixture.queue("> backup.txt\nkeep it", true);
  expect(item.identity.processPid).toBe(omoProgram.pid);
  await fixture.drain();
  expect(fixture.writes).toEqual(["\u001b[200~> backup.txt\nkeep it\u001b[201~"]);
  expect(enter.mock.calls).toEqual([]);
  expect(item.message).toMatchObject({ state: "uncertain", error: { code: "pasted_not_sent" } });
});
