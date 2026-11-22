import { statSync } from "node:fs";
import { piBranchRecordRanges, piEntryIndex } from "./pi-tree.ts";

export interface PiQuestionnaireCall { id: string; args: unknown }

const cache = new Map<string, { stamp: string; calls: readonly PiQuestionnaireCall[] }>();

/** Pending calls on the same last-written branch Pi's conversation reader projects.
 * Never replay the whole file: /tree leaves unresolved tool calls on abandoned paths.
 * Pi does not persist a leaf-only navigation until it appends; the current drawing
 * must still match the pending call before this evidence can authorize an answer.
 */
export function pendingPiQuestionnaires(path: string): readonly PiQuestionnaireCall[] | null {
  const before = statSync(path);
  const stamp = (stat: typeof before) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const cached = cache.get(path);
  cache.delete(path);
  if (cached?.stamp === stamp(before)) {
    cache.set(path, cached);
    return cached.calls;
  }
  const index = piEntryIndex(path);
  if (!before.isFile() || !index || index.file !== `${before.dev}:${before.ino}` || !index.entries.length) return null;
  const open = new Map<string, PiQuestionnaireCall>();
  let parent: string | null = null;
  let leaf: string | null = null;
  const seen = new Set<string>();
  for (const item of piBranchRecordRanges(path, before.size)) {
    const entry = JSON.parse(item.line);
    // Unlike display history, prompt authorization cannot accept a truncated chain,
    // duplicate identity or an entry whose ancestry could not be verified to its root.
    if (!entry || typeof entry.id !== "string" || !entry.id || seen.has(entry.id)
      || entry.parentId !== parent) return null;
    seen.add(entry.id);
    parent = entry.id;
    leaf = entry.id;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== "toolCall" || part.name !== "questionnaire" || part.incomplete === true) continue;
        if (typeof part.id !== "string" || !part.id || open.has(part.id)) return null;
        open.set(part.id, { id: part.id, args: part.arguments });
      }
    } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      open.delete(message.toolCallId);
    }
  }
  if (leaf !== index.entries.at(-1)?.id || stamp(statSync(path)) !== stamp(before)) return null;
  const calls = [...open.values()];
  cache.set(path, { stamp: stamp(before), calls });
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
  return calls;
}
