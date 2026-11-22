/**
 * Settings → Devices and PCs → Add a connection → SSH: the PCs this PC's server could reach over SSH, for one
 * tap to open Add PC with the address filled in. Two sources, both read only, neither connected to:
 * the hosts named in its own account's ssh config, and the other PCs of its own Tailscale login (reached by
 * their MagicDNS name, over SSH like any other address, never through the relay).
 */
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { type ConfigHost, MAX_HOSTS, sshConfigHosts } from "./ssh-config.ts";
import { includer, MAX_FILE_BYTES, readCapped } from "./ssh-include.ts";
import { canonicalIp, RESOLVE_TIMEOUT_MS, resolveWithin, systemResolve } from "./ssh-lookup.ts";
import { readTailscaleStatus, tailnetPeers } from "./tailnet-pcs.ts";

export interface SshCandidate {
  /** the Host alias, or the Tailscale machine name */
  name: string;
  /** what Add PC connects to: the alias itself (ssh resolves it through the config), or the MagicDNS name */
  destination: string;
  /** user@hostname as the config resolves it, or the MagicDNS name; null when the alias says nothing more */
  detail: string | null;
  source: "ssh_config" | "tailscale";
  /** the MagicDNS name of the PC of this PC's Tailscale login it is, when it is one (a config host may name one) */
  tailnet?: string;
}

export interface SshCandidatesOptions {
  sshDir?: string;
  /** the folder `~` stands for, and with `sshDir` the only one an Include may read in; the server account's own by default */
  home?: string;
  readStatus?: () => Promise<string | null>;
  /** the addresses a host name resolves to, as ssh would reach it (getaddrinfo: hosts file, DNS, MagicDNS) */
  resolve?: (host: string) => Promise<string[]>;
  resolveTimeoutMs?: number;
}

const listings = new WeakMap<SshCandidatesOptions, Promise<SshCandidate[]>>();

export function sshCandidates(options: SshCandidatesOptions = {}): Promise<SshCandidate[]> {
  const running = listings.get(options);
  if (running !== undefined) return running;
  const listing = listCandidates(options).finally(() => listings.delete(options));
  listings.set(options, listing);
  return listing;
}

async function listCandidates(options: SshCandidatesOptions): Promise<SshCandidate[]> {
  const sshDir = options.sshDir ?? join(homedir(), ".ssh");
  const [config, status] = await Promise.all([readCapped(join(sshDir, "config"), MAX_FILE_BYTES), (options.readStatus ?? readTailscaleStatus)()]);
  const hosts = config === null ? [] : await sshConfigHosts(config, includer(sshDir, options.home ?? homedir()));
  const peers = tailnetPeers(status);
  // a config host is the Tailscale PC it reaches: its HostName when it sets one, else its alias, as ssh resolves it.
  // Then that row stands for it. An address, or the addresses a name resolves to, decide: all of them (of the
  // AddressFamily ssh uses) that PC's, else none (answers naming two PCs, or a PC and an address off the tailnet, claim
  // nothing), and a name whose lookup fails or is late claims none. A name is looked up as written (`box.example.`
  // stays absolute). A proxied host's name is resolved at the far end, wherever that leads, and an undetermined one may
  // go elsewhere, so neither claims a PC. An alias alone never claims a PC its HostName leads away from: one kept from
  // before a rename names a PC it no longer reaches
  const claimable = peers.length === 0 ? [] : hosts.filter((host) => host.proxied !== true && host.undetermined !== true);
  const names = [...new Set(claimable.map(({ alias, hostname }) => hostname ?? alias).filter((name) => isIP(name) === 0))];
  const resolved = await resolveWithin(names, { resolve: options.resolve ?? systemResolve, timeoutMs: options.resolveTimeoutMs ?? RESOLVE_TIMEOUT_MS });
  const peerByIp = new Map<string, (typeof peers)[number]>();
  for (const peer of peers) for (const ip of peer.ips) if (!peerByIp.has(canonicalIp(ip))) peerByIp.set(canonicalIp(ip), peer);
  const peerOf = ({ alias, hostname, addressFamily, proxied, undetermined }: ConfigHost) => {
    if (proxied === true || undetermined === true) return undefined;
    const written = hostname ?? alias;
    const addresses = (isIP(written) === 0 ? resolved.get(written) ?? [] : [canonicalIp(written)])
      .filter((address) => addressFamily === undefined || isIP(address) === (addressFamily === "inet" ? 4 : 6));
    const owners = new Set(addresses.map((address) => peerByIp.get(address)));
    return owners.size === 1 ? [...owners][0] : undefined;
  };
  const claimed = new Set<string>();
  const fromConfig: SshCandidate[] = [];
  for (const host of hosts) {
    const { alias, hostname, user } = host;
    const peer = peerOf(host);
    const claims = peer !== undefined && !claimed.has(peer.dnsName);
    if (!claims && fromConfig.length + peers.length - claimed.size >= MAX_HOSTS) continue;
    if (claims) claimed.add(peer.dnsName);
    fromConfig.push({
      name: alias,
      destination: alias,
      detail: hostname === null ? (user === null ? null : `${user}@${alias}`) : user === null ? hostname : `${user}@${hostname}`,
      source: "ssh_config",
      ...(peer === undefined ? {} : { tailnet: peer.dnsName }),
    });
  }
  const fromTailnet: SshCandidate[] = peers
    .filter(({ dnsName }) => !claimed.has(dnsName))
    .map(({ name, dnsName }) => ({ name, destination: dnsName, detail: dnsName, source: "tailscale", tailnet: dnsName }));
  return [...fromConfig, ...fromTailnet].slice(0, MAX_HOSTS);
}
