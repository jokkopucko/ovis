import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from "bun:test";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { forgetTranscriptState, pictureIndexForTests, transcriptImage, transcriptImageAsync, transcriptPage } from "./conversation.ts";
import { TranscriptReader, transcriptReader } from "./transcript-reader.ts";

let leases: { mockRestore(): void } | undefined;
beforeEach(() => {
  const reader = new TranscriptReader({
    open: async (path) => {
      const fd = fs.openSync(path, "r");
      return {
        stat: async () => fs.fstatSync(fd),
        read: async (buffer, offset, length, position) => ({ bytesRead: fs.readSync(fd, buffer, offset, length, position) }),
        close: async () => fs.closeSync(fd),
      };
    },
    stat: async (path, follow) => follow ? fs.statSync(path) : fs.lstatSync(path),
  });
  leases = spyOn(transcriptReader, "read").mockImplementation(reader.read.bind(reader) as typeof transcriptReader.read);
});

const roots: string[] = [];
afterEach(() => {
  leases?.mockRestore();
  setSystemTime();
  forgetTranscriptState();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const picture = { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } };
const line = (entry: unknown) => JSON.stringify(entry) + "\n";
function fixture(tiny = false) {
  const dir = mkdtempSync(join(tmpdir(), "ovis-claude-image-"));
  roots.push(dir);
  const path = join(dir, "session.jsonl");
  const call = line({ type: "assistant", uuid: id(2), parentUuid: id(1), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
  const result = line({ type: "user", uuid: id(3), parentUuid: id(2), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture, picture] }] } });
  const padding = tiny
    ? line({ type: "progress", data: "read", uuid: id(3) }).repeat(6000)
    : line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(20);
  writeFileSync(path, line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "read" } }) + call + padding + result);
  return { path, ref: `${id(3)}:0:0` };
}
async function asMain(path: string, ref: string) {
  pictureIndexForTests(false);
  try { return await transcriptImageAsync(path, ref); } finally { pictureIndexForTests(true); }
}
function exact(image: Awaited<ReturnType<typeof transcriptImageAsync>>) {
  expect(image?.mediaType).toBe("image/png");
  expect(Buffer.from(image!.bytes).equals(png)).toBe(true);
  expect(image!.bytes.byteLength).toBe(png.length);
}

function holdTimes(path: string, mtimeMs: number, ctimeMs: number): () => void {
  const times = { mtimeMs, ctimeMs, mtime: new Date(mtimeMs), ctime: new Date(ctimeMs) };
  const [fstat, stat] = [fs.fstatSync, fs.statSync];
  const watches = [
    spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => Object.assign(fstat(...args), times)) as typeof fs.fstatSync),
    spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => { const value = stat(...args); return value && "mtimeMs" in value && args[0] === path ? Object.assign(value, times) : value; }) as typeof fs.statSync),
  ];
  return () => { for (const watch of watches) watch.mockRestore(); };
}

describe("cooperative Claude images", () => {
  for (const tiny of [false, true]) it(`runs timers and file IO before cold and warm lookups finish (${tiny ? "tiny records" : "large history"})`, async () => {
    const { path, ref } = fixture(tiny);
    for (let pass = 0; pass < 2; pass += 1) {
      let finished = false;
      const progress = new Promise<void>((resolve, reject) => setTimeout(() => {
        if (finished) { reject(new Error("image lookup blocked the timer")); return; }
        Bun.file(path).slice(0, 16).arrayBuffer().then(() => {
          try { expect(finished).toBe(false); resolve(); } catch (error) { reject(error); }
        }, reject);
      }, 0));
      const reading = Promise.all([transcriptImageAsync(path, ref), transcriptImageAsync(path, `${id(3)}:0:1`)]).then((images) => { finished = true; return images; });
      const [images] = await Promise.all([reading, progress]);
      images.forEach(exact);
    }
  });

  it("serves exactly 8 MiB and rejects an image one byte larger", async () => {
    const { path } = fixture(true);
    const bytes = Buffer.alloc(8 * 1024 * 1024);
    png.copy(bytes);
    const image = (data: Buffer) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: data.toString("base64") } });
    writeFileSync(path, line({ type: "user", uuid: id(3), message: { content: [image(bytes), image(Buffer.concat([bytes, Buffer.from([0])]))] } }));
    const accepted = await transcriptImageAsync(path, `${id(3)}:0`);
    expect(accepted?.mediaType).toBe("image/png");
    expect(Buffer.from(accepted!.bytes).equals(bytes)).toBe(true);
    expect(await transcriptImageAsync(path, `${id(3)}:1`)).toBeNull();
  });

  it("serves through the shared reader's own file access, warm and cold", async () => {
    leases?.mockRestore();
    leases = undefined;
    const { path, ref } = fixture();
    exact(await transcriptImageAsync(path, ref));
    exact(await transcriptImageAsync(path, ref));
    expect(await transcriptImageAsync(path, `${id(3)}:0:2`)).toBeNull();
    appendFileSync(path, line({ type: "progress", data: "the session goes on" }));
    exact(await transcriptImageAsync(path, ref));
  });

  it("serves a record read over several windows, whose shape keeps bytes of its first window", async () => {
    const { path } = fixture(true);
    // the record's head (its type and uuid, then the start of a long text) is kept from the first
    // window, read in the lease's own buffer; the next windows are read into that same buffer, so
    // a shape that held on to the first window instead of copying it would no longer parse
    const text = "y".repeat(2.5 * 1024 * 1024);
    writeFileSync(path, line({ type: "user", uuid: id(7), message: { content: [{ type: "text", text }, picture] } }));
    let reads = 0;
    const read = fs.readSync;
    const counting = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      reads += 1;
      return read(...args);
    }) as typeof fs.readSync);
    try {
      exact(await transcriptImageAsync(path, `${id(7)}:1`));
      exact(await transcriptImageAsync(path, `${id(7)}:1`));
    } finally { counting.mockRestore(); }
    expect(reads).toBeGreaterThan(6);
    expect(await transcriptImageAsync(path, `${id(7)}:0`)).toBeNull();
  });

  it("bounds record judgments between event-loop turns even with a warm boundary", async () => {
    const { path, ref } = fixture(true);
    exact(await transcriptImageAsync(path, ref));
    let since = 0, most = 0, total = 0;
    const parse = JSON.parse;
    const counting = spyOn(JSON, "parse").mockImplementation(((...args: Parameters<typeof JSON.parse>) => {
      since += 1; total += 1;
      return parse(...args);
    }) as typeof JSON.parse);
    let looking = true;
    const turn = () => { most = Math.max(most, since); since = 0; if (looking) setImmediate(turn); };
    try {
      setImmediate(turn);
      exact(await transcriptImageAsync(path, ref));
    } finally { looking = false; most = Math.max(most, since); counting.mockRestore(); }
    expect(total).toBeGreaterThan(6000);
    expect(most).toBeLessThanOrEqual(100);
  });

  it("bounds record judgments between event-loop turns on a cold boundary scan", async () => {
    const { path, ref } = fixture(true);
    let since = 0, most = 0, total = 0;
    const parse = JSON.parse;
    const counting = spyOn(JSON, "parse").mockImplementation(((...args: Parameters<typeof JSON.parse>) => {
      since += 1; total += 1;
      return parse(...args);
    }) as typeof JSON.parse);
    let looking = true;
    const turn = () => { most = Math.max(most, since); since = 0; if (looking) setImmediate(turn); };
    try {
      setImmediate(turn);
      exact(await transcriptImageAsync(path, ref));
    } finally { looking = false; most = Math.max(most, since); counting.mockRestore(); }
    expect(total).toBeGreaterThan(12000);
    expect(most).toBeLessThanOrEqual(100);
  });

  it("yields while constructing a search for a long decoded tool call id", async () => {
    const { path, ref } = fixture(true);
    const call = "c".repeat(100_000);
    writeFileSync(path, line({ type: "assistant", message: { content: [{ type: "tool_use", id: call, name: "Read" }] } }) + line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: call, content: [picture] }] } }));
    let finished = false;
    const progress = new Promise<void>((resolve, reject) => setTimeout(() => {
      try { expect(finished).toBe(false); resolve(); } catch (error) { reject(error); }
    }, 0));
    // Some engines refuse a regexp this large; either outcome must let other work run first.
    const reading = transcriptImageAsync(path, ref).then(() => { finished = true; });
    await Promise.all([reading, progress]);
  });

  it("rejects a second mutation after validation has already hashed the changed prefix", async () => {
    const { path, ref } = fixture();
    const original = await Bun.file(path).bytes();
    const record = Buffer.from(original).lastIndexOf(`{"type":"user","uuid":"${id(3)}"`);
    let records = 0;
    let changed = false;
    const read = fs.readSync;
    const watching = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = read(...args);
      const request = args as unknown as [number, Uint8Array, number, number, number];
      if (request[4] === record && ++records === 2) {
        const bytes = Buffer.from(original);
        bytes.write("gone", bytes.indexOf('"id":"read"') + 6);
        writeFileSync(path, bytes);
        appendFileSync(path, line({ type: "progress", data: "second append" }));
        changed = true;
      }
      return result;
    }) as typeof fs.readSync);
    try {
      const reading = transcriptImageAsync(path, ref);
      await new Promise<void>((resolve) => setImmediate(resolve));
      appendFileSync(path, line({ type: "progress", data: "first append" }));
      expect(await reading).toBeNull();
      expect(changed).toBe(true);
    } finally { watching.mockRestore(); }
  });

  // "replace" renames a file over the open transcript, which needs POSIX rename-over-an-open-file semantics
  for (const change of ["replace", "truncate", "rewrite", "rewrite and grow", "clear", "rewind"] as const) it.skipIf(change === "replace" && process.platform === "win32")(`rejects an image after an in-flight ${change}`, async () => {
    const { path, ref } = fixture();
    const apply = () => {
      if (change === "replace") { writeFileSync(`${path}.new`, line({ type: "user", uuid: id(3), message: { content: [picture] } })); renameSync(`${path}.new`, path); }
      if (change === "truncate") truncateSync(path, 0);
      if (change === "rewrite" || change === "rewrite and grow") {
        const bytes = fs.readFileSync(path);
        bytes[bytes.indexOf('"read"') + 1] = 120;
        writeFileSync(path, bytes);
        if (change === "rewrite and grow") appendFileSync(path, line({ type: "progress", data: "appended" }));
      }
      if (change === "clear") appendFileSync(path, line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }));
      if (change === "rewind") appendFileSync(path, line({ type: "user", uuid: id(4), parentUuid: null, message: { content: "new branch" } }));
    };
    let applied = false;
    const read = fs.readSync;
    const watching = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = read(...args);
      if (!applied) { applied = true; apply(); }
      return result;
    }) as typeof fs.readSync);
    try {
      expect(await transcriptImageAsync(path, ref)).toBeNull();
      expect(applied).toBe(true);
    } finally { watching.mockRestore(); }
    if (change === "rewrite" || change === "rewrite and grow") {
      exact(await transcriptImageAsync(path, ref));
      exact(transcriptImage(path, ref));
    } else {
      expect(await transcriptImageAsync(path, ref)).toBeNull();
      expect(transcriptImage(path, ref)).toBeNull();
    }
  });

  it("allows a harmless append and concurrent page/image reads without downgrading the boundary cache", async () => {
    const { path, ref } = fixture();
    const reading = transcriptImageAsync(path, ref);
    await new Promise<void>((resolve) => setImmediate(resolve));
    appendFileSync(path, line({ type: "assistant", uuid: id(4), parentUuid: id(3), message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } }));
    transcriptPage("claude-transcript", path);
    exact(await transcriptImageAsync(path, ref));
    exact(await reading);
    exact(await transcriptImageAsync(path, ref));
    appendFileSync(path, line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }));
    expect(await transcriptImageAsync(path, ref)).toBeNull();
  });
});

