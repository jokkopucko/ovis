import { describe, expect, it } from "bun:test";
import { hookedStream, ParserHooks, type HookParams } from "./hooks.ts";

function stream() {
  const hooks = new ParserHooks();
  const engine: string[] = [];
  const write = hookedStream(hooks, (text) => engine.push(text));
  return { hooks, write, engine, sent: () => engine.join("") };
}

describe("hookedStream", () => {
  it("passes text with no hooked sequence through in one piece", () => {
    const { write, engine } = stream();
    write("hello \x1b[1mworld\x1b[0m\r\n");
    expect(engine).toEqual(["hello \x1b[1mworld\x1b[0m\r\n"]);
  });

  it("drops a CSI a hook takes and keeps one it leaves, in order", () => {
    const { hooks, write, sent } = stream();
    const seen: HookParams[] = [];
    hooks.registerCsiHandler({ final: "c" }, () => true);
    hooks.registerCsiHandler({ prefix: ">", final: "m" }, (params) => { seen.push(params); return false; });
    write("a\x1b[cb\x1b[>4;2mc");
    expect(sent()).toBe("ab\x1b[>4;2mc");
    expect(seen).toEqual([[4, 2]]);
  });

  it("asks the newest handler first and stops at the first that takes the sequence", () => {
    const { hooks, write } = stream();
    const calls: string[] = [];
    hooks.registerCsiHandler({ final: "n" }, () => { calls.push("old"); return true; });
    const newer = hooks.registerCsiHandler({ final: "n" }, () => { calls.push("new"); return true; });
    write("\x1b[6n");
    newer.dispose();
    write("\x1b[6n");
    expect(calls).toEqual(["new", "old"]);
  });

  it("reads a CSI split across writes, with sub-params and an empty param", () => {
    const { hooks, write, sent } = stream();
    const seen: HookParams[] = [];
    hooks.registerCsiHandler({ prefix: "?", final: "h" }, (params) => { seen.push(params); return false; });
    write("x\x1b[?1;");
    write(";4:3h");
    expect(seen).toEqual([[1, 0, [4, 3]]]);
    expect(sent()).toBe("x\x1b[?1;;4:3h");
  });

  it("gives a hooked OSC its whole payload across writes, ended by BEL or ST", () => {
    const { hooks, write, sent } = stream();
    const payloads: string[] = [];
    hooks.registerOscHandler(52, (data) => { payloads.push(data); return true; });
    write("a\x1b]52;c;aGVs");
    write("bG8=\x07b\x1b]52;c;eA==\x1b");
    write("\\c");
    expect(payloads).toEqual(["c;aGVsbG8=", "c;eA=="]);
    expect(sent()).toBe("abc");
  });

  it("runs a hooked OSC at the ESC of its ST, before the backslash arrives", () => {
    const { hooks, write, sent } = stream();
    const payloads: string[] = [];
    hooks.registerOscHandler(52, (data) => { payloads.push(data); return true; });
    write("\x1b]52;c;QQ==\x1b");
    expect(payloads).toEqual(["c;QQ=="]);
    expect(write.oscStringState().open).toBe(false);
    write("\\after");
    expect(sent()).toBe("after");
  });

  it("ignores C0 controls inside an OSC, in its id and its payload, as xterm's parser does", () => {
    const { hooks, write } = stream();
    const payloads: string[] = [];
    hooks.registerOscHandler(52, (data) => { payloads.push(data); return true; });
    write("\x1b]5\x002;c;\x01QQ==\x07");
    expect(payloads).toEqual(["c;QQ=="]);
  });

  it("hands the engine a hooked OSC whole when no hook takes it", () => {
    const { hooks, write, sent } = stream();
    hooks.registerOscHandler(8, () => false);
    write("\x1b]8;;https://a.example\x1b\\link\x1b]8;;\x07");
    expect(sent()).toBe("\x1b]8;;https://a.example\x1b\\link\x1b]8;;\x07");
  });

  it("streams an OSC no hook names as soon as its id is known", () => {
    const { write, engine } = stream();
    write("\x1b]0;tit");
    expect(engine).toEqual(["\x1b]0;tit"]);
    write("le\x07");
    expect(engine.join("")).toBe("\x1b]0;title\x07");
  });

  it("says where an OSC stands", () => {
    const { hooks, write } = stream();
    hooks.registerOscHandler(52, () => true);
    expect(write.oscStringState()).toEqual({ open: false, idComplete: false, id: -1 });
    write("\x1b]5");
    expect(write.oscStringState()).toEqual({ open: true, idComplete: false, id: 5 });
    write("2;c;");
    expect(write.oscStringState()).toEqual({ open: true, idComplete: true, id: 52 });
    write("\x07");
    expect(write.oscStringState().open).toBe(false);
  });

  it("ends an OSC at an ESC that begins another sequence, and reads that sequence", () => {
    const { hooks, write, sent } = stream();
    const payloads: string[] = [];
    const csi: HookParams[] = [];
    hooks.registerOscHandler(52, (data) => { payloads.push(data); return true; });
    hooks.registerCsiHandler({ final: "n" }, (params) => { csi.push(params); return true; });
    write("\x1b]52;c;QQ==\x1b[6nz\x1b]0;t\x1b[5n");
    expect(payloads).toEqual(["c;QQ=="]);
    expect(csi).toEqual([[6], [5]]);
    expect(sent()).toBe("z\x1b]0;t\x1b\\");
  });

  it("takes a hooked DCS with its data and params", () => {
    const { hooks, write, sent } = stream();
    const seen: [string, HookParams][] = [];
    hooks.registerDcsHandler({ intermediates: "$", final: "q" }, (data, params) => { seen.push([data, params]); return true; });
    write("\x1bP$q\"p\x1b\\ok\x1bPq#0;2;0;0;0\x1b\\");
    expect(seen).toEqual([["\"p", [0]]]);
    expect(sent()).toBe("ok\x1bPq#0;2;0;0;0\x1b\\");
  });

  it("gives the engine C1 introducers in their 7-bit form", () => {
    const { hooks, write, sent } = stream();
    hooks.registerCsiHandler({ final: "c" }, () => true);
    write("\u009b1m\u009bc\u009d0;t\u009c");
    expect(sent()).toBe("\x1b[1m\x1b]0;t\x1b\\");
  });

  it("drops a hooked sequence CAN cancels, and gives the engine the CAN", () => {
    const { hooks, write, sent } = stream();
    const payloads: string[] = [];
    hooks.registerOscHandler(52, (data) => { payloads.push(data); return true; });
    write("\x1b]52;c;QQ\x18after");
    expect(payloads).toEqual([]);
    expect(sent()).toBe("\x18after");
  });

  it("forgets a sequence half read when reset", () => {
    const { hooks, write, sent } = stream();
    hooks.registerOscHandler(52, () => true);
    write("\x1b]52;c;QQ");
    write.reset();
    write("plain");
    expect(sent()).toBe("plain");
    expect(write.oscStringState().open).toBe(false);
  });

  it("gives the engine what came before a sequence before a hook sees it", () => {
    const { hooks, write, engine } = stream();
    const seen: string[] = [];
    hooks.registerCsiHandler({ final: "n" }, () => { seen.push(engine.join("")); return true; });
    write("\x1b[cbefore\x1b[6nafter");
    expect(seen).toEqual(["\x1b[cbefore"]);
    expect(engine.join("")).toBe("\x1b[cbeforeafter");
  });

  it("ends an OSC at a C1 introducer and reads the sequence it begins", () => {
    const { hooks, write } = stream();
    const payloads: string[] = [];
    hooks.registerOscHandler(52, (data) => { payloads.push(data); return true; });
    write("\x1b]0;title\u009d52;c;QQ==\x07");
    expect(payloads).toEqual(["c;QQ=="]);
  });

  it("drops a malformed CSI unseen, as xterm's parser ignores it", () => {
    const { hooks, write, sent } = stream();
    const seen: HookParams[] = [];
    hooks.registerCsiHandler({ final: "n" }, (params) => { seen.push(params); return true; });
    write("a\x1b[2?6nb\x1b[1 2nc");
    expect(seen).toEqual([]);
    expect(sent()).toBe("abc");
  });

  it("says whether the stream is between sequences", () => {
    const { write } = stream();
    expect(write.idle()).toBe(true);
    write("\x1b]0;tit");
    expect(write.idle()).toBe(false);
    write("le\x07plain");
    expect(write.idle()).toBe(true);
  });
});
