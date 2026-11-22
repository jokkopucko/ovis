import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateStateFs, writePrivateState } from "./private-state.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-private-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Op = keyof typeof privateStateFs;
const real = { ...privateStateFs };
const spies: { mockRestore(): void }[] = [];
afterEach(() => { for (const spy of spies.splice(0)) spy.mockRestore(); });

/**
 * `fail` throws instead of calling through, once, for the
 * first call of that operation that `when` accepts; a failing close still releases the
 * descriptor first, as close(2) does on Linux.
 */
function trace(options: { fail?: Op; when?: (args: unknown[]) => boolean; error?: Error; maxWrite?: number } = {}) {
  const ops: string[] = [];
  const names = new Map<number, string>();
  const open = new Set<number>();
  const name = (fd: unknown) => names.get(fd as number) ?? String(fd);
  let failed = false;
  const shouldFail = (op: Op, args: unknown[]) => {
    if (failed || options.fail !== op || !(options.when?.(args) ?? true)) return false;
    failed = true;
    return true;
  };
  const error = options.error ?? Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
  const wrap = <K extends Op>(op: K, label: (args: unknown[]) => string, call: (...args: unknown[]) => unknown) => {
    spies.push(spyOn(privateStateFs, op).mockImplementation(((...args: unknown[]) => {
      ops.push(`${op} ${label(args)}`);
      if (shouldFail(op, args)) {
        if (op === "closeSync") call(...args);
        ops.push(`${op} threw`);
        throw error;
      }
      return call(...args);
    }) as never));
  };
  const short = (path: unknown) => String(path).replace(dir, "").replace(/\.\d+\.[0-9a-f]{12}\.tmp$/, ".<tmp>");
  wrap("mkdirSync", (args) => short(args[0]), (...args) => real.mkdirSync(...(args as Parameters<typeof real.mkdirSync>)));
  wrap("openSync", (args) => short(args[0]), (...args) => {
    const fd = real.openSync(...(args as Parameters<typeof real.openSync>));
    names.set(fd, String(args[0]).endsWith(".tmp") ? "file" : "dir");
    open.add(fd);
    return fd;
  });
  wrap("writeSync", (args) => name(args[0]), (fd, buffer, offset, length) =>
    real.writeSync(fd as number, buffer as Buffer, offset as number, Math.min(length as number, options.maxWrite ?? Infinity)));
  wrap("fsyncSync", (args) => name(args[0]), (fd) => real.fsyncSync(fd as number));
  wrap("closeSync", (args) => name(args[0]), (fd) => { open.delete(fd as number); real.closeSync(fd as number); });
  wrap("renameSync", (args) => `${short(args[0])} -> ${short(args[1])}`, (from, to) => real.renameSync(from as string, to as string));
  wrap("unlinkSync", (args) => short(args[0]), (path) => real.unlinkSync(path as string));
  return { ops, open };
}

const value = { gate_closed_at: "2026-10-21T00:00:00.000Z", devices: [{ id: "0123456789abcdef", label: "Pixel — 휴대폰 📱" }] };
const document = `${JSON.stringify(value, null, 2)}\n`;

