import { describe, expect, it, spyOn } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import * as machineContext from "../lib/machineContext.tsx";
import * as settingsModule from "../lib/settings.ts";
import { PromptCard, type PromptCardProps } from "./PromptCard.tsx";

describe("a pending answer sends once, keeps its place, and offers Retry on failure (IS-056)", () => {
  const approval: InteractivePrompt = {
    id: "demo-approval", agent: "codex", kind: "approval", title: "Allow command?", question: "Allow command?",
    body: "git push origin feat/export-guard",
    options: [
      { label: "Yes", description: null },
      { label: "Yes, and don't ask again for git push", description: null },
      { label: "No, and tell Codex what to do differently", description: null },
    ],
    multi_select: false, custom_option_index: null,
  };

  it("sends one request for ten rapid clicks, keeps the status line in the header without adding a row at rest, and retries after a 500", async () => {
    const sent: PromptAnswer[] = [];
    let settle: ((error?: unknown) => void) | null = null;
    const answerSpy = spyOn(machineContext, "useMachineApi").mockReturnValue({
      answerPanePrompt: (answer: PromptAnswer) => {
        sent.push(answer);
        return new Promise<void>((resolve, reject) => {
          settle = (error) => { if (error !== undefined) reject(error); else resolve(); };
        });
      },
    } as ReturnType<typeof machineContext.useMachineApi>);
    const settingsSpy = spyOn(settingsModule, "useSettings").mockReturnValue({
      settings: settingsModule.DEFAULT_SETTINGS,
      resolvedLanguage: "en",
    } as ReturnType<typeof settingsModule.useSettings>);
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const savedDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
    const savedAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
    const listen = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { ...listen, matchMedia: () => ({ matches: false, ...listen }) } });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { activeElement: null, body: {} } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    let renderer: ReactTestRenderer | undefined;
    const answered: boolean[] = [];
    try {
      await act(async () => {
        renderer = create(createElement(PromptCard, {
          paneId: "w1D:p1", prompt: approval, onPromptChanged: () => {}, onAnswered: (toBox) => { answered.push(toBox); },
        }));
      });
      const options = () => renderer!.root.findAll((node) => node.type === "button" && typeof node.props.className === "string" && node.props.className.startsWith("prompt-card-option"));
      const header = renderer!.root.find((node) => node.type === "header" && node.props.className === "prompt-card-header");
      const status = () => header.findByProps({ role: "status" });
      expect(status().props.className).toBe("prompt-card-status is-empty");
      expect(options().map((opt) => opt.props.disabled)).toEqual([false, false, false]);

      const first = options()[0]!;
      await act(async () => {
        for (let i = 0; i < 10; i++) first.props.onClick({ nativeEvent: {}, currentTarget: {} });
      });
      expect(sent).toEqual([{ pane_id: "w1D:p1", prompt_id: "demo-approval", option_index: 0 }]);
      expect(options().map((opt) => opt.props.disabled)).toEqual([true, true, true]);
      expect(status().props.className).toBe("prompt-card-status");
      expect(status().children).toContain("Sending your answer…");

      await act(async () => { settle!(new ApiError("herdr said no", 500, "internal_error", "internal_error")); });
      expect(options().map((opt) => opt.props.disabled)).toEqual([false, false, false]);
      const retry = renderer!.root.find((node) => node.type === "button" && typeof node.props.className === "string" && node.props.className.includes("prompt-card-retry"));
      expect(retry.children).toEqual(["Retry"]);

      await act(async () => { retry.props.onClick({ nativeEvent: {}, currentTarget: {} }); });
      expect(sent).toEqual([
        { pane_id: "w1D:p1", prompt_id: "demo-approval", option_index: 0 },
        { pane_id: "w1D:p1", prompt_id: "demo-approval", option_index: 0 },
      ]);
      await act(async () => { settle!(); });
      expect(answered).toHaveLength(1);
    } finally {
      await act(async () => { renderer?.unmount(); });
      settingsSpy.mockRestore();
      answerSpy.mockRestore();
      if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
      if (savedDoc) Object.defineProperty(globalThis, "document", savedDoc); else Reflect.deleteProperty(globalThis, "document");
      if (savedAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", savedAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages); else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it("after a failed typed answer is edited, never sends the old text: Retry goes and Send takes what the field shows", async () => {
    const freeForm: InteractivePrompt = {
      id: "demo-free", agent: "claude", kind: "question", title: "Which name?", question: "Which name?", body: null,
      options: [{ label: "Type something", description: null }],
      multi_select: false, custom_option_index: 0,
    };
    const sent: PromptAnswer[] = [];
    let settle: ((error?: unknown) => void) | null = null;
    const answerSpy = spyOn(machineContext, "useMachineApi").mockReturnValue({
      answerPanePrompt: (answer: PromptAnswer) => {
        sent.push(answer);
        return new Promise<void>((resolve, reject) => {
          settle = (error) => { if (error !== undefined) reject(error); else resolve(); };
        });
      },
    } as ReturnType<typeof machineContext.useMachineApi>);
    const settingsSpy = spyOn(settingsModule, "useSettings").mockReturnValue({
      settings: settingsModule.DEFAULT_SETTINGS,
      resolvedLanguage: "en",
    } as ReturnType<typeof settingsModule.useSettings>);
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const savedDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
    const savedAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
    const listen = { addEventListener() {}, removeEventListener() {} };
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { ...listen, matchMedia: () => ({ matches: false, ...listen }) } });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { activeElement: null, body: {} } });
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(PromptCard, { paneId: "w1D:p1", prompt: freeForm, onPromptChanged: () => {}, onAnswered: () => {} }));
      });
      const field = () => renderer!.root.find((node) => node.type === "input");
      const type = async (value: string) => { await act(async () => { field().props.onChange({ currentTarget: { value } }); }); };
      const send = () => renderer!.root.find((node) => node.type === "button" && Array.isArray(node.children) && node.children.includes("Send"));
      const retries = () => renderer!.root.findAll((node) => node.type === "button" && typeof node.props.className === "string" && node.props.className.includes("prompt-card-retry"));

      await type("first");
      await act(async () => { send().props.onClick({ nativeEvent: {}, currentTarget: {} }); });
      await act(async () => { settle!(new ApiError("herdr said no", 500, "internal_error", "internal_error")); });
      expect(retries()).toHaveLength(1);

      await type("second");
      for (const retry of retries()) await act(async () => { retry.props.onClick({ nativeEvent: {}, currentTarget: {} }); });
      expect(sent.map((answer) => answer.custom_text)).toEqual(["first"]);
      expect(renderer!.root.findAll((node) => node.props.role === "alert")).toHaveLength(1);

      await act(async () => { send().props.onClick({ nativeEvent: {}, currentTarget: {} }); });
      expect(sent.map((answer) => answer.custom_text)).toEqual(["first", "second"]);
      await act(async () => { settle!(); });
    } finally {
      await act(async () => { renderer?.unmount(); });
      settingsSpy.mockRestore();
      answerSpy.mockRestore();
      if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
      if (savedDoc) Object.defineProperty(globalThis, "document", savedDoc); else Reflect.deleteProperty(globalThis, "document");
      if (savedAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", savedAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
      if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages); else Reflect.deleteProperty(navigator, "languages");
    }
  });
});

