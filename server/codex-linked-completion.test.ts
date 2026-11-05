import { expect, test } from "bun:test";
import { matchCodexTranscript } from "./codex.ts";

const prompt = "Start the local development server.";
const answer = "The local server is ready. [http://127.0.0.1:4317](http://127.0.0.1:4317) is the address.\n\nUse a development account to sign in.";
const event = (payload: unknown) => JSON.stringify({ type: "event_msg", payload });
const candidate = (path: string, text = answer, asked = prompt) => ({ path, text: [
  event({ type: "item_completed", turn_id: "t", item: { type: "UserMessage", content: [{ text: asked }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] } }),
  event({ type: "task_complete", turn_id: "t", last_agent_message: text }),
].join("\n") });
const screen = `› ${prompt}

• The local server is ready. http://127.0.0.1:4317 (http://127.0.0.1:4317) is the address.

  Use a development account to sign in.

  Worked for 17s • 3:50 PM

  1 background terminal running · /ps to view · /stop to close

  ⚠ weekly limit: 12% left · /status

› Ask Codex to do anything

  GPT-6.1 Terra xhigh Fast · main · Context 49% left
  ← for agents · ? for shortcuts`;

test("matches a complete linked reply with a native background-terminal notice", () => {
  expect(matchCodexTranscript(screen, [candidate("own")])).toBe("own");
  expect(matchCodexTranscript(screen.replace("  1 background terminal running · /ps to view · /stop to close\n", ""), [candidate("own")])).toBe("own");
});

test("recognizes every integer percentage from zero to 100 in either notice order", () => {
  for (let threshold = 0; threshold <= 100; threshold++) {
    const notice = `⚠ Heads up, you have less than ${threshold}% of your weekly limit left. Run /status for a breakdown.`;
    const withRemaining = screen.replace("12% left", `${threshold}% left`);
    const wrapped = notice.replace("weekly limit", "weekly\n  limit");
    for (const text of [withRemaining.replace("  1 background", `${notice}\n\n  1 background`), withRemaining.replace("  ⚠ weekly", `${notice}\n\n  ⚠ weekly`), withRemaining.replace("  1 background", `${wrapped}\n\n  1 background`)]) {
      expect(matchCodexTranscript(text, [candidate("own")])).toBe("own");
      expect(matchCodexTranscript(text.replace("Run /status for a breakdown.", "Run /status to proceed."), [candidate("own")])).toBeNull();
    }
  }
});

test("does not discard impossible percentages or different warning text", () => {
  for (const percentage of ["101", "1000", "-1", "9.5"]) {
    const invalid = `⚠ Heads up, you have less than ${percentage}% of your weekly limit left. Run /status for a breakdown.`;
    expect(matchCodexTranscript(screen.replace("  1 background", `${invalid}\n\n  1 background`), [candidate("own")])).toBeNull();
    expect(matchCodexTranscript(screen.replace("12% left", `${percentage}% left`), [candidate("own")])).toBeNull();
  }
});

const text = "The implementation preserves request metadata and trace identifiers while masking sensitive values.";
const url = "http://127.0.0.1:4317";
const shownAs = (literal: string) => screen.replace(/• The local[\s\S]*?to sign in\./, `• ${literal.replaceAll("\n", "\n  ")}`);
const owners = new Set(["own", "rendered", "other"]);
// a conversation that was asked the prompt but whose read holds no finish for it, after an older finished turn or none
const unfinished = (path: string, text: string, older: boolean) => ({ path, text: [
  ...older ? [event({ type: "task_complete", turn_id: "old", last_agent_message: "A previous unrelated result." })] : [],
  event({ type: "item_completed", turn_id: "t", item: { type: "UserMessage", content: [{ text: prompt }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] } }),
].join("\n") });
const spaced = [`${text} Read report (docs/my report.md) for details.`, `${text} Read [report](/repo/docs/my report.md) for details.`] as const;
const collisions: [string, string, { path: string; text: string }][] = [
  // a local link whose path has a space, shown relative to the folder
  ["a spaced local link", spaced[0], candidate("rendered", spaced[1])],
  // a bare URL, shown followed by itself
  ["a bare URL", `${text} Address: ${url} (${url}).`, candidate("rendered", `${text} Address: ${url}.`)],
  // an ordered list Codex numbers on from its first marker
  ["a renumbered list", `${text}\n\n4. Verify the project account.\n5. Submit the supporting documents.`, candidate("rendered", `${text}\n\n4. Verify the project account.\n8. Submit the supporting documents.`)],
  // a reference link, shown as its label alone
  ["a reference link", `${text} Read report for details.`, candidate("rendered", `${text} Read [report][ref] for details.\n\n[ref]: https://example.com/report`)],
  ["an unfinished turn", spaced[0], unfinished("rendered", spaced[1], false)],
  ["an unfinished turn after an older finished one", spaced[0], unfinished("rendered", spaced[1], true)],
  // its prompt pushed out of the tail read (by a large tool output) and its turn not finished in it
  ["its prompt cut from the read", spaced[0], { path: "rendered", text: unfinished("rendered", spaced[1], false).text.split("\n").slice(1).join("\n") }],
  // its finished turn's prompt pushed out of the tail read
  ["its finished turn's prompt cut from the read", spaced[0], { path: "rendered", text: candidate("rendered", spaced[1]).text.split("\n").slice(1).join("\n") }],
];
for (const [kind, literal, rendered] of collisions) {
  test(`keeps an exact reply unbound while a same-prompt conversation's answer with ${kind} may render the same`, () => {
    expect(matchCodexTranscript(shownAs(literal), [candidate("own", literal), rendered], new Set(), new Map(), false, owners)).toBeNull();
  });
}

