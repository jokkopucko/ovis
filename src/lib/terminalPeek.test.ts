import { describe, expect, test } from "bun:test";
import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import { CLAUDE_AUTO_RETURN, SCREEN_AUTO_RETURN, autoReturnArmed, commandScreenClosed, paneLensFlags, peekFor, returnBlocked, screenReturnArmed, sentOutcome, watchReturn, type TerminalPeek } from "./terminalPeek.ts";

const peek: TerminalPeek = { slot: "a", machineId: "local", paneId: "w1:p1", command: "/usage", text: "/usage", knownOutcomeIds: ["o1"], auto: true, watch: null, inputRowSeen: true };
const outcome = (id: string, text: string, created: string): CommandOutcome => ({
  id, pane_id: "w1:p1", text, state: "terminal-required", evidence: [], created_at: created, updated_at: created,
});
const notice = (ts: string | null, source = "local-command"): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "notice", text: "Settings dialog dismissed", source }] });
const SENT = "2026-10-22T01:00:00.000Z";

describe("paneLensFlags", () => {
  test("the chat lens covers the grid", () => {
    expect(paneLensFlags("chat", null)).toEqual({ chatMounted: true, gridCovered: true });
  });

  test("a peek keeps the chat mounted and uncovers the grid", () => {
    expect(paneLensFlags("chat", peek)).toEqual({ chatMounted: true, gridCovered: false });
  });

  test("the terminal lens has no chat to keep", () => {
    expect(paneLensFlags("terminal", null)).toEqual({ chatMounted: false, gridCovered: false });
    expect(paneLensFlags("terminal", peek)).toEqual({ chatMounted: false, gridCovered: false });
  });
});

describe("peekFor", () => {
  test("is the peek of its own half, PC and pane", () => {
    expect(peekFor(peek, "a", "local", "w1:p1")).toBe(peek);
  });

  test("no other half, PC or pane shows it", () => {
    expect(peekFor(peek, "b", "local", "w1:p1")).toBeNull();
    expect(peekFor(peek, "a", "remote", "w1:p1")).toBeNull();
    expect(peekFor(peek, "a", "local", "w1:p2")).toBeNull();
    expect(peekFor(peek, "a", "local", null)).toBeNull();
    expect(peekFor(null, "a", "local", "w1:p1")).toBeNull();
  });
});

describe("autoReturnArmed", () => {
  test("Claude Code comes back by itself after a recorded command, sent bare", () => {
    for (const command of CLAUDE_AUTO_RETURN) expect(autoReturnArmed("claude", `/${command}`, command)).toBe(true);
    expect(autoReturnArmed("claude", "/Config ", "Config")).toBe(true);
  });

  test("every other agent waits for the reader", () => {
    for (const agent of ["codex", "pi", "omp", "hermes", "opencode", null]) expect(autoReturnArmed(agent, "/status", "status")).toBe(false);
  });

  test("a command whose close records nothing the chat reads, or records at open, stays manual", () => {
    for (const command of ["diff", "export", "plugin", "mobile", "autocompact", "add-dir", "mcp", "scroll-speed", "sandbox", "tasks", "memory", "btw", "doctor"]) {
      expect(autoReturnArmed("claude", `/${command}`, command)).toBe(false);
    }
  });

  test("a custom or unknown command stays manual", () => {
    expect(autoReturnArmed("claude", "/deploy", "deploy")).toBe(false);
    expect(autoReturnArmed("claude", "/frobnicate", "frobnicate")).toBe(false);
  });

  test("only the bare form the recording covers", () => {
    expect(autoReturnArmed("claude", "/fast", "fast")).toBe(true);
    expect(autoReturnArmed("claude", "/fast on", "fast")).toBe(false);
    expect(autoReturnArmed("claude", "/resume 4f2a", "resume")).toBe(false);
  });
});

