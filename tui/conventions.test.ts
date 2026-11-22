import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { fail, files, lineOf, read, repo, stripComments } from "../scripts/source-scan.ts";

// Rules for the terminal screen under tui/. Each failure says what to change; repo-wide rules are
// in scripts/conventions.test.ts, and the UI wording scan of src/conventions.test.ts reads tui/ too.

/** The screen's shipped code: not tests, and not the test tooling under tui/testing/. */
const productCode = (): string[] => files("tui/**/*.{ts,tsx,mjs,js}").filter((file) => !file.startsWith("tui/testing/") && !/\.test\.tsx?$/.test(file));

/**
 * Module specifiers of static imports and re-exports, side-effect imports and `import("…")` with a literal (as in
 * scripts/conventions.test.ts). A declaration never runs on into the next `import`: one that no semicolon ends would
 * otherwise take the import after it for its own `from` and hide what that import names.
 */
const SPECIFIER = /(?:^|[\s;])(?:import|export)\s(?:(?!\bimport\b)[^;])*?\sfrom\s*["']([^"']+)["']|(?:^|[\s;])import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

/** Each relative import of `code` (comments removed), as the repository path it names and its line. */
function relativeImports(file: string, code: string): { target: string; line: number; specifier: string }[] {
  return [...code.matchAll(SPECIFIER)].flatMap((match) => {
    const specifier = match[1] ?? match[2] ?? match[3]!;
    if (!specifier.startsWith(".")) return [];
    // the match may start with the newline before the import
    const at = match.index + match[0].search(/\S/);
    return [{ target: posix.normalize(posix.join(posix.dirname(file), specifier.replace(/\?.*$/, ""))), line: lineOf(code, at), specifier }];
  });
}

/** Every match of `pattern` in each file's code (comments removed), as `file:line: text`. */
function matches(fileList: string[], pattern: RegExp): string[] {
  return fileList.flatMap((file) => {
    const code = stripComments(read(file));
    return [...code.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].map((match) => {
      const line = lineOf(code, match.index);
      return `${file}:${line}: ${code.split("\n")[line - 1]!.trim().slice(0, 160)}`;
    });
  });
}

describe("import closure of tui/main.ts", () => {
  // The screen starts small and holds none of the server's module state: what it runs is tui/,
  // shared/ and these server files, which carry no server state of their own.
  const OUTSIDE_ALLOWED = new Set([
    ...["connection.ts", "socket-transport.ts", "core-socket.ts", "core-model.ts", "event-stream.ts", "layout-ops.ts", "layout-doc.ts", "snapshot.ts", "seen-label.ts", "worktrees.ts", "errors.ts", "hc-api.generated.ts"].map((name) => `server/herdr-core/${name}`),
    "server/agent-identity.ts", "server/herdr-sidebar.ts", "server/user-home.ts", "server/herdr/line-reader.ts", "server/herdr/test-session.ts",
    "package.json",
  ]);
  const allowed = (path: string) => path.startsWith("tui/") || path.startsWith("shared/") || OUTSIDE_ALLOWED.has(path);

  /**
   * The repository files `entry` reaches through relative imports, followed transitively through
   * every allowed code file, and each import that leaves the allowed set. A file that does not
   * exist is not read: a listed file its row has not written yet is simply not reached.
   */
  function closure(entry: string, source: (path: string) => string | undefined): { reached: string[]; offenders: string[] } {
    const reached = new Set([entry]);
    const offenders: string[] = [];
    for (const queue = [entry]; queue.length;) {
      const file = queue.shift()!;
      const text = /\.(?:ts|tsx|mjs|js)$/.test(file) ? source(file) : undefined;
      if (text === undefined) continue;
      for (const { target, line, specifier } of relativeImports(file, stripComments(text))) {
        if (!allowed(target)) offenders.push(`${file}:${line}: ${specifier} (${target})`);
        else if (!reached.has(target)) {
          reached.add(target);
          queue.push(target);
        }
      }
    }
    return { reached: [...reached], offenders };
  }

  it("stays inside tui/, shared/ and the listed server files", () => {
    const { reached, offenders } = closure("tui/main.ts", (path) => existsSync(join(repo, path)) ? read(path) : undefined);
    expect(reached).toContain("package.json");
    fail(offenders, "tui/main.ts reaches these files outside tui/, shared/ and OUTSIDE_ALLOWED (tui/conventions.test.ts): move what the screen needs into shared/ or a listed server/herdr-core/ file that carries no server state, and import it from there. Do not add a file to OUTSIDE_ALLOWED unless the plan names it.");
  });

  it("follows listed server files and reports what they reach", () => {
    const graph: Record<string, string> = {
      "tui/main.ts": "import { a } from \"./model/a.ts\";\nimport { version } from \"../package.json\";",
      "tui/model/a.ts": "export * from \"../../shared/x.ts\";\nimport \"../../server/herdr-core/not-written-yet.ts\";",
      "shared/x.ts": "import { snapshot } from \"../server/herdr-core/snapshot.ts\";\nimport { ops } from \"../server/herdr-core/layout-ops.ts\";",
      "server/herdr-core/snapshot.ts": "import { w } from \"./worktrees.ts\";\nimport { id } from \"../agent-identity.ts\";\n// import \"../herdr/commented.ts\";\nimport { call } from \"../herdr/client.ts\";",
      "server/herdr-core/worktrees.ts": "",
      "server/agent-identity.ts": "import \"../src/lib/status.ts\";",
    };
    const { reached, offenders } = closure("tui/main.ts", (path) => graph[path]);
    expect(reached).toEqual(expect.arrayContaining(["server/agent-identity.ts", "server/herdr-core/layout-ops.ts"]));
    expect(offenders).toEqual([
      "tui/model/a.ts:2: ../../server/herdr-core/not-written-yet.ts (server/herdr-core/not-written-yet.ts)",
      "server/herdr-core/snapshot.ts:4: ../herdr/client.ts (server/herdr/client.ts)",
      "server/agent-identity.ts:1: ../src/lib/status.ts (src/lib/status.ts)",
    ]);
  });

  it("reads an import that no semicolon ends as its own import, whatever follows it", () => {
    const sources: Record<string, string> = {
      "tui/main.ts": "import \"../server/index.ts\"\nimport { version } from \"../package.json\";\nimport \"./model/b.ts\";",
      "tui/model/b.ts": "export const b = 1\nimport \"../../server/main.ts\"\nimport { c } from \"./c.ts\";",
    };
    expect(closure("tui/main.ts", (path) => sources[path]).offenders).toEqual([
      "tui/main.ts:1: ../server/index.ts (server/index.ts)",
      "tui/model/b.ts:2: ../../server/main.ts (server/main.ts)",
    ]);
  });
});

