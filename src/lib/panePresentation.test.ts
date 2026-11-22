import { expect, it } from "bun:test";
import { ConversationFinishEvidence, conversationFinishPresented, paneCovered, PANE_COVER_SELECTOR } from "./panePresentation.ts";
import type { ConversationTurn } from "../../shared/protocol.ts";
import { turnRevision } from "./turnRevision.ts";

for (const source of ["claude-transcript", "codex-transcript"] as const) {
  it(`${source} requires the newest answer's native final marker, not an earlier complete turn`, () => {
    const done: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] };
    const user: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "Next request" }] };
    const partial: ConversationTurn = { role: "assistant", ts: null, parts: [{ kind: "text", text: "Still working", phase: "commentary" }] };
    expect(conversationFinishPresented({ source, turns: [done] })).toBe(true);
    for (const turns of [[], [done, user], [done, user, partial],
      [{ ...partial, parts: [{ kind: "text" as const, text: "Unlabelled prose" }] }],
      [{ ...done, parts: [...done.parts, { kind: "thinking" as const, text: "More work" }] }]]) {
      expect(conversationFinishPresented({ source, turns })).toBe(false);
    }
  });
}

for (const source of ["omp-transcript", "omo-transcript", "gjc-transcript", "pi-transcript", "opencode-transcript", "grok-transcript", "devin-transcript", "hermes-transcript", "agy-transcript"] as const) {
it(`${source} does not accept prose without native completion evidence`, () => {
  const conversation = { source, turns: [
    { role: "assistant", ts: null, parts: [{ kind: "text", text: "Native stop" }] },
  ] } satisfies Parameters<typeof conversationFinishPresented>[0];
  expect(conversationFinishPresented(conversation)).toBe(false);
  expect(new ConversationFinishEvidence().accept(source, 1, conversation)).toBe(false);
});
}

it("looks past only informational and local-command notices, never new user work", () => {
  const answer: ConversationTurn = { role: "assistant", ts: "2026-10-19T00:00:00Z", parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] };
  for (const source of ["informational", "local-command"]) {
    expect(conversationFinishPresented({ source: "claude-transcript", turns: [
      answer, { role: "user", ts: null, parts: [{ kind: "notice", text: "Notice", source }] },
    ] })).toBe(true);
  }
  expect(conversationFinishPresented({ source: "claude-transcript", turns: [
    answer, { role: "user", ts: null, parts: [{ kind: "notice", text: "Work arrived", source: "async-result" }] },
  ] })).toBe(false);
  expect(conversationFinishPresented({ source: "omp-transcript", turns: [
    answer, { role: "user", ts: null, parts: [{ kind: "goal_wait", due_at: "2026-10-19T00:05:00Z", waiting_on: { tasks: 0, monitors: 1, terminals: 0, dags: 0, cells: 0 } }] },
  ] })).toBe(true);
});