async function withFailingCard(prompt: InteractivePrompt, run: (card: { sent: PromptAnswer[]; root: () => ReactTestRenderer["root"]; settle: (error?: unknown) => Promise<void>; update: (next: Partial<PromptCardProps>) => Promise<void> }) => Promise<void>, props: Partial<PromptCardProps> = {}): Promise<void> {
  const sent: PromptAnswer[] = [];
  let pending: ((error?: unknown) => void) | null = null;
  const answerSpy = spyOn(machineContext, "useMachineApi").mockReturnValue({
    answerPanePrompt: (answer: PromptAnswer) => {
      sent.push(answer);
      return new Promise<void>((resolve, reject) => { pending = (error) => { if (error !== undefined) reject(error); else resolve(); }; });
    },
  } as ReturnType<typeof machineContext.useMachineApi>);
  const settingsSpy = spyOn(settingsModule, "useSettings").mockReturnValue({
    settings: settingsModule.DEFAULT_SETTINGS,
    resolvedLanguage: "en",
  } as ReturnType<typeof settingsModule.useSettings>);
  const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const savedDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
  const savedAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  const savedLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");
  const listen = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { ...listen, matchMedia: () => ({ matches: false, ...listen }) } });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: { activeElement: null, body: {} } });
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      renderer = create(createElement(PromptCard, { paneId: "w1D:p1", prompt, onPromptChanged: () => {}, onAnswered: () => {}, ...props }));
    });
    const update = (next: Partial<PromptCardProps>) => act(async () => { renderer!.update(createElement(PromptCard, { paneId: "w1D:p1", prompt, onPromptChanged: () => {}, onAnswered: () => {}, ...props, ...next })); });
    await run({ sent, root: () => renderer!.root, settle: (error) => act(async () => { pending!(error); }), update });
  } finally {
    await act(async () => { renderer?.unmount(); });
    settingsSpy.mockRestore();
    answerSpy.mockRestore();
    if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow); else Reflect.deleteProperty(globalThis, "window");
    if (savedDoc) Object.defineProperty(globalThis, "document", savedDoc); else Reflect.deleteProperty(globalThis, "document");
    if (savedAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", savedAct); else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    if (savedLanguages) Object.defineProperty(navigator, "languages", savedLanguages); else Reflect.deleteProperty(navigator, "languages");
  }
}

