import type { CommandForm, CommandOutcome, SlashCommand } from "../shared/protocol.ts";
import { skillSyntax } from "../shared/skill-syntax.ts";
import { withoutClaudeSidePanel } from "./dialogs/claude.ts";
import { ANSI_RE, cleanLine, type DialogReader, type ParsedPrompt } from "./dialogs/shared.ts";

export interface CommandInvocation {
  readonly name: string;
  readonly argument: string;
  readonly form: CommandForm | null;
}

export interface CommandSend {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly agent: string;
  readonly identity: string;
  readonly screen: string;
  /**
   * `screen`'s first row in the pane's history (herdr's max_offset_from_bottom: a detection read is the live screen,
   * however far a device scrolled): the same row read before and after
   * `screen`.
   */
  top?: number;
  readonly form: CommandForm | null;
  readonly invocations: readonly CommandInvocation[];
  resultEchoes?: Readonly<Record<string, number | null>>;
  resultEchoLimit?: Readonly<Record<string, number | null>>;
  outcome?: CommandOutcome;
  readonly note?: string;
  readonly unattached?: readonly string[];
  countedCut?: boolean;
  dialogId?: string;
  dialogObserved?: true;
  closedAt?: number;
  transcriptClosedAt?: number;
  transcriptStore?: string;
  transcriptEcho?: number;
  transcriptEvidence?: { readonly offset: number; readonly at: number };
  transcriptAmbiguous?: true;
  waitingSince?: number;
  settled?: { screen: string; since: number };
}

export function commandInvocations(agent: string, text: string, commands: readonly SlashCommand[]): CommandInvocation[] {
  const syntax = skillSyntax(agent);
  const matches: CommandInvocation[] = [];
  const trimmed = text.trim();
  for (const match of trimmed.matchAll(/(?:^|\s)([/$@])([^\s/$@]\S*)/gu)) {
    const trigger = match[1];
    const name = match[2] ?? "";
    const leading = match.index === 0;
    const row = commands.find((row) => {
      if (row.name.toLocaleLowerCase() !== name.toLocaleLowerCase()) return false;
      if (trigger === "@") return agent === "opencode" && row.trigger === "@";
      if (leading) return syntax.skillTriggers.length > 1
        ? trigger === "/" || (trigger === "$" && row.source === "skill")
        : (row.trigger ?? "/") === trigger;
      if (row.source !== "skill" || (trigger !== "/" && trigger !== "$") || !syntax.inline.includes(trigger)) return false;
      if (agent === "codex") return row.trigger === "$";
      if (agent === "claude") return row.trigger === undefined;
      if (agent === "omp") return row.name.startsWith("skill:");
      return true;
    });
    if (!leading && !row) continue;
    if (leading && trigger === "$" && !syntax.skillTriggers.includes("$")) continue;
    if (trigger === "@" && (agent !== "opencode" || !row)) continue;
    if (!row && (!leading || trigger === "@")) continue;
    if (!row && !/^[\p{L}\p{N}_:-]+$/u.test(name)) continue;
    const argument = trimmed.slice(match.index + match[0].length).trim();
    const forms = row?.forms ?? [];
    const sub = argument.split(/\s+/u)[0]?.toLocaleLowerCase();
    const bare = forms.find((form) => form.match === "bare");
    const form = row?.visibility === "terminal" || (agent === "omp" && name === "btw") ? { match: "bare" as const, interaction: "terminal" as const }
      : argument === "" ? bare
      : forms.find((form) => typeof form.match === "object" && form.match.sub.toLocaleLowerCase() === sub)
        ?? forms.find((form) => form.match === "other") ?? bare;
    matches.push({ name, argument, form: form ?? null });
  }
  return matches;
}

export interface OutcomeObservation {
  readonly now: number;
  readonly nextAt?: number;
  readonly screen?: string;
  readonly resultScreen?: string;
  readonly top?: number;
  readonly transcript?: string | readonly CommandTranscriptRecord[];
  readonly transcriptAt?: number;
  readonly readers?: readonly DialogReader[];
  readonly dialog?: { readonly id: string; readonly reader: string };
  readonly waitingSince?: number;
  readonly settledSince?: number;
  /** `named`: the agent named this very command (its hook), so a later send does not cut it off, only the window */
  readonly evidence?: { readonly kind: "dialog" | "native" | "side-store"; readonly at: number; readonly catalogChanged?: true; readonly named?: true };
}

