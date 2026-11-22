import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { ConversationPart, ConversationTurn } from "../../shared/protocol.ts";
import { ChatRowMemoryContext, type ChatRowMemory } from "../lib/chatRowState.tsx";
import { SettingsProvider } from "../lib/settings.ts";
import { Turn } from "./ChatView.tsx";

const text = (value: string): ConversationPart => ({ kind: "text", text: value });
const tool = (command: string): ConversationPart => ({ kind: "tool", name: "Bash", summary: command, input: JSON.stringify({ command }), output: "" });

type Folds = { showThinking?: boolean; expandThinking?: boolean; foldWork?: boolean; requestDetails?: boolean };

const render = (parts: ConversationPart[], state: { live: boolean; waiting?: boolean }, role: ConversationTurn["role"] = "assistant", folds: Folds = {}, memory?: ChatRowMemory): string => {
  const turn: ConversationTurn = { role, ts: "2026-01-01T12:00:00Z", end_ts: "2026-01-01T12:01:00Z", parts };
  const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    const chat = createElement(SettingsProvider, { children: createElement(Turn, {
      paneId: "w1:p1", turn, rowKey: "turn:1", live: state.live, waiting: state.waiting ?? false, showThinking: false, ...folds,
    }) });
    return renderToStaticMarkup(memory === undefined ? chat : createElement(ChatRowMemoryContext.Provider, { value: memory, children: chat }));
  } finally {
    if (languages) Object.defineProperty(navigator, "languages", languages);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

const titles = (html: string) => [...html.matchAll(/class="work-block-title">([^<]*)</g)].map((match) => match[1]);
const expanded = (html: string) => [...html.matchAll(/class="work-block-head" aria-expanded="(true|false)"/g)].map((match) => match[1] === "true");
const thoughtsOpen = (html: string) => [...html.matchAll(/class="work-row work-row-thinking"><button type="button" class="work-row-head" aria-expanded="(true|false)"/g)].map((match) => match[1] === "true");
const reasoning: ConversationPart = { kind: "thinking", text: "Weighing it." };

describe("a bash-mode command", () => {
  it("shows the command, then what it printed, and the output of a failed one as an error", () => {
    const html = render([{ kind: "shell", command: "ls missing", stdout: "", stderr: "ls: missing: No such file or directory" }], { live: false }, "user");
    expect(html).toContain('<code>ls missing</code>');
    expect(html).toContain('<pre class="chat-tool-io chat-shell-stderr">ls: missing: No such file or directory</pre>');
    expect(render([{ kind: "shell", command: "true" }], { live: false }, "user")).not.toContain("<pre");
    expect(render([{ kind: "shell", command: "true", stdout: "", stderr: "" }], { live: false }, "user")).not.toContain("<pre");
  });
});

describe("an agent turn's work blocks", () => {
  it("says Working… for a running turn that has written no work or words yet", () => {
    for (const parts of [[], [text("\n\n")]]) {
      const html = render(parts, { live: true });
      expect(html).toContain("work-block is-live is-pending");
      expect(titles(html)).toEqual(["Working…"]);
      expect(titles(render(parts, { live: false }))).toEqual([]);
    }
  });

  it("draws each run where the agent ran it, with the turn's state and duration on the last", () => {
    const parts = [text("Checking first."), tool("ls"), text("Now the loans."), tool("cat loans"), text("No book is on loan.")];
    const settled = render(parts, { live: false });
    const order = ["Checking first.", "Worked<", "Now the loans.", "Worked for 1m", "No book is on loan."].map((needle) => settled.indexOf(needle));
    expect(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!))).toBe(true);
    expect(titles(settled)).toEqual(["Worked", "Worked for 1m"]);
    expect(expanded(settled)).toEqual([false, false]);
    const live = render(parts, { live: true });
    expect(titles(live)).toEqual(["Worked", "Working…"]);
    expect(expanded(live)).toEqual([false, true]);
    expect(titles(render(parts, { live: true, waiting: true }))).toEqual(["Worked", "Needs you"]);
  });

  it("names an MCP tool's row by its server and tool, keeping its id in the title (#3875)", () => {
    const id = "mcp__claude_ai_HomeAssistant__get_entity_state";
    const part: ConversationPart = { kind: "tool", name: id, summary: "light.kitchen", input: JSON.stringify({ entity_id: "light.kitchen" }), output: "on" };
    const html = render([part], { live: true });
    expect(html).toContain('<span class="work-row-name">HomeAssistant get_entity_state</span>');
    expect(html).toContain(`title="${id} · light.kitchen"`);
    expect(html).not.toContain(`>${id}<`);
    const memory: ChatRowMemory = { toggles: new Map([["tool:0", true]]), outputs: new Map(), runs: new Map(), dormant: new Map() };
    expect(render([part], { live: true }, "assistant", {}, memory)).toContain(`<p class="work-row-tool">${id}</p>`);
  });

  it("keeps one block for tools followed by the answer", () => {
    const html = render([tool("ls"), tool("cat a"), text("Done.")], { live: false });
    expect(titles(html)).toEqual(["Worked for 1m"]);
    expect(html.indexOf("Worked for 1m")).toBeLessThan(html.indexOf("Done."));
  });
});

