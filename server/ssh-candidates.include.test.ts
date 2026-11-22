import { expect, it, spyOn } from "bun:test";
import { chmodSync, mkdirSync, type PathLike, renameSync, symlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { basename, join } from "node:path";

import { sshCandidates } from "./ssh-candidates.ts";
import { includeTestOnly, wildcardIncludesRead } from "./ssh-include.ts";
import { sshDir, twoPeers } from "./ssh-candidates.fixture.ts";


it.skipIf(process.platform === "win32")("reads an Include only inside the home or ssh folder, never through an absolute path, `..` or a link out of them", async () => {
  const home = sshDir({ ".ssh/config": "", "notes/hosts": "Host in-home\n" });
  const outside = sshDir({ secret: "Host leaked\n  HostName secret.example\n  User root\n" });
  symlinkSync(join(outside, "secret"), join(home, ".ssh", "link"));
  writeFileSync(join(home, ".ssh", "config"), [
    `Include ${join(outside, "secret")}`, `Include ../../${basename(outside)}/secret`, "Include link", `Include ${outside}/*`,
    "Include ~/notes/hosts", "Host own",
  ].join("\n"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => null });
  expect(candidates.map((candidate) => candidate.name)).toEqual(["in-home", "own"]);
});

it.skipIf(!wildcardIncludesRead)("follows a glob Include's link whose target stays in the home folder, as ssh -G does", async () => {
  const home = sshDir({ "dotfiles/box.conf": "Host box\n  HostName 100.64.0.2\n", ".ssh/config": "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  mkdirSync(join(home, ".ssh", "conf.d"));
  symlinkSync(join(home, "dotfiles", "box.conf"), join(home, ".ssh", "conf.d", "box.conf"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.tailnet])).toEqual([
    ["box", "100.64.0.2", "other.tail.ts.net"], ["box", "box.tail.ts.net", "box.tail.ts.net"],
  ]);
});

it.skipIf(process.platform === "win32")("claims nothing for a host a glob Include's link out of the home folder may set", async () => {
  const outside = sshDir({ "box.conf": "Host box\n  HostName 100.64.0.2\n" });
  const home = sshDir({ ".ssh/config": "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  mkdirSync(join(home, ".ssh", "conf.d"));
  symlinkSync(join(outside, "box.conf"), join(home, ".ssh", "conf.d", "box.conf"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it.skipIf(process.platform === "win32")("skips an included FIFO or oversized file without waiting on it or reading it", async () => {
  const home = sshDir({ ".ssh/big": `Host too-big\n${"#".repeat(300 * 1024)}\n`, ".ssh/small": "Host small\n", ".ssh/config": "Include pipe\nInclude big\nInclude small\n" });
  await Bun.$`mkfifo ${join(home, ".ssh", "pipe")}`;
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => null });
  expect(candidates.map((candidate) => candidate.name)).toEqual(["small"]);
});

it.skipIf(!wildcardIncludesRead)("reads at most 64 included files across every Include", async () => {
  const files: Record<string, string> = { config: "Include a/*\nInclude b/*\n" };
  for (let index = 0; index < 40; index++) {
    files[`a/${String(index).padStart(2, "0")}`] = `Host a${index}\n`;
    files[`b/${String(index).padStart(2, "0")}`] = `Host b${index}\n`;
  }
  const dir = sshDir(files);
  expect(await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => null })).toHaveLength(64);
});

it("claims nothing for a later host once a glob Include goes past the included-file budget", async () => {
  const files: Record<string, string> = { config: "Include a/*\nHost box\n  HostName 100.64.0.1\n" };
  for (let index = 0; index < 65; index++) files[`a/${String(index).padStart(2, "0")}`] = "# nothing here\n";
  const dir = sshDir(files);
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it("claims nothing for a host a glob Include past the file budget may set before the files it read", async () => {
  const files: Record<string, string> = { config: "Include a/*\n" };
  const route = "Host box\n  HostName 100.64.0.1\n  AddressFamily inet\n  ProxyCommand none\n  ProxyJump none\n  CanonicalizeHostname no\n";
  for (let index = 0; index < 65; index++) files[`a/${String(index).padStart(2, "0")}`] = route;
  const dir = sshDir(files);
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it("claims nothing for a host an Include with a token or environment variable may set, never expanding it", async () => {
  const dir = sshDir({ config: "Include ${HOME}/.ssh/conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

/**
 * Runs `swap` right after the code under test first resolves or opens `path`: the moment between a check of a path and
 * its use, where a folder or file on the way can be replaced by a link
 */
function swapAfterFirstLook(path: string, swap: () => void): () => void {
  const [realpath, open] = [fsPromises.realpath, fsPromises.open];
  let swapped = false;
  const after = <T>(value: T, looked: unknown): T => {
    if (!swapped && String(looked) === path) { swapped = true; swap(); }
    return value;
  };
  const spies = [
    spyOn(fsPromises, "realpath").mockImplementation((async (looked: PathLike) => after(await realpath(looked), looked)) as typeof realpath),
    spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof open>) => after(await open(...args), args[0])),
  ];
  return () => { for (const spy of spies) spy.mockRestore(); };
}

function homeAndOutside(files: Record<string, string>): { home: string; ssh: string; outside: string } {
  const home = sshDir({ "notes/leak": "Host leaked\n", ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`.ssh/${name}`, text])) });
  const outside = sshDir({});
  symlinkSync(join(home, "notes", "leak"), join(outside, "evil"));
  return { home, ssh: join(home, ".ssh"), outside };
}

it.skipIf(!wildcardIncludesRead)("never lists a folder a wildcard Include reaches through a link out of the home folder, and claims nothing it may set", async () => {
  const { home, ssh, outside } = homeAndOutside({ "conf.d/own/hosts": "Host own\n", config: "Include conf.d/*/*\nHost box\n  HostName 100.64.0.1\n" });
  symlinkSync(outside, join(ssh, "conf.d", "link"));
  const candidates = await sshCandidates({ sshDir: ssh, home, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([
    ["own", undefined], ["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"],
  ]);
});

it.skipIf(!wildcardIncludesRead)("never lists a folder swapped for a link out of the home folder after it was checked", async () => {
  const { home, ssh, outside } = homeAndOutside({ "conf.d/own/hosts": "Host own\n", config: "Include conf.d/*/*\n" });
  const folder = join(ssh, "conf.d", "own");
  // swapped once its parent is opened: the folder itself is opened through that parent, never looked up by path
  const restore = swapAfterFirstLook(join(ssh, "conf.d"), () => { renameSync(folder, join(ssh, "own.old")); symlinkSync(outside, folder); });
  try {
    const candidates = await sshCandidates({ sshDir: ssh, home, readStatus: async () => null });
    expect(candidates.map((candidate) => candidate.name)).toEqual([]);
  } finally { restore(); }
});

it("claims nothing for a later host once the folder entries every Include looks at pass their budget, matching or not", async () => {
  const files: Record<string, string> = { config: "Include conf.d/*.conf\nInclude conf.d/*.conf\nHost box\n  HostName 100.64.0.1\n" };
  for (let index = 0; index < 600; index++) files[`conf.d/n${String(index).padStart(3, "0")}`] = "";
  const dir = sshDir(files);
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

it.skipIf(!wildcardIncludesRead)("reads the files a wildcard matches in the order of the links' own names, not of their targets", async () => {
  const home = sshDir({ "z/hosts": "Host box\n  HostName 100.64.0.1\n", "a/hosts": "Host box\n  HostName 100.64.0.2\n", ".ssh/config": "Include conf.d/*/hosts\n" });
  mkdirSync(join(home, ".ssh", "conf.d"));
  symlinkSync(join(home, "z"), join(home, ".ssh", "conf.d", "a"));
  symlinkSync(join(home, "a"), join(home, ".ssh", "conf.d", "b"));
  const candidates = await sshCandidates({ sshDir: join(home, ".ssh"), home, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.tailnet])).toEqual([
    ["box", "100.64.0.1", "box.tail.ts.net"], ["other", "other.tail.ts.net", "other.tail.ts.net"],
  ]);
});

it.skipIf(!wildcardIncludesRead)("claims nothing for a host a glob(3) feature not matched exactly here may set, and reads an escaped name as glob(3) does", async () => {
  const classed = sshDir({ "conf.d/1.conf": "Host box\n  HostName 100.64.0.2\n", config: "Include conf.d/[[:digit:]].conf\nHost box\n  HostName 100.64.0.1\n" });
  const escaped = sshDir({ "conf.d/d/x.conf": "Host esc\n", "conf.d/a*b": "Host star\n", "conf.d/axb": "Host other-file\n", config: "Include conf.d/*/x\\.conf conf.d/a\\*b\n" });
  const fromClass = await sshCandidates({ sshDir: classed, home: classed, readStatus: async () => twoPeers });
  expect(fromClass.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
  expect((await sshCandidates({ sshDir: escaped, home: escaped, readStatus: async () => null })).map((candidate) => candidate.name)).toEqual(["esc", "star"]);
});

it("claims nothing for a host an Include of another user's home (~user) may set", async () => {
  const dir = sshDir({ config: "Include ~someone/.ssh/hosts\nHost box\n  HostName 100.64.0.1\n" });
  const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
  expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
});

const unread = [["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]];

it.skipIf(process.platform === "win32")("claims no PC for a host a folder listed by path brings, even one swapped for a link out of home after it was checked", async () => {
  const { home, ssh, outside } = homeAndOutside({ "conf.d/x.conf": "Host own\n", config: "Include conf.d/*\n" });
  writeFileSync(join(home, "notes", "leak"), "Host leaked\n  HostName 100.64.0.1\n");
  const folder = join(ssh, "conf.d");
  const realpath = fsPromises.realpath;
  let swapped = false;
  // swapped for a link out of home just after the folder's path is checked, before it is listed by that path
  const spy = spyOn(fsPromises, "realpath").mockImplementation((async (looked: PathLike) => {
    const found = await realpath(looked);
    if (!swapped && String(looked) === folder) { swapped = true; renameSync(folder, `${folder}.old`); symlinkSync(outside, folder); }
    return found;
  }) as typeof realpath);
  // listed by path, names only, as off glibc (macOS here)
  Object.assign(includeTestOnly, { getdents: null, platform: "darwin" });
  try {
    const candidates = await sshCandidates({ sshDir: ssh, home, readStatus: async () => twoPeers });
    expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["leaked", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]]);
  } finally { delete includeTestOnly.getdents; delete includeTestOnly.platform; spy.mockRestore(); }
});

async function rowsOf(files: Record<string, string>): Promise<(string | undefined)[][]> {
  const dir = sshDir(files);
  return (await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers })).map((candidate) => [candidate.name, candidate.tailnet]);
}
const unclaimed = [["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]];

it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("claims nothing for a host an included file it cannot open may set", async () => {
  const dir = sshDir({ "locked.conf": "Host box\n  HostName 100.64.0.2\n", config: "Include locked.conf\nHost box\n  HostName 100.64.0.1\n" });
  chmodSync(join(dir, "locked.conf"), 0);
  expect((await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers })).map((candidate) => [candidate.name, candidate.tailnet])).toEqual(unread);
});

it.skipIf(!wildcardIncludesRead)("reads `..` after a wildcard only through the folders it matched, as glob(3) does", async () => {
  expect(await rowsOf({ "conf.d/hosts": "Host box\n  HostName 100.64.0.2\n", config: "Include conf.d/*/../hosts\nHost box\n  HostName 100.64.0.1\n" })).toEqual(unclaimed);
});

it.skipIf(!wildcardIncludesRead)("matches only folders with a wildcard Include's trailing slash", async () => {
  expect(await rowsOf({ "conf.d/file": "Host box\n  HostName 100.64.0.2\n", config: "Include conf.d/*/\nHost box\n  HostName 100.64.0.1\n" })).toEqual(unclaimed);
});

it.skipIf(!wildcardIncludesRead)("reads the files a wildcard matches in the order of their names' bytes, as glob(3) in the C locale", async () => {
  const files = { "conf.d/\uE000.conf": "Host box\n  HostName 100.64.0.1\n", "conf.d/\u{10000}.conf": "Host box\n  HostName 100.64.0.2\n", config: "Include conf.d/*\n" };
  expect(await rowsOf(files)).toEqual(unclaimed);
});

it("reads a wildcard Include by path where getdents64 is not available, and claims no PC for the hosts it brings", async () => {
  const dir = sshDir({ "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n", config: "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  // listed by path, names only, as off glibc (macOS here)
  Object.assign(includeTestOnly, { getdents: null, platform: "darwin" });
  try {
    const candidates = await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers });
    expect(candidates.map((candidate) => [candidate.name, candidate.detail, candidate.tailnet])).toEqual([
      ["box", "100.64.0.2", undefined], ["box", "box.tail.ts.net", "box.tail.ts.net"], ["other", "other.tail.ts.net", "other.tail.ts.net"],
    ]);
  } finally { delete includeTestOnly.getdents; delete includeTestOnly.platform; }
});

it("lists a host only a wildcard Include names where getdents64 is not available, without claiming the PC its HostName reaches", async () => {
  // listed by path, names only, as off glibc (macOS here)
  Object.assign(includeTestOnly, { getdents: null, platform: "darwin" });
  try {
    expect(await rowsOf({ "config.d/lab.conf": "Host lab\n  HostName 100.64.0.2\n", config: "Include config.d/*\n" })).toEqual([
      ["lab", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"],
    ]);
  } finally { delete includeTestOnly.getdents; delete includeTestOnly.platform; }
});

it("claims no PC for a host whose options a wildcard Include listed by path sets, even one its own Host lines do not name", async () => {
  // listed by path, names only, as off glibc (macOS here)
  Object.assign(includeTestOnly, { getdents: null, platform: "darwin" });
  try {
    expect(await rowsOf({ "conf.d/x.conf": "Host *\n  HostName 100.64.0.1\n", config: "Include conf.d/*\nHost lab\n" })).toEqual([
      ["lab", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"],
    ]);
  } finally { delete includeTestOnly.getdents; delete includeTestOnly.platform; }
});

it("claims no PC for a host after a wildcard Include listed by path, whether the listing found files or none", async () => {
  const after = "Host lab\n  HostName 100.64.0.1\n";
  const empty = sshDir({ config: `Include conf.d/*\n${after}` });
  mkdirSync(join(empty, "conf.d"));
  // listed by path, names only, as off glibc (macOS here)
  Object.assign(includeTestOnly, { getdents: null, platform: "darwin" });
  try {
    expect(await rowsOf({ "conf.d/a.conf": "Host listed\n", config: `Include conf.d/*\n${after}` })).toEqual([["listed", undefined], ["lab", undefined], ...unclaimed]);
    const rows = await sshCandidates({ sshDir: empty, home: empty, readStatus: async () => twoPeers });
    expect(rows.map((candidate) => [candidate.name, candidate.tailnet])).toEqual([["lab", undefined], ...unclaimed]);
  } finally { delete includeTestOnly.getdents; delete includeTestOnly.platform; }
});

it.skipIf(process.platform === "win32")("never reads a literally named Include file swapped for a link out of home after it was opened, where the opened file is checked by its path", async () => {
  const { home, ssh, outside } = homeAndOutside({ "conf.d/x.conf": "Host own\n", config: "Include conf.d/x.conf\nHost box\n  HostName 100.64.0.1\n" });
  writeFileSync(join(outside, "secret"), "Host leaked\n");
  const file = join(ssh, "conf.d", "x.conf");
  const restore = swapAfterFirstLook(file, () => { renameSync(file, `${file}.old`); symlinkSync(join(outside, "secret"), file); });
  includeTestOnly.platform = "darwin";
  try {
    const candidates = await sshCandidates({ sshDir: ssh, home, readStatus: async () => twoPeers });
    expect(candidates.map((candidate) => [candidate.name, candidate.tailnet])).toEqual(unread);
  } finally { delete includeTestOnly.platform; restore(); }
});

it.skipIf(!wildcardIncludesRead)("leaves a wildcard Include unread when a folder entry's name is not UTF-8", async () => {
  const dir = sshDir({ config: "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  mkdirSync(join(dir, "conf.d"));
  writeFileSync(Buffer.concat([Buffer.from(`${join(dir, "conf.d")}/`), Buffer.from([0xff, 0x2e, 0x63])]), "Host box\n  HostName 100.64.0.2\n");
  expect((await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers })).map((candidate) => [candidate.name, candidate.tailnet])).toEqual(unread);
});
