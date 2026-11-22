import { expect, it } from "bun:test";
import { join } from "node:path";

import { sshCandidates } from "./ssh-candidates.ts";
import { wildcardIncludesRead } from "./ssh-include.ts";
import { resolver, sshDir, twoPeers } from "./ssh-candidates.fixture.ts";

const status = (peers: string[]): string => JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "self.tail.ts.net.", UserID: 1 },
  Peer: Object.fromEntries(peers.map((name, index) => [`k${index}`, { DNSName: `${name}.tail.ts.net.`, UserID: 1, Online: true, OS: "linux", TailscaleIPs: [`100.64.1.${index + 1}`] }])),
});

/** answers each named peer's name and MagicDNS name with its address in `status(peers)`, as MagicDNS does */
const magicDns = (peers: string[]) => async (host: string): Promise<string[]> => {
  const index = peers.findIndex((name) => host === name || host === `${name}.tail.ts.net`);
  return index < 0 ? [] : [`100.64.1.${index + 1}`];
};

it("starts each file one Include names in the Host block of the Include", async () => {
  const dir = sshDir({ config: "Host lab\n  Include a b\n", a: "Host other\n  User bob\n", b: "User alice\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => null });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail])).toEqual([["lab", "alice@lab"]]);
});

it("lists a host an included file names only when the block of its Include applies to that host", async () => {
  const dir = sshDir({ config: "Host a\n  Include inc\nMatch all\n  Include all.conf\nMatch originalhost x\n  Include x.conf\n", inc: "Host b\n", "all.conf": "Host c\n", "x.conf": "Host d\n" });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => null });
  expect(candidates.map((candidate) => candidate.name)).toEqual(["a", "c"]);
});

it("lists the hosts an Include under a condition it cannot weigh offline names, claiming no PC for them", async () => {
  const dir = sshDir({ config: "Match exec \"true\"\n  Include inc\nHost after\n", inc: "Host box\n" });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers, resolve: resolver({ box: ["100.64.0.1"] }) });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["box", undefined], ["after", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"],
  ]);
});

it("claims nothing for a host an Include out of reach may set", async () => {
  const outside = sshDir({ hosts: "Host box\n  ProxyJump bastion\n" });
  const dir = sshDir({ config: `Include ${join(outside, "hosts")}\nHost box\n  HostName 100.64.0.1\n` });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it("spends no weighing on hosts an Include's own block rules out, so a later host is still listed", async () => {
  const dir = sshDir({ config: "Host a\n  Include inc\nHost useful\n", inc: Array.from({ length: 500 }, (_, index) => `Host x${index}`).join("\n") });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => null });
  expect(candidates.map((candidate) => candidate.name)).toEqual(["a", "useful"]);
});

it("claims nothing for a host a Match condition it cannot weigh offline may send elsewhere", async () => {
  const dir = sshDir({ config: [
    "Host box far fin", "Match originalhost box exec \"on-vpn\"", "  HostName 100.64.0.2",
    "Match final originalhost nomatch", "  HostName 100.64.0.2", "Host *", "  HostName 100.64.0.1",
  ].join("\n") });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolve: async () => [] });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["box", undefined], ["far", "box.tail.ts.net"], ["fin", "box.tail.ts.net"], ["other", "other.tail.ts.net"],
  ]);
});

it("reads an Include inside a Host block as part of that block", async () => {
  const dir = sshDir({ config: "Host lab\n  Include lab.conf\nHost after\n", "lab.conf": "HostName lab-pc.tail.ts.net\nUser alice\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["lab-pc"]), resolve: magicDns(["lab-pc"]) });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.source])).toEqual([
    ["lab", "alice@lab-pc.tail.ts.net", "ssh_config"], ["after", null, "ssh_config"],
  ]);
});

it.skipIf(!wildcardIncludesRead)("reads the hosts of the files an Include names, in their place", async () => {
  const dir = sshDir({
    config: "Host first\n  HostName one.example\nHost *\nInclude conf.d/*\nHost last\n",
    "conf.d/b": "Host from-b\n",
    "conf.d/a": "Host from-a\n  User a\n",
  });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => null });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail])).toEqual([
    ["first", "one.example"], ["from-a", "a@from-a"], ["from-b", null], ["last", null],
  ]);
  expect(candidates.every((candidate) => candidate.source === "ssh_config" && candidate.destination === candidate.name)).toBe(true);
});

it("lists 200 PCs at most, keeping a row for every Tailscale PC before config hosts fill the rest", async () => {
  const dir = sshDir({ config: Array.from({ length: 200 }, (_, index) => `Host h${index}`).join("\n") });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["extra"]), resolve: async () => [] });
  expect(candidates.map((candidate) => candidate.name)).toEqual([...Array.from({ length: 199 }, (_, index) => `h${index}`), "extra"]);
  expect(candidates.at(-1)?.source).toBe("tailscale");
});

