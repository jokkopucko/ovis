/**
 * OpenCode v2 attaches a skill only when its own TUI autocomplete row is accepted
 * (packages/tui/src/component/prompt/autocomplete.tsx registers `prompt.skills`; core's
 * session/prompt.ts reads `input.skills`, at 843a6c51): a pasted `@id` stays plain text. So each
 * `@<id>` skill token is typed, its row read off the screen, and accepted with the recorded key.
 * The callers keep their own ownership, identity, held-draft and single-delivery checks; every
 * write here asks `allowed` first, as theirs do.
 */
import { HerdrError, paneRead, paneSendKeys, paneSendText } from "./herdr/client.ts";

/** the key that accepted the selected row in the 2.0.32 recordings (fixtures opencode-autocomplete-2.0.32-skill-*) */
export const OPENCODE_SKILL_ACCEPT_KEY = "Tab";
export const OPENCODE_SKILL_ROW_WAIT_MS = 2_000;
/** how long the screen after the key may take to show the accepted skill */
export const OPENCODE_SKILL_ACCEPT_WAIT_MS = 1_000;
const ROW_POLL_MS = 50;

type Cell = { ch: string; bg: string; fg: string; bold: boolean };

/** One screen line as cells with the background and weight SGR gave them; other escapes are dropped. */
function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let bg = "default";
  let fg = "default";
  let bold = false;
  for (let at = 0; at < line.length;) {
    if (line[at] === "\u001b") {
      const sgr = /^\u001b\[([0-9;:]*)m/u.exec(line.slice(at));
      if (sgr) {
        const codes = sgr[1] === "" ? [0] : sgr[1]!.split(/[;:]/u).map(Number);
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i]!;
          if (code === 0) { bg = "default"; fg = "default"; bold = false; }
          else if (code === 1) bold = true;
          else if (code === 22) bold = false;
          else if (code === 49) bg = "default";
          else if (code === 39) fg = "default";
          else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) fg = String(code);
          else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) bg = String(code);
          else if ((code === 38 || code === 48) && codes[i + 1] === 2) { const color = codes.slice(i + 2, i + 5).join(","); if (code === 48) bg = color; else fg = color; i += 4; }
          else if ((code === 38 || code === 48) && codes[i + 1] === 5) { const color = `5:${codes[i + 2]}`; if (code === 48) bg = color; else fg = color; i += 2; }
        }
        at += sgr[0].length;
        continue;
      }
      const other = /^\u001b(?:\[[0-9;:?]*[A-Za-z]|\][^\u0007]*\u0007|.)/u.exec(line.slice(at));
      at += other ? other[0].length : 1;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(at)!);
    out.push({ ch, bg, fg, bold });
    at += ch.length;
  }
  return out;
}

const textOf = (line: Cell[]): string => line.map((cell) => cell.ch).join("").trimEnd();

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * The autocomplete exactly as recorded on 2.0.32 (fixtures opencode-autocomplete-2.0.32-*), typed `@id`:
 * - a box of rows `┃ … ┃` sharing one left and one right border;
 * - right under it, at the same left border: a bare `┃`, the input row(s) ending in the typed `@id`,
 *   a bare `┃`, the agent/model row, and the prompt's bottom edge `╹▀…` as wide as the box.
 * Returns its rows (as cells) and its agent row, or null for any other layout.
 */
function autocomplete(screen: string, id: string): { rows: Cell[][]; panel: string; agent: string; inputFg: string; inputPrefix: string; inputTokens: string[] } | null {
  const all = screen.split(/\r?\n/u).map(cells);
  const lines = all.map(textOf);
  const boxRow = /^( *)┃ (.*) ┃$/u;
  const first = lines.findIndex((line) => boxRow.test(line));
  if (first < 0) return null;
  const indent = boxRow.exec(lines[first]!)![1]!;
  const width = Bun.stringWidth(lines[first]!);
  let at = first + 1;
  while (at < lines.length && boxRow.exec(lines[at]!)?.[1] === indent && Bun.stringWidth(lines[at]!) === width) at++;
  if (at < lines.length && boxRow.test(lines[at]!)) return null;
  const rows = all.slice(first, at);
  const bare = `${indent}┃`;
  const filled = new RegExp(`^${indent}┃ +\\S`, "u");
  if (lines[at++] !== bare) return null;
  const input = at;
  while (at < lines.length && filled.test(lines[at]!) && !lines[at]!.endsWith(`@${id}`)) at++;
  if (at >= lines.length || !new RegExp(`^${indent}┃ +(?:.* )?@${escape(id)}$`, "u").test(lines[at]!) || at - input > 8) return null;
  // the input row's own background, right after its border: the colour of a row nobody selected
  const panel = all[at]![indent.length + 1]?.bg ?? "default";
  const inputFg = all[at]!.filter((cell) => cell.ch.trim() !== "").at(-1)!.fg;
  const inputText = lines.slice(input, at + 1).map((line) => line.replace(/^ *┃ */u, "")).join(" ");
  const inputPrefix = inputText.slice(0, inputText.lastIndexOf(`@${id}`)).replace(/\s/gu, "");
  const inputTokens = [...inputText.matchAll(/(?:^|\s)@(\S+)/gu)].map((match) => match[1]!);
  at++;
  // the prompt's bottom edge spans the box's own width, as in the recordings (39, 74 and 98 columns)
  const bottom = lines[at + 2] ?? "";
  if (lines[at] !== bare || !filled.test(lines[at + 1] ?? "") || !new RegExp(`^${indent}╹▀+$`, "u").test(bottom) || Bun.stringWidth(bottom) !== width) return null;
  return { rows, panel, agent: lines[at + 1]!, inputFg, inputPrefix, inputTokens };
}

