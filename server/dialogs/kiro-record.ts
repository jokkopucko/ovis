import { type AgentRecord, OpenRequests, jsonLines, object } from "./record.ts";

/**
 * Distinct key for a Kiro V3 approval ask: Kiro attaches `_meta.kiro.askId` and `consentRound` to distinguish
 * multiple approval rounds sharing one `toolCallId`, so resolving round 1 cannot clear round 2 and a stale card
 * from round 1 cannot match round 2.
 */
function interactionKey(payload: Record<string, unknown>, fallback: string): string {
  const kiro = object(object(payload._meta)?.kiro);
  const askId = typeof kiro?.askId === "string" && kiro.askId !== "" ? kiro.askId : null;
  const toolCallId = typeof payload.toolCallId === "string" && payload.toolCallId !== "" ? payload.toolCallId : null;
  const round = typeof payload.consentRound === "number" && Number.isSafeInteger(payload.consentRound)
    ? payload.consentRound
    : typeof kiro?.consentRound === "number" && Number.isSafeInteger(kiro.consentRound)
      ? kiro.consentRound
      : null;
  if (askId !== null) return toolCallId !== null ? `${toolCallId}\0${askId}` : askId;
  if (toolCallId !== null) return round !== null ? `${toolCallId}\0r${round}` : toolCallId;
  return fallback;
}

/**
 * Kiro CLI V3's session record (`sessions/<workspace-hash>/<session-id>/messages.jsonl`, 3.6.2) writes a
 * `pending_interaction` line (`interactionType: "tool_approval"`, `toolCallId`, `_meta.kiro.askId`, and
 * `_meta.kiro.command` for a shell command when `_meta.kiro.consent.capability === "shell"`) while it waits on
 * the user, and an `interaction_resolved` line with the same `toolCallId` and `askId` once answered (allowed,
 * denied, or cancelled with Esc). Its approval card (dialogs/kiro.ts) draws `shell → <command>` as its body,
 * which `withRecord` replaces with the verbatim command.
 */
export const kiroRecord: AgentRecord = {
  lead: /^shell\s*→\s*/u,
  pending(text) {
    const requests = new OpenRequests();
    for (const [index, entry] of jsonLines(text).entries()) {
      const payload = object(entry.payload);
      if (payload === null) continue;
      if (payload.type === "pending_interaction") {
        const id = interactionKey(payload, `row:${index}`);
        const kiro = object(object(payload._meta)?.kiro);
        const consent = object(kiro?.consent);
        const command = payload.interactionType === "tool_approval"
          && consent?.capability === "shell"
          && typeof kiro?.command === "string"
          ? kiro.command
          : null;
        requests.open(id, command);
      } else if (payload.type === "interaction_resolved") {
        const id = interactionKey(payload, "");
        if (id !== "") requests.close(id);
      } else if (payload.type === "user" || payload.type === "turn_end") {
        requests.clear();
      }
    }
    return requests.only();
  },
};
