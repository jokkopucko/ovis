import type { DialogReader } from "./registry.ts";
import { ANSI_RE, type CardWords, type ParsedPrompt, cleanLine, findLastIndex, finishPrompt, isDivider, own } from "./shared.ts";

/**
 * Command Code's permission prompt, as its TUI draws it (ACP `session/request_permission`):
 *
 *   Create File
 *
 *   Do you want to create hello.txt?
 *
 *   ❯ 1. Yes
 *     2. Yes, allow all edits this session [shift+tab]
 *     3. No, tell Command Code what to do differently
 *
 *   ↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to
 *   bypass all permissions (Docs ↗)
 *
 * The rows are numbered and the cursor is marked with `❯`; the footer names the keys. Only the
 * rows directly above the footer are the dialog's: a numbered list in the conversation above it
 * (or in the agent's own output) is not an option, and a command's own text is not one either.
 */
/**
 * command-code@1.88.0's PermissionFooter (dist/cli.mjs). Ink wraps its Text at word or
 * character boundaries. Match the entire footer, not a bag of words that also accepts later output.
 * MainView hides its normal input/status chrome while permissionPanel is present.
 */
export function cmdFooterStart(lines: string[]): number {
  const at = findLastIndex(lines, (line) => /^\s*↑/.test(line));
  if (at < 0) return -1;
  const footer = lines.slice(at).join("").replace(/\s/g, "");
  return /^↑\/↓navigate·enterselect(?:·ctrl\+[ey]explain)?·Runcmd--yolotobypassallpermissions\(Docs↗\)$/i.test(footer) ? at : -1;
}

function parseCmdQuestion(screen: string): ParsedPrompt | null {
  const lines = screen.replace(ANSI_RE, "").split(/\r?\n/);
  const hintIndex = cmdFooterStart(lines);
  if (hintIndex < 0) return null;
  let blockStart = hintIndex;
  while (blockStart > 0 && lines[blockStart - 1]!.trim() === "") blockStart -= 1;
  while (blockStart > 0) {
    const prev = lines[blockStart - 1]!;
    if (isDivider(prev) || prev.trim() === "") break;
    if (/^\s*[❯›>]?\s*\d+\.\s+/.test(prev)) { blockStart -= 1; continue; }
    if (/^\s+\S/.test(prev) && !/^\s*[❯›>]?\s*\d+\.\s+/.test(prev)) { blockStart -= 1; continue; }
    break;
  }
  const rows: { label: string; selected: boolean; number: number }[] = [];
  for (let index = blockStart; index < hintIndex; index += 1) {
    const match = /^\s*([❯›>])?\s*(\d+)\.\s+(.+)$/.exec(lines[index]!);
    if (!match) continue;
    const row = { label: match[3]!.trim(), selected: match[1] !== undefined, number: Number(match[2]) };
    let next = index + 1;
    while (next < hintIndex && !/^\s*[❯›>]?\s*\d+\.\s+/.test(lines[next]!) && !/↑\/↓/.test(lines[next]!) && lines[next]!.trim() !== "" && !isDivider(lines[next]!)) {
      row.label = (row.label + " " + lines[next]!.trim()).trim();
      next += 1;
    }
    rows.push(row);
  }
  if (rows.length < 2) return null;
  if (!rows.every((row, index) => row.number === index + 1)) return null;
  // the cursor must be marked on exactly one row: without it the chat cannot tell which option
  // an answer would land on, and Command Code may mark the cursor by colour alone
  if (rows.filter((row) => row.selected).length !== 1) return null;
  // The source-defined permission choices begin with Yes and end with No, not arbitrary menu labels.
  if (rows[0]?.label !== "Yes" || !/^No(?:,|$)/.test(rows.at(-1)?.label ?? "")) return null;
  const selectedIndex = rows.findIndex((row) => row.selected);
  const firstRowIndex = lines.findIndex((line, index) => index >= blockStart && /^\s*[❯›>]?\s*1\.\s+/.test(line));
  let title: CardWords = own("Permission request");
  let titleIndex = -1;
  if (firstRowIndex >= 0) {
    let index = firstRowIndex - 1;
    while (index >= 0) {
      const cleaned = cleanLine(lines[index]!);
      if (cleaned === "") { index -= 1; continue; }
      if (isDivider(cleaned)) break;
      if (/Do you want to .+\?/i.test(cleaned)) { index -= 1; continue; }
      if (/needs to (execute|run|approve|create|edit|write|delete)/i.test(cleaned)) { index -= 1; continue; }
      if (/ctrl\+e/i.test(cleaned) && /explain/i.test(cleaned)) { index -= 1; continue; }
      if (/[;|]|2>\/dev\/null|head -\d/.test(cleaned)) { index -= 1; continue; }
      if (cleaned) title = cleaned;
      break;
    }
    titleIndex = index;
  }
  let question = title;
  if (firstRowIndex >= 0) {
    for (let index = firstRowIndex - 1; index >= 0; index -= 1) {
      const cleaned = cleanLine(lines[index]!);
      if (cleaned === "") continue;
      if (isDivider(cleaned)) break;
      if (/Do you want to .+\?/i.test(cleaned) || /needs to (execute|run|approve|create|edit|write|delete)/i.test(cleaned)) { question = cleaned; break; }
    }
  }
  // the body: what the agent wants to do (the command, the file), every line of the dialog between
  // its title and the rows but the question, so a command shown above the question is in the card's
  // id too: a command replaced under the card makes it stale instead of approving the new one
  const bodyLines = firstRowIndex >= 0 ? lines.slice(titleIndex + 1, firstRowIndex) : [];
  const body = bodyLines.map(cleanLine).filter((line) => line && line !== question && !isDivider(line) && !/ctrl\+e/i.test(line)).join("\n") || null;
  // The id hashes the whole screen above the rows as drawn, not only the title and body the card
  // shows: where the dialog starts is a guess (a heredoc can hold a rule; its indentation is part of
  // the command), so any change above the rows makes the card stale. Output that changes there while
  // the dialog is open makes it stale too, and the answer goes to the terminal instead.
  const dialog = lines.slice(0, firstRowIndex).join("\n");
  return finishPrompt("cmd", {
    kind: "approval", title, question, body,
    options: rows.map((row) => ({ label: row.label, description: null })),
    multi_select: false,
    custom_option_index: null,
  }, {
    responder: "cmd-question",
    menuLabels: rows.map((row) => row.label),
    selectedIndex,
    checkedOptionIndices: [],
    customMenuIndex: null,
    rejectWithEscapeIndex: null,
  }, { body: dialog });
}

export const readers: readonly DialogReader[] = [
  {
    id: "cmd-question", agents: ["cmd"], priority: 10,
    // the cursor is read off the screen, so it is re-read before the Enter: a cursor the user
    // moved in the terminal since the card was drawn would otherwise be answered from a
    // position the chat never saw
    reread: "before-commit", list: "none",
    parse: (screen) => {
      const parsed = parseCmdQuestion(screen);
      return parsed?.responder === "cmd-question" ? parsed : null;
    },
  },
];
