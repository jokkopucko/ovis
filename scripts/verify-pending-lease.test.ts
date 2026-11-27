import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, read, repo } from "./source-scan.ts";
import {
  CALLER_PATTERNS,
  computePendingLeasePins,
  diffPendingLeasePins,
  extractCodexWriteSlice,
  extractComposerLeaseSlice,
  extractConnectionsLeaseSlice,
  extractHerdrClientWriteSlice,
  extractInputGuardLeaseSlice,
  extractLeaseCallerSlice,
  extractPendingInputLeaseSlice,
  extractSkillAttachLeaseSlice,
  PENDING_LEASE_PINS_PATH,
} from "./verify-pending-lease.ts";

describe("verify-pending-lease enforcement", () => {
  it("keeps the targeted pending-lease AST pins in sync with the TLA+ model", () => {
    const expected = JSON.parse(readFileSync(join(repo, PENDING_LEASE_PINS_PATH), "utf8")) as Record<string, string>;
    const actual = computePendingLeasePins();
    fail(
      diffPendingLeasePins(expected, actual),
      `A pending-lease guard, attachment lifecycle step or caller changed since .claude/skills/verify-pending-lease was last verified. Follow .claude/skills/verify-pending-lease/SKILL.md ("When you change the covered code on purpose"): update PendingLease.tla and SKILL.md if a step changed, run TLC on PendingLease.cfg and all broken-*.cfg configs, then record both .claude/skills/verify-pending-lease/covered.sh --record and bun scripts/verify-pending-lease.ts --record.`,
    );
  });

  it("ignores unrelated routes and comments while catching lease, guard and caller edits", () => {
    const guard = read("server/input-guard.ts");
    expect(extractInputGuardLeaseSlice(guard.replace("TERMINAL_REPLIES =", "/* comment */ TERMINAL_REPLIES =")))
      .toBe(extractInputGuardLeaseSlice(guard));
    expect(extractInputGuardLeaseSlice(guard.replace("facts.claimed && facts.member && facts.ready", "facts.member && facts.ready")))
      .not.toBe(extractInputGuardLeaseSlice(guard));

    const pendingInput = read("server/pending-input.ts");
    expect(extractPendingInputLeaseSlice(`${pendingInput}\nexport const UNRELATED = true;\n`))
      .toBe(extractPendingInputLeaseSlice(pendingInput));
    expect(extractPendingInputLeaseSlice(pendingInput.replace("item.inFlight ? \"uncertain\" : \"held\"", "\"held\"")))
      .not.toBe(extractPendingInputLeaseSlice(pendingInput));
    // the queue giving out a message while a turn's end the agent tells is awaited
    expect(extractPendingInputLeaseSlice(pendingInput.replace("this.gates.has(paneId) || this.turns.has(paneId)\n", "this.gates.has(paneId)\n")))
      .not.toBe(extractPendingInputLeaseSlice(pendingInput));

    const connections = read("server/core/connections.ts");
    expect(extractConnectionsLeaseSlice(connections.replace("const WATCHES = 64;", "const WATCHES = 128;")))
      .toBe(extractConnectionsLeaseSlice(connections));
    expect(extractConnectionsLeaseSlice(connections.replace("if (state.revoked) throw new HerdrError", "if (false) throw new HerdrError")))
      .not.toBe(extractConnectionsLeaseSlice(connections));

    const herdrClient = read("server/herdr/client.ts");
    expect(extractHerdrClientWriteSlice(herdrClient.replace("if (guard && !guard()) {", "if (false) {")))
      .not.toBe(extractHerdrClientWriteSlice(herdrClient));
    // paneSendText no longer handing herdrRpc its guard
    const unguarded = herdrClient.replace("await herdrRpc(\"pane.send_text\", { pane_id: paneId, text }, socketPath, undefined, guard);",
      "await herdrRpc(\"pane.send_text\", { pane_id: paneId, text }, socketPath);");
    expect(unguarded).not.toBe(herdrClient);
    expect(extractHerdrClientWriteSlice(unguarded)).not.toBe(extractHerdrClientWriteSlice(herdrClient));

    // turn/start no longer asking its guard right before the request
    const codex = read("server/approvals/codex.ts");
    const startTurn = codex.slice(codex.indexOf("  async startTurn("));
    const unasked = codex.replace(startTurn, startTurn.replace("    if (!mayWrite()) return \"unsent\";\n", ""));
    expect(unasked).not.toBe(codex);
    expect(extractCodexWriteSlice(unasked)).not.toBe(extractCodexWriteSlice(codex));

    const composer = read("server/core/composer.ts");
    expect(extractComposerLeaseSlice(composer.replace("TYPED_LINE_MAX = 200", "TYPED_LINE_MAX = 250")))
      .toBe(extractComposerLeaseSlice(composer));
    expect(extractComposerLeaseSlice(composer.replace("await paneSendKeys(paneId, [\"esc\"], undefined, allowed)", "await paneSendKeys(paneId, [\"esc\"])")))
      .not.toBe(extractComposerLeaseSlice(composer));

    const skillAttach = read("server/opencode-skill-attach.ts");
    expect(extractSkillAttachLeaseSlice(skillAttach.replace("if (!allowed()) throw new HerdrError", "if (false) throw new HerdrError")))
      .not.toBe(extractSkillAttachLeaseSlice(skillAttach));

    const pendingCaller = CALLER_PATTERNS.find((entry) => entry.file === "server/core/pending.ts")!;
    const pendingCode = read("server/core/pending.ts");
    // Unrelated statement inside pendingFrames.submit must NOT trip the lease pin.
    expect(extractLeaseCallerSlice(
      "server/core/pending.ts",
      pendingCode.replace("confirmations.set(message.pane_id, refusal);", "confirmations.set(message.pane_id, { ...refusal });"),
      pendingCaller.pattern,
      pendingCaller.wholeDecls,
    )).toBe(extractLeaseCallerSlice("server/core/pending.ts", pendingCode, pendingCaller.pattern, pendingCaller.wholeDecls));
    // Dropping allowed() from paneSendText or paneSendKeys MUST trip the lease pin.
    expect(extractLeaseCallerSlice(
      "server/core/pending.ts",
      pendingCode.replace("() => allowed() && inTime() && (wrote = true)", "() => inTime() && (wrote = true)"),
      pendingCaller.pattern,
      pendingCaller.wholeDecls,
    )).not.toBe(extractLeaseCallerSlice("server/core/pending.ts", pendingCode, pendingCaller.pattern, pendingCaller.wholeDecls));
    expect(extractLeaseCallerSlice(
      "server/core/pending.ts",
      pendingCode.replace("() => allowed() && !(refused = resumed())", "() => !(refused = resumed())"),
      pendingCaller.pattern,
      pendingCaller.wholeDecls,
    )).not.toBe(extractLeaseCallerSlice("server/core/pending.ts", pendingCode, pendingCaller.pattern, pendingCaller.wholeDecls));
    // the typing guard answering yes when its check throws, and the refusal that holds the pane never holding it
    const allowedBody = pendingCode.slice(pendingCode.indexOf("      const allowed = (): boolean => {"));
    const lenient = pendingCode.replace(allowedBody, allowedBody.replace(/return false;/u, "return true;"));
    expect(lenient).not.toBe(pendingCode);
    const neverHolds = pendingCode.replace("const unannounced = !wrote && error instanceof CodexOwnScreenRefusal;", "const unannounced = false;");
    expect(neverHolds).not.toBe(pendingCode);
    for (const mutated of [lenient, neverHolds]) {
      expect(extractLeaseCallerSlice("server/core/pending.ts", mutated, pendingCaller.pattern, pendingCaller.wholeDecls))
        .not.toBe(extractLeaseCallerSlice("server/core/pending.ts", pendingCode, pendingCaller.pattern, pendingCaller.wholeDecls));
    }
    // the queue no longer going behind the turn Codex's server took a message as, or behind one it says runs
    for (const taken of ["          behindCodexTurn(paneId, viaData.over);\n          noteSubmitted(", "          behindCodexTurn(paneId, viaData.over);\n          throw new HerdrError(\"pending_wait\""]) {
      const unawaited = pendingCode.replace(taken, taken.slice(taken.indexOf("\n") + 1));
      expect(unawaited).not.toBe(pendingCode);
      expect(extractLeaseCallerSlice("server/core/pending.ts", unawaited, pendingCaller.pattern, pendingCaller.wholeDecls))
        .not.toBe(extractLeaseCallerSlice("server/core/pending.ts", pendingCode, pendingCaller.pattern, pendingCaller.wholeDecls));
    }
    // The Codex steer's authorizePending moved from its writing callback to the end of its checkPane callback, an await
    // (thread/loaded/list) before the write: the calls keep their order, only the callback that owns the check changes.
    const steerWrite = "            await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);\n          }, () => {\n            authorizePending(owner, paneId, lease);\n";
    const authorizeInCheck = pendingCode.replace(steerWrite,
      "            await noMaskedPrompt(paneId, lease.sighting.facts().cols, identity);\n            authorizePending(owner, paneId, lease);\n          }, () => {\n");
    expect(pendingCode).toContain(steerWrite);
    expect(extractLeaseCallerSlice("server/core/pending.ts", authorizeInCheck, pendingCaller.pattern, pendingCaller.wholeDecls))
      .not.toBe(extractLeaseCallerSlice("server/core/pending.ts", pendingCode, pendingCaller.pattern, pendingCaller.wholeDecls));

    const terminalsCaller = CALLER_PATTERNS.find((entry) => entry.file === "server/core/terminals.ts")!;
    const terminalsCode = read("server/core/terminals.ts");
    expect(extractLeaseCallerSlice(
      "server/core/terminals.ts",
      terminalsCode.replace("holdPending(client, paneId);", "if (false) holdPending(client, paneId);"),
      terminalsCaller.pattern,
      terminalsCaller.wholeDecls,
    )).not.toBe(extractLeaseCallerSlice("server/core/terminals.ts", terminalsCode, terminalsCaller.pattern, terminalsCaller.wholeDecls));

    const routesCaller = CALLER_PATTERNS.find((entry) => entry.file === "server/workspace-routes.ts")!;
    const routes = read("server/workspace-routes.ts");
    expect(extractLeaseCallerSlice("server/workspace-routes.ts", `${routes}\nfunction extraGitRoute() { return "/api/workspace/git/log"; }\n`, routesCaller.pattern))
      .toBe(extractLeaseCallerSlice("server/workspace-routes.ts", routes, routesCaller.pattern));
    expect(extractLeaseCallerSlice("server/workspace-routes.ts", routes.replace("asked?.end();", "void 0;"), routesCaller.pattern))
      .not.toBe(extractLeaseCallerSlice("server/workspace-routes.ts", routes, routesCaller.pattern));
  });

  it("covers every Next action in view.ts and every Break* constant in a broken-*.cfg", () => {
    const dir = join(repo, ".claude/skills/verify-pending-lease");
    const tla = readFileSync(join(dir, "PendingLease.tla"), "utf8");
    const view = readFileSync(join(dir, "view.ts"), "utf8");

    const nextBlock = tla.slice(tla.indexOf("Next =="), tla.indexOf("Spec ==")).replace(/\\\*.*$/gm, "");
    const actions = [...nextBlock.matchAll(/(?<!\\)\b([A-Z][A-Za-z0-9]*)\b/g)]
      .map((m) => m[1]!)
      .filter((name) => !["Next", "Clients", "Msgs", "Over"].includes(name));
    const cases = new Set([...view.matchAll(/\bcase\s+"([A-Za-z0-9]+)"\s*:/g)].map((m) => m[1]!));
    expect(actions.filter((action) => !cases.has(action))).toEqual([]);

    const breaks = [...tla.slice(0, tla.indexOf("VARIABLES")).matchAll(/\b(Break[A-Za-z0-9]+)\b/g)].map((m) => m[1]!);
    const cfgs = readdirSync(dir).filter((name) => name.startsWith("broken-") && name.endsWith(".cfg"));
    expect(cfgs.length).toBe(breaks.length);
    for (const brk of breaks) {
      const enabledIn = cfgs.filter((cfg) => new RegExp(`\\b${brk}\\s*=\\s*TRUE\\b`).test(readFileSync(join(dir, cfg), "utf8")));
      expect(enabledIn).toHaveLength(1);
    }
  });
});
