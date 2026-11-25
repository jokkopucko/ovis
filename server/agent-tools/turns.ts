import type { AcpChild, AcpChildren } from "../acp/children.ts";
import { KeeperRequestError, type KeeperClient } from "../acp/client.ts";
import { allowsDelegatedMode } from "./harnesses.ts";
import type { Ledger, ToolChild } from "./ledger.ts";
import { HARNESS_LIMITS, answer, harnessStopReason, refuse } from "../../shared/harness-tool.ts";
import type { SessionRef, SessionState, Untrusted } from "../../shared/harness-contract.generated.ts";

export function untrusted(from: string, text: string): Untrusted {
  const bytes = Buffer.from(text);
  return { untrusted: true as const, from, text: bytes.subarray(0, 65536).toString("utf8"), ...(bytes.length > 65536 ? { truncated: true as const } : {}) };
}
export const childRef = (row: ToolChild, child: AcpChild): SessionRef => ({ address: row.terminal, drive: "acp", machine: "local", harness: row.harness, ...(row.version && { version: row.version }), agent_session_id: child.client.session, parent: row.parent, started_by: "agent" });
export function childState(child: AcpChild, row?: ToolChild, parent = false): SessionState {
  const { client } = child;
  const turn = row?.turns.at(-1)?.n ?? null;
  if (client.agentGone || client.keeperGone) return { state: "gone", turn };
  if (client.pending().length) return { state: "waiting_human", turn, on: "approval" };
  const q = client.questions.current;
  if (q) {
    if (!q.parent || !q.field || row?.held || client.holdGeneration !== null) return { state: "waiting_human", turn, on: "question" };
    const { field } = q;
    return { state: "waiting_parent", turn, on: "question", ...(parent ? { question: { id: q.id, prompt: untrusted(child.terminal, field.prompt),
      choices: field.choices.map(c => untrusted(child.terminal, c.description ? `${c.label}\n${c.description}` : c.label)), multiple: field.multiple, accepts_text: field.custom !== null } } : {}) };
  }
  return { state: !client.connected || client.turn?.running ? "working" : client.turn ? "done" : "idle", turn };
}
export function delegatedMode(harness: string, client: KeeperClient): string | null {
  const initial = client.initialPermissions;
  if (!initial?.mode || !allowsDelegatedMode(harness, initial.mode) || client.sessionMode !== initial.mode
    || initial.allowAll === true || client.allowAll === true
    || (harness === "copilot" && client.allowAll !== false)) return null;
  return initial.mode;
}