describe("a failed answer's Retry never sends a selection the user has since changed", () => {
  const click = { nativeEvent: {}, currentTarget: {} };
  const buttonWith = (root: ReactTestRenderer["root"], className: string) => root.findAll((node) => node.type === "button" && typeof node.props.className === "string" && node.props.className.includes(className));
  const checkboxes = (root: ReactTestRenderer["root"]) => root.findAll((node) => node.type === "input" && node.props.type === "checkbox");
  const options = [{ label: "A", description: null }, { label: "B", description: null }, { label: "C", description: null }];

  it("Claude-style multi-select: A submitted and failed, then switched to B, sends B", async () => {
    const prompt: InteractivePrompt = { id: "multi", agent: "claude", kind: "question", title: "Pick", question: "Pick", body: null, options, multi_select: true, custom_option_index: null };
    await withFailingCard(prompt, async ({ sent, root, settle }) => {
      await act(async () => { checkboxes(root())[0]!.props.onChange(); });
      await act(async () => { buttonWith(root(), "prompt-card-submit")[0]!.props.onClick(click); });
      await settle(new ApiError("herdr said no", 500, "internal_error", "internal_error"));
      expect(buttonWith(root(), "prompt-card-retry")).toHaveLength(1);

      await act(async () => { checkboxes(root())[0]!.props.onChange(); });
      await act(async () => { checkboxes(root())[1]!.props.onChange(); });
      for (const retry of buttonWith(root(), "prompt-card-retry")) await act(async () => { retry.props.onClick(click); });
      await act(async () => { buttonWith(root(), "prompt-card-submit")[0]!.props.onClick(click); });
      expect(sent.map((answer) => answer.option_indices)).toEqual([[0], [1]]);
      await settle();
    });
  });

  it("pi-ask multi-select: a failed Next with A, then switched to B, carries B", async () => {
    const prompt: InteractivePrompt = {
      id: "pi-multi", agent: "pi", kind: "question", title: "Pick", question: "Pick", body: null, options, multi_select: true, custom_option_index: null,
      checks_with_text: true, drafts_saved: true, can_step_next: true,
    };
    await withFailingCard(prompt, async ({ sent, root, settle }) => {
      await act(async () => { checkboxes(root())[0]!.props.onChange(); });
      await act(async () => { buttonWith(root(), "prompt-card-next")[0]!.props.onClick(click); });
      await settle(new ApiError("herdr said no", 500, "internal_error", "internal_error"));
      expect(buttonWith(root(), "prompt-card-retry")).toHaveLength(1);

      await act(async () => { checkboxes(root())[0]!.props.onChange(); });
      await act(async () => { checkboxes(root())[1]!.props.onChange(); });
      for (const retry of buttonWith(root(), "prompt-card-retry")) await act(async () => { retry.props.onClick(click); });
      await act(async () => { buttonWith(root(), "prompt-card-next")[0]!.props.onClick(click); });
      expect(sent.map((answer) => [answer.step_next, answer.draft?.option_indices])).toEqual([[true, [0]], [true, [1]]]);
      await settle();
    });
  });
});

