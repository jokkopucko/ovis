import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, reactProps, type Page } from "../lib/page.fixture.ts";

import type { InteractivePrompt, PromptAnswer } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import * as machineContext from "../lib/machineContext.tsx";
import * as settingsModule from "../lib/settings.ts";
import { PromptCard, type PromptCardProps } from "./PromptCard.tsx";

let page: Page;
beforeEach(() => { page = openPage(); });
afterEach(async () => { await page.close(); });

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
    const answered: boolean[] = [];
    try {
      await page.render(createElement(PromptCard, {
          paneId: "w1D:p1", prompt: approval, onPromptChanged: () => {}, onAnswered: (toBox) => { answered.push(toBox); },
        }));
      const options = () => [...page.container.querySelectorAll<HTMLButtonElement>('button[class^="prompt-card-option"]')];
      const status = () => page.one('header[class="prompt-card-header"] [role="status"]');
      expect(status().className).toBe("prompt-card-status is-empty");
      expect(options().map((opt) => opt.disabled)).toEqual([false, false, false]);

      const first = options()[0]!;
      await act(async () => {
        for (let i = 0; i < 10; i++) first.click();
      });
      expect(sent).toEqual([{ pane_id: "w1D:p1", prompt_id: "demo-approval", option_index: 0 }]);
      expect(options().map((opt) => opt.disabled)).toEqual([true, true, true]);
      expect(status().className).toBe("prompt-card-status");
      expect(status().textContent).toContain("Sending your answer…");

      await act(async () => { settle!(new ApiError("herdr said no", 500, "internal_error", "internal_error")); });
      expect(options().map((opt) => opt.disabled)).toEqual([false, false, false]);
      const retry = page.one("button.prompt-card-retry");
      expect(retry.textContent).toBe("Retry");

      await act(async () => { retry.click(); });
      expect(sent).toEqual([
        { pane_id: "w1D:p1", prompt_id: "demo-approval", option_index: 0 },
        { pane_id: "w1D:p1", prompt_id: "demo-approval", option_index: 0 },
      ]);
      await act(async () => { settle!(); });
      expect(answered).toHaveLength(1);
    } finally {
      await page.render(null);
      settingsSpy.mockRestore();
      answerSpy.mockRestore();
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
    try {
      await page.render(createElement(PromptCard, { paneId: "w1D:p1", prompt: freeForm, onPromptChanged: () => {}, onAnswered: () => {} }));
      const field = () => page.one<HTMLInputElement>("input");
      const type = (value: string) => page.type(field(), value);
      const send = () => {
        const buttons = [...page.container.querySelectorAll("button")].filter((node) => node.textContent?.trim() === "Send");
        if (buttons.length !== 1) throw new Error("Expected one Send button");
        return buttons[0]!;
      };
      const retries = () => page.container.querySelectorAll<HTMLButtonElement>("button.prompt-card-retry");

      await type("first");
      await act(async () => { send().click(); });
      await act(async () => { settle!(new ApiError("herdr said no", 500, "internal_error", "internal_error")); });
      expect(retries()).toHaveLength(1);

      await type("second");
      for (const retry of retries()) await act(async () => { retry.click(); });
      expect(sent.map((answer) => answer.custom_text)).toEqual(["first"]);
      expect(page.container.querySelectorAll('[role="alert"]')).toHaveLength(1);

      await act(async () => { send().click(); });
      expect(sent.map((answer) => answer.custom_text)).toEqual(["first", "second"]);
      await act(async () => { settle!(); });
    } finally {
      await page.render(null);
      settingsSpy.mockRestore();
      answerSpy.mockRestore();
    }
  });
});

async function withFailingCard(prompt: InteractivePrompt, run: (card: { sent: PromptAnswer[]; root: () => HTMLElement; settle: (error?: unknown) => Promise<void>; update: (next: Partial<PromptCardProps>) => Promise<void> }) => Promise<void>, props: Partial<PromptCardProps> = {}): Promise<void> {
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
  try {
    await page.render(createElement(PromptCard, { paneId: "w1D:p1", prompt, onPromptChanged: () => {}, onAnswered: () => {}, ...props }));
    const update = (next: Partial<PromptCardProps>) => page.render(createElement(PromptCard, { paneId: "w1D:p1", prompt, onPromptChanged: () => {}, onAnswered: () => {}, ...props, ...next }));
    await run({ sent, root: () => page.container, settle: (error) => act(async () => { pending!(error); }), update });
  } finally {
    await page.render(null);
    settingsSpy.mockRestore();
    answerSpy.mockRestore();
  }
}