describe("screenReturnArmed", () => {
  const RECORDED: Record<string, string[]> = {
    codex: ["permissions", "theme", "statusline", "resume", "review", "rename", "new", "fork", "usage", "diff"],
    omp: ["settings", "hotkeys", "tree", "resume", "extensions", "agents", "usage", "context", "btw"],
    pi: ["settings", "tree", "resume", "scoped-models"],
    gjc: ["settings", "theme", "tree", "resume", "sessions", "transcript", "routing"],
    omo: ["settings", "tree", "thinking", "scoped-models", "favorite-models", "sessions", "resume", "rename", "share", "trust"],
    hermes: ["model", "reload-mcp", "new", "reset", "clear"],
    devin: ["model", "models", "config", "resume", "theme", "shortcuts", "mode", "btw"],
    agy: ["model", "resume", "config", "permissions", "mcp", "skills", "usage", "context", "help", "tasks", "rewind", "artifact", "codesearch", "diff", "changelog"],
    grok: ["settings", "sessions", "resume", "plugins", "skills", "hooks", "help", "usage", "context", "history"],
  };

  test("lists exactly the recorded commands, each sent bare", () => {
    expect(Object.fromEntries(Object.entries(SCREEN_AUTO_RETURN).map(([agent, known]) => [agent, [...known.bare]]))).toEqual(RECORDED);
    for (const [agent, commands] of Object.entries(RECORDED)) {
      for (const command of commands) expect([agent, command, screenReturnArmed(agent, `/${command}`, command)]).toEqual([agent, command, true]);
    }
    expect(screenReturnArmed("omp", "/Settings ", "Settings")).toBe(true);
  });

  test("a form with arguments only where the recording covered one: Codex's /cd into a folder", () => {
    expect(screenReturnArmed("codex", "/cd ../other", "cd")).toBe(true);
    expect(screenReturnArmed("codex", "/cd", "cd")).toBe(false);
    expect(screenReturnArmed("codex", "/review the auth change", "review")).toBe(false);
    expect(screenReturnArmed("omp", "/btw what changed?", "btw")).toBe(false);
    expect(screenReturnArmed("devin", "/model swe-1.6", "model")).toBe(false);
  });

  test("print forms, toggles, $EDITOR handoffs and screens that close onto text stay manual", () => {
    const manual: [string, string][] = [["codex", "status"], ["codex", "vim"], ["codex", "mention"], ["codex", "side"], ["codex", "btw"], ["codex", "goal"],
      ["omp", "plan"], ["omp", "copy"], ["pi", "hotkeys"], ["pi", "session"], ["gjc", "hotkeys"], ["gjc", "btw"], ["omo", "tasks"], ["omo", "btw"],
      ["hermes", "palette"], ["hermes", "prompt"], ["hermes", "compose"], ["hermes", "resume"], ["devin", "mcp"], ["devin", "status"], ["agy", "open"],
      ["grok", "model"], ["grok", "theme"], ["grok", "status"],
      ["omp", "switch"], ["gjc", "model"]];
    for (const [agent, command] of manual) expect([agent, command, screenReturnArmed(agent, `/${command}`, command)]).toEqual([agent, command, false]);
  });

  test("Claude Code, OpenCode and agents never recorded come back by hand from the screen", () => {
    for (const agent of ["claude", "opencode", "cmd", "toString", null]) expect(screenReturnArmed(agent, "/settings", "settings")).toBe(false);
  });
});

describe("watchReturn", () => {
  test("arms on the agent's arm set, returns on the next ready frame", () => {
    expect(watchReturn("codex", false, "gone")).toEqual({ step: "wait", armed: true });
    expect(watchReturn("codex", true, "gone")).toEqual({ step: "wait", armed: true });
    expect(watchReturn("codex", true, "ready")).toEqual({ step: "return" });
    expect(watchReturn("agy", false, "covered")).toEqual({ step: "wait", armed: true });
    expect(watchReturn("codex", false, "covered")).toEqual({ step: "wait", armed: false });
    // Hermes draws its row again before every screen: only a covered row arms it
    expect(watchReturn("hermes", false, "gone")).toEqual({ step: "wait", armed: false });
    expect(watchReturn("hermes", false, "covered")).toEqual({ step: "wait", armed: true });
  });

  test("a ready or draft frame before arming, and a blank frame, change nothing", () => {
    expect(watchReturn("omp", false, "ready")).toEqual({ step: "wait", armed: false });
    expect(watchReturn("omp", false, "draft")).toEqual({ step: "wait", armed: false });
    expect(watchReturn("omp", false, "unknown")).toEqual({ step: "wait", armed: false });
    expect(watchReturn("omp", true, "unknown")).toEqual({ step: "wait", armed: true });
  });

  test("a draft after arming, or an agent with no screen return, leaves it to the reader", () => {
    expect(watchReturn("grok", true, "draft")).toEqual({ step: "manual" });
    expect(watchReturn("claude", false, "gone")).toEqual({ step: "manual" });
    expect(watchReturn("opencode", true, "ready")).toEqual({ step: "manual" });
  });
});