export const WINDOW_MS = 10 * 60_000;
const normalize = (text: string): string => text.replace(/\s+/gu, " ").trim();
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

export interface CommandTranscriptRecord {
  readonly offset: number;
  readonly entry: Readonly<Record<string, unknown>>;
}

export function commandTranscriptRecords(text: string, start = 0): CommandTranscriptRecord[] {
  const records: CommandTranscriptRecord[] = [];
  let offset = start;
  for (const line of text.split("\n")) {
    try {
      const entry = object(JSON.parse(line));
      if (["system", "user", "message", "response_item", "event_msg", "model_change", "thinking_level_change", "compaction", "compacted"].includes(String(entry.type))
        || (entry.type === "custom" && entry.customType === "context_clear")) {
        records.push({ offset, entry });
      } else if (entry.type === "custom_message" && entry.customType === "skill-prompt") {
        const { name, args } = object(entry.details);
        records.push({ offset, entry: { type: entry.type, customType: entry.customType, id: entry.id, parentId: entry.parentId,
          timestamp: entry.timestamp, details: { name, args } } });
      } else if (typeof entry.uuid === "string") {
        records.push({ offset, entry: { uuid: entry.uuid, parentUuid: entry.parentUuid } });
      } else if (typeof entry.id === "string") {
        records.push({ offset, entry: { id: entry.id, parentId: entry.parentId } });
      }
    } catch {}
    offset += Buffer.byteLength(line) + 1;
  }
  return records;
}

function claudeCommand(entry: Readonly<Record<string, unknown>>): string | null {
  const content = entry.type === "system" && entry.subtype === "local_command" ? entry.content
    : entry.type === "user" && !entry.isMeta ? object(entry.message).content : undefined;
  if (typeof content !== "string") return null;
  // Native local commands put name before message; skill echoes put message first.
  const command = /^(?:<command-name>(\/[^<]+)<\/command-name>\s*<command-message>[^<]*<\/command-message>|<command-message>[^<]*<\/command-message>\s*<command-name>(\/[^<]+)<\/command-name>)(?:\s*<command-args>([\s\S]*)<\/command-args>)?$/u.exec(content.trim());
  return command ? normalize(`${command[1] ?? command[2]} ${command[3] ?? ""}`) : null;
}

/** The command a gjc skill run records, however it was typed (gjc 0.18.12 writes the same record from its TUI). */
function gjcSkillCommand(entry: Readonly<Record<string, unknown>>): string | null {
  if (entry.type !== "custom_message" || entry.customType !== "skill-prompt") return null;
  const details = object(entry.details);
  if (typeof details.name !== "string" || !details.name) return null;
  return gjcSkillText(`/skill:${details.name} ${typeof details.args === "string" ? details.args : ""}`);
}

/** gjc keeps the spaces inside a skill's arguments (`"a  b"` is not `"a b"`) and trims only their ends. */
function gjcSkillText(text: string): string {
  const [, command = "", args = ""] = /^(\S*)\s*([\s\S]*)$/u.exec(text.trim()) ?? [];
  return args ? `${command} ${args}` : command;
}

function commandEcho(agent: string, entry: Readonly<Record<string, unknown>>): string | null {
  return agent === "claude" ? claudeCommand(entry) : agent === "gjc" ? gjcSkillCommand(entry) : null;
}

const echoText = (agent: string, text: string): string => agent === "gjc" ? gjcSkillText(text) : normalize(text);

function gjcSkillTurnEnd(sent: CommandSend, records: readonly CommandTranscriptRecord[], until: number, used: ReadonlySet<number>,
  echoOffset: number | null | undefined): { offset: number; at: number } | null {
  const inWindow = (entry: Readonly<Record<string, unknown>>): boolean => {
    const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return time > sent.at && time < until;
  };
  const echoes = records.filter(({ entry, offset }) => (echoOffset === undefined || offset === echoOffset)
    && inWindow(entry) && gjcSkillCommand(entry) === gjcSkillText(sent.text));
  const echo = echoes.length === 1 ? echoes[0] : undefined;
  if (!echo || typeof echo.entry.id !== "string") return null;
  const turn = new Set([echo.entry.id]);
  for (const { entry, offset } of records) {
    if (offset <= echo.offset || typeof entry.parentId !== "string" || !turn.has(entry.parentId)) continue;
    const message = object(entry.message);
    if (gjcSkillCommand(entry) !== null || message.role === "user") return null;
    if (message.role === "assistant" && typeof message.stopReason === "string" && message.stopReason !== "toolUse") {
      return inWindow(entry) && !used.has(offset) ? { offset, at: Date.parse(String(entry.timestamp)) } : null;
    }
    if (typeof entry.id === "string") turn.add(entry.id);
  }
  return null;
}

