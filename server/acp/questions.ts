import { createHash } from "node:crypto";
import type { Row } from "./messages.ts";
import type { AnswerOutcome } from "./answers.ts";
import { questionForm, type QuestionField } from "./question-form.ts";
import { showable } from "../approvals/hub.ts";

interface Pending {
  readonly id: string;
  readonly receipt: string;
  readonly fields: readonly QuestionField[];
  readonly message: string | null;
  readonly content: Map<string, string | string[]>;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  deadline: number;
  step: number;
}
type Reply = { action: "cancel" } | { action: "accept"; content: Record<string, string | string[]> };
const WINDOW_MS = 30_000;

/** Only `from-agent` elicitation/create rows enter here. Replayed questions go to the
 * person immediately: restarting Ovis never gives a passed question back to an agent. */
export class KeeperQuestions {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly changed: () => void, private readonly send: (id: string, result: Reply, expectedMode?: string) => Promise<AnswerOutcome>) {}

  add(harness: string, row: Row, id: string, params: Record<string, unknown>, live: boolean): void {
    const form = Buffer.byteLength(row.raw) <= 65_536 ? questionForm(harness, params) : null;
    const fields = form?.fields ?? [];
    const now = Date.now();
    const deadline = form?.audience === "parent" && live && row.ts ? Math.min(now, row.ts) + WINDOW_MS : 0;
    this.remove(id);
    const timer = deadline > now ? setTimeout(() => this.pass(id), deadline - now).unref() : undefined;
    const message = typeof params.message === "string" && params.message.length <= 4096 && showable(params.message) ? params.message : null;
    this.pending.set(id, { id, fields, message, content: new Map(), step: 0, timer, deadline: timer ? deadline : 0,
      receipt: `question.${row.seq}.${createHash("sha256").update(row.raw).digest("hex").slice(0, 16)}` });
  }
  remove(id: string): void {
    clearTimeout(this.pending.get(id)?.timer);
    this.pending.delete(id);
  }
  clear(): void { for (const id of this.pending.keys()) this.remove(id); }
  get current() {
    const item = this.pending.values().next().value;
    if (!item) return null;
    if (item.deadline <= Date.now()) item.deadline = 0;
    return { id: `${item.receipt}.${item.step}`, field: item.fields[item.step], message: item.message, parent: item.deadline !== 0 };
  }
  private pass(id: string): void {
    const item = this.pending.get(id);
    if (item) { item.deadline = 0; clearTimeout(item.timer); this.changed(); }
  }
  handoff(receipt: string): boolean {
    const item = this.pending.values().next().value, q = this.current;
    if (!item || q?.id !== receipt || !q.parent) return false;
    this.pass(item.id);
    return true;
  }
  async respond(receipt: string, parentMode: string | null, input: { indices: readonly number[]; text?: string }): Promise<"answered" | "changed" | "invalid"> {
    const parent = parentMode !== null;
    const item = this.pending.values().next().value, q = this.current;
    if (!item || !q || q.id !== receipt || q.parent !== parent) return "changed";
    const field = q.field;
    if (!field) return !parent && input.indices.length === 1 && input.indices[0] === 0
      ? await this.send(item.id, { action: "cancel" }) === "won" ? "answered" : "changed" : "invalid";
    const picks: string[] = [];
    for (const i of input.indices) {
      const choice = Number.isSafeInteger(i) ? field.choices[i] : null;
      if (!choice || picks.includes(choice.value)) return "invalid";
      picks.push(choice.value);
    }
    const skip = !parent && field.optional && !picks.length && (input.text === "" || field.multiple && input.text === undefined);
    if (!skip && input.text !== undefined && (!field.custom || !input.text.trim() || input.text.length > 4096)) return "invalid";
    if ((!field.multiple && picks.length > 1) || (!skip && !picks.length && input.text === undefined)) return "invalid";
    const content = new Map(item.content);
    if (picks.length) content.set(field.key, field.multiple ? picks : picks[0] ?? "");
    if (!skip && field.custom && input.text !== undefined) content.set(field.custom, input.text);
    if (item.step + 1 === item.fields.length) {
      return await this.send(item.id, { action: "accept", content: Object.fromEntries(content) }, parentMode ?? undefined) === "won" ? "answered" : "changed";
    }
    for (const [key, value] of content) item.content.set(key, value);
    item.step++;
    this.changed();
    return "answered";
  }
}
