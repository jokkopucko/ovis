import { describe, expect, it } from "bun:test";
import {
  extendLines,
  highlightNow,
  highlightRuns,
  canHighlight,
  countLines,
  languageForFence,
  LINE_ELEMENT_LIMIT,
  languageForPath,
  linesFromRuns,
  normalizeCode,
  plainLines,
  SYNC_HIGHLIGHT_LIMIT,
  type Lines,
} from "./highlight.ts";

const text = (lines: Lines) => lines.map((line) => line.map((token) => token.text).join(""));
const highlight = (code: string, language: string) => highlightNow(normalizeCode(code), language);

describe("languageForFence", () => {
  it("knows aliases and the first word only", () => {
    expect(languageForFence("ts")).toBe("ts");
    expect(languageForFence("typescript")).toBe("ts");
    expect(languageForFence("TSX title=x")).toBe("tsx");
    expect(languageForFence("javascript")).toBe("js");
    expect(languageForFence("sh")).toBe("shell");
    expect(languageForFence("bash")).toBe("shell");
    expect(languageForFence("yml")).toBe("yaml");
    expect(languageForFence("dockerfile")).toBe("dockerfile");
    expect(languageForFence("c")).toBe("cpp");
    expect(languageForFence("scss")).toBe("css");
  });
  it("returns null for nothing or the unknown", () => {
    expect(languageForFence("")).toBeNull();
    expect(languageForFence("klingon")).toBeNull();
  });
  it("returns null for plain text, which is registered but no language", () => {
    for (const word of ["text", "txt", "plaintext", "TXT"]) expect(languageForFence(word)).toBeNull();
  });
  it("maps the Markdown spellings to markdown", () => {
    for (const word of ["md", "markdown", "mkd", "mdown", "mkdn"]) expect(languageForFence(word)).toBe("markdown");
  });
});

describe("languageForPath", () => {
  it.each([
    ["/r/Dockerfile", "dockerfile"], ["/r/Dockerfile.dev", "dockerfile"], ["/r/app.dockerfile", "dockerfile"],
    ["/r/.gitignore", "toml"], ["/r/.env.local", "env"], ["/r/.env", "env"], ["/r/x.tsx", "tsx"], ["/r/x.ts", "ts"],
    ["/r/x.mjs", "js"], ["/r/README.md", "markdown"], ["/r/a.toml", "toml"], ["/r/a.ini", "toml"], ["/r/a.svg", "html"],
    ["/r/a.py", "python"], ["C:\\r\\a.go", "go"], ["/r/a.", null], ["/r/.bashrc", "shell"], ["/r.d/LICENSE", null],
    ["/r/CMakeLists.txt", "cmake"], ["/r/a.json", "json"], ["/r/a.yml", "yaml"], ["/r/a.vue", "vue"], ["/r/a.c", "cpp"],
  ])("%s → %s", (path, language) => expect(languageForPath(path)).toBe(language));
  it("takes only a Dockerfile, or one with a suffix, as a Dockerfile", () => {
    expect(languageForPath("/r/dockerfile.txt")).toBe("dockerfile");
    expect(languageForPath("/r/dockerfiles.json")).toBe("json");
    expect(languageForPath("/r/dockerfiles")).toBeNull();
  });
  it("decides what is Markdown, by name only and ignoring case", () => {
    expect(languageForPath("/r/notes.MARKDOWN")).toBe("markdown");
    expect(languageForPath("/r/x.mdx")).toBeNull();
    expect(languageForPath("/r/x.mkd")).toBe("markdown");
    expect(languageForPath("/r/x.mdown")).toBe("markdown");
  });
  it("lets a Markdown extension win over a Dockerfile name", () => {
    expect(languageForPath("/r/Dockerfile.md")).toBe("markdown");
    expect(languageForPath("/r/Dockerfile.dev")).toBe("dockerfile");
  });
  it("has no language for plain-text files", () => {
    for (const name of ["a.txt", "a.text"]) expect(languageForPath(`/r/${name}`)).toBeNull();
  });
  it("returns null for the unknown", () => {
    expect(languageForPath("/r/notes.xyz")).toBeNull();
    expect(languageForPath("/r/LICENSE")).toBeNull();
    expect(languageForPath("/r/Makefile")).toBeNull();
  });
});

