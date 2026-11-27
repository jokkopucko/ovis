import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import * as herdr from "../herdr/client.ts";
import * as kiroModule from "../kiro.ts";
import { handlePromptRequest, parseInteractivePrompt } from "../prompt.ts";
import { recordSettled } from "../record-cards.ts";
import { kiroRecord } from "./kiro-record.ts";
import { withRecord } from "./record.ts";
import { parsedByPublicPrompt } from "./shared.ts";

const pendingShell = (id: string, command: string, extra?: { askId?: string; consentRound?: number }): string => JSON.stringify({
  id: `${id}-pending`,
  timestamp: "2026-11-26T19:53:02.552Z",
  payload: {
    type: "pending_interaction",
    interactionType: "tool_approval",
    toolCallId: id,
    ...(extra?.consentRound !== undefined ? { consentRound: extra.consentRound } : {}),
    question: command,
    options: [
      { optionId: "accept", name: "Allow", kind: "allow_once" },
      { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Deny", kind: "reject_once" },
      { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
    ],
    _meta: {
      kiro: {
        toolId: "run_command",
        command,
        ...(extra?.askId !== undefined ? { askId: extra.askId } : {}),
        ...(extra?.consentRound !== undefined ? { consentRound: extra.consentRound } : {}),
        consent: { capability: "shell", resource: command },
      },
    },
  },
});

const pendingWrite = (id: string, path: string): string => JSON.stringify({
  id: `${id}-pending`,
  timestamp: "2026-11-26T19:53:07.277Z",
  payload: {
    type: "pending_interaction",
    interactionType: "tool_approval",
    toolCallId: id,
    question: "Write File",
    _meta: {
      kiro: {
        toolId: "fs_write",
        consent: { capability: "fs_write", resource: path },
      },
    },
  },
});

const resolved = (id: string, outcome: "selected" | "cancelled", selectedOption?: "accept" | "reject", extra?: { askId?: string; consentRound?: number }): string => JSON.stringify({
  id: `${id}-resolved`,
  timestamp: "2026-11-26T19:53:08.147Z",
  payload: {
    type: "interaction_resolved",
    toolCallId: id,
    ...(extra?.consentRound !== undefined ? { consentRound: extra.consentRound } : {}),
    outcome,
    ...(selectedOption ? { selectedOption } : {}),
    ...(extra?.askId !== undefined || extra?.consentRound !== undefined ? {
      _meta: { kiro: { ...(extra?.askId !== undefined ? { askId: extra.askId } : {}), ...(extra?.consentRound !== undefined ? { consentRound: extra.consentRound } : {}) } },
    } : {}),
  },
});

const userTurn = (content: string): string => JSON.stringify({
  id: "user-1",
  timestamp: "2026-11-26T19:53:10.000Z",
  payload: { type: "user", content },
});

const turnEnd = (): string => JSON.stringify({
  id: "turn-end-1",
  timestamp: "2026-11-26T19:53:11.000Z",
  payload: { type: "turn_end", stopReason: "end_turn" },
});

const fileIdentityOf = (path: string): string => {
  const stat = statSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};

describe("kiro's V3 session record", () => {
  test("extracts a single open shell tool_approval and closes it on accept, reject, cancel, user turn, or turn_end", () => {
    const id = "run_command_call_87c8a74ae56f3964";
    const cmd = "echo KIRO_LONG_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_END";
    expect(kiroRecord.pending(pendingShell(id, cmd))).toEqual({ id, command: cmd });
    expect(kiroRecord.pending([pendingShell(id, cmd), resolved(id, "selected", "accept")].join("\n"))).toBeNull();
    expect(kiroRecord.pending([pendingShell(id, cmd), resolved(id, "selected", "reject")].join("\n"))).toBeNull();
    expect(kiroRecord.pending([pendingShell(id, cmd), resolved(id, "cancelled")].join("\n"))).toBeNull();
    expect(kiroRecord.pending([pendingShell(id, cmd), userTurn("never mind")].join("\n"))).toBeNull();
    expect(kiroRecord.pending([pendingShell(id, cmd), turnEnd()].join("\n"))).toBeNull();
  });

  test("distinguishes separate approval rounds sharing a toolCallId via askId and consentRound", () => {
    const round1 = kiroRecord.pending(pendingShell("tool_1", "echo sample", { askId: "pr-1", consentRound: 1 }))!;
    const round2 = kiroRecord.pending([
      pendingShell("tool_1", "echo sample", { askId: "pr-1", consentRound: 1 }),
      resolved("tool_1", "selected", "reject", { askId: "pr-1", consentRound: 1 }),
      pendingShell("tool_1", "echo sample", { askId: "pr-2", consentRound: 2 }),
    ].join("\n"))!;
    expect(round1.id).not.toBe(round2.id);

    // An out-of-order resolution for round 1 must not clear round 2
    const stillOpen = kiroRecord.pending([
      pendingShell("tool_1", "echo sample", { askId: "pr-1", consentRound: 1 }),
      pendingShell("tool_1", "echo sample", { askId: "pr-2", consentRound: 2 }),
      resolved("tool_1", "selected", "reject", { askId: "pr-1", consentRound: 1 }),
    ].join("\n"));
    expect(stillOpen).toEqual(round2);

    // Without askId, consentRound alone still separates rounds
    const r1 = kiroRecord.pending(pendingShell("tool_2", "echo sample", { consentRound: 1 }))!;
    const r2 = kiroRecord.pending([
      pendingShell("tool_2", "echo sample", { consentRound: 1 }),
      resolved("tool_2", "selected", "reject", { consentRound: 1 }),
      pendingShell("tool_2", "echo sample", { consentRound: 2 }),
    ].join("\n"))!;
    expect(r1.id).not.toBe(r2.id);
  });

  test("returns null for non-shell tools, simultaneous open interactions, or malformed lines", () => {
    expect(kiroRecord.pending(pendingWrite("call_write_1", "/tmp/outside.txt"))).toBeNull();
    expect(kiroRecord.pending([
      pendingShell("run_1", "echo one"),
      pendingShell("run_2", "echo two"),
    ].join("\n"))).toBeNull();
    expect(kiroRecord.pending([
      pendingShell("run_1", "echo one"),
      pendingWrite("call_write_1", "/tmp/outside.txt"),
    ].join("\n"))).toBeNull();
    expect(kiroRecord.pending([
      pendingShell("run_1", "echo one"),
      JSON.stringify({ payload: { type: "pending_interaction", interactionType: "tool_approval" } }),
    ].join("\n"))).toBeNull();
    expect(kiroRecord.pending(`${pendingShell("run_1", "echo one")}\n{"payload":{"type":"interaction_res`)).toEqual({
      id: "run_1",
      command: "echo one",
    });
  });

  test("unwraps a wrapped Kiro 3.6.2 shell approval and binds the card to that request id", () => {
    const command = "echo KIRO_LONG_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_END";
    const screen = `
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Echo the exact string provided requires approval
 shell → echo
 KIRO_LONG_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJKLMNOPQRST
 UVWXYZ_END

 ❯ Allow once
   Deny once
   Create allow rule to approve future similar actions
   Create deny rule to block future similar actions
───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 esc to close · ↑↓ to navigate · ↵ to select · Tab to edit
`;
    const request = kiroRecord.pending(pendingShell("run_command_call_87c8a74ae56f3964", command, { askId: "pr-long" }))!;
    const card = parsedByPublicPrompt.get(parseInteractivePrompt("kiro", screen)!)!;
    const shown = withRecord(card, request, screen, kiroRecord);
    expect(shown.record).toEqual(request);
    expect(shown.body).toBe(command);
    expect(shown.id).not.toBe(card.id);
    expect(shown.selectedIndex).toBe(0);
    const wrong = withRecord(card, { id: "run_other", command: "echo something else" }, screen, kiroRecord);
    expect(wrong).toBe(card);
    expect(wrong.record).toBeUndefined();
  });

  test("binds the 5-option Approve for me promo screen while preserving all 5 choices", () => {
    const command = "echo KIRO_V3_APPROVAL_TEST";
    const screen = `
───────────────────────────────────────────────────────────────────────
 Run Command requires approval
 shell → echo KIRO_V3_APPROVAL_TEST

 ❯ Allow once
   Deny once
   Create allow rule to approve future similar actions
   Create deny rule to block future similar actions
 ─────────────────────────────────────────────────────────────────────
   Allow once and enable Approve for me
   Approve for me lets Kiro approve routine actions, block risky ones, and ask when unsure.
───────────────────────────────────────────────────────────────────────
 esc to close · ↑↓ to navigate · ↵ to select · Tab to edit
`;
    const request = kiroRecord.pending(pendingShell("run_promo_1", command, { askId: "pr-promo" }))!;
    const card = parsedByPublicPrompt.get(parseInteractivePrompt("kiro", screen)!)!;
    const shown = withRecord(card, request, screen, kiroRecord);
    expect(shown.record).toEqual(request);
    expect(shown.body).toBe(command);
    expect(shown.options.map((option) => option.label)).toEqual([
      "Allow once",
      "Deny once",
      "Create allow rule to approve future similar actions",
      "Create deny rule to block future similar actions",
      "Allow once and enable Approve for me",
    ]);
  });

  test("reports closed in recordSettled after accept, reject, or cancel", async () => {
    const id = "run_settle_1";
    const before = kiroRecord.pending(pendingShell(id, "echo ok", { askId: "pr-settle" }))!;
    for (const closingLine of [
      resolved(id, "selected", "accept", { askId: "pr-settle" }),
      resolved(id, "selected", "reject", { askId: "pr-settle" }),
      resolved(id, "cancelled", undefined, { askId: "pr-settle" }),
    ]) {
      const after = kiroRecord.pending([pendingShell(id, "echo ok", { askId: "pr-settle" }), closingLine].join("\n"));
      expect(await recordSettled("p", "kiro", before.id, 0, async () => after)).toBe("closed");
    }
  });
});

describe("kiro approval route guards", () => {
  const spies: Array<{ mockRestore(): void }> = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const approvalScreen = (selected: 0 | 1 = 0) => `
───────────────────────────────────────────────────────────────────────
 Run Command requires approval
 shell → echo KIRO_ROUTE_GUARD

 ${selected === 0 ? "❯" : " "} Allow once
 ${selected === 1 ? "❯" : " "} Deny once
   Create allow rule to approve future similar actions
   Create deny rule to block future similar actions
───────────────────────────────────────────────────────────────────────
 esc to close · ↑↓ to navigate · ↵ to select · Tab to edit
`;

  function stubKiroPane(
    paneId: string,
    foregroundArgv: string[],
    readMessages: () => { path: string; identity: string; text: string } | null,
    readScreen: () => string,
    onSendKeys: (keys: string[]) => void,
  ) {
    const pane = { pane_id: paneId, terminal_id: paneId, workspace_id: "w1", tab_id: "t1", agent: "kiro", agent_status: "blocked", cwd: "/tmp", focused: true, revision: 1 };
    spies.push(
      spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane], agents: [] } as unknown as SessionSnapshot),
      spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: readScreen() }) as Awaited<ReturnType<typeof herdr.paneRead>>),
      spyOn(herdr, "paneProcessInfo").mockResolvedValue({ pane_id: paneId, foreground_processes: [{ pid: 4242, name: "bun", argv: foregroundArgv }] } as Awaited<ReturnType<typeof herdr.paneProcessInfo>>),
      spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { onSendKeys([...keys]); }),
      spyOn(kiroModule, "readKiroV3MessagesTail").mockImplementation(async () => readMessages()),
    );
  }

  test("withholds the card and suppresses fallback when Kiro is not in the pane foreground", async () => {
    if (process.platform === "win32") return;
    const sent: string[][] = [];
    stubKiroPane("kiro-bg-pane", ["bash"], () => null, () => approvalScreen(0), (keys) => sent.push(keys));
    const url = new URL("http://localhost/api/pane/prompt?pane_id=kiro-bg-pane");
    const res = await handlePromptRequest(new Request(url), url);
    expect(res?.status).toBe(200);
    expect((await res!.json() as { prompt: unknown }).prompt).toBeNull();
    expect(sent).toEqual([]);
  });

  test("binds GET to the V3 record and refuses POST with 409 when a different ask replaces it before keys go", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-kiro-route-"));
    tempDirs.push(dir);
    const messages = join(dir, "messages.jsonl");
    writeFileSync(messages, `${pendingShell("call_first", "echo KIRO_ROUTE_GUARD", { askId: "pr-1" })}\n`);
    const readFileTail = () => ({ path: messages, identity: fileIdentityOf(messages), text: readFileSync(messages, "utf8") });

    const sent: string[][] = [];
    stubKiroPane("kiro-rec-pane", ["/opt/kiro-cli/bun", "/opt/kiro-cli/tui.js", "chat", "--trust-workspace"], readFileTail, () => approvalScreen(0), (keys) => sent.push(keys));

    const getUrl = new URL("http://localhost/api/pane/prompt?pane_id=kiro-rec-pane");
    const getRes = await handlePromptRequest(new Request(getUrl), getUrl);
    expect(getRes?.status).toBe(200);
    const { prompt } = await getRes!.json() as { prompt: { id: string; body: string } };
    expect(prompt.body).toBe("echo KIRO_ROUTE_GUARD");

    // Replace the open request with a second round carrying the exact same toolCallId and command
    writeFileSync(messages, [
      pendingShell("call_first", "echo KIRO_ROUTE_GUARD", { askId: "pr-1" }),
      resolved("call_first", "selected", "reject", { askId: "pr-1" }),
      pendingShell("call_first", "echo KIRO_ROUTE_GUARD", { askId: "pr-2" }),
    ].join("\n") + "\n");

    const postUrl = new URL("http://localhost/api/pane/prompt/answer");
    const postRes = await handlePromptRequest(new Request(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "kiro-rec-pane", prompt_id: prompt.id, option_index: 0 }),
    }), postUrl);
    expect(postRes?.status).toBe(409);
    expect(sent).toEqual([]);
  });

  test("refuses Enter with 409 if the cursor moves from Deny once to Allow once during the final record lookup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-kiro-cursor-race-"));
    tempDirs.push(dir);
    const messages = join(dir, "messages.jsonl");
    writeFileSync(messages, `${pendingShell("call_race", "echo KIRO_ROUTE_GUARD", { askId: "pr-race" })}\n`);

    let cursor: 0 | 1 = 1; // already on Deny once
    let recordReads = 0;
    const sent: Array<{ keys: string[]; cursor: 0 | 1 }> = [];
    stubKiroPane(
      "kiro-cursor-race-pane",
      ["/opt/kiro-cli/bun", "/opt/kiro-cli/tui.js", "chat"],
      () => {
        recordReads += 1;
        // Simulate cursor moving to Allow once (0) during the final post-settle recordRequest check before Enter
        // Read 1: GET, Read 2: POST firstRead, Read 3: verifyThenSend readKnownPrompt, Read 4: verifyThenSend recordRequest
        if (recordReads === 4) cursor = 0;
        return { path: messages, identity: fileIdentityOf(messages), text: readFileSync(messages, "utf8") };
      },
      () => approvalScreen(cursor),
      (keys) => sent.push({ keys, cursor }),
    );

    const getUrl = new URL("http://localhost/api/pane/prompt?pane_id=kiro-cursor-race-pane");
    const { prompt } = await (await handlePromptRequest(new Request(getUrl), getUrl))!.json() as { prompt: { id: string } };

    const postUrl = new URL("http://localhost/api/pane/prompt/answer");
    const postRes = await handlePromptRequest(new Request(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "kiro-cursor-race-pane", prompt_id: prompt.id, option_index: 1 }),
    }), postUrl);
    expect(postRes?.status).toBe(409);
    expect(sent).toEqual([]);
  });

  test("refuses Enter with 409 if messages.jsonl closes the request during the final post-record screen check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-kiro-sync-race-"));
    tempDirs.push(dir);
    const messages = join(dir, "messages.jsonl");
    writeFileSync(messages, `${pendingShell("call_sync", "echo KIRO_ROUTE_GUARD", { askId: "pr-sync" })}\n`);

    let recordReads = 0;
    let closeOnNextScreen = false;
    const sent: string[][] = [];
    stubKiroPane(
      "kiro-sync-race-pane",
      ["/opt/kiro-cli/bun", "/opt/kiro-cli/tui.js", "chat"],
      () => {
        recordReads += 1;
        if (recordReads === 4) closeOnNextScreen = true;
        return { path: messages, identity: fileIdentityOf(messages), text: readFileSync(messages, "utf8") };
      },
      () => {
        if (closeOnNextScreen) {
          closeOnNextScreen = false;
          writeFileSync(messages, [
            pendingShell("call_sync", "echo KIRO_ROUTE_GUARD", { askId: "pr-sync" }),
            resolved("call_sync", "selected", "reject", { askId: "pr-sync" }),
          ].join("\n") + "\n");
        }
        return approvalScreen(1);
      },
      (keys) => sent.push(keys),
    );

    const getUrl = new URL("http://localhost/api/pane/prompt?pane_id=kiro-sync-race-pane");
    const { prompt } = await (await handlePromptRequest(new Request(getUrl), getUrl))!.json() as { prompt: { id: string } };

    const postUrl = new URL("http://localhost/api/pane/prompt/answer");
    const postRes = await handlePromptRequest(new Request(postUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "kiro-sync-race-pane", prompt_id: prompt.id, option_index: 1 }),
    }), postUrl);
    expect(postRes?.status).toBe(409);
    expect(sent).toEqual([]);
  });
});