describe("the folds Settings → Chat starts a turn with", () => {
  const commentary = (value: string): ConversationPart => ({ kind: "text", text: value, phase: "commentary" });

  it("starts every work block folded with Collapse work on, the running one included, but one that needs you (#2228)", () => {
    const parts = [tool("ls"), tool("cat a")];
    const running = render(parts, { live: true }, "assistant", { foldWork: true });
    expect(titles(running)).toEqual(["Working…"]);
    expect(expanded(running)).toEqual([false]);
    expect(running).toContain("2 commands");
    expect(expanded(render(parts, { live: true, waiting: true }, "assistant", { foldWork: true }))).toEqual([true]);
    expect(expanded(render([...parts, commentary("Still looking.")], { live: false }, "assistant", { foldWork: true }))).toEqual([false]);
    expect(expanded(render(parts, { live: true }))).toEqual([true]);
    expect(expanded(render([...parts, commentary("Still looking.")], { live: false }))).toEqual([true]);
  });

  it("starts the agent's reasoning open with Expand thinking on, and folded otherwise (#2346)", () => {
    const parts = [reasoning, tool("ls")];
    const open = render(parts, { live: true }, "assistant", { showThinking: true, expandThinking: true });
    expect(thoughtsOpen(open)).toEqual([true]);
    expect(open).toContain("Weighing it.");
    const folded = render(parts, { live: true }, "assistant", { showThinking: true });
    expect(thoughtsOpen(folded)).toEqual([false]);
    expect(folded).not.toContain("Weighing it.");
    expect(thoughtsOpen(render(parts, { live: true }, "assistant", { expandThinking: true }))).toEqual([]);
  });
});

