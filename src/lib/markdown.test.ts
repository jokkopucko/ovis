import { describe, expect, it, spyOn } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadKatex, Markdown } from "../components/Markdown.tsx";
import { FILE_LINK_COUNT, FILE_LINK_LIMIT, linkFilePaths } from "../components/FilePathLink.tsx";
import { HighlightedCode } from "../components/HighlightedCode.tsx";
import { OpenFileContext } from "./filePaths.ts";
import { SettingsProvider } from "./settings.ts";
import { FOLD_CODE_AFTER_LINES, FOLDED_CODE_LINES, foldCode, inlineMarks, isTableSeparator, mathNestsTooDeep, parseInline, parseMarkdown, safeMarkdownHref, shownText, trimUrl, type InlineNode, type ListBlock } from "../../shared/markdown.ts";

describe("parseMarkdown", () => {
  it("renders inline and display math while leaving fenced code untouched", async () => {
    // the chat fetches KaTeX with the first expression; a static render draws it once it is there
    await loadKatex();
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Markdown, { children: "\\(x_i\\)\n\n\\[\\mathrm{ECA@}k=\\frac{1}{N}\\sum_i\\mathbf{1}[\\text{예측}_i=\\text{정답}_i]\\]" }) }));
      expect(html).toContain("katex-display");
      expect(html).toContain("katex-html");
      expect(html).not.toContain("katex-error");
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });
  it("draws Korean, Japanese or Chinese text written straight into an expression", async () => {
    await loadKatex();
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Markdown, { children: "\\(가 + 1\\) and \\(日本 = x\\)" }) }));
      expect(html.match(/class="katex"/g)?.length).toBe(2);
      expect(html).not.toContain("\\(가");
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });
  it("parses level one through three headings", () => {
    expect(parseMarkdown("# One\n## Two\n### Three").map((block) => block.type === "heading" ? block.level : null)).toEqual([1, 2, 3]);
  });

  it("parses unordered, ordered, and one-level nested lists", () => {
    const blocks = parseMarkdown("- first\n  - nested\n- second\n\n1. one\n2. two");
    expect(blocks[0]).toMatchObject({
      type: "list",
      ordered: false,
      items: [{ blocks: [{ type: "list", ordered: false, items: [{ content: [{ type: "text", value: "nested" }] }] }] }, {}],
    });
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true, items: [{}, {}] });
  });

  it("keeps fenced code and its language", () => {
    expect(parseMarkdown("```ts\nconst x = 1;\n```")).toEqual([{ type: "code", language: "ts", value: "const x = 1;" }]);
  });

  it("recognizes display math without parsing its contents as markdown", () => {
    const formula = "\\[\n\\mathrm{ECA@}k = \\frac{1}{N}\\sum_i \\mathbf{1}[\\text{예측}_i=\\text{정답}_i]\\,\\prod_j\\mathbf{1}[|F_i\\cap I_{ij}|\\ge k]\n\\]";
    expect(parseMarkdown(formula)).toEqual([{ type: "math", value: formula.slice(3, -3) }]);
    expect(parseMarkdown("before\n\\[x^2\\]\nafter").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(parseMarkdown("```tex\n\\[x\\]\n```")).toEqual([{ type: "code", language: "tex", value: "\\[x\\]" }]);
    expect(parseMarkdown("\\[unfinished")).toEqual([{ type: "paragraph", lines: [[{ type: "text", value: "\\[unfinished" }]] }]);
  });

  it("recognizes $$ display math and a math fence", () => {
    expect(parseMarkdown("$$\n\\int_0^1 x\\,dx\n$$")).toEqual([{ type: "math", value: "\\int_0^1 x\\,dx", dollar: true }]);
    expect(parseMarkdown("before\n$$x^2$$\nafter").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(parseMarkdown("$$unfinished\n\n# Still a heading").map((block) => block.type)).toEqual(["paragraph", "heading"]);
    expect(parseMarkdown("$$ a\n$$ b\n```\ncode\n```\n$$ c $$").map((block) => block.type)).toEqual(["paragraph", "paragraph", "code", "math"]);
    // a formula left open does not hide one a later line opens and closes, with either delimiter
    expect(parseMarkdown("$$oops\n\n# Heading\n\n$$x^2$$").map((block) => block.type)).toEqual(["paragraph", "heading", "math"]);
    expect(parseMarkdown("\\[oops\n\n# Heading\n\n\\[x^2\\]").map((block) => block.type)).toEqual(["paragraph", "heading", "math"]);
    // a blank line ends the search for a close (display math holds none), so a later formula on several lines is drawn
    expect(parseMarkdown("$$ is the shell PID.\n\nLater:\n\n$$\na^2+b^2\n$$").map((block) => block.type)).toEqual(["paragraph", "paragraph", "math"]);
    expect(parseMarkdown("\\[oops\n\n# Heading\n\n\\[\nx\n\\]").map((block) => block.type)).toEqual(["paragraph", "heading", "math"]);
    // nor does it reach past a line that opens a formula with the other delimiter
    expect(parseMarkdown("$$oops\n\\[\nx\n\\]\n$$").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    expect(parseMarkdown("\\[oops\n$$\nx\n$$\n\\]").map((block) => block.type)).toEqual(["paragraph", "math", "paragraph"]);
    // a line that closes its formula and goes on in prose is prose, and takes nothing after it
    expect(parseMarkdown("$$E=mc^2$$ where E is energy\n\n## Units\n\n- joules\n\n$$\nE\n$$").map((block) => block.type)).toEqual(["paragraph", "heading", "list", "math"]);
    expect(parseMarkdown("```math\nx^2\n```")).toEqual([{ type: "code", language: "math", value: "x^2" }]);
  });

  it("draws $…$, $$…$$ and a math fence with KaTeX, and leaves prices as text", async () => {
    await loadKatex();
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const draw = (source: string): string => renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Markdown, { children: source }) }));
      expect(draw("$x^2$ costs $5 and $10")).toMatch(/^(?:(?!katex).)*class="katex"(?:(?!class="katex").)*\$5 and \$10/s);
      // one KaTeX cannot draw shows as written: a $$ formula on its own lines, a math fence as its code
      expect(draw("$$\na \\unknowncommand\nb\n$$")).toContain('<span class="markdown-math-source">$$\na \\unknowncommand\nb\n$$</span>');
      expect(draw("$$\\unknowncommand$$")).toContain('<span class="markdown-math-source">$$\\unknowncommand$$</span>');
      expect(draw("$$\n\\unknowncommand\n$$")).toContain('<span class="markdown-math-source">$$\n\\unknowncommand\n$$</span>');
      expect(draw("```math\n\\unknowncommand\n```")).toContain("<pre");
      for (const source of ["$$\nx^2\n$$", "```math\nx^2\n```"]) {
        const html = draw(source);
        expect(html).toContain("katex-display");
        expect(html).not.toContain("<pre");
      }
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it("keeps later markdown and code intact after an unclosed display formula", () => {
    for (const code of ["raw code", "\\]"]) {
      expect(parseMarkdown(`\\[unfinished\n\n# Still a heading\n\n\`\`\`tex\n${code}\n\`\`\`\n\n- still a list`).map((block) => block.type)).toEqual([
        "paragraph", "heading", "code", "list",
      ]);
    }
  });

  it("parses a GFM table", () => {
    const [table] = parseMarkdown("| Name | Value |\n| --- | --- |\n| a | b |");
    expect(table).toMatchObject({ type: "table", header: [[{ value: "Name" }], [{ value: "Value" }]], rows: [[[{ value: "a" }], [{ value: "b" }]]] });
  });
});