describe("writePrivateState", () => {
  it("writes all bytes and fsyncs before rename", () => {
    const root = mkdtempSync(join(dir, "order-"));
    const path = join(root, "state", "devices.json");
    const { ops, open } = trace({ maxWrite: 16 });
    expect(writePrivateState(path, value, "linux")).toEqual({ directorySynced: true });
    const rel = path.replace(dir, "");
    const writes = Math.ceil(Buffer.byteLength(document) / 16);
    expect(ops).toEqual([
      `mkdirSync ${rel.replace("/devices.json", "")}`,
      `openSync ${rel}.<tmp>`,
      ...Array.from({ length: writes }, () => "writeSync file"),
      "fsyncSync file",
      "closeSync file",
      `renameSync ${rel}.<tmp> -> ${rel}`,
      `openSync ${rel.replace("/devices.json", "")}`,
      "fsyncSync dir",
      "closeSync dir",
    ]);
    expect(open.size).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(document);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "state")).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(root, "state"))).toEqual(["devices.json"]);
  });

  it("creates its temporary file exclusively, under a name of its own", () => {
    const root = mkdtempSync(join(dir, "exclusive-"));
    const open = spyOn(privateStateFs, "openSync");
    spies.push(open);
    writePrivateState(join(root, "a.json"), 1, "linux");
    writePrivateState(join(root, "a.json"), 2, "linux");
    const temporaries = open.mock.calls.filter(([path]) => String(path).endsWith(".tmp"));
    expect(temporaries.map(([, flags, mode]) => [flags, mode])).toEqual([["wx", 0o600], ["wx", 0o600]]);
    expect(temporaries[0]![0]).not.toBe(temporaries[1]![0]);
  });

  it("never carries a wider mode of the old file over", () => {
    const root = mkdtempSync(join(dir, "mode-"));
    const path = join(root, "vapid.json");
    writeFileSync(path, "{}\n", { mode: 0o644 });
    chmodSync(path, 0o644);
    writePrivateState(path, value, "linux");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("keeps a narrower mode of the old file", () => {
    const root = mkdtempSync(join(dir, "narrow-"));
    for (const [before, after] of [[0o400, 0o400], [0o440, 0o400], [0o640, 0o600]] as const) {
      const path = join(root, `devices-${before.toString(8)}.json`);
      writeFileSync(path, "{}\n", { mode: 0o600 });
      chmodSync(path, before);
      writePrivateState(path, value, "linux");
      expect(statSync(path).mode & 0o777).toBe(after);
      expect(readFileSync(path, "utf8")).toBe(document);
    }
  });

  it("leaves the destination unchanged on file sync failure", () => {
    const root = mkdtempSync(join(dir, "fsync-"));
    const path = join(root, "devices.json");
    writeFileSync(path, "old\n", { mode: 0o600 });
    const { ops, open } = trace({ fail: "fsyncSync", maxWrite: 5 });
    expect(() => writePrivateState(path, value, "linux")).toThrow("EIO");
    expect(ops.filter((op) => op.startsWith("writeSync")).length).toBe(Math.ceil(Buffer.byteLength(document) / 5));
    expect(ops.some((op) => op.startsWith("renameSync"))).toBe(false);
    expect(open.size).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("old\n");
    expect(readdirSync(root)).toEqual(["devices.json"]);
  });

  for (const fail of ["openSync", "writeSync", "fsyncSync", "closeSync", "renameSync"] as const) {
    it(`propagates a ${fail} failure before the rename and leaves nothing behind`, () => {
      const root = mkdtempSync(join(dir, `${fail}-`));
      const path = join(root, "push-subscriptions.json");
      writeFileSync(path, "[]\n", { mode: 0o600 });
      const { ops, open } = trace({ fail, when: (args) => fail !== "openSync" || String(args[0]).endsWith(".tmp") });
      expect(() => writePrivateState(path, value, "linux")).toThrow("EIO");
      expect(ops.filter((op) => op === "closeSync file").length).toBe(fail === "openSync" ? 0 : 1);
      expect(ops).not.toContain(`openSync ${root.replace(dir, "")}`);
      expect(open.size).toBe(0);
      expect(readFileSync(path, "utf8")).toBe("[]\n");
      expect(readdirSync(root)).toEqual(["push-subscriptions.json"]);
    });
  }

  it("refuses a write that makes no progress instead of spinning", () => {
    const root = mkdtempSync(join(dir, "stuck-"));
    spies.push(spyOn(privateStateFs, "writeSync").mockImplementation(() => 0));
    expect(() => writePrivateState(join(root, "devices.json"), value, "linux")).toThrow("wrote no bytes");
    expect(readdirSync(root)).toEqual([]);
  });

  it("attempts POSIX directory sync without claiming rollback", () => {
    for (const fail of ["openSync", "fsyncSync"] as const) {
      const root = mkdtempSync(join(dir, `dir-${fail}-`));
      const path = join(root, "devices.json");
      writeFileSync(path, "old\n", { mode: 0o600 });
      const { ops, open } = trace({ fail, when: (args) => fail === "openSync" ? !String(args[0]).endsWith(".tmp") : ops.includes("closeSync file") });
      expect(writePrivateState(path, value, "linux")).toEqual({ directorySynced: false });
      expect(ops.indexOf(`${fail} threw`)).toBeGreaterThan(ops.findIndex((op) => op.startsWith("renameSync")));
      expect(ops.some((op) => op.startsWith("unlinkSync"))).toBe(false);
      expect(open.size).toBe(0);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(value);
      expect(readdirSync(root)).toEqual(["devices.json"]);
    }
  });

  it("does not open the directory on Windows", () => {
    const root = mkdtempSync(join(dir, "windows-"));
    const { ops } = trace();
    expect(writePrivateState(join(root, "vapid.json"), value, "win32")).toEqual({ directorySynced: false });
    expect(ops.at(-1)).toStartWith("renameSync");
    expect(JSON.parse(readFileSync(join(root, "vapid.json"), "utf8"))).toEqual(value);
  });
});
