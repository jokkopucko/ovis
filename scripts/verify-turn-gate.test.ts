import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, type Config, explore, loadClass, VARIANTS } from "../.claude/skills/verify-turn-gate/explore.ts";
import { fail, read, repo } from "./source-scan.ts";
import {
  computeTurnGatePins,
  diffTurnGatePins,
  extractCallerGateSlice,
  extractCodexSteeringSlice,
  extractPendingInputGateSlice,
  TURN_GATE_PINS_PATH,
} from "./verify-turn-gate.ts";

afterAll(() => cleanup());

describe("verify-turn-gate enforcement", () => {
  it("keeps the targeted turn-gate AST pins in sync with the skill", () => {
    const expected = JSON.parse(readFileSync(join(repo, TURN_GATE_PINS_PATH), "utf8")) as Record<string, string>;
    const actual = computeTurnGatePins();
    fail(
      diffTurnGatePins(expected, actual),
      `A turn-gate method or caller changed since .claude/skills/verify-turn-gate was last verified. Follow .claude/skills/verify-turn-gate/SKILL.md ("When you change the covered code on purpose"): update explore.ts and SKILL.md if a step changed, run check.ts, then record both .claude/skills/verify-turn-gate/covered.sh --record and bun scripts/verify-turn-gate.ts --record.`,
    );
  });

  it("ignores comments and unrelated code inside shared handlers while catching turn-gate and guard edits", () => {
    const pendingInput = read("server/pending-input.ts");
    expect(extractPendingInputGateSlice(`${pendingInput}\n// comment only\nexport const UNRELATED_CONSTANT = 1;\n`))
      .toBe(extractPendingInputGateSlice(pendingInput));
    expect(extractPendingInputGateSlice(pendingInput.replace("if (ready(status) && gate.sawWorking) {", "if (ready(status)) {")))
      .not.toBe(extractPendingInputGateSlice(pendingInput));
    expect(extractPendingInputGateSlice(pendingInput.replace("PENDING_START_TIMEOUT_MS = 10_000", "PENDING_START_TIMEOUT_MS = 1_000")))
      .not.toBe(extractPendingInputGateSlice(pendingInput));
    // the Enter's wait ending when the turn's end can no longer be told, with no status that showed it
    expect(extractPendingInputGateSlice(pendingInput.replace("else if (!turn.gate.sawWorking) turn.gate.deadline = this.now() + this.startTimeoutMs;", "else this.gates.delete(paneId);")))
      .not.toBe(extractPendingInputGateSlice(pendingInput));

    const steering = read("server/codex-steering.ts");
    expect(extractCodexSteeringSlice(steering.replace("Ask Codex to do anything", "Ask Codex anything")))
      .toBe(extractCodexSteeringSlice(steering));
    expect(extractCodexSteeringSlice(steering.replace("restart: false", "restart: true")))
      .not.toBe(extractCodexSteeringSlice(steering));

    const caller = read("server/core/pending.ts");
    expect(extractCallerGateSlice("server/core/pending.ts", `${caller}\nfunction unrelatedHelper() { return 42; }\n`))
      .toBe(extractCallerGateSlice("server/core/pending.ts", caller));
    // Editing an unrelated statement inside pendingFrames.submit must NOT trip the turn-gate pin.
    expect(extractCallerGateSlice("server/core/pending.ts", caller.replace("confirmations.set(message.pane_id, refusal);", "confirmations.set(message.pane_id, { ...refusal });")))
      .toBe(extractCallerGateSlice("server/core/pending.ts", caller));
    // Editing arguments, control-flow guards, or steerMark initialization MUST trip the pin.
    expect(extractCallerGateSlice("server/core/pending.ts", caller.replace("committing(true, false, steerMark);", "committing(true, false, pending.mark(paneId));")))
      .not.toBe(extractCallerGateSlice("server/core/pending.ts", caller));
    // the steer's commit moved from its writing callback to the end of its checkPane callback, before thread/loaded/list:
    // the gate calls keep their order, only the callback that owns the commit changes
    const checkEnd = "            await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);\n          }, () => {\n";
    const commitInCheck = caller.replace("            committing(true, false, steerMark);\n", "")
      .replace(checkEnd, checkEnd.replace("          }, () => {\n", "            committing(true, false, steerMark);\n          }, () => {\n"));
    expect(commitInCheck).toContain("identity);\n            committing(true, false, steerMark);\n          }, () => {\n            authorizePending(");
    expect(extractCallerGateSlice("server/core/pending.ts", commitInCheck))
      .not.toBe(extractCallerGateSlice("server/core/pending.ts", caller));
    expect(extractCallerGateSlice("server/core/pending.ts", caller.replace("let steerMark = mark;", "let steerMark = 0;")))
      .not.toBe(extractCallerGateSlice("server/core/pending.ts", caller));
    expect(extractCallerGateSlice("server/core/pending.ts", caller.replace("!pending.waiting(message.pane_id)", "true")))
      .not.toBe(extractCallerGateSlice("server/core/pending.ts", caller));
    expect(extractCallerGateSlice("server/core/pending.ts", caller.replace("if (!pending.claim(item, true)) return;", "if (false) return;")))
      .not.toBe(extractCallerGateSlice("server/core/pending.ts", caller));
    // the queue no longer drained when Codex's own server tells the turn's end, or no longer going behind that turn
    expect(extractCallerGateSlice("server/core/pending.ts", caller.replace("pending.turnOver(paneId, wait, told); drainPending(paneId);", "pending.turnOver(paneId, wait, told);")))
      .not.toBe(extractCallerGateSlice("server/core/pending.ts", caller));
    expect(extractCallerGateSlice("server/core/pending.ts", caller.replace("          behindCodexTurn(paneId, viaData.over);\n          noteSubmitted(", "          noteSubmitted(")))
      .not.toBe(extractCallerGateSlice("server/core/pending.ts", caller));

    const statusCode = read("server/core/status.ts");
    expect(extractCallerGateSlice("server/core/status.ts", statusCode.replace("pending.status(paneId,", "if (false) pending.status(paneId,")))
      .not.toBe(extractCallerGateSlice("server/core/status.ts", statusCode));

    const serverCore = read("server/core/server-core.ts");
    expect(extractCallerGateSlice("server/core/server-core.ts", serverCore.replace("for (const paneId of pending.expire())", "for (const paneId of ([] as string[]))")))
      .not.toBe(extractCallerGateSlice("server/core/server-core.ts", serverCore));
  });

  it("matches every broken variant against server/pending-input.ts and checks live gate smoke", async () => {
    for (const name of Object.keys(VARIANTS)) {
      await expect(loadClass(name)).resolves.toBeDefined();
    }
    const base: Config = {
      name: "gate-smoke",
      agent: "codex",
      messages: 1,
      owners: ["a"],
      free: true,
      rest: "idle",
      overtake: false,
      ownQueue: false,
      lateEvents: false,
      steerPastEnd: true,
      sendNowDuringRestart: true,
      baseline: true,
      atOnce: true,
      slowEnter: false,
      served: false,
      others: 0,
      blocks: 0,
      gone: true,
      moves: true,
      holds: true,
      rules: ["QueueWaitsForTurnEvidence"],
      expect: "holds",
    };
    for (const variant of ["sent-ends-wait", "uncertain-ends-wait"] as const) {
      const brokenResult = await explore({
        ...base,
        name: `broken-${variant}`,
        messages: 3,
        gone: false,
        moves: false,
        holds: false,
        variant,
        expect: "QueueWaitsForTurnEvidence",
      });
      expect(brokenResult.broken?.rule).toBe("QueueWaitsForTurnEvidence");
    }

    const smoke = await explore(base);
    expect(smoke.broken).toBeNull();
    expect(smoke.states).toBeGreaterThan(100);
  }, 30_000);
});
