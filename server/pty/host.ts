import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../entries.ts";
import { answersUsage, exitText, installedBinaryVouched, runBounded, type BinaryVerdict } from "../native-binary.ts";

export { installedBinaryVouched as installedHostVouched } from "../native-binary.ts";

export const RUST_SIDECAR_BUILD = join(ROOT, "crates", "pty-sidecar", "target", "release", "ovis-pty-sidecar");
export const RUST_SIDECAR_INSTALLED = join(ROOT, "bin", "ovis-pty-sidecar");

/** The host to run without OVIS_PTY_SIDECAR_BIN: the installed release's when its record vouches for it, else a local build. */
export function defaultRustSidecar(installed = RUST_SIDECAR_INSTALLED): string {
  return existsSync(installed) && installedBinaryVouched(installed) ? installed : RUST_SIDECAR_BUILD;
}

export type RustHostVerdict = BinaryVerdict;

const verdicts = new Map<string, RustHostVerdict>();
const said = new Set<string>();

function once(message: string, print: (message: string) => void = console.error): void {
  if (said.has(message)) return;
  said.add(message);
  print(message);
}

export function rustSidecarPath(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const binary = env["OVIS_PTY_SIDECAR_BIN"] || defaultRustSidecar();
  if (binary === "~") return home;
  return binary.startsWith("~/") ? join(home, binary.slice(2)) : binary;
}

/**
 * Checks the host's identity and its PTY path before it is allowed to serve attachments, in at most
 * 2 x timeoutMs: a run past its time is killed with SIGKILL, since the host (or a binary posing as it)
 * may outlive SIGTERM, and the server's start waits on this check.
 */
export function probeRustHost(binary: string, env: Record<string, string | undefined> = process.env, timeoutMs = 3000): RustHostVerdict {
  const identity = answersUsage(binary, { usage: "pty-sidecar: usage:", what: "the Rust PTY host" }, env, timeoutMs);
  if (!identity.ok) return identity;
  const run = runBounded([binary, "1", "1", "true"], env, timeoutMs);
  if ("reason" in run) return { ok: false, reason: run.reason };
  return run.exitCode === 0 ? { ok: true } : { ok: false, reason: exitText(run) };
}

/** What to do about a host that cannot run, said with the reason it fails for. */
export const RUST_HOST_FIX = "run bun scripts/pty-sidecar.ts install for the release's host in bin/, build one with cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml, or set OVIS_PTY_SIDECAR_BIN to a built binary's absolute path, in a folder that lets programs run (not mounted noexec)";

/**
 * The PTY host of every terminal this server runs itself, on Linux and macOS, once it passes its check.
 * Without one, herdr's terminals are mirrored and a private sign-in is refused.
 */
export function rustSidecar(env: Record<string, string | undefined> = process.env): string | null {
  if (process.platform === "win32") return null;
  if (env["OVIS_PTY_SIDECAR"] === "node") once("OVIS_PTY_SIDECAR=node: the Node PTY sidecar was removed, so the Rust PTY host runs every terminal");
  const binary = rustSidecarPath(env);
  let verdict = verdicts.get(binary);
  if (!verdict) {
    verdict = probeRustHost(binary, env);
    verdicts.set(binary, verdict);
  }
  if (!verdict.ok) {
    once(`No PTY host: the Rust PTY host cannot run (${binary}: ${verdict.reason}), so herdr's terminals are mirrored; to fix it, ${RUST_HOST_FIX}`);
    return null;
  }
  once(`PTY host: Rust (${binary})`, console.log);
  return binary;
}

export function resetPtyHostForTests(): void {
  verdicts.clear();
  said.clear();
}
