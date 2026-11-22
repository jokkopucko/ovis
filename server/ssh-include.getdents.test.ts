import { expect, it } from "bun:test";

import { sshCandidates } from "./ssh-candidates.ts";
import { sshDir, twoPeers } from "./ssh-candidates.fixture.ts";
import { includeTestOnly } from "./ssh-include.ts";

async function withGetdents(getdents: typeof includeTestOnly.getdents, files: Record<string, string>): Promise<(string | undefined)[][]> {
  const dir = sshDir({ ...files, config: "Include conf.d/*\nHost box\n  HostName 100.64.0.1\n" });
  includeTestOnly.getdents = getdents;
  try {
    return (await sshCandidates({ sshDir: dir, home: dir, readStatus: async () => twoPeers })).map((candidate) => [candidate.name, candidate.tailnet]);
  } finally { delete includeTestOnly.getdents; }
}
const unread = [["box", undefined], ["box", "box.tail.ts.net"], ["other", "other.tail.ts.net"]];

const answering = (chunks: (Buffer | number)[]) => (_fd: number, buffer: Buffer): number => {
  const chunk = chunks.shift() ?? 0;
  if (typeof chunk === "number") return chunk;
  chunk.copy(buffer);
  return chunk.length;
};
/** one linux_dirent64 record naming `name`: its d_reclen says `reclen`, its bytes are `bytes` long */
const record = (name: string, reclen: number, bytes = Math.max(reclen, 20 + name.length)): Buffer => {
  const written = Buffer.alloc(bytes);
  written.writeUInt16LE(reclen, 16);
  written.write(name, 19);
  return written;
};

it.skipIf(process.platform === "win32")("leaves a getdents64 answer it cannot trust unread, never a listing", async () => {
  const files = { "conf.d/x.conf": "Host listed\n" };
  for (const chunks of [[record("x.conf", 200, 26)], [record("x.conf", 0, 32)], [record("x.conf", 24)], [32 * 1024 + 8]]) {
    expect(await withGetdents(answering(chunks), files)).toEqual(unread);
  }
});

it.skipIf(process.platform === "win32")("leaves an Include unread when getdents64 fails, never as an empty folder", async () => {
  expect(await withGetdents(answering([-1]), { "conf.d/x.conf": "Host listed\n" })).toEqual(unread);
});

it.skipIf(process.platform === "win32")("counts every record getdents64 answers, `.` and `..` too, against the folder-entry budget", async () => {
  const records = [".", "..", // dot-names, which `*` never matches, so only the entry budget can cut the listing
    ...Array.from({ length: 1023 }, (_, index) => `.n${String(index).padStart(4, "0")}`)].map((name) => record(name, 32));
  expect(await withGetdents(answering([Buffer.concat(records.slice(0, 1000)), Buffer.concat(records.slice(1000))]), { "conf.d/x.conf": "" })).toEqual(unread);
});
