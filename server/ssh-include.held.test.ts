import { expect, it } from "bun:test";
import { chmodSync, mkdirSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { sshCandidates } from "./ssh-candidates.ts";
import { sshDir, twoPeers } from "./ssh-candidates.fixture.ts";
import { glibcGetdents, glibcOpenAt, type Getdents, type OpenAt } from "./ssh-include-dir.ts";
import { includeTestOnly } from "./ssh-include.ts";

// a wildcard Include listed through the held folder's descriptor (getdents64) and its matches opened through it (openat), with glibc
const [getdents, openAt] = [glibcGetdents(), glibcOpenAt()];
const calls = (): { getdents: Getdents; openAt: OpenAt } => {
  if (getdents === null || openAt === null) throw new Error("glibc's getdents64/openat did not load");
  return { getdents, openAt };
};
const linux = process.platform === "linux";

async function rowsWith(stand: { getdents?: Getdents; openAt?: OpenAt | null }, dir: string, ssh = dir): Promise<(string | undefined)[][]> {
  Object.assign(includeTestOnly, stand);
  try {
    return (await sshCandidates({ sshDir: ssh, home: dir, readStatus: async () => twoPeers })).map((candidate) => [candidate.name, candidate.tailnet]);
  } finally { for (const key of ["getdents", "openAt"] as const) delete includeTestOnly[key]; }
}
const box = (files: Record<string, string>) => sshDir({ ...files, config: "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
const fromFile = [["box", "other.tail.ts.net"], ["box", "box.tail.ts.net"]];
const claimed = [["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]];
const unread = [["box", undefined], ...claimed];
const afterListing = (then: () => void): Getdents => (fd, buffer, length) => {
  const got = calls().getdents(fd, buffer, length);
  if (Number(got) === 0) then();
  return got;
};

it.skipIf(!linux)("reads what a listing matched from the folder it listed, even one swapped after the listing", async () => {
  const dir = box({ "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n" });
  mkdirSync(join(dir, "empty"));
  const folder = join(dir, "conf.d");
  expect(await rowsWith({ getdents: afterListing(() => { renameSync(folder, `${folder}.old`); symlinkSync(join(dir, "empty"), folder); }) }, dir)).toEqual(fromFile);
});

it.skipIf(!linux)("leaves an Include unread when its held folder is outside home once listed", async () => {
  const dir = box({ "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n" });
  const outside = sshDir({});
  expect(await rowsWith({ getdents: afterListing(() => renameSync(join(dir, "conf.d"), join(outside, "moved"))) }, dir)).toEqual(unread);
});

it.skipIf(!linux)("leaves an Include unread when any open of a file it listed fails", async () => {
  const fails: Record<string, (dir: string, file: string) => void> = {
    gone: () => {},
    // a link whose target runs through a file: ENOTDIR
    notDir: (dir, file) => { unlinkSync(file); symlinkSync(join(dir, "config", "sub"), file); },
    loop: (_, file) => { unlinkSync(file); symlinkSync(file, file); },
    ...(process.getuid?.() === 0 ? {} : { refused: (_: string, file: string) => { chmodSync(file, 0); } }),
  };
  for (const [kind, fail] of Object.entries(fails)) {
    const dir = box({ "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n" });
    const file = join(dir, "conf.d", "x.conf");
    fail(dir, file);
    const opening: OpenAt = (at, rest, flags) => { if (kind === "gone") unlinkSync(file); return calls().openAt(at, rest, flags); };
    expect([kind, await rowsWith({ openAt: opening }, dir)]).toEqual([kind, unread]);
  }
});

it.skipIf(!linux)("never reads a file swapped for a link out of the home folder after it was listed, just before it is opened", async () => {
  const home = sshDir({ ".ssh/conf.d/x.conf": "Host own\n", ".ssh/config": "Include conf.d/*.conf\n" });
  const outside = sshDir({ secret: "Host leaked\n" });
  const file = join(home, ".ssh", "conf.d", "x.conf");
  let swaps = 0;
  const swapping: OpenAt = (at, rest, flags) => {
    if (rest === "x.conf") { swaps++; renameSync(file, `${file}.old`); symlinkSync(join(outside, "secret"), file); }
    return calls().openAt(at, rest, flags);
  };
  expect(await rowsWith({ openAt: swapping }, home, join(home, ".ssh"))).toEqual(claimed);
  expect(swaps).toBe(1);
});

it.skipIf(!linux)("claims no PC from a listing whose matches are opened by path, without openat", async () => {
  expect(await rowsWith({ openAt: null }, box({ "conf.d/x.conf": "Host box\n  HostName 100.64.0.2\n" }))).toEqual(unread);
});
