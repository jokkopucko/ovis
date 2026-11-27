import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeDescriptor } from "./bridge.ts";

const entry = join(import.meta.dir, "remote-entry.ts");
const receipt = (pane: string) => ({ pc: "local", epoch: "e", pane, id: 1 });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "seen-ssh-"));
  const config = join(realpathSync(home), "c");
  const socket = join(config, "herdr", "herdr.sock");
  mkdirSync(join(config, "herdr"), { recursive: true });
  const herdr = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(client) { client.data = { buffer: "" }; },
      data(client, chunk) {
        client.data.buffer += chunk.toString();
        let newline: number;
        while ((newline = client.data.buffer.indexOf("\n")) !== -1) {
          const request = JSON.parse(client.data.buffer.slice(0, newline)) as { id: string; method: string };
          client.data.buffer = client.data.buffer.slice(newline + 1);
          if (request.method === "events.subscribe") continue;
          client.write(`${JSON.stringify(request.method === "ping"
            ? { id: request.id, result: { version: "0.9.3", protocol: 22, capabilities: {} } }
            : { id: request.id, error: { code: "unsupported", message: "not in this test" } })}\n`);
        }
      },
    },
  });
  const path = join(home, ".config", "herdr-web-ui", "bridges", `${createHash("sha256").update(socket).digest("hex")}.json`);
  const descriptor = (): BridgeDescriptor => JSON.parse(readFileSync(path, "utf8"));
  const children: Array<{ kill(signal: NodeJS.Signals): void; exited: Promise<number> }> = [];
  const start = async (hold = false) => {
    const started = Promise.withResolvers<void>();
    const renaming = Promise.withResolvers<void>();
    const signalled = Promise.withResolvers<void>();
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import * as fs from "node:fs/promises";
      import { spyOn } from "bun:test";
      const release = Promise.withResolvers();
      if (${hold}) {
        process.on("message", (message) => { if (message === "release") release.resolve(); });
        process.on("SIGTERM", () => setImmediate(() => process.send("signalled")));
        const rename = fs.rename;
        spyOn(fs, "rename").mockImplementation(async (from, to) => {
          if (String(to).endsWith("/seen.json")) {
            process.send("renaming");
            await release.promise;
          }
          await rename(from, to);
        });
      }
      await import(${JSON.stringify(entry)});
      process.send("started");
      if (!${hold}) process.disconnect?.();
    `], {
      cwd: home, stdin: "ignore", stdout: "ignore", stderr: "inherit",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: config, TMPDIR: tmpdir() },
      ipc(message) {
        if (message === "started") started.resolve();
        if (message === "renaming") renaming.resolve();
        if (message === "signalled") signalled.resolve();
      },
    });
    children.push(child);
    await Promise.race([started.promise, child.exited.then((code) => { if (code !== 0) throw new Error(`Bridge start exited ${code}`); })]);
    return { child, renaming: renaming.promise, signalled: signalled.promise };
  };
  const request = (row?: ReturnType<typeof receipt>) => {
    const { port, token } = descriptor();
    return fetch(`http://127.0.0.1:${port}/api/seen`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-herdr-machine": "1" },
      ...(row === undefined ? {} : { method: "POST", body: JSON.stringify(row) }),
    });
  };
  const close = async () => {
    for (const child of children) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    herdr.stop(true);
    rmSync(home, { recursive: true, force: true });
  };
  return { start, descriptor, request, close };
}

it.skipIf(process.platform === "win32")("keeps the SSH bridge's descriptor until its accepted receipt is safe to hand off", async () => {
  const f = fixture();
  try {
    const { child: old, renaming, signalled } = await f.start(true);
    const pending = f.request(receipt("old")).catch(() => null);
    await renaming;
    old.kill("SIGTERM");
    await signalled;
    const { child: contender } = await f.start();
    expect(f.descriptor().pid).toBe(old.pid);
    expect(await contender.exited).toBe(0);
    old.send("release");
    expect(await old.exited).toBe(0);
    await pending;
    const { child: next } = await f.start();
    expect((await f.request(receipt("new"))).status).toBe(200);
    next.kill("SIGTERM");
    expect(await next.exited).toBe(0);
    await f.start();
    expect(await (await f.request()).json()).toEqual({ finishes: [receipt("old"), receipt("new")] });
  } finally { await f.close(); }
}, 20_000);

it.skipIf(process.platform === "win32")("exits a retiring SSH bridge by its deadline even if the final rename never returns", async () => {
  const f = fixture();
  try {
    const { child: old, renaming } = await f.start(true);
    const pending = f.request(receipt("blocked")).catch(() => null);
    await renaming;
    old.kill("SIGTERM");
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(() => deadline.reject(new Error("SSH bridge did not exit within 12 seconds of SIGTERM")), 12_000);
    const code = await Promise.race([old.exited, deadline.promise]).finally(() => clearTimeout(timer));
    expect(code).toBe(1);
    await pending;
    await f.start();
    expect((await f.request(receipt("new"))).status).toBe(200);
  } finally { await f.close(); }
}, 20_000);