it("keeps a row for the first 32 Tailscale PCs only, as the tailnet list asks no more", async () => {
  const peers = Array.from({ length: 40 }, (_, index) => `pc${index}`);
  const dir = sshDir({ config: Array.from({ length: 200 }, (_, index) => `Host h${index}`).join("\n") });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(peers), resolve: async () => [] });
  expect(candidates.map((candidate) => candidate.name)).toEqual([...Array.from({ length: 168 }, (_, index) => `h${index}`), ...peers.slice(0, 32)]);
});

it("keeps the Tailscale row of a PC whose many config hosts a skipped Include leaves undetermined", async () => {
  const boxes = Array.from({ length: 200 }, (_, index) => `Host box${index}\n  HostName 100.64.0.1`);
  const lab = ["Host lab", "  HostName 100.64.0.2", "  AddressFamily inet", "  ProxyCommand none", "  ProxyJump none", "  CanonicalizeHostname no"];
  const dir = sshDir({ config: [...lab, "Host *", "  Include %d/hosts", ...boxes].join("\n") });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers, resolve: async () => [] });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["lab", "other.tail.ts.net"], ...Array.from({ length: 198 }, (_, index) => [`box${index}`, undefined]), ["box", "box.tail.ts.net"],
  ]);
});

it("adds the Tailscale PCs no config host already names, and names the Tailscale PC a config host is", async () => {
  const dir = sshDir({ config: "Host lab\n  HostName lab-pc.tail.ts.net\nHost eamac\nHost build\n  HostName build.example\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => status(["lab-pc", "eamac", "winvm"]), resolve: magicDns(["lab-pc", "eamac", "winvm"]) });
  expect(candidates).toEqual([
    { name: "lab", destination: "lab", detail: "lab-pc.tail.ts.net", source: "ssh_config", tailnet: "lab-pc.tail.ts.net" },
    { name: "eamac", destination: "eamac", detail: null, source: "ssh_config", tailnet: "eamac.tail.ts.net" },
    { name: "build", destination: "build", detail: "build.example", source: "ssh_config" },
    { name: "winvm", destination: "winvm.tail.ts.net", detail: "winvm.tail.ts.net", source: "tailscale", tailnet: "winvm.tail.ts.net" },
  ]);
});

it("takes a config host's HostName over its alias: a stale alias naming one Tailscale PC while it reaches another claims the one it reaches", async () => {
  const dir = sshDir({ config: "Host home-server\n  HostName 100.123.228.51\n" });
  const tailnet = JSON.stringify({
    BackendState: "Running",
    Self: { DNSName: "home-window.tail.ts.net.", UserID: 1 },
    Peer: {
      a: { DNSName: "home-server.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.106.153.26", "fd7a:115c:a1e0::bc30:991b"] },
      b: { DNSName: "old-desktop.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.123.228.51"] },
    },
  });
  expect(await sshCandidates({ sshDir: dir, readStatus: async () => tailnet })).toEqual([
    { name: "home-server", destination: "home-server", detail: "100.123.228.51", source: "ssh_config", tailnet: "old-desktop.tail.ts.net" },
    { name: "home-server", destination: "home-server.tail.ts.net", detail: "home-server.tail.ts.net", source: "tailscale", tailnet: "home-server.tail.ts.net" },
  ]);
});

it("claims the Tailscale PC a config host's name resolves to, not the one it is spelled like", async () => {
  const dir = sshDir({ config: "Host box\nHost lab\n  HostName lab.lan\nHost far\n  HostName far.lan\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers,
    resolve: resolver({ box: ["100.64.0.2"], "lab.lan": ["fd7a:115c:a1e0:0:0:0:0:2"], "far.lan": ["192.168.1.9"] }) });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["box", "other.tail.ts.net"], ["lab", "other.tail.ts.net"], ["far", undefined], ["box", "box.tail.ts.net"],
  ]);
});

it("matches an equivalent spelling of a Tailscale address without looking it up, and never across zone ids", async () => {
  const dir = sshDir({ config: "Host six\n  HostName FD7A:115C:A1E0:0:0:0:0:2\nHost mapped\n  HostName ::ffff:100.64.0.1\nHost zoned\n  HostName fe80::1%eth0\n" });
  const tailnet = JSON.stringify({ BackendState: "Running", Self: { DNSName: "self.tail.ts.net.", UserID: 1 }, Peer: {
    a: { DNSName: "box.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["100.64.0.1"] },
    b: { DNSName: "other.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["fd7a:115c:a1e0::2"] },
    c: { DNSName: "link.tail.ts.net.", UserID: 1, Online: true, OS: "linux", TailscaleIPs: ["fe80::1%eth1"] },
  } });
  const looked: string[] = [];
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => tailnet, resolve: async (host) => { looked.push(host); return []; } });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["six", "other.tail.ts.net"], ["mapped", "box.tail.ts.net"], ["zoned", undefined], ["link", "link.tail.ts.net"],
  ]);
  expect(looked).toEqual([]);
});

