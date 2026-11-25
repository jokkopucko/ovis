import { afterEach, describe, expect, it } from "bun:test";
import { createConnection, Socket } from "node:net";
import { dirname } from "node:path";
import { readFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { KeeperClient } from "./client.ts";
import { keeperBuilt, keeperRoot, startKeeper, until } from "./keeper.fake.ts";

const prompt = (client: KeeperClient, text: string) =>
  client.request("session/prompt", { sessionId: client.session, prompt: [{ type: "text", text }] }) as Promise<{ stopReason: string }>;

it("a disconnected caller can cancel its keeper-readiness wait before replay", async () => {
  const client = new KeeperClient("", { connect: () => new Socket() });
  const abort = new AbortController();
  try {
    const ready = client.ready(abort.signal).then(() => "ready", () => "cancelled");
    abort.abort();
    expect(await Promise.race([ready, new Promise(resolve => setImmediate(() => resolve("still pending")))])).toBe("cancelled");
  } finally { client.close(); }
});

it("reserves an answer while replay is pending, without waiting for the watermark twice", async () => {
  const socket = new Socket();
  const client = new KeeperClient("", { connect: () => socket });
  const raw = JSON.stringify({ id: "example", method: "session/request_permission", params: {
    sessionId: "s",
    options: [{ optionId: "dismiss", name: "Dismiss", kind: "reject_once" }],
  } });
  socket.emit("data", `${JSON.stringify({ seq: 1, dir: "keeper", raw: JSON.stringify({ method: "_keeper/session", params: { sessionId: "s" } }) })}\n${JSON.stringify({ seq: 2, dir: "from-agent", raw })}\n`);
  const first = client.answer("example", "dismiss");
  try {
    const duplicate = client.answer("example", "dismiss");
    expect(await Promise.race([duplicate, new Promise((resolve) => setImmediate(() => resolve("waiting")))])).toBe("lost");
  } finally {
    client.close();
    expect(await first).toBe("gone");
  }
});

describe.skipIf(!keeperBuilt)("KeeperClient against the real keeper and the scripted agent", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function keeper(args: string[] = [], root = keeperRoot()) {
    const started = await startKeeper(root, args);
    cleanups.push(() => rmSync(dirname(root), { recursive: true, force: true }), started.stop);
    return { root, ...started };
  }

  function attach(root: string, connect?: (path: string) => Socket) {
    const client = new KeeperClient(root, connect ? { connect } : {});
    cleanups.push(() => client.close());
    return client;
  }

  it("names its process before its socket appears, so a client refused by a socket not listening yet waits for it", async () => {
    const root = keeperRoot();
    const created: string[] = [];
    const socket = Promise.withResolvers<unknown>();
    const watcher = watch(root, (_event, name) => {
      if (name !== null && !created.includes(name)) created.push(name);
      if (name === "acp.sock") socket.resolve(JSON.parse(readFileSync(join(root, "process.json"), "utf8")));
    });
    cleanups.push(() => watcher.close());
    const { pid } = await keeper([], root);
    expect(await socket.promise).toMatchObject({ keeper: pid });
    expect(created.indexOf("process.json")).toBeGreaterThanOrEqual(0);
    expect(created.indexOf("process.json")).toBeLessThan(created.indexOf("acp.sock"));
  });

  it("replays what happened before it attached, then follows live, and reports the turn's stop reason and text", async () => {
    const { root } = await keeper();
    const first = attach(root);
    await first.ready();
    await until(first, "session", () => first.session !== null);
    expect(await prompt(first, "echo hello")).toEqual({ stopReason: "end_turn" });
    expect(first.turn).toEqual({ running: false, stopReason: "end_turn", text: "echo bytes=10", error: null });

    // a client that attaches later rebuilds the same state from the archive
    const later = attach(root);
    await later.ready();
    expect(later.session).toBe(first.session);
    expect(later.turn).toEqual(first.turn);
    // and sees the next turn live, sent by another client
    const next = prompt(first, "echo again!");
    await until(later, "the next turn's end", () => later.turn?.text === "echo bytes=11" && !later.turn.running);
    expect(later.turn?.stopReason).toBe("end_turn");
    await next;
  });

  it("refuses a chat submission after the agent closed stdin but stayed alive", async () => {
    const { root } = await keeper();
    const client = attach(root);
    await client.ready();
    await until(client, "session", () => client.session !== null);
    expect(await prompt(client, "end-and-close-input")).toEqual({ stopReason: "end_turn" });
    await expect(client.submit("not delivered")).rejects.toThrow("could not write");
  });

  it("shows a permission request with the agent's options unchanged, and the chosen option reaches the agent", async () => {
    const { root } = await keeper();
    const client = attach(root);
    await client.ready();
    await until(client, "session", () => client.session !== null);
    const turn = prompt(client, "ask");
    await until(client, "the permission request", () => client.pending().length === 1);
    const [asked] = client.pending();
    expect(asked!.options).toEqual([{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }]);
    expect(asked!.toolCall).toMatchObject({ title: "touch x", kind: "execute", rawInput: { command: "touch x" } });
    expect(asked!.sessionId).toBe(client.session);
    expect(asked!.keeperId).toMatch(/^agent-\d+$/);
    expect(await client.answer(asked!.keeperId, "reject")).toBe("won");
    expect(await turn).toEqual({ stopReason: "end_turn" });
    // the agent says which option it was given
    expect(client.turn?.text).toBe("answered reject");
    expect(client.pending()).toEqual([]);
  });

  it("lets only the first of two clients' answers through", async () => {
    const { root } = await keeper();
    const [one, two] = [attach(root), attach(root)];
    await Promise.all([one.ready(), two.ready()]);
    await until(one, "session", () => one.session !== null);
    const turn = prompt(one, "ask");
    await until(two, "the request at the second client", () => two.pending().length === 1);
    await until(one, "the request at the first client", () => one.pending().length === 1);
    const id = one.pending()[0]!.keeperId;
    const outcomes = await Promise.all([one.answer(id, "allow"), two.answer(id, "reject")]);
    expect([...outcomes].sort()).toEqual(["lost", "won"]);
    await turn;
    expect(one.turn?.text).toBe(outcomes[0] === "won" ? "answered allow" : "answered reject");
    // a third answer to a settled request is not sent at all
    expect(await one.answer(id, "allow")).toBe("lost");
  });

  it("keeps a pending request across a dropped connection, and it is still answerable after the reconnect", async () => {
    const { root } = await keeper();
    const sockets: Socket[] = [];
    const client = attach(root, (path) => {
      const socket = createConnection(path);
      sockets.push(socket);
      return socket;
    });
    await client.ready();
    await until(client, "session", () => client.session !== null);
    const turn = prompt(client, "ask").catch((error: unknown) => error);
    await until(client, "the permission request", () => client.pending().length === 1);
    const id = client.pending()[0]!.keeperId;

    sockets[0]!.destroy();
    // the request in flight on the dropped connection is refused, never left hanging
    expect(await turn).toBeInstanceOf(Error);
    await until(client, "the reconnect", () => sockets.length === 2 && client.connected);
    expect(client.pending().map((request) => request.keeperId)).toEqual([id]);
    expect(await client.answer(id, "allow")).toBe("won");
    await until(client, "the end of the turn", () => client.turn?.running === false && client.turn.text === "answered allow");
  });

  it("asks nothing of its own: a turn with no permission request ends with no pending request at any point", async () => {
    const { root } = await keeper();
    const client = attach(root);
    const seen: number[] = [];
    client.onChange(() => seen.push(client.pending().length));
    await client.ready();
    await until(client, "session", () => client.session !== null);
    expect(await prompt(client, "echo read only")).toEqual({ stopReason: "end_turn" });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((count) => count === 0)).toBe(true);
  });

  it("ends the turn when the agent exits mid-turn", async () => {
    const { root } = await keeper();
    const client = attach(root);
    await client.ready();
    await until(client, "session", () => client.session !== null);
    void prompt(client, "quit").catch(() => undefined);
    await until(client, "the agent's end", () => client.agentGone);
    expect(client.turn?.running).toBe(false);
    expect(client.turn?.text).toBe("bye");
  });

  it("clears pending cards when a killed keeper leaves its socket behind", async () => {
    const started = await keeper();
    const client = attach(started.root);
    await client.ready();
    await until(client, "session", () => client.session !== null);
    void prompt(client, "ask").catch(() => undefined);
    await until(client, "the permission request", () => client.pending().length === 1);
    const id = client.pending()[0]!.keeperId;
    process.kill(started.pid, "SIGKILL");
    await until(client, "the keeper's end", () => client.keeperGone, 2_000);
    expect(client.pending()).toEqual([]);
    expect(await client.answer(id, "reject")).toBe("gone");
  });

  it("drops a request the agent can no longer receive: after a keeper restart its answer is gone", async () => {
    const first = await keeper();
    const client = attach(first.root);
    await client.ready();
    await until(client, "session", () => client.session !== null);
    void prompt(client, "ask").catch(() => undefined);
    await until(client, "the permission request", () => client.pending().length === 1);
    const id = client.pending()[0]!.keeperId;
    client.close();
    await first.stop("SIGKILL");

    await keeper([], first.root);
    const again = attach(first.root);
    await again.ready();
    await until(again, "the loaded session", () => again.session !== null);
    expect(again.session).toBe(client.session);
    expect(again.pending()).toEqual([]);
    expect(await prompt(again, "echo next")).toEqual({ stopReason: "end_turn" });
    expect(again.turn?.running).toBe(false);
    expect(await again.answer(id, "allow")).toBe("gone");
  });
});
