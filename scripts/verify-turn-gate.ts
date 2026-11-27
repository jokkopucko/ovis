/**
 * Targeted AST pin for `.claude/skills/verify-turn-gate`: hashes only the covered turn-gate
 * declarations in `server/pending-input.ts`, `server/codex-steering.ts`, `server/completion.ts`
 * and `server/core/input.ts` plus the call sites and control-flow guards in
 * `server/core/{pending,status,server-core}.ts` and `server/collector.ts` that read or mutate the
 * turn gate, with comments stripped. Unrelated edits in those shared files leave the pin unchanged,
 * while an unverified turn-gate change fails `scripts/verify-turn-gate.test.ts` in `check fast`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";
import { repo } from "./source-scan.ts";

export const TURN_GATE_PINS_PATH = ".claude/skills/verify-turn-gate/pins.json";

const PENDING_INPUT_MEMBERS = new Set([
  "resend", "expireResends", "holdQueued", "finish", "enqueue", "next", "claim", "committing",
  "typedAtOnce", "settle", "confirmRecorded", "discard", "mark", "current", "status", "baseline",
  "observe", "read", "waiting", "forget", "apply", "hold", "holdItem", "rehold", "holdPane",
  "move", "close", "expire", "blocksQueue", "awaitTurn", "turnOver", "finished",
]);

const PENDING_INPUT_VARS = new Set(["ready", "PENDING_START_TIMEOUT_MS"]);

const CODEX_STEERING_DECLS = new Set([
  "codexSteeringPending", "agySteeringPending", "SEND_NOW", "interruptCodexSteering",
]);

const COMPLETION_MEMBERS = new Set([
  "observe", "replayed", "resync", "current", "readSnapshot", "present", "project", "forget", "drop", "record",
]);

const CALLER_FILES = [
  "server/core/pending.ts",
  "server/core/status.ts",
  "server/core/server-core.ts",
  "server/collector.ts",
] as const;

const GATE_CALL_PATTERN = /\bpending\.(?:status|observe|baseline|mark|current|waiting|next|claim|committing|typedAtOnce|settle|confirmRecorded|discard|enqueue|hold|holdQueued|holdItem|rehold|holdPane|move|forget|expire|resend|close|awaitTurn|turnOver)\b|\b(?:committing|behindCodexTurn|interruptCodexSteering|pendingContext|holdPending|holdPendingPane|movePendingPane|drainPending|deliverySnapshot|clientSnapshot|reconcileCodexDeliveries|steerMark|enterMark)\b|\bhandlers\.onBaseline\b|\bonBaseline\b|\bdeps\.snapshot\b/;

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function parseSource(file: string, code: string): ts.SourceFile {
  return ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function elideBlockBodies<T extends ts.Node>(root: T, sf: ts.SourceFile): string {
  const result = ts.transform(root, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) && node.body && ts.isBlock(node.body)) {
          const emptyBlock = context.factory.createBlock([]);
          if (ts.isArrowFunction(node)) {
            return context.factory.updateArrowFunction(node, node.modifiers, node.typeParameters, node.parameters, node.type, node.equalsGreaterThanToken, emptyBlock);
          }
          if (ts.isFunctionExpression(node)) {
            return context.factory.updateFunctionExpression(node, node.modifiers, node.asteriskToken, node.name, node.typeParameters, node.parameters, node.type, emptyBlock);
          }
          if (ts.isMethodDeclaration(node)) {
            return context.factory.updateMethodDeclaration(node, node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, node.parameters, node.type, emptyBlock);
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (node) => ts.visitEachChild(node, visit, context);
    },
  ]);
  const printed = printer.printNode(ts.EmitHint.Unspecified, result.transformed[0]!, sf);
  result.dispose();
  return printed.replace(/\s+/g, " ").trim();
}

function containsNode(ancestor: ts.Node, target: ts.Node): boolean {
  return target.pos >= ancestor.pos && target.end <= ancestor.end;
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function isLogicalOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.AmpersandAmpersandToken
    || kind === ts.SyntaxKind.BarBarToken
    || kind === ts.SyntaxKind.QuestionQuestionToken;
}

function controlContextPath(node: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = [];
  for (let cur: ts.Node | undefined = node.parent; cur && !ts.isSourceFile(cur); cur = cur.parent) {
    if ((ts.isFunctionDeclaration(cur) || ts.isMethodDeclaration(cur)) && cur.name && ts.isIdentifier(cur.name)) {
      parts.unshift(`fn:${cur.name.text}`);
    } else if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      parts.unshift(`var:${cur.name.text}`);
    } else if (ts.isPropertyAssignment(cur) && (ts.isIdentifier(cur.name) || ts.isStringLiteral(cur.name))) {
      parts.unshift(`prop:${cur.name.text}`);
    } else if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && ts.isCallExpression(cur.parent) && cur.parent.arguments.includes(cur)) {
      // which callback of a call holds the node: a commit in target.send's checkPane is not one in its writing
      parts.unshift(`arg${cur.parent.arguments.indexOf(cur)}(${printer.printNode(ts.EmitHint.Unspecified, cur.parent.expression, sf)})`);
    } else if (ts.isIfStatement(cur)) {
      if (containsNode(cur.thenStatement, node)) parts.unshift(`if(${elideBlockBodies(cur.expression, sf)})`);
      else if (cur.elseStatement && containsNode(cur.elseStatement, node)) parts.unshift(`else(${elideBlockBodies(cur.expression, sf)})`);
    } else if (ts.isConditionalExpression(cur)) {
      if (containsNode(cur.whenTrue, node)) parts.unshift(`?(${elideBlockBodies(cur.condition, sf)})`);
      else if (containsNode(cur.whenFalse, node)) parts.unshift(`:(${elideBlockBodies(cur.condition, sf)})`);
    } else if (ts.isBinaryExpression(cur) && isLogicalOperator(cur.operatorToken.kind) && containsNode(cur.right, node)) {
      parts.unshift(`${cur.operatorToken.getText(sf)}(${elideBlockBodies(cur.left, sf)})`);
    } else if (ts.isForOfStatement(cur) && containsNode(cur.statement, node)) {
      parts.unshift(`forOf(${elideBlockBodies(cur.initializer, sf)} of ${elideBlockBodies(cur.expression, sf)})`);
    } else if (ts.isForInStatement(cur) && containsNode(cur.statement, node)) {
      parts.unshift(`forIn(${elideBlockBodies(cur.initializer, sf)} in ${elideBlockBodies(cur.expression, sf)})`);
    } else if ((ts.isWhileStatement(cur) || ts.isDoStatement(cur)) && containsNode(cur.statement, node)) {
      parts.unshift(`while(${elideBlockBodies(cur.expression, sf)})`);
    } else if (ts.isCaseClause(cur) && !containsNode(cur.expression, node)) {
      parts.unshift(`case(${elideBlockBodies(cur.expression, sf)})`);
    } else if (ts.isCatchClause(cur)) {
      parts.unshift("catch");
    }
  }
  return parts.join(" > ") || "<top>";
}

export function extractPendingInputGateSlice(code: string): string {
  const sf = parseSource("server/pending-input.ts", code);
  const chunks: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === "TurnGate") {
      chunks.push(`interface:TurnGate\n${printer.printNode(ts.EmitHint.Unspecified, stmt, sf)}`);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && PENDING_INPUT_VARS.has(decl.name.text)) {
          chunks.push(`var:${decl.name.text}\n${printer.printNode(ts.EmitHint.Unspecified, decl, sf)}`);
        }
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name?.text === "PendingInputs") {
      for (const member of stmt.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
        if (name && PENDING_INPUT_MEMBERS.has(name)) {
          chunks.push(`PendingInputs.${name}\n${printer.printNode(ts.EmitHint.Unspecified, member, sf)}`);
        }
      }
    }
  }
  return chunks.join("\n---\n");
}

export function extractCodexSteeringSlice(code: string): string {
  const sf = parseSource("server/codex-steering.ts", code);
  const chunks: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && CODEX_STEERING_DECLS.has(stmt.name.text)) {
      chunks.push(`fn:${stmt.name.text}\n${printer.printNode(ts.EmitHint.Unspecified, stmt, sf)}`);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && CODEX_STEERING_DECLS.has(decl.name.text)) {
          chunks.push(`var:${decl.name.text}\n${printer.printNode(ts.EmitHint.Unspecified, decl, sf)}`);
        }
      }
    }
  }
  return chunks.join("\n---\n");
}

export function extractCompletionSlice(code: string): string {
  const sf = parseSource("server/completion.ts", code);
  const chunks: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === "CompletionTracker") {
      for (const member of stmt.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
        if (name && COMPLETION_MEMBERS.has(name)) {
          chunks.push(`CompletionTracker.${name}\n${printer.printNode(ts.EmitHint.Unspecified, member, sf)}`);
        }
      }
    }
  }
  return chunks.join("\n---\n");
}

export function extractInputSerializeSlice(code: string): string {
  const sf = parseSource("server/core/input.ts", code);
  const chunks: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "serialize") {
      chunks.push(`fn:serialize\n${printer.printNode(ts.EmitHint.Unspecified, node, sf)}`);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return chunks.join("\n---\n");
}

export function extractCallerGateSlice(file: string, code: string): string {
  const sf = parseSource(file, code);
  const hits: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = printer.printNode(ts.EmitHint.Unspecified, node.expression, sf);
      if (GATE_CALL_PATTERN.test(callee)) {
        hits.push(`${controlContextPath(node, sf)} => call:${elideBlockBodies(node, sf)}`);
      }
    } else if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const left = printer.printNode(ts.EmitHint.Unspecified, node.left, sf);
      const right = ts.isCallExpression(node.right) ? "" : elideBlockBodies(node.right, sf);
      if (GATE_CALL_PATTERN.test(left) || (right && GATE_CALL_PATTERN.test(right))) {
        hits.push(`${controlContextPath(node, sf)} => assign:${elideBlockBodies(node, sf)}`);
      }
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && GATE_CALL_PATTERN.test(node.name.text) && node.initializer && !ts.isCallExpression(node.initializer)) {
      hits.push(`${controlContextPath(node, sf)} => decl:${node.name.text} = ${elideBlockBodies(node.initializer, sf)}`);
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "onBaseline") {
      hits.push(`${controlContextPath(node, sf)} => prop:${elideBlockBodies(node, sf)}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits.join("\n");
}

export function computeTurnGatePins(readText: (relPath: string) => string = (relPath) => readFileSync(join(repo, relPath), "utf8")): Record<string, string> {
  const pins: Record<string, string> = {
    "server/pending-input.ts#TurnGate": sha256(extractPendingInputGateSlice(readText("server/pending-input.ts"))),
    "server/codex-steering.ts#SEND_NOW": sha256(extractCodexSteeringSlice(readText("server/codex-steering.ts"))),
    "server/completion.ts#readSnapshot": sha256(extractCompletionSlice(readText("server/completion.ts"))),
    "server/core/input.ts#serialize": sha256(extractInputSerializeSlice(readText("server/core/input.ts"))),
  };
  for (const file of CALLER_FILES) {
    pins[`${file}#gate-calls`] = sha256(extractCallerGateSlice(file, readText(file)));
  }
  return pins;
}

export function diffTurnGatePins(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): string[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return keys.filter((key) => expected[key] !== actual[key]).map((key) => `${key}: expected ${expected[key] ?? "absent"}, got ${actual[key] ?? "absent"}`);
}

if (import.meta.main) {
  const record = process.argv.includes("--record");
  const target = join(repo, TURN_GATE_PINS_PATH);
  const actual = computeTurnGatePins();
  if (record) {
    writeFileSync(target, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`recorded ${TURN_GATE_PINS_PATH}`);
    process.exit(0);
  }
  const expected = JSON.parse(readFileSync(target, "utf8")) as Record<string, string>;
  const diffs = diffTurnGatePins(expected, actual);
  if (diffs.length > 0) {
    console.error(`Turn-gate pins drifted (${TURN_GATE_PINS_PATH}):\n  ${diffs.join("\n  ")}`);
    process.exit(1);
  }
  console.log("turn-gate pins match");
}
