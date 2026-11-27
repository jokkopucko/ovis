/**
 * Targeted AST pin for `.claude/skills/verify-pending-lease`: hashes only the covered lease,
 * attachment, connection, transport-guard and first-message declarations/call sites across all 13
 * covered files, with comments stripped and control-flow guards recorded. Unrelated edits in shared
 * files (`server-core.ts`, `workspace-routes.ts`, `herdr/client.ts`, `composer.ts`, `socket.ts`,
 * `pending.ts`) leave the pin unchanged, while an unverified pending-lease change fails
 * `scripts/verify-pending-lease.test.ts` in `check fast`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";
import { repo } from "./source-scan.ts";

export const PENDING_LEASE_PINS_PATH = ".claude/skills/verify-pending-lease/pins.json";

const PENDING_INPUT_LEASE_MEMBERS = new Set([
  "finish", "enqueue", "next", "claim", "settle", "discard", "hold", "holdItem", "rehold", "holdPane", "move", "close",
  // the wait for a turn's end the agent itself tells (the model's turnWait), and what a queue request asks before it is typed at once
  "awaitTurn", "turnOver", "waiting",
]);

const PENDING_INPUT_INTERFACES = new Set(["FirstMessageAsk", "PendingRecord"]);

const INPUT_GUARD_DECLS = new Set(["sightingFacts", "typingGuards"]);

const CONNECTION_FN_DECLS = new Set([
  "connectionData", "connectionOf", "mayType", "authorizeSocket", "admit", "setRole", "end",
]);

const COMPOSER_DECLS = new Set(["refusedFirstWrite", "freeClaudeBox"]);

const SKILL_ATTACH_DECLS = new Set(["herdrSkillAttachIo", "typeWithSkills"]);

/** herdr's write and the wrappers that hand it a typing guard */
const HERDR_WRITE_DECLS = new Set(["writeRequest", "herdrRpc", "paneSendText", "paneSendKeys"]);

/** Codex's own server: the steer and turn/start requests a pending message goes as, each asking its guard right before */
const CODEX_WRITE_METHODS = new Set(["steer", "startTurn"]);

export const CALLER_PATTERNS: ReadonlyArray<{ file: string; pattern: RegExp; wholeDecls?: ReadonlySet<string> }> = [
  {
    file: "server/core/pending.ts",
    wholeDecls: new Set([
      "FIRST_MESSAGE_RETRY_CODES", "pendingLease", "authorizePending", "holdPending",
      "holdPendingPane", "holdRequested", "closeConnection", "askFirstMessage", "queueFirstMessage",
      // the typing guard dispatchPendingText hands herdr, and the refusal that holds the pane (RefusedHoldPane)
      "allowed", "unannounced",
      // the queue going behind a turn Codex's own server tells the end of (SentAsTurn, DataBusy, TurnOver)
      "behindCodexTurn",
    ]),
    pattern: /\b(?:pendingAuthorities|pendingLease|authorizePending|authorizeSocket|holdPending|holdPendingPane|holdRequested|closeConnection|askFirstMessage|queueFirstMessage|typists|paneSendText|paneSendKeys|typeWithSkills|freeClaudeBox|refusedFirstWrite|behindCodexTurn|child\.client\.submit|target\.send|pending\.(?:enqueue|next|claim|settle|discard|hold|holdItem|rehold|holdPane|move|close|awaitTurn|turnOver|waiting)|item\.lease|way\.(?:at|left)|arrived)\b/,
  },
  {
    file: "server/core/terminals.ts",
    pattern: /\b(?:sightingFacts|holdPending|holdPendingPane|closeAttachment|closeAttachments|detachClaimed|dropClaims|drainingAttachments|attachment\.clients\.(?:add|delete)|client\.data\.attached\.(?:set|delete|has|get))\b/,
  },
  {
    file: "server/core/terminal-process.ts",
    pattern: /\b(?:holdPendingPane|inputReady|attachment\.ready|attachment\.held|attachment\.clients)\b/,
  },
  {
    file: "server/core/socket.ts",
    pattern: /\b(?:setRole|holdPending|end)\b/,
  },
  {
    file: "server/core/server-core.ts",
    pattern: /\b(?:createTerminalRegistry|createPendingDelivery|createConnections|createInputLane|holdPending|holdPendingPane|closeConnection|detachClaimed|dropClaims|authorizeSocket|mayType)\b/,
  },
  {
    file: "server/workspace-routes.ts",
    pattern: /\bfirstMessages\.(?:ask|queue)\b|\basked(?:\?\.)?\.(?:at|end)\b|\basked\?\.(?:at|end)\b/,
  },
];

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
      // which callback of a call holds the node: a lease check in target.send's checkPane is not one in its writing
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

