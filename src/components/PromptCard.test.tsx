import { describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { InteractivePrompt } from "../../shared/protocol.ts";
import { translate } from "../lib/i18n.ts";
import * as settingsModule from "../lib/settings.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { PromptCard, type PromptCardProps } from "./PromptCard.tsx";

const goal: InteractivePrompt = {
  id: "g", agent: "claude", kind: "menu", title: "Goal active", question: "the file hello.txt exists", body: "running 25s · 0 tokens",
  options: [{ label: "Close", description: null }], multi_select: false, custom_option_index: null,
  own_text: { title: { key: "Goal active" }, labels: { 0: { key: "Close" } } },
};

const render = (prompt: InteractivePrompt, languages: string[], screenWords: string | null = null, state: Pick<PromptCardProps, "answered" | "stale" | "context"> = {}): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: languages });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(PromptCard, {
      paneId: "w1:p1", prompt, onPromptChanged: () => {}, onAnswered: () => {}, screenWords, ...state,
    }) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};

describe("a prompt card's own words", () => {
  it("associates each card with its own PC and workspace without a visible row", () => {
    for (const context of ["Claude · checkout-api · workstation", "Codex · export-guard · laptop"]) {
      const html = render(goal, ["en"], null, { context });
      const id = /aria-describedby="([^"]+)"/.exec(html)?.[1];
      expect(id).toBeDefined();
      expect(html).toContain(`<p id="${id}" class="visually-hidden">${context}</p>`);
    }
    expect(render(goal, ["en"])).not.toContain("aria-describedby=");
  });

  it("shows both translated status messages when an answered card becomes stale", () => {
    for (const language of ["en", "ko"] as const) {
      const html = render(goal, [language], null, { answered: true, stale: true });
      expect(html).toContain(translate(language, "Sending your answer…"));
      expect(html).toContain(translate(language, "Not updated: the question on screen may have changed."));
      expect(html).toContain('aria-busy="true"');
    }
  });

  it("shows the words the bridge wrote in the reader's language, and the agent's as written (#1482)", () => {
    for (const language of ["ko", "ja", "zh"] as const) {
      const html = render(goal, [language]);
      expect(html).toContain(`<h2>${translate(language, "Goal active")}</h2>`);
      expect(html).toContain(translate(language, "Close"));
      expect(html).not.toContain("<h2>Goal active</h2>");
      expect(html).toContain("the file hello.txt exists");
      expect(html).toContain("running 25s · 0 tokens");
    }
  });

  it("shows an older bridge's card, which names no words of its own, as it came", () => {
    const { own_text: _, ...older } = goal;
    expect(render(older, ["ko"])).toContain("<h2>Goal active</h2>");
  });
});

describe("Claude's words over its question, read off the screen (#2088)", () => {
  const asked: InteractivePrompt = {
    id: "q", agent: "claude", kind: "question", title: "Fix", question: "Which fix do you want?", body: null,
    options: [{ label: "Patch", description: null }, { label: "Rewrite", description: null }], multi_select: false, custom_option_index: null,
  };

  it("shows them over the question, saying where they came from in the reader's language", () => {
    const html = render(asked, ["ko"], "There are two ways to fix it.\n\nPatch adds the newline.");
    expect(html).toContain("There are two ways to fix it.\n\nPatch adds the newline.");
    expect(html).toContain(translate("ko", "From the terminal, until the agent saves this turn"));
    expect(html.indexOf("There are two ways")).toBeLessThan(html.indexOf("Which fix do you want?"));
  });

  it("shows no words and no caption without them", () => {
    expect(render(asked, ["en"])).not.toContain("prompt-card-words");
  });
});

describe("the preview Claude draws for the option under its cursor (#1212)", () => {
  const layout: InteractivePrompt = {
    id: "p", agent: "claude", kind: "question", title: "Layout", question: "Which layout?", body: null,
    options: [{ label: "Grid", description: null }, { label: "Wide", description: null }, { label: "Tall", description: null }], multi_select: false, custom_option_index: null,
  };

  it("shows it under that option, as drawn, with the rows Claude cut in the reader's language", () => {
    const html = render({ ...layout, option_preview: { option_index: 2, text: "row 1\nrow 2", hidden_lines: 31 } }, ["ko"]);
    expect(html).toContain("row 1\nrow 2");
    expect(html.indexOf("Tall")).toBeLessThan(html.indexOf("row 1"));
    expect(html.indexOf("Wide")).toBeLessThan(html.indexOf("Tall"));
    expect(html).toContain(translate("ko", "{n} more lines Claude left out", { n: 31 }));
  });

  it("shows it on a multiple choice too", () => {
    const html = render({ ...layout, multi_select: true, option_preview: { option_index: 1, text: "wide wide" } }, ["en"]);
    expect(html).toContain("wide wide");
    expect(html.indexOf("Wide")).toBeLessThan(html.indexOf("wide wide"));
    expect(html.indexOf("wide wide")).toBeLessThan(html.indexOf("Tall"));
  });

  it("shows no preview without one, and no cut note for a whole one", () => {
    expect(render(layout, ["en"])).not.toContain("prompt-card-option-preview");
    expect(render({ ...layout, option_preview: { option_index: 0, text: "+--+" } }, ["en"])).not.toContain("more lines Claude left out");
  });
});

