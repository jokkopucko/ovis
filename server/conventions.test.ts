import { describe, expect, it } from "bun:test";
import { posix } from "node:path";
import { fail, files, lineOf, read, stripComments } from "../scripts/source-scan.ts";

// Server rules from AGENTS.md and server/AGENTS.md that used to be prose only. Each failure says
// what to change; client rules are in src/conventions.test.ts, repo-wide ones in
// scripts/conventions.test.ts.

/** Server code that ships: not tests, not test stand-ins. */
const serverCode = (): string[] => files("server/**/*.{ts,mjs,js}").filter((file) => !/\.test\.ts$|\.fake\.ts$/.test(file));

/** Every match of `pattern` in each file's code (comments removed), as `file:line: text`. */
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
  // node-pty panics Bun (oven-sh/bun#18546): only the Node sidecar loads it. `Bun.resolveSync`
  // in server/pty/sidecar.ts only finds the package for Node and is not a load.
  const NODE_SIDE = new Set(["server/pty/pty-host.mjs", "server/pty/smoke.mjs"]);
  const LOAD = /\bfrom\s*["'](?:@lydell\/)?node-pty[^"']*["']|\bimport\s*\(?\s*["'](?:@lydell\/)?node-pty[^"']*["']|\b(?:require|createRequire\s*\([^()]*(?:\([^()]*\))?[^()]*\))\s*\(\s*["'](?:@lydell\/)?node-pty[^"']*["']/;

  it("loads node-pty only in the Node sidecar", () => {
    // this file names the package in its own examples
    const code = [...files("{server,src,shared,scripts,site,telemetry}/**/*.{ts,tsx,mjs,cjs,js}"), "vite.config.ts"].filter((file) => file !== "server/conventions.test.ts");
    const loads = matches(code, LOAD);
    fail(loads.filter((load) => !NODE_SIDE.has(load.file)).map((load) => load.at),
      "node-pty must never load inside Bun (AGENTS.md, Bridge invariants). PTY work goes through the Node sidecar server/pty/pty-host.mjs via PtySession (server/pty/session.ts).");
    expect(loads.map((load) => load.file)).toContain("server/pty/pty-host.mjs");
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

/** The text of the `{ … }` that opens at `open`, strings respected. */
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
  // Every error body is `{ error: { code, message } }` (AGENTS.md, Changing a contract): the
  // client reads `code` to decide and shows `message`. JSON answers go through jsonResponse or
  // its wrappers in server/http.ts, so the content type and the envelope stay one shape.
  it("builds JSON answers only through server/http.ts", () => {
    fail(matches(serverCode().filter((file) => file !== "server/http.ts"), /\bResponse\.json\s*\(|new Response\s*\(\s*JSON\.stringify/).map((match) => match.at),
      "Answer JSON with jsonResponse, errorResponse, badRequest or conflictResponse from server/http.ts, not Response.json or new Response(JSON.stringify(…)).");
  });

  /** An answer built from an object literal: jsonResponse or a local wrapper around it (`reply`, `fail`). */
  const ANSWER = /\b(?:jsonResponse|reply|fail)\s*\(\s*\{/;
  /** The value of the object's own top-level `error` key (strings blanked), or null when it has none. */
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
  /** Whether the answer at `at` has an error body other than `{ error: { code, message } }`. */
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

/**
 * Unix-socket connections opened in `code` (comments removed): Bun.connect with `unix:` or with
 * options it cannot read, and node:net's connect or createConnection (named, default or namespace
 * import, or require) called with `path:` or with a single path-like argument.
 */
function unixConnects(file: string, code: string): { file: string; at: string; bun: boolean }[] {
  const at = (index: number) => `${file}:${lineOf(code, index)}: ${code.split("\n")[lineOf(code, index) - 1]!.trim().slice(0, 160)}`;
  /** The first argument of the call whose `(` ends at `open`. */
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
    // TCP is `{ host, port }` or `(port, host)`; a path, an options object with `path:` or anything unreadable is a unix socket
    if (arg.startsWith("{") ? /\bpath\s*:/.test(arg) : !/^\d|port/i.test(arg)) found.push({ file, at: at(match.index), bun: false });
  }
  return found;
}

describe("herdr socket", () => {
  // herdr closes the socket after each answer, so every RPC opens its own connection in
  // server/herdr/client.ts (no pooling), and only server/collector.ts holds a status
  // subscription (AGENTS.md, Bridge invariants).
  const UNIX_CONNECT_ALLOWED: Record<string, string> = {
    "server/herdr/client.ts": "the one herdr RPC client: one connection per call, plus subscribeEvents",
    "server/herdr-marker.ts": "a liveness probe: connects and ends at once, sends no request",
  };
  const NET_CONNECT_ALLOWED: Record<string, string> = {
    "server/ssh-askpass.ts": "the SSH askpass helper's own private socket, not herdr's",
    "server/herdr-core/adapter.ts": "a liveness probe of the core adapter's own socket before startup: sends no request",
    "server/herdr-core/runtime.ts": "a liveness probe of herdr-core's socket, not herdr's: connects and closes, sends nothing",
    "server/runtime-move-lock.ts": "the herdr-core move's own lock socket, not herdr's: asks which Ovis server holds it",
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

  // Server code calls herdr through the typed wrappers in server/herdr/client.ts (paneProcessInfo,
  // agentGet, paneSendText, paneSendKeys, …), never through herdrRpc itself: the wrapper is where a
  // method's params are typed (server/herdr/methods.ts), so `{ target }` to pane.process_info does
  // not compile there. herdrRpc's untyped fallback still takes any params given an explicit result
  // type, so this guard is what keeps server code off it. These files still call herdrRpc because
  // open PRs change them; a follow-up PR moves them to the wrappers once those PRs land.
  const HERDR_RPC_ALLOWED: Record<string, string> = {
    "server/conversation.ts": "open PRs #869 #912 #923 change it",
    "server/gjc-runtime.ts": "open PR #912 changes it",
    "server/hermes.ts": "open PR #910 changes it",
    "server/omo.ts": "open PR #923 changes it",
    "server/shell-agent.ts": "open PRs #885 #923 change it",
  };
  // Files that do not call herdrRpc on main yet but whose open PR adds a `pane.process_info` call.
  // They are exempt from the "no longer calls" check below. Remove an entry when its PR switches to
  // paneProcessInfo(paneId) (the better outcome), merges, or closes.
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
    // server/herdr-core/adapter.ts is the other end: it answers herdr's events.subscribe (the
    // collector's own, reaching it through HERDR_SOCKET) from hc's event stream of the same name;
    // hc's generated types, their generator and the hc connection only name that hc method as a type
    // server/herdr-core/pin-label.ts reads hc's own `labels` events for pins, never a pane's status;
    // server/herdr-core/machine-scope.ts only narrows hc's stream to one machine's events for that adapter
    const HC_STREAM_TYPES = ["server/herdr-core/adapter.ts", "server/herdr-core/hc-api.generated.ts", "scripts/hc-types.ts", "server/herdr-core/connection.ts", "server/herdr-core/pin-label.ts", "server/herdr-core/machine-scope.ts"];
    const raw = matches(files("{server,src,shared,scripts}/**/*.{ts,tsx,mjs,js}").filter((file) => !file.endsWith(".test.ts")), /["']events\.subscribe["']/).filter((match) => match.file !== "server/herdr/client.ts" && !HC_STREAM_TYPES.includes(match.file));
    fail([...subscribers, ...raw].map((match) => match.at),
      "server/collector.ts is the only status subscription (startStatusCollector), and `events.subscribe` is sent only by subscribeEvents in server/herdr/client.ts: take pane status from the collector's callbacks (onStatus, onPaneEnded, onBaseline) in server/index.ts instead of subscribing again.");
  });
});

describe("runtime gates", () => {
  /**
   * A gate on the runtime's name: a comparison with `"herdr-core"` or a `case` on it, any read of the
   * served runtime's name (`capabilities().runtime`), or a comparison of the chosen one (`runtime()`).
   * `"herdr"` alone names other things too (a turn's source, a query parameter), so it counts only
   * beside one of those reads.
   */
  const NAMED = /[!=]== ?"herdr-core"|\bcase "herdr-core"\s*:|\bcapabilities\(\)\.runtime\b|\bruntime\(\)\s*[!=]==/;

  // which runtime is served or named, not what it can do
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
      // the runtime told, not asked: /api/health's answer
      "return jsonResponse({ ok: true, runtime: runtime() });",
      // another herdr: a query parameter, a turn's source, a program started
      'const discover = url.searchParams.get("discover") === "herdr";',
      'if (source === "herdr" && tracked) return;',
      'switch (signal.source) { case "herdr": return turns.chat; default: return turns.herdr; }',
      'const command = process.env["OVIS_HERDR_BIN"] || "herdr";',
      // an ability read, which is what a gate should do
      'if (capabilities().attach === "pty-cli") watch();',
    ]) expect(NAMED.test(other)).toBe(false);
  });
});

describe("remote PC bundle boundary", () => {
  // scripts/build-remote-bundle.ts ships server/, shared/ and integrations/ but not src/ or relay/: code
  // there that imports either loads from a checkout, where every check runs, and not on a remote PC (#2220)
  const SRC_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']((?:\.\.\/)+(?:src|relay)\/[^"']*)["']/;
  // server/relay/ is in the bundle: only a path that resolves to the checkout's own src/ or relay/ counts
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
