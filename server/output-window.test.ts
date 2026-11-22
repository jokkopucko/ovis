import { describe, expect, it } from "bun:test";
import { OutputWindow, OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_JOIN_BYTES_PER_SECOND, OUTPUT_JOIN_MAX_MS, OUTPUT_LOW_BYTES, OUTPUT_PAUSE_MAX_MS, OUTPUT_STALL_MS, ReplayBuffer, wireBytes } from "./output-window.ts";

describe("terminal output credit", () => {
  it("holds high-water backpressure until the low watermark, without duplicate credit", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.blocked).toBe(true);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES - 1);
    expect(window.blocked).toBe(true);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(window.blocked).toBe(false);
    const pending = window.pending;
    window.acknowledge(window.id, 0);
    window.acknowledge(window.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(window.pending).toBe(pending);
  });

  it("rejects stale subscriptions, impossible offsets and non-integer credit", () => {
    const old = new OutputWindow();
    const current = new OutputWindow();
    current.write(100);
    expect(current.acknowledge(old.id, 100)).toBe(false);
    for (const value of [-1, 101, 0.5, NaN, Infinity]) expect(current.acknowledge(current.id, value)).toBe(false);
    expect(current.pending).toBe(100);
    expect(current.acknowledge(current.id, 100)).toBe(true);
    expect(current.pending).toBe(0);
  });

  it("closes a blocked client only after OUTPUT_STALL_MS without ACK progress", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 0)).toBe("pause");
    expect(window.check(0, OUTPUT_STALL_MS - 1)).toBe("pause");
    expect(window.check(0, OUTPUT_STALL_MS)).toBe("stop");
  });

  it("restarts the stall clock on every ACK that moves, never on a duplicate", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES * 2);
    expect(window.check(0, 0)).toBe("pause");
    expect(window.acknowledge(window.id, 64 * 1024)).toBe(true);
    expect(window.blocked).toBe(true);
    expect(window.check(0, 1500)).toBe("pause");
    expect(window.check(0, 3000)).toBe("pause");
    window.acknowledge(window.id, 64 * 1024);
    expect(window.check(0, 3499)).toBe("pause");
    expect(window.check(0, 1500 + OUTPUT_STALL_MS)).toBe("stop");
  });

  it("lets a joiner on a slow link acknowledge a large replay after 3 s (moshi-3)", () => {
    const window = new OutputWindow();
    const replay = 200 * 1024;
    window.join("x".repeat(replay), 0, 0);
    window.write(replay);
    window.write(OUTPUT_HIGH_BYTES - replay);
    expect(window.blocked).toBe(true);
    for (const at of [0, OUTPUT_STALL_MS, 3000]) expect(window.check(0, at)).toBe("flow");
    expect(window.acknowledge(window.id, replay)).toBe(true);
    expect(window.joinUntil).toBeUndefined();
    expect(window.blocked).toBe(false);
    expect(window.check(0, 3000)).toBe("flow");
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 3100)).toBe("pause");
    expect(window.check(0, 3100 + OUTPUT_STALL_MS)).toBe("stop");
  });

  it("never pauses the shared pty for a joiner, and bounds the time it gets", () => {
    const window = new OutputWindow();
    window.join("x".repeat(OUTPUT_HARD_BYTES), 0, 0);
    window.write(OUTPUT_HIGH_BYTES + 1024);
    expect(window.check(OUTPUT_HIGH_BYTES, 1000)).toBe("flow");
    expect(window.joinUntil).toBe(OUTPUT_JOIN_MAX_MS);
    expect(window.check(0, OUTPUT_JOIN_MAX_MS - 1)).toBe("flow");
    expect(window.check(0, OUTPUT_JOIN_MAX_MS)).toBe("stop");
    const full = new OutputWindow();
    full.join("x".repeat(1024), 0, 0);
    expect(full.check(OUTPUT_HARD_BYTES, 0)).toBe("stop");
  });

  it("gives a joiner whose small replay is acknowledged nothing beyond the usual deadline", () => {
    const window = new OutputWindow();
    window.join("x".repeat(1024), 0, 0);
    window.write(1024);
    window.acknowledge(window.id, 1024);
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 10_000)).toBe("pause");
    expect(window.check(0, 10_000 + OUTPUT_STALL_MS)).toBe("stop");
    const silent = new OutputWindow();
    silent.join("x".repeat(1024), 0, 0);
    silent.write(1024 + OUTPUT_HIGH_BYTES);
    expect(silent.check(0, 0)).toBe("flow");
    expect(silent.check(0, OUTPUT_STALL_MS + 32)).toBe("stop");
  });

  it("stops a client that holds the pty paused by acknowledging a byte at a time", () => {
    const window = new OutputWindow();
    window.write(OUTPUT_HIGH_BYTES);
    let at = 0;
    let acknowledged = 0;
    expect(window.check(0, at)).toBe("pause");
    while (at + OUTPUT_STALL_MS - 100 < OUTPUT_PAUSE_MAX_MS) {
      at += OUTPUT_STALL_MS - 100;
      window.acknowledge(window.id, ++acknowledged);
      expect(window.check(0, at)).toBe("pause");
    }
    expect(window.check(0, OUTPUT_PAUSE_MAX_MS)).toBe("stop");
    const honest = new OutputWindow();
    honest.write(OUTPUT_HIGH_BYTES);
    expect(honest.check(0, 0)).toBe("pause");
    honest.acknowledge(honest.id, OUTPUT_HIGH_BYTES - OUTPUT_LOW_BYTES);
    expect(honest.check(0, OUTPUT_PAUSE_MAX_MS - 1)).toBe("flow");
    honest.write(OUTPUT_HIGH_BYTES);
    expect(honest.check(0, OUTPUT_PAUSE_MAX_MS)).toBe("pause");
    expect(honest.check(0, OUTPUT_PAUSE_MAX_MS + 1)).toBe("pause");
  });

  it("sizes a joiner's budget by its serialized frame, where an ESC costs six bytes", () => {
    const replay = "\x1b[31mred\x1b[0m ".repeat(Math.floor(128 * 1024 / 13));
    expect(wireBytes(replay)).toBeGreaterThan(Buffer.byteLength(replay) * 1.5);
    const window = new OutputWindow();
    window.join(replay, 0, 0);
    window.write(Buffer.byteLength(replay));
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 0)).toBe("flow");
    const crossing = OUTPUT_STALL_MS + Math.ceil(wireBytes(replay) * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND) - 1;
    expect(crossing).toBeLessThan(OUTPUT_JOIN_MAX_MS);
    expect(window.check(0, crossing)).toBe("flow");
    expect(window.acknowledge(window.id, Buffer.byteLength(replay))).toBe(true);
  });

  it("gives a joiner that was never blocked during its budget the usual deadline later", () => {
    const window = new OutputWindow();
    window.join("x".repeat(1024), 0, 0);
    window.write(1024);
    expect(window.check(0, 0)).toBe("flow");
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 20_000)).toBe("pause");
    expect(window.check(0, 20_000 + OUTPUT_STALL_MS - 1)).toBe("pause");
    expect(window.check(0, 20_000 + OUTPUT_STALL_MS)).toBe("stop");
  });

  it("never pauses or stops an idle pane for another pane's backlog on the same socket", () => {
    const idle = new OutputWindow();
    idle.write(10_000);
    idle.acknowledge(idle.id, 10_000);
    expect(idle.check(300 * 1024, 0)).toBe("flow");
    expect(idle.check(300 * 1024, OUTPUT_STALL_MS + 500)).toBe("flow");
    expect(idle.check(300 * 1024, OUTPUT_PAUSE_MAX_MS + 500)).toBe("flow");
    expect(idle.check(OUTPUT_HARD_BYTES, OUTPUT_PAUSE_MAX_MS + 600)).toBe("stop");
    const busy = new OutputWindow();
    busy.write(OUTPUT_LOW_BYTES + 1);
    expect(busy.check(300 * 1024, 0)).toBe("pause");
    expect(busy.check(300 * 1024, OUTPUT_STALL_MS)).toBe("stop");
  });

  it("gives a joiner time for what the socket has queued ahead of its replay", () => {
    const replay = "\x1b[31mred\x1b[0m ".repeat(Math.floor(128 * 1024 / 13));
    const ahead = 200 * 1024;
    const window = new OutputWindow();
    window.join(replay, ahead, 0);
    window.write(Buffer.byteLength(replay));
    window.write(OUTPUT_HIGH_BYTES);
    expect(window.check(0, 0)).toBe("flow");
    const ownFrameOnly = OUTPUT_STALL_MS + Math.ceil(wireBytes(replay) * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND);
    const withAhead = Math.min(OUTPUT_JOIN_MAX_MS, OUTPUT_STALL_MS + Math.ceil((ahead + wireBytes(replay)) * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND));
    expect(window.joinUntil).toBe(withAhead);
    expect(window.check(0, ownFrameOnly + 500)).toBe("flow");
    expect(window.check(0, withAhead)).toBe("stop");
  });

  it("gives a joiner time beyond the cap for a large snapshot queued ahead of its replay (#2566)", () => {
    const large = 2 * 1024 * 1024;
    const window = new OutputWindow();
    window.join("screen", 0, 0, large);
    window.write(OUTPUT_HIGH_BYTES);
    const snapshotCrossing = Math.ceil(large * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND);
    expect(snapshotCrossing).toBeGreaterThan(OUTPUT_JOIN_MAX_MS);
    expect(window.check(0, snapshotCrossing)).toBe("flow");
    expect(window.check(0, window.joinUntil!)).toBe("stop");
  });

  it("gives a large frame still in flight after the replay ACK the time it needs to cross", () => {
    const replay = "\x1b[31mred\x1b[0m ".repeat(Math.floor(128 * 1024 / 13));
    const live = "\x1b[32mgrn\x1b[0m ".repeat(Math.floor(64 * 1024 / 13));
    const window = new OutputWindow();
    window.join(replay, 0, 0);
    const replayEnd = window.write(Buffer.byteLength(replay), wireBytes(replay));
    const firstEnd = window.write(Buffer.byteLength(live), wireBytes(live));
    const lastEnd = window.write(Buffer.byteLength(live), wireBytes(live));
    window.write(4096);
    expect(window.blocked).toBe(true);
    expect(window.check(0, 0)).toBe("flow");
    expect(window.acknowledge(window.id, replayEnd)).toBe(true);
    expect(window.blocked).toBe(true);
    expect(window.check(0, 4001)).toBe("pause");
    // the next frame cannot be acknowledged before it has crossed a 32 KiB/s link
    expect(wireBytes(live) * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND).toBeGreaterThan(OUTPUT_STALL_MS);
    expect(window.check(0, 4001 + OUTPUT_STALL_MS + 100)).toBe("pause");
    expect(window.acknowledge(window.id, firstEnd)).toBe(true);
    expect(window.check(0, 7000)).toBe("pause");
    expect(window.acknowledge(window.id, lastEnd)).toBe(true);
    expect(window.check(0, 9000)).toBe("flow");
    const silent = new OutputWindow();
    silent.write(Buffer.byteLength(live), wireBytes(live));
    silent.write(OUTPUT_HIGH_BYTES);
    expect(silent.check(0, 0)).toBe("pause");
    const deadline = OUTPUT_STALL_MS + Math.ceil(wireBytes(live) * 1000 / OUTPUT_JOIN_BYTES_PER_SECOND);
    expect(silent.check(0, deadline - 1)).toBe("pause");
    expect(silent.check(0, deadline)).toBe("stop");
  });

  it("bounds replay in bytes without corrupting Korean or emoji at the cut", () => {
    const text = "시작🙂끝";
    for (let limit = 1; limit <= Buffer.byteLength(text); limit++) {
      const replay = new ReplayBuffer(limit);
      replay.append("prefix");
      replay.append(text);
      const tail = replay.text();
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(limit);
      expect(tail).not.toContain("�");
      expect(text.endsWith(tail)).toBe(true);
    }
  });

  it("says when output has fallen out of the tail", () => {
    const replay = new ReplayBuffer(16);
    replay.append("x".repeat(16));
    expect(replay.truncated).toBe(false);
    replay.append("y");
    expect(replay.truncated).toBe(true);
  });

  it("leads a late joiner's replay with the modes that fell out of the tail", () => {
    const replay = new ReplayBuffer(16);
    replay.append("\x1b[?1006l\x1b[?1016l\x1b[?1000l\x1b[?1049h\x1b[?1000h\x1b[?1002;1006h\x1b[?25l");
    replay.append("x".repeat(40));
    expect(replay.text()).toBe("\x1b[?1016l\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l" + "x".repeat(16));
    replay.append("\x1b[?1049l" + "y".repeat(16));
    replay.append("y".repeat(16));
    expect(replay.text()).toBe("\x1b[?1016l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?25l\x1b[?1049l" + "y".repeat(16));
  });

  it("passes a modifyOtherKeys request that fell out of the tail on to a late joiner", () => {
    const replay = new ReplayBuffer(16);
    replay.append("\x1b[?1049h\x1b[>4;2m");
    replay.append("x".repeat(40));
    expect(replay.text()).toBe("\x1b[?1049h\x1b[>4;2m" + "x".repeat(16));
    replay.append("\x1b[>1;2m\x1b[>41m\x1b[>0m" + "y".repeat(40));
    expect(replay.text()).toBe("\x1b[?1049h\x1b[>4;2m" + "y".repeat(16));
    // herdr turns it off as CSI > 4 ; 0 m; a program may also write CSI > 4 m or CSI > 4 n
    // and a bare CSI > m or CSI > n resets every resource; CSI > 0 m is another resource
    for (const off of ["\x1b[>4;0m", "\x1b[>4m", "\x1b[>4n", "\x1b[>m", "\x1b[>n"]) {
      replay.append("\x1b[>4;1m" + off + "z".repeat(40));
      expect(replay.text()).toBe("\x1b[?1049h" + "z".repeat(16));
    }
    replay.append("\x1b[>4;2m" + "w".repeat(10));
    expect(replay.text()).toBe("\x1b[?1049h" + "\x1b[>4;2m" + "w".repeat(10));
  });

  it("replays a short stream as it is, and nothing before any output", () => {
    const replay = new ReplayBuffer(1024);
    expect(replay.text()).toBe("");
    replay.append("\x1b[?1049h\x1b[?1000hhello");
    expect(replay.text()).toBe("\x1b[?1049h\x1b[?1000hhello");
  });
});
