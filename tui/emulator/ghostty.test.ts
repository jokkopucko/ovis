import { describe, expect, it, spyOn } from "bun:test";
import { join } from "node:path";

import type { GhosttyExports, GhosttyModule } from "../../shared/ghostty/engine.ts";
import { TERMINAL_HISTORY_LINES } from "../../shared/terminal-flow.ts";
import { createEmulatorLoader, MAX_COLS, MAX_ROWS } from "./ghostty.ts";
import type { Emulator, EmulatorResult } from "./index.ts";

const wasmPath = join(import.meta.dir, "../../shared/ghostty/ghostty-vt.wasm");
const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** a loader that counts its reads and keeps every module it made */
function countingLoader() {
  const state = { reads: 0, modules: [] as GhosttyModule[] };
  const loader = createEmulatorLoader({
    read: async () => {
      state.reads++;
      return Bun.file(wasmPath).arrayBuffer();
    },
    onModule: (module) => state.modules.push(module),
  });
  return { loader, state };
}

/** the emulator a created result holds, or a failed test */
function made(result: EmulatorResult<Emulator>): Emulator {
  if (!result.ok) throw new Error(`no emulator: ${result.error.kind}: ${result.error.message}`);
  return result.value;
}

/** what an emulator draws on row `y`, trailing blanks cut */
function rowText(emulator: Emulator, y: number): string {
  let found = "";
  const result = emulator.frameAll((row, runs) => {
    if (row === y) found = runs.flatMap((run) => run.cells.map((cell) => cell.text)).join("").trimEnd();
  });
  expect(result.ok).toBe(true);
  return found;
}

/**
 * a loader whose modules log, by name, every export the engine calls; `force` runs before each call and may throw. It keeps only
 * the newest module: a fuzz that kept them all would hold every wasm instance it made.
 */
function recordingLoader(force?: (name: string) => void) {
  const log: string[] = [];
  let newest: GhosttyModule | null = null;
  const loader = createEmulatorLoader({
    read: async () => Bun.file(wasmPath).arrayBuffer(),
    onModule: (module) => {
      newest = module;
      const logged: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(module.exports)) {
        logged[name] = typeof value !== "function" ? value : (...args: unknown[]) => {
          log.push(name);
          force?.(name);
          return (value as (...args: unknown[]) => unknown)(...args);
        };
      }
      (module as { exports: GhosttyExports }).exports = logged as unknown as GhosttyExports;
    },
  });
  return { loader, log, newest: () => newest };
}

/** what the engine called after it freed the terminal, other than the frees that end its own dispose */
function callsAfterFree(log: string[]): string[] {
  const freed = log.indexOf("ghostty_terminal_free");
  return freed < 0 ? [] : log.slice(freed + 1).filter((name) => name !== "ghostty_wasm_free");
}

/** a small seeded generator (mulberry32), so that a fuzz run can be repeated */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** every row an emulator draws, the cursor and the modes after it */
function screenOf(emulator: Emulator) {
  const rows: string[] = [];
  const drawn = emulator.frameAll((y, runs) => {
    rows[y] = runs.flatMap((run) => run.cells.map((cell) => cell.text)).join("").trimEnd();
  });
  return { drawn, rows, cursor: emulator.cursorState(), modes: emulator.modes() };
}

/** an emulator with its replies collected */
async function pane(loader: ReturnType<typeof countingLoader>["loader"], cols = 20, rows = 5) {
  const replies: string[] = [];
  const emulator = made(await loader.create({ cols, rows, events: { onReply: (bytes) => replies.push(text(bytes)) } }));
  return { emulator, replies };
}