describe("a failed answer's Retry never sends a selection the user has since changed", () => {
  const buttonWith = (root: HTMLElement, className: string) => root.querySelectorAll<HTMLButtonElement>(`button.${className}`);
  const checkboxes = (root: HTMLElement) => root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
  const options = [{ label: "A", description: null }, { label: "B", description: null }, { label: "C", description: null }];

  it("Claude-style multi-select: A submitted and failed, then switched to B, sends B", async () => {
    const prompt: InteractivePrompt = { id: "multi", agent: "claude", kind: "question", title: "Pick", question: "Pick", body: null, options, multi_select: true, custom_option_index: null };
    await withFailingCard(prompt, async ({ sent, root, settle }) => {
      await act(async () => { checkboxes(root())[0]!.click(); });
      await act(async () => { buttonWith(root(), "prompt-card-submit")[0]!.click(); });
      await settle(new ApiError("herdr said no", 500, "internal_error", "internal_error"));
      expect(buttonWith(root(), "prompt-card-retry")).toHaveLength(1);

      await act(async () => { checkboxes(root())[0]!.click(); });
      await act(async () => { checkboxes(root())[1]!.click(); });
      for (const retry of buttonWith(root(), "prompt-card-retry")) await act(async () => { retry.click(); });
      await act(async () => { buttonWith(root(), "prompt-card-submit")[0]!.click(); });
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
      await act(async () => { checkboxes(root())[0]!.click(); });
      await act(async () => { buttonWith(root(), "prompt-card-next")[0]!.click(); });
      await settle(new ApiError("herdr said no", 500, "internal_error", "internal_error"));
      expect(buttonWith(root(), "prompt-card-retry")).toHaveLength(1);

      await act(async () => { checkboxes(root())[0]!.click(); });
      await act(async () => { checkboxes(root())[1]!.click(); });
      for (const retry of buttonWith(root(), "prompt-card-retry")) await act(async () => { retry.click(); });
      await act(async () => { buttonWith(root(), "prompt-card-next")[0]!.click(); });
      expect(sent.map((answer) => [answer.step_next, answer.draft?.option_indices])).toEqual([[true, [0]], [true, [1]]]);
      await settle();
    });
  });
});

describe("a device that may only watch sees the card's answers as unavailable and sends none", () => {
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
      const controls = [...root().querySelectorAll<HTMLButtonElement | HTMLInputElement>('button:not([class="prompt-card-fold"]), input:not([class="prompt-card-fold"])')];
      expect(controls.length).toBeGreaterThan(1);
      expect(controls.filter((node) => !node.disabled).map((node) => node.className)).toEqual([]);
      const reason = page.one("p.prompt-card-hint[id]");
      expect(reason.textContent === REASON && reason.id).toBeTruthy();
      const answers = controls.filter((node) => node.tagName === "BUTTON");
      expect(answers.map((node) => node.title)).toEqual(answers.map(() => REASON));
      expect(answers.filter((node) => !String(node.getAttribute("aria-describedby")).split(" ").includes(reason.id))).toEqual([]);
      // folding the card is the device's own and stays
      expect(page.one<HTMLButtonElement>('[class="prompt-card-fold"]').disabled).toBe(false);
      // Even dispatching a click event on the disabled buttons sends nothing.
      for (const button of answers) await act(async () => {
        button.dispatchEvent(new page.window.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as MouseEvent);
      });
      expect(sent).toEqual([]);
      // React drops those clicks before the handler runs; exercise its guard separately.
      for (const button of answers) await act(async () => {
        const { onClick } = reactProps(button);
        if (typeof onClick !== "function") throw new TypeError("Missing answer handler");
        onClick({ nativeEvent: new page.window.MouseEvent("click"), currentTarget: button });
      });
      expect(sent).toEqual([]);
    }, { watching: true });
  });

  it("takes the device's permission as it is now: answers come back when it may drive again, and go when it may only watch", async () => {
    await withFailingCard(prompts[0]!, async ({ sent, root, update }) => {
      const option = () => root().querySelectorAll<HTMLButtonElement>('button[class^="prompt-card-option"]')[0]!;
      const reasons = () => [...root().querySelectorAll("p")].filter((node) => node.textContent === REASON);
      expect([option().disabled, reasons().length]).toEqual([true, 1]);
      await update({ watching: false });
      expect([option().disabled, option().getAttribute("title"), reasons().length]).toEqual([false, null, 0]);
      await update({ watching: true });
      expect([option().disabled, reasons().length]).toEqual([true, 1]);
      await update({ watching: false });
      await act(async () => { option().click(); });
      expect(sent.map((answer) => answer.option_index)).toEqual([0]);
    }, { watching: true });
  });
});
