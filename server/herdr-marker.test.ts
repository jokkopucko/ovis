import { expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { markerOwner, parseProcessLine, refusedSocket, staleMarker } from "./herdr-marker.ts";

// a real marker and the process behind it, read from a Windows PC (herdr 0.9.3)
const MARKER = "26540:1790829888292852700";
const DAEMON = { name: "herdr", startedMs: 1790829888236 };

it("reads the pid and the start out of herdr's Windows socket marker", () => {
  expect(markerOwner(MARKER)).toEqual({ pid: 26540, startedMs: 1790829888292 });
  expect(markerOwner("4312")).toEqual({ pid: 4312, startedMs: null });
  expect(markerOwner("")).toBeNull();
  expect(markerOwner("0:1")).toBeNull();
  expect(markerOwner("abc:1")).toBeNull();
});

it("reads the process the probe printed, and none from an empty answer", () => {
  expect(parseProcessLine("herdr|1790829888236\r\n")).toEqual(DAEMON);
  expect(parseProcessLine("")).toBeNull();
  expect(parseProcessLine("\r\n")).toBeNull();
});

it("keeps the marker of the daemon that wrote it", () => {
  expect(staleMarker(MARKER, () => DAEMON)).toBe(false);
  expect(staleMarker(MARKER, () => ({ name: "HERDR.EXE", startedMs: DAEMON.startedMs }))).toBe(false);
});

it("calls a marker stale when its pid is gone or was handed to another program", () => {
  expect(staleMarker(MARKER, () => null)).toBe(true);
  expect(staleMarker(MARKER, () => ({ name: "svchost", startedMs: DAEMON.startedMs }))).toBe(true);
  expect(staleMarker(MARKER, () => ({ name: "herdr-web-ui", startedMs: DAEMON.startedMs }))).toBe(true);
});

it("calls a marker stale when another herdr holds its pid: it started at another time", () => {
  expect(staleMarker(MARKER, () => ({ name: "herdr", startedMs: DAEMON.startedMs + 3_600_000 }))).toBe(true);
});

it("falls back to the name when either start is unknown, and never calls an unreadable marker stale", () => {
  expect(staleMarker(MARKER, () => ({ name: "herdr", startedMs: null }))).toBe(false);
  expect(staleMarker("26540", () => DAEMON)).toBe(false);
  expect(staleMarker("garbage", () => null)).toBe(false);
});

it.skipIf(process.platform === "win32")("calls a socket file refused only once the process listening on it was killed", async () => {
  // /tmp, not the per-user TMPDIR: macOS's is long enough to pass the 104-byte sun_path limit
  const dir = mkdtempSync("/tmp/herdr-refused-");
  try {
    const path = join(dir, "herdr.sock");
    expect(await refusedSocket(path)).toBe(false);
    const listener = Bun.spawn([process.execPath, "-e", "Bun.listen({ unix: process.argv[1], socket: { data() {} } }); console.log('ready');", path], { stdout: "pipe", stderr: "inherit" });
    try {
      await listener.stdout.getReader().read();
      expect(await refusedSocket(path)).toBe(false);
    } finally { listener.kill("SIGKILL"); await listener.exited; }
    expect(existsSync(path)).toBe(true);
    expect(await refusedSocket(path)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
