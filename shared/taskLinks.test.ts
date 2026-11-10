import { describe, expect, it } from "bun:test";
import { type InlineNode, parseInline } from "./markdown.ts";
import { linkTaskCode, linkTaskIds, taskHref } from "./taskLinks.ts";

const href = (id: string) => `https://tasks.home.jdsaa.com/t/${id}`;

describe("task ID links", () => {
  it("links to the task view's fixed HTTPS address", () => {
    expect(taskHref("T-00042")).toBe("https://tasks.home.jdsaa.com/t/T-00042");
  });

  it("links each ID in text and leaves the rest as text", () => {
    expect(linkTaskIds("see T-00009 and T-00010.")).toEqual([
      { type: "text", value: "see " },
      { type: "link", href: href("T-00009"), children: [{ type: "text", value: "T-00009" }] },
      { type: "text", value: " and " },
      { type: "link", href: href("T-00010"), children: [{ type: "text", value: "T-00010" }] },
      { type: "text", value: "." },
    ]);
    expect(linkTaskIds("XT-00009 T-0009 T-000099")).toEqual([{ type: "text", value: "XT-00009 T-0009 T-000099" }]);
  });

  it("links a code span only when it is one whole ID", () => {
    expect(linkTaskCode("T-00009")).toEqual({ type: "link", href: href("T-00009"), children: [{ type: "code", value: "T-00009" }] });
    expect(linkTaskCode("ws-task show T-00009")).toEqual({ type: "code", value: "ws-task show T-00009" });
  });

  it("keeps IDs as text where links are off", () => {
    expect(parseInline("T-00009 `T-00009`", false)).toEqual([{ type: "text", value: "T-00009 " }, { type: "code", value: "T-00009" }]);
  });

  it("links IDs in chat text, inside emphasis, but not inside another link", () => {
    const link = (id: string, child: InlineNode): InlineNode => ({ type: "link", href: href(id), children: [child] });
    expect(parseInline("**T-00001** `T-00002` [T-00003](https://x.dev/a)")).toEqual([
      { type: "strong", children: [link("T-00001", { type: "text", value: "T-00001" })] },
      { type: "text", value: " " },
      link("T-00002", { type: "code", value: "T-00002" }),
      { type: "text", value: " " },
      { type: "link", href: "https://x.dev/a", children: [{ type: "text", value: "T-00003" }] },
    ]);
  });
});
