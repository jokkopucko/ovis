import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { fail, files, importClosure, lineOf, read, repo, stripComments } from "../scripts/source-scan.ts";

const serverCode = (): string[] => files("server/**/*.{ts,mjs,js}").filter((file) => !/\.test\.ts$|\.fake\.ts$/.test(file));

function matches(fileList: string[], pattern: RegExp): { file: string; at: string; index: number; code: string }[] {
  return fileList.flatMap((file) => {
    const code = stripComments(read(file));
    return [...code.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))].map((match) => {
      const line = lineOf(code, match.index);
      return { file, index: match.index, code, at: `${file}:${line}: ${code.split("\n")[line - 1]!.trim().slice(0, 160)}` };
    });
  });
}

describe("PTY sidecar boundary", () => {
  // node-pty panics Bun (oven-sh/bun#18546); terminals run on the Rust PTY host instead
  const LOAD = /\bfrom\s*["'](?:@lydell\/)?node-pty[^"']*["']|\bimport\s*\(?\s*["'](?:@lydell\/)?node-pty[^"']*["']|\b(?:require|createRequire\s*\([^()]*(?:\([^()]*\))?[^()]*\))\s*\(\s*["'](?:@lydell\/)?node-pty[^"']*["']/;

  it("never loads node-pty", () => {
    const code = [...files("{server,src,shared,scripts,site,telemetry,tui}/**/*.{ts,tsx,mjs,cjs,js}"), "vite.config.ts"].filter((file) => file !== "server/conventions.test.ts");
    const loads = matches(code, LOAD);
    fail(loads.map((load) => load.at),
      "node-pty must never load inside Bun: it panics the runtime (oven-sh/bun#18546). PTY work goes through PtySession (server/pty/session.ts) on the Rust PTY host (crates/pty-sidecar).");
  });

  it("knows an import from a mention", () => {
    expect(LOAD.test("import * as pty from \"@lydell/node-pty\";")).toBe(true);
    expect(LOAD.test("const pty = await import('node-pty')")).toBe(true);
    expect(LOAD.test("const pty = createRequire(import.meta.url)(\"@lydell/node-pty\");")).toBe(true);
    expect(LOAD.test("Bun.resolveSync(\"@lydell/node-pty\", import.meta.dir);")).toBe(false);
  });
});

describe("web push", () => {
  // web-push's sendNotification goes through node:https, which Bun does not carry the way it
  // needs; push.ts builds each request with generateRequestDetails and sends it with fetch.
  it("never calls sendNotification", () => {
    fail(matches(files("{server,src,shared,scripts,telemetry}/**/*.{ts,tsx,mjs,js}").filter((file) => !file.endsWith(".test.ts")), /\bsendNotification\b/).map((match) => match.at),
      "Web push requests are built with webpush.generateRequestDetails and sent with fetch (server/push.ts); never call sendNotification (AGENTS.md, Bridge invariants).");
  });
});

describe("account service fake", () => {
  it("is imported by tests and their helpers only", () => {
    const shipped = files("{server,src,shared,app}/**/*.{ts,tsx,mjs,js}").filter((file) => !/\.test\.tsx?$|\.test-helpers\.ts$/.test(file) && file !== "shared/account-service-fake.ts" && !file.includes("/node_modules/"));
    fail(matches(shipped, /(?:from|import)\s*\(?\s*["'][^"']*account-service-fake(?:\.ts)?["']/).map((match) => match.at),
      "shared/account-service-fake.ts is test support: import it from a test or a *.test-helpers.ts file only.");
  });
});

function braces(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "\"" || ch === "'" || ch === "`") {
      for (i += 1; i < code.length && code[i] !== ch; i += code[i] === "\\" ? 2 : 1);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

describe("error bodies", () => {
  it("builds JSON answers only through server/http.ts", () => {
    fail(matches(serverCode().filter((file) => file !== "server/http.ts"), /\bResponse\.json\s*\(|new Response\s*\(\s*JSON\.stringify/).map((match) => match.at),
      "Answer JSON with jsonResponse, errorResponse, badRequest or conflictResponse from server/http.ts, not Response.json or new Response(JSON.stringify(…)).");
  });

  const ANSWER = /\b(?:jsonResponse|reply|fail)\s*\(\s*\{/;
  const errorValue = (object: string): string | null => {
    for (let i = 1, depth = 0; i < object.length; i++) {
      const ch = object[i]!;
      if ("{[(".includes(ch)) depth += 1;
      else if ("}])".includes(ch)) depth -= 1;
      else if (depth === 0 && /^(?<![\w$.])error\s*:/.test(object.slice(i)) && !/[\w$.]/.test(object[i - 1]!)) {
        return object.slice(i).replace(/^error\s*:\s*/, "");
      }
    }
    return null;
  };
  const malformed = (code: string, at: number): boolean => {
    const blank = stripComments(code.slice(at), { strings: true });
    const object = braces(blank, blank.indexOf("{"));
    const value = errorValue(object);
    if (value === null) return false;
    if (!value.startsWith("{")) return true;
    const body = braces(value, 0);
    return !/\bcode\s*[:,}]/.test(body) || !/\bmessage\s*[:,}]/.test(body);
  };

  it("gives every error body both a code and a message", () => {
    const bodies = matches(serverCode(), ANSWER).filter((match) => errorValue(braces(stripComments(match.code.slice(match.index), { strings: true }), match.code.indexOf("{", match.index) - match.index)) !== null);
    expect(bodies.length).toBeGreaterThan(30);
    fail(bodies.filter((match) => malformed(match.code, match.index)).map((match) => match.at),
      "An error body is { error: { code, message } } with a snake_case code: use badRequest(code, message) or conflictResponse(code, message) from server/http.ts, errorResponse(error) for a thrown error, or jsonResponse({ error: { code, message } }, status) for another status.");
  });

  it("reads an error body's shape", () => {
    expect(malformed("return jsonResponse({ error: \"nope\" }, 400);", 7)).toBe(true);
    expect(malformed("return reply({ error: { code: \"x\" } }, 400);", 7)).toBe(true);
    expect(malformed("return jsonResponse({ error: { code, message: a ? b : \"c\" } }, 503);", 7)).toBe(false);
    expect(malformed("return jsonResponse({ error: { message: \"invalid pairing code\" } }, 400);", 7)).toBe(true);
    expect(malformed("return jsonResponse({ ok: false, error: \"nope\" }, 400);", 7)).toBe(true);
    expect(malformed("return jsonResponse({ ok: true, data: { error: \"kept\" } });", 7)).toBe(false);
    expect(ANSWER.test("this.patch({ phase: \"error\", error: \"failed\" });")).toBe(false);
  });
});

function unixConnects(file: string, code: string): { file: string; at: string; bun: boolean }[] {
  const at = (index: number) => `${file}:${lineOf(code, index)}: ${code.split("\n")[lineOf(code, index) - 1]!.trim().slice(0, 160)}`;
  const argument = (open: number): string => {
    const rest = code.slice(open).trimStart();
    return rest.startsWith("{") ? braces(rest, 0) : /^[^,)]*/.exec(rest)![0].trim();
  };
  const found: { file: string; at: string; bun: boolean }[] = [];
  for (const match of code.matchAll(/\bBun\.connect\s*(?:<[^>]*>)?\s*\(/g)) {
    const arg = argument(match.index + match[0].length);
    if (!arg.startsWith("{") || /\bunix\s*:/.test(arg)) found.push({ file, at: at(match.index), bun: true });
  }
  const names: string[] = [];
  for (const match of code.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*["'](?:node:)?net["']/g)) {
    for (const item of match[1]!.matchAll(/\b(connect|createConnection)\b(?:\s+as\s+(\w+))?/g)) names.push(item[2] ?? item[1]!);
  }
  for (const match of code.matchAll(/\bimport\s+(?:\*\s*as\s+)?(\w+)\s*(?:,\s*\{[^}]*\}\s*)?from\s*["'](?:node:)?net["']|\b(?:const|let|var)\s+(\w+)\s*=\s*(?:require|await\s+import)\s*\(\s*["'](?:node:)?net["']\s*\)/g)) {
    const space = match[1] ?? match[2]!;
    names.push(`${space}.connect`, `${space}.createConnection`);
  }
  if (!names.length) return found;
  for (const match of code.matchAll(new RegExp(`(?<![\\w.])(?:${names.map((name) => name.replace(".", "\\.")).join("|")})\\s*\\(`, "g"))) {
    const arg = argument(match.index + match[0].length);
    if (arg.startsWith("{") ? /\bpath\s*:/.test(arg) : !/^\d|port/i.test(arg)) found.push({ file, at: at(match.index), bun: false });
  }
  return found;
}

describe("herdr-core's socket transport", () => {
  // The terminal screen reaches herdr-core through this file so that no core is ever started (hc
  // connect starts one when none runs). A PATH stand-in sees only a spawn by name; this rule also
  // sees one by absolute path, and every file the transport imports, however deep.
  const ENTRY = "server/herdr-core/socket-transport.ts";
  const RUNS_HC_OR_HERDR = new Set(["server/herdr-core/hc-connect.ts", "server/herdr-core/discovery.ts", "server/herdr/client.ts"]);
  /**
   * child_process, and any value import of "bun" (named, default, namespace, re-export or dynamic), spaces or none
   * around the braces and `from`: only `import type` passes
   */
  const PROCESS_START = /["'](?:node:)?child_process["']|(?<![\w$.])(?:import|export)(?![\w$])(?!\s*type(?:\s*[{*]|\s+(?!from[\s"'])[\w$]))[^;]*?(?<![\w$])from\s*["']bun["']|\b(?:import|require)\s*\(\s*["']bun["']\s*\)/g;
  /** the global Bun's members the closure uses; any other use of `Bun` (Bun.spawn, Bun.$, Bun["spawn"], `const B = Bun`) could start a process */
  const BUN_MEMBERS = ["connect", "Socket", "TOML"];
  const OTHER_BUN = new RegExp(`(?<![\\w$])Bun(?![\\w$])(?!\\s*\\.\\s*(?:${BUN_MEMBERS.join("|")})(?![\\w$]))`, "g");
  const repoSource = (path: string) => (existsSync(join(repo, path)) ? read(path) : undefined);

  /** Each import of a file that runs hc or herdr in `entry`'s import closure, and each process start there, as `file:line: text`. */
  function processStarts(entry: string, source: (path: string) => string | undefined): string[] {
    const { reached, offenders } = importClosure(entry, source, (path) => !RUNS_HC_OR_HERDR.has(path));
    const starts = reached.filter((file) => /\.(?:ts|tsx|mjs|js)$/.test(file)).flatMap((file) => {
      const code = stripComments(source(file) ?? "");
      // `Bun` inside a string counts too: a template literal's `${...}` is code
      const offsets = [...code.matchAll(PROCESS_START), ...code.matchAll(OTHER_BUN)].map((match) => match.index + match[0].search(/\S/));
      return [...new Set(offsets.map((at) => lineOf(code, at)))].sort((a, b) => a - b).map((line) => `${file}:${line}: ${code.split("\n")[line - 1]!.trim().slice(0, 160)}`);
    });
    return [...offenders, ...starts];
  }

  it("starts no process anywhere in its import closure", () => {
    expect(importClosure(ENTRY, repoSource).reached).toContain("server/herdr-core/connection.ts");
    fail(processStarts(ENTRY, repoSource),
      "server/herdr-core/socket-transport.ts must never start a core: nothing in its import closure may start a process (Bun.spawn, Bun.spawnSync, Bun.$, child_process, a value import of \"bun\", or Bun used as anything but Bun.connect, Bun.Socket or Bun.TOML) or import hc-connect.ts, discovery.ts or server/herdr/client.ts, which run hc or herdr. Take the process start out of the file named, or import what the transport needs from a file that starts nothing.");
  });

  it("finds a process start or an import of what runs hc in any file of the closure", () => {
    const graph: Record<string, string> = {
      [ENTRY]: "import { a } from \"./connection.ts\";\nimport { b } from \"./hc-connect.ts\";\nBun.spawn([\"hc\"]);",
      "server/herdr-core/connection.ts": "import \"../../shared/x.ts\";\n// Bun.spawn in a comment\nconst p = Bun . spawnSync([\"sh\"]);",
      "shared/x.ts": "import { spawn } from \"bun\";\nimport { execFile } from \"node:child_process\";\nimport \"./y.ts\";",
      "server/herdr-core/hc-connect.ts": "Bun.spawn([\"hc\", \"connect\"]);",
      // every other way to reach Bun's process starts; the members the closure really uses and a type import pass
      "shared/y.ts": [
        "import { $ } from \"bun\";",
        "import * as b from \"bun\";",
        "const B = Bun;",
        "Bun[\"spawn\"]([\"hc\"]);",
        "globalThis.Bun.spawn([\"hc\"]);",
        "const run = await import(\"bun\");",
        "import type { Socket } from \"bun\";",
        "const s: Bun.Socket<undefined> = await Bun.connect({ unix: \"x\" }); Bun.TOML.parse(\"\");",
        "const text = `${Bun.spawn([\"hc\"])}`;",
        // the same imports written without spaces, after a brace, or across lines
        "import{spawn}from\"bun\";",
        "import {spawn}from \"bun\";",
        "import{ spawn } from \"bun\";",
        "import{spawnSync}from\"bun\";",
        "{}import { spawn } from \"bun\";",
        "import {",
        "  spawn,",
        "}from \"bun\";",
        "import{$}from\"bun\";",
        "export*from'bun';",
        "import type{Socket}from\"bun\";",
      ].join("\n"),
    };
    expect(processStarts(ENTRY, (path) => graph[path])).toEqual([
      `${ENTRY}:2: ./hc-connect.ts (server/herdr-core/hc-connect.ts)`,
      `${ENTRY}:3: Bun.spawn(["hc"]);`,
      "server/herdr-core/connection.ts:3: const p = Bun . spawnSync([\"sh\"]);",
      "shared/x.ts:1: import { spawn } from \"bun\";",
      "shared/x.ts:2: import { execFile } from \"node:child_process\";",
      "shared/y.ts:1: import { $ } from \"bun\";",
      "shared/y.ts:2: import * as b from \"bun\";",
      "shared/y.ts:3: const B = Bun;",
      "shared/y.ts:4: Bun[\"spawn\"]([\"hc\"]);",
      "shared/y.ts:5: globalThis.Bun.spawn([\"hc\"]);",
      "shared/y.ts:6: const run = await import(\"bun\");",
      "shared/y.ts:9: const text = `${Bun.spawn([\"hc\"])}`;",
      "shared/y.ts:10: import{spawn}from\"bun\";",
      "shared/y.ts:11: import {spawn}from \"bun\";",
      "shared/y.ts:12: import{ spawn } from \"bun\";",
      "shared/y.ts:13: import{spawnSync}from\"bun\";",
      "shared/y.ts:14: {}import { spawn } from \"bun\";",
      "shared/y.ts:15: import {",
      "shared/y.ts:18: import{$}from\"bun\";",
      "shared/y.ts:19: export*from'bun';",
    ]);
  });
});

describe("herdr socket", () => {
  // herdr closes the socket after each answer, so every RPC opens its own connection in
  // server/herdr/client.ts (no pooling), and only server/collector.ts holds a status
  // subscription (AGENTS.md, Bridge invariants).
  const UNIX_CONNECT_ALLOWED: Record<string, string> = {
    "server/herdr/client.ts": "the one herdr RPC client: one connection per call, plus subscribeEvents",
    "server/herdr-marker.ts": "a liveness probe: connects and ends at once, sends no request",
    "server/account/recovery.ts": "ovis recover's own private recovery socket in this PC's state folder, not herdr's",
    "server/herdr-core/socket-transport.ts": "herdr-core's socket, not herdr's: a line that never starts a core, for a client that must not",
  };
  const NET_CONNECT_ALLOWED: Record<string, string> = {
    "server/line-call.ts": "one request to a private tool broker's socket, never herdr's",
    "server/ssh-askpass.ts": "the SSH askpass helper's own private socket, not herdr's",
    "server/approvals/relay.ts": "an agent's approval hook reaching the approval hub's own socket or pipe, not herdr's",
    "server/herdr-core/adapter.ts": "a liveness probe of the core adapter's own socket before startup: sends no request",
    "server/herdr-core/runtime.ts": "a liveness probe of herdr-core's socket, not herdr's: connects and closes, sends nothing",
    "server/runtime-move-lock.ts": "the herdr-core move's own lock socket, not herdr's: asks which Ovis server holds it",
    "server/omo-control.ts": "OmO's own terminal-control socket, the one the pane's OmO process listens on, not herdr's: one request per connection",
    "server/acp/client.ts": "an ACP keeper's own socket in this server's state folder (crates/acp-keeper), not herdr's: one connection the keeper streams its log on",
  };

  it("opens herdr's socket only in server/herdr/client.ts", () => {
    const uses = serverCode().flatMap((file) => unixConnects(file, stripComments(read(file))));
    expect(uses.map((use) => use.file)).toContain("server/herdr/client.ts");
    fail(uses.filter((use) => !(use.file in (use.bun ? UNIX_CONNECT_ALLOWED : NET_CONNECT_ALLOWED))).map((use) => use.at),
      "Call herdr through the typed wrappers in server/herdr/client.ts: one connection per call, never a pooled or second client. A unix socket that is not herdr's gets an entry with its reason in UNIX_CONNECT_ALLOWED (Bun.connect) or NET_CONNECT_ALLOWED (node:net) in server/conventions.test.ts. A TCP connection (`{ host, port }`) is not flagged.");
  });

  it("tells a unix socket from a TCP one", () => {
    const found = (code: string) => unixConnects("example.ts", code).length;
    expect(found("Bun.connect({ unix: path, socket })")).toBe(1);
    expect(found("Bun.connect(options)")).toBe(1);
    expect(found("Bun.connect({ hostname: \"127.0.0.1\", port, socket })")).toBe(0);
    expect(found("import { connect as dial } from \"node:net\";\ndial({ path: \"/tmp/herdr.sock\" });")).toBe(1);
    expect(found("import net from \"node:net\";\nnet.createConnection({ path: socketPath });")).toBe(1);
    expect(found("import * as net from \"node:net\";\nnet.connect(process.env.HERDR_SOCKET_PATH);")).toBe(1);
    expect(found("import { connect as tcpConnect, createServer } from \"node:net\";\ntcpConnect({ host, port });\ntcpConnect(port, host);")).toBe(0);
  });

  const HERDR_RPC_ALLOWED: Record<string, string> = {
    "server/conversation.ts": "open PRs #869 #912 #923 change it",
    "server/gjc-runtime.ts": "open PR #912 changes it",
    "server/hermes.ts": "open PR #910 changes it",
    "server/omo.ts": "open PR #923 changes it",
    "server/shell-agent.ts": "open PRs #885 #923 change it",
  };
  const HERDR_RPC_PENDING: Record<string, string> = {
    "server/gjc-status.ts": "open PR #928 adds a call",
    "server/index.ts": "open PR #859 adds a call",
  };

  it("calls herdrRpc only inside server/herdr/", () => {
    const uses = matches(serverCode().filter((file) => !file.startsWith("server/herdr/")), /\bherdrRpc\b/);
    fail(uses.filter((use) => !(use.file in HERDR_RPC_ALLOWED) && !(use.file in HERDR_RPC_PENDING)).map((use) => use.at),
      "Do not call herdrRpc outside server/herdr/: add a typed wrapper in server/herdr/client.ts (its method in HerdrMethods, server/herdr/methods.ts) and call that; for pane status use the server/collector.ts listeners. Files waiting on open PRs are listed in HERDR_RPC_ALLOWED in server/conventions.test.ts; do not add new ones.");
    const users = new Set(uses.map((use) => use.file));
    fail(Object.keys(HERDR_RPC_ALLOWED).filter((file) => !users.has(file)),
      "These files no longer call herdrRpc: remove them from HERDR_RPC_ALLOWED in server/conventions.test.ts.");
  });

  it("subscribes to status only in server/collector.ts", () => {
    const subscribers = matches(serverCode(), /\bsubscribeEvents\b/).filter((match) => match.file !== "server/herdr/client.ts" && match.file !== "server/collector.ts");
    // server/herdr-core/core.fake.ts is the tests' stand-in for hc, answering the method as hc does
    // server/herdr-core/event-stream.ts opens that hc stream for the adapter (and the terminal screen)
    const HC_STREAM_TYPES = ["server/herdr-core/adapter.ts", "server/herdr-core/event-stream.ts", "server/herdr-core/hc-api.generated.ts", "scripts/hc-types.ts", "server/herdr-core/connection.ts", "server/herdr-core/pin-label.ts", "server/herdr-core/machine-scope.ts", "server/herdr-core/core.fake.ts"];
    const raw = matches(files("{server,src,shared,scripts}/**/*.{ts,tsx,mjs,js}").filter((file) => !file.endsWith(".test.ts")), /["']events\.subscribe["']/).filter((match) => match.file !== "server/herdr/client.ts" && !HC_STREAM_TYPES.includes(match.file));
    fail([...subscribers, ...raw].map((match) => match.at),
      "server/collector.ts is the only status subscription (startStatusCollector), and `events.subscribe` is sent only by subscribeEvents in server/herdr/client.ts: take pane status from the collector's callbacks (onStatus, onPaneEnded, onBaseline) in server/index.ts instead of subscribing again.");
  });
});

describe("runtime gates", () => {
  const NAMED = /[!=]== ?"herdr-core"|\bcase "herdr-core"\s*:|\bcapabilities\(\)\.runtime\b|\bruntime\(\)\s*[!=]==/;

  const RUNTIME_NAMED: Record<string, string> = {
    "server/runtime-move.ts": "the move goes from herdr to herdr-core",
    "server/runtime-move-run.ts": "the move goes from herdr to herdr-core",
    "server/runtime-move-service.ts": "the move goes from herdr to herdr-core",
    "server/index.ts": "a saved choice of herdr-core falls back to herdr when no hc is found",
    "server/machines.ts": "a remote PC's own Ovis is taken by the runtime its identity names",
    "server/conversation.ts": "the name of hc's program in an attach client's argv",
    "server/agents-routes.ts": "herdr itself starts two agent kinds without a manifest",
    "server/herdr-update.ts": "`herdr update` updates herdr, no other runtime",
  };

  it("asks the runtime for an ability, never for its name", () => {
    const named = matches([...serverCode(), ...files("shared/**/*.ts")].filter((file) => !file.startsWith("server/herdr-core/") && file !== "server/runtime/capabilities.ts"), NAMED);
    fail(named.filter((use) => !(use.file in RUNTIME_NAMED)).map((use) => use.at),
      "Do not branch on the runtime's name: read the ability the code needs from capabilities() (server/runtime/capabilities.ts), adding a field to RuntimeCapabilities and to each runtime's record when none fits.");
    const users = new Set(named.map((use) => use.file));
    fail(Object.keys(RUNTIME_NAMED).filter((file) => !users.has(file)),
      "These files no longer compare the runtime's name: remove them from RUNTIME_NAMED in server/conventions.test.ts.");
  });

  it("knows a gate on the runtime's name from another use of the word", () => {
    for (const gate of [
      'if (identity.runtime !== "herdr-core") return;',
      'if (capabilities().runtime === "herdr") kinds.add("omp");',
      'const other = capabilities().runtime !== "herdr";',
      'if (runtime() !== "herdr") return null;',
      'if (runtime() === "herdr-core") start();',
      'switch (served) { case "herdr": return 1; case "herdr-core": return 2; }',
      'switch (capabilities().runtime) { case "herdr": return 1; default: return 2; }',
    ]) expect(NAMED.test(gate)).toBe(true);
    for (const other of [
      "return jsonResponse({ ok: true, runtime: runtime() });",
      'const discover = url.searchParams.get("discover") === "herdr";',
      'if (source === "herdr" && tracked) return;',
      'switch (signal.source) { case "herdr": return turns.chat; default: return turns.herdr; }',
      'const command = process.env["OVIS_HERDR_BIN"] || "herdr";',
      'if (capabilities().attach === "pty-cli") watch();',
    ]) expect(NAMED.test(other)).toBe(false);
  });
});

describe("remote PC bundle boundary", () => {
  // scripts/build-remote-bundle.ts ships server/, shared/ and integrations/ but not src/ or relay/: code
  // there that imports either loads from a checkout, where every check runs, and not on a remote PC (#2220)
  const SRC_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']((?:\.\.\/)+(?:src|relay)\/[^"']*)["']/;
  const leavesBundle = (file: string, spec: string) => /^(?:src|relay)\//.test(posix.normalize(posix.join(posix.dirname(file), spec)));

  it("never imports src/ or relay/ from code the remote bundle carries", () => {
    const shipped = [...serverCode(), ...files("{shared,integrations}/**/*.{ts,mjs,js}").filter((file) => !file.endsWith(".test.ts"))];
    fail(matches(shipped, SRC_IMPORT).filter((found) => leavesBundle(found.file, SRC_IMPORT.exec(found.code.slice(found.index))![1]!)).map((found) => found.at),
      "The remote PC bundle (scripts/build-remote-bundle.ts) carries server/, shared/ and integrations/, not src/ or relay/: move what this code needs into shared/, as shared/markdown.ts was.");
  });

  it("knows an import of src/ from a mention", () => {
    expect(SRC_IMPORT.test("import { parseInline } from \"../src/lib/markdown.ts\";")).toBe(true);
    expect(SRC_IMPORT.test("const m = await import('../../src/lib/x.ts')")).toBe(true);
    expect(SRC_IMPORT.test("import \"../src/styles.css\";")).toBe(true);
    expect(SRC_IMPORT.test("import { PAIR_CLOSE } from \"../../relay/pair-room.ts\";")).toBe(true);
    expect(SRC_IMPORT.test("import { a } from \"../shared/markdown.ts\";")).toBe(false);
    expect(SRC_IMPORT.test("import { a } from \"./src-files.ts\";")).toBe(false);
    expect(leavesBundle("server/relay/pair-code.ts", "../../relay/pair-room.ts")).toBe(true);
    expect(leavesBundle("server/account/mailbox.ts", "../relay/identity.ts")).toBe(false);
  });
});

describe("server entries", () => {
  // The compiled binary (scripts/build-server.ts) has no .ts files: a child started by a source file's
  // path works only from a checkout.
  const START_BY_PATH = /\bprocess\.execPath\s*,\s*\[?\s*(?:join\s*\(|resolve\s*\(|["'`][^"'`\n]*\.(?:ts|tsx|js|mjs)["'`])/;
  const ALLOWED: Record<string, string> = {
    "server/supervisor.ts": "installs the Rust PTY host with the script of a release checked out from source, which only the source updater makes",
    "server/updater.ts": "builds a release checked out from source with that release's own scripts",
  };

  it("starts the server's own entries only through entryCommand", () => {
    // a *.test-helpers.ts is test support, as a test is: it runs from a checkout, never in the compiled binary
    const starts = matches([...serverCode(), "scripts/plugin.ts", "scripts/plugin-tui.ts"].filter((file) => file !== "server/entries.ts" && !file.endsWith(".test-helpers.ts")), START_BY_PATH);
    fail(starts.filter((start) => !(start.file in ALLOWED)).map((start) => start.at),
      "Start the server's own code with entryCommand(name) from server/entries.ts (add the entry to ENTRIES), never with process.execPath and a .ts path: the compiled binary has no such file.");
    const users = new Set(starts.map((start) => start.file));
    fail(Object.keys(ALLOWED).filter((file) => !users.has(file)), "These files no longer start a file by path: remove them from ALLOWED in server/conventions.test.ts.");
  });

  it("knows a start by path from other uses of process.execPath", () => {
    expect(START_BY_PATH.test("Bun.spawn([process.execPath, join(import.meta.dir, \"machine-entry.ts\")], {")).toBe(true);
    expect(START_BY_PATH.test("Bun.spawn([process.execPath, \"server/index.ts\"], {")).toBe(true);
    expect(START_BY_PATH.test("spawn(process.execPath, [join(ROOT, \"server\", \"managed.ts\")], {")).toBe(true);
    expect(START_BY_PATH.test("run([process.execPath, \"install\", \"--frozen-lockfile\"])")).toBe(false);
    expect(START_BY_PATH.test("[process.execPath, \"-e\", SCRIPT, String(pid)]")).toBe(false);
    expect(START_BY_PATH.test("Bun.spawn(entryCommand(\"machine\"), {")).toBe(false);
  });
});

describe("herdr focus", () => {
  const SENDS: Record<string, number> = { "server/herdr/client.ts": 3 };
  const CALLERS: Record<string, string> = {
    "server/pane-routes.ts": "POST /api/pane/focus, the request a person's own action sends",
  };
  const RULE = "Selecting a pane or tab in the browser never moves herdr's own focus. `pane.focus` is sent by paneFocus (POST /api/pane/focus) and by the two restores in server/herdr/client.ts that put herdr's focus back after a swap or a move took it.";

  it("sends pane.focus only from the focus route and the two restores", () => {
    const code = files("{server,shared}/**/*.{ts,mjs,js}").filter((file) => !/\.test\.ts$|\.fake\.ts$|\.generated\.ts$/.test(file));
    const sends = matches(code, /["']pane\.focus["']/);
    const counts = new Map<string, number>();
    for (const send of sends) counts.set(send.file, (counts.get(send.file) ?? 0) + 1);
    fail(sends.filter((send) => counts.get(send.file) !== SENDS[send.file]).map((send) => send.at),
      `${RULE} A new sender is an explicit action that needs herdr to show the pane: route it through paneFocus, or raise the file's count in SENDS in server/conventions.test.ts with that reason in the pull request.`);
    fail(Object.keys(SENDS).filter((file) => counts.get(file) !== SENDS[file]),
      "These files no longer send pane.focus that many times: set their count in SENDS in server/conventions.test.ts.");
  });

  it("calls paneFocus only from the focus route", () => {
    const calls = matches(serverCode().filter((file) => file !== "server/herdr/client.ts"), /\bpaneFocus\s*\(/);
    fail(calls.filter((call) => !(call.file in CALLERS)).map((call) => call.at),
      `${RULE} A new caller is an explicit action that needs herdr to show the pane: list its file in CALLERS in server/conventions.test.ts with that action.`);
    const users = new Set(calls.map((call) => call.file));
    fail(Object.keys(CALLERS).filter((file) => !users.has(file)),
      "These files no longer call paneFocus: remove them from CALLERS in server/conventions.test.ts.");
  });
});

describe("herdr update", () => {
  const REAL = "server/index.ts";
  const STAND_IN = /^new HerdrUpdater\(\s*\{(?:[^}]*,)?\s*bin\s*[:,}]/;

  it("builds a HerdrUpdater for the real herdr only in the server's own start", () => {
    const code = files("{server,scripts,src,shared}/**/*.{ts,tsx,mjs,js}").filter((file) => file !== REAL && file !== "server/conventions.test.ts");
    const builds = matches(code, /new HerdrUpdater\(/).filter((build) => !STAND_IN.test(build.code.slice(build.index, build.index + 400)));
    fail(builds.map((build) => build.at),
      "A test never runs the real `herdr update`: it would update the herdr of whoever runs the tests. Give the updater a stand-in, `new HerdrUpdater({ bin: <a script the test wrote> })`, as server/herdr-update.test.ts does. Only server/index.ts builds one for the real herdr.");
  });

  it("knows a stand-in binary from the real herdr", () => {
    expect(STAND_IN.test("new HerdrUpdater({ bin: herdr.path, socketPath: \"/srv/herdr.sock\" })")).toBe(true);
    expect(STAND_IN.test("new HerdrUpdater({ timeoutMs: 200, bin })")).toBe(true);
    expect(STAND_IN.test("new HerdrUpdater()")).toBe(false);
    expect(STAND_IN.test("new HerdrUpdater({ timeoutMs: 200 })")).toBe(false);
    expect(STAND_IN.test("new HerdrUpdater({ socketPath: \"/tmp/bin/herdr.sock\" })")).toBe(false);
  });
});

describe("test servers", () => {
  const FROM_INDEX = /import\s*\{[^}]*\bcreateServer\b[^}]*\}\s*from\s*["'](?:\.\.?\/)+(?:server\/)?index\.ts["']/;
  const CALL = /(?<![.\w$])createServer\(/g;
  const OWN: Record<string, { calls: number; why: string }> = {
    "server/copilot.contract.test.ts": { calls: 1, why: "node's net.createServer, inside the text of the stand-in Copilot script" },
    "server/device-access.contract.test.ts": { calls: 1, why: "the default state folder, under an XDG_CONFIG_HOME the test made" },
    "server/ipv6-loopback.contract.test.ts": { calls: 1, why: "a port the test took itself, to see the start fail" },
  };

  function closing(code: string, open: number): number {
    let depth = 1;
    let end = open + 1;
    for (; depth > 0 && end < code.length; end++) depth += "({[".includes(code[end]!) ? 1 : ")}]".includes(code[end]!) ? -1 : 0;
    return end;
  }

  function ownProperties(object: string): string {
    let depth = 0;
    let own = "";
    for (const char of object) {
      if ("({[".includes(char)) depth += 1;
      if (depth <= 1) own += char;
      if (")}]".includes(char)) depth -= 1;
    }
    return own;
  }

  function serverCalls(file: string, code: string): { at: string; isolated: boolean }[] {
    if (!FROM_INDEX.test(code)) return [];
    return [...code.matchAll(CALL)].map((match) => {
      const open = match.index + match[0].length - 1;
      const args = code.slice(open + 1, closing(code, open) - 1).trim();
      const before = code.slice(0, match.index);
      const declared = (name: string): string => {
        const at = before.lastIndexOf(`const ${name} = {`);
        return at < 0 ? "" : ownProperties(code.slice(code.indexOf("{", at), closing(code, code.indexOf("{", at))));
      };
      const literal = args.startsWith("{") ? ownProperties(args) : "";
      const named = literal ? [...literal.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((spread) => declared(spread[1]!)).join("") : /^[A-Za-z_$][\w$]*$/.test(args) ? declared(args) : "";
      const port = /\bport:\s*([^,}\s]+)/.exec(literal) ?? /\bport:\s*([^,}\s]+)/.exec(named);
      const line = lineOf(code, match.index);
      return { at: `${file}:${line}: ${code.split("\n")[line - 1]!.trim().slice(0, 160)}`, isolated: port?.[1] === "0" && /(?<![\w$.])stateDir\b/.test(literal + named) };
    });
  }

  it("start on a free port with a state folder of their own", () => {
    const tests = files("{server,scripts,src,shared}/**/*.{ts,tsx}").filter((file) => /\.test\.tsx?$|test-helpers\.ts$/.test(file) || file.startsWith("scripts/"));
    const open = tests.flatMap((file) => serverCalls(file, stripComments(read(file))).filter((call) => !call.isolated).map((call) => ({ file, at: call.at })));
    const counts = new Map<string, number>();
    for (const call of open) counts.set(call.file, (counts.get(call.file) ?? 0) + 1);
    fail(open.filter((call) => counts.get(call.file) !== OWN[call.file]?.calls).map((call) => call.at),
      "A test's createServer takes `port: 0` and a `stateDir` the test made (`mkdtempSync(join(tmpdir(), \"ovis-…\"))`), in the call or in the `const` object it passes or spreads: without them it binds the port and reads and writes the state folder of whoever runs the tests. A call that cannot is counted in OWN in server/conventions.test.ts with its reason.");
    fail(Object.keys(OWN).filter((file) => counts.get(file) !== OWN[file]!.calls),
      "These files no longer hold that many createServer calls without port: 0 and a stateDir: set their count in OWN in server/conventions.test.ts, or remove them.");
  });

  it("reads a call's options, in place or from the const it names", () => {
    const from = "import { createServer } from \"./index.ts\";\n";
    const isolated = (code: string): boolean[] => serverCalls("x.test.ts", from + code).map((call) => call.isolated);
    expect(isolated("createServer({ port: 0, stateDir: dir, token: \"\" });")).toEqual([true]);
    expect(isolated("const base = { port: 0, token: \"\" } as const;\ncreateServer({ ...base, stateDir: tempDir() });")).toEqual([true]);
    expect(isolated("const options = { port: 0, stateDir: root } as const;\ncreateServer(options);")).toEqual([true]);
    expect(isolated("const options = {\n  port: 0,\n  stateDir: root,\n} as const;\ncreateServer(options);")).toEqual([true]);
    expect(isolated("const base = { port: 0, stateDir: dir };\ncreateServer({ ...base, port: 7317 });")).toEqual([false]);
    expect(isolated("const base = { port: 0, token: \"\" };\ncreateServer({ ...base, stateDir: dir, lanHttps: { port: 8443 } });")).toEqual([true]);
    expect(isolated("createServer({ port: 0, siblingStateDir: legacy });")).toEqual([false]);
    expect(isolated("createServer({ port: 7317, stateDir: dir });")).toEqual([false]);
    expect(isolated("createServer(options);")).toEqual([false]);
    expect(isolated("net.createServer((socket) => socket.end());")).toEqual([]);
    expect(serverCalls("x.test.ts", "import { createServer } from \"node:net\";\ncreateServer();")).toEqual([]);
  });
});
