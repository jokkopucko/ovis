/**
 * Which side of a relay connection is behind, from what the PC's WELCOME says about itself
 * (shared/relay-mux.ts). Pure, so the policy is tested without a browser; lib/relay/shell.tsx acts
 * on the answer and components/RelayShell.tsx shows it.
 *
 * - another `relay_protocol`: the two cannot talk at all, a hard stop (`needs-update`);
 * - a server below MIN_SERVER_VERSION: the PC must update first (`pc-outdated`), from the shell
 *   when its install is managed;
 * - a server newer than the shell: this page is a stale cache, reloaded once onto the new shell;
 * - anything else connects. A server at the shell's own version always does: it is built from the
 *   same source, which is what an unreleased checkout reports until its release raises the version.
 */
import { MIN_SERVER_VERSION, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";

export type RelaySkew = "ok" | "protocol-mismatch" | "pc-outdated" | "server-newer";

type Version = readonly [number, number, number];

/**
 * SemVer 2.0.0: `major.minor.patch`, then an optional `-pre.release` and `+build.meta`, each a
 * dot-separated list of non-empty [0-9A-Za-z-] identifiers (numeric pre-release ones without a
 * leading zero). The suffixes are validated, not compared. Anything else is null.
 */
const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(text: string): Version | null {
  if (text.length > 64) return null;
  const match = SEMVER.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export interface RelaySkewInput {
  server: { version: string; relayProtocol: number };
  shellVersion: string;
  minServerVersion?: string;
  relayProtocol?: number;
}

export function relaySkew({ server, shellVersion, minServerVersion = MIN_SERVER_VERSION, relayProtocol = RELAY_PROTOCOL }: RelaySkewInput): RelaySkew {
  if (server.relayProtocol !== relayProtocol) return "protocol-mismatch";
  const ours = parseVersion(shellVersion);
  const theirs = parseVersion(server.version);
  // a version the shell cannot read is not one it knows to support
  if (theirs === null) return "pc-outdated";
  const configured = parseVersion(minServerVersion);
  if (configured === null) throw new Error(`MIN_SERVER_VERSION is not a version: ${minServerVersion}`);
  const floor = ours !== null && compareVersions(ours, configured) < 0 ? ours : configured;
  if (compareVersions(theirs, floor) < 0) return "pc-outdated";
  if (ours !== null && compareVersions(theirs, ours) > 0) return "server-newer";
  return "ok";
}

export interface ReloadMemory {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const RELOAD_KEY = "ovis:relay-skew-reloads";
/** Pairs remembered per tab; past this the oldest is forgotten, so the receipt stays small. */
const RELOAD_PAIRS = 16;

function reloaded(memory: ReloadMemory): string[] {
  try {
    const value: unknown = JSON.parse(memory.getItem(RELOAD_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((pair): pair is string => typeof pair === "string") : [];
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
}

/**
 * Whether a newer PC should reload this page onto a newer shell: once per (shell, server)
 * pair, recorded in the tab's sessionStorage, so a host still serving the old shell after the
 * reload connects instead of reloading again. Storage that throws (a private window) answers no:
 * a missed reload costs less than a loop.
 */
export function reloadOnce(memory: ReloadMemory, shellVersion: string, serverVersion: string): boolean {
  const pair = `${shellVersion}->${serverVersion}`;
  try {
    const pairs = reloaded(memory);
    if (pairs.includes(pair)) return false;
    memory.setItem(RELOAD_KEY, JSON.stringify([...pairs, pair].slice(-RELOAD_PAIRS)));
    return reloaded(memory).includes(pair);
  } catch { return false; }
}