it("looks past a compaction's summary and its notices to the answer before them (#3675)", () => {
  const answered = { source: "claude-transcript", history_id: "session", turns: [
    { role: "assistant", ts: "2026-10-19T00:00:00Z", end_ts: "2026-10-19T00:00:05Z", parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] },
  ] } satisfies Parameters<typeof conversationFinishPresented>[0];
  // as server/claude-transcript.ts parses what Claude Code records for /compact typed at rest (server/core/status.test.ts):
  // the command, then the summary; the command's echo and output lines are dropped
  const compacted = { ...answered, turns: [...answered.turns,
    { role: "user", ts: "2026-10-19T00:59:57Z", parts: [{ kind: "text", text: "/compact" }] },
    { role: "user", ts: "2026-10-19T01:00:00Z", parts: [{ kind: "compact", text: "Summary of the earlier session" }] },
    { role: "user", ts: "2026-10-19T01:00:01Z", parts: [{ kind: "notice", text: "Compacted", source: "informational" }] },
    { role: "user", ts: "2026-10-19T02:00:00Z", parts: [{ kind: "notice", text: "Updated", source: "local-command" }] },
  ] } satisfies Parameters<typeof conversationFinishPresented>[0];
  expect(conversationFinishPresented(compacted)).toBe(true);
  expect(new ConversationFinishEvidence().accept("compact-unseen", 40, compacted)).toBe(true);
  const seen = new ConversationFinishEvidence();
  expect(seen.accept("compact-seen", 40, answered)).toBe(true);
  expect(seen.accept("compact-seen", 41, answered)).toBe(false);
  expect(seen.accept("compact-seen", 41, compacted)).toBe(true);
  expect(seen.accept("compact-seen", 42, structuredClone(compacted))).toBe(false);
  const skipped = new ConversationFinishEvidence();
  expect(skipped.accept("compact-skipped", 40, answered)).toBe(true);
  expect(skipped.accept("compact-skipped", 42, compacted)).toBe(false);
  const other = new ConversationFinishEvidence();
  const older = { ...answered, turns: [{ ...answered.turns[0]!, ts: "2026-10-18T00:00:00Z", end_ts: "2026-10-18T00:00:05Z", parts: [{ kind: "text" as const, text: "Older", phase: "final_answer" as const }] }] };
  expect(other.accept("compact-other", 40, older)).toBe(true);
  expect(other.accept("compact-other", 41, compacted)).toBe(false);
  const twice = new ConversationFinishEvidence();
  const again = { ...compacted, turns: [...compacted.turns,
    { role: "user", ts: "2026-10-19T03:59:50Z", parts: [{ kind: "text", text: "/compact keep the test list" }] },
    { role: "user", ts: "2026-10-19T04:00:00Z", parts: [{ kind: "compact", text: "Summary of the summary" }] }] } satisfies Parameters<typeof conversationFinishPresented>[0];
  expect(twice.accept("compact-twice", 40, answered)).toBe(true);
  expect(twice.accept("compact-twice", 41, compacted)).toBe(true);
  expect(twice.accept("compact-twice", 42, again)).toBe(true);
  expect(twice.accept("compact-twice", 43, structuredClone(again))).toBe(false);
  const local = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "compact-terminal" ? JSON.stringify({ id: 40, at: 1 }) : null,
  } });
  try {
    expect(new ConversationFinishEvidence().accept("compact-terminal", 41, compacted)).toBe(true);
    expect(new ConversationFinishEvidence().accept("compact-terminal", 42, compacted)).toBe(false);
  } finally {
    if (local) Object.defineProperty(globalThis, "localStorage", local);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  const prompted = { ...compacted, turns: [...compacted.turns,
    { role: "user", ts: "2026-10-19T03:00:00Z", parts: [{ kind: "text", text: "Next request" }] }] } satisfies Parameters<typeof conversationFinishPresented>[0];
  expect(conversationFinishPresented(prompted)).toBe(false);
  expect(new ConversationFinishEvidence().accept("compact-prompted", 40, prompted)).toBe(false);
  // a compaction no /compact asked for (Claude Code's own; at rest it keeps the finish id, server/core/status.test.ts)
  // leaves the answer before it presented and proving its own finish, and proves no finish of its own
  const idle = { ...answered, turns: [...answered.turns,
    { role: "user", ts: "2026-10-19T01:00:00Z", parts: [{ kind: "compact", text: "Summary of the earlier session" }] }] } satisfies Parameters<typeof conversationFinishPresented>[0];
  expect(conversationFinishPresented(idle)).toBe(true);
  expect(new ConversationFinishEvidence().accept("compact-idle-fresh", 40, idle)).toBe(true);
  const unattributed = new ConversationFinishEvidence();
  expect(unattributed.accept("compact-idle", 40, answered)).toBe(true);
  expect(unattributed.accept("compact-idle", 40, idle)).toBe(true);
  expect(unattributed.accept("compact-idle", 41, idle)).toBe(false);
  const idleThenCommanded = { ...idle, turns: [...idle.turns,
    { role: "user", ts: "2026-10-19T01:30:00Z", parts: [{ kind: "text", text: "/compact" }] },
    { role: "user", ts: "2026-10-19T01:30:05Z", parts: [{ kind: "compact", text: "Summary after the idle one" }] }] } satisfies Parameters<typeof conversationFinishPresented>[0];
  const sequence = new ConversationFinishEvidence();
  expect(sequence.accept("compact-idle-then", 40, idle)).toBe(true);
  expect(sequence.accept("compact-idle-then", 41, idleThenCommanded)).toBe(true);
  // the other agents record no command: each compaction of theirs proves its finish, as with #3690
  const opencode = { ...answered, source: "opencode-transcript" as const };
  const opencodeCompacted = { ...opencode, turns: [...opencode.turns, idle.turns[1]!] };
  const otherAgent = new ConversationFinishEvidence();
  expect(otherAgent.accept("compact-opencode", 40, opencode)).toBe(true);
  expect(otherAgent.accept("compact-opencode", 41, opencodeCompacted)).toBe(true);
  const answer = answered.turns[0]!;
  const savedByMain = JSON.stringify([answered.source, answered.history_id, idle.turns[1]!.ts, turnRevision({ role: answer.role, ts: answer.ts,
    parts: [answer.parts[0]!, idle.turns[1]!.parts[0]!] })]);
  const upgradeStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "compact-upgrade" ? JSON.stringify({ id: 40, at: 1, answer: savedByMain }) : null,
  } });
  try {
    expect(new ConversationFinishEvidence().accept("compact-upgrade", 41, idleThenCommanded)).toBe(true);
  } finally {
    if (upgradeStorage) Object.defineProperty(globalThis, "localStorage", upgradeStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
  expect(conversationFinishPresented({ ...answered, turns: [...answered.turns, compacted.turns[1]!] })).toBe(false);
});