/**
 * Whether `@id`'s skill row (`@id [description]` padded to the kind label `skill`, autocomplete.tsx
 * labels[kind]) is the selected row of the recorded autocomplete. The selection is drawn only as the
 * row's background (2.0.32: the accent colour, every other row the panel's), read from the screen's
 * colours: exactly one row may differ from the panel, and it must be that skill row. A box of a single
 * row has nothing else to select. Anything else (no colours, another row selected, another layout)
 * is not a selection, and nothing is accepted.
 */
export function skillRowSelected(screen: string, id: string): boolean {
  const box = autocomplete(screen, id);
  if (!box) return false;
  const skillRow = new RegExp(`^@${escape(id)}(?: .*\\S)?\\s{2,}skill$`, "u");
  const indent = textOf(box.rows[0]!).indexOf("┃");
  const content = (row: Cell[]): string => /^ *┃ (.*) ┃$/u.exec(textOf(row))?.[1] ?? "";
  const target = box.rows.findIndex((row) => skillRow.test(content(row)));
  if (target < 0) return false;
  if (box.rows.length === 1) return true;
  const selected = box.rows.flatMap((row, index) => (row[indent + 2]?.bg ?? box.panel) !== box.panel ? [index] : []);
  return selected.length === 1 && selected[0] === target;
}

/** Only the explicit agent label before the model separator is an identity; narrow model-only rows aren't. */
const agentName = (line: string): string | null => /^ *┃ +(.+?)\s+·(?:\s|$)/u.exec(line)?.[1]?.trim().replace(/\s+/gu, " ") ?? null;

/** The current prompt, anchored at its bottom edge, not an earlier bordered content block. */
function promptState(screen: string, id: string, inputFg?: string): { agent: string | null; attached: boolean; space: boolean; token: string | null; prefix: string | null } | null {
  const all = screen.split(/\r?\n/u).map(cells);
  const lines = all.map(textOf);
  let bottom = lines.length - 1;
  while (bottom >= 0 && !/^ *╹▀+$/u.test(lines[bottom]!)) bottom--;
  if (bottom < 3 || !/^ *┃ +\S/u.test(lines[bottom - 1]!)) return null;
  const agent = agentName(lines[bottom - 1]!);
  const indent = lines[bottom]!.indexOf("╹");
  const bare = `${" ".repeat(indent)}┃`;
  if (lines[bottom - 2] !== bare) return null;
  const top = lines.lastIndexOf(bare, bottom - 3);
  if (top < 0) return null;
  for (let index = bottom - 3; index > top; index--) {
    // the last such token on the row: an earlier one can be a skill attached before it
    const match = [...lines[index]!.matchAll(/(?:^|\s)(@\S+)(?=\s|$)/gu)].at(-1);
    if (!match || !/^ *┃ /u.test(lines[index]!)) continue;
    const token = match[1]!;
    // the match counts UTF-16 units, the cells one code point each: an emoji before the token is two units
    const prefix = lines[index]!.slice(0, match.index + match[0].length - token.length);
    const start = Array.from(prefix).length;
    const width = Array.from(token).length;
    const tokenCells = all[index]!.slice(start, start + width);
    const next = all[index]![start + width];
    const paddingFg = all[index]![indent + 1]?.fg;
    // Tab inserts a space drawn as input text, not panel padding. Without a pre-Tab colour,
    // only that text-coloured separator can establish the normal input foreground.
    const normalFg = inputFg ?? (next?.ch === " " && next.fg !== paddingFg ? next.fg : undefined);
    // Nothing after the token is typed yet, so a word starting the next input row is the token's own
    // wrapped tail (`@effect` + `-two`): the token is the two joined, never the first piece alone.
    const rowEnds = next === undefined || next.ch === " " && next.fg === paddingFg;
    const tail = rowEnds && index + 1 < bottom - 2 ? /^ *┃ +(\S+)/u.exec(lines[index + 1]!)?.[1] : undefined;
    const attached = tail === undefined && token === `@${id}` && tokenCells.length === width && (tokenCells.every((cell) => cell.bold)
      || normalFg !== undefined && tokenCells.every((cell) => cell.fg !== "default" && cell.fg === tokenCells[0]!.fg && cell.fg !== normalFg));
    const space = next?.ch === " " && normalFg !== undefined && next.fg === normalFg && next.fg !== paddingFg;
    const joinedPrefix = [...lines.slice(top + 1, index), prefix].map((line) => line.replace(/^ *┃ */u, "")).join(" ").replace(/\s/gu, "");
    return { agent, attached, space, token: `${token}${tail ?? ""}`.slice(1), prefix: joinedPrefix };
  }
  return { agent, attached: false, space: false, token: null, prefix: null };
}

