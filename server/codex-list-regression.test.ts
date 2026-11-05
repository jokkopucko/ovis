import { expect, test } from "bun:test";
import { matchCodexTranscript } from "./codex.ts";

const question = "Summarize the current work and the next steps.";
const answer = "The current status is recorded below.\n\n| Item | Status |\n|---|---|\n| Preparation | Complete |\n| Review | Pending |\n\nNext, proceed in this order.\n\n1. Verify the project account.\n2. Submit the application and supporting documents.\n3. Confirm the scope and estimated costs.\n\nThe application has not yet been submitted.";
const event = (payload: unknown) => JSON.stringify({ type: "event_msg", payload });
const candidate = (path: string, response = answer, asked = question) => ({ path, text: [
  event({ type: "item_completed", turn_id: "t", item: { type: "UserMessage", content: [{ text: asked }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: response }] } }),
  event({ type: "task_complete", turn_id: "t", last_agent_message: response }),
].join("\n") });
const screen = `› ${question}

• The current status is recorded below.

   Item           Status
  ━━━━━━━━━━━━━━  ━━━━━━━━━
   Preparation    Complete
  ──────────────  ─────────
   Review         Pending

  Next, proceed in this order.

  1. Verify the project account.
  2. Submit the application and supporting documents.
  3. Confirm the scope and estimated costs.

  The application has not yet been submitted.

  Worked for 13s • 3:12 PM
                       ⚠ weekly limit: 15% left · /status

› Ask Codex to do anything

  GPT-6.1-Sol high Fast · Context 23% left
  ← for agents · ? for shortcuts`;

test("matches a completed answer containing a table and an ordered list", () => {
  expect(matchCodexTranscript(screen, [candidate("own")])).toBe("own");
});

test("requires the exact unique completed answer and its prompt", () => {
  expect(matchCodexTranscript(screen, [candidate("own"), candidate("twin")])).toBeNull();
  expect(matchCodexTranscript(screen.replace("estimated costs", "confirmed costs"), [candidate("own")])).toBeNull();
  expect(matchCodexTranscript(screen.replace("2. Submit", "4. Submit"), [candidate("own")])).toBeNull();
  expect(matchCodexTranscript(screen, [candidate("own", answer, "Another question")])).toBeNull();
  expect(matchCodexTranscript(screen.replace("Review         Pending", "Review         Complete"), [candidate("own")])).toBeNull();
});

test("does not bind when another candidate may have been asked the same prompt", () => {
  const unfinished = { path: "unfinished", text: event({ type: "item_completed", turn_id: "u", item: { type: "UserMessage", content: [{ text: question }] } }) };
  const missingPrompt = { path: "cut", text: JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer from an unknown prompt." }] } }) };
  expect(matchCodexTranscript(screen, [candidate("own"), unfinished])).toBeNull();
  expect(matchCodexTranscript(screen, [candidate("own"), missingPrompt])).toBeNull();
  expect(matchCodexTranscript(screen, [candidate("own"), candidate("other", "An unrelated complete response.", "A different question.")])).toBe("own");
});

test("accepts a list that starts at a later number and wraps within a word", () => {
  const numbered = answer.replace("1. Verify", "4. Verify").replace("2. Submit", "5. Submit").replace("3. Confirm", "6. Confirm");
  const shown = screen.replace("1. Verify", "4. Verify").replace("2. Submit", "5. Submit").replace("3. Confirm", "6. Confirm")
    .replace("application and supporting", "appli\n    cation and supporting");
  expect(matchCodexTranscript(shown, [candidate("own", numbered)])).toBe("own");
});

test("accepts exact weekly notices wrapped at a narrow pane width", () => {
  const wrapped = screen.replace("  Worked for 13s • 3:12 PM\n", "  Worked for 13s • 3:12 PM\n\n⚠ Heads up, you have less than 25% of your weekly limit left. Run /\n  status for a breakdown.\n")
    .replace("⚠ weekly limit: 15% left · /status", "⚠ weekly limit: 15% left · /sta\n  tus");
  expect(matchCodexTranscript(wrapped, [candidate("own")])).toBe("own");
  expect(matchCodexTranscript(wrapped.replace("status for a breakdown.", "status to proceed."), [candidate("own")])).toBeNull();
});
