/**
 * Settings → Connect a device → PCs on your Tailscale: other PCs of this PC's own Tailscale login whose Ovis
 * already lets this PC drive it, each added through the relay with one tap. Adding one asks that PC, over the
 * tailnet, for the code it would show under Connect a device, and spends it here as a typed code would
 * (MachineManager.addTailnet). Nothing new is trusted: the other PC answers only because `tailscale serve`
 * names this PC's login as its owner's (server/access.ts), the access that already drives it. The tailnet
 * itself admits nobody, and no account membership comes from it.
 */
import { HTTPS_PORTS, tailscaleBinary } from "./tailscale.ts";
import { TargetAccountPcError } from "../shared/relay-channel.ts";

const PROBE_MS = 2500;
/** an address the list found stays addable this long */
const FOUND_MS = 10 * 60_000;
const MAX_PEERS = 32;
const PHONE_OS = new Set(["ios", "android"]);
/** a health or code answer is a few hundred bytes; anything past this is not one */
const MAX_BODY_BYTES = 64 * 1024;

export interface TailnetPcsOptions {
  readStatus?: () => Promise<string | null>;
  ports?: readonly number[];
  origin?: (dnsName: string, port: number) => string;
}

export interface TailnetPc {
  name: string;
  url: string;
  /** that PC's relay phase: a code is asked only while it is online */
  relay: string | null;
  /** that PC's Ovis predates typed codes (before 0.5): it is updated before one tap can add it */
  outdated: boolean;
}

interface PeerJson { DNSName?: string; UserID?: string; Online?: boolean; OS?: string; Tags?: string[]; TailscaleIPs?: string[] }
interface StatusJson { BackendState?: string; Self?: PeerJson; Peer?: Record<string, PeerJson> }

/** Online, untagged peers of this PC's own login, phones aside, from `tailscale status --json`. */
export function tailnetPeers(status: string | null): { name: string; dnsName: string; ips: string[] }[] {
  if (status === null) return [];
  let parsed: StatusJson;
  // user ids pass 2^53: kept as the digits written, or two ids can become one
  try { parsed = JSON.parse(status.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"')) as StatusJson; } catch { return []; }
  const own = parsed.Self?.UserID;
  if (parsed.BackendState !== "Running" || own === undefined || (parsed.Self?.Tags?.length ?? 0) > 0) return [];
  return Object.values(parsed.Peer ?? {})
    .filter((peer) => peer.Online === true && (peer.Tags?.length ?? 0) === 0 && String(peer.UserID) === String(own)
      && typeof peer.DNSName === "string" && peer.DNSName !== "" && !PHONE_OS.has((peer.OS ?? "").toLowerCase()))
    .slice(0, MAX_PEERS)
    .map((peer) => {
      const dnsName = peer.DNSName!.replace(/\.$/, "");
      // the machine name Tailscale's admin console shows and lets the person rename, not the OS hostname
      return { name: dnsName.split(".")[0]!.slice(0, 100), dnsName, ips: (peer.TailscaleIPs ?? []).filter((ip) => typeof ip === "string") };
    });
}

/** `tailscale status --json` from this PC's own CLI, or null when Tailscale is not here or does not answer in time */
export const readTailscaleStatus = async (): Promise<string | null> => {
  const binary = tailscaleBinary();
  if (binary === null) return null;
  const proc = Bun.spawn([binary, "status", "--json"], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => proc.kill(), PROBE_MS);
  try {
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? text : null;
  } catch { return null; } finally { clearTimeout(timer); }
};

const httpsOrigin = (dnsName: string, port: number) => `https://${dnsName}${port === 443 ? "" : `:${port}`}`;

/** The body as JSON, or null when it is not JSON or runs past MAX_BODY_BYTES; reading stops there. */
async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { void reader.cancel(); return null; }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return null; }
}

interface Health { web_ui?: { server_id?: string }; auth?: { authenticated?: boolean; via?: string; role?: string }; relay?: { phase?: string } | null }

export class TailnetPcs {
  private found = new Map<string, { name: string; dnsName: string; at: number }>();
  private listing: Promise<(TailnetPc & { server_id: string | null })[]> | null = null;
  private readonly readStatus: () => Promise<string | null>;
  private readonly ports: readonly number[];
  private readonly origin: (dnsName: string, port: number) => string;

  constructor(options: TailnetPcsOptions = {}) {
    this.readStatus = options.readStatus ?? readTailscaleStatus;
    this.ports = options.ports ?? HTTPS_PORTS;
    this.origin = options.origin ?? httpsOrigin;
  }

  /** this PC's login drives that Ovis as its owner: what `tailscale serve` says, never an open LAN window; herdr there may be stopped */
  private static drivable(health: Health): boolean {
    return health.auth?.authenticated === true && health.auth.via === "tailscale" && health.auth.role === "drive";
  }

  /**
   * An Ovis before typed codes: its health names no relay ID while its relay is online. Both came in the same
   * release (0.4.23), and an online relay always has its ID, so a current Ovis never looks like this.
   */
  private static outdated(health: Health): boolean {
    return health.relay?.phase === "online" && health.web_ui?.server_id === undefined;
  }