/**
 * A closed autocomplete, a styled token in the prompt, and the same agent (not necessarily model).
 * The agents are compared only when both rows name one: a narrow model-only row (before or after a
 * resize during Tab) shows no agent, so it can neither confirm nor refute one. That means a model-only
 * row is accepted here even when the row before Tab named an agent; a caller must not take that alone
 * as "same agent". typeWithSkills holds such a row until its deadline and refuses a switch it saw.
 */
export function skillAccepted(screen: string, id: string, agent: string, inputFg?: string): boolean {
  if (autocomplete(screen, id)) return false;
  const state = promptState(screen, id, inputFg);
  const before = agentName(agent);
  return state?.attached === true && (state.agent === null || before === null || state.agent === before);
}

/** The `@id` tokens of `text` that name one of `skills`, in order, each once. */
export function skillTokens(text: string, skills: readonly string[]): string[] {
  const known = new Set(skills);
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/gu)) {
    const id = match[1]!;
    if (known.has(id) && !found.includes(id)) found.push(id);
  }
  return found;
}

export interface SkillAttachIo {
  sendText(text: string, allowed: () => boolean): Promise<void>;
  sendKeys(keys: string[], allowed: () => boolean): Promise<void>;
  screen(): Promise<string>;
  wait(ms: number): Promise<void>;
  now(): number;
}

export const herdrSkillAttachIo = (paneId: string): SkillAttachIo => ({
  sendText: (text, allowed) => paneSendText(paneId, text, undefined, allowed),
  sendKeys: (keys, allowed) => paneSendKeys(paneId, keys, undefined, allowed),
  // the visible screen with its colours: the selected row and an attached skill are drawn only in them
  screen: async () => (await paneRead({ paneId, source: "visible", format: "ansi" })).text,
  // fixed wait: the poll interval of typeWithSkills' deadline-bounded read of the autocomplete row
  wait: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
});

const paste = (text: string): string => `\u001b[200~${text}\u001b[201~`;

/** What reached the prompt, piece by piece: typed keys, or one bracketed paste (OpenCode treats them differently). */
export type PromptPiece = { typed: string } | { pasted: string };

/**
 * Types `text` (without its Enter) with each `@id` of `skills` through the autocomplete. A token
 * whose row is not recognized within OPENCODE_SKILL_ROW_WAIT_MS stays plain text (a space closes
 * the box), and is reported missed. Throws HerdrError cancelled when `allowed` refuses a write.
 * `revalidate` re-runs the caller's ownership, session-identity and state checks (they await herdr)
 * right before every write, so nothing is typed into a session that replaced the one checked.
 */
