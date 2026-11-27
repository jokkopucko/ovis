import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownWindowsControl, WindowsControl } from "./windows-control.ts";

it("keeps the fixed mirror on unknown, mismatched and non-native stream pairs", () => {
  const daemon = { version: "0.9.5", protocol: 22 };
  expect(knownWindowsControl("win32", daemon, "herdr 0.9.5\r\n")).toBe(true);
  expect(knownWindowsControl("win32", daemon, "herdr 0.9.3")).toBe(false);
  expect(knownWindowsControl("win32", { ...daemon, protocol: 23 }, "herdr 0.9.5")).toBe(false);
  expect(knownWindowsControl("win32", { ...daemon, version: "0.9.6" }, "herdr 0.9.6")).toBe(false);
  expect(knownWindowsControl("win32", { ...daemon, runtime: "herdr-core" }, "herdr 0.9.5")).toBe(false);
  expect(knownWindowsControl("linux", daemon, "herdr 0.9.5")).toBe(false);
});

it.skipIf(process.platform === "win32")("passes a Windows socket path without the transport's named-pipe prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-control-path-"));
  const command = join(root, "read-socket");
  writeFileSync(command, `#!${process.execPath}
const bytes = Buffer.from(process.env.HERDR_SOCKET_PATH).toString("base64");
console.log(JSON.stringify({type:"terminal.frame",full:true,width:80,height:24,encoding:"ansi",bytes}));
`, { mode: 0o700 });
  const path = "C:\\Users\\test\\herdr.sock";
  try {
    for (const socket of [path, `\\\\.\\pipe\\${path}`]) {
      const screen = Promise.withResolvers<string>();
      const child = new WindowsControl({
        command, socket, target: "t", takeover: false, cols: 80, rows: 24,
        onFrame: screen.resolve, onEnd: () => screen.reject(new Error("No control frame")),
      });
      try { expect(await screen.promise).toBe(path); }
      finally { child.kill(); await child.exited; }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
