import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";

import { createHash } from "node:crypto";
import { chmodSync, symlinkSync } from "node:fs";
import { codexAnswer, codexCard, codexDecision, CodexServers, launcherScript, onServedStatus, privateChain, privateFolder, serverArgs, servedQuestions, servedStatus, servedTurnEnd, servedPlan, servesCommands, serverSocket, shellScript, supportsCodexServer } from "./codex.ts";
import { parsePrompt } from "../dialogs/live.ts";
import { ApprovalHub } from "./hub.ts";

// a command approval recorded from Codex 0.171.0 on its own app server (`codex --remote` TUI, read-only sandbox)
const RECORDED = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "codex-app-server-approval-0.171.0.json"), "utf8")) as { id: number; method: string; params: Record<string, unknown> };

/**
 * Four commands of the shared check table (short, longer than the pane, a heredoc over lines, quotes and Korean), each
 * as Codex 0.171.0 asked it over its app server, as its shell ran it (strace's execve, Codex's shell snapshot aside),
 * and its TUI's dialog for it, recorded in an isolated herdr-core.
 */
const COMMANDS = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "codex-app-server-commands-0.171.0.json"), "utf8")) as
  { shape: string; request: { method: string; params: Record<string, unknown> }; executed: string; screen: string }[];

/**
 * What Codex 0.171.0's server sent Ovis's connection while its real TUI, on the same server, asked a question, ran a
 * subagent and titled the thread aside: the question as resuming the thread brought it back to a client that connected
 * while it waited, then the subagent's turn inside the pane's own. Recorded in an isolated CODEX_HOME.
 */
const STATUS = readFileSync(join(import.meta.dir, "..", "fixtures", "codex-app-server-status-0.171.0.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
const MAIN = "01a210a7-62bd-79a2-9c7b-0c09d625d336";

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  // short: a socket's path has at most 104 bytes on macOS
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cx-")));
  roots.push(dir);
  return dir;
}

/** Resolves when `file` holds a line `match` takes, or rejects after `ms`. */
function lineIn(file: string, match: (line: string) => boolean, ms = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const look = () => {
      const found = existsSync(file) ? readFileSync(file, "utf8").split("\n").find(match) : undefined;
      if (found === undefined) return false;
      watcher.close();
      clearTimeout(timer);
      resolve(found);
      return true;
    };
    const watcher = watch(dirname(file), () => void look());
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`no such line in ${file}`)); }, ms);
    look();
  });
}