describe("emulator per pane", () => {
  it("refuses only complete Kitty graphics queries and exposes no payload in the grid", async () => {
    const { emulator, replies } = await pane(countingLoader().loader);
    const query = "\x1b_Ga=q,i=42,t=d,f=24,s=1,v=1;AAAA\x1b\\";
    emulator.write(bytesOf(`before${query.slice(0, -1)}`));
    expect(replies).toEqual([]);
    emulator.write(bytesOf("\\after"));
    expect(replies).toEqual(["\x1b_Gi=42;ENOTSUP:graphics are not supported\x1b\\"]);
    emulator.write(bytesOf("\x1b_Ga=q,i=13;AB\x18\x1b\\\x1b_Ga=T,i=14;AAAA\x1b\\\x1b_Ga=q,i=15,q=2;AA\x1b\\"));
    expect(replies).toHaveLength(1);
    expect(rowText(emulator, 0)).toBe("beforeafter");
  });

  it("answers a graphics query before what the engine answers to bytes written after it", async () => {
    const { emulator, replies } = await pane(countingLoader().loader);
    const query = "\x1b_Ga=q,i=31,t=d,f=24,s=1,v=1;AAAA\x1b\\";
    const refusal = "\x1b_Gi=31;ENOTSUP:graphics are not supported\x1b\\";
    const kind = (reply: string) => reply === refusal ? "refusal" : reply.startsWith("\x1b[?") && reply.endsWith("c") ? "attributes" : reply;
    emulator.write(bytesOf(`${query}\x1b[c`));
    expect(replies.map(kind)).toEqual(["refusal", "attributes"]);
    replies.length = 0;
    emulator.write(bytesOf(`\x1b[c${query}`));
    expect(replies.map(kind)).toEqual(["attributes", "refusal"]);
    replies.length = 0;
    emulator.write(bytesOf(query.slice(0, -1)));
    emulator.write(bytesOf("\\\x1b[c"));
    expect(replies.map(kind)).toEqual(["refusal", "attributes"]);
  });

  it("writes the bytes after a refused query when the refusal's handler throws, and fails that write alone", async () => {
    const { loader } = countingLoader();
    const emulator = made(await loader.create({ cols: 40, rows: 4, events: { onReply: (bytes) => {
      if (text(bytes).includes("ENOTSUP")) throw new Error("the handler failed");
    } } }));
    const result = emulator.write(bytesOf("\x1b_Ga=q,i=1;AAAA\x1b\\TAIL-TEXT"));
    expect(result.ok ? "ok" : `${result.error.kind}: ${result.error.message}`).toBe("failed: the handler failed");
    expect(rowText(emulator, 0)).toBe("TAIL-TEXT");
    expect(emulator.write(bytesOf("!")).ok).toBe(true);
    expect(rowText(emulator, 0)).toBe("TAIL-TEXT!");
  });

  it("shares no state between two emulators", async () => {
    const { loader } = countingLoader();
    const a = await pane(loader);
    const b = await pane(loader);
    a.emulator.write(bytesOf("alpha"));
    b.emulator.write(bytesOf("beta\r\n\x1b[6n"));
    expect(rowText(a.emulator, 0)).toBe("alpha");
    expect(rowText(b.emulator, 0)).toBe("beta");
    expect(rowText(a.emulator, 1)).toBe("");
    expect(a.replies).toEqual([]);
    expect(b.replies).toEqual(["\x1b[2;1R"]);
    a.emulator.write(bytesOf("\x1b[6n"));
    expect(a.replies).toEqual(["\x1b[1;6R"]);
    expect(b.replies).toEqual(["\x1b[2;1R"]);
  });

  it("asks the engine for the core's width rule, no images and the shared history line", async () => {
    const { loader } = countingLoader();
    const { emulator, replies } = await pane(loader, 20, 3);
    // a ZWJ family is one wide cell under the core's rule (two columns), six under xterm's
    emulator.write(bytesOf("\u{1F468}\u200D\u{1F469}\u200D\u{1F467}x\x1b[6n"));
    expect(replies).toEqual(["\x1b[1;4R"]);
    replies.length = 0;
    emulator.write(bytesOf("\x1b_Gi=1,a=T,t=d,f=24,s=1,v=1;AAAA\x1b\\"));
    expect(replies).toEqual([]);
  });

  it("keeps about the shared history line count of rows, not the module's byte limit", async () => {
    const { loader } = countingLoader();
    const { emulator } = await pane(loader, 120, 40);
    const line = "x".repeat(110) + "\r\n";
    emulator.write(bytesOf(line.repeat(TERMINAL_HISTORY_LINES + 200)));
    const history = emulator.history();
    expect(history.ok).toBe(true);
    const kept = history.ok ? history.value.scrollback : 0;
    expect(kept).toBeGreaterThan(1500);
    expect(kept).toBeLessThanOrEqual(TERMINAL_HISTORY_LINES + 40);
  });

  it("frees on dispose and reports the error value afterwards", async () => {
    let frees = 0;
    const loader = createEmulatorLoader({
      read: async () => Bun.file(wasmPath).arrayBuffer(),
      onModule: (module) => {
        const real = module.exports;
        (module as { exports: GhosttyExports }).exports = {
          ...real,
          ghostty_terminal_free: (terminal) => {
            frees++;
            return real.ghostty_terminal_free(terminal);
          },
        };
      },
    });
    const { emulator, replies } = await pane(loader);
    emulator.write(bytesOf("x"));
    expect(frees).toBe(0);
    emulator.dispose();
    expect(frees).toBe(1);
    emulator.dispose();
    expect(frees).toBe(1);
    const after = emulator.write(bytesOf("\x1b[6n"));
    expect(after.ok).toBe(false);
    expect(!after.ok && after.error.kind).toBe("disposed");
    const badSizeAfter = emulator.resize(0, 0, 8, 16);
    expect(!badSizeAfter.ok && badSizeAfter.error.kind).toBe("disposed");
    for (const result of [emulator.resize(30, 6, 8, 16), emulator.frameAll(() => {}), emulator.cursorState(), emulator.encodePaste("a")]) {
      expect(!result.ok && result.error.kind).toBe("disposed");
    }
    expect(replies).toEqual([]);

    const trapping = createEmulatorLoader({
      read: async () => Bun.file(wasmPath).arrayBuffer(),
      onModule: (module) => {
        (module as { exports: GhosttyExports }).exports = {
          ...module.exports,
          ghostty_terminal_free: () => {
            throw new WebAssembly.RuntimeError("forced trap");
          },
        };
      },
    });
    const trapped = made(await trapping.create({ cols: 20, rows: 5, events: {} }));
    expect(() => trapped.dispose()).not.toThrow();
    expect(trapped.failure?.kind).toBe("trapped");
    const afterTrap = trapped.write(bytesOf("x"));
    expect(afterTrap.ok).toBe(false);

    // a free that throws anything else is recorded as `failed`; the emulator is disposed all the same
    const throwing = createEmulatorLoader({
      read: async () => Bun.file(wasmPath).arrayBuffer(),
      onModule: (module) => {
        (module as { exports: GhosttyExports }).exports = {
          ...module.exports,
          ghostty_terminal_free: () => {
            throw new Error("forced free error");
          },
        };
      },
    });
    const broken = made(await throwing.create({ cols: 20, rows: 5, events: {} }));
    expect(() => broken.dispose()).not.toThrow();
    expect(broken.failure?.kind).toBe("failed");
    const afterBroken = broken.write(bytesOf("x"));
    expect(!afterBroken.ok && afterBroken.error.kind).toBe("disposed");
  });

  it("returns a value when a handler disposes the emulator during a call", async () => {
    const { loader } = countingLoader();
    const bell = bytesOf("\x07");
    const hold = bytesOf("\x1b[?2026h");
    const reply = bytesOf("a\x1b[6nb");
    const withHandler = async (name: "onReply" | "onEffect" | "onHold", bytes: Uint8Array) => {
      let emulator: Emulator | undefined;
      emulator = made(await loader.create({ cols: 20, rows: 5, events: { [name]: () => emulator?.dispose() } }));
      const result = emulator.write(bytes);
      expect(result).toEqual({ ok: true, value: undefined });
      const later = emulator.write(bytesOf("x"));
      expect(!later.ok && later.error.kind).toBe("disposed");
    };
    await withHandler("onReply", reply);
    await withHandler("onEffect", bell);
    await withHandler("onHold", hold);

    const drawn = made(await loader.create({ cols: 20, rows: 5, events: {} }));
    drawn.write(bytesOf("a"));
    const result = drawn.frameAll(() => drawn.dispose());
    expect(result).toEqual({ ok: true, value: undefined });
    const later = drawn.frameAll(() => {});
    expect(!later.ok && later.error.kind).toBe("disposed");
  });

  it("keeps a second emulator answering after the first one's engine throws", async () => {
    let armed = false;
    let trapReads = 0;
    const modules: GhosttyModule[] = [];
    const loader = createEmulatorLoader({
      read: async () => Bun.file(wasmPath).arrayBuffer(),
      onModule: (module) => {
        modules.push(module);
        // a copy of the exports whose write can be made to trap, as a real out-of-bounds write does
        const real = module.exports;
        const first = modules.length === 1;
        const forced: GhosttyExports = { ...real, ghostty_terminal_vt_write: (terminal, ptr, len) => {
          if (first && armed) throw new WebAssembly.RuntimeError("forced: memory access out of bounds");
          return real.ghostty_terminal_vt_write(terminal, ptr, len);
        } };
        (module as { exports: GhosttyExports }).exports = forced;
        if (first) {
          let recorded = module.trap;
          Object.defineProperty(module, "trap", {
            get: () => {
              trapReads++;
              return recorded;
            },
            set: (value) => {
              recorded = value;
            },
          });
        }
      },
    });
    const a = await pane(loader);
    const b = await pane(loader);
    armed = true;
    const failed = a.emulator.write(bytesOf("boom"));
    expect(!failed.ok && failed.error.kind).toBe("trapped");
    const again = a.emulator.write(bytesOf("later"));
    expect(!again.ok && again.error.kind).toBe("trapped");
    const laterFrame = a.emulator.frameAll(() => {});
    expect(a.emulator.failure).not.toBeNull();
    for (const result of [again, laterFrame]) expect(result.ok ? null : result.error).toBe(a.emulator.failure);
    expect(a.emulator.failure?.kind).toBe("trapped");
    const readsAtDeath = trapReads;
    for (let n = 0; n < 3; n++) a.emulator.write(bytesOf("more"));
    expect(trapReads).toBe(readsAtDeath);

    expect(b.emulator.write(bytesOf("alive\x1b[6n")).ok).toBe(true);
    expect(b.replies).toEqual(["\x1b[1;6R"]);
    expect(rowText(b.emulator, 0)).toBe("alive");

    // the dead emulator's module is not reused: a new emulator gets a module of its own
    armed = false;
    const c = await pane(loader);
    expect(modules).toHaveLength(3);
    expect(modules[2]).not.toBe(modules[0]);
    c.emulator.write(bytesOf("\x1b[6n"));
    expect(c.replies).toEqual(["\x1b[1;1R"]);
    const badSizeDead = a.emulator.resize(0, 0, 8, 16);
    expect(!badSizeDead.ok && badSizeDead.error.kind).toBe("trapped");
    a.emulator.dispose();
  });

  it("keeps the pane alive after an argument error", async () => {
    const { loader } = countingLoader();
    const { emulator, replies } = await pane(loader);
    const bad = emulator.encodeKey({ key: "NO_SUCH_KEY" });
    expect(!bad.ok && bad.error.kind).toBe("failed");
    expect(emulator.failure).toBeNull();
    expect(emulator.write(bytesOf("ok\x1b[6n")).ok).toBe(true);
    expect(replies).toEqual(["\x1b[1;3R"]);
    expect(rowText(emulator, 0)).toBe("ok");
  });

  it("keeps the pane alive after a handler throws once", async () => {
    let throwNext = true;
    const replies: string[] = [];
    const emulator = made(await countingLoader().loader.create({
      cols: 10,
      rows: 3,
      events: {
        onReply: (bytes) => {
          if (throwNext) {
            throwNext = false;
            throw new Error("handler broke");
          }
          replies.push(text(bytes));
        },
      },
    }));
    const result = emulator.write(bytesOf("\x1b[6n"));
    expect(!result.ok && result.error.kind).toBe("failed");
    expect(emulator.failure).toBeNull();
    expect(emulator.write(bytesOf("a\x1b[6n")).ok).toBe(true);
    expect(replies).toEqual(["\x1b[1;2R"]);
    expect(emulator.frameAll(() => {}).ok).toBe(true);
    emulator.write(bytesOf("c"));
    const thrownDraw = emulator.frame(() => {
      throw new Error("draw broke");
    });
    expect(!thrownDraw.ok && thrownDraw.error.kind).toBe("failed");
    expect(emulator.write(bytesOf("b")).ok).toBe(true);
  });

  it("refuses a size outside the range before the engine sees it", async () => {
    const { loader } = countingLoader();
    const { emulator, replies } = await pane(loader);
    const sizes: [number, number, number, number][] = [
      [0, 5, 8, 16], [5, 0, 8, 16], [-1, -1, 8, 16], [65535, 65535, 8, 16], [MAX_COLS + 1, 5, 8, 16],
      [5, MAX_ROWS + 1, 8, 16], [1.5, 5, 8, 16], [Number.NaN, 5, 8, 16], [5, 5, Number.NaN, 16], [5, 5, Number.POSITIVE_INFINITY, 16],
    ];
    for (const [cols, rows, cellW, cellH] of sizes) {
      const result = emulator.resize(cols, rows, cellW, cellH);
      expect(!result.ok && result.error.kind).toBe("size");
    }
    for (const [cols, rows] of [[0, 0], [-1, -1], [65535, 65535]] as const) {
      const created = await loader.create({ cols, rows, events: {} });
      expect(!created.ok && created.error.kind).toBe("size");
    }
    expect(emulator.failure).toBeNull();
    const wide = emulator.resize(1001, 5, 8, 16);
    expect(!wide.ok && wide.error.kind).toBe("size");
    expect(emulator.resize(1000, 5, 8, 16).ok).toBe(true);
    expect(emulator.resize(MAX_COLS, MAX_ROWS, 8, 16).ok).toBe(true);
    const tall = emulator.resize(5, 501, 8, 16);
    expect(!tall.ok && tall.error.kind).toBe("size");
    expect(emulator.resize(5, 500, 8, 16).ok).toBe(true);
    expect(emulator.resize(1, 1, 8, 16).ok).toBe(true);
    emulator.write(bytesOf("\x1b[6n"));
    expect(replies).toEqual(["\x1b[1;1R"]);
  });

  it("takes a megabyte of random bytes without an exception", async () => {
    const { loader } = countingLoader();
    const { emulator } = await pane(loader, 80, 24);
    const chunk = new Uint8Array(65536);
    for (let sent = 0; sent < 1 << 20; sent += chunk.length) {
      crypto.getRandomValues(chunk);
      const result = emulator.write(chunk);
      if (!result.ok) {
        expect(["trapped", "failed"]).toContain(result.error.kind);
        break;
      }
    }
    expect(() => emulator.frameAll(() => {})).not.toThrow();
  }, 60_000);
});