function claudeOutputEchoes(records: readonly CommandTranscriptRecord[]): ReadonlyMap<number, number> {
  const byId = new Map<string, CommandTranscriptRecord | null>();
  for (const record of records) {
    const id = record.entry.uuid;
    if (typeof id === "string") byId.set(id, byId.has(id) ? null : record);
  }
  const pending: number[] = [];
  const outputs = new Map<number, number>();
  const completed = new Set<number>();
  for (const record of records) {
    const { entry, offset } = record;
    if (claudeCommand(entry) !== null) { pending.push(offset); continue; }
    if (entry.type !== "system" || entry.subtype !== "local_command" || typeof entry.content !== "string"
      || !/^<local-command-(stdout|stderr)>[\s\S]+<\/local-command-\1>$/u.test(entry.content.trim())) {
      if ((entry.type === "user" && !entry.isMeta) || (entry.type === "system" && entry.subtype === "local_command")) pending.length = 0;
      continue;
    }
    let echo: number | undefined;
    if (entry.parentUuid === undefined || entry.parentUuid === null) echo = pending.shift();
    else {
      let parent: unknown = entry.parentUuid;
      const seen = new Set<string>();
      while (typeof parent === "string" && !seen.has(parent)) {
        seen.add(parent);
        const ancestor = byId.get(parent);
        if (!ancestor || ancestor.offset >= offset) break;
        if (claudeCommand(ancestor.entry) !== null) { echo = ancestor.offset; break; }
        parent = ancestor.entry.parentUuid;
      }
      const index = echo === undefined ? -1 : pending.indexOf(echo);
      if (index >= 0) pending.splice(index, 1);
    }
    if (echo === undefined || completed.has(echo)) continue;
    outputs.set(offset, echo);
    completed.add(echo);
  }
  return outputs;
}

export const PI_EVIDENCE_TYPES: ReadonlySet<string> = new Set(["model_change", "thinking_level_change", "compaction"]);

function transcriptEvidence(sent: CommandSend, records: readonly CommandTranscriptRecord[], until: number, used: ReadonlySet<number> = new Set(),
  echoOffset?: number | null, outputs?: ReadonlyMap<number, number>): { offset: number; at: number } | null {
  const invocation = sent.invocations[0];
  if (sent.agent === "gjc" && invocation?.name.startsWith("skill:")) return gjcSkillTurnEnd(sent, records, until, used, echoOffset);
  // A reserved byte offset may now contain another command after an in-place rewrite.
  const matchingEchoes = sent.agent === "claude" ? records.filter(({ entry, offset }) => {
    const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    return (echoOffset === undefined || offset === echoOffset)
      && time > sent.at && time < until && claudeCommand(entry) === normalize(sent.text);
  }) : [];
  const ownEcho = matchingEchoes.length === 1 ? matchingEchoes[0]!.offset : undefined;
  const outputEchoes = outputs ?? (sent.agent === "claude" ? claudeOutputEchoes(records) : new Map<number, number>());
  for (const { offset, entry } of records) {
    const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (!Number.isFinite(time) || time <= sent.at || time >= until) continue;
    const message = object(entry.message);
    const evidence = { offset, at: time };
    if (sent.agent === "claude") {
      // Claude Code writes /compact as a user line when it starts; the fold it made, the boundary, is its result.
      // A fold Claude made on its own (trigger "auto") is no /compact's, even one queued behind it.
      if (/^\/compact(?:\s|$)/u.test(normalize(sent.text))) {
        if (entry.type === "system" && entry.subtype === "compact_boundary" && object(entry.compactMetadata).trigger !== "auto"
          && !used.has(offset)) return evidence;
        continue;
      }
      const local = entry.type === "system" && entry.subtype === "local_command";
      if ((entry.type === "user" && !entry.isMeta) || local) {
        const content = local ? entry.content : message.content;
        if (typeof content !== "string") continue;
        if (local && ownEcho !== undefined && ownEcho !== null && !used.has(offset) && outputEchoes.get(offset) === ownEcho) return evidence;
        if (!local && claudeCommand(entry) === null && !used.has(offset) && normalize(content) === normalize(sent.text)) return evidence;
      }
      continue;
    }
    if (!invocation) continue;
    const name = invocation.name.toLocaleLowerCase();
    const argument = invocation.argument.split(/\s+/u)[0] ?? "";
    if (used.has(offset)) continue;
    if (["pi", "omp", "gjc", "omo"].includes(sent.agent) && PI_EVIDENCE_TYPES.has(String(entry.type))) {
      if (entry.type === "model_change" && ["model", "models", "switch"].includes(name) && argument) {
        const model = typeof entry.model === "string" ? entry.model : entry.modelId;
        const qualified = typeof entry.provider === "string" ? `${entry.provider}/${model}` : model;
        if (argument === model || argument === qualified || (typeof model === "string" && argument === model.slice(model.indexOf("/") + 1))) return evidence;
      }
      if (entry.type === "thinking_level_change" && ["thinking", "effort", "efforts"].includes(name) && argument === entry.thinkingLevel) return evidence;
      // Native /compact folds do not name their cause; an automatic fold has the same shape.
      // omp's /handoff writes its document as an in-place compaction (method "handoff" on 18.8.7)
      if (sent.agent === "omp" && entry.type === "compaction" && entry.method === "handoff" && name === "handoff") return evidence;
    }
  }
  return null;
}