describe("the command a card shows", () => {
  it("is the script the shell runs, with Codex's /bin/bash -lc and its quoting taken off", () => {
    expect(shellScript("/bin/bash -lc 'ls -la'")).toBe("ls -la");
    expect(shellScript("/bin/bash -c 'touch am-short.flag'")).toBe("touch am-short.flag");
    expect(shellScript(`/bin/zsh -lc 'echo '"'"'Ovis'"'"' "x"'`)).toBe(`echo 'Ovis' "x"`);
    expect(shellScript("/bin/bash -lc 'cat <<'\\''EOF'\\'' > a.txt\nfirst line\n\tthird\nEOF\nwc -l a.txt'"))
      .toBe("cat <<'EOF' > a.txt\nfirst line\n\tthird\nEOF\nwc -l a.txt");
    // a backslash before a line break joins the lines, in double quotes and out of them
    expect(shellScript('/bin/bash -c "printf %s A\\\nB"')).toBe("printf %s AB");
    expect(shellScript("/bin/bash -c ab\\\ncd")).toBe("abcd");
  });

  it("is the command as it is where it is not one shell script, or where the shell would read it otherwise", () => {
    expect(shellScript("ls -la")).toBe("ls -la");
    expect(shellScript("/bin/bash -lc 'ls' extra")).toBe("/bin/bash -lc 'ls' extra");
    expect(shellScript("/bin/bash -lc \"$(evil)\"")).toBe("/bin/bash -lc \"$(evil)\"");
    expect(shellScript("/bin/bash -lc 'unclosed")).toBe("/bin/bash -lc 'unclosed");
    expect(shellScript("python3 -c 'print(1)'")).toBe("python3 -c 'print(1)'");
  });

  it("is, for each recorded command, what the shell ran, character for character", () => {
    expect(COMMANDS.map(({ shape }) => shape)).toEqual(["short", "long", "multi", "quote"]);
    for (const { shape, request, executed } of COMMANDS) expect(codexCard(request.method, request.params)?.command, shape).toBe(executed);
  });

  it("is bound to the TUI's dialog that shows it, its lines wrapped by the pane, and to no other", () => {
    const hub = new ApprovalHub(join(root(), "h"), []);
    cleanups.push(() => hub.stop());
    for (const [at, { shape, request, screen }] of COMMANDS.entries()) {
      const pane = `w1:p${at}`;
      const parsed = parsePrompt("codex", screen);
      expect(parsed?.responder, shape).toBe("codex-approval");
      expect(parsed?.approvalCommand, shape).toBeString();
      expect(parsed?.approvalKind, shape).toBe("command");
      hub.hold(pane, { kind: "codex", decision: codexDecision }, codexCard(request.method, request.params)!, () => {});
      expect(hub.shown(pane, { command: parsed!.approvalCommand!, kind: "command" })?.command, shape).toBe(codexCard(request.method, request.params)!.command);
      const other = COMMANDS[(at + 1) % COMMANDS.length]!;
      expect(hub.shown(pane, { command: parsePrompt("codex", other.screen)!.approvalCommand!, kind: "command" }), shape).toBeNull();
      expect(hub.shown(pane, { command: null, kind: "edit" }), shape).toBeNull();
    }
  });

  it("binds a dialog that does not show its command only to the one request of its kind held", () => {
    const hub = new ApprovalHub(join(root(), "h"), []);
    cleanups.push(() => hub.stop());
    const source = { kind: "codex", decision: codexDecision };
    const make = codexCard(RECORDED.method, { ...RECORDED.params, command: "/bin/bash -lc 'make check'" })!;
    hub.hold("w1:p1", source, make, () => {});
    expect(hub.shown("w1:p1", { command: null, kind: "command" })?.command).toBe("make check");
    hub.hold("w1:p1", source, codexCard(RECORDED.method, { ...RECORDED.params, command: "/bin/bash -lc 'printf innocuous'" })!, () => {});
    // a clipped `$ make…` with two held: the screen cannot say which it is
    expect(hub.shown("w1:p1", { command: null, kind: "command" })).toBeNull();
    expect(hub.shown("w1:p1", { command: "make check", kind: "command" })?.command).toBe("make check");
  });

  it("comes from the recorded request with its reason and where it runs", () => {
    expect(codexCard(RECORDED.method, RECORDED.params))
      .toEqual({ command: "ls -la", description: "Do you approve running ls -la in the workspace with escalated permissions?\nin /home/user/work", dialog: "command" });
  });

  it("tells two runs of one command apart by where they run and what more they may do", () => {
    const elsewhere = codexCard(RECORDED.method, { ...RECORDED.params, cwd: "/srv/other", environmentId: "remote-1", additionalPermissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/srv"] } } });
    expect(elsewhere?.description).toBe("Do you approve running ls -la in the workspace with escalated permissions?\nin /srv/other\nenvironment: remote-1\nwith network: on\nwith write: /srv");
    expect(codexCard(RECORDED.method, { ...RECORDED.params, additionalPermissions: { network: null, fileSystem: { read: null, write: null, entries: [{ path: "/x" }] } } })).toBeNull();
  });

  it("leaves to the TUI a command of another kind, a network approval, and an edit whose changes were not announced", () => {
    expect(codexCard(RECORDED.method, { ...RECORDED.params, kind: "writeStdin" })).toBeNull();
    expect(codexCard(RECORDED.method, { ...RECORDED.params, networkApprovalContext: { host: "example.com" } })).toBeNull();
    expect(codexCard("item/fileChange/requestApproval", { itemId: "i1", reason: null })).toBeNull();
    expect(codexCard("item/tool/requestUserInput", RECORDED.params)).toBeNull();
  });

  it("shows an edit with its announced changes and permissions spelled out, and leaves an MCP server's form to the TUI", () => {
    const changes = new Map([["i1", [{ path: "/w/a.txt", kind: "add", diff: "+hello" }, { path: "/w/b.txt", kind: "update", diff: "-x\n+y", movePath: "/elsewhere/b.txt" }]]]);
    expect(codexCard("item/fileChange/requestApproval", { itemId: "i1", reason: "outside the workspace" }, changes))
      .toEqual({ command: "add /w/a.txt\n+hello\nupdate /w/b.txt -> /elsewhere/b.txt\n-x\n+y", description: "outside the workspace", dialog: "edit" });
    expect(codexCard("item/permissions/requestApproval", { reason: "needs the net", permissions: { network: { enabled: true }, fileSystem: { read: null, write: ["/srv"] } } }))
      .toEqual({ command: "network: on\nwrite: /srv", description: "needs the net", dialog: "grant" });
    expect(codexCard("item/permissions/requestApproval", { reason: "nothing", permissions: { network: null, fileSystem: null } })).toBeNull();
    expect(codexCard("mcpServer/elicitation/request", { mode: "form", serverName: "deploy", message: "Ship it?", requestedSchema: { type: "object", properties: {} } })).toBeNull();
  });
});

describe("a card's answer", () => {
  it("is accept for Yes, and for No what the TUI's No sends, which stops the turn", () => {
    expect(codexDecision("Yes, proceed (y)")).toBe("allow");
    expect(codexDecision("No, and tell Codex what to do differently (esc)")).toBe("deny");
    expect(codexDecision("Yes, and don't ask again for commands that start with `ls -la` (p)")).toBeNull();
    // the native answer grants for the turn: Codex 0.171.0's other grants go to the dialog as their keys
    expect(codexDecision("Yes, grant these permissions for this turn (y)")).toBe("allow");
    expect(codexDecision("Yes, grant these permissions for this session (s)")).toBeNull();
    expect(codexDecision("Yes, grant for this turn with strict auto review (r)")).toBeNull();
    expect(codexDecision("Yes, provide the requested info")).toBeNull();
    expect(codexAnswer(RECORDED.method, RECORDED.params, "allow")).toEqual({ decision: "accept" });
    expect(codexAnswer(RECORDED.method, RECORDED.params, "deny")).toEqual({ decision: "cancel" });
    expect(codexAnswer(RECORDED.method, { availableDecisions: ["accept", "decline"] }, "deny")).toEqual({ decision: "decline" });
    expect(codexAnswer("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: null } }, "allow"))
      .toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(codexAnswer("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: null } }, "deny")).toEqual({ permissions: {}, scope: "turn" });
  });
});

describe("which launches run on their own server", () => {
  it("takes only the Codex versions measured, and the arguments Ovis launches with", () => {
    expect(supportsCodexServer("0.169.0")).toBe(true);
    expect(supportsCodexServer("0.171.0")).toBe(true);
    expect(supportsCodexServer("0.168.9")).toBe(false);
    expect(supportsCodexServer("0.172.0")).toBe(false);
    expect(serverArgs(["--sandbox", "read-only", "--ask-for-approval", "on-request", "--model", "gpt-6", "-c", "model_reasoning_effort=high", "--", "hi -c x"]))
      .toEqual({ server: ["-c", "model_reasoning_effort=high"], tui: ["--sandbox", "read-only", "--ask-for-approval", "on-request", "--model", "gpt-6", "-c", "model_reasoning_effort=high", "--", "hi -c x"] });
    expect(serverArgs(["--config=a=1", "--enable", "x"])?.server).toEqual(["--config", "a=1", "--enable", "x"]);
    expect(serverArgs(["resume", "abc"])).toBeNull();
    expect(serverArgs(["--remote", "ws://x"])).toBeNull();
    expect(serverArgs(["-c"])).toBeNull();
  });

  it("writes a launcher of this account only for a measured version, and none otherwise", () => {
    const hub = new ApprovalHub(join(root(), "h"), []);
    const servers = new CodexServers(hub, { tmp: root() });
    cleanups.push(() => servers.stop());
    expect(servers.launch("w1:p1", ["--model", "m"], "0.168.0")).toBeNull();
    expect(servers.launch("w1:p1", ["resume", "x"], "0.171.0")).toBeNull();
    expect(servers.launch("w1:p1", ["--model", "m"], null)).toBeNull();
    const program = servers.launch("w1:p1", ["--model", "m"], "0.171.0")!;
    expect(statSync(program).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(program)).mode & 0o777).toBe(0o700);
    expect(readFileSync(program, "utf8")).toContain(`codex --remote "unix://$socket" '--model' 'm'`);
  });

  it("drops only the launch that failed: its folder, and the pane's wait while the pane is still that launch's", () => {
    const hub = new ApprovalHub(join(root(), "h"), []);
    const tmp = root();
    const servers = new CodexServers(hub, { tmp });
    cleanups.push(() => servers.stop());
    const first = servers.launch("w1:p1", [], "0.171.0")!;
    const second = servers.launch("w1:p1", [], "0.171.0")!;
    servers.abandon("w1:p1", first);
    expect(existsSync(dirname(first))).toBe(false);
    expect(existsSync(second)).toBe(true);
    // the pane is the second launch's still: its server is waited for
    writeFileSync(join(dirname(second), "elsewhere"), "");
    servers.abandon("w1:p1", join(tmp, "not-a-launch", "launch"));
    servers.abandon("w1:p1", second);
    expect(existsSync(dirname(second))).toBe(false);
  });
});

describe("where the launcher is written", () => {
  it("is a folder no other account can rename entries in", () => {
    const mine = 1000;
    const tmp = [{ uid: 0, mode: 0o755 }, { uid: 0, mode: 0o1777 }];
    expect(privateChain(tmp, mine)).toBe(true);
    expect(privateChain([{ uid: 0, mode: 0o755 }, { uid: mine, mode: 0o755 }], mine)).toBe(true);
    // writable by all or by a group, which another account may share: only a sticky one is private
    for (const mode of [0o777, 0o775, 0o770]) {
      expect(privateChain([{ uid: 0, mode: 0o755 }, { uid: mine, mode }], mine), mode.toString(8)).toBe(false);
      expect(privateChain([{ uid: 0, mode: 0o755 }, { uid: mine, mode: mode | 0o1000 }], mine), mode.toString(8)).toBe(true);
    }
    // a folder no other account can pass through shields what is under it
    expect(privateChain([{ uid: 0, mode: 0o755 }, { uid: mine, mode: 0o700 }, { uid: mine, mode: 0o777 }], mine)).toBe(true);
    // another account's folder on the way, or a writable one above a private one
    expect(privateChain([{ uid: 0, mode: 0o755 }, { uid: 1001, mode: 0o755 }, { uid: mine, mode: 0o700 }], mine)).toBe(false);
    expect(privateChain([{ uid: 0, mode: 0o755 }, { uid: mine, mode: 0o777 }, { uid: mine, mode: 0o700 }], mine)).toBe(false);

    // the path as resolved, not a link to it; none for a folder that is not there
    const dir = root();
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(dir, "link"));
    expect(privateFolder(join(dir, "link"))).toBe(real);
    expect(privateFolder(join(dir, "none"))).toBeNull();
  });
});

describe("the server's socket", () => {
  const listen = (path: string) => {
    const listener = Bun.listen({ unix: path, socket: { data() {} } });
    cleanups.push(() => listener.stop(true));
  };

  it("is the socket itself, or a link to the socket named for its path in a folder of this account only", () => {
    const dir = root();
    listen(join(dir, "own.sock"));
    expect(serverSocket(join(dir, "own.sock"))).toBe(true);
    const rendezvous = join(dir, "r");
    mkdirSync(rendezvous, { mode: 0o700 });
    const link = join(dir, "codex.sock");
    const target = join(rendezvous, createHash("sha256").update(link).digest("hex"));
    listen(target);
    symlinkSync(target, link);
    expect(serverSocket(link)).toBe(true);
  });

  it("is no link elsewhere, no folder others can write in, and no file", () => {
    const dir = root();
    const open = join(dir, "open");
    mkdirSync(open, { mode: 0o700 });
    const elsewhere = join(dir, "elsewhere.sock");
    const misnamed = join(open, "someone-else");
    listen(misnamed);
    symlinkSync(misnamed, elsewhere);
    expect(serverSocket(elsewhere)).toBe(false);
    const shared = join(dir, "shared.sock");
    const target = join(open, createHash("sha256").update(shared).digest("hex"));
    listen(target);
    symlinkSync(target, shared);
    chmodSync(open, 0o777);
    expect(serverSocket(shared)).toBe(false);
    writeFileSync(join(dir, "file.sock"), "");
    expect(serverSocket(join(dir, "file.sock"))).toBe(false);
    expect(serverSocket(join(dir, "none.sock"))).toBe(false);
  });
});

describe("the launcher", () => {
  /** A `codex` that logs how it was run; as `app-server` it listens on its socket until stopped, unless told to fail. */
  function stubCodex(dir: string): { bin: string; log: string } {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "codex.log");
    writeFileSync(join(bin, "stub.ts"), `
import { appendFileSync } from "node:fs";
const log = (line: string) => appendFileSync(${JSON.stringify(log)}, line + "\\n");
const args = process.argv.slice(2);
log(JSON.stringify(args));
if (args[0] === "app-server" && process.env.STUB_NO_SOCKET !== "1") {
  const path = args[args.indexOf("--listen") + 1]!.slice("unix://".length);
  const server = Bun.listen({ unix: path, socket: { data() {} } });
  process.on("SIGTERM", () => { log("server stopped"); server.stop(true); process.exit(0); });
}
`);
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(join(bin, "stub.ts"))} "$@"\n`, { mode: 0o755 });
    return { bin, log };
  }

  async function run(dir: string, env: Record<string, string> = {}) {
    const { bin, log } = stubCodex(dir);
    const folder = join(dir, "run");
    mkdirSync(folder, { mode: 0o700 });
    const program = join(folder, "launch");
    writeFileSync(program, launcherScript(folder, ["-c", "a=1"], ["--model", "m", "-c", "a=1", "--", "it's ok"], ["--model", "m", "-c", "a=1", "--", "it's ok"]), { mode: 0o700 });
    // a session of its own, as a pane's shell gives it its own terminal: its job control must not take the test runner's
    const launcher = Bun.spawn([program], { env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
    return { folder, log, exited: await launcher.exited };
  }

  it("starts the server on a socket in its folder, the TUI on it, then stops the server and removes the folder", async () => {
    const dir = root();
    const { folder, log, exited } = await run(dir);
    expect(exited).toBe(0);
    await lineIn(log, (line) => line === "server stopped");
    const runs = readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("[")).map((line) => JSON.parse(line) as string[]);
    expect(runs).toEqual([
      ["app-server", "-c", "a=1", "--listen", `unix://${folder}/codex.sock`],
      ["--remote", `unix://${folder}/codex.sock`, "--model", "m", "-c", "a=1", "--", "it's ok"],
    ]);
    expect(existsSync(folder)).toBe(false);
  });

  it("starts plain codex with the launch's arguments when the server does not come up", async () => {
    const dir = root();
    const { folder, log, exited } = await run(dir, { STUB_NO_SOCKET: "1" });
    expect(exited).toBe(0);
    const runs = readFileSync(log, "utf8").split("\n").filter((line) => line.startsWith("[")).map((line) => JSON.parse(line) as string[]);
    expect(runs).toEqual([["app-server", "-c", "a=1", "--listen", `unix://${folder}/codex.sock`], ["--model", "m", "-c", "a=1", "--", "it's ok"]]);
    expect(existsSync(folder)).toBe(false);
  });
});

