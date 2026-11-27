import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript-api";
import { readers } from "./dialogs/index.ts";
import { AGENT_SOURCES } from "./skills/index.ts";
import { files, read } from "../scripts/source-scan.ts";

const registeredReaderIds = new Set(readers.map(({ id }) => id));
const emptyContext = (home: string) => ({
  home,
  cwd: null,
  repoRoot: null,
  env: null,
  roots: {},
});

function parse(source: string, fileName = "source.ts"): ts.SourceFile {
  const scriptKind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".js") || fileName.endsWith(".mjs")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
}

function stripExpr(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return stripExpr(expression.expression);
  }
  return expression;
}

function forbiddenDeclarations(source: string, fileName?: string): string[] {
  const violations: string[] = [];
  const checkBinding = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      if (name.text === "unrepresentable" || name.text === "TERMINAL_ONLY_COMMANDS") {
        violations.push(name.text);
      }
    } else {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) checkBinding(element.name);
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      checkBinding(node.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, fileName));
  return violations;
}

/**
 * The Codex approval adapter subscribes to its threads to receive their approvals (`thread/resume` with no overrides),
 * reads when a turn starts (`turn/started`), and starts a turn of the pane's own thread for a plain chat message to an
 * idle Codex (`turn/start`, never a command): those three names only, there.
 */
const CODEX_APPROVALS = { file: "server/approvals/codex.ts", names: new Set(["thread/resume", "turn/started", "turn/start"]) };

/** OpenCode's command route, only where commands sent as data call it (docs/agent-commands.md#commands-sent-as-data). */
const OPENCODE_COMMAND = { file: "server/opencode-service.ts", text: "/api/session/${}/command" };