it("binds a completed answer to one finish and rejects unchanged new-finish responses", () => {
  const evidence = new ConversationFinishEvidence();
  const first = { source: "pi-transcript" as const, history_id: "session", turns: [
    { role: "assistant" as const, ts: "2026-10-19T00:00:00Z", parts: [{ kind: "text" as const, text: "First", phase: "final_answer" as const }] },
  ] };
  expect(evidence.accept("pc:epoch:pane", 1, first)).toBe(true);
  expect(evidence.accept("pc:epoch:pane", 1, first, first)).toBe(true);
  expect(evidence.accept("pc:epoch:pane", 2, first, first)).toBe(false);
  expect(evidence.accept("pc:epoch:pane", 2, structuredClone(first), first)).toBe(false);
  const older = structuredClone(first);
  older.turns[0]!.ts = "2026-10-18T00:00:00Z";
  older.turns[0]!.parts[0]!.text = "A different but older answer";
  expect(evidence.accept("pc:epoch:pane", 2, older, first)).toBe(false);
  const decorated = structuredClone(first);
  Object.assign(decorated.turns[0]!, { end_ts: first.turns[0]!.ts });
  decorated.turns[0]!.parts[0]!.text = "Rewritten old answer, same completed turn";
  expect(evidence.accept("pc:epoch:pane", 2, decorated, first)).toBe(false);
  const lateMetadata = structuredClone(first);
  Object.assign(lateMetadata.turns[0]!, { end_ts: "2026-10-19T00:02:00Z" });
  expect(evidence.accept("pc:epoch:pane", 2, lateMetadata, first)).toBe(false);
  const next = structuredClone(first);
  next.turns[0]!.ts = "2026-10-19T00:01:00Z";
  next.turns[0]!.parts[0]!.text = "Second";
  expect(evidence.accept("pc:epoch:pane", 2, next, first)).toBe(true);
  expect(evidence.accept("pc:epoch:pane", 1, first)).toBe(false);
  expect(evidence.accept("pc:new-epoch:pane", 1, first)).toBe(true);
  expect(evidence.accept("pending-scope", 2, { ...first, turns: [] })).toBe(false);
  expect(evidence.accept("pending-scope", 1, first)).toBe(false);
  expect(evidence.accept("pending-scope", 2, next)).toBe(true);
  evidence.observe("unread-scope", 2);
  expect(evidence.accept("unread-scope", 1, next)).toBe(false);
  expect(evidence.accept("unread-scope", 2, next)).toBe(true);
  expect(evidence.accept("skipped-scope", 1, first)).toBe(true);
  expect(evidence.accept("skipped-scope", 3, next)).toBe(true);
  const third = structuredClone(next);
  third.turns[0]!.ts = "2026-10-19T00:02:00Z";
  third.turns[0]!.parts[0]!.text = "Third";
  expect(evidence.accept("skipped-scope", 3, third)).toBe(false);
  const local = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => key === "pc:epoch:pane" ? JSON.stringify({ id: 1, at: 1, answer: evidence.answer("pc:new-epoch:pane", 1) }) : null,
  } });
  try {
    const reloaded = new ConversationFinishEvidence();
    expect(reloaded.accept("pc:epoch:pane", 2, structuredClone(first))).toBe(false);
    expect(reloaded.accept("pc:epoch:pane", 2, structuredClone(next))).toBe(true);
  } finally {
    if (local) Object.defineProperty(globalThis, "localStorage", local);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

it("accepts finish 10 after finish 4 without waiting for the resting agent to answer again", () => {
  const evidence = new ConversationFinishEvidence();
  const first = { source: "pi-transcript", history_id: "session", turns: [
    { role: "assistant", ts: "2026-10-19T00:00:00Z", parts: [{ kind: "text", text: "First", phase: "final_answer" }] },
  ] } satisfies Parameters<typeof conversationFinishPresented>[0];
  const final = { ...first, turns: [
    { role: "assistant", ts: "2026-10-19T00:10:00Z", parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] },
  ] } satisfies Parameters<typeof conversationFinishPresented>[0];
  expect(evidence.accept("resting-scope", 4, first)).toBe(true);

  expect(evidence.accept("resting-scope", 10, structuredClone(first))).toBe(false);
  expect(evidence.accept("resting-scope", 10, final, final)).toBe(false);
  expect(evidence.accept("resting-scope", 10, final, first)).toBe(true);
  expect(evidence.answer("resting-scope", 10)).toBeDefined();
  expect(evidence.accept("resting-scope", 10, final, final)).toBe(true);
  expect(evidence.accept("resting-scope", 10, structuredClone(final), final)).toBe(true);
  expect(evidence.accept("resting-scope", 9, final)).toBe(false);
});