describe("calls from inside a running call", () => {
  it("frees the engine only after a call whose handler disposed it returned, however much of the write is left", async () => {
    const { loader } = countingLoader();
    for (const tail of [64, 256, 70000]) {
      let emulator: Emulator | undefined;
      let replies = 0;
      emulator = made(await loader.create({ cols: 80, rows: 24, events: { onReply: () => {
        replies++;
        emulator?.dispose();
      } } }));
      const result = emulator.write(bytesOf("\x1b[6n" + "x".repeat(tail) + "\x1b[6n"));
      expect(result).toEqual({ ok: true, value: undefined });
      expect(emulator.failure).toBeNull();
      // the second query of the same write reaches no handler: the emulator was already disposed
      expect(replies).toBe(1);
      const later = emulator.write(bytesOf("x"));
      expect(!later.ok && later.error.kind).toBe("disposed");
    }
  });

  it("calls no module export after the free, and frees once, after the running call's last module call", async () => {
    const { loader, log } = recordingLoader();
    let emulator: Emulator | undefined;
    let freedInHandler: boolean | undefined;
    emulator = made(await loader.create({ cols: 40, rows: 5, events: { onReply: () => {
      emulator?.dispose();
      freedInHandler = log.includes("ghostty_terminal_free");
    } } }));
    log.length = 0;
    // after the query the write goes on, and a hold makes the engine call the module again from its callback
    const result = emulator.write(bytesOf("a\x1b[6n" + "y".repeat(300) + "\x1b[?2026h" + "z".repeat(300)));
    expect(result.ok).toBe(true);
    expect(freedInHandler).toBe(false);
    expect(log.filter((name) => name === "ghostty_terminal_free")).toHaveLength(1);
    expect(log).toContain("ghostty_render_state_update");
    expect(log.lastIndexOf("ghostty_render_state_update")).toBeLessThan(log.indexOf("ghostty_terminal_free"));
    expect(log.lastIndexOf("ghostty_terminal_vt_write")).toBeLessThan(log.indexOf("ghostty_terminal_free"));
    expect(callsAfterFree(log)).toEqual([]);
    const calls = log.length;
    for (const later of [emulator.write(bytesOf("x")), emulator.frameAll(() => {}), emulator.cursorState(), emulator.reset()]) {
      expect(!later.ok && later.error.kind).toBe("disposed");
    }
    emulator.dispose();
    expect(log).toHaveLength(calls);

    // a draw callback that disposes: the rest of the frame is not drawn, and the free comes after the frame
    const drawn = made(await loader.create({ cols: 40, rows: 5, events: {} }));
    drawn.write(bytesOf("one\r\ntwo\r\nthree"));
    log.length = 0;
    let rows = 0;
    const frame = drawn.frameAll(() => {
      rows++;
      drawn.dispose();
    });
    expect(frame).toEqual({ ok: true, value: undefined });
    expect(rows).toBe(1);
    expect(log.filter((name) => name === "ghostty_terminal_free")).toHaveLength(1);
    expect(callsAfterFree(log)).toEqual([]);
  });

  it("answers disposed, not failed, when a handler disposes and then throws, and frees once", async () => {
    let armed = false;
    const { loader, log } = recordingLoader((name) => {
      if (armed && name === "ghostty_render_state_update") throw new WebAssembly.RuntimeError("forced trap");
    });
    let emulator: Emulator | undefined;
    emulator = made(await loader.create({ cols: 20, rows: 5, events: { onReply: () => {
      emulator?.dispose();
      throw new Error("handler broke after dispose");
    } } }));
    const result = emulator.write(bytesOf("\x1b[6n" + "x".repeat(500)));
    expect(!result.ok && result.error.kind).toBe("disposed");
    expect(emulator.failure).toBeNull();
    const later = emulator.write(bytesOf("x"));
    expect(!later.ok && later.error.kind).toBe("disposed");
    expect(log.filter((name) => name === "ghostty_terminal_free")).toHaveLength(1);
    expect(callsAfterFree(log)).toEqual([]);

    // a call that traps after its handler disposed the emulator (the second hold captures the screen again):
    // that call answers the trap, later ones `disposed`
    let trapping: Emulator | undefined;
    trapping = made(await loader.create({ cols: 20, rows: 5, events: { onHold: () => {
      trapping?.dispose();
      armed = true;
    } } }));
    const trapped = trapping.write(bytesOf("\x1b[?2026h\x1b[?2026l\x1b[?2026h"));
    armed = false;
    expect(!trapped.ok && trapped.error.kind).toBe("trapped");
    expect(trapping.failure?.kind).toBe("trapped");
    const next = trapping.write(bytesOf("x"));
    expect(!next.ok && next.error.kind).toBe("disposed");
  });

  it("never traps when a reply handler disposes during 3000 seeded writes of 1 to 70000 bytes", async () => {
    const seed = 54;
    const random = seeded(seed);
    const { loader, log } = recordingLoader();
    const pieces = ["\x1b[6n", "\x1b[5n", "\x1b[?2026h", "\x1b[?2026l", "\x07", "\r\n", "\x1b[31m", "\x1b]0;t\x07", "\x1b[2J", "\u{D55C}"];
    const payload = (): Uint8Array => {
      const length = 1 + Math.floor(random() * 70000);
      const bytes = new Uint8Array(length);
      let at = 0;
      while (at < length) {
        const pick = random();
        if (pick < 0.3) {
          const piece = bytesOf(pieces[Math.floor(random() * pieces.length)]!);
          bytes.set(piece.subarray(0, length - at), at);
          at += piece.length;
        } else if (pick < 0.5) {
          for (const end = Math.min(length, at + 1 + Math.floor(random() * 256)); at < end; at++) bytes[at] = Math.floor(random() * 256);
        } else {
          const end = Math.min(length, at + 1 + Math.floor(random() * 2048));
          bytes.fill(0x61 + Math.floor(random() * 26), at, end);
          at = end;
        }
      }
      // one query that random bytes before it cannot swallow (CAN and ST end any sequence or string)
      const query = bytesOf("\x18\x1b\\\x1b[6n");
      bytes.set(query.subarray(0, length), Math.floor(random() * Math.max(1, length - query.length)));
      return bytes;
    };
    const answers = new Map<string, number>();
    let writes = 0;
    let disposedInCall = 0;
    const late: string[] = [];
    while (writes < 3000) {
      let emulator: Emulator | undefined;
      let repliesLeft = 1 + Math.floor(random() * 3);
      emulator = made(await loader.create({ cols: 1 + Math.floor(random() * 200), rows: 1 + Math.floor(random() * 60), events: { onReply: () => {
        if (--repliesLeft === 0) emulator?.dispose();
      } } }));
      log.length = 0;
      for (let round = 0; round < 4 && writes < 3000; round++) {
        writes++;
        const result = emulator.write(payload());
        const answer = result.ok ? "ok" : result.error.kind;
        answers.set(answer, (answers.get(answer) ?? 0) + 1);
        if (answer === "disposed") break;
        if (repliesLeft <= 0 && answer === "ok") disposedInCall++;
      }
      late.push(...callsAfterFree(log));
      if (repliesLeft <= 0) expect(log.filter((name) => name === "ghostty_terminal_free")).toHaveLength(1);
      emulator.dispose();
    }
    expect([...answers.keys()].filter((answer) => answer !== "ok" && answer !== "disposed")).toEqual([]);
    expect(late).toEqual([]);
    // most rounds really disposed from inside a running write
    expect(disposedInCall).toBeGreaterThan(500);
  }, 60_000);

  const nestedCalls: Record<string, (emulator: Emulator) => EmulatorResult<unknown>> = {
    write: (emulator) => emulator.write(bytesOf("NESTED")),
    reset: (emulator) => emulator.reset(),
    resize: (emulator) => emulator.resize(10, 2, 8, 16),
    frame: (emulator) => emulator.frame(() => {}),
    cursorState: (emulator) => emulator.cursorState(),
  };
  const callbacks = ["onReply", "onEffect", "onHold", "draw"] as const;

  /** one outer call whose callback (once) makes `nested` on its own emulator; the outer call's result and the screen after it */
  async function outerCall(loader: ReturnType<typeof recordingLoader>, callback: (typeof callbacks)[number], nested?: string) {
    let emulator: Emulator | undefined;
    let nestedResult: EmulatorResult<unknown> | undefined;
    let nestedModuleCalls = -1;
    const replies: string[] = [];
    const once = () => {
      if (!nested || nestedResult || !emulator) return;
      const before = loader.log.length;
      nestedResult = nestedCalls[nested]!(emulator);
      nestedModuleCalls = loader.log.length - before;
    };
    const events = {
      onReply: (bytes: Uint8Array) => {
        replies.push(text(bytes));
        if (callback === "onReply") once();
      },
      onEffect: () => callback === "onEffect" && once(),
      onHold: () => callback === "onHold" && once(),
    };
    emulator = made(await loader.loader.create({ cols: 30, rows: 3, events }));
    const input = { onReply: "A\x1b[6nB tail", onEffect: "A\x07B tail", onHold: "A\x1b[?2026hB tail\x1b[?2026l", draw: "A B tail" }[callback];
    let outer: EmulatorResult<unknown> = emulator.write(bytesOf(input));
    if (callback === "draw") outer = emulator.frameAll((y) => y === 0 && once());
    emulator.write(bytesOf("\x1b[6n"));
    return { outer, screen: screenOf(emulator), replies, nestedResult, nestedModuleCalls };
  }

  it("refuses a call of its own emulator from a handler or draw callback with busy, and does nothing", async () => {
    const loader = recordingLoader();
    for (const callback of callbacks) {
      const control = await outerCall(loader, callback);
      expect(control.outer.ok).toBe(true);
      for (const nested of Object.keys(nestedCalls)) {
        const run = await outerCall(loader, callback, nested);
        expect({ callback, nested, kind: run.nestedResult && !run.nestedResult.ok && run.nestedResult.error.kind }).toEqual({ callback, nested, kind: "busy" });
        expect(run.nestedModuleCalls).toBe(0);
        expect(run.outer).toEqual(control.outer);
        expect(run.screen).toEqual(control.screen);
        expect(run.replies).toEqual(control.replies);
      }
    }
  });

  it("lets a handler call another emulator freely", async () => {
    const { loader } = recordingLoader();
    const b = await pane(loader, 30, 3);
    let fromA: EmulatorResult<unknown> | undefined;
    const a = made(await loader.create({ cols: 30, rows: 3, events: { onReply: () => {
      fromA = b.emulator.write(bytesOf("from-A\x1b[6n"));
    } } }));
    expect(a.write(bytesOf("A\x1b[6nB")).ok).toBe(true);
    expect(fromA).toEqual({ ok: true, value: undefined });
    expect(rowText(a, 0)).toBe("AB");
    expect(rowText(b.emulator, 0)).toBe("from-A");
    expect(b.replies).toEqual(["\x1b[1;7R"]);
  });
});