describe("the screen's product code", () => {
  it("starts no process and never imports tui/testing/", () => {
    const testing = productCode().flatMap((file) => relativeImports(file, stripComments(read(file)))
      .filter(({ target }) => target.startsWith("tui/testing/")).map(({ line, specifier }) => `${file}:${line}: ${specifier}`));
    fail([...matches(productCode(), /\bBun\s*\.\s*(?:spawnSync|spawn|\$)|["'](?:node:)?child_process["']/), ...testing],
      "The screen starts no process (no Bun.spawn, Bun.spawnSync, Bun.$ or node:child_process) and never imports tui/testing/: the launcher starts the core, and only test files and the tooling under tui/testing/ start processes.");
  });

  it("touches the terminal, environment and arguments only in tui/main.ts and tui/host/", () => {
    const outside = productCode().filter((file) => file !== "tui/main.ts" && !file.startsWith("tui/host/"));
    fail(matches(outside, /\bprocess\s*\.\s*(?:stdin|stdout|env|argv)\b/),
      "Only tui/main.ts and tui/host/ read process.stdin, process.stdout, process.env or process.argv: pass what this code needs in as a value or through the host's interface.");
  });

  it("reads no clock and arms no timer in tui/input/ and tui/model/", () => {
    // their waits are deadlines on the caller's clock, named in tui/model/deadlines.ts; the loop owns the one timer
    const pure = productCode().filter((file) => file.startsWith("tui/input/") || file.startsWith("tui/model/"));
    fail(matches(pure, /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\b|\bDate\s*\.\s*now\b|\bnew\s+Date\b|\bperformance\s*\.\s*now\b|\bBun\s*\.\s*(?:sleep|sleepSync|nanoseconds)\b/),
      "tui/input/ and tui/model/ read no clock and arm no timer: take the time as an argument from the caller, and name every wait or limit in tui/model/deadlines.ts.");
  });

  it("never reaches the Ovis server", () => {
    fail(matches(productCode(), /\bfetch\s*\(|\/api\//),
      "The screen talks to herdr-core only, never to the Ovis server: no fetch( and no /api/ route under tui/. Use the core connection (server/herdr-core/ files on the closure list) instead.");
  });

  it("never names the Ovis server's settings", () => {
    // spelled in pieces so that this file does not hold the old name the repo-wide scan looks for
    const settings = ["OVIS_TOKEN", "OVIS_URL", ["HERDR", "WEB", "TOKEN"].join("_")];
    fail(matches(productCode(), new RegExp(`\\b(?:${settings.join("|")})\\b`)),
      "The screen holds no Ovis server token or address: remove these settings from tui/. It reaches herdr-core through its own socket and needs neither.");
  });
});

describe("the tui/ type-check project", () => {
  it("has no DOM library", () => {
    // read as plain JSON, so a comment in a tsconfig fails here instead of hiding an entry
    const config = (path: string) => JSON.parse(read(path)) as { extends?: string; compilerOptions?: { lib?: string[] } };
    let path = "tui/tsconfig.json";
    let lib = config(path).compilerOptions?.lib;
    for (let base = config(path).extends; lib === undefined && base !== undefined; base = config(path).extends) {
      path = posix.normalize(posix.join(posix.dirname(path), base));
      lib = config(path).compilerOptions?.lib;
    }
    expect(lib).toBeDefined();
    fail((lib ?? []).filter((entry) => entry.toLowerCase().startsWith("dom")).map((entry) => `${path}: lib ${entry}`),
      "tui/tsconfig.json sets its own \"lib\" without DOM: the screen runs in a terminal, so a DOM type in its closure is a mistake to fix in that code, not a library to add.");
  });
});
