import type { DialogReader } from "./registry.ts";
import { ANSI_RE, CARD_BODY_MAX, type MenuRow, type ParsedPrompt, cleanLine, finishPrompt, isDivider } from "./shared.ts";

// Kiro V3's footer, whole:
// 1. Wide default (`O$n`): `esc to close · ↑↓ to navigate · ↵ to select` (+ optional `· Tab to edit`)
// 2. Narrow compact (`ari` strips `to ` from every action and omits `·` at line wraps):
//    `esc close [·| ] ↑↓ navigate [·| ] ↵ select` (+ optional `[·| ] Tab edit`)
// 3. Rule row focused (`hr` with `footerLeft`): `esc to close · Enter to see more options`
export const KIRO_APPROVAL_HINT_RE = /^(?:esc to close\s*·\s*↑↓\s*to navigate\s*·\s*↵\s*to select(?:\s*·\s*tab to edit)?|esc close(?:\s*·\s*|\s+)↑↓\s*navigate(?:\s*·\s*|\s+)↵\s*select(?:(?:\s*·\s*|\s+)tab edit)?|esc to close\s*·\s*enter to see more options)$/i;
const KIRO_APPROVAL_HEADER_RE = /\brequires approval\s*$/i;
const KIRO_DETAIL_RE = /^\S+\s*→/;
// only the choices Kiro draws: a command's own lines must never read as one
const KIRO_ROW_RE = /^([❯›>])?\s*(.+)$/;
// Exact option sequences Kiro V3 draws (tui.js sri/PAe + optional Approve-for-me promo; plus Kiro 2.32 V3).
// Requiring a complete menu starting with Allow / Allow once and containing Deny / Deny once rejects clipped tails
// (e.g. a narrow pane that cut "Allow once" off the top) while still accepting shorter menus when rule options omit.
const KIRO_V3_6_MAIN_MENUS: readonly (readonly string[])[] = [
  ["Allow once", "Deny once", "Create allow rule to approve future similar actions", "Create deny rule to block future similar actions"],
  ["Allow once", "Deny once", "Create allow rule to approve future similar actions"],
  ["Allow once", "Deny once", "Create deny rule to block future similar actions"],
  ["Allow once", "Deny once"],
];
const KIRO_V3_6_MAIN_LABELS: ReadonlySet<string> = new Set(KIRO_V3_6_MAIN_MENUS[0]);
const KIRO_APPROVE_FOR_ME_LABEL = "Allow once and enable Approve for me";
const KIRO_APPROVE_FOR_ME_NOTE = "Approve for me lets Kiro approve routine actions, block risky ones, and ask when unsure.";
const KIRO_V2_32_MENUS: readonly (readonly string[])[] = [
  ["Allow", "Always allow", "Deny", "Always deny"],
  ["Allow", "Always allow", "Deny"],
  ["Allow", "Deny", "Always deny"],
  ["Allow", "Deny"],
];
const KIRO_V2_32_LABELS: ReadonlySet<string> = new Set(KIRO_V2_32_MENUS[0]);
// Kiro's Lf() line-truncation suffix and Mwi()/Lc() multiline fold suffix (`...+N lines`):
// never offer a card for a command whose hidden lines or tail the user cannot see, even when a classifier reason
// paragraph (`Rwi`) sits below the command preview.
const KIRO_TRUNCATED_END_RE = /(?:\[\d+ more characters not shown\]|\.\.\.\+\d+ lines?)$/u;

const sameLabels = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.length === expected.length && actual.every((label, index) => label === expected[index]);

/**
 * The footer's first line when Kiro's footer ends the screen, on one line or wrapped over up to three (matching
 * live.ts `ends`); -1 when it does not. A footer above later output is an answered menu, not one waiting.
 */
function hintStart(lines: string[]): number {
  const shown = lines.flatMap((line, index) => cleanLine(line) && !isDivider(line) ? [index] : []);
  for (let span = 1; span <= 3 && span <= shown.length; span += 1) {
    const tail = shown.slice(-span);
    if (KIRO_APPROVAL_HINT_RE.test(tail.map((index) => cleanLine(lines[index]!)).join(" "))) return tail[0]!;
  }
  return -1;
}

/**
 * Normalize approval detail lines while preserving literal characters (`│`, box-drawing text) and relative indentation
 * (for heredocs / Python / YAML): trim trailing spaces, drop leading/trailing blank lines, and remove only the common
 * leading space margin Kiro's `paddingX: 1` adds to every non-empty line.
 */