describe("an omp Ask card in the agent's own Markdown (#1644)", () => {
  const ask: InteractivePrompt = {
    id: "a", agent: "omp", kind: "question", title: "Question", body: null, text_format: "markdown",
    question: "Which **route** carries it? See [the guide](https://example.com/guide).",
    options: [{ label: "Use `local` socket", description: "Goes through [the relay](https://example.com/relay)." }],
    multi_select: false, custom_option_index: 1,
  };

  it("draws the question and options as Markdown, with links only in the question", () => {
    const html = render(ask, ["en"]);
    expect(html).toContain("<strong><span>route</span></strong>");
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).toContain("<code>local</code>");
    expect(html).not.toContain("https://example.com/relay");
    expect(html).toContain("the relay");
  });

  it("draws an option's Markdown whole, never reading a link to `recommended` as the Recommended tag (#2220 review)", () => {
    const twins: InteractivePrompt = { ...ask, options: [{ label: "Keep [production](recommended)", description: null }, { label: "Keep [production]", description: null }], custom_option_index: 2 };
    const html = render(twins, ["en"]);
    const labels = [...html.matchAll(/<span class="prompt-card-option-label">(.*?)<\/span><\/span>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ""));
    expect(labels).toEqual(["Keep production", "Keep [production]"]);
    expect(html).not.toContain("prompt-card-tag");
  });

  it("draws a card read off the screen as plain text", () => {
    const { text_format: _, ...plain } = ask;
    const html = render(plain, ["en"]);
    expect(html).toContain("Which **route** carries it?");
    expect(html).toContain("Use `local` socket");
  });
});

describe("a form whose questions the agent's own keys move between", () => {
  const form: InteractivePrompt = {
    id: "f", agent: "omo", kind: "question", title: "Question 1 of 3", question: "Which color do you prefer?", body: null,
    options: [{ label: "Red", description: null }, { label: "Blue", description: null }], multi_select: false, custom_option_index: 2,
    steps: [{ label: "Color", answered: false, current: true }, { label: "Size", answered: false, current: false, can_navigate: true }, { label: "Shape", answered: false, current: false, can_navigate: true }],
    can_step_next: true,
  };

  it("offers Next, and each other question as a step to tap, unanswered as they are", () => {
    for (const language of ["en", "ko"] as const) {
      const html = render(form, [language]);
      expect(html).toContain('class="btn btn-ghost prompt-card-next"');
      expect(html).toContain(translate(language, "Next"));
      expect([...html.matchAll(/class="prompt-card-step-button"/g)]).toHaveLength(2);
      expect(html).not.toContain("prompt-card-back");
    }
  });

  it("offers no answered step the form itself does not mark as one to go to (Hermes past an answer)", () => {
    const hermes: InteractivePrompt = { ...form, agent: "hermes", can_step_back: true, can_step_next: false,
      steps: [{ label: "Colour", answered: true, current: false }, { label: "Size", answered: false, current: false, can_navigate: true }, { label: "Shape", answered: false, current: true }] };
    expect([...render(hermes, ["en"]).matchAll(/class="prompt-card-step-button"/g)]).toHaveLength(1);
  });

  it("has no Next where the card cannot go on", () => {
    const { can_step_next: _, ...last } = form;
    expect(render(last, ["en"])).not.toContain("prompt-card-next");
  });
});

describe("a question's typed answer survives a page reload (G-008)", () => {
  const asked: InteractivePrompt = {
    id: "g008", agent: "codex", kind: "question", title: "저장소 선택", question: "멱등성 키를 어디에 저장할까요?", body: null,
    options: [{ label: "Postgres", description: null }, { label: "직접 입력", description: null }], multi_select: false, custom_option_index: 1,
  };

  it("hands the typed text to its owner, keeps no store of its own, and shows the owner's text again after a reload", async () => {
    const settingsSpy = spyOn(settingsModule, "useSettings").mockReturnValue({
      settings: settingsModule.DEFAULT_SETTINGS,
      resolvedLanguage: "ko",
    } as ReturnType<typeof settingsModule.useSettings>);
    const session = new Map<string, string>();
    const local = new Map<string, string>();
    const storage = (store: Map<string, string>) => ({ getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } });
    const listen = { addEventListener() {}, removeEventListener() {} };
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const savedAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { ...listen, matchMedia: () => ({ matches: false, ...listen }), sessionStorage: storage(session), localStorage: storage(local) } });
    let owned: string | undefined;
    const card = (initialText?: string) => createElement(PromptCard, {
      paneId: "w1:p1", prompt: asked, onPromptChanged: () => {}, onAnswered: () => {}, onTextChange: (text) => { owned = text; }, ...(initialText === undefined ? {} : { initialText }),
    });
    const field = (renderer: ReactTestRenderer) => renderer.root.find((node) => node.type === "input");
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => { renderer = create(card()); });
      await act(async () => { field(renderer!).props.onChange({ currentTarget: { value: "이 질문의 답변 초안 보존 시험" } }); });
      expect(owned).toBe("이 질문의 답변 초안 보존 시험");
      expect([...session.keys(), ...local.keys()].filter((key) => key.startsWith("ovis:prompt-draft:"))).toEqual([]);

      await act(async () => { renderer!.unmount(); });
      await act(async () => { renderer = create(card(owned)); });
      expect(field(renderer!).props.value).toBe("이 질문의 답변 초안 보존 시험");
    } finally {
      await act(async () => { renderer?.unmount(); });
      settingsSpy.mockRestore();
      if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
      if (savedAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", savedAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    }
  });
});