// Accepted false refusal: whether another same-prompt answer renders otherwise is not judged, so the exact reply stays unbound
test("keeps an exact reply unbound while a same-prompt conversation answered otherwise (accepted false refusal)", () => {
  for (const [literal, other] of [
    [`${text} Read report (docs/report.md) for details.`, `${text} Read [summary](/repo/docs/summary.md) for details.`],
    [spaced[0], `${text} Read [summary](/repo/docs/my summary.md) for details.`],
    [`${text} Address: ${url} (${url}).`, `${text} Address: http://127.0.0.1:4321.`],
    [`${text}\n\n4. Verify the project account.\n5. Submit the supporting documents.`, `${text}\n\n4. Close the project account.\n8. Submit the supporting documents.`],
  ] as const) {
    expect(matchCodexTranscript(shownAs(literal), [candidate("own", literal), candidate("other", other)], new Set(), new Map(), false, owners)).toBeNull();
  }
});

test("matches an exact or rendered reply when its conversation is the only one asked the prompt shown", () => {
  const elsewhere = candidate("other", "The release notes list three fixes and one new setting for remote access.", "Summarize the release notes.");
  for (const [shown, recorded] of [[shownAs(spaced[0]), spaced[0]], [screen, answer]] as const) {
    expect(matchCodexTranscript(shown, [candidate("own", recorded), elsewhere], new Set(), new Map(), false, owners)).toBe("own");
    expect(matchCodexTranscript(shown, [candidate("own", recorded)], new Set(), new Map(), false, owners)).toBe("own");
  }
});

test("matches an exact reply while another conversation asked the prompt only before its latest finished turn", () => {
  const turn = (id: string, asked: string, said: string) => [
    event({ type: "item_completed", turn_id: id, item: { type: "UserMessage", content: [{ text: asked }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: said }] } }),
    event({ type: "task_complete", turn_id: id, last_agent_message: said }),
  ];
  const notes = "The release notes list three fixes for reconnecting panes and one new setting for remote access from a phone.";
  const later = { path: "other", text: [...turn("a", prompt, "The build cache was cleared and the dependencies were installed again."),
    ...turn("b", "Summarize the release notes.", notes)].join("\n") };
  for (const [shown, recorded] of [[shownAs(spaced[0]), spaced[0]], [screen, answer]] as const) {
    expect(matchCodexTranscript(shown, [candidate("own", recorded), later], new Set(), new Map(), false, owners)).toBe("own");
  }
  // one whose last finished turn's prompt the tail read cut still counts, whatever its answer reads as: a reference
  // link's definition, say, is not on screen, so its answer may still be the one shown
  const literal = `${text} Read report for details.`;
  for (const said of [notes, `${text} Read [report][ref] for details.\n\n[ref]: https://example.com/a-long-reference-target-not-on-screen`]) {
    const cut = { path: "other", text: turn("b", prompt, said).slice(1).join("\n") };
    expect(matchCodexTranscript(shownAs(literal), [candidate("own", literal), cut], new Set(), new Map(), false, owners)).toBeNull();
  }
  // asked again as its latest turn, finished or not, it still counts
  const again = { path: "other", text: [...later.text.split("\n"), event({ type: "item_completed", turn_id: "c", item: { type: "UserMessage", content: [{ text: prompt }] } })].join("\n") };
  expect(matchCodexTranscript(screen, [candidate("own"), again], new Set(), new Map(), false, owners)).toBeNull();
  // a later turn not read finished may have begun after the screen was read, which may show the earlier one: a
  // new prompt after the shown turn, or a finish with no turn of its own, keeps every prompt counting
  const literal2 = `${text} Read report for details.`;
  const reference = `${text} Read [report][ref] for details.\n\n[ref]: https://example.com/a-long-reference-target-not-on-screen`;
  const begun = { path: "other", text: [...turn("a", prompt, reference), event({ type: "item_completed", turn_id: "b", item: { type: "UserMessage", content: [{ text: "Summarize the release notes." }] } })].join("\n") };
  const idless = { path: "other", text: [event({ type: "user_message", message: prompt }), turn("a", prompt, reference)[1]!,
    event({ type: "task_complete", last_agent_message: reference }), event({ type: "user_message", message: "Summarize the release notes." })].join("\n") };
  for (const other of [begun, idless]) {
    expect(matchCodexTranscript(shownAs(literal2), [candidate("own", literal2), other], new Set(), new Map(), false, owners)).toBeNull();
  }
});

test("keeps changed, ambiguous, unfinished and unknown replies unbound", () => {
  expect(matchCodexTranscript(screen, [candidate("own"), candidate("twin")])).toBeNull();
  expect(matchCodexTranscript(screen.replaceAll(":4317", ":4321"), [candidate("own")])).toBeNull();
  expect(matchCodexTranscript(screen.replace("to sign in", "to log out"), [candidate("own")])).toBeNull();
  const unfinished = { path: "unfinished", text: event({ type: "item_completed", turn_id: "other", item: { type: "UserMessage", content: [{ text: prompt }] } }) };
  expect(matchCodexTranscript(screen, [candidate("own"), unfinished])).toBeNull();
  expect(matchCodexTranscript(screen.replace("/stop to close", "/stop to proceed"), [candidate("own")])).toBeNull();
});