function formatDetail(rawLines: readonly string[]): string {
  const lines = rawLines.map((line) => line.trimEnd());
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  let end = lines.length;
  while (end > start && lines[end - 1]!.trim() === "") end -= 1;
  const trimmed = lines.slice(start, end);
  if (trimmed.length === 0) return "";
  const nonEmpty = trimmed.filter((line) => line.trim() !== "");
  const margin = Math.min(...nonEmpty.map((line) => line.length - line.trimStart().length));
  return trimmed.map((line) => (line.trim() === "" ? "" : line.slice(margin))).join("\n");
}

/** Whether any line or paragraph of the detail preview ends with Kiro's truncation/fold suffix or exceeds the card cap. */
function detailTruncated(detail: string): boolean {
  if (detail.length > CARD_BODY_MAX) return true;
  if (detail.split("\n").some((line) => KIRO_TRUNCATED_END_RE.test(line.trimEnd()))) return true;
  return detail.split(/\n[ \t]*\n/).some((paragraph) => KIRO_TRUNCATED_END_RE.test(paragraph.replace(/\s+/gu, " ").trim()));
}

interface ParsedKiroApproval {
  readonly header: string;
  readonly detail: string;
  readonly rows: MenuRow[];
  readonly truncated: boolean;
  readonly ambiguous: boolean;
}

function readKiroApproval(screen: string): ParsedKiroApproval | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = hintStart(lines);
  if (hintIndex < 0) return null;
  let index = hintIndex - 1;
  while (index >= 0 && (!cleanLine(lines[index]!) || isDivider(lines[index]!))) index -= 1;

  // Kiro 3.6.2 shows an explanatory note under "Allow once and enable Approve for me" (may wrap on narrow panes)
  let sawApproveForMeNote = false;
  for (let span = 1; span <= 3 && index - span + 1 >= 0; span += 1) {
    const slice = lines.slice(index - span + 1, index + 1);
    if (slice.some((line) => !cleanLine(line) || isDivider(line))) break;
    if (slice.map(cleanLine).join(" ") === KIRO_APPROVE_FOR_ME_NOTE) {
      index -= span;
      sawApproveForMeNote = true;
      break;
    }
  }
  while (index >= 0 && !cleanLine(lines[index]!)) index -= 1;

  const rows: MenuRow[] = [];
  let family: "v3.6" | "v2.32" | null = null;

  // Optional 5th row ("Allow once and enable Approve for me") sits below a single separator divider
  const tail = index >= 0 ? KIRO_ROW_RE.exec(cleanLine(lines[index]!)) : null;
  const hasApproveForMe = Boolean(tail && tail[2] === KIRO_APPROVE_FOR_ME_LABEL);
  if (hasApproveForMe) {
    rows.unshift({ label: tail![2]!, selected: Boolean(tail![1]), checked: false, lineIndex: index });
    family = "v3.6";
    index -= 1;
    while (index >= 0 && !cleanLine(lines[index]!)) index -= 1;
    if (index >= 0 && isDivider(lines[index]!)) index -= 1;
    while (index >= 0 && !cleanLine(lines[index]!)) index -= 1;
  } else if (sawApproveForMeNote) {
    return null;
  }

  for (; index >= 0; index -= 1) {
    const match = KIRO_ROW_RE.exec(cleanLine(lines[index]!));
    if (!match) break;
    const label = match[2]!;
    if (KIRO_V3_6_MAIN_LABELS.has(label) && (family === null || family === "v3.6")) {
      family = "v3.6";
      rows.unshift({ label, selected: Boolean(match[1]), checked: false, lineIndex: index });
    } else if (KIRO_V2_32_LABELS.has(label) && (family === null || family === "v2.32")) {
      family = "v2.32";
      rows.unshift({ label, selected: Boolean(match[1]), checked: false, lineIndex: index });
    } else {
      break;
    }
  }

  const labels = rows.map((row) => row.label);
  const mainLabels = hasApproveForMe ? labels.slice(0, -1) : labels;
  const validMenu = family === "v3.6"
    ? KIRO_V3_6_MAIN_MENUS.some((expected) => sameLabels(mainLabels, expected))
    : family === "v2.32" && KIRO_V2_32_MENUS.some((expected) => sameLabels(mainLabels, expected));
  if (!validMenu || new Set(labels).size !== labels.length || rows.filter((row) => row.selected).length !== 1) return null;

  // Kiro always draws a blank line between the detail block and the first option row; without it, a command line
  // touching the top of the menu could masquerade as an extra option
  const aboveRows = rows[0]!.lineIndex - 1;
  if (aboveRows < 0 || cleanLine(lines[aboveRows]!) !== "") return null;

  // the header is the line right over the tool's "<tool> → …" detail. The screen above is the agent's to
  // draw: a command that prints another such pair (or a footer) could pass for it and hide what is above,
  // so the whole screen must hold one, else no card
  const headers: number[] = [];
  for (let at = aboveRows - 1; at >= 0; at -= 1) {
    if (KIRO_APPROVAL_HEADER_RE.test(cleanLine(lines[at]!)) && KIRO_DETAIL_RE.test(cleanLine(lines[at + 1] ?? ""))) headers.push(at);
  }
  if (headers.length === 0) return null;
  const headerIndex = headers[0]!;
  const header = cleanLine(lines[headerIndex]!);
  const detail = formatDetail(lines.slice(headerIndex + 1, rows[0]!.lineIndex));
  if (!detail) return null;
  // Check truncation across the earliest header-to-rows span too, so an ambiguous header above a truncated command
  // still suppresses the generic fallback card
  const fullDetail = headers.length === 1 ? detail : formatDetail(lines.slice(headers.at(-1)! + 1, rows[0]!.lineIndex));
  const truncated = detailTruncated(detail) || detailTruncated(fullDetail);
  return { header, detail, rows, truncated, ambiguous: headers.length !== 1 };
}

