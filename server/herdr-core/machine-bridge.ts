import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { entryCommand, ROOT } from "../entries.ts";
import type { HcConnection } from "./connection.ts";
import { hcBin } from "./runtime.ts";

/**
 * Another machine this PC's core reaches (`hc machine add`), as machine.list tells it. A temporary
 * one (a sandbox for a task) is not a PC: it is left out.
 */
export interface HcMachine {
  /** the other core's permanent id: the PC's id, which a rename keeps */
  id: string;
  /** what this core calls it: its terminals are `<name>/t3` */
  name: string;
  connected: boolean;
  why: string | null;
}

export async function listHcMachines(hc: Pick<HcConnection, "call">): Promise<HcMachine[]> {
  const { machines } = await hc.call("machine.list", {});
  return machines.filter((machine) => machine.temporary !== true)
    .map((machine) => ({ id: machine.id, name: machine.name, connected: machine.state === "connected", why: machine.why ?? (machine.state === "connected" ? null : machine.state) }));
}

/** A machine's own server (machine-entry.ts), on loopback for this one, and how to end it. */
export interface MachineBridge {
  endpoint: { url: string; token: string };
  exited: Promise<unknown>;
  stop: () => void;
}

const CORE_ENV = /^(?:HC_.*|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_RUNTIME_DIR|XDG_CONFIG_HOME|XDG_STATE_HOME)$/;
const PROGRAM_ENV = /^(?:PATH|PATHEXT|LANG|LC_.*|TMPDIR|TEMP|TMP|SystemRoot|SYSTEMROOT|WINDIR|ComSpec|COMSPEC)$/;
const READY_MS = 30_000;

/**
 * Starts a machine's server: this server's own code, in a process of its own, serving herdr's API from
 * that machine's terminals over this PC's core (machine-scope.ts). It runs with an empty home folder
 * of its own and none of this server's settings: the agents' files and processes here are not that
 * machine's, so no transcript of this PC can be taken for one of its panes. Its state lives under
 * `stateDir`; it ends with this server (it holds the stdin this one keeps open).
 */
export async function startMachineBridge(machine: Pick<HcMachine, "id" | "name">, stateDir: string): Promise<MachineBridge> {
  const dir = join(stateDir, "hc-machines", machine.id);
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const pick = (pattern: RegExp) => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => pattern.test(entry[0]) && entry[1] !== undefined));
  const env: Record<string, string> = {
    ...pick(PROGRAM_ENV),
    HOME: home,
    ...(process.platform === "win32" ? { USERPROFILE: home } : {}),
    OVIS_RUNTIME: "herdr-core",
    OVIS_HC_MACHINE: machine.name,
    OVIS_HC_MACHINE_ID: machine.id,
    OVIS_HC_MACHINE_STATE: dir,
    OVIS_HC_BIN: hcBin(),
    OVIS_HC_ENV: JSON.stringify(pick(CORE_ENV)),
  };
  const ready = Promise.withResolvers<{ port: number; token: string }>();
  const child = Bun.spawn(entryCommand("machine"), {
    cwd: ROOT, env, windowsHide: true, stdin: "pipe", stdout: "inherit", stderr: "inherit",
    ipc(message) {
      if (message?.type === "ready" && Number.isInteger(message.port) && typeof message.token === "string") ready.resolve({ port: message.port, token: message.token });
    },
  });
  const stop = () => {
    try { child.stdin.end(); } catch {}
    child.kill();
  };
  void child.exited.then((code) => ready.reject(new Error(`The server for ${machine.name} stopped before it answered (exit ${code})`)));
  const timer = setTimeout(() => ready.reject(new Error(`The server for ${machine.name} did not start within ${READY_MS / 1000}s`)), READY_MS);
  try {
    const { port, token } = await ready.promise;
    return { endpoint: { url: `http://127.0.0.1:${port}`, token }, exited: child.exited, stop };
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