const screenLines = (screen: string): string[] => screen.replace(ANSI_RE, "").split(/\r?\n/u).map((line) => line.trimEnd());
/**
 * Screens read against each other, as lines. Claude's are read on the session's side of a fullscreen side panel, as
 * parsePrompt reads its cards, only when every one of them shows the panel: a table's divider can pass for the panel's
 * edge on one screen and not the next, and a cut on one side alone loses the anchor between them.
 */
function readAlike(agent: string, ...screens: string[]): { lines: string[][]; cut: boolean } {
  if (agent === "claude") {
    const cut = screens.map(withoutClaudeSidePanel);
    if (cut.every((text, index) => text !== screens[index])) return { lines: cut.map(screenLines), cut: true };
  }
  return { lines: screens.map(screenLines), cut: false };
}
function withoutChrome(lines: string[], agent: string, readers: readonly DialogReader[]): string[] | null {
  const reader = readers.find((reader) => reader.kind === "result" && reader.chromeStart
    && reader.agents.some((candidate) => candidate === agent || candidate === "*"));
  const start = reader?.chromeStart ? reader.chromeStart(lines) : -1;
  if (!Number.isInteger(start) || start < -1 || start > lines.length) return null;
  if (start === -1) return lines;
  if (lines.slice(start).some((line) => {
    const command = /[/$@]\S.*$/u.exec(cleanLine(line))?.[0];
    return command !== undefined && readers.some((candidate) => candidate.agents.some((name) => name === agent || name === "*")
      && (candidate.echoOf ?? defaultEchoOf)(line, command));
  })) return null;
  return lines.slice(0, start);
}

export function dialogSettlingScreen(screen: string, agent: string, readers: readonly DialogReader[]): string {
  const lines = screenLines(screen);
  return (withoutChrome(lines, agent, readers) ?? lines).join("\n");
}

const defaultEchoOf = (line: string, command: string): boolean => {
  const match = /^[❯›>]\s+(.+)$/u.exec(cleanLine(line));
  return match !== null && normalize(match[1] ?? "") === normalize(command);
};

function anchorEnd(snapshot: readonly string[], lines: readonly string[]): number | null {
  const before = snapshot.filter((line) => line.trim());
  if (before.length === 0) return null;
  const shown = lines.flatMap((line, index) => line.trim() ? [{ line, index }] : []);
  let best = Math.min(3, before.length) - 1;
  let end: number | null = null;
  for (let at = 0; at < shown.length; at++) {
    let matched = 0;
    while (matched < before.length && matched <= at && before[before.length - 1 - matched] === shown[at - matched]?.line) matched++;
    if (matched > best) { best = matched; end = shown[at]?.index ?? null; }
    else if (matched === best) end = null;
  }
  return end;
}