describe("a device that may only watch sees the card's answers as unavailable and sends none", () => {
  const click = { nativeEvent: {}, currentTarget: {} };
  const REASON = "This device can only watch.";
  const prompts: InteractivePrompt[] = [
    {
      id: "watch-approval", agent: "codex", kind: "approval", title: "Allow command?", question: "Allow command?", body: "git push origin feat/export-guard",
      options: [{ label: "Yes", description: null }, { label: "No, and tell Codex what to do differently", description: null }],
      multi_select: false, custom_option_index: null,
    },
    {
      id: "watch-form", agent: "pi", kind: "question", title: "Pick", question: "Pick", body: null,
      options: [{ label: "A", description: null }, { label: "B", description: null }, { label: "Type something", description: null }],
      multi_select: true, custom_option_index: 2, checks_with_text: true, can_step_next: true, optional: true,
    },
  ];

  it.each(prompts.map((prompt) => [prompt.id, prompt] as const))("%s", async (_id, prompt) => {
    await withFailingCard(prompt, async ({ sent, root }) => {
      const controls = root().findAll((node) => (node.type === "button" || node.type === "input") && node.props.className !== "prompt-card-fold");
      expect(controls.length).toBeGreaterThan(1);
      expect(controls.filter((node) => node.props.disabled !== true).map((node) => node.props.className)).toEqual([]);
      const reason = root().find((node) => node.type === "p" && node.children.includes(REASON));
      expect(reason.props.id).toBeTruthy();
      const answers = controls.filter((node) => node.type === "button");
      expect(answers.map((node) => node.props.title)).toEqual(answers.map(() => REASON));
      expect(answers.filter((node) => !String(node.props["aria-describedby"]).split(" ").includes(reason.props.id))).toEqual([]);
      // folding the card is the device's own and stays
      expect(root().find((node) => node.props.className === "prompt-card-fold").props.disabled).toBe(false);
      // a press that reaches a button anyway sends nothing
      for (const button of answers) await act(async () => { button.props.onClick(click); });
      expect(sent).toEqual([]);
    }, { watching: true });
  });

  it("takes the device's permission as it is now: answers come back when it may drive again, and go when it may only watch", async () => {
    await withFailingCard(prompts[0]!, async ({ sent, root, update }) => {
      const option = () => root().findAll((node) => node.type === "button" && String(node.props.className).startsWith("prompt-card-option"))[0]!;
      const reasons = () => root().findAll((node) => node.type === "p" && node.children.includes(REASON));
      expect([option().props.disabled, reasons().length]).toEqual([true, 1]);
      await update({ watching: false });
      expect([option().props.disabled, option().props.title, reasons().length]).toEqual([false, undefined, 0]);
      await update({ watching: true });
      expect([option().props.disabled, reasons().length]).toEqual([true, 1]);
      await update({ watching: false });
      await act(async () => { option().props.onClick(click); });
      expect(sent.map((answer) => answer.option_index)).toEqual([0]);
    }, { watching: true });
  });
});
