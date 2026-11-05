import { describe, expect, test } from "bun:test";
import type { ParsedPrompt } from "./shared.ts";
import { navigateNativeSteps } from "./step-navigate.ts";

const labels = ["Color", "Size", "Shape", "Submit"];
/** omp's card at a stop of its strip; bound to its call unless `unbound` */
function card(index: number, { unbound = false, call = "call-a", strip = labels }: { unbound?: boolean; call?: string; strip?: string[] } = {}): ParsedPrompt {
  return {
    id: `card-${index}${unbound ? "-unbound" : ""}`, agent: "omp", kind: "question", title: "", question: "", body: null, options: [], multi_select: false,
    custom_option_index: null, ompCall: call,
    steps: strip.map((label, at) => ({ label, answered: false, current: at === index })),
    nativeSteps: unbound ? undefined : { identity: `identity-${call}`, index, count: labels.length, next: "tab", previous: "shift+tab" },
  } as unknown as ParsedPrompt;
}

/** A move whose reads after its key are `after`, in order, then the last one again. */
async function moveWith(after: ParsedPrompt[]): Promise<{ landed: ParsedPrompt | null; sent: string[] }> {
  const sent: string[] = [];
  let reads = 0;
  const landed = await navigateNativeSteps(card(0), 1, {
    read: async () => sent.length === 0 ? card(0) : after[Math.min(reads++, after.length - 1)]!,
    send: async (key) => { sent.push(key); },
    active: () => true,
    // far past the test's own time limit: a move that waited for it would fail the test
    deadline: Date.now() + 60_000,
  });
  return { landed, sent };
}

describe("an omp move reads an unbound strip", () => {
  test("a frame drawn halfway (the same call, the same strip) is read again", async () => {
    const { landed, sent } = await moveWith([card(1, { unbound: true }), card(1)]);
    expect(landed?.id).toBe("card-1");
    expect(sent).toEqual(["tab"]);
  });

  test.each([
    ["another call", card(1, { unbound: true, call: "call-b" })],
    ["another strip", card(1, { unbound: true, strip: ["Color", "Size", "Changed", "Submit"] })],
  ] as const)("%s ends the move at once", async (_, shown) => {
    const { landed, sent } = await moveWith([shown]);
    expect(landed).toBeNull();
    expect(sent).toEqual(["tab"]);
  });
});