describe("inline markdown", () => {
  it("turns Codex local file citations into file links, including source metadata and Unicode paths", () => {
    const path = "/Users/u/My Documents/보고서.pdf";
    const output = `:codex-file-citation{path=${JSON.stringify(path)} purpose="output"}`;
    const source = `:codex-file-citation{purpose="source" page_number="4" path=${JSON.stringify(path)}}`;
    const file: InlineNode = { type: "file", path, children: [{ type: "text", value: "보고서.pdf" }] };
    expect(parseInline(output)).toEqual([file]);
    expect(parseInline(`See ${source}.`)).toEqual([{ type: "text", value: "See " }, file, { type: "text", value: "." }]);
    const windows = "C:\\Users\\u\\My Docs\\report.docx";
    expect(parseInline(`:codex-file-citation{path=${JSON.stringify(windows)} purpose="output"}`)).toMatchObject([{ type: "file", path: windows }]);
    expect(parseInline(output, false)).toEqual([{ type: "text", value: output }]);
  });

  it("leaves incomplete, invalid and non-local Codex citations as written", () => {
    for (const citation of [
      ':codex-file-citation{path="/tmp/report.pdf" purpose="output"',
      ':codex-file-citation{path="https://example.com/x" purpose="output"}',
      ':codex-file-citation{path="/tmp/x" purpose="output" path="/tmp/y"}',
      ':codex-file-citation{path="/tmp/x" purpose="output" mode="live"}',
      ':codex-file-citation{path="/tmp/x" purpose="unknown"}',
      ':codex-file-citation{path="/tmp/x" purpose="output" broken}',
    ]) expect(parseInline(citation).some((node) => node.type === "file")).toBe(false);
    const citation = ':codex-file-citation{path="/tmp/report.pdf" purpose="output"}';
    expect(parseInline(`\`${citation}\``)).toEqual([{ type: "code", value: citation }]);
    expect(parseMarkdown(`\`\`\`text\n${citation}\n\`\`\``)).toEqual([{ type: "code", language: "text", value: citation }]);
  });

  it("opens a Codex citation only where a file:/// link could: no network share, no control character", () => {
    for (const path of ["//server/share/a.txt", "\\\\server\\share\\a.txt", "/tmp/a\u007fb"]) {
      expect(parseInline(`:codex-file-citation{path=${JSON.stringify(path)} purpose="output"}`).some((node) => node.type === "file")).toBe(false);
    }
    // the same share, its slashes written as JSON escapes
    expect(parseInline(':codex-file-citation{path="\\u002f\\u002fserver/share/a.txt" purpose="output"}').some((node) => node.type === "file")).toBe(false);
  });

  it("leaves the markdown after an unfinished Codex citation as markdown, and reads a brace inside a quoted path", () => {
    const nodes = parseInline(':codex-file-citation{unfinished **urgent** and `code` } then :codex-file-citation{path="/tmp/a.pdf" purpose="output"}');
    expect(nodes.map((node) => node.type)).toEqual(["text", "strong", "text", "code", "text", "file"]);
    expect(parseInline(':codex-file-citation{path="/tmp/a}b.pdf" purpose="output"}')).toEqual([{ type: "file", path: "/tmp/a}b.pdf", children: [{ type: "text", value: "a}b.pdf" }] }]);
    expect(parseInline(':codex-file-citation{path="/tmp/a.pdf" purpose="output" }')).toMatchObject([{ type: "file", path: "/tmp/a.pdf" }]);
    // an escape JSON has no reading for is no directive: the markdown inside it stays markdown
    expect(parseInline(':codex-file-citation{path="/tmp/\\q **urgent**" purpose="output"}').some((node) => node.type === "strong")).toBe(true);
  });

  it("renders a Codex citation through the existing file opener", () => {
    const citation = ':codex-file-citation{path="/tmp/My report.pdf" purpose="output"}';
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(OpenFileContext.Provider, {
        value: () => {}, children: createElement(Markdown, { children: citation }),
      }) }));
      expect(html).toContain('<button type="button" class="markdown-file" title="Open /tmp/My report.pdf"><span>My report.pdf</span></button>');
      expect(html).not.toContain("codex-file-citation");
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it("parses links and rejects unsafe protocols", () => {
    expect(safeMarkdownHref("https://example.com")).toBe("https://example.com");
    expect(safeMarkdownHref("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeMarkdownHref("javascript:alert(1)")).toBeNull();
    expect(parseInline("[safe](https://example.com) [unsafe](javascript:bad)" )).toMatchObject([
      { type: "link", href: "https://example.com" },
      { type: "text", value: " " },
      { type: "text", value: "unsafe" },
    ]);
  });

  it("keeps a link to a local file as that file, not only its label", () => {
    expect(parseInline("근거: [실험 결과](/home/u/repo/output/REPORT.md)")).toEqual([
      { type: "text", value: "근거: " },
      { type: "file", path: "/home/u/repo/output/REPORT.md", children: [{ type: "text", value: "실험 결과" }] },
    ]);
    expect(parseInline("[x](src/x.ts#L12) [y](~/y.md:3:1)")).toMatchObject([
      { type: "file", path: "src/x.ts#L12" },
      { type: "text", value: " " },
      { type: "file", path: "~/y.md:3:1" },
    ]);
    expect(parseInline("[range](src/x.ts#L12-L18) [section](docs/a.md#usage)")).toMatchObject([
      { type: "file", path: "src/x.ts#L12-L18" },
      { type: "text", value: " " },
      { type: "file", path: "docs/a.md" },
    ]);
    for (const target of ["javascript:bad", "data:text/html,x", "#section"]) {
      expect(parseInline(`[label](${target})`)).toEqual([{ type: "text", value: "label" }]);
    }
  });

  it("decodes a percent-encoded file link once, as a file URI is", () => {
    expect(parseInline("[photo](/tmp/ovis%20test/%EC%82%AC%EC%A7%84.png)")).toMatchObject([{ type: "file", path: "/tmp/ovis test/사진.png" }]);
    expect(parseInline("[x](src/a%20b.ts#L12) [y](a%2520b.md:3)")).toMatchObject([
      { type: "file", path: "src/a b.ts#L12" },
      { type: "text", value: " " },
      { type: "file", path: "a%20b.md:3" },
    ]);
    // not valid encoding, a control character or a line once decoded: kept as written
    expect(parseInline("[x](/tmp/100%.png) [y](/tmp/a%0Ab.md) [z](/tmp/a%23L12)")).toMatchObject([
      { type: "file", path: "/tmp/100%.png" },
      { type: "text", value: " " },
      { type: "file", path: "/tmp/a%0Ab.md" },
      { type: "text", value: " " },
      { type: "file", path: "/tmp/a%23L12" },
    ]);
    // a terminal shows the address as written
    expect(shownText(parseInline("Open [the guide](/tmp/a%20b.md)?"), true)).toBe("Open the guide (/tmp/a%20b.md)?");
  });

  it("links an address written without its scheme, and leaves files and non-addresses alone", () => {
    expect(parseInline("[docs](www.example.com/x)")).toEqual([{ type: "link", href: "https://www.example.com/x", children: [{ type: "text", value: "docs" }] }]);
    expect(parseInline("[guide](docs.example.com/guide)")).toMatchObject([{ type: "link", href: "https://docs.example.com/guide" }]);
    expect(parseInline("[here](localhost:7317)")).toMatchObject([{ type: "link", href: "http://localhost:7317" }]);
    expect(parseInline("[api](api.example.com:8443/v1)")).toMatchObject([{ type: "link", href: "https://api.example.com:8443/v1" }]);
    expect(parseInline("[readme](README.md)")).toMatchObject([{ type: "file", path: "README.md" }]);
    expect(parseInline("[x](src/x.ts)")).toMatchObject([{ type: "file", path: "src/x.ts" }]);
    expect(parseInline("see www.example.com/a/b.")).toEqual([
      { type: "text", value: "see " },
      { type: "link", href: "https://www.example.com/a/b", children: [{ type: "text", value: "www.example.com/a/b" }] },
      { type: "text", value: "." },
    ]);
    // a file and its line, or a folder with a dot, is not an address
    expect(parseInline("[main.ts](main.ts:42)")).toMatchObject([{ type: "file", path: "main.ts:42" }]);
    expect(parseInline("[README.md](README.md:3:1)")).toMatchObject([{ type: "file", path: "README.md:3:1" }]);
    expect(parseInline("[notes](notes.v2/todo.md)")).toMatchObject([{ type: "file", path: "notes.v2/todo.md" }]);
    expect(parseInline("[call](tel:123)")).toEqual([{ type: "text", value: "call" }]);
    // a local server by address is plain http, as localhost is
    expect(parseInline("[server](127.0.0.1:8080)")).toMatchObject([{ type: "link", href: "http://127.0.0.1:8080" }]);
    expect(parseInline("[dev](192.168.0.10:5173/app)")).toMatchObject([{ type: "link", href: "http://192.168.0.10:5173/app" }]);
    expect(parseInline("[v](1.2.3.4)")).toMatchObject([{ type: "file", path: "1.2.3.4" }]);
    // a bare domain in prose stays prose, and a code span keeps its address as code (rendered as a link)
    expect(parseInline("example.com is fine")).toEqual([{ type: "text", value: "example.com is fine" }]);
    expect(parseInline("`https://example.com/x`")).toEqual([{ type: "code", value: "https://example.com/x" }]);
  });

  it("parses inline code, bold, italic, and strikethrough", () => {
    expect(parseInline("`code` **bold** *italic* ~~gone~~").map((node) => node.type)).toEqual([
      "code", "text", "strong", "text", "em", "text", "del",
    ]);
  });

  it("renders inline math in prose but not in code spans", () => {
    expect(parseInline("Result \\(x_i + \\frac{1}{N}\\) and `\\(raw\\)`")).toEqual([
      { type: "text", value: "Result " },
      { type: "math", value: "x_i + \\frac{1}{N}" },
      { type: "text", value: " and " },
      { type: "code", value: "\\(raw\\)" },
    ]);
    expect(parseInline("\\(unfinished")).toEqual([{ type: "text", value: "\\(unfinished" }]);
  });

  it("reads $…$ as math only where a price cannot be", () => {
    const text = (value: string): InlineNode[] => [{ type: "text", value }];
    for (const prose of [
      "costs $5 and $10 today", "$5 or $10", "from $5 to $10.", "I paid $5 for X$ and", "$20, $30 and $40",
      "a$b$c", "$x$5", "$ x$", "$x $", "\\$x$", "$$x$$ inline", "echo $HOME and $PATH", "Run $HOME/${PATH} now", "cd $HOME/$(whoami)", "echo $A$#", "$5 or six$", "${HOME} and ${PATH}", "$x$y",
    ]) expect(parseInline(prose)).toEqual(text(prose));
    expect(parseInline("$x^2$ and $\\alpha$.")).toEqual([
      { type: "math", value: "x^2", dollar: true }, { type: "text", value: " and " }, { type: "math", value: "\\alpha", dollar: true }, { type: "text", value: "." },
    ]);
    expect(parseInline("solve $2x+1 = 0$")).toEqual([{ type: "text", value: "solve " }, { type: "math", value: "2x+1 = 0", dollar: true }]);
    expect(parseInline("($E=mc^2$)")).toEqual([{ type: "text", value: "(" }, { type: "math", value: "E=mc^2", dollar: true }, { type: "text", value: ")" }]);
    expect(parseInline("$2 + 2 = 4$")).toEqual([{ type: "math", value: "2 + 2 = 4", dollar: true }]);
    // a formula touching Korean, Japanese or Chinese text (a particle) is still one
    expect(parseInline("$x$는 실수이다")).toEqual([{ type: "math", value: "x", dollar: true }, { type: "text", value: "는 실수이다" }]);
    expect(parseInline("함수 $f(x)$를 보자").map((node) => node.type)).toEqual(["text", "math", "text"]);
    expect(parseInline("값은$x$이다").map((node) => node.type)).toEqual(["text", "math", "text"]);
    // sentence punctuation after a formula ends the sentence, not the formula
    for (const end of ["?", "!", ".", ","]) expect(parseInline(`What is $x$${end}`).map((node) => node.type)).toEqual(["text", "math", "text"]);
    expect(parseInline("$3$ apples")).toEqual([{ type: "math", value: "3", dollar: true }, { type: "text", value: " apples" }]);
    expect(parseInline("`$x$`")).toEqual([{ type: "code", value: "$x$" }]);
    // a code span after a dollar stays a code span: its backtick never joins a formula
    expect(parseInline("$x `y$` z")).toEqual([{ type: "text", value: "$x " }, { type: "code", value: "y$" }, { type: "text", value: " z" }]);
    expect(parseInline("Set $FOO `bar$`")).toEqual([{ type: "text", value: "Set $FOO " }, { type: "code", value: "bar$" }]);
    expect(parseInline("$a`$ b")).toEqual([{ type: "text", value: "$a`$ b" }]);
  });

  it("preserves underscores in identifiers while retaining standalone emphasis", () => {
    for (const value of ["MAC_QA_CHAT_OK", "api_key_name", "foo__bar__baz", "한글_세션_이름"]) {
      expect(parseInline(value)).toEqual([{ type: "text", value }]);
    }
    expect(parseInline("_italic_ (__bold__) `api_key_name`").map((node) => node.type)).toEqual([
      "em", "text", "strong", "text", "code",
    ]);
    expect(parseInline("__MAC_QA_CHAT_OK__")).toEqual([
      { type: "strong", children: [{ type: "text", value: "MAC_QA_CHAT_OK" }] },
    ]);
  });
});

describe("autolinks", () => {
  const link = (href: string): InlineNode => ({ type: "link", href, children: [{ type: "text", value: href }] });

  it("links a bare http(s) URL and keeps the text around it", () => {
    expect(parseInline("https://github.com/devswha/ovis/pull/36 이런거")).toEqual([
      link("https://github.com/devswha/ovis/pull/36"),
      { type: "text", value: " 이런거" },
    ]);
    // no space before Korean: the address ends at the first non-ASCII character
    expect(parseInline("see https://example.com/a에서 확인")).toEqual([
      { type: "text", value: "see " }, link("https://example.com/a"), { type: "text", value: "에서 확인" },
    ]);
  });

  it("leaves the sentence's punctuation out, and keeps parentheses the URL opened", () => {
    expect(parseInline("(see https://example.com/a).")).toEqual([
      { type: "text", value: "(see " }, link("https://example.com/a"), { type: "text", value: ")." },
    ]);
    expect(parseInline("https://en.wikipedia.org/wiki/Rust_(language), then")).toEqual([
      link("https://en.wikipedia.org/wiki/Rust_(language)"), { type: "text", value: ", then" },
    ]);
    expect(parseInline("done: https://example.com/x?y=1&z=2!")).toEqual([
      { type: "text", value: "done: " }, link("https://example.com/x?y=1&z=2"), { type: "text", value: "!" },
    ]);
  });

  it("links an <angle> URL, and nothing inside code, a markdown link, or another scheme", () => {
    expect(parseInline("<https://example.com/a>")).toEqual([link("https://example.com/a")]);
    expect(parseInline("`https://example.com`")).toEqual([{ type: "code", value: "https://example.com" }]);
    expect(parseInline("[https://example.com](https://example.com/b)")).toEqual([
      { type: "link", href: "https://example.com/b", children: [{ type: "text", value: "https://example.com" }] },
    ]);
    for (const value of ["javascript:alert(1)", "ftp://example.com", "file:///etc/passwd", "http:/x"]) {
      expect(parseInline(value).some((node) => node.type === "link")).toBe(false);
    }
  });

  it("links inside emphasis", () => {
    expect(parseInline("**https://example.com**")).toEqual([{ type: "strong", children: [link("https://example.com")] }]);
  });
  it("opens a labeled local file URI through the file viewer", () => {
    expect(parseInline("file:///tmp/README.md")).toEqual([
      { type: "file", path: "/tmp/README.md", children: [{ type: "text", value: "file:///tmp/README.md" }] },
    ]);
    // Korean written straight after the address is prose, as it is after an http one
    expect(parseInline("file:///tmp/a.md에서 확인")).toEqual([
      { type: "file", path: "/tmp/a.md", children: [{ type: "text", value: "file:///tmp/a.md" }] },
      { type: "text", value: "에서 확인" },
    ]);
    expect(parseInline("file:///tmp/Bob's-notes.md")).toEqual([
      { type: "file", path: "/tmp/Bob's-notes.md", children: [{ type: "text", value: "file:///tmp/Bob's-notes.md" }] },
    ]);
    expect(parseInline("[README](file:///tmp/README.md)")).toEqual([
      { type: "file", path: "/tmp/README.md", children: [{ type: "text", value: "README" }] },
    ]);
  });
});

describe("foldCode", () => {
  const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");

  it("shows blocks up to the limit whole", () => {
    expect(foldCode(lines(12))).toBeNull();
    expect(foldCode(lines(FOLD_CODE_AFTER_LINES))).toBeNull();
  });

  it("folds a longer block to its first lines and counts all of them", () => {
    const fold = foldCode(lines(382));
    expect(fold?.lines).toBe(382);
    expect(fold?.head.split("\n")).toHaveLength(FOLDED_CODE_LINES);
    expect(fold?.head.startsWith("line 1\n")).toBe(true);
    expect(fold?.head.endsWith(`line ${FOLDED_CODE_LINES}`)).toBe(true);
  });
});

/**
 * This thread's CPU time in milliseconds, where the system keeps a clock for it (Linux, macOS), or
 * null. process.threadCpuUsage() counts in whole ticks of a millisecond, so a run of two read none
 * on a busy runner, and the ratio was infinite.
 */
const threadClock = ((): (() => number) | null => {
  const id = process.platform === "linux" ? 3 : process.platform === "darwin" ? 16 : null;
  if (id === null) return null;
  try {
    const { symbols } = dlopen(process.platform === "linux" ? "libc.so.6" : "libSystem.B.dylib", { clock_gettime: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } });
    const time = new BigInt64Array(2);
    return () => {
      if (symbols.clock_gettime(id, ptr(time)) !== 0) throw new Error("clock_gettime(CLOCK_THREAD_CPUTIME_ID) failed");
      return Number(time[0]!) * 1000 + Number(time[1]!) / 1e6;
    };
  } catch { return null; }
})();