it("a lookup rejected after an in-place rewrite and growth leaves no stale boundary behind for the next lookup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-stale-boundary-"));
  roots.push(dir);
  const path = join(dir, "log.jsonl");
  const uuid = "00000000-0000-4000-8000-000000000001";
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  const picture = JSON.stringify({ type: "user", uuid, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] } }) + "\n";
  const clear = JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }) + "\n";
  const same = JSON.stringify({ type: "progress", data: "x".repeat(clear.length - 30) }) + "\n";
  expect(same.length).toBe(clear.length);
  const padding = JSON.stringify({ type: "progress", data: "x".repeat(1024 * 1024) }) + "\n";
  writeFileSync(path, picture + same + padding.repeat(3));
  let scanned = false;
  let changed = false;
  const read = fs.readSync;
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const result = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (at[4] === 0 && !scanned) scanned = true;
    else if (at[4] === 0 && scanned && !changed) {
      writeFileSync(path, picture + clear + padding.repeat(3));
      appendFileSync(path, JSON.stringify({ type: "progress", data: "append" }) + "\n");
      changed = true;
    }
    return result;
  }) as typeof fs.readSync);
  try {
    expect(await transcriptImageAsync(path, `${uuid}:0`)).toBeNull();
    expect(changed).toBe(true);
  } finally { watch.mockRestore(); }
  // the picture is now before a /clear: the next lookup must not reuse the rejected scan's boundary
  expect(await transcriptImageAsync(path, `${uuid}:0`)).toBeNull();
});

it("never serves a picture read from a rewrite the file undid before an append (ABA)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-aba-"));
  roots.push(dir);
  const path = join(dir, "session.jsonl");
  const other = Buffer.from(png);
  other[40] = other[40]! ^ 1;
  const result = (bytes: Buffer) => line({ type: "user", uuid: id(3), parentUuid: id(2), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [{ ...picture, source: { ...picture.source, data: bytes.toString("base64") } }] }] } });
  const before = line({ type: "progress", data: "before" });
  const head = before + line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } })
    + line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "read" } })
    + line({ type: "assistant", uuid: id(2), parentUuid: id(1), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } })
    + line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(20);
  const original = head + result(png);
  const rewritten = head + result(other);
  expect(rewritten.length).toBe(original.length);
  writeFileSync(path, original);
  const floor = Buffer.byteLength(before);
  const record = Buffer.byteLength(head);
  let step = 0;
  const read = fs.readSync;
  const size = Buffer.byteLength(original);
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (step === 0 && at[4] > floor && at[4] + at[3] === size) { step = 1; writeFileSync(path, rewritten); step = 2; }
    else if (step === 2 && at[4] === record) { step = 3; writeFileSync(path, original); appendFileSync(path, line({ type: "progress", data: "append" })); step = 4; }
    return value;
  }) as typeof fs.readSync);
  let image: Awaited<ReturnType<typeof transcriptImageAsync>>;
  try { image = await transcriptImageAsync(path, `${id(3)}:0:0`); } finally { watch.mockRestore(); }
  expect(step).toBe(4);
  // the file holds the first picture: the other one must not be served, whether this read serves or not
  expect(image === null || Buffer.from(image.bytes).equals(png)).toBe(true);
  exact(await transcriptImageAsync(path, `${id(3)}:0:0`));
});