export async function typeWithSkills(text: string, skills: readonly string[], allowed: () => boolean, io: SkillAttachIo, revalidate: () => Promise<void>,
  beforeKey: (screen: string) => Promise<void> = async () => {}): Promise<{ attached: string[]; missed: string[]; prompt: PromptPiece[] }> {
  const attached: string[] = [];
  const missed: string[] = [];
  const prompt: PromptPiece[] = [];
  const write = async (send: () => Promise<void>): Promise<void> => {
    await revalidate();
    if (!allowed()) throw new HerdrError("cancelled", "The message's sender may no longer type into this pane");
    await send();
  };
  const tokens = skillTokens(text, skills);
  let rest = text;
  let afterAccept = false;
  for (const id of tokens) {
    const match = new RegExp(`(^|\\s)@${id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=\\s|$)`, "u").exec(rest);
    if (!match) continue;
    let before = rest.slice(0, match.index + match[1]!.length);
    if (afterAccept) before = before.replace(/^ /u, "");
    if (before) { await write(() => io.sendText(paste(before), allowed)); prompt.push({ pasted: before }); }
    rest = rest.slice(match.index + match[0].length);
    await write(() => io.sendText(`@${id}`, allowed));
    let seen = false;
    for (const deadline = io.now() + OPENCODE_SKILL_ROW_WAIT_MS; !(seen = skillRowSelected(await io.screen(), id)) && io.now() < deadline;) await io.wait(ROW_POLL_MS);
    let accepted = false;
    let insertedSpace = false;
    if (seen) {
      // the checks awaited herdr: the box is read again right before the key, which goes only to that selected row
      await revalidate();
      if (!allowed()) throw new HerdrError("cancelled", "The message's sender may no longer type into this pane");
      const before = await io.screen();
      const box = autocomplete(before, id);
      // A read cannot guard the subsequent write atomically: that needs conditional herdr send-keys.
      if (box && skillRowSelected(before, id)) {
        // the caller's last checks on the screen this key was decided on, which cost it no further read
        await beforeKey(before);
        await io.sendKeys([OPENCODE_SKILL_ACCEPT_KEY], allowed);
        // attached only as the screen after the key shows it
        const deadline = io.now() + OPENCODE_SKILL_ACCEPT_WAIT_MS;
        const from = agentName(box.agent);
        let lastAgent: string | null = null;
        // another agent named after Tab and not named back since: a model-only read cannot clear it
        let switched: string | null = null;
        do {
          const screen = await io.screen();
          const late = io.now() >= deadline;
          const state = promptState(screen, id, box.inputFg);
          if (state?.token != null && state.token !== id && (state.prefix === box.inputPrefix || !box.inputTokens.includes(state.token))) {
            throw new HerdrError("submit_changed", "OpenCode attached another skill. Your chat text stayed here. Check the terminal before sending again.");
          }
          // Tab's space is evidence of its own: a text-coloured separator, or the token drawn attached
          // (accepting the row typed `@id `). Neither waits on the agent check below, so a later blank or
          // partial read cannot make the rest add a second space.
          if (state?.token === id && !autocomplete(screen, id)) insertedSpace ||= state.space || state.attached;
          // Two consistent reads confirm a switch. A switch still showing on the last read has had no second
          // read, but it is not resolved either, and the rest and Enter would go to that other agent.
          if (from !== null && state?.agent != null && state.agent !== from && (state.agent === lastAgent || late)) {
            throw new HerdrError("submit_changed", `Tab switched OpenCode's agent from ${JSON.stringify(from)} to ${JSON.stringify(state.agent)}. Nothing more was typed.`);
          }
          if (from !== null && state?.agent != null) switched = state.agent === from ? null : state.agent;
          if (switched !== null && late) {
            throw new HerdrError("submit_changed", `Tab switched OpenCode's agent from ${JSON.stringify(from)} to ${JSON.stringify(switched)}. Nothing more was typed.`);
          }
          // a model-only row cannot show a switch from a named agent: it is taken only once the wait is up
          accepted = switched === null && (from === null || state?.agent != null || late) && skillAccepted(screen, id, box.agent, box.inputFg);
          insertedSpace ||= accepted;
          if (accepted || late) break;
          lastAgent = state?.agent ?? null;
          await io.wait(ROW_POLL_MS);
        } while (true);
      }
    }
    if (accepted) attached.push(id);
    else missed.push(id);
    afterAccept = insertedSpace;
    prompt.push({ typed: `@${id}${insertedSpace ? " " : ""}` });
    if (!insertedSpace && !/^\s/u.test(rest)) { await write(() => io.sendText(" ", allowed)); prompt.push({ typed: " " }); }
  }
  if (afterAccept) rest = rest.replace(/^ /u, "");
  // a trailing @mention would leave OpenCode's file box open for the Enter: closed with a space, as closeMention does for a paste
  if (/(?:^|\s)@\S+$/u.test(rest)) rest += " ";
  if (rest) { await write(() => io.sendText(paste(rest), allowed)); prompt.push({ pasted: rest }); }
  return { attached, missed, prompt };
}