describe("the options", () => {
  it("answers a missing or non-object options argument with a size error, before the engine file is read", async () => {
    const { loader, state } = countingLoader();
    for (const options of [undefined, null, "80x24", 5, true]) {
      const created = await loader.create(options as never);
      expect(!created.ok && created.error.kind).toBe("size");
    }
    expect(state.reads).toBe(0);
  });

  it("builds a screen's engine when events is undefined or null", async () => {
    let armed = false;
    const { loader, newest } = recordingLoader((name) => {
      if (armed && name === "ghostty_terminal_vt_write") throw new WebAssembly.RuntimeError("forced trap");
    });
    for (const events of [undefined, null]) {
      const emulator = made(await loader.create({ cols: 20, rows: 5, events: events as never }));
      const module = newest();
      // only a screen's engine watches for mode 9001; a reply with no handler to take it is dropped
      expect(emulator.write(bytesOf("\x1b[?9001h\x1b[6n")).ok).toBe(true);
      const modes = emulator.modes();
      expect(modes.ok && modes.value.win32Input).toBe(true);
      armed = true;
      const failed = emulator.write(bytesOf("x"));
      armed = false;
      expect(!failed.ok && failed.error.kind).toBe("trapped");
      expect(module?.trap).toBeInstanceOf(WebAssembly.RuntimeError);
      const next = emulator.cursorState();
      expect(!next.ok && next.error.kind).toBe("trapped");
    }
  });
});

