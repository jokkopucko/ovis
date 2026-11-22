import { isIP } from "node:net";

export const RESOLVE_TIMEOUT_MS = 1500;
/** name lookups running at most across every listing; a lookup holds its slot until the resolver answers, since a
 * system lookup cannot be cancelled, and the rest wait for a free slot. A held slot relies on getaddrinfo's own timeout
 * (resolv.conf's timeout and attempts) to come back when a name server never answers */
const MAX_LOOKUPS = 16;

export type Resolve = (host: string) => Promise<string[]>;
export interface Lookup {
  resolve: Resolve;
  timeoutMs: number;
}

/**
 * One spelling per address: `FD7A:0:0::1` is `fd7a::1` and `::ffff:100.64.0.1` is `100.64.0.1`. A zone id stays, so
 * the same address on two links never compares equal.
 */
export const canonicalIp = (ip: string): string => {
  const zoneAt = ip.indexOf("%");
  const [address, zone] = zoneAt < 0 ? [ip, ""] : [ip.slice(0, zoneAt), ip.slice(zoneAt)];
  if (isIP(address) !== 6) return ip;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped === null) return canonical + zone;
  const [high, low] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)];
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}${zone}`;
};

export const systemResolve: Resolve = async (host) => (await Bun.dns.lookup(host, { backend: "system" })).map(({ address }) => address);

interface NameLookup { addresses: Promise<string[]>; listings: number; start: () => void }
interface Lookups { pending: Map<string, NameLookup>; running: number; waiting: NameLookup[] }
const lookupsOf = new WeakMap<Resolve, Lookups>();

function lookupOnce(resolve: Resolve, name: string): NameLookup {
  const state: Lookups = lookupsOf.get(resolve) ?? { pending: new Map(), running: 0, waiting: [] };
  lookupsOf.set(resolve, state);
  const known = state.pending.get(name);
  if (known !== undefined) { known.listings += 1; return known; }
  const slot = Promise.withResolvers<void>();
  const lookup: NameLookup = {
    listings: 1, start: slot.resolve,
    addresses: slot.promise.then(async () => {
      try { return await resolve(name); } catch { return []; } finally {
        if (state.pending.get(name) === lookup) state.pending.delete(name);
        const next = state.waiting.shift();
        if (next === undefined) state.running--; else next.start();
      }
    }),
  };
  state.pending.set(name, lookup);
  if (state.running < MAX_LOOKUPS) { state.running++; lookup.start(); } else state.waiting.push(lookup);
  return lookup;
}

function leave(resolve: Resolve, name: string, lookup: NameLookup): void {
  lookup.listings -= 1;
  const state = lookupsOf.get(resolve);
  if (state === undefined || lookup.listings > 0) return;
  if (state.pending.get(name) === lookup) state.pending.delete(name);
  const queued = state.waiting.indexOf(lookup);
  if (queued >= 0) state.waiting.splice(queued, 1);
}

export async function resolveWithin(names: string[], { resolve, timeoutMs }: Lookup): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((done) => { timer = setTimeout(done, timeoutMs); });
  const lookups = names.map((name) => [name, lookupOnce(resolve, name)] as const);
  await Promise.race([Promise.all(lookups.map(async ([name, { addresses }]) => {
    const answer = await addresses;
    if (answer.length > 0) found.set(name, answer.map(canonicalIp));
  })), deadline]);
  clearTimeout(timer);
  for (const [name, lookup] of lookups) leave(resolve, name, lookup);
  return new Map(found);
}