export class ChildTurns {
  private readonly watches = new Map<AcpChild, () => void>();
  private readonly closing = new AbortController();
  constructor(private readonly ledger: Ledger, private readonly acp: AcpChildren, private readonly now: () => number) {}
  close(): void { this.closing.abort(); for (const off of this.watches.values()) off(); this.watches.clear(); }
  forget(child: AcpChild): void { this.watches.get(child)?.(); this.watches.delete(child); }
  watch(child: AcpChild): void {
    if (this.watches.has(child)) return;
    const change = () => {
      const row = this.ledger.children.get(child.terminal);
      const turn = row?.turns.at(-1);
      const client = child.client;
      if (row && row.id === child.id && client.connected && row.held !== (client.holdGeneration !== null)) {
        row.held = client.holdGeneration !== null;
        this.ledger.save();
      }
      if (!row || row.id !== child.id || !turn || turn.end !== null || turn.seq === null || turn.seq !== client.turnSequence || !client.connected || !client.turn || client.turn.running) return;
      turn.end = harnessStopReason(client.turn.stopReason ?? (client.agentGone ? "gone" : "unknown"));
      this.ledger.audit(row, "turn", turn.n, turn.end);
      this.ledger.save();
    };
    this.watches.set(child, child.client.onChange(change));
    change();
  }
  async send(child: AcpChild, row: ToolChild, args: Record<string, unknown>) {
    const expectedMode = delegatedMode(row.harness, child.client);
    if (expectedMode === null) return refuse("not_granted", "Child permission mode is not allowed.");
    const key = typeof args.key === "string" ? args.key : null;
    const accepted = (n: number, duplicate: boolean) => answer("accepted", { session: row.terminal, accepted: true, turn_id: `${row.id}.${n}`, key, duplicate });
    if (row.held || child.client.terminalReady) return refuse("taken_over", "A person holds this child.");
    if (child.client.pending().length) return refuse("waiting_human", "A person must answer the child's card.");
    const duplicate = key && row.turns.find(t => t.key === key);
    if (duplicate) return duplicate.seq === null ? refuse("unavailable", "Delivery of the original prompt is unconfirmed.") : accepted(duplicate.n, true);
    if (this.now() - row.created >= HARNESS_LIMITS.child_minutes * 60_000) {
      await this.acp.markTimeLimit(child.id);
      return refuse("time_limit", "This child no longer takes new work.");
    }
    if (child.client.status !== "idle" && child.client.status !== "done") return refuse("busy", "This child is not ready for a new prompt.");
    const n = (row.turns.at(-1)?.n ?? 0) + 1;
    const turn: ToolChild["turns"][number] = { key, n, seq: null, end: null };
    row.turns.push(turn);
    this.ledger.save();
    try { await child.client.submit(String(args.task), expectedMode); }
    catch (error) {
      if (error instanceof KeeperRequestError && [-32004,-32002,-32005].includes(error.code)) {
        row.turns = row.turns.filter(t => t !== turn);
        this.ledger.save();
      }
      if (error instanceof KeeperRequestError && error.code === -32005) return refuse("busy", "A turn or decision is already pending.");
      if (error instanceof KeeperRequestError && error.code === -32004) return refuse("not_granted", "Child permission mode changed.");
      return refuse(child.client.terminalReady ? "taken_over" : "unavailable", "Delivery could not be confirmed. Do not repeat without checking.");
    }
    turn.seq = child.client.turnSequence;
    this.ledger.save();
    this.ledger.audit(row, "send", n);
    this.forget(child); this.watch(child);
    return accepted(n, false);
  }
  async wait(child: AcpChild, row: ToolChild, ms: number, signal: AbortSignal) {
    const { promise, resolve } = Promise.withResolvers<void>();
    const check = () => { if (row.held || child.client.terminalReady || childState(child, row).state !== "working") resolve(); };
    const off = child.client.onChange(check);
    const timer = setTimeout(resolve, ms);
    const close = () => resolve();
    const end = AbortSignal.any([signal, this.closing.signal]);
    end.addEventListener("abort", close, { once: true });
    try { if (end.aborted) close(); else check(); await promise; }
    finally { off(); clearTimeout(timer); end.removeEventListener("abort", close); }
    return row.held || child.client.terminalReady ? refuse("taken_over", "A person holds this child.") : answer("state", { session: row.terminal, state: childState(child, row, true) });
  }
  async answerQuestion(child: AcpChild, row: ToolChild, args: Record<string, unknown>) {
    const client = child.client, session = row.terminal;
    const expectedMode = delegatedMode(row.harness, client);
    if (expectedMode === null) return refuse("not_granted", "Child permission mode is not allowed.");
    if (client.pending().length) return refuse("waiting_human", "Only a person can answer a permission request.");
    if (row.held || client.holdGeneration !== null || client.status === "unknown") return refuse("taken_over", "ACP does not own this conversation.");
    const q = client.questions.current;
    if (!q?.parent || q.id !== args.question_id) return refuse("waiting_human", "This question is not waiting for you.");
    if (args.choice === undefined && args.choices === undefined && args.text === undefined) {
      if (client.questions.handoff(q.id)) this.ledger.audit(row, "answer", row.turns.at(-1)?.n ?? null);
      return answer("state", { session, state: childState(child, row) });
    }
    if (args.choices !== undefined && args.choice !== undefined) return refuse("bad_request", "Supply choice or choices, not both.");
    const indices = Array.isArray(args.choices) ? args.choices : typeof args.choice === "number" ? [args.choice] : [];
    const result = await client.questions.respond(q.id, expectedMode, { indices, ...(typeof args.text === "string" ? { text: args.text } : {}) });
    if (result !== "answered") return refuse(result === "invalid" ? "bad_request" : "unavailable", "The answer was not accepted.");
    this.ledger.audit(row, "answer", row.turns.at(-1)?.n ?? null);
    return answer("answered", { session, question_id: q.id });
  }
  result(child: AcpChild, row: ToolChild, id: unknown, parent = true) {
    if (child.client.status === "unknown") return refuse("taken_over", "ACP does not own this conversation.");
    const state = childState(child, row, parent);
    const turn = id === undefined ? row.turns.at(-1) : row.turns.find(t => `${row.id}.${t.n}` === id);
    if (id !== undefined && !turn) return refuse("unknown_session", "Unknown turn.");
    if (!turn || state.on || turn.end === null || !child.client.connected) return answer("state", { session: row.terminal, state });
    const latest = turn.seq === child.client.turnSequence ? child.client.turn : null;
    return answer("result", { session: row.terminal, turn_id: `${row.id}.${turn.n}`, stop_reason: harnessStopReason(turn.end), end_from: "acp", answer_from: latest ? "acp" : null,
      final_message: latest?.text ? untrusted(row.terminal, latest.text) : null, error: latest?.error ? untrusted(row.terminal, latest.error) : null, usage: latest ? child.client.usage : null,
      model: latest && child.client.model && /^[\w.:-]+(?:\/[\w.:-]+)*$/.test(child.client.model) ? child.client.model : null });
  }
}
