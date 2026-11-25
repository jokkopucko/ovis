import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseConversationMetadata } from "./conversation-metadata.ts";
import { forgetPiModels } from "./pi-models.ts";

const jsonl = (...entries: unknown[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");

// A pi window is looked up in the agent dir's models.json, so a test that left that unset
// would read whatever machine ran it: the same test would pass here and fail on a laptop.
const emptyDir = mkdtempSync(join(tmpdir(), "herdr-meta-empty-"));
const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
process.env["PI_CODING_AGENT_DIR"] = emptyDir;
afterAll(() => {
  if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
  rmSync(emptyDir, { recursive: true, force: true });
  forgetPiModels();
});

describe("recorded conversation model settings", () => {
  it("uses the latest Codex turn context, not the session's initial model", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "session_meta", payload: { model: "initial", reasoning_effort: "low" } },
      { type: "turn_context", payload: { model: "current", effort: "xhigh" } },
      { type: "response_item", payload: { type: "message", role: "user", model: "user text is not metadata" } },
    ), "codex-transcript")).toEqual({ model: "current", reasoning_effort: "xhigh" });
  });

  it("recognizes collaboration-mode settings and explicit effort overrides", () => {
    const context = { collaboration_mode: { settings: { model: "collaboration-model", reasoning_effort: "high" } } };
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: context }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: "high" });
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: "none" } }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: "none" });
    expect(parseConversationMetadata(jsonl({ type: "turn_context", payload: { ...context, effort: null } }), "codex-transcript"))
      .toEqual({ model: "collaboration-model", reasoning_effort: null });
  });

  it("does not carry an old effort into a Codex context that no longer reports one", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "turn_context", payload: { model: "first", effort: "high" } },
      { type: "turn_context", payload: { model: "second" } },
    ), "codex-transcript")).toEqual({ model: "second", reasoning_effort: null });
  });

  it("updates independent omp/omo/pi model and thinking settings, including off", () => {
    for (const source of ["omp-transcript", "omo-transcript", "pi-transcript"] as const) {
      expect(parseConversationMetadata(jsonl(
        { type: "model_change", modelId: "first" },
        { type: "thinking_level_change", thinkingLevel: "max" },
        { type: "model_change", modelId: "second" },
      ), source)).toEqual({ model: "second", reasoning_effort: "max" });
      expect(parseConversationMetadata(jsonl(
        { type: "thinking_level_change", thinkingLevel: "off" },
        { type: "message", message: { role: "assistant", model: "actual-response-model" } },
      ), source)).toEqual({ model: "actual-response-model", reasoning_effort: "off" });
    }
  });

  it("reads omp's own model change, which names provider/id in one field", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "message", message: { role: "assistant", model: "claude-opus-5-5", provider: "anthropic" } },
      { type: "model_change", model: "openai-codex/gpt-5.6-sol" },
    ), "omp-transcript")).toEqual({ model: "gpt-5.6-sol", reasoning_effort: null, provider: "openai-codex" });
    expect(parseConversationMetadata(jsonl({ type: "model_change", model: "local-model" }), "omp-transcript"))
      .toEqual({ model: "local-model", reasoning_effort: null });
  });

  it("names the provider an omp, omo, gjc or pi conversation runs at, by the rules of its model", () => {
    const answer = (provider?: string) => ({ type: "message", message: { role: "assistant", model: "m", ...(provider ? { provider } : {}) } });
    const clear = { type: "custom", customType: "context_clear" };
    for (const source of ["omp-transcript", "omo-transcript", "gjc-transcript", "pi-transcript"] as const) {
      const provider = (...entries: unknown[]) => parseConversationMetadata(jsonl(...entries), source).provider;
      expect(provider({ type: "model_change", provider: "anthropic", modelId: "claude-opus-5-5" })).toBe("anthropic");
      expect(provider({ type: "model_change", model: "openai-codex/gpt-5.6-sol" })).toBe("openai-codex");
      expect(provider({ type: "model_change", model: "anthropic/claude-opus-5-5" }, answer("openai-codex"))).toBe("openai-codex");
      expect(provider({ type: "model_change", model: "anthropic/claude-opus-5-5" }, answer())).toBeUndefined();
      expect(provider({ type: "model_change", model: "anthropic/claude-opus-5-5" }, { type: "message", message: { role: "assistant" } })).toBe("anthropic");
      expect(provider(answer("anthropic"), { type: "model_change", modelId: "local-model" })).toBeUndefined();
      expect(provider(answer("anthropic"), clear)).toBeUndefined();
      const before = parseConversationMetadata(jsonl(answer("anthropic")), source);
      expect(parseConversationMetadata(jsonl({ type: "thinking_level_change", thinkingLevel: "high" }), source, before).provider).toBe("anthropic");
      expect(parseConversationMetadata(jsonl(clear), source, before).provider).toBeUndefined();
    }
    expect(parseConversationMetadata(jsonl(answer("anthropic")), "cmd-transcript").provider).toBeUndefined();
    expect(parseConversationMetadata(jsonl({ type: "assistant", message: { role: "assistant", model: "claude-test", provider: "anthropic" } }), "claude-transcript").provider).toBeUndefined();
  });

  it("reads Claude's actual model without deriving effort from thinking content", () => {
    expect(parseConversationMetadata(jsonl(
      { type: "assistant", message: { role: "assistant", model: "claude-test", content: [{ type: "thinking", thinking: "text" }] } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
    ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: null });
    expect(parseConversationMetadata(jsonl(
      { type: "assistant", effort: "high", message: { role: "assistant", model: "claude-test" } },
      { type: "assistant", effort: "xhigh", message: { role: "assistant", model: "claude-test" } },
      { type: "assistant", message: { role: "assistant", model: "<synthetic>" } },
    ), "claude-transcript")).toEqual({ model: "claude-test", reasoning_effort: "xhigh" });
  });

  // Claude Code 2.1.311 as recorded, in order: /model sonnet, /effort xhigh, /model nosuchmodel
  // (refused), /effort ultracode (keeps the effort), /model haiku, /model with its card closed
  const recorded = readFileSync(new URL("./fixtures/claude-model-2.1.311.jsonl", import.meta.url), "utf8").trim().split("\n");
  const before = { model: "claude-opus-5-5", reasoning_effort: "medium" };

  it("takes the model and effort Claude's /model and /effort set, before the next answer", () => {
    const seen: unknown[] = [];
    let metadata = before;
    for (const line of recorded) {
      const next = parseConversationMetadata(line, "claude-transcript", metadata);
      if (next.model !== metadata.model || next.reasoning_effort !== metadata.reasoning_effort) seen.push(next);
      metadata = next as typeof before;
    }
    // each prompt of the recording was sent under the default mode
    expect(seen).toEqual([
      { model: "claude-sonnet-5-5", reasoning_effort: "medium", permission_mode: "default" },
      { model: "claude-sonnet-5-5", reasoning_effort: "xhigh", permission_mode: "default" },
      { model: "claude-haiku-5-5", reasoning_effort: "xhigh", permission_mode: "default" },
    ]);
    expect(parseConversationMetadata(recorded.join("\n"), "claude-transcript", before)).toEqual({ model: "claude-haiku-5-5", reasoning_effort: "xhigh", permission_mode: "default" });
    expect(parseConversationMetadata(jsonl({ type: "assistant", effort: "high", message: { role: "assistant", model: "claude-haiku-4-5-20251001" } }), "claude-transcript", { model: "claude-haiku-5-5", reasoning_effort: "xhigh" }))
      .toEqual({ model: "claude-haiku-4-5-20251001", reasoning_effort: "high" });
  });

  it("reads the forms other Claude Code versions print, and keeps the old value for anything else", () => {
    const said = (text: string) => ({ type: "user", message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` } });
    const after = (...entries: unknown[]) => parseConversationMetadata(jsonl(...entries), "claude-transcript", before);
    expect(after(said("Set model to `Sonnet 5.5` for this session only"))).toEqual({ ...before, model: "claude-sonnet-5-5" });
    expect(after(said("Set model to `Sonnet 5` and saved as your default for new sessions with `xhigh` effort"))).toEqual({ model: "claude-sonnet-5", reasoning_effort: "xhigh" });
    expect(after(said("Set model to `Opus 5 (1M context)` and saved as your default for new sessions"))).toEqual({ ...before, model: "claude-opus-5" });
    expect(after(said("Set model to Opus 4.8 (1M context) (default) and saved as your default for new sessions"))).toEqual({ ...before, model: "claude-opus-4-8" });
    expect(after(said("Set model to \u001b[1mHaiku 4.5\u001b[22m and saved as your default for new sessions"))).toEqual({ ...before, model: "claude-haiku-4-5" });
    expect(after(said("Set effort level to low (saved as your default for new sessions): Quick, straightforward implementation"))).toEqual({ ...before, reasoning_effort: "low" });
    expect(after(said("Set effort level to high (this session only): Comprehensive implementation with extensive testing and documentation · Ultracode on"))).toEqual({ ...before, reasoning_effort: "high" });
    expect(after({ type: "system", subtype: "local_command", commandRun: { command: "model", args: "" }, content: "<local-command-stdout>Set model to `Fable 5.1` and saved as your default for new sessions</local-command-stdout>" }))
      .toEqual({ ...before, model: "claude-fable-5-1" });
    for (const unchanged of [
      said("Kept model as `Sonnet 5`"),
      said("Model 'opus xhigh' not found"),
      said("Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration"),
      said("Set model to `Default (recommended)` and saved as your default for new sessions"),
      said("Set model to `Default (recommended)` and saved as your default for new sessions with `max` effort"),
      said("Set model to `Sonnet 5.5 Turbo` for this session only"),
      said("Set model to `Sonnet 5.05` for this session only"),
      said("Set model to `claude-sonnet-5-5` for this session only"),
      said("Set model to `Nova 6` for this session only"),
      { ...said("Set model to `Sonnet 5.5` for this session only"), permissionMode: "default" },
      { ...said("Set model to `Sonnet 5.5` for this session only"), origin: { kind: "human" } },
      { type: "user", message: { role: "user", content: "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout> Explain this format." } },
      { type: "user", message: { role: "user", content: "<command-name>/model</command-name>\n<command-args>x <local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout></command-args>" } },
      { ...said("Set model to `Sonnet 5.5` for this session only"), isSidechain: true },
      { type: "system", subtype: "local_command", commandRun: { command: "effort", args: "" }, content: "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>" },
      { type: "system", subtype: "turn_duration", content: "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>" }] } },
    ]) {
      // a typed prompt still says the permission mode it was sent under
      const { permission_mode: _mode, ...settings } = after(unchanged);
      expect(settings).toEqual(before);
    }
  });

  it("tolerates absent metadata, unexpected types and a torn append without losing valid settings", () => {
    const text = jsonl(null, [], { type: "turn_context", payload: null },
      { type: "turn_context", payload: { model: "recorded", effort: "medium" } },
      { type: "turn_context", payload: { model: {}, effort: undefined } });
    expect(parseConversationMetadata(`${text}\n{"type":`, "codex-transcript"))
      .toEqual({ model: "recorded", reasoning_effort: "medium" });
    expect(parseConversationMetadata("", "scrollback")).toEqual({ model: null, reasoning_effort: null });
  });
});

describe("context use", () => {
  const assistant = (usage: Record<string, number>, model = "claude-opus-5-5", extra: Record<string, unknown> = {}) =>
    ({ type: "assistant", ...extra, message: { role: "assistant", model, usage } });

  it("reads Codex's last request against the window it states", () => {
    const tokens = (total: number) => ({ type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: total }, model_context_window: 258_400 } } });
    expect(parseConversationMetadata(jsonl(tokens(10_000), tokens(67_723), { type: "event_msg", payload: { type: "token_count", info: null } }), "codex-transcript").context)
      .toEqual({ used: 67_723, window: 258_400 });
  });

  it("adds up a Claude request's input and cache, skipping subagents, and knows the 1M window once past 200k", () => {
    const small = parseConversationMetadata(jsonl(assistant({ input_tokens: 2, cache_creation_input_tokens: 700, cache_read_input_tokens: 40_000, output_tokens: 900 })), "claude-transcript");
    expect(small.context).toEqual({ used: 40_702, window: null });
    const long = parseConversationMetadata(jsonl(
      assistant({ input_tokens: 5, cache_read_input_tokens: 420_000 }),
      assistant({ input_tokens: 1, cache_read_input_tokens: 5_000 }, "claude-opus-5-5", { isSidechain: true }),
      assistant({ input_tokens: 3, cache_read_input_tokens: 30_000 }),
      assistant({ input_tokens: 0, output_tokens: 0 }, "<synthetic>"),
    ), "claude-transcript");
    expect(long.context).toEqual({ used: 30_003, window: 1_000_000 });
  });

  it("reads omp's usage shape, with no window to go by", () => {
    const entry = { type: "message", message: { role: "assistant", model: "gpt-6", usage: { input: 2, output: 7_000, cacheRead: 10_000, cacheWrite: 22_000 } } };
    expect(parseConversationMetadata(jsonl(entry), "omo-transcript").context).toEqual({ used: 32_002, window: null });
    expect(parseConversationMetadata(jsonl({ type: "message", message: { role: "user" } }), "omp-transcript").context).toBeUndefined();
  });

  it("reads pi's usage shape, which names the same fields omp does", () => {
    const entry = { type: "message", message: { role: "assistant", model: "qwen-test", usage: { input: 4_924, output: 198, cacheRead: 18_400, cacheWrite: 1_000, reasoning: 53, totalTokens: 24_522 } } };
    // the figure pi draws its own footer from: totalTokens, which counts the answer as well
    expect(parseConversationMetadata(jsonl(entry), "pi-transcript")).toEqual({
      model: "qwen-test", reasoning_effort: null, context: { used: 24_522, window: null },
    });
  });

  it("adds up a pi request itself when it states no total", () => {
    const usage = (extra: Record<string, unknown> = {}) => ({ type: "message", message: { role: "assistant", model: "qwen-test", usage: { input: 1_000, output: 200, cacheRead: 500, cacheWrite: 0, ...extra } } });
    expect(parseConversationMetadata(jsonl(usage()), "pi-transcript").context).toEqual({ used: 1_700, window: null });
    expect(parseConversationMetadata(jsonl(usage({ totalTokens: 1_234 })), "pi-transcript").context).toEqual({ used: 1_234, window: null });
    // a request that failed or was stopped filled nothing: pi leaves it out of its own figure
    const failed = { type: "message", message: { role: "assistant", model: "qwen-test", stopReason: "error", errorMessage: "401", usage: { input: 9_000, output: 0 } } };
    const aborted = { ...failed, message: { ...failed.message, stopReason: "aborted" } };
    expect(parseConversationMetadata(jsonl(usage(), failed), "pi-transcript").context).toEqual({ used: 1_700, window: null });
    expect(parseConversationMetadata(jsonl(usage(), aborted), "pi-transcript").context).toEqual({ used: 1_700, window: null });
  });

  it("draws pi's ring against the window its own catalog states, and not against a guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-meta-window-"));
    const previous = process.env["PI_CODING_AGENT_DIR"];
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: 215_000 }] } } }));
    process.env["PI_CODING_AGENT_DIR"] = dir;
    forgetPiModels();
    try {
      const entry = (extra: Record<string, unknown> = {}) => ({ type: "message", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { totalTokens: 100_000 }, ...extra } });
      expect(parseConversationMetadata(jsonl(entry()), "pi-transcript").context).toEqual({ used: 100_000, window: 215_000 });
      const changed = [
        { type: "model_change", provider: "lwsa", modelId: "qwen-test" },
        entry(),
        { type: "model_change", provider: "other", modelId: "qwen-test" },
        entry({ provider: "other" }),
      ];
      expect(parseConversationMetadata(jsonl(...changed), "pi-transcript").context).toEqual({ used: 100_000, window: null });
      const omp = { type: "message", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } } };
      expect(parseConversationMetadata(jsonl(omp), "omp-transcript").context).toEqual({ used: 8, window: null });
    } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previous;
      forgetPiModels();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stats pi's catalog once per fold, not once per answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-meta-stats-"));
    const catalog = join(dir, "models.json");
    writeFileSync(catalog, JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: 215_000 }] } } }));
    forgetPiModels();
    const stat = spyOn(fs, "statSync");
    try {
      const answers = Array.from({ length: 50 }, (_, i) => ({ type: "message", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { totalTokens: 1_000 + i } } }));
      expect(parseConversationMetadata(jsonl(...answers), "pi-transcript", undefined, dir).context).toEqual({ used: 1_049, window: 215_000 });
      expect(stat.mock.calls.filter(([path]) => path === catalog)).toHaveLength(1);
    } finally {
      stat.mockRestore();
      forgetPiModels();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads pi's window from the pane's own agent dir, not the bridge's", () => {
    const bridge = mkdtempSync(join(tmpdir(), "herdr-meta-bridge-"));
    const pane = mkdtempSync(join(tmpdir(), "herdr-meta-pane-"));
    const previous = process.env["PI_CODING_AGENT_DIR"];
    writeFileSync(join(bridge, "models.json"), JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: 215_000 }] } } }));
    writeFileSync(join(pane, "models.json"), JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: 400_000 }] } } }));
    process.env["PI_CODING_AGENT_DIR"] = bridge;
    forgetPiModels();
    try {
      const entry = jsonl({ type: "message", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { totalTokens: 100_000 } } });
      expect(parseConversationMetadata(entry, "pi-transcript", undefined, pane).context).toEqual({ used: 100_000, window: 400_000 });
      expect(parseConversationMetadata(entry, "pi-transcript", undefined, null).context).toEqual({ used: 100_000, window: null });
      expect(parseConversationMetadata(entry, "pi-transcript").context).toEqual({ used: 100_000, window: 215_000 });
    } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = previous;
      forgetPiModels();
      rmSync(bridge, { recursive: true, force: true });
      rmSync(pane, { recursive: true, force: true });
    }
  });
});

describe("Claude Code's permission mode", () => {
  // Claude Code 2.1.330 as recorded (Haiku, an isolated config): a prompt under auto, Shift+Tab, a prompt, Shift+Tab, a prompt
  const recorded = readFileSync(new URL("./fixtures/claude-permission-mode-2.1.330.jsonl", import.meta.url), "utf8").trim().split("\n");

  it("follows the mode each prompt was sent under and each switch it recorded", () => {
    const seen: (string | undefined)[] = [];
    let metadata = parseConversationMetadata("", "claude-transcript");
    for (const line of recorded) {
      metadata = parseConversationMetadata(line, "claude-transcript", metadata);
      if ((JSON.parse(line) as { type?: string }).type === "user") seen.push(metadata.permission_mode);
    }
    expect(seen).toEqual(["auto", "default", "acceptEdits"]);
    expect(parseConversationMetadata(recorded.join("\n"), "claude-transcript").permission_mode).toBe("acceptEdits");
  });

  it("leaves a subagent's mode and a transcript that names none out", () => {
    const sidechain = jsonl({ type: "user", isSidechain: true, permissionMode: "bypassPermissions", message: { role: "user", content: "go" } });
    expect(parseConversationMetadata(sidechain, "claude-transcript").permission_mode).toBeUndefined();
    expect(parseConversationMetadata(`${recorded[1]}\n${sidechain}`, "claude-transcript").permission_mode).toBe("auto");
  });
});
