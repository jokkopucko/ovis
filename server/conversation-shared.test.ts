import { expect, it } from "bun:test";
import { closeSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finishAsync, type Steps } from "./codex-images.ts";
import { boundSteps, checkBoundFile, ConversationReadPending, type FileIdentity, openBound, readBound } from "./conversation-shared.ts";

it("holds a file past 2^63 to its inode whether a stat gives it as a number, unsigned or signed (#4089)", () => {
  const path = "transcript.jsonl";
  const unsigned = 10_727_827_628_292_156_347n;
  // a bigint fstat of an NFS file can give bit 63 as the sign; a number stat rounds the unsigned value
  const signed = BigInt.asIntN(64, unsigned);
  const opened = (authorized: FileIdentity, stat: FileIdentity): string => {
    try { readBound([[path, authorized]], () => checkBoundFile(path, stat)); return "open"; }
    catch (error) { return error instanceof ConversationReadPending ? "refused" : "error"; }
  };
  expect(opened({ dev: 194, ino: Number(unsigned) }, { dev: 194n, ino: signed })).toBe("open");
  expect(opened({ dev: 194n, ino: unsigned }, { dev: 194n, ino: signed })).toBe("open");
  expect(opened({ dev: 194n, ino: signed }, { dev: 194n, ino: signed - 1n })).toBe("refused");
  expect(opened({ dev: 194, ino: Number(unsigned) }, { dev: 194n, ino: signed + 4096n })).toBe("refused");
  expect(opened({ dev: 194n, ino: unsigned }, { dev: 194n, ino: BigInt.asIntN(64, unsigned + 1n) })).toBe("refused");
});

it("keeps two interleaved lookups' bindings of one path apart, through their awaits and a rejected one, and none after them", async () => {
  const root = mkdtempSync(join(tmpdir(), "bound-steps-"));
  try {
    const path = join(root, "transcript.jsonl");
    writeFileSync(path, "the pane's own\n");
    const own = statSync(path);
    const other: FileIdentity = { dev: own.dev, ino: own.ino + 1 };
    const opened = (): string => {
      try { closeSync(openBound(path)); return "open"; }
      catch (error) { return error instanceof ConversationReadPending ? "refused" : "error"; }
    };
    function* lookup(rejecting: boolean): Steps<string> {
      const seen: string[] = [];
      for (let step = 0; step < 3; step++) {
        if (rejecting && step === 1) {
          try { yield Promise.reject(new Error("read failed")); } catch { seen.push("rejected"); }
        } else yield;
        seen.push(opened());
      }
      return seen.join(",");
    }
    const [mine, theirs] = await Promise.all([
      finishAsync(boundSteps([[path, own]], lookup(false))),
      finishAsync(boundSteps([[path, other]], lookup(true))),
    ]);
    expect(mine).toBe("open,open,open");
    expect(theirs).toBe("refused,rejected,refused,refused");
    expect(opened()).toBe("open");
    const failing = function* (): Steps<never> { yield; throw new Error("broken"); };
    await expect(finishAsync(boundSteps([[path, other]], failing()))).rejects.toThrow("broken");
    expect(opened()).toBe("open");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
