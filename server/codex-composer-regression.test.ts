import { expect, test } from "bun:test";
import { matchCodexTranscript } from "./codex.ts";

const prompt = "Keep login results for diagnosis.";
const answer = "Keep **login results** even on success.\n\n| Request | `result` |\n|---|---|\n| Regular success | Exclude |\n| Login success | Keep |\n| Failure | Keep |\n\nPreserve request metadata and trace identifiers. Mask JWT values before recording login responses. This policy is not applied yet.";
const event = (payload: unknown) => JSON.stringify({ type: "event_msg", timestamp: "2026-11-03T04:42:35Z", payload });
const own = { path: "own", text: [
  event({ type: "item_completed", turn_id: "t", item: { type: "UserMessage", content: [{ text: prompt }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: answer }] } }),
  event({ type: "task_complete", turn_id: "t", last_agent_message: answer }),
].join("\n") };
const screen = `› ${prompt}

• Keep login results even on success.

   Request          result
  ━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━
   Regular success  Exclude
  ────────────────  ─────────────
   Login success    Keep
  ────────────────  ─────────────
   Failure          Keep

  Preserve request metadata and trace identifiers. Mask JWT values before recording login responses. This policy is not applied yet.

  Worked for 8s • 1:42 PM
                      ⚠ weekly limit: 21% left · /status

› Ask Codex to do anything

  GPT-6.1 Terra xhigh fast · main · Context 70% left
  ← for agents · ? for shortcuts                         ⚠ 3 warnings · f2 to view`;

test("binds a completed formatted answer above the 0.166 model and limit chrome", () => {
  expect(matchCodexTranscript(screen, [own])).toBe("own");
  const warned = screen.replace("  Worked for 8s • 1:42 PM\n", "  Worked for 8s • 1:42 PM\n\n⚠ Heads up, you have less than 25% of your weekly limit left. Run /status for a breakdown.\n").replace("xhigh fast ·", "xhigh Fast ·");
  expect(matchCodexTranscript(warned, [own])).toBe("own");
  expect(matchCodexTranscript(warned.replace("Run /status for a breakdown.", "Run /status to continue."), [own])).toBeNull();
  expect(matchCodexTranscript(warned, [own, { ...own, path: "other" }])).toBeNull();
});

test("keeps ambiguous, changed, unfinished and foreign-folder answers unbound", () => {
  expect(matchCodexTranscript(screen, [own, { ...own, path: "twin" }])).toBeNull();
  expect(matchCodexTranscript(screen.replace("Mask JWT", "Keep JWT"), [own])).toBeNull();
  expect(matchCodexTranscript(screen, [{ ...own, text: own.text.split("\n").slice(0, -1).join("\n") }])).toBeNull();
  expect(matchCodexTranscript(screen, [own], new Set(), new Map(), false, new Set(["elsewhere"]))).toBeNull();
  expect(matchCodexTranscript(screen.replace("21% left · /status", "21% left · arbitrary output"), [own])).toBeNull();
});

test("keeps a rendered answer unbound while another conversation asked the same prompt", () => {
  // Codex shows a file link's target relative to the folder, so a conversation whose recorded answer differs
  // only in markup may be the one on screen although its letters and digits differ from the screen's
  const asked = "Explain the implementation.";
  const conversation = (path: string, said: string, finished = true) => ({ path, text: [
    event({ type: "item_completed", turn_id: "t", item: { type: "UserMessage", content: [{ text: asked }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: said }] } }),
    ...finished ? [event({ type: "task_complete", turn_id: "t", last_agent_message: said })] : [],
  ].join("\n") });
  const plain = "The implementation preserves request metadata and trace identifiers while masking sensitive values before recording responses.";
  const bold = conversation("bold", `${plain.replace("request metadata", "**request metadata**")} Read report (docs/report.md) for details.`);
  const linked = conversation("linked", `${plain} Read [report](/repo/docs/report.md) for details.`);
  const shown = `› ${asked}\n\n• ${plain} Read report (docs/report.md) for details.\n\n  Worked for 8s • 1:42 PM\n\n› Ask Codex to do anything\n  GPT-6.1 Terra xhigh fast · /repo`;
  expect(matchCodexTranscript(shown, [bold])).toBe("bold");
  expect(matchCodexTranscript(shown, [bold, linked])).toBeNull();
  expect(matchCodexTranscript(shown, [linked, bold])).toBeNull();
  // its finish not read yet, or in another folder, the other conversation still may be the one shown
  const unfinished = conversation("linked", `${plain} Read [report](/repo/docs/report.md) for details.`, false);
  expect(matchCodexTranscript(shown, [bold, unfinished])).toBeNull();
  expect(matchCodexTranscript(shown, [bold, unfinished], new Set(), new Map(), false, new Set(["bold"]))).toBeNull();
  // a tail read that cut the other conversation's prompt
  const cut = { path: "linked", text: unfinished.text.split("\n").slice(1).join("\n") };
  expect(matchCodexTranscript(shown, [bold, cut])).toBeNull();
});
