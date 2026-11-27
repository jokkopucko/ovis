import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as conversation from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import * as control from "./omo-control.ts";
import { sendCommandAsData } from "./command-data-send.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { omoControlCall, omoControlSocket } from "./omo-control.ts";
import { commandDataRoute } from "./command-data-send.ts";
import type { CommandSend } from "./outcome.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-control-"));
  roots.push(dir);
  return dir;
}

/** A /proc with one process (`pid`) holding the listed socket inodes, and /proc/net/unix naming `sockets` by inode. */
function fakeProc(dir: string, pid: number, held: string[], sockets: Record<string, string>): string {
  const proc = join(dir, "proc");
  mkdirSync(join(proc, "net"), { recursive: true });
  mkdirSync(join(proc, String(pid), "fd"), { recursive: true });
  const rows = Object.entries(sockets).map(([inode, path]) => `0000000000000000: 00000002 00000000 00010000 0001 01 ${inode} ${path}`);
  writeFileSync(join(proc, "net", "unix"), ["Num RefCount Protocol Flags Type St Inode Path", ...rows].join("\n") + "\n");
  held.forEach((inode, index) => symlinkSync(`socket:[${inode}]`, join(proc, String(pid), "fd", String(index + 3))));
  return proc;
}

it("finds the control socket the pane's own process listens on, and no other", () => {
  const dir = root();
  const agentDir = join(dir, "agent");
  const own = join(agentDir, "rpc", "tui", "t-own.sock");
  const proc = fakeProc(dir, 42, ["111", "222"], { "111": join(dir, "elsewhere.sock"), "222": own, "333": join(agentDir, "rpc", "tui", "t-other.sock") });
  expect(omoControlSocket(42, agentDir, proc)).toBe(own);
  expect(omoControlSocket(42, join(dir, "another-agent"), proc)).toBeNull();
  expect(omoControlSocket(7, agentDir, proc)).toBeNull();
});

it("reads a socket path with spaces, and the short-path fallback the process holds", () => {
  const dir = root();
  const agentDir = join(dir, "my agent");
  const spaced = join(agentDir, "rpc", "tui", "t-0123456789abcdef.sock");
  expect(omoControlSocket(42, agentDir, fakeProc(dir, 42, ["111"], { "111": spaced }))).toBe(spaced);
  const other = root();
  const short = join(other, "s", "t-0123456789abcdef.sock");
  expect(omoControlSocket(42, agentDir, fakeProc(other, 42, ["222"], { "222": short }))).toBe(short);
  const third = root();
  expect(omoControlSocket(42, agentDir, fakeProc(third, 42, ["333"], { "333": join(third, "unrelated.sock") }))).toBeNull();
});