describe("Ovis on the pane's Codex server", () => {
  type Message = Record<string, unknown>;

  /** A Codex app server of `version` on the launch's socket: what Ovis sends comes in order, and the test sends as Codex. */
  function codexServer(program: string, version = "0.171.0", loaded: string[] = []) {
    const received: Message[] = [];
    const waiting: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
    let client: ServerWebSocket<undefined> | null = null;
    const connected = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const resumeErrors = new Set<string>();
    const resumed = new Map<string, Message>();
    const server: Server<undefined> = Bun.serve({
      unix: join(dirname(program), "codex.sock"),
      fetch: (request, bun) => bun.upgrade(request) ? undefined : new Response("no", { status: 400 }),
      websocket: {
        open(socket) { client = socket; connected.resolve(); },
        close() { closed.resolve(); },
        message(socket, data) {
          const message = JSON.parse(String(data)) as Message;
          received.push(message);
          for (const wait of [...waiting]) if (wait.match(message)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(message); }
          const params = (message["params"] ?? {}) as Message;
          if (message["method"] === "initialize") socket.send(JSON.stringify({ id: message["id"], result: { userAgent: `ovis/${version} (Ubuntu; x86_64) xterm (ovis; 0)` } }));
          if (message["method"] === "thread/loaded/list") socket.send(JSON.stringify({ id: message["id"], result: { data: loaded, nextCursor: null } }));
          if (message["method"] === "thread/resume") {
            const refused = resumeErrors.delete(String(params["threadId"]));
            socket.send(JSON.stringify(refused ? { id: message["id"], error: { code: -32600, message: "no rollout found" } } : { id: message["id"], result: resumed.get(String(params["threadId"])) ?? {} }));
          }
        },
      },
    });
    cleanups.push(() => server.stop(true));
    return {
      received, connected: connected.promise, closed: closed.promise,
      send: (message: Message) => client!.send(JSON.stringify(message)),
      next: (match: (message: Message) => boolean) => new Promise<Message>((resolve) => {
        const found = received.find(match);
        if (found) resolve(found);
        else waiting.push({ match, resolve });
      }),
      refuseResume: (threadId: string) => resumeErrors.add(threadId),
      /** What resuming `threadId` answers: the thread as Codex describes it. */
      resumeWith: (threadId: string, thread: Message) => resumed.set(threadId, { thread }),
      drop: () => client!.close(),
    };
  }

  function launched(version = "0.171.0", loaded: string[] = []) {
    const waiting: (() => void)[] = [];
    const settling: (() => void)[] = [];
    const failures: (string | null)[] = [];
    const hub = new ApprovalHub(join(root(), "h"), [], { onHeld: () => waiting.shift()?.(), onSettled: () => settling.shift()?.(),
      onTurn: (_pane, _kind, event) => { if ("failed" in event && event.failed) failures.push(event.prompt); } });
    const servers = new CodexServers(hub, { tmp: root() });
    cleanups.push(() => { servers.stop(); hub.stop(); });
    const program = servers.launch("w1:p1", ["--model", "m"], "0.171.0")!;
    const codex = codexServer(program, version, loaded);
    const held = () => new Promise<void>((resolve) => waiting.push(resolve));
    const settled = () => new Promise<void>((resolve) => settling.push(resolve));
    return { hub, servers, codex, held, settled, failures, program };
  }

  /** Codex runs thread `id`: Ovis subscribes to it. */
  async function running(codex: ReturnType<typeof codexServer>, id = "t1") {
    await codex.next((message) => message["method"] === "thread/loaded/list");
    codex.send({ method: "thread/started", params: { thread: { id, parentThreadId: null, ephemeral: false } } });
    codex.send({ method: "thread/status/changed", params: { threadId: id, status: { type: "active", activeFlags: [] } } });
    await codex.next((message) => message["method"] === "thread/resume" && (message["params"] as Message)["threadId"] === id);
  }

  it("subscribes to a thread as it runs, again where Codex refused it before its first turn, and to none twice", async () => {
    const { codex } = launched();
    await codex.next((message) => message["method"] === "thread/loaded/list");
    codex.refuseResume("t1");
    codex.send({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "active", activeFlags: [] } } });
    const first = await codex.next((message) => message["method"] === "thread/resume");
    expect(first["params"]).toEqual({ threadId: "t1", excludeTurns: true });
    codex.send({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
    await codex.next((message) => message["method"] === "thread/resume" && message !== first);
    codex.send({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "active", activeFlags: [] } } });
    codex.send({ method: "thread/status/changed", params: { threadId: "t2", status: { type: "active", activeFlags: [] } } });
    await codex.next((message) => message["method"] === "thread/resume" && (message["params"] as Message)["threadId"] === "t2");
    expect(codex.received.filter((message) => message["method"] === "thread/resume").map((message) => (message["params"] as Message)["threadId"])).toEqual(["t1", "t1", "t2"]);
  });

  it("holds an approval as its card and answers Yes as accept", async () => {
    const { hub, codex, held } = launched();
    await running(codex);
    const holding = held();
    codex.send(RECORDED);
    await holding;
    const [card] = hub.held("w1:p1");
    expect(card).toMatchObject({ kind: "codex", command: "ls -la", description: "Do you approve running ls -la in the workspace with escalated permissions?\nin /home/user/work" });
    expect(hub.settle("w1:p1", card!.id, "allow")).toBe(true);
    expect(await codex.next((message) => message["id"] === RECORDED.id && "result" in message)).toEqual({ id: RECORDED.id, result: { decision: "accept" } });
  });

  it("answers No as the TUI's No, which stops the turn", async () => {
    const { hub, codex, held } = launched();
    await running(codex);
    const holding = held();
    codex.send(RECORDED);
    await holding;
    hub.settle("w1:p1", hub.held("w1:p1")[0]!.id, "deny");
    expect(await codex.next((message) => message["id"] === RECORDED.id && "result" in message)).toEqual({ id: RECORDED.id, result: { decision: "cancel" } });
  });

  it("releases a card the TUI answered first, and sends nothing for it", async () => {
    const { hub, codex, held } = launched();
    await running(codex);
    const holding = held();
    codex.send(RECORDED);
    await holding;
    const { id } = hub.held("w1:p1")[0]!;
    codex.send({ method: "serverRequest/resolved", params: { threadId: "t1", requestId: RECORDED.id } });
    // a request Ovis sends after the notification is read after it
    codex.send({ method: "thread/status/changed", params: { threadId: "t9", status: { type: "active", activeFlags: [] } } });
    await codex.next((message) => message["method"] === "thread/resume" && (message["params"] as Message)["threadId"] === "t9");
    expect(hub.held("w1:p1")).toEqual([]);
    expect(hub.settle("w1:p1", id, "allow")).toBe(false);
    expect(codex.received.filter((message) => message["id"] === RECORDED.id)).toEqual([]);
  });

  it("answers no other request, and releases what it holds when the server goes", async () => {
    const { hub, codex, held, settled } = launched();
    await running(codex);
    codex.send({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "t1", questions: [] } });
    const holding = held();
    codex.send(RECORDED);
    await holding;
    expect(hub.held("w1:p1")).toHaveLength(1);
    const released = settled();
    codex.drop();
    await released;
    expect(hub.held("w1:p1")).toEqual([]);
    expect(codex.received.filter((message) => message["id"] === 7 || message["id"] === RECORDED.id)).toEqual([]);
  });

  it("tells each turn's end as the server says it, its subagents' turns aside", async () => {
    const { codex } = launched();
    await running(codex);
    let subagents = 0;
    // a subagent's thread runs: Ovis subscribes to it too, and reads it after what came before
    const subagentRuns = async () => {
      const id = `s${++subagents}`;
      codex.send({ method: "thread/started", params: { thread: { id, parentThreadId: "t1", ephemeral: false } } });
      codex.send({ method: "thread/status/changed", params: { threadId: id, status: { type: "active", activeFlags: [] } } });
      codex.send({ method: "turn/completed", params: { threadId: id, turn: { id: `${id}u`, status: "completed", error: null } } });
      await codex.next((message) => message["method"] === "thread/resume" && (message["params"] as Message)["threadId"] === id);
    };
    expect(servedTurnEnd("w1:p1")).toBe("running");
    codex.send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "failed", error: { message: "usage limit" } } } });
    await subagentRuns();
    expect(servedTurnEnd("w1:p1")).toBe("failed");
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u2" } } });
    await subagentRuns();
    expect(servedTurnEnd("w1:p1")).toBe("running");
    codex.send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u2", status: "completed", error: null } } });
    await subagentRuns();
    expect(servedTurnEnd("w1:p1")).toBe("answered");
  });

  /** Resolves once Ovis has read everything sent before: it subscribes to a subagent's thread only after reading it. */
  let barriers = 0;
  async function read(codex: ReturnType<typeof codexServer>) {
    const id = `b${++barriers}`;
    codex.send({ method: "thread/started", params: { thread: { id, parentThreadId: "x", ephemeral: false } } });
    codex.send({ method: "thread/status/changed", params: { threadId: id, status: { type: "active", activeFlags: [] } } });
    await codex.next((message) => message["method"] === "thread/resume" && (message["params"] as Message)["threadId"] === id);
  }

  it("reports a terminal usage limit on a resumed main thread whose turn started before attachment", async () => {
    const { codex, failures } = launched("0.171.0", ["t1"]);
    codex.resumeWith("t1", { id: "t1", parentThreadId: null, ephemeral: false, status: { type: "active", activeFlags: [] } });
    await codex.next((message) => message["method"] === "thread/resume");
    await read(codex);
    expect(servedStatus("w1:p1")?.threadId).toBe("t1");
    codex.send({ method: "error", params: { threadId: "t1", turnId: "u1", willRetry: false,
      error: { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" } } });
    await read(codex);
    expect(failures).toEqual(["u1"]);
  });

  it("tells a terminal usage-limit error before completion and tells the turn's failure only once", async () => {
    const { codex, failures } = launched();
    await running(codex);
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } });
    // codex-cli 0.171.0 generated v2/ErrorNotification.json and TurnCompletedNotification.json.
    const error = { message: "Usage limit reached", codexErrorInfo: "usageLimitExceeded" };
    const notice = { error, threadId: "t1", turnId: "u1", willRetry: false };
    for (const params of [{ ...notice, willRetry: true }, { ...notice, threadId: "other" }, { ...notice, turnId: "old" }]) {
      codex.send({ method: "error", params });
    }
    await read(codex);
    expect(failures).toEqual([]);
    expect(servedTurnEnd("w1:p1")).toBe("running");

    codex.send({ method: "error", params: notice });
    await read(codex);
    expect(servedTurnEnd("w1:p1")).toBe("running");
    expect(failures).toEqual(["u1"]);
    const failedTurn = { status: "failed", items: [], error };
    codex.send({ method: "turn/completed", params: { threadId: "t1", turn: { ...failedTurn, id: "u1" } } });
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u2" } } });
    codex.send({ method: "turn/completed", params: { threadId: "t1", turn: { ...failedTurn, id: "u1" } } });
    codex.send({ method: "turn/completed", params: { threadId: "t1", turn: { ...failedTurn, id: "u2" } } });
    await read(codex);
    expect(failures).toEqual(["u1", "u2"]);
  });

  it("follows the pane's own thread as its server tells it, the side threads and a subagent's turn aside", async () => {
    const { codex } = launched();
    await codex.next((message) => message["method"] === "thread/loaded/list");
    const subagentEnds = STATUS.findIndex((message) => message["method"] === "turn/completed" && (message["params"] as Message)["threadId"] !== MAIN);
    const asked = STATUS.findIndex((message) => message["method"] === "item/tool/requestUserInput");
    for (const message of STATUS.slice(0, asked + 1)) codex.send(message);
    await read(codex);
    expect(servedQuestions("w1:p1")).toMatchObject([{ key: "1", threadId: MAIN, questions: [{ id: "size", header: "Size", question: "Pick a size", isOther: true, isSecret: false, options: [{ label: "Small (Recommended)" }, { label: "Large" }] }] }]);
    for (const message of STATUS.slice(asked + 1, subagentEnds + 1)) codex.send(message);
    await read(codex);
    expect(servedQuestions("w1:p1")).toEqual([]);
    expect(servedTurnEnd("w1:p1")).toBe("running");
    expect(servedStatus("w1:p1")).toEqual({ threadId: MAIN, context: { used: 12_844, window: 475_000 }, model: null });
    for (const message of STATUS.slice(subagentEnds + 1)) codex.send(message);
    await read(codex);
    expect(servedTurnEnd("w1:p1")).toBe("answered");
    expect(servedStatus("w1:p1")).toEqual({ threadId: MAIN, context: { used: 12_955, window: 475_000 }, model: null });
  });

  it("forgets a thread's turn end, questions and figures when the pane runs another thread", async () => {
    const { codex } = launched();
    await running(codex);
    codex.send({ id: 4, method: "item/tool/requestUserInput", params: { threadId: "t1", turnId: "u1", itemId: "i", isBlocking: false, questions: [{ id: "q", header: "Q", question: "Which?", options: null }] } });
    codex.send({ method: "thread/tokenUsage/updated", params: { threadId: "t1", turnId: "u1", tokenUsage: { last: { totalTokens: 500 }, total: { totalTokens: 900 }, modelContextWindow: 1000 } } });
    codex.send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "failed", error: null } } });
    await read(codex);
    expect(servedTurnEnd("w1:p1")).toBe("failed");
    expect(servedQuestions("w1:p1")).toHaveLength(1);
    codex.send({ method: "thread/started", params: { thread: { id: "t2", parentThreadId: null, ephemeral: false } } });
    await read(codex);
    expect([servedTurnEnd("w1:p1"), servedQuestions("w1:p1"), servedStatus("w1:p1")]).toEqual([null, [], { threadId: "t2", context: null, model: null }]);
    codex.send({ method: "turn/completed", params: { threadId: "t1", turn: { id: "u1", status: "completed", error: null } } });
    codex.send({ method: "thread/tokenUsage/updated", params: { threadId: "t1", turnId: "u1", tokenUsage: { last: { totalTokens: 600 }, total: { totalTokens: 900 }, modelContextWindow: 1000 } } });
    await read(codex);
    expect([servedTurnEnd("w1:p1"), servedStatus("w1:p1")?.context]).toEqual([null, null]);
  });

  it("takes no subagent's turn for the pane's own, also when it starts before the parent tells of it", async () => {
    const { codex } = launched();
    await running(codex);
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1", rootTurnId: "u1" } } });
    codex.send({ method: "turn/started", params: { threadId: "s1", turn: { id: "v1", rootTurnId: "u1" } } });
    codex.send({ method: "turn/completed", params: { threadId: "s1", turn: { id: "v1", status: "completed", error: null } } });
    await read(codex);
    expect([servedTurnEnd("w1:p1"), servedStatus("w1:p1")?.threadId]).toEqual(["running", "t1"]);
  });

  it("takes, of the threads loaded as it connects, one that runs over an idle one", async () => {
    const { codex } = launched("0.171.0", ["a", "b"]);
    codex.resumeWith("a", { id: "a", parentThreadId: null, ephemeral: false, status: { type: "idle" } });
    codex.resumeWith("b", { id: "b", parentThreadId: null, ephemeral: false, status: { type: "active", activeFlags: [] } });
    await codex.next((message) => message["method"] === "thread/resume" && (message["params"] as Message)["threadId"] === "b");
    await read(codex);
    expect(servedStatus("w1:p1")?.threadId).toBe("b");
  });

  it("names the model Codex moved a turn to until the next turn, and forgets all with the server", async () => {
    const { codex } = launched();
    await running(codex);
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } });
    codex.send({ method: "model/rerouted", params: { threadId: "t1", turnId: "u1", fromModel: "m", toModel: "m-safe", reason: "highRiskCyberActivity" } });
    codex.send({ method: "model/rerouted", params: { threadId: "t2", turnId: "v1", fromModel: "m", toModel: "other", reason: "highRiskCyberActivity" } });
    codex.send({ id: 3, method: "item/tool/requestUserInput", params: { threadId: "t1", turnId: "u1", itemId: "i", isBlocking: true, questions: [{ id: "q", header: "Q", question: "Which?", options: null }] } });
    await read(codex);
    expect(servedStatus("w1:p1")).toEqual({ threadId: "t1", context: null, model: "m-safe" });
    expect(servedQuestions("w1:p1")).toHaveLength(1);
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u2" } } });
    // a late reroute of the turn before names no model of this one
    codex.send({ method: "model/rerouted", params: { threadId: "t1", turnId: "u1", fromModel: "m", toModel: "m-safe", reason: "highRiskCyberActivity" } });
    await read(codex);
    expect(servedStatus("w1:p1")?.model).toBeNull();
    const told = new Promise<string>((resolve) => { const stop = onServedStatus((paneId) => { stop(); resolve(paneId); }); });
    codex.drop();
    expect(await told).toBe("w1:p1");
    expect(servedStatus("w1:p1")).toBeNull();
    expect(servedQuestions("w1:p1")).toEqual([]);
  });

  const request = (codex: ReturnType<typeof codexServer>, method: string) => codex.next((message) => message["method"] === method);
  const idle = (codex: ReturnType<typeof codexServer>) => codex.send({ method: "thread/status/changed", params: { threadId: "t1", status: { type: "idle" } } });

  it.each(["other thread loaded during pane checks", "parent with a loaded subagent"])("checks the steer target at the write: %s", async (scenario) => {
    const loaded = ["t1"];
    const { codex, servers, program } = launched("0.171.0", loaded);
    await running(codex);
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "turn" } } });
    if (scenario === "parent with a loaded subagent") {
      codex.send({ method: "thread/started", params: { thread: { id: "child", parentThreadId: "t1" } } });
      loaded.push("child");
    }
    await read(codex);
    const target = servers.steerTarget("w1:p1", ["codex", "--remote", `unix://${join(dirname(program), "codex.sock")}`])!;
    const result = target.send("message", crypto.randomUUID(), async () => {
      if (scenario === "other thread loaded during pane checks") loaded.push("t2");
    }, () => {});
    const outcome = await Promise.race([result, request(codex, "turn/steer")]);
    if (scenario === "other thread loaded during pane checks") expect(outcome).toBe("changed");
    else {
      expect(outcome).toMatchObject({ method: "turn/steer" });
      codex.send({ id: (outcome as Message).id, result: { turnId: "turn" } });
      expect(await result).toBe("accepted");
    }
  });

  it.each(["matching reply", "wrong turn", "lost reply"])("attributes a Send now to its own turn/steer request: %s", async (reply) => {
    const { codex, servers, program } = launched("0.171.0", ["t1"]);
    await running(codex);
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "turn" } } });
    await read(codex);
    expect(servers.steerTarget("w1:p1", ["codex"])).toBeNull();
    const target = servers.steerTarget("w1:p1", ["codex", "--remote", `unix://${join(dirname(program), "codex.sock")}`])!;
    const id = crypto.randomUUID();
    const result = target.send("repeat", id, async () => {}, () => {});
    const steer = await request(codex, "turn/steer");
    expect(steer.params).toEqual({ threadId: "t1", expectedTurnId: "turn", clientUserMessageId: id, input: [{ type: "text", text: "repeat", text_elements: [] }] });
    codex.send({ id: -1, result: { turnId: "turn" } });
    if (reply === "lost reply") codex.drop();
    else codex.send({ id: steer.id, result: { turnId: reply === "matching reply" ? "turn" : "other" } });
    expect(await result).toBe(reply === "matching reply" ? "accepted" : "unknown");
  });

  it("runs a bare /plan as the TUI does: Plan mode with Plan's own effort and the thread's model as it is then", async () => {
    const { codex } = launched("0.171.0", ["t1"]);
    await running(codex);
    codex.send({ method: "thread/settings/updated", params: { threadId: "t1", threadSettings: { model: "gpt-6.2-astra", effort: "low" } } });
    idle(codex);
    await read(codex);
    const sent = servedPlan("w1:p1", "t1", () => true);
    const modes = await request(codex, "collaborationMode/list");
    const config = await request(codex, "config/read");
    // the user switched models while Ovis looked Plan up: the update keeps the new one
    codex.send({ method: "thread/settings/updated", params: { threadId: "t1", threadSettings: { model: "gpt-6.2-sol" } } });
    await read(codex);
    codex.send({ id: modes["id"], result: { data: [{ name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" }, { name: "Default", mode: "default", model: null, reasoning_effort: null }] } });
    codex.send({ id: config["id"], result: { config: {} } });
    const update = await request(codex, "thread/settings/update");
    expect(update["params"]).toEqual({ threadId: "t1", collaborationMode: { mode: "plan", settings: { model: "gpt-6.2-sol", reasoning_effort: "medium", developer_instructions: null } } });
    codex.send({ id: update["id"], result: {} });
    expect(await sent).toBe("applied");
  });

  it("takes Plan's effort from Codex's config where it sets one", async () => {
    const { codex } = launched("0.171.0", ["t1"]);
    await running(codex);
    codex.send({ method: "thread/settings/updated", params: { threadId: "t1", threadSettings: { model: "m" } } });
    idle(codex);
    await read(codex);
    const sent = servedPlan("w1:p1", "t1", () => true);
    codex.send({ id: (await request(codex, "collaborationMode/list"))["id"], result: { data: [{ name: "Plan", mode: "plan", reasoning_effort: "medium" }] } });
    codex.send({ id: (await request(codex, "config/read"))["id"], result: { config: { plan_mode_reasoning_effort: "high" } } });
    const update = await request(codex, "thread/settings/update");
    expect((update["params"] as { collaborationMode: { settings: { reasoning_effort: string } } }).collaborationMode.settings.reasoning_effort).toBe("high");
    codex.send({ id: update["id"], result: {} });
    expect(await sent).toBe("applied");
  });

  it("sends no /plan while a turn runs or may run, for another thread, before the model is known, or once the sender is revoked", async () => {
    const { codex } = launched("0.171.0", ["t1"]);
    await running(codex);
    // running(): the thread is active, so not idle
    codex.send({ method: "thread/settings/updated", params: { threadId: "t1", threadSettings: { model: "m" } } });
    await read(codex);
    expect(await servedPlan("w1:p1", "t1", () => true)).toBe("unsent");
    idle(codex);
    await read(codex);
    expect(await servedPlan("w1:p1", "t2", () => true)).toBe("unsent");
    expect(await servedPlan("w9:p9", "t1", () => true)).toBe("unsent");
    const revoked = servedPlan("w1:p1", "t1", () => false);
    codex.send({ id: (await request(codex, "collaborationMode/list"))["id"], result: { data: [{ name: "Plan", mode: "plan", reasoning_effort: "medium" }] } });
    codex.send({ id: (await request(codex, "config/read"))["id"], result: { config: {} } });
    expect(await revoked).toBe("unsent");
    codex.send({ method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } });
    await read(codex);
    expect(await servedPlan("w1:p1", "t1", () => true)).toBe("unsent");
    expect(codex.received.filter((message) => message["method"] === "thread/settings/update")).toEqual([]);
    expect(servesCommands("w1:p1")).toBe(true);
    expect(servesCommands("w9:p9")).toBe(false);
  });

  it("calls a /plan whose server went before it answered unknown, and one it refused unsent", async () => {
    const { codex } = launched("0.171.0", ["t1"]);
    await running(codex);
    codex.send({ method: "thread/settings/updated", params: { threadId: "t1", threadSettings: { model: "m" } } });
    idle(codex);
    await read(codex);
    const answerLookups = async () => {
      codex.send({ id: (await codex.next((message) => message["method"] === "collaborationMode/list" && !answered.has(message)))["id"], result: { data: [{ name: "Plan", mode: "plan", reasoning_effort: "medium" }] } });
      codex.send({ id: (await codex.next((message) => message["method"] === "config/read" && !answered.has(message)))["id"], result: { config: {} } });
      for (const message of codex.received) if (message["method"] === "collaborationMode/list" || message["method"] === "config/read") answered.add(message);
    };
    const answered = new Set<Record<string, unknown>>();
    const refused = servedPlan("w1:p1", "t1", () => true);
    await answerLookups();
    const first = await request(codex, "thread/settings/update");
    codex.send({ id: first["id"], error: { code: -32600, message: "no" } });
    expect(await refused).toBe("unsent");
    const dropped = servedPlan("w1:p1", "t1", () => true);
    await answerLookups();
    await codex.next((message) => message["method"] === "thread/settings/update" && message !== first);
    codex.drop();
    expect(await dropped).toBe("unknown");
  });

  it("sends no /plan when Codex's config cannot be read, which may set Plan's effort", async () => {
    const { codex } = launched("0.171.0", ["t1"]);
    await running(codex);
    codex.send({ method: "thread/settings/updated", params: { threadId: "t1", threadSettings: { model: "m" } } });
    idle(codex);
    await read(codex);
    const sent = servedPlan("w1:p1", "t1", () => true);
    codex.send({ id: (await request(codex, "collaborationMode/list"))["id"], result: { data: [{ name: "Plan", mode: "plan", reasoning_effort: "medium" }] } });
    codex.send({ id: (await request(codex, "config/read"))["id"], error: { code: -32603, message: "unreadable" } });
    expect(await sent).toBe("unsent");
    expect(codex.received.filter((message) => message["method"] === "thread/settings/update")).toEqual([]);
  });

  it("sends no /plan while another thread is loaded, which the TUI may show after a /resume or /new", async () => {
    const { codex } = launched("0.171.0", ["t1", "t9"]);
    await running(codex);
    codex.send({ method: "thread/settings/updated", params: { threadId: "t1", threadSettings: { model: "m" } } });
    idle(codex);
    await read(codex);
    const sent = servedPlan("w1:p1", "t1", () => true);
    codex.send({ id: (await request(codex, "collaborationMode/list"))["id"], result: { data: [{ name: "Plan", mode: "plan", reasoning_effort: "medium" }] } });
    codex.send({ id: (await request(codex, "config/read"))["id"], result: { config: {} } });
    expect(await sent).toBe("unsent");
    expect(codex.received.filter((message) => message["method"] === "thread/settings/update")).toEqual([]);
  });

  it("leaves a server of a version not measured to the TUI and the screen", async () => {
    const { hub, codex } = launched("0.172.0");
    await codex.connected;
    await codex.closed;
    expect(codex.received.map((message) => message["method"])).toEqual(["initialize"]);
    expect(hub.held("w1:p1")).toEqual([]);
    expect(servedTurnEnd("w1:p1")).toBeNull();
  });
});
