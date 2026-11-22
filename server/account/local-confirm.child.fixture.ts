import { dlopen, FFIType } from "bun:ffi";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeDesktopOwnerFd } from "./local-confirm.ts";

const channel = readlinkSync("/proc/self/fd/3");
const argv = ["ovis-server", "--desktop-owner-fd", "3"];
const taken = takeDesktopOwnerFd(argv) !== null;
const dir = mkdtempSync(join(tmpdir(), "ovis-confirm-child-"));
const listing = join(dir, "fds");
// system(3) forks and execs with every descriptor that is not close-on-exec, as a plain spawn of any child does
const libc = dlopen("libc.so.6", { system: { args: [FFIType.cstring], returns: FFIType.i32 } });
const quoted = `'${listing.replaceAll("'", "'\\''")}'`;
libc.symbols.system(Buffer.from(`for fd in /proc/self/fd/*; do readlink "$fd"; done > ${quoted}\0`));
if (!existsSync(listing)) throw new Error("The descriptor probe wrote no report");
const inherited = readFileSync(listing, "utf8").split("\n").includes(channel);
rmSync(dir, { recursive: true, force: true });
process.stdout.write(JSON.stringify({ channel, taken, argv, inherited }));
