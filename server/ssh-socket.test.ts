import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshConnection } from "./ssh.ts";

it.skipIf(process.platform === "win32")("keeps SSH sockets short and private even with a long TMPDIR", async () => {
  const root = mkdtempSync(join(tmpdir(), "ssh-test-"));
  const long = join(root, "x".repeat(120));
  mkdirSync(long);
  const saved = process.env["TMPDIR"];
  process.env["TMPDIR"] = long;
  const ssh = new SshConnection({ destination: "pc" }, join(root, "state"));
  try {
    const dir = ssh["makeDir"]();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // OpenSSH first binds a temporary control socket with a random suffix before renaming it.
    for (const name of ["control.0123456789abcdef", "ask"]) {
      expect(Buffer.byteLength(join(dir, name))).toBeLessThanOrEqual(100);
      const server = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(join(dir, name), resolve);
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    ssh.close();
    expect(() => statSync(dir)).toThrow();
  } finally {
    ssh.close();
    if (saved === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
