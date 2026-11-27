/**
 * The launcher of `ovis tui` (scripts/plugin-tui.ts) with the host fixture as its screen, for
 * tui/host/restore.contract.test.ts:
 *
 *   bun tui/testing/launcher-fixture.ts <a mode of host-fixture.ts> [waiter]
 *
 * The mode reaches the launcher as an argument it does not take itself, so it starts the screen at once, with no core,
 * and hands the mode on. With `waiter` the launcher hands itself over to the small shell waiter as `ovis tui` does
 * (scripts/plugin-tui-waiter.ts); without, it stays and waits for the screen itself. Everything else is the launcher's own: the signals it passes on, the terminal settings it saves,
 * and what it writes back when the screen dies by a signal.
 */
import { join } from "node:path";
import { launchTui, systemParts } from "../../scripts/plugin-tui.ts";
import { execWaiter } from "../../scripts/plugin-tui-waiter.ts";

const caller: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const parts = systemParts(caller, caller["HOME"] ?? "/");
const screen = { command: [process.execPath, join(import.meta.dir, "host-fixture.ts")], cwd: import.meta.dir, file: null };
const mode = process.argv[2] ?? "wait";
if (mode === "job") process.stdout.write(`OVIS_TEST_JOB ${process.pid}\n`);
const handOver = process.argv[3] === "waiter" ? { handOver: execWaiter } : {};
process.exit(await launchTui([mode], { ...parts, screen, ...handOver }));
