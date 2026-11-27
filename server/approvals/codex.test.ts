import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";

import { createHash } from "node:crypto";
import { chmodSync, symlinkSync } from "node:fs";
import { codexAnswer, codexCard, codexDecision, CodexServers, launcherScript, onServedStatus, privateChain, privateFolder, serverArgs, servedQuestions, servedStatus, servedTurnEnd, servedPlan, servedTurn, servesCommands, serverSocket, shellScript, supportsCodexServer } from "./codex.ts";
import * as rollout from "../codex.ts";
import { ConversationMonitor } from "../conversation-monitor.ts";
import { paneConversation } from "../conversation.ts";
import { parsePrompt } from "../dialogs/live.ts";
import * as herdr from "../herdr/client.ts";
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
  function codexServer(program: string, version = "0.171.0", loaded: string[] = [], threads: Record<string, Message | (() => Message)> = {}) {
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
          if (message["method"] === "thread/read") {
            const entry = threads[String(params["threadId"])];
            const read = typeof entry === "function" ? entry() : entry;
            socket.send(JSON.stringify(read === undefined ? { id: message["id"], error: { code: -32600, message: "thread not loaded" } } : { id: message["id"], result: read }));
          }
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
      resumeWith: (threadId: string, thread: Message, settings: Message = {}) => resumed.set(threadId, { ...settings, thread }),
      drop: () => client!.close(),
    };
  }

  function launched(version = "0.171.0", loaded: string[] = [], threads: Record<string, Message | (() => Message)> = {}) {
    const waiting: (() => void)[] = [];
    const settling: (() => void)[] = [];
    const failures: (string | null)[] = [];
    const hub = new ApprovalHub(join(root(), "h"), [], { onHeld: () => waiting.shift()?.(), onSettled: () => settling.shift()?.(),
      onTurn: (_pane, _kind, event) => { if ("failed" in event && event.failed) failures.push(event.prompt); } });
    const servers = new CodexServers(hub, { tmp: root() });
    cleanups.push(() => { servers.stop(); hub.stop(); });
    const program = servers.launch("w1:p1", ["--model", "m"], "0.171.0")!;
    const codex = codexServer(program, version, loaded, threads);
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

  function chatRollouts() {
    const paneId = "w1:p1";
    const dir = root();
    const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({
      protocol: 1, version: "test", workspaces: [], tabs: [], layouts: [], agents: [],
      panes: [{ pane_id: paneId, workspace_id: "w1", tab_id: "w1:t1", terminal_id: paneId, cwd: dir, agent: "codex", agent_status: "idle", revision: 0, focused: true }],
    });
    const processInfo = spyOn(herdr, "paneProcessInfo").mockResolvedValue({ pane_id: paneId, foreground_processes: [] });
    const transcript = spyOn(rollout, "codexTranscriptPath").mockResolvedValue(null);
    cleanups.push(() => { transcript.mockRestore(); processInfo.mockRestore(); snapshot.mockRestore(); });
    const show = (threadId: string) => {
      const path = join(dir, `rollout-2026-11-26T00-00-00-${threadId}.jsonl`);
      writeFileSync(path, [
        { type: "session_meta", payload: { id: threadId, cwd: dir } },
        { type: "turn_context", payload: { model: "gpt-6.2-sol", effort: "low" } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      transcript.mockResolvedValue({ path, how: "inferred" });
    };
    return { paneId, dir, show, conversation: () => paneConversation(paneId, dir) };
  }

  it("refreshes chat model, effort and Plan mode from its own Codex thread without a rollout write", async () => {
    const { codex } = launched();
    const { paneId, dir, show, conversation } = chatRollouts();
    show(MAIN);
    let update = Promise.withResolvers<string>();
    const monitor = new ConversationMonitor((_, signature) => update.resolve(signature), dir);
    cleanups.push(() => monitor.stop());

    // A fixture from Codex 0.171.0's generated ThreadSettingsUpdatedNotification and ThreadSettings.
    const settings = (threadId: string, effort: string | null, mode: "plan" | "default", model = "gpt-6.2-sol") => ({
      method: "thread/settings/updated",
      params: { threadId, threadSettings: {
        disabledPluginIds: [], cwd: dir, approvalPolicy: "on-request", approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false }, activePermissionProfile: null,
        model, modelProvider: "openai", serviceTier: null, effort, summary: null,
        collaborationMode: { mode, settings: { model, reasoning_effort: effort, developer_instructions: null } },
        personality: null,
      } },
    });
    await running(codex, MAIN);
    monitor.watch(paneId);
    const beforeSignature = await update.promise;
    const before = await conversation();
    expect(before.metadata).toEqual({ model: "gpt-6.2-sol", reasoning_effort: "low" });

    update = Promise.withResolvers<string>();
    codex.send(settings(MAIN, "high", "plan", "gpt-6.2-astra"));
    codex.send(settings("another-thread", "medium", "default"));
    await read(codex);
    const planned = await conversation();
    expect(planned.metadata).toEqual({ model: "gpt-6.2-astra", reasoning_effort: "high", permission_mode: "plan" });
    expect(planned.version).not.toBe(before.version);
    expect(await update.promise).not.toBe(beforeSignature);

    codex.send({ method: "turn/started", params: { threadId: MAIN, turn: { id: "turn" } } });
    codex.send({ method: "model/rerouted", params: { threadId: MAIN, turnId: "turn", toModel: "rerouted" } });
    codex.send({ method: "turn/completed", params: { threadId: MAIN, turn: { status: "completed" } } });
    await read(codex);
    expect((await conversation()).metadata.model).toBe("rerouted");
    codex.send(settings(MAIN, null, "default"));
    await read(codex);
    expect((await conversation()).metadata).toEqual(before.metadata);
  });

  it("shows start settings, then picks up a greeting's unsent Plan change on the first successful resume", async () => {
    const { codex } = launched();
    const { paneId, show, conversation } = chatRollouts();
    const active = { method: "thread/status/changed", params: { threadId: MAIN, status: { type: "active", activeFlags: [] } } };
    await codex.next((message) => message["method"] === "thread/loaded/list");
    codex.send({ method: "thread/started", params: { thread: { id: MAIN, parentThreadId: null, status: { type: "idle" }, model: "gpt-6.2-sol", reasoningEffort: "low" } } });
    await read(codex);
    expect(servedStatus(paneId)).toMatchObject({ settings: { model: "gpt-6.2-sol", effort: "low", plan: null } });

    // Observed on 0.171.0: the greeting sends no settings notification to the observer, and
    // even an early subscription is refused until the rollout exists.
    codex.refuseResume(MAIN);
    codex.send(active);
    await read(codex);
    codex.resumeWith(MAIN, { id: MAIN, parentThreadId: null, status: { type: "active" } }, {
      model: "gpt-6.2-astra", reasoningEffort: "high",
      collaborationMode: { mode: "plan", settings: { model: "gpt-6.2-astra", reasoning_effort: "high", developer_instructions: null } },
    });
    show(MAIN);
    codex.send(active);
    await read(codex);
    expect((await conversation()).metadata).toEqual({ model: "gpt-6.2-astra", reasoning_effort: "high", permission_mode: "plan" });
  });

  it("follows the chat's verified idle resume without taking another loaded thread's settings", async () => {
    const other = "01a210a7-62bd-79a2-9c7b-0c09d625d337";
    const loaded = [MAIN];
    const { codex } = launched("0.171.0", loaded);
    const { paneId, show, conversation } = chatRollouts();
    await running(codex, MAIN);
    show(MAIN);
    expect((await conversation()).metadata.reasoning_effort).toBe("low");

    // Loading B in the TUI broadcasts idle, not thread/started or turn/started. A remains loaded.
    loaded.push(other);
    codex.resumeWith(other, { id: other, parentThreadId: null, status: { type: "idle" } }, {
      model: "gpt-6.2-astra", reasoningEffort: "medium", collaborationMode: { mode: "default" },
    });
    codex.send({ method: "thread/status/changed", params: { threadId: other, status: { type: "idle" } } });
    await read(codex);
    expect(servedStatus(paneId)?.threadId).toBe(MAIN);
    const followed = Promise.withResolvers<void>();
    const stop = onServedStatus((pane) => {
      if (pane === paneId && servedStatus(pane)?.threadId === other) followed.resolve();
    });
    const timer = setTimeout(() => followed.reject(new Error("Ovis did not follow the verified idle rollout")), 1_000);
    try {
      show(other);
      await conversation();
      await followed.promise;
      codex.send({ method: "thread/settings/updated", params: { threadId: MAIN, threadSettings: { model: "other-model", effort: "high", collaborationMode: { mode: "plan" } } } });
      await read(codex);
      expect((await conversation()).metadata).toEqual({ model: "gpt-6.2-astra", reasoning_effort: "medium" });
    } finally {
      clearTimeout(timer);
      stop();
    }
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

  describe("a chat message as a new turn of the pane's own thread", () => {
    /**
     * Codex 0.171.0's turn/start as a second client sent it on the idle thread of a real TUI (codex --remote) whose
     * input box held a draft, and its answer: the TUI drew the message and its answer and kept the draft, and the
     * thread's user message carried the client's id. Recorded in an isolated CODEX_HOME.
     */
    const TURN = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "codex-app-server-turn-start-0.171.0.json"), "utf8")) as
      { request: { threadId: string; clientUserMessageId: string; input: { text: string }[] }; response: Message };
    const THREAD = TURN.request.threadId;
    const TURN_ID = String((TURN.response["turn"] as Message)["id"]);

    /**
     * What Codex 0.171.0's server told the client that started a turn, up to that turn's end: one interrupted, one whose
     * model request was refused. Recorded from `codex app-server` in an isolated CODEX_HOME with no model behind it.
     */
    const ENDS = JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "codex-app-server-turn-ends-0.171.0.json"), "utf8")) as
      Record<"interrupted" | "failed", { threadId: string; response: Message; told: Message[] }>;

    /** The first of `loaded` is the pane's own thread, at rest. */
    async function atRest(loaded: string[] = [THREAD]) {
      const { codex } = launched("0.171.0", loaded);
      await running(codex, loaded[0]);
      codex.send({ method: "thread/status/changed", params: { threadId: loaded[0], status: { type: "idle" } } });
      await read(codex);
      return codex;
    }
    const send = (mayWrite = () => true) => servedTurn("w1:p1", THREAD, TURN.request.input[0]!.text, TURN.request.clientUserMessageId, mayWrite);
    /** `send()` as Codex took it: the turn its recorded answer names. */
    async function taken(codex: ReturnType<typeof codexServer>) {
      const sent = send();
      const start = await request(codex, "turn/start");
      codex.send({ id: start["id"], result: TURN.response });
      const turn = await sent;
      if (typeof turn === "string" || turn.turn !== "started") throw new Error(`turn/start was not taken: ${JSON.stringify(turn)}`);
      return turn;
    }
    /** What `over` has settled as by now, once everything sent before was read. */
    async function soFar(codex: ReturnType<typeof codexServer>, over: Promise<boolean>): Promise<boolean | "pending"> {
      let settled: boolean | "pending" = "pending";
      void over.then((told) => { settled = told; });
      await read(codex);
      return settled;
    }
    const ends = (turn: string, status = "completed", threadId = THREAD) => ({ method: "turn/completed", params: { threadId, turn: { id: turn, status, error: null } } });

    it("starts it as Codex took it from a second client, and takes the turn it answers as sent", async () => {
      const codex = await atRest();
      const sent = send();
      const start = await request(codex, "turn/start");
      expect(start["params"]).toEqual(TURN.request);
      codex.send({ id: start["id"], result: TURN.response });
      expect(await sent).toMatchObject({ turn: "started" });
    });

    it.each(["another thread is loaded", "the sender may no longer write"])("sends nothing when %s", async (scenario) => {
      const codex = await atRest(scenario === "another thread is loaded" ? [THREAD, "other"] : [THREAD]);
      const sent = send(() => scenario !== "the sender may no longer write");
      expect(await sent).toBe("unsent");
      expect(codex.received.some((message) => message["method"] === "turn/start")).toBe(false);
    });

    it("starts no second turn on one it took whose turn/started has not come yet, and names that turn as the one that runs", async () => {
      const codex = await atRest();
      const first = await taken(codex);
      // nor once the end of the turn before is told, behind the answer that named this one
      codex.send(ends("u0"));
      await read(codex);
      const second = await send();
      expect(second).toMatchObject({ turn: "running" });
      expect(codex.received.filter((message) => message["method"] === "turn/start")).toHaveLength(1);
      codex.send(ends(TURN_ID));
      expect(await Promise.all([first.over, typeof second === "string" ? null : second.over])).toEqual([true, true]);
    });

    it("tells the end of the turn it started by that turn's own turn/completed, not by a subagent's or an earlier turn's, nor by the thread reading idle", async () => {
      const codex = await atRest();
      const turn = await taken(codex);
      codex.send({ method: "turn/started", params: { threadId: THREAD, turn: { id: TURN_ID, rootTurnId: TURN_ID } } });
      // a subagent's turn names the parent's as its root and ends on its own thread (codex-app-server-status-0.171.0.jsonl)
      codex.send({ method: "turn/started", params: { threadId: "sub", turn: { id: "v1", rootTurnId: TURN_ID } } });
      codex.send(ends("v1", "completed", "sub"));
      // nor is the end of the turn before, told late
      codex.send(ends("u0"));
      // and the thread reads idle before its turn/completed comes, as recorded there
      codex.send({ method: "thread/status/changed", params: { threadId: THREAD, status: { type: "idle" } } });
      expect(await soFar(codex, turn.over)).toBe("pending");
      codex.send(ends(TURN_ID));
      expect(await turn.over).toBe(true);
    });

    it.each(["interrupted", "failed"] as const)("takes a turn that ended %s as ended by its own turn/completed, as Codex told it", async (how) => {
      const { threadId, response, told } = ENDS[how];
      const codex = await atRest([threadId]);
      const sent = servedTurn("w1:p1", threadId, "first", crypto.randomUUID(), () => true);
      const start = await request(codex, "turn/start");
      codex.send({ id: start["id"], result: response });
      const turn = await sent;
      if (typeof turn === "string") throw new Error(`turn/start was not taken: ${turn}`);
      // the thread stops running the turn first: it reads idle, or systemError for a turn that failed
      for (const message of told.slice(0, -1)) codex.send(message);
      expect(await soFar(codex, turn.over)).toBe("pending");
      codex.send(told.at(-1)!);
      expect(await turn.over).toBe(true);
    });

    it("takes a turn whose end came before its answer as ended", async () => {
      const codex = await atRest();
      const sent = send();
      const start = await request(codex, "turn/start");
      codex.send(ends(TURN_ID));
      codex.send({ id: start["id"], result: TURN.response });
      const turn = await sent;
      expect(turn).toMatchObject({ turn: "started" });
      expect(typeof turn === "string" ? null : await turn.over).toBe(true);
    });

    const begins = (turn: string) => ({ method: "turn/started", params: { threadId: THREAD, turn: { id: turn, rootTurnId: turn } } });

    it("takes no turn/completed that names no turn for the end of the turn it waits for: that end can no longer be told", async () => {
      const codex = await atRest();
      const turn = await taken(codex);
      codex.send({ method: "turn/completed", params: { threadId: THREAD, turn: { status: "completed", error: null } } });
      expect(await soFar(codex, turn.over)).toBe(false);
    });

    it("takes a turn as over when its answer comes after its end and a later turn's", async () => {
      const codex = await atRest();
      const sent = send();
      const start = await request(codex, "turn/start");
      for (const message of [ends(TURN_ID), begins("u9"), ends("u9")]) codex.send(message);
      codex.send({ id: start["id"], result: TURN.response });
      const turn = await sent;
      if (typeof turn === "string") throw new Error(`turn/start was not taken: ${turn}`);
      expect(await soFar(codex, turn.over)).toBe(true);
    });

    it("takes a turn as over once a later turn of the thread starts, its own end never told", async () => {
      const codex = await atRest();
      const turn = await taken(codex);
      codex.send(begins("u9"));
      expect(await soFar(codex, turn.over)).toBe(true);
    });

    it("waits for the end of a turn the TUI started first, which Codex steered with the message and answered with", async () => {
      const codex = await atRest();
      const sent = send();
      const start = await request(codex, "turn/start");
      codex.send(begins("uB"));
      codex.send({ id: start["id"], result: { turn: { id: "uB", rootTurnId: "uB", status: "inProgress" } } });
      const turn = await sent;
      if (typeof turn === "string") throw new Error(`turn/start was not taken: ${turn}`);
      expect(turn.turn).toBe("started");
      expect(await soFar(codex, turn.over)).toBe("pending");
      codex.send(ends("uB"));
      expect(await turn.over).toBe(true);
    });

    it("names no running turn of a thread the TUI may have left for another one it loaded", async () => {
      const codex = await atRest([THREAD, "other"]);
      codex.send(begins("u1"));
      await read(codex);
      expect(await send()).toBe("unsent");
    });

    it.each(["the connection ends", "the pane runs another thread"])("can no longer tell a turn's end once %s", async (scenario) => {
      const codex = await atRest();
      const turn = await taken(codex);
      if (scenario === "the connection ends") codex.drop();
      else codex.send({ method: "thread/started", params: { thread: { id: "t2", parentThreadId: null, ephemeral: false } } });
      expect(await turn.over).toBe(false);
    });

    it("sends nothing into a turn the TUI started, and tells that turn's end, a subagent's turn under it aside", async () => {
      const { codex } = launched("0.171.0", [MAIN]);
      await codex.next((message) => message["method"] === "thread/loaded/list");
      const completed = (own: boolean, from: number) => STATUS.findIndex((message, at) => at >= from && message["method"] === "turn/completed" && ((message["params"] as Message)["threadId"] === MAIN) === own);
      const subagentEnds = completed(false, STATUS.findIndex((message) => message["method"] === "turn/started"));
      const mainEnds = completed(true, subagentEnds);
      // as recorded: the pane's thread runs a turn, and a subagent's turn under it has started
      for (const message of STATUS.slice(0, subagentEnds)) codex.send(message);
      await read(codex);
      const sent = await servedTurn("w1:p1", MAIN, "next", crypto.randomUUID(), () => true);
      if (typeof sent === "string") throw new Error(`the server named no turn: ${sent}`);
      expect(sent.turn).toBe("running");
      expect(codex.received.some((message) => message["method"] === "turn/start")).toBe(false);
      // the subagent's turn ends, then the pane's thread reads idle: neither is the end of the pane's own turn
      for (const message of STATUS.slice(subagentEnds, mainEnds)) codex.send(message);
      expect(await soFar(codex, sent.over)).toBe("pending");
      codex.send(STATUS[mainEnds]!);
      expect(await sent.over).toBe(true);
    });

    it("tells the end of a turn it was not told the start of by the thread reading idle", async () => {
      const { codex } = launched("0.171.0", [THREAD]);
      // as for a thread's first turn: Ovis is subscribed once it runs, after its turn/started went out
      await running(codex, THREAD);
      await read(codex);
      const sent = await send();
      if (typeof sent === "string") throw new Error(`the server named no turn: ${sent}`);
      expect(sent.turn).toBe("running");
      expect(await soFar(codex, sent.over)).toBe("pending");
      codex.send({ method: "thread/status/changed", params: { threadId: THREAD, status: { type: "idle" } } });
      expect(await sent.over).toBe(true);
    });

    it.each(["the connection ends", "Codex answers an error"])("does not know it went when %s before a turn comes back", async (scenario) => {
      const codex = await atRest();
      const sent = send();
      const start = await request(codex, "turn/start");
      if (scenario === "the connection ends") codex.drop();
      else codex.send({ id: start["id"], error: { code: -32603, message: "internal error" } });
      expect(await sent).toBe("unknown");
    });
  });


  describe("the conversation its own server holds for the TUI", () => {
    /**
     * What Codex 0.171.0's server answered a second client while its real TUI (codex --remote) ran: the threads loaded
     * after one exchange (the pane's and the one Codex titles it in, aside) and after a /new, each as thread/read
     * describes it, and the rollout of the first. Recorded in an isolated CODEX_HOME.
     */
    const RECORDING = readFileSync(join(import.meta.dir, "..", "fixtures", "codex-app-server-conversations-0.171.0.json"), "utf8");
    const FIRST = "01a2196f-48d2-7353-b50a-04524b6d1886";
    const NEW = "01a2196f-f948-7c51-9c2d-9790944fe6d6";

    function pane(at: "afterFirstAnswer" | "afterNew", screen: string, home = join(root(), "codex"), reads?: (recorded: { read: Record<string, Message> }, loaded: string[]) => Record<string, Message | (() => Message)>) {
      const recorded = JSON.parse(RECORDING.replaceAll("<codex-home>", home).replaceAll("<cwd>", dirname(home))) as
        { loaded: Record<"afterFirstAnswer" | "afterNew", { data: string[] }>; read: Record<string, Message>; rollout: Message[] };
      const first = String(((recorded.read[FIRST]!)["thread"] as Message)["path"]);
      mkdirSync(dirname(first), { recursive: true });
      writeFileSync(first, recorded.rollout.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      const loaded = [...recorded.loaded[at].data];
      const { codex, program } = launched("0.171.0", loaded, reads?.(recorded, loaded) ?? recorded.read);
      const tui = { pid: 2147483647, name: "codex", argv: ["/usr/bin/codex", "--remote", `unix://${join(dirname(program), "codex.sock")}`] };
      const spies = [
        spyOn(herdr, "agentGet").mockResolvedValue({ pane_id: "w1:p1", agent: "codex", cwd: dirname(home) } as Awaited<ReturnType<typeof herdr.agentGet>>),
        spyOn(herdr, "paneProcessInfo").mockResolvedValue({ pane_id: "w1:p1", foreground_processes: [tui] }),
        spyOn(herdr, "paneRead").mockResolvedValue({ text: screen } as Awaited<ReturnType<typeof herdr.paneRead>>),
      ];
      cleanups.push(() => { for (const spy of spies) spy.mockRestore(); });
      const proofs = new Map<string, string>();
      const lookup = async () => {
        // Ovis subscribes to the threads loaded as it connected once it is ready
        await codex.next((message) => message["method"] === "thread/resume");
        return await rollout.codexTranscriptPath("w1:p1", dirname(home), home, undefined, false, false, proofs);
      };
      return { first, home, proofs, lookup, codex, recorded };
    }

    it("reads the one it holds, with no screen or folder evidence, and proves its file", async () => {
      const { first, home, proofs, lookup } = pane("afterFirstAnswer", "\u203a Ask Codex to do anything");
      expect(await lookup()).toEqual({ path: first, how: "served" });
      const file = statSync(first, { bigint: true });
      expect(proofs.get(first)).toBe(`${file.dev}:${file.ino}`);
      expect(await rollout.codexOpenRollout("w1:p1", null, home)).toBe(first);
    });

    const said = (path: string, id: string, answer: string, asked = "Explain it") => writeFileSync(path, [
      { type: "session_meta", payload: { id, cwd: dirname(dirname(path)), originator: "codex-tui", cli_version: "0.171.0", source: "vscode" } },
      { type: "event_msg", payload: { type: "user_message", message: asked } },
      { type: "event_msg", payload: { type: "agent_message", message: answer } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "a" });

    it("after a /new and a /resume of the first, still loaded, tells the TUI's among the server's own by the screen", async () => {
      const answer = "The first conversation explains how the launcher keeps its app server beside the terminal it serves.";
      const { first, lookup, recorded } = pane("afterNew", `>_ OpenAI Codex (v0.171.0)\n\n\u203a Explain it\n\n\u2022 ${answer}\n\n\u203a Ask Codex to do anything`);
      said(first, FIRST, answer);
      const next = String(((recorded.read[NEW]!)["thread"] as Message)["path"]);
      said(next, NEW, "The second conversation answers something else entirely, about a thread that was started anew.");
      expect(await lookup()).toEqual({ path: first, how: "inferred" });
    });

    it("after a /new, tells the new one by short answers the screen shows under their prompts", async () => {
      const { lookup, recorded } = pane("afterNew", ">_ OpenAI Codex (v0.171.0)\n\n\u203a What colour is the sky?\n\n\u2022 The sky is usually a clear bright blue by day.\n\n"
        + "\u203a And at sunset?\n\n\u2022 At sunset it turns orange, pink and deep red.\n\n\u203a Ask Codex to do anything");
      const next = String(((recorded.read[NEW]!)["thread"] as Message)["path"]);
      said(next, NEW, "The sky is usually a clear bright blue by day.", "What colour is the sky?");
      writeFileSync(next, [
        { type: "event_msg", payload: { type: "user_message", message: "And at sunset?" } },
        { type: "event_msg", payload: { type: "agent_message", message: "At sunset it turns orange, pink and deep red." } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "a" });
      expect(await lookup()).toEqual({ path: next, how: "inferred" });
    });

    it("takes none when an answer the screen shows was given in another of them too, as in a fork", async () => {
      // the new one forked the first: the long answer both hold, then short replies of its own the match cannot weigh
      const answer = "The first conversation explains how the launcher keeps its app server beside the terminal it serves.";
      const replies = Array.from({ length: 8 }, (_, at) => `ok ${at}`);
      const { first, lookup, recorded } = pane("afterNew", `>_ OpenAI Codex (v0.171.0)\n\n\u203a Explain it\n\n\u2022 ${answer}\n\n`
        + replies.map((reply) => `\u203a Again\n\n\u2022 ${reply}\n\n`).join("") + "\u203a Ask Codex to do anything");
      said(first, FIRST, answer);
      const next = String(((recorded.read[NEW]!)["thread"] as Message)["path"]);
      said(next, NEW, answer);
      for (const reply of replies) said(next, NEW, reply, "Again");
      expect(await lookup()).toBeNull();
    });

    it("takes none when the server loads another thread while Ovis reads them, as a /new does", async () => {
      const { lookup } = pane("afterFirstAnswer", "\u203a Ask Codex to do anything", undefined, (recorded, loaded) => ({
        ...recorded.read, [FIRST]: () => { if (!loaded.includes(NEW)) loaded.push(NEW); return recorded.read[FIRST]!; },
      }));
      expect(await lookup()).toBeNull();
    });

    it("takes none when the path the server names leads to another thread's file", async () => {
      const { first, lookup, recorded } = pane("afterFirstAnswer", "\u203a Ask Codex to do anything");
      // another thread's own rollout, in the same store
      const other = join(dirname(first), "rollout-2026-11-27T05-00-00-01a21970-0000-7000-8000-000000000000.jsonl");
      rmSync(first);
      said(other, "01a21970-0000-7000-8000-000000000000", "Another conversation entirely.");
      symlinkSync(other, first);
      expect(await lookup()).toBeNull();
      expect(recorded.read[FIRST]).toBeDefined();
    });

    describe("among several, takes none", () => {
      const answer = "The first conversation explains how the launcher keeps its app server beside the terminal it serves.";
      const resumedFirst = `>_ OpenAI Codex (v0.171.0)\n\n\u203a Explain it\n\n\u2022 ${answer}\n\n\u203a Ask Codex to do anything`;
      const written = (recorded: { read: Record<string, Message> }, first: string, other = "The second conversation answers something else entirely, about a thread that was started anew.") => {
        said(first, FIRST, answer);
        const next = String(((recorded.read[NEW]!)["thread"] as Message)["path"]);
        said(next, NEW, other);
        return next;
      };

      it("while another of them runs a turn, whose answer may not be written yet", async () => {
        const { first, lookup, recorded } = pane("afterNew", resumedFirst, undefined, (recorded) => ({
          ...recorded.read, [NEW]: { thread: { ...(recorded.read[NEW]!["thread"] as Message), status: { type: "active", activeFlags: [] } } },
        }));
        written(recorded, first);
        expect(await lookup()).toBeNull();
      });

      it("when one of them is too long to be weighed whole", async () => {
        const { first, lookup, recorded } = pane("afterNew", resumedFirst);
        const next = written(recorded, first);
        writeFileSync(next, JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(1024 * 1024) } }) + "\n", { flag: "a" });
        expect(await lookup()).toBeNull();
      });

      it("when the server loads another thread while the screen is read", async () => {
        let reads = 0;
        const { first, lookup, recorded } = pane("afterNew", resumedFirst, undefined, (recorded, loaded) => ({
          ...recorded.read, [FIRST]: () => { if (++reads === 2 && !loaded.includes("01a21970-0000-7000-8000-000000000001")) loaded.push("01a21970-0000-7000-8000-000000000001"); return recorded.read[FIRST]!; },
        }));
        written(recorded, first);
        expect(await lookup()).toBeNull();
        expect(reads).toBeGreaterThanOrEqual(2);
      });
    });

    it("after a /new not written yet, takes none, though the previous conversation is still in the history above", async () => {
      const answer = "The first conversation explains how the launcher keeps its app server beside the terminal it serves.";
      const { first, lookup, codex } = pane("afterNew", `>_ OpenAI Codex (v0.171.0)\n\n\u203a Explain it\n\n\u2022 ${answer}\n\n  Worked for 2s\n\n`
        + ">_ OpenAI Codex (v0.171.0)\n\n\u203a Ask Codex to do anything");
      said(first, FIRST, answer);
      expect(await lookup()).toBeNull();
      expect(codex.received.some((message) => message["method"] === "thread/read" && (message["params"] as Message)["threadId"] === NEW)).toBe(true);
    });
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
