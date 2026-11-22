import { expect, it } from "bun:test";

import { CLAUDE_EFFORTS, CODEX_EFFORTS, firstPromptDelivery, launchAgent, launchArgs, launchCapabilities, launchChoiceFault, launchDefaults, modelDraftAfterSync, modelSuggestions } from "./agentLaunchMode.ts";

const plain = { claudeLaunchMode: "default", codexLaunchMode: "default" } as const;

it("adds nothing while both modes follow the agent's own configuration", () => {
  expect(launchArgs("claude", plain)).toBeUndefined();
  expect(launchArgs("codex", plain)).toBeUndefined();
  expect(launchAgent("claude", plain)).toEqual({ kind: "claude" });
});

it("starts Claude Code with its permission mode", () => {
  expect(launchArgs("claude", { ...plain, claudeLaunchMode: "plan" })).toEqual(["--permission-mode", "plan"]);
  expect(launchAgent("claude", { ...plain, claudeLaunchMode: "bypassPermissions" })).toEqual({ kind: "claude", args: ["--permission-mode", "bypassPermissions"] });
});

it("starts Codex with a sandbox and an approval policy together", () => {
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "readOnly" })).toEqual(["--sandbox", "read-only", "--ask-for-approval", "on-request"]);
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "auto" })).toEqual(["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]);
  expect(launchArgs("codex", { ...plain, codexLaunchMode: "fullAccess" })).toEqual(["--sandbox", "danger-full-access", "--ask-for-approval", "never"]);
});

it("leaves other agents and a plain shell alone", () => {
  const set = { claudeLaunchMode: "plan", codexLaunchMode: "fullAccess" } as const;
  expect(launchArgs("omp", set)).toBeUndefined();
  expect(launchAgent("copilot", set, { prompt: "Fix it" })).toEqual({ kind: "copilot" });
  expect(firstPromptDelivery("copilot", "Fix it")).toBe("pending");
  expect(launchAgent("gemini", set)).toEqual({ kind: "gemini" });
  expect(launchAgent("", set)).toBeNull();
});

it("names a model and an effort for the agents whose CLI documents them, and a positional prompt only where the separator makes it safe", () => {
  // Claude Code's parser runs a subcommand named by the first operand even after `--` (claude -- update ran the updater)
  expect(launchCapabilities("claude")).toEqual({ model: true, efforts: CLAUDE_EFFORTS, ultracode: true, positionalPrompt: false });
  // clap takes everything after `--` as the PROMPT positional (codex -- logout started the TUI)
  expect(launchCapabilities("codex")).toEqual({ model: true, efforts: CODEX_EFFORTS, ultracode: false, positionalPrompt: true });
  // Letta Code takes a prompt only with `-p`, its headless mode (letta-code 0.34.23, src/cli/args.ts)
  for (const kind of ["omp", "pi", "gemini", "opencode", "letta", ""]) expect(launchCapabilities(kind)).toEqual({ model: false, efforts: [], ultracode: false, positionalPrompt: false });
  expect(modelSuggestions("claude")).toEqual(["sonnet", "opus", "haiku"]);
  expect(modelSuggestions("codex")).toEqual([]);
});

it("puts the model, the effort and then the prompt after the mode, each in the agent's own syntax", () => {
  expect(launchArgs("claude", { ...plain, claudeLaunchMode: "plan" }, { model: "opus", effort: "high", prompt: "Fix the flaky test" }))
    .toEqual(["--permission-mode", "plan", "--model", "opus", "--effort", "high"]);
  expect(launchArgs("codex", plain, { model: "gpt-5-codex", effort: "xhigh", prompt: " Review the branch " }))
    .toEqual(["--model", "gpt-5-codex", "-c", "model_reasoning_effort=xhigh", "--", "Review the branch"]);
  expect(launchAgent("codex", plain, { prompt: "$review-pr" })).toEqual({ kind: "codex", args: ["--", "$review-pr"] });
  for (const prompt of ["logout", "update", "--help", "-p x"]) expect(launchArgs("codex", plain, { prompt })).toEqual(["--", prompt]);
  expect(launchArgs("codex", plain, { model: "  ", effort: "", prompt: "" })).toBeUndefined();
  // DeepSeek Harness: an effort only (the bridge saves it for dsh-tui, which has no such flag), never a model
  expect(launchArgs("dsh-tui", plain, { model: "dsh-deepseek-flash", effort: "off", prompt: "hi" })).toEqual(["--effort", "off"]);
  expect(launchChoiceFault("dsh-tui", { effort: "medium" })).toBe("effort");
});