function scrolledAnchor(snapshot: readonly string[], lines: readonly string[], shift: number): number | null {
  let last = snapshot.length - 1;
  while (last >= 0 && !snapshot[last]!.trim()) last -= 1;
  if (!Number.isInteger(shift) || shift < 0 || last < shift || last - shift >= lines.length) return null;
  for (let index = shift; index <= last; index++) if (snapshot[index] !== lines[index - shift]) return null;
  return last - shift;
}

const sendAnchor = (snapshot: readonly string[], lines: readonly string[], snapshotTop: number | undefined, top: number | undefined): number | null =>
  (snapshotTop !== undefined && top !== undefined ? scrolledAnchor(snapshot, lines, top - snapshotTop) : null) ?? anchorEnd(snapshot, lines);

function printedPastEarlier(sent: CommandSend, same: readonly CommandSend[], reader: DialogReader, readers: readonly DialogReader[], read: (send: CommandSend) => string[],
  counted: (send: CommandSend) => boolean): boolean {
  const known = [...same].reverse().find((candidate) => candidate.top !== undefined && counted(candidate)
    && typeof candidate.resultEchoes?.[reader.id] === "number"
    && typeof candidate.resultEchoLimit?.[reader.id] === "number");
  const owed = known?.resultEchoLimit?.[reader.id];
  if (!known || typeof owed !== "number" || known.top === undefined || sent.top === undefined) return false;
  const full = read(sent);
  const before = withoutChrome(read(known), sent.agent, readers);
  const lines = withoutChrome(full, sent.agent, readers);
  if (before === null || lines === null) return false;
  let last = before.length - 1;
  while (last >= 0 && !before[last]!.trim()) last -= 1;
  const end = known.top + last - sent.top;
  const echoOf = reader.echoOf ?? defaultEchoOf;
  const complete = lines.filter((line, index) => index > end && echoOf(line, sent.text)
    && resultBelow(sent, blockBelow(full, lines, index, echoOf), reader) !== null).length;
  return complete >= owed;
}

export function reserveResultEchoes(sent: CommandSend, previous: readonly CommandSend[], readers: readonly DialogReader[]): Readonly<Record<string, number | null>> {
  const reservations: Record<string, number | null> = {};
  const same = previous.filter((candidate) => candidate.agent === sent.agent && candidate.identity === sent.identity && normalize(candidate.text) === normalize(sent.text));
  const prior = same.at(-1);
  const alike = readAlike(sent.agent, sent.screen, ...same.map((candidate) => candidate.screen));
  const read = (send: CommandSend): string[] => alike.lines[send === sent ? 0 : same.indexOf(send) + 1]!;
  if (prior) sent.countedCut = alike.cut;
  const counted = (send: CommandSend): boolean => send.countedCut === undefined || send.countedCut === alike.cut;
  const lines = withoutChrome(read(sent), sent.agent, readers);
  for (const reader of readers) {
    if (lines === null) { reservations[reader.id] = null; continue; }
    const echoOf = reader.echoOf ?? defaultEchoOf;
    const priorOrdinal = prior?.resultEchoes?.[reader.id];
    const priorLimit = prior?.resultEchoLimit?.[reader.id];
    if (!prior) { reservations[reader.id] = 1; continue; }
    const past = (): number | null => printedPastEarlier(sent, same, reader, readers, read, counted) ? 1 : null;
    if (priorOrdinal === null || priorLimit === null) { reservations[reader.id] = past(); continue; }
    // the history rows outrank the prior screen's text: on a screen of identical blocks its tail also matches the
    // screen's own bottom and counts none of the echoes printed since, so the debt would never be paid (#1550)
    if (past() === 1) { reservations[reader.id] = 1; continue; }
    const before = withoutChrome(read(prior), sent.agent, readers);
    if (before === null) { reservations[reader.id] = null; continue; }
    const anchor = sendAnchor(before, lines, prior.top, sent.top);
    if (anchor === null) {
      reservations[reader.id] = prior.outcome?.state === "result-observed" ? 1 : past();
      continue;
    }
    if (!counted(prior)) { reservations[reader.id] = past(); continue; }
    const echoed = lines.slice(anchor + 1).filter((line) => echoOf(line, sent.text)).length;
    reservations[reader.id] = Math.max(0, (priorLimit ?? priorOrdinal ?? 1) - echoed) + 1;
  }
  return reservations;
}