it("a lookup with a warm boundary rebuilds it when the file is rewritten before that boundary and appended to", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-warm-boundary-"));
  roots.push(dir);
  const path = join(dir, "log.jsonl");
  const drawn = line({ type: "user", uuid: id(1), message: { content: [picture] } });
  const clear = line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } });
  const same = line({ type: "progress", data: "x".repeat(clear.length - 30) });
  expect(same.length).toBe(clear.length);
  const padding = line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(3);
  writeFileSync(path, drawn + same + padding);
  exact(await transcriptImageAsync(path, `${id(1)}:0`));
  let changed = false;
  const read = fs.readSync;
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (!changed && at[4] === 0) {
      changed = true;
      writeFileSync(path, drawn + clear + padding);
      appendFileSync(path, line({ type: "progress", data: "append" }));
    }
    return value;
  }) as typeof fs.readSync);
  try { expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull(); } finally { watch.mockRestore(); }
  expect(changed).toBe(true);
  expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull();
});

it("a lookup that sees the file rewritten drops the boundary it kept, even when it serves nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-dropped-boundary-"));
  roots.push(dir);
  const path = join(dir, "log.jsonl");
  const drawn = line({ type: "user", uuid: id(1), message: { content: [picture] } });
  const broken = drawn.replace(id(1), id(9));
  const clear = line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } });
  const same = line({ type: "progress", data: "x".repeat(clear.length - 30) });
  const padding = line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(3);
  writeFileSync(path, drawn + same + padding);
  exact(await transcriptImageAsync(path, `${id(1)}:0`));
  let changed = false;
  const read = fs.readSync;
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (!changed && at[4] === 0) {
      changed = true;
      // a coarse file clock (WSL2 ticks at 250 Hz) can stamp a rewrite within the same tick with the old
      // times; rewrite until the change time moves, as it has for any later real rewrite
      const before = fs.statSync(path, { bigint: true }).ctimeNs;
      do writeFileSync(path, broken + same + padding); while (fs.statSync(path, { bigint: true }).ctimeNs === before);
    }
    return value;
  }) as typeof fs.readSync);
  try { expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull(); } finally { watch.mockRestore(); }
  expect(changed).toBe(true);
  // then it names the picture again, a /clear after it hides it, and the file grows: the boundary kept
  // before the change still matches the tail, and must not be reused
  writeFileSync(path, drawn + clear + padding);
  appendFileSync(path, line({ type: "progress", data: "append" }));
  expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull();
});

// renames the directory that holds the open transcript, which needs POSIX rename semantics (Windows refuses it)
it.skipIf(process.platform === "win32")("a filesystem exception revokes a rejected lookup's boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-exception-"));
  roots.push(dir, `${dir}.away`);
  const path = join(dir, "session.jsonl");
  const drawn = line({ type: "user", uuid: id(1), message: { content: [picture] } });
  const clear = line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } });
  const same = line({ type: "progress", data: "x".repeat(clear.length - 30) });
  expect(same.length).toBe(clear.length);
  const padding = line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(3);
  writeFileSync(path, drawn + same + padding);
  exact(await transcriptImageAsync(path, `${id(1)}:0`));
  let moved = false;
  const read = fs.readSync;
  const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    const value = read(...args);
    const at = args as unknown as [number, Uint8Array, number, number, number];
    if (!moved && at[4] === 0) {
      moved = true;
      renameSync(dir, `${dir}.away`);
    }
    return value;
  }) as typeof fs.readSync);
  try { expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull(); } finally { watch.mockRestore(); }
  expect(moved).toBe(true);
  renameSync(`${dir}.away`, dir);
  writeFileSync(path, drawn + clear + padding);
  appendFileSync(path, line({ type: "progress", data: "append" }));
  expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull();
});

it("serves no picture from another transcript that a folder swap holds at the path from the lease's open on", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-swap-"));
  const elsewhere = mkdtempSync(join(tmpdir(), "ovis-image-swap-other-"));
  roots.push(dir, elsewhere);
  const path = join(dir, "session.jsonl");
  const foreign = Buffer.from(png);
  foreign[foreign.length - 1]! ^= 1;
  writeFileSync(path, line({ type: "user", uuid: id(1), message: { content: [picture] } }));
  writeFileSync(join(elsewhere, "session.jsonl"), line({ type: "user", uuid: id(1), message: { content: [{ ...picture, source: { ...picture.source, data: foreign.toString("base64") } }] } }));
  exact(await transcriptImageAsync(path, `${id(1)}:0`));
  forgetTranscriptState();
  const away = `${dir}.away`;
  const held = new Set<number>();
  let swaps = 0;
  const { openSync, closeSync } = fs;
  const opens = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] !== path) return openSync(...args);
    if (held.size === 0) { swaps++; renameSync(dir, away); renameSync(elsewhere, dir); }
    const fd = openSync(...args);
    held.add(fd);
    return fd;
  }) as typeof fs.openSync);
  const closes = spyOn(fs, "closeSync").mockImplementation(((fd: number) => {
    closeSync(fd);
    if (held.delete(fd) && held.size === 0) { renameSync(dir, elsewhere); renameSync(away, dir); }
  }) as typeof fs.closeSync);
  let image: Awaited<ReturnType<typeof transcriptImageAsync>>;
  try { image = await transcriptImageAsync(path, `${id(1)}:0`); } finally { opens.mockRestore(); closes.mockRestore(); }
  expect(swaps).toBeGreaterThan(0);
  expect(held.size).toBe(0);
  expect(image !== null && Buffer.from(image.bytes).equals(foreign) ? "FOREIGN" : image).toBeNull();
});

it("rejects an image when the path's last check sees a same-size rewrite that put the modification time back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-image-ctime-"));
  roots.push(dir);
  const path = join(dir, "session.jsonl");
  const other = Buffer.from(png);
  other[40] = other[40]! ^ 1;
  const text = (bytes: Buffer) => line({ type: "user", uuid: id(1), parentUuid: null, message: { content: [{ ...picture, source: { ...picture.source, data: bytes.toString("base64") } }] } });
  writeFileSync(path, text(png));
  const time = Math.floor(Date.now() / 1000) - 10;
  utimesSync(path, time, time);
  let checks = 0;
  const stat = fs.statSync;
  const watch = spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => {
    if (args[0] === path && ++checks === 3) {
      // a coarse file clock (WSL2 ticks at 250 Hz) can leave the change time where it was; rewrite until it moves
      const before = stat(path, { bigint: true }).ctimeNs;
      do { writeFileSync(path, text(other)); utimesSync(path, time, time); } while (stat(path, { bigint: true }).ctimeNs === before);
    }
    return stat(...args);
  }) as typeof fs.statSync);
  try { expect(await transcriptImageAsync(path, `${id(1)}:0`)).toBeNull(); } finally { watch.mockRestore(); }
  expect(checks).toBe(3);
  expect(Buffer.from((await transcriptImageAsync(path, `${id(1)}:0`))!.bytes)).toEqual(other);
});