describe("text no one wrote by hand", () => {
  // what an agent prints, or a changelog holds, is not always prose: the page parses it while it
  // draws, so a line that takes seconds freezes the tab, and one that nests without end crashes it
  /**
   * What `parse` makes of `text(size)`, having checked that it reads in linear time: ten times the
   * text takes under thirty times as long (linear is ten, a search of the rest of the line from
   * every character a hundred). A budget in milliseconds failed on GitHub's runners with nothing
   * slower in the parser, so this counts the CPU time this thread spent, which a busy runner does
   * not stretch as it does the clock (the process's time also counts the compiler's and the garbage
   * collector's threads, and reached 32 on a busy runner, #2084). Small and large are timed in
   * turn, up to five rounds, and the fastest of each are compared: being preempted or slowed only
   * adds time, so the fastest run is the one closest to the parser's own work. A count of the
   * parser's steps would not see what some of these cases guard against, a regular expression
   * backtracking in one call.
   */
  const linear = <T,>(text: (size: number) => string, size: number, parse: (text: string) => T): T => {
    const small = text(size / 10);
    const large = text(size);
    // both read once untimed, so the first timed run is not the one that compiles the parser
    parse(small);
    const read = parse(large);
    const cpu = (): number => {
      if (threadClock !== null) return threadClock();
      const { user, system } = process.cpuUsage();
      return (user + system) / 1000;
    };
    // a parse of microseconds is timed over as many runs as take two milliseconds; twenty where the
    // process's clock may count in steps of milliseconds, so no run of the small text reads none
    const shortest = threadClock === null ? 20 : 2;
    let runs = 1;
    const timed = (input: string): number => {
      const start = cpu();
      for (let run = 0; run < runs; run += 1) parse(input);
      return cpu() - start;
    };
    while (timed(small) < shortest) runs *= 2;
    let fastestSmall = Infinity;
    let fastestLarge = Infinity;
    for (let round = 0; round < 5 && !(fastestLarge / fastestSmall < 30); round += 1) {
      fastestSmall = Math.min(fastestSmall, timed(small));
      fastestLarge = Math.min(fastestLarge, timed(large));
    }
    expect(fastestLarge / fastestSmall).toBeLessThan(30);
    return read;
  };
  /** every string of up to `length` of the `parts`, in order */
  const everyLine = (parts: string[], length: number): string[] => {
    let lines = [""];
    const all = [""];
    for (let step = 0; step < length; step += 1) {
      lines = lines.flatMap((line) => parts.map((part) => line + part));
      all.push(...lines);
    }
    return all;
  };

  it("cuts a URL's closing parentheses as it did, counting them once", () => {
    // the rule as it was written first: both counts taken again at every closing parenthesis
    const asBefore = (url: string): string => {
      let end = url.length;
      for (;;) {
        const last = url[end - 1];
        if (last !== undefined && ".,:;!?'\"*_~".includes(last)) { end -= 1; continue; }
        if (last === ")") {
          const text = url.slice(0, end);
          if (text.split(")").length > text.split("(").length) { end -= 1; continue; }
        }
        break;
      }
      return url.slice(0, end);
    };
    const urls = everyLine(["a", "(", ")", ".", "_"], 6).map((tail) => `https://x.dev/${tail}`);
    expect(urls.length).toBeGreaterThan(19_000);
    for (const url of urls) expect(trimUrl(url)).toBe(asBefore(url));
    const closing = (count: number): string => `https://x.dev/${")".repeat(count)}`;
    expect(linear(closing, 48_000, trimUrl)).toBe("https://x.dev/");
    linear(closing, 48_000, (text) => parseMarkdown(text));
  });

  it("knows a table's separator line as it did, cell by cell", () => {
    // the one pattern it was: it shares a run of spaces between its parts in every way there is
    const asBefore = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/;
    const lines = everyLine([" ", "|", "---", "--", ":", "x"], 6);
    expect(lines.length).toBeGreaterThan(55_000);
    let separators = 0;
    for (const line of lines) {
      expect(`${line}: ${isTableSeparator(line)}`).toBe(`${line}: ${asBefore.test(line)}`);
      if (isTableSeparator(line)) separators += 1;
    }
    expect(separators).toBeGreaterThan(100);
    for (const line of ["|---|---|", "---|---", " | :--- | ---: | :---: | ", "\t|---\t|\t---|\t", "|--|--|", "|---|:-:|-|"]) expect(isTableSeparator(line)).toBe(true);
    for (const line of ["", "---", "|---|", "||---|---", "|---|---||", "|---|:|", "|---|-x-|"]) expect(isTableSeparator(line)).toBe(false);
    linear((spaces) => `a|b\n${" ".repeat(spaces)}x`, 96_000, (text) => parseMarkdown(text));
    linear((spaces) => `a|b\n---|---${" ".repeat(spaces)}x`, 96_000, (text) => parseMarkdown(text));
  });

  it("looks once for the end of a formula that never closes", () => {
    const indexOf = String.prototype.indexOf;
    // characters the closer searches read, not how many there are: one search per opener over the
    // rest of the text is as many calls as one per line, but reads the text over and over
    let scanned = 0;
    let expectedMaximum = 0;
    const closer = spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search, position) {
      const found = indexOf.call(this, search, position);
      if (search === "\\]") {
        const from = Math.max(0, Math.min(this.length, Number(position ?? 0)));
        scanned += (found === -1 ? this.length : found + search.length) - from;
        // Fail promptly on a quadratic search instead of finishing its work.
        expect(scanned).toBeLessThanOrEqual(expectedMaximum);
      }
      return found;
    });
    let blocks: ReturnType<typeof parseMarkdown> = [];
    try {
      for (const lines of [3_200, 32_000]) {
        const text = "\\[\n".repeat(lines);
        scanned = 0;
        // the text read about once, with a few characters for each line's own search
        expectedMaximum = text.length + 4 * (lines + 1);
        blocks = parseMarkdown(text);
        expect(scanned).toBeGreaterThan(0);
        expect(scanned).toBeLessThanOrEqual(expectedMaximum);
      }
    } finally {
      closer.mockRestore();
    }
    expect(blocks).toHaveLength(32_000);
    expect(blocks.every((block) => block.type === "paragraph")).toBe(true);
    // the search ends at a fence: what opens after it is looked for again
    expect(parseMarkdown("\\[ a\n\\[ b\n```\ncode\n```\n\\[ c \\]\n\\[ d").map((block) => block.type))
      .toEqual(["paragraph", "paragraph", "code", "math", "paragraph"]);
  });

  it("looks once for what closes a bracket, an inline formula or an underscore", () => {
    const exec = RegExp.prototype.exec;
    // These searches have no variable-length backtracking inside one attempt. The token pattern
    // is deliberately absent: a single global exec of it can search quadratically before failing.
    const searches = new Set([
      /[`[<*_~$]|:codex-file-citation\{|\\\(|file:\/\/\/|https?:\/\/|www\./g,
      /\n/g, /}/g, /[\n\r\u2028\u2029]/g, /\\\)/g, /\$/g, /[\]\n]/g, /[\s)]/g,
      /_(?![\p{L}\p{N}\p{M}_])/gu,
      /__(?![\p{L}\p{N}\p{M}_])/gu,
      // Only the single-underscore token can succeed in the last fixture; trying the bold
      // alternative first would rescan the whole suffix at every `__`.
      /_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_])/yu,
      // one sticky attempt, over a run with no `*` in it
      /\*\*[^*\n]+\*\*/y,
    ].map((pattern) => pattern.toString()));
    const counted = (text: string): InlineNode[] => {
      let scanned = 0;
      let unbounded = 0;
      const closer = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, input) {
        if (input !== text) return exec.call(this, input);
        if (!searches.has(this.toString())) {
          unbounded += 1;
          // Stop before running a potentially quadratic search, even on the largest fixture.
          expect(unbounded).toBe(0);
        }
        const start = this.lastIndex;
        const match = exec.call(this, input);
        // Count the span searched, not calls: failed searches consume the remaining suffix.
        scanned += Math.max(0, (match === null ? input.length : match.index + match[0].length) - start);
        return match;
      });
      let nodes: InlineNode[];
      try {
        nodes = parseInline(text);
      } finally {
        closer.mockRestore();
      }
      expect(scanned).toBeGreaterThan(0);
      // Each opener/closer search gets one pass; tokens consume their own text.
      expect(scanned).toBeLessThanOrEqual(10 * text.length);
      return nodes;
    };
    // a megabyte of each took from one minute to four: every one was searched from to the line's end
    for (const part of ["[a", "\\(", "_a ", "__a ", "a$", ":codex-file-citation{"]) {
      const line = (length: number): string => part.repeat(Math.ceil(length / part.length));
      for (const length of [20_000, 200_000]) {
        expect(counted(line(length))).toEqual([{ type: "text", value: line(length) }]);
      }
    }
    // a label closed with an address that is not, and a `__` that only a `_` closes
    for (const count of [4_000, 40_000]) expect(counted("[a](b".repeat(count))).toHaveLength(1);
    for (const count of [3_000, 30_000]) expect(counted("__a b_ ".repeat(count))).toHaveLength(count * 2);
    // the marks are the ones it found as one pattern, searching the whole line
    const asBefore = /(`[^`\n]+`|\\\(.+?\\\)|\[[^\]\n]+\]\([^\s)]+\)|<https?:\/\/[^\s<>]+>|file:\/\/\/[!#-;=?-_a-~]+|https?:\/\/[!-;=?-~]+|(?<![\w.@/-])www\.[!-;=?-~]+|\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}\p{M}_])__(?=\S)[^\n]*?\S__(?![\p{L}\p{N}\p{M}_])|~~[^~\n]+~~|(?<!\*)\*[^*\n]+\*(?!\*)|(?<![\p{L}\p{N}\p{M}_])_(?=\S)[^\n]*?\S_(?![\p{L}\p{N}\p{M}_]))/gu;
    const found = (marks: Iterable<RegExpMatchArray>): string => [...marks].map((mark) => `${mark.index}:${mark[0]}`).join("\n");
    const lines = everyLine(["_", "a", " ", "[", "](", ")", "\\(", "\\)", "\n"], 5);
    expect(lines.length).toBeGreaterThan(66_000);
    let marked = 0;
    for (const line of lines) {
      const marks = found(inlineMarks(line));
      expect(`${line}: ${marks}`).toBe(`${line}: ${found(line.matchAll(asBefore))}`);
      if (marks !== "") marked += 1;
    }
    expect(marked).toBeGreaterThan(1000);
  });

  it("reads a line of dollars that never closes in linear time", () => {
    for (const part of ["$a ", "$5 ", "$a\\$", " $a$b"]) linear((size) => part.repeat(size / part.length), 200_000, (line) => parseInline(line));
  });

  it("adds an item's lines to it without copying the item at every line", () => {
    const [list] = linear((lines) => `- a\n${"  x\n".repeat(lines)}`, 48_000, (text) => parseMarkdown(text)) as [ListBlock];
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.content).toHaveLength(96_001);
  });

  it("stops nesting emphasis after a few levels, and keeps what is inside as text", () => {
    const depth = (nodes: InlineNode[]): number => {
      let levels = 0;
      for (let level = nodes; level.length > 0; levels += 1) {
        level = level.flatMap((node) => "children" in node ? node.children : []);
      }
      return levels;
    };
    const nodes = linear((count) => `${"_".repeat(count)} x`, 48_000, (text) => parseInline(text));
    expect(depth(nodes)).toBeLessThan(20);
    // nothing is lost: what the levels left over hold is still there, as text
    expect(JSON.stringify(nodes)).toContain("_".repeat(40_000));
    // what people write nests as before
    expect(parseInline("**a _b ~~c~~_**")).toEqual([{ type: "strong", children: [{ type: "text", value: "a " },
      { type: "em", children: [{ type: "text", value: "b " }, { type: "del", children: [{ type: "text", value: "c" }] }] }] }]);
    expect(depth(parseInline(`${"__".repeat(8)}a${"__".repeat(8)}`))).toBe(9);
    // a link around it is not a level: sixteen of emphasis read whole inside a label too
    const sixteen = `${"__".repeat(16)}a\`x\`b${"__".repeat(16)}`;
    expect(JSON.stringify(parseInline(sixteen))).toContain('{"type":"code","value":"x"}');
    expect(JSON.stringify(parseInline(`[${sixteen}](https://x.dev)`))).toContain('{"type":"code","value":"x"}');
  });

  it("reads a heading or an item whose text holds a line separator, without trying every split of its spaces", () => {
    // U+2028 is not a line here (only \n is), and `.` stops at it unless told otherwise
    const [heading] = linear((spaces) => `# ${" ".repeat(spaces)}a\u2028b`, 48_000, (text) => parseMarkdown(text));
    expect(heading).toEqual({ type: "heading", level: 1, content: [{ type: "text", value: "a\u2028b" }] });
    const [list] = linear((spaces) => `- ${" ".repeat(spaces)}a\u2028b`, 48_000, (text) => parseMarkdown(text)) as [ListBlock];
    expect(list.items).toEqual([{ content: [{ type: "text", value: "a\u2028b" }] }]);
    linear((spaces) => `1. ${" ".repeat(spaces)}\u2029`, 48_000, (text) => parseMarkdown(text));
  });

  it("shows a formula nested beyond reason as its source, without asking KaTeX", async () => {
    for (const formula of ["x", "\\frac{1}{2}", "{".repeat(100) + "}".repeat(100), "\\{".repeat(500), "{}".repeat(5000)]) expect(mathNestsTooDeep(formula)).toBe(false);
    expect(mathNestsTooDeep("{".repeat(101))).toBe(true);
    const fractions = `${"\\frac{1}{".repeat(4000)}x${"}".repeat(4000)}`;
    expect(mathNestsTooDeep(fractions)).toBe(true);
    const katex = await loadKatex();
    const asked = spyOn(katex, "renderToString");
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Markdown, { children: `\\[${fractions}\\]\n\n\\(\\frac{1}{2}\\)` }) }));
      expect(html).toContain("\\frac{1}{\\frac{1}{");
      // the formula beside it is still drawn, and it is the only one KaTeX was given
      expect(html).toContain("katex-html");
      expect(asked.mock.calls.map(([formula]) => formula)).toEqual(["\\frac{1}{2}"]);
    } finally {
      asked.mockRestore();
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });
});