const RESULT_RESERVATION_CAP = 64;
const reservationKey = (sent: CommandSend): string => JSON.stringify([sent.agent, sent.identity, normalize(sent.text)]);

export class CommandReservations {
  private sends: CommandSend[] = [];
  private transcriptClaims: { store: string; offset: number; until: number }[] = [];
  private transcriptEchoes: { store: string; offset: number; until: number }[] = [];
  private dropped = new Map<string, number>();
  private overflowUntil = 0;

  prune(now: number): void {
    for (const expired of this.sends) {
      if (expired.at + WINDOW_MS > now || expired.transcriptEvidence || expired.outcome?.state === "result-observed") continue;
      for (const pending of this.sends) {
        if (pending.at > expired.at && reservationKey(pending) === reservationKey(expired)) pending.transcriptAmbiguous = true;
      }
    }
    this.sends = this.sends.filter((sent) => sent.at + WINDOW_MS > now);
    this.transcriptClaims = this.transcriptClaims.filter((claim) => claim.until > now);
    this.transcriptEchoes = this.transcriptEchoes.filter((claim) => claim.until > now);
    for (const [key, until] of this.dropped) if (until <= now) this.dropped.delete(key);
  }

  private ambiguous(sent: CommandSend): void {
    sent.transcriptAmbiguous = true;
    sent.resultEchoLimit = Object.fromEntries(Object.keys(sent.resultEchoes ?? {}).map((id) => [id, null]));
  }

  close(text: string, at: number): void {
    for (const sent of this.sends) {
      sent.closedAt ??= at;
      if (normalize(text) !== normalize(sent.text)) sent.transcriptClosedAt ??= at;
      sent.dialogId = undefined;
    }
  }

  observeTranscript(identity: string, store: string, records: readonly CommandTranscriptRecord[], through: string | undefined): void {
    const end = this.sends.findIndex((sent) => sent.id === through);
    if (end < 0) return;
    const sends = this.sends.slice(0, end + 1).filter((sent) => sent.identity === identity);
    const used = new Set(this.transcriptClaims.filter((claim) => claim.store === store).map((claim) => claim.offset));
    const echoes = new Set(this.transcriptEchoes.filter((claim) => claim.store === store).map((claim) => claim.offset));
    const outputs = claudeOutputEchoes(records);
    for (const sent of sends) {
      if (sent.transcriptAmbiguous || sent.transcriptEvidence || (sent.transcriptStore !== undefined && sent.transcriptStore !== store)) continue;
      sent.transcriptStore = store;
      const echoed = sent.agent === "claude" || (sent.agent === "gjc" && sent.invocations[0]?.name.startsWith("skill:") === true);
      if (echoed) {
        const candidates = records.filter(({ entry, offset }) => {
          const time = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
          return (!echoes.has(offset) || offset === sent.transcriptEcho)
            && time > sent.at && time < sent.at + WINDOW_MS && commandEcho(sent.agent, entry) === echoText(sent.agent, sent.text);
        });
        const pending = sends.filter(other => other.agent === sent.agent && echoText(other.agent, other.text) === echoText(sent.agent, sent.text)
          && !other.transcriptEvidence && !other.transcriptAmbiguous
          && (other === sent || other.transcriptEcho === undefined)
          && (other.transcriptStore === undefined || other.transcriptStore === store)
          && candidates.some(({ entry }) => {
            const time = Date.parse(String(entry.timestamp));
            return time > other.at && time < other.at + WINDOW_MS;
          }));
        if (candidates.length > pending.length) {
          for (const other of pending) other.transcriptAmbiguous = true;
          continue;
        }
        if (candidates.length < pending.length) continue;
        const echo = candidates[0];
        if (echo && sent.transcriptEcho === undefined) {
          if (this.transcriptEchoes.length >= RESULT_RESERVATION_CAP) { sent.transcriptAmbiguous = true; continue; }
          sent.transcriptEcho = echo.offset;
          echoes.add(echo.offset);
          this.transcriptEchoes.push({ store, offset: echo.offset, until: Date.parse(String(echo.entry.timestamp)) + WINDOW_MS });
        }
      }
      const evidence = transcriptEvidence(sent, records, sent.at + WINDOW_MS, used,
        echoed ? sent.transcriptEcho ?? null : undefined, outputs);
      if (!evidence) continue;
      if (this.transcriptClaims.length >= RESULT_RESERVATION_CAP) {
        sent.transcriptAmbiguous = true;
        continue;
      }
      sent.transcriptEvidence = evidence;
      used.add(evidence.offset);
      this.transcriptClaims.push({ store, offset: evidence.offset, until: evidence.at + WINDOW_MS });
    }
  }