// Windows makes a symbolic link only with Developer Mode or the right to make one, which a test
// run may not have: the reader's `follow` is checked with injected IO there (transcript-reader.test.ts)
describe.skipIf(process.platform === "win32")("a transcript reached through a link", () => {
  // a Claude store can be reached through a linked directory (one config directory linked into
  // another), or name its transcript by a link: the path is checked by the file it names, as statSync does
  it("serves through a link to the file and through a linked directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-claude-image-link-"));
    roots.push(dir);
    const path = join(dir, "store", "session.jsonl");
    mkdirSync(dirname(path));
    writeFileSync(path, line({ type: "user", uuid: id(1), parentUuid: null, message: { content: [picture] } }));
    const file = join(dir, "linked.jsonl");
    symlinkSync(path, file);
    const store = join(dir, "linked-store");
    symlinkSync(dirname(path), store, "dir");
    for (const linked of [file, join(store, basename(path))]) {
      exact(await transcriptImageAsync(linked, `${id(1)}:0`));
      exact(await transcriptImageAsync(linked, `${id(1)}:0`));
      exact(transcriptImage(linked, `${id(1)}:0`));
    }
  });

  it("rejects an image when the link is moved to another file during the lookup", async () => {
    const { path, ref } = fixture();
    const link = join(dirname(path), "linked.jsonl");
    const copy = join(dirname(path), "copy.jsonl");
    copyFileSync(path, copy);
    symlinkSync(path, link);
    let moved = false;
    const read = fs.readSync;
    const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = read(...args);
      if (!moved) { moved = true; rmSync(link); symlinkSync(copy, link); }
      return result;
    }) as typeof fs.readSync);
    try { expect(await transcriptImageAsync(link, ref)).toBeNull(); } finally { watch.mockRestore(); }
    expect(moved).toBe(true);
    exact(await transcriptImageAsync(link, ref));
  });
});