it("claims a PC only when every address a name resolves to is that PC's, whatever the order of answers or PCs", async () => {
  const dir = sshDir({ config: "Host mixed\nHost swapped\nHost half\nHost both\n" });
  const resolve = resolver({ mixed: ["100.64.0.1", "100.64.0.2"], swapped: ["100.64.0.2", "100.64.0.1"], half: ["100.64.0.2", "192.168.1.9"], both: ["fd7a:115c:a1e0::2", "100.64.0.2"] });
  const reversed = JSON.stringify({ ...JSON.parse(twoPeers), Peer: { b: JSON.parse(twoPeers).Peer.b, a: JSON.parse(twoPeers).Peer.a } });
  for (const tailnet of [twoPeers, reversed]) {
    const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => tailnet, resolve });
    expect(candidates.filter((candidate) => candidate.source === "ssh_config").map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
      ["mixed", undefined], ["swapped", undefined], ["half", undefined], ["both", "other.tail.ts.net"],
    ]);
    expect(candidates.filter((candidate) => candidate.source === "tailscale").map((candidate) => candidate.name)).toEqual(["box"]);
  }
});

it("looks up a HostName as written, an absolute one with its trailing dot", async () => {
  const dir = sshDir({ config: "Host abs\n  HostName box.example.\n" });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolve: resolver({ "box.example.": ["100.64.0.2"], "box.example": ["100.64.0.1"] }) });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["abs", "other.tail.ts.net"], ["box", "box.tail.ts.net"]]);
});

it("applies the directives an Include brings into a Host block only to the hosts that block matches", async () => {
  const dir = sshDir({
    config: "Host a\n  HostName 192.0.2.1\nHost a\n  Include inc\nHost b\n  HostName 192.0.2.2\nHost c\n  Include inc\n",
    inc: "Host *\n  HostName 100.64.0.1\n",
  });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers, resolve: async () => [] });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.tailnet])).toEqual([
    ["a", "192.0.2.1", undefined], ["b", "192.0.2.2", undefined], ["c", "100.64.0.1", "box.tail.ts.net"], ["other", "other.tail.ts.net", "other.tail.ts.net"],
  ]);
});

it("keeps only the answers of the AddressFamily ssh would use", async () => {
  const dir = sshDir({ config: [
    "Host four", "  HostName four.lan", "  AddressFamily inet", "Host six", "  HostName six.lan", "  AddressFamily inet6",
    "Host mixed", "  HostName mixed.lan", "  AddressFamily inet", "Host any4", "  HostName any4.lan", "Host *", "  AddressFamily inet",
  ].join("\n") });
  const resolve = resolver({ "four.lan": ["100.64.0.1", "fd00::9"], "six.lan": ["192.168.1.9", "fd7a:115c:a1e0::2"], "mixed.lan": ["192.168.1.9", "fd7a:115c:a1e0::2"], "any4.lan": ["fd00::9", "100.64.0.1"] });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolve });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["four", "box.tail.ts.net"], ["six", "other.tail.ts.net"], ["mixed", undefined], ["any4", "box.tail.ts.net"],
  ]);
});

it("never claims a proxied host, by the addresses a local lookup gives or by its name", async () => {
  const dir = sshDir({ config: [
    "Host jump", "  ProxyJump bastion", "Host cmd", "  HostName cmd.lan", "  ProxyCommand ssh -W %h:%p bastion",
    "Host other", "  ProxyJump bastion", "Host direct", "  HostName direct.lan", "  ProxyJump none",
  ].join("\n") });
  const looked: string[] = [];
  const answers = resolver({ jump: ["100.64.0.2"], "cmd.lan": ["100.64.0.2"], other: ["100.64.0.1"], "direct.lan": ["100.64.0.1"] });
  const candidates = await sshCandidates({ sshDir: dir, readStatus: async () => twoPeers, resolve: async (host) => { looked.push(host); return answers(host); } });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["jump", undefined], ["cmd", undefined], ["other", undefined], ["direct", "box.tail.ts.net"], ["other", "other.tail.ts.net"],
  ]);
  expect(looked).toEqual(["direct.lan"]);
});

it("lists only the other source when one is missing", async () => {
  const empty = sshDir({});
  expect(await sshCandidates({ sshDir: empty, readStatus: async () => null })).toEqual([]);
  expect((await sshCandidates({ sshDir: empty, readStatus: async () => status(["box"]) })).map((candidate) => candidate.destination)).toEqual(["box.tail.ts.net"]);
});
