import { afterAll, afterEach, mock, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { HerdrPane } from "../../shared/protocol.ts";
import * as collector from "../collector.ts";
import * as conversation from "../conversation.ts";
import * as herdr from "../herdr/client.ts";
import * as service from "../opencode-service.ts";
import { PendingInputs } from "../pending-input.ts";
import { connectionData, type Client } from "./connections.ts";

// herdr's status events come from the test, as the collector would hand them over
type Handlers = { onStatus: collector.StatusCollectorHandlers["onStatus"]; onBaseline: (panes: readonly unknown[]) => void; onReconciled: (panes: readonly HerdrPane[]) => void; onResync: NonNullable<collector.StatusCollectorHandlers["onResync"]>; onPaneEnded: (paneId: string) => void; onPaneClosed: (paneId: string) => void; herdrLive?: { identity: () => string | null; onChange: (identity: string | null) => void } };
export let handlers: Handlers;
export let collectorSnapshot: () => Promise<{ panes: HerdrPane[] }>;
export const originalCollector = collector.startStatusCollector;
mock.module("../collector.ts", () => ({
  ...collector,
  startStatusCollector: (seen: Handlers, deps: { snapshot: typeof collectorSnapshot }) => {
    collectorSnapshot = deps.snapshot;
    handlers = seen;
    return { ready: Promise.resolve(), structureReady: Promise.resolve(), focusReady: Promise.resolve(), trackPane() {}, stop() {} };
  },
}));
const { createStatusHub } = await import("./status.ts");

export const root = mkdtempSync(join(tmpdir(), "herdr-status-hub-"));
afterAll(() => {
  mock.module("../collector.ts", () => ({ ...collector, startStatusCollector: originalCollector }));
  rmSync(root, { recursive: true, force: true });
});
const stubs: { mockRestore(): void }[] = [];
afterEach(() => { for (const stub of stubs.splice(0)) stub.mockRestore(); });

// an OpenCode parent session whose one child runs, and a resting Claude session with a background subagent its prompt started
export const at = Date.now() - 10_000;
const store = join(root, "opencode.db");
{
  const db = new Database(store, { create: true });
  db.exec(`CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, time_created integer);
    CREATE TABLE session_message (id text PRIMARY KEY, session_id text, type text, seq integer, time_created integer, time_updated integer, data text)`);
  db.query("INSERT INTO session_v2 VALUES ('ses_child', 'ses_parent', ?)").run(at + 1000);
  const row = db.query("INSERT INTO session_message VALUES (?, ?, 'user', 1, ?, ?, ?)");
  row.run("msg_parent", "ses_parent", at, at, JSON.stringify({ time: { created: at } }));
  row.run("msg_child", "ses_child", at + 1000, at + 1000, JSON.stringify({ time: { created: at + 1000 } }));
  db.close();
}
const CLAUDE = "11111111-1111-4111-8111-111111111111";
const transcript = join(root, `${CLAUDE}.jsonl`);
{
  const line = (value: unknown) => `${JSON.stringify(value)}\n`;
  mkdirSync(join(root, CLAUDE, "subagents"), { recursive: true });
  writeFileSync(transcript, line({ type: "user", origin: { kind: "human" }, timestamp: new Date(at - 1000).toISOString(), permissionMode: "default", message: { role: "user", content: "go" } }));
  writeFileSync(join(root, CLAUDE, "subagents", "agent-a1.meta.json"), JSON.stringify({ agentType: "reviewer", description: "review", toolUseId: "toolu_a1", requestShape: "background" }));
  writeFileSync(join(root, CLAUDE, "subagents", "agent-a1.jsonl"), line({ isSidechain: true, sessionId: CLAUDE, agentId: "a1", type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: "review" } }));
}

const base = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", agent_status: "idle" };
export const opencode = (session: string | null) => ({ ...base, agent: "opencode", ...(session ? { agent_session: { agent: "opencode", source: "herdr:opencode", kind: "id", value: session } } : {}) });
export const claude = { ...base, agent: "claude", agent_session: { agent: "claude", source: "hook", kind: "id", value: CLAUDE } };

let hubs = 0;
/**
 * The status hub with herdr, OpenCode's service and the Claude lookup stood in for; what a browser and web push are sent.
 * `herdrIdentity`: what the stood-in herdr's socket reads as (server/finishes.ts), when a test needs one.
 */