it("keeps proving a finish when Codex dates its answer again with a later task_complete", () => {
  const evidence = new ConversationFinishEvidence();
  const answered = { source: "codex-transcript", history_id: "rollout", turns: [
    { role: "assistant", ts: "2026-10-19T00:00:00Z", end_ts: "2026-10-19T00:00:05Z", parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] },
  ] } satisfies Parameters<typeof conversationFinishPresented>[0];
  const completed = structuredClone(answered);
  completed.turns[0]!.end_ts = "2026-10-19T00:00:06Z";
  expect(evidence.accept("codex-scope", 3, answered)).toBe(true);
  expect(evidence.accept("codex-scope", 3, completed, answered)).toBe(true);
  expect(evidence.accept("codex-scope", 3, completed, completed)).toBe(true);
  const other = structuredClone(completed);
  other.turns[0]!.parts[0]!.text = "Something else";
  expect(evidence.accept("codex-scope", 3, other, completed)).toBe(false);
});

it("does not take an older reply with the same text for the finish when no turn has a start time", () => {
  const evidence = new ConversationFinishEvidence();
  const newest = { source: "opencode-transcript", history_id: "session", turns: [
    { role: "assistant", ts: null, end_ts: "2026-10-19T00:05:00Z", parts: [{ kind: "text", text: "Done", phase: "final_answer" }] },
  ] } satisfies Parameters<typeof conversationFinishPresented>[0];
  const older = structuredClone(newest);
  older.turns[0]!.end_ts = "2026-10-19T00:01:00Z";
  expect(evidence.accept("no-start-scope", 3, newest)).toBe(true);
  expect(evidence.accept("no-start-scope", 3, older, newest)).toBe(false);
  expect(evidence.accept("no-start-scope", 3, structuredClone(newest), older)).toBe(true);
});

for (const id of [5, 10]) {
  it(`accepts finish ${id} when the saved finish 4 has no answer proof`, () => {
    const local = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => key === "terminal-baseline" ? JSON.stringify({ id: 4, at: 1 }) : null,
    } });
    try {
      const evidence = new ConversationFinishEvidence();
      const final = { source: "pi-transcript", turns: [
        { role: "assistant", ts: "2026-10-19T00:10:00Z", parts: [{ kind: "text", text: "Finished", phase: "final_answer" }] },
      ] } satisfies Parameters<typeof conversationFinishPresented>[0];
      expect(evidence.accept("terminal-baseline", id, final, final)).toBe(false);
      expect(evidence.accept("terminal-baseline", id, final)).toBe(true);
      expect(evidence.accept("terminal-baseline", id, final, final)).toBe(true);
    } finally {
      if (local) Object.defineProperty(globalThis, "localStorage", local);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
}

async function covered(html: string): Promise<boolean> {
  let matched = false;
  await new HTMLRewriter().on(PANE_COVER_SELECTOR, { element() { matched = true; } })
    .transform(new Response(html)).text();
  return matched;
}

it("treats a composer's slash or file listbox popup as covering the pane", async () => {
  expect(await covered('<div class="menu composer-menu"><div role="listbox"><button role="option">Option</button></div></div>')).toBe(true);
});

it("treats the failed-suggestions popup as coverage even without a listbox role", async () => {
  expect(await covered('<div class="menu composer-menu"><div class="composer-menu-group"><p class="chat-inline-error">Failed</p></div></div>')).toBe(true);
});

it("leaves a docked file panel and a plain inline listbox uncovered", async () => {
  expect(await covered('<aside class="file-panel"><section class="file-viewer file-viewer-docked"></section></aside><div role="listbox"></div>')).toBe(false);
});

it("ignores retained hidden covers without ignoring another presented dialog", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  const beforeStyle = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  const nodes = [
    { closest: () => ({}), getClientRects: () => [{}], visibility: "visible" },
    { closest: () => null, getClientRects: () => [], visibility: "visible" },
    { closest: () => null, getClientRects: () => [{}], visibility: "hidden" },
  ];
  Object.defineProperty(globalThis, "document", { configurable: true, value: { querySelectorAll: () => nodes } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (node: { visibility: string }) => node });
  try {
    expect(paneCovered()).toBe(false);
    nodes.push({ closest: () => null, getClientRects: () => [{}], visibility: "visible" });
    expect(paneCovered()).toBe(true);
  } finally {
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
    if (beforeStyle) Object.defineProperty(globalThis, "getComputedStyle", beforeStyle);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});