describe("sentOutcome", () => {
  test("is the outcome with the sent text the chat had not read", () => {
    const own = outcome("o2", "/usage", SENT);
    expect(sentOutcome(peek, [outcome("o1", "/status", SENT), own, outcome("o3", "/status", SENT)])).toBe(own);
  });

  test("passes over an identical send just before it that no read had listed yet", () => {
    const earlier = outcome("o2", "/usage", "2026-10-22T00:59:58.000Z");
    const own = outcome("o3", "/usage", SENT);
    expect(sentOutcome(peek, [earlier, own])).toBe(own);
    expect(commandScreenClosed(peek, "claude", sentOutcome(peek, [earlier, own])!.created_at, [notice("2026-10-22T00:59:59.000Z")])).toBe(false);
  });

  test("passes over an older identical send", () => {
    const older = outcome("o1", "/usage", "2026-10-22T00:50:00.000Z");
    const own = outcome("o2", "/usage ", SENT);
    expect(sentOutcome(peek, [older, own])).toBe(own);
  });

  test("is null while the send's outcome is not listed yet", () => {
    expect(sentOutcome(peek, [outcome("o1", "/usage", SENT)])).toBeNull();
    expect(sentOutcome(peek, [])).toBeNull();
  });

  test("a peek opened by hand, or before the chat read any outcome, has none", () => {
    expect(sentOutcome({ ...peek, text: null }, [outcome("o2", "/usage", SENT)])).toBeNull();
    expect(sentOutcome({ ...peek, knownOutcomeIds: null }, [outcome("o2", "/usage", SENT)])).toBeNull();
  });
});

describe("commandScreenClosed", () => {
  test("a local-command notice written after the send closes it", () => {
    expect(commandScreenClosed(peek, "claude", SENT, [notice("2026-10-22T01:00:04.000Z")])).toBe(true);
  });

  test("a notice from before the send, or at the same moment, does not", () => {
    expect(commandScreenClosed(peek, "claude", SENT, [notice("2026-10-22T00:59:00.000Z")])).toBe(false);
    expect(commandScreenClosed(peek, "claude", SENT, [notice(SENT)])).toBe(false);
    expect(commandScreenClosed(peek, "claude", SENT, [notice(null)])).toBe(false);
  });

  test("only a local-command notice counts", () => {
    expect(commandScreenClosed(peek, "claude", SENT, [notice("2026-10-22T01:00:04.000Z", "informational")])).toBe(false);
    expect(commandScreenClosed(peek, "claude", SENT, [{ role: "assistant", ts: "2026-10-22T01:00:04.000Z", parts: [{ kind: "text", text: "Done." }] }])).toBe(false);
  });

  test("waits for the send's outcome to be listed", () => {
    expect(commandScreenClosed(peek, "claude", null, [notice("2026-10-22T01:00:04.000Z")])).toBe(false);
  });

  test("never for another agent or a peek left manual", () => {
    expect(commandScreenClosed(peek, "codex", SENT, [notice("2026-10-22T01:00:04.000Z")])).toBe(false);
    expect(commandScreenClosed({ ...peek, auto: false }, "claude", SENT, [notice("2026-10-22T01:00:04.000Z")])).toBe(false);
  });
});

describe("returnBlocked", () => {
  const none = { heldDraft: false, findOpen: false, composing: false };
  test("nothing in the way lets the chat come back", () => {
    expect(returnBlocked(none)).toBe(false);
  });

  test("held terminal input, the find bar or a composition keeps the terminal", () => {
    expect(returnBlocked({ ...none, heldDraft: true })).toBe(true);
    expect(returnBlocked({ ...none, findOpen: true })).toBe(true);
    expect(returnBlocked({ ...none, composing: true })).toBe(true);
  });
});
