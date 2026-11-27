import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/harness-tool.ts";
import { writePrivate } from "./runs.ts";
import type { AcpChildren } from "../acp/children.ts";
import type { AuditRecord } from "../../shared/harness-contract.generated.ts";

export interface ToolChild {
  id: string;
  terminal: string;
  harness: string;
  readonly version?: string;
  parent: string;
  starter: string;
  run: string;
  created: number;
  held: boolean;
  turns: { key: string | null; n: number; seq: number | null; end: string | null }[];
}
type Launch = Pick<ToolChild, "run" | "starter" | "parent" | "harness" | "version" | "created">;
function isLaunch(v: unknown): v is Launch {
  return isRecord(v) && ["run","starter","parent","harness"].every(k => typeof v[k] === "string") && typeof v.created === "number"
    && (v.version === undefined || typeof v.version === "string");
}
function isChild(row: unknown): row is ToolChild {
  return isRecord(row) && typeof row.id === "string" && typeof row.terminal === "string" && typeof row.held === "boolean"
    && Array.isArray(row.turns) && row.turns.every(t => isRecord(t) && Number.isSafeInteger(t.n) && (t.seq === null || Number.isSafeInteger(t.seq)) && (t.key === null || typeof t.key === "string") && (t.end === null || typeof t.end === "string"))
    && isLaunch(row);
}
export class Ledger {
  readonly children = new Map<string, ToolChild>();
  readonly launches = new Map<string, Launch>();
  constructor(private readonly dir: string) {
    const pending = join(dir, "launches.json");
    if (existsSync(pending)) {
      const items: unknown = JSON.parse(readFileSync(pending, "utf8"));
      if (!Array.isArray(items) || !items.every(isLaunch)) throw new Error("Unreadable launch intents.");
      for (const item of items) this.launches.set(item.run, item);
    }
    const path = join(dir, "children.json");
    if (!existsSync(path)) return;
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows) || !rows.every(isChild)) throw new Error("Cannot read agent tool children.");
    for (const row of rows) this.children.set(row.terminal, row);
  }
  save(): void { writePrivate(join(this.dir, "children.json"), JSON.stringify([...this.children.values()])); }
  async reconcile(acp: AcpChildren) {
    const terminals = await acp.terminals();
    const found = new Set<string>();
    for (const terminal of terminals) {
      const run = terminal.labels["ovis.run"];
      if (!run || terminal.state !== "live" || terminal.address.includes("/")) continue;
      const child = acp.forPane(terminal.address);
      if (found.has(run) || !child || child.id !== terminal.labels["ovis.acp"]) throw new Error("Unreconciled agent keeper.");
      found.add(run);
      const saved = this.children.get(terminal.address);
      if (saved?.id === child.id && saved.run === run) continue;
      const intent = this.launches.get(run);
      if (!intent || intent.parent !== terminal.parent || intent.harness !== child.harness) throw new Error("Unverified keeper ownership.");
      const row: ToolChild = { ...intent, id: child.id, terminal: terminal.address, held: false, turns: [] };
      this.children.set(row.terminal, row); this.save(); this.audit(row, "start", null);
    }
    for (const key of this.launches.keys()) this.finish(key);
    return terminals;
  }
  begin(intent: Launch): void { this.launches.set(intent.run, intent); this.saveLaunches(); }
  finish(run: string): void { if (this.launches.delete(run)) this.saveLaunches(); }
  private saveLaunches(): void { writePrivate(join(this.dir, "launches.json"), JSON.stringify([...this.launches.values()])); }
  audit(row: ToolChild, verb: "start" | "stop" | "send" | "answer" | "turn", turn: number | null, end: string | null = null): void {
    const file = join(this.dir, "audit.jsonl");
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) >= 10 * 1024 * 1024) renameSync(file, join(this.dir, "audit.1.jsonl"));
    const record: AuditRecord = { at: new Date().toISOString(), run: row.starter, parent: row.parent, child: row.terminal, machine: "local", harness: row.harness, verb, turn_id: turn === null ? null : `${row.id}.${turn}`, stop_reason: end };
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
}