  private async probe(url: string): Promise<Health | null> {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(PROBE_MS), redirect: "error" });
      if (!response.ok) { void response.body?.cancel(); return null; }
      const health = await boundedJson(response);
      return typeof health === "object" && health !== null ? health as Health : null;
    } catch { return null; }
  }

  async list(added: ReadonlySet<string>): Promise<TailnetPc[]> {
    this.listing ??= this.discover().finally(() => { this.listing = null; });
    return (await this.listing).filter((pc) => pc.server_id === null || !added.has(pc.server_id)).map(({ name, url, relay, outdated }) => ({ name, url, relay, outdated }));
  }

  private async discover(): Promise<(TailnetPc & { server_id: string | null })[]> {
    const peers = tailnetPeers(await this.readStatus());
    const pcs = await Promise.all(peers.map(async ({ name, dnsName }): Promise<(TailnetPc & { dnsName: string; server_id: string | null }) | null> => {
      const answers = await Promise.all(this.ports.map(async (port) => {
        const url = this.origin(dnsName, port);
        const health = await this.probe(url);
        return health !== null && TailnetPcs.drivable(health)
          ? { name, dnsName, url, relay: health.relay?.phase ?? null, outdated: TailnetPcs.outdated(health), server_id: health.web_ui?.server_id ?? null } : null;
      }));
      const found = answers.filter((answer) => answer !== null);
      return found.find((answer) => answer.server_id !== null && answer.relay === "online") ?? found.find((answer) => answer.server_id !== null)
        ?? found.find((answer) => !answer.outdated) ?? found[0] ?? null;
    }));
    const listed = pcs.filter((pc) => pc !== null);
    // a fresh list replaces the last: a PC gone from it is no longer addable
    this.found = new Map(listed.map((pc) => [pc.url, { name: pc.name, dnsName: pc.dnsName, at: Date.now() }]));
    return listed.map(({ name, url, relay, outdated, server_id }) => ({ name, url, relay, outdated, server_id }));
  }

  /** the name a recent list found at this address, or null: no other address is ever asked for a code */
  foundAt(url: unknown): string | null {
    if (typeof url !== "string") return null;
    const held = this.found.get(url);
    return held !== undefined && Date.now() - held.at <= FOUND_MS ? held.name : null;
  }

  /**
   * The code that PC would show under Connect a device, asked of it as its owner (server/relay/routes.ts
   * /api/relay/code). Its trust is checked again first, Tailscale's word before the PC's: the list may be minutes old.
   */
  async code(url: string, added: ReadonlySet<string>): Promise<{ code: string; server_id: string }> {
    const held = this.found.get(url);
    const peers = tailnetPeers(await this.readStatus());
    if (held === undefined || !peers.some((peer) => peer.dnsName === held.dnsName)) throw new TailnetPcError("not_found", "That PC is no longer one of yours on Tailscale. Look again.");
    const health = await this.probe(url);
    if (health === null || !TailnetPcs.drivable(health)) throw new TailnetPcError("not_owner", "That PC no longer lets this PC in as its owner over Tailscale. Add it with its code instead.");
    if (health.web_ui?.server_id !== undefined && added.has(health.web_ui.server_id)) throw new TailnetPcError("already_added", "That PC is already added.");
    if (health.relay?.phase !== "online") throw new TailnetPcError("relay_off", "Turn the relay on on that PC first, under Add a connection.");
    if (TailnetPcs.outdated(health)) throw new TailnetPcError("outdated", OUTDATED);
    let response: Response;
    try {
      response = await fetch(`${url}/api/relay/code`, { method: "POST", headers: { "x-herdr-update": "1", "x-ovis-pc-add": "1" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    } catch {
      throw new TailnetPcError("unreachable", "That PC did not answer. Check that it is on, then try again.");
    }
    const body = await boundedJson(response) as { code?: unknown; server_id?: unknown; error?: { code?: unknown } } | null;
    if (!response.ok || typeof body?.code !== "string" || typeof body.server_id !== "string") {
      // that PC's own words never reach the person. Its health named its relay ID, so it is a current Ovis: a 404 or
      // 405 here comes from something in between, not from its version
      const refusal = body?.error?.code;
      if (refusal === "pc_add_target_bound") throw new TargetAccountPcError();
      if (refusal === "relay_off") throw new TailnetPcError("relay_off", "Turn the relay on on that PC first, under Add a connection.");
      if (refusal === "relay_offline") throw new TailnetPcError("relay_offline", "That PC's relay cannot be reached right now. Try again in a moment.");
      if (refusal === "code_unavailable") throw new TailnetPcError("code_unavailable", "That PC uses its own relay, which cannot give a code. Add it with its QR code instead.");
      throw new TailnetPcError("no_code", "That PC could not give a code just now. Try again in a moment.");
    }
    return { code: body.code, server_id: body.server_id };
  }
}

const OUTDATED = "That PC runs an older Ovis. Update it to 0.5 to add it here in one tap.";

export class TailnetPcError extends Error {
  constructor(readonly failure: "not_found" | "not_owner" | "already_added" | "relay_off" | "relay_offline" | "code_unavailable" | "outdated" | "unreachable" | "no_code" | "mismatch", message: string) { super(message); }
}