describe("numbered lists as agents write them", () => {
  const render = (source: string): string => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(Markdown, { children: source }) }));
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const lists = (source: string) => parseMarkdown(source).map((block) => block.type === "list" ? { start: block.start ?? 1, items: block.items.length } : block.type);

  it("tells the list how many digits its widest number has, as the browser numbers it (#1993)", () => {
    const digits = (source: string) => render(source).match(/--markdown-list-digits:(\d+)/)?.[1] ?? null;
    expect(digits("1. a\n2. b")).toBeNull();
    expect(digits("9. a\n10. b")).toBe("2");
    expect(digits("99. a\n100. b")).toBe("3");
    expect(digits("0. a")).toBeNull();
    expect(digits("- a\n- b")).toBeNull();
    // a nested list counts its own numbers, not its parent's
    expect(render("100. a\n    1. b")).toMatch(/--markdown-list-digits:3[^>]*><li><span>a<\/span><ol class="markdown-list"><li>/);
    // past a 32-bit integer the browser counts from 1, so that start sets no wider indent
    expect(digits("2147483647. a")).toBe("10");
    expect(digits("100000000000000000000. a")).toBeNull();
  });

  it("reads a task list item's box as checked or open, and keeps the rest as its text", () => {
    const [block] = parseMarkdown("- [x] done\n- [ ] open\n- [X] also done\n- [ ]\n- [y] not a box\n- plain");
    expect((block as ListBlock).items.map((item) => [item.checked, item.content])).toEqual([
      [true, [{ type: "text", value: "done" }]],
      [false, [{ type: "text", value: "open" }]],
      [true, [{ type: "text", value: "also done" }]],
      [false, []],
      [undefined, [{ type: "text", value: "[y] not a box" }]],
      [undefined, [{ type: "text", value: "plain" }]],
    ]);
    const html = render("1. step\n   - [x] done\n   - [ ] open");
    // the box is named by the item's text, so a screen reader says "done, checkbox, checked"
    const done = /<li class="markdown-task"><span class="markdown-task-box" role="checkbox" aria-checked="true" aria-disabled="true" aria-labelledby="([^"]+)"><svg[^]*?<\/svg><\/span><span id="([^"]+)"><span>done<\/span><\/span><\/li>/.exec(html);
    expect(done?.[1]).toBe(done?.[2]!);
    const open = /<li class="markdown-task"><span class="markdown-task-box" role="checkbox" aria-checked="false" aria-disabled="true" aria-labelledby="([^"]+)"><\/span><span id="([^"]+)"><span>open<\/span><\/span><\/li>/.exec(html);
    expect(open?.[1]).toBe(open?.[2]!);
    expect(done).not.toBeNull();
    expect(open).not.toBeNull();
    expect(open?.[1]).not.toBe(done?.[1]);
    // a task with no text has nothing to be labelled by: it is named as an empty task
    expect(render("- [ ]")).toContain('<span class="markdown-task-box" role="checkbox" aria-checked="false" aria-disabled="true" aria-label="Empty task"></span>');
  });

  it("keeps one list across blank lines between its items", () => {
    expect(lists("1. a\n\n2. b\n\n3. c")).toEqual([{ start: 1, items: 3 }]);
  });

  it("goes on from its own number after a code block or other break, and starts where it says", () => {
    expect(lists("1. first\n```\ncode\n```\n2. second\n3. third")).toEqual([{ start: 1, items: 1 }, "code", { start: 2, items: 2 }]);
    expect(lists("3. three\n4. four")).toEqual([{ start: 3, items: 2 }]);
  });

  it("reads an item's indented lines as its own text, and an indented fence as code", () => {
    const blocks = parseMarkdown("1. first\n   more about it\n2. second");
    expect(lists("1. first\n   more about it\n2. second")).toEqual([{ start: 1, items: 2 }]);
    const first = (blocks[0] as Extract<ReturnType<typeof parseMarkdown>[number], { type: "list" }>).items[0]!;
    expect(first.content.map((node) => node.type === "text" ? node.value : "").join("")).toBe("first more about it");
    const fenced = parseMarkdown("1. run it\n   ```sh\n   bun test\n   ```\n2. then this");
    expect(fenced.map((block) => block.type)).toEqual(["list", "code", "list"]);
    expect(fenced[1]).toEqual({ type: "code", language: "sh", value: "bun test" });
  });

  it("shows a table indented under an item as a table in that item, not as the item's text", () => {
    const blocks = parseMarkdown("1. **Two ways**\n   - Example:\n\n     | Way | Box |\n     |---|---|\n     | a | `[0,1]` |\n     | b | `[2,3]` |\n\n   - after it\n\n2. second");
    expect(lists("1. **Two ways**\n   - Example:\n\n     | Way | Box |\n     |---|---|\n     | a | `[0,1]` |\n\n   - after it\n\n2. second")).toEqual([{ start: 1, items: 2 }]);
    const item = (blocks[0] as ListBlock).items[0]!;
    const nested = item.blocks?.[0] as ListBlock;
    // the sibling after the table stays nested, in the same list as the item the table is under
    expect(nested.items.map((entry) => entry.content)).toEqual([[{ type: "text", value: "Example:" }], [{ type: "text", value: "after it" }]]);
    expect(nested.items[0]?.blocks?.[0]).toMatchObject({ type: "table", header: [[{ value: "Way" }], [{ value: "Box" }]], rows: [[[{ value: "a" }], [{ type: "code", value: "[0,1]" }]], [[{ value: "b" }], [{ type: "code", value: "[2,3]" }]]] });
  });

  it("goes on counting after a table in an item, the way agents number every item 1.", () => {
    const source = "1. first\n\n   | a | b |\n   |---|---|\n   | 1 | 2 |\n\n1. second\n1. third";
    expect(lists(source)).toEqual([{ start: 1, items: 3 }]);
    const html = render(source);
    expect(html).toContain('<ol class="markdown-list"><li><span>first</span><div class="markdown-table-wrap"><table>');
    expect(html.match(/<ol/g)).toHaveLength(1);
  });

  it("keeps a table and a nested list under one item in the order they were written", () => {
    const [list] = parseMarkdown("- item\n  - sub\n\n  | a | b |\n  |---|---|\n  | 1 | 2 |\n\n  - more\n- next");
    expect((list as ListBlock).items[0]?.blocks?.map((block) => block.type)).toEqual(["list", "table", "list"]);
    expect((list as ListBlock).items).toHaveLength(2);
  });

  it("keeps an item's text after its table below the table", () => {
    const source = "1. Before\n\n   | A | B |\n   |---|---|\n   | x | y |\n\n   After the table.\n   And more.\n\n   Another paragraph.\n\n1. Next";
    const [list] = parseMarkdown(source);
    expect(lists(source)).toEqual([{ start: 1, items: 2 }]);
    const item = (list as ListBlock).items[0]!;
    expect(item.content).toEqual([{ type: "text", value: "Before" }]);
    expect(item.blocks).toMatchObject([
      { type: "table" },
      { type: "paragraph", lines: [[{ value: "After the table." }], [{ value: "And more." }]] },
      { type: "paragraph", lines: [[{ value: "Another paragraph." }]] },
    ]);
    expect(render(source)).toContain("</table></div><p>");
  });

  it("ends the list at a quote after an item's table, as before tables nested", () => {
    const blocks = parseMarkdown("1. Before\n\n   | A | B |\n   |---|---|\n   | x | y |\n\n   > Note\n\n1. Next");
    expect(blocks.map((block) => block.type)).toEqual(["list", "blockquote", "list"]);
  });

  it("ends an item's table at the next item or a line outside the item", () => {
    const [list] = parseMarkdown("- item\n  | A | B |\n  |---|---|\n  | x | y |\n- next | value");
    expect((list as ListBlock).items.map((item) => item.content)).toEqual([[{ type: "text", value: "item" }], [{ type: "text", value: "next | value" }]]);
    expect((list as ListBlock).items[0]?.blocks?.[0]).toMatchObject({ type: "table", rows: [[[{ value: "x" }], [{ value: "y" }]]] });
    const blocks = parseMarkdown("- item\n  | A | B |\n  |---|---|\n  | x | y |\nnot | in it");
    expect(blocks.map((block) => block.type)).toEqual(["list", "paragraph"]);
  });

  it("keeps both of two nested lists under one item", () => {
    const [list] = parseMarkdown("- item\n  - bullet\n  1. step");
    expect((list as ListBlock).items[0]?.blocks?.map((block) => block.type === "list" && block.ordered)).toEqual([false, true]);
  });

  it("escapes markup in a table cell inside a list item", () => {
    const html = render("- item\n\n  | <b>x</b> | y |\n  |---|---|\n  | <script>alert(1)</script> | <img src=x onerror=alert(1)> |");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
  });
});

