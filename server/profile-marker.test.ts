import { afterEach, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARKER, markedByProfile } from "./profile-marker.ts";

const folders: string[] = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "ovis-profile-marker-"));
  folders.push(dir);
  return dir;
}
const marker = '{"profile":"machine"}';

it("takes the profile's own small file for its marker", () => {
  const dir = folder();
  writeFileSync(join(dir, MARKER), marker, { mode: 0o600 });
  expect(markedByProfile(join(dir, MARKER))).toBe(true);
});

const notMarkers: [string, (dir: string) => void][] = [
  ["a link to the profile's marker", (dir) => { writeFileSync(join(dir, "elsewhere.json"), marker); symlinkSync(join(dir, "elsewhere.json"), join(dir, MARKER)); }],
  ["a file of more than 4096 bytes, whatever it holds", (dir) => writeFileSync(join(dir, MARKER), JSON.stringify({ profile: "machine", padding: "x".repeat(5000) }))],
  ["a folder", (dir) => mkdirSync(join(dir, MARKER))],
];
it.each(notMarkers)("takes %s for no marker", (_, make) => {
  const dir = folder();
  make(dir);
  expect(markedByProfile(join(dir, MARKER))).toBe(false);
});

// a FIFO is never read: reading one would wait for a writer that never comes
it.skipIf(process.platform === "win32")("takes a FIFO for no marker, at once", () => {
  const dir = folder();
  expect(Bun.spawnSync(["mkfifo", join(dir, MARKER)]).exitCode).toBe(0);
  expect(markedByProfile(join(dir, MARKER))).toBe(false);
});

it.skipIf(process.platform === "win32")("judges what it reads by the descriptor it reads it through, not by an earlier look at the name", async () => {
  const dir = folder();
  const path = join(dir, MARKER);
  writeFileSync(join(dir, "seen.json"), marker);
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  const seen = fs.lstatSync(join(dir, "seen.json"));
  const look = spyOn(fs, "lstatSync").mockImplementation((() => seen) as never);
  const writer = Bun.spawn(["sh", "-c", `printf '%s' '${marker}' > "$0"`, path], { stdout: "ignore", stderr: "ignore" });
  try { expect(markedByProfile(path)).toBe(false); }
  finally {
    look.mockRestore();
    writer.kill();
    await writer.exited;
  }
});