/**
 * Whether Kiro's approval is one the terminal must answer: its command preview is truncated or folded
 * (`[N more characters not shown]`, `...+N lines`, or over `CARD_BODY_MAX`), also when a row the reader cannot read
 * (a label wrapped on a narrow pane) keeps it from a card, or the screen holds two header/detail pairs. Neither
 * `kiro-approval` nor a generic fallback card answers it.
 */
export function kiroApprovalLeftToTerminal(screen: string): boolean {
  const parsed = readKiroApproval(screen);
  if (parsed !== null) return parsed.truncated || parsed.ambiguous;
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = hintStart(lines);
  if (hintIndex < 0) return false;
  for (let at = hintIndex - 1; at >= 0; at -= 1) {
    if (KIRO_APPROVAL_HEADER_RE.test(cleanLine(lines[at]!))) return detailTruncated(formatDetail(lines.slice(at + 1, hintIndex)));
  }
  return false;
}

/**
 * Whether Kiro's approval footer ends the screen (any of its forms, the rule row's `Enter to see more options` among
 * them, and whether or not the reader could read the rows): queued messages must hold rather than pressing Enter
 * into the menu.
 */
export function kiroApprovalWaits(screen: string): boolean {
  return hintStart(screen.replace(ANSI_RE, "").split(/\r?\n/)) >= 0;
}

/**
 * Kiro V3's approval (3.6.2 and 2.32): a "<what> requires approval" header, its detail ("shell → <command>",
 * "fs_write → <path>", …), the rows right above the footer, selected with arrows and Enter, never digit keys.
 * Every line between the header and the rows is the body, preserving relative indentation and literal characters
 * (and when Kiro's V3 session record holds the pending shell command, `withRecord` binds the card to that exact
 * request and unwraps it).
 */
function parseKiroApproval(screen: string): ParsedPrompt | null {
  const parsed = readKiroApproval(screen);
  if (parsed === null || parsed.truncated || parsed.ambiguous) return null;
  const labels = parsed.rows.map((row) => row.label);
  return finishPrompt("kiro", {
    kind: "approval", title: parsed.header, question: parsed.header,
    body: parsed.detail,
    options: labels.map((label) => ({ label, description: null })), multi_select: false, custom_option_index: null,
  }, {
    responder: "kiro-approval", menuLabels: labels,
    selectedIndex: parsed.rows.findIndex((row) => row.selected), checkedOptionIndices: [], customMenuIndex: null,
    rejectWithEscapeIndex: null,
  });
}

export const readers: readonly DialogReader[] = [{
  id: "kiro-approval", agents: ["kiro"], priority: 10,
  reread: "none", list: "none", parse: parseKiroApproval,
}];
