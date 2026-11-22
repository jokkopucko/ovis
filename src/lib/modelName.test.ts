import { describe, expect, test } from "bun:test";
import { modelLabel } from "./modelName.ts";

describe("modelLabel", () => {
  test("names a Claude id by the vendor's family and version", () => {
    expect(modelLabel("claude-opus-5-5")).toEqual({ text: "Opus 5.5", named: true });
    expect(modelLabel("claude-sonnet-5")).toEqual({ text: "Sonnet 5", named: true });
    expect(modelLabel("claude-haiku-4-5")).toEqual({ text: "Haiku 4.5", named: true });
    expect(modelLabel("claude-opus-4-1")).toEqual({ text: "Opus 4.1", named: true });
    expect(modelLabel("claude-fable-5-1")).toEqual({ text: "Fable 5.1", named: true });
  });

  test("reads the vendor's own provider prefix as the same model", () => {
    expect(modelLabel("anthropic/claude-opus-5-5")).toEqual({ text: "Opus 5.5", named: true });
  });

  test("names a bare GPT or GLM version", () => {
    expect(modelLabel("gpt-5.6")).toEqual({ text: "GPT-5.6", named: true });
    expect(modelLabel("gpt-6")).toEqual({ text: "GPT-6", named: true });
    expect(modelLabel("glm-5.3")).toEqual({ text: "GLM-5.3", named: true });
  });

  test("names the one GPT tier Codex's own status line writes, with its hyphen", () => {
    expect(modelLabel("gpt-5.6-sol")).toEqual({ text: "GPT-5.6-Sol", named: true });
    expect(modelLabel("gpt-6-sol")).toEqual({ text: "GPT-6-Sol", named: true });
  });

  test("shows an id it cannot name for certain exactly as received", () => {
    for (const id of [
      "claude-haiku-4-5-20251001", "claude-opus-5-5[1m]", "claude-opus-5-5-fast",
      "claude-3-5-sonnet-20241022", "claude-3", "claude-nova-5",
      "gpt-5.6-sol-max", "gpt-5.6-Sol", "gpt-5.6-solo", "gpt-sol", "gpt-5.6-sol-codex-preview-2026-10", "gpt-4.1-mini", "gpt-transcribe",
      "bedrock/claude-opus-5-5", "openrouter/anthropic/claude-opus-5-5", "openai/gpt-5.6", "anthropic/x",
      "qwen-3-8-flash", "grok-4.7", "glm-5.3-air", "Claude-Opus-5-5", " claude-opus-5-5", "codex-test-model", "<synthetic>", "",
    ]) expect(modelLabel(id)).toEqual({ text: id, named: false });
  });

  test("shows a version with a leading zero as the id it is, for every vendor", () => {
    for (const id of [
      "claude-sonnet-5-05", "claude-opus-05-5", "claude-opus-05", "claude-opus-0-5", "claude-opus-0", "claude-opus-5-00", "anthropic/claude-sonnet-5-05",
      "gpt-05.6", "gpt-5.06", "gpt-05", "gpt-0", "gpt-0.5", "gpt-05.6-sol", "gpt-5.06-sol",
      "glm-05.3", "glm-5.03", "glm-05", "glm-0",
      // a minor of 0 is the vendor's form only for Anthropic: the others write the bare major
      "gpt-5.0", "gpt-5.0-sol", "glm-5.0",
    ]) expect(modelLabel(id)).toEqual({ text: id, named: false });
    expect(modelLabel("claude-opus-4-0")).toEqual({ text: "Opus 4.0", named: true });
    expect(modelLabel("claude-sonnet-10-10")).toEqual({ text: "Sonnet 10.10", named: true });
  });

  test("shows every other shape that is not the vendor's canonical form as received", () => {
    for (const id of [
      "claude-opus-", "claude-opus--5", "claude--5-5", "claude-opus-5--5", "gpt-", "gpt-.6", "gpt--sol", "glm-", "glm-.3", "anthropic/", "/claude-opus-5-5",
      "claude-opus-555", "claude-opus-5-555", "claude-opus-5-5-5", "gpt-555", "gpt-5.666", "gpt-5.6.1", "glm-555", "glm-5.333", "glm-5.3.1",
      "claude-opus-5-5-", "claude-opus-5-", "claude-opus-5.5", "claude_opus_5_5", "gpt-5.", "gpt-5.6-", "gpt-5.6-sol-", "gpt-5-6", "gpt5.6", "glm-5.", "glm-5.3-", "glm-5-3",
      "CLAUDE-opus-5-5", "claude-Opus-5-5", "claude-OPUS-5-5", "Anthropic/claude-opus-5-5", "GPT-5.6", "Gpt-5.6", "gpt-5.6-SOL", "GLM-5.3", "Glm-5.3",
      "claude-opus-5-5 ", "claude-opus-5-5\n", "\nclaude-opus-5-5", "claude-opus -5-5", "claude-opus-5\t-5", "gpt-5.6 ", "gpt-5.6\n", " gpt-5.6", "gpt- 5.6", "glm-5.3\n", "glm-5.3\u00a0",
      "claude-opus-\uff15-\uff15", "gpt-\u0665.\u0666",
    ]) expect(modelLabel(id)).toEqual({ text: id, named: false });
  });

  // The accepted consequence of naming by the vendor's id syntax and not from a list of released
  // versions: a well-formed id is named even where no such model exists, so that a new model
  // needs no change here. This is by design; do not turn it into a list.
  test("names a well-formed id of a version nobody released", () => {
    expect(modelLabel("claude-opus-9-9")).toEqual({ text: "Opus 9.9", named: true });
    expect(modelLabel("claude-mythos-12")).toEqual({ text: "Mythos 12", named: true });
    expect(modelLabel("gpt-10")).toEqual({ text: "GPT-10", named: true });
    expect(modelLabel("gpt-9.9-sol")).toEqual({ text: "GPT-9.9-Sol", named: true });
    expect(modelLabel("glm-9.9")).toEqual({ text: "GLM-9.9", named: true });
    expect(modelLabel("glm-10.10")).toEqual({ text: "GLM-10.10", named: true });
  });
});
