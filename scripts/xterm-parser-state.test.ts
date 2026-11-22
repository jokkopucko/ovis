/**
 * `Terminal.oscStringState()` (patches/@xterm%2Fxterm@6.0.0.patch) reads private parser fields
 * by their owning classes: EscapeSequenceParser.currentState and _oscParser, OscParser._state and
 * _id, and the ParserState/OscState values those fields hold. PaneTerminal decides from it whether
 * a replayed OSC may still dispatch as a clipboard write. These checks read the installed xterm
 * source as TypeScript, so an xterm upgrade that renames a field or renumbers a state fails here:
 * port the accessor to the new parser (and rerun scripts/replay-clipboard-demo-regression.ts),
 * never loosen this check.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";

const xterm = join(import.meta.dir, "../node_modules/@xterm/xterm");
const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(join(xterm, "src", file), "utf8"), ts.ScriptTarget.Latest, true);

function classOf(source: ts.SourceFile, name: string): ts.ClassDeclaration {
  const found = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === name);
  if (!found) throw new Error(`${source.fileName} declares no class ${name}`);
  return found;
}

const memberNames = (node: ts.ClassDeclaration): string[] =>
  node.members.flatMap((member) => member.name && ts.isIdentifier(member.name) ? [member.name.text] : []);

function enumOf(source: ts.SourceFile, name: string): Record<string, number> {
  const found = source.statements.find((node): node is ts.EnumDeclaration => ts.isEnumDeclaration(node) && node.name.text === name);
  if (!found) throw new Error(`${source.fileName} declares no enum ${name}`);
  return Object.fromEntries(found.members.map((member) => {
    if (!member.initializer || !ts.isNumericLiteral(member.initializer)) throw new Error(`${name}.${member.name.getText()} has no literal value`);
    return [member.name.getText(), Number(member.initializer.text)];
  }));
}

function methodBody(node: ts.ClassDeclaration, name: string): string {
  const method = node.members.find((member): member is ts.MethodDeclaration =>
    ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.name.text === name);
  if (!method?.body) throw new Error(`${node.name?.text} has no method ${name}`);
  return method.body.getText().replace(/\s+/g, " ");
}

describe("xterm parser state behind oscStringState", () => {
  it("is xterm 6.0.0, the version the accessor was ported to", () => {
    expect(JSON.parse(readFileSync(join(xterm, "package.json"), "utf8")).version).toBe("6.0.0");
  });

  it("keeps the parser fields the accessor reads", () => {
    const escape = classOf(parse("common/parser/EscapeSequenceParser.ts"), "EscapeSequenceParser");
    expect(memberNames(escape)).toEqual(expect.arrayContaining(["currentState", "_oscParser"]));
    const osc = classOf(parse("common/parser/OscParser.ts"), "OscParser");
    expect(memberNames(osc)).toEqual(expect.arrayContaining(["_state", "_id"]));
  });

  it("keeps the state values the accessor compares", () => {
    const constants = parse("common/parser/Constants.ts");
    expect(enumOf(constants, "OscState")).toEqual({ START: 0, ID: 1, PAYLOAD: 2, ABORT: 3 });
    expect(enumOf(constants, "ParserState").OSC_STRING).toBe(8);
  });

  it("reads each field in its owning class", () => {
    const escape = classOf(parse("common/parser/EscapeSequenceParser.ts"), "EscapeSequenceParser");
    expect(methodBody(escape, "oscStringState")).toBe("{ return { open: this.currentState === ParserState.OSC_STRING, ...this._oscParser.stringState() }; }");
    const osc = classOf(parse("common/parser/OscParser.ts"), "OscParser");
    expect(methodBody(osc, "stringState")).toBe("{ return { id: this._id, idComplete: this._state === OscState.PAYLOAD }; }");
    expect(methodBody(classOf(parse("common/InputHandler.ts"), "InputHandler"), "oscStringState")).toBe("{ return this._parser.oscStringState(); }");
    expect(methodBody(classOf(parse("common/CoreTerminal.ts"), "CoreTerminal"), "oscStringState")).toBe("{ return this._inputHandler.oscStringState(); }");
    expect(methodBody(classOf(parse("browser/public/Terminal.ts"), "Terminal"), "oscStringState")).toBe("{ return this._core.oscStringState(); }");
  });

  it("declares the accessor in the package's public typings", () => {
    const typings = readFileSync(join(xterm, "typings/xterm.d.ts"), "utf8");
    expect(typings).toContain("oscStringState(): IOscStringState;");
    expect(typings).toMatch(/export interface IOscStringState \{\s*open: boolean;\s*id: number;\s*idComplete: boolean;\s*\}/);
  });
});
