import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import * as herdr from "../herdr/client.ts";
import * as conversation from "../conversation.ts";
import * as prompt from "../prompt.ts";
import * as native from "../opencode-native.ts";
import { commandDataRoute } from "../command-data-send.ts";
import { createSubmitText } from "./composer.ts";
import type { CommandSend } from "../outcome.ts";
import type { HerdrPane } from "../../shared/protocol.ts";

const servers: { stop(): void }[] = [];
afterEach(() => {
  mock.restore();
  for (const server of servers.splice(0)) server.stop();
});

const sendOf = (text: string, name: string): CommandSend => ({
  id: "c1", text, at: Date.now(), agent: "opencode", identity: "i", screen: "", form: null,
  invocations: [{ name, argument: text.slice(name.length + 2), form: null }],
});

const SESSION = { agent: "opencode", source: "herdr:opencode", kind: "id", value: "ses_1" } as HerdrPane["agent_session"];

function openCodePane(baseUrl: string, send: CommandSend, { version = "2.2.2", bound = "ses_1", now = SESSION }: { version?: string; bound?: string; now?: HerdrPane["agent_session"] } = {}) {
  const typed: string[] = [];
  const noted: unknown[] = [];
  const evidence: unknown[] = [];
  const pane = { pane_id: "p", terminal_id: "t", agent: "opencode", agent_status: "idle", agent_session: SESSION } as HerdrPane;
  let reads = 0;
  // the first read is the send's own; every later one is herdr's word on the pane right before the request
  spyOn(herdr, "paneGet").mockImplementation(async () => (reads++ === 0 ? pane : { ...pane, agent_session: now }));
  spyOn(conversation, "paneProcessRoots").mockImplementation(async () => ({ omo: null, processes: undefined }) as Awaited<ReturnType<typeof conversation.paneProcessRoots>>);
  spyOn(prompt, "prepareCommandSend").mockReturnValue(send as ReturnType<typeof prompt.prepareCommandSend>);
  spyOn(prompt, "bindCommandProcess").mockImplementation(() => {});
  spyOn(prompt, "noteSubmitted").mockImplementation((_pane, _text, command) => { noted.push(command); });
  spyOn(prompt, "noteCommandEvidence").mockImplementation((_pane, id, found) => { evidence.push({ id, kind: found.kind }); });
  spyOn(native, "openCodePaneService").mockImplementation(async () => ({ service: { config: { baseUrl, port: Number(new URL(baseUrl).port), password: "pw", pid: 1 }, version }, sessionID: bound }));
  spyOn(native, "startOpenCodeWatch").mockReturnValue(null);
  spyOn(herdr, "agentPrompt").mockImplementation(async (_pane, text) => { typed.push(text); });
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, data) => { typed.push(data); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async () => {});
  const submit = createSubmitText({ options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 45_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0 });
  return { typed, noted, evidence, submit: (text: string) => submit("p", text, text, Date.now()),
    reads: () => reads, submitAs: (text: string, authorize: () => void) => submit("p", text, text, Date.now(), false, authorize) };
}

function service(status: number) {
  const requests: { path: string; body: unknown }[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    requests.push({ path: new URL(request.url).pathname, body: await request.json() });
    return new Response(null, { status });
  } });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

// OpenCode's API is never used from Windows (command-data-send.ts): there every command is typed
const posix = it.skipIf(process.platform === "win32");

posix("runs an OpenCode server command through its session, typing nothing, and takes the answer as its result", async () => {
  const { url, requests } = service(204);
  const pane = openCodePane(url, sendOf("/review main", "review"));
  await pane.submit("/review main");
  expect(requests).toEqual([{ path: "/api/session/ses_1/command", body: { name: "review", text: "main", delivery: "steer" } }]);
  expect(pane.typed).toEqual([]);
  expect(pane.noted).toHaveLength(1);
  expect(pane.evidence).toEqual([{ id: "c1", kind: "native" }]);
});

posix("asks OpenCode to compact the session, leaving the result to the compaction it ends in", async () => {
  const { url, requests } = service(200);
  const pane = openCodePane(url, sendOf("/compact", "compact"));
  await pane.submit("/compact");
  expect(requests).toEqual([{ path: "/api/session/ses_1/compact", body: {} }]);
  expect(pane.typed).toEqual([]);
  expect(pane.noted).toHaveLength(1);
  expect(pane.evidence).toEqual([]);
});

posix("types a command OpenCode's server does not know, as before", async () => {
  const { url, requests } = service(404);
  const pane = openCodePane(url, sendOf("/nope", "nope"));
  await pane.submit("/nope");
  expect(requests.map((request) => request.path)).toEqual(["/api/session/ses_1/command"]);
  expect(pane.typed).toHaveLength(1);
  expect(pane.evidence).toEqual([]);
});