  add(sent: CommandSend, readers: readonly DialogReader[]): void {
    this.prune(sent.at);
    const key = reservationKey(sent);
    sent.resultEchoes = reserveResultEchoes(sent, this.sends, readers);
    sent.resultEchoLimit = { ...sent.resultEchoes };
    for (const prior of this.sends) {
      if (reservationKey(prior) !== key) continue;
      prior.resultEchoLimit = Object.fromEntries(Object.entries(prior.resultEchoLimit ?? prior.resultEchoes ?? {})
        .map(([id, count]) => [id, count === null ? null : count + 1]));
    }
    if (this.overflowUntil > sent.at || (this.dropped.get(key) ?? 0) > sent.at) this.ambiguous(sent);
    this.sends.push(sent);
    if (this.sends.length <= RESULT_RESERVATION_CAP) return;
    const dropped = this.sends.shift();
    if (!dropped) return;
    const droppedKey = reservationKey(dropped);
    const until = Math.max(dropped.at + WINDOW_MS, this.dropped.get(droppedKey) ?? 0);
    if (this.dropped.size >= RESULT_RESERVATION_CAP && !this.dropped.has(droppedKey)) {
      this.overflowUntil = Math.max(this.overflowUntil, until, ...this.dropped.values());
      this.dropped.clear();
      for (const pending of this.sends) this.ambiguous(pending);
    } else {
      this.dropped.set(droppedKey, until);
      for (const pending of this.sends) if (reservationKey(pending) === droppedKey) this.ambiguous(pending);
    }
  }
}

export function ownsCommandDialog(sent: CommandSend, prompt: ParsedPrompt, screen: string, reader: DialogReader, readers: readonly DialogReader[]): boolean {
  if (prompt.kind === "approval" || prompt.kind === "plan" || reader.id === "claude-confirm") return false;
  if (sent.form?.dialog) return sent.form.dialog === reader.id;
  const below = ownedCommandScreen(sent, screen, reader, readers);
  return below !== null && reader.parse(below, {
    agent: sent.agent, omoAsk: null, omoTrusted: false, omoOpen: [], sent: sent.text, working: false,
  })?.id === prompt.id;
}

function ownedCommandScreen(sent: CommandSend, screen: string, reader: DialogReader, readers: readonly DialogReader[], top?: number): string | null {
  const alike = readAlike(sent.agent, screen, sent.screen);
  if (sent.countedCut !== undefined && sent.countedCut !== alike.cut) return null;
  const [fullLines, sentLines] = alike.lines as [string[], string[]];
  const lines = withoutChrome(fullLines, sent.agent, readers);
  const before = withoutChrome(sentLines, sent.agent, readers);
  if (lines === null || before === null) return null;
  const anchor = sendAnchor(before, lines, sent.top, top);
  if (anchor === null) return null;
  const ordinal = sent.resultEchoes?.[reader.id];
  const reserved = sent.resultEchoLimit?.[reader.id];
  if (ordinal === null || reserved === null) return null;
  const echoOf = reader.echoOf ?? defaultEchoOf;
  const echoes = lines.flatMap((line, index) => index > anchor && echoOf(line, sent.text) ? [index] : []);
  if (echoes.length > (reserved ?? ordinal ?? 1)) return null;
  const echo = echoes[(ordinal ?? 1) - 1];
  if (echo === undefined) return null;
  return blockBelow(fullLines, lines, echo, echoOf);
}

function blockBelow(fullLines: readonly string[], lines: readonly string[], echo: number, echoOf: NonNullable<DialogReader["echoOf"]>): string {
  const next = lines.findIndex((line, index) => {
    if (index <= echo) return false;
    const command = /[/$@]\S.*$/u.exec(cleanLine(line))?.[0];
    return command !== undefined && echoOf(line, command);
  });
  return fullLines.slice(echo + 1, next === -1 ? undefined : next + 1).join("\n");
}

