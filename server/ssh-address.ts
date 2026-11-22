import { userInfo } from "node:os";
import type { SshTarget } from "../shared/machines.ts";
import { sshClient } from "./ssh.ts";

const KEPT_MS = 60_000;
const KEPT_MOST = 512;
const FAILED_MS = 10_000;
const kept = new Map<string, { address: string | null; at: number }>();

/**
 * The PC an SSH target reaches, as OpenSSH resolves it (`ssh -G`, which reads the config and connects to nothing):
 * `user@hostname:port`. Two aliases of one host, or a port given and the default 22, are the same PC.
 */
export function sshAddress(target: SshTarget): string | null | undefined {
  const hit = kept.get(keyOf(target));
  if (!fresh(hit)) void warmSshAddresses([target]);
  return hit?.address;
}
const fresh = (hit: { address: string | null; at: number } | undefined) => !!hit && Date.now() - hit.at < (hit.address === null ? FAILED_MS : KEPT_MS);
const keyOf = (target: SshTarget) => `${target.destination}\0${target.port ?? ""}`;
const sshArgs = (target: SshTarget, config?: string) => [sshClient().ssh, ...(config ? ["-F", config] : []), "-G", ...(target.port ? ["-p", String(target.port)] : []), "--", target.destination];
function parseResolved(output: string): string | null {
  const said = new Map<string, string>();
  for (const line of output.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) said.set(line.slice(0, space).toLowerCase(), line.slice(space + 1).trim());
  }
  const user = said.get("user"), hostname = said.get("hostname"), port = said.get("port");
  return user && hostname && port ? `${user}@${hostname.toLowerCase()}:${port}` : null;
}

export function samePc(a: SshTarget, b: SshTarget, unknown = true): boolean {
  const x = sshAddress(a), y = sshAddress(b);
  if (typeof x === "string" && typeof y === "string") return x === y;
  const written = literalAddress(a) === literalAddress(b);
  return written || (unknown && (bareAlias(a) || bareAlias(b)));
}
const bareAlias = (target: SshTarget) => { const host = target.destination.slice(target.destination.lastIndexOf("@") + 1); return !host.includes(".") && !host.includes(":"); };

const pending = new Map<string, Promise<void>>();
let generation = 0;
export async function warmSshAddresses(targets: SshTarget[]): Promise<void> {
  await Promise.all(targets.map((target) => {
    const key = keyOf(target);
    if (fresh(kept.get(key))) return;
    const running = pending.get(key);
    if (running) return running;
    const asked = generation;
    const work = sshAddresses.resolve(target).then((address) => {
      if (asked !== generation) return;
      kept.delete(key);
      kept.set(key, { address, at: Date.now() });
      for (const old of kept.keys()) { if (kept.size <= KEPT_MOST) break; kept.delete(old); }
    }).finally(() => { if (asked === generation) pending.delete(key); });
    pending.set(key, work);
    return work;
  }));
}
const RESOLVE_MS = 3000;

/** The resolver, replaced in tests (scripts/test-herdr.ts): never the account's ssh or its config there. */
export const sshAddresses: { resolve(target: SshTarget, config?: string): Promise<string | null> } = {
  resolve: (target, config) => resolveWithSsh(target, config),
};
export async function resolveWithSsh(target: SshTarget, config?: string): Promise<string | null> {
  {
    try {
      const run = Bun.spawn(sshArgs(target, config), { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
      // the read ends at the limit too: a child ssh left running (a Match exec, say) may hold its output open after it is killed
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise<null>((resolve) => { timer = setTimeout(() => { run.kill("SIGKILL"); resolve(null); }, RESOLVE_MS); });
      const done = Promise.all([new Response(run.stdout).text(), run.exited]).then(([output, code]) => code === 0 ? parseResolved(output) : null);
      try { return await Promise.race([done, limit]); } finally { clearTimeout(timer); }
    } catch { return null; }
  }
}

export function literalAddress(target: SshTarget): string {
  const at = target.destination.lastIndexOf("@");
  const user = at >= 0 ? target.destination.slice(0, at) : userInfo().username;
  return `${user}@${target.destination.slice(at + 1).toLowerCase()}:${target.port ?? 22}`;
}

export function forgetSshAddresses(): void { kept.clear(); pending.clear(); generation++; }