function extractNamedDeclarations(file: string, code: string, names: ReadonlySet<string>): string {
  const sf = parseSource(file, code);
  const chunks: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name && names.has(node.name.text)) {
      chunks.push(`fn:${node.name.text}\n${printer.printNode(ts.EmitHint.Unspecified, node, sf)}`);
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text)) {
      chunks.push(`var:${node.name.text}\n${printer.printNode(ts.EmitHint.Unspecified, node, sf)}`);
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return chunks.join("\n---\n");
}

export function extractInputGuardLeaseSlice(code: string): string {
  return extractNamedDeclarations("server/input-guard.ts", code, INPUT_GUARD_DECLS);
}

export function extractPendingInputLeaseSlice(code: string): string {
  const sf = parseSource("server/pending-input.ts", code);
  const chunks: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && PENDING_INPUT_INTERFACES.has(stmt.name.text)) {
      chunks.push(`interface:${stmt.name.text}\n${printer.printNode(ts.EmitHint.Unspecified, stmt, sf)}`);
    } else if (ts.isClassDeclaration(stmt) && stmt.name?.text === "PendingInputs") {
      for (const member of stmt.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
        if (name && PENDING_INPUT_LEASE_MEMBERS.has(name)) {
          chunks.push(`PendingInputs.${name}\n${printer.printNode(ts.EmitHint.Unspecified, member, sf)}`);
        }
      }
    }
  }
  return chunks.join("\n---\n");
}

export function extractConnectionsLeaseSlice(code: string): string {
  return extractNamedDeclarations("server/core/connections.ts", code, CONNECTION_FN_DECLS);
}

export function extractHerdrClientWriteSlice(code: string): string {
  return extractNamedDeclarations("server/herdr/client.ts", code, HERDR_WRITE_DECLS);
}

export function extractCodexWriteSlice(code: string): string {
  const sf = parseSource("server/approvals/codex.ts", code);
  const chunks: string[] = [];
  for (const stmt of sf.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name?.text === "Connection") {
      for (const member of stmt.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
        if (name && CODEX_WRITE_METHODS.has(name)) chunks.push(`Connection.${name}\n${printer.printNode(ts.EmitHint.Unspecified, member, sf)}`);
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === "servedTurn") {
      chunks.push(`fn:servedTurn\n${printer.printNode(ts.EmitHint.Unspecified, stmt, sf)}`);
    }
  }
  return chunks.join("\n---\n");
}

export function extractComposerLeaseSlice(code: string): string {
  return extractNamedDeclarations("server/core/composer.ts", code, COMPOSER_DECLS);
}

export function extractSkillAttachLeaseSlice(code: string): string {
  return extractNamedDeclarations("server/opencode-skill-attach.ts", code, SKILL_ATTACH_DECLS);
}

export function extractInputSerializeSlice(code: string): string {
  return extractNamedDeclarations("server/core/input.ts", code, new Set(["serialize"]));
}