describe("the engine file", () => {
  it("is read once, on the first emulator, and not before", async () => {
    const { loader, state } = countingLoader();
    expect(state.reads).toBe(0);
    await pane(loader);
    expect(state.reads).toBe(1);
    await Promise.all([pane(loader), pane(loader)]);
    await pane(loader);
    expect(state.reads).toBe(1);
  });

  it("is not read by importing the loader, and a missing file is an error value that a later call retries", async () => {
    const spy = spyOn(Bun, "file");
    try {
      const wasmCalls = () => spy.mock.calls.filter(([path]) => String(path).endsWith(".wasm")).length;
      const fresh = (await import("./ghostty.ts?fresh=" + Math.random())) as typeof import("./ghostty.ts");
      expect(wasmCalls()).toBe(0);
      const options = { cols: 10, rows: 3, events: {} };
      const [first, second] = await Promise.all([fresh.createEmulator(options), fresh.createEmulator(options)]);
      made(first).dispose();
      made(second).dispose();
      expect(wasmCalls()).toBe(1);
    } finally {
      spy.mockRestore();
    }
    let reads = 0;
    let exists = false;
    const loader = createEmulatorLoader({
      read: async () => {
        reads++;
        if (!exists) throw new Error("ENOENT: not there yet");
        return Bun.file(wasmPath).arrayBuffer();
      },
    });
    expect(reads).toBe(0);
    const missing = await loader.create({ cols: 10, rows: 3, events: {} });
    expect(!missing.ok && missing.error.kind).toBe("failed");
    exists = true;
    made(await loader.create({ cols: 10, rows: 3, events: {} })).dispose();
    expect(reads).toBe(2);
  });
});
