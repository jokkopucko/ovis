import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OmoAskReader, ompAsksAfter, type OmoAsks } from "./omo-ask.ts";
import { ompMarkdownPrompt } from "./omp-ask.ts";
import { answerKeys, parseInteractivePrompt } from "./prompt.ts";

// Real omp screens and session files (#1644): an ask call of three Markdown questions from a fake
// model provider, recorded in the isolated herdr test session with a disposable omp home, at 120
// and 60 columns. `md-open` is the session while the dialog waits, `md-settled` after it was answered.
const VERSIONS = ["18.12.6", "18.13.2"] as const;
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/omp-ask-${name}`, import.meta.url));
const screen = (version: string, name: string, width: number) => readFileSync(fixture(`${version}-md-${name}-${width}.txt`), "utf8");
const open = (version: string, state: "open" | "settled" = "open") => new OmoAskReader(ompAsksAfter).read(fixture(`${version}-md-${state}.jsonl`));
const card = (shown: string) => parseInteractivePrompt("omp", shown)!;
type Asked = { questions: { question: string; options: { label: string; description?: string }[] }[] };
const withArgs = (asks: OmoAsks, change: (args: Asked) => void): OmoAsks => asks.map((call) => {
  const args = structuredClone(call.args) as Asked;
  change(args);
  return { ...call, args };
});

describe("omp Ask cards in the agent's own Markdown (#1644)", () => {
  for (const version of VERSIONS) for (const width of [120, 60]) {
    it(`gives the open call's Markdown to the question on screen (${version}, ${width} columns)`, () => {
      const single = card(screen(version, "single", width));
      const rich = ompMarkdownPrompt(single, open(version));
      expect(single.text_format).toBeUndefined();
      expect(rich).toMatchObject({
        id: single.id, text_format: "markdown", multi_select: false, custom_option_index: 2,
        question: "Which **route** should carry the `fixture` session? See [the guide](https://example.com/guide).",
        options: [
          { label: "Use `local` socket", description: "Keeps the **session** on *this* PC." },
          { label: "Remote relay", description: "Goes through [the relay](https://example.com/relay) with `ssh`." },
        ],
      });
      // the menu on screen still answers: the same keys as the card read off it
      for (const answer of [{ option_index: 0 }, { option_index: 1 }, { custom_text: "Keep `it`" }]) {
        expect(answerKeys(rich, answer)).toEqual(answerKeys(single, answer));
      }

      // a question omp cut at four rows stays as drawn: what it shows is a prefix, which another call's
      // question may share, and the card must not give one call's words to the menu of another
      const multi = card(screen(version, "multi", width));
      expect(multi.question.endsWith("…")).toBe(true);
      expect(ompMarkdownPrompt(multi, open(version))).toBe(multi);
    });

    it(`leaves an option with a preview as drawn (${version}, ${width} columns)`, () => {
      const preview = card(screen(version, "preview", width));
      expect(ompMarkdownPrompt(preview, open(version))).toBe(preview);
    });
  }

  it("leaves the card as drawn when no open call is provably the menu on screen", () => {
    const version = "18.12.6";
    const single = card(screen(version, "single", 120));
    const asks = open(version);
    expect(open(version, "settled")).toEqual([]);
    const unproved: [string, OmoAsks][] = [
      ["no open call: the session recorded the answer", open(version, "settled")],
      ["two open calls", [...asks, { ...asks[0]!, id: "another" }]],
      ["another question", withArgs(asks, (args) => { args.questions[0]!.question = "Which **route** should carry the `other` session?"; })],
      ["the options in another order", withArgs(asks, (args) => { args.questions[0]!.options.reverse(); })],
      ["another label", withArgs(asks, (args) => { args.questions[0]!.options[1]!.label = "Remote `relay` host"; })],
      // what the letters alone would not tell apart: a path, a link's address, a mark, a letter's case
      ["a label with a path", withArgs(asks, (args) => { args.questions[0]!.options[0]!.label = "Use `local/socket`"; })],
      ["another address", withArgs(asks, (args) => { args.questions[0]!.question = args.questions[0]!.question.replace("/guide", "/Guide"); })],
      ["a description with a mark more", withArgs(asks, (args) => { args.questions[0]!.options[0]!.description = "Keeps the **session** on *this* P/C."; })],
      ["a label in another case", withArgs(asks, (args) => { args.questions[0]!.options[1]!.label = "remote relay"; })],
      // omp draws the characters in code as written
      ["code with an underscore", withArgs(asks, (args) => { args.questions[0]!.options[0]!.label = "Use `local_socket`"; })],
      ["code with an asterisk", withArgs(asks, (args) => { args.questions[0]!.options[0]!.label = "Use `local*socket`"; })],
      ["an address with an underscore", withArgs(asks, (args) => { args.questions[0]!.question = args.questions[0]!.question.replace("/guide", "/gui_de"); })],
      // a space between two words: omp wraps at the spaces, but never takes one out (#2220, CodeRabbit)
      ["a space less", withArgs(asks, (args) => { args.questions[0]!.options[0]!.label = "Use `local`socket"; })],
      // and a mark that pairs with nothing, as a glob or a path
      ["an unpaired asterisk", withArgs(asks, (args) => { args.questions[0]!.options[0]!.label = "Use `local` *socket"; })],
      ["an unpaired underscore", withArgs(asks, (args) => { args.questions[0]!.options[0]!.label = "Use `local` _socket"; })],
      // where Bun's parser and omp's part: omp draws an HTML entity and `~x~` as written
      ["an HTML entity", withArgs(asks, (args) => { args.questions[0]!.options[0]!.label = "Use `local`&#32;socket"; })],
      ["single tildes", withArgs(asks, (args) => { args.questions[0]!.options[0]!.label = "Use `local` ~socket~"; })],
      // Markdown omp draws in its own way: a table
      ["a table in the question", withArgs(asks, (args) => { args.questions[0]!.question += "\n\n| a | b |\n|---|---|\n| 1 | 2 |"; })],
      ["another description", withArgs(asks, (args) => { args.questions[0]!.options[0]!.description = "Keeps the **session** elsewhere."; })],
      ["a description omp does not show", withArgs(asks, (args) => { delete args.questions[0]!.options[0]!.description; })],
      ["one more option", withArgs(asks, (args) => { args.questions[0]!.options.push({ label: "Third" }); })],
      ["the same question twice in the call", withArgs(asks, (args) => { args.questions.push(structuredClone(args.questions[0]!)); })],
      ["arguments in no shape omp asks with", asks.map((call) => ({ ...call, args: { questions: "route" } }))],
    ];
    for (const [name, calls] of unproved) expect(ompMarkdownPrompt(single, calls), name).toBe(single);
    // a question that ends in its own `\u2026` on one row is not one omp cut: it shows the whole question
    const row = "Which route should carry the fixture session? See the guide (https://example.com/guide).";
    const drawnScreen = screen(version, "single", 120);
    const at = drawnScreen.lastIndexOf(row);
    const ending = card(drawnScreen.slice(0, at) + "Which route should carry the fixture session\u2026".padEnd(row.length) + drawnScreen.slice(at + row.length));
    expect(ending.question).toBe("Which route should carry the fixture session\u2026");
    const longer = withArgs(asks, (args) => { args.questions[0]!.question = "Which **route** should carry the `fixture` session into production?"; });
    expect(ompMarkdownPrompt(ending, longer)).toBe(ending);
    // nor is one that fills four rows while omp's footer offers nothing to expand
    const full = screen(version, "multi", 120).replace(" \u00b7 Ctrl+O expand", "               ");
    const unexpanded = card(full);
    expect(unexpanded.question.endsWith("\u2026")).toBe(true);
    expect(ompMarkdownPrompt(unexpanded, open(version))).toBe(unexpanded);
    // omp's review of the answers is no question card
    const review = card(readFileSync(fixture("18.12.6-submit-60.txt"), "utf8"));
    expect(review.title).toBe("Review answers");
    expect(ompMarkdownPrompt(review, asks)).toBe(review);
  });

  it("leaves the card as drawn where the chat's own Markdown scanner would show other characters (#2220 review)", () => {
    const version = "18.12.6";
    const drawnScreen = screen(version, "single", 120);
    // the screen's rows rewritten in place, as omp would draw these labels
    const relabel = (shown: string, labels: [string, string]) => {
      let out = shown;
      for (const [from, to] of [["Use local socket (Recommended)", labels[0]], ["Remote relay", labels[1]]] as const) {
        const at = out.lastIndexOf(from);
        out = out.slice(0, at) + to.padEnd(from.length) + out.slice(at + from.length);
      }
      return out;
    };
    const cases: [string, [string, string], [string, string]][] = [
      // omp draws the stars of a glob pair as written; the chat's scanner takes them for emphasis
      ["a glob pair", ["Keep *.log and *.tmp", "Keep .log and .tmp"], ["Keep *.log and *.tmp", "Keep .log and .tmp"]],
      // an escaped mark: omp draws the mark, the chat's scanner keeps the backslash
      ["an escape", ["Keep \\*literal\\* files", "Remote relay"], ["Keep *literal* files", "Remote relay"]],
      // a code span in two backticks around one
      ["a two-backtick code span", ["Run `` a`b ``", "Remote relay"], ["Run a`b", "Remote relay"]],
    ];
    for (const [name, asked, shown] of cases) {
      const menu = card(relabel(drawnScreen, shown));
      expect(menu.options.map((option) => option.label), name).toEqual(shown);
      const calls = withArgs(open(version), (args) => {
        args.questions[0]!.options[0]!.label = asked[0];
        args.questions[0]!.options[1]!.label = asked[1];
      });
      expect(ompMarkdownPrompt(menu, calls), name).toBe(menu);
    }
    // the glob pair in the question itself
    const row = "Which route should carry the fixture session? See the guide (https://example.com/guide).";
    const at = drawnScreen.lastIndexOf(row);
    const globs = card(drawnScreen.slice(0, at) + "Keep *.log and *.tmp?".padEnd(row.length) + drawnScreen.slice(at + row.length));
    const asked = withArgs(open(version), (args) => { args.questions[0]!.question = "Keep *.log and *.tmp?"; });
    expect(ompMarkdownPrompt(globs, asked)).toBe(globs);
    // a picture: omp draws its alt text, the card its picture or `!` and its address
    const picture = card(drawnScreen.slice(0, at) + "Use production or staging?".padEnd(row.length) + drawnScreen.slice(at + row.length));
    const pictured = withArgs(open(version), (args) => { args.questions[0]!.question = "Use ![production](/etc/prod.conf) or staging?"; });
    expect(ompMarkdownPrompt(picture, pictured)).toBe(picture);
  });

  it("leaves the card as drawn for a question the card would draw as a diagram, or options it would show alike (#2233)", () => {
    // omp draws a ```mermaid fence's code; the chat's Markdown would draw a diagram in its place
    // (this fixture's question is cut, so it stays as drawn whatever its fences; the rule below holds for whole ones)
    const multi = card(screen("18.13.2", "multi", 120));
    expect(ompMarkdownPrompt(multi, open("18.13.2"))).toBe(multi);
    // and a ```svg fence's, which the chat draws as a figure, and a ```math one's, drawn as a formula
    for (const language of ["mermaid", "svg", "math"]) {
      const diagram = withArgs(open("18.13.2"), (args) => { args.questions[1]!.question = args.questions[1]!.question.replace("```sh", `\`\`\`${language}`); });
      expect(ompMarkdownPrompt(multi, diagram)).toBe(multi);
    }

    // two options omp draws as different characters (or with different link addresses) that the card shows alike
    const version = "18.12.6";
    const drawnScreen = screen(version, "single", 120);
    const relabel = (labels: [string, string]) => {
      let out = drawnScreen;
      for (const [from, to] of [["Use local socket (Recommended)", labels[0]], ["Remote relay", labels[1]]] as const) {
        const at = out.lastIndexOf(from);
        out = out.slice(0, at) + to.padEnd(from.length) + out.slice(at + from.length);
      }
      return out;
    };
    const cases: [string, [string, string], [string, string]][] = [
      ["spacing twins", ["Keep **production**", "Keep  **production**"], ["Keep production", "Keep  production"]],
      ["one link's words to two addresses", ["Keep [production](https://a.example)", "Keep [production](https://b.example)"], ["Keep production", "Keep production"]],
      ["case twins", ["Keep **Production**", "Keep **production**"], ["Keep Production", "Keep production"]],
    ];
    for (const [name, asked, shown] of cases) {
      const menu = card(relabel(shown));
      const calls = withArgs(open(version), (args) => {
        args.questions[0]!.options[0]!.label = asked[0];
        args.questions[0]!.options[1]!.label = asked[1];
      });
      expect(ompMarkdownPrompt(menu, calls), name).toBe(menu);
    }
    // two options told apart on the card keep their Markdown
    const apart = card(relabel(["Keep production", "Keep staging"]));
    const named = withArgs(open(version), (args) => {
      args.questions[0]!.options[0]!.label = "Keep **production**";
      args.questions[0]!.options[1]!.label = "Keep **staging**";
    });
    expect(ompMarkdownPrompt(apart, named)?.text_format).toBe("markdown");
  });

  it("closes an omp session's ask call at its result and at the next user message", () => {
    const call = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "ask", arguments: { questions: [] } }] } };
    const opened = ompAsksAfter([], call);
    expect(opened.map((ask) => ask.id)).toEqual(["a"]);
    expect(ompAsksAfter(opened, { type: "message", message: { role: "toolResult", toolCallId: "a" } })).toEqual([]);
    expect(ompAsksAfter(opened, { type: "message", message: { role: "user", content: "next" } })).toEqual([]);
    expect(ompAsksAfter(opened, { type: "custom", customType: "tool_execution_start" })).toBe(opened);
    // another tool's call, or one omp did not finish streaming, opens nothing
    expect(ompAsksAfter([], { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "b", name: "bash", arguments: {} }] } })).toEqual([]);
    expect(ompAsksAfter([], { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c", name: "ask", arguments: {}, incomplete: true }] } })).toEqual([]);
  });
});