export function extractLeaseCallerSlice(
  file: string,
  code: string,
  pattern: RegExp,
  wholeDecls?: ReadonlySet<string>,
): string {
  const sf = parseSource(file, code);
  const hits: string[] = [];
  function visit(node: ts.Node): void {
    if (wholeDecls) {
      if (ts.isFunctionDeclaration(node) && node.name && wholeDecls.has(node.name.text)) {
        hits.push(`decl-fn:${node.name.text}\n${printer.printNode(ts.EmitHint.Unspecified, node, sf)}`);
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && wholeDecls.has(node.name.text)) {
        hits.push(`decl-var:${node.name.text}\n${printer.printNode(ts.EmitHint.Unspecified, node, sf)}`);
        return;
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = printer.printNode(ts.EmitHint.Unspecified, node.expression, sf);
      if (pattern.test(callee)) {
        hits.push(`${controlContextPath(node, sf)} => call:${elideBlockBodies(node, sf)}`);
      }
    } else if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
      const left = printer.printNode(ts.EmitHint.Unspecified, node.left, sf);
      const right = ts.isCallExpression(node.right) ? "" : elideBlockBodies(node.right, sf);
      if (pattern.test(left) || (right && pattern.test(right))) {
        hits.push(`${controlContextPath(node, sf)} => assign:${elideBlockBodies(node, sf)}`);
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const parent = node.parent;
      const isCallee = ts.isCallExpression(parent) && parent.expression === node;
      const isOuterProp = ts.isPropertyAccessExpression(parent) && parent.expression === node;
      if (!isCallee && !isOuterProp) {
        const printed = printer.printNode(ts.EmitHint.Unspecified, node, sf);
        if (pattern.test(printed)) {
          hits.push(`${controlContextPath(node, sf)} => prop:${printed.replace(/\s+/g, " ").trim()}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits.join("\n");
}

export function computePendingLeasePins(readText: (relPath: string) => string = (relPath) => readFileSync(join(repo, relPath), "utf8")): Record<string, string> {
  const pins: Record<string, string> = {
    "server/input-guard.ts#pendingLease": sha256(extractInputGuardLeaseSlice(readText("server/input-guard.ts"))),
    "server/pending-input.ts#lease": sha256(extractPendingInputLeaseSlice(readText("server/pending-input.ts"))),
    "server/core/connections.ts#lease": sha256(extractConnectionsLeaseSlice(readText("server/core/connections.ts"))),
    "server/herdr/client.ts#writeRequest": sha256(extractHerdrClientWriteSlice(readText("server/herdr/client.ts"))),
    "server/approvals/codex.ts#write": sha256(extractCodexWriteSlice(readText("server/approvals/codex.ts"))),
    "server/core/composer.ts#lease": sha256(extractComposerLeaseSlice(readText("server/core/composer.ts"))),
    "server/opencode-skill-attach.ts#lease": sha256(extractSkillAttachLeaseSlice(readText("server/opencode-skill-attach.ts"))),
    "server/core/input.ts#serialize": sha256(extractInputSerializeSlice(readText("server/core/input.ts"))),
  };
  for (const { file, pattern, wholeDecls } of CALLER_PATTERNS) {
    pins[`${file}#lease-calls`] = sha256(extractLeaseCallerSlice(file, readText(file), pattern, wholeDecls));
  }
  return pins;
}

export function diffPendingLeasePins(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): string[] {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  return keys.filter((key) => expected[key] !== actual[key]).map((key) => `${key}: expected ${expected[key] ?? "absent"}, got ${actual[key] ?? "absent"}`);
}

if (import.meta.main) {
  const record = process.argv.includes("--record");
  const target = join(repo, PENDING_LEASE_PINS_PATH);
  const actual = computePendingLeasePins();
  if (record) {
    writeFileSync(target, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`recorded ${PENDING_LEASE_PINS_PATH}`);
    process.exit(0);
  }
  const expected = JSON.parse(readFileSync(target, "utf8")) as Record<string, string>;
  const diffs = diffPendingLeasePins(expected, actual);
  if (diffs.length > 0) {
    console.error(`Pending-lease pins drifted (${PENDING_LEASE_PINS_PATH}):\n  ${diffs.join("\n  ")}`);
    process.exit(1);
  }
  console.log("pending-lease pins match");
}
