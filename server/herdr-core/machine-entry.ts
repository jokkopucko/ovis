// The server of one of the core's other machines (machine-bridge.ts starts it): herdr's API answered
// from that machine's terminals through this PC's core, served on loopback to the server that
// started it, as an SSH PC's bridge serves its own (server/remote-entry.ts).
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../index.ts";
import { hcMachine, setRuntime, startRuntime } from "./runtime.ts";

const stateDir = process.env["OVIS_HC_MACHINE_STATE"];
if (hcMachine() === null || !stateDir) throw new Error("machine-entry.ts runs only as machine-bridge.ts starts it");
setRuntime("herdr-core");
// the adapter's socket in a short folder of its own: under a long state folder its path would pass a unix socket's limit
const socketDir = mkdtempSync(join(tmpdir(), "ovis-hc-"));
const core = await startRuntime(socketDir);
const token = randomBytes(32).toString("hex");
// that machine's files are not on this disk: nothing here reads or makes them for it
const server = createServer({ port: 0, hostname: "127.0.0.1", token, machines: false, bridgeOnly: true, localFiles: false, stateDir });
process.send?.({ type: "ready", port: server.port, token });
for await (const _chunk of Bun.stdin.stream()) {}
await server.stop();
await core?.stop({ drain: true });
rmSync(socketDir, { recursive: true, force: true });
process.exit(0);