describe("finding a picture's record", () => {
  const other = Buffer.from(png);
  other[40] = other[40]! ^ 1;
  const otherPicture = { ...picture, source: { ...picture.source, data: other.toString("base64") } };
  function transcript(text: string) {
    const dir = mkdtempSync(join(tmpdir(), "ovis-claude-picture-"));
    roots.push(dir);
    const path = join(dir, "session.jsonl");
    writeFileSync(path, text);
    return path;
  }
  async function both(path: string, ref: string) {
    const bytes = (image: Awaited<ReturnType<typeof transcriptImageAsync>>) => image === null ? null : Buffer.from(image.bytes);
    const [cooperative, sync] = [await transcriptImageAsync(path, ref), transcriptImage(path, ref)];
    const searched = await asMain(path, ref);
    expect(bytes(sync)).toEqual(bytes(cooperative));
    expect(bytes(cooperative)).toEqual(bytes(searched));
    return cooperative;
  }

  const quiet = () => setSystemTime(new Date(Date.now() + 10_000));

  it("reads a few windows for each tool's picture of a long transcript, not the transcript", async () => {
    let text = line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "look" } });
    for (let at = 0; at < 40; at += 1) text += line({ type: "progress", uuid: id(100 + at), data: "x".repeat(1024 * 1024) });
    for (let call = 0; call < 4; call += 1) {
      text += line({ type: "assistant", uuid: id(10 + 2 * call), message: { content: [{ type: "tool_use", id: `read-${call}`, name: "Read" }] } });
      text += line({ type: "user", uuid: id(11 + 2 * call), message: { content: [{ type: "tool_result", tool_use_id: `read-${call}`, content: [picture] }] } });
    }
    const path = transcript(text);
    quiet();
    let cold = 0;
    const counted = fs.readSync;
    const counting = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const result = counted(...args);
      cold += result;
      return result;
    }) as typeof fs.readSync);
    try { exact(await transcriptImageAsync(path, `${id(11)}:0:0`)); } finally { counting.mockRestore(); }
    expect(cold).toBeLessThan(Buffer.byteLength(text) * 1.2);
    for (let call = 0; call < 4; call += 1) {
      let bytes = 0;
      const read = fs.readSync;
      const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const result = read(...args);
        bytes += result;
        return result;
      }) as typeof fs.readSync);
      try { exact(await transcriptImageAsync(path, `${id(11 + 2 * call)}:0:0`)); } finally { watch.mockRestore(); }
      expect(bytes).toBeLessThan(3 * 1024 * 1024);
    }
  });

  it("reads a transcript once for a page of pictures right after an append, while the session is not yet quiet", async () => {
    let text = line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "look" } });
    for (let at = 0; at < 16; at += 1) text += line({ type: "progress", uuid: id(100 + at), data: "x".repeat(1024 * 1024) });
    for (let call = 0; call < 4; call += 1) {
      text += line({ type: "assistant", uuid: id(10 + 2 * call), message: { content: [{ type: "tool_use", id: `read-${call}`, name: "Read" }] } });
      text += line({ type: "user", uuid: id(11 + 2 * call), message: { content: [{ type: "tool_result", tool_use_id: `read-${call}`, content: [picture] }] } });
    }
    const path = transcript(text);
    exact(await transcriptImageAsync(path, `${id(11)}:0:0`));
    appendFileSync(path, line({ type: "progress", data: "the session goes on" }));
    let bytes = 0;
    const read = fs.readSync;
    const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const value = read(...args);
      bytes += value;
      return value;
    }) as typeof fs.readSync);
    try {
      for (const image of await Promise.all([0, 1, 2, 3].map((call) => transcriptImageAsync(path, `${id(11 + 2 * call)}:0:0`)))) exact(image);
    } finally { watch.mockRestore(); }
    expect(bytes).toBeLessThan(Buffer.byteLength(text) + 4 * 3 * 1024 * 1024);
  });

  for (const kib of [64, 1025]) it(`reads about what lies between a tool's picture and a call far back (${kib} KiB lines)`, async () => {
    let text = line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "look" } });
    text += line({ type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
    for (let at = 0; at < Math.floor(40 * 1024 / kib); at += 1) text += line({ type: "progress", uuid: id(100 + at), data: "x".repeat(kib * 1024) });
    const result = Buffer.byteLength(text);
    const path = transcript(text + line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture] }] } }));
    quiet();
    exact(await transcriptImageAsync(path, `${id(3)}:0:0`));
    let bytes = 0;
    const read = fs.readSync;
    const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const value = read(...args);
      bytes += value;
      return value;
    }) as typeof fs.readSync);
    try { exact(await transcriptImageAsync(path, `${id(3)}:0:0`)); } finally { watch.mockRestore(); }
    // a forward search for the call reads everything before the result once (and the search for the
    // record the whole transcript before that). Going back costs a 64 KiB piece past each window of a
    // MiB, and each of the four shorter windows it starts with can cost the line it cuts: under a fifth more
    expect(bytes).toBeLessThan(result * 1.2);
  });

  it("goes back over lines of a MiB to a call far back in a few reads per line", async () => {
    // every read is a round trip on a network home: a window that cuts a long line finds the line's start
    // in pieces that grow, not 64 KiB at a time, and the next window is as long as that one turned out
    let text = line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "look" } });
    text += line({ type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
    const lines = 20;
    for (let at = 0; at < lines; at += 1) text += line({ type: "progress", uuid: id(100 + at), data: "x".repeat(1024 * 1024) });
    const path = transcript(text + line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture] }] } }));
    quiet();
    exact(await transcriptImageAsync(path, `${id(3)}:0:0`));
    let reads = 0;
    const read = fs.readSync;
    const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      reads += 1;
      return read(...args);
    }) as typeof fs.readSync);
    try { exact(await transcriptImageAsync(path, `${id(3)}:0:0`)); } finally { watch.mockRestore(); }
    // the piece before a window that finds the line's start, and the window of a MiB, which does not read
    // again what that piece holds: two reads a line, and a few more for the first windows (64 KiB pieces
    // took 6 a line)
    expect(reads).toBeLessThan(3 * lines);
  });

  it("finds a tool's call whose id a search window's edge cuts in two", async () => {
    const call = line({ type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "read-across-the-edge", name: "Read" }] } });
    const head = (pad: number) => line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "x".repeat(pad) } });
    const pad = 1024 * 1024 - Buffer.byteLength(head(0)) - call.indexOf("read-across-the-edge") - 8;
    const text = head(pad) + call;
    expect(Buffer.byteLength(head(pad)) + call.indexOf("read-across-the-edge")).toBe(1024 * 1024 - 8);
    const path = transcript(text + line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: "read-across-the-edge", content: [picture] }] } }));
    exact(await asMain(path, `${id(3)}:0:0`));
    exact(await transcriptImageAsync(path, `${id(3)}:0:0`));
  });

  it("finds a tool's call whose id the backward walk's first window cuts where what its probe read ends", async () => {
    const id2 = "read-across-the-probe";
    const call = (pad: number) => line({ type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: id2, name: "Read", input: { pad: "x".repeat(pad) } }] } });
    const tail = (pad: number) => Buffer.byteLength(call(pad)) - call(pad).indexOf(id2);
    const pad = 64 * 1024 + 8 - tail(0);
    expect(tail(pad)).toBe(64 * 1024 + 8);
    const path = transcript(line({ type: "user", uuid: id(1), parentUuid: null, message: { content: "look" } }) + call(pad)
      + line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: id2, content: [picture] }] } }));
    quiet();
    exact(await transcriptImageAsync(path, `${id(3)}:0:0`));
    exact(await transcriptImageAsync(path, `${id(3)}:0:0`));
    exact(await asMain(path, `${id(3)}:0:0`));
  });

  it("finds a tool's call however far back it was made, and only the last block naming it decides", async () => {
    const padding = line({ type: "progress", data: "x".repeat(1024 * 1024) }).repeat(3);
    const call = (uuid: number) => line({ type: "assistant", uuid: id(uuid), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
    const result = (uuid: number) => line({ type: "user", uuid: id(uuid), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture] }] } });
    const path = transcript(call(2) + padding + result(3) + padding + result(4) + padding + call(5) + padding + result(6));
    exact(await both(path, `${id(3)}:0:0`));
    expect(await both(path, `${id(4)}:0:0`)).toBeNull();
    exact(await both(path, `${id(6)}:0:0`));
    expect(await both(transcript(padding + result(3)), `${id(3)}:0:0`)).toBeNull();
    const near = transcript(call(2) + result(3) + result(4));
    exact(await both(near, `${id(3)}:0:0`));
    expect(await both(near, `${id(4)}:0:0`)).toBeNull();
  });

  it("searches for a uuid on two records, and the first one decides", async () => {
    const text = (uuid: number) => line({ type: "user", uuid: id(uuid), message: { content: [{ type: "text", text: "no picture" }] } });
    const drawn = (uuid: number, image = picture) => line({ type: "user", uuid: id(uuid), message: { content: [image] } });
    const padding = line({ type: "progress", uuid: id(50), data: "x".repeat(1024 * 1024) }).repeat(2);
    expect(await both(transcript(text(1) + padding + drawn(1)), `${id(1)}:0`)).toBeNull();
    exact(await both(transcript(drawn(1) + padding + drawn(1, otherPicture)), `${id(1)}:0`));
    const sidechain = line({ type: "user", uuid: id(1), isSidechain: true, message: { content: [{ type: "text", text: "no picture" }] } });
    expect(await both(transcript(sidechain + padding + drawn(1)), `${id(1)}:0`)).toBeNull();
    const answer = line({ type: "assistant", uuid: id(1), message: { content: [{ type: "text", text: "hi" }] } });
    exact(await both(transcript(answer + padding + drawn(1)), `${id(1)}:0`));
  });

  it("searches for every picture after more records the branch does not follow than it keeps the uuids of", async () => {
    const sidechain = (uuid: number) => line({ type: "user", uuid: id(uuid), isSidechain: true, message: { content: [{ type: "text", text: "no picture" }] } });
    const drawn = (uuid: number) => line({ type: "user", uuid: id(uuid), message: { content: [picture] } });
    let text = drawn(5);
    for (let at = 0; at < 128 * 1024; at += 1) text += sidechain(100_000 + at);
    text += sidechain(99) + drawn(99) + drawn(4);
    const path = transcript(text);
    quiet();
    expect(await both(path, `${id(99)}:0`)).toBeNull();
    exact(await both(path, `${id(4)}:0`));
    const cost = async (ref: string) => {
      let bytes = 0;
      const read = fs.readSync;
      const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const value = read(...args);
        bytes += value;
        return value;
      }) as typeof fs.readSync);
      try { exact(await transcriptImageAsync(path, ref)); } finally { watch.mockRestore(); }
      return bytes;
    };
    expect(await cost(`${id(5)}:0`)).toBeLessThan(1024 * 1024);
    expect(await cost(`${id(4)}:0`)).toBeGreaterThan(Buffer.byteLength(text) / 2);
    appendFileSync(path, line({ type: "progress", data: "appended" }));
    expect(await cost(`${id(4)}:0`)).toBeLessThan(Buffer.byteLength(text) * 1.5);
  });

  it("still knows a sidechain's uuid after the scan has looked it up for a hundred pictures", async () => {
    const sidechain = (uuid: number) => line({ type: "user", uuid: id(uuid), isSidechain: true, message: { content: [{ type: "text", text: "no picture" }] } });
    const drawn = (uuid: number) => line({ type: "user", uuid: id(uuid), message: { content: [picture] } });
    let text = "";
    for (let at = 0; at < 20; at += 1) text += sidechain(1000 + at);
    for (let at = 0; at < 100; at += 1) text += drawn(2000 + at);
    for (let at = 0; at < 20; at += 1) text += sidechain(3000 + at);
    const path = transcript(text + drawn(1005) + drawn(3005) + drawn(4000));
    expect(await both(path, `${id(1005)}:0`)).toBeNull();
    expect(await both(path, `${id(3005)}:0`)).toBeNull();
    exact(await both(path, `${id(4000)}:0`));
    exact(await both(path, `${id(2050)}:0`));
  });

  for (const mib of [12, 20]) it(`searches for a picture after a record too long for the boundary scan to follow (${mib} MiB)`, async () => {
    const long = line({ type: "user", uuid: id(1), message: { content: [{ type: "text", text: "y".repeat(mib * 1024 * 1024) }] } });
    const path = transcript(line({ type: "user", uuid: id(2), message: { content: [picture] } }) + long + line({ type: "user", uuid: id(1), message: { content: [picture] } }));
    exact(await both(path, `${id(2)}:0`));
    expect(await both(path, `${id(1)}:0`)).toBeNull();
  });

  it("serves nothing from a record a /clear or a rewind left behind, and the picture of one after", async () => {
    const clear = line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } });
    const drawn = (uuid: number, image = picture) => line({ type: "user", uuid: id(uuid), message: { content: [image] } });
    const path = transcript(drawn(1) + clear + drawn(2));
    expect(await both(path, `${id(1)}:0`)).toBeNull();
    exact(await both(path, `${id(2)}:0`));
    appendFileSync(path, drawn(1, otherPicture));
    const after = await both(path, `${id(1)}:0`);
    expect(Buffer.from(after!.bytes).equals(other)).toBe(true);
    const record = (uuid: number, parentUuid: number | null, type: string, content: unknown) => line({ type, uuid: id(uuid), parentUuid: parentUuid === null ? null : id(parentUuid), message: { role: type, content } });
    const rewound = transcript(record(10, null, "user", "look") + record(11, 10, "assistant", [{ type: "text", text: "ok" }])
      + record(12, 11, "user", [picture]) + record(13, 12, "assistant", [{ type: "text", text: "seen" }])
      + record(14, 11, "user", "look again") + record(15, 14, "user", [otherPicture]));
    expect(await both(rewound, `${id(12)}:0`)).toBeNull();
    const kept = await both(rewound, `${id(15)}:0`);
    expect(Buffer.from(kept!.bytes).equals(other)).toBe(true);
  });

  const unreadable = (named: string) => line({ type: "file-history-snapshot", messageId: named, snapshot: { files: Array.from({ length: 1_200_000 }, () => "a") } });

  it("refuses as the search does when a record it cannot judge names the picture's uuid before it", async () => {
    const drawn = line({ type: "user", uuid: id(1), message: { content: [picture] } });
    expect(await both(transcript(unreadable(id(1)) + drawn), `${id(1)}:0`)).toBeNull();
    exact(await both(transcript(unreadable(id(2)) + drawn), `${id(1)}:0`));
    exact(await both(transcript(drawn + unreadable(id(1))), `${id(1)}:0`));
  });

  it("refuses as the forward search does when a record it cannot judge names the call before the call", async () => {
    const call = line({ type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
    const result = line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture] }] } });
    expect(await both(transcript(unreadable("read") + call + result), `${id(3)}:0:0`)).toBeNull();
    expect(await both(transcript(call + unreadable("read") + result), `${id(3)}:0:0`)).toBeNull();
    exact(await both(transcript(unreadable("other") + call + result), `${id(3)}:0:0`));
  });

  it("checks the record a kept scan indexed against a file rewritten in place and grown since", async () => {
    const drawn = (image = picture) => line({ type: "user", uuid: id(1), message: { content: [image] } });
    const pad = (length: number) => line({ type: "progress", data: "p".repeat(length - 30) });
    const tail = line({ type: "progress", data: "the tail a kept scan is checked by, longer than sixty-four bytes" });
    const size = Buffer.byteLength(drawn());
    async function rewritten(before: string, after: string) {
      expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
      const path = transcript(before + tail);
      exact(await both(path, `${id(1)}:0`));
      writeFileSync(path, after + tail);
      appendFileSync(path, pad(100));
      return await both(path, `${id(1)}:0`);
    }
    exact(await rewritten(drawn() + pad(1000), pad(100) + drawn() + pad(900)));
    const first = await rewritten(pad(500 + size) + drawn() + drawn(otherPicture) + pad(1000), pad(500) + drawn() + drawn(otherPicture) + pad(1000 + size));
    expect(Buffer.from(first!.bytes).equals(png)).toBe(true);
    const now = await rewritten(drawn() + pad(1000), drawn(otherPicture) + pad(1000));
    expect(Buffer.from(now!.bytes).equals(other)).toBe(true);
    const joined = (text: string) => text.slice(0, -1) + " ";
    expect(await rewritten(pad(1000) + drawn(), joined(pad(1000)) + drawn())).toBeNull();
    expect(await rewritten(drawn() + pad(1000), joined(drawn()) + pad(1000))).toBeNull();
    // once a rewrite is seen, the index is not used again: a second rewrite can put the record the scan
    // saw back where it was, with another of its uuid before it
    const twice = transcript(pad(500 + size) + drawn() + drawn(otherPicture) + pad(1000) + tail);
    exact(await both(twice, `${id(1)}:0`));
    writeFileSync(twice, pad(500 + size) + drawn(otherPicture) + drawn() + pad(1000) + tail);
    appendFileSync(twice, pad(100));
    expect(Buffer.from((await both(twice, `${id(1)}:0`))!.bytes).equals(other)).toBe(true);
    writeFileSync(twice, pad(500) + drawn(otherPicture) + drawn() + pad(1000 + size) + tail + pad(100));
    appendFileSync(twice, pad(100));
    expect(Buffer.from((await both(twice, `${id(1)}:0`))!.bytes).equals(other)).toBe(true);
  });

  async function earlierRewritten(earlier: string, text: string, ref: string) {
    const pad = (length: number) => line({ type: "progress", data: "p".repeat(length - 30) });
    const tail = pad(256 * 1024) + line({ type: "progress", data: "the tail a kept scan is checked by, longer than sixty-four bytes" });
    const stand = pad(Buffer.byteLength(earlier));
    expect(Buffer.byteLength(stand)).toBe(Buffer.byteLength(earlier));
    const path = transcript(pad(200) + stand + text + tail);
    exact(await both(path, ref));
    writeFileSync(path, pad(200) + earlier + text + tail);
    appendFileSync(path, pad(100));
    return await both(path, ref);
  }
  const between = line({ type: "progress", data: "a record between" });
  const drawnOne = (image = picture) => line({ type: "user", uuid: id(1), message: { content: [image] } });
  it("serves the picture a line rewritten in place before the record a kept scan indexed now holds, as the search does", async () => {
    const first = await earlierRewritten(drawnOne(otherPicture), between + drawnOne(), `${id(1)}:0`);
    expect(Buffer.from(first!.bytes).equals(other)).toBe(true);
  });
  it("refuses as the search does when a line before the record a kept scan indexed is rewritten in place to one it cannot judge naming the uuid", async () => {
    expect(await earlierRewritten(unreadable(id(1)), between + drawnOne(), `${id(1)}:0`)).toBeNull();
  });
  it("reads a kept scan's bytes again after a same-size rewrite that kept the file's times (one timestamp tick)", async () => {
    // on NTFS two writes a millisecond apart often keep the file's id, size, mtime and ctime: the version
    // a lookup vouched for then names other bytes, and only a read begun past that tick vouches for it
    const pad = (length: number) => line({ type: "progress", data: "p".repeat(length - 30) });
    const path = transcript(pad(Buffer.byteLength(drawnOne(otherPicture))) + between + drawnOne() + pad(200));
    exact(await both(path, `${id(1)}:0`));
    const kept = fs.statSync(path);
    writeFileSync(path, drawnOne(otherPicture) + between + drawnOne() + pad(200));
    const times = { mtimeMs: kept.mtimeMs, ctimeMs: kept.ctimeMs, mtime: kept.mtime, ctime: kept.ctime };
    const [fstat, stat] = [fs.fstatSync, fs.statSync];
    const watches = [
      spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => Object.assign(fstat(...args), times)) as typeof fs.fstatSync),
      spyOn(fs, "statSync").mockImplementation(((...args: Parameters<typeof fs.statSync>) => { const value = stat(...args); return value && "mtimeMs" in value && args[0] === path ? Object.assign(value, times) : value; }) as typeof fs.statSync),
    ];
    let image: Awaited<ReturnType<typeof transcriptImageAsync>>;
    try { image = await both(path, `${id(1)}:0`); } finally { for (const watch of watches) watch.mockRestore(); }
    expect(Buffer.from(image!.bytes).equals(other)).toBe(true);
  });

  function rewritable() {
    const pad = (length: number) => line({ type: "progress", data: "p".repeat(length - 30) });
    const tail = pad(256 * 1024) + line({ type: "progress", data: "the tail a kept scan is checked by, longer than sixty-four bytes" });
    const earlier = drawnOne(otherPicture);
    const before = pad(200) + pad(Buffer.byteLength(earlier)) + between + drawnOne() + tail;
    const after = pad(200) + earlier + between + drawnOne() + tail;
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    return { path: transcript(before), after };
  }
  // times held for a 10 s tick (whole seconds, as a coarse or cached timestamp source reports them): a
  // rewrite 5 s into the tick keeps the version, so no read made in it vouches for a later lookup. The
  // ctime decides: a writer can give the mtime any fraction
  for (const [name, mtime] of [["both times", 0], ["the ctime, the mtime set to a fraction", 250.25]] as const) it(`reads a kept scan's bytes again when the file's times tick coarser than the quiet rule's 3 s (${name})`, async () => {
    const tick = Math.floor(Date.now() / 10_000) * 10_000 - 60_000;
    const { path, after } = rewritable();
    const restore = holdTimes(path, tick + mtime, tick);
    try {
      setSystemTime(new Date(tick + 5_000));
      exact(await both(path, `${id(1)}:0`));
      setSystemTime(new Date(tick + 5_500));
      writeFileSync(path, after);
      expect(Buffer.from((await both(path, `${id(1)}:0`))!.bytes).equals(other)).toBe(true);
    } finally { restore(); }
  });
  it("reads a kept scan's bytes again within 3 s of the file's ctime, however old its mtime", async () => {
    // a writer that keeps the mtime (cp -p, rsync -t) still moves the ctime: within 3 s of it a rewrite can
    // keep the version, so a read made then vouches for nothing to a later lookup
    const old = Date.now() - 3_600_000 + 0.25;
    const { path, after } = rewritable();
    const restore = holdTimes(path, old, Date.now() - 1_000 + 0.25);
    try {
      exact(await both(path, `${id(1)}:0`));
      writeFileSync(path, after);
      expect(Buffer.from((await both(path, `${id(1)}:0`))!.bytes).equals(other)).toBe(true);
    } finally { restore(); }
  });
  it("reads a kept scan's bytes again when a later lookup would share a read begun before it, while a rewrite kept the file's times", async () => {
    // A read of the bytes vouches only to lookups that began before it. Here a lookup begins after the
    // read took its window, and after a same-size rewrite that kept every time the file reports: sharing
    // that read would serve the picture the bytes no longer hold.
    const old = Date.now() - 1_000 + 0.25;
    const { path, after } = rewritable();
    const restore = holdTimes(path, old, old);
    try {
      exact(await transcriptImageAsync(path, `${id(1)}:0`));
      appendFileSync(path, line({ type: "progress", data: "the session goes on" }));
      const grown = after + line({ type: "progress", data: "the session goes on" });
      let later: ReturnType<typeof transcriptImageAsync> | undefined;
      const read = fs.readSync;
      const watch = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
        const value = read(...args);
        if (later === undefined && (args as unknown[])[4] === 0) {
          writeFileSync(path, grown);
          later = transcriptImageAsync(path, `${id(1)}:0`);
        }
        return value;
      }) as typeof fs.readSync);
      let first: Awaited<ReturnType<typeof transcriptImageAsync>>;
      try { first = await transcriptImageAsync(path, `${id(1)}:0`); } finally { watch.mockRestore(); }
      expect(later).toBeDefined();
      exact(first);
      expect(Buffer.from((await later!)!.bytes).equals(other)).toBe(true);
      expect(Buffer.from((await asMain(path, `${id(1)}:0`))!.bytes).equals(other)).toBe(true);
    } finally { restore(); }
  });

  it("refuses as the forward search does when a line before the call is rewritten in place to one it cannot judge naming the call", async () => {
    const call = line({ type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
    const result = line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture] }] } });
    expect(await earlierRewritten(unreadable("read"), call + between + result, `${id(3)}:0:0`)).toBeNull();
  });
  it("refuses as the forward search does for a tool's picture past the uuids it keeps, when a line before the call is rewritten in place to one it cannot judge naming the call", async () => {
    // the result is past MARKS_LIMIT, so no record of it is indexed: a lookup that has not read the bytes
    // again must not go back from the result by what the kept scan noted, which misses the rewritten line
    const call = line({ type: "assistant", uuid: id(2), message: { content: [{ type: "tool_use", id: "read", name: "Read" }] } });
    const sidechain = (uuid: number) => line({ type: "user", uuid: id(uuid), isSidechain: true, message: { content: [{ type: "text", text: "no picture" }] } });
    let sidechains = "";
    for (let at = 0; at <= 128 * 1024; at += 1) sidechains += sidechain(100_000 + at);
    const result = line({ type: "user", uuid: id(3), message: { content: [{ type: "tool_result", tool_use_id: "read", content: [picture] }] } });
    expect(await earlierRewritten(unreadable("read"), call + sidechains + between + result, `${id(3)}:0:0`)).toBeNull();
  });

});