describe("quotes nested beyond reason", () => {
  it("parses a line of thousands of quote marks without overflowing the stack", () => {
    const blocks = parseMarkdown(`${">".repeat(30_000)} deep\n\nafter`);
    expect(blocks.map((block) => block.type)).toEqual(["blockquote", "paragraph"]);
    let depth = 0;
    for (let block = blocks[0]; block?.type === "blockquote"; block = block.blocks[0]) depth += 1;
    expect(depth).toBe(33);
  });

  it("still nests the quotes people write", () => {
    const [outer] = parseMarkdown("> one\n> > two");
    expect(outer?.type === "blockquote" && outer.blocks.map((block) => block.type)).toEqual(["paragraph", "blockquote"]);
  });

  it("reads ![alt](src) as an image whose fallback is the `!` and the link it was", () => {
    expect(parseInline("see ![a pic](img/a.png) now")).toEqual([
      { type: "text", value: "see " },
      { type: "image", alt: "a pic", src: "img/a.png", fallback: [{ type: "text", value: "!" }, { type: "file", path: "img/a.png", children: [{ type: "text", value: "a pic" }] }] },
      { type: "text", value: " now" },
    ]);
    expect(parseInline("![x](https://a.dev/x.png)")[0]).toMatchObject({ type: "image", fallback: [{ type: "text", value: "!" }, { type: "link", href: "https://a.dev/x.png" }] });
  });
});

