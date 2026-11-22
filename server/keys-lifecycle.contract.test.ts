import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as herdr from "./herdr/client.ts";
import { createServer } from "./index.ts";
import { PtySession } from "./pty/session.ts";

/** A left click as xterm reports it with herdr's SGR mouse mode on: press, then release. */
const CLICK = "\x1b[<0;5;3M\x1b[<0;5;3m";
/** xterm's answers to a herdr-core attach's questions (focus, colours, cursor colour, DA1), as #2816 saw them typed. */
const REPLIES = "\x1b[I\x1b]10;rgb:d8d8/d0d0/c3c3\x1b\\\x1b]11;rgb:1818/1616/1313\x1b\\\x1b]12;rgb:f0f0/a8a8/3030\x1b\\\x1b[?1;2c";

async function queuedKeys(leave: "none" | "detach" | "replace" | "reattach" | "refresh", input = false, text = "queued text", automatic = false) {
  const root = mkdtempSync(join(tmpdir(), "ovis-keys-lifecycle-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
  const sockets: WebSocket[] = [];
  let workspace: string | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[][] = [];
  const original = herdr.paneSendKeys;
  const texts: string[] = [];
  const originalText = herdr.paneSendText;
  const textSpy = spyOn(herdr, "paneSendText").mockImplementation(async (pane, text) => {
    texts.push(text);
    return originalText(pane, text);
  });
  const written: string[] = [];
  const originalWrite = PtySession.prototype.write;
  const writeSpy = spyOn(PtySession.prototype, "write").mockImplementation(function (this: PtySession, data: string) {
    written.push(data);
    return originalWrite.call(this, data);
  });
  const spy = spyOn(herdr, "paneSendKeys").mockImplementation(async (pane, keys) => {
    calls.push(keys);
    if (calls.length === 1) await gate;
    return original(pane, keys);
  });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Queued keys contract deadline");
      await Bun.sleep(20);
    }
  };
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const seen: any[] = [];
    ws.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
    await until(() => seen.some((frame) => frame.type === "snapshot"));
    return { ws, seen, send: (message: unknown) => ws.send(JSON.stringify(message)) };
  };
  try {
    const created = await herdr.herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
      "workspace.create", { label: "ovis-test-keys-lifecycle", cwd: root, focus: false },
    );
    workspace = created.workspace.workspace_id;
    const pane = created.root_pane.pane_id;
    const owner = await connect();
    owner.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
    await until(() => owner.seen.some((frame) => frame.type === "input-ready"));
    const peer = leave === "detach" || leave === "reattach" ? await connect() : undefined;
    if (peer) {
      peer.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
      await until(() => peer.seen.some((frame) => frame.type === "input-ready"));
    }
    owner.send({ type: "keys", pane_id: pane, keys: ["ctrl+right"] });
    await until(() => calls.length === 1);
    owner.send(input ? { type: "input", pane_id: pane, text, ...(automatic ? { automatic: true } : {}) }
      : { type: "keys", pane_id: pane, keys: ["ctrl+alt+shift+left"] });
    if (leave !== "none" && leave !== "refresh") owner.send({ type: "detach", pane_id: pane });
    owner.send({ type: "role", mode: "interact" });
    await until(() => owner.seen.some((frame) => frame.type === "role-ack"));
    if (leave === "reattach" || leave === "refresh") {
      const readyCount = owner.seen.filter((frame) => frame.type === "input-ready").length;
      owner.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
      await until(() => owner.seen.filter((frame) => frame.type === "input-ready").length > readyCount);
    }
    if (leave === "replace") {
      const replacement = await connect();
      replacement.send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
      await until(() => replacement.seen.some((frame) => frame.type === "input-ready"));
    }
    release();
    if (leave === "none" || leave === "refresh") {
      if (input && (text === CLICK || automatic)) {
        // a mouse report keeps the attach input path, where herdr encodes it for the program's
        // own mouse mode; pane.send_text would type its bytes literally (#667). The terminal's
        // answers go to the attach that asked, never typed into the program (#2816)
        await until(() => written.includes(text) || texts.length > 0);
        expect(texts).toEqual([]);
        expect(written).toContain(text);
        expect(owner.seen.filter((frame) => frame.type === "error")).toEqual([]);
      } else if (input) {
        await until(() => texts.length === 1);
        expect(texts).toEqual([text]);
      } else {
        await until(() => calls.length === 2);
        expect(calls[1]).toEqual(["ctrl+alt+shift+left"]);
      }
    } else {
      // `input_failed` for a chord too: `input_not_ready` would make the client drop the readiness
      // of the attach it holds by now (the "reattach" case was told `input-ready` before this)
      await until(() => texts.length > 0 || owner.seen.some((frame) => frame.type === "error" && frame.code === "input_failed"));
      expect(calls).toEqual([["ctrl+right"]]);
      expect(texts).toEqual([]);
      expect(written).not.toContain(text);
      expect(owner.seen.filter((frame) => frame.type === "error").map((frame) => frame.code)).toEqual(["input_failed"]);
    }
  } finally {
    release();
    for (const socket of sockets) socket.close();
    server.stop();
    spy.mockRestore();
    textSpy.mockRestore();
    writeSpy.mockRestore();
    if (workspace) await herdr.workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

it("sends a queued chord when its original terminal attachment is still ready", () => queuedKeys("none"), 20_000);
it("drops a queued chord after its sender detaches while another client keeps the attachment", () => queuedKeys("detach"), 20_000);
it("drops a queued chord after its original attachment is replaced", () => queuedKeys("replace"), 20_000);
it("drops a queued chord after its sender detaches and rejoins the same attachment", () => queuedKeys("reattach"), 20_000);
it("preserves a queued chord when the sender refreshes its attach without detaching", () => queuedKeys("refresh"), 20_000);

it("sends text queued behind a chord while its attachment claim survives", () => queuedKeys("none", true), 20_000);
it("drops queued text after its sender detaches while a peer keeps the attachment", () => queuedKeys("detach", true), 20_000);
it("drops queued text after its attachment is replaced", () => queuedKeys("replace", true), 20_000);
it("drops queued text after its sender detaches and rejoins the same attachment", () => queuedKeys("reattach", true), 20_000);
it("preserves queued text on repeated attach without detach", () => queuedKeys("refresh", true), 20_000);

it("writes a click queued behind an arrow into the attach, not through send_text", () => queuedKeys("none", true, CLICK), 20_000);
it("drops a queued click after its sender detaches while a peer keeps the attachment", () => queuedKeys("detach", true, CLICK), 20_000);
it("drops a queued click after its attachment is replaced", () => queuedKeys("replace", true, CLICK), 20_000);
it("writes the terminal's answers queued behind a key into the attach, never typed (#2816)", () => queuedKeys("none", true, REPLIES, true), 20_000);
it("types a paste of the same bytes queued behind a key, as typing", () => queuedKeys("none", true, REPLIES), 20_000);

it("cancels a pending attach continuation when detach and reattach installs a new claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-attach-claim-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
  let workspace: string | undefined;
  let socket: WebSocket | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let lookupPending = false;
  const original = herdr.sessionSnapshot;
  const spy = spyOn(herdr, "sessionSnapshot").mockImplementation(async (...args) => {
    if (new Error().stack?.includes("terminalInfoFor")) {
      lookupPending = true;
      await gate;
    }
    return original(...args);
  });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Attach claim contract deadline");
      await Bun.sleep(20);
    }
  };
  try {
    const made = await herdr.workspaceCreate({ cwd: root, label: "ovis-test-attach-claim" });
    workspace = made.workspace.workspace_id;
    const pane = made.root_pane.pane_id;
    const seen: any[] = [];
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
    await until(() => seen.some((frame) => frame.type === "snapshot"));
    const send = (message: unknown) => socket!.send(JSON.stringify(message));
    send({ type: "attach", pane_id: pane, cols: 40, rows: 20, keep_size: true });
    await until(() => lookupPending);
    send({ type: "detach", pane_id: pane });
    send({ type: "attach", pane_id: pane, cols: 73, rows: 29 });
    send({ type: "role", mode: "interact" });
    await until(() => seen.some((frame) => frame.type === "role-ack"));
    release();
    await until(() => seen.some((frame) => frame.type === "input-ready"));
    expect(seen.filter((frame) => frame.type === "pane-geometry").map(({ cols, rows }) => ({ cols, rows }))).toEqual([{ cols: 73, rows: 29 }]);
  } finally {
    release();
    socket?.close();
    server.stop();
    spy.mockRestore();
    if (workspace) await herdr.workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it("refuses a chord sent while its attach is still being looked up, instead of sending it around the claim", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-attach-pending-keys-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
  let workspace: string | undefined;
  let socket: WebSocket | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let lookupPending = false;
  const originalSnapshot = herdr.sessionSnapshot;
  const snapshotSpy = spyOn(herdr, "sessionSnapshot").mockImplementation(async (...args) => {
    if (new Error().stack?.includes("terminalInfoFor")) {
      lookupPending = true;
      await gate;
    }
    return originalSnapshot(...args);
  });
  const calls: string[][] = [];
  const originalKeys = herdr.paneSendKeys;
  const keysSpy = spyOn(herdr, "paneSendKeys").mockImplementation(async (pane, keys) => {
    calls.push(keys);
    return originalKeys(pane, keys);
  });
  const until = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("Pending attach keys contract deadline");
      await Bun.sleep(20);
    }
  };
  try {
    const made = await herdr.workspaceCreate({ cwd: root, label: "ovis-test-attach-pending-keys" });
    workspace = made.workspace.workspace_id;
    const pane = made.root_pane.pane_id;
    const seen: any[] = [];
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.addEventListener("message", (event) => seen.push(JSON.parse(String(event.data))));
    await until(() => seen.some((frame) => frame.type === "snapshot"));
    const send = (message: unknown) => socket!.send(JSON.stringify(message));
    send({ type: "attach", pane_id: pane, cols: 80, rows: 24 });
    await until(() => lookupPending);
    send({ type: "keys", pane_id: pane, keys: ["ctrl+w"] });
    await until(() => seen.some((frame) => frame.type === "error" && frame.pane_id === pane));
    expect(seen.filter((frame) => frame.type === "error").map((frame) => frame.code)).toEqual(["input_not_ready"]);
    expect(calls).toEqual([]);
    release();
    await until(() => seen.some((frame) => frame.type === "input-ready"));
    send({ type: "keys", pane_id: pane, keys: ["ctrl+right"] });
    await until(() => calls.length === 1);
    expect(calls).toEqual([["ctrl+right"]]);
  } finally {
    release();
    socket?.close();
    server.stop();
    snapshotSpy.mockRestore();
    keysSpy.mockRestore();
    if (workspace) await herdr.workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
