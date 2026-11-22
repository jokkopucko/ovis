import { describe, expect, it } from "bun:test";
import { darwinStartTime, darwinTerminal, procTerminalDevice } from "./darwin-process.ts";

/** A 648-byte kinfo_proc that started at `seconds` (plus `micros`) on terminal device `device`. */
function kinfo(seconds: number, micros: number, device: number): Uint8Array {
  const answer = new Uint8Array(648);
  const view = new DataView(answer.buffer);
  view.setBigInt64(0, BigInt(seconds), true);
  view.setInt32(8, micros, true);
  view.setInt32(572, device, true);
  return answer;
}

describe("macOS kernel process record", () => {
  it("reads the controlling terminal's device from kinfo_proc, and none for NODEV or a short answer", () => {
    const answer = new Uint8Array(648).fill(0xff);
    const view = new DataView(answer.buffer);
    view.setInt32(572, 0x1000001, true);
    expect(procTerminalDevice(answer)).toBe(0x1000001);
    view.setInt32(572, -1, true);
    expect(procTerminalDevice(answer)).toBeNull();
    expect(procTerminalDevice(answer.subarray(0, 575))).toBeNull();
    expect(procTerminalDevice(new Uint8Array(0))).toBeNull();
  });

  it("takes a terminal and its start from one record, so a PID reused between reads cannot pair two processes", () => {
    const records = [kinfo(1_793_000_000, 250_000, 1), kinfo(1_793_000_100, 0, 2)];
    let reads = 0;
    const read = () => records[Math.min(reads++, 1)]!;
    const name = (device: number) => `ttys00${device}`;
    expect(darwinTerminal(42, read, name)).toEqual({ tty: "ttys001", startedAt: 1_793_000_000_250 });
    expect(reads).toBe(1);
    expect(darwinTerminal(42, () => kinfo(1_793_000_000, 0, -1), name)).toBeNull();
    expect(darwinTerminal(42, () => kinfo(0, 0, 1), name)).toBeNull();
    expect(darwinTerminal(42, () => new Uint8Array(0), name)).toBeNull();
    expect(darwinTerminal(42, () => null, name)).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")("tells what `ps` told, for a live process and none for a missing one", async () => {
    const child = Bun.spawn([process.execPath, "-e", "await Bun.sleep(5000)"]);
    try {
      const ps = Bun.spawnSync(["/bin/ps", "-o", "tty=", "-o", "lstart=", "-p", String(child.pid)], { env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
      const [tty, ...lstart] = ps.stdout.toString().trim().split(/\s+/);
      const started = darwinStartTime(child.pid);
      expect(started).not.toBeNull();
      expect(Math.floor(Number(started! / 1000n) / 1000) * 1000).toBe(Date.parse(`${lstart.join(" ")} UTC`));
      const record = darwinTerminal(child.pid);
      expect(record?.tty ?? null).toBe(tty === "??" ? null : tty!);
      if (record) expect(record.startedAt).toBe(Number(started! / 1000n));
    } finally { child.kill(); }
    expect(darwinStartTime(2147483647)).toBeNull();
    expect(darwinTerminal(2147483647)).toBeNull();
  });
});
