import type { InlineNode } from "./markdown.ts";

/**
 * Local patch: a work-steward task ID (`T-00042`) in chat text links to the task web view. The
 * view has one HTTPS address for every device (Caddy, over WireGuard), so the link does not depend
 * on the address the device reached Ovis by.
 */
export const TASK_VIEW_BASE = "https://tasks.home.jdsaa.com";
const TASK_ID = /\bT-\d{5}\b/g;
const WHOLE_TASK_ID = /^T-\d{5}$/;

export function taskHref(id: string): string {
  return `${TASK_VIEW_BASE}/t/${id}`;
}

/** `value` as text nodes, with each task ID in it as a link. */
export function linkTaskIds(value: string): InlineNode[] {
  if (!value.includes("T-")) return [{ type: "text", value }];
  const nodes: InlineNode[] = [];
  let offset = 0;
  // one linear pass: the pattern has no nested repetition
  for (const match of value.matchAll(TASK_ID)) {
    const index = match.index ?? 0;
    if (index > offset) nodes.push({ type: "text", value: value.slice(offset, index) });
    nodes.push({ type: "link", href: taskHref(match[0]), children: [{ type: "text", value: match[0] }] });
    offset = index + match[0].length;
  }
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes;
}

/** A code span that holds only a task ID (`` `T-00042` ``) links too, and keeps its code look. */
export function linkTaskCode(value: string): InlineNode {
  const code: InlineNode = { type: "code", value };
  return WHOLE_TASK_ID.test(value) ? { type: "link", href: taskHref(value), children: [code] } : code;
}
