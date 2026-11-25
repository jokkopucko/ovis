import { chmodSync, lstatSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";
import { HubConnections } from "./connections.ts";
import { HARNESS_CONTRACT, HARNESS_LIMITS, TOOL_SCHEMAS, VIEW_VERBS, answer, harnessVerb, isRecord, isView, refuse, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { projectSafeCommand } from "../entries.ts";
import { coreConnection } from "../herdr-core/runtime.ts";
import { AcpStartFailed, AcpUnavailable, type AcpChildren } from "../acp/children.ts";
import { KeeperRequestError } from "../acp/client.ts";
import { resolveHarness, type HarnessCommand } from "./harnesses.ts";
import { AGENT_MCP_SERVER, askable, askRefusal, permissionLaunch } from "./permission-launch.ts";
import { RunStore, type Run } from "./runs.ts";
import { Ledger, type ToolChild } from "./ledger.ts";
import { validArgs } from "./guards.ts";
import { ChildTurns, childRef, childState } from "./turns.ts";
import { HarnessView, type ViewOptions } from "./view.ts";
import { PaneGrants } from "./pane-grants.ts";
import { provePane, socketPeer, stillIn, type PaneReader } from "./pane-proof.ts";

interface Options extends ViewOptions {
  readonly acp: AcpChildren;
  readonly dir: string;
  readonly setting: () => HarnessToolSetting;
  readonly now?: () => number;
  readonly resolve?: (kind: string) => HarnessCommand | null;
  /** this PC's herdr-core panes; tests give their own */
  readonly panes?: PaneReader;
}
const PANE_CALL_FIELDS = new Set(["contract", "id", "principal", "pane_hint", "verb", "args"]);
const hcPanes: PaneReader = {
  list: async () => (await coreConnection().call("terminal.list", {})).terminals,
  get: address => coreConnection().call("terminal.get", { terminal: address }).catch(() => null),
};
const paneLabel = (t: { name?: string | null; title?: string }, address: string) => (t.name || t.title || address).replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 80) || address;
export class AgentToolHub {
  readonly address: string;
  readonly runs: RunStore;
  readonly grants: PaneGrants;
  private server: Server | null = null;
  private readonly connections = new HubConnections();
  private readonly ledger: Ledger;
  private readonly turns: ChildTurns;
  private readonly view: HarnessView;
  private readonly now: () => number;
  private readonly waits = new Map<string, number>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly off: () => void;
  private closed = false;
  constructor(private readonly options: Options) {
    this.address = join(options.dir, "hub.sock");
    this.runs = new RunStore(options.dir);
    this.grants = new PaneGrants(options.dir, this.runs);
    this.now = options.now ?? Date.now;
    this.ledger = new Ledger(options.dir);
    this.turns = new ChildTurns(this.ledger, options.acp, this.now);
    this.view = new HarnessView(options, options.acp, this.ledger);
    this.off = options.acp.onStatus(child => {
      const row = this.ledger.children.get(child.terminal);
      if (row?.id === child.id && (child.client.keeperGone || child.client.agentGone)) {
        this.runs.revoke(row.run);
        if (child.client.keeperGone) { this.turns.forget(child); return; }
      }
      this.turns.watch(child);
    });
    this.settingsChanged();
  }
  get setting() { return this.options.setting(); }
  private verbs(principal: { depth: number; ceiling?: string }): readonly string[] {
    const policy = this.setting;
    return policy.level === "off" ? [] : policy.level === "start" && (principal.ceiling || policy.harnesses.some(askable)) && principal.depth < policy.depth ? Object.keys(TOOL_SCHEMAS) : VIEW_VERBS;
  }
  reconcileLaunches() { return this.ledger.reconcile(this.options.acp); }
  settingsChanged(): void {
    if (this.setting.level !== "start") this.grants.clear();
    if (this.setting.level === "off") this.runs.revokeAll();
  }
  /** Drops the words on panes that closed while nobody asked (an Ovis restart, a missed vacate). */
  async reconcilePanes(): Promise<void> {
    const before = this.grants.known();
    this.grants.reconcile(await (this.options.panes ?? hcPanes).list(), before);
  }
  async answerPane(id: string, allow: boolean): Promise<"ok" | "gone"> {
    const pane = this.grants.view().pending.find(p => p.id === id)?.pane;
    const live = pane ? await (this.options.panes ?? hcPanes).get(pane) : null;
    // a pane Ovis launched since (its own token) or an ACP child is never also a tokenless one
    const taken = !pane || !!this.options.acp.forPane(pane) || this.runs.tokenManaged(pane) || !!live?.labels["ovis.acp"] || !!live?.labels["ovis.run"];
    return this.setting.level === "start" ? this.grants.answer(id, allow, taken ? null : live) : "gone";
  }
  listen(): void {
    if (this.server) return;
    if (process.platform === "win32" || Buffer.byteLength(this.address) > 100) throw new Error("Agent tool socket is not available at this path.");
    const existing = lstatSync(this.address, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error("Agent tool socket path is occupied.");
      rmSync(this.address);
    }
    const server = createServer(s => this.connections.receive(s, (body, signal, socket) => this.call(body, signal, socket)));
    server.on("error", () => console.warn("Agent tool socket unavailable."));
    const mask = process.umask(0o077);
    try { server.listen(this.address); chmodSync(this.address, 0o600); this.server = server; }
    finally { process.umask(mask); }
  }
  close(): void { this.closed = true; this.off(); this.connections.close(); this.turns.close(); this.server?.close(); this.server = null; }
  command(tokenFile: string) {
    const [command, ...args] = projectSafeCommand("agent-mcp");
    if (!command) throw new Error("Missing relay command.");
    return { name: AGENT_MCP_SERVER, command, args: [...args, "--socket", this.address, "--token-file", tokenFile], env: [] };
  }
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(id) ?? Promise.resolve();
    const next = prior.then(action, action);
    this.tails.set(id, next);
    try { return await next; } finally { if (this.tails.get(id) === next) this.tails.delete(id); }
  }
  private async call(input: unknown, signal: AbortSignal, socket: Socket): Promise<object> {
    if (!isRecord(input) || input.contract !== HARNESS_CONTRACT) return refuse("unknown_contract", "Unknown contract.");
    if ("principal" in input || "pane_hint" in input) return this.paneCall(input, signal, socket);
    const { token, verb, args } = input;
    const auth = () => !signal.aborted && !this.closed && this.setting.level !== "off" && typeof token === "string" ? this.runs.verify(token) : null;
    const deny = () => this.setting.level === "off" ? refuse("tools_off", "Agent tools are off.") : refuse("not_granted", "This run is not granted that operation.");
    const began = this.now();
    const run = auth();
    if (!run && verb === "scope" && !this.closed && this.setting.level !== "off" && typeof token === "string") {
      const reservation = this.runs.discovery(token);
      if (reservation) return answer("scope", { verbs: this.verbs(reservation) });
    }
    if (!run) return deny();
    return this.act(run, auth, deny, verb, args, signal, began);
  }
  /**
   * A call from a pane hc started, with no token: the kernel and hc say which pane (pane-proof.ts), and its owner's
   * word says whether that pane may (pane-grants.ts). The first call raises his card and does nothing else; nothing
   * the caller sends names the pane, and HC_TERMINAL_ID (`pane_hint`) can only fail the proof.
   */
  private async paneCall(input: Record<string, unknown>, signal: AbortSignal, socket: Socket): Promise<object> {
    const { verb, args, pane_hint: hint } = input;
    if (input.principal !== "pane" || Object.keys(input).some(k => !PANE_CALL_FIELDS.has(k)) || (hint !== undefined && (typeof hint !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(hint)))) return refuse("bad_request", "Invalid pane call.");
    if (verb !== "scope" && !(harnessVerb(verb) && validArgs(verb, args))) return refuse("bad_request", "Invalid or unexpected argument.");
    if (this.closed) return refuse("unavailable", "The Ovis server did not answer.");
    if (this.setting.level === "off") return refuse("tools_off", "Agent tools are off.");
    if (this.setting.level !== "start") return refuse("not_granted", "Let agents call other agents is off in Ovis.");
    const began = this.now();
    const peer = socketPeer(socket);
    if (!peer) return refuse("not_granted", "This process could not be traced to a pane.");
    try {
      const before = this.grants.known();
      const proof = await provePane(peer, hint, this.options.panes ?? hcPanes);
      if (!proof) return refuse("not_granted", "This process is not in one of this PC's herdr-core panes.");
      const { key, terminal } = proof;
      // the panes hc lists now: cards and grants of panes that closed unseen free their places before this one is counted
      this.grants.reconcile(proof.live, before);
      if (this.options.acp.forPane(key.pane) || terminal.labels["ovis.acp"] || terminal.labels["ovis.run"] || this.runs.tokenManaged(key.pane)) return refuse("not_granted", "Ovis started this pane's agent with a tool of its own.");
      if (signal.aborted || this.closed || this.setting.level !== "start") return refuse("not_granted", "The grant changed.");
      const word = this.grants.decide(key, paneLabel(terminal, key.pane));
      if (word.state !== "allowed") return word.state === "pending" ? refuse("approval_required", "Ask the person to allow this pane in Ovis, then run the command again.")
        : word.state === "denied" ? refuse("approval_denied", "The person did not allow this pane.") : refuse("rate_limited", "Too many panes are waiting for an answer.");
      const run = this.runs.paneRun(word.run);
      if (!run) return refuse("not_granted", "This pane's grant has ended.");
      // checked again at every step of the call: still a process of that pane, and the pane still allowed
      const auth = () => !signal.aborted && !this.closed && this.setting.level === "start" && stillIn(peer, key) && this.grants.allows(key, run.id);
      return await this.act(run, auth, () => refuse("not_granted", "This pane's grant has ended."), verb, args, signal, began);
    } finally { peer.close(); }
  }
  private async act(run: Run, auth: () => unknown, deny: () => ReturnType<typeof refuse>, verb: unknown, args: unknown, signal: AbortSignal, began: number): Promise<object> {
    if (!this.runs.takeCall(run.id, this.now())) return refuse("rate_limited", "Too many calls in the past minute.");
    if (verb === "scope") {
      const verbs = this.verbs(run);
      const ownsChild = !verbs.includes("stop") && [...this.ledger.children.values()].some(row => row.starter === run.id);
      return answer("scope", { verbs: ownsChild ? [...verbs, "stop"] : verbs });
    }
    if (!harnessVerb(verb)) return refuse("bad_request", "Unknown verb.");
    if (!isView(verb) && verb !== "stop" && this.setting.level !== "start") return deny();
    if (!validArgs(verb, args)) return refuse("bad_request", "Invalid or unexpected argument.");
    const privilegedRead = verb === "read" && (args.what === "result" || args.what === "screen");
    if (privilegedRead && !this.verbs(run).includes("result")) return deny();
    if (isView(verb)) {
      const result = await this.view.query(verb, args, this.turns);
      return auth() && (!privilegedRead || this.verbs(run).includes("result")) ? result : deny();
    }
    const allowed = () => !!auth() && (verb === "stop" || this.verbs(run).includes(verb));
    const session = String(args.session ?? "");
    if (verb === "start" || verb === "ask") {
      if (!run.ceiling && run.depth < this.setting.depth && (!askable(String(args.harness)) || !this.setting.harnesses.includes(String(args.harness)))) return refuse("not_granted", "This harness has no verified ask-for-everything launch.");
      if (!allowed()) return refuse("depth_exceeded", "This run is at its depth limit.");
      const started = await this.serial(run.id, async () => {
        if (!allowed()) return deny();
        return this.start(run, args, allowed);
      });
      if (verb === "start" || !("session" in started) || started.kind !== "session") return started;
      if ("send_error" in started) return started;
      const ref = started.session;
      const remaining = Math.max(0, HARNESS_LIMITS.wait_seconds - (this.now() - began) / 1000);
      const turnId = started.sent?.turn_id;
      const waiting = await this.wait(run, ref.address, { ...args, turn: turnId, timeout_s: Math.min(Number(args.timeout_s ?? 30), remaining) }, signal);
      if (!allowed()) return deny();
      if (!("state" in waiting)) return waiting;
      const child = this.options.acp.forPane(ref.address), row = this.ledger.children.get(ref.address);
      const result = child && row && waiting.state.state === "done" ? this.turns.result(child, row, turnId) : null;
      const payload = result?.kind === "result" ? (({ contract: _contract, kind: _kind, session: _session, ...body }) => body)(result) : null;
      return answer("ask", { session: ref, state: waiting.state, sent: started.sent, result: payload });
    }
    if (session === run.self) return refuse("self_target", "A run cannot target itself.");
    if (this.runs.ancestors(run).includes(session)) return refuse("ancestor_target", "A run cannot target an ancestor.");
    if (!allowed()) return deny();
    const row = this.ledger.children.get(session);
    if (!row) return refuse("unknown_session", "Unknown session.");
    if (row.starter !== run.id) return refuse("not_owner", "Not your child.");
    const child = this.options.acp.forPane(session);
    if (!child || child.id !== row.id) return refuse("unknown_session", "The child has ended.");
    await child.client.ready(signal);
    if (!allowed()) return deny();
    this.turns.watch(child);
    if (verb === "result") return this.turns.result(child, row, args.turn);
    if (verb === "wait") {
      const result = await this.wait(run, session, args, signal);
      return allowed() ? result : deny();
    }
    return this.serial(run.id, async () => {
      if (!allowed()) return deny();
      if (this.options.acp.forPane(session) !== child) return refuse("unknown_session", "The child has ended.");
      if (verb === "send") {
        const cmd = (this.options.resolve ?? resolveHarness)(row.harness);
        const verified = cmd && permissionLaunch(row.harness, run.ceiling, row.run, cmd)?.ceiling;
        if (!verified || verified.mode !== child.client.sessionMode) return deny();
        return this.turns.send(child, row, args, verified.mode);
      }
      if (row.held || child.client.terminalReady) return refuse("taken_over", "A person holds this session.");
      try {
        const receipt = await child.client.request("_keeper/tool_stop", {}, signal);
        if (!isRecord(receipt) || receipt.stopping !== true) return refuse("unavailable", "Keeper did not confirm stop.");
      } catch (error) {
        if (error instanceof KeeperRequestError && error.code === -32002) return refuse("taken_over", "A person holds this child.");
        throw error;
      }
      await this.options.acp.stop(row.id);
      this.ledger.audit(row, "stop", null);
      this.turns.forget(child);
      this.ledger.children.delete(session); this.ledger.save(); this.runs.revoke(row.run);
      return answer("stopped", { session, stopped: true });
    });
  }
  private async wait(run: Run, session: string, args: Record<string, unknown>, signal: AbortSignal) {
    const row = this.ledger.children.get(session), child = this.options.acp.forPane(session);
    if (!row || !child || row.id !== child.id) return refuse("unknown_session", "The child has ended.");
    if (args.turn && args.turn !== `${row.id}.${row.turns.at(-1)?.n}`) {
      const old = row.turns.find(t => `${row.id}.${t.n}` === args.turn);
      return old?.end ? answer("state", { session, state: { state: "done", turn: old.n } }) : refuse("unknown_session", "Unknown turn.");
    }
    const n = this.waits.get(run.id) ?? 0;
    if (n >= 8) return refuse("rate_limited", "Too many open waits.");
    this.waits.set(run.id, n + 1);
    try { return await this.turns.wait(child, row, Number(args.timeout_s ?? 30) * 1000, signal); }
    finally { this.waits.set(run.id, (this.waits.get(run.id) ?? 1) - 1); }
  }
  private async start(run: Run, args: Record<string, unknown>, allowed: () => boolean) {
    const kind = String(args.harness);
    if (args.on !== undefined && args.on !== "local") return refuse("approval_required", "Starting on another machine needs a person's approval and is not supported yet.");
    if (!this.setting.harnesses.includes(kind)) return refuse("not_granted", "This harness was not enabled.");
    if (run.depth >= this.setting.depth) return refuse("depth_exceeded", "This run is at its depth limit.");
    const expired = () => run.started_by !== null && this.now() - (this.ledger.children.get(run.self)?.created ?? run.created_ms) >= HARNESS_LIMITS.child_minutes * 60_000;
    if (expired()) return refuse("time_limit", "This child no longer starts new work.");
    const own = [...this.ledger.children.values()].filter(r => r.starter === run.id && this.options.acp.forPane(r.terminal)?.id === r.id);
    const used = typeof args.key === "string" ? this.runs.previousStart(run.id, args.key) : undefined;
    if (used) {
      const row = own.find(r => r.run === used), child = row ? this.options.acp.forPane(row.terminal) : null;
      if (row && child) {
        const initial = row.turns[0];
        const sent = initial?.key === args.key && initial?.seq != null ? { accepted: true, turn_id: `${row.id}.${initial.n}`, key: args.key, duplicate: true } : null;
        return answer("session", { session: childRef(row, child), state: childState(child, row), sent, ...(args.task && !sent ? { send_error: refuse("unavailable","No confirmed initial prompt receipt.").error } : {}) });
      }
      return refuse("unknown_session", "This key named a child that is no longer available.");
    }
    const command = (this.options.resolve ?? resolveHarness)(kind);
    if (!command) return refuse("start_failed", "This harness has no supported ACP adapter.");
    if (command.ceiling?.profile !== run.ceiling || !run.ceiling) {
      const refusal = await askRefusal(kind, command);
      if (refusal) return refuse("not_granted", refusal);
    }
    const cwd = typeof args.cwd === "string" ? args.cwd : (await coreConnection().call("terminal.get", { terminal: run.self })).cwd;
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) return refuse("bad_request", "The folder does not exist.");
    if (!allowed() || !this.setting.harnesses.includes(kind) || run.depth >= this.setting.depth) return refuse("not_granted", "The grant changed.");
    if (expired()) return refuse("time_limit", "This child no longer starts new work.");
    const key = this.runs.reserve(run.depth + 1, run.ceiling);
    const launch = permissionLaunch(kind, run.ceiling, key.id, command);
    if (!launch) { key.cancel(); return refuse("not_granted", "The child launch is not proven within the parent's permission ceiling."); }
    const intent = { run: key.id, parent: run.self, starter: run.id, harness: kind, created: this.now() };
    try {
      if (typeof args.key === "string") this.runs.rememberStart(run.id, args.key, key.id);
      this.ledger.begin(intent);
      const child = await this.options.acp.start({ harness: kind, argv: launch.argv, env: { ...launch.env, OVIS_AGENT_SOCKET: this.address, OVIS_AGENT_TOKEN_FILE: key.tokenFile },
        cwd, parentPane: run.self, runId: key.id, mcpServers: [this.command(key.tokenFile)], askEveryTime: launch.askEveryTime, sessionMeta: launch.sessionMeta, configOptions: launch.configOptions, privateFiles: launch.privateFiles });
      this.view.signInNeeded.delete(kind);
      if (child.client.sessionMode !== launch.ceiling.mode) {
        await this.options.acp.stop(child.id);
        this.ledger.finish(key.id); key.cancel();
        return refuse("not_granted", "The child did not open in its verified mode.");
      }
      const row: ToolChild = { id: child.id, terminal: child.terminal, harness: kind, starter: run.id, parent: run.self, run: key.id, created: this.now(), held: false, turns: [] };
      this.ledger.children.set(child.terminal, row); this.ledger.save(); this.ledger.audit(row, "start", null); this.turns.watch(child);
      this.ledger.finish(key.id);
      if (!allowed() || !this.setting.harnesses.includes(kind) || run.depth >= this.setting.depth) { key.cancel(); return refuse("not_granted", "The grant changed while starting."); }
      key.bind({ self: child.terminal, depth: run.depth + 1, root: run.root, harness: kind, started_by: run.id, ceiling: launch.ceiling.profile });
      const accepted = args.task ? await this.turns.send(child, row, args, launch.ceiling.mode) : null;
      if (accepted?.kind === "refusal") return answer("session", { session: childRef(row, child), state: childState(child, row), sent: null, send_error: accepted.error });
      const sent = accepted ? { accepted: true, turn_id: accepted.turn_id, key: accepted.key, duplicate: accepted.duplicate } : null;
      return answer("session", { session: childRef(row, child), state: childState(child, row), sent });
    } catch (error) {
      if (error instanceof AcpStartFailed && error.agentCode === -32000) this.view.signInNeeded.add(kind);
      const live = await this.options.acp.terminals().catch(() => null);
      if (live && !live.some(t => t.state === "live" && t.labels["ovis.run"] === key.id)) {
        this.ledger.finish(key.id);
        if (error instanceof AcpStartFailed || error instanceof AcpUnavailable) this.runs.forgetFailedStart(run.id, key.id);
      }
      key.cancel(); return refuse("start_failed", "The harness did not open an ACP session.");
    }
  }
}