describe("the index against the search, on random transcripts", () => {
  // a seeded generator (mulberry32): the same transcripts on every run
  function random(seed: number) {
    let state = seed >>> 0;
    const next = () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(items: readonly T[]) => items[Math.floor(next() * items.length)]! };
  }
  const pictures = [0, 1, 2].map((variant) => {
    const bytes = Buffer.from(png);
    if (variant > 0) bytes[40] = bytes[40]! ^ variant;
    return { type: "image", source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") } };
  });
  const uuids = [1, 2, 3, 4, 5].map(id);
  const calls: (string | number)[] = ["c1", "c2", 7];
  const unreadableLine = line({ type: "file-history-snapshot", messageId: "NAMED", snapshot: { files: Array.from({ length: 1_200_000 }, () => "a") } });
  const unreadable = { replace: (_: string, named: string) => unreadableLine.replace("NAMED", named.padEnd(36, "_")) };
  const isUnreadable = (text: string) => text.startsWith('{"type":"file-history-snapshot"');
  const tail = () => line({ type: "progress", data: "a tail longer than the sixty-four bytes a kept scan is checked by" });

  function records(rng: ReturnType<typeof random>, count: number, state: { fresh: number; last: string | null; answers: string[]; unread: boolean; budget: { unread: number } }) {
    const out: string[] = [];
    const uuid = () => rng.next() < 0.6 ? rng.pick(uuids) : id(100 + state.fresh++);
    const chain = (entry: Record<string, unknown>) => {
      const own = uuid();
      const record = { parentUuid: state.last, ...entry, uuid: own };
      if (entry.isSidechain !== true) state.last = own;
      if (entry.type === "assistant") state.answers.push(own);
      return line(record);
    };
    const pictured = () => rng.next() < 0.3 ? [{ type: "text", text: "see" }, rng.pick(pictures)] : [rng.pick(pictures), ...(rng.next() < 0.3 ? [rng.pick(pictures)] : [])];
    for (let at = 0; at < count; at += 1) {
      const kind = rng.int(13);
      if (kind === 0) out.push(chain({ type: "user", message: { role: "user", content: "a prompt" } }));
      else if (kind === 1) out.push(chain({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "an answer" }] } }));
      else if (kind === 2) out.push(chain({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: rng.pick(calls), name: "Read" }] } }));
      else if (kind === 3 || kind === 4) out.push(chain({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: String(rng.pick(calls)), content: pictured() }] } }));
      else if (kind === 5) out.push(chain({ type: "user", message: { role: "user", content: pictured() } }));
      else if (kind === 6) {
        const first = chain({ type: "user", message: { role: "user", content: [pictures[0]] } });
        out.push(first, first.replace(pictures[0]!.source.data, pictures[1 + rng.int(2)]!.source.data));
      }
      else if (kind === 7) out.push(chain({ type: "user", isSidechain: true, message: { role: "user", content: rng.next() < 0.5 ? pictured() : "a sidechain's prompt" } }));
      else if (kind === 8) out.push(chain({ type: "user", isMeta: true, message: { role: "user", content: pictured() } }));
      else if (kind === 9) out.push(line({ type: "progress", data: `${rng.pick(uuids)} ${"p".repeat(rng.int(400))}`, toolUseID: String(rng.pick(calls)) }));
      else if (kind === 10) { if (rng.next() < 0.3) out.push(line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } })); }
      else if (kind === 11) {
        if (state.answers.length > 0) { state.last = rng.pick(state.answers); out.push(chain({ type: "user", message: { role: "user", content: "a prompt again" } })); }
      } else if (!state.unread && state.budget.unread > 0 && rng.next() < 0.1) {
        state.unread = true;
        state.budget.unread -= 1;
        out.push(unreadable.replace("NAMED", String(rng.next() < 0.5 ? rng.pick(uuids) : rng.pick(calls))));
      }
    }
    return out;
  }

  function rewrite(rng: ReturnType<typeof random>, lines: string[]): string[] {
    const next = [...lines];
    const body = next.length - 1;
    const kind = rng.int(6);
    if (kind === 0) {
      const at = rng.int(body);
      for (const [from, to] of [[0, 1], [1, 2], [2, 0]] as const) if (next[at]!.includes(pictures[from]!.source.data)) { next[at] = next[at]!.replace(pictures[from]!.source.data, pictures[to]!.source.data); break; }
    } else if (kind === 1 && body >= 2) {
      const at = rng.int(body - 1);
      [next[at], next[at + 1]] = [next[at + 1]!, next[at]!];
    } else if (kind === 5) {
      const held = next.flatMap((text, at) => {
        if (at >= body || text.length > 100_000) return [];
        const entry = JSON.parse(text) as { uuid?: string; message?: { content?: { type?: string; tool_use_id?: string; content?: unknown }[] } };
        const content = entry.message?.content;
        if (typeof entry.uuid !== "string" || !Array.isArray(content)) return [];
        const result = content.find((block) => block.type === "tool_result" && Array.isArray(block.content));
        return content.some((block) => block.type === "image") || result ? [{ at, uuid: entry.uuid, call: result?.tool_use_id }] : [];
      });
      if (held.length > 0) {
        const { at: record, uuid, call } = rng.pick(held);
        const earlier = next.flatMap((text, at) => at < record ? [at] : []);
        const unread = earlier.filter((at) => isUnreadable(next[at]!));
        const at = unread.length > 0 && rng.next() < 0.5 ? rng.pick(unread) : earlier.length > 0 ? rng.pick(earlier) : -1;
        if (at !== -1 && isUnreadable(next[at]!)) next[at] = unreadable.replace("NAMED", call !== undefined && rng.next() < 0.5 ? call : uuid);
        else if (at !== -1) {
          const drawn = line({ type: "user", uuid, message: { role: "user", content: [rng.pick(pictures), { type: "text", text: "" }] } });
          const room = Buffer.byteLength(next[at]!) - Buffer.byteLength(drawn);
          if (room >= 0) next[at] = drawn.replace('"text":""', `"text":"${" ".repeat(room)}"`);
        }
      }
    } else if (kind === 3 && body >= 2) {
      const at = rng.int(body - 1);
      next[at] = next[at]!.slice(0, -1) + " ";
    } else if (kind === 4 && body >= 2) {
      const even = next.slice(0, body - 1).flatMap((text, at) => Buffer.byteLength(text) === Buffer.byteLength(next[at + 1]!) ? [at] : []);
      const [gone] = next.splice(even.length > 0 && rng.next() < 0.7 ? rng.pick(even) : rng.int(body - 1), 1);
      next.splice(body - 1, 0, line({ type: "progress", data: "q".repeat(Math.max(0, Buffer.byteLength(gone!) - 31)) }).slice(0, -1).padEnd(Buffer.byteLength(gone!) - 1, " ") + "\n");
    } else {
      const padded = next.map((text, at) => at < body && text.startsWith('{"type":"progress","data":"') ? at : -1).filter((at) => at !== -1);
      if (padded.length >= 2) {
        const from = rng.pick(padded), to = rng.pick(padded);
        const moved = Math.min(rng.int(300), next[from]!.match(/p+/)?.[0].length ?? 0);
        if (from !== to && moved > 0) {
          next[from] = next[from]!.replace(/p+/, (run) => run.slice(moved));
          next[to] = next[to]!.replace(/ (p*)"/, (_, run: string) => ` ${run}${"p".repeat(moved)}"`);
        }
      }
    }
    return next;
  }

  it("serves what the search serves for every lookup, through appends and rewrites in place", async () => {
    const rng = random(2627);
    const refs = uuids.flatMap((uuid) => [`${uuid}:0`, `${uuid}:1`, `${uuid}:0:0`, `${uuid}:1:0`, `${uuid}:0:1`]);
    const digest = (image: Awaited<ReturnType<typeof transcriptImageAsync>>) => image === null ? "none" : Bun.hash.xxHash3(image.bytes).toString(16);
    let compared = 0, served = 0;
    const budget = { unread: 8 };
    const differences: string[] = [];
    let restoreTimes = () => {};
    try { for (let round = 0; round < 200; round += 1) {
      const dir = mkdtempSync(join(tmpdir(), "ovis-claude-fuzz-"));
      roots.push(dir);
      const path = join(dir, "session.jsonl");
      const state = { fresh: 0, last: null as string | null, answers: [] as string[], unread: false, budget };
      const kind = rng.next();
      const quiet = kind < 0.5;
      restoreTimes();
      restoreTimes = kind >= 0.5 && kind < 0.7 ? holdTimes(path, Math.floor(Date.now() / 1000) * 1000 - 10_000, Math.floor(Date.now() / 1000) * 1000 - 10_000) : () => {};
      let writes = 0;
      const write = (text: string) => {
        writeFileSync(path, text);
        if (quiet) { const at = new Date(Date.UTC(2026, 0, 1) + ++writes * 1000); utimesSync(path, at, at); }
      };
      if (quiet) setSystemTime(new Date(Date.now() + 3_600_000));
      else setSystemTime();
      const first: string[] = [];
      if (budget.unread > 0 && rng.next() < 0.12) {
        budget.unread -= 1;
        state.unread = true;
        const named = rng.next() < 0.5 ? rng.pick(uuids) : rng.pick(calls);
        first.push(unreadable.replace("NAMED", String(named)));
        if (typeof named === "string" && uuids.includes(named)) first.push(line({ type: "user", uuid: named, parentUuid: null, message: { role: "user", content: [pictures[0]] } }));
        else {
          first.push(line({ type: "assistant", uuid: id(90), parentUuid: null, message: { role: "assistant", content: [{ type: "tool_use", id: named, name: "Read" }] } }));
          first.push(line({ type: "user", uuid: rng.pick(uuids), parentUuid: id(90), message: { role: "user", content: [{ type: "tool_result", tool_use_id: String(named), content: [pictures[0]] }] } }));
        }
        state.last = null;
      }
      let lines = [...first, ...records(rng, 4 + rng.int(20), state), tail()];
      write(lines.join(""));
      for (let step = 0; step < 3; step += 1) {
        if (step > 0) {
          const change = rng.int(3);
          if (change === 0) lines = [...lines, ...records(rng, 1 + rng.int(4), state), tail()];
          else {
            lines = rewrite(rng, lines);
            if (change === 2) lines = [...lines, ...records(rng, 1 + rng.int(3), state), tail()];
          }
          write(lines.join(""));
        }
        const held = lines.flatMap((text) => {
          if (text.length > 100_000) return [];
          const entry = JSON.parse(text) as { uuid?: string; message?: { content?: unknown } };
          if (typeof entry.uuid !== "string" || !Array.isArray(entry.message?.content)) return [];
          return (entry.message.content as { type?: string; content?: unknown[] }[]).flatMap((block, at) => block.type === "image" ? [`${entry.uuid}:${at}`]
            : block.type === "tool_result" && Array.isArray(block.content) ? block.content.map((_, nested) => `${entry.uuid}:${at}:${nested}`) : []);
        });
        for (let pick = 0; pick < 8; pick += 1) {
          const ref = held.length > 0 && rng.next() < 0.7 ? rng.pick(held) : rng.pick(refs);
          const [indexed, searched] = [digest(await transcriptImageAsync(path, ref)), digest(await asMain(path, ref))];
          compared += 1;
          if (searched !== "none") served += 1;
          if (indexed !== searched) differences.push(`round ${round} step ${step} ${ref}: ${indexed} where the search gives ${searched}`);
        }
      }
    } } finally { restoreTimes(); }
    expect(differences).toEqual([]);
    expect(served).toBeGreaterThan(compared / 10);
  }, 60_000);
});