describe("Compaction and failed requests (#901)", () => {
  const failed = (error: string): ConversationPart => ({ kind: "text", text: `Error: ${error}`, failed: true });
  const rows = (html: string) => [...html.matchAll(/class="chat-skill(?: is-error)? chat-failed-requests"(?: open="")?><summary>.*?<span class="chat-skill-name">([^<]*)</g)].map((match) => match[1]);
  const opened = (html: string) => [...html.matchAll(/class="chat-skill(?: is-error)? chat-failed-requests"( open="")?>/g)].map((match) => match[1] !== undefined);
  const alerting = (html: string) => [...html.matchAll(/class="chat-skill( is-error)? chat-failed-requests"/g)].map((match) => match[1] !== undefined);

  it("draws each failed request as its error line while off, as before", () => {
    const html = render([failed("503 overloaded"), failed("Connection error."), text("hello")], { live: false });
    expect(rows(html)).toEqual([]);
    expect(html).toContain("Error: 503 overloaded");
    expect(html).toContain("Error: Connection error.");
  });

  it("gathers a run of failed requests into one row, saying whether another request followed", () => {
    const on = { requestDetails: true };
    const retried = render([failed("503 overloaded"), failed("Connection error."), text("hello")], { live: false }, "assistant", on);
    expect(rows(retried)).toEqual(["2 requests failed, then tried again"]);
    expect(alerting(retried)).toEqual([false]);
    expect(retried).toContain("<li>503 overloaded</li><li>Connection error.</li>");
    expect(retried).not.toContain("Error: 503");
    expect(retried).toContain("hello");
    const alone = render([failed("401 unauthorized")], { live: false }, "assistant", on);
    expect(rows(alone)).toEqual(["Request failed"]);
    expect(alerting(alone)).toEqual([true]);
    const apart = render([failed("a"), text("partial"), failed("b")], { live: false }, "assistant", on);
    expect(rows(apart)).toEqual(["Request failed, then tried again", "Request failed"]);
    expect(alerting(apart)).toEqual([false, true]);
    expect(opened(alone)).toEqual([true]);
    expect(opened(retried)).toEqual([false]);
    expect(opened(apart)).toEqual([false, true]);
    expect(opened(render([failed("401 unauthorized")], { live: true }, "assistant", on))).toEqual([false]);
  });

  it("names the token counts a compaction recorded only while on", () => {
    const card: ConversationPart = { kind: "compact", text: "folded", tokens_before: 761969, tokens_saved: 493241 };
    const summary = (html: string) => html.match(/<summary>(.*?)<\/summary>/)?.[1] ?? "";
    expect(summary(render([card], { live: false }, "user", { requestDetails: true }))).toContain("Conversation compacted · 762k tokens before · 493k tokens saved");
    expect(summary(render([card], { live: false }, "user"))).not.toContain("tokens");
    expect(summary(render([{ kind: "compact", text: "folded" }], { live: false }, "user", { requestDetails: true }))).not.toContain("tokens");
  });
});

describe("a run of todo updates, opened", () => {
  const LIST = ["Read the fixture", "Patch the parser"];
  const todo = (id: string, ops: unknown[], done: number): ConversationPart => ({
    kind: "tool", name: "todo", summary: "todo", input: JSON.stringify({ ops }), call_id: id,
    output: `Overall: ${done}/${LIST.length} done.\n  Fix:\n${LIST.map((item, index) => `    - [${index < done ? "X" : " "}] ${item}`).join("\n")}`,
  });

  it("shows each update's own input and output, not only the list it left (#1601)", () => {
    const parts = [todo("t1", [{ op: "init", list: [{ phase: "Fix", items: LIST }] }], 0), todo("t2", [{ op: "done", task: LIST[0] }], 1)];
    const memory: ChatRowMemory = { toggles: new Map([["tool:0", true], ["tool:1", true]]), outputs: new Map(), runs: new Map(), dormant: new Map() };
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    let html: string;
    try {
      html = renderToStaticMarkup(createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(SettingsProvider, { children: createElement(Turn, {
        paneId: "w1:p1", turn: { role: "assistant", ts: "2026-01-01T12:00:00Z", parts }, rowKey: "turn:1", live: true, waiting: false, showThinking: false,
      }) }) }));
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
    const attempts = html.slice(html.indexOf("work-todo-attempts"));
    expect(html).toContain("work-todo-attempts");
    expect(attempts.match(/aria-expanded="true"/g)?.length).toBe(2);
    for (const [op, done] of [["init", 0], ["done", 1]] as const) {
      expect(attempts).toContain(`&quot;op&quot;: &quot;${op}&quot;`);
      expect(attempts).toContain(`Overall: ${done}/2 done.`);
    }
  });

  it("shows a lone whole-list update opened as its list by status, a cancelled item as dropped", () => {
    // one opencode `todowrite`, as opencode 2.2.2 stored it: the list is the input, the answer only counts
    const part: ConversationPart = {
      kind: "tool", name: "todowrite", summary: "todowrite", call_id: "call_todo_1", state: "ok",
      input: JSON.stringify({ todos: [{ content: "Reproduce", status: "completed" }, { content: "Fix", status: "in_progress" }, { content: "Add a test", status: "cancelled" }] }, null, 2),
      output: "Todos updated: 1/3 completed, 1 in progress, 1 cancelled. In progress: \"Fix\"",
    };
    const memory: ChatRowMemory = { toggles: new Map([["tool:0", true]]), outputs: new Map(), runs: new Map(), dormant: new Map() };
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    let html: string;
    try {
      html = renderToStaticMarkup(createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(SettingsProvider, { children: createElement(Turn, {
        paneId: "w1:p1", turn: { role: "assistant", ts: "2026-01-01T12:00:00Z", parts: [part] }, rowKey: "turn:1", live: true, waiting: false, showThinking: false,
      }) }) }));
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
    expect([...html.matchAll(/class="todo-item is-([a-z_]+)"/g)].map((match) => match[1])).toEqual(["completed", "in_progress", "dropped"]);
  });
});