describe("highlightNow", () => {
  it("keeps a multi-line comment's role on every line it spans", () => {
    const lines = highlight("/* a\nb */\nconst x = 1;", "ts");
    expect(text(lines)).toEqual(["/* a", "b */", "const x = 1;"]);
    expect(lines[0]!.every((t) => t.role === "comment")).toBe(true);
    expect(lines[1]!.every((t) => t.role === "comment")).toBe(true);
    expect(lines[2]!.find((t) => t.text === "const")?.role).toBe("keyword");
    expect(lines[2]!.find((t) => t.text === "1")?.role).toBe("number");
  });
  it("keeps a template string's role across lines", () => {
    const lines = highlight("const s = `a\nb`;", "js");
    expect(lines[1]!.find((t) => t.text.includes("b"))?.role).toBe("string");
  });
  it("maps diff lines to inserted and deleted", () => {
    const lines = highlight("+added\n-removed", "diff");
    expect(lines[0]![0]!.role).toBe("inserted");
    expect(lines[1]![0]!.role).toBe("deleted");
  });
  it("preserves final newlines and blank lines as source text", () => {
    expect(text(highlight("a\nb\n", "ts"))).toEqual(["a", "b", ""]);
    expect(text(highlight("a\n\n", "ts"))).toEqual(["a", "", ""]);
  });
  it("splits CRLF without keeping the carriage return", () => {
    expect(text(highlight("a\r\nb", "ts"))).toEqual(["a", "b"]);
  });
  it("reads a class name as a type and a function's name as a function", () => {
    const lines = highlight("class Box {}\nfunction run() {}", "ts");
    expect(lines[0]!.find((t) => t.text === "Box")?.role).toBe("type");
    expect(lines[1]!.find((t) => t.text === "run")?.role).toBe("function");
  });
  it("colors Markdown's headings, inline code and links", () => {
    const lines = highlight("# Title\nsome `code` and [a](b)", "markdown");
    expect(lines[0]![0]).toEqual({ text: "# Title", role: "function" });
    expect(lines[1]!.find((t) => t.text === "`code`")?.role).toBe("string");
    expect(lines[1]!.find((t) => t.text === "[a](b)")?.role).toBe("variable");
  });
  it("keeps the source exactly, whatever the language", () => {
    const code = "const a = `x${'y'}`; // z\n<div a=\"b\">{c}</div>\n\n\t\"\\\"\"";
    for (const language of ["ts", "tsx", "markdown", "json", "yaml", "shell", "html"]) {
      expect(text(highlight(code, language)).join("\n")).toBe(normalizeCode(code));
    }
  });
  it("returns the same lines for the same call, so a remounted view does not tokenize again", () => {
    expect(highlightNow("const x = 1;", "ts")).toBe(highlightNow("const x = 1;", "ts"));
  });
  it("gives plain lines when the highlighter fails", () => {
    expect(highlightNow("x", "klingon")).toEqual([[{ text: "x", role: null }]]);
  });
});

describe("highlightRuns and linesFromRuns", () => {
  it("merge neighbors of one role and add up to the source", () => {
    const source = "const a = 1;\nconst b = 2;";
    const runs = highlightRuns(source, "ts");
    expect([...runs.lengths].reduce((sum, length) => sum + length, 0)).toBe(source.length);
    for (let i = 1; i < runs.roles.length; i++) expect(runs.roles[i]).not.toBe(runs.roles[i - 1]);
    expect(text(linesFromRuns(source, runs))).toEqual(["const a = 1;", "const b = 2;"]);
  });
  it("leave a source the runs fall short of plain past them", () => {
    const runs = highlightRuns("const", "ts");
    const lines = linesFromRuns("const x\ny", runs);
    expect(lines).toEqual([[{ text: "const", role: "keyword" }, { text: " x", role: null }], [{ text: "y", role: null }]]);
  });
  it("give one empty line for an empty source", () => {
    expect(linesFromRuns("", highlightRuns("", "ts"))).toEqual([[]]);
    expect(plainLines("")).toEqual([[]]);
  });
});

describe("extendLines", () => {
  it("keeps the colored lines and adds the tail plain", () => {
    const lines = highlight("const a", "ts");
    const extended = extendLines(lines, " = 1;\nlet b\n");
    expect(text(extended)).toEqual(["const a = 1;", "let b", ""]);
    expect(extended[0]![0]).toEqual({ text: "const", role: "keyword" });
    expect(extended[1]).toEqual([{ text: "let b", role: null }]);
    expect(text(lines)).toEqual(["const a"]);
  });
  it("returns the lines themselves for no tail", () => {
    const lines = highlight("x", "ts");
    expect(extendLines(lines, "")).toBe(lines);
  });
});

describe("SYNC_HIGHLIGHT_LIMIT", () => {
  // what is highlighted while the page draws must stay quick in the worst shapes measured: runs the
  // tokenizer rescans to the end (an unterminated string of escapes, a line of dashes in YAML)
  it.each([
    ["json", "\"\\"], ["yaml", "--"], ["css", "\"\\"], ["python", "\"\\"], ["vue", "<a "], ["markdown", "[["], ["ts", "x=/[/"],
  ])("keeps %s of %j well under a frame's budget", (language, unit) => {
    const code = unit.repeat(Math.ceil(SYNC_HIGHLIGHT_LIMIT / unit.length)).slice(0, SYNC_HIGHLIGHT_LIMIT);
    highlightRuns(code, language);
    const runs = Array.from({ length: 5 }, () => {
      const start = performance.now();
      highlightRuns(code, language);
      return performance.now() - start;
    });
    expect(Math.min(...runs)).toBeLessThan(50);
  });
});

describe("countLines", () => {
  it("counts the lines of a normalized source, a blank one included", () => {
    expect(countLines("")).toBe(1);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n\nb")).toBe(3);
    expect(countLines("\n".repeat(LINE_ELEMENT_LIMIT))).toBe(LINE_ELEMENT_LIMIT + 1);
  });
});

describe("canHighlight", () => {
  it("knows the registered languages and nothing else", () => {
    expect(canHighlight("ts")).toBe(true);
    expect(canHighlight("typescript")).toBe(false);
    expect(canHighlight(null)).toBe(false);
  });
});
