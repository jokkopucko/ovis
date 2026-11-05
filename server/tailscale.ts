/**
 * What Tailscale on this PC can already do for a phone, read-only: `tailscale status --json` and
 * `tailscale serve status --json`, never `serve`, `up` or anything else that changes the tailnet.
 * The Settings → Phone panel turns the answer into the address that already works, or the one
 * command the user still has to run on this PC.
 */
import { existsSync } from "node:fs";
import type { RemoteAccess, TailscaleAccess } from "../shared/protocol.ts";
import { addressesNode } from "./access.ts";

const TIMEOUT_MS = 2500;
/** the macOS App Store build puts no `tailscale` on the PATH; its CLI lives in the app bundle */
const MAC_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** HTTPS ports to suggest, the conventional one first; a port another service already uses is skipped */
export const HTTPS_PORTS: readonly number[] = [443, 8443, 7317, 17317];
/** names the one HTTPS port to publish the app on, for a user who keeps 443 for something else */
export const HTTPS_PORT_VARIABLE = "OVIS_TAILSCALE_HTTPS_PORT";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** stdout of the two commands; null where the command failed, timed out or is not installed */
export interface TailscaleOutput {
  status: string | null;
  serve: string | null;
}

interface NodeJson { DNSName?: string; UserID?: number | string; TailscaleIPs?: string[]; Tags?: string[] }
interface StatusJson { BackendState?: string; Self?: NodeJson; Peer?: Record<string, NodeJson>; User?: Record<string, { LoginName?: string }> }
interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>;
  /** "host:port" -> handlers by path */
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
}

const NONE: TailscaleAccess = { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null };

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try { return JSON.parse(text) as T; } catch { return null; }
}

/**
 * `tailscale status --json` with every `UserID` kept as the digits written. Tailscale's user ids
 * pass 2^53, so as a double an id stops matching its key in `User`, and two ids can become one.
 */
function parseStatus(status: string | null): StatusJson | null {
  return parseJson<StatusJson>(status === null ? null : status.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"'));
}

/** Does this `serve` proxy target point at the web ui on this machine, at its root? */
function proxiesTo(target: string | undefined, port: number): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    const targetPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return LOOPBACK.has(url.hostname) && targetPort === port && (url.pathname === "" || url.pathname === "/");
  } catch { return false; }
}

function httpsUrl(host: string, port: number): string {
  return `https://${host}${port === 443 ? "" : `:${port}`}`;
}

/**
 * The HTTPS ports a new `tailscale serve` may take, in order: the usual ones while the variable is
 * unset, only the port it names when it is set, and none when it names no port. A port the user
 * chose is never traded for another, since a phone's installed app stays on the address it was
 * installed from.
 */
export function httpsPorts(value: string | undefined): readonly number[] {
  const text = value?.trim() ?? "";
  if (text === "") return HTTPS_PORTS;
  const port = /^\d+$/.test(text) ? Number(text) : 0;
  return port >= 1 && port <= 65535 ? [port] : [];
}

/** Pure: the two commands' output (or their absence) to what the phone panel needs. */
export function parseTailscale(output: TailscaleOutput | null, port: number, candidates: readonly number[] = HTTPS_PORTS): TailscaleAccess {
  if (output === null) return NONE;
  const status = parseJson<StatusJson>(output.status);
  if (status === null || status.BackendState !== "Running") return { ...NONE, state: "stopped" };
  const dns = parseNodeName(output.status);
  const serve = parseJson<ServeJson>(output.serve);
  const taken = new Set(Object.keys(serve?.TCP ?? {}).map(Number).filter(Number.isFinite));
  let servingUrl: string | null = null;
  for (const [hostPort, site] of Object.entries(serve?.Web ?? {})) {
    const separator = hostPort.lastIndexOf(":");
    const host = hostPort.slice(0, separator);
    const webPort = Number(hostPort.slice(separator + 1));
    // an HTTP listener is no use to a phone: it can neither install the app nor receive alerts
    if (!serve?.TCP?.[String(webPort)]?.HTTPS) continue;
    if (proxiesTo(site.Handlers?.["/"]?.Proxy, port)) { servingUrl = httpsUrl(host, webPort); break; }
  }
  const free = servingUrl === null ? candidates.find((candidate) => !taken.has(candidate)) ?? null : null;
  return {
    state: "running",
    dns_name: dns,
    serving_url: servingUrl,
    serve_command: free === null ? null : `tailscale serve --bg --https=${free} http://127.0.0.1:${port}`,
    serve_url: free === null || dns === null ? null : httpsUrl(dns, free),
  };
}

