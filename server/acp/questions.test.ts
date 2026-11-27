import { expect, it, spyOn } from "bun:test";
import { KeeperQuestions } from "./questions.ts";

it("keeps an expired question with the person when the wall clock moves back", async () => {
  const opened = 1_700_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(opened);
  const sent: string[] = [];
  const questions = new KeeperQuestions(() => {}, async id => { sent.push(id); return "won"; });
  const params = { mode: "form", toolCallId: "tool-1", message: "Which color?", requestedSchema: {
    type: "object", properties: { question_0: { type: "string", oneOf: [{ const: "Blue", title: "Blue" }] } },
  } };
  try {
    questions.add("claude", { seq: 1, dir: "from-agent", ts: opened, raw: JSON.stringify(params) }, "question", params, true);
    const current = questions.current;
    expect(current?.parent).toBe(true);
    if (!current) throw new Error("missing question");

    clock.mockReturnValue(opened + 31_000);
    expect(questions.current?.parent).toBe(false);
    clock.mockReturnValue(opened + 1_000);

    expect(await questions.respond(current.id, "default", { indices: [0] })).toBe("changed");
    expect(questions.current?.parent).toBe(false);
    expect(sent).toEqual([]);
  } finally {
    questions.clear();
    clock.mockRestore();
  }
});
