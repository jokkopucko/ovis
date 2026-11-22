import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SshTarget } from "../shared/machines.ts";
import { validateTarget } from "./machine-security.ts";

/** Saved by the local herdr client; reading its catalog never connects to a host. */
export interface HerdrMachineProfile {
  id: string;
  label: string;
  enabled: boolean;
  /** null when herdr accepts an address this web client cannot represent safely. */
  target: SshTarget | null;
}

const run = promisify(execFile);

function profileTarget(target: string, session: string): SshTarget | null {
  try {
    const selectedSession = session === "default" || session === "" ? {} : { session };
    // Herdr also accepts SSH URIs. Keep the SSH alias verbatim (URL would lowercase it),
    // and split only the explicit port; credentials, paths and encoded options are refused.
    if (target.startsWith("ssh://")) {
      const match = /^ssh:\/\/((?:[a-zA-Z0-9_.-]+@)?(?:\[[a-fA-F0-9:]+\]|[a-zA-Z0-9_.-]+))(?::([0-9]+))?$/.exec(target);
      if (!match) return null;
      return validateTarget({ destination: match[1], ...selectedSession, ...(match[2] ? { port: Number(match[2]) } : {}) });
    }
    return validateTarget({ destination: target, ...selectedSession });
  } catch { return null; }
}

export function parseHerdrProfiles(text: string): HerdrMachineProfile[] {
  const rows: unknown = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error("Invalid herdr machine list");
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
    if (!row || typeof row !== "object") throw new Error("Invalid herdr machine profile");
    const value = row as Record<string, unknown>;
    if (typeof value.id !== "string" || !value.id || ids.has(value.id) || typeof value.label !== "string"
      || typeof value.target !== "string" || typeof value.session !== "string" || typeof value.enabled !== "boolean") throw new Error("Invalid herdr machine profile");
    ids.add(value.id);
    return { id: value.id, label: value.label, enabled: value.enabled, target: profileTarget(value.target, value.session) };
  });
}

export function samePort(a: SshTarget["port"], b: SshTarget["port"]): boolean {
  return a === undefined || b === undefined ? a === b : Number(a) === Number(b);
}

export function sameSshSession(a: SshTarget, b: SshTarget): boolean {
  // An omitted port is resolved by OpenSSH config, and need not be 22. Do not guess
  // that two aliases or an implicit and explicit port name the same destination.
  return a.destination === b.destination && samePort(a.port, b.port) && (a.session || "default") === (b.session || "default");
}

export async function readHerdrProfiles(): Promise<HerdrMachineProfile[]> {
  try {
    const { stdout } = await run(process.env.OVIS_HERDR_BIN || "herdr", ["machine", "list", "--json"], {
      timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true,
    });
    return parseHerdrProfiles(stdout);
  } catch {
    // CLI stderr can include local paths. Keep the discovery diagnostic bounded and actionable;
    // manual setup remains usable with old/missing herdr or an unreadable catalog.
    throw new Error("Could not read saved herdr machines. Check herdr machine list --json on this PC, or enter an SSH address manually.");
  }
}