function forbiddenBoundaryLiterals(source: string, fileName?: string): string[] {
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    const text = ts.isStringLiteralLike(node)
      ? node.text
      : ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map((span) => "${}" + span.literal.text).join("")
        : undefined;
    if (text !== undefined && !(fileName === CODEX_APPROVALS.file && CODEX_APPROVALS.names.has(text))
      && !(fileName === OPENCODE_COMMAND.file && text === OPENCODE_COMMAND.text)) {
      if (
        text.includes("/tui/") ||
        ["service.ensure", "turn/start", "thread/resume", "skill.invoke"].some((method) => text.includes(method)) ||
        /\/api\/session\/[^/]+\/command(?:[/?#]|$)/.test(text) ||
        // Only the terminal attachment may take over, after an explicit user request.
        (text.includes("--takeover") && fileName !== "server/core/terminal-process.ts" && fileName !== "server/windows-control.ts")
      ) {
        violations.push(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, fileName));
  return violations;
}

function forbiddenProcessOperations(source: string, fileName?: string): string[] {
  const violations: string[] = [];
  const isProcessModule = (node: ts.Expression | undefined): boolean =>
    node !== undefined &&
    ts.isStringLiteralLike(node) &&
    (node.text === "node:child_process" || node.text === "child_process");
  const isBun = (expression: ts.Expression): boolean => {
    const node = stripExpr(expression);
    return (
      (ts.isIdentifier(node) && node.text === "Bun") ||
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "globalThis" &&
        node.name.text === "Bun") ||
      (ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "globalThis" &&
        node.argumentExpression !== undefined &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "Bun")
    );
  };
  const spawnMember = (node: ts.Expression): string | undefined => {
    node = stripExpr(node);
    if (ts.isPropertyAccessExpression(node) && isBun(node.expression)) {
      return node.name.text;
    }
    if (ts.isElementAccessExpression(node) && isBun(node.expression) && node.argumentExpression !== undefined) {
      const argument = stripExpr(node.argumentExpression);
      if (ts.isStringLiteralLike(argument)) return argument.text;
    }
    return undefined;
  };
  const hasSpawnBinding = (name: ts.BindingName): string[] => {
    if (ts.isIdentifier(name)) return [];
    return name.elements.flatMap((element) => {
      if (!ts.isBindingElement(element)) return [];
      const property = element.propertyName ?? element.name;
      let propertyName: string | undefined;
      if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) {
        propertyName = property.text;
      } else if (ts.isComputedPropertyName(property) && ts.isStringLiteralLike(property.expression)) {
        propertyName = property.expression.text;
      }
      const found = propertyName === "spawn" || propertyName === "spawnSync" ? [propertyName] : [];
      return [...found, ...hasSpawnBinding(element.name)];
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isProcessModule(node.moduleSpecifier)) {
      violations.push("child_process import");
    } else if (ts.isExportDeclaration(node) && isProcessModule(node.moduleSpecifier)) {
      violations.push("child_process import");
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isProcessModule(node.moduleReference.expression)
    ) {
      violations.push("child_process import");
    } else if (
      ts.isCallExpression(node) &&
      ((node.expression.kind === ts.SyntaxKind.ImportKeyword && isProcessModule(node.arguments[0])) ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require" &&
          isProcessModule(node.arguments[0])))
    ) {
      violations.push("child_process import");
    } else if (ts.isCallExpression(node)) {
      const member = spawnMember(node.expression);
      if (member === "spawn" || member === "spawnSync") {
        violations.push(`Bun.${member}`);
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined && isBun(node.initializer)) {
      violations.push(...hasSpawnBinding(node.name).map((member) => `Bun.${member} destructuring`));
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, fileName));
  return violations;
}

describe("agent command catalog conventions", () => {
  it("maps every dialog form to a registered reader", () => {
    const home = mkdtempSync(join(tmpdir(), "catalog-conventions-"));
    try {
      for (const [agent, source] of Object.entries(AGENT_SOURCES)) {
        const forms = Object.entries(source.forms ?? {}).flatMap(([command, commandForms]) =>
          commandForms.map((form) => ({ command, form })),
        );
        const discovered = source.discover(emptyContext(home));
        const discoveredForms = discovered.flatMap((command) =>
          (command.forms ?? []).map((form) => ({ command: command.name, form })),
        );
        for (const { command, form } of [...forms, ...discoveredForms]) {
          if (form.interaction === "dialog") {
            const dialog = "dialog" in form ? form.dialog : undefined;
            expect(
              registeredReaderIds.has(dialog ?? ""),
              `${agent} /${command} names unregistered dialog reader "${dialog ?? ""}"`,
            ).toBe(true);
          }
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("covers every registered dialog reader in a server test", () => {
    const testFiles = files("server/**/*.test.ts").filter((file) => file !== "server/catalog.conventions.test.ts");
    const testSources = testFiles.map((file) => [file, read(file)] as const);
    for (const { id } of readers) {
      const coveringFile = testSources.find(([, source]) => source.includes(id))?.[0];
      expect(coveringFile, `dialog reader "${id}" has no server test`).toBeDefined();
    }
  });

  it("pins every static builtin table", () => {
    for (const [agent, source] of Object.entries(AGENT_SOURCES)) {
      if (source.builtins.length > 0) {
        const pins = [source.pin ?? []].flat();
        expect(pins.length > 0 && pins.every((pin) => pin.trim() !== ""), `${agent} has builtins but no version pin`).toBeTrue();
      }
    }
  });

  it("does not declare unrepresentable catalog entries or terminal-only lists", () => {
    const candidates = [...files("server/**/*.{ts,mjs,js}"), ...files("src/**/*.{ts,tsx,mjs,js}")];
    for (const file of candidates) {
      expect(forbiddenDeclarations(read(file), file), `${file} declares forbidden catalog state`).toEqual([]);
    }
  }, 60_000);

  it("keeps non-test code inside the agent command boundaries", () => {
    const candidates = [
      ...files("server/**/*.{ts,tsx,mjs,js}"),
      ...files("src/**/*.{ts,tsx,mjs,js}"),
      ...files("shared/**/*.{ts,tsx,mjs,js}"),
    ].filter((file) => !/\.(?:test|spec)\.[^.]+$/.test(file));
    for (const file of candidates) {
      const violations = forbiddenBoundaryLiterals(read(file), file);
      expect(
        violations,
        `${file} contains forbidden agent command literals: ${JSON.stringify(violations)}. ` +
          "Send commands through the catalog and normal terminal submit path, not raw agent API calls " +
          "(docs/agent-commands.md#the-three-contracts). Keep --takeover only in the user-requested terminal attachment path.",
      ).toEqual([]);
    }
  }, 60_000);

  it("finds forbidden boundaries in strings and template literals", () => {
    for (const literal of [
      '"/tui/command"',
      '"service.ensure"',
      "'turn/start'",
      "`thread/resume`",
      "`skill.invoke`",
      '"/api/session/example/command"',
      "`/api/session/${id}/command`",
      "`https://${host}/api/session/${id}/command?sync=true`",
      "`/tui/${command}`",
      '"--takeover"',
    ]) {
      expect(forbiddenBoundaryLiterals(`const value = ${literal};`), literal).toHaveLength(1);
    }
  });

  it("ignores boundary wording in comments and unrelated routes", () => {
    expect(
      forbiddenBoundaryLiterals(
        [
          '// "/tui/command" "service.ensure" "turn/start" "--takeover"',
          '/* `thread/resume` "skill.invoke" "/api/session/example/command" */',
          'const route = "/api/pane/prompt/answer";',
          'const other = "/api/session/example/commands";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("allows takeover only in the user-requested terminal attachment path", () => {
    const source = 'args.push("--takeover"); const method = "service.ensure";';
    expect(forbiddenBoundaryLiterals(source, "server/core/terminal-process.ts")).toEqual(["service.ensure"]);
    expect(forbiddenBoundaryLiterals(source, "server/windows-control.ts")).toEqual(["service.ensure"]);
    expect(forbiddenBoundaryLiterals(source, "server/other.ts")).toEqual(["--takeover", "service.ensure"]);
  });

  it("keeps catalog readers and process metadata free of child processes", () => {
    const candidates = [
      ...files("server/skills/*.ts"),
      ...["server/session-history.ts", "server/agent-version.ts", "server/codex-daemon.ts", "server/catalog-sources.ts"].filter((file) =>
        files(file).includes(file),
      ),
    ];
    for (const file of candidates) {
      expect(forbiddenProcessOperations(read(file), file), `${file} uses a forbidden process operation`).toEqual([]);
    }
  });

  it("finds multiline child_process imports", () => {
    expect(forbiddenProcessOperations('import {\n  spawn,\n} from "node:child_process";')).toContain("child_process import");
  });

  it("finds child_process exports and import-equals declarations", () => {
    expect(
      forbiddenProcessOperations(
        [
          'export * from "node:child_process";',
          'export { spawn } from "child_process";',
          'import childProcess = require("node:child_process");',
        ].join("\n"),
      ),
    ).toEqual(["child_process import", "child_process import", "child_process import"]);
  });

  it("ignores forbidden declaration wording in test titles", () => {
    expect(
      forbiddenDeclarations(
        '// const unrepresentable; TERMINAL_ONLY_COMMANDS\n' +
          'const title = "const unrepresentable";\n' +
          'it("const unrepresentable is only a title", () => {});',
      ),
    ).toEqual([]);
  });

  it("finds forbidden variable declarations", () => {
    expect(forbiddenDeclarations("const unrepresentable = [];")).toEqual(["unrepresentable"]);
  });

  it("finds forbidden names in destructured variable bindings", () => {
    expect(
      forbiddenDeclarations(
        [
          "const { unrepresentable } = x;",
          "const { a: unrepresentable } = x;",
          "const { nested: { TERMINAL_ONLY_COMMANDS } } = x;",
          "const [TERMINAL_ONLY_COMMANDS] = x;",
        ].join("\n"),
      ),
    ).toEqual(["unrepresentable", "unrepresentable", "TERMINAL_ONLY_COMMANDS", "TERMINAL_ONLY_COMMANDS"]);
  });

  it("allows forbidden names as class properties", () => {
    expect(
      forbiddenDeclarations("class Example { unrepresentable = []; TERMINAL_ONLY_COMMANDS = []; }"),
    ).toEqual([]);
  });

  it("finds bracket and globalThis Bun spawn calls", () => {
    expect(
      forbiddenProcessOperations(
        [
          'Bun["spawn"](["not-executed"]);',
          'Bun["spawnSync"](["not-executed"]);',
          'globalThis.Bun.spawn(["not-executed"]);',
          'globalThis.Bun["spawnSync"](["not-executed"]);',
        ].join("\n"),
      ),
    ).toEqual(["Bun.spawn", "Bun.spawnSync", "Bun.spawn", "Bun.spawnSync"]);
  });

  it("unwraps Bun receivers in spawn calls", () => {
    expect(
      forbiddenProcessOperations(
        [
          'globalThis["Bun"].spawn(["not-executed"]);',
          "(Bun).spawn([\"not-executed\"]);",
          "(Bun as any).spawn([\"not-executed\"]);",
          'Bun!.spawn(["not-executed"]);',
          'globalThis[`Bun`].spawn(["not-executed"]);',
        ].join("\n"),
      ),
    ).toEqual(["Bun.spawn", "Bun.spawn", "Bun.spawn", "Bun.spawn", "Bun.spawn"]);
  });

  it("finds Bun spawn properties destructured from Bun", () => {
    expect(
      forbiddenProcessOperations(
        [
          "const { spawn } = Bun;",
          "const { spawn: launch } = Bun;",
          "const { nested: { spawn: launch } } = globalThis.Bun;",
          "const [, { spawnSync }] = Bun;",
          'const { ["spawn"] : run } = Bun;',
          "const { spawn } = anotherObject;",
        ].join("\n"),
      ),
    ).toEqual([
      "Bun.spawn destructuring",
      "Bun.spawn destructuring",
      "Bun.spawn destructuring",
      "Bun.spawnSync destructuring",
      "Bun.spawn destructuring",
    ]);
  });

  it("unwraps Bun destructuring initializers", () => {
    expect(
      forbiddenProcessOperations(
        [
          "const { spawn } = (Bun);",
          'const { spawn } = globalThis["Bun"];',
        ].join("\n"),
      ),
    ).toEqual(["Bun.spawn destructuring", "Bun.spawn destructuring"]);
  });
});
