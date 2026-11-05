import { describe, expect, it } from "bun:test";
import { unwrapAgentRows } from "./agentCopy.ts";

const REPLY = "Summary line. The build command is `npx example-cli@latest build -p ios --profile beta --auto-submit` and it should be copied exactly as one line without any extra spaces. Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one line.";

describe("unwrapAgentRows", () => {
  it("joins a reply Claude Code wrapped at the pane width into one line (#2558)", () => {
    // the rows the issue copied from a 158-column pane, the first after Claude's "⏺ " marker
    const copied = "Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one line without any\n"
      + "  extra spaces. Summary line. The build command is npx example-cli@latest build -p ios --profile beta --auto-submit and it should be copied exactly as one\n"
      + "  line.";
    expect(unwrapAgentRows(copied, 158, 2, [REPLY])).toBe(REPLY.replaceAll("`", ""));
    expect(unwrapAgentRows("⏺ The reply wraps\n  here.", 18, 0, ["The reply wraps here."])).toBe("⏺ The reply wraps here.");
    // a selection that ends partway through the wrapped word
    expect(unwrapAgentRows("⏺ The reply wraps\n  he", 18, 0, ["The reply wraps here."])).toBe("⏺ The reply wraps he");
  });

  it("keeps every break the agent's own text does not show as a wrap (#2575 review)", () => {
    const said = [
      "Run these:\n\n```bash\nbun run check fast && bun test src\ngit push origin HEAD\n```",
      "```ts\nconst answer = computeTheValue(a, b);\nreturn answer;\n```",
      "```ts\nexport const first = makeTheFirstValue();\nexport const second = makeTheSecond();\nexport const third = 3;\n```",
      "Done. The fix is in the branch now\nNext I will run the tests.",
    ];
    const kept: [string, number][] = [
      ["  bun run check fast && bun test src\n  git push origin HEAD", 38],
      ["  const answer = computeTheValue(a, b);\n  return answer;", 40],
      ["  export const first = makeTheFirstValue();\n  export const second = makeTheSecond();\n  export const third = 3;", 44],
      // tool output is not the agent's text at all
      ["  ⎿  src/components/ConnectPhoneDialog.tsx\n     src/lib/api.ts", 44],
      ["⏺ Done. The fix is in the branch now\n  Next I will run the tests.", 38],
    ];
    for (const [copied, cols] of kept) expect(unwrapAgentRows(copied, cols, 0, said)).toBe(copied);
  });

  it("keeps blank lines, list items, tables, wider rows and anything with no transcript", () => {
    const said = ["First paragraph ends here.\n\n- short item\n- second item"];
    const kept = [
      "⏺ First paragraph ends here.\n\n  - short item\n  - second item\nplain row",
      "  │ name   │ value │\n  │ second │ row   │",
      "  a row drawn wider before a resize\n  - next item",
    ];
    for (const copied of kept) expect(unwrapAgentRows(copied, 30, 0, said)).toBe(copied);
    expect(unwrapAgentRows("⏺ The reply wraps\n  here.", 18, 0, [])).toBe("⏺ The reply wraps\n  here.");
  });

  it("joins a word or wide text split at the edge with no space, as the agent wrote it", () => {
    expect(unwrapAgentRows("  See https://exampl\n  e.com/path", 20, 0, ["See https://example.com/path for it."])).toBe("  See https://example.com/path");
    expect(unwrapAgentRows("  これは折り返されま\n  す。", 22, 0, ["これは折り返されます。"])).toBe("  これは折り返されます。");
    expect(unwrapAgentRows("⏺ 한국어로쓴문장이\n  다음", 20, 0, ["한국어로쓴문장이 다음 문장"])).toBe("⏺ 한국어로쓴문장이 다음");
    expect(unwrapAgentRows("one\r\ntwo", 10, 0, ["one two"])).toBe("one\r\ntwo");
  });
});