export function tailscaleBinary(): string | null {
  return Bun.which("tailscale") ?? (existsSync(MAC_APP_CLI) ? MAC_APP_CLI : null);
}

async function run(binary: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn([binary, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function readTailscale(binary: string | null = tailscaleBinary()): Promise<TailscaleOutput | null> {
  if (binary === null) return null;
  const [status, serve] = await Promise.all([run(binary, ["status", "--json"]), run(binary, ["serve", "status", "--json"])]);
  return { status, serve };
}

export async function remoteAccess(port: number, candidates: readonly number[] = httpsPorts(process.env[HTTPS_PORT_VARIABLE])): Promise<RemoteAccess> {
  return { port, tailscale: parseTailscale(await readTailscale(), port, candidates) };
}

/** A tagged node belongs to no person: its `User` entry is the node itself, named by its MagicDNS name. */
export function isTaggedNode(status: string | null): boolean {
  return (parseJson<StatusJson>(status)?.Self?.Tags?.length ?? 0) > 0;
}

/** The login this PC's Tailscale node belongs to, from `tailscale status --json`; null when it does not say, or the node is tagged. */
export function parseTailscaleOwner(status: string | null): string | null {
  const parsed = parseStatus(status);
  const id = parsed?.Self?.UserID;
  if (id === undefined || id === null || isTaggedNode(status)) return null;
  return parsed?.User?.[String(id)]?.LoginName || null;
}

/**
 * The one login `tailscale status --json` proves owns every node of this tailnet, with none of them
 * tagged, or null. A tagged node is the one case `tailscale serve` deliberately states no person
 * for, and a tailnet can hold many of those, which is why a proxied request with no login is
 * otherwise a stranger. Where Tailscale says there is no tagged node and no second login, the
 * owner's own devices are all a tailnet request can come from. A second login, a single tag
 * anywhere, a node whose owner the status does not name, or a status it could not read answer
 * null: the proof has to be positive, never the benefit of the doubt.
 */
export function parseSoleTailnetLogin(status: string | null): string | null {
  return readSoleLogin(status).login;
}

/**
 * `parseSoleTailnetLogin`'s proof together with what the status settles for good: a Running status
 * that names this PC's user states whether one login owns the tailnet - the login above, or a tag
 * or a second login against it. A daemon still coming up, a status that names no user for this
 * PC, or one that names no login for a tailnet it would prove, leaves the question open instead.
 */
function readSoleLogin(status: string | null): { login: string | null; settled: boolean } {
  // "every node" is every node this PC's Tailscale lists: a node an ACL hides is not in its network map
  const parsed = parseStatus(status);
  if (parsed === null || parsed.BackendState !== "Running") return { login: null, settled: false };
  const self = parsed.Self;
  if (self === undefined || self.UserID === undefined || self.UserID === null) return { login: null, settled: false };
  const owner = self.UserID;
  // offline peers count: they are nodes of this tailnet and can come back at any moment
  const nodes: NodeJson[] = [self, ...Object.values(parsed.Peer ?? {})];
  const sole = nodes.every((node) => (node.Tags?.length ?? 0) === 0
    && node.UserID !== undefined && node.UserID !== null && String(node.UserID) === String(owner));
  if (!sole) return { login: null, settled: true };
  const login = parsed.User?.[String(owner)]?.LoginName || null;
  return { login, settled: login !== null };
}

/** This PC's IPv4 address on the tailnet (100.x.y.z), from `tailscale status --json`; null when it has none. */
export function parseTailscaleIp(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.TailscaleIPs?.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null;
}

/** This PC's MagicDNS name from `tailscale status --json`, without its trailing dot; null when it has none. */
export function parseNodeName(status: string | null): string | null {
  return parseJson<StatusJson>(status)?.Self?.DNSName?.replace(/\.$/, "") || null;
}

export interface TailnetIdentity {
  owner: string | null;
  tagged: boolean;
  soleLogin: string | null;
  dnsName: string | null;
  tailnetIp: string | null;
}

const OWNER_TTL_MS = 5 * 60_000;
/** how soon a request stating a login may read the status again while this PC's own login is unknown */
const LOGIN_RETRY_MS = 2_000;

const cliStatus = async (): Promise<string | null> => {
  const binary = tailscaleBinary();
  return binary === null ? null : run(binary, ["status", "--json"]);
};

/**
 * What `tailscale status --json` says about this PC and its tailnet, read through `readStatus` and
 * kept five minutes. `identity` answers every reader that does not grant from the cache, refreshing
 * a stale value in the background, so those readers never wait on the tailscale CLI; the first
 * lookup is what `createServer` starts. `freshIdentity` is the owner's grant path, the one reader
 * that waits for a read, shared with any read already in flight.
 */
export class TailnetIdentitySource {
  /**
   * the last read's answer and when it landed; null until the first read lands. `ownerKnown`: a
   * Running status named this PC's login, or that its node is tagged and has none
   */
  private cache: (TailnetIdentity & { at: number; settled: boolean; ownerKnown: boolean }) | null = null;
  /** the read in flight, so concurrent grants share one bounded read */
  private reading: Promise<void> | null = null;

  constructor(private readonly readStatus: () => Promise<string | null> = cliStatus) {}

  /**
   * A read that failed, or one whose status leaves the sole-login question open, keeps what the
   * last read said about this PC, withdraws the sole-login proof, and marks the cache unsettled,
   * so the next grant-path request reads again at once instead of waiting out the TTL. A status
   * that states the answer for good - one login's tailnet, or a tag or a second login against it
   * - stands for the TTL. Readers that do not grant keep the TTL as before.
   */
  private async read(): Promise<void> {
    const status = await this.readStatus();
    if (status === null) {
      this.cache = {
        owner: this.cache?.owner ?? null,
        tagged: this.cache?.tagged ?? false,
        soleLogin: null,
        dnsName: this.cache?.dnsName ?? null,
        tailnetIp: this.cache?.tailnetIp ?? null,
        settled: false,
        ownerKnown: this.cache?.ownerKnown ?? false,
        at: Date.now(),
      };
      return;
    }
    const sole = readSoleLogin(status);
    // a daemon that is not Running says nothing about whose PC this is: keep the login a Running one
    // named, and leave it unconfirmed so a login request reads again (`loginIdentity`)
    const running = parseStatus(status)?.BackendState === "Running";
    const kept = !running && this.cache !== null && (this.cache.owner !== null || this.cache.tagged) ? this.cache : null;
    const owner = kept ? kept.owner : parseTailscaleOwner(status);
    const tagged = kept ? kept.tagged : isTaggedNode(status);
    this.cache = {
      owner,
      tagged,
      soleLogin: sole.login,
      dnsName: parseNodeName(status),
      tailnetIp: parseTailscaleIp(status),
      settled: sole.settled,
      ownerKnown: running && (owner !== null || tagged),
      at: Date.now(),
    };
  }

  private refresh(): Promise<void> {
    this.reading ??= this.read().finally(() => { this.reading = null; });
    return this.reading;
  }

  /**
   * The PC's own Tailscale login, or that its node is tagged and has none, and the one login that
   * owns this whole tailnet (`parseSoleTailnetLogin`), cached five minutes. A stale value is
   * answered at once and refreshed in the background.
   */
  identity(): TailnetIdentity {
    if (this.cache === null || Date.now() - this.cache.at >= OWNER_TTL_MS) void this.refresh();
    return {
      owner: this.cache?.owner ?? null,
      tagged: this.cache?.tagged ?? false,
      soleLogin: this.cache?.soleLogin ?? null,
      dnsName: this.cache?.dnsName ?? null,
      tailnetIp: this.cache?.tailnetIp ?? null,
    };
  }

  /**
   * `identity` for a request that states a Tailscale login. Until a read has named this PC's own
   * login (or found its node tagged), this waits for a read, shared and bounded like
   * `freshIdentity`: a server started at boot asks before tailscaled has logged in, and that
   * answer must not stand for five minutes against the owner's own devices. A new read starts at
   * most every `LOGIN_RETRY_MS`, so requests cannot keep the tailscale CLI spawning.
   */
  async loginIdentity(): Promise<TailnetIdentity> {
    if (this.cache !== null && this.cache.ownerKnown) return this.identity();
    if (this.reading === null && this.cache !== null && Date.now() - this.cache.at < LOGIN_RETRY_MS) return this.identity();
    await this.refresh();
    return this.identity();
  }

  /**
   * `identity` for a request the owner's sole-login proof would admit. A cache that already says
   * a node is tagged, that the tailnet is not one login's, or that this Host is not this PC's name
   * answers at once and grants nothing. Otherwise this waits for one status read, shared with any
   * read in flight and bounded by the read's own timeout, so the grant never rests on a warm cache.
   * A read that fails, or leaves the question open, grants nothing and is read again next request.
   */
  async freshIdentity(host: string | null): Promise<TailnetIdentity> {
    const cached = this.identity();
    if (this.cache !== null && this.cache.settled && (this.cache.soleLogin === null || !addressesNode({ host, dnsName: this.cache.dnsName, tailnetIp: this.cache.tailnetIp }))) return cached;
    await this.refresh();
    return this.identity();
  }
}
