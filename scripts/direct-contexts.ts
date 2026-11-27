/**
 * Browser setups a script makes by itself, each held to its count by scripts/conventions.test.ts (the counts may only shrink):
 *
 * - Direct contexts, counted in scripts/direct-contexts.json: a call of `newContext` or `launchPersistentContext`, and
 *   `browser.newPage()`, for which Playwright makes a context of its own. Such a context has whatever the script thought
 *   of: one with the app's service worker and one without, one in the machine's language and one in English.
 *   `newContext(overrides)` of withDemoBrowser's session and `appContext(browser, overrides)` (scripts/app-context.ts)
 *   start every script from the same context instead.
 * - Demo launches, counted in scripts/demo-launches.json: a call of `launch` or `launchPersistentContext` in a script
 *   that imports scripts/demo-build.ts or scripts/demo-browser.ts, under whatever name (a second browser beside
 *   withDemoBrowser's is a launch of its own). A `*.test.ts` file is not counted here: it tests the factory or the
 *   harness, and its browser is the one it tests them with. withDemoBrowser (scripts/demo-browser.ts) builds, serves
 *   and launches the same way for all.
 *
 * The calls are read from the parsed file, not matched in its text: `a.newContext()`, `a?.newContext?.()` and
 * `a["newContext"]()` are the same call, one inside a string, a comment or a regular expression is none, and no
 * backtick in a regular expression or a nested template hides the calls after it. Nothing here knows a variable's
 * type, so a page made on a browser is told by its receiver: one named as a browser, or a launch awaited in place.
 *
 * `bun scripts/direct-contexts.ts` prints the current counts of direct contexts, `--launches` those of demo launches.
 */
import { posix } from "node:path";
import ts from "typescript-api";
import { files, read } from "./source-scan.ts";

/** The factory and the harness make the one call of each kind the scripts share. */
const SHARED = ["scripts/app-context.ts", "scripts/demo-browser.ts"];

export const browserScriptFiles = (): string[] => files("scripts/**/*.{ts,tsx,mjs,js}").filter((file) => !SHARED.includes(file));

/** `node` without the parentheses, `!`, `as` and `await` around it. */
function inner(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
  return node;
}

/** The method a call names and what it is called on: `on.name(…)`, `on?.name?.(…)`, `on["name"](…)`. Null for a plain `name(…)`. */
function method(call: ts.CallExpression): { name: string; at: ts.Node; on: ts.Expression } | null {
  const callee = inner(call.expression);
  if (ts.isPropertyAccessExpression(callee)) return { name: callee.name.text, at: callee.name, on: callee.expression };
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) return { name: callee.argumentExpression.text, at: callee.argumentExpression, on: callee.expression };
  return null;
}

function isBrowser(node: ts.Expression): boolean {
  const on = inner(node);
  if (ts.isCallExpression(on)) return method(on)?.name === "launch";
  const name = ts.isIdentifier(on) ? on.text : ts.isPropertyAccessExpression(on) ? on.name.text : null;
  return name !== null && /browser/i.test(name) && !/context/i.test(name);
}

const isDemoSetup = (file: string, specifier: string): boolean =>
  specifier.startsWith(".") && ["scripts/demo-build.ts", "scripts/demo-browser.ts"].includes(posix.normalize(posix.join(posix.dirname(file), specifier.replace(/\?.*$/, ""))));

interface Found { contexts: string[]; launches: string[] }
const scanned = new Map<string, { text: string; found: Found }>();

function scan(file: string, text: string): Found {
  const last = scanned.get(file);
  if (last?.text === text) return last.found;
  // Bun runs every script as a module, where a top-level `await (…)` is an await; a file with no import or export
  // would be parsed as a script, where it is a call of a function named await: the export at the end makes it a module
  const source = ts.createSourceFile(file, `${text}\nexport {};`, ts.ScriptTarget.Latest);
  const lines = text.split("\n");
  const where = (node: ts.Node): string => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${file}:${line + 1}: ${lines[line]!.trim().slice(0, 160)}`;
  };
  const found: Found = { contexts: [], launches: [] };
  let setsUpDemo = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
      setsUpDemo ||= isDemoSetup(file, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [first] = node.arguments;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && first !== undefined && ts.isStringLiteralLike(first)) setsUpDemo ||= isDemoSetup(file, first.text);
      const called = method(node);
      if (called !== null) {
        const { name } = called;
        if (name === "newContext" || name === "launchPersistentContext" || (name === "newPage" && isBrowser(called.on))) found.contexts.push(where(called.at));
        if (name === "launch" || name === "launchPersistentContext") found.launches.push(where(called.at));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  // a unit test that drives the factory or the harness from a browser of its own is not a demo script
  if (!setsUpDemo || file.endsWith(".test.ts")) found.launches = [];
  scanned.set(file, { text, found });
  return found;
}

export const directContexts = (file: string, text = read(file)): string[] => scan(file, text).contexts;

export const demoLaunches = (file: string, text = read(file)): string[] => scan(file, text).launches;

function countsOf(find: (file: string) => string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of browserScriptFiles()) {
    const count = find(file).length;
    if (count) counts[file] = count;
  }
  return counts;
}

export const directContextCounts = (): Record<string, number> => countsOf(directContexts);

export const demoLaunchCounts = (): Record<string, number> => countsOf(demoLaunches);

if (import.meta.main) console.log(JSON.stringify(process.argv.includes("--launches") ? demoLaunchCounts() : directContextCounts(), null, 2));
