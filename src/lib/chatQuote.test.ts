import { describe, expect, it } from "bun:test";
import { draftWithQuote } from "./chatQuote.ts";

describe("quoting a selection into the draft", () => {
  it("puts the quote in an empty draft with a blank line after it", () => {
    expect(draftWithQuote("", "backfill it from updated_at")).toBe("> backfill it from updated_at\n\n");
  });

  it("goes after what was typed, kept as it is, and stacks under an earlier quote", () => {
    expect(draftWithQuote("Before step 1:", "backfill it")).toBe("Before step 1:\n\n> backfill it\n\n");
    expect(draftWithQuote("Line two:  \n", "backfill it")).toBe("Line two:  \n\n> backfill it\n\n");
    const first = draftWithQuote("", "backfill it from updated_at");
    expect(draftWithQuote(first, "First line\r\n\r\nSecond line")).toBe(`${first}> First line\n>\n> Second line\n\n`);
  });

  it("leaves the draft alone for a quote of whitespace", () => {
    expect(draftWithQuote("Typed", " \n ")).toBe("Typed");
  });
});
