import type { AcpChildren } from "../acp/children.ts";
import type { AgentDetector } from "../agent-catalog-detect.ts";
import { agentCatalogFor } from "../agent-catalog-routes.ts";
import { catalogPlatform } from "../../shared/agent-catalog.ts";
import { answer, refuse } from "../../shared/harness-tool.ts";
import { paneConversation } from "../conversation.ts";
import { paneRead, sessionSnapshot } from "../herdr/client.ts";
import { coreConnection } from "../herdr-core/runtime.ts";
import type { Machine } from "../../shared/machines.ts";
import { readPrompt } from "../prompt.ts";
import { harnessCapabilities } from "./harnesses.ts";
import { childState, ChildTurns, untrusted } from "./turns.ts";
import type { Ledger } from "./ledger.ts";

export interface ViewOptions {
  readonly detector?: AgentDetector;
  readonly machines?: () => readonly Machine[];
  readonly hasHook?: (kind: string) => boolean;
}
const eligible = (pane: { pane_id: string; agent?: string | null }) => !!pane.agent && !pane.pane_id.includes("/");
export class HarnessView {
  readonly signInNeeded = new Set<string>();
  constructor(private readonly options: ViewOptions, private readonly acp: AcpChildren, private readonly ledger: Ledger) {}
  async query(verb: string, args: Record<string, unknown>, turns: ChildTurns) {
    switch (verb) {
      case "machines": return answer("machines", { machines: (this.options.machines?.() ?? []).map(m => ({ id: m.id, name: m.name, online: m.state === "connected", versions: {}, reach: m.kind === "local" ? "local" : m.kind === "hc" ? "hc-via" : m.kind === "ssh" ? "hc-ssh" : m.kind })) });
      case "harnesses": {
        if (!this.options.detector) return refuse("unavailable", "No harness catalog.");
        const { agents } = await agentCatalogFor(catalogPlatform(process.platform), this.options.detector);
        return answer("harnesses", { harnesses: agents.map(agent => ({ kind: agent.id, installed: agent.state.installed, version: agent.state.version,
          signed_in: this.signInNeeded.has(agent.id) ? false : null, capabilities: harnessCapabilities(agent.id, this.options.hasHook?.(agent.id) ?? false) })) });
      }
      case "ls": {
        const { panes } = await sessionSnapshot();
        return answer("sessions", { sessions: panes.filter(eligible).map(p => {
          const child = this.acp.forPane(p.pane_id), row = this.ledger.children.get(p.pane_id);
          return { address: p.pane_id, drive: child ? "acp" : "terminal", harness: p.agent, machine: "local", parent: panes.some(parent => parent.pane_id === p.parent_pane_id) ? p.parent_pane_id : null, agent_session_id: child?.client.session ?? p.agent_session?.value ?? null,
            started_by: row && row.id === child?.id ? "agent" : "human", state: child ? childState(child, row) : { state: p.agent_status === "blocked" ? "waiting_human" : p.agent_status, turn: null } };
        }) });
      }
      default: return this.read(args, turns);
    }
  }
  private async read(args: Record<string, unknown>, turns: ChildTurns) {
    const session = String(args.session);
    if (session.includes("/")) return refuse("unknown_session", "Only sessions on this PC can be read.");
    const child = this.acp.forPane(session), row = this.ledger.children.get(session);
    const target = child ? null : (await sessionSnapshot()).panes.find(p => p.pane_id === session && eligible(p));
    if (!child && !target) return refuse("unknown_session", "No eligible agent in this pane.");
    let uncertain = false;
    const observe = () => { uncertain ||= this.acp.forPane(session) !== child || child?.client.status === "unknown"; };
    const off = child?.client.onChange(observe);
    try {
    observe();
    if (uncertain) return refuse("taken_over", "ACP does not own this conversation.");
    const state = async () => {
      if (child) return childState(child, row);
      const read = await readPrompt(session);
      if (!eligible(read.pane) || read.pane.terminal_id !== target?.terminal_id || read.pane.agent !== target?.agent) throw new Error("Agent session changed.");
      if (read.stale || read.inputUnverified) throw new Error("Session changed.");
      return { state: read.prompt || read.status === "blocked" ? "waiting_human" : read.status, turn: null };
    };
    const before = await state();
    const stateOnly = (s: typeof before) => answer("state", { session, state: s });
    if (args.what === "state" || before.state === "waiting_human" || child && !child.client.connected) return stateOnly(before);
    if ((child || args.what === "result") && before.state === "working") return stateOnly(before);
    if (args.what === "result" && child && row) return turns.result(child, row, undefined);
    let output: object;
    if (args.what === "screen") {
      const screen = await paneRead({ paneId: session, source: "visible", format: "text" });
      const { cols, rows } = await coreConnection().call("terminal.get", { terminal: session });
      output = answer("screen", { session, text: untrusted(session, screen.text), cols, rows });
    } else {
      const page = { prompts: 1, ...(typeof args.cursor === "string" ? { before: args.cursor } : {}) };
      const history = child ? await child.client.history.page(page) : await paneConversation(session, undefined, page);
      const items = history.turns.flatMap(t => t.parts.flatMap(p => {
        if (p.kind === "tool") return [{ type: p.name === "plan" ? "plan" : "tool_call", text: untrusted(session, p.name === "plan" ? p.input : p.summary) }];
        return p.kind === "text" || p.kind === "thinking" ? [{
          type: p.kind === "thinking" ? "agent_thought_chunk" : t.role === "user" ? "user_message_chunk" : "agent_message_chunk", text: untrusted(session, p.text),
        }] : [];
      }));
      output = args.what === "result" ? answer("result", { session, final_message: before.state === "done" ? items.reverse().find(item => item.type === "agent_message_chunk")?.text ?? null : null,
        end_from: "reader", answer_from: "reader", stop_reason: "unknown", usage: null, error: null, model: null, turn_id: null }) : answer("transcript", { session, items, next: history.cursor ?? null });
    }
    const after = await state();
    observe();
    if (uncertain) return refuse("taken_over", "ACP ownership changed during the read.");
    return after.state === "waiting_human" || (child || args.what === "result") && after.state === "working" || child && !child.client.connected ? stateOnly(after) : output;
    } finally { off?.(); }
  }
}