describe("an agent turn's folded work, drawn again", () => {
  const commentary = (value: string): ConversationPart => ({ kind: "text", text: value, phase: "commentary" });
  const answer = (value: string): ConversationPart => ({ kind: "text", text: value, phase: "final_answer" });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let memory: ChatRowMemory;
  let renderer: ReactTestRenderer | undefined;

  const view = (parts: ConversationPart[], folds: Folds = {}) => createElement(ChatRowMemoryContext.Provider, { value: memory, children: createElement(SettingsProvider, { children: createElement(Turn, {
    paneId: "w1:p1", turn: { role: "assistant", ts: "2026-01-01T12:00:00Z", parts }, rowKey: "turn:1", live: true, waiting: false, showThinking: false, ...folds,
  }) }) });
  const draw = async (parts: ConversationPart[], folds: Folds = {}) => {
    await act(async () => { if (renderer) renderer.update(view(parts, folds)); else renderer = create(view(parts, folds)); });
  };
  const heads = () => renderer!.root.findAll((node) => node.props.className === "work-block-head");
  const opened = () => heads().map((node) => node.props["aria-expanded"] as boolean);
  const toggle = async (index: number) => { await act(async () => { heads()[index]!.props.onClick(); }); };
  const thoughts = () => renderer!.root.findAll((node) => node.type === "div" && node.props.className === "work-row work-row-thinking").map((row) => row.findByType("button"));
  const thoughtOpened = () => thoughts().map((node) => node.props["aria-expanded"] as boolean);
  const remount = async (parts: ConversationPart[], folds: Folds = {}) => {
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await draw(parts, folds);
  };
  const nextMessage = async (parts: ConversationPart[], folds: Folds = {}) => {
    memory = { toggles: new Map(), outputs: new Map(), runs: new Map(), dormant: new Map() };
    await remount(parts, folds);
  };

  it("keeps a work block as the reader opened or closed it for its message, whatever Collapse work says", async () => {
    const fold = { foldWork: true };
    await draw([tool("ls")], fold);
    expect(opened()).toEqual([false]);
    await toggle(0);
    expect(opened()).toEqual([true]);
    await draw([tool("ls"), tool("cat a")], fold);
    expect(opened()).toEqual([true]);
    await remount([tool("ls"), tool("cat a")], fold);
    expect(opened()).toEqual([true]);
    await draw([tool("ls"), tool("cat a")]);
    await toggle(0);
    await draw([tool("ls"), tool("cat a")], fold);
    await draw([tool("ls"), tool("cat a")]);
    expect(opened()).toEqual([false]);
    await nextMessage([tool("ls")], fold);
    expect(opened()).toEqual([false]);
    await draw([tool("ls")]);
    expect(opened()).toEqual([true]);
  });

  it("keeps reasoning as the reader opened or closed it for its message, whatever Expand thinking says", async () => {
    const expand = { showThinking: true, expandThinking: true };
    await draw([reasoning, tool("ls")], expand);
    expect(thoughtOpened()).toEqual([true]);
    await act(async () => { thoughts()[0]!.props.onClick(); });
    expect(thoughtOpened()).toEqual([false]);
    await draw([reasoning, tool("ls"), tool("cat a")], expand);
    expect(thoughtOpened()).toEqual([false]);
    await remount([reasoning, tool("ls"), tool("cat a")], expand);
    expect(thoughtOpened()).toEqual([false]);
    await nextMessage([reasoning, tool("ls")], expand);
    expect(thoughtOpened()).toEqual([true]);
    await draw([reasoning, tool("ls")], { showThinking: true });
    expect(thoughtOpened()).toEqual([false]);
  });

  beforeEach(() => {
    for (const key of ["window", "document", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    descriptors.set("languages", Object.getOwnPropertyDescriptor(navigator, "languages"));
    const listeners = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "window", { configurable: true, value: { ...listeners, matchMedia: () => ({ matches: false, ...listeners }) } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { ...listeners, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    memory = { toggles: new Map(), outputs: new Map(), runs: new Map(), dormant: new Map() };
  });

  afterEach(async () => {
    if (renderer) await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      const target = key === "languages" ? navigator : globalThis;
      if (descriptor) Object.defineProperty(target, key, descriptor);
      else Reflect.deleteProperty(target, key);
    }
  });

  it("keeps a block folded when the words before its tools join it (#2063)", async () => {
    for (const [before, after] of [[text("Checking."), commentary("Checking.")], [commentary(""), commentary("Checking.")]] as const) {
      memory = { toggles: new Map(), outputs: new Map(), runs: new Map(), dormant: new Map() };
      await draw([before, tool("ls")]);
      await toggle(0);
      expect(opened()).toEqual([false]);
      await draw([after, tool("ls")]);
      expect(opened()).toEqual([false]);
      await remount([after, tool("ls")]);
      expect(opened()).toEqual([false]);
      await act(async () => { renderer!.unmount(); });
      renderer = undefined;
    }
  });

  it("keeps a block folded when it merges with reasoning the chat does not show (#2111)", async () => {
    const reasoning: ConversationPart = { kind: "thinking", text: "Weighing it." };
    await draw([reasoning, text("Checking."), tool("ls")]);
    expect(opened()).toEqual([true]);
    await toggle(0);
    expect(opened()).toEqual([false]);
    await draw([reasoning, commentary("Checking."), tool("ls")]);
    expect(opened()).toEqual([false]);
    await remount([reasoning, commentary("Checking."), tool("ls")]);
    expect(opened()).toEqual([false]);
    await draw([reasoning, answer("Checking."), tool("ls")]);
    expect(opened()).toEqual([false]);
    await remount([reasoning, answer("Checking."), tool("ls")]);
    expect(opened()).toEqual([false]);
  });

  it("keeps a block's fold while its run is hidden reasoning alone, until it draws again", async () => {
    const reasoning: ConversationPart = { kind: "thinking", text: "Weighing it." };
    await draw([commentary("Checking."), reasoning]);
    await toggle(0);
    expect(opened()).toEqual([false]);
    await draw([answer("Checking."), reasoning]);
    expect(opened()).toEqual([]);
    await draw([answer("Checking."), { ...reasoning, text: "Weighing it again." }]);
    expect(opened()).toEqual([]);
    await draw([answer("Checking."), { ...reasoning, text: "Weighing it again." }, tool("ls")]);
    expect(opened()).toEqual([false]);
    await remount([answer("Checking."), { ...reasoning, text: "Weighing it again." }, tool("ls")]);
    expect(opened()).toEqual([false]);
  });

  it("keeps a merged block's fold when a part leaves it", async () => {
    await draw([tool("ls"), text("One shelf."), commentary("Checking it.")]);
    expect(opened()).toEqual([false, true]);
    await toggle(1);
    await toggle(1);
    await draw([tool("ls"), commentary("One shelf."), commentary("Checking it.")]);
    expect(opened()).toEqual([true]);
    await toggle(0);
    expect(opened()).toEqual([false]);
    await draw([tool("ls"), commentary("One shelf."), answer("Checking it.")]);
    expect(opened()).toEqual([false]);
    await remount([tool("ls"), commentary("One shelf."), answer("Checking it.")]);
    expect(opened()).toEqual([false]);
  });
});
