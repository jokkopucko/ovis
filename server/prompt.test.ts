import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane, InteractivePrompt } from "../shared/protocol.ts";

import { answerKeys, hermesInputDraft, claudeClearableDraft, claudeInputBoxText, claudeInputDraft, claudeInputEmpty, historyEndShowsLive, viewportShowsLive, removedInvisible, noteSubmitted, codexQuestionsCollapsed, codexQueuedPrompt, handlePromptRequest, openOmoAsks, parseClaudeSuggestion, parseFallbackPrompt, parseInteractivePrompt, pendingOmoAsk, promptWaitEnded, claudeRestoredDraft, lastChatSubmitted, piListsTemplate, piRunsCommand } from "./prompt.ts";
import { rememberPaneCommands } from "./commands.ts";
import { registry } from "./dialogs/registry.ts";
import { gjcCustomEditorMatches } from "./dialogs/fallback.ts";
import { ANSI_RE, parsedByPublicPrompt } from "./dialogs/shared.ts";

const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);
// Real omo-ai 5.1.30 pane.read captures at 120 and 45 columns, with the recorded open calls.
const omoPendingFixture = (name: string) => readFileSync(new URL(`./fixtures/omo-pending-5.1.30-${name}`, import.meta.url), "utf8");
const omoExtensionTail = omoPendingFixture("extension-tail.txt");
// Real omo-ai 5.1.48 captures of a two-question widget at 120 and 45 columns, with the recorded call.
const omo48PendingFixture = (name: string) => readFileSync(new URL(`./fixtures/omo-pending-5.1.48-${name}`, import.meta.url), "utf8");
const withOmoExtensionTail = (screen: string) => screen.replace(/(❯\n─+\n)/, `$1${omoExtensionTail}`);
// OmO's omo-task widget rows under the input box, as a live pane shows them: a live row wrapped onto a
// second line, a live row, a finished row and the `+N more` line
const omoTaskRows = ` ⠦ AdversarialVerify todo 2... · agent:omo-native-gate-reviewer(openai/gpt-6-astra:high) · turn 10 (47 tools) · $3.2103 · 26779 tok/s · running · 6m
 0s
 ⠋ Map the implementation surface · category:quick · running · 41s
 Review diff|agent:explore background completed
 +2 more
`;
const CLAUDE_BACKGROUND_APPROVAL_FOOTER = "Esc to cancel · ctrl+x ctrl+k twice to stop background agents";
const claudeBackgroundApproval = (selected: number, footer = CLAUDE_BACKGROUND_APPROVAL_FOOTER) => {
  const row = (index: number, label: string) => `${index === selected ? " ❯ " : "   "}${index + 1}. ${label}`;
  return [
    "✻ Waiting for 1 background agent to finish",
    "",
    "─".repeat(80),
    " Bash command · from the general-purpose agent",
    " Run shell command",
    "╌".repeat(80),
    " │ systemctl --user start demo.service",
    "╌".repeat(80),
    " │ Permission rule Bash(systemctl --user start:*) requires confirmation for this command.",
    " /permissions to update rules",
    "",
    " Do you want to proceed?",
    row(0, "Yes"),
    row(1, "Yes, and don't ask again for: systemctl --user start demo.service"),
    row(2, "No"),
    "",
    ` ${footer}`,
    "",
  ].join("\n");
};

describe("interactive prompt parsing", () => {
  test("invalidates approvals when their command changes, including text beyond the display cap", () => {
    const screen = (command: string, secondSelected = false) => `
Would you like to run the following command?
${command}
${secondSelected ? " " : "›"} 1. Yes, proceed
${secondSelected ? "›" : " "} 2. No, cancel
Press enter to confirm or esc to cancel
`;
    const first = parseInteractivePrompt("codex", screen("echo first"))!;
    expect(first).not.toBeNull();
    expect(parseInteractivePrompt("codex", screen("echo second"))!.id).not.toBe(first.id);
    expect(parseInteractivePrompt("codex", screen("echo first", true))!.id).toBe(first.id);
    const prefix = "x".repeat(12_010);
    expect(parseInteractivePrompt("codex", screen(prefix + "a"))!.id)
      .not.toBe(parseInteractivePrompt("codex", screen(prefix + "b"))!.id);
  });

  test("parses Claude questions, approvals, and plans", () => {
    const questionScreen = `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
     Occlusion benchmark.
  2. YCB-V
     Household objects.
  3. T-LESS
     Texture-less objects.
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    const question = parseInteractivePrompt("claude", questionScreen);
    expect(question).toMatchObject({
      agent: "claude",
      kind: "question",
      // a single question is titled by its header chip
      title: "Dataset",
      question: "Which evaluation dataset should we use?",
      multi_select: false,
      custom_option_index: 3,
    });
    expect(labels(question)).toEqual(["LM-O", "YCB-V", "T-LESS"]);
    expect(question?.options[0]?.description).toBe("Occlusion benchmark.");
    expect(parseInteractivePrompt("claude", questionScreen)?.id).toBe(question?.id);

    const approval = parseInteractivePrompt("claude", `
Bash command

  curl -I https://example.com
  Fetch HTTP headers.

This command requires approval

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don’t ask again for: curl *
  3. No

Esc to cancel · Tab to amend · ctrl+e to explain
`);
    expect(approval?.kind).toBe("approval");
    expect(approval?.title).toBe("Fetch HTTP headers.");
    expect(labels(approval)).toEqual(["Yes", "Yes, and don’t ask again for: curl *", "No"]);

    const plan = parseInteractivePrompt("claude", `
Ready to code?

Here is Claude's plan:
Add a heading to the README file.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. No, refine with Ultraplan on Claude Code on the web
  4. Tell Claude what to change
     shift+tab to approve with this feedback
`);
    expect(plan).toMatchObject({ kind: "plan", title: "Ready to code?", custom_option_index: 3 });
    expect(plan?.body).toContain("Add a heading");
    expect(answerKeys(plan!, { custom_text: "Keep the existing introduction" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] },
      { text: "Keep the existing introduction" },
      // Enter keeps planning: shift+tab approves the plan with the feedback
      { keys: ["enter"] },
    ]);
  });

  test("parses omp single, multi-select, and approval prompts", () => {
    const single = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────╮
│ Which target?           │
├─────────────────────────┤
│❯ ○ Jetson Orin         │
│  ○ RK3588               │
│  ○ Other (type your own)│
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`);
    expect(single).toMatchObject({ kind: "question", question: "Which target?", custom_option_index: 2 });
    expect(labels(single)).toEqual(["Jetson Orin", "RK3588"]);

    const multi = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────╮
│ Which checks?           │
├─────────────────────────┤
│❯ ☐ Lint                │
│  ☐ Tests                │
│  ☐ Build                │
│  ☐ Other (type your own)│
├─────────────────────────┤
│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel
╰─────────────────────────╯
`);
    expect(multi).toMatchObject({ kind: "question", title: "Multiple choice", multi_select: true, custom_option_index: null });
    expect(answerKeys(multi!, { option_indices: [0, 2] })).toEqual([
      { keys: ["space"] },
      { keys: ["down"] },
      { keys: ["down"] },
      { keys: ["space"] },
      { keys: ["tab"] },
      { keys: ["enter"] },
    ]);

    const approval = parseInteractivePrompt("omp", `
╭─ Permission ────────────╮
│ Allow tool: bash        │
│ curl -I example.com     │
│❯ Approve               │
│  Deny                  │
╰─────────────────────────╯
`);
    expect(approval?.kind).toBe("approval");
    expect(labels(approval)).toEqual(["Approve", "Deny"]);
  });

  test("recognizes OMP's clipped legacy single-select footer only with its full menu identity", () => {
    const screen = (footer = "Enter select · n note · ↑/↓ move · Tab/←/→ · Esc can…", rows = ["❯ ○ Local socket", "  ○ Remote relay", "  ○ Other (type your own)"], suffix = "") => `
╭─ Ask ─────────────────────────────────────────────────╮
│ Which route should carry the fictional session?       │
├───────────────────────────────────────────────────────┤
${rows.map((row) => `│ ${row.padEnd(52)}│`).join("\n")}
├───────────────────────────────────────────────────────┤
│ ${footer.padEnd(52)}│
╰───────────────────────────────────────────────────────╯${suffix}
`;
    const prompt = parseInteractivePrompt("omp", screen());
    expect(prompt).toMatchObject({ kind: "question", question: "Which route should carry the fictional session?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["Local socket", "Remote relay"]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    for (const clipped of ["c…", "ca…", "can…", "canc…", "cance…"]) {
      expect(parseInteractivePrompt("omp", screen(`Enter select · n note · ↑/↓ move · Tab/←/→ · Esc ${clipped}`))).not.toBeNull();
    }
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · ↑/↓ move · Esc ca…"))).not.toBeNull();
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · ↑/↓ move · Esc…"))).not.toBeNull();
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · ↑/↓ move · Tab/←/→…"))).not.toBeNull();
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · ↑/↓ move · Tab/←/→..."))).not.toBeNull();

    expect(parseInteractivePrompt("omp", screen("Enter select · ↑/↓ move · Tab/←/→ · Esc can…"))).toBeNull();
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · Tab/←/→ · Esc can…"))).toBeNull();
    expect(parseInteractivePrompt("omp", screen("Enter select · ↑/↓ move · Tab/←/→…"))).toBeNull();
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · ↑/↓ move · Tab/←/→"))).toBeNull();
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · ↑/↓ move · Tab/←/…"))).toBeNull();
    for (const unmarked of ["c", "ca", "can"]) {
      expect(parseInteractivePrompt("omp", screen(`Enter select · n note · ↑/↓ move · Tab/←/→ · Esc ${unmarked}`))).toBeNull();
    }
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · ↑/↓ move · Esc"))).toBeNull();
    expect(parseInteractivePrompt("omp", screen("Enter select · n note · ↑/↓ move · Tab/←/→ · Esc cypress…"))).toBeNull();
    expect(parseInteractivePrompt("omp", screen(undefined, ["❯ ○ Local socket", "  ○ Remote relay"]))).toBeNull();
    expect(parseInteractivePrompt("omp", screen(undefined, ["❯ ○ Local socket", "❯ ○ Remote relay", "  ○ Other (type your own)"]))).toBeNull();
    expect(parseInteractivePrompt("omp", screen(undefined, ["❯ ○ Local socket", "  ○ Remote relay", "  Other (type your own)"]))).toBeNull();
    expect(parseInteractivePrompt("omp", screen(undefined, ["❯ ○ Local socket", " ○ Remote relay", "  ○ Other (type your own)"]))).toBeNull();
    expect(parseInteractivePrompt("omp", screen(undefined, ["   ❯ ○ Local socket", "     ○ Remote relay", "     ○ Other (type your own)"]))).not.toBeNull();
    expect(parseInteractivePrompt("omp", screen(undefined, undefined, "\nUnrelated output\n"))).toBeNull();
  });


  test("parses current OMP question hints and keeps descriptions out of the answer rows", () => {
    const screen = `
╭─ Ask ───────────────────────────╮
│ Which deployment target?       │
├────────────────────────────────┤
│❯ ○ ARM server                   │
│      Runs on the lab machine     │
│  ○ x86 runner                   │
│      ○ supports the hosted runner│
│      for Linux builds            │
│  ○ Other (type your own)        │
├────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⎋ cancel │
╰────────────────────────────────╯
`;
    const prompt = parseInteractivePrompt("omp", screen);
    expect(prompt).toMatchObject({ kind: "question", question: "Which deployment target?", multi_select: false, custom_option_index: 2 });
    expect(prompt?.options).toEqual([
      { label: "ARM server", description: "Runs on the lab machine" },
      { label: "x86 runner", description: "○ supports the hosted runner for Linux builds" },
    ]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt!, { custom_text: "A local test runner" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
      { text: "A local test runner" }, { keys: ["enter"] },
    ]);
  });

  test("keeps glyphs in wrapped OMP labels and descriptions out of the option column", () => {
    const prompt = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────────────╮
│ Which deployment target?       │
├────────────────────────────────┤
│❯ ○ ARM server with an           │
│    ○ unusually long label       │
│      ☑ supports the hosted image│
│  ○ x86 runner                   │
│  ○ Other (type your own)        │
├────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⎋ cancel │
╰────────────────────────────────╯
`);
    expect(prompt?.options).toEqual([
      { label: "ARM server with an ○ unusually long label", description: "☑ supports the hosted image" },
      { label: "x86 runner", description: null },
    ]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("anchors option markers to the selected row in OMP's padded panel", () => {
    const prompt = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────────────╮
│ Which deployment target?       │
├────────────────────────────────┤
│ ❯ ○ ARM server                  │
│       ○ supports ARM builds     │
│   ○ x86 runner                  │
│       Hosted Linux builds       │
│   ○ Other (type your own)       │
├────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⎋ cancel │
╰────────────────────────────────╯
`);
    expect(prompt?.options).toEqual([
      { label: "ARM server", description: "○ supports ARM builds" },
      { label: "x86 runner", description: "Hosted Linux builds" },
    ]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("keeps OMP's native question tab strip out of the question title", () => {
    const screen = `
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Update Available
 New version 18.11.1 is available. Run: omp update
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  ⎋ Working…
╭─ Ask ───────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│  Transport    Targets    Notes    Narrow view    Submit                                                             │
│ Which route should carry the fictional session?                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ❯ ○ Local socket                                                                                                    │
│       Keeps the session on this PC.                                                                                 │
│   ○ Remote relay                                                                                                    │
│       Uses the fictional remote endpoint.                                                                           │
│   ○ Other (type your own)                                                                                           │
│                                                                                                                     │
│                                                                                                                     │
├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⇥/←/→ question · ⎋ cancel · Alt+H hide                                               │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
`;
    const prompt = parseInteractivePrompt("omp", screen);
    expect(prompt).toMatchObject({ question: "Which route should carry the fictional session?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["Local socket", "Remote relay"]);
    expect(prompt?.options.map((option) => option.description)).toEqual([
      "Keeps the session on this PC.", "Uses the fictional remote endpoint.",
    ]);
    expect(parseInteractivePrompt("omp", screen.replace(
      "Which route should carry the fictional session?",
      "Should we choose   Submit\n│ or Cancel for the fictional task?",
    ))?.question).toBe("Should we choose Submit or Cancel for the fictional task?");
    expect(parseInteractivePrompt("omp", screen.replace(
      "Transport    Targets    Notes    Narrow view    Submit",
      "Transport    Targets    Notes\n│  Narrow view    Submit",
    ))?.question).toBe("Which route should carry the fictional session?");
    expect(parseInteractivePrompt("omp", screen.replace(
      "Transport    Targets    Notes    Narrow view    Submit",
      "Transport\n│  Targets\n│  Notes\n│  Narrow view\n│  Submit",
    ))?.question).toBe("Which route should carry the fictional session?");
    expect(parseInteractivePrompt("omp", screen.replace(
      "Transport    Targets    Notes    Narrow view    Submit",
      "Transport    Targ…",
    ))?.question).toBe("Which route should carry the fictional session?");
    expect(parseInteractivePrompt("omp", screen.replace(
      "Which route should carry the fictional session?",
      "Submit\n│    Cancel\n│ Which action should run?",
    ))?.question).toBe("Submit Cancel Which action should run?");
  });

  test("recognizes OMP's clipped single-question footer only with its question controls", () => {
    const screen = `
╭─ Ask ─────────────────────────────────────────────────╮
│  Transport    Targets    Notes    Narrow view         │
│  Submit                                               │
│ Which deliberately long answer should remain readable │
│ when the native question wraps across a narrow        │
│ terminal?                                             │
├───────────────────────────────────────────────────────┤
│ ❯ ○ Local socket                                      │
│   ○ Remote relay                                      │
│   ○ Other (type your own)                             │
├───────────────────────────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⇥/←/→ question · ↓ sc… │
╰───────────────────────────────────────────────────────╯
`;
    const prompt = parseInteractivePrompt("omp", screen);
    expect(prompt).toMatchObject({
      kind: "question", question: "Which deliberately long answer should remain readable when the native question wraps across a narrow terminal?",
    });
    expect(labels(prompt)).toEqual(["Local socket", "Remote relay"]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(parseInteractivePrompt("omp", screen.replace("n note · ", ""))).toBeNull();
    expect(parseInteractivePrompt("omp", screen.replace("⇥/←/→ question", "⇥/←/→ navigate"))).toBeNull();
    expect(parseInteractivePrompt("omp", screen.replace("│   ○ Other (type your own)                             │\n", ""))).toBeNull();
  });

  test("recognizes OMP's question hint when the word itself is clipped", () => {
    const screen = `
╭─ Ask ───────────────────────────────────────╮
│  Transport    Targets    Notes              │
│  Narrow view    Submit                      │
│ Which fictional answer should remain        │
│ readable when this question wraps across a  │
│ narrow terminal?                            │
├─────────────────────────────────────────────┤
│ ❯ ○ A fictional answer that wraps across    │
│     the narrow native terminal              │
│       A synthetic description that also     │
│       wraps at narrow terminal widths.      │
│   ○ Other (type your own)                   │
├─────────────────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⇥/←/→ quest… │
╰─────────────────────────────────────────────╯
`;
    const prompt = parseInteractivePrompt("omp", screen);
    expect(prompt).toMatchObject({
      question: "Which fictional answer should remain readable when this question wraps across a narrow terminal?",
      options: [{
        label: "A fictional answer that wraps across the narrow native terminal",
        description: "A synthetic description that also wraps at narrow terminal widths.",
      }],
    });
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    for (const prefix of ["q", "qu", "que", "ques", "questi", "questio", "question"]) {
      expect(parseInteractivePrompt("omp", screen.replace("quest…", `${prefix}…`))?.question).toBe(prompt?.question);
    }
    for (const unrelated of ["quest", "query…", "questions…"]) {
      expect(parseInteractivePrompt("omp", screen.replace("quest…", unrelated))).toBeNull();
    }
    expect(parseInteractivePrompt("omp", screen.replace("n note · ", ""))).toBeNull();
    expect(parseInteractivePrompt("omp", screen.replace("│   ○ Other (type your own)                   │\n", ""))).toBeNull();
    expect(parseInteractivePrompt("omp", screen + "\nAgent resumed")).toBeNull();
  });

  test("parses OMP's review tab as an explicit submit or cancel prompt", () => {
    const screen = `
╭─ Ask ──────────────────────────────────────────────────────────╮
│  Transport    Targets    Submit                                │
│ Review answers                                                  │
├────────────────────────────────────────────────────────────────┤
│ 1. Transport: Remote relay                                      │
│ 2. Targets: ARM server                                          │
│                                                                 │
│ ❯ Submit                                                        │
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│ ⏎ submit · ↑/↓ scroll · ⎋ cancel · Alt+H hide                  │
╰────────────────────────────────────────────────────────────────╯
`;
    const prompt = parseInteractivePrompt("omp", screen);
    expect(prompt).toMatchObject({
      kind: "menu", title: "Review answers", question: "Submit these answers?", custom_option_index: null,
    });
    expect(prompt?.answers).toEqual([
      { question: "Transport", answer: "Remote relay" },
      { question: "Targets", answer: "ARM server" },
    ]);
    expect(prompt?.body).toBeNull();
    expect(labels(prompt)).toEqual(["Submit", "Cancel"]);
    const noted = parseInteractivePrompt("omp", screen
      .replace("│ 1. Transport: Remote relay                                      │\n", "│ 1 unanswered question; Enter still submits.                     │\n│                                                                 │\n│ 1. Transport: Remote relay                                      │\n│    Note: keep the old relay                                     │\n")
      .replace("2. Targets: ARM server        ", "2. Targets:                    "));
    expect(noted?.answers).toEqual([
      { question: "Transport", answer: "Remote relay", note: "keep the old relay" },
      { question: "Targets", answer: null },
    ]);
    expect(noted?.body).toBe("1 unanswered question; Enter still submits.");
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
    expect(() => answerKeys(prompt!, { custom_text: "submit now" })).toThrow();
    expect(parseInteractivePrompt("omp", screen.replace("❯ Submit", "  Submit"))).toBeNull();
    expect(parseInteractivePrompt("omp", screen.replace("Review answers", "Ordinary title"))).toBeNull();
  });

  test("parses current OMP multi-select hints with checked choices and safe option indices", () => {
    const screen = `
╭─ Ask ───────────────────────────╮
│ Which checks should run?        │
├────────────────────────────────┤
│  ☒ Lint                         │
│❯ ☐ Unit tests                   │
│      ☑ runs without external     │
│      tools                      │
│  ☐ Browser checks               │
│  ○ Other (type your own)        │
├────────────────────────────────┤
│ ␠ toggle · ⏎ submit · ↑/↓ move · Tab/←/→ question · ⎋ cancel │
╰────────────────────────────────╯
`;
    const prompt = parseInteractivePrompt("omp", screen);
    expect(prompt).toMatchObject({ kind: "question", multi_select: true });
    expect(prompt?.options).toEqual([
      { label: "Lint", description: null },
      { label: "Unit tests", description: "☑ runs without external tools" },
      { label: "Browser checks", description: null },
    ]);
    expect(answerKeys(prompt!, { option_indices: [1, 2] })).toEqual([
      { keys: ["up"] }, { keys: ["space"] },
      { keys: ["down"] }, { keys: ["space"] },
      { keys: ["down"] }, { keys: ["space"] },
      { keys: ["enter"] },
    ]);
  });

  test("advances a current OMP multi question without switching to the next question", () => {
    const prompt = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────────────╮
│ Which platforms should run?     │
├────────────────────────────────┤
│  ☑ Linux                         │
│❯ ☐ macOS                         │
│  ☐ Other (type your own)        │
├────────────────────────────────┤
│ ␠ toggle · ⏎ next · ↑/↓ move · Tab/←/→ question · ⎋ cancel │
╰────────────────────────────────╯
`);
    expect(prompt).toMatchObject({ multi_select: true, custom_option_index: null });
    expect(answerKeys(prompt!, { option_indices: [0, 1] })).toEqual([
      { keys: ["space"] }, { keys: ["enter"] },
    ]);
  });

  test("leaves the Other row before advancing a current OMP multi question", () => {
    const prompt = parseInteractivePrompt("omp", `
╭─ Ask ───────────────────────────╮
│ Which platforms should run?     │
├────────────────────────────────┤
│  ☑ Linux                         │
│  ☐ macOS                         │
│❯ ☐ Other (type your own)        │
├────────────────────────────────┤
│ ␠ toggle · ⏎ next · ↑/↓ move · Tab/←/→ question · ⎋ cancel │
╰────────────────────────────────╯
`);
    expect(prompt).toMatchObject({ multi_select: true, custom_option_index: null });
    expect(answerKeys(prompt!, { option_indices: [0] })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("parses Codex continue, question, async question, and approval prompts", () => {
    const menu = parseInteractivePrompt("codex", `
✨ Update available! 0.146.0 -> 0.146.1

› 1. Update now
  2. Skip
  3. Skip until next version

Press enter to continue
`);
    expect(menu).toMatchObject({ kind: "menu", title: "Codex", question: "Choose how to continue" });
    expect(answerKeys(menu!, { option_index: 2 })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);

    const question = parseInteractivePrompt("codex", `
Question 1/1 (1 unanswered)
Which export format should we use?

› 1. ONNX               Export a portable ONNX model.
  2. TensorRT           Build an NVIDIA TensorRT engine.
  3. RKNN               Build an RKNN model.
  4. None of the above  Optionally, add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`);
    expect(question).toMatchObject({ kind: "question", custom_option_index: 3 });
    expect(labels(question)).toEqual(["ONNX", "TensorRT", "RKNN"]);
    expect(question?.options[0]?.description).toBe("Export a portable ONNX model.");

    const asyncQuestion = parseInteractivePrompt("codex", `
Which accelerator?

› 1. CUDA
  2. CPU
  3. NPU
  4. Other

enter submit   ctrl + ] skip
option 1/4   shift + → main prompt
`);
    expect(asyncQuestion).toMatchObject({ kind: "question", question: "Which accelerator?", custom_option_index: 3 });
    expect(labels(asyncQuestion)).toEqual(["CUDA", "CPU", "NPU"]);

    const approval = parseInteractivePrompt("codex", `
Would you like to run the following command?

Environment: local
$ curl -I https://example.com

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with curl
  3. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`);
    expect(approval?.kind).toBe("approval");
    expect(approval?.body).toContain("curl -I");
    expect(answerKeys(approval!, { option_index: 2 })).toEqual([{ keys: ["esc"] }]);
  });

  // screens captured from Claude Code 2.1.280 and Codex 0.156.0 (paths shortened)
  test("parses Claude Code 2.1 question tabs, their review, and tool approvals without the old markers", () => {
    const first = parseInteractivePrompt("claude", `
←  ☐ Route  ☐ Author  ✔ Submit  →
Which way should the PR go?
❯ 1. Log in as owner
     Authenticate as the repository owner and open the PR directly on the repo.
  2. Fork
     Push the branch to a fork and open the PR from there.
  3. Type something.
────────────────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(first).toMatchObject({ kind: "question", title: "Route · 1 of 2", question: "Which way should the PR go?", custom_option_index: 2 });
    expect(labels(first)).toEqual(["Log in as owner", "Fork"]);

    const sets = parseInteractivePrompt("claude", `
←  ☒ Route  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
         Include the LM-O dataset.
  2. [ ] YCB-V
         Include the YCB-V dataset.
  3. [ ] T-LESS
         Include the T-LESS dataset.
  4. [ ] Type something
     Next
────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(sets).toMatchObject({ title: "Sets · 2 of 2", multi_select: true });
    // → moves on to the next tab: an enter there would pick its first option
    expect(answerKeys(sets!, { option_indices: [0, 2] })).toEqual([
      { keys: ["enter"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] },
    ]);

    const review = parseInteractivePrompt("claude", `
←  ☒ Route  ☒ Author  ✔ Submit  →
Review your answers
 ● Which way should the PR go?
   → Log in as owner
 ● Who should author the commits?
   → Repo owner
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel
`);
    // a menu: a typed pick submits every answer at once, so the chat asks for Confirm
    expect(review).toMatchObject({ kind: "menu", title: "Review your answers", question: "Ready to submit your answers?", custom_option_index: null });
    expect(review?.answers).toEqual([
      { question: "Which way should the PR go?", answer: "Log in as owner" },
      { question: "Who should author the commits?", answer: "Repo owner" },
    ]);
    expect(review?.body).toBeNull();
    expect(labels(review)).toEqual(["Submit answers", "Cancel"]);

    const bash = parseInteractivePrompt("claude", `
● Deleting the junk directory
  ⎿  $ rm -rf junk
────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/prompt-lab/junk from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend
`);
    expect(bash).toMatchObject({ kind: "approval", title: "Bash command", question: "Do you want to proceed?", body: "rm -rf junk\nDelete the junk directory" });
    expect(labels(bash)).toEqual(["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "Yes, and switch to auto mode · auto mode handles these prompts for you", "No"]);
    // a narrow pane wraps a long option: its label still reads whole
    const wrapped = parseInteractivePrompt("claude", `
────────────────────────────────────────
 Bash command
   rm -rf junk
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
   /tmp/prompt-lab/junk from this project
   3. No
 Esc to cancel · Tab to amend
`);
    expect(labels(wrapped)).toEqual(["Yes", "Yes, and always allow access to /tmp/prompt-lab/junk from this project", "No"]);
    // Claude's own text opens with ● as well: a rule in its table is not the approval's panel
    const underText = parseInteractivePrompt("claude", `
● Results table follows:
────────────────────────────────────────
  run   AR
────────────────────────────────────────
  a     0.66
────────────────────────────────────────
 Bash command
   rm -rf junk
   Delete the junk directory
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(underText).toMatchObject({ kind: "approval", title: "Bash command", body: "rm -rf junk\nDelete the junk directory" });
    // an MCP call is a call too: the first rule under it opens the panel, not a rule in its preview
    const mcp = parseInteractivePrompt("claude", `
● github - create_issue (MCP)(title: "Flaky test")
────────────────────────────────────────
 Tool use
   github - create_issue(title: "Flaky test")
────────────────────────────────────────
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
`);
    expect(mcp).toMatchObject({ kind: "approval", title: "Tool use" });
    expect(answerKeys(bash!, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);

    const write = parseInteractivePrompt("claude", `
● Write(hello.txt)
────────────────────────────────────────
 Create file
 hello.txt
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 hi
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create hello.txt?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)
   3. No
 Esc to cancel · Tab to amend
`);
    expect(write).toMatchObject({ kind: "approval", title: "Create file", question: "Do you want to create hello.txt?", body: "hello.txt\n1 hi" });
  });

  test("finds Claude's question tabs over a wrapped question and a cut-off bar, and never answers the next question", () => {
    // a narrow pane: the question wraps over seven lines and the bar loses its right end
    const wrapped = parseInteractivePrompt("claude", `
────────────────────────────
←  ☒ Route  ☐ Author  ✔ Su
Who should author the
commits that go into the
pull request, given that
the fork belongs to the
lab account and the
upstream repository to
its owner?
❯ 1. Keep local
     The local git identity.
  2. Repo owner
     The repository owner.
  3. Type something.
────────────────────────────
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`);
    expect(wrapped).toMatchObject({
      kind: "question", title: "Author",
      question: "Who should author the commits that go into the pull request, given that the fork belongs to the lab account and the upstream repository to its owner?",
    });
    expect(answerKeys(wrapped!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);

    // a multiple choice alone: → reaches the review of the answers, which has its own card
    const alone = parseInteractivePrompt("claude", `
←  ☐ Sets  ✔ Submit  →
Which datasets?
❯ 1. [ ] LM-O
  2. [ ] YCB-V
  3. [ ] T-LESS
  4. [ ] Type something
     Submit
────────────────────────────
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(alone).toMatchObject({ title: "Sets", multi_select: true });
    expect(answerKeys(alone!, { option_indices: [1] })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] }]);
  });

  test("titles a Claude approval from its panel, not from rules in a file preview, and joins labels wrapped over lines", () => {
    const edit = parseInteractivePrompt("claude", `
● Write(notes.md)
────────────────────────────────────────
 Create file
 notes.md
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 # Notes
  2 ────────────────────────────────────────
  3 Results below the rule
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create notes.md?
 ❯ 1. Yes
   2. Yes, and switch to accept edits
   (auto-approve file edits and common
   file commands) for this session
   3. No
 Esc to cancel · Tab to amend
`);
    expect(edit).toMatchObject({ kind: "approval", title: "Create file", question: "Do you want to create notes.md?" });
    expect(labels(edit)).toEqual([
      "Yes", "Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session", "No",
    ]);
  });

  test("parses the last of several Codex 0.156 questions and its folder trust prompt", () => {
    const last = parseInteractivePrompt("codex", `
  Question 2/2 (1 unanswered)
  Which split?
  › 1. train (Recommended)  Use the training split.
    2. test                 Use the test split.
    3. None of the above    Optionally, add details in notes (tab).
  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt
`);
    expect(last).toMatchObject({ kind: "question", title: "Question 2 of 2", question: "Which split?", custom_option_index: 2 });
    expect(labels(last)).toEqual(["train (Recommended)", "test"]);

    const trust = parseInteractivePrompt("codex", `
  Folder access
  /tmp/prompt-lab-codex
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Back to Agent Command Center
  enter continue · esc back
`);
    expect(trust).toMatchObject({ kind: "approval", title: "Trust this folder?", body: "Codex can read, edit, and run files here, subject to your permission settings." });
    expect(labels(trust)).toEqual(["Trust and continue", "Back to Agent Command Center"]);
    expect(answerKeys(trust!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
  });

  test("parses Codex's folder trust prompt when its hint ends with esc quit", () => {
    const trust = parseInteractivePrompt("codex", `
  Folder access
  /tmp/prompt-lab-codex
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.
› 1. Trust and continue
  2. Open restricted
  enter continue · esc quit
`);
    expect(trust).toMatchObject({ kind: "approval", title: "Trust this folder?" });
    expect(labels(trust)).toEqual(["Trust and continue", "Open restricted"]);
    expect(answerKeys(trust!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
  });

  test("does not read Codex's update prompt as an approval under a question-like line", () => {
    expect(parseInteractivePrompt("codex", `
• Would you like to continue with the tests next?

  Update available! 0.162.1 -> 0.163.0
› 1. Update now
  2. Skip
  3. Skip until next version
  enter continue · esc skip
`)).toBeNull();
  });

  test("ignores unknown agents, stale transcript menus, and ordinary output", () => {
    expect(parseInteractivePrompt("other", "Enter to select · ↑/↓ to navigate · Esc to cancel")).toBeNull();
    expect(parseInteractivePrompt("claude", "No response requested. The task is complete.")).toBeNull();
    expect(parseInteractivePrompt("codex", `
Would you like to run the following command?
› 1. Yes, proceed
  2. No, and tell Codex what to do differently
Press enter to confirm or esc to cancel

• Command completed successfully.
› Ask Codex to do something
`)).toBeNull();
  });
});

describe("Codex's queue of questions (request_user_input_async)", () => {
  const status = "  GPT-6-Sol xhigh · ~/lab · Context 97% left · weekly 56% left";

  test("reads an open question: its position, a wrapped title, wrapped options and the typed-answer row", () => {
    const prompt = parseInteractivePrompt("codex", `
• WAITING
• Queued follow-up inputs
  1 of 2
  정리 범위를 현재 Q255 학습 출력과 연결된 산출물로 한정할까요, 아니면
  output/test 전체 실험까지 포함할까요?
  › 1. 현재 Q255 관련 산출물만
    2. output/test 전체 실험까지 포함해서 모두 정리하고
       결과를 표로 남기기
    3. Other
  enter submit   ctrl+] skip   alt+↓ main prompt   alt+↑ next question
`);
    expect(prompt).toMatchObject({
      kind: "question", title: "Question 1 of 2", queued: "open",
      question: "정리 범위를 현재 Q255 학습 출력과 연결된 산출물로 한정할까요, 아니면 output/test 전체 실험까지 포함할까요?",
      custom_option_index: 2,
    });
    expect(labels(prompt)).toEqual(["현재 Q255 관련 산출물만", "output/test 전체 실험까지 포함해서 모두 정리하고 결과를 표로 남기기"]);
    // an answer of its own is typed into the last row once it is selected, then submitted
    expect(answerKeys(prompt!, { custom_text: "Q255 only, keep logs" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { text: "Q255 only, keep logs" }, { keys: ["enter"] },
    ]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("reads an open free-form question, and a last row already typed over", () => {
    const freeForm = parseInteractivePrompt("codex", `
• Queued follow-up inputs
  Any notes?
  Type your answer
  enter submit   ctrl+] skip   alt+↓ main prompt
`);
    expect(freeForm).toMatchObject({ title: "Question", question: "Any notes?", options: [], custom_option_index: 0 });
    expect(answerKeys(freeForm!, { custom_text: "none" })).toEqual([{ text: "none" }, { keys: ["enter"] }]);

    const typed = parseInteractivePrompt("codex", `
• Queued follow-up inputs
  Which split?
    1. train
    2. test
  › 3. val spl
  enter submit   ctrl+] skip   alt+↓ main prompt
`);
    expect(labels(typed)).toEqual(["train", "test"]);
    expect(answerKeys(typed!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("a collapsed queue shows its first question, taken from the rollout's newest unanswered ones", () => {
    const collapsed = `
• WAITING
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
${status}
`;
    expect(parseInteractivePrompt("codex", collapsed)).toBeNull();
    // only the card answers it: Codex keeps working, and the chat's messages still go to Codex
    expect(codexQueuedPrompt(collapsed, [{ key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] }])?.queued).toBe("collapsed");
    // a message of the user's own waiting to go replaces the questions' block: nothing to open
    expect(codexQueuedPrompt(collapsed.replace("    alt+↑ to answer", "    alt+↑ to answer\n• Messages to be submitted after next tool call\n  ↳ stop, don't touch prod"), [
      { key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] },
    ])).toBeNull();
    const asked = [
      // skipped in the TUI: no record says so, but only the newest two are waiting
      { key: "call_a:0", title: "Old question?", options: ["x", "y"] },
      { key: "call_b:0", title: "Which dataset?", options: ["LM-O", "YCB-V"] },
      { key: "call_b:1", title: "Any notes?", options: [] },
    ];
    const prompt = codexQueuedPrompt(collapsed, asked);
    expect(prompt).toMatchObject({ kind: "question", title: "Question 1 of 2", question: "Which dataset?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["LM-O", "YCB-V"]);
    expect(codexQueuedPrompt(collapsed.replace("? 2 questions", "? 1 question"), asked)).toMatchObject({ title: "Question", question: "Any notes?", options: [], custom_option_index: 0 });
    // the queue opened on another question last time (one was skipped): the card shows that one
    expect(codexQueuedPrompt(collapsed, asked, { question: "Old question?", options: ["x", "y"] })).toMatchObject({ question: "Old question?", title: "Question 1 of 2" });
    // by title and options: an older skipped question with the same title is not the one it opened on
    const twins = [
      { key: "call_t:0", title: "Which dataset?", options: ["COCO"] },
      ...asked,
    ];
    expect(labels(codexQueuedPrompt(collapsed, twins, { question: "Which dataset?", options: ["LM-O", "YCB-V"] }))).toEqual(["LM-O", "YCB-V"]);
    expect(labels(codexQueuedPrompt(collapsed, twins, { question: "Which dataset?", options: ["COCO"] }))).toEqual(["COCO"]);
    // fewer on record than the queue holds: the card cannot say which is first
    expect(codexQueuedPrompt(collapsed, asked.slice(2))).toBeNull();
    // the count must be the queue above the main prompt, not an old line higher up
    expect(codexQueuedPrompt(collapsed.replace("› Ask Codex to do anything", `${"output line\n".repeat(20)}› Ask Codex`), asked)).toBeNull();
  });
});

describe("Codex's collapsed question queue", () => {
  test("is told apart from an open question, which holds the input", () => {
    const collapsed = `
• WAITING
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
  GPT-6-Sol xhigh · ~/lab · Context 97% left
`;
    expect(codexQuestionsCollapsed(collapsed)).toBe(true);
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  Which split?
  › 1. train
    2. test
    3. Other
  enter submit   ctrl+] skip   alt+↓ main prompt
`)).toBe(false);
    expect(codexQuestionsCollapsed("› Ask Codex to do anything\n")).toBe(false);
    // a numbered menu the parser does not know, right under the queue: not the main prompt
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  ? 1 question
    alt+↑ to answer
› 1. Continue with the new plan
  2. Stop here
`)).toBe(false);
    // an approval under the queue holds the input: a message would answer it
    expect(codexQuestionsCollapsed(`
• Queued follow-up inputs
  ? 1 question
    alt+↑ to answer

Would you like to run the following command?

$ rm -rf junk

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

Press enter to confirm or esc to cancel
`)).toBe(false);
  });

  test("the card and the send path read the same count, so they never tell different stories", () => {
    const asked = [{ key: "call_c:0", title: "Which dataset?", options: ["LM-O"] }, { key: "call_c:1", title: "Any notes?", options: [] }];
    const collapsed = `
• Queued follow-up inputs
  ? 2 questions · 8s
    alt+↑ to answer
› Ask Codex to do anything
  GPT-6-Sol xhigh · ~/lab · Context 97% left
`;
    const screens = {
      collapsed,
      // a message of the user's own waiting to be submitted
      queuedMessage: collapsed.replace("    alt+↑ to answer", "    alt+↑ to answer\n• Messages to be submitted after next tool call\n  ↳ stop, don't touch prod"),
      // something the parser does not know sits between the queue and the main prompt
      somethingBelow: collapsed.replace("› Ask Codex to do anything", "  Allow network access?\n› Ask Codex to do anything"),
      noHint: collapsed.replace("    alt+↑ to answer\n", ""),
      // a menu row the parser does not know, right under the hint, is not the main prompt
      numberedRow: collapsed.replace("› Ask Codex to do anything", "› 1. Allow once\n  2. Deny"),
      none: "› Ask Codex to do anything\n",
    };
    const shown = Object.fromEntries(Object.entries(screens).map(([name, screen]) => [name, [codexQueuedPrompt(screen, asked) !== null, codexQuestionsCollapsed(screen)]]));
    expect(shown).toEqual({ collapsed: [true, true], queuedMessage: [false, false], somethingBelow: [false, false], noHint: [false, false], numberedRow: [false, false], none: [false, false] });
  });

  test("Ultra's » main prompt still sits under the queue, while a numbered row there does not", () => {
    const asked = [{ key: "call_u:0", title: "Which dataset?", options: ["LM-O", "YCB-V"] }];
    const collapsed = `
• Queued follow-up inputs
  ? 1 question · 8s
    alt+↑ to answer
» Ask Codex to do anything
  GPT-6-Sol ultra · ~/lab · Context 97% left
`;
    for (const screen of [collapsed, collapsed.replace("alt+↑", "shift+←"), `${collapsed}  ? for shortcuts\n`]) {
      expect(codexQuestionsCollapsed(screen)).toBe(true);
      expect(codexQueuedPrompt(screen, asked)).toMatchObject({ queued: "collapsed", title: "Question", question: "Which dataset?" });
    }
    expect(codexQueuedPrompt(collapsed.replace("1 question", "2 questions"), [...asked, { key: "call_u:1", title: "Any notes?", options: [] }]))
      .toMatchObject({ title: "Question 1 of 2", question: "Which dataset?" });
    for (const screen of [
      collapsed.replace("» Ask Codex to do anything", "» 1. Allow\n  2. Deny"),
      collapsed.replace("» Ask Codex to do anything", "  Allow network access?\n» Ask Codex to do anything"),
      collapsed.replace("    alt+↑ to answer\n", ""),
      "» Ask Codex to do anything\n",
    ]) {
      expect(codexQuestionsCollapsed(screen)).toBe(false);
      expect(codexQueuedPrompt(screen, asked)).toBeNull();
    }
  });
});

describe("interactive prompt answers", () => {
  const claudeQuestion = () => parseInteractivePrompt("claude", `
☐ Dataset

Which evaluation dataset should we use?

❯ 1. LM-O
  2. YCB-V
  3. T-LESS
  4. Type something.
────────────────────────────
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`)!;

  test("selects the first and third options relative to the native cursor", () => {
    expect(answerKeys(claudeQuestion(), { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(claudeQuestion(), { option_index: 2 })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] },
    ]);
  });

  test("enters custom text through the provider's direct-input row", () => {
    expect(answerKeys(claudeQuestion(), { custom_text: "Use the internal benchmark" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] },
      { text: "Use the internal benchmark" },
      { keys: ["enter"] },
    ]);

    const codex = parseInteractivePrompt("codex", `
Which backend?

› 1. CUDA
  2. CPU
  3. None of the above  Add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`)!;
    expect(answerKeys(codex, { custom_text: "ROCm" })).toEqual([
      { keys: ["down"] }, { keys: ["down"] }, { keys: ["tab"] },
      { text: "ROCm" }, { keys: ["enter"] },
    ]);
  });

  test("rejects invalid answer shapes", () => {
    expect(() => answerKeys(claudeQuestion(), { option_index: 0, custom_text: "also" })).toThrow("Exactly one answer");
    expect(() => answerKeys(claudeQuestion(), { option_indices: [0] })).toThrow("requires one or more selections");
    expect(() => answerKeys(claudeQuestion(), { option_index: 99 })).toThrow("valid option index");
    expect(() => answerKeys(claudeQuestion(), { custom_text: 42 } as never)).toThrow("must be a string");
    expect(() => answerKeys(claudeQuestion(), { option_indices: null } as never)).toThrow("must be an array");
  });
});

describe("Claude's plan in a narrow pane", () => {
  // Claude Code 2.1.316's plan dialog with a made-up plan, wrapped as Claude wraps it: a 58-column pane
  // (two side by side) breaks the footer inside the plan's path or before it, a 44-column phone pane
  // spreads it over three lines
  const split = (footer: string) => `  ────────────────────────────────────────────────────────
   Ready to code?

   Here is Claude's plan:
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   Plan: add a heading to the README

   1. Add a heading line at the top of README.md.
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌


  ────────────────────────────────────────────────────────
   Claude has written up a plan and is ready to execute.
   Would you like to proceed?

   ❯ 1. Yes, and use auto mode
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this feedback

${footer}
`;
  const phone = `  ──────────────────────────────────────────
   Ready to code?

   Here is Claude's plan:
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   Plan: add a heading to the README

   1. Add a heading line at the top of
   README.md.
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌


  ──────────────────────────────────────────
   Claude has written up a plan and is
   ready to execute. Would you like to
   proceed?

   ❯ 1. Yes, and use auto mode
     2. Yes, manually approve edits
     3. Tell Claude what to change
        shift+tab to approve with this
        feedback

   ctrl+g to edit in VS Code ·
   ~/.claude/plans/plan-add-a-heading-to-th
   e-readme-mellow-pike.md
`;
  const screens = [
    ["wrapped inside the path", split("   ctrl+g to edit in VS Code · ~/.claude/plans/plan-add-a\n   -heading-to-the-readme-mellow-pike.md")],
    ["wrapped before the path", split("   ctrl+g to edit in VS Code ·\n   ~/.claude/plans/plan-readme-heading-mellow-pike.md")],
    ["over three lines", phone],
    ["on one line", split("   ctrl+g to edit in VS Code · ~/.claude/plans/plan-a.md")],
    ["wrapped inside the extension", split("   ctrl+g to edit in VS Code · ~/.claude/plans/aaaaaaaaa.m\n   d")],
    ["over four lines", phone.replace("   e-readme-mellow-pike.md", "   e-readme-and-the-changelog-in-one-go-m\n   ellow-pike.md")],
    ["over seven lines", phone.replace("   e-readme-mellow-pike.md", "   e-readme-and-the-changelog-in-one-go-m\n   ellow-pike-and-a-much-longer-name-tha\n   n-anyone-would-ever-give-a-plan-file-o\n   n-their-own-disk-or-anywhere-else-at-a\n   ll.md")],
    ["with a space in its wrapped folder", split("   ctrl+g to edit in VS Code · ~/Library/Application\n   Support/Claude Code/plans/plan-a.md")],
    ["wrapped inside the editor's name", split("   ctrl+g to edit in VS\n   Code · ~/.claude/plans/\n   example.md")],
    ["with a · in its folder", phone.replace("   ~/.claude/plans/plan-add-a-heading-to-th\n   e-readme-mellow-pike.md", "   ~/claude·work/plans/plan-add-a-heading-t\n   o-the-readme-mellow-pike.md")],
  ];

  test.each(screens)("reads the plan with its footer %s", (_footer, screen) => {
    const prompt = parseInteractivePrompt("claude", screen);
    expect(prompt).toMatchObject({
      kind: "plan", title: "Ready to code?", custom_option_index: 2,
      options: [{ label: "Yes, and use auto mode" }, { label: "Yes, manually approve edits" }, { label: "Tell Claude what to change" }],
    });
    expect(prompt?.body).toContain("Add a heading line");
  });

  test.each(screens)("reads no plan once output follows its footer %s", (_footer, screen) => {
    expect(parseInteractivePrompt("claude", `${screen}\n⏺ User approved Claude's plan\n`)).toBeNull();
    expect(parseInteractivePrompt("claude", `${screen}\n⏺ Updated README.md\n`)).toBeNull();
    expect(parseInteractivePrompt("claude", `${screen}\nREADME.md\n`)).toBeNull();
  });

  test("reads no plan once output runs on from its wrapped footer's last row", () => {
    expect(parseInteractivePrompt("claude", split("   ctrl+g to edit in VS Code ·\n   ~/.claude/plans/\n   old-plan.m\n   dREADME.md"))).toBeNull();
  });
});

describe("Claude's question in a narrow pane", () => {
  // live-captured from Claude Code 2.1.283 in a 44-column herdr pane: the hint wraps
  const narrow = `────────────────────────────────────────────
 ☐ 재현 테스트

│ 재현용 테스트 질문입니다. 지금 이 질문
│ 화면을 백그라운드에서 캡처하고 있으니,
│ 15초쯤 기다렸다가 아무거나 골라 주세요.
│ 기다리는 동안 채팅 모드에 이 질문 카드가
│ 뜨는지도 봐 주시면 좋습니다.

❯ 1. 채팅에 카드가 안 떠요
     채팅 모드에 이 질문이 보이지 않음
  2. 채팅에 카드가 떠요
     채팅 모드에 이 질문이 카드로 보임
  3. Type something.
────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to
cancel
`;

  test("reads the question though its hint wrapped, and knows it is still open", () => {
    const prompt = parseInteractivePrompt("claude", narrow);
    expect(prompt).toMatchObject({
      kind: "question",
      title: "재현 테스트",
      options: [{ label: "채팅에 카드가 안 떠요" }, { label: "채팅에 카드가 떠요" }],
      custom_option_index: 2,
    });
    expect(prompt?.question).toStartWith("재현용 테스트 질문입니다.");
  });

  test("does not take an answered menu above later output for an open one", () => {
    expect(parseInteractivePrompt("claude", narrow + "\n● Done.\n\n> ")).toBeNull();
  });
});

describe("a question under a numbered message sent earlier", () => {
  // live-captured from Claude Code in a 120-column herdr pane (shortened): the message sent before,
  // "1. …", stays on screen after the prompt mark, above the panel and the session's titled rule
  const claude = `
❯ 1. 로그인해서 커넥트 눌럿어

⏺ Tailscale 로그인은 완료됐습니다.

  Ran 1 shell command
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Buzz 공개

│ Buzz를 Tailscale 없이 인터넷에서 쓰도록 공개할까요?

❯ 1. 공개 진행 (추천)
     Cloudflare Tunnel로 buzz.kilpenguin.com을 엽니다. 인바운드 포트는 열지 않습니다. relay는 닫힌 모드(멤버 키 서명만
     허용)이고 relay와 /pair만 노출합니다.
  2. Tailscale 유지
     지금 구성 그대로 갑니다(이미 동작 중).
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
─────────────────────────────────────────────────────────────────────────────────────────────── Buzz 슬랙 대체 AI 조사 ─
`;

  test("reads Claude's question, not the sent message, as the menu, with a description wrapped over two lines", () => {
    const prompt = parseInteractivePrompt("claude", claude);
    expect(prompt).toMatchObject({ kind: "question", title: "Buzz 공개", question: "Buzz를 Tailscale 없이 인터넷에서 쓰도록 공개할까요?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["공개 진행 (추천)", "Tailscale 유지"]);
    expect(prompt?.options.map((option) => option.description)).toEqual([
      "Cloudflare Tunnel로 buzz.kilpenguin.com을 엽니다. 인바운드 포트는 열지 않습니다. relay는 닫힌 모드(멤버 키 서명만 허용)이고 relay와 /pair만 노출합니다.",
      "지금 구성 그대로 갑니다(이미 동작 중).",
    ]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("does not start the menu at a numbered line in the first option's description", () => {
    const prompt = parseInteractivePrompt("claude", `
 ☐ Setup

How should we set up?

  1. Script
     Runs these steps:
     1. Install deps
❯ 2. Manual
     Follow the guide.
  3. Type something.
────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`);
    expect(prompt).toMatchObject({ kind: "question", question: "How should we set up?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["Script", "Manual"]);
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("does not take the menu's column from a numbered line under its last option", () => {
    const prompt = parseInteractivePrompt("codex", `
› 1. 먼저 이것부터 해줘

✨ Update available! 0.146.0 -> 0.146.1

› 1. Update now
  2. Skip
  3. Skip until next version
     1. Asks again at the next release.

Press enter to continue
`);
    expect(prompt).toMatchObject({ kind: "menu", question: "Choose how to continue" });
    expect(labels(prompt)).toEqual(["Update now", "Skip", "Skip until next version"]);
  });

  test("reads Codex's open question without the queue header under a sent message", () => {
    const prompt = parseInteractivePrompt("codex", `
› 1. 먼저 이것부터 해줘

• 알겠습니다.

Which accelerator?

› 1. CUDA
  2. CPU
  3. Other

enter submit   ctrl + ] skip
option 1/3   shift + → main prompt
`);
    expect(prompt).toMatchObject({ kind: "question", question: "Which accelerator?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["CUDA", "CPU"]);
  });

  test("reads Codex's question under its own sent message", () => {
    const prompt = parseInteractivePrompt("codex", `
› 1. 먼저 이것부터 해줘

• 알겠습니다.

Which backend?

› 1. CUDA
  2. CPU
  3. None of the above  Add details in notes (tab).

tab to add notes | enter to submit answer | esc to interrupt
`);
    expect(prompt).toMatchObject({ kind: "question", question: "Which backend?", custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["CUDA", "CPU"]);
  });
});

describe("Claude's question with option previews", () => {
  // live-captured from Claude Code 2.1.288 in a 120-column herdr pane: the selected option's
  // preview is boxed to the right of the options, and the form has no "Type something" row
  const withPreview = `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ Layout  ☐ Features  ✔ Submit  →

Which layout?

❯ 1. Grid                         ┌──────────────────────────────────────────┐
  2. List                         │ ┌──┐ ┌──┐                                │
                                  │ │  │ │  │                                │
                                  │ └──┘ └──┘                                │
                                  │ ┌──┐ ┌──┐                                │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel
`;

  test("reads the options without the preview box and offers no typed answer", () => {
    const prompt = parseInteractivePrompt("claude", withPreview);
    expect(prompt).toMatchObject({
      kind: "question", title: "Layout · 1 of 2", question: "Which layout?",
      options: [{ label: "Grid", description: null }, { label: "List", description: null }],
      multi_select: false, custom_option_index: null,
    });
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt!, { custom_text: "x" })).toThrow();
  });

  test("cuts the box off at its own column only: a bar inside an option's text stays", () => {
    // the same screen with qualifiers after a bar, padded so the box keeps its column
    // padded by display width, so the box keeps its terminal column: a wide character takes two
    const relabel = (screen: string, from: string, to: string) => { expect(screen).toContain(from); return screen.replace(from, to + " ".repeat(Bun.stringWidth(from) - Bun.stringWidth(to))); };
    const screen = relabel(relabel(withPreview, "❯ 1. Grid                         ", "❯ 1. Grid  │ compact"), "  2. List                         ", "  2. List  │ spacious");
    const labelsOf = (prompt: InteractivePrompt | null) => prompt?.kind === "question" ? prompt.options.map((option) => `${option.label}${option.description === null ? "" : ` / ${option.description}`}`) : prompt;
    expect(labelsOf(parseInteractivePrompt("claude", screen))).toEqual(["Grid  │ compact", "List  │ spacious"]);
    // an option in wide characters: its box edge stands at the same column, at a smaller string index
    const wide = relabel(relabel(withPreview, "❯ 1. Grid                         ", "❯ 1. 격자 보기"), "  2. List                         ", "  2. 目录列表  │ 宽");
    expect(labelsOf(parseInteractivePrompt("claude", wide))).toEqual(["격자 보기", "目录列表  │ 宽"]);
    // a joined emoji is one grapheme two columns wide, not the sum of its code points
    const emoji = relabel(withPreview, "❯ 1. Grid                         ", "❯ 1. 👩‍💻 Code");
    expect(labelsOf(parseInteractivePrompt("claude", emoji))).toEqual(["👩‍💻 Code", "List"]);
  });

  test("does not take an answered form above later output for an open one", () => {
    expect(parseInteractivePrompt("claude", withPreview + "\n● Done.\n\n> ")).toBeNull();
  });

  // live-captured from Claude Code 2.1.290 in a 120-column herdr pane, asked with a long description
  // for every option: the form draws none, so nothing under an option is joined into one
  const described = (cursorOn: 0 | 1) => cursorOn === 0 ? `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Layout

Which layout should the report use?

❯ 1. Single Column                ┌──────────────────────────────────────────┐
  2. Two Column                   │ ┌──────────────────┐                     │
  3. Dashboard Grid               │ │     HEADER       │                     │
                                  │ ├──────────────────┤                     │
                                  │ │   Content here   │                     │
                                  │ │   More content   │                     │
                                  │ └──────────────────┘                     │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
` : `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 ☐ Layout

Which layout should the report use?

  1. Single Column                ┌──────────────────────────────────────────┐
❯ 2. Two Column                   │ ┌─────┬──────────┐                       │
  3. Dashboard Grid               │ │ KEY │ CONTENT  │                       │
                                  │ │ INF │ CONTENT  │                       │
                                  │ │ O   │ CONTENT  │                       │
                                  │ │     │ CONTENT  │                       │
                                  │ └─────┴──────────┘                       │
                                  └──────────────────────────────────────────┘

                                  Notes: press n to add notes

────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Chat about this

Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel
`;

  test("draws no option descriptions though the question gave them, and keeps its id as the cursor moves", () => {
    const first = parseInteractivePrompt("claude", described(0));
    const second = parseInteractivePrompt("claude", described(1));
    expect(labels(first)).toEqual(["Single Column", "Two Column", "Dashboard Grid"]);
    expect(first?.options.map((option) => option.description)).toEqual([null, null, null]);
    expect(second?.id).toBe(first!.id);
  });
});

describe("Claude's question over its task list", () => {
  // live-captured shape from Claude Code 2.1.289: the task list stays under the open panel,
  // after a rule that carries the session's name
  const question = `────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
←  ☐ 방향 검토  ☐ 문구  ✔ Submit  →

검토용 목업 페이지를 만들까요?

❯ 1. 만들지 않음 (Recommended)
     조건과 문구만 바뀌어 테스트로 확인 가능.
  2. 만듦
     목업으로 먼저 보고 확정한 뒤 구현.
  3. Type something.
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;
  const tasks = (rows: string) => `──────────────────────────────────────────────────────────────────────────────────────────────── 세션 이름 ─

${rows}
`;

  test("reads the question under the session's rule, with or without the task list", () => {
    for (const rows of [
      "",
      "  3 tasks (0 done, 3 open)\n  ◻ 준비\n  ◻ 구현\n  ◻ 검증",
      "  5 tasks (1 done, 1 in progress, 3 open)\n  ◼ 구현\n    Running tests…\n  ✔ 준비\n  ◻ 검증\n   … +2 pending",
    ]) {
      expect(parseInteractivePrompt("claude", question + tasks(rows))).toMatchObject({
        kind: "question", title: "방향 검토 · 1 of 2", question: "검토용 목업 페이지를 만들까요?",
        options: [{ label: "만들지 않음 (Recommended)" }, { label: "만듦" }], custom_option_index: 2,
      });
    }
  });

  test("does not take an answered form above later output and the task list for an open one", () => {
    const later = question + "\n⏺ 만들지 않음으로 진행합니다.\n\n────────\n❯ \n────────\n  ⏵⏵ bypass permissions on\n" + tasks("  3 tasks (0 done, 3 open)\n  ◻ 준비");
    expect(parseInteractivePrompt("claude", later)).toBeNull();
  });

  test("keeps output that ends in … after the list: only an in-progress task's activity is the list's", () => {
    const after = question + tasks("  3 tasks (0 done, 3 open)\n  ◻ 준비") + "⏺ Done…\n";
    expect(parseInteractivePrompt("claude", after)).toBeNull();
  });

  test("does not take an answered form for an open one when the agent's own lines follow the task header", () => {
    // the old panel is still in the buffer; the agent went on and the input line is the user's again
    const after = question + "\n  3 tasks (0 done, 3 open)\n● Continuing with the first option…\n❯ Explain the remaining work…\n";
    expect(parseInteractivePrompt("claude", after)).toBeNull();
  });

  test("does not take an answered form for an open one when output sits between the panel and the task list", () => {
    const after = question + "\n⏺ 만들지 않음으로 진행합니다.\n" + tasks("  3 tasks (0 done, 3 open)\n  ◻ 준비");
    expect(parseInteractivePrompt("claude", after)).toBeNull();
  });

  test("does not take a rule of another program under the panel for Claude's own", () => {
    expect(parseInteractivePrompt("claude", question + "\n⏺ Done.\n──── user@host:~/project ─\n")).toBeNull();
  });
});

describe("Claude's review of several answers in a named session", () => {
  // live-captured from Claude Code 2.1.299 (CLAUDE_CODE_NO_FLICKER=1, `--name`, 120x40): the review
  // has no key hint of its own, its last row is Cancel, and the session's rule follows it
  const rule = `${"─".repeat(107)} session-name ─`;
  const review = `❯ ASKREPRO 7

${"─".repeat(120)}
←  ☒ Route  ☒ Author  ☒ Notes  ✔ Submit  →

Review your answers

 ● Which way should the PR go?
   → my own words typed in the chat my own words t
 ● Who should author the commits?
   → Repo owner
 ● What should the release notes say?
   → my own words typed in the chat my own words typed in the chat my own w

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`;
  const withRule = (rows = "") => `${review}${rule}\n${rows ? `\n${rows}\n` : ""}`;
  // a review taller than the pane, same capture: the tabs and the heading are cut off at the top
  const tall = `
 │ ● The PC splits traffic between the main server and the reserve almost evenly, because both servers sit in the same
 │   city and answer equally fast. Which way should we go?
   → my own words typed in the chat my own words typed in the chat my own words typed in the chat my own words typed in
   the chat my own words typed in the chat
 │ ● After every subscription update the client restarts the tunnel. How often should the subscription be updated?
   → Once a day
 │ ● The client has no leak protection. What should we do?
   → my own words typed in the chat my own words typed in the chat my own words typed in the chat my own words typed in
   my own words typed in the chat my o

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
${rule}
`;

  test("reads the review under the session's rule, with or without the task list", () => {
    for (const rows of ["", "  3 tasks (0 done, 1 in progress, 2 open)\n  ◼ 구현\n    Running tests…\n  ◻ 검증\n  ◻ 정리"]) {
      const card = parseInteractivePrompt("claude", withRule(rows));
      expect(card).toMatchObject({ kind: "menu", title: "Review your answers", question: "Ready to submit your answers?", custom_option_index: null });
      expect(labels(card)).toEqual(["Submit answers", "Cancel"]);
      expect(card?.answers?.map((item) => item.question)).toEqual([
        "Which way should the PR go?", "Who should author the commits?", "What should the release notes say?",
      ]);
      expect(card?.answers?.[1]).toEqual({ question: "Who should author the commits?", answer: "Repo owner" });
      expect(answerKeys(card!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    }
  });

  test("reads a question the pane wrapped as one line, not as the terminal broke it", () => {
    const card = parseInteractivePrompt("claude", `
←  ☒ Names  ☒ Replay  ✔ Submit  →

Review your answers

 ● What should the two top-level rows be called?
   → Fictional repo names (Recommended)
 ● The demo's terminal replay (git log, bun test, the pretend shell) lives in the 'release' shell workspace. What
 happens to it?
   → Second tab in a repo (Recommended)

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`);
    expect(card?.answers).toEqual([
      { question: "What should the two top-level rows be called?", answer: "Fictional repo names (Recommended)" },
      { question: "The demo's terminal replay (git log, bun test, the pretend shell) lives in the 'release' shell workspace. What happens to it?", answer: "Second tab in a repo (Recommended)" },
    ]);
    expect(card?.body).toBeNull();
  });

  test("keeps Claude's own warning out of the answers, and marks what the top cut off", () => {
    // Claude Code 2.1.302 draws the warning at the panel's edge, the answers indented
    const card = parseInteractivePrompt("claude", `
←  ☐ Names  ☒ Replay  ✔ Submit  →

Review your answers

⚠ You have not answered all questions

 ● The demo's terminal replay lives in the 'release' shell workspace. What happens to it?
   → Second tab in a repo

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel
`);
    expect(card?.answers).toEqual([{ question: "The demo's terminal replay lives in the 'release' shell workspace. What happens to it?", answer: "Second tab in a repo" }]);
    expect(card?.body).toBe("⚠ You have not answered all questions");

    // the pane's top cut an answer: its rest is shown as a rest, not as a question
    const cut = parseInteractivePrompt("claude", tall.replace(/^[\s\S]*?(?=   the chat my own words typed in the chat\n)/, "\n"));
    expect(cut?.answers?.[0]).toEqual({ question: null, answer: "…the chat my own words typed in the chat" });
    expect(cut?.answers?.[1]?.answer).toBe("Once a day");
  });

  test("reads a review cut off at the top of the pane, its tabs and heading out of view", () => {
    const card = parseInteractivePrompt("claude", tall);
    expect(card).toMatchObject({ kind: "menu", title: "Review your answers", question: "Ready to submit your answers?" });
    expect(labels(card)).toEqual(["Submit answers", "Cancel"]);
    // the wrapped lines of a question and of an answer read as one line each
    expect(card?.answers).toEqual([
      {
        question: "The PC splits traffic between the main server and the reserve almost evenly, because both servers sit in the same city and answer equally fast. Which way should we go?",
        answer: "my own words typed in the chat ".repeat(5).trim(),
      },
      { question: "After every subscription update the client restarts the tunnel. How often should the subscription be updated?", answer: "Once a day" },
      { question: "The client has no leak protection. What should we do?", answer: `${"my own words typed in the chat ".repeat(3)}my own words typed in my own words typed in the chat my o` },
    ]);
  });

  test("does not take an answered review above later output and the session's rule for an open one", () => {
    expect(parseInteractivePrompt("claude", `${review}\n⏺ Done.\n\n${rule}\n`)).toBeNull();
    expect(parseInteractivePrompt("claude", `${review}\n⏺ Done.\n──── user@host:~/project ─\n`)).toBeNull();
  });

  test("takes no screen without the review's own tabs, answers and rows for one", () => {
    // no tabs and no answer of the review's above the question: some other text that says the same
    expect(parseInteractivePrompt("claude", `Notes for the release\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel\n${rule}\n`)).toBeNull();
    // cut off at the top, but the rows are not the review's
    expect(parseInteractivePrompt("claude", tall.replace("1. Submit answers", "1. Ship it"))).toBeNull();
    // tabs far above, with another panel's rule between them and the question: not this review's
    expect(parseInteractivePrompt("claude", `←  ☒ Route  ✔ Submit  →\n ● Which way?\n   → Fork\n${"─".repeat(120)}\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel\n`)).toBeNull();
  });
});

describe("Claude's held message", () => {
  // Claude Code 2.1.294, live: a pasted message with a zero-width space, after its Enter
  const rule = "─".repeat(80);
  const held = (box: string, footer = "  [Haiku 4.5] │ project\n  ⏸ manual mode on") => `
 ▐▛███▜▌   Claude Code v2.1.294
${" ".repeat(40)}Removed 1 invisible character · review and press Enter to send
${rule}
${box}
${rule}
${footer}
`;

  test("shows the message Claude holds, with Send and Discard", () => {
    const prompt = parseInteractivePrompt("claude", held("❯ helloworld test"))!;
    expect(prompt).not.toBeNull();
    expect(prompt.title).toBe("Claude Code removed 1 invisible character");
    expect(prompt.body).toBe("helloworld test");
    expect(prompt.options.map((option) => option.label)).toEqual(["Send", "Discard"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["ctrl+c"] }]);
  });

  test("keeps a held message of several lines whole, and counts the characters", () => {
    const screen = held("❯ first line\n  second line").replace("Removed 1 invisible character", "Removed 3 invisible characters");
    const prompt = parseInteractivePrompt("claude", screen)!;
    expect(prompt.title).toBe("Claude Code removed 3 invisible characters");
    expect(prompt.body).toBe("first line\nsecond line");
  });

  test("knows a held message without the hint, by what the chat just sent", () => {
    // a turn's status line took the hint's row: only the box says it, and only to the one who sent it
    const screen = held("\u276f timingtest").replace(/.*Removed 1 invisible character.*\n/, "  \u273b Cooked for 1s \u00b7 done 5:23 PM\n");
    expect(parseInteractivePrompt("claude", screen)).toBeNull();
    const prompt = parseInteractivePrompt("claude", screen, null, true, [], "timing\u200btest")!;
    expect(prompt.title).toBe("Claude Code removed 1 invisible character");
    expect(prompt.body).toBe("timingtest");
    // a box that differs in anything visible is the user's own draft
    expect(parseInteractivePrompt("claude", screen, null, true, [], "timing\u200btests")).toBeNull();
    expect(parseInteractivePrompt("claude", screen, null, true, [], "timingtest")).toBeNull();
  });

  test("counts only invisible characters as removed, a wrapped box aside", () => {
    expect(removedInvisible("a\u200bb\u2060c\ufeff", "abc")).toBe(3);
    expect(removedInvisible("long message here", "long mess\nage here")).toBe(0);
    expect(removedInvisible("abc", "abd")).toBe(0);
    expect(removedInvisible("ab\u200bc", "ab")).toBe(0);
    expect(removedInvisible("\ud55c\u3164\uae00", "\ud55c\uae00")).toBe(1);
  });

  test("offers no Discard while Claude works: its Ctrl+C would interrupt the turn", () => {
    // Claude Code 2.1.294, live: Ctrl+C under a running turn answers "Interrupted" and leaves the box as it was
    const prompt = parseInteractivePrompt("claude", held("❯ helloworld test"), null, true, [], null, true)!;
    expect(prompt.body).toBe("helloworld test");
    expect(prompt.options.map((option) => option.label)).toEqual(["Send"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { option_index: 1 })).toThrow();
  });

  test("is gone once the input is empty, and never reads the hint off a quoted screen", () => {
    // sent or discarded: the hint stays over an empty input
    expect(parseInteractivePrompt("claude", held("❯"))).toBeNull();
    // output under the box is not Claude's footer: the hint is quoted, not live
    expect(parseInteractivePrompt("claude", held("❯ hi", `  footer\n${rule}\n❯ another box`))).toBeNull();
    // the same words not over an input box
    expect(parseInteractivePrompt("claude", "Removed 1 invisible character · review and press Enter to send\nsome output\n")).toBeNull();
  });
});

describe("Claude's unnumbered menus", () => {
  // Claude Code 2.1.285 on a folder it has not seen, as herdr's pane read shows it (live)
  const trust = (selected: 0 | 1 = 0, after = "") => `
❯ claude --model claude-haiku-4-5-20251001

────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /home/user/projects/new-app

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this folder

 Enter to confirm · Esc to cancel
${after}`;

  test("reads the folder-trust check as a menu with its question and both rows", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(prompt).not.toBeNull();
    expect(prompt.kind).toBe("menu");
    expect(prompt.title).toBe("Accessing workspace");
    expect(prompt.question).toBe("Is this a project you created or one you trust?");
    expect(labels(prompt)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(prompt.body).toContain("Claude Code'll be able to read, edit, and execute files here.");
  });

  test("answers from the native cursor, and keeps its id when only the cursor moves", () => {
    const prompt = parseInteractivePrompt("claude", trust())!;
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    const moved = parseInteractivePrompt("claude", trust(1))!;
    expect(moved.id).toBe(prompt.id);
    expect(answerKeys(moved, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(() => answerKeys(prompt, { custom_text: "maybe" })).toThrow();
  });

  test("is gone once the menu is answered and Claude draws under it", () => {
    expect(parseInteractivePrompt("claude", trust(1, " ▐▛███▛█   Claude Code v2.1.285\n❯ Try \"fix typecheck errors\"\n"))).toBeNull();
  });

  test("keeps a label a narrow pane wrapped as one row", () => {
    // 24 columns: the panel's sentences and the second row both reach the edge and wrap
    const narrow = (selected: 0 | 1) => `
 Accessing workspace:

 Quick safety check: Is
 this a project you
 created or one you
 trust?

 ${selected === 0 ? "❯" : " "} No, exit
 ${selected === 1 ? "❯" : " "} Yes, I trust this
   folder

 Enter to confirm · Esc
 to cancel
`;
    const prompt = parseInteractivePrompt("claude", narrow(0))!;
    expect(labels(prompt)).toEqual(["No, exit", "Yes, I trust this folder"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(labels(parseInteractivePrompt("claude", narrow(1)))).toEqual(["No, exit", "Yes, I trust this folder"]);
  });

  test("never takes the next row for a wrapped label when a row is the widest line", () => {
    // nothing else on screen reaches as far as the first row, so it says nothing of the pane's
    // width: the line under it may be its tail or the next row, and a guess answers the wrong row
    const two = (selected: 0 | 1) => `
 Trust?

 ${selected === 0 ? "❯" : " "} Yes, trust this folder and continue
 ${selected === 1 ? "❯" : " "} No, exit

 Enter to confirm · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", two(0))).toBeNull();
    // with the cursor on it, the second line is a row for certain
    expect(labels(parseInteractivePrompt("claude", two(1)))).toEqual(["Yes, trust this folder and continue", "No, exit"]);
    // merged, this would show two options and answer the second with one Down, the real `Yes`
    const three = `
 Trust?

 ❯ No, exit and keep this folder untrusted
   Yes
   Yes, and allow hooks too

 Enter to confirm · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", three)).toBeNull();
    const panel = ` Trust? The first row is not the widest line here, so this one tells the width.\n${three.slice(" Trust?\n".length + 1)}`;
    const prompt = parseInteractivePrompt("claude", panel);
    expect(labels(prompt)).toEqual(["No, exit and keep this folder untrusted", "Yes", "Yes, and allow hooks too"]);
    expect(answerKeys(prompt!, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("leaves numbered rows and a menu without one selected row to the other readers", () => {
    expect(parseInteractivePrompt("claude", "Pick one\n\n❯ 1. First\n  2. Second\n\nEnter to confirm · Esc to cancel\n")).toBeNull();
    expect(parseInteractivePrompt("claude", "Pick one\n\n  First\n  Second\n\nEnter to confirm · Esc to cancel\n")).toBeNull();
  });
});

describe("OmO's ask_user_question form", () => {
  // omo 5.1.7 in a 120-column herdr pane, as herdr reads it: the overlay between two rules, then
  // omo's footer. herdr labels the pane `pi` while omo waits on it.
  const rule = "─".repeat(120);
  const footer = `${rule}\n/private/tmp/omo-ask${" ".repeat(74)}[----------] 42K/1M (4.2%)\n${" ".repeat(86)}claude-opus-5-5 · high · OmO 5.1.7\n`;
  const form = (body: string) => `\n [표시 위치] [월 한도] wait for answer\n\n${rule}\n\n Ask user · 30m\n${body}\n${footer}`;
  const first = form(` → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여줄까요?
 → 1. 설정 > 음성 입력 (추천)
      오늘, 이번 달, 누적의 분·횟수·추정 비용을 보여주고 OpenAI 사용량 페이지 링크를 붙입니다. 변경 범위가 가장 작습니
 다.
   2. 설정 + 사이드바 미터
      사이드바의 구독 사용량 미터 옆에 음성 항목도 넣습니다. 한눈에 보이지만 UI 변경이 커집니다.
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
`);

  test("reads the question asked now, its options and the form's steps", () => {
    const prompt = parseInteractivePrompt("pi", first);
    expect(prompt).toMatchObject({
      agent: "omo", kind: "question", title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?",
      multi_select: false, custom_option_index: 2,
      steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }],
    });
    expect(labels(prompt)).toEqual(["설정 > 음성 입력 (추천)", "설정 + 사이드바 미터"]);
    // a word the pane wrapped at its edge is one word again
    expect(prompt?.options[0]?.description).toEndWith("변경 범위가 가장 작습니다.");
    // navigation picks the option and moves on; a typed answer replaces one typed before
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt!, { custom_text: "둘 다" })).toEqual([
      { keys: ["backspace"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }, { text: "둘 다" }, { keys: ["enter"] },
    ]);
    expect(() => answerKeys(prompt!, { option_index: 2 })).toThrow("valid option index");
    // herdr may name the pane omo, or claude while omo's SDK child runs
    expect(parseInteractivePrompt("omo", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("claude", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("", first)?.id).toBe(prompt?.id);
    expect(parseInteractivePrompt("codex", first)).toBeNull();
  });

  test("marks answered questions and chosen options, and a new step is another card", () => {
    const second = form(`   표시 위치 ✓  → 월 한도 ✓    Submit
 월 사용 한도를 둘까요?
   1. 한도 없음
      경고만 표시합니다.
   2. 월 $5 한도 ✓
      넘으면 음성 입력을 막습니다.
 → Type your own answer...
 Submit (2/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
`);
    const prompt = parseInteractivePrompt("pi", second);
    expect(prompt).toMatchObject({ title: "Question 2 of 2", question: "월 사용 한도를 둘까요?" });
    expect(labels(prompt)).toEqual(["한도 없음", "월 $5 한도"]);
    expect(prompt?.steps?.map((step) => [step.answered, step.current])).toEqual([[true, false], [true, true]]);
    expect(prompt?.id).not.toBe(parseInteractivePrompt("pi", first)?.id);
    // the cursor is on the typed answer's row already
    expect(answerKeys(prompt!, { custom_text: "없음" })).toEqual([{ keys: ["backspace"] }, { keys: ["enter"] }, { text: "없음" }, { keys: ["enter"] }]);
  });

  test("answers a multiple choice afresh by navigation, then moves on with Tab", () => {
    const prompt = parseInteractivePrompt("pi", form(` → 검사    보고    Submit
 어떤 검사를 돌릴까요?
 → 1. Lint ✓
      빠른 정적 검사
   2. Tests
      단위 테스트
   3. Build
   Type your own answer...
 Submit (1/2 answered) — Enter toggles; Tab to Submit
 ↑↓ move  1-9 select  space toggle  enter toggle  tab next / Submit  c comment  esc cancel
`));
    expect(prompt).toMatchObject({ title: "Question 1 of 2", multi_select: true, custom_option_index: null });
    expect(labels(prompt)).toEqual(["Lint", "Tests", "Build"]);
    expect(prompt?.options[2]?.description).toBeNull();
    // Backspace clears what was chosen before (Lint here, or rows out of view), then each number toggles one
    expect(answerKeys(prompt!, { option_indices: [2, 0] })).toEqual([{ keys: ["backspace"] }, { keys: ["space"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["space"] }, { keys: ["tab"] }]);
    expect(answerKeys(prompt!, { option_indices: [1] })).toEqual([{ keys: ["backspace"] }, { keys: ["down"] }, { keys: ["space"] }, { keys: ["tab"] }]);
  });

  test("reviews the answers: Submit, a row to change, or a comment", () => {
    const review = (rows: string, hint: string) => form(`   표시 위치 ✓    월 한도 ✓  → Submit
 Review your answers
${rows}

 Comment (optional; unanswered questions are reported)
>
 Submit (2/2 answered)
 ${hint}
`);
    const onComment = parseInteractivePrompt("pi", review("   표시 위치: 설정 > 음성 입력 (추천)\n   월 한도: 월 $5 한도", "enter submit  ↑ review answers  shift+tab back  tab next question  esc back"));
    expect(onComment).toMatchObject({
      kind: "menu", title: "Review your answers", question: "Submit (2/2 answered)", body: null, custom_option_index: 3,
      steps: [{ label: "표시 위치", answered: true, current: false }, { label: "월 한도", answered: true, current: false }],
    });
    expect(labels(onComment)).toEqual(["Submit", "표시 위치: 설정 > 음성 입력 (추천)", "월 한도: 월 $5 한도", "Comment (optional; unanswered questions are reported)"]);
    expect(answerKeys(onComment!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(onComment!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(onComment!, { custom_text: "급해요" })).toEqual([{ text: "급해요" }, { keys: ["enter"] }]);
    expect(() => answerKeys(onComment!, { option_index: 3 })).toThrow("valid option index");

    const onRow = parseInteractivePrompt("pi", review("   표시 위치: 설정 > 음성 입력 (추천)\n → 월 한도: 월 $5 한도", "enter edit answer  ↑↓ move  tab next question  esc back"));
    expect(onRow?.id).toBe(onComment?.id);
    expect(answerKeys(onRow!, { option_index: 0 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(onRow!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(onRow!, { custom_text: "급해요" })).toEqual([{ keys: ["down"] }, { text: "급해요" }, { keys: ["enter"] }]);

    // the label before a typed comment is the bridge's, as a key (#1482); the comment and omo's notice are not
    const typed = (field: string) => parseInteractivePrompt("pi", review("   표시 위치: 설정 > 음성 입력 (추천)\n   월 한도: 월 $5 한도", "enter submit  ↑ review answers  shift+tab back  tab next question  esc back").replace(">\n Submit", field));
    const commented = typed("> 급해요\n Submit");
    expect(commented?.body).toBe("Comment: 급해요");
    expect(commented?.own_text?.body).toEqual({ key: "Comment: {comment}", vars: { comment: "급해요" } });
    const noticed = typed("> 급해요\n ! 1 answer was changed\n Submit");
    expect(noticed?.body).toBe("1 answer was changed\nComment: 급해요");
    expect(noticed?.own_text?.body).toEqual({ key: "{notice}\nComment: {comment}", vars: { notice: "1 answer was changed", comment: "급해요" } });
  });

  test("joins what a narrow pane wraps, the tab bar, the hint and words cut at the edge", () => {
    // omo's own renderer at 40 columns
    const narrow = `${"─".repeat(40)}

 Ask user
 → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여
 줄까요?
 → 1. 설정 > 음성 입력 (추천)
      오늘, 이번 달, 누적의 분·횟수·추
 정 비용을 보여줍니다.
   2. 설정 + 사이드바 미터
      한눈에 보이지만 UI 변경이 커집니
 다.
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select
 enter next  tab next question  c
 comment  esc cancel

${"─".repeat(40)}
`;
    const prompt = parseInteractivePrompt("pi", narrow);
    expect(prompt?.question).toBe("음성 사용량과 추정 비용을 어디에 보여줄까요?");
    expect(prompt?.options.map((option) => option.description)).toEqual(["오늘, 이번 달, 누적의 분·횟수·추정 비용을 보여줍니다.", "한눈에 보이지만 UI 변경이 커집니다."]);
  });

  test("is no card once output has followed the form", () => {
    const later = first.replace(footer, `${Array.from({ length: 12 }, (_, index) => ` line ${index}`).join("\n")}\n${footer}`);
    expect(parseInteractivePrompt("pi", later)).toBeNull();
  });

  // The form's text on a screen that is not omo's live form: printed in a shell, or quoted in
  // Claude's transcript. A card there would type its answer into that program. Each is tried as
  // the form alone and with the rule and footer omo drew under it.
  const printed = [first.replace(footer, ""), first];
  const claudeBox = `\n${rule}\n❯ \n${rule}\n  ? for shortcuts\n`;
  const agents = ["", "pi", "omo", "claude"];

  test("is no card for the form's text printed in a shell, its prompt below", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text}user@host:~/project$ `)).toBeNull();
    }
  });

  test("is no card for the form's text in a shell with output after it", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text} M server/prompt.ts\n M CHANGELOG.md\n 2 files changed\n`)).toBeNull();
    }
  });

  test("is no card for the form's text in Claude's transcript, over Claude's input box", () => {
    for (const text of printed) {
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${text}${claudeBox}`)).toBeNull();
    }
  });

  test("is no card for the form's text quoted (indented) in Claude's transcript", () => {
    for (const text of printed) {
      const quoted = text.split("\n").map((line) => line ? `  ${line}` : line).join("\n");
      for (const agent of agents) expect(parseInteractivePrompt(agent, `${quoted}${claudeBox}`)).toBeNull();
    }
  });

  test("needs the session's matching call when the pane is not known to wait on the user", () => {
    // what the server asks for a pane herdr names claude, or not at all, that is not blocked
    expect(parseInteractivePrompt("", first, null, false)).toBeNull();
    expect(parseInteractivePrompt("claude", first, null, false)).toBeNull();
    const ask = { questions: ["표시 위치", "월 한도"].map((header) => ({
      header, question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", multiSelect: false, options: [{ label: "설정 > 음성 입력 (추천)", description: null }, { label: "설정 + 사이드바 미터", description: null }],
    })) };
    expect(parseInteractivePrompt("", first, ask, false)).toMatchObject({ title: "Question 1 of 2" });
    // another form's call is no evidence
    ask.questions[1]!.header = "다른 질문";
    expect(parseInteractivePrompt("claude", first, ask, false)).toBeNull();
  });

  // omo's session file for the form below: the ask_user_question call, then (once answered) its result
  const call = {
    questions: [
      { header: "표시 위치", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", options: [
        { label: "설정 > 음성 입력 (추천)", description: "오늘, 이번 달, 누적을 보여줍니다." },
        { label: "설정 + 사이드바 미터", description: "한눈에 보이지만 UI 변경이 커집니다." },
        { label: "상단 상태 표시줄", description: "항상 보입니다." },
        { label: "표시하지 않음" },
      ] },
      { header: "월 한도", question: "월 사용 한도를 둘까요?", options: [{ label: "한도 없음" }, { label: "월 $5 한도" }] },
    ],
    waitForAnswer: true,
  };
  const record = (message: unknown) => JSON.stringify({ type: "message", message });
  const asking = [
    record({ role: "user", content: [{ type: "text", text: "ask me" }] }),
    record({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask_user_question", arguments: call }] }),
  ].join("\n");
  // omo's own renderer at 60 columns, in a pane too short for the whole form
  const rule60 = "─".repeat(60);

  test("finds the call omo's session waits on", () => {
    const ask = pendingOmoAsk(asking);
    expect(ask?.questions.map((question) => [question.header, question.options.length, question.multiSelect])).toEqual([["표시 위치", 4, false], ["월 한도", 2, false]]);
    expect(ask?.questions[0]!.options[3]).toEqual({ label: "표시하지 않음", description: null });
    // answered, the agent moved on, or not the shape omo asks with
    expect(pendingOmoAsk(`${asking}\n${record({ role: "toolResult", toolCallId: "call-1", content: [] })}`)).toBeNull();
    expect(pendingOmoAsk(`${asking}\n${record({ role: "assistant", content: [{ type: "text", text: "done" }] })}`)?.id).toBe("call-1");
    expect(pendingOmoAsk(asking.replace('"questions"', '"items"'))).toBeNull();
    // a tail read from inside a record
    expect(pendingOmoAsk(`ge":{"role":"user"}}\n${asking}`)?.questions).toHaveLength(2);
  });

  test("takes the form's text from the session's call, the screen telling where it stands", () => {
    const short = `      한눈에 보이지만 UI 변경이 커집니다.
   3. 상단 상태 표시줄
      항상 보입니다.
   4. 표시하지 않음
   Type your own answer...
 Submit (0/2 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next
 question  c comment  esc cancel

${rule60}
`;
    // the title, the tabs and the question are above the pane's top
    expect(parseInteractivePrompt("pi", short)).toBeNull();
    const prompt = parseInteractivePrompt("pi", short, pendingOmoAsk(asking));
    expect(prompt).toMatchObject({
      title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", custom_option_index: 4,
      steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }],
    });
    expect(labels(prompt)).toEqual(["설정 > 음성 입력 (추천)", "설정 + 사이드바 미터", "상단 상태 표시줄", "표시하지 않음"]);
    expect(prompt?.options[0]?.description).toBe("오늘, 이번 달, 누적을 보여줍니다.");
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([...Array.from({ length: 5 }, () => ({ keys: ["up"] })), { keys: ["enter"] }]);
    // the cursor's row is out of view: to the typed answer's row from the top, where ↑ stops
    expect(answerKeys(prompt!, { custom_text: "둘 다" })).toEqual([
      { keys: ["backspace"] }, ...Array(5).fill({ keys: ["up"] }), ...Array(4).fill({ keys: ["down"] }), { keys: ["enter"] },
      { text: "둘 다" }, { keys: ["enter"] },
    ]);
    // rows that are not the call's question's are no card
    expect(parseInteractivePrompt("pi", short, { questions: [pendingOmoAsk(asking)!.questions[1]!] })).toBeNull();

    // with the whole form in view the call's text wins over the pane's wrap; another call is ignored
    const ask = pendingOmoAsk(asking.replaceAll("상단 상태 표시줄", "x").replace("오늘, 이번 달, 누적을 보여줍니다.", "원문 설명"))!;
    ask.questions[0]!.options.splice(2);
    expect(parseInteractivePrompt("pi", first, ask)?.options[0]?.description).toBe("원문 설명");
    ask.questions[1]!.header = "다른 질문";
    expect(parseInteractivePrompt("pi", first, ask)?.options[0]?.description).toEndWith("가장 작습니다.");
  });

  test("offers to save or discard an answer typed in the terminal", () => {
    const typing = `      항상 보입니다.
   4. 표시하지 않음
   Type your own answer...
 Your answer (enter to save, ↑↓ back to options, esc to
 discard)
> 안녕
 Submit (0/2 answered) — Enter advances
 enter save and next  ↑↓ back to options  tab next question
   esc discard

${rule60}
`;
    const prompt = parseInteractivePrompt("pi", typing, pendingOmoAsk(asking));
    expect(prompt).toMatchObject({ kind: "menu", title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?", custom_option_index: null });
    expect(prompt?.options).toEqual([{ label: "Save the typed answer", description: "안녕" }, { label: "Discard it", description: null }]);
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
    // the whole form in view needs no session
    const whole = form(` → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여줄까요?
   1. 설정 > 음성 입력 (추천)
   Type your own answer...
 Your answer (enter to save, ↑↓ back to options, esc to discard)
> 안녕
 Submit (0/2 answered) — Enter advances
 enter save and next  ↑↓ back to options  tab next question  esc discard
`);
    expect(parseInteractivePrompt("pi", whole)).toMatchObject({ title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?" });
  });

  test("reviews the answers of a form whose rows are out of view, by the call's headers", () => {
    const short = `
 Comment (optional; unanswered questions are reported)
>
 Submit (2/2 answered)
 enter submit  ↑ review answers  shift+tab back  tab next
 question  esc back

${rule60}
`;
    expect(parseInteractivePrompt("pi", short)).toBeNull();
    const prompt = parseInteractivePrompt("pi", short, pendingOmoAsk(asking));
    expect(labels(prompt)).toEqual(["Submit", "표시 위치", "월 한도", "Comment (optional; unanswered questions are reported)"]);
    expect(prompt?.steps?.every((step) => step.answered && !step.current)).toBeTrue();
    expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });

  // the same call asked without waiting: omo accepts it at once and folds it into a widget
  const accepted = (id: string) => record({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "Question accepted; the answer will arrive as a user message." }], details: { accepted: true, status: "pending" }, isError: false });
  const asyncAsking = `${asking.replace('"waitForAnswer":true', '"waitForAnswer":false')}\n${accepted("call-1")}\n${record({ role: "assistant", content: [{ type: "text", text: "meanwhile" }], stopReason: "stop" })}`;

  for (const count of ["one", "two"]) for (const width of ["wide", "narrow"]) {
    test(`reads the real 5.1.30 ${count}-question ${width} widget with its pending call`, () => {
      const open = openOmoAsks(omoPendingFixture(`${count}.jsonl`));
      const question = open[0]!.questions[0]!;
      const prompt = parseInteractivePrompt("pi", omoPendingFixture(`${count}-${width}.txt`), null, false, open);
      expect(prompt).toMatchObject({
        agent: "omo", kind: "question", question: question.question, options: question.options,
        multi_select: question.multiSelect, custom_option_index: question.multiSelect ? null : question.options.length,
        title: count === "one" ? question.header : "Question 1 of 2",
      });
    });
  }

  // omo 5.1.48 joins the header and the question with " - " where 5.1.30 drew " — "
  for (const width of ["wide", "narrow"]) {
    test(`reads the real 5.1.48 two-question ${width} widget with its pending call`, () => {
      const open = openOmoAsks(omo48PendingFixture("two.jsonl"));
      const question = open[0]!.questions[0]!;
      const screen = omo48PendingFixture(`two-${width}.txt`);
      expect(screen).toContain(`${question.header} - `);
      expect(parseInteractivePrompt("pi", screen, null, false, open)).toMatchObject({
        agent: "omo", kind: "question", title: "Question 1 of 2", question: question.question, options: question.options,
        multi_select: false, custom_option_index: question.options.length,
      });
    });
  }

  test("reads a 5.1.48 widget whose header holds the separator, and only for a call it shows", () => {
    const jsonl = omo48PendingFixture("two.jsonl");
    const screen = omo48PendingFixture("two-wide.txt");
    const { header, question } = openOmoAsks(jsonl)[0]!.questions[0]!;
    const read = (calls: string, shown: string) => parseInteractivePrompt("pi", shown, null, false, openOmoAsks(calls));
    // a header holding " - " splits there first; the split after it is the one the call asked
    const dashed = `${header} - x`;
    const dashedCalls = jsonl.replaceAll(`"header":"${header}"`, `"header":"${dashed}"`);
    expect(read(dashedCalls, screen.replaceAll(`${header} - `, `${dashed} - `))).toMatchObject({ agent: "omo", title: "Question 1 of 2" });
    // a header or question the call does not hold, or nothing after the separator: no card
    expect(read(dashedCalls, screen)).toBeNull();
    expect(read(jsonl, screen.replaceAll(`${header} - `, `${header} - another `))).toBeNull();
    expect(read(jsonl, screen.replaceAll(question, "..."))).toBeNull();
  });

  test("tries separators that share a space, and gives no card when two calls fit the line", () => {
    const screen = omo48PendingFixture("two-wide.txt");
    const call = (id: string, header: string, question: string, options: string[]) => [
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "ask_user_question", arguments: { questions: [{ header, question, multiSelect: false, options: options.map((label) => ({ label })) }], waitForAnswer: false } }] } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "ask_user_question", content: [{ type: "text", text: "Question accepted; the answer will arrive as a user message." }], details: { accepted: true, requestId: id, status: "pending" }, isError: false } }),
    ].join("\n");
    const actual = call("actual", "Plan -", "Choose deployment target?", ["Staging", "Production"]);
    const decoy = call("decoy", "Plan", "- Choose deployment target?", ["Continue", "Cancel"]);
    const widget = (separator: string) => screen.replace(/\? Question pending[^\n]*\n[^\n]*\n[^\n]*\n/,
      `? 2 questions pending · 30m\n  Plan -${separator}Choose deployment target?\n[ Staging ]  [ Production ]  [ own answer\u2026 ]\n`);
    const read = (calls: string, separator: string) => parseInteractivePrompt("pi", widget(separator), null, false, openOmoAsks(calls));
    for (const separator of [" - ", " \u2014 "]) {
      expect(read(actual, separator), separator).toMatchObject({ agent: "omo", title: "Plan -", options: [{ label: "Staging" }, { label: "Production" }] });
      // both calls fit the line, split at either separator: no card rather than the wrong one
      expect(read(`${actual}\n${decoy}`, separator), separator).toBeNull();
    }
    // a cut that leaves only one call's header still counts against the other call
    const cut = (separator: string) => screen.replace(/\? Question pending[^\n]*\n[^\n]*\n[^\n]*\n/,
      `? 2 questions pending · 30m\n  P - Deploy${separator}...\n[ Continue ]  [ Cancel ]  [ own answer\u2026 ]\n`);
    const cutActual = call("cut-actual", "P - Deploy", "Choose deployment target?", ["Continue", "Cancel"]);
    const cutDecoy = call("cut-decoy", "P", "Deploy - Choose another target?", ["Continue", "Cancel"]);
    // one column narrower, the cut also takes the separator's space
    for (const separator of [" - ", " \u2014 ", " -", " \u2014"]) {
      expect(parseInteractivePrompt("pi", cut(separator), null, false, openOmoAsks(`${cutActual}\n${cutDecoy}`)), separator).toBeNull();
    }
  });

  for (const count of ["one", "two"]) for (const width of ["wide", "narrow"]) {
    test(`reads the real 5.1.30 ${count}-question ${width} widget with extension status below the box`, () => {
      const open = openOmoAsks(omoPendingFixture(`${count}.jsonl`));
      const screen = withOmoExtensionTail(omoPendingFixture(`${count}-${width}.txt`));
      expect(parseInteractivePrompt("pi", screen, null, false, open)).toMatchObject({
        agent: "omo", kind: "question", question: open[0]!.questions[0]!.question,
      });
      expect(parseInteractivePrompt("pi", `${screen}$ echo after\n`, null, false, open)).toBeNull();
    });
  }

  for (const count of ["one", "two"]) for (const width of ["wide", "narrow"]) {
    test(`reads the real 5.1.30 ${count}-question ${width} widget with task rows below the box`, () => {
      const open = openOmoAsks(omoPendingFixture(`${count}.jsonl`));
      const screen = omoPendingFixture(`${count}-${width}.txt`).replace(/(❯\n─+\n)/, `$1${omoTaskRows}`);
      expect(screen).toContain(omoTaskRows);
      expect(parseInteractivePrompt("pi", screen, null, false, open)).toMatchObject({ agent: "omo", kind: "question" });
      expect(parseInteractivePrompt("pi", `${screen}$ echo after\n`, null, false, open)).toBeNull();
      expect(parseInteractivePrompt("pi", screen.replace(omoTaskRows, `${omoTaskRows}${" ordinary output\n".repeat(4)}`), null, false, open)).toBeNull();
    });
  }

  test("keeps a form dead under output that only looks like OmO task rows", () => {
    const open = openOmoAsks(omoPendingFixture("one.jsonl"));
    const screen = omoPendingFixture("one-wide.txt");
    const under = (rows: string) => parseInteractivePrompt("pi", screen.replace(/(❯\n─+\n)/, `$1${rows}`), null, false, open);
    const liveRow = omoTaskRows.split("\n")[0]!;
    expect(under(omoTaskRows)).not.toBeNull();
    // a spinner line without a task route is another program's output
    expect(under(" ⠦ compiling…\n")).toBeNull();
    // a shell prompt is never a task row, whatever follows it
    expect(under(" $ echo x|agent:explore background completed\n")).toBeNull();
    // two unknown lines and the native footer overflow the footer budget
    expect(under(`${liveRow}\n${" ordinary output\n".repeat(2)}`)).toBeNull();
    expect(under(`${liveRow}\n $ echo after\n`)).toBeNull();
  });

  test("reads an OmO waiting form with task rows under its rule", () => {
    const extended = first.replace(footer, footer.replace(`${rule}\n`, `${rule}\n${omoTaskRows}`));
    expect(parseInteractivePrompt("pi", extended)).toMatchObject({ agent: "omo", kind: "question", title: "Question 1 of 2" });
  });

  test("reads an OmO waiting form with extension status under its rule", () => {
    const extended = first.replace(footer, footer.replace(`${rule}\n`, `${rule}\n${omoExtensionTail}`));
    expect(parseInteractivePrompt("pi", extended)).toMatchObject({ agent: "omo", kind: "question", title: "Question 1 of 2" });
    expect(parseInteractivePrompt("pi", `${extended}user@host:~/project$ `)).toBeNull();
    expect(parseInteractivePrompt("pi", extended.replace(omoExtensionTail, `${omoExtensionTail} ordinary output\n`.repeat(4)))).toBeNull();
  });

  test("reads OmO typing and review forms with extension status under their rule", () => {
    const typing = form(` → 표시 위치    월 한도    Submit
 음성 사용량과 추정 비용을 어디에 보여줄까요?
 → 1. 설정 > 음성 입력 (추천)
   Type your own answer...
 Your answer (enter to save, ↑↓ back to options, esc to discard)
> 안녕
 Submit (0/2 answered) — Enter advances
 enter save and next  ↑↓ back to options  tab next question  esc discard
`);
    const review = form(`   표시 위치 ✓    월 한도 ✓  → Submit
 Review your answers
   표시 위치: 설정 > 음성 입력 (추천)
   월 한도: 한도 없음

 Comment (optional; unanswered questions are reported)
>
 Submit (2/2 answered)
 enter submit  ↑ review answers  shift+tab back  tab next question  esc back
`);
    for (const screen of [typing, review]) {
      const expected = parseInteractivePrompt("pi", screen);
      expect(expected).not.toBeNull();
      const extended = screen.replace(footer, footer.replace(`${rule}\n`, `${rule}\n${omoExtensionTail}`));
      expect(parseInteractivePrompt("pi", extended)).toEqual(expected);
      expect(parseInteractivePrompt("pi", `${extended}$ `)).toBeNull();
      // the same forms with OmO's task rows under the rule
      const withTasks = screen.replace(footer, footer.replace(`${rule}\n`, `${rule}\n${omoTaskRows}`));
      expect(parseInteractivePrompt("pi", withTasks)).toEqual(expected);
      expect(parseInteractivePrompt("pi", `${withTasks}$ `)).toBeNull();
    }
  });

  test("keeps a call asked without waiting open until it is settled", () => {
    expect(openOmoAsks(asyncAsking).map((ask) => [ask.questions[0]!.header, ask.wait])).toEqual([["표시 위치", false]]);
    expect(pendingOmoAsk(asyncAsking)?.questions).toHaveLength(2);
    const settlement = JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: "call-1", status: "answered" } });
    expect(openOmoAsks(`${asyncAsking}\n${settlement}`)).toEqual([]);
    expect(openOmoAsks(`${asyncAsking}\n${record({ role: "user", content: [{ type: "text", text: "[Answer to question call-1]\n표시 위치: 설정" }] })}`)).toEqual([]);
    // refused: the result is an error, and nothing is left open
    const refused = asyncAsking.replace(accepted("call-1"), record({ role: "toolResult", toolCallId: "call-1", content: [], details: {}, isError: true }));
    expect(openOmoAsks(refused)).toEqual([]);
  });

  // omo 5.1.19's widget for it at 120 columns, over its empty input box and its footer
  const widget = (box = "❯", after = "") => `● meanwhile

? Question pending (2 unanswered) · 30m
  표시 위치 — 음성 사용량과 추정 비용을 어디에 보여줄까요?
[ 설정 > 음성 입력 (추천) ]  [ 설정 + 사이드바 미터 ]  [ 상단 상태 표시줄 ]  [ 표시하지 않음 ]  [ own answer… ]
+1 more question
enter to answer · /answer · or just type your reply

 Todo
 [•] 사용량 표시
── • Running eval (3s • esc to interrupt) ${"─".repeat(80)}
${box}
${rule}${after}
~/work • main • 321K/1M (32.1%) (auto)                                         claude-opus-5-5:high
(😺 OmO Native) 🤖 2 mem just now
`;

  test("reads the widget of a question asked without waiting, by the session's open call", () => {
    const open = openOmoAsks(asyncAsking);
    // herdr may name the pane claude and report it at work: the session's open call is the evidence
    const prompt = parseInteractivePrompt("claude", widget(), null, false, open);
    expect(prompt).toMatchObject({
      agent: "omo", kind: "question", title: "Question 1 of 2", question: "음성 사용량과 추정 비용을 어디에 보여줄까요?",
      multi_select: false, custom_option_index: 4,
      steps: [{ label: "표시 위치", answered: false, current: true }, { label: "월 한도", answered: false, current: false }],
    });
    expect(labels(prompt)).toEqual(["설정 > 음성 입력 (추천)", "설정 + 사이드바 미터", "상단 상태 표시줄", "표시하지 않음"]);
    // a pending card validates answers but emits no steps until its form is opened and checked
    expect(answerKeys(prompt!, { option_index: 1 })).toEqual([]);
    expect(answerKeys(prompt!, { custom_text: "둘 다 보여줘" })).toEqual([]);
    for (const text of ["1", "2 please", "/answer", "!ls"]) expect(answerKeys(prompt!, { custom_text: text })).toEqual([]);
    // the second question, shown once the first has its answer
    const second = widget().replace("(2 unanswered)", "(1 unanswered)").replace(/  표시 위치 — .*\n\[.*\n\+1 more question\n/, "  월 한도 — 월 사용 한도를 둘까요?\n[ 한도 없음 ]  [ 월 $5 한도 ]  [ own answer… ]\n");
    expect(parseInteractivePrompt("claude", second, null, false, open)).toMatchObject({
      title: "Question 2 of 2", steps: [{ answered: true, current: false }, { answered: false, current: true }],
    });
  });

  test("no card for the widget without an open call, with text in the box, or with output under it", () => {
    const open = openOmoAsks(asyncAsking);
    expect(parseInteractivePrompt("claude", widget(), null, false, [])).toBeNull();
    // a call that waits has its form, never this widget
    expect(parseInteractivePrompt("claude", widget(), null, false, openOmoAsks(asking))).toBeNull();
    // a number typed now would join the text
    expect(parseInteractivePrompt("claude", widget("❯ 둘 다"), null, false, open)).toBeNull();
    expect(parseInteractivePrompt("claude", widget("❯", "\n$ echo after"), null, false, open)).toBeNull();
    expect(parseInteractivePrompt("claude", `${widget()}$ \n`, null, false, open)).toBeNull();
    expect(parseInteractivePrompt("claude", `${widget()}λ \n`, null, false, open)).toBeNull();
  });
});

describe("Claude's suggested next prompt", () => {
  // Claude Code 2.1.284 as herdr reads it with ANSI: the grey suggestion in the empty input box
  const RULE = "\u001b[0m\u001b[38;2;136;136;136m" + "─".repeat(60) + "\u001b[0m";
  const screen = (input: string, below = RULE) => [
    "\u001b[0m\u001b[38;2;255;255;255m● \u001b[0m표본 수집이 끝나면 알림이 오도록 걸어 두었습니다.",
    "",
    "\u001b[0m\u001b[38;2;153;153;153m✻ Worked for 2m 14s · done 오후 4:16\u001b[0m",
    RULE,
    input,
    below,
    "  \u001b[0m\u001b[38;5;6m[Opus 5.5 (1M context)]\u001b[0m\u001b[38;2;153;153;153m │ \u001b[0m\u001b[2m\u001b[38;2;153;153;153m⏱️  25h\u001b[0m",
    "  \u001b[0m\u001b[38;2;255;107;128m⏵⏵ bypass permissions on\u001b[0m",
  ].join("\r\n");

  test("reads the grey text in the empty input box", () => {
    expect(parseClaudeSuggestion(screen("❯\u00a0\u001b[0m\u001b[2m아직 진행중이야?\u001b[0m"))).toBe("아직 진행중이야?");
    // dim set together with a color, in one sequence
    expect(parseClaudeSuggestion(screen("❯ \u001b[2;38;5;8mrun the tests again\u001b[0m"))).toBe("run the tests again");
  });

  test("nothing while text is typed, the box is empty, or it holds Claude's tip", () => {
    expect(parseClaudeSuggestion(screen("❯\u00a0아직 진행중이야?"))).toBeNull();
    // typed text right after a grey remainder is still typed
    expect(parseClaudeSuggestion(screen("❯ \u001b[2m아직\u001b[0m 진행중"))).toBeNull();
    expect(parseClaudeSuggestion(screen("❯\u00a0"))).toBeNull();
    expect(parseClaudeSuggestion(screen('❯ \u001b[2mTry "how does <filepath> work?"\u001b[0m'))).toBeNull();
  });

  test("a truecolor foreground is not dim: its 2 is the color mode", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[38;2;153;153;153mnot a suggestion\u001b[0m"))).toBeNull();
  });

  test("only the input box: not a ❯ line without its rules, nor a box of several lines", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[2mfirst line\u001b[0m", "  \u001b[2msecond line\u001b[0m"))).toBeNull();
    expect(parseClaudeSuggestion("❯ \u001b[2mloose text\u001b[0m\nmore")).toBeNull();
  });

  test("only the live input box, the bottom one: not an earlier box above a bash-mode input", () => {
    const below = RULE + "\r\n\u001b[38;2;255;255;255m● quoted output\u001b[0m\r\n" + RULE + "\r\n! ls\r\n" + RULE;
    expect(parseClaudeSuggestion(screen("❯ \u001b[2mrun deploy --prod\u001b[0m", below))).toBeNull();
  });

  test("Claude's own drawn cursor on the first grey character", () => {
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27m\u001b[2mun the tests\u001b[22m"))).toBe("run the tests");
    // a typed character under that cursor, with nothing grey after it, is typed
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27m"))).toBeNull();
    expect(parseClaudeSuggestion(screen("❯ \u001b[7mr\u001b[27mun"))).toBeNull();
  });

  test("a draft typed in the input box is the user's: Claude's grey text, its tip, its cursor and an empty box are not", () => {
    // the live screen as a detection read gives it, without colors, and the viewport's ANSI read of the same screen
    const draft = (ansi: string, live = ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")) => claudeInputDraft(live, ansi);
    expect(draft(screen("❯\u00a0아직 진행중이야?"))).toBe(true);
    expect(draft(screen("❯ \u001b[2m아직\u001b[0m 진행중"))).toBe(true);
    expect(draft(screen("❯ \u001b[7mr\u001b[27mun"))).toBe(true);
    expect(draft(screen("❯ \u001b[7mr\u001b[27m"))).toBe(true);
    // a draft of several lines fills the box down to its rule
    expect(draft(screen("❯ first line", "  second line\r\n" + RULE))).toBe(true);
    expect(draft(screen("❯\u00a0\u001b[0m\u001b[2m아직 진행중이야?\u001b[0m"))).toBe(false);
    expect(draft(screen("❯ \u001b[7mr\u001b[27m\u001b[2mun the tests\u001b[22m"))).toBe(false);
    expect(draft(screen('❯ \u001b[2mTry "how does <filepath> work?"\u001b[0m'))).toBe(false);
    // grey text wrapped over two rows is still Claude's own
    expect(draft(screen("❯ \u001b[2mfirst grey row\u001b[0m", "  \u001b[2msecond grey row\u001b[0m\r\n" + RULE))).toBe(false);
    expect(draft(screen("❯\u00a0"))).toBe(false);
    expect(draft(screen("❯ \u001b[7m \u001b[27m"))).toBe(false);
    // a paste or an image Claude folded into a placeholder is content, dim or not
    expect(draft(screen("❯ \u001b[2m[Pasted text #1 +12 lines]\u001b[0m"))).toBe(true);
    expect(draft(screen("❯ \u001b[2m[Image #1]\u001b[0m"))).toBe(true);
    // a named session labels its rule
    expect(draft(screen("❯ typed", "──── my-session ─"))).toBe(true);
    // no rule on screen says nothing
    expect(draft("❯ loose text\nmore")).toBe(false);
  });

  test("Claude's tip drawn without colors (NO_COLOR, #926) is no draft; other plain words are", () => {
    // Claude Code 2.1.296 under NO_COLOR=1: an empty input box, no SGR color or dim anywhere
    const plainRule = "\u2500".repeat(60);
    const colorless = (row: string) => ["", plainRule, row, plainRule, "  \u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents"].join("\r\n");
    const strip = (ansi: string) => ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const tip = colorless('\u276f Try "how does <filepath> work?"');
    expect(claudeInputDraft(strip(tip), tip)).toBe(false);
    expect(claudeInputEmpty(strip(tip), tip)).toBe(true);
    expect(claudeClearableDraft(strip(tip), tip)).toBeNull();
    // Claude's drawn cursor on its first character
    const cursor = colorless('\u276f \u001b[7mT\u001b[27mry "how does <filepath> work?"');
    expect(claudeInputDraft(strip(cursor), cursor)).toBe(false);
    // typed words that are not the tip's whole form stay a draft
    for (const typed of ['\u276f Try this instead', '\u276f Try "x" and more', '\u276f please Try "x"']) {
      expect(claudeInputDraft(strip(colorless(typed)), colorless(typed))).toBe(true);
    }
    // on a colored screen only dim tells the tip: typed `Try "\u2026"` there is a draft
    expect(claudeInputDraft(strip(screen('\u276f Try "x"')), screen('\u276f Try "x"'))).toBe(true);
    // colors not verified to show the live screen prove nothing
    expect(claudeInputDraft(strip(tip), null)).toBe(true);
  });

  test("Claude's IDE pill after the ❯ is no draft and hides no suggestion (#1096)", () => {
    // Claude Code 2.1.302, from its bundle (not a captured screen): with an editor connected the input's
    // leading pill `[⧉ N lines selected] ` or `[⧉ In <file>] ` is painted in the theme's IDE color, not
    // dim, before the placeholder (its first character inverse, the rest dim)
    const strip = (ansi: string) => ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const pill = (label: string) => `\u001b[38;2;71;130;200m[⧉ ${label}] \u001b[39m`;
    const grey = (text: string) => `\u001b[7m${text[0]}\u001b[27m\u001b[2m${text.slice(1)}\u001b[22m`;
    const read = (row: string) => {
      const ansi = screen(row);
      const live = strip(ansi);
      return { draft: claudeInputDraft(live, ansi), empty: claudeInputEmpty(live, ansi), clearable: claudeClearableDraft(live, ansi) };
    };
    const empty = { draft: false, empty: true, clearable: null };
    expect(read(`❯ ${pill("1 line selected")}${grey('Try "refactor this function"')}`)).toEqual(empty);
    expect(read(`❯ ${pill("In src/foo.ts")}${grey('Try "refactor this function"')}`)).toEqual(empty);
    expect(read(`❯ ${pill("1 line selected")}\u001b[7m \u001b[27m`)).toEqual(empty);
    expect(read(`❯ ${pill("12 lines selected")}`)).toEqual(empty);
    expect(read(`❯ ${grey('Try "refactor this function"')}`)).toEqual(empty);
    // a pill alone needs no colors to read as empty
    expect(claudeInputDraft(strip(screen(`❯ ${pill("12 lines selected")}`)), null)).toBe(false);
    // typed text after the pill is a draft, offered for clearing without the pill
    expect(read(`❯ ${pill("1 line selected")}hello there\u001b[7m \u001b[27m`)).toEqual({ draft: true, empty: false, clearable: "hello there " });
    expect(read(`❯ ${pill("In src/foo.ts")}\u001b[7mr\u001b[27mun`)).toEqual({ draft: true, empty: false, clearable: "run" });
    // Claude's suggestion after the pill is still offered, its tip still is not
    expect(parseClaudeSuggestion(screen(`❯ ${pill("3 lines selected")}${grey("run the tests again")}`))).toBe("run the tests again");
    expect(parseClaudeSuggestion(screen(`❯ ${pill("3 lines selected")}${grey('Try "refactor this function"')}`))).toBeNull();
    expect(parseClaudeSuggestion(screen(`❯ ${pill("3 lines selected")}typed`))).toBeNull();
    // the chat's own message restored after the pill is that message
    const restored = screen(`❯ ${pill("1 line selected")}run the tests`);
    expect(claudeRestoredDraft(strip(restored), restored, "run the tests")).toBe("run the tests");
    // drawn without colors (NO_COLOR): the pill and the tip after it are no draft, typed words are
    const plainRule = "\u2500".repeat(60);
    const colorless = (row: string) => ["", plainRule, row, plainRule, "  \u23f5\u23f5 auto mode on (shift+tab to cycle)"].join("\r\n");
    const tip = colorless('❯ [⧉ 1 line selected] \u001b[7mT\u001b[27mry "refactor this function"');
    expect(claudeInputDraft(strip(tip), tip)).toBe(false);
    expect(claudeInputEmpty(strip(tip), tip)).toBe(true);
    const typed = colorless("❯ [⧉ 1 line selected] Try this instead");
    expect(claudeInputDraft(strip(typed), typed)).toBe(true);
    expect(claudeClearableDraft(strip(typed), typed)).toBe("Try this instead");
  });

  test("OmO's box while it works, under a rule its status labels, is read like Claude's", () => {
    // OmO (reported by herdr as Claude) as it draws its box mid-turn: two dashes lead the label
    const rule = "\u2500".repeat(60);
    const working = (row: string) => ["● earlier output", "\u2500\u2500 • Running eval (7s • esc to interrupt) " + "\u2500".repeat(40), row, rule,
      "~/workspace/app • main • 27.1% (auto)   claude-opus-5-5:medium"].join("\r\n");
    expect(claudeInputDraft(working("❯"), null)).toBe(false);
    expect(claudeInputEmpty(working("❯"), null)).toBe(true);
    expect(claudeInputDraft(working("❯ still typing"), null)).toBe(true);
    expect(claudeInputBoxText(working("❯ still typing"))).toBe("❯ still typing");
    // a row with one dash before its words is no rule
    expect(claudeInputDraft(["─ not a rule ─", "❯", rule].join("\r\n"), null)).toBe(true);
  });

  test("the box a refusal shows: its rows as plain text, nothing when it cannot be read whole", () => {
    const rule = "\u2500".repeat(60);
    expect(claudeInputBoxText([rule, "\u001b[2m! ls\u001b[0m", rule].join("\r\n"))).toBe("! ls");
    expect(claudeInputBoxText([rule, "❯ first line", "  second line", rule].join("\r\n"))).toBe("❯ first line\n  second line");
    expect(claudeInputBoxText(["  more of a tall draft", rule, "  footer"].join("\r\n"))).toBe("");
    expect(claudeInputBoxText("no box here")).toBe("");
    expect(claudeInputBoxText([rule, `❯ ${"x".repeat(300)}`, rule].join("\r\n"))).toBe(`❯ ${"x".repeat(198)}…`);
  });

  test("a viewport's colors count only when it is verified to show the live screen", () => {
    const live = screen("❯ \u001b[2mrun the tests\u001b[0m").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const colors = screen("❯ \u001b[2mrun the tests\u001b[0m");
    const bottom = { offset_from_bottom: 0 };
    expect(viewportShowsLive(bottom, bottom, colors, live, live)).toBe(true);
    // scrolled before or after the colored read
    expect(viewportShowsLive({ offset_from_bottom: 12 }, bottom, colors, live, live)).toBe(false);
    expect(viewportShowsLive(bottom, { offset_from_bottom: 3 }, colors, live, live)).toBe(false);
    // a scroll known for one read only is no proof, whatever the text says
    expect(viewportShowsLive({ offset_from_bottom: 12 }, null, colors, live, live)).toBe(false);
    expect(viewportShowsLive(null, { offset_from_bottom: 12 }, colors, live, live)).toBe(false);
    expect(viewportShowsLive(bottom, null, colors, live, live)).toBe(false);
    // no scroll from herdr at all: the viewport's whole text must be the live screen's
    expect(viewportShowsLive(null, null, colors, live, live)).toBe(true);
    expect(viewportShowsLive(null, null, "● older output\r\n" + colors, live, live)).toBe(false);
    // the live screen changed across the colored read
    expect(viewportShowsLive(bottom, bottom, colors, live.replace("run the tests", "run the test"), live)).toBe(false);
  });

  test("the history's last rows lend their colors only when they are the unchanged live screen, colors included", () => {
    const live = screen("❯ \u001b[2mrun the tests\u001b[0m").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    const colors = screen("❯ \u001b[2mrun the tests\u001b[0m");
    expect(historyEndShowsLive(colors, colors, [live, live])).toBe(true);
    // other rows than the live screen's (a resize between the reads, an older box)
    expect(historyEndShowsLive("● older output\r\n" + colors, "● older output\r\n" + colors, [live, live])).toBe(false);
    // the live screen changed across the colored reads, before or after them
    const changed = live.replace("run the tests", "run the test");
    expect(historyEndShowsLive(colors, colors, [changed, live])).toBe(false);
    expect(historyEndShowsLive(colors, colors, [live, changed])).toBe(false);
    expect(historyEndShowsLive(colors, colors, [])).toBe(false);
    // the suggestion accepted with Tab between the colored reads: the same words, typed now
    const typed = screen("❯ run the tests");
    expect(historyEndShowsLive(colors, typed, [live, live])).toBe(false);
    expect(historyEndShowsLive(typed, colors, [live, live])).toBe(false);
    // a read with no color at all (NO_COLOR): its tip and the same words typed read the same
    expect(historyEndShowsLive(live, live, [live, live])).toBe(false);
  });

  test("bash mode, a box clipped by the pane, or a viewport that is not the live box hold a pending message", () => {
    const draft = (ansi: string, live = ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")) => claudeInputDraft(live, ansi);
    // the Enter after a paste would run it as a command
    expect(draft(screen("! "))).toBe(true);
    expect(draft(screen("! echo unfinished"))).toBe(true);
    // a draft taller than the pane: its top rule and `❯` row are above the screen
    expect(draft(["  more of the draft", "  its last line", RULE, "  footer"].join("\r\n"))).toBe(true);
    // the viewport scrolled into the history shows no box, or another one: only the live box counts
    const live = screen("❯\u00a0half typed").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(claudeInputDraft(live, "\u001b[0m● earlier output\r\n" + "more of it")).toBe(true);
    expect(claudeInputDraft(live, screen("❯ \u001b[2mhalf typed\u001b[0m".replace("half typed", "an old suggestion")))).toBe(true);
    // colors not verified to show the live screen (null) say nothing: a box that is not empty holds,
    // also one whose words are Claude's grey suggestion; an empty one does not
    const grey = screen("❯ \u001b[2mrun the tests\u001b[0m");
    expect(claudeInputDraft(grey.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""), null)).toBe(true);
    expect(claudeInputDraft(screen("❯\u00a0").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""), null)).toBe(false);
    // an empty live box sends, whatever an older box in the scrolled viewport held
    const empty = screen("❯\u00a0").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(claudeInputDraft(empty, screen("❯ an old draft"))).toBe(false);
  });

  test("keeps every typed space in the draft offered for clearing", () => {
    const live = screen("❯  hello ");
    expect(claudeClearableDraft(live, live)).toBe(" hello ");
    const nonbreaking = screen("❯\u00a0hello\u00a0");
    expect(claudeClearableDraft(nonbreaking, nonbreaking)).toBe("hello\u00a0");
  });

  test("offers no clearing when the live row gained a space after its color read", () => {
    expect(claudeClearableDraft(screen("❯ hello "), screen("❯ hello"))).toBeNull();
  });

  test("the chat offers to clear only a typed draft on the box's one row, read with verified colors", () => {
    const clearable = (ansi: string, live = ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")) => claudeClearableDraft(live, ansi);
    expect(clearable(screen("❯ ㅔ"))).toBe("ㅔ");
    expect(clearable(screen("❯ half typed "))).toBe("half typed ");
    // Claude's drawn cursor sits on a typed character too
    expect(clearable(screen("❯ \u001b[7mr\u001b[27mun"))).toBe("run");
    // Claude's own grey text and an empty box are no draft
    expect(clearable(screen("❯ \u001b[2mrun the tests\u001b[0m"))).toBeNull();
    expect(clearable(screen("❯ "))).toBeNull();
    // ctrl+k and ctrl+u edit one screen row: a draft on two, wrapped or not, stays the user's to clear
    expect(clearable(screen("❯ first line", "  second line\r\n" + RULE))).toBeNull();
    // bash mode takes a Backspace of its own, and a placeholder stands for more than it shows
    expect(clearable(screen("! echo unfinished"))).toBeNull();
    expect(clearable(screen("❯ [Pasted text #1 +12 lines]"))).toBeNull();
    // a box clipped by the pane, or colors not verified to show the live screen
    expect(clearable(["  more of the draft", RULE, "  footer"].join("\r\n"))).toBeNull();
    expect(claudeClearableDraft(screen("❯ half typed").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""), null)).toBeNull();
  });

  test("a box holding the chat's own last message is Claude's restored copy, everything else is not", () => {
    const restored = (ansi: string, sent: string | null, live = ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")) => claudeRestoredDraft(live, ansi, sent);
    // the copy Claude puts back on a cancel is typed text: the same words, whitespace aside
    expect(restored(screen("❯ run the tests"), "run the tests")).toBe("run the tests");
    expect(restored(screen("❯\u00a0run\u00a0the\u00a0tests"), "run the tests")).toBe("run the tests");
    // a long message wraps onto rows indented two spaces; joined back they are the sent text
    expect(restored(screen("❯ a longer message that wrapped onto", "  its second row\r\n" + RULE), "a longer message that wrapped onto its second row")).toBe("a longer message that wrapped onto its second row");
    // a wrap inside a word joins its rows with nothing between them
    expect(restored(screen("❯ a longer message that wrapped in its mid", "  dle word\r\n" + RULE), "a longer message that wrapped in its middle word")).toBe("a longer message that wrapped in its middle word");
    // typed on or replaced, the words are the user's
    expect(restored(screen("❯ run the tests edited"), "run the tests")).toBeNull();
    // a box of many blank rows against a near miss is answered at once, never by backtracking over them
    const started = performance.now();
    expect(restored(screen("\u276f x", "\r\n".repeat(30) + RULE), `x${" ".repeat(30)}y`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
    // so are spaces taken out or put in: two Esc presses would erase that edit
    expect(restored(screen("❯ runthe tests"), "run the tests")).toBeNull();
    expect(restored(screen("❯ run  the tests"), "run the tests")).toBeNull();
    expect(restored(screen("❯ other words"), "run the tests")).toBeNull();
    // Claude's grey suggestion is not a draft, an empty box holds nothing, bash mode is the user's
    expect(restored(screen("❯ \u001b[2mrun the tests\u001b[0m"), "run the tests")).toBeNull();
    expect(restored(screen("❯\u00a0"), "run the tests")).toBeNull();
    expect(restored(screen("! run the tests"), "run the tests")).toBeNull();
    // a paste Claude folded into a placeholder is content, whatever it reads as
    expect(restored(screen("❯ [Pasted text #1 +12 lines]"), "[Pasted text #1 +12 lines]")).toBeNull();
    // colors not verified to show the live screen, or no chat send before, say nothing
    const live = screen("❯ run the tests").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    expect(claudeRestoredDraft(live, null, "run the tests")).toBeNull();
    expect(restored(screen("❯ run the tests"), null)).toBeNull();
    expect(restored(screen("❯ run the tests"), "  ")).toBeNull();
  });

  test("remembers what the chat last sent a pane", () => {
    noteSubmitted("p_sent", "run the tests");
    expect(lastChatSubmitted("p_sent")).toBe("run the tests");
    expect(lastChatSubmitted("p_nothing")).toBeNull();
    noteSubmitted("p_sent", "another");
    expect(lastChatSubmitted("p_sent")).toBe("another");
  });
});

describe("the fallback card for a blocked pane no reader knows", () => {
  test("offers a numbered menu at the screen's end as options answered by their number", () => {
    const prompt = parseFallbackPrompt("gjc", `
 Apply these 3 file changes?
 src/a.ts, src/b.ts, src/c.ts

 › 1. Apply all
   2. Review each
   3. Discard

 ↵ choose · esc back
`);
    expect(prompt.kind).toBe("menu");
    expect(prompt.fallback).toBe(true);
    expect(prompt.question).toBe("Apply these 3 file changes?");
    expect(prompt.body).toBe("src/a.ts, src/b.ts, src/c.ts");
    expect(labels(prompt)).toEqual(["Apply all", "Review each", "Discard", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ text: "3" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "1" }]);
    expect(() => answerKeys(prompt, { custom_text: "no" })).toThrow();
  });

  test("offers Enter and Esc after the rows, for a program that reads a whole line", () => {
    const prompt = parseFallbackPrompt("gjc", "Pick a profile:\n1. Work\n2. Home\n\nEnter a number >\n");
    expect(labels(prompt)).toEqual(["Work", "Home", "Enter", "Esc"]);
    // the number goes alone; the Enter that submits it is its own tap
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["esc"] }]);
  });

  test("reads GJC's unnumbered selection rows and answers with cursor navigation", () => {
    // gjc v0.18.7's custom-provider selector: active row uses the navigation cursor, other rows
    // start with two spaces, and the footer names Up/Down, Enter, and Esc.
    const compatibility = (selected: 0 | 1) => `
Step 1: Compatibility

${selected === 0 ? "❯" : " "} OpenAI-compatible
${selected === 1 ? "❯" : " "} Anthropic-compatible
[↑↓ to navigate, Enter to select, Esc to cancel]
`;
    const prompt = parseFallbackPrompt("gjc", compatibility(0));
    expect(prompt.kind).toBe("menu");
    expect(prompt.fallback).toBe(true);
    expect(labels(prompt)).toEqual(["OpenAI-compatible", "Anthropic-compatible", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["esc"] }]);
    expect(parseFallbackPrompt("gjc", compatibility(1)).id).toBe(prompt.id);
    expect(parseFallbackPrompt("gjc", compatibility(1).replace("Anthropic-compatible", "Local endpoint")).id).not.toBe(prompt.id);

    const selectedSecond = parseFallbackPrompt("gjc", `
Step 4: Credential source

  Environment variable
❯ Paste API key
[↑↓ to navigate, Enter to select, Esc to go back]
`);
    expect(labels(selectedSecond)).toEqual(["Environment variable", "Paste API key", "Esc"]);
    expect(answerKeys(selectedSecond, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("reads GJC's standard and outlined question selectors", () => {
    for (const footer of [
      "up/down navigate  enter select  esc cancel",
      "up/down navigate  enter select  ←/→ question  esc cancel",
      "↑/↓ select  enter  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript",
      "↑/↓ select  enter  ←/→ question  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript",
    ]) {
      const screen = `Choose an approach\n\n──────────────\n│❯ First     │\n│  Second    │\n──────────────\n\n${footer}\n\n──────────────\n`;
      const prompt = parseFallbackPrompt("gjc", screen);
      expect(labels(prompt)).toEqual(["First", "Second", "Esc"]);
      expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
      expect(labels(parseFallbackPrompt("gjc", screen.replace("│  Second    │", "│  (1/12)    │")))).not.toContain("First");
      expect(labels(parseFallbackPrompt("gjc", `${screen}\n❯ message input\n`))).not.toContain("First");
    }
  });

  test("reads GJC Nerd Font question cursors without exposing transcript summaries as choices", () => {
    const dialog = `──────────────

Use read-only checks.

Which approach?

──────────────
│ Inspect now (Recommended) │
│  Clarify scope first       │
│  Other (type your own)     │
──────────────

 ↑/↓ select  enter  esc  PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript

──────────────
`;
    const screen = `Earlier question summary\n├─  Inspect now\n└─  Clarify scope first\n\nWorking…\n${dialog}`;
    const prompt = parseFallbackPrompt("gjc", screen);
    expect(labels(prompt)).toEqual(["Inspect now (Recommended)", "Clarify scope first", "Other (type your own)", "Esc"]);
    expect(prompt.question).toBe("Which approach?");
    expect(prompt.body).toBe("Use read-only checks.");
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    const moved = parseFallbackPrompt("gjc", screen.replace("│ Inspect", "│  Inspect").replace("│  Clarify", "│ Clarify"));
    expect(moved.id).toBe(prompt.id);
    expect(answerKeys(moved, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(labels(parseFallbackPrompt("claude", screen))).toEqual(["↑", "↓", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", screen.replace("│ Inspect", "│  Inspect")))).toEqual(["↑", "↓", "Enter", "Esc"]);
  });

  test("does not infer GJC choices without the exact footer, a selected row, or the GJC agent", () => {
    const footer = "[↑↓ to navigate, Enter to select, Esc to cancel]";
    const generic = ["↑", "↓", "Enter", "Esc"];
    expect(labels(parseFallbackPrompt("gjc", `Pick one:\n\nAlpha\nBeta\n${footer}\n`))).toEqual(generic);
    expect(labels(parseFallbackPrompt("gjc", `Pick one:\n❯ Alpha\n  Beta\n${footer}\n`))).toEqual(generic);
    expect(labels(parseFallbackPrompt("gjc", `Pick one:\n❯ Alpha\n  Beta\n↑/↓ to move · Enter to choose · Esc to cancel\n`))).toEqual(generic);
    expect(labels(parseFallbackPrompt("claude", `Pick one:\n\n❯ Alpha\n  Beta\n${footer}\n`))).toEqual(generic);
  });

  test("hashes a framed GJC question without the transcript or ticking status above it", () => {
    const dialog = "──────────────\n\nUse staging only.\n\nWhich approach?\n\n──────────────\n│❯ First     │\n│  Second    │\n──────────────\n\nup/down navigate  enter select  esc cancel\n\n──────────────\n";
    const first = parseFallbackPrompt("gjc", `Earlier output\n◷ 12h23m\n${dialog}`);
    const later = parseFallbackPrompt("gjc", `New output\n◷ 12h24m\n${dialog}`);
    expect(later.id).toBe(first.id);
    expect(first.question).toBe("Which approach?");
    expect(first.body).toBe("Use staging only.");
    expect(parseFallbackPrompt("gjc", dialog.replace("Use staging only.", "Use production.")).id).not.toBe(first.id);
    expect(parseFallbackPrompt("gjc", dialog.replace("Which approach?", "Delete everything?")).id).not.toBe(first.id);
    expect(parseFallbackPrompt("gjc", dialog.replace("Second", "Remove")).id).not.toBe(first.id);
    expect(parseFallbackPrompt("gjc", dialog.replace("│❯ First     │", "│  First     │").replace("│  Second    │", "│❯ Second    │")).id).toBe(first.id);
  });

  test("keeps approval details above a padded Markdown rule in a framed GJC title", () => {
    const dialog = (target: string) => `──────────────\n\n Delete ${target}.\n\n ────────── \n\n Proceed?\n\n❯ Yes\n  No\n\nup/down navigate  enter select  esc cancel\n\n──────────────\n`;
    const staging = parseFallbackPrompt("gjc", dialog("staging"));
    expect(staging.body).toBe("Delete staging.");
    expect(parseFallbackPrompt("gjc", dialog("production")).id).not.toBe(staging.id);
  });

  test("keeps the full GJC screen when a matching outer frame is absent", () => {
    for (const close of ["", "────"]) {
      const screen = (target: string) => `Delete ${target}.\n──────────────\n\nProceed?\n\n❯ Yes\n  No\n\nup/down navigate  enter select  esc cancel\n\n${close}\n`;
      expect(parseFallbackPrompt("gjc", screen("production")).id).not.toBe(parseFallbackPrompt("gjc", screen("staging")).id);
    }
  });

  test("titles a GJC selector with its own heading, not an earlier question on the screen", () => {
    const prompt = parseFallbackPrompt("gjc", "Delete your project?\nDone, it is kept.\n\nChoose a provider\n\n❯ Alpha\n  Beta\n[↑↓ to navigate, Enter to select, Esc to cancel]\n");
    expect(prompt.question).toBe("Choose a provider");
    expect(labels(prompt)).toEqual(["Alpha", "Beta", "Esc"]);
    expect(parseFallbackPrompt("gjc", "Earlier text\n\nWhich one?\nPick the safe one\n\n❯ Alpha\n  Beta\n[↑↓ to navigate, Enter to select, Esc to cancel]\n").question).toBe("Which one?");
  });

  test("answers a GJC selector whose labels start with numbers by moving, never by typing a number", () => {
    const prompt = parseFallbackPrompt("gjc", "Choose an approach\n\n❯ 1. Keep branch\n  2. Delete branch\nup/down navigate  enter select  esc cancel\n");
    expect(labels(prompt)).toEqual(["1. Keep branch", "2. Delete branch", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("joins the lines the last row wraps onto into its label", () => {
    const prompt = parseFallbackPrompt("gjc", "Trust this folder?\n\n❯ 1. No, exit\n  2. Yes, trust folder and\n     allow all commands without asking\n\n Enter to confirm\n");
    expect(labels(prompt)).toEqual(["No, exit", "Yes, trust folder and allow all commands without asking", "Enter", "Esc"]);
  });

  test("reads no menu when the last row's wrapped label ends in its own letter key", () => {
    const prompt = parseFallbackPrompt("gjc", "Access?\n1. Read only\n2. Full access, every file and\n   command (f)\n\nEnter to select\n");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
    // or ends the row's first line, a description wrapped under it
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Cancel\n2. Full access (f)\n   Allows writing to every file\n\nType f, then Enter\n"))).toEqual(["Enter", "Esc"]);
  });

  test("takes the last line for a hint only when it names a way to choose", () => {
    const menu = (hint: string) => labels(parseFallbackPrompt("gjc", `Pick one:\n1. Alpha\n2. Beta\n\n${hint}\n`));
    // a plain Enter or Press asks for something else: a digit typed there is no answer
    for (const hint of ["Enter recovery code", "Enter your password", "Enter your phone number", "Press any key", "Enter to continue"]) {
      expect(menu(hint)).toEqual(["Enter", "Esc"]);
    }
    expect(labels(parseFallbackPrompt("gjc", "1. A\n2. B\nEnter recovery code\n"))).toEqual(["Enter", "Esc"]);
    for (const hint of ["Enter to select", "↵ choose · esc back", "Enter to confirm · Esc to cancel", "Enter a number", "Type 1-2", "↑/↓ to move", "Tab/arrows to navigate"]) {
      expect(menu(hint)).toEqual(["Alpha", "Beta", "Enter", "Esc"]);
    }
  });

  test("reads no menu unless its hint is the screen's last line, with only the last row's wrap above it", () => {
    // a new prompt under the hint takes what is typed now: a digit there is no menu answer
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. Read only\n2. Full access\nEnter to select\nEnter recovery code ABCD\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. Read only\n2. Full access\n\nEnter to select\nWaiting for the token\n"))).toEqual(["Enter", "Esc"]);
    // a line under the last row, not indented past its number, is not its wrap
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n  1. Read only\n  2. Full access\n  Saved.\nEnter to select\n"))).toEqual(["Enter", "Esc"]);
    // nor a hint inside the last row's wrap, with a new prompt under it
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Read settings\n2. Load profiles\n   Profiles loaded\n   Enter to continue\nEnter recovery code ABCD\n"))).toEqual(["Enter", "Esc"]);
    // nor an input field there, or more output than a wrapped label
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Load configuration\n2. Connect to account\n   Authentication required\n   Password:\nEnter password and press Enter\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Done:\n1. Load configuration\n2. Connect to account\n   Connected to example.com\n   Authentication required\n   Waiting\nEnter to continue\n"))).toEqual(["Enter", "Esc"]);
    // a wrapped label's own words are no hint
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Cancel\n2. Allow access to the\n   selected account number only\n\nEnter to select\n"))).toEqual(["Cancel", "Allow access to the selected account number only", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Where?\n1. Here\n2. Allow the agent to\n   choose a directory\n\nEnter to select\n"))).toEqual(["Here", "Allow the agent to choose a directory", "Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Retry?\n1. Never\n2. Retry with a maximum\n   attempt count: 3\n\nEnter to select\n"))).toEqual(["Never", "Retry with a maximum attempt count: 3", "Enter", "Esc"]);
    // a hint right under the last row, indented like its wrap, is still the hint
    expect(labels(parseFallbackPrompt("gjc", "Pick a profile:\n1. Work\n2. Home\n   Enter a number >\n"))).toEqual(["Work", "Home", "Enter", "Esc"]);
  });

  test("keeps a wrapped label on its own row, since each row starts with its number", () => {
    const prompt = parseFallbackPrompt("gjc", "Trust this folder?\n\n❯ 1. No, exit and keep this folder\n     untrusted\n  2. Yes, trust folder\n  3. Yes, trust and allow hooks\n\n Enter to confirm\n");
    expect(labels(prompt)).toEqual(["No, exit and keep this folder untrusted", "Yes, trust folder", "Yes, trust and allow hooks", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "2" }]);
  });

  test("guesses no options for an unnumbered menu, offering the keys its hint names", () => {
    const prompt = parseFallbackPrompt("claude", "Continue?\n\n  Yes\n❯ No\n  Later\n\n ↑/↓ to move · Enter to choose\n");
    expect(prompt.title).toBe("Waiting for input");
    expect(prompt.question).toBe("Continue?");
    expect(labels(prompt)).toEqual(["↑", "↓", "Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }]);
  });

  test("reads no menu once a new prompt or input box follows it", () => {
    const done = parseFallbackPrompt("claude", "Pick one\n\n  1. Deny\n❯ 2. Allow\n\n● Done.\n❯ \n");
    expect(labels(done)).toEqual(["Enter", "Esc"]);
    const quoted = parseFallbackPrompt("claude", "> quoted example\n❯ Deny\n  Allow all\n");
    expect(labels(quoted)).toEqual(["Enter", "Esc"]);
  });

  test("reads a numbered list as no menu without a hint to choose, or before an input field", () => {
    expect(labels(parseFallbackPrompt("gjc", "My plan:\n\n1. Inspect files\n2. Remove backups\n\nPassword:\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick:\n1. A\n2. B\nEnter a number\nChoice: 2\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Access?\n1. Read only (r)\n2. Full access (f)\nType r or f, then Enter\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("gjc", "Pick\n1. One\n❯ \n2. Two\nEnter to select\n"))).toEqual(["Enter", "Esc"]);
  });

  test("offers no letters or arrows for an input box, a quote or a word", () => {
    expect(labels(parseFallbackPrompt("claude", 'The installer prints "Overwrite? (y/n)".\n❯ \n'))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("claude", "Done.\n❯ Explain why the installer asks (y/n)\n"))).toEqual(["Enter", "Esc"]);
    expect(labels(parseFallbackPrompt("claude", "Use arrow functions in the patch.\nArrowhead metadata loaded\n"))).toEqual(["Enter", "Esc"]);
  });

  test("without a menu, shows the screen's last lines and offers Enter and Esc", () => {
    const prompt = parseFallbackPrompt("codex", "Working on it\n\nPress any key to review the diff (q to quit)\n");
    expect(prompt.title).toBe("Waiting for input");
    expect(prompt.question).toBe("Press any key to review the diff (q to quit)");
    expect(prompt.body).toContain("Working on it");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["esc"] }]);
  });

  test("offers a (y/n) question at the screen's end as Yes and No, typing the letter alone", () => {
    const prompt = parseFallbackPrompt("gjc", " config.json already exists.\n Overwrite it? (y/n)\n Press Enter to keep it, or Esc to abort\n");
    expect(prompt.question).toBe("Overwrite it? (y/n)");
    expect(labels(prompt)).toEqual(["Yes (y)", "No (n)", "Enter", "Esc"]);
    // the card's title, Yes and No are the bridge's own words, as keys (#1482); the question is the screen's, and key names stay
    expect(prompt.own_text).toEqual({ title: { key: "Waiting for input" }, labels: { 0: { key: "Yes (y)" }, 1: { key: "No (n)" } } });
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ text: "y" }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "n" }]);
    expect(labels(parseFallbackPrompt("gjc", "Delete the branch? [Y/n] "))).toEqual(["Yes (y)", "No (n)", "Enter", "Esc"]);
  });

  test("offers no letters for a (y/n) only mentioned above the prompt", () => {
    const prompt = parseFallbackPrompt("codex", 'The installer prints "Overwrite config? (y/n)".\nIt then exits.\n\n› Ask Codex to do anything\n  100% context left\n');
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
  });

  test("takes the question from the line that asks it, not the hint below", () => {
    const prompt = parseFallbackPrompt("gjc", "Found 3 stale caches.\nClear them now?\nPress Enter to continue, Esc to skip\n");
    expect(prompt.question).toBe("Clear them now?");
    expect(prompt.body).toBe("Found 3 stale caches.\nPress Enter to continue, Esc to skip");
    expect(labels(prompt)).toEqual(["Enter", "Esc"]);
  });

  test("gives the same id to the same screen, and another to a changed one", () => {
    const screen = "Pick\n\n❯ 1. One\n  2. Two\n\n Enter to select\n";
    expect(parseFallbackPrompt("omo", screen).id).toBe(parseFallbackPrompt("omo", screen).id);
    expect(parseFallbackPrompt("omo", screen.replace("Two", "Three")).id).not.toBe(parseFallbackPrompt("omo", screen).id);
    const context = (command: string) => [`$ ${command}`, ...Array.from({ length: 14 }, (_, i) => `line ${i}`), "Run it?", "", "❯ 1. Yes", "  2. No", "", " Enter to select"].join("\n");
    expect(parseFallbackPrompt("gjc", context("rm -rf important")).id).not.toBe(parseFallbackPrompt("gjc", context("rm safe.tmp")).id);
    const keys = (command: string) => [`$ ${command}`, ...Array.from({ length: 18 }, (_, i) => `line ${i}`), "Proceed? (y/n)"].join("\n");
    expect(parseFallbackPrompt("gjc", keys("rm -rf important")).id).not.toBe(parseFallbackPrompt("gjc", keys("rm safe.tmp")).id);
    const footer = (end: string) => `Pick\n\n❯ 1. One\n  2. Two\n\n ${end}\n`;
    expect(parseFallbackPrompt("gjc", footer("Enter to select")).id).not.toBe(parseFallbackPrompt("gjc", footer("Enter to select · done")).id);
  });

  /** a numbered menu under the line an agent keeps showing while it waits */
  const underWorkingLine = (working: string, cursor = 0) => [
    working, "", "Run the tests?", "",
    ...["Yes", "No"].map((label, index) => `${index === cursor ? "❯" : " "} ${index + 1}. ${label}`),
    "", "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");
  const idOf = (screen: string) => parseFallbackPrompt("claude", screen).id;

  test("keeps its id while only Claude's working line ticks", () => {
    // the spinner, the time and the token count move on every second; the prompt does not
    const first = parseFallbackPrompt("claude", underWorkingLine("✢ Tempering… (1m 55s · ↓ 10.0k tokens)"));
    expect(idOf(underWorkingLine("✻ Tempering… (1m 58s · ↓ 10.4k tokens)"))).toBe(first.id);
    expect(idOf(underWorkingLine("· Tempering… (2h 3m 1s · ↑ 1,204 tokens)"))).toBe(first.id);
    expect(idOf(underWorkingLine("* Running the tests… (5s · ↓ 12 tokens · esc to interrupt)"))).toBe(idOf(underWorkingLine("✶ Running the tests… (9s · ↓ 3.1k tokens · esc to interrupt)")));
    // the card shows the line as the screen has it
    expect(first.body).toBe("✢ Tempering… (1m 55s · ↓ 10.0k tokens)");
    // the keys card holds the line among its last ones, and as its question when nothing asks
    const keys = (working: string) => ["Apply the migration to the staging database", working, "Proceed? (y/n)"].join("\n");
    expect(idOf(keys("✢ Tempering… (5s · ↓ 1.0k tokens)"))).toBe(idOf(keys("✶ Tempering… (9s · ↓ 1.3k tokens)")));
    const asked = (working: string) => ["Pick one", "", "❯ 1. One", "  2. Two", working, "Enter to select"].join("\n");
    expect(idOf(asked("✢ Tempering… (5s · ↓ 1.0k tokens)"))).toBe(idOf(asked("✶ Tempering… (9s · ↓ 1.3k tokens)")));
  });

  test("makes another card of anything else that changed, on a working line too", () => {
    const working = "✢ Tempering… (5s · ↓ 1.0k tokens)";
    // what the agent is doing: the words stay in the id
    expect(idOf(underWorkingLine("✢ Deleting staging… (5s · ↓ 1.0k tokens)"))).not.toBe(idOf(underWorkingLine("✢ Deleting production… (5s · ↓ 1.0k tokens)")));
    // the row the cursor is on: Enter would pick another one
    expect(idOf(underWorkingLine(working, 0))).not.toBe(idOf(underWorkingLine(working, 1)));
    // the hint coming or going is a change of the line, once
    expect(idOf(underWorkingLine(working))).not.toBe(idOf(underWorkingLine("✢ Tempering… (5s · ↓ 1.0k tokens · esc to interrupt)")));
    // what is asked about, named above the lines the keys card shows, under a line that ticks
    const keys = (target: string, time: string) => [`Delete ${target}`, ...Array.from({ length: 15 }, (_, i) => `detail ${i}`), `✢ Tempering… (${time} · ↓ 1.0k tokens)`, "Proceed? (y/n)"].join("\n");
    expect(idOf(keys("staging", "5s"))).toBe(idOf(keys("staging", "9s")));
    expect(idOf(keys("staging", "5s"))).not.toBe(idOf(keys("production", "9s")));
  });

  test("reads a line that is not known to be Claude's working line to the letter", () => {
    const differ = (one: string, other: string, agent = "claude") =>
      expect(parseFallbackPrompt(agent, underWorkingLine(one)).id).not.toBe(parseFallbackPrompt(agent, underWorkingLine(other)).id);
    // a time in a command, in parentheses of another kind, or on a line with no spinner or no ellipsis
    differ("$ sleep 30s", "$ sleep 60s");
    differ("Waiting… (30s timeout)", "Waiting… (60s timeout)");
    differ("Tests passed (12s · 3 files)", "Tests passed (13s · 3 files)");
    differ("Tempering… (5s · ↓ 1.0k tokens)", "Tempering… (9s · ↓ 1.0k tokens)");
    differ("✢ Tempering (5s · ↓ 1.0k tokens)", "✢ Tempering (9s · ↓ 1.0k tokens)");
    // a duration that is offered, not one that has passed: nothing says tokens were used
    differ("* Restart service… (5s)", "* Restart service… (300s)");
    differ("✢ Restarting… (5s · downtime)", "✢ Restarting… (300s · downtime)");
    differ("✢ Tempering… (5s · esc to interrupt)", "✢ Tempering… (9s · esc to interrupt)");
    differ("• Restart service (5s · downtime)", "• Restart service (300s · downtime)");
    // an amount of tokens that is asked about: no arrow, or not on a working line
    differ("✢ Purchasing… (5s · 10 tokens)", "✢ Purchasing… (5s · 100000 tokens)");
    differ("• Purchase credits (5s · 10 tokens)", "• Purchase credits (5s · 100000 tokens)");
    differ("Budget: 10.0k tokens", "Budget: 90.0k tokens");
    // another program's working line, and Claude's line in a pane that does not run Claude
    differ("• Working (12s • esc to interrupt)", "• Working (47s • esc to interrupt)");
    differ("⠋ Thinking... (3s)", "⠹ Thinking... (9s)");
    differ("✢ Tempering… (5s · ↓ 1.0k tokens)", "✻ Tempering… (9s · ↓ 1.3k tokens)", "gjc");
  });

  test("tells the working line from a line that holds its blanked form as text", () => {
    // a fixture or a note about this very rule, shown on the screen: its text is what is asked about
    const about = (line: string) => ["Remove this exact line from the fixture?", line, "", "1. Yes", "2. No", "", "Enter a number, or Esc to cancel"].join("\n");
    expect(idOf(about("✢ Tempering… (55s · ↓ 10.0k tokens)"))).not.toBe(idOf(about("* Tempering… (<time> · <tokens>)")));
    expect(idOf(about("✢ Tempering… (55s · ↓ 10.0k tokens · esc to interrupt)"))).not.toBe(idOf(about("* Tempering… (<time> · <tokens> · esc to interrupt)")));
    // and from the same line one row further down
    const moved = (before: string[]) => [...before, "✢ Tempering… (55s · ↓ 10.0k tokens)", "", "1. Yes", "2. No", "", "Enter a number, or Esc to cancel"].join("\n");
    expect(idOf(moved(["Run it?"]))).not.toBe(idOf(moved(["Run it?", "Run it?"])));
  });

  test("keeps the marker of the selected row in the id, whatever the rows look like", () => {
    const rows = (selected: number, on: string, off: string, tail: string) =>
      ["Choose operation", ...["Delete all", "Cancel"].map((label, index) => `${index === selected ? on : off} ${label}${tail}`), "Use ↑/↓ then Enter"].join("\n");
    for (const [on, off, tail] of [
      ["•", "◦", " (5s · irreversible)"],
      ["*", "·", "…"],
      // rows that read like working lines: a spinner's frames as markers, an ellipsis and a time
      ["*", "·", "… (5s)"],
      // and with a token count: two lines of that shape are not one working line
      ["*", "·", "… (5s · ↓ 1.0k tokens)"],
    ] as const) {
      expect(idOf(rows(0, on, off, tail))).not.toBe(idOf(rows(1, on, off, tail)));
    }
  });
});

describe("Claude's suggestion on a prompt poll", () => {
  /** a herdr with one Claude pane whose ANSI reads never answer */
  async function stalledAnsiHerdr(status: string, run: (reads: string[]) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-prompt-suggestion-"));
    const path = join(root, "herdr.sock");
    const reads: string[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { format?: string } };
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "session.snapshot") {
          return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: "claude", agent_status: status }], layouts: [] } });
        }
        if (request.method !== "pane.read") throw new Error(`unexpected fixture RPC: ${request.method}`);
        reads.push(request.params.format ?? "");
        if (request.params.format === "text") answer({ read: { text: "Done.\n\n────────\n❯ \n────────\n" } });
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(reads); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function poll(): Promise<{ body: unknown; ms: number }> {
    const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
    const started = Date.now();
    const response = await handlePromptRequest(new Request(url), url);
    return { body: await response!.json(), ms: Date.now() - started };
  }

  test("answers without it once its read is late, rather than waiting on herdr", async () => {
    await stalledAnsiHerdr("idle", async (reads) => {
      const { body, ms } = await poll();
      expect(body).toEqual({ prompt: null, suggestion: null, restored: null });
      expect(reads).toEqual(["text", "ansi"]);
      expect(ms).toBeLessThan(2_500);
    });
  }, 4_000);

  test("is not read while Claude works", async () => {
    await stalledAnsiHerdr("working", async (reads) => {
      const { body, ms } = await poll();
      expect(body).toEqual({ prompt: null, suggestion: null, restored: null });
      expect(reads).toEqual(["text"]);
      expect(ms).toBeLessThan(1_000);
    });
  }, 4_000);
});

describe("Claude's plan card on a prompt poll", () => {
  const SCREEN = `
Ready to code?

Here is Claude's plan:
4. The last step that fits the pane.

Claude has written up a plan and is ready to execute. Would you like to proceed?

❯ 1. Yes, auto-accept edits
  2. Yes, manually approve edits
  3. Tell Claude what to change
     shift+tab to approve with this feedback
`;

  /** a herdr whose one Claude pane shows the plan dialog, and a Claude store with the session's plan file */
  async function planHerdr(run: (transcript: string, planFile: string) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-prompt-plan-"));
    const path = join(root, "herdr.sock");
    mkdirSync(join(root, "claude", "projects", "-work"), { recursive: true });
    mkdirSync(join(root, "claude", "plans"), { recursive: true });
    const transcript = join(root, "claude", "projects", "-work", "0b8e6f0e-8d3f-4c1a-9a53-6c2b7a1d9e42.jsonl");
    const planFile = join(root, "claude", "plans", "mellow-purring-pike.md");
    writeFileSync(transcript, `${JSON.stringify({ type: "user", slug: "mellow-purring-pike" })}\n`);
    writeFileSync(planFile, "# Plan\n\n1. The first step, gone from the pane.\n4. The last step that fits the pane.\n");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string };
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        if (request.method === "session.snapshot") {
          return answer({ snapshot: { panes: [{ pane_id: "p_1", agent: "claude", agent_status: "blocked" }], layouts: [] } });
        }
        if (request.method !== "pane.read") throw new Error(`unexpected fixture RPC: ${request.method}`);
        answer({ read: { text: SCREEN } });
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(transcript, planFile); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function poll(claudeTranscript?: (paneId: string) => string | null, readOnly?: boolean): Promise<InteractivePrompt | null> {
    const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1");
    const response = await handlePromptRequest(new Request(url), url, { claudeTranscript, readOnly });
    return ((await response!.json()) as { prompt: InteractivePrompt | null }).prompt;
  }

  test("takes the whole plan from Claude's plan file, with the screen's id and the plan's revision", async () => {
    await planHerdr(async (transcript, planFile) => {
      const screen = await poll();
      const filed = await poll((paneId) => paneId === "p_1" ? transcript : null);
      expect(screen).toMatchObject({ kind: "plan" });
      expect(screen?.plan_file).toBeUndefined();
      expect(screen?.body).not.toContain("The first step");
      expect(filed).toMatchObject({ kind: "plan", plan_file: planFile });
      expect(filed?.id.startsWith(`${screen!.id}.`)).toBe(true);
      expect(filed?.body).toContain("1. The first step, gone from the pane.");
    });
  }, 4_000);

  test("gives a watch-only requester the screen's card, without the plan file's text or path", async () => {
    await planHerdr(async (transcript) => {
      const screen = await poll();
      const watched = await poll(() => transcript, true);
      expect(watched).toMatchObject({ kind: "plan", id: screen!.id });
      expect(watched?.plan_file).toBeUndefined();
      expect(watched?.body).not.toContain("The first step");
      expect(watched?.body).toContain("The last step that fits the pane.");
    });
  }, 4_000);

  test("gives a connection server's plan=0 ask the screen's card, as for a watching device", async () => {
    await planHerdr(async (transcript) => {
      const screen = await poll();
      const url = new URL("http://127.0.0.1/api/pane/prompt?pane_id=p_1&plan=0");
      const response = await handlePromptRequest(new Request(url), url, { claudeTranscript: () => transcript });
      const asked = ((await response!.json()) as { prompt: InteractivePrompt | null }).prompt;
      expect(asked).toMatchObject({ kind: "plan", id: screen!.id });
      expect(asked?.plan_file).toBeUndefined();
      expect(asked?.body).not.toContain("The first step");
    });
  }, 4_000);

  test("a changed plan file is a new card, and an answer to the old one is refused", async () => {
    await planHerdr(async (transcript, planFile) => {
      const claudeTranscript = () => transcript;
      const before = await poll(claudeTranscript);
      writeFileSync(planFile, "# Plan\n\n1. A rewritten first step.\n4. The last step that fits the pane.\n");
      const after = await poll(claudeTranscript);
      expect(after?.id).not.toBe(before!.id);
      expect(after?.body).toContain("A rewritten first step.");
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = await handlePromptRequest(new Request(url, {
        method: "POST",
        body: JSON.stringify({ pane_id: "p_1", prompt_id: before!.id, option_index: 0 }),
      }), url, { claudeTranscript });
      expect(response!.status).toBe(409);
      expect(((await response!.json()) as { error: { code: string } }).error.code).toBe("prompt_changed");
    });
  }, 4_000);

  test("keeps the screen's text when the session has no plan file", async () => {
    await planHerdr(async (transcript, planFile) => {
      rmSync(planFile);
      const prompt = await poll(() => transcript);
      expect(prompt?.plan_file).toBeUndefined();
      expect(prompt?.body).toContain("The last step that fits the pane.");
    });
  }, 4_000);
});

// Captured from pi 0.87.1 driving its own dialogs: the pane's footer stays under the dialog,
// so the hint is near the end of the screen without being it.
describe("pi's dialogs", () => {
  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const piScreen = (body: string) => `────────────────────────────────────────\n\n${body}\n────────────────────────────────────────${FOOTER}`;
  const MENU_HINT = " ↑↓ navigate  enter select  escape/ctrl+c cancel";
  const select = piScreen(" Allow dangerous command?\n\n → Allow once\n   Always allow\n   Block\n" + MENU_HINT);

  test("reads an extension's select as its options, in pi's own order", () => {
    const prompt = parseInteractivePrompt("pi", select)!;
    expect(prompt.kind).toBe("question");
    expect(prompt.question).toBe("Allow dangerous command?");
    expect(prompt.options.map((option) => option.label)).toEqual(["Allow once", "Always allow", "Block"]);
    // the cursor sits on the first row, so one option is one key step per row above it
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  // As OmO 5.1.40 drew its init-deep advisor: pi's widget, Escape named `esc`, a timeout ticking in the title
  test("reads OmO's select, which names Escape esc and counts down in its title", () => {
    const omo = (seconds: number, title = "Init-deep") => piScreen(` ${title} (${seconds}s)\n\n → Run now\n   Skip this time\n   Never in this project\n   Never anywhere\n ↑↓ navigate  enter select  esc/ctrl+c cancel`);
    const prompt = parseInteractivePrompt("pi", omo(9))!;
    expect(prompt.fallback).toBeUndefined();
    expect(prompt.question).toBe("Init-deep (9s)");
    expect(prompt.options.map((option) => option.label)).toEqual(["Run now", "Skip this time", "Never in this project", "Never anywhere"]);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
    // a tick of the countdown is the same card, so an answer tapped after it still lands
    expect(parseInteractivePrompt("pi", omo(8))!.id).toBe(prompt.id);
    // only the count is left out: another title is another question
    expect(parseInteractivePrompt("pi", omo(9, "Reindex"))!.id).not.toBe(prompt.id);
    const input = parseInteractivePrompt("pi", piScreen(" Branch name?\n\n>\n enter submit  esc/ctrl+c cancel"))!;
    expect(input.custom_option_index).toBe(0);
  });

  test("reads a confirm as an approval, and declines it by pressing No", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Clear session?\n All messages will be lost.\n\n → Yes\n   No\n" + MENU_HINT))!;
    expect(prompt.kind).toBe("approval");
    expect(prompt.title).toBe("Clear session?");
    expect(prompt.question).toBe("All messages will be lost.");
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    // measured on pi: pressing "No" answers the confirmation false, where Escape would leave
    // it unanswered, so the card's decline presses the row it shows
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  // senpi asks a confirm as a select titled `${title}\n${message}`, so a timeout ticks at the end of the message
  test("keeps a timed confirm's card through its countdown, which ticks after its message", () => {
    const confirm = (seconds: number, message = "All messages will be lost.") => piScreen(` Clear session?\n ${message} (${seconds}s)\n\n → Yes\n   No\n ↑↓ navigate  enter select  esc/ctrl+c cancel`);
    const prompt = parseInteractivePrompt("pi", confirm(9))!;
    expect(prompt.kind).toBe("approval");
    expect(prompt.question).toBe("All messages will be lost. (9s)");
    // a Yes tapped after a tick answers the same card
    expect(parseInteractivePrompt("pi", confirm(8))!.id).toBe(prompt.id);
    expect(parseInteractivePrompt("pi", confirm(9, "Only this tab is cleared."))!.id).not.toBe(prompt.id);
    // a narrow pane can wrap `(10s)` onto a line of its own where `(9s)` still fits
    const wrappedCount = piScreen(" Clear session?\n All messages will be lost.\n (10s)\n\n \u2192 Yes\n   No\n \u2191\u2193 navigate  enter select  esc/ctrl+c cancel");
    expect(parseInteractivePrompt("pi", wrappedCount)!.id).toBe(prompt.id);
  });

  // senpi's text input counts down in its title
  test("keeps a timed input's card through its countdown, which ticks after its title", () => {
    const input = (seconds: number, title = "Branch name?") => piScreen(` ${title} (${seconds}s)\n\n>\n enter submit  esc/ctrl+c cancel`);
    const prompt = parseInteractivePrompt("pi", input(9))!;
    expect(prompt.custom_option_index).toBe(0);
    expect(prompt.question).toBe("Branch name? (9s)");
    expect(parseInteractivePrompt("pi", input(8))!.id).toBe(prompt.id);
    expect(parseInteractivePrompt("pi", input(9, "Tag name?"))!.id).not.toBe(prompt.id);
    // as senpi wraps a title at 46 columns: the count alone on the last line, as the count is
    const narrow = (seconds: number, grace = 30) => piScreen(` Restart with a grace period of (${grace}s)\n before deploying? (${seconds}s)\n\n>\n enter submit  esc/ctrl+c cancel`);
    const alone = (seconds: number) => piScreen(` What should the new release branch be named?\n (${seconds}s)\n\n>\n enter submit  esc/ctrl+c cancel`);
    expect(parseInteractivePrompt("pi", alone(8))!.id).toBe(parseInteractivePrompt("pi", alone(9))!.id);
    expect(parseInteractivePrompt("pi", narrow(8))!.id).toBe(parseInteractivePrompt("pi", narrow(9))!.id);
    // a count on an earlier line is the question's own words
    expect(parseInteractivePrompt("pi", narrow(9, 60))!.id).not.toBe(parseInteractivePrompt("pi", narrow(9))!.id);
  });

  test("lets the chat type an answer to a dialog that wants text", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Branch name?\n\n>\n enter submit  escape/ctrl+c cancel"))!;
    expect(prompt.question).toBe("Branch name?");
    expect(prompt.custom_option_index).toBe(0);
    // the `>` line already owns the input: an Enter typed before the answer submits the dialog
    // empty, and the answer is left behind to be typed into pi's own prompt
    // the line is emptied first: text typed into it in the terminal would stay around the answer
    expect(answerKeys(prompt, { custom_text: "feat/x" })).toEqual([{ keys: ["ctrl+k"] }, { keys: ["ctrl+u"] }, { text: "feat/x" }, { keys: ["enter"] }]);
  });

  // The wrap as pi 0.87.1 draws it in a pane 46 columns wide: a row three columns in, its rest one.
  test("reads an option a narrow pane wrapped as one option, so a tap lands on the row it names", () => {
    const narrow = piScreen(" Where should this change go next?\n\n → Keep it on the staging environment for now\n and wait for review\n   Deploy to production\n   Cancel\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n");
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt.options.map((option) => option.label)).toEqual(['Keep it on the staging environment for now and wait for review', "Deploy to production", "Cancel"]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
    // an option that is not the cursor's wraps the same way
    const second = piScreen(" Pick one\n\n → Cancel\n   Keep it on the staging environment for now\n and wait for review\n   Deploy to production\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n");
    expect(parseInteractivePrompt("pi", second)!.options.map((option) => option.label)).toEqual(["Cancel", "Keep it on the staging environment for now and wait for review", "Deploy to production"]);
  });

  test("reads a confirm's wrapped message whole, under the dialog's own title", () => {
    const prompt = parseInteractivePrompt("pi", piScreen(" Delete the branch?\n This removes the local branch and its remote\n counterpart for good.\n\n → Yes\n   No\n\n ↑↓ navigate  enter select  escape/ctrl+c\n cancel\n"))!;
    expect(prompt.kind).toBe("approval");
    expect(prompt.title).toBe("Delete the branch?");
    expect(prompt.question).toBe("This removes the local branch and its remote counterpart for good.");
  });

  test("offers nothing once the dialog is answered, moved through, or never opened", () => {
    expect(parseInteractivePrompt("pi", select.replace("→ Allow once", "  Allow once").replace("   Always allow", " → Always allow"))).toBeNull();
    // an answered dialog leaves its hint on screen while pi carries on under it: the hint is
    // no longer near the end, so the card that was offered is withdrawn rather than reoffered
    expect(parseInteractivePrompt("pi", piScreen(" select -> Always allow\n" + MENU_HINT + "\n\n thinking\n more of the answer\n and yet more\n\n>" ))).toBeNull();
    // pi's own main prompt, and its slash palette: the palette ends in a row count rather than
    // this hint, and its rows are set out in two columns, which are commands, not answers
    expect(parseInteractivePrompt("pi", piScreen(""))).toBeNull();
    const palette = piScreen(" /model\n → settings                        Open settings menu\n   model                           Select model\n   tree                            Navigate session tree\n   (1/51)\n" + MENU_HINT);
    expect(parseInteractivePrompt("pi", palette)).toBeNull();
    // /tree navigates the session's branch, which the chat cannot undo: its hint says "↑/↓ move"
    expect(parseInteractivePrompt("pi", piScreen("   Session Tree\n  ↑/↓ move · ←/→ page · ctrl+←/→ branch · ctrl+x copy\n  Type to search:\n────────────────────────────────────────\n  an entry\n  (0/1)"))).toBeNull();
  });

  test("tells a dialog apart from another of the same shape", () => {
    const other = select.replace("Block", "Block and say why");
    expect(parseInteractivePrompt("pi", select)!.id).not.toBe(parseInteractivePrompt("pi", other)!.id);
    // the id is the card's own content: what the chat polls keeps its answer open while pi
    // redraws around the dialog, and turns stale only when the dialog itself changes
    expect(parseInteractivePrompt("pi", select.replace("0.0%/215k (auto)", "12.3%/215k (auto)"))!.id).toBe(parseInteractivePrompt("pi", select)!.id);
  });

  test("reads a select, confirm and input over an extension's status line in pi's footer", () => {
    const withStatus = (screen: string) => `${screen}worktree: main · usage 12%\n`;
    expect(labels(parseInteractivePrompt("pi", withStatus(select)))).toEqual(["Allow once", "Always allow", "Block"]);
    expect(parseInteractivePrompt("pi", withStatus(piScreen(" Clear session?\n All messages will be lost.\n\n → Yes\n   No\n" + MENU_HINT)))?.kind).toBe("approval");
    expect(parseInteractivePrompt("pi", withStatus(piScreen(" Branch name?\n\n>\n enter submit  escape/ctrl+c cancel")))?.custom_option_index).toBe(0);
    expect(parseInteractivePrompt("pi", `${withStatus(select)}Some later output\nand more\n`)).toBeNull();
  });
});

// Pi's thinking-selector layout with fictional offered levels; no installed Pi dependency.
const PI_THINKING_HINT = "Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel";
function piThinking(at = 1, narrow = false, levels = ["off", "medium", "max"], query = ""): string {
  return ["Thinking Level", "", "Shift+Tab cycles thinking levels in-session", "", `> ${query}`, "",
    ...levels.map((level, index) => `${index === at ? "→" : " "} ${level === "medium" ? "✓" : " "} ${level}${narrow ? "" : `    ${level === "max" ? "Maximum reasoning · default" : "Reasoning description"}`}`), "",
    narrow ? "  Enter to\nselect ·\nCtrl+S to set\nas default ·\nEscape/Ctrl+C\nto cancel" : PI_THINKING_HINT,
    "────────────────────────────", "/tmp/fictional", "0.0%/215k (auto)",
  ].join("\n");
}

describe("pi's thinking selector", () => {
  test("separates current/default/highlight across widths and keeps cursor movement out of identity", () => {
    const wide = parseInteractivePrompt("pi", piThinking(2))!;
    const narrow = parseInteractivePrompt("pi", piThinking(2, true))!;
    expect(wide.question).toBe("Select thinking level (currently medium)");
    expect(wide.own_text).toEqual({ question: { key: "Select thinking level (currently {level})", vars: { level: "medium" } } });
    expect(wide.id).toBe("cb779b7d598a"); // the id main's bridge gave this card before its question went as a key
    expect(wide.options[2]).toEqual({ label: "max", description: "Maximum reasoning · default" });
    expect(narrow.options).toEqual(["off", "medium", "max"].map((label) => ({ label, description: null })));
    expect(narrow.question).toBe(wide.question);
    expect(parseInteractivePrompt("pi", piThinking(0))!.id).toBe(wide.id);
    expect(answerKeys(wide, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("offers only visible levels, even a single supported or filtered row", () => {
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    expect(labels(parseInteractivePrompt("pi", piThinking(4, true, levels)))).toEqual(levels);
    for (const query of ["", "max"]) {
      expect(labels(parseInteractivePrompt("pi", piThinking(0, true, ["max"], query)))).toEqual(["max"]);
    }
  });

  test("refuses empty, unknown, incomplete and stale drawings", () => {
    const screen = piThinking();
    for (const drawn of [
      piThinking(0, true, []), piThinking(0, true, ["unknown"]), screen.replace("Thinking Level", "Models"),
      screen.replace("> ", "search: "), screen.replace(PI_THINKING_HINT, "Enter to select"),
      screen.replace("→ ✓ medium", "  ✓ medium"), screen + "\nAnswer output\nMore output\n> next message",
      piThinking(1, true) + "\nAnswer output\nMore output\n> next message",
      screen.replace("    max", "    unknown"),
    ]) expect(parseInteractivePrompt("pi", drawn)).toBeNull();
  });

  test("reads the selector over an extension's status line in pi's footer", () => {
    for (const narrow of [false, true]) {
      const screen = `${piThinking(1, narrow)}\nworktree: main · usage 12%`;
      expect(labels(parseInteractivePrompt("pi", screen))).toEqual(["off", "medium", "max"]);
      expect(parseInteractivePrompt("pi", `${screen}\nAnswer output\nMore output`)).toBeNull();
    }
  });
});

// Both screens captured from pi 0.87.1 running /model in a pane of its own, at 140 columns and
// at 46, with the catalogue already settled.
describe("pi's model list", () => {
  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const MODEL_HINT = " Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel";
  const wide = `────────────────────────────────────────

Only showing models from configured providers. Use /login to add providers.
>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default
    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]
Could not refresh llama.cpp; showing cached models.
${MODEL_HINT}
────────────────────────────────────────${FOOTER}`;

  test("reads the catalogue, naming the model answering now", () => {
    const prompt = parseInteractivePrompt("pi", wide)!;
    expect(prompt.kind).toBe("question");
    expect(prompt.question).toBe("Select model (currently vllm/Qwen/Qwen3.8-27B [lwsa-platform])");
    expect(prompt.options.map((option) => option.label)).toEqual([
      "vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default",
      "vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]",
    ]);
    // pi's own notes sit among the rows — the refresh failure at column zero, `Model Name:`
    // indented — and none of them is a model pi can be switched to
    expect(prompt.options.length).toBe(2);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("navigates from where pi drew the cursor, which is the model in use", () => {
    const moved = wide.replace("→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]",
      "  ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n→ vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]");
    const prompt = parseInteractivePrompt("pi", moved)!;
    expect(prompt.question).toBe("Select model (currently vllm/Qwen/Qwen3.8-27B [lwsa-platform])");
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("voids a catalogue whose rows run out mid-name rather than offering the ones before it", () => {
    // a screen redrawn while pi is still writing it ends a row in the middle of its provider
    // bracket. Stopping there is right, but the rows before it were already collected, and
    // offering them is a catalogue pi never drew: the reader would count down into a list whose
    // rest does not exist, and the count the card shows would not be the list pi has. This is the
    // same call the wrapped-name check makes — a row that cannot be read voids the reading
    const cut = `────────────────────────────────────────

Only showing models from configured providers. Use /login to add providers.
>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default
    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]
    another-model [provider-
${MODEL_HINT}
────────────────────────────────────────${FOOTER}`;
    expect(parseInteractivePrompt("pi", cut)).toBeNull();
  });

  // Captured from pi 0.87.1 running /model in a 46-column pane, the width a phone leaves it:
  // the hint splits across two lines, and so does a model's own name, which drops the provider's
  // bracket — the one mark that tells a row from pi's notes — onto a line of its own at column
  // zero, where it looks exactly like a note. Every check here is read off that capture.
  const narrow = `──────────────────────────────

Only showing models from configured providers.
Use /login to add providers.
>

→ ✓ vllm-flash/Qwen3.8-Flash-Next
[lwsa-platform] · default
    vllm/Qwen/Qwen3.8-27B [lwsa-platform]

  Model Name: qwen-3-8-flash

  Refreshing model catalogs…

  Enter to select · Ctrl+S to set as default ·
Escape/Ctrl+C to cancel
──────────────────────────────
/tmp/pn
0.0%/215k (auto)  vllm-flash/Qwen3.8-Flash-Nex
`;

  test("reads the catalogue off a phone's pane, joining the rows pi wrapped", () => {
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt).not.toBeNull();
    expect(prompt.options.map((option) => option.label)).toEqual([
      "vllm-flash/Qwen3.8-Flash-Next [lwsa-platform] · default",
      "vllm/Qwen/Qwen3.8-27B [lwsa-platform]",
    ]);
    expect(prompt.question).toBe("Select model (currently vllm-flash/Qwen3.8-Flash-Next [lwsa-platform])");
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("stops the catalogue at pi's notes, which the narrow pane indents like a row", () => {
    // `Model Name:` and `Refreshing model catalogs…` sit two spaces in, the same indentation a
    // wrapped row's tail carries, and neither is a model pi can be switched to
    const prompt = parseInteractivePrompt("pi", narrow)!;
    expect(prompt.options.some((option) => /Model Name|Refreshing/i.test(option.label))).toBe(false);
  });

  test("goes stale on a phone's pane once the wrapped hint is buried", () => {
    expect(parseInteractivePrompt("pi", narrow)).not.toBeNull();
    expect(parseInteractivePrompt("pi", `${narrow}Some later output\nand more\n`)).toBeNull();
  });

  test("says nothing rather than offer a model that is only half a name", () => {
    // a bracket cut mid-word is not a provider: joining it back would invent `lwsa- platform`
    const cut = `────────────────────────

>

→ ✓ vllm/Qwen/Qwen3.8-27B [lwsa-
    vllm-flash/Qwen3.8-Flash-Next
${MODEL_HINT}
────────────────────────${FOOTER}`;
    expect(parseInteractivePrompt("pi", cut)).toBeNull();
    // filtering the list down to one model leaves nothing to choose between
    const one = wide.replace("    vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]\n", "");
    expect(parseInteractivePrompt("pi", one)).toBeNull();
    // and with the cursor on no row at all, an answer would navigate from nowhere
    expect(parseInteractivePrompt("pi", wide.replace("→ ✓ vllm/Qwen", "  ✓ vllm/Qwen"))).toBeNull();
  });

  // Captured from pi 0.87.1 running /login in a 46-column pane. `↑↓ navigate` carries no `·`, so
  // pi keeps its footer under this dialog as it does everywhere else, and the hint's own wrap puts
  // it four lines from the bottom — further than a three-line window reaches. A phone leaves pi
  // exactly this wide, so every dialog it can be asked had no card at that width.
  const login = `──────────────────────────────

 Login

 Choose how to sign in.

 → Sign in with an account
   Sign in with an API key

 ↑↓ navigate  enter select  escape/ctrl+c
 cancel
──────────────────────────────
/tmp/pr
0.0%/215k (auto)  vllm-flash/Qwen3.8-Flash-Nex
`;

  test("reads a dialog whose wrapped hint sits over pi's footer", () => {
    const prompt = parseInteractivePrompt("pi", login)!;
    expect(prompt).not.toBeNull();
    expect(prompt.options.map((option) => option.label)).toEqual([
      "Sign in with an account",
      "Sign in with an API key",
    ]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("goes stale on a phone's pane once a wrapped dialog hint is buried", () => {
    expect(parseInteractivePrompt("pi", login)).not.toBeNull();
    // pi keeps the answered dialog on screen; what comes after buries the hint, and a card still
    // open then would press keys into whatever the pane shows by then
    expect(parseInteractivePrompt("pi", `${login}Some later output\nand more\n`)).toBeNull();
  });

  test("goes stale once the list is answered and buried", () => {
    expect(parseInteractivePrompt("pi", wide)).not.toBeNull();
    // pi keeps the answered list on screen; the next request's output buries the hint under it,
    // and the card must not stay open offering a switch into whatever the pane shows by then
    expect(parseInteractivePrompt("pi", `${wide}\nSome later output\nand more`)).toBeNull();
  });

  // As pi 1.4.0 drew /model in a 68-column pane with a usage extension's `ctx.ui.setStatus`: pi
  // joins every status into a third footer line under the meter, truncated rather than wrapped.
  const status = `────────────────────────────────────────────────────────────────────

Only showing models from configured providers. Use /login to add
providers.

>

→ ✓ claude-opus-5-5 [pi-claude-cli] · default
    gpt-4.1 [openai]
    gpt-4o [openai]
  (1/58)

  Model Name: Claude Opus 5.5

  Model catalogs refreshed.

  Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to
cancel
────────────────────────────────────────────────────────────────────
~/app (main)
↑52 ↓5.3k R460k W33k CH98.9% $0.461 (sub) 3.7%/1.0M (auto)  claude-o
Claude: 5h 12% (4h 4m) · 7d 12% (6d 8h) | Codex: 5h 0% (4h 55m) ·...
`;

  test("reads the list over an extension's status line in pi's footer", () => {
    const prompt = parseInteractivePrompt("pi", status)!;
    expect(prompt).not.toBeNull();
    expect(prompt.question).toBe("Select model (currently claude-opus-5-5 [pi-claude-cli])");
    expect(labels(prompt)).toEqual(["claude-opus-5-5 [pi-claude-cli] · default", "gpt-4.1 [openai]", "gpt-4o [openai]"]);
    // the status line is allowed only under the stats line: output under the footer still buries the list
    expect(parseInteractivePrompt("pi", `${status}Some later output\nand more\n`)).toBeNull();
    expect(parseInteractivePrompt("pi", status.replace(/\n↑52 .*\n/, "\nprogress 50%/100 done\n"))).toBeNull();
    const under = (line: string) => status.replace(/Claude: 5h.*\n$/, `${line}\n`);
    // a prompt under the stats line is not a status: a composer, or a shell's once pi has gone
    for (const prompt of ["❯ a new message", "› next", "> next", "$ ", "# ", "user@host:~/app$", "user@host ~/app (main)>", "➜  app git:(main)"]) {
      expect(parseInteractivePrompt("pi", under(prompt))).toBeNull();
    }
    // output that only starts like the stats line, or a stats line without pi's folder line above it, is not pi's footer
    for (const stats of ["$1 total", "↑2 items", "R3 rows", "CH5 done", "10 %/100"]) {
      expect(parseInteractivePrompt("pi", status.replace(/\n↑52 .*\n/, `\n${stats}\n`))).toBeNull();
    }
    expect(parseInteractivePrompt("pi", status.replace("~/app (main)\n", "build finished\n"))).toBeNull();
    // statuses that merely start or end with such a character are still statuses
    for (const shown of ["$0.42 today", "#1234 open", "usage 12%"]) expect(parseInteractivePrompt("pi", under(shown))).not.toBeNull();
    // a narrow pane cuts the stats line before its meter, as pi cuts that line at 48 columns
    const narrow = status.replace("$0.461 (sub) 3.7%/1.0M (auto)  claude-o", "$0.461 (sub) 3.7...");
    expect(labels(parseInteractivePrompt("pi", narrow))).toEqual(labels(parseInteractivePrompt("pi", status)));
    expect(parseInteractivePrompt("pi", status.replace(/\n↑52 .*\n/, "\n0.0%/200k (auto)\n"))).not.toBeNull();
    expect(parseInteractivePrompt("pi", status.replace(/\n↑52 .*\n/, "\n?/200k\n"))).not.toBeNull();
  });
});

// Claude Code 2.1.290 running /model in a pane of its own, captured at 120 columns, at 46 by 40
// and at 46 by 24. The list held twelve models; the twelfth was never drawn in a capture, so
// the fixtures that draw a window stop at the eleventh and count it.
const CLAUDE_MODELS: [name: string, said: string][] = [
  ["Default (recommended)", "Fable 5.1"], ["Opus 5.5", "For complex work and everyday tasks"], ["Fable 5.1", "For your toughest challenges"],
  ["Sonnet 5.5", "Most efficient for simpler tasks"], ["Haiku 4.5", "Fastest for quick answers"], ["Sonnet 5", "Efficient for routine tasks"],
  ["Opus 5", "Best for everyday, complex tasks"], ["Fable 5", "Most capable for your hardest and longest-running tasks"],
  ["Opus 4.8", "Best for everyday, complex tasks"], ["Opus 4.7", "Best for everyday, complex tasks"], ["Opus 4.6", "Best for everyday, complex tasks"],
];
const CLAUDE_MODEL_HINT = "  Enter to set as default · s to use this session only · Esc to cancel";
/** after Esc in the terminal: Claude says what it kept and has its input box back */
const CLAUDE_MODEL_CLOSED = `❯ /model\n  ⎿  Kept model as Opus 5.5\n\n${"─".repeat(60)}\n❯ \n${"─".repeat(60)}\n  [Opus 5.5] │ app git:(main)\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n`;
/**
 * The list as a wide pane shows it: `shown` rows from row `from`, the cursor on row `at`, `✔` on
 * the second. The cursor's column holds `↑` or `↓` on the window's first and last row when the
 * list goes on beyond it, and the effort line under the rows follows the cursor.
 */
function claudeModelList(at: number, from = 0, shown = 10, hint = CLAUDE_MODEL_HINT): string {
  const window = CLAUDE_MODELS.slice(from, from + shown);
  const below = 12 - from - window.length;
  const rows = window.map(([name, said], index) => {
    const row = from + index;
    const mark = row === at ? "❯" : index === 0 && from > 0 ? "↑" : index === window.length - 1 && below > 0 ? "↓" : " ";
    return `  ${mark} ${`${row + 1}.`.padEnd(3)} ${`${name}${row === 1 ? " ✔" : ""}`.padEnd(21)}  ${said}`;
  });
  return [
    "❯ /model", "", "─".repeat(120), "  Select model",
    "  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,",
    "  specify with --model.", "", ...rows, ...(below > 0 ? [`     … +${below} model${below === 1 ? "" : "s"}`] : []), "",
    at === 4 ? "  ○ Effort not supported for Haiku 4.5" : at === 2 ? "  ● High effort (default) ←/→ to adjust" : "  ◐ Medium effort (default) ←/→ to adjust",
    "", hint, "",
  ].join("\n");
}

describe("Claude Code's model list", () => {
  test("reads the rows it draws, naming the model in use and counting the ones it holds back", () => {
    // the capture itself, so that the drawing above is checked against what Claude drew
    const captured = `❯ /model

${"─".repeat(120)}
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,
  specify with --model.

    1.  Default (recommended)  Fable 5.1
  ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks
    3.  Fable 5.1              For your toughest challenges
    4.  Sonnet 5.5             Most efficient for simpler tasks
    5.  Haiku 4.5              Fastest for quick answers
    6.  Sonnet 5               Efficient for routine tasks
    7.  Opus 5                 Best for everyday, complex tasks
    8.  Fable 5                Most capable for your hardest and longest-running tasks
    9.  Opus 4.8               Best for everyday, complex tasks
  ↓ 10. Opus 4.7               Best for everyday, complex tasks
     … +2 models

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this session only · Esc to cancel
`;
    expect(claudeModelList(1)).toBe(captured);
    const prompt = parseInteractivePrompt("claude", captured)!;
    expect(prompt).toMatchObject({ agent: "claude", kind: "question", title: "", body: null, multi_select: false, custom_option_index: null });
    expect(prompt.question).toBe("Select model for this session (currently Opus 5.5). 2 more models are listed in the terminal.");
    expect(prompt.options).toEqual(CLAUDE_MODELS.slice(0, 10).map(([label, description]) => ({ label, description })));
    // herdr reports the pane idle while the list waits: no other agent's reader takes it for its own
    for (const agent of ["codex", "omp", "pi", "omo", ""]) expect(parseInteractivePrompt(agent, captured)).toBeNull();
  });

  test("is one card wherever the cursor stands, whatever effort the row under it would run at", () => {
    const first = parseInteractivePrompt("claude", claudeModelList(1))!;
    for (const at of [0, 2, 4, 9]) expect(parseInteractivePrompt("claude", claudeModelList(at))!.id).toBe(first.id);
  });

  test("reads a window further down the list, and the last row with the cursor on it", () => {
    // nine ↓ from the second row: the window has moved one row down, `↑` on its first
    const scrolled = claudeModelList(10, 1);
    expect(scrolled).toContain("  ↑ 2.  Opus 5.5 ✔             For complex work and everyday tasks\n");
    expect(scrolled).toContain("  ❯ 11. Opus 4.6               Best for everyday, complex tasks\n     … +1 model\n");
    const prompt = parseInteractivePrompt("claude", scrolled)!;
    expect(labels(prompt)).toEqual(CLAUDE_MODELS.slice(1, 11).map(([name]) => name));
    // one above the window, one below it
    expect(prompt.question).toBe("Select model for this session (currently Opus 5.5). 2 more models are listed in the terminal.");
    expect(parseInteractivePrompt("claude", claudeModelList(1, 1))!.id).toBe(prompt.id);
    expect(prompt.id).not.toBe(parseInteractivePrompt("claude", claudeModelList(1))!.id);
    // the model in use above the window: the card does not name one
    expect(parseInteractivePrompt("claude", claudeModelList(4, 2))!.question).toBe("Select model for this session. 3 more models are listed in the terminal.");
  });

  test("reads the list by family that another session drew, with nothing held back", () => {
    // captured from the same Claude Code a few minutes apart: five rows, the name in what a row says
    const families = `   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names,
   specify with --model.

   ❯ 1. Default (recommended) ✔  Opus 5.5 · Best for everyday, complex tasks
     2. Opus                     Opus 5.5 · Best for everyday, complex tasks
     3. Fable                    Fable 5.1 · Most capable for your hardest and longest-running tasks
     4. Sonnet                   Sonnet 5.5 · Efficient for routine tasks
     5. Haiku                    Haiku 4.5 · Fastest for quick answers

   ◐ Medium effort (default) ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel
`;
    const prompt = parseInteractivePrompt("claude", families)!;
    expect(prompt.question).toBe("Select model for this session (currently Default)");
    expect(prompt.options).toEqual([
      { label: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
      { label: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks" },
      { label: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks" },
      { label: "Sonnet", description: "Sonnet 5.5 · Efficient for routine tasks" },
      { label: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
    ]);
  });

  // 46 columns by 24 lines, the pane a phone leaves: the title has scrolled off the top, Claude
  // draws five rows of the twelve, and what a row says wraps under itself
  const PHONE = `  becomes the default for new sessions. For
  other/previous model names, specify with
  --model.

    1.  Default (recommended)  Fable 5.1
  ❯ 2.  Opus 5.5 ✔             For complex
                               work and
                               everyday
                               tasks
    3.  Fable 5.1              For your
                               toughest
                               challenges
    4.  Sonnet 5.5             Most
                               efficient for
                               simpler
                               tasks
  ↓ 5.  Haiku 4.5              Fastest for
                               quick answers
     … +7 models

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this
  session only · Esc to cancel
`;

  test("reads the list off a phone's pane, with its title scrolled off and its rows wrapped", () => {
    const prompt = parseInteractivePrompt("claude", PHONE)!;
    expect(prompt.question).toBe("Select model for this session (currently Opus 5.5). 7 more models are listed in the terminal.");
    expect(prompt.options).toEqual(CLAUDE_MODELS.slice(0, 5).map(([label, description]) => ({ label, description })));
    // the same pane 40 lines tall draws ten rows, and cuts the one word longer than its column:
    // it stays cut as the pane shows it, since a line that fills its column says nothing of a space
    const cut = `    7.  Opus 5                 Best for
                               everyday,
                               complex tasks
  ❯ 8.  Fable 5                Most capable
                               for your
                               hardest and
                               longest-runni
                               ng tasks
    9.  Opus 4.8               Best for
                               everyday,
                               complex tasks
  ↓ 10. Opus 4.7               Best for
                               everyday,
                               complex tasks
     … +2 models

  ● High effort (default) ←/→ to adjust

  Enter to set as default · s to use this
  session only · Esc to cancel
`;
    expect(parseInteractivePrompt("claude", cut)!.options).toEqual(CLAUDE_MODELS.slice(6, 10).map(([label, description]) => ({ label, description: description.replace("longest-running", "longest-runni ng") })));
  });

  test("picks with s, the key for this session only, and never with Enter", () => {
    const prompt = parseInteractivePrompt("claude", claudeModelList(1))!;
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ text: "s" }]);
    expect(answerKeys(prompt, { option_index: 4 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { text: "s" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { text: "s" }]);
    // a window further down: the moves count from the cursor's place in it
    expect(answerKeys(parseInteractivePrompt("claude", claudeModelList(10, 1))!, { option_index: 7 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { text: "s" }]);
    expect(() => answerKeys(prompt, { custom_text: "opus" })).toThrow();
    expect(() => answerKeys(prompt, { option_index: 10 })).toThrow();
  });

  test("offers no card for a list that is not waiting, or that names no key for this session", () => {
    expect(parseInteractivePrompt("claude", CLAUDE_MODEL_CLOSED)).toBeNull();
    // the list's text left above later output takes no key any more
    expect(parseInteractivePrompt("claude", `${claudeModelList(1)}Some later output\nand more\n`)).toBeNull();
    // nor does it hold the screen for a message that waits to be typed, while an open list does, wrapped or not
    expect(registry.waits("claude", `${claudeModelList(1)}Some later output\nand more\n`)).toBe(false);
    expect(registry.waits("claude", claudeModelList(1))).toBe(true);
    const wrapped = claudeModelList(1).replace(CLAUDE_MODEL_HINT, "  Enter to set as\n  default · s to use\n  this session\n  only · Esc to\n  cancel");
    expect(registry.waits("claude", wrapped)).toBe(true);
    // Claude's own footer under the open list, the session's rule and its task list, is no later output: also under a wrapped hint
    expect(registry.waits("claude", `${claudeModelList(1)}──────────── Session name ─\n`)).toBe(true);
    expect(registry.waits("claude", `${wrapped}──────────── Session name ─\n`)).toBe(true);
    expect(registry.waits("claude", `${wrapped}──────────── Session name ─\n  3 tasks (0 done, 1 in progress, 2 open)\n  ◼ 구현\n    Running tests…\n  ◻ 검증\n  ◻ 정리\n`)).toBe(true);
    // the same footer under an answered list's hint and what came after it holds nothing
    expect(registry.waits("claude", `${wrapped}⏺ Kept the model.\n──────────── Session name ─\n`)).toBe(false);
    // a list that takes Enter alone would save the pick as the default: not this card's to press
    expect(parseInteractivePrompt("claude", claudeModelList(1, 0, 10, "  Enter to set as default · Esc to cancel"))).toBeNull();
    expect(parseInteractivePrompt("claude", claudeModelList(1, 0, 10, "  Enter to confirm · Esc to cancel"))).toBeNull();
  });

  test("offers no card for rows it cannot read as the list drew them", () => {
    const list = claudeModelList(1);
    // no cursor on any row drawn, or on two of them
    expect(parseInteractivePrompt("claude", list.replace("  ❯ 2. ", "    2. "))).toBeNull();
    expect(parseInteractivePrompt("claude", list.replace("    4. ", "  ❯ 4. "))).toBeNull();
    // a name the pane cut in two stands under its row at the name's own column. Half a name is no
    // model: that row is left to the terminal, and the rows under it are offered as they read
    const split = PHONE.replace("    1.  Default (recommended)  Fable 5.1", "    1.  Default\n        (recommended)          Fable 5.1");
    expect(parseInteractivePrompt("claude", split)).not.toBeNull();
    expect(labels(parseInteractivePrompt("claude", split))).toEqual(["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 4.5"]);
    expect(parseInteractivePrompt("claude", split)!.question).toBe("Select model for this session (currently Opus 5.5). 8 more models are listed in the terminal.");
    // the last row cut so: nothing under it says where the list ends
    expect(parseInteractivePrompt("claude", PHONE.replace("  ↓ 5.  Haiku 4.5              Fastest for\n                               quick answers", "  ↓ 5.  Haiku\n        4.5                    Fastest"))).toBeNull();
    // one row is no choice
    expect(parseInteractivePrompt("claude", claudeModelList(1, 1, 1))).toBeNull();
    // more under the rows than the effort line: another program's text over the same hint
    expect(parseInteractivePrompt("claude", list.replace("\n\n  ◐ Medium", "\n\n  one\n  two\n  three\n  ◐ Medium"))).toBeNull();
  });

  test("reads a wrapped line by its column, whatever it begins with", () => {
    // what a row says can wrap onto a line that begins like a row of its own
    const numbered = PHONE.replace("                               work and\n                               everyday", "                               work and\n                               3. everyday");
    expect(numbered).not.toBe(PHONE);
    const prompt = parseInteractivePrompt("claude", numbered)!;
    expect(labels(prompt)).toEqual(CLAUDE_MODELS.slice(0, 5).map(([name]) => name));
    expect(prompt.options[1]!.description).toBe("For complex work and 3. everyday tasks");
  });

  test("takes no numbered line above the list for one of its rows", () => {
    // an answer's own list in the transcript, right above the panel
    const answered = `● Here are the steps:\n  1. Read the file\n  2. Run the tests\n\n${claudeModelList(1)}`;
    expect(labels(parseInteractivePrompt("claude", answered))).toEqual(CLAUDE_MODELS.slice(0, 10).map(([name]) => name));
    // even right above the window with its count running on into it: `↑` is the window's first row
    const window = claudeModelList(10, 1);
    const ranOn = `● Options:\n  1. Keep it\n${window.slice(window.indexOf("  ↑ 2. "))}`;
    expect(ranOn).toContain("  1. Keep it\n  ↑ 2.  Opus 5.5 ✔");
    expect(labels(parseInteractivePrompt("claude", ranOn))).toEqual(CLAUDE_MODELS.slice(1, 11).map(([name]) => name));
    // and `↓` is its last: a numbered line right under that row is none of the list's
    const under = claudeModelList(1).replace("     … +2 models\n", "    11. Read the file\n");
    expect(under).toContain("  ↓ 10. Opus 4.7               Best for everyday, complex tasks\n    11. Read the file\n");
    expect(parseInteractivePrompt("claude", under)).toBeNull();
  });
});

// Codex 0.160.1 running /model in a pane of its own, captured at 120 columns and at 46 by 24:
// the list of models, the reasoning levels behind a model's row, and the list behind "More
// reasoning…". The footer is the one Codex draws for the row under the cursor.
const CODEX_OPENS = "  enter select · esc back";
const CODEX_PICKS = "  enter default · s session · esc back";
const CODEX_MODELS: [name: string, said: string][] = [
  ["GPT-6.1-Sol (default)", "Latest workhorse model for coding and everyday work."], ["GPT-6-Astra", "Frontier intelligence for the most demanding work."],
  ["GPT-6-Sol", "Previous generation workhorse model."], ["GPT-6-Luna", "Fast and affordable model for easier tasks."],
  ["GPT-5.6-Sol", "Older generation workhorse model."], ["GPT-5.6-Terra", "Older balanced model for straightforward work."],
  ["GPT-5.6-Luna", "Older fast and efficient model."],
];
const CODEX_LEVELS: [name: string, said: string][] = [
  ["Low", "Fast responses with lighter reasoning"], ["Medium (default)", "Balances speed and reasoning depth for everyday tasks"],
  ["High", "Greater reasoning depth for complex problems"], ["Extra high", "Extra high reasoning depth for complex problems"],
  ["More reasoning…", "Max and Ultra consume usage limits faster"],
];
const CODEX_HEAD = "\n  >_ OpenAI Codex (v0.160.1)\n     ~/app\n  permissions: YOLO mode\n\n  Hello, you. Got an idea?\n\n";
/**
 * One of Codex's lists with its cursor on row `at` and `(current)` on the second: the names in one
 * column, what a row says in the next, and under them the footer of the row the cursor is on.
 */
function codexList(title: string, rows: [string, string][], at: number, footer: (row: number) => string): string {
  const width = Math.max(...rows.map(([name], row) => name.length + (row === 1 ? " (current)".length : 0)));
  return `${CODEX_HEAD}  ${title}\n\n\n${rows.map(([name, said], row) => `${row === at ? "›" : " "} ${row + 1}. ${`${name}${row === 1 ? " (current)" : ""}`.padEnd(width)}  ${said}`).join("\n")}\n\n${footer(at)}\n`;
}
const codexModels = (at: number, footer: (row: number) => string = () => CODEX_OPENS) => codexList("Select Model and Effort", CODEX_MODELS, at, footer);
/** the levels of a model: every level picks, and the last row opens the list of the advanced ones */
const codexLevels = (at: number, model = "GPT-6-Astra") => codexList(`Select Reasoning Level for ${model}`, CODEX_LEVELS, at, (row) => row === 4 ? CODEX_OPENS : CODEX_PICKS);

// Claude Code 2.1.294's `/effort` slider with ▲ over level `at` (low, medium, high, xhigh, max),
// as it draws it under the command that opened it. 2.1.311 draws the same with Ultracode's switch
// on: "Ultracode  on", and its line under the names (null: no switch, as for a model without it)
const CLAUDE_EFFORT_ARROW = [0, 10, 20, 30, 41];
const CLAUDE_EFFORT_HINT = "  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel";
function claudeEffort(at: number, hint = CLAUDE_EFFORT_HINT, ultracode: "on" | "off" | null = "off", key = "Tab"): string {
  // without the switch's column the slider stands further right
  const pad = " ".repeat(ultracode === null ? 39 : 29);
  const track = `${"─".repeat(CLAUDE_EFFORT_ARROW[at]!)}▲${"─".repeat(41 - CLAUDE_EFFORT_ARROW[at]!)}`;
  const names = "low     medium     high     xhigh      max";
  if (ultracode === null) return `❯ /effort\n${"─".repeat(120)}\n  Effort\n\n${pad}Faster${" ".repeat(29)}Smarter\n${pad}${track}\n${pad}${names}\n\n${hint}\n`;
  const under = ultracode === "on" ? `${pad}Ultracode: dynamic workflows on every task` : "";
  return `❯ /effort\n${"─".repeat(120)}\n  Effort\n\n${pad}Faster${" ".repeat(29)}Smarter\n${pad}${track}      Ultracode  ${ultracode}\n${pad}${names}      ${key} to toggle\n${under}\n\n${hint}\n`;
}
// what the slider leaves once `s` applied the switch alone (Claude Code 2.1.311)
const CLAUDE_ULTRACODE_SET = `❯ /effort\n  ⎿  Ultracode on (this session only): dynamic workflows on every task. Effort stays high.\n${"─".repeat(105)} ultracode ─\n❯\n${"─".repeat(120)}\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n`;
// what the slider leaves once `s` picked a level
const CLAUDE_EFFORT_SET = `❯ /effort\n  ⎿  Set effort level to medium (this session only): Balanced approach with standard implementation and testing\n${"─".repeat(120)}\n❯\n${"─".repeat(120)}\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\n`;

describe("Claude Code's effort slider", () => {
  test("reads the levels it draws, whatever level ▲ stands over", () => {
    // the capture itself, so that the drawing above is checked against what Claude drew
    const captured = `❯ /effort
${"─".repeat(120)}
  Effort

                             Faster                             Smarter
                             ──────────▲───────────────────────────────      Ultracode  off
                             low     medium     high     xhigh      max      Tab to toggle


  ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
`;
    expect(claudeEffort(1)).toBe(captured);
    const prompt = parseInteractivePrompt("claude", captured)!;
    expect(prompt).toMatchObject({ agent: "claude", kind: "question", title: "", question: "Set effort for this session", body: null, multi_select: false, custom_option_index: null });
    // the levels, then Ultracode's switch in the card's own words
    expect(labels(prompt)).toEqual(["low", "medium", "high", "xhigh", "max", "Turn Ultracode on"]);
    expect(prompt.own_text).toEqual({
      question: { key: "Set effort for this session" },
      labels: { 5: { key: "Turn Ultracode on" } },
      descriptions: { 5: { key: "Keeps the effort level, for this session only" } },
    });
    // one card wherever ▲ stands
    for (const at of [0, 2, 3, 4]) expect(parseInteractivePrompt("claude", claudeEffort(at))!.id).toBe(prompt.id);
    // herdr reports the pane idle while the slider waits: no other agent's reader takes it for its own
    for (const agent of ["codex", "omp", "pi", "omo", ""]) expect(parseInteractivePrompt(agent, captured)).toBeNull();
  });

  test("reads 2.1.301's slider, which describes the level between the names and the hint", () => {
    // captures from Claude Code 2.1.301: one line under the names at low, two at max
    const rule = "▔".repeat(120);
    const low = `❯ /effort
${rule}
   Effort

                             Faster                             Smarter
                             ─▲────────────────────────────────────────      Ultracode  off
                             low     medium     high     xhigh      max      Tab to toggle

                                    ~0.7x the estimated cost of medium (the default)


   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
`;
    const max = `❯ /effort
${rule}
   Effort

                             Faster                             Smarter
                             ────────────────────────────────────────▲─      Ultracode  off
                             low     medium     high     xhigh      max      Tab to toggle

    May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.
    (~5.2x)

   ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
`;
    const atLow = parseInteractivePrompt("claude", low)!;
    expect(labels(atLow)).toEqual(["low", "medium", "high", "xhigh", "max", "Turn Ultracode on"]);
    expect(answerKeys(atLow, { option_index: 2 })).toEqual([{ keys: ["right"] }, { keys: ["right"] }, { text: "s" }]);
    const atMax = parseInteractivePrompt("claude", max)!;
    expect(atMax.id).toBe(atLow.id);
    expect(answerKeys(atMax, { option_index: 3 })).toEqual([{ keys: ["left"] }, { text: "s" }]);
    // the description a narrow pane wrapped over more lines is still between the names and the hint
    const wrapped = max.replace("Use sparingly for the hardest tasks.", "\n    Use sparingly\n    for the hardest tasks.");
    expect(labels(parseInteractivePrompt("claude", wrapped)!)).toEqual(["low", "medium", "high", "xhigh", "max", "Turn Ultracode on"]);
  });

  test("moves with ←/→ from the level ▲ is over and picks with s, never with Enter", () => {
    const prompt = parseInteractivePrompt("claude", claudeEffort(2))!;
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ text: "s" }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["left"] }, { keys: ["left"] }, { text: "s" }]);
    expect(answerKeys(prompt, { option_index: 4 })).toEqual([{ keys: ["right"] }, { keys: ["right"] }, { text: "s" }]);
    expect(answerKeys(parseInteractivePrompt("claude", claudeEffort(4))!, { option_index: 3 })).toEqual([{ keys: ["left"] }, { text: "s" }]);
    // Ultracode's switch: Tab flips it in the dialog, and only `s` applies it, at the level ▲ is over
    expect(answerKeys(prompt, { option_index: 5 })).toEqual([{ keys: ["tab"] }, { text: "s" }]);
    expect(() => answerKeys(prompt, { custom_text: "high" })).toThrow();
    expect(() => answerKeys(prompt, { option_index: 6 })).toThrow();
  });

  test("reads the slider while Ultracode is on, which draws Claude's own line under the names (#2232)", () => {
    // the drawings above, checked against what Claude Code 2.1.311 drew with ▲ over xhigh
    const recorded = (state: string) => readFileSync(new URL(`./fixtures/claude-effort-2.1.311-${state}-120.txt`, import.meta.url), "utf8");
    expect(recorded("on").endsWith(claudeEffort(3, CLAUDE_EFFORT_HINT, "on").replace("❯ /effort\n", ""))).toBe(true);
    expect(recorded("off").endsWith(claudeEffort(3).replace("❯ /effort\n", ""))).toBe(true);
    expect(recorded("none").endsWith(claudeEffort(3, CLAUDE_EFFORT_HINT, null).replace("❯ /effort\n", ""))).toBe(true);
    const on = parseInteractivePrompt("claude", claudeEffort(2, CLAUDE_EFFORT_HINT, "on"))!;
    expect(labels(on)).toEqual(["low", "medium", "high", "xhigh", "max", "Turn Ultracode off"]);
    expect(on.own_text?.labels).toEqual({ 5: { key: "Turn Ultracode off" } });
    // the description names no level: ▲ still has no part in the card's id
    expect(on.options[5]!.description).toBe("Keeps the effort level, for this session only");
    for (const at of [0, 1, 3, 4]) expect(parseInteractivePrompt("claude", claudeEffort(at, CLAUDE_EFFORT_HINT, "on"))!.id).toBe(on.id);
    // the switch's state is part of the card: the answer for one state is no answer for the other
    expect(on.id).not.toBe(parseInteractivePrompt("claude", claudeEffort(2))!.id);
    expect(answerKeys(on, { option_index: 0 })).toEqual([{ keys: ["left"] }, { keys: ["left"] }, { text: "s" }]);
    expect(answerKeys(on, { option_index: 5 })).toEqual([{ keys: ["tab"] }, { text: "s" }]);
    // the line cut short by the pane is still Claude's
    expect(parseInteractivePrompt("claude", claudeEffort(2, CLAUDE_EFFORT_HINT, "on").replace("dynamic workflows on every task", "dynamic workflows…"))!.id).toBe(on.id);
    expect(registry.waits("claude", claudeEffort(2, CLAUDE_EFFORT_HINT, "on"))).toBe(true);
    // the switch applied: no card, and nothing held
    expect(parseInteractivePrompt("claude", CLAUDE_ULTRACODE_SET)).toBeNull();
    expect(registry.waits("claude", CLAUDE_ULTRACODE_SET)).toBe(false);
  });

  test("offers no switch row where the slider draws no switch, or names a key the card does not send", () => {
    // a model without Ultracode, or dynamic workflows off: the levels alone
    const none = parseInteractivePrompt("claude", claudeEffort(2, CLAUDE_EFFORT_HINT, null))!;
    expect(labels(none)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(() => answerKeys(none, { option_index: 5 })).toThrow();
    // the user bound the switch to another key: the levels stay, the switch is the terminal's
    for (const key of ["ctrl+u", "Shift+Tab", "ctrl+x ctrl+u"]) {
      for (const state of ["on", "off"] as const) {
        const rebound = parseInteractivePrompt("claude", claudeEffort(2, CLAUDE_EFFORT_HINT, state, key));
        expect(labels(rebound), `${key} ${state}`).toEqual(["low", "medium", "high", "xhigh", "max"]);
      }
    }
    // or unbound it: Claude draws the switch's state alone, no key's line with it
    for (const state of ["on", "off"] as const) {
      const unbound = parseInteractivePrompt("claude", claudeEffort(2, CLAUDE_EFFORT_HINT, state).replace("      Tab to toggle", ""));
      expect(labels(unbound), state).toEqual(["low", "medium", "high", "xhigh", "max"]);
      expect(parsedByPublicPrompt.get(unbound!)?.claudeUltracode, state).toBe(state === "on");
    }
  });

  test("offers no card where the switch and Claude's line for it disagree, or the switch is half drawn", () => {
    const on = claudeEffort(2, CLAUDE_EFFORT_HINT, "on");
    const off = claudeEffort(2);
    const broken = [
      // Claude's line under the names while the switch reads off, and none while it reads on
      on.replace("Ultracode  on", "Ultracode  off"),
      off.replace("Ultracode  off", "Ultracode  on"),
      // a drawn switch keeps the line under the names for its own: no level's description there
      off.replace("Tab to toggle\n\n", "Tab to toggle\n     May use excessive tokens resulting in long response times or overthinking.\n"),
      // the key without its state, beside the slider or right under the names
      off.replace("      Ultracode  off", ""),
      claudeEffort(2, CLAUDE_EFFORT_HINT, null).replace("max\n\n", "max\n                             Tab to toggle\n\n"),
      // the line with no switch at all
      claudeEffort(2, CLAUDE_EFFORT_HINT, null).replace("max\n\n", "max\n                             Ultracode: dynamic workflows on every task\n"),
      // the switch beside the slider and again under it, as a narrow pane draws it, its key unbound or not
      off.replace("Tab to toggle\n\n\n", "Tab to toggle\n\n\n                       Ultracode  off\n                       Tab to toggle\n\n"),
      off.replace("      Tab to toggle\n\n\n", "\n\n\n                       Ultracode  off\n\n"),
    ];
    for (const screen of broken) {
      expect(parseInteractivePrompt("claude", screen), screen).toBeNull();
      expect(registry.waits("claude", screen)).toBe(true);
    }
  });

  test("reads the slider of a pane under 70 columns, its switch on two lines of its own under the names", () => {
    // as Claude Code 2.1.311 draws it at 60 columns, the hint wrapped too
    const narrow = (at: number, ultracode: "on" | "off") => `❯ /effort\n${"─".repeat(60)}\n  Effort\n\n         Faster                             Smarter\n`
      + `         ${"─".repeat(CLAUDE_EFFORT_ARROW[at]!)}▲${"─".repeat(41 - CLAUDE_EFFORT_ARROW[at]!)}\n         low     medium     high     xhigh      max\n`
      + `${ultracode === "on" ? "         Ultracode: dynamic workflows on every task" : ""}\n\n                       Ultracode  ${ultracode}\n                       Tab to toggle\n\n`
      + "  ←/→ to adjust · Enter to confirm · s for this session\n  only · Esc to cancel\n";
    const off = parseInteractivePrompt("claude", narrow(3, "off"))!;
    expect(labels(off)).toEqual(["low", "medium", "high", "xhigh", "max", "Turn Ultracode on"]);
    expect(answerKeys(off, { option_index: 2 })).toEqual([{ keys: ["left"] }, { text: "s" }]);
    const on = parseInteractivePrompt("claude", narrow(3, "on"))!;
    expect(labels(on)).toEqual(["low", "medium", "high", "xhigh", "max", "Turn Ultracode off"]);
    expect(parseInteractivePrompt("claude", narrow(0, "on"))!.id).toBe(on.id);
    // the key's line alone, a blank line under it, is never read as the names: names a pane cut
    // or wrapped still give no card
    const wrapped = narrow(3, "off").replace("high     xhigh      max", "high\n         xhigh      max");
    expect(parseInteractivePrompt("claude", wrapped)).toBeNull();
    expect(registry.waits("claude", wrapped)).toBe(true);
    // a switch drawn twice, its key drawn twice or right under the names, or a key line without its
    // state is no drawing of Claude's. A state line alone is: the key unbound
    const drawn = narrow(3, "off");
    for (const screen of [
      drawn.replace("Tab to toggle\n", "Tab to toggle\n                       Ultracode  off\n                       Tab to toggle\n"),
      drawn.replace("Tab to toggle\n", "Tab to toggle\n                       Tab to toggle\n"),
      drawn.replace("                       Tab to toggle\n", "").replace("Ultracode  off\n", "Ultracode  off\n                       Ultracode  off\n"),
      drawn.replace("                       Ultracode  off\n", ""),
      drawn.replace("max\n", "max\n                       Tab to toggle\n"),
    ]) expect(parseInteractivePrompt("claude", screen), screen).toBeNull();
    expect(labels(parseInteractivePrompt("claude", drawn.replace("                       Tab to toggle\n", ""))))
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("offers no card for a slider that is not waiting, or that it cannot read", () => {
    expect(parseInteractivePrompt("claude", CLAUDE_EFFORT_SET)).toBeNull();
    // the slider's text left above later output takes no key any more, and holds no message back
    expect(parseInteractivePrompt("claude", `${claudeEffort(2)}Some later output\nand more\n`)).toBeNull();
    expect(registry.waits("claude", `${claudeEffort(2)}Some later output\nand more\n`)).toBe(false);
    expect(registry.waits("claude", claudeEffort(2))).toBe(true);
    expect(registry.waits("claude", CLAUDE_EFFORT_SET)).toBe(false);
    // a slider that takes Enter alone would save the level as the default: not this card's to press
    expect(parseInteractivePrompt("claude", claudeEffort(2, "  ←/→ to adjust · Enter to confirm · Esc to cancel"))).toBeNull();
    // level names a narrow pane wrapped: no card, and the slider still holds the screen
    const wrapped = claudeEffort(2).replace("low     medium     high     xhigh      max      Tab to toggle", "low     medium     high\n  xhigh      max");
    expect(parseInteractivePrompt("claude", wrapped)).toBeNull();
    expect(registry.waits("claude", wrapped)).toBe(true);
    // ▲ between two levels stands over neither
    const between = claudeEffort(2).replace(`${"─".repeat(20)}▲${"─".repeat(21)}`, `${"─".repeat(15)}▲${"─".repeat(26)}`);
    expect(between).not.toBe(claudeEffort(2));
    expect(parseInteractivePrompt("claude", between)).toBeNull();
  });
});

describe("Codex's model lists", () => {
  test("reads the list of models, whose rows open the next list", () => {
    // the capture itself, so that the drawing above is checked against what Codex drew
    const captured = `  Select Model and Effort


  1. GPT-6.1-Sol (default)  Latest workhorse model for coding and everyday work.
› 2. GPT-6-Astra (current)  Frontier intelligence for the most demanding work.
  3. GPT-6-Sol              Previous generation workhorse model.
  4. GPT-6-Luna             Fast and affordable model for easier tasks.
  5. GPT-5.6-Sol            Older generation workhorse model.
  6. GPT-5.6-Terra          Older balanced model for straightforward work.
  7. GPT-5.6-Luna           Older fast and efficient model.

  enter select · esc back
`;
    expect(codexModels(1)).toBe(`${CODEX_HEAD}${captured}`);
    const prompt = parseInteractivePrompt("codex", codexModels(1))!;
    expect(prompt).toMatchObject({ agent: "codex", kind: "question", title: "", body: null, multi_select: false, custom_option_index: null });
    expect(prompt.question).toBe("Select model for this session (currently GPT-6-Astra)");
    expect(prompt.options).toEqual(CODEX_MODELS.map(([label, description]) => ({ label, description })));
    // the row's key is the screen's to name once the cursor is on it: the card only knows the moves
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { pick: true }]);
    expect(answerKeys(prompt, { option_index: 1 })).toEqual([{ pick: true }]);
    for (const agent of ["claude", "omp", "pi", "omo", ""]) expect(parseInteractivePrompt(agent, codexModels(1))).toBeNull();
  });

  test("reads a model's reasoning levels without the row that opens the advanced ones", () => {
    const captured = `  Select Reasoning Level for GPT-6-Astra


  1. Low                         Fast responses with lighter reasoning
› 2. Medium (default) (current)  Balances speed and reasoning depth for everyday tasks
  3. High                        Greater reasoning depth for complex problems
  4. Extra high                  Extra high reasoning depth for complex problems
  5. More reasoning…             Max and Ultra consume usage limits faster

  enter default · s session · esc back
`;
    expect(codexLevels(1)).toBe(`${CODEX_HEAD}${captured}`);
    const prompt = parseInteractivePrompt("codex", codexLevels(1))!;
    // "More reasoning…" takes Enter, beside levels whose Enter saves a default: left to the terminal
    expect(prompt.question).toBe("Select reasoning level for GPT-6-Astra for this session (currently Medium). More levels are listed in the terminal.");
    expect(prompt.options).toEqual(CODEX_LEVELS.slice(0, 4).map(([label, description]) => ({ label, description })));
    expect(() => answerKeys(prompt, { option_index: 4 })).toThrow();
    // with the cursor on that row in the terminal, its footer is the one of a row that opens a
    // list: the same card, and the moves to a level count from where the cursor is
    expect(codexLevels(4)).toContain("› 5. More reasoning…             Max and Ultra consume usage limits faster\n\n  enter select · esc back\n");
    const onMore = parseInteractivePrompt("codex", codexLevels(4))!;
    expect(onMore.id).toBe(prompt.id);
    expect(answerKeys(onMore, { option_index: 2 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { pick: true }]);
    // any other row under the cursor whose footer says it only opens a list is not offered either
    const opener = codexList("Select Reasoning Level for GPT-6-Astra", CODEX_LEVELS.slice(0, 4), 2, () => CODEX_OPENS);
    expect(labels(parseInteractivePrompt("codex", opener))).toEqual(["Low", "Medium (default)", "Extra high"]);
    // the levels of another model are another card
    expect(parseInteractivePrompt("codex", codexLevels(1, "GPT-6-Sol"))!.id).not.toBe(prompt.id);
  });

  test("reads the advanced levels with what Codex says over them, wrapped by a phone's pane", () => {
    const wide = `${CODEX_HEAD}  Advanced Reasoning
  ⚠ Consumes usage limits faster


› 1. Max    For difficult problems when quality matters more than speed · higher usage
  2. Ultra  For demanding work using multiple agents · highest usage

  enter default · s session · esc back
`;
    const prompt = parseInteractivePrompt("codex", wide)!;
    expect(prompt.question).toBe("Select advanced reasoning for this session");
    expect(prompt.body).toBe("⚠ Consumes usage limits faster");
    expect(prompt.options).toEqual([
      { label: "Max", description: "For difficult problems when quality matters more than speed · higher usage" },
      { label: "Ultra", description: "For demanding work using multiple agents · highest usage" },
    ]);
    // the capture at 46 columns, with the cursor moved to Ultra, whose Enter applies it at once
    const phone = `  It’s dangerous to code alone. Take a prompt.

  Advanced Reasoning
  ⚠ Consumes usage limits faster


  1. Max    For difficult problems when
            quality matters more than speed ·
            higher usage
› 2. Ultra  For demanding work using multiple
            agents · highest usage

  enter apply · s session · esc back
`;
    expect(parseInteractivePrompt("codex", phone)!.options).toEqual(prompt.options);
    expect(parseInteractivePrompt("codex", phone)!.id).toBe(prompt.id);
  });

  test("reads the names alone where the pane has no room for what a row says", () => {
    // 46 columns: Codex leaves the second column out
    const phone = `  Select Reasoning Level for GPT-6-Astra


  1. Low
› 2. Medium (default) (current)
  3. High
  4. Extra high
  5. More reasoning…

  enter default · s session · esc back
`;
    const prompt = parseInteractivePrompt("codex", phone)!;
    expect(prompt.question).toBe("Select reasoning level for GPT-6-Astra for this session (currently Medium). More levels are listed in the terminal.");
    expect(prompt.options).toEqual(CODEX_LEVELS.slice(0, 4).map(([label]) => ({ label, description: null })));
  });

  test("knows a list by the header right above its rows, wrapped or under the conversation's last line", () => {
    // a pane too narrow for the levels' title: the model's name wraps under it
    const wrapped = `  Select Reasoning Level for
  GPT-5.6-Terra


  1. Low
› 2. Medium (default) (current)
  3. High

  enter default · s session ·
  esc back
`;
    const prompt = parseInteractivePrompt("codex", wrapped)!;
    expect(prompt.question).toBe("Select reasoning level for GPT-5.6-Terra for this session (currently Medium)");
    expect(prompt.body).toBeNull();
    expect(labels(prompt)).toEqual(["Low", "Medium (default)", "High"]);
    // no blank between the conversation's last line and the title: the lines over the title are not the list's
    const under = codexLevels(1).replace("Got an idea?\n\n  Select", "Got an idea?\n  Select");
    expect(under).not.toBe(codexLevels(1));
    expect(parseInteractivePrompt("codex", under)!.id).toBe(parseInteractivePrompt("codex", codexLevels(1))!.id);
    // another list's header between a model list's title and the rows: the rows are that list's
    const other = `  Select Model and Effort\n\n  Select Approval Mode\n\n› 1. Read only\n  2. Full access\n\n${CODEX_OPENS}\n`;
    expect(parseInteractivePrompt("codex", other)).toBeNull();
    expect(parseInteractivePrompt("codex", other.replace("\n\n  Select Approval Mode", "\n  Select Approval Mode\n  Choose what Codex may do\n  without asking"))).toBeNull();
  });

  test("keeps a gap inside one row's name out of what the rows say", () => {
    // names alone, one of them written with two spaces: no column of descriptions to split it at
    const names = `  Select Model and Effort\n\n\n› 1. Custom  Model (current)\n  2. GPT-6-Sol\n  3. GPT-6-Luna\n\n${CODEX_OPENS}\n`;
    const prompt = parseInteractivePrompt("codex", names)!;
    expect(prompt.options).toEqual([{ label: "Custom Model", description: null }, { label: "GPT-6-Sol", description: null }, { label: "GPT-6-Luna", description: null }]);
    expect(prompt.question).toBe("Select model for this session (currently Custom Model)");
    // and beside a column the other rows share
    const beside = codexModels(1).replace("  3. GPT-6-Sol              Previous generation workhorse model.", "  3. GPT  6 Sol");
    expect(parseInteractivePrompt("codex", beside)!.options[2]).toEqual({ label: "GPT 6 Sol", description: null });
    expect(parseInteractivePrompt("codex", beside)!.options[3]).toEqual({ label: "GPT-6-Luna", description: "Fast and affordable model for easier tasks." });
  });

  test("offers no card for another list of Codex's, or for one that is not waiting", () => {
    // the footer is every Codex list's: only the model lists' titles make it this card
    expect(parseInteractivePrompt("codex", codexList("Select Approval Mode", CODEX_LEVELS, 1, () => CODEX_OPENS))).toBeNull();
    // the list of quick presets, which mixes rows that pick with rows that open a list and was
    // never looked at live: left to the terminal
    expect(parseInteractivePrompt("codex", codexList("Select Model", CODEX_MODELS, 1, () => CODEX_PICKS))).toBeNull();
    expect(parseInteractivePrompt("codex", codexList("Select Reasoning Level for GPT-6-Astra", CODEX_LEVELS, 1, () => "  enter confirm · esc back"))).toBeNull();
    // answered, with Codex's own prompt under it
    expect(parseInteractivePrompt("codex", `${codexLevels(1)}• Model changed to gpt-6-astra medium for this session only\n› Ask Codex to do anything\n`)).toBeNull();
    // no cursor on a row, or one row alone
    expect(parseInteractivePrompt("codex", codexLevels(1).replace("› 2. ", "  2. "))).toBeNull();
    expect(parseInteractivePrompt("codex", codexList("Select Model and Effort", CODEX_MODELS.slice(0, 1), 0, () => CODEX_OPENS))).toBeNull();
    // anything between the rows and their footer
    expect(parseInteractivePrompt("codex", codexLevels(1).replace(`\n\n${CODEX_PICKS}`, `\n  Loading…\n${CODEX_PICKS}`))).toBeNull();
  });
});

// The answer route against a herdr that only holds a screen: what the pane shows is the test's to
// change, between two reads or under an answer's own keys, and every key the route sends is kept.
describe("an answer and the menu it was made for", () => {
  interface Pane {
    agent: string; status: string; screen: string; sent: string[]; onSent?: (sent: string) => void;
    /** the pane's folder and its Codex rollout, for a prompt named by the agent's own call */
    cwd?: string; rollout?: string;
    /** how long herdr takes over each screen read from now on */
    readDelay?: number;
    onRead?: () => void;
    /** fail this screen read, without claiming that the screen is empty */
    nextReadFails?: boolean;
    /** herdr never answers what it is asked about the pane's agent */
    agentUnanswered?: boolean;
    /** what an ANSI read shows instead of `screen`: the pane's viewport, scrolled off its live screen */
    viewport?: string;
    /** A text viewport scrolled away from detection's live drawing. */
    visibleScreen?: string;
    /** the next screen read alone answers with this, that much later */
    nextRead?: { text: string; delay: number };
    /** herdr presses this key and its reply is lost on the way */
    replyLostOn?: string;
    /** herdr answers the next key only once this settles: what happens while a key is on its way */
    holdSend?: Promise<unknown>;
    /** the next screen read is taken as the screen is when it arrives, and answered only once this settles */
    holdRead?: Promise<unknown>;
    /** a held screen read has arrived */
    onReadHeld?: () => void;
    /** more panes showing the same screen: p_2 … */
    more?: number;
    /** the next snapshot alone takes this long */
    nextSnapshotDelay?: number;
    root: string;
    omo?: { pid: number; path: string; live: boolean };
    /** an omp pane's omp is stopped behind its shell: herdr still names the pane omp, its foreground is the shell */
    ompStopped?: boolean;
    /** a pi pane's pi has ended: herdr still names the pane pi, its foreground is the shell */
    piGone?: boolean;
  }

  async function withPane(agent: string, status: string, screen: string, run: (pane: Pane) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "herdr-prompt-answer-"));
    const path = join(root, "herdr.sock");
    const pane: Pane = { agent, status, screen, sent: [], root };
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input.split("\n")[0]!) as { id: string; method: string; params: { keys?: string[]; text?: string; format?: string; source?: string } };
        const answer = (result: unknown) => socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
        const snapshotDelay = request.method === "session.snapshot" ? pane.nextSnapshotDelay : undefined;
        if (snapshotDelay !== undefined) pane.nextSnapshotDelay = undefined;
        if (request.method === "session.snapshot") return void setTimeout(() => answer({ snapshot: { panes: Array.from({ length: 1 + (pane.more ?? 0) }, (_, index) => ({ pane_id: `p_${index + 1}`, agent: pane.agent, agent_status: pane.status, cwd: pane.cwd, ...(pane.omo ? { agent_session: { agent: "omo", kind: "path", value: pane.omo.path } } : {}) })), layouts: [] } }), snapshotDelay ?? 0);
        if (request.method === "pane.read") {
          pane.onRead?.();
          if (pane.nextReadFails) {
            pane.nextReadFails = false;
            return void socket.destroy();
          }
          const gate = pane.holdRead;
          if (gate) {
            pane.holdRead = undefined;
            const text = request.params.source === "visible" && pane.visibleScreen !== undefined ? pane.visibleScreen : request.params.format === "ansi" ? pane.viewport ?? pane.screen : pane.screen;
            pane.onReadHeld?.();
            return void gate.then(() => answer({ read: { text } }));
          }
          const once = pane.nextRead;
          pane.nextRead = undefined;
          if (once) return void setTimeout(() => answer({ read: { text: once.text } }), once.delay);
          return void setTimeout(() => answer({ read: { text: request.params.source === "visible" && pane.visibleScreen !== undefined ? pane.visibleScreen : request.params.format === "ansi" ? pane.viewport ?? pane.screen : pane.screen } }), pane.readDelay ?? 0);
        }
        if (request.method === "pane.process_info") return answer({ process_info: { foreground_processes: pane.omo?.live ? [{ pid: pane.omo.pid, argv: ["omo"] }]
          : pane.agent === "omp" ? [pane.ompStopped ? { pid: 4100, argv: ["/bin/bash"] } : { pid: 4242, argv: ["omp"] }]
          : pane.agent === "pi" ? [pane.piGone ? { pid: 4100, argv: ["/bin/bash"] } : { pid: 4343, argv: ["node", "/usr/local/bin/pi"] }]
          // a Codex pane runs Codex: its rollout is read only while one does
          : pane.agent === "codex" ? [{ pid: 2147483647, argv: ["/usr/bin/codex"] }] : [] } });
        // a pane whose scroll herdr does not report: a colored read counts when its text is the live screen's
        if (request.method === "pane.get") return answer({ pane: { pane_id: "p_1" } });
        if (request.method === "agent.get" && pane.agentUnanswered) return;
        if (request.method === "agent.get") return answer({ agent: pane.rollout ? { agent_session: { kind: "path", value: pane.rollout } } : {} });
        if (request.method !== "pane.send_keys" && request.method !== "pane.send_text") throw new Error(`unexpected fixture RPC: ${request.method}`);
        let lost = false;
        for (const sent of request.params.keys ?? [`text:${request.params.text}`]) {
          pane.sent.push(sent);
          pane.onSent?.(sent);
          lost ||= sent === pane.replyLostOn;
        }
        if (lost) return void socket.destroy();
        const held = pane.holdSend;
        pane.holdSend = undefined;
        if (held) return void held.then(() => answer({}));
        answer({});
      });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    const previous = process.env["HERDR_SOCKET"];
    process.env["HERDR_SOCKET"] = path;
    try { await run(pane); } finally {
      if (previous === undefined) delete process.env["HERDR_SOCKET"];
      else process.env["HERDR_SOCKET"] = previous;
      for (const socket of sockets) socket.destroy();
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  async function card(codexHome?: string, paneId = "p_1"): Promise<InteractivePrompt | null> {
    const url = new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${paneId}`);
    return ((await (await handlePromptRequest(new Request(url), url, { codexHome }))!.json()) as { prompt: InteractivePrompt | null }).prompt;
  }

  async function answer(promptId: string, choice: { option_index?: number; option_indices?: number[]; custom_text?: string; step_back?: boolean; step_index?: number }, more: { signal?: AbortSignal; codexHome?: string } = {}): Promise<{ status: number; code?: string }> {
    const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
    const response = (await handlePromptRequest(new Request(url, { method: "POST", signal: more.signal, body: JSON.stringify({ pane_id: "p_1", prompt_id: promptId, ...choice }) }), url, { codexHome: more.codexHome }))!;
    const body = await response.json() as { error?: { code: string } };
    return { status: response.status, code: body.error?.code };
  }

  // #2106 review: omp 18.13's approval menu on a terminal without extended key reporting, where Ctrl+J and Ctrl+M arrive
  // as LF and CR and Ctrl+Enter and Shift+Enter as CR, all read as Enter, which takes the highlighted row (Approve when the
  // panel opens); Ctrl+H and Ctrl+I arrive as Backspace and Tab. omp matches what arrives against its bindings: approve
  // first, then deny, then the arrows, then Enter
  test.each([
    ["Ctrl+J", "ctrl+j"], ["Ctrl+M", "ctrl+m"], ["Ctrl+\u23ce", "ctrl+enter"], ["\u21e7\u23ce", "shift+enter"], ["Ctrl+I", "ctrl+i"], ["\u238b", "esc"],
  ] as const)("denies when omp's Deny is bound to %s, on a terminal that delivers it as another key", async (deny, denyName) => {
    // two actions never share a binding: with Deny on Ctrl+\u23ce, Approve keeps only Ctrl+Q
    const approveDrawn = denyName === "ctrl+enter" ? "Ctrl+Q" : "Ctrl+\u23ce/Ctrl+Q";
    const approveNames = denyName === "ctrl+enter" ? ["ctrl+q"] : ["ctrl+enter", "ctrl+q"];
    const shown = readFileSync(new URL("./fixtures/omp-approval-18.13.2-unicode-wide.txt", import.meta.url), "utf8")
      .replace("Ctrl+\u23ce/Ctrl+Q approve \u00b7 \u238b deny \u00b7", `${approveDrawn} approve \u00b7 ${deny} deny \u00b7`);
    expect(shown).toContain(`${approveDrawn} approve \u00b7 ${deny} deny`);
    const rows = ["approved", "approved for the session", "denied"];
    const legacy = (key: string): string => /^(?:ctrl\+[jm]|(?:ctrl|shift)\+enter)$/.test(key) ? "enter"
      : key === "ctrl+h" ? "backspace" : key === "ctrl+i" ? "tab" : key;
    /** what omp 18.13 does with the keys the bridge sent, as a legacy terminal delivers them */
    const outcome = (sent: string[]): string => {
      let cursor = 0;
      for (const key of sent) {
        const received = legacy(key);
        if (approveNames.includes(received)) return "approved";
        if (received === denyName) return "denied";
        if (received === "up") cursor = (cursor + rows.length - 1) % rows.length;
        else if (received === "down") cursor = (cursor + 1) % rows.length;
        else if (received === "enter") return rows[cursor]!;
      }
      return "waiting";
    };
    // omp redraws its cursor as the arrows arrive, which the bridge reads back before it selects
    const lines = shown.split("\n");
    const top = lines.findIndex((line) => line.startsWith("\u2502 \u276f Approve "));
    expect(top).toBeGreaterThan(0);
    const drawn = (cursor: number) => lines.map((line, index) => index < top || index > top + 2 ? line
      : `\u2502 ${index - top === cursor ? "\u276f" : " "} ${line.slice(4)}`).join("\n");
    expect(drawn(0)).toBe(shown);
    for (const [option, expected] of [[2, "denied"], [0, "approved"], [1, "approved for the session"]] as const) {
      await withPane("omp", "blocked", shown, async (pane) => {
        let cursor = 0;
        pane.onSent = (key) => {
          if (key === "up") cursor = (cursor + rows.length - 1) % rows.length;
          else if (key === "down") cursor = (cursor + 1) % rows.length;
          pane.screen = drawn(cursor);
        };
        const shownCard = await card();
        expect(shownCard?.options.map((row) => row.label)).toEqual(["Approve", "Approve bash for this session", "Deny"]);
        expect(await answer(shownCard!.id, { option_index: option })).toEqual({ status: 200, code: undefined });
        expect(outcome(pane.sent), `${deny} option ${option}: ${pane.sent.join(",")}`).toBe(expected);
      });
    }
  });

  test.each(["whole", "heading-only", "command-only", "command-middle"])("refuses an old cmd heredoc card with a quoted native frame (%s)", async (layout) => {
    const screen = (prefix: string) => {
      const shown = [
        "─".repeat(60), "", "Execute Shell Command",
        `Command Code needs to execute ${prefix}; cat <<'EOF'`,
        "─".repeat(40), "", "Execute Shell Command", "Command Code needs to execute echo quoted.", "EOF.",
        "", "Press [ctrl+e] to explain this command", "",
        "❯ 1. Yes", "  2. Yes, don't ask again for `printf` commands in this project",
        "  3. No, tell Command Code what to do differently", "",
        "↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to bypass all permissions (Docs ↗)",
      ];
      if (layout === "command-middle") return ["  printf a", `  ${prefix}`, "  cat <<'EOF'", ...shown.slice(4)].join("\n");
      return layout === "command-only"
        ? [`  ${prefix}; cat <<'EOF'`, ...shown.slice(4)].join("\n")
        : shown.slice(layout === "heading-only" ? 2 : 0).join("\n");
    };
    await withPane("cmd", "blocked", screen("printf harmless"), async (pane) => {
      const first = await card();
      expect(first).not.toBeNull();
      if (first === null) throw new Error("cmd permission fixture did not produce a card");
      pane.screen = screen("printf secrets >/tmp/leaked");
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  test("refuses an old cmd heredoc card after delimiter indentation changes execution", async () => {
    const screen = (indent: string) => [
      "─".repeat(40), "", "Execute Shell Command", "Command Code needs to execute cat <<'EOF'",
      "─".repeat(40), `${indent}EOF`, "printf secrets >/tmp/leaked", ": <<'EOF'", "EOF", "printf done.",
      "", "Press [ctrl+e] to explain this command", "", "❯ 1. Yes",
      "  2. Yes, don't ask again for `cat` commands in this project",
      "  3. No, tell Command Code what to do differently", "",
      "↑/↓ navigate · enter select · ctrl+e explain · Run cmd --yolo to bypass all permissions (Docs ↗)",
    ].join("\n");
    await withPane("cmd", "blocked", screen("  "), async (pane) => {
      const first = await card();
      expect(first).not.toBeNull();
      if (first === null) throw new Error("cmd heredoc fixture did not produce a card");
      pane.screen = screen("");
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  const omoRule = "─".repeat(100);
  const omoWidget = (box = "❯") => `? Question pending (1 unanswered) · 30m
 QA — Which one?
 [ First ] [ Second ] [ own answer… ]
 enter to answer · /answer · or just type your reply
${omoRule}
${box}
${omoRule}
/tmp/work • main
(😺 OmO Native)
`;
  const omoFormScreen = (at = 0, question = "Which one?", options = ["First", "Second"]) => `${omoRule}
 Ask user · 30m
 → QA    Submit
 ${question}
${options.map((label, i) => ` ${at === i ? "→" : " "} ${i + 1}. ${label}`).join("\n")}
 ${at === options.length ? "→" : " "} Type your own answer...
 Submit (0/1 answered) — Enter advances
 ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
${omoRule}
/tmp/work • main
(😺 OmO Native)
`;
  const omoCall = (id: string, options: { label: string }[] | undefined = [{ label: "First" }, { label: "Second" }]) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "ask_user_question", arguments: { waitForAnswer: false, questions: [{ header: "QA", question: "Which one?", ...(options ? { options } : {}) }] } }] } }) + "\n";

  // These route fixtures use /proc to read an inert child's isolated agent directory.
  async function withOmo(run: (pane: Pane) => Promise<void>, options?: { label: string }[]): Promise<void> {
    await withPane("claude", "working", omoWidget(), async (pane) => {
      const agentDir = join(pane.root, "agent");
      const dir = join(agentDir, "sessions");
      mkdirSync(dir, { recursive: true });
      pane.cwd = pane.root;
      const path = join(dir, "2026-10-06T00-00-00_qa-session-488.jsonl");
      writeFileSync(path, JSON.stringify({ type: "session", id: "qa-session-488", cwd: pane.cwd, timestamp: new Date().toISOString() }) + "\n" + omoCall("q1", options));
      // An inert child supplies a real process environment; all RPCs and session files are fixtures.
      const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], { cwd: pane.cwd, stdin: "pipe", stdout: "ignore", stderr: "ignore", env: { ...process.env, OMO_CODING_AGENT_DIR: agentDir } });
      pane.omo = { pid: child.pid, path, live: true };
      promptWaitEnded("p_1");
      try { await run(pane); }
      finally { child.kill(); await child.exited; }
    });
  }

  for (const count of ["one", "two"]) for (const width of ["wide", "narrow"]) {
    test.skipIf(process.platform !== "linux")(`discovers the real 5.1.30 ${count}-question ${width} widget through the prompt route`, async () => {
      await withOmo(async (pane) => {
        appendFileSync(pane.omo!.path, JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: "q1" } }) + "\n" + omoPendingFixture(`${count}.jsonl`));
        pane.screen = omoPendingFixture(`${count}-${width}.txt`);
        pane.agent = "pi";
        pane.status = "blocked";
        const question = openOmoAsks(omoPendingFixture(`${count}.jsonl`))[0]!.questions[0]!;
        const prompt = await card();
        expect(prompt).toMatchObject({
          agent: "omo", kind: "question", question: question.question, options: question.options,
          multi_select: question.multiSelect, custom_option_index: question.multiSelect ? null : question.options.length,
        });
      });
    });
  }

  test.skipIf(process.platform !== "linux")("discovers a pending question with extension status below the input box", async () => {
    await withOmo(async (pane) => {
      appendFileSync(pane.omo!.path, JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: "q1" } }) + "\n" + omoPendingFixture("one.jsonl"));
      pane.screen = withOmoExtensionTail(omoPendingFixture("one-wide.txt"));
      pane.agent = "pi";
      pane.status = "blocked";
      expect(await card()).toMatchObject({ agent: "omo", kind: "question", multi_select: true });
    });
  });

  test.skipIf(process.platform !== "linux")("discovers a pending question with task rows below the input box", async () => {
    await withOmo(async (pane) => {
      appendFileSync(pane.omo!.path, JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: "q1" } }) + "\n" + omoPendingFixture("one.jsonl"));
      pane.screen = omoPendingFixture("one-wide.txt").replace(/(❯\n─+\n)/, `$1${omoTaskRows}`);
      pane.agent = "pi";
      pane.status = "blocked";
      expect(await card()).toMatchObject({ agent: "omo", kind: "question" });
    });
  });

  // Claude Code 2.1.294, live: a message it holds back for an invisible character
  const heldRule = "─".repeat(80);
  const heldScreen = (box: string, over = `${" ".repeat(40)}Removed 1 invisible character · review and press Enter to send`) => `
 ▐▛███▜▌   Claude Code v2.1.294
${over}
${heldRule}
${box}
${heldRule}
  [Haiku 4.5] │ project
`;

  test("sends Claude's held message only as the card showed it: a box edited in the terminal refuses the answer", async () => {
    await withPane("claude", "idle", heldScreen("❯ helloworld test"), async (pane) => {
      const shown = (await card())!;
      expect(shown.body).toBe("helloworld test");
      // edited in the terminal after the card was read: the hint stays, the message is another one
      pane.screen = heldScreen("❯ helloworld test and more");
      expect(await answer(shown.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      // sent from the terminal meanwhile: the hint lingers over an empty input
      pane.screen = heldScreen("❯");
      expect(await answer(shown.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(await answer(shown.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      // the card as the screen shows it now is answered with one Enter
      pane.screen = heldScreen("❯ helloworld test");
      const again = (await card())!;
      expect(await answer(again.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("never presses Ctrl+C for a Discard tapped before Claude went to work", async () => {
    await withPane("claude", "idle", heldScreen("❯ helloworld test"), async (pane) => {
      const shown = (await card())!;
      expect(labels(shown)).toEqual(["Send", "Discard"]);
      // a turn began under the card: Ctrl+C would interrupt it and leave the message where it is
      pane.status = "working";
      expect(await answer(shown.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      const working = (await card())!;
      expect(labels(working)).toEqual(["Send"]);
      expect((await answer(working.id, { option_index: 1 })).status).toBe(400);
      expect(pane.sent).toEqual([]);
    });
  });

  test("forgets what the chat sent once its held message is answered: the same words after it are a new message", async () => {
    // the hint has gone: only the chat's own send says the box holds a held message
    const box = heldScreen("❯ samemessage", "  ✻ Cooked for 1s · done");
    await withPane("claude", "idle", box, async (pane) => {
      expect(await card()).toBeNull();
      noteSubmitted("p_1", "same\u200bmessage");
      const shown = (await card())!;
      expect(shown.body).toBe("samemessage");
      expect(await answer(shown.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
      // typed or pasted again, without the character: nothing was taken out of this one
      expect(await card()).toBeNull();
    });
  });

  test("takes no grey placeholder or suggestion in Claude's empty box for a held message", async () => {
    // Claude Code 2.1.294, live: the empty box's own grey text (SGR 2), as herdr's ANSI read gives it
    const grey = (text: string) => `❯ \u001b[0m\u001b[2m${text}\u001b[0m`;
    await withPane("claude", "idle", heldScreen("❯ helloworld test"), async (pane) => {
      const shown = (await card())!;
      expect(labels(shown)).toEqual(["Send", "Discard"]);
      // sent or cleared in the terminal: the hint lingers a moment over a box that is empty again
      for (const empty of [grey('Try "how does <filepath> work?"'), grey("run the tests")]) {
        pane.screen = heldScreen(empty);
        expect(await card()).toBeNull();
        // Enter there would send Claude's suggestion, Ctrl+C would ask to leave Claude
        expect(await answer(shown.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
        expect(await answer(shown.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      }
      expect(pane.sent).toEqual([]);
      // typed text is not grey: a message of the same words is a held message
      pane.screen = heldScreen("❯ run the tests");
      expect((await card())?.body).toBe("run the tests");
      // a pane scrolled into its history: the viewport's older box and its grey text say nothing
      // about the message the live screen holds
      pane.screen = heldScreen("❯ helloworld test");
      pane.viewport = heldScreen(grey("run the tests"));
      expect((await card())?.body).toBe("helloworld test");
    });
  });

  test.skipIf(process.platform !== "linux")("opens the pending OmO form, navigates to a non-default row and confirms after redraw", async () => {
    for (const box of ["❯", "❯ ", "❯\n ", "❯│"]) await withOmo(async (pane) => {
      pane.screen = omoWidget(box);
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "alt+up") pane.screen = omoFormScreen(at);
        if (sent === "down") pane.screen = omoFormScreen(++at);
        if (sent === "enter") pane.screen = "Working…";
      };
      const prompt = (await card())!;
      expect(prompt).not.toBeNull();
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["alt+up", "down", "enter"]);
    });
  });

  test.skipIf(process.platform !== "linux")("matches the call even when the full form reveals another question already answered", async () => {
    await withOmo(async (pane) => {
      const entry = JSON.parse(omoCall("q1"));
      entry.message.content[0].arguments.questions.push({ header: "Later", question: "Another?", options: [{ label: "Yes" }] });
      appendFileSync(pane.omo!.path, JSON.stringify(entry) + "\n");
      let at = 0;
      const draw = () => omoFormScreen(at).replace("→ QA    Submit", "→ QA    Later ✓    Submit").replace("0/1 answered", "1/2 answered");
      pane.onSent = (sent) => {
        if (sent === "down") at++;
        if (sent === "alt+up" || sent === "down") pane.screen = draw();
        if (sent === "enter") pane.screen = "Working…";
      };
      const prompt = (await card())!;
      expect(prompt.steps).toHaveLength(2);
      expect((await answer(prompt.id, { option_index: 1 })).status).toBe(200);
      expect(pane.sent).toEqual(["alt+up", "down", "enter"]);
    });
  });

  test.skipIf(process.platform !== "linux")("types a digit-prefixed reply only after opening the question's own answer field", async () => {
    await withOmo(async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "alt+up" || sent === "backspace") pane.screen = omoFormScreen(at);
        if (sent === "down") pane.screen = omoFormScreen(++at);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "2 please" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["alt+up", "backspace", "down", "down", "enter", "text:2 please", "enter"]);
    });
  });

  test.skipIf(process.platform !== "linux")("rejects an identical replacement call before sending any key", async () => {
    await withOmo(async (pane) => {
      const first = (await card())!;
      appendFileSync(pane.omo!.path, JSON.stringify({ type: "custom", customType: "ask-user:settlement", data: { requestId: "q1" } }) + "\n" + omoCall("q2"));
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test.skipIf(process.platform !== "linux")("rechecks the live OmO process before answering a cached-looking widget", async () => {
    await withOmo(async (pane) => {
      const first = (await card())!;
      pane.omo!.live = false;
      // Even an exact copy of the widget, without an obvious shell marker, is no longer owned.
      expect(await answer(first.id, { custom_text: "echo wrong target" })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect(await card()).toBeNull();
    });
  });

  test.skipIf(process.platform !== "linux")("sends no answer if opening the widget reveals another question", async () => {
    await withOmo(async (pane) => {
      const first = (await card())!;
      pane.onSent = () => { pane.screen = omoFormScreen(0, "Delete the workspace?"); };
      expect(await answer(first.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["alt+up"]);
    });
  });

  // two open calls whose questions share their options (#2092): one asks two such questions, the decoy one
  const sharedCall = (id: string, questions: { header: string; question: string }[]) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse",
    content: [{ type: "toolCall", id, name: "ask_user_question", arguments: { waitForAnswer: false,
      questions: questions.map((question) => ({ ...question, options: [{ label: "Continue" }, { label: "Cancel" }] })) } }] } }) + "\n";
  const twoShared = sharedCall("actual", [{ header: "QA", question: "Proceed with the build?" }, { header: "QB", question: "Proceed with the deploy?" }]);
  const decoyShared = sharedCall("decoy", [{ header: "Deploy", question: "Deploy now?" }]);
  // a form in a pane too short for it: its title, tabs and question scrolled off, its options in view
  const clippedSharedForm = `${omoRule}
 \u2192 1. Continue
   2. Cancel
   Type your own answer...
 Submit (0/2 answered) \u2014 Enter advances
 \u2191\u2193 move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
${omoRule}
/tmp/work \u2022 main
(\ud83d\ude3a OmO Native)
`;

  test("names no call for a clipped form that one open call fits twice and a decoy call once (#2092)", () => {
    // the decoy alone is what the clipped form would be read as
    expect(parseInteractivePrompt("pi", clippedSharedForm, null, false, openOmoAsks(decoyShared))).toMatchObject({ agent: "omo", kind: "question" });
    expect(parseInteractivePrompt("pi", clippedSharedForm, null, false, openOmoAsks(twoShared))).toBeNull();
    expect(parseInteractivePrompt("pi", clippedSharedForm, null, false, openOmoAsks(`${twoShared}${decoyShared}`))).toBeNull();
    // questions the screen cannot show (multiple choice under a single-choice hint) make nothing ambiguous
    const twoMulti = twoShared.replaceAll('"question":"Proceed', '"multiSelect":true,"question":"Proceed');
    expect(openOmoAsks(twoMulti)[0]!.questions.every((question) => question.multiSelect)).toBe(true);
    expect(parseInteractivePrompt("pi", clippedSharedForm, null, false, openOmoAsks(`${twoMulti}${decoyShared}`))).toMatchObject({ question: "Deploy now?" });
  });

  test("keeps a clipped typed-answer card when another call's labels share only its first wrapped line, and refuses a true twin (#2092)", () => {
    // a 60-column pane wraps the first option after 54 characters; only its first row tells the calls apart from a rough look
    const prefix = "Continue deployment after completing the release safety".slice(0, 54);
    const call = (id: string, tails: string[]) => JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "ask_user_question", arguments: { waitForAnswer: false,
        questions: tails.map((tail, at) => ({ header: `Q${at}`, question: `Question ${id}${at}`, options: [{ label: prefix + tail }, { label: "Cancel" }] })) } }] } }) + "\n";
    const rule = "\u2500".repeat(60);
    const screen = [rule, ` \u2192 1. ${prefix}`, "y checks", "   2. Cancel", "   Type your own answer...",
      " Your answer (enter to save, \u2191\u2193 back to options, esc to", " discard)", " > custom draft", " Submit (0/1 answered) \u2014 Enter advances",
      " enter save and next  \u2191\u2193 back to options  tab next question", " esc discard", rule, "/tmp/work \u2022 main", "(\ud83d\ude3a OmO Native)", ""].join("\n");
    const actual = call("visible", ["y checks"]);
    const read = (calls: string) => parseInteractivePrompt("pi", screen, null, false, openOmoAsks(calls));
    const alone = read(actual);
    expect(alone).toMatchObject({ agent: "omo", kind: "menu", question: "Question visible0" });
    // another call whose questions cannot be the form on screen: the card stays
    expect(read(`${actual}${call("incompatible", ["y report", "y summary"])}`)?.id).toBe(alone!.id);
    // a call two of whose questions are the form on screen: no card
    expect(read(`${actual}${call("twin", ["y checks", "y checks"])}`)).toBeNull();
  });

  test.skipIf(process.platform !== "linux")("answers no call when the opened form is clipped and another call fits it too (#2092)", async () => {
    await withOmo(async (pane) => {
      writeFileSync(pane.omo!.path, JSON.stringify({ type: "session", id: "qa-session-488", cwd: pane.cwd }) + "\n" + twoShared + decoyShared);
      // the widget names the decoy; Alt+Up opens the other call's form, clipped
      pane.screen = omoWidget().replace("? Question pending (1 unanswered) \u00b7 30m\n QA \u2014 Which one?\n [ First ] [ Second ]",
        "? 2 questions pending \u00b7 30m\n Deploy \u2014 Deploy now?\n [ Continue ] [ Cancel ]");
      const prompt = (await card())!;
      expect(prompt).toMatchObject({ agent: "omo", question: "Deploy now?" });
      pane.onSent = (sent) => { if (sent === "alt+up") pane.screen = clippedSharedForm; };
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["alt+up"]);
    });
  });

  test.skipIf(process.platform !== "linux")("offers a reply-only card when the call has no predefined options", async () => {
    await withOmo(async (pane) => {
      writeFileSync(pane.omo!.path, JSON.stringify({ type: "session", id: "qa-session-488", cwd: pane.cwd }) + "\n" + omoCall("reply-only", []).replace(',"options":[]', ""));
      pane.screen = omoWidget().replace("[ First ] [ Second ] ", "");
      const prompt = (await card())!;
      expect(prompt.options).toEqual([]);
      expect(prompt.custom_option_index).toBe(0);
      pane.onSent = (sent) => { if (sent === "alt+up" || sent === "backspace") pane.screen = omoFormScreen(0, "Which one?", []); };
      expect((await answer(prompt.id, { custom_text: "my answer" })).status).toBe(200);
      expect(pane.sent).toEqual(["alt+up", "backspace", "enter", "text:my answer", "enter"]);
    });
  });

  /** Codex's continue menu with its cursor on `at` */
  const menu = (rows: string[], at = 0, above = "Conversation interrupted") =>
    `${above}\n\n${rows.map((row, index) => `${index === at ? "›" : " "} ${index + 1}. ${row}`).join("\n")}\n\nPress enter to continue\n`;
  const RESUME = ["Resume the task", "Start over", "Quit"];
  const DELETE = ["Keep the branch", "Delete the branch", "Quit"];
  const gjcSelector = (at = 0, rows = ["OpenAI-compatible", "Anthropic-compatible"]) =>
    `Step 1: Compatibility\n\n${rows.map((row, index) => `${index === at ? "❯" : " "} ${row}`).join("\n")}\n[↑↓ to navigate, Enter to select, Esc to cancel]\n`;

  /** the pane as a menu would run it: ↓ and ↑ move the cursor, and the screen shows it */
  function moving(pane: Pane, rows: string[], draw: (at: number) => string = (at) => menu(rows, at), start = 0): void {
    let at = start;
    pane.onSent = (sent) => {
      if (sent === "down") at = Math.min(rows.length - 1, at + 1);
      if (sent === "up") at = Math.max(0, at - 1);
      // what is typed shows in the menu's own row
      pane.screen = draw(at) + (sent.startsWith("text:") ? `\n${sent.slice(5)}\n` : "");
    };
  }

  const gjcCustomScreen = (at = 0, draft: string | null = null, question = "Which scope?") =>
    `──────────────\n\n${question}\n\n──────────────\n${["Read only", "Other (type your own)", "Ask about these choices"].map((label, index) => `│${at === index ? "" : " "} ${label} │`).join("\n")}\n──────────────\n\n${draft === null ? "↑/↓ select enter esc PgUp/PgDn/Ctrl+u/d: question · Wheel: transcript" : `> ${draft}\n\nenter submit esc back to options ctrl+g external editor PgUp/PgDn: question · Wheel: transcript`}\n\n──────────────\n`;

  test("matches a GJC editor below thousands of quoted body rows without losing its identity", () => {
    const body = "> Quoted body details\n".repeat(4_000);
    const question = `${body}Which scope?`;
    const expected = parsedByPublicPrompt.get(parseFallbackPrompt("gjc", gjcCustomScreen(0, null, question)))!;
    expect(expected.body).toHaveLength(12_000);
    expect(gjcCustomEditorMatches(gjcCustomScreen(1, "", question), expected, "")).toBe(true);
    expect(gjcCustomEditorMatches(gjcCustomScreen(1, "Original\n> draft", question), expected, "Original > draft")).toBe(true);
    expect(gjcCustomEditorMatches(gjcCustomScreen(1, "Original \n draft", question), expected, "Original  draft")).toBe(true);
    const wrapped = ["Original", ...Array<string>(32).fill("> draft")];
    expect(gjcCustomEditorMatches(gjcCustomScreen(1, wrapped.join("\n"), question), expected, wrapped.join(" "))).toBe(true);
    expect(gjcCustomEditorMatches(gjcCustomScreen(1, "Changed draft", question), expected, "Original draft")).toBe(false);
    expect(gjcCustomEditorMatches(gjcCustomScreen(1, "", `${body}Changed details\nWhich scope?`), expected, "")).toBe(false);
  });

  test("sends a GJC Other answer only after its own inline editor opens and contains the pasted draft", async () => {
    await withPane("gjc", "blocked", gjcCustomScreen(), async (pane) => {
      let at = 0;
      let opened = false;
      pane.onSent = (sent) => {
        if (sent === "down") at++;
        if (sent === "enter") opened = true;
        const draft = sent.startsWith("text:") ? sent.slice(5).replace("\u001b[200~", "").replace("\u001b[201~", "") : "";
        pane.screen = gjcCustomScreen(at, opened ? draft : null);
      };
      const prompt = (await card())!;
      expect(prompt.custom_option_index).toBe(1);
      expect(await answer(prompt.id, { custom_text: "/scope 읽기 전용" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter", "text:\u001b[200~/scope 읽기 전용\u001b[201~", "enter"]);
    });
  });

  test("does not type a GJC Other answer into a dismissed or replaced editor", async () => {
    for (const next of ["Ready\n\n❯ ", gjcCustomScreen(1, "", "A different question?")]) {
      await withPane("gjc", "blocked", gjcCustomScreen(), async (pane) => {
        pane.onSent = (sent) => { pane.screen = sent === "down" ? gjcCustomScreen(1) : next; };
        expect(await answer((await card())!.id, { custom_text: "Never send this to the composer" })).toEqual({ status: 409, code: "prompt_changed" });
        expect(pane.sent).toEqual(["down", "enter"]);
      });
    }
  });

  test("does not submit a GJC custom draft after its editor closes or the draft changes", async () => {
    // Soft wrapping can put the space between words at the row boundary. Changed content,
    // doubled internal spaces, and incomplete drafts still must not be submitted.
    for (const next of ["Ready\n\n❯ ", gjcCustomScreen(1, "Changed locally"), gjcCustomScreen(1, "Original\nchanged"), gjcCustomScreen(1, "Original  draft"), gjcCustomScreen(1, "Original")]) {
      await withPane("gjc", "blocked", gjcCustomScreen(), async (pane) => {
        pane.onSent = (sent) => {
          if (sent === "down") pane.screen = gjcCustomScreen(1);
          else if (sent === "enter") pane.screen = gjcCustomScreen(1, "");
          else if (sent.startsWith("text:")) pane.screen = next;
        };
        expect(await answer((await card())!.id, { custom_text: "Original draft" })).toEqual({ status: 409, code: "prompt_changed" });
        expect(pane.sent).toEqual(["down", "enter", "text:\u001b[200~Original draft\u001b[201~"]);
      });
    }
  });

  test.each([
    ["Original draft", "Original\ndraft"],
    ["Original draft", "Orig\ninal draft"],
    ["Original > draft", "Original\n> draft"],
    ["Original  draft", "Original \n draft"],
  ])("submits soft-wrapped GJC draft %s from the live drawing while the viewport shows history", async (text, draft) => {
    await withPane("gjc", "blocked", gjcCustomScreen(), async (pane) => {
      pane.visibleScreen = "Earlier output\n\n❯ ";
      pane.onSent = (sent) => {
        if (sent === "down") pane.screen = gjcCustomScreen(1);
        else if (sent === "enter") pane.screen = gjcCustomScreen(1, "");
        else if (sent.startsWith("text:")) pane.screen = gjcCustomScreen(1, draft);
      };
      expect(await answer((await card())!.id, { custom_text: text })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter", `text:\u001b[200~${text}\u001b[201~`, "enter"]);
    });
  });

  test("rejects a GJC editor whose question body changes beyond the display cap", async () => {
    const body = "Approval details ".repeat(800);
    const draw = (at: number, draft: string | null, suffix: string) =>
      gjcCustomScreen(at, draft, `${body}${suffix}\nWhich scope?`);
    for (const changedAfterPaste of [false, true]) {
      await withPane("gjc", "blocked", draw(0, null, "Original"), async (pane) => {
        pane.onSent = (sent) => {
          if (sent === "down") pane.screen = draw(1, null, "Original");
          else if (sent === "enter") pane.screen = draw(1, "", changedAfterPaste ? "Original" : "Changed");
          else if (sent.startsWith("text:")) pane.screen = draw(1, "My answer", "Changed");
        };
        const prompt = (await card())!;
        expect(prompt.body).toHaveLength(12_000);
        expect(await answer(prompt.id, { custom_text: "My answer" })).toEqual({ status: 409, code: "prompt_changed" });
        expect(pane.sent).toEqual(changedAfterPaste
          ? ["down", "enter", "text:\u001b[200~My answer\u001b[201~"]
          : ["down", "enter"]);
      });
    }
  });

  test("never uses a historical GJC editor when the live drawing has closed", async () => {
    await withPane("gjc", "blocked", gjcCustomScreen(), async (pane) => {
      pane.onSent = (sent) => {
        if (sent === "down") pane.screen = gjcCustomScreen(1);
        else if (sent === "enter") {
          pane.screen = "Ready\n\n❯ ";
          pane.visibleScreen = gjcCustomScreen(1, "");
        } else if (sent.startsWith("text:")) pane.visibleScreen = gjcCustomScreen(1, "Do not send");
      };
      expect(await answer((await card())!.id, { custom_text: "Do not send" })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("does not resume GJC text delivery after seeing its editor dismissed once", async () => {
    await withPane("gjc", "blocked", gjcCustomScreen(), async (pane) => {
      let editorReads = 0;
      pane.onSent = (sent) => {
        if (sent === "down") pane.screen = gjcCustomScreen(1);
        if (sent === "enter") pane.onRead = () => {
          editorReads++;
          pane.screen = editorReads === 1 ? "Ready\n\n❯ " : gjcCustomScreen(1, "");
        };
      };
      expect(await answer((await card())!.id, { custom_text: "Do not replay" })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down", "enter"]);
      expect(editorReads).toBe(1);
    });
  });

  test("recognizes numbered GJC Other before the clarification row and refuses control characters", () => {
    const prompt = parseFallbackPrompt("gjc", gjcCustomScreen().replace("Other (type your own)", "2. Other (type your own)"));
    expect(prompt.custom_option_index).toBe(1);
    expect(() => answerKeys(prompt, { option_index: 1 })).toThrow();
    expect(() => answerKeys(prompt, { custom_text: "bad\u001b[201~input" })).toThrow();
    expect(() => answerKeys(prompt, { custom_text: "Use\nthe terminal" })).toThrow();
  });

  test("shows a GJC startup selector even before the pane is reported blocked", async () => {
    await withPane("gjc", "idle", gjcSelector().replace("[↑↓ to navigate, Enter to select, Esc to cancel]", "up/down navigate  enter select  esc cancel"), async () => {
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(["OpenAI-compatible", "Anthropic-compatible", "Esc"]);
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
    });
  });

  test("answers GJC's unnumbered selector after confirming its moved cursor", async () => {
    await withPane("gjc", "blocked", gjcSelector(), async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") at = Math.min(1, at + 1);
        if (sent === "up") at = Math.max(0, at - 1);
        pane.screen = gjcSelector(at);
      };
      const prompt = (await card())!;
      expect(prompt.fallback).toBe(true);
      expect(labels(prompt)).toEqual(["OpenAI-compatible", "Anthropic-compatible", "Esc"]);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("does not confirm a changed GJC selector after moving its cursor", async () => {
    await withPane("gjc", "blocked", gjcSelector(), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = (sent) => { if (sent === "down") pane.screen = gjcSelector(1, ["Resume", "Delete"]); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("answers a framed GJC question across unrelated output and status redraws", async () => {
    const screen = (at: number, tick: number) => `Output ${tick}\n◷ 12h${tick}m\n──────────────\n\n${gjcSelector(at)}\n──────────────\n`;
    await withPane("gjc", "blocked", screen(0, 23), async (pane) => {
      const prompt = (await card())!;
      pane.screen = screen(0, 24);
      pane.onSent = (sent) => { if (sent === "down") pane.screen = screen(1, 25); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("refuses a framed GJC answer when its approval details change during navigation", async () => {
    const screen = (target: string, at = 0) => `──────────────\n\n Delete ${target}.\n\n ────────── \n\n Proceed?\n\n${at === 0 ? "❯" : " "} Yes\n${at === 1 ? "❯" : " "} No\n\nup/down navigate  enter select  esc cancel\n\n──────────────\n`;
    await withPane("gjc", "blocked", screen("staging"), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = (sent) => { if (sent === "down") pane.screen = screen("production", 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("checks a GJC selector after each move and stops once it is gone", async () => {
    const rows = ["First", "Second", "Third", "Fourth"];
    await withPane("gjc", "blocked", gjcSelector(0, rows), async (pane) => {
      let at = 0;
      pane.onSent = (sent) => { if (sent === "down") pane.screen = gjcSelector(++at, rows); };
      expect(await answer((await card())!.id, { option_index: 3 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "down", "enter"]);
    });
    await withPane("gjc", "blocked", gjcSelector(0, rows), async (pane) => {
      const prompt = (await card())!;
      // the selector dismissed after the first move: the composer takes the keys now
      pane.onSent = (sent) => { if (sent === "down") pane.screen = "Ready\n\n❯ \n"; };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("moves to the row and confirms it while the menu stays the card's", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(RESUME);
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
    });
  });

  /** Claude's question with option previews, its cursor on `at`: the box is redrawn for the option under it */
  const previewQuestion = (at: number): string => {
    const rows = ["Grid", "List"];
    const box = ["┌──────────────────┐", `│ ${rows[at]!.padEnd(16)} │`, "└──────────────────┘"];
    const option = (row: string, index: number) => `${index === at ? "❯" : " "} ${index + 1}. ${row.padEnd(20)}${box[index] ?? ""}`;
    return `${"─".repeat(80)}\n←  ☐ Layout  ✔ Submit  →\n\nWhich layout?\n\n${rows.map(option).join("\n")}\n${" ".repeat(25)}${box[2]}\n\n${" ".repeat(25)}Notes: press n to add notes\n\n${"─".repeat(80)}\n  Chat about this\n\nEnter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel\n`;
  };

  test("moves to a previewed option and confirms it while the box is redrawn for it", async () => {
    await withPane("claude", "blocked", previewQuestion(0), async (pane) => {
      moving(pane, ["Grid", "List"], previewQuestion);
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(["Grid", "List"]);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("waits out a screen caught half drawn after a move", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // the ↓ clears the menu before it draws it again: a read in between finds no menu at all
      pane.onSent = (sent) => {
        if (sent !== "down") return;
        pane.screen = "";
        setTimeout(() => { pane.screen = menu(RESUME, 1); }, 80);
      };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("presses no Enter into a menu that took the place of the card's under its moves", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // answered in the terminal as the answer's ↓ went out, and another menu asks under it:
      // its second row, which the Enter would take, deletes a branch
      pane.onSent = () => { pane.screen = menu(DELETE, 1, "Branch cleanup"); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("presses no Enter on a row an arrow key typed in the terminal moved the cursor to", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = menu(RESUME, 2); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("the cursor's row is no part of what a menu says: the same card wherever it stands", () => {
    const id = (screen: string) => parseInteractivePrompt("codex", screen)!.id;
    expect(id(menu(RESUME, 2))).toBe(id(menu(RESUME, 0)));
  });

  const QUESTION = (rows: string[], at: number) => `
☐ Dataset

Which evaluation dataset should we use?

${rows.map((row, index) => `${index === at ? "❯" : " "} ${index + 1}. ${row}`).join("\n")}
────────────────────────────
  ${rows.length + 1}. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const DATASETS = ["LM-O", "YCB-V", "Type something."];

  test("types a custom answer only into the question it was written for", async () => {
    await withPane("claude", "blocked", QUESTION(DATASETS, 0), async (pane) => {
      moving(pane, DATASETS, (at) => QUESTION(DATASETS, at));
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "the internal set" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "text:the internal set", "enter"]);
    });
    await withPane("claude", "blocked", QUESTION(DATASETS, 0), async (pane) => {
      const prompt = (await card())!;
      // another question by the time the cursor is down: the text would be typed into its row
      pane.onSent = () => { pane.screen = QUESTION(["main", "release", "Type something."], 2); };
      expect(await answer(prompt.id, { custom_text: "the internal set" })).toEqual({ status: 409, code: "prompt_changed" });
      // the read right before the second move already shows the other question: no second key either
      expect(pane.sent).toEqual(["down"]);
    });
  });

  const FOOTER = "\n────────────────────────────────────────\n/tmp/app\n0.0%/215k (auto)                                        some-model • medium\n";
  const dialog = (title: string, rows: string[], at: number) =>
    `────────────────────────────────────────\n\n ${title}\n\n${rows.map((row, index) => `${index === at ? " → " : "   "}${row}`).join("\n")}\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`;
  const ALLOW = ["Allow once", "Always allow", "Block"];

  test("offers no card and sends no key once pi has ended under its dialog's last screen", async () => {
    // pi's last dialog stays on the screen with one line of whatever came next under its footer, which reads
    // like an extension's status line: only pi holding the pane's input tells them apart
    for (const after of ["Killed", "host%", "user@host:~/app$ rm -rf build", "progress 90%"]) {
      await withPane("pi", "idle", `${dialog("Allow dangerous command?", ALLOW, 0)}${after}\n`, async (pane) => {
        const prompt = (await card())!;
        expect(prompt).not.toBeNull();
        pane.piGone = true;
        expect(await card()).toBeNull();
        expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
        expect(pane.sent).toEqual([]);
      });
    }
    // and none of an answer under way once pi ends
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      moving(pane, ALLOW, (at) => dialog("Allow dangerous command?", ALLOW, at));
      const prompt = (await card())!;
      pane.onSent = () => { pane.piGone = true; };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("answers pi's dialog once its cursor is on the row, and no other dialog in its place", async () => {
    // pi stays idle while a dialog waits, and a dialog with its cursor off the first row has no card
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      moving(pane, ALLOW, (at) => dialog("Allow dangerous command?", ALLOW, at));
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
    });
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = dialog("Delete the session?", ["Keep it", "Delete it"], 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("presses no Enter once the asking ended under its moves, though the same menu shows again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      // herdr reports the agent back at work as the ↓ goes out (answered in the terminal), and the
      // same menu is asked again with its cursor on the very row: the screen alone says nothing
      pane.onSent = () => { promptWaitEnded("p_1"); pane.screen = menu(RESUME, 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { promptWaitEnded("p_1"); pane.screen = dialog("Allow dangerous command?", ALLOW, 1); };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  });

  test("a read by another device while the answer redraws the menu ends no asking", async () => {
    await withPane("pi", "idle", dialog("Allow dangerous command?", ALLOW, 0), async (pane) => {
      const prompt = (await card())!;
      let at = 0;
      let polled: Promise<InteractivePrompt | null> | undefined;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        pane.screen = dialog("Allow dangerous command?", ALLOW, at);
        // pi's dialog with its cursor off the first row has no card: this poll reads none
        polled ??= card();
      };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter"]);
      expect(await polled).toBeNull();
    });
  });

  test("starts nothing that cannot be undone for a request that was given up", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      const abort = new AbortController();
      const moved = pane.onSent!;
      pane.onSent = (sent) => { moved(sent); abort.abort(); };
      const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
      const response = (await handlePromptRequest(new Request(url, { method: "POST", signal: abort.signal, body: JSON.stringify({ pane_id: "p_1", prompt_id: prompt.id, option_index: 1 }) }), url))!;
      expect(response.status).toBe(409);
      expect(pane.sent).toEqual(["down"]);
    });
  });

  const OMP = (rows: string[], at: number, question = "Which target?") => `
╭─ Ask ───────────────────╮
│ ${question}
├─────────────────────────┤
${rows.map((row, index) => `│${index === at ? "❯" : " "} ○ ${row}`).join("\n")}
├─────────────────────────┤
│ Enter select · n note · ↑/↓ move · Esc cancel
╰─────────────────────────╯
`;
  const TARGETS = ["Jetson Orin", "RK3588", "Other (type your own)"];

  test("types omp's custom answer into the row its Enter opens", async () => {
    await withPane("omp", "blocked", OMP(TARGETS, 0), async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        // the row's Enter opens an editor no reader knows, and what is typed shows in it
        pane.screen = sent === "enter" ? "Other:\n> \n" : sent.startsWith("text:") ? `Other:\n> ${sent.slice(5)}\n` : OMP(TARGETS, at);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "an x86 box" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "enter", "text:an x86 box", "enter"]);
    });
  });

  test("advances only the active question in a current OMP multi-question dialog", async () => {
    const render = (question: number, cursor: number, checked: number[]) => question === 0 ? `
╭─ Ask ───────────────────────────╮
│ Which platforms should run?     │
├────────────────────────────────┤
${["Linux", "macOS", "Other (type your own)"].map((label, index) => `│${cursor === index ? "❯ " : "  "}${index === 2 ? "○" : checked.includes(index) ? "☑" : "☐"} ${label}`).join("\n")}
├────────────────────────────────┤
│ ␣ toggle · ⏎ next · ↑/↓ move · Tab/←/→ question · ⎋ cancel │
╰────────────────────────────────╯
` : `
╭─ Ask ───────────────────────────╮
│ Which build should run?         │
├────────────────────────────────┤
│❯ ○ Debug                        │
│  ○ Release                      │
│  ○ Other (type your own)        │
├────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · Tab/←/→ question · ⎋ cancel │
╰────────────────────────────────╯
`;
    await withPane("omp", "blocked", render(0, 0, []), async (pane) => {
      let question = 0;
      let cursor = 0;
      const checked = new Set<number>();
      pane.onSent = (sent) => {
        if (sent === "down") cursor = Math.min(2, cursor + 1);
        else if (sent === "space") checked.has(cursor) ? checked.delete(cursor) : checked.add(cursor);
        else if (sent === "tab") question = 1;
        else if (sent === "enter" && question === 0) { question = 1; cursor = 0; }
        else if (sent === "enter" && question === 1) question = 2;
        pane.screen = question === 2 ? "Fictional OMP answers submitted" : render(question, cursor, [...checked]);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_indices: [1] })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "space", "enter"]);
      expect(question).toBe(1);
      expect(checked).toEqual(new Set([1]));
    });
  });

  test("submits a one-question current OMP multi dialog with Enter", async () => {
    const screen = `
╭─ Ask ───────────────────────────╮
│ Which checks should run?        │
├────────────────────────────────┤
│❯ ☐ Unit tests                   │
│  ☐ Browser checks               │
│  ○ Other (type your own)        │
├────────────────────────────────┤
│ ␠ toggle · ⏎ submit · ↑/↓ move · Tab/←/→ question · ⎋ cancel │
╰────────────────────────────────╯
`;
    await withPane("omp", "blocked", screen, async (pane) => {
      let checked = false;
      pane.onSent = (sent) => {
        if (sent === "space") checked = !checked;
        if (sent === "enter") pane.screen = "Fictional OMP answer submitted";
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_indices: [0] })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["space", "enter"]);
      expect(checked).toBe(true);
      expect(pane.screen).toBe("Fictional OMP answer submitted");
    });
  });

  test("moves through OMP questions, refuses stale or typed review answers, then submits once", async () => {
    const questions = [
      { title: "Which route should carry the fictional session?", options: ["Local socket", "Remote relay"] },
      { title: "Which target should receive it?", options: ["ARM server", "x86 runner"] },
    ];
    const drawQuestion = (question: number, cursor: number) => `
╭─ Ask ──────────────────────────────────────────────────────────╮
│  Transport    Targets    Submit                                │
│ ${questions[question]!.title}
├────────────────────────────────────────────────────────────────┤
${questions[question]!.options.map((label, index) => `│  ${cursor === index ? "❯ " : "  "}○ ${label}`).join("\n")}
│    ○ Other (type your own)
├────────────────────────────────────────────────────────────────┤
│ ⏎ select · n note · ↑/↓ move · ⇥/←/→ question · ⎋ cancel       │
╰────────────────────────────────────────────────────────────────╯
`;
    const drawReview = (target = "ARM server") => `
╭─ Ask ──────────────────────────────────────────────────────────╮
│  Transport    Targets    Submit                                │
│ Review answers                                                  │
├────────────────────────────────────────────────────────────────┤
│ 1. Transport: Remote relay                                      │
│ 2. Targets: ${target.padEnd(50)}│
│                                                                 │
│ ❯ Submit                                                        │
│                                                                 │
├────────────────────────────────────────────────────────────────┤
│ ⏎ submit · ↑/↓ scroll · ⎋ cancel · Alt+H hide                  │
╰────────────────────────────────────────────────────────────────╯
`;

    await withPane("omp", "blocked", drawQuestion(0, 0), async (pane) => {
      let activeQuestion = 0;
      let cursor = 0;
      let submitted = false;
      pane.onSent = (sent) => {
        if (sent === "down") cursor = Math.min(1, cursor + 1);
        if (sent === "enter" && activeQuestion === 0) {
          activeQuestion = 1;
          cursor = 0;
          pane.screen = drawQuestion(activeQuestion, cursor);
        } else if (sent === "enter" && activeQuestion === 1) {
          pane.screen = drawReview();
        } else if (sent === "enter" && activeQuestion === 2) {
          submitted = true;
          pane.screen = "Fictional OMP answers submitted";
        } else if (activeQuestion < 2) {
          pane.screen = drawQuestion(activeQuestion, cursor);
        }
      };

      const first = (await card())!;
      expect(first.question).toBe(questions[0]!.title);
      expect(await answer(first.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(activeQuestion).toBe(1);
      expect(pane.sent).toEqual(["down", "enter"]);

      const second = (await card())!;
      expect(second.question).toBe(questions[1]!.title);
      expect(await answer(second.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.screen).toContain("Review answers");

      const review = (await card())!;
      expect(labels(review)).toEqual(["Submit", "Cancel"]);
      pane.screen = drawReview("Changed target");
      expect(await answer(review.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down", "enter", "enter"]);

      const refreshedReview = (await card())!;
      expect(await answer(refreshedReview.id, { custom_text: "ordinary text" })).toEqual({ status: 400, code: "invalid_answer" });
      expect(pane.sent).toEqual(["down", "enter", "enter"]);

      activeQuestion = 2;
      expect(await answer(refreshedReview.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(submitted).toBe(true);
      expect(pane.sent).toEqual(["down", "enter", "enter", "enter"]);
      expect(pane.screen).toBe("Fictional OMP answers submitted");
    });
  });

  const input = (question: string, typed = "") => `────────────────────────────────────────\n\n ${question}\n\n> ${typed}\n enter submit  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`;

  test("answers pi's text dialog", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      pane.onSent = (sent) => { if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5)); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["ctrl+k", "ctrl+u", "text:fix/answers", "enter"]);
    });
  });

  const CHECKS = (rows: string[], at: number, ticked: number[] = [], question = "Which checks should run?") => `
☐ Checks

${question}

${rows.map((row, index) => `${index === at ? "❯" : " "} ${index + 1}. ${index < rows.length - 1 ? `[${ticked.includes(index) ? "✓" : " "}] ` : ""}${row}`).join("\n")}
────────────────────────────
  ${rows.length + 1}. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
  const KINDS = ["Lint", "Tests", "Type something."];

  test("ticks a multiple choice row by row", async () => {
    await withPane("claude", "blocked", CHECKS(KINDS, 0), async (pane) => {
      let at = 0;
      const ticked: number[] = [];
      pane.onSent = (sent) => { if (sent === "down") at += 1; if (sent === "enter") ticked.push(at); pane.screen = CHECKS(KINDS, at, ticked); };
      const prompt = (await card())!;
      expect(prompt.multi_select).toBe(true);
      expect(await answer(prompt.id, { option_indices: [0, 1] })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter", "down", "enter", "right"]);
    });
  });

  // This route looks at the screen before the first key that is not a move, and never after it:
  // from there on an answer's keys are the ones it always sent, whatever the screen shows.
  test("after its first key that is not a move, an answer sends the rest of its keys unseen", async () => {
    const cases: { agent: string; status: string; screen: string; choice: Parameters<typeof answer>[1] }[] = [
      { agent: "claude", status: "blocked", screen: QUESTION(DATASETS, 2), choice: { custom_text: "the internal set" } },
      { agent: "claude", status: "blocked", screen: CHECKS(KINDS, 0), choice: { option_indices: [0, 1] } },
      { agent: "pi", status: "idle", screen: input("Branch name?"), choice: { custom_text: "fix/answers" } },
      { agent: "omp", status: "blocked", screen: OMP(TARGETS, 2), choice: { custom_text: "an x86 box" } },
    ];
    for (const { agent, status, screen, choice } of cases) {
      await withPane(agent, status, screen, async (pane) => {
        // what the answer's keys are, as main sends them
        const keys = answerKeys(parseInteractivePrompt(agent, screen)!, choice).flatMap((step) => step.keys ?? [`text:${step.text}`]);
        expect(keys.length).toBeGreaterThan(1);
        const prompt = (await card())!;
        // the screen is something else from the first key on
        pane.onSent = () => { pane.screen = "Working…\n"; };
        expect(await answer(prompt.id, choice)).toEqual({ status: 200, code: undefined });
        expect(pane.sent).toEqual(keys);
      });
    }
  });

  test("sends no more of omp's answer once omp is stopped behind its shell under it", async () => {
    // the custom answer's Enter opens omp's editor, and the text and its Enter go unseen: only the check before each key holds them
    await withPane("omp", "blocked", OMP(TARGETS, 2), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.ompStopped = true; };
      expect(await answer(prompt.id, { custom_text: "an x86 box" })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["enter"]);
    });
    // and none of it, nor any card, while it is stopped behind its shell over the dialog it left
    await withPane("omp", "blocked", OMP(TARGETS, 2), async (pane) => {
      const prompt = (await card())!;
      pane.ompStopped = true;
      expect(await card()).toBeNull();
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
  });

  test("leaves Codex's queue alone while the question just answered is still on the screen", async () => {
    const open = "\n• Queued follow-up inputs\n  Which split?\n  › 1. train\n    2. test\n    3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n";
    await withPane("codex", "working", open, async (pane) => {
      // Codex takes the Enter a moment later: the question is still drawn at the first look,
      // then the main prompt has the input back, with nothing left to close
      pane.onSent = (sent) => { if (sent === "enter") setTimeout(() => { pane.screen = "› Ask Codex to do anything\n"; }, 150); };
      const prompt = (await card())!;
      expect(prompt.queued).toBe("open");
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("Codex back at work says nothing about a question in its queue", async () => {
    const open = "\n• Queued follow-up inputs\n  Which split?\n  › 1. train\n    2. test\n    3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n";
    await withPane("codex", "working", open, async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") { at += 1; pane.screen = open.replace("› 1. train\n    2. test", "  1. train\n  › 2. test"); }
        // Codex asks while it works, and herdr reports it working again under the answer's move
        promptWaitEnded("p_1");
        if (sent === "enter") pane.screen = "› Ask Codex to do anything\n";
      };
      const prompt = (await card())!;
      promptWaitEnded("p_1");
      expect((await card())!.id).toBe(prompt.id);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(at).toBe(1);
      expect(pane.sent).toEqual(["down", "enter"]);
    });
  });

  test("sends nothing for a request given up before its turn, even to the row the cursor is on", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const prompt = (await card())!;
      const abort = new AbortController();
      abort.abort();
      expect((await answer(prompt.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
    // and a fallback card's single key
    await withPane("gjc", "blocked", "Which environment?\n\n  1. Staging\n  2. Production\n\nEnter a number, or Esc to cancel\n", async (pane) => {
      const prompt = (await card())!;
      expect(prompt.fallback).toBe(true);
      const abort = new AbortController();
      abort.abort();
      expect((await answer(prompt.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      expect(pane.sent).toEqual([]);
    });
  });

  /** omp's session-only model picker, a rule between its recent model and the rest, which ↑/↓ step over */
  const ompPicker = (at: number) => {
    const box = (text: string) => `│ ${text.padEnd(86)} │`;
    const row = (index: number, name: string) => box(`${at === index ? "❯" : " "} ${name}`);
    return [
      `\n╭─ Switch Model ${"─".repeat(73)}╮`, box(" Session-only switch — role models stay unchanged"), box(" 🔍 >"), box(""),
      row(0, "litellm/claude-opus-5-5 ●          1m ◫  $4/20"), box(`  ${"─".repeat(80)}`),
      row(1, "litellm/gpt-6-sol                1.1m ◫  $2/10"), row(2, "litellm/gpt-5.6-sol              1.1m ◫  $4/20"), box(""),
      box("  GPT 6 Sol (LiteLLM) · 1.1m ctx · 128k out"), box(""),
      box("↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close"), `╰${"─".repeat(88)}╯\n`,
    ].join("\n");
  };

  // An ordinary answer that needs a move, on a screen drawn again the way each agent draws it
  // with the cursor on another row: every reader must still know its own menu there.
  describe("moves to a row that is not the cursor's and answers it", () => {
    const rule = "─".repeat(120);
    const omoFooter = `${rule}\n/private/tmp/omo-ask${" ".repeat(74)}[----------] 42K/1M (4.2%)\n${" ".repeat(86)}claude-opus-5-5 · high · OmO 5.1.7\n`;
    const mark = (at: number, row: number, on = "❯") => at === row ? on : " ";
    const cases: { name: string; agent: string; status?: string; rows: number; start?: number; draw: (at: number, ticked: number[]) => string; choice: Parameters<typeof answer>[1]; sent: string[] }[] = [
      {
        name: "omp's permission: Deny", agent: "omp", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n╭─ Permission ────────────╮\n│ Allow tool: bash        │\n│ curl -I example.com     │\n│${mark(at, 0)} Approve               │\n│${mark(at, 1)} Deny                  │\n╰─────────────────────────╯\n`,
      },
      {
        name: "omp's question", agent: "omp", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => OMP(TARGETS, at),
      },
      {
        name: "omp's multiple choice", agent: "omp", rows: 4, choice: { option_indices: [0, 2] }, sent: ["space", "down", "down", "space", "tab", "enter"],
        draw: (at, ticked) => `\n╭─ Ask ───────────────────╮\n│ Which checks?           │\n├─────────────────────────┤\n${["Lint", "Tests", "Build", "Other (type your own)"].map((row, index) => `│${mark(at, index)} ${ticked.includes(index) ? "☑" : "☐"} ${row}`).join("\n")}\n├─────────────────────────┤\n│ Space/Enter toggle · n note · ↑/↓ move · Tab/←/→ · Esc cancel\n╰─────────────────────────╯\n`,
      },
      {
        name: "Codex's approval", agent: "codex", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nWould you like to run the following command?\necho first\n${mark(at, 0, "›")} 1. Yes, proceed\n${mark(at, 1, "›")} 2. Yes, and don't ask again for this command\n${mark(at, 2, "›")} 3. No, cancel\nPress enter to confirm or esc to cancel\n`,
      },
      {
        name: "Codex's question", agent: "codex", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nWhich backend?\n\n${mark(at, 0, "›")} 1. CUDA\n${mark(at, 1, "›")} 2. CPU\n${mark(at, 2, "›")} 3. None of the above  Add details in notes (tab).\n\ntab to add notes | enter to submit answer | esc to interrupt\n`,
      },
      {
        name: "Claude's approval, to its last row", agent: "claude", rows: 3, choice: { option_index: 2 }, sent: ["down", "down", "enter"],
        draw: (at) => `\nBash command\n\n  curl -I https://example.com\n  Fetch HTTP headers.\n\nThis command requires approval\n\nDo you want to proceed?\n${mark(at, 0)} 1. Yes\n${mark(at, 1)} 2. Yes, and don’t ask again for: curl *\n${mark(at, 2)} 3. No\n\nEsc to cancel · Tab to amend · ctrl+e to explain\n`,
      },
      {
        name: "Claude's plan", agent: "claude", rows: 4, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\nReady to code?\n\nHere is Claude's plan:\nAdd a heading to the README file.\n\nClaude has written up a plan and is ready to execute. Would you like to proceed?\n\n${mark(at, 0)} 1. Yes, auto-accept edits\n${mark(at, 1)} 2. Yes, manually approve edits\n${mark(at, 2)} 3. No, refine with Ultraplan on Claude Code on the web\n${mark(at, 3)} 4. Tell Claude what to change\n     shift+tab to approve with this feedback\n`,
      },
      {
        name: "Claude's review of its answers: Cancel", agent: "claude", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n←  ☒ Route  ☒ Author  ✔ Submit  →\nReview your answers\n ● Which way should the PR go?\n   → Log in as owner\n ● Who should author the commits?\n   → Repo owner\nReady to submit your answers?\n${mark(at, 0)} 1. Submit answers\n${mark(at, 1)} 2. Cancel\n`,
      },
      {
        name: "Claude's folder-trust check", agent: "claude", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n Accessing workspace:\n\n /home/user/projects/new-app\n\n Quick safety check: Is this a project you created or one you trust?\n\n ${mark(at, 0)} No, exit\n ${mark(at, 1)} Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`,
      },
      {
        name: "pi's confirmation: No", agent: "pi", status: "idle", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `────────────────────────────────────────\n\n Clear session?\n All messages will be lost.\n\n${[" Yes", " No"].map((row, index) => `${at === index ? " →" : "  "}${row}`).join("\n")}\n ↑↓ navigate  enter select  escape/ctrl+c cancel\n────────────────────────────────────────${FOOTER}`,
      },
      {
        name: "pi's model list", agent: "pi", status: "idle", rows: 2, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `────────────────────────────────────────\n\nOnly showing models from configured providers. Use /login to add providers.\n>\n\n${at === 0 ? "→" : " "} ✓ vllm/Qwen/Qwen3.8-27B [lwsa-platform] · default\n${at === 1 ? "→" : " "}   vllm-flash/Qwen3.8-Flash-Next [lwsa-platform]\n Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel\n────────────────────────────────────────${FOOTER}`,
      },
      {
        name: "pi's thinking level, reread at a narrower width", agent: "pi", status: "idle", rows: 3, start: 2,
        choice: { option_index: 0 }, sent: ["up", "up", "enter"], draw: (at) => piThinking(at, at === 0),
      },
      {
        name: "OmO's model list", agent: "omo", status: "idle", rows: 3, choice: { option_index: 2 }, sent: ["down", "down", "enter"],
        draw: (at) => `Only showing models from configured providers. Use /login to add providers.\nenter select  ctrl+s select as default  ctrl+f favorite\n>\n${["claude-opus-4-8 [anthropic] ✓", "claude-fable-5 [anthropic]", "gpt-5.5 [chatgpt-subscription]"].map((row, index) => `${at === index ? "→" : " "}   ${row}`).join("\n")}\n  Model Name: Claude Opus 4.8\n${"─".repeat(40)}\n/tmp/app • $0.000 (sub) • 0/1M (0.0%) (auto)  (anthropic) claude-opus-4-8 • effort medium\n(😺 OmO Native)\n`,
      },
      {
        name: "omp's model picker, over the rule between its recent model and the rest", agent: "omp", status: "idle", rows: 3, choice: { option_index: 2 },
        sent: ["down", "down", "enter"],
        draw: (at) => ompPicker(at),
      },
      {
        // the last row drawn carries the cursor where it carried `↓`, under another effort line
        name: "Claude's model list, to the last row it draws", agent: "claude", status: "idle", rows: 10, start: 1, choice: { option_index: 9 },
        sent: [...Array.from({ length: 8 }, () => "down"), "text:s"],
        draw: (at) => claudeModelList(at),
      },
      {
        name: "Codex's model list: Enter, which there only opens the model's levels", agent: "codex", status: "done", rows: 7, start: 1, choice: { option_index: 4 },
        sent: ["down", "down", "down", "enter"],
        draw: (at) => codexModels(at),
      },
      {
        name: "Codex's reasoning levels: s, for this session", agent: "codex", status: "done", rows: 5, start: 1, choice: { option_index: 3 },
        sent: ["down", "down", "text:s"],
        draw: (at) => codexLevels(at),
      },
      {
        name: "Codex's reasoning levels, from the row that opens the advanced ones up to a level: s", agent: "codex", status: "done", rows: 5, start: 4, choice: { option_index: 0 },
        sent: ["up", "up", "up", "up", "text:s"],
        draw: (at) => codexLevels(at),
      },
      {
        name: "omo's review, from its comment up to an answer", agent: "pi", rows: 3, start: 2, choice: { option_index: 2 }, sent: ["up", "enter"],
        draw: (at) => `\n [표시 위치] [월 한도] wait for answer\n\n${rule}\n\n Ask user · 30m\n   표시 위치 ✓    월 한도 ✓  → Submit\n Review your answers\n ${at === 0 ? "→" : " "} 표시 위치: 설정 > 음성 입력 (추천)\n ${at === 1 ? "→" : " "} 월 한도: 월 $5 한도\n\n Comment (optional; unanswered questions are reported)\n>\n Submit (2/2 answered)\n ${at === 2 ? "enter submit  ↑ review answers  shift+tab back  tab next question  esc back" : "enter edit answer  ↑↓ move  tab next question  esc back"}\n${omoFooter}`,
      },
      {
        name: "Hermes's clarify question: Blue", agent: "hermes", rows: 3, choice: { option_index: 1 }, sent: ["down", "enter"],
        draw: (at) => `\n ask 1 question\n ▸ Pick a colour\n${["Red (Recommended)", "Blue", "Other (type your answer)"].map((row, index) => `   ${at === index ? "▸" : " "} ${index + 1}. ${row}`).join("\n")}\n 0/1 answered · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel\n ─ (⌐■_■) deliberating…  · 10s │ opus 5.5\n`,
      },
      {
        name: "Hermes's multi-select question: Red and Blue", agent: "hermes", rows: 4, choice: { option_indices: [0, 1] }, sent: ["space", "down", "space", "enter"],
        draw: (at, ticked) => `\n ask 1 question\n ▸ Pick colours\n${["Red", "Blue", "Green"].map((row, index) => `   ${at === index ? "▸" : " "} ${ticked.includes(index) ? "[x]" : "[ ]"} ${index + 1}. ${row}`).join("\n")}\n   ${at === 3 ? "▸" : " "} 4. Other (type your answer)\n 0/1 answered · Space toggle · ↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel\n ─ (⌐■_■) deliberating…  · 10s │ opus 5.5\n`,
      },
    ];
    for (const { name, agent, status = "blocked", rows, start = 0, draw, choice, sent } of cases) {
      test(name, async () => {
        await withPane(agent, status, draw(start, []), async (pane) => {
          let at = start;
          const ticked: number[] = [];
          pane.onSent = (key) => {
            if (key === "down") at = Math.min(rows - 1, at + 1);
            if (key === "up") at = Math.max(0, at - 1);
            if (key === "space") ticked.push(at);
            pane.screen = draw(at, ticked);
          };
          const prompt = (await card())!;
          expect(prompt).not.toBeNull();
          expect(await answer(prompt.id, choice)).toEqual({ status: 200, code: undefined });
          expect(pane.sent).toEqual(sent);
        });
      });
    }
  });

  test("answers Claude's second option after redrawing its background-agent footer", async () => {
    await withPane("claude", "blocked", claudeBackgroundApproval(0), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = (sent) => {
        if (sent === "down") pane.screen = claudeBackgroundApproval(1);
      };
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "enter"]);
      expect(pane.sent.some((sent) => sent.startsWith("text:") || /^\d+$/.test(sent))).toBe(false);
    });
  });

  test("picks Claude's model with s only where the list still shows that model under the cursor", async () => {
    // the cursor's own row: the list is looked at again, then the letter alone, and never an Enter
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["text:s"]);
    });
    // a pane made shorter under the moves: Claude draws five rows of the list, another card, and
    // the model under the cursor is still the one that was tapped
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      let at = 1;
      pane.onSent = (sent) => { if (sent === "down") at += 1; pane.screen = claudeModelList(at, 0, 5); };
      expect(parseInteractivePrompt("claude", claudeModelList(3, 0, 5))!.id).not.toBe(parseInteractivePrompt("claude", claudeModelList(3))!.id);
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "text:s"]);
    });
  });

  describe("picker cancellation matches the parent move boundaries", () => {
    const providerList = (agent: "pi" | "omo", at: number) => {
      const rows = ["gpt-5.5", "gpt-6-sol", "gpt-6-astra"].map((name, row) =>
        `${at === row ? "→" : " "}   ${name} [chatgpt-subscription]`).join("\n");
      return agent === "omo"
        ? `enter select  ctrl+s select as default  ctrl+f favorite\n>\n${rows}\n${"─".repeat(40)}\n/tmp/fixture\n(OmO Native)\n`
        : `>\n${rows}\nEnter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel\n${"─".repeat(40)}\n/tmp/fixture\n0.0%/215k (auto)\n`;
    };
    const cases = [
      { id: "omo-model", agent: "omo", move: "down", rereadMoves: false, draw: (at: number) => providerList("omo", at) },
      { id: "pi-model", agent: "pi", move: "down", rereadMoves: false, draw: (at: number) => providerList("pi", at) },
      { id: "pi-thinking", agent: "pi", move: "down", rereadMoves: false, draw: piThinking },
      { id: "claude-model", agent: "claude", move: "down", rereadMoves: true, draw: claudeModelList },
      { id: "claude-effort", agent: "claude", move: "right", rereadMoves: true, draw: claudeEffort },
      { id: "codex-model", agent: "codex", move: "down", rereadMoves: true, draw: codexModels },
      { id: "omp-model", agent: "omp", move: "down", rereadMoves: true, draw: ompPicker },
    ];
    for (const fixture of cases) for (const during of ["first move", "next read", "commit read", "asking ended"]) {
      test(`${fixture.id} preserves parent navigation when cancelled during ${during}`, async () => {
        await withPane(fixture.agent, "idle", fixture.draw(0), async (pane) => {
          const prompt = (await card())!;
          const abort = new AbortController();
          let at = 0;
          pane.onSent = (sent) => {
            if (sent !== fixture.move) return;
            at += 1;
            pane.screen = fixture.draw(at);
            if (at === 1 && during === "first move") abort.abort();
            if (at === 1 && during === "asking ended") promptWaitEnded("p_1");
          };
          // Abort within the exact read, after onRow's entry guard but before it returns.
          pane.onRead = () => {
            if ((at > 0 && during === "next read") || (at === 2 && during === "commit read")) abort.abort();
          };
          const result = await answer(prompt.id, { option_index: 2 }, { signal: abort.signal });
          const moves = during === "asking ended" || (during === "first move" && fixture.rereadMoves) ? 1 : 2;
          expect(pane.sent, `${fixture.id} must keep the parent's reversible keys without a commit`).toEqual(Array.from({ length: moves }, () => fixture.move));
          expect(result).toEqual({ status: 409, code: "prompt_changed" });
        });
      });
    }
  });

  // a refusal waits out the answer's own 1.5 s for the picker to show the row
  test("sends no further arrow into omp's input once its model picker closes under the moves", async () => {
    await withPane("omp", "idle", ompPicker(0), async (pane) => {
      const prompt = (await card())!;
      // Esc in the terminal right after the first ↓: omp's input box takes ↑/↓ as its history
      pane.onSent = (sent) => { if (sent === "down") pane.screen = "\n> \n"; };
      const result = await answer(prompt.id, { option_index: 2 });
      expect(pane.sent, "a closed picker must not receive the remaining arrows").toEqual(["down"]);
      expect(result).toEqual({ status: 409, code: "prompt_changed" });
    });
  });

  describe("Hermes's question, changed in the terminal between the last look and a key", () => {
    const hermes = (question: string, at: number, ticked: number[] = [], multi = false) => `\n ask 1 question\n ▸ ${question}\n${["Red", "Blue", "Green"].map((row, index) => `   ${at === index ? "▸" : " "} ${multi ? (ticked.includes(index) ? "[x] " : "[ ] ") : ""}${index + 1}. ${row}`).join("\n")}\n   ${at === 3 ? "▸" : " "} 4. Other (type your answer)\n 0/1 answered · ${multi ? "Space toggle · " : ""}↑/↓ select · Enter confirm and continue · Tab/Shift+Tab switch question · Esc/Ctrl+C cancel\n ─ (⌐■_■) deliberating…  · 10s │ opus 5.5\n`;

    // the reads after the move: the look that finds Blue under the cursor, the read before Enter, its settling read
    for (const [moveOn, read] of [[2, "the read before Enter"], [3, "the settling read before Enter"]] as const) {
      test(`an arrow pressed in the terminal by ${read}: no Enter on the row it moved to`, async () => {
        await withPane("hermes", "blocked", hermes("Pick a colour", 0), async (pane) => {
          const prompt = (await card())!;
          let reads = 0;
          pane.onSent = (sent) => { if (sent === "down") { pane.screen = hermes("Pick a colour", 1); reads = 0; } };
          pane.onRead = () => { reads += 1; if (pane.sent.length > 0 && reads === moveOn) pane.screen = hermes("Pick a colour", 2); };
          const result = await answer(prompt.id, { option_index: 1 });
          expect(reads, "the cursor moved under the answer").toBeGreaterThanOrEqual(moveOn);
          expect(pane.sent, "Enter would answer Green, not the Blue tapped on the card").toEqual(["down"]);
          expect(result).toEqual({ status: 409, code: "prompt_changed" });
        });
      });
    }

    test("a multi-select answer stops once the terminal ticks a row the answer's next Space would untick", async () => {
      await withPane("hermes", "blocked", hermes("Pick colours", 0, [], true), async (pane) => {
        const prompt = (await card())!;
        let at = 0;
        const ticked: number[] = [];
        pane.onSent = (sent) => {
          if (sent === "down") at += 1;
          // Space in the terminal on Green right after the answer's first one
          if (sent === "space") ticked.push(at, ...(ticked.length === 0 ? [2] : []));
          pane.screen = hermes("Pick colours", at, ticked, true);
        };
        const result = await answer(prompt.id, { option_indices: [0, 2] });
        expect(pane.sent, "a second Space on Green would untick it and Enter would lock Red alone").toEqual(["space", "down", "down"]);
        expect(result).toEqual({ status: 409, code: "prompt_changed" });
      });
    });

    test("a multi-select answer stops once the terminal switches to another question after the first tick", async () => {
      await withPane("hermes", "blocked", hermes("Pick colours", 0, [], true), async (pane) => {
        const prompt = (await card())!;
        // Tab in the terminal right after the first Space: the next question, drawn alike
        pane.onSent = (sent) => { if (sent === "space") pane.screen = hermes("Pick more colours", 0, [], true); };
        const result = await answer(prompt.id, { option_indices: [0, 2] });
        expect(pane.sent, "the other question must not take the remaining moves, ticks or Enter").toEqual(["space"]);
        expect(result).toEqual({ status: 409, code: "prompt_changed" });
      });
    });
  });

  test("an interaction plan sends no commit when Claude's highlight moves past the requested model", async () => {
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      // A deterministic terminal move races our one Down: the requested row is 2, not 3.
      pane.onSent = (sent) => { if (sent === "down") pane.screen = claudeModelList(3); };
      const result = await answer(prompt.id, { option_index: 2 });
      expect(pane.sent, "a changed highlight must not receive the session commit s").toEqual(["down"]);
      expect(result).toEqual({ status: 409, code: "prompt_changed" });
    });
  });

  test("sets Claude's effort with ←/→ and s only where the slider still stands over that level", async () => {
    await withPane("claude", "idle", claudeEffort(2), async (pane) => {
      let at = 2;
      pane.onSent = (sent) => {
        if (sent === "right") at = Math.min(4, at + 1);
        if (sent === "left") at = Math.max(0, at - 1);
        pane.screen = claudeEffort(at);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["left", "left", "text:s"]);
    });
    // a key typed in the terminal at the same moment: ▲ over another level, so no letter
    await withPane("claude", "idle", claudeEffort(2), async (pane) => {
      pane.onSent = (sent) => { if (sent === "right") pane.screen = claudeEffort(4); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["right"]);
    });
  }, 20_000);

  test("turns Claude's Ultracode on from the effort card with Tab, then s once the slider shows it flipped (#2232)", async () => {
    await withPane("claude", "idle", claudeEffort(2), async (pane) => {
      pane.onSent = (sent) => {
        if (sent === "tab") pane.screen = claudeEffort(2, CLAUDE_EFFORT_HINT, "on");
        if (sent === "text:s") pane.screen = CLAUDE_ULTRACODE_SET;
      };
      const prompt = (await card())!;
      expect(labels(prompt)?.at(-1)).toBe("Turn Ultracode on");
      expect(await answer(prompt.id, { option_index: 5 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab", "text:s"]);
    });
    // and off again, from a slider drawn with it on
    await withPane("claude", "idle", claudeEffort(4, CLAUDE_EFFORT_HINT, "on"), async (pane) => {
      pane.onSent = (sent) => { if (sent === "tab") pane.screen = claudeEffort(4); };
      const prompt = (await card())!;
      expect(labels(prompt)?.at(-1)).toBe("Turn Ultracode off");
      expect(await answer(prompt.id, { option_index: 5 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["tab", "text:s"]);
    });
  });

  // each refusal waits out the answer's own 1.5 s for the slider to show the switch flipped
  test("types no s once the switch did not flip under the Tab, or ▲ moved with it", async () => {
    // a Tab the slider never took (the switch drawn as before): `s` would apply only the level
    await withPane("claude", "idle", claudeEffort(2), async (pane) => {
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 5 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
    // an arrow typed in the terminal at the same moment: the switch flipped, but at another level
    await withPane("claude", "idle", claudeEffort(2), async (pane) => {
      pane.onSent = (sent) => { if (sent === "tab") pane.screen = claudeEffort(3, CLAUDE_EFFORT_HINT, "on"); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 5 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["tab"]);
    });
  }, 20_000);

  test("sets Claude's effort while Ultracode is on, and only while the switch still shows it so", async () => {
    await withPane("claude", "idle", claudeEffort(2, CLAUDE_EFFORT_HINT, "on"), async (pane) => {
      let at = 2;
      pane.onSent = (sent) => {
        if (sent === "left") at = Math.max(0, at - 1);
        pane.screen = claudeEffort(at, CLAUDE_EFFORT_HINT, "on");
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["left", "text:s"]);
    });
    // a Tab pressed in the terminal under the move: `s` would turn Ultracode off with the level
    await withPane("claude", "idle", claudeEffort(2, CLAUDE_EFFORT_HINT, "on"), async (pane) => {
      pane.onSent = (sent) => { if (sent === "left") pane.screen = claudeEffort(1); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["left"]);
    });
  }, 20_000);

  test("sends no Esc to Claude's goal dialog once it shows another goal than the card's", async () => {
    const goal = (name: string) => readFileSync(new URL("./fixtures/claude-goal-2.1.304-active-120.txt", import.meta.url), "utf8").replaceAll("hello.txt", name);
    await withPane("claude", "idle", goal("hello.txt"), async (pane) => {
      // the card's read, the answer's own read of the card, then its look before the key
      let reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 3) pane.screen = goal("other.txt"); };
      const prompt = (await card())!;
      expect(prompt.title).toBe("Goal active");
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
    });
    await withPane("claude", "idle", goal("hello.txt"), async (pane) => {
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["esc"]);
    });
  });

  // live on Claude Code 2.1.316: herdr says blocked a moment before Claude draws its permission panel, and for a
  // moment after it closes; a poll then got a "Waiting for input" card [Enter, Esc] made of Claude's own input box
  test("shows no fallback card while Claude's own input box is still the screen", async () => {
    const rule = "─".repeat(80);
    const box = `\n\n                                     Tip: run /help for help\n${rule}\n❯ Use the Bash tool to run touch made.txt\n${rule}\n  user@host /tmp/garden\n  ⏸ manual mode on\n`;
    await withPane("claude", "blocked", box, async (pane) => {
      const first = await card();
      expect(first === null ? null : { title: first.title, question: first.question, options: first.options.map((option) => option.label) }).toBeNull();
      pane.screen = `● Bash(touch made.txt)\n${rule}\n Bash command\n   touch made.txt\n   Create the file\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend\n`;
      expect((await card())?.title).toBe("Bash command");
    });
  });

  test("still offers the fallback card for a Claude dialog no reader knows, drawn between two rules", async () => {
    const rule = "─".repeat(80);
    await withPane("claude", "blocked", `● Earlier output\n${rule}\n New MCP server found in .mcp.json: tools\n Use this server?\n${rule}\n Enter to confirm · Esc to cancel\n`, async () => {
      expect((await card())?.title).toBe("Waiting for input");
    });
  });

  // a list's cursor row between two rules, or a dialog drawn under a box, is no input box ending the screen
  test.each([
    ["its options between two rules", `● Earlier output\n Some new Claude dialog\n${"─".repeat(80)}\n ❯ 1. Allow\n   2. Deny\n${"─".repeat(80)}\n Enter to confirm · Esc to cancel\n`],
    ["drawn under an input box", `● Earlier output\n${"─".repeat(80)}\n❯ \n${"─".repeat(80)}\n Some new dialog under the box\n ❯ 1. Allow\n   2. Deny\n Enter to confirm · Esc to cancel\n`],
  ])("still offers the fallback card for a Claude dialog no reader knows, %s", async (_name, screen) => {
    await withPane("claude", "blocked", screen, async () => {
      expect((await card())?.options.map((option) => option.label)).toEqual(["Allow", "Deny", "Enter", "Esc"]);
    });
  });

  test("keeps waiting for Claude's next question through a failed read after answering", async () => {
    const screen = (question: string) => `←  ☐ Device  ☐ Symptoms  ✔ Submit  →\n\n${question}\n\n❯ 1. Phone\n  2. Desktop browser\n  3. Type something.\n${"─".repeat(80)}\n  4. Chat about this\n\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n`;
    await withPane("claude", "blocked", screen("Which device do you use?"), async (pane) => {
      const prompt = (await card())!;
      let reads = 0;
      pane.onSent = (sent) => {
        if (sent !== "enter") return;
        pane.onRead = () => {
          reads += 1;
          if (reads === 1) pane.nextReadFails = true;
          if (reads === 3) pane.screen = screen("Which problems do you see?");
        };
      };
      expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      // the failed read, the old question, then the next one: its whole tab bar read once more in
      // color and the text read again after that (#2465)
      expect(reads).toBe(4);
      expect((await card())!.question).toBe("Which problems do you see?");
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  // each refusal waits out the answer's own 1.5 s for the list to show the row
  test("types no s, and no further arrow, once Claude's model list is not the one that was tapped", async () => {
    // closed in the terminal right after the answer read it, with no move to wait on: the look
    // before the letter is what keeps it out of Claude's own prompt
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      // the card's read, the answer's own read of the card, then its look before the letter:
      // the list is still up for the second and gone for the third
      let reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 3) pane.screen = CLAUDE_MODEL_CLOSED; };
      const prompt = (await card())!;
      expect(reads).toBe(1);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      // the answer got past its own read (a list gone by then is refused at once, with two reads)
      expect(reads).toBeGreaterThanOrEqual(3);
      expect(pane.sent).toEqual([]);
    });
    // closed in the terminal under the first move: no second arrow into Claude's own prompt,
    // where it would walk the prompt's history, and no letter
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = CLAUDE_MODEL_CLOSED; };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // a key typed in the terminal at the same moment, one more row down: another model's row
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      let at = 1;
      pane.onSent = (sent) => { if (sent === "down") at += at === 1 ? 2 : 1; pane.screen = claudeModelList(at); };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // another list in its place under the last move, the same number and name on another model
    // (a list by family names the model in what the row says): not the row that was tapped
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      const prompt = (await card())!;
      let at = 1;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        pane.screen = at === 3 ? claudeModelList(at).replace("Most efficient for simpler tasks", "Sonnet 5 · Efficient for routine tasks") : claudeModelList(at);
      };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down", "down"]);
    });
  }, 20_000);

  test("takes the key Codex's footer names for the row the cursor is on, and never Enter where it offers s", async () => {
    // a model with a single reasoning level picks from the first list: its row's footer offers s,
    // and Enter there would save it as the default
    const single = (row: number) => row === 3 ? CODEX_PICKS : CODEX_OPENS;
    await withPane("codex", "done", codexModels(1, single), async (pane) => {
      let at = 1;
      pane.onSent = (sent) => { if (sent === "down") at += 1; pane.screen = codexModels(at, single); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "down", "text:s"]);
    });
    // the cursor's own row: looked at again, and the key is the one that look shows
    await withPane("codex", "done", codexLevels(1), async (pane) => {
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["text:s"]);
    });
    // Ultra's footer says apply for Enter: s all the same
    const advanced = (at: number) => codexList("Advanced Reasoning", [["Max", "For difficult problems"], ["Ultra", "For demanding work"]], at, (row) => row === 1 ? "  enter apply · s session · esc back" : CODEX_PICKS).replace(" (current)", "          ");
    await withPane("codex", "done", advanced(0), async (pane) => {
      pane.onSent = (sent) => { if (sent === "down") pane.screen = advanced(1); };
      const prompt = (await card())!;
      expect(labels(prompt)).toEqual(["Max", "Ultra"]);
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "text:s"]);
    });
  });

  test("answers a model list only once the pane shows what follows it, so its card does not come up again", async () => {
    // Codex draws a model's levels a moment after the Enter: the read right after the answer is theirs
    await withPane("codex", "done", codexModels(1), async (pane) => {
      pane.onSent = (sent) => { if (sent === "enter") setTimeout(() => { pane.screen = codexLevels(1); }, 200); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect((await card())!.question).toBe("Select reasoning level for GPT-6-Astra for this session (currently Medium). More levels are listed in the terminal.");
    });
    // and Claude closes its list a moment after the s: no card is left to read
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      pane.onSent = (sent) => { if (sent === "text:s") setTimeout(() => { pane.screen = CLAUDE_MODEL_CLOSED; }, 200); };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect(await card()).toBeNull();
    });
    // also where the pane was made shorter under the moves, and the list was another window by the s
    await withPane("claude", "idle", claudeModelList(1), async (pane) => {
      let at = 1;
      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        pane.screen = claudeModelList(at, 0, 5);
        if (sent === "text:s") setTimeout(() => { pane.screen = CLAUDE_MODEL_CLOSED; }, 200);
      };
      const prompt = (await card())!;
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "text:s"]);
      expect(await card()).toBeNull();
    });
  });

  test("answers Claude's question tabs only once the pane shows the next step, so the step answered does not come up again", async () => {
    // Claude Code 2.1.314: two questions, then the review, each drawn a moment after the key
    const rule = "─".repeat(80);
    const tabs = (device: boolean, symptoms: boolean) => `←  ${device ? "☒" : "☐"} Device  ${symptoms ? "☒" : "☐"} Symptoms  ✔ Submit  →\n\n`;
    const hint = "\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel\n";
    const mark = (at: number, row: number) => at === row ? "❯" : " ";
    const device = (at: number) => `${tabs(false, false)}Which device do you use?\n\n${["Phone", "Desktop browser", "Type something."].map((row, index) => `${mark(at, index)} ${index + 1}. ${row}`).join("\n")}\n${rule}\n  4. Chat about this\n${hint}`;
    const problems = ["Answer not sent", "Wrong option sent", "Card stays open"];
    const symptoms = (at: number, ticked: number[]) => `${tabs(true, ticked.length > 0)}Which problems do you see?\n\n${problems.map((row, index) => `${mark(at, index)} ${index + 1}. [${ticked.includes(index) ? "✔" : " "}] ${row}`).join("\n")}\n${mark(at, 3)} 4. [ ] Type something\n     Submit\n${rule}\n  5. Chat about this\n${hint}`;
    const review = `${tabs(true, true)}Review your answers\n\n ● Which device do you use?\n   → Desktop browser\n ● Which problems do you see?\n   → Answer not sent, Card stays open\n\nReady to submit your answers?\n\n❯ 1. Submit answers\n  2. Cancel\n`;
    await withPane("claude", "blocked", device(0), async (pane) => {
      let at = 0;
      const ticked: number[] = [];
      pane.onSent = (sent) => {
        if (sent === "down") pane.screen = device(++at);
        if (sent === "enter") setTimeout(() => { at = 0; pane.screen = symptoms(at, ticked); }, 200);
      };
      expect(await answer((await card())!.id, { option_index: 1 })).toEqual({ status: 200, code: undefined });
      expect((await card())!.question).toBe("Which problems do you see?");

      pane.onSent = (sent) => {
        if (sent === "down") at += 1;
        if (sent === "enter" || sent === "space") ticked.push(at);
        pane.screen = symptoms(at, ticked);
        // the review comes in two draws: its heading first, a screen no reader knows
        if (sent === "right") setTimeout(() => { pane.screen = `${tabs(true, true)}Review your answers\n`; }, 100);
        if (sent === "right") setTimeout(() => { pane.screen = review; }, 300);
      };
      expect(await answer((await card())!.id, { option_indices: [0, 2] })).toEqual({ status: 200, code: undefined });
      expect(ticked).toEqual([0, 2]);
      expect((await card())!.title).toBe("Review your answers");

      // submitted: Claude goes on with the answers
      pane.onSent = (sent) => { if (sent === "enter") setTimeout(() => { pane.status = "working"; pane.screen = `⏺ User answered Claude's questions\n\n${rule}\n❯ \n${rule}\n`; }, 200); };
      expect(await answer((await card())!.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(await card()).toBeNull();
    });
  });

  // #2464's wait covered Claude's question tabs only; its other dialogs close a moment after the key too (live on
  // Claude Code 2.1.316: the trust check read again right after its answer, under a new id; the plan read again
  // after its feedback, the feedback drawn in its last row and read as a plain option)
  const rows = (labels: string[], at: number, numbered: boolean, indent = " ") => labels.map((label, index) => `${indent}${index === at ? "❯" : " "} ${numbered ? `${index + 1}. ` : ""}${label}`).join("\n");
  test.each([
    ["a tool approval", (at: number) => `● Bash(touch made.txt)\n${"─".repeat(80)}\n Bash command\n   touch made.txt\n   Create the file\n Do you want to proceed?\n${rows(["Yes", "Yes, and always allow access to /tmp/x from this project", "No"], at, true)}\n Esc to cancel · Tab to amend\n`, { option_index: 0 }],
    ["the folder-trust check", (at: number) => ` Accessing workspace:\n\n /tmp/garden\n\n Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\n project, or work from your team).\n\n${rows(["No, exit", "Yes, I trust this folder"], at, false)}\n\n Enter to confirm · Esc to cancel\n`, { option_index: 1 }],
    ["a plan, with feedback", (at: number, typed = "Tell Claude what to change") => `Ready to code?\n\nHere is Claude's plan:\nAdd a heading to the README file.\n\nClaude has written up a plan and is ready to execute. Would you like to proceed?\n\n${rows(["Yes, auto-accept edits", "Yes, manually approve edits", typed], at, true, "")}\n     shift+tab to approve with this feedback\n`, { custom_text: "Keep the intro" }],
  ] as const)("answers %s only once Claude has closed it, so the read right after gets no card", async (_name, dialog, choice) => {
    await withPane("claude", "blocked", dialog(0), async (pane) => {
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "down") pane.screen = dialog(++at);
        // the plan's typed feedback shows in its row before the key that sends it, as Claude draws it
        if (sent.startsWith("text:")) pane.screen = dialog(at, sent.slice(5));
        // the panel gives way to Claude's input box 200 ms after the key, while herdr still says blocked
        if (sent === "enter" || sent === "shift+tab") setTimeout(() => { pane.screen = `✻ Working… (esc to interrupt)\n${"─".repeat(80)}\n❯ \n${"─".repeat(80)}\n`; }, 200);
      };
      const before = (await card())!;
      expect(await answer(before.id, choice)).toEqual({ status: 200, code: undefined });
      // the card's read right after the answer: neither the dialog just answered, under a new id, nor a fallback card
      const after = await card();
      expect(after === null ? null : { title: after.title, options: after.options.map((option) => option.label), sameId: after.id === before.id }).toBeNull();
    });
  });

  test("an answer to a Claude approval that does not close waits about a second, however slow the reads", async () => {
    const approval = `● Bash(touch made.txt)\n${"─".repeat(80)}\n Bash command\n   touch made.txt\n   Create the file\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel · Tab to amend\n`;
    await withPane("claude", "blocked", approval, async (pane) => {
      const before = (await card())!;
      pane.readDelay = 100;
      const started = performance.now();
      expect(await answer(before.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      // 20 reads of 100 ms and more took over 3 s; the wait's own deadline is 1 s, plus the read in flight
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });

  // #2503 review by @jpcarranza94, live on Claude Code 2.1.316
  test("with colors (steps), an answer to Claude's last question waits through a half-drawn review", async () => {
    const panel = (state: string) => readFileSync(new URL(`./fixtures/claude-tabs-2.1.312-${state}-120.ansi`, import.meta.url), "utf8");
    const draw = (pane: Pane, screen: string) => { pane.viewport = screen; pane.screen = screen.replace(ANSI_RE, ""); };
    const review = panel("review");
    const heading = review.split("\n").slice(0, 4).join("\n") + "\n";
    await withPane("claude", "blocked", "", async (pane) => {
      draw(pane, panel("second"));
      const second = (await card())!;
      expect(second.steps?.length).toBe(3);
      pane.onSent = (sent) => {
        if (sent !== "enter") return;
        setTimeout(() => draw(pane, heading), 100);
        setTimeout(() => draw(pane, review), 300);
      };
      expect(await answer(second.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect((await card())!.title).toBe("Review your answers");
    });
  });

  test("goes back between Claude's question tabs with ← only as the pane shows each tab, and stops when it does not", async () => {
    // Claude Code 2.1.312 at 120 columns, colors kept: the active tab is drawn on a background (#2465)
    const panel = (state: string) => readFileSync(new URL(`./fixtures/claude-tabs-2.1.312-${state}-120.ansi`, import.meta.url), "utf8");
    // the first question once both are answered, as the review's ← ← shows it
    const states: Record<string, string> = {
      review: panel("review"), symptoms: panel("review-back"),
      device: panel("first-answered").replace("☐ Symptoms", "☒ Symptoms"),
    };
    const show = (pane: Pane, state: string) => { pane.viewport = states[state]!; pane.screen = states[state]!.replace(ANSI_RE, ""); };
    const order = ["device", "symptoms", "review"];
    const press = (pane: Pane, skip = false) => {
      let at = 2;
      pane.onSent = (sent) => {
        if (sent !== "left") return;
        at = Math.max(0, at - (skip ? 2 : 1));
        setTimeout(() => show(pane, order[at]!), 100);
      };
    };
    await withPane("claude", "blocked", "", async (pane) => {
      show(pane, "review");
      const review = (await card())!;
      expect(review).toMatchObject({ title: "Review your answers", can_step_back: true });
      expect(review.steps?.map((step) => step.can_navigate ?? false)).toEqual([true, true, false]);
      // the tab it is on, or one past the last: nothing to press
      for (const choice of [{ step_index: 2 }, { step_index: 3 }, { step_index: -1 }, { step_back: true, step_index: 0 }, { step_back: true, option_index: 0 }]) {
        expect((await answer(review.id, choice)).status).toBe(400);
      }
      expect(pane.sent).toEqual([]);
      press(pane);
      expect(await answer(review.id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["left"]);
      expect(await card()).toMatchObject({ question: "Which problems do you see?", can_step_back: true });
    });
    await withPane("claude", "blocked", "", async (pane) => {
      show(pane, "review");
      press(pane);
      expect(await answer((await card())!.id, { step_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["left", "left"]);
      const device = (await card())!;
      expect(device).toMatchObject({ title: "Device · 1 of 2", question: "Which device do you use?" });
      expect(device.can_step_back).toBeUndefined();
    });
    // a frame mid-redraw whose colors cannot be checked says nothing about the tab: the route looks again
    await withPane("claude", "blocked", "", async (pane) => {
      show(pane, "review");
      pane.onSent = (sent) => {
        if (sent !== "left") return;
        pane.viewport = states.symptoms!.replace(ANSI_RE, "");
        pane.screen = states.symptoms!.replace(ANSI_RE, "");
        setTimeout(() => show(pane, "symptoms"), 150);
      };
      expect(await answer((await card())!.id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["left"]);
    });
    // → lights the next tab a moment before the question under it is redrawn: that frame is no
    // finished move, so the second → waits for the question too
    await withPane("claude", "blocked", "", async (pane) => {
      const bar = (lit: number) => "← " + [" ☒ Device ", " ☒ Symptoms ", " ✔ Submit "]
        .map((tab, at) => at === lit ? `\u001b[38;2;0;0;0m\u001b[48;2;177;185;249m${tab}\u001b[0m` : tab).join("") + " →";
      const lit = (screen: string, at: number) => screen.split("\n").map((line) => line.replace(ANSI_RE, "").startsWith("←") ? bar(at) : line).join("\n");
      const draw = (screen: string) => { pane.viewport = screen; pane.screen = screen.replace(ANSI_RE, ""); };
      draw(states.device!);
      let at = 0;
      // the question drawn when each → went out
      const under: string[] = [];
      pane.onSent = (sent) => {
        if (sent !== "right") return;
        under.push(pane.screen.includes("Which problems do you see?") ? "symptoms" : "device");
        at += 1;
        const next = order[at]!;
        draw(lit(at === 1 ? states.device! : states.symptoms!, at));
        setTimeout(() => show(pane, next), 150);
      };
      expect(await answer((await card())!.id, { step_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["right", "right"]);
      expect(under).toEqual(["device", "symptoms"]);
      expect((await card())!.title).toBe("Review your answers");
    });
    // a poll while a step is on its way reads the tab it moves to: that card's id still answers once
    // the step is done, so the next tap on a step is not refused (#2503 review by @jpcarranza94)
    await withPane("claude", "blocked", "", async (pane) => {
      show(pane, "review");
      let polled: InteractivePrompt | null = null;
      pane.onSent = (sent) => {
        if (sent !== "left") return;
        const next = pane.sent.filter((key) => key === "left").length === 1 ? "symptoms" : "device";
        show(pane, next);
        // the poll runs to its end before herdr answers the key, so before the step can end
        if (next === "symptoms") pane.holdSend = card().then((shown) => { polled = shown; });
      };
      expect(await answer((await card())!.id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(polled!).toMatchObject({ question: "Which problems do you see?" });
      expect(await answer(polled!.id, { step_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["left", "left"]);
      expect((await card())!.question).toBe("Which device do you use?");
    });
    // a card read before moves that come back to its tab is not the card now: each move is a new
    // asking, so the review read before Back and a step back to the review is refused (#2503 review)
    await withPane("claude", "blocked", "", async (pane) => {
      show(pane, "review");
      const before = (await card())!;
      pane.onSent = (sent) => { if (sent === "left") show(pane, "symptoms"); if (sent === "right") show(pane, "review"); };
      expect(await answer(before.id, { step_back: true })).toEqual({ status: 200, code: undefined });
      expect(await answer((await card())!.id, { step_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["left", "right"]);
      expect((await card())!.title).toBe("Review your answers");
      expect(await answer(before.id, { step_back: true })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["left", "right"]);
    });
    // a poll begun during a move and answered after it read the tab the move left: it changes nothing
    // about the asking, so the card of the tab the move reached still answers (#2503 review)
    await withPane("claude", "blocked", "", async (pane) => {
      show(pane, "review");
      const review = (await card())!;
      let release = () => {};
      let late: Promise<InteractivePrompt | null> = Promise.resolve(null);
      pane.onSent = (sent) => {
        if (sent !== "left") return;
        pane.holdRead = new Promise<void>((resolve) => { release = resolve; });
        // the key waits for the poll's first read, taken as the review; only then does the pane redraw
        pane.holdSend = new Promise<void>((resolve) => { pane.onReadHeld = () => { pane.onReadHeld = undefined; show(pane, "symptoms"); resolve(); }; });
        late = card();
      };
      expect(await answer(review.id, { step_back: true })).toEqual({ status: 200, code: undefined });
      const reached = (await card())!;
      expect(reached.question).toBe("Which problems do you see?");
      release();
      await late;
      expect((await card())!.id).toBe(reached.id);
      pane.onSent = (sent) => { if (sent === "left") show(pane, "device"); };
      expect(await answer(reached.id, { step_back: true })).toEqual({ status: 200, code: undefined });
    });
    // the pane went two tabs for one ←: not the tab asked for, so no second key
    await withPane("claude", "blocked", "", async (pane) => {
      show(pane, "review");
      press(pane, true);
      expect(await answer((await card())!.id, { step_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["left"]);
    });
    // colors that do not say which tab is shown: no steps, and no key for a step
    await withPane("claude", "blocked", states.review!.replace(ANSI_RE, ""), async (pane) => {
      const review = (await card())!;
      expect(review.steps).toBeUndefined();
      expect((await answer(review.id, { step_back: true })).status).toBe(400);
      expect(pane.sent).toEqual([]);
    });
  });

  // each refusal waits out the answer's own 1.5 s for the list to show the row
  test("presses nothing in Codex's list once it is not the list, or the row, that was tapped", async () => {
    // the levels of another model in its place under the move: the same rows, another list
    await withPane("codex", "done", codexLevels(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = codexLevels(2, "GPT-6-Sol"); };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // closed in the terminal under the first move: no second arrow into Codex's own prompt
    await withPane("codex", "done", codexLevels(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = `${CODEX_HEAD}› Ask Codex to do anything\n\n  GPT-6-Astra medium · main\n`; };
      expect(await answer(prompt.id, { option_index: 3 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // a footer this reader does not know under the row: not a key to guess
    await withPane("codex", "done", codexLevels(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = () => { pane.screen = codexLevels(2).replace(CODEX_PICKS, "  enter default · esc back"); };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
    // a level's row whose footer turns out to say Enter opens a list: no Enter goes into a list
    // of levels, where the rows beside it save a default on that key
    const opening = (at: number) => codexList("Select Reasoning Level for GPT-6-Astra", CODEX_LEVELS, at, (row) => row === 2 || row === 4 ? CODEX_OPENS : CODEX_PICKS);
    await withPane("codex", "done", opening(1), async (pane) => {
      const prompt = (await card())!;
      pane.onSent = (sent) => { if (sent === "down") pane.screen = opening(2); };
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
    });
  }, 20_000);

  test("keeps fallback cards when a model title is only transcript text or belongs to another agent", async () => {
    const unknown = "Advanced Reasoning\nThis section explains the tradeoff.\n\nChoose a deployment target:\n  1. Staging\n  2. Production\n\nEnter a number, or Esc to cancel\n";
    for (const agent of ["claude", "omp", "codex"]) {
      await withPane(agent, "blocked", unknown, async () => {
        expect((await card())?.fallback).toBe(true);
      });
    }
    // a pi pane gets no generic card at all: its keys would be guessed into pi, which may show
    // pi-ask's form (it takes no typed keys); the terminal answers what no reader knows
    await withPane("pi", "blocked", unknown, async () => {
      expect(await card()).toBeNull();
    });
    await withPane("codex", "blocked", `${codexModels(1)}\nContinue deployment?\n${CODEX_OPENS}\n`, async () => {
      expect((await card())?.fallback).toBe(true);
    });
    // Words before the footer are not a long, fictitious key name.
    await withPane("codex", "blocked", codexModels(1).replace(CODEX_OPENS, `Continue deployment\n${CODEX_OPENS}`), async () => {
      expect((await card())?.fallback).toBe(true);
    });
    // Even a Codex-shaped footer belongs to the other agent's unknown prompt here (no generic card on pi).
    await withPane("pi", "blocked", codexLevels(1), async () => {
      expect(await card()).toBeNull();
    });
    // A newer picker title supersedes the older model heading in the visible transcript.
    const other = `Advanced Reasoning\n\nSelect Deployment Target\n\n› 1. Staging\n  2. Production\n\n${CODEX_OPENS}\n`;
    for (const screen of [other, other.replace("Select Deployment Target", "Choose a deployment target:"), other.replace("\n\nSelect Deployment Target", "\nSelect Deployment Target")]) {
      await withPane("codex", "blocked", screen, async () => {
        expect((await card())?.fallback).toBe(true);
      });
    }
  });

  test("offers no fallback card over a Codex list whose Enter would save a default", async () => {
    // rows this reader cannot take (something between them and their footer), under a status of
    // blocked left over from an approval: the fallback card's Enter is not offered here
    const unread = codexLevels(1).replace(`\n\n${CODEX_PICKS}`, `\n  Loading…\n${CODEX_PICKS}`);
    expect(parseInteractivePrompt("codex", unread)).toBeNull();
    expect(parseFallbackPrompt("codex", unread).options.map((option) => option.label)).toContain("Enter");
    await withPane("codex", "blocked", unread, async () => {
      expect(await card()).toBeNull();
    });
    // its footer cut beyond reading by a pane a few columns wide: the list's title still says what it is
    const cut = codexLevels(1).replace(CODEX_PICKS, "  enter\n  defa\n  ult ·\n  s\n  sessi\n  on ·\n  esc\n  back");
    expect(parseInteractivePrompt("codex", cut)).toBeNull();
    await withPane("codex", "blocked", cut, async () => {
      expect(await card()).toBeNull();
    });
    await withPane("codex", "blocked", `Loading\n${CODEX_PICKS}`, async () => {
      expect(await card()).toBeNull();
    });
    // A clipped title does not make a recognizable session/default footer safe to answer with Enter.
    await withPane("codex", "blocked", cut.replace("Select Reasoning Level for GPT-6-Astra", "Older transcript"), async () => {
      expect(await card()).toBeNull();
    });
    // An unreadable or remapped accept hint is still a model menu, not permission to offer Enter.
    for (const footer of ["  enter confirm · esc back", "  tab default · s session · esc back"]) {
      const unknown = codexLevels(1).replace(CODEX_PICKS, footer);
      expect(parseInteractivePrompt("codex", unknown)).toBeNull();
      await withPane("codex", "blocked", unknown, async () => {
        expect(await card()).toBeNull();
      });
    }
    // the list of quick presets has no card of its own, and no fallback one either
    await withPane("codex", "blocked", codexList("Select Model", CODEX_MODELS, 1, () => CODEX_OPENS), async () => {
      expect(await card()).toBeNull();
    });
    // a list the reader does take is its own card under any status
    await withPane("codex", "blocked", codexLevels(1), async (pane) => {
      pane.onSent = (sent) => { if (sent === "down") pane.screen = codexLevels(2); };
      const prompt = (await card())!;
      expect(prompt.fallback).toBeUndefined();
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "text:s"]);
    });
  });

  test("offers no fallback card over Claude's model list, whose Enter would save a default", async () => {
    // a name the pane cut in two: no reader takes the list, and herdr reports the pane blocked
    // (a status left over from an approval): the fallback card's Enter is not offered here
    const unread = claudeModelList(1).replace("  ↓ 10. Opus 4.7               Best for everyday, complex tasks", "  ↓ 10. Opus\n        4.7                    Best for everyday, complex tasks");
    expect(parseInteractivePrompt("claude", unread)).toBeNull();
    expect(parseFallbackPrompt("claude", unread).options.map((option) => option.label)).toContain("Enter");
    await withPane("claude", "blocked", unread, async () => {
      expect(await card()).toBeNull();
    });
    // its hint wrapped further than the reader follows it, in a pane narrower than any measured
    const narrow = unread.replace(CLAUDE_MODEL_HINT, "  Enter to set as\n  default · s to use\n  this session\n  only · Esc to\n  cancel");
    await withPane("claude", "blocked", narrow, async () => {
      expect(await card()).toBeNull();
    });
    // a list the reader does take is its own card under any status
    await withPane("claude", "blocked", claudeModelList(1), async (pane) => {
      let at = 1;
      pane.onSent = (sent) => { if (sent === "down") at += 1; pane.screen = claudeModelList(at); };
      const prompt = (await card())!;
      expect(prompt.fallback).toBeUndefined();
      expect(await answer(prompt.id, { option_index: 2 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["down", "text:s"]);
    });
  });

  test("offers no fallback card, and holds pending input, over an effort slider whose hint the reader cannot take", async () => {
    // a hint cut inside a word, and one without the session-only key: the slider's Enter still
    // saves the level as the default, so neither the fallback card nor a pending message may press it
    const unread = [
      claudeEffort(2, "  ←/→ to adjust · Enter to confirm · s for this ses\n  sion only · Esc to cancel"),
      claudeEffort(2, "  ←/→ to adjust · Enter to confirm · Esc to cancel"),
    ];
    for (const screen of unread) {
      expect(parseInteractivePrompt("claude", screen)).toBeNull();
      expect(parseFallbackPrompt("claude", screen).options.map((option) => option.label)).toContain("Enter");
      expect(registry.waits("claude", screen)).toBe(true);
      await withPane("claude", "blocked", screen, async () => {
        expect(await card()).toBeNull();
      });
    }
    // the same hint above later output belongs to an answered slider
    expect(registry.waits("claude", `${unread[1]}Some later output\n`)).toBe(false);
  });

  test("a screen read that comes back after the wait authorises no key", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      moving(pane, RESUME);
      const prompt = (await card())!;
      const moved = pane.onSent!;
      pane.onSent = (sent) => { moved(sent); pane.readDelay = 1_800; };
      const started = Date.now();
      expect(await answer(prompt.id, { option_index: 1 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["down"]);
      // cut off when the wait is over, not waited out
      expect(Date.now() - started).toBeLessThan(1_790);
    });
  }, 6_000);

  test("a lookup that herdr never answers is cut off with the wait", async () => {
    const collapsed = "\n• WAITING\n• Queued follow-up inputs\n  ? 1 question · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  GPT-6-Sol xhigh · ~/lab · Context 97% left\n";
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      pane.cwd = pane.root;
      const prompt = (await card())!;
      // under the move the screen is Codex's collapsed queue, whose card needs the pane's
      // rollout, and herdr does not say which one it is
      pane.onSent = () => { pane.agentUnanswered = true; pane.screen = collapsed; };
      const started = Date.now();
      expect((await answer(prompt.id, { option_index: 1 })).status).toBe(409);
      expect(pane.sent).toEqual(["down"]);
      expect(Date.now() - started).toBeLessThan(2_500);
    });
  }, 6_000);

  test("answers pi's text dialog on a herdr whose screen reads take 400 ms", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      pane.onSent = (sent) => { if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5)); };
      const prompt = (await card())!;
      pane.readDelay = 400;
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["ctrl+k", "ctrl+u", "text:fix/answers", "enter"]);
    });
  }, 10_000);

  test("goes on ticking a multiple choice whose descriptions a narrowed pane wraps", async () => {
    const described = (at: number, ticked: number[], narrow: boolean) => `
☐ Checks

Which checks should run?

${at === 0 ? "❯" : " "} 1. [${ticked.includes(0) ? "✓" : " "}] Lint
     ${narrow ? "Run the linters over\n     the whole repository" : "Run the linters over the whole repository"}
${at === 1 ? "❯" : " "} 2. [${ticked.includes(1) ? "✓" : " "}] ${narrow ? "Tests, unit and\n     integration" : "Tests, unit and integration"}
     ${narrow ? "Run every suite, which takes\n     about ten minutes" : "Run every suite, which takes about ten minutes"}
${at === 2 ? "❯" : " "} 3. Type something.
────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;
    await withPane("claude", "blocked", described(0, [], false), async (pane) => {
      let at = 0;
      const ticked: number[] = [];
      // the pane is narrowed as the first tick goes out: the same options, wrapped
      pane.onSent = (sent) => { if (sent === "down") at += 1; if (sent === "enter") ticked.push(at); pane.screen = described(at, ticked, true); };
      const prompt = (await card())!;
      expect(prompt.options[0]!.description).toBe("Run the linters over the whole repository");
      expect(await answer(prompt.id, { option_indices: [0, 1] })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter", "down", "enter", "right"]);
    });
  });

  test("answers a question of Codex's collapsed queue, and opens no queue for a request given up", async () => {
    // the conversation's earlier answer on screen ties the pane to its rollout (herdr's report alone does not)
    const said = "The training data is split by date, so the evaluation never sees a later example.";
    const collapsed = `\n\u2022 ${said}\n` + "\n• WAITING\n• Queued follow-up inputs\n  ? 2 questions · 8s\n    alt+↑ to answer\n› Ask Codex to do anything\n  GPT-6-Sol xhigh · ~/lab · Context 97% left\n";
    const open = (at: number) => `\n• Queued follow-up inputs\n  1 of 2\n  Which split?\n  ${at === 0 ? "›" : " "} 1. train\n  ${at === 1 ? "›" : " "} 2. test\n  ${at === 2 ? "›" : " "} 3. Other\n  enter submit   ctrl+] skip   alt+↓ main prompt\n`;
    const item = (payload: unknown) => `${JSON.stringify({ type: "response_item", payload })}\n`;
    const ask = (call: string, count = 1) => item({ type: "function_call", name: "request_user_input_async", call_id: call, arguments: JSON.stringify({ questions: Array.from({ length: count }, () => ({ title: "Which split?", options: ["train", "test"] })) }) });
    await withPane("codex", "working", collapsed, async (pane) => {
      const home = join(pane.root, "codex");
      mkdirSync(join(home, "sessions"), { recursive: true });
      pane.rollout = join(home, "sessions", "rollout.jsonl");
      pane.cwd = pane.root;
      // one call asks the same question twice: the card is the first of the two
      writeFileSync(pane.rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "t", source: "cli" } })}\n${item({ type: "message", role: "assistant", content: [{ type: "output_text", text: said }] })}${ask("call_1", 2)}`);
      const queued = (await card(home))!;
      expect(queued.queued).toBe("collapsed");
      // another terminal client opens the queue between this answer's first read and its read
      // before alt+↑: the answer is refused, and the queue it did not open is not its to close
      let reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 2) pane.screen = open(0); };
      expect(await answer(queued.id, { option_index: 1 }, { codexHome: home })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      pane.screen = collapsed;
      pane.onRead = undefined;
      // refused with nothing sent, the card is still the one that was read
      expect((await card(home))!.id).toBe(queued.id);
      // a request given up while the screen is read before alt+↑ (the answer's second read,
      // after the one that finds the card) opens no queue
      const abort = new AbortController();
      reads = 0;
      pane.onRead = () => { reads += 1; if (reads === 2) abort.abort(); };
      expect((await answer(queued.id, { option_index: 1 }, { signal: abort.signal, codexHome: home })).status).toBe(409);
      expect(pane.sent).toEqual([]);
      pane.onRead = undefined;
      // given up with nothing sent: the same card still
      expect((await card(home))!.id).toBe(queued.id);
      let at = 0;
      pane.onSent = (sent) => {
        if (sent === "alt+up") pane.screen = open(0);
        if (sent === "down") {
          at += 1;
          // the rollout catches up under the answer: another call asking the same thing
          appendFileSync(pane.rollout!, ask("call_2"));
          pane.screen = open(at);
        }
        if (sent === "enter") pane.screen = "› Ask Codex to do anything\n";
      };
      // neither the twin nor the rollout's news under the answer is a reason to refuse: the
      // question on the screen is the card's
      expect(await answer(queued.id, { option_index: 1 }, { codexHome: home })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["alt+up", "down", "enter"]);

      // The queue opens on another question than the card's, and the alt+↓ that closes it
      // again is pressed with its reply lost; another client has the queue open after that.
      // This request closes it no second time
      pane.sent.length = 0;
      pane.screen = collapsed;
      const later = (await card(home))!;
      const other = open(0).replace("Which split?", "Which metric?");
      pane.replyLostOn = "alt+down";
      pane.onSent = (sent) => { pane.screen = sent === "alt+up" || sent === "alt+down" ? other : pane.screen; };
      expect((await answer(later.id, { option_index: 0 }, { codexHome: home })).status).not.toBe(200);
      expect(pane.sent).toEqual(["alt+up", "alt+down"]);
    });
  });

  test("a key herdr may have pressed, its reply lost, has ended the asking", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      pane.replyLostOn = "enter";
      // herdr pressed the Enter and the answer never heard so: the route fails
      expect((await answer(first.id, { option_index: 0 })).status).not.toBe(200);
      expect(pane.sent).toEqual(["enter"]);
      pane.replyLostOn = undefined;
      // the same menu asked again is another asking: the old card's id answers nothing
      expect((await card())!.id).not.toBe(first.id);
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("a key that never reached herdr has ended nothing", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // herdr is gone between the answer's read and its Enter: nothing is pressed
      const socket = process.env["HERDR_SOCKET"]!;
      pane.onRead = () => { process.env["HERDR_SOCKET"] = join(pane.root, "gone.sock"); };
      try {
        expect((await answer(first.id, { option_index: 0 })).status).toBe(502);
      } finally { process.env["HERDR_SOCKET"] = socket; }
      pane.onRead = undefined;
      expect(pane.sent).toEqual([]);
      // the card is still the one to answer, with whatever was picked in it
      expect((await card())!.id).toBe(first.id);
    });
  });

  test("a read held up before its screen read ends the asking its empty screen shows", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // another device's read waits on herdr's snapshot
      pane.nextSnapshotDelay = 300;
      const held = card();
      // meanwhile an answer begins and is given up, with nothing sent
      const abort = new AbortController();
      pane.onRead = () => abort.abort();
      expect((await answer(first.id, { option_index: 0 }, { signal: abort.signal })).status).toBe(409);
      pane.onRead = undefined;
      expect(pane.sent).toEqual([]);
      // the menu is answered in the terminal: the held read finds no prompt, and says so
      pane.screen = "Working…\n";
      pane.status = "working";
      expect(await held).toBeNull();
      // asked again as it was, it is another asking
      pane.screen = menu(RESUME);
      pane.status = "blocked";
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test("a read that began under an answer and comes back after it changes nothing", async () => {
    await withPane("pi", "idle", input("Branch name?"), async (pane) => {
      const prompt = (await card())!;
      let late: Promise<InteractivePrompt | null> | undefined;
      pane.onSent = (sent) => {
        // another device reads the pane as the answer empties the line, catches the screen
        // between two draws, and herdr is slow to say so
        if (sent === "ctrl+k") { pane.nextRead = { text: "", delay: 400 }; late = card(); }
        if (sent.startsWith("text:")) pane.screen = input("Branch name?", sent.slice(5));
        if (sent === "enter") pane.screen = input("Delete which branch?");
      };
      expect(await answer(prompt.id, { custom_text: "fix/answers" })).toEqual({ status: 200, code: undefined });
      // the next dialog has its card before that read is back
      const next = (await card())!;
      expect(next.question).toBe("Delete which branch?");
      expect(await late!).toBeNull();
      // and it is still that card: the late read ended no asking
      expect((await card())!.id).toBe(next.id);
      pane.onSent = undefined;
      expect((await answer(next.id, { custom_text: "old/one" })).status).toBe(200);
    });
  });

  test("an asking is kept however many panes ask", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      pane.more = 257;
      const first = (await card())!;
      for (let index = 2; index <= 258; index += 1) expect(await card(undefined, `p_${index}`)).not.toBeNull();
      expect((await card())!.id).toBe(first.id);
    });
  }, 20_000);

  test("a prompt keeps its id from read to read while it waits", async () => {
    await withPane("codex", "blocked", menu(RESUME), async () => {
      const first = (await card())!;
      expect((await card())!.id).toBe(first.id);
      // and it is not the hash of its text alone
      expect(first.id).not.toBe(parseInteractivePrompt("codex", menu(RESUME))!.id);
    });
  });

  test("refuses an answer to a prompt that went away and was asked again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // answered in the terminal: a read finds no menu, then the same menu asked again
      pane.screen = "Working…\n";
      pane.status = "working";
      expect(await card()).toBeNull();
      pane.screen = menu(RESUME);
      pane.status = "blocked";
      const second = (await card())!;
      expect(labels(second)).toEqual(labels(first));
      expect(second.id).not.toBe(first.id);
      // the first asking's card, still open on another device (or its typed pick's Confirm)
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect(await answer(second.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(pane.sent).toEqual(["enter"]);
    });
  });

  test("refuses a second answer to the id of a prompt already answered, the same one asked again", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // the screen never changes: answered, the menu is asked again as it was
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual(["enter"]);
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test("refuses an answer to a prompt asked again after the agent went back to work unseen", async () => {
    await withPane("codex", "blocked", menu(RESUME), async (pane) => {
      const first = (await card())!;
      // answered in the terminal and asked again between two reads: only herdr's status says so
      promptWaitEnded("p_1");
      expect(await answer(first.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
      expect(pane.sent).toEqual([]);
      expect((await card())!.id).not.toBe(first.id);
    });
  });

  test("logs prompt answer requests with pane_id, prompt_matched and outcome", async () => {
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    try {
      await withPane("codex", "blocked", menu(RESUME), async (pane) => {
        const prompt = (await card())!;
        logged.length = 0;
        expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 200, code: undefined });
        expect(logged.some((line) => line.includes("[prompt/answer]") && line.includes("pane=\"p_1\"") && line.includes("prompt_matched=true") && line.includes("outcome=ok"))).toBe(true);
        logged.length = 0;
        expect(await answer(prompt.id, { option_index: 0 })).toEqual({ status: 409, code: "prompt_changed" });
        expect(logged.some((line) => line.includes("[prompt/answer]") && line.includes("pane=\"p_1\"") && line.includes("prompt_matched=false") && line.includes("outcome=prompt_changed"))).toBe(true);
        // the pane id is the client's until the snapshot has checked it: no newline or escape of it reaches the log
        logged.length = 0;
        const url = new URL("http://127.0.0.1/api/pane/prompt/answer");
        const forged = "p_1\nFORGED \u001b[2J prompt_matched=true outcome=ok";
        const response = (await handlePromptRequest(new Request(url, { method: "POST", body: JSON.stringify({ pane_id: forged, prompt_id: prompt.id, option_index: 0 }) }), url, {}))!;
        expect(response.ok).toBe(false);
        const line = logged.find((entry) => entry.includes("[prompt/answer]"));
        expect(line).toBeDefined();
        expect(line!.includes("\n")).toBe(false);
        expect(line!.includes("\u001b")).toBe(false);
        // the forged fields stay inside the quoted id; the line's own fields follow it
        if (!line!.includes(`pane=${JSON.stringify(forged)} prompt_matched=false outcome=`)) throw new Error(`unexpected log line: ${line}`);
      });
    } finally { console.log = originalLog; }
  });
});

// fork: Claude Code 2.1.29x screens the readers missed, answered as menus (arrows + enter), never by typing the number
describe("Claude Code 2.1.29x approvals and questions", () => {
  const RULE = "─".repeat(80);
  const DASH = "╌".repeat(80);
  test("accepts its exact background-agent footer, but not unknown trailing text", () => {
    const footer = CLAUDE_BACKGROUND_APPROVAL_FOOTER;
    for (const accepted of [
      footer,
      "Esc to cancel · Tab to amend",
      "Esc to cancel · Tab to amend · ctrl+e to explain",
      "Esc to cancel · ctrl+e to explain",
      "Esc to cancel",
    ]) {
      const prompt = parseInteractivePrompt("claude", claudeBackgroundApproval(1, accepted));
      expect(prompt).toMatchObject({
        kind: "approval",
        title: "Bash command · from the general-purpose agent",
        question: "Do you want to proceed?",
      });
      expect(labels(prompt)).toEqual(["Yes", "Yes, and don't ask again for: systemctl --user start demo.service", "No"]);
    }
    for (const unknown of [
      "Esc to cancel Password:",
      "Esc to cancel · Password:",
      "Esc to cancel · unknown trailing text",
      `${footer} · Password:`,
    ]) {
      expect(parseInteractivePrompt("claude", claudeBackgroundApproval(1, unknown))).toBeNull();
    }
  });

  test("an approval whose hint is Esc to cancel alone is a card", () => {
    const screen = [
      "● Bash(systemctl --user restart demo.service)",
      "  ⎿  Waiting…",
      "",
      RULE,
      " Bash command",
      " Restart the demo service",
      DASH,
      " │ systemctl --user restart demo.service",
      DASH,
      " │ Permission rule Bash(systemctl --user restart:*) requires confirmation for this command.",
      " /permissions to update rules",
      "",
      " Do you want to proceed?",
      "   1. Yes",
      " ❯ 2. Yes, and don't ask again for: systemctl *",
      "   3. No",
      "",
      " Esc to cancel",
      "",
    ].join("\n");
    const prompt = parseInteractivePrompt("claude", screen)!;
    expect(prompt).toMatchObject({ kind: "approval", title: "Bash command", question: "Do you want to proceed?" });
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes", "Yes, and don't ask again for: systemctl *", "No"]);
    expect(answerKeys(prompt, { option_index: 0 }).flatMap((step) => step.keys ?? [])).toEqual(["up", "enter"]);
  });

  test("a long command pushes the panel's title off the screen: still an approval", () => {
    const screen = [
      ...Array.from({ length: 24 }, (_, index) => ` │ echo line ${index}`),
      DASH,
      " A variable in this command can't be checked before it runs",
      " │ Permission rule Bash(systemctl --user daemon-reload:*) requires confirmation for this command.",
      " /permissions to update rules",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      "",
      " Esc to cancel · Tab to amend",
      "",
    ].join("\n");
    const prompt = parseInteractivePrompt("claude", screen)!;
    expect(prompt).toMatchObject({ kind: "approval", title: "Command approval", question: "Do you want to proceed?" });
    expect(prompt.options.map((option) => option.label)).toEqual(["Yes", "No"]);
  });

  test("a question whose typed-answer row already holds a draft keeps it as the typed answer", () => {
    const screen = [
      "❯ which session should get the notes?",
      RULE,
      " ☐ Session",
      "",
      "Two sessions are open. Which one?",
      "",
      "  1. builder-a",
      "     started 15 hours ago",
      "  2. builder-b",
      "     started 13 hours ago",
      "❯ 3. neither, tell me their names",
      RULE,
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · ctrl+g to edit in VS Code · Esc to cancel",
      "",
    ].join("\n");
    const prompt = parseInteractivePrompt("claude", screen)!;
    expect(prompt).toMatchObject({ kind: "question", title: "Session", question: "Two sessions are open. Which one?", custom_option_index: 2 });
    expect(prompt.options.map((option) => option.label)).toEqual(["builder-a", "builder-b"]);
    expect(answerKeys(prompt, { option_index: 1 }).flatMap((step) => step.keys ?? [])).toEqual(["up", "enter"]);
  });

  test("an answered approval above another program's bare Esc to cancel hint is no card", () => {
    const screen = [
      RULE,
      " Bash command",
      " sudo -v",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      "",
      " Esc to cancel · Tab to amend",
      "Password:",
      "Esc to cancel",
      "",
    ].join("\n");
    expect(parseInteractivePrompt("claude", screen)).toBeNull();
  });

  test("an answered approval whose hint a narrow pane wrapped, above another bare hint, is no card", () => {
    const screen = [
      RULE,
      " Bash command",
      " sudo -v",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      "",
      " Esc to",
      " cancel · Tab to amend",
      "Password:",
      "Esc to cancel",
      "",
    ].join("\n");
    expect(parseInteractivePrompt("claude", screen)).toBeNull();
  });

  test("an option that names Esc to cancel in its own text keeps the approval a card", () => {
    const screen = [
      RULE,
      " Bash command",
      " echo Esc to cancel",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don’t ask again for: echo Esc to cancel:*",
      "   3. No",
      "",
      " Esc to cancel · Tab to amend",
      "",
    ].join("\n");
    expect(parseInteractivePrompt("claude", screen)?.options.length).toBe(3);
  });

  test("a command line that reads Tip: is part of a scrolled approval's asking", () => {
    const scrolledApproval = (tip: string) => [
      " │ cat <<EOF",
      ` │ Tip: ${tip}`,
      " │ EOF",
      DASH,
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      "",
      " Esc to cancel · Tab to amend",
      "",
    ].join("\n");
    const hello = parseInteractivePrompt("claude", scrolledApproval("hello"))!;
    const changed = parseInteractivePrompt("claude", scrolledApproval("$(rm -rf important)"))!;
    expect(changed.body).toContain("rm -rf important");
    expect(changed.id).not.toBe(hello.id);
  });

  test("a boxed line and a dashed rule further up the screen do not make printed rows an approval", () => {
    const screen = [
      " │ earlier boxed output",
      DASH,
      "● Here is what the dialog says:",
      "",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
      "    2. No",
      "",
      "  Esc to cancel",
      "",
    ].join("\n");
    expect(parseInteractivePrompt("claude", screen)).toBeNull();
  });

  test("a printed approval with no panel left above it is no card", () => {
    const screen = ["Printed example", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "Esc to cancel", ""].join("\n");
    expect(parseInteractivePrompt("claude", screen)).toBeNull();
  });

  test("a scrolled approval is another asking when a command line far above the question changes", () => {
    const scrolledApproval = (first: string) => [
      ` │ ${first}`,
      ...Array.from({ length: 12 }, () => " │ echo same"),
      DASH,
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. No",
      "",
      " Esc to cancel · Tab to amend",
      "",
    ].join("\n");
    const harmless = parseInteractivePrompt("claude", scrolledApproval("echo harmless"))!;
    const changed = parseInteractivePrompt("claude", scrolledApproval("rm -rf important"))!;
    expect(changed.body).toContain("rm -rf important");
    expect(changed.id).not.toBe(harmless.id);
  });

  test("a menu ending in Chat about this with no question chip or rule over it has no typed-answer row", () => {
    const screen = [
      "Choose an item",
      "  1. Keep",
      "❯ 2. Delete",
      "  3. Chat about this",
      "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel",
      "",
    ].join("\n");
    expect(parseInteractivePrompt("claude", screen)?.custom_option_index ?? null).toBeNull();
  });

  // live on 2.1.295: the draft stays in its row when the cursor moves up, and the hint loses ctrl+g
  test("a drafted question stays a card with the cursor on another row", () => {
    const screen = [
      RULE,
      " ☐ Pick",
      "",
      "Which fruit?",
      "",
      "  1. apple",
      "     Apple",
      "❯ 2. pear",
      "     Pear",
      "  3. my draft",
      RULE,
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
      "",
    ].join("\n");
    const prompt = parseInteractivePrompt("claude", screen)!;
    expect(prompt).toMatchObject({ kind: "question", title: "Pick", custom_option_index: 2 });
    expect(prompt.options.map((option) => option.label)).toEqual(["apple", "pear"]);
    expect(answerKeys(prompt, { option_index: 0 }).flatMap((step) => step.keys ?? [])).toEqual(["up", "enter"]);
    expect(answerKeys(prompt, { custom_text: "plum" }).flatMap((step) => step.keys ?? [`text:${step.text}`]))
      .toEqual(["down", "ctrl+k", "ctrl+u", "text:plum", "enter"]);
  });

  // live on 2.1.295: the typed text went in after the draft, "neither, tell me their namesbuilder-c"
  test("a typed answer replaces the draft in the row instead of joining it", () => {
    const screen = [
      RULE,
      " ☐ Session",
      "",
      "Two sessions are open. Which one?",
      "",
      "  1. builder-a",
      "     started 15 hours ago",
      "  2. builder-b",
      "     started 13 hours ago",
      "❯ 3. neither, tell me their names",
      RULE,
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel",
      "",
    ].join("\n");
    const prompt = parseInteractivePrompt("claude", screen)!;
    expect(answerKeys(prompt, { custom_text: "builder-c" }).flatMap((step) => step.keys ?? [`text:${step.text}`]))
      .toEqual(["ctrl+k", "ctrl+u", "text:builder-c", "enter"]);
  });
});

// Claude Code 2.1.296's multiple choice, captured in #752: a ticked row is drawn [✔], and the
// unnumbered Submit row between the typed answer and "Chat about this" takes the cursor too
describe("Claude's multiple choice answered with its own text", () => {
  // Claude Code 2.1.301: typing into "Type something" ticks that row, and Enter on Submit, under
  // it, takes the answer to the next question or the review (→ there moves the text's cursor)
  const screen = (at: "Manzana" | "Submit", typed = false) => [
    "←  ☐ Frutas  ✔ Submit  →",
    "¿Qué frutas?",
    `${at === "Manzana" ? "❯" : " "} 1. [ ] Manzana`,
    "         Manzana",
    "  2. [ ] Pera",
    "         Pera",
    typed ? "  3. [✔] Kiwi" : "  3. [ ] Type something",
    `${at === "Submit" ? "❯" : " "}    Submit`,
    "─".repeat(119),
    "  4. Chat about this",
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");

  test("offers the typed answer, and types it in its row before Enter on Submit", () => {
    const prompt = parseInteractivePrompt("claude", screen("Manzana"))!;
    expect(prompt).toMatchObject({ multi_select: true, custom_option_index: 2 });
    expect(labels(prompt)).toEqual(["Manzana", "Pera"]);
    expect(answerKeys(prompt, { custom_text: "Kiwi" })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { text: "Kiwi" }, { keys: ["down"] }, { keys: ["enter"] }]);
    // from Submit, the row is one up
    expect(answerKeys(parseInteractivePrompt("claude", screen("Submit"))!, { custom_text: "Kiwi" })).toEqual([{ keys: ["up"] }, { text: "Kiwi" }, { keys: ["down"] }, { keys: ["enter"] }]);
    // the choices still go as they did
    expect(answerKeys(prompt, { option_indices: [1] })).toEqual([{ keys: ["down"] }, { keys: ["enter"] }, { keys: ["right"] }]);
  });

  test("empties a draft already typed into the row first", () => {
    const prompt = parseInteractivePrompt("claude", screen("Manzana", true))!;
    expect(prompt).toMatchObject({ multi_select: true, custom_option_index: 2 });
    expect(answerKeys(prompt, { custom_text: "Uva" })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["ctrl+k"] }, { keys: ["ctrl+u"] }, { text: "Uva" }, { keys: ["down"] }, { keys: ["enter"] }]);
  });
});

describe("Claude's multiple choice ticked in the terminal", () => {
  const screen = (ticked: boolean, at: "A" | "B" | "Submit" | "Chat") => [
    `←  ${ticked ? "☒" : "☐"} Pick  ✔ Submit  →`,
    "Which ones?",
    `${at === "A" ? "❯" : " "} 1. [${ticked ? "✔" : " "}] Option A`,
    "         First description",
    `${at === "B" ? "❯" : " "} 2. [${ticked ? "✔" : " "}] Option B`,
    "         Second description",
    "  3. [ ] Type something",
    `${at === "Submit" ? "❯" : " "}    Submit`,
    "─".repeat(40),
    `${at === "Chat" ? "❯" : " "} 4. Chat about this`,
    "Enter to select · ↑/↓ to navigate · Esc to cancel",
  ].join("\n");

  test("reads [✔] rows as ticked, without the box in their labels", () => {
    const prompt = parseInteractivePrompt("claude", screen(true, "B"))!;
    expect(prompt).toMatchObject({ kind: "question", title: "Multiple choice", question: "Which ones?", multi_select: true, custom_option_index: 2 });
    expect(prompt.options.map((option) => option.label)).toEqual(["Option A", "Option B"]);
    // both are ticked: only A is wanted, so B (under the cursor) is unticked, never ticked again
    expect(answerKeys(prompt, { option_indices: [0] })).toEqual([{ keys: ["enter"] }, { keys: ["right"] }]);
    expect(answerKeys(prompt, { option_indices: [0, 1] })).toEqual([{ keys: ["right"] }]);
  });

  test("keeps the card with the cursor on Submit, counting the moves from that row", () => {
    const prompt = parseInteractivePrompt("claude", screen(true, "Submit"))!;
    expect(prompt).toMatchObject({ question: "Which ones?", multi_select: true });
    expect(prompt.options.map((option) => option.label)).toEqual(["Option A", "Option B"]);
    // Submit → Type something → Option B
    expect(answerKeys(prompt, { option_indices: [0] })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }, { keys: ["right"] }]);
  });

  test("counts the Submit row between the typed answer and Chat about this", () => {
    const prompt = parseInteractivePrompt("claude", screen(false, "Chat"))!;
    // Chat about this → Submit → Type something → Option B → Option A
    expect(answerKeys(prompt, { option_indices: [0] })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }, { keys: ["right"] }]);
  });
});

// #542: the model list's hint as a narrow pane wraps it, and the same words quoted in Claude's output
describe("Claude Code's model list under a hint wrapped anywhere", () => {
  const list = (hint: string) => claudeModelList(1).replace(CLAUDE_MODEL_HINT, hint);

  test("holds the screen and reads the list with the hint split inside a word", () => {
    const split = list("  Enter to set as default · s to use this ses\n  sion only · Esc to cancel");
    expect(registry.waits("claude", split)).toBe(true);
    expect(registry.waits("claude", `${split}──────────── Session name ─\n`)).toBe(true);
    expect(parseInteractivePrompt("claude", split)?.options.map((option) => option.label)).toEqual(CLAUDE_MODELS.slice(0, 10).map(([name]) => name));
    // the same list's text above later output still holds nothing
    expect(registry.waits("claude", `${split}Some later output\nand more\n`)).toBe(false);
  });

  test("holds the screen and reads the list with the hint over seven lines", () => {
    const tall = list("  Enter to\n  set as\n  default ·\n  s to use\n  this\n  session\n  only · Esc to cancel");
    expect(registry.waits("claude", tall)).toBe(true);
    expect(parseInteractivePrompt("claude", tall)?.options).toHaveLength(10);
  });

  test("does not take the hint quoted in Claude's output for an open list", () => {
    const quoted = `${CLAUDE_MODEL_CLOSED}⏺ Example: Enter to set as default · s to use this session only · Esc to\n  cancel\n──────────── Summary ─\n`;
    expect(registry.waits("claude", quoted)).toBe(false);
    expect(registry.waits("claude", `⏺ Enter to set as default · s to use this session only · Esc to cancel\n`)).toBe(false);
  });
});

describe("hermesInputDraft", () => {
  // input rows of real Hermes 0.21.5 screens (herdr pane read --source visible --format ansi)
  const CLASSIC_HINT = "\u001b[0m\u001b[38;5;230m❯ \u001b[0m\u001b[3m\u001b[38;5;136mType / to browse commands, or Ctrl+P for the palette\u001b[0m";
  const CLASSIC_TYPED = "\u001b[0m\u001b[38;5;230m❯ \u001b[0mReply with only the word";
  const TUI_HINT = " \u001b[0m\u001b[1m\u001b[38;2;255;248;220m❯ \u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;184;134;11mT\u001b[0m\u001b[38;2;184;134;11mry \"how does the config loader work?\"\u001b[0m";
  const TUI_TYPED = " \u001b[0m\u001b[1m\u001b[38;2;255;248;220m❯ \u001b[0m\u001b[38;2;255;248;220mReply with only the word\u001b[0m              ";
  const screen = (input: string) => `● ❯ an earlier message, echoed\n────────\n${input}\n────────`;
  const plain = (ansi: string) => ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const draft = (input: string, colors: string | null = screen(input)) => hermesInputDraft(plain(screen(input)), colors);

  test("knows text typed into the classic CLI or the TUI for a draft", () => {
    expect(draft(CLASSIC_TYPED)).toBe(true);
    expect(draft(TUI_TYPED)).toBe(true);
    // a `❯` the user typed is text, not the prompt
    expect(draft("\u001b[0m\u001b[38;5;230m❯ \u001b[0mreview ❯ ")).toBe(true);
  });

  test("takes neither interface's own hint for a draft: the classic italic placeholder, the TUI's cursor chip", () => {
    expect(draft(CLASSIC_HINT)).toBe(false);
    expect(draft(TUI_HINT)).toBe(false);
  });

  test("reads an input with nothing after the prompt as empty, without colors", () => {
    expect(draft(" \u001b[1m❯ \u001b[0m", null)).toBe(false);
  });

  test("knows a draft that holds a `❯` without colors too, and reads an empty prompt row with colors as empty", () => {
    expect(draft("\u001b[0m\u001b[38;5;230m❯ \u001b[0mreview ❯ ", null)).toBe(true);
    expect(draft("\u001b[0m\u001b[38;5;230m❯ \u001b[0m")).toBe(false);
  });

  test("counts any text as a draft without colors verified to show that screen", () => {
    expect(draft(CLASSIC_HINT, null)).toBe(true);
    expect(draft(TUI_HINT, screen(CLASSIC_TYPED))).toBe(true);
  });

  test("does not know a screen without an input row to be empty", () => {
    expect(hermesInputDraft("Approve this command?\n  [1] Approve once\n", null)).toBe(true);
  });
});

// Captured from OmO 5.1.30 (engine senpi 2026.10.11) running /model in an isolated herdr session:
// fullscreen at 120 columns, after `gpt` was typed and the cursor moved down, and at 46 columns.
describe("OmO's model list", () => {
  const wide = `Only showing models from configured providers. Use /login to add providers.

enter select ctrl+s select as default ctrl+f favorite

>

→   claude-opus-4-8 [anthropic] ✓
    claude-fable-5 [anthropic]
    claude-fable-5-1 [anthropic]
    claude-haiku-4-5 [anthropic]
    claude-haiku-4-5-20251001 [anthropic]
    claude-haiku-5-5 [anthropic]
    claude-opus-4-5 [anthropic]
    claude-opus-4-5-20251101 [anthropic]
    claude-opus-4-6 [anthropic]
    claude-opus-4-7 [anthropic]
    claude-opus-5 [anthropic]
    claude-opus-5-5 [anthropic]
    claude-sonnet-4-5 [anthropic]
    claude-sonnet-4-5-20250929 [anthropic]
    claude-sonnet-4-6 [anthropic]
    claude-sonnet-5 [anthropic]
    claude-sonnet-5-5 [anthropic]
    gpt-5.3-codex-spark [chatgpt-subscription]
    gpt-5.5 [chatgpt-subscription]
    gpt-5.6-luna [chatgpt-subscription]
  … 14 more below

  Model Name: Claude Opus 4.8

  Model catalogs refreshed.

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/private/tmp/model-probe-cwd • $0.000 (sub) • 0/1M (0.0%) (auto)            (anthropic) claude-opus-4-8 • effort medium
(😺 OmO Native by Q Kim)
`;
  const moved = `Only showing models from configured providers. Use /login to add providers.

enter select ctrl+s select as default ctrl+f favorite

> gpt

    gpt-5.5 [chatgpt-subscription]
→   gpt-6-sol [chatgpt-subscription]
    gpt-6-luna [chatgpt-subscription]
    gpt-5.6-sol [chatgpt-subscription]
    gpt-6-astra [chatgpt-subscription]
    gpt-6.1-sol [chatgpt-subscription]
    gpt-5.6-luna [chatgpt-subscription]
    gpt-5.6-terra [chatgpt-subscription]
    gpt-6-sol-fast [chatgpt-subscription]
    gpt-6-luna-fast [chatgpt-subscription]
    gpt-5.6-sol-fast [chatgpt-subscription]
    gpt-6-astra-fast [chatgpt-subscription]
    gpt-6.1-sol-fast [chatgpt-subscription]
    gpt-5.6-luna-fast [chatgpt-subscription]
    gpt-5.6-terra-fast [chatgpt-subscription]
    gpt-5.3-codex-spark [chatgpt-subscription]
    gpt-6.1-sol-ultrafast [chatgpt-subscription]

  Model Name: GPT-6 Sol

  Model catalogs refreshed.

───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/private/tmp/model-probe-cwd • $0.000 (sub) • 0/1M (0.0%) (auto)            (anthropic) claude-opus-4-8 • effort medium
(😺 OmO Native by Q Kim)
`;
  const narrow = `Only showing models from configured providers.
Use /login to add providers.

enter select ctrl+s select as default ctrl+f
favorite

> gpt

→   gpt-5.5 [chatgpt-subscription]
    gpt-6-sol [chatgpt-subscription]
    gpt-6-luna [chatgpt-subscription]
    gpt-5.6-sol [chatgpt-subscription]
    gpt-6-astra [chatgpt-subscription]
    gpt-6.1-sol [chatgpt-subscription]
    gpt-5.6-luna [chatgpt-subscription]
    gpt-5.6-terra [chatgpt-subscription]
    gpt-6-sol-fast [chatgpt-subscription]
    gpt-6-luna-fast [chatgpt-subscription]
    gpt-5.6-sol-fast [chatgpt-subscription]
    gpt-6-astra-fast [chatgpt-subscription]
    gpt-6.1-sol-fast [chatgpt-subscription]
    gpt-5.6-luna-fast [chatgpt-subscription]
    gpt-5.6-terra-fast [chatgpt-subscription]
    gpt-5.3-codex-spark [chatgpt-subscription]
    gpt-6.1-sol-ultrafast
[chatgpt-subscription]

  Model Name: GPT-5.5

  Model catalogs refreshed.

──────────────────────────────────────────────
… • 0/1M (0.0%) (auto)  claude-opus-4-8:medium
(😺 OmO Native by Q Kim)
`;

  test("reads the catalogue under OmO's filter line, naming the model in use", () => {
    const prompt = parseInteractivePrompt("omo", wide)!;
    expect(prompt.kind).toBe("question");
    expect(prompt.question).toBe("Select model (currently claude-opus-4-8 [anthropic])");
    // the tick OmO sets after the name is not part of it, and the count of rows below is no row
    expect(prompt.options[0]!.label).toBe("claude-opus-4-8 [anthropic]");
    expect(prompt.options.length).toBe(20);
    expect(prompt.options.some((option) => /more below|Model Name|catalogs/.test(option.label))).toBe(false);
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("reads what a filter left, from where the cursor stands", () => {
    const prompt = parseInteractivePrompt("omo", moved)!;
    expect(prompt.options[0]!.label).toBe("gpt-5.5 [chatgpt-subscription]");
    expect(prompt.options[1]!.label).toBe("gpt-6-sol [chatgpt-subscription]");
    // no tick among a filter's rows that leave the model in use out
    expect(prompt.question).toBe("Select model");
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("reads a phone's pane, its hint and a model's provider wrapped onto lines of their own", () => {
    const prompt = parseInteractivePrompt("omo", narrow)!;
    expect(prompt).not.toBeNull();
    expect(prompt.options.at(-1)!.label).toBe("gpt-6.1-sol-ultrafast [chatgpt-subscription]");
    expect(prompt.options.every((option) => /\[[^\]]+\]$/.test(option.label))).toBe(true);
  });

  test("is read whatever herdr calls the pane", () => {
    // herdr names an OmO pane `pi` or `claude` at times, or nothing
    for (const agent of ["pi", "claude", ""]) {
      const prompt = parseInteractivePrompt(agent, wide);
      expect(prompt?.question).toBe("Select model (currently claude-opus-4-8 [anthropic])");
      expect(prompt?.options.length).toBe(20);
    }
  });

  test("still offers a filter that left a single model", () => {
    const lines = moved.split("\n");
    const first = lines.findIndex((line) => line.includes("gpt-5.5 [chatgpt-subscription]"));
    const last = lines.findIndex((line) => line.includes("Model Name:"));
    const one = [...lines.slice(0, first), "→   gpt-5.5 [chatgpt-subscription]", ...lines.slice(last)].join("\n");
    const prompt = parseInteractivePrompt("omo", one)!;
    expect(prompt.options.map((option) => option.label)).toEqual(["gpt-5.5 [chatgpt-subscription]"]);
  });

  test("is gone once the list is: dismissed, or quoted with other text under it", () => {
    expect(parseInteractivePrompt("omo", wide.replace(/enter select +ctrl\+s select as default +ctrl\+f favorite\n/, ""))).toBeNull();
    const rule = wide.lastIndexOf("─");
    expect(parseInteractivePrompt("omo", `${wide.slice(0, wide.indexOf("Model Name"))}some other output\n${wide.slice(wide.indexOf("Model Name"))}`)).toBeNull();
    expect(rule).toBeGreaterThan(0);
  });
});

// Captured from omp 18.11.1 running /switch in an isolated herdr session at 120 columns by 40: the
// picker as it opens, after ↓ was pressed eight times, and after `sol` was typed and ↓ pressed
// once; and as it opened from the chat's `/model` in a browser that left the pane 94 columns by
// 18. Provider names and the pane's folder are renamed in the files.
describe("omp's model picker", () => {
  const capture = (name: string) => readFileSync(new URL(`./fixtures/omp-switch-18.11.1-${name}.txt`, import.meta.url), "utf8");
  const wide = capture("wide");
  const scrolled = capture("scrolled");
  const filtered = capture("filtered");
  const short = capture("short");
  const labels = (prompt: InteractivePrompt | null) => prompt?.options.map((option) => option.label);

  test("reads the picker /switch opens, naming the model in use and the models under its window", () => {
    const prompt = parseInteractivePrompt("omp", wide)!;
    expect(prompt.kind).toBe("question");
    expect(prompt.question).toBe("Select model for this session (currently litellm/claude-opus-5-5). More models are listed in the terminal.");
    // the name alone: neither the mark on the model in use, its figures nor the scrollbar after them
    expect(labels(prompt)).toEqual([
      "litellm/claude-opus-5-5", "litellm/gpt-5.6-sol", "litellm/deepseek-v4-flash", "litellm/gpt-6.1-sol",
      "litellm-anthropic/gemini-3.8-flash-high", "litellm/gpt-6-astra", "litellm/claude-opus-4-6-thinking",
    ]);
    expect(prompt.options.every((option) => option.description === null)).toBe(true);
    expect(prompt.custom_option_index).toBeNull();
    expect(answerKeys(prompt, { option_index: 2 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  test("reads a window scrolled past the rule between recent models and the rest, from where the cursor stands", () => {
    const prompt = parseInteractivePrompt("omp", scrolled)!;
    // the model in use has scrolled out of the window
    expect(prompt.question).toBe("Select model for this session. More models are listed in the terminal.");
    expect(labels(prompt)).toEqual([
      "litellm/gpt-6.1-sol", "litellm-anthropic/gemini-3.8-flash-high", "litellm/gpt-6-astra",
      "litellm/claude-opus-4-6-thinking", "litellm/gpt-oss-120b", "litellm/gpt-oss-120b-medium",
    ]);
    // ↑/↓ step over the rule: one key per model
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("reads what a search left, which fits the window", () => {
    const prompt = parseInteractivePrompt("omp", filtered)!;
    expect(prompt.question).toBe("Select model for this session");
    expect(labels(prompt)).toEqual(["litellm/gpt-6.1-sol", "litellm/gpt-6-sol", "litellm/gpt-5.6-sol"]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
  });

  test("reads a short pane's five rows under a footer cut at its edge", () => {
    expect(short).toContain("⌥P task …");
    const prompt = parseInteractivePrompt("omp", short)!;
    expect(prompt.question).toBe("Select model for this session (currently litellm/claude-opus-5-5). More models are listed in the terminal.");
    expect(labels(prompt)).toEqual([
      "litellm/claude-opus-5-5", "litellm/gpt-5.6-sol", "litellm/deepseek-v4-flash", "litellm/gpt-6.1-sol", "litellm-anthropic/gemini-3.8-flash-high",
    ]);
  });

  test("says on a model the conversation overflows that omp compacts it first", () => {
    const over = scrolled.replace("litellm/gpt-oss-120b   ", "litellm/gpt-oss-120b ⦸ context>131k");
    expect(over).not.toBe(scrolled);
    const prompt = parseInteractivePrompt("omp", over)!;
    expect(prompt.options[4]).toEqual({ label: "litellm/gpt-oss-120b", description: "The conversation is over its 131k context: omp compacts it first" });
  });

  test("is gone once the picker is, and reads neither its quick roles nor its task models", () => {
    // Esc: the picker leaves the screen, which ends in omp's input box again
    expect(parseInteractivePrompt("omp", wide.slice(0, wide.indexOf("╭─ Switch Model")))).toBeNull();
    // anything under it is not omp's picker, which is drawn over the bottom of the screen
    expect(parseInteractivePrompt("omp", `${wide}some later output\n`)).toBeNull();
    // a leading `@` lists quick roles, and Alt+P the model for task subagents: not the session's model
    expect(parseInteractivePrompt("omp", wide.replace("Session-only switch — role models stay unchanged", "Quick role switch — applies its model and thinking for this session"))).toBeNull();
    expect(parseInteractivePrompt("omp", wide.replace("╭─ Switch Model ─", "╭─ Switch Task Model ─"))).toBeNull();
    expect(parseInteractivePrompt("omp", wide.replace("use for this session", "use for Task subagents"))).toBeNull();
    // another agent's pane draws no such picker
    expect(parseInteractivePrompt("pi", wide)).toBeNull();
  });
});

describe("piRunsCommand", () => {
  test("takes a builtin as Pi matches it, and an unknown or later /name as a message", () => {
    const pane = { pane_id: "pi-runs-builtin", agent: "pi", cwd: "/work" } as HerdrPane;
    expect(piRunsCommand(pane, "/model")).toBe(true);
    expect(piRunsCommand(pane, "  /thinking high")).toBe(true);
    expect(piRunsCommand(pane, "/Model")).toBe(false);
    expect(piRunsCommand(pane, "/not-a-pi-command")).toBe(false);
    expect(piRunsCommand(pane, "/home/me/file.png what is this")).toBe(false);
    expect(piRunsCommand(pane, "switch with /model")).toBe(false);
    // builtins Pi's menu hides still run when typed exactly
    expect(piRunsCommand(pane, "/debug")).toBe(true);
    expect(piRunsCommand(pane, "/arminsayshi")).toBe(true);
    expect(piRunsCommand(pane, "/dementedelves")).toBe(true);
    expect(piRunsCommand(pane, "/debug this")).toBe(false);
  });

  test("takes a builtin's argument only where Pi takes one, as Pi's submit handler reads it", () => {
    const pane = { pane_id: "pi-runs-arguments", agent: "pi", cwd: "/work" } as HerdrPane;
    expect(piRunsCommand(pane, "/compact focus on the parser")).toBe(true);
    expect(piRunsCommand(pane, "/model sonnet ")).toBe(true);
    // Pi's editor pastes a tab as four spaces
    expect(piRunsCommand(pane, "/model\tsonnet")).toBe(true);
    expect(piRunsCommand(pane, "/new please")).toBe(false);
    expect(piRunsCommand(pane, "/settings foo")).toBe(false);
    expect(piRunsCommand(pane, "/model\nwhich one is best?")).toBe(false);
  });

  test("takes a shell command, but not a lone ! or !!", () => {
    const pane = { pane_id: "pi-runs-shell", agent: "pi", cwd: "/work" } as HerdrPane;
    expect(piRunsCommand(pane, "!git status")).toBe(true);
    expect(piRunsCommand(pane, " !! ls")).toBe(true);
    expect(piRunsCommand(pane, "!")).toBe(false);
    expect(piRunsCommand(pane, "!!")).toBe(false);
    expect(piRunsCommand(pane, "wow!")).toBe(false);
  });

  test("keeps a receipt for the pane's prompt templates, which no catalog proves Pi loaded, and its skills", () => {
    const pane = { pane_id: "pi-runs-catalog", agent: "pi", cwd: "/work" } as HerdrPane;
    rememberPaneCommands(pane, "pi", [
      { name: "skill:commit", description: "Commit", source: "skill" },
      { name: "review", description: "Review", source: "user" },
    ]);
    expect(piRunsCommand(pane, "/skill:commit and push")).toBe(false);
    expect(piRunsCommand(pane, "/review")).toBe(false);
    expect(piRunsCommand(pane, "/review\nthe parser")).toBe(false);
    expect(piListsTemplate(pane, "/review\nthe parser")).toBe(true);
    expect(piListsTemplate(pane, "/skill:commit and push")).toBe(false);
    expect(piListsTemplate(pane, "/commit")).toBe(false);
  });
});