it("offers Claude Code's five effort levels, with Ultracode a switch of its own rather than a level", () => {
  expect(CLAUDE_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(launchCapabilities("claude").efforts).not.toContain("ultracode");
  expect(launchChoiceFault("claude", { effort: "ultracode" })).toBe("effort");
});

it("turns Ultracode on with one inline --settings object after the effort it keeps, and adds nothing while it is off", () => {
  const on = ["--settings", "{\"ultracode\":true}"];
  expect(launchArgs("claude", plain, { effort: "medium", ultracode: true })).toEqual(["--effort", "medium", ...on]);
  expect(launchArgs("claude", plain, { ultracode: true })).toEqual(on);
  expect(launchArgs("claude", { ...plain, claudeLaunchMode: "plan" }, { model: "opus", effort: "medium", ultracode: true, prompt: "Fix it" }))
    .toEqual(["--permission-mode", "plan", "--model", "opus", "--effort", "medium", ...on]);
  expect(launchAgent("claude", plain, { ultracode: true })).toEqual({ kind: "claude", args: on });
  expect(launchArgs("claude", plain, { effort: "high", ultracode: false })).toEqual(["--effort", "high"]);
  expect(launchArgs("claude", plain, { ultracode: false })).toBeUndefined();
  expect(launchChoiceFault("claude", { model: "opus", effort: "max", ultracode: true })).toBeNull();
});

it("refuses Ultracode for every agent but Claude Code, and never passes it there", () => {
  expect(launchChoiceFault("codex", { ultracode: true })).toBe("ultracode");
  expect(launchChoiceFault("omp", { ultracode: true })).toBe("ultracode");
  expect(launchChoiceFault("", { ultracode: true })).toBe("ultracode");
  expect(launchChoiceFault("codex", { ultracode: false })).toBeNull();
  expect(launchArgs("codex", plain, { effort: "high", ultracode: true })).toEqual(["-c", "model_reasoning_effort=high"]);
  expect(launchArgs("omp", plain, { ultracode: true })).toBeUndefined();
});

it("refuses a choice the launch does not take, and a model that would read as a flag", () => {
  expect(launchChoiceFault("claude", { model: "opus", effort: "max", prompt: "hi" })).toBeNull();
  expect(launchChoiceFault("omp", { model: "", effort: "", prompt: "hi" })).toBeNull();
  expect(launchChoiceFault("omp", { model: "gpt-5" })).toBe("model");
  expect(launchChoiceFault("omp", { effort: "high" })).toBe("effort");
  expect(launchChoiceFault("codex", { effort: "ultracode" })).toBe("effort");
  expect(launchChoiceFault("claude", { model: "--dangerously-skip-permissions" })).toBe("model");
  expect(launchChoiceFault("claude", { model: "two words" })).toBe("model");
  expect(launchChoiceFault("", { prompt: "a shell takes none" })).toBe("prompt");
  expect(launchArgs("omp", plain, { model: "gpt-5", effort: "high" })).toBeUndefined();
  expect(launchArgs("claude", plain, { model: "--dangerously-skip-permissions" })).toBeUndefined();
});

it("sends the first prompt as Codex's own argument, and as the bridge's pending message for every other agent", () => {
  expect(firstPromptDelivery("codex", "Fix it")).toBe("positional");
  expect(firstPromptDelivery("codex", "-v tell me")).toBe("positional");
  expect(firstPromptDelivery("claude", "Fix it")).toBe("pending");
  expect(firstPromptDelivery("omp", "Fix it")).toBe("pending");
  expect(firstPromptDelivery("opencode", "Fix it")).toBe("pending");
  expect(launchArgs("claude", plain, { prompt: "Fix it" })).toBeUndefined();
  expect(firstPromptDelivery("codex", "   ")).toBeNull();
  expect(firstPromptDelivery("", "Fix it")).toBeNull();
});

it("starts a new agent on the model and effort Settings > Agents sets for it, and on its own while none is set", () => {
  const none = { claudeLaunchModel: "", claudeLaunchEffort: "", codexLaunchModel: "", codexLaunchEffort: "" };
  const set = { claudeLaunchModel: "opus[1m]", claudeLaunchEffort: "high", codexLaunchModel: "gpt-5-codex", codexLaunchEffort: "xhigh" };
  expect(launchDefaults("claude", none)).toEqual({ model: "", effort: "" });
  expect(launchAgent("claude", plain, launchDefaults("claude", none))).toEqual({ kind: "claude" });
  expect(launchDefaults("claude", set)).toEqual({ model: "opus[1m]", effort: "high" });
  expect(launchAgent("codex", plain, launchDefaults("codex", set))).toEqual({ kind: "codex", args: ["--model", "gpt-5-codex", "-c", "model_reasoning_effort=xhigh"] });
  expect(launchDefaults("codex", { ...none, claudeLaunchModel: "opus", claudeLaunchEffort: "max" })).toEqual({ model: "", effort: "" });
  for (const kind of ["omp", "copilot", "gemini", ""]) expect(launchDefaults(kind, set)).toEqual({ model: "", effort: "" });
  expect(launchDefaults("claude", { ...none, claudeLaunchModel: "opus --dangerously-skip-permissions", claudeLaunchEffort: "ultra" })).toEqual({ model: "", effort: "" });
});

it("keeps a model being typed that --model would refuse when another device changes the setting, and shows a kept one's change", () => {
  expect(modelDraftAfterSync("claude", "opus", "sonnet")).toBe("sonnet");
  expect(modelDraftAfterSync("claude", " sonnet ", "sonnet")).toBe(" sonnet ");
  expect(modelDraftAfterSync("claude", "opus --verbose", "sonnet")).toBe("opus --verbose");
});