describe("file paths in output", () => {
  const LOG = "/tmp/editor-shot/t00000.png (1600, 1000) -> (1255, 960)\ndisplay image 1: [image/png]";
  const render = (element: ReturnType<typeof createElement>, open: ((path: string) => void) | null): string => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    // a code block folds itself in a layout effect, which a static render warns it skips
    const error = console.error;
    console.error = (...args: unknown[]) => { if (!String(args[0]).includes("useLayoutEffect")) error(...args); };
    try {
      return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(OpenFileContext.Provider, { value: open, children: element }) }));
    } finally {
      console.error = error;
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  };
  const opener = (): void => {};

  it("opens the files a log in a plain code block names, and leaves code in a language alone", () => {
    const plain = render(createElement(Markdown, { children: `\`\`\`\n${LOG}\n\`\`\`` }), opener);
    expect(plain).toContain(`<button type="button" class="markdown-file" title="Open /tmp/editor-shot/t00000.png">/tmp/editor-shot/t00000.png</button> (1600, 1000)`);
    // a MIME type has no extension: it is not a file
    expect(plain).not.toContain("Open image/png");
    const code = render(createElement(Markdown, { children: "```ts\nimport { a } from \"./lib/a.ts\";\n```" }), opener);
    expect(code).not.toContain("markdown-file");
    // a language with no grammar here is still a language; a tag that says plain output is not
    expect(render(createElement(Markdown, { children: "```rust\ninclude_str!(\"./private/key.pem\");\n```" }), opener)).not.toContain("markdown-file");
    expect(render(createElement(Markdown, { children: `\`\`\`log\n${LOG}\n\`\`\`` }), opener)).toContain("markdown-file");
    // nothing to open them with: the text stays as it was
    expect(render(createElement(Markdown, { children: `\`\`\`\n${LOG}\n\`\`\`` }), null)).not.toContain("markdown-file");
  });

  it("links a tool output's paths, keeping its text, and leaves a huge output plain", () => {
    const html = render(createElement("pre", null, linkFilePaths(LOG, opener)), opener);
    expect(html).toBe(`<pre><button type="button" class="markdown-file" title="Open /tmp/editor-shot/t00000.png">/tmp/editor-shot/t00000.png</button> (1600, 1000) -&gt; (1255, 960)\ndisplay image 1: [image/png]</pre>`);
    expect(linkFilePaths("no paths here", opener)).toBe("no paths here");
    const huge = `${"x".repeat(FILE_LINK_LIMIT)} /tmp/a/b.png`;
    expect(linkFilePaths(huge, opener)).toBe(huge);
    expect(linkFilePaths(LOG, null)).toBe(LOG);
    // a listing of thousands is not thousands of buttons
    const listing = Array.from({ length: FILE_LINK_COUNT + 1 }, (_, i) => `/tmp/a/${i}.png`).join(" ");
    expect(linkFilePaths(listing, opener)).toBe(listing);
  });

  it("measures a code block's links by the whole block, not line by line", () => {
    const dense = Array.from({ length: 20 }, () => "/tmp/a.png ".repeat(1_500).trim()).join("\n");
    expect(dense.length).toBeGreaterThan(FILE_LINK_LIMIT);
    const html = render(createElement(HighlightedCode, { code: dense, language: null, open: opener }), opener);
    expect(html).not.toContain("markdown-file");
    const few = render(createElement(HighlightedCode, { code: "/tmp/a.png\n/tmp/b.png", language: null, open: opener }), opener);
    expect(few.match(/markdown-file/g)).toHaveLength(2);
  });
});