it("authenticates with the secret's raw bytes, then answers the request by its id", async () => {
  const dir = root();
  const socket = join(dir, "t.sock");
  const secret = Buffer.alloc(32, 7);
  writeFileSync(`${socket}.secret`, secret);
  const received: Buffer[] = [];
  const server = createServer((client) => {
    client.on("data", (chunk) => {
      received.push(chunk);
      const all = Buffer.concat(received);
      if (!all.includes(0x0a)) return;
      const request = JSON.parse(all.subarray(32).toString("utf8")) as { id: string };
      client.write(`${JSON.stringify({ type: "event", id: request.id })}\n${JSON.stringify({ type: "response", id: request.id, command: "set_thinking_level", success: true })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const answer = await omoControlCall(socket, { type: "set_thinking_level", level: "high" });
  expect(answer).toMatchObject({ type: "response", success: true });
  const all = Buffer.concat(received);
  expect(all.subarray(0, 32).equals(secret)).toBe(true);
  expect(JSON.parse(all.subarray(32).toString("utf8"))).toMatchObject({ type: "set_thinking_level", level: "high" });
});

it("calls a request nothing reached unsent, and one the socket dropped unknown", async () => {
  const dir = root();
  const socket = join(dir, "t.sock");
  expect(await omoControlCall(socket, { type: "get_state" })).toBe("unsent");
  writeFileSync(`${socket}.secret`, Buffer.alloc(32, 1));
  expect(await omoControlCall(socket, { type: "get_state" })).toBe("unsent");
  const server = createServer((client) => client.once("data", () => client.destroy()));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  expect(await omoControlCall(socket, { type: "get_state" })).toBe("unknown");
});

it("sets an offered level for this session only, and types one OmO does not offer", async () => {
  const requests: Record<string, unknown>[] = [];
  spyOn(conversation, "paneProcessRoots").mockImplementation(async () => ({ omo: { agentDir: "/a", pluginDir: null, held: false }, environ: null, pid: 42, cwd: null }));
  spyOn(control, "omoControlSocket").mockReturnValue("/a/rpc/tui/t.sock");
  spyOn(control, "omoControlCall").mockImplementation(async (_socket, request) => {
    requests.push(request);
    return request["type"] === "get_available_thinking_levels" ? { type: "response", success: true, data: { levels: ["off", "low", "high"] } } : { type: "response", success: true };
  });
  const pane = { pane_id: "p", terminal_id: "t" } as HerdrPane;
  spyOn(herdr, "paneGet").mockImplementation(async () => pane);
  expect(await sendCommandAsData(pane, { agent: "omo", kind: "effort", level: "high" }, () => true)).toMatchObject({ ran: true });
  expect(requests).toEqual([{ type: "get_available_thinking_levels" }, { type: "set_thinking_level", level: "high", scope: "turn" }]);
  requests.length = 0;
  expect(await sendCommandAsData(pane, { agent: "omo", kind: "effort", level: "max" }, () => true)).toBeNull();
  expect(requests).toEqual([{ type: "get_available_thinking_levels" }]);
  mock.restore();
});

it("types /efforts for a model with one level besides off, and never types one OmO answered ambiguously", async () => {
  const pane = { pane_id: "p", terminal_id: "t" } as HerdrPane;
  spyOn(herdr, "paneGet").mockImplementation(async () => pane);
  let answer: Record<string, unknown> = { type: "response", success: true };
  let levels = ["off", "medium"];
  spyOn(conversation, "paneProcessRoots").mockImplementation(async () => ({ omo: { agentDir: "/a", pluginDir: null, held: false }, environ: null, pid: 42, cwd: null }));
  spyOn(control, "omoControlSocket").mockReturnValue("/a/rpc/tui/t.sock");
  spyOn(control, "omoControlCall").mockImplementation(async (_socket, request) =>
    request["type"] === "get_available_thinking_levels" ? { type: "response", success: true, data: { levels } } : answer);
  expect(await sendCommandAsData(pane, { agent: "omo", kind: "effort", level: "medium" }, () => true)).toBeNull();
  levels = ["off", "low", "high"];
  answer = { type: "response" };
  await expect(sendCommandAsData(pane, { agent: "omo", kind: "effort", level: "high" }, () => true)).rejects.toMatchObject({ code: "timeout" });
  answer = { type: "response", success: false, error: "no" };
  expect(await sendCommandAsData(pane, { agent: "omo", kind: "effort", level: "high" }, () => true)).toBeNull();
  mock.restore();
});

it("sends no effort once herdr reports another session in the pane", async () => {
  const requests: Record<string, unknown>[] = [];
  const pane = { pane_id: "p", terminal_id: "t", agent_session: { agent: "pi", source: "herdr:pi", kind: "id", value: "a" } } as HerdrPane;
  spyOn(herdr, "paneGet").mockImplementation(async () => ({ ...pane, agent_session: { ...pane.agent_session!, value: "b" } }));
  spyOn(conversation, "paneProcessRoots").mockImplementation(async () => ({ omo: { agentDir: "/a", pluginDir: null, held: false }, environ: null, pid: 42, cwd: null }));
  spyOn(control, "omoControlSocket").mockReturnValue("/a/rpc/tui/t.sock");
  spyOn(control, "omoControlCall").mockImplementation(async (_socket, request) => {
    requests.push(request);
    return { type: "response", success: true, data: { levels: ["off", "low", "high"] } };
  });
  expect(await sendCommandAsData(pane, { agent: "omo", kind: "effort", level: "high" }, () => true)).toBeNull();
  expect(requests).toEqual([]);
  mock.restore();
});

it("asks the sender once connected, right before the bytes go", async () => {
  const dir = root();
  const socket = join(dir, "t.sock");
  writeFileSync(`${socket}.secret`, Buffer.alloc(32, 3));
  const received: Buffer[] = [];
  const server = createServer((client) => client.on("data", (chunk) => received.push(chunk)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  expect(await omoControlCall(socket, { type: "set_thinking_level", level: "high" }, () => false)).toBe("unsent");
  expect(received).toEqual([]);
});

it("routes OmO's /efforts with one level, and nothing else", () => {
  const send = (text: string, agent = "omo"): CommandSend => ({ id: "c", text, at: 0, agent, identity: "i", screen: "", form: null, invocations: [{ name: text.slice(1).split(" ")[0]!, argument: "", form: null }] });
  expect(commandDataRoute(send("/efforts high"), "/efforts high")).toEqual({ agent: "omo", kind: "effort", level: "high" });
  expect(commandDataRoute(send("/efforts high", "pi"), "/efforts high")).toEqual({ agent: "omo", kind: "effort", level: "high" });
  expect(commandDataRoute(send("/efforts"), "/efforts")).toBeNull();
  expect(commandDataRoute(send("/efforts high now"), "/efforts high now")).toBeNull();
  expect(commandDataRoute(send("/efforts\thigh"), "/efforts\thigh")).toBeNull();
  expect(commandDataRoute(send("/efforts\nhigh"), "/efforts\nhigh")).toBeNull();
  expect(commandDataRoute(send(" /efforts high"), " /efforts high")).toBeNull();
  expect(commandDataRoute(send("/reasoning off"), "/reasoning off")).toBeNull();
});
