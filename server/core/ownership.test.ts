import { describe, expect, it } from "bun:test";
import { posix } from "node:path";
import ts from "typescript-api";
import { fail, files, read } from "../../scripts/source-scan.ts";

const INDEX = new Set(["server/core", "server/core/", "server/core/index", "server/core/index.ts", "server/core/index.js"]);
const EXPORTS = ["SocketData", "connectionData", "createCore"];

const ALIASES: [string, string][] = Object.entries(
  (ts.readConfigFile("tsconfig.json", read).config as { compilerOptions: { paths: Record<string, string[]> } }).compilerOptions.paths,
).map(([alias, [path]]) => [alias.replace(/\*$/, ""), posix.normalize(path!.replace(/\*$/, ""))]);

const parse = (file: string, text: string): ts.SourceFile => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

function loads(callee: ts.Expression): boolean {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
    && (callee.expression.text === "require" && callee.name.text === "resolve" || callee.expression.text === "mock" && callee.name.text === "module");
}

function moduleNames(file: string, text: string): { name: string; line: number; partial: boolean }[] {
  const source = parse(file, text);
  const names: { name: string; line: number; partial: boolean }[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node === undefined) return;
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    if (ts.isStringLiteralLike(node)) names.push({ name: node.text, line, partial: false });
    else if (ts.isTemplateExpression(node)) names.push({ name: node.head.text, line, partial: true });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isCallExpression(node) && loads(node.expression)) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function pathOf(file: string, name: string): string | null {
  for (const [alias, folder] of ALIASES) if (name.startsWith(alias)) return posix.normalize(`${folder}/${name.slice(alias.length)}`);
  return name.startsWith(".") ? posix.normalize(posix.join(posix.dirname(file), name)) : null;
}

function reachesIntoCore(file: string, text: string): string[] {
  return moduleNames(file, text).flatMap(({ name, line, partial }) => {
    const path = pathOf(file, name);
    const inside = path !== null && (path === "server/core" || path.startsWith("server/core/")) && (partial || !INDEX.has(path));
    return inside ? [`${file}:${line}: ${name}`] : [];
  });
}

function exportedNames(file: string, text: string): string[] {
  const source = parse(file, text);
  return source.statements.flatMap((statement): string[] => {
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause === undefined) return ["*"];
      if (ts.isNamespaceExport(statement.exportClause)) return [statement.exportClause.name.text];
      return statement.exportClause.elements.map((element) => element.name.text);
    }
    if (ts.isExportAssignment(statement)) return ["default"];
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return ["default"];
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.map((declaration) => declaration.name.getText(source));
    const name = (statement as ts.DeclarationStatement).name;
    return [name === undefined ? statement.getText(source) : name.getText(source)];
  });
}

describe("the core's boundary", () => {
  it("is reached from outside only through server/core/index.ts", () => {
    const outside = files("{server,src,shared,scripts,site,telemetry,app}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}").filter((file) => !file.startsWith("server/core/"));
    fail(outside.flatMap((file) => reachesIntoCore(file, read(file))),
      "Import the core from server/core/index.ts. Its modules share the state they own by reference; reaching one from outside lets that state be held or changed where its owner does not look.");
    expect(outside).toContain("server/index.ts");
  });

  it("exports only createCore and the WebSocket's data from server/core/index.ts", () => {
    expect(exportedNames("server/core/index.ts", read("server/core/index.ts")).sort()).toEqual(EXPORTS);
  });

  it("finds every way of naming a module inside the core", () => {
    const reaching = [
      "import { createSocket } from \"./core/socket.ts\";",
      "import type { FrameHandlers } from \"./core/socket.ts\"",
      "import {\n  createSocket,\n} from \"./core/socket.ts\";",
      "import \"./core/socket.ts\";",
      "export { createSocket } from \"./core/socket.ts\";",
      "export * from \"./core/socket.ts\";",
      "import { createSocket } from \"./core/socket\";",
      "import socket = require(\"./core/socket.ts\");",
      "const socket = await import(\"./core/socket.ts\");",
      "const socket = await import(`./core/socket.ts`);",
      "const socket = await import(`./core/${name}.ts`);",
      "const socket = require(\"./core/socket.ts\");",
      "const path = require.resolve(\"./core/socket.ts\");",
      "mock.module(\"./core/socket.ts\", () => ({}));",
      "type Socket = typeof import(\"./core/socket.ts\");",
      "import { createSocket } from \"@shared/../server/core/socket.ts\";",
    ];
    for (const source of reaching) expect({ source, found: reachesIntoCore("server/fixture.ts", source).length }).toEqual({ source, found: 1 });
    expect(reachesIntoCore("scripts/fixture.ts", "import { send } from \"../server/core/connections.ts\";")).toEqual(["scripts/fixture.ts:1: ../server/core/connections.ts"]);
  });

  it("lets the index, other folders and mere mentions pass", () => {
    const passing = [
      "import { createCore } from \"./core/index.ts\";",
      "import { createCore } from \"./core/index\";",
      "import { createCore } from \"./core\";",
      "export { createCore } from \"./core/\";",
      "import { corelike } from \"./corelike.ts\";",
      "import { join } from \"node:path\";",
      "// import { createSocket } from \"./core/socket.ts\";",
      "const text = \"./core/socket.ts\";",
      "const other = await import(`./plugins/${name}.ts`);",
    ];
    for (const source of passing) expect({ source, found: reachesIntoCore("server/fixture.ts", source) }).toEqual({ source, found: [] });
  });

  it("reads every form of export", () => {
    expect(exportedNames("server/core/index.ts", "export { a } from \"./a.ts\"\nexport { b } from \"./b.ts\"")).toEqual(["a", "b"]);
    expect(exportedNames("server/core/index.ts", "export { type A, b as c } from \"./a.ts\";")).toEqual(["A", "c"]);
    expect(exportedNames("server/core/index.ts", "export * from \"./a.ts\"")).toEqual(["*"]);
    expect(exportedNames("server/core/index.ts", "export * as all from \"./a.ts\"")).toEqual(["all"]);
    expect(exportedNames("server/core/index.ts", "const a = 1\nexport { a }")).toEqual(["a"]);
    expect(exportedNames("server/core/index.ts", "export const leak = 1")).toEqual(["leak"]);
    expect(exportedNames("server/core/index.ts", "export default function f() {}")).toEqual(["default"]);
    expect(exportedNames("server/core/index.ts", "const a = 1\nexport default a")).toEqual(["default"]);
    expect(exportedNames("server/core/index.ts", "export function f() {}\nexport class C {}\nexport interface I {}\nexport type T = 1\nexport enum E { A }"))
      .toEqual(["f", "C", "I", "T", "E"]);
  });
});