export function hub<Owner = unknown, Lease = unknown>(path = transcript, queued?: PendingInputs<Owner, Lease>, drain?: (paneId: string) => void, herdrIdentity?: () => string | null) {
  let panes: unknown[] = [];
  let gate: Promise<void> | null = null;
  let reading: (() => void) | undefined;
  const lookups: Promise<unknown>[] = [];
  const polls: Promise<void>[] = [];
  const answer = () => ({ agents: [], layouts: [], panes: structuredClone(panes), protocol: 1, tabs: [], version: "test", workspaces: [] });
  stubs.push(
    spyOn(herdr, "sessionSnapshot").mockImplementation(async () => { const read = answer(); reading?.(); if (gate) await gate; return read as never; }),
    spyOn(herdr, "paneGet").mockImplementation(() => { const read = Promise.resolve(structuredClone(panes[0]) as never); lookups.push(read); return read; }),
    spyOn(herdr, "paneProcessInfo").mockResolvedValue(undefined),
    spyOn(service, "readOpenCodeService").mockReturnValue(null),
    spyOn(conversation, "claudePaneSession").mockResolvedValue({ path, startedAt: null, pid: null } as never),
    spyOn(conversation, "claudePanePid").mockResolvedValue(null as never),
  );
  const frames: { type: string; agent_status?: string; background_tasks?: number; background_wait?: boolean }[] = [];
  const client: Client = { data: connectionData({ deviceId: undefined, readOnly: false }), readyState: WebSocket.OPEN, getBufferedAmount: () => 0, send: (encoded: string) => { frames.push(JSON.parse(encoded)); return 1; }, close: () => {} };
  const pending = queued ?? new PendingInputs<Owner, Lease>(() => {});
  /** panes whose held messages were turned away, and why */
  const held: { paneId: string; code: string }[] = [];
  const status = createStatusHub({
    options: { stateDir: join(root, `state${++hubs}`), opencodeDb: store, machines: false, ...(herdrIdentity ? { herdrIdentity } : {}) },
    devices: { gated: false, has: () => true, onPaired: () => {} } as never, preferences: { get: () => ({ muted_panes: [] }), subscribe: () => () => {} } as never,
    clients: new Set([client]), present: new Set(), pending, drainPending: drain ?? (() => {}), holdPendingPane: (paneId, fault) => { held.push({ paneId, code: fault.code }); },
    usage: { invalidate() {} } as never, usageLogin: { ended: () => false } as never,
  });
  const alerts: string[] = [];
  const poll = status.opencodeAgents.poll.bind(status.opencodeAgents);
  stubs.push(spyOn(status.opencodeAgents, "poll").mockImplementation((only) => { const read = poll(only); polls.push(read); return read; }));
  stubs.push(spyOn(status.push, "onStatus").mockImplementation(async (_paneId: string, alert: string) => { alerts.push(alert); }));
  stubs.push({ mockRestore: () => { status.collector.stop(); status.omo.stop(); status.gjc.stop(); status.claudeAgents.stop(); status.opencodeAgents.stop(); status.plans.stop(); clearInterval(status.waitTimer); } });
  const ended: string[] = [];
  stubs.push(spyOn(status.push, "onEnded").mockImplementation(async (paneId: string) => { ended.push(paneId); }));
  return {
    alerts, pending, status, held,
    /** "terminal ended" alerts sent: push's and the pane-exited frames clients alert from */
    ended: () => ({ push: [...ended], frames: frames.filter((seen) => seen.type === "pane-exited").length }),
    /** herdr's panes from now on, as a snapshot or a pane lookup reads them */
    herdrSays: (pane: unknown) => { panes = [pane]; },
    /** a snapshot, both trackers reading it (Claude's lookup awaited) */
    snapshot: async () => { const snapshot = await status.clientSnapshot(); await status.claudeAgents.refresh(panes as HerdrPane[]); return snapshot; },
    /** a snapshot whose read begins now and is answered when `open` is called */
    heldSnapshot: async () => {
      const opened = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      gate = opened.promise;
      reading = started.resolve;
      const read = status.clientSnapshot();
      await started.promise;
      gate = null;
      reading = undefined;
      return async () => { opened.resolve(); await read; };
    },
    /** the pane's last status frame */
    last: () => {
      const frame = frames.filter((seen) => seen.type === "pane-status").at(-1);
      return { status: frame?.agent_status, tasks: frame?.background_tasks ?? 0, bg: frame?.background_wait === true };
    },
    /** the Claude tracker's poll, as its timer runs it */
    poll: () => status.claudeAgents.poll(),
    /** the lookups and reads a status event set off */
    settle: async () => { await Promise.all(lookups); await Promise.all(polls); },
  };
}

export const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const ts = (ms: number) => new Date(at + ms).toISOString();
let fixtures = 0;
/** Each turn regression has its own transcript, parent session and streaming child. */
export async function workingClaude<Owner = unknown, Lease = unknown>(queued?: PendingInputs<Owner, Lease>, drain?: (paneId: string) => void) {
  const id = `33333333-3333-4333-8333-${String(++fixtures).padStart(12, "0")}`;
  const path = join(root, `${id}.jsonl`);
  const dir = join(root, id, "subagents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, line({ type: "user", origin: { kind: "human" }, timestamp: ts(-1000), message: { role: "user", content: "go" } }));
  const child = join(dir, "agent-b1.jsonl");
  writeFileSync(join(dir, "agent-b1.meta.json"), JSON.stringify({ agentType: "reviewer", toolUseId: "toolu_b1", requestShape: "background" }));
  writeFileSync(child, line({ isSidechain: true, sessionId: id, agentId: "b1", type: "user", timestamp: ts(0), message: { role: "user", content: "review" } }));
  const pane = { ...claude, agent_session: { ...claude.agent_session, value: id } };
  const h = hub(path, queued, drain);
  h.herdrSays(pane);
  handlers.onBaseline([pane]);
  await h.snapshot();
  h.herdrSays({ ...pane, agent_status: "working" });
  handlers.onStatus(pane.pane_id, "working", "claude");
  return { ...h, path, pane, child,
    rest: () => appendFileSync(path, line({ type: "system", subtype: "turn_duration", timestamp: ts(300) })),
    next: () => appendFileSync(path, line({ type: "user", origin: { kind: "human" }, timestamp: ts(5000), message: { role: "user", content: "next" } })),
  };
}
