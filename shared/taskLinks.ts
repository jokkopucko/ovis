import type { InlineNode } from "./markdown.ts";

/**
 * Local patch: a work-steward task ID (`T-00042`) in chat text links to the task web view, which
 * runs on the same machine as Ovis on port 7790. The host is the page's own, so the link works on
 * whichever address the device reached Ovis by. Where there is no page (the server), IDs stay text.
 */
export const TASK_VIEW_PORT = 7790;
const TASK_ID = /\bT-\d{5}\b/g;
const WHOLE_TASK_ID = /^T-\d{5}$/;

export function taskHref(id: string, host = globalThis.location?.hostname): string | null {
  return host ? taskViewUrl(id, host) : null;
}

function taskViewUrl(id: string, host: string): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${TASK_VIEW_PORT}/t/${id}`;
}

/** `value` as text nodes, with each task ID in it as a link. */
export function linkTaskIds(value: string, host = globalThis.location?.hostname): InlineNode[] {
  if (!host || !value.includes("T-")) return [{ type: "text", value }];
  const nodes: InlineNode[] = [];
  let offset = 0;
  // one linear pass: the pattern has no nested repetition
  for (const match of value.matchAll(TASK_ID)) {
    const index = match.index ?? 0;
    if (index > offset) nodes.push({ type: "text", value: value.slice(offset, index) });
    nodes.push({ type: "link", href: taskViewUrl(match[0], host), children: [{ type: "text", value: match[0] }] });
    offset = index + match[0].length;
  }
  if (offset < value.length) nodes.push({ type: "text", value: value.slice(offset) });
  return nodes;
}

/** A code span that holds only a task ID (`` `T-00042` ``) links too, and keeps its code look. */
export function linkTaskCode(value: string, host = globalThis.location?.hostname): InlineNode {
  const code: InlineNode = { type: "code", value };
  const href = WHOLE_TASK_ID.test(value) ? taskHref(value, host) : null;
  return href === null ? code : { type: "link", href, children: [code] };
}
