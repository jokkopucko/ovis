import { describe, expect, it } from "bun:test";
import { testTerminal } from "../src/lib/ghostty/testTerminal.test-support.ts";
import { DemoHistory } from "../site/demo/history.ts";
import type { PaneFindRequest, PaneFindResponse } from "../shared/protocol.ts";

const request = (query: string, patch: Partial<PaneFindRequest> = {}): PaneFindRequest => ({ pane_id: "demo", query, direction: "forward", jump: false, ...patch });
describe("demo terminal history", () => {
  it("keeps searches read-only unless explicitly jumping and reflows on resize", () => {
    const history = new DemoHistory(80, 20);
    const before = history.scroll();
    const result = history.find(request("ERROR"));
    expect(result.total).toBeGreaterThan(0);
    expect(history.scroll()).toEqual(before);
    const jump = history.find(request("ERROR", { jump: true, direction: "backward" }));
    expect(jump.scroll!.offset_from_bottom).toBeGreaterThan(0);
    expect(jump.content_revision).toBe(result.content_revision);
    history.resize(30, 10);
    expect(history.revision).toBeGreaterThan(result.content_revision);
    expect(history.scroll().max_offset_from_bottom).toBeGreaterThan(before.max_offset_from_bottom);
  });
  it("uses complete Unicode cells and crosses soft wraps but never hard rows", async () => {
    const term = await testTerminal({ cols: 5, rows: 5 });
    const history = new DemoHistory(5, 5, ["abcd界éZ", "ERROR", "ready"]);
    const found = history.find(request("d界é"));
    expect(found.matches).toEqual([{ start: { row: 0, col: 3 }, end: { row: 1, col: 2 } }]);
    expect(history.find(request("́")).total).toBe(0);
    expect(history.find(request("ERRORready")).total).toBe(0);
    await new Promise<void>((resolve) => term.write(history.render(), resolve));
    expect(term.buffer.active.getLine(0)?.getCell(3)?.getChars()).toBe("d");
    expect(term.buffer.active.getLine(1)?.getCell(0)?.getChars()).toBe("界");
    expect(term.buffer.active.getLine(1)?.getCell(2)?.getChars()).toBe("é");
    term.dispose();
  });
  it("caps the returned window while preserving exact counts and the current match", () => {
    const history = new DemoHistory(80, 20, ["x ".repeat(1500)]);
    const result = history.find(request("x"));
    expect(result.total).toBe(1500);
    expect(result.matches).toHaveLength(1024);
    expect(result.matches).toContainEqual(result.match!);
  });
});

it("the demo transport loads log history by shell command and serves scroll/find without a real server", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let socket: WebSocket | undefined;
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?history";
    await import(transport);
    const demo = (globalThis as any).window;
    const post = async (path: string, body: unknown): Promise<Response> => demo.fetch(`/api/${path}`, { method: "POST", body: JSON.stringify(body) });
    const made = await (await post("workspace/create", { cwd: "/home/demo/log-check", label: "log-check" })).json();
    const pane = made.pane_id as string;
    const readScroll = async () => (await (await demo.fetch(`/api/pane/scroll?pane_id=${pane}`)).json()).scroll;
    expect((await readScroll()).max_offset_from_bottom).toBe(0);
    socket = new demo.WebSocket("ws://demo.test/ws");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("demo socket did not open")), 1000);
      socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const output: string[] = [];
    socket!.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "pty-data") output.push(message.data);
    });
    socket!.send(JSON.stringify({ type: "attach", pane_id: pane, cols: 60, rows: 12 }));
    socket!.send(JSON.stringify({ type: "input", pane_id: pane, text: "demo logs\r" }));
    const before = await readScroll();
    expect(before.max_offset_from_bottom).toBeGreaterThan(150);
    expect(before.viewport_rows).toBe(12);
    const frames = output.length;
    const foundResponse = await post("pane/find", { ...request("ERROR"), pane_id: pane });
    expect(foundResponse.status).toBe(200);
    const found = await foundResponse.json() as PaneFindResponse;
    expect(found.matches!.length).toBeGreaterThan(0);
    expect(await readScroll()).toEqual(before);
    expect(output.length).toBe(frames);
    await post("pane/scroll", { pane_id: pane, offset_from_bottom: before.max_offset_from_bottom });
    expect((await readScroll()).offset_from_bottom).toBe(before.max_offset_from_bottom);
    expect(output.at(-1)).toContain("Fictional checkout service");
    socket!.send(JSON.stringify({ type: "resize", pane_id: pane, cols: 35, rows: 10 }));
    const stale = await post("pane/find", { ...request("ERROR"), pane_id: pane, previous: found.match, content_revision: found.content_revision });
    expect(stale.status).toBe(409);
    socket!.send(JSON.stringify({ type: "input", pane_id: pane, text: "pwd\r" }));
    expect(output.at(-1)).toContain("/tmp/herdr-demo/release");
    expect((await readScroll()).offset_from_bottom).toBe(0);
  } finally {
    socket?.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
