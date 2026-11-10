import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { codexOwnScreenOpen } from "./codex.ts";

// Screens recorded from a real Codex in an isolated herdr session (src/lib/fixtures-input-rows/README.md): 0.163.0 as
// `herdr pane read --format ansi` gave them, and 0.167.0 as the text the bridge reads before a send.
const RECORDED = join(import.meta.dir, "../../src/lib/fixtures-input-rows/codex");
const RECORDED_167 = join(import.meta.dir, "../../src/lib/fixtures-input-rows/codex-0.167.0");
const COMPOSER = "› Ask Codex to do anything\n  GPT-6-Astra default fast · main · Context 100% left · 0 in · 0 out\n  ← for agents · ? for shortcuts";
const under = (...rows: string[]): string => ["  >_ OpenAI Codex (v0.167.0)", "     /tmp/proj", "", ...rows].join("\n");

describe("codexOwnScreenOpen", () => {
  it("reads every recorded screen of Codex 0.163: a list, a field, the status line's editor and the pager are open, the composer is not", () => {
    const read = Object.fromEntries(readdirSync(RECORDED).filter((file) => file.endsWith(".ansi")).sort()
      .map((file) => [file.replace(/\.ansi$/, ""), codexOwnScreenOpen(stripVTControlCharacters(readFileSync(join(RECORDED, file), "utf8")))]));
    // open, at 120 and at 40 columns; Escape leaves the /diff pager up (`diff-closed`), q closes it (`diff-closed-q`)
    const open = ["cd-untrusted-repo-open", "diff-open", "permissions-open", "rename-open", "statusline-open", "theme-open"].flatMap((name) => [`${name}-120`, `${name}-40`]);
    expect(Object.keys(read).filter((name) => read[name]).sort()).toEqual([...open, "diff-closed-120"].sort());
    // the composer at rest, after each screen closed, and with a draft in it (/mention leaves `@`)
    expect(Object.keys(read).filter((name) => !read[name]).sort()).toEqual(["cd-untrusted-repo-closed-120", "diff-closed-q-120", "diff-closed-q-40", "mention-closed-120",
      "permissions-closed-120", "permissions-closed-40", "permissions-idle-120", "permissions-idle-40", "rename-closed-40"]);
  });

  it("reads every recorded screen of Codex 0.167, at 100 and at 40 columns", () => {
    const read: Record<string, boolean[]> = {};
    for (const file of readdirSync(RECORDED_167).filter((name) => name.endsWith(".txt")).sort()) {
      (read[file.replace(/-\d+\.txt$/, "")] ??= []).push(codexOwnScreenOpen(readFileSync(join(RECORDED_167, file), "utf8")));
    }
    const names = (open: boolean): string[] => Object.keys(read).filter((name) => read[name]!.every((value) => value === open)).sort();
    // every list, field, editor, view and pager a command or a key of Codex's opens: herdr reported Codex idle under each
    // (the folder question: blocked at 100 columns, idle at 40, and unknown, so typed into, in its first seconds)
    expect(names(true)).toEqual(["agents", "agents-help", "diff", "experimental", "find", "history-search", "keymap", "model-advanced", "model-effort",
      "model-effort-last-row", "model-list", "permissions", "rename", "resume", "review", "statusline", "theme", "trust"]);
    // the composer: empty, with a draft, with its shortcuts shown (`? / esc close`: it still takes what is typed), with the
    // slash commands' popup over a draft, and at Ultra reasoning effort (its mark `»`, the U L T R A banner under it)
    expect(names(false)).toEqual(["composer-draft", "composer-empty", "composer-shortcuts", "composer-ultra-banner", "composer-ultra-draft", "composer-ultra-empty",
      "composer-ultra-shortcuts", "slash-popup"]);
    expect([...names(true), ...names(false)].length).toBe(Object.keys(read).length);
  });

  it("knows a footer by its keys and the one that leaves, however Codex words or wraps it", () => {
    for (const footer of [
      "  enter select · esc back",
      // the row that picks in /model: Enter there saves the row as the default for every new session
      "  enter default · s session · esc back",
      "  enter apply · s session · esc back",
      "  space toggle · ←/→ reorder · enter save · esc cancel",
      // wrapped by a 40-column pane
      "  space toggle · ←/→ reorder · enter\n  save · esc cancel",
      "  enter submit · esc back",
      "  enter continue · esc cancel",
      // keys the user remapped
      "  ctrl+j select · q back",
      // Codex 0.162 and before
      "  Press enter to select · esc to go back",
      "  Press enter to confirm or esc to go back",
      // a pager: its keys, then the one that closes it on a row of its own
      " ↑/↓ to scroll · pgup/pgdn to page · home/end to jump\n q close",
      // the keys cut by a narrow pane: the last row alone tells
      " ↑/↓ to scroll · pgup/pgdn to page · hom\n q close",
      // 0.167: items apart by spaces alone, two rows of keys, a key that does two things, wrapped inside its words
      "  ? help  esc back  ↑/↓ move  enter open  n new",
      " enter resume   esc exit   ^c exit   tab focus   ←/→ option\n ^o comfy   ^t preview   ^e exp   ↑/↓ browse",
      "  space toggle · enter save · esc save/close",
      "  space toggle · enter save · esc save/\n  close",
      "  left/right group · enter edit shortcut · * custom · - unbound · esc close",
      "  Find:\n  Type to find · full transcript · esc cancel",
      // the search through earlier prompts has no footer: its field ends the screen
      "  reverse-i-search: fix",
      // the transcript's pager, as 0.167 drew it with `[tui] fullscreen_transcript = false` (seen, not recorded)
      "^space select\n ↑/↓ to scroll · pgup/pgdn to page · home/end to jump\n q close · f3 find · esc browse prompts",
    ]) expect(codexOwnScreenOpen(under("  Some list", "› 1. First", "  2. Second", footer)), footer).toBeTrue();
  });

  it("leaves the composer alone, with whatever it and the conversation above it show", () => {
    for (const [name, screen] of Object.entries({
      "at rest": under(COMPOSER),
      "with a draft, its hint row gone": under("› a draft", "  GPT-6-Astra default fast · main · Context 100% left"),
      "with only the warning beside an empty hint row": under("› @", "  GPT-6-Astra medium fast · main", "                                   ⚠ 1 warning · f2 to view"),
      "at Ultra reasoning effort": under(COMPOSER.replace("›", "»").replace("default fast", "ultra")),
      "working": under("• Working (3s • esc to interrupt)", "", COMPOSER),
      "with a message queued": under("• Messages to be submitted after next tool call (press esc to interrupt and send immediately)", "  ↳ and then", COMPOSER),
      "after one Escape": under("› Ask Codex to do anything", "  esc again to edit previous message"),
      "with its shortcuts shown, as 0.167 ends them": under("  /keymap customize", "› Ask Codex to do anything", "  GPT-6.1-Sol default · /tmp/proj", "  ? / esc close"),
      "at Ultra, the banner under the box": under("» Ask Codex to do anything", "                              U L T R A", "  ← for agents · ? for shortcuts"),
      // the composer as 0.167 drew it with `[tui] fullscreen_transcript = false` (seen, not recorded): one row under the box
      "in that layout, at rest": under("› Ask Codex to do anything", "", "  GPT-6.1-Sol default · /tmp/proj · ← for agents"),
      "in that layout, with its shortcuts shown": under("› Ask Codex to do anything", "", "  ? / esc close"),
      "with its shortcuts shown": under("› Ask Codex to do anything", "  / for commands                 ! for shell commands", "  shift + enter for newline      tab to queue message",
        "  esc again to edit previous message   ctrl + c to exit", "  ctrl + t to view transcript"),
      "under an answer that quotes a list's footer": under("• Run /model. You will see:", "  enter select · esc back", "", COMPOSER),
      "with a draft that quotes one": under("› the footer said", "  enter select · esc back", "  GPT-6-Astra default fast · main"),
      // a thread or a folder named like a key hint is an item of the status line, beside the model
      "a status line naming a thread like a hint": under("› Ask Codex to do anything", "  GPT-6-Astra default · main · esc back"),
      // and one a narrow pane cut at its `·` goes on in the next row, which is no footer of its own
      "a status line wrapped before such a name": under("› Ask Codex to do anything", "  GPT-6-Astra ultra · /fixture ·", "  esc cancel"),
      "a status line wrapped before a name that leaves nothing": under("› Ask Codex to do anything", "  GPT-6-Astra ultra · /fixture ·", "  enter save"),
      "an empty screen": "",
      "a shell prompt": "user@host:~/proj$ ",
    })) expect(codexOwnScreenOpen(screen), name).toBeFalse();
  });
});