it("types a command OpenCode's TUI runs itself, asking its server nothing", async () => {
  const { url, requests } = service(204);
  const pane = openCodePane(url, sendOf("/clear", "clear"));
  await pane.submit("/clear");
  expect(requests).toEqual([]);
  expect(pane.typed).toHaveLength(1);
});

it("types the command when OpenCode's service cannot be reached", async () => {
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) });
  const url = `http://127.0.0.1:${closed.port}`;
  closed.stop(true);
  const pane = openCodePane(url, sendOf("/review", "review"));
  await pane.submit("/review");
  expect(pane.typed).toHaveLength(1);
});

posix("never types a command whose request reached OpenCode without an answer", async () => {
  const dropping: NetServer = createNetServer((socket) => socket.once("data", () => socket.destroy()));
  await new Promise<void>((resolve) => dropping.listen(0, "127.0.0.1", resolve));
  servers.push({ stop: () => dropping.close() });
  const port = (dropping.address() as { port: number }).port;
  const pane = openCodePane(`http://127.0.0.1:${port}`, sendOf("/review", "review"));
  await expect(pane.submit("/review")).rejects.toMatchObject({ code: "timeout" });
  expect(pane.typed).toEqual([]);
  expect(pane.noted).toEqual([]);
});

posix("never types a command that ran in OpenCode and failed", async () => {
  const { url } = service(500);
  const pane = openCodePane(url, sendOf("/goal clear", "goal"));
  await expect(pane.submit("/goal clear")).rejects.toMatchObject({ code: "command_failed" });
  expect(pane.typed).toEqual([]);
  expect(pane.noted).toEqual([]);
});

it("routes only a lone OpenCode command that its server runs", () => {
  expect(commandDataRoute(sendOf("/review main", "review"), "/review main")).toEqual({ agent: "opencode", kind: "command", name: "review", text: "main" });
  expect(commandDataRoute(sendOf("/compact", "compact"), "/compact ")).toEqual({ agent: "opencode", kind: "compact" });
  expect(commandDataRoute(sendOf("/compact", "compact"), " /compact")).toBeNull();
  expect(commandDataRoute(sendOf("/review main", "review"), " /review main")).toBeNull();
  expect(commandDataRoute(sendOf("/review a\n  b", "review"), "/review a\n  b")).toMatchObject({ text: "a\n  b" });
  expect(commandDataRoute(sendOf("/team/check main", "team/check"), "/team/check main")).toEqual({ agent: "opencode", kind: "command", name: "team/check", text: "main" });
  expect(commandDataRoute(sendOf("/compact now", "compact"), "/compact now")).toBeNull();
  expect(commandDataRoute(sendOf("/models", "models"), "/models")).toBeNull();
  expect(commandDataRoute(sendOf("/resume", "resume"), "/resume")).toBeNull();
  expect(commandDataRoute(sendOf("/usage", "usage"), "/usage")).toBeNull();
  expect(commandDataRoute(sendOf("/review @effect", "review"), "/review @effect")).toBeNull();
  expect(commandDataRoute({ ...sendOf("/review", "review"), agent: "claude" }, "/review")).toBeNull();
  expect(commandDataRoute(sendOf("/review", "review"), "please /review")).toBeNull();
});

it("types the command for an OpenCode version not measured, or a session other than the pane's now", async () => {
  const { url, requests } = service(204);
  for (const version of ["3.0.0", "2.unknown"]) {
    const pane = openCodePane(url, sendOf("/review", "review"), { version });
    await pane.submit("/review");
    expect(pane.typed).toHaveLength(1);
    mock.restore();
  }
  const older = openCodePane(url, sendOf("/review", "review"), { bound: "ses_2" });
  await older.submit("/review");
  expect(older.typed).toHaveLength(1);
  mock.restore();
  const moved = openCodePane(url, sendOf("/review", "review"), { now: { ...SESSION!, value: "ses_9" } });
  await moved.submit("/review");
  expect(moved.typed).toHaveLength(1);
  expect(requests).toEqual([]);
});

posix("sends nothing once the sender may no longer type, though the connection opened", async () => {
  const { url, requests } = service(204);
  const pane = openCodePane(url, sendOf("/review", "review"));
  // revoked once herdr was asked about the pane right before the request: only the write's own check is left
  const revoked = () => { if (pane.reads() >= 2) throw Object.assign(new Error("revoked"), { code: "cancelled" }); };
  await expect(pane.submitAs("/review", revoked)).rejects.toMatchObject({ code: "cancelled" });
  expect(requests).toEqual([]);
  expect(pane.typed).toEqual([]);
});