function resultBelow(sent: CommandSend, below: string, reader: DialogReader): { text: string; catalogChanged?: true } | null {
  const parsed = reader.parse(below, { agent: sent.agent, omoAsk: null, omoTrusted: false, omoOpen: [], sent: sent.text, working: false });
  const block = parsed?.resultText?.replace(ANSI_RE, "").replace(/\r\n/gu, "\n");
  if (!block || !below.includes(block) || below.slice(0, below.indexOf(block)).trim()) return null;
  return { text: block, ...(parsed?.catalogChanged ? { catalogChanged: true as const } : {}) };
}

function recognizedResult(sent: CommandSend, screen: string, readers: readonly DialogReader[], top?: number): { text: string; catalogChanged?: true } | null {
  for (const reader of readers) {
    if (reader.kind !== "result" || !reader.agents.some((agent) => agent === sent.agent || agent === "*")
      || (sent.form?.dialog && sent.form.dialog !== reader.id)) continue;
    const below = ownedCommandScreen(sent, screen, reader, readers, top);
    const result = below === null ? null : resultBelow(sent, below, reader);
    if (result) return result;
  }
  return null;
}

export function commandOutcome(paneId: string, sent: CommandSend, observation: OutcomeObservation): CommandOutcome {
  const now = observation.now;
  const until = Math.min(sent.closedAt ?? Infinity, observation.nextAt ?? Infinity, sent.at + WINDOW_MS);
  const previous = sent.outcome;
  let state: CommandOutcome["state"] = sent.form?.interaction === "terminal" ? "terminal-required" : "accepted";
  let evidence = previous?.evidence ?? [];
  let catalogChanged = previous?.catalog_changed;
  let resultText = previous?.result_text;
  if (previous?.state === "result-observed") state = previous.state;
  else if (state !== "terminal-required") {
    const records = typeof observation.transcript === "string" ? commandTranscriptRecords(observation.transcript) : observation.transcript ?? [];
    const recorded = observation.transcriptAt ?? transcriptEvidence(sent, records, until)?.at ?? null;
    const external = observation.evidence;
    const validExternal = external && external.at > sent.at && external.at < (external.named ? sent.at + WINDOW_MS : until) ? external : undefined;
    const result = now < sent.at + WINDOW_MS
      ? recognizedResult(sent, observation.resultScreen ?? observation.screen ?? "", observation.readers ?? [], observation.top) : null;
    if (recorded !== null || validExternal || result) {
      state = "result-observed";
      evidence = [{ kind: recorded !== null ? "transcript" : validExternal?.kind ?? "recognized-result",
        at: new Date(recorded ?? validExternal?.at ?? now).toISOString() }];
      catalogChanged = validExternal?.catalogChanged ?? result?.catalogChanged;
      resultText = recorded === null && !validExternal ? result?.text.slice(0, 2000) : undefined;
    } else if (sent.form?.interaction === "dialog" && previous?.state === "terminal-required") state = previous.state;
    else if (observation.nextAt !== undefined || now >= until) state = "unknown";
    else if (observation.dialog && (!sent.form?.dialog || sent.form.dialog === observation.dialog.reader)) state = "interaction-required";
    else if (sent.form?.interaction === "dialog" && !sent.dialogObserved && !observation.dialog
      && observation.settledSince !== undefined && observation.settledSince >= sent.at
      && now - observation.settledSince >= 2000) state = "terminal-required";
    else if (observation.waitingSince !== undefined && now - observation.waitingSince >= 2000) state = "terminal-required";
  }
  const preview = sent.screen !== "" && now < until && observation.screen !== undefined && observation.screen !== sent.screen
    ? observation.screen.replace(ANSI_RE, "").slice(-2000) : undefined;
  const changed = previous?.state !== state || previous.preview !== preview || previous.catalog_changed !== catalogChanged;
  return {
    id: sent.id, pane_id: paneId, text: sent.text, state, evidence,
    ...(preview ? { preview } : {}), ...(resultText ? { result_text: resultText } : {}), ...(catalogChanged ? { catalog_changed: true } : {}),
    ...(sent.note ? { note: sent.note } : {}),
    ...(sent.unattached?.length ? { unattached_skills: [...sent.unattached] } : {}),
    created_at: new Date(sent.at).toISOString(), updated_at: changed ? new Date(now).toISOString() : previous.updated_at,
  };
}
