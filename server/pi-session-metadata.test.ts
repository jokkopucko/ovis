import { afterEach, describe, expect, it, jest, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, fstatSync, mkdirSync, mkdtempSync, openSync, read, realpathSync, renameSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionHistoryResponse, SessionSnapshot } from "../shared/protocol.ts";
import { PiLabelParser } from "./pi-session-label.ts";
import { PI_CHUNK_BYTES, PI_HEADER_DEADLINE_MS, PI_READ_DEADLINE_MS, PI_READERS, PiMetadataBusy, PiSessionReader } from "./pi-session-metadata.ts";
import { listSessions, MAX_STATS, piSessionFolder } from "./session-history.ts";
import { handleSessionHistoryRequest } from "./session-history-routes.ts";

const roots: string[] = [];
const readers: PiSessionReader[] = [];
const releases: Array<() => void> = [];
/** Every held I/O gate also releases on test failure/timeout, before cleanup waits for readers. */
function ioGate() {
  const gate = Promise.withResolvers<void>();
  releases.push(gate.resolve);
  return gate;
}
afterEach(async () => {
  const closing = readers.splice(0);
  for (const reader of closing) reader.close();
  for (const release of releases.splice(0)) release();
  await Promise.all(closing.map((reader) => reader.idle()));
  mock.restore();
  jest.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const header = (id = "fixture", cwd = process.cwd()) => line({ type: "session", version: 3, id, cwd, timestamp: "2026-10-01T09:00:00Z" });
const prompt = (content: unknown) => line({ type: "message", message: { role: "user", content } });
const name = (name: unknown) => line({ type: "session_info", name });
const filler = (size: number) => line({ type: "message", message: { role: "system", content: "x".repeat(size) } });
function fixture(options: ConstructorParameters<typeof PiSessionReader>[0] = {}) {
  const home = mkdtempSync(join(tmpdir(), "ovis-pi-label-"));
  roots.push(home);
  const store = join(home, "sessions");
  const folder = join(store, piSessionFolder(process.cwd()));
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "fixture.jsonl");
  const io = { bytes: 0, max: 0, calls: 0 };
  const reader = new PiSessionReader({
    read: options.read ?? ((fd, buffer, length, position) => new Promise((done, fail) => {
      io.max = Math.max(io.max, length);
      io.calls++;
      read(fd, buffer, 0, length, position, (error, bytes) => { io.bytes += bytes; if (error) fail(error); else done(bytes); });
    })),
    deadlineMs: options.deadlineMs,
  });
  readers.push(reader);
  const stores = { home, env: { PI_CODING_AGENT_SESSION_DIR: store }, piReader: reader };
  return { file, folder, reader, io, stores, list: () => listSessions("pi", process.cwd(), stores) };
}
const parsed = (body: string, chunk = 7) => {
  const bytes = Buffer.from(body);
  const parser = new PiLabelParser();
  for (let start = 0; start < bytes.length; start += chunk) parser.feed(bytes.subarray(start, start + chunk));
  return parser.finish();
};

describe("Pi native label semantics", () => {
  it("skips native falsy JSON preambles before a valid header, with or without trailing whitespace", async () => {
    const f = fixture();
    const body = header() + prompt("visible prompt");
    for (const value of ['""', "null", "false", "0", "-0"]) {
      for (const whitespace of ["", " ", "\t"]) {
        const transcript = `${value}${whitespace}\n${body}`;
        for (const chunk of [1, 7, PI_CHUNK_BYTES]) {
          expect(parsed(transcript, chunk)).toMatchObject({ header: { id: "fixture" }, firstMessage: "visible prompt" });
        }
        writeFileSync(f.file, transcript);
        expect((await f.list())[0]).toMatchObject({ id: "fixture", firstMessage: "visible prompt" });
      }
    }
  });

  it("refuses a truthy non-header preamble instead of skipping its projected value", () => {
    for (const value of ['"not a header"', '" "', '"\\u0000"', "true", "1", "-1", "[]", "{}"]) {
      for (const whitespace of ["", " "]) {
        for (const chunk of [1, 7, PI_CHUNK_BYTES]) {
          expect(parsed(`${value}${whitespace}\n${header()}`, chunk).header?.id).toBe("");
        }
      }
    }
  });

  it("retains exact bounded header identities but never substitutes an overflowing prefix", () => {
    for (const field of ["id", "cwd"] as const) {
      for (const chunk of [1, PI_CHUNK_BYTES]) {
        const exact = { type: "session", version: 3, id: "fixture", cwd: process.cwd(), [field]: "x".repeat(16384) };
        expect(parsed(line(exact), chunk).header?.[field]).toBe(exact[field]);
        expect(parsed(line({ ...exact, [field]: exact[field] + " " }), chunk).header?.[field]).toBe("");
        expect(parsed(line({ ...exact, [field]: exact[field] + "other" }), chunk).header?.[field]).toBe("");
      }
    }
  });

  it("uses latest names, trims them, clears them explicitly and ignores extension titles", () => {
    const body = header() + prompt(" First prompt ") + name("old") + line({ type: "title", title: "not a Pi name" });
    expect(parsed(body).title).toBe("old");
    expect(parsed(body + name("  new name  ")).title).toBe("new name");
    for (const clear of ["", " \t\n ", null, undefined]) {
      expect(parsed(body + name(clear))).toMatchObject({ title: null, firstMessage: "First prompt" });
    }
  });

  it("takes the first usable user text, text blocks only joined with spaces, not input_text or images", () => {
    const body = header() + prompt("   ") + prompt([{ type: "image", data: "abc" }, { type: "input_text", text: "not Pi text" }])
      + prompt([{ type: "text", text: "  Hello" }, { type: "image", data: "abc" }, { type: "text", text: "world  " }]) + prompt("later");
    expect(parsed(body).firstMessage).toBe("Hello world");
    expect(parsed(header() + prompt("  string content  ")).firstMessage).toBe("string content");
    expect(parsed(header() + prompt([{ type: "text", text: "a " }, { type: "text", text: " b" }])).firstMessage).toBe("a   b");
    expect(parsed(header() + prompt([{ type: "text", text: " ".repeat(10000) + "after leading whitespace" }])).firstMessage).toBe("after leading whitespace");
  });

  it("matches JSON parsing across every boundary, escapes and Unicode included", () => {
    const body = header() + prompt([{ type: "text", text: 'Hello 🐑 한글 \\ "\n\t' }, { type: "text", text: "friend" }])
      + '{"type":"session_info","name":"a \\uD83D\\uDC11 \\uD55C"}\n';
    for (let size = 1; size < 80; size++) expect(parsed(body, size)).toMatchObject({ title: "a 🐑 한", firstMessage: 'Hello 🐑 한글 \\ "\n\t friend' });
  });

  it("does not trust malformed records, but keeps reading after enormous and deeply nested ones", () => {
    const bad = ['{"type":"session_info","name":"bad",}', '{"type":"session_info","name":"bad"} trailing', '{"type":"session_info","name":"bad\\q"}', '{"type":"session_info","name":"bad","x":01}'];
    for (const invalid of bad) expect(parsed(header() + name("good") + invalid + "\n").title).toBe("good");
    const deeplyNested = `{"x":${"[".repeat(100)}0${"]".repeat(100)}}\n`;
    expect(parsed(header() + deeplyNested + '{broken\n' + filler(512 * 1024) + prompt("readable"), PI_CHUNK_BYTES).firstMessage).toBe("readable");
  });

  it("validates controls even in ignored string spans after the label and across read chunks", () => {
    const prefix = "x".repeat(PI_CHUNK_BYTES + 19);
    for (let code = 0; code < 32; code++) {
      const invalid = `{"type":"session_info","name":"bad","ignored":"${prefix}${String.fromCharCode(code)}"}\n`;
      expect(() => JSON.parse(invalid)).toThrow();
      expect(parsed(header() + name("good") + invalid, PI_CHUNK_BYTES).title).toBe("good");
    }
    const escaped = line({ type: "session_info", name: "valid", ignored: `${prefix}\"\\\n\t\u2028\u2029🐑` });
    expect(parsed(header() + escaped, PI_CHUNK_BYTES).title).toBe("valid");
  });

  it("keeps clipping and escape semantics when ordinary string spans cross chunk boundaries", () => {
    const leading = " ".repeat(PI_CHUNK_BYTES - 15);
    const body = header() + prompt([{ type: "text", text: `${leading}${"p".repeat(2000)} tail \\"🐑` }])
      + name(`${leading}${"n".repeat(200)} tail \\"🐑`);
    for (const chunk of [127, PI_CHUNK_BYTES - 1, PI_CHUNK_BYTES, PI_CHUNK_BYTES + 1]) {
      expect(parsed(body, chunk)).toMatchObject({ title: `${"n".repeat(200)} …`, firstMessage: `${"p".repeat(2000)} …` });
    }
  });

  it("rejects BOM-prefixed records as native JSON.parse does, including split BOM bytes", () => {
    const invalid = `\ufeff${name("bad").trimEnd()}`;
    expect(() => JSON.parse(invalid)).toThrow();
    for (let size = 1; size < 8; size++) {
      expect(parsed(header() + name("good") + invalid + "\n", size).title).toBe("good");
      expect(parsed(header() + name("good") + invalid + "\n" + name("after"), size).title).toBe("after");
    }
  });

  it("rejects malformed UTF-8 inside retained and ignored fields without relying on a later rename", () => {
    for (const ignored of [false, true]) {
      const prefix = ignored ? '{"type":"session_info","name":"bad","ignored":"' : '{"type":"session_info","name":"';
      for (const bad of [[0xff], [0xc0, 0xaf], [0xe2], [0xe2, 0x28, 0xa1], [0xed, 0xa0, 0x80]]) {
        for (const newline of ["", "\n"]) {
          const bytes = Buffer.concat([Buffer.from(header() + name("good") + prefix), Buffer.from(bad), Buffer.from(`"}${newline}`)]);
          for (const chunk of [1, 7, PI_CHUNK_BYTES]) {
            const parser = new PiLabelParser();
            for (let at = 0; at < bytes.length; at += chunk) parser.feed(bytes.subarray(at, at + chunk));
            expect(parser.finish().title).toBe("good");
          }
        }
      }
    }
  });

  it("recovers after malformed UTF-8 and waits for complete JSON across chunks", () => {
    const parser = new PiLabelParser();
    parser.feed(Buffer.from(header() + name("good")));
    parser.feed(Buffer.concat([Buffer.from('{"type":"session_info","name":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    parser.feed(Buffer.from('{"type":"session_info","name":"next","ignored":1'));
    parser.feed(Buffer.from('2}\n'));
    expect(parser.finish().title).toBe("next");
  });

  it("flushes UTF-8 at EOF, accepting a whole final record but rejecting incomplete bytes after it", () => {
    const prefix = Buffer.from(header() + name("good"));
    const final = Buffer.from(name("끝 🐑").trimEnd());
    const cases = [
      { bytes: Buffer.concat([prefix, final]), title: "끝 🐑" },
      ...[[0xe2], [0xe2, 0x82], [0xf0, 0x9f, 0x90]].map((tail) => ({
        // The JSON itself is complete; only flushing the decoder reveals this invalid suffix.
        bytes: Buffer.concat([prefix, final, Buffer.from(tail)]), title: "good",
      })),
    ];
    for (const { bytes, title } of cases) {
      for (const size of [1, 2, 3, 7]) {
        const parser = new PiLabelParser();
        for (let at = 0; at < bytes.length; at += size) parser.feed(bytes.subarray(at, at + size));
        expect(parser.finish().title).toBe(title);
      }
    }
  });

  it("retains clipped text from huge user/image and name records, not their conversation payloads", () => {
    const body = header() + prompt([{ type: "image", data: "a".repeat(512 * 1024) }, { type: "text", text: "hello".repeat(10000) }]) + name(" ".repeat(10000) + "n".repeat(10000));
    const label = parsed(body, PI_CHUNK_BYTES);
    expect(label.title).toBe("n".repeat(201));
    expect(label.firstMessage).toBe("hello".repeat(401).slice(0, 2001));
    expect(JSON.stringify(label).length).toBeLessThan(2500);
  });
});

describe("Pi stat-keyed streaming reader", () => {
  it("finishes multichunk headerless files once and reaches the older session by the fourth open", async () => {
    jest.useFakeTimers();
    spyOn(performance, "now").mockReturnValue(0);
    const f = fixture();
    writeFileSync(f.file, header("older-real-session") + name("Still available"));
    utimesSync(f.file, 1, 1);
    const whitespace = " ".repeat(PI_CHUNK_BYTES + 1);
    for (let n = 0; n < 150; n++) {
      const path = join(f.folder, `headerless-${n}.jsonl`);
      writeFileSync(path, whitespace);
      utimesSync(path, 2 + n, 2 + n);
    }
    for (let open = 0; open < 3; open++) await expect(f.list()).rejects.toBeInstanceOf(PiMetadataBusy);
    const rows = await f.list();
    expect(rows).toMatchObject([{ id: "older-real-session", title: "Still available" }]);
    expect(f.io.calls).toBe(301);
    const bytes = f.io.bytes;
    for (let open = 0; open < 2; open++) expect(await f.list()).toEqual(rows);
    expect(f.io.calls).toBe(301);
    expect(f.io.bytes).toBe(bytes);
    expect(f.reader.cacheSize()).toBe(151);
    // A completed empty result is stat-keyed too: a later valid header must become visible.
    appendFileSync(join(f.folder, "headerless-149.jsonl"), header("newly-readable") + name("Appended session"));
    expect(await f.list()).toEqual(rows);
    expect(await f.list()).toMatchObject([{ id: "newly-readable", title: "Appended session" }, { id: "older-real-session" }]);
    expect(f.io.calls).toBe(303);
  });

  for (const count of [200, 201]) {
    it(`lists the older session behind ${count} unchanged empty files without a false empty response`, async () => {
      jest.useFakeTimers();
      spyOn(performance, "now").mockReturnValue(0);
      const f = fixture();
      writeFileSync(f.file, header("older-real-session") + name("Still available"));
      utimesSync(f.file, 1, 1);
      for (let n = 0; n < count; n++) {
        const path = join(f.folder, `empty-${n}.jsonl`);
        writeFileSync(path, "");
        utimesSync(path, 2 + n, 2 + n);
      }
      for (let open = 0; open < 2; open++) {
        expect(await f.list()).toMatchObject([{ id: "older-real-session", title: "Still available" }]);
      }
      expect(f.reader.cacheSize()).toBe(1);
      expect(f.io.calls).toBe(1);
    });
  }

  it("preserves long header checkpoints when empty files are interleaved between them", async () => {
    jest.useFakeTimers();
    spyOn(performance, "now").mockReturnValue(0);
    const f = fixture();
    for (let n = 0; n < 50; n++) {
      const time = 1_790_000_000 + (50 - n) * 7;
      const path = join(f.folder, `long-${n}.jsonl`);
      writeFileSync(path, line({
        type: "session", version: 3, id: `long-${n}`, cwd: process.cwd(),
        ignored: "x".repeat(70 * 1024),
      }) + name(`Session ${n}`));
      utimesSync(path, time, time);
      if (n < 49) for (let gap = 1; gap <= 6; gap++) {
        const empty = join(f.folder, `empty-${n}-${gap}.jsonl`);
        writeFileSync(empty, "");
        utimesSync(empty, time - gap, time - gap);
      }
    }
    // 344 candidates: headerless files must neither evict checkpoints nor hide real sessions.
    await expect(f.list()).rejects.toBeInstanceOf(PiMetadataBusy);
    const rows = await f.list();
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, n) => `long-${n}`));
    expect(rows.map((row) => row.title)).toEqual(Array.from({ length: 50 }, (_, n) => `Session ${n}`));
    expect(f.reader.cacheSize()).toBe(50);
    expect(f.io.calls).toBe(100);
  });

  it("keeps newest header checkpoints when more long headers exist than cache entries", async () => {
    jest.useFakeTimers();
    spyOn(performance, "now").mockReturnValue(0);
    const f = fixture();
    for (let n = 0; n < 257; n++) {
      const path = join(f.folder, `${n}.jsonl`);
      writeFileSync(path, line({
        type: "session", version: 3, id: `long-header-${n}`, cwd: process.cwd(),
        ignored: "x".repeat(70 * 1024),
      }) + name(`Session ${n}`));
      utimesSync(path, 1_790_000_000 + n, 1_790_000_000 + n);
    }
    // No first-line record fits in the first chunk. Keep those checkpoints rather than
    // walking far enough to evict them before the next open can finish even one header.
    await expect(f.list()).rejects.toBeInstanceOf(PiMetadataBusy);
    const firstReads = f.io.calls;
    const rows = await f.list();
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, n) => `long-header-${256 - n}`));
    expect(rows.map((row) => row.title)).toEqual(Array.from({ length: 50 }, (_, n) => `Session ${256 - n}`));
    expect(firstReads).toBeLessThanOrEqual(50);
    expect(f.io.calls - firstReads).toBe(50);
    expect(f.reader.cacheSize()).toBeLessThanOrEqual(256);
    expect(f.io.max).toBeLessThanOrEqual(PI_CHUNK_BYTES);
  });

  for (const earlier of [false, true]) {
    it(`returns ${earlier ? "checked rows" : "busy, not empty"} when the header phase times out`, async () => {
      jest.useFakeTimers();
      let now = 0;
      spyOn(performance, "now").mockImplementation(() => now);
      const entered = Promise.withResolvers<void>();
      const release = ioGate();
      const f = fixture({ read: async (fd, buffer, length, position) => {
        if (length === PI_CHUNK_BYTES) { entered.resolve(); await release.promise; }
        return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
      } });
      writeFileSync(f.file, header("held") + filler(PI_CHUNK_BYTES));
      utimesSync(f.file, 1, 1);
      if (earlier) {
        const path = join(f.folder, "checked.jsonl");
        writeFileSync(path, header("checked") + name("Available"));
        utimesSync(path, 2, 2);
      }
      const outcome = f.list().then((rows) => ({ rows }), (error: unknown) => ({ error }));
      await entered.promise;
      now = PI_HEADER_DEADLINE_MS + 1;
      jest.advanceTimersByTime(PI_HEADER_DEADLINE_MS + 1);
      if (earlier) expect(await outcome).toMatchObject({ rows: [{ id: "checked", title: "Available" }] });
      else {
        const result = await outcome;
        expect("error" in result && result.error instanceof PiMetadataBusy).toBe(true);
      }
      expect(f.reader.size().active).toBe(1);
      release.resolve();
      await f.reader.idle();
    });
  }

  for (const phase of ["active", "queued"] as const) {
    it(`review timeout: bounds an ${phase} header request while filesystem work is held`, async () => {
      jest.useFakeTimers();
      let now = 0;
      spyOn(performance, "now").mockImplementation(() => now);
      const entered = Promise.withResolvers<void>();
      const release = ioGate();
      const descriptors = new Set<number>();
      const f = fixture({ read: async (fd, buffer, length, position) => {
        descriptors.add(fd);
        if (descriptors.size === (phase === "queued" ? PI_READERS : 1)) entered.resolve();
        await release.promise;
        return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
      } });
      writeFileSync(f.file, header());
      const blockers = phase === "queued" ? Array.from({ length: PI_READERS }, () =>
        f.reader.read(() => openSync(f.file, "r"), 2000).catch((error: unknown) => error)) : [];
      if (phase === "queued") await entered.promise;
      let opened = false;
      const outcome = f.reader.read(() => { opened = true; return openSync(f.file, "r"); }, 50, null, "header")
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      if (phase === "active") await entered.promise;
      now = 51;
      jest.advanceTimersByTime(51);
      // Drain the rejection handler queued by the timer, not any filesystem work.
      await Promise.resolve();
      const expired = await Promise.race([outcome, Promise.resolve({ pending: true })]);
      expect(expired).toHaveProperty("error");
      expect(opened).toBe(phase === "active");
      for (const fd of descriptors) expect(fstatSync(fd).isFile()).toBe(true);
      release.resolve();
      await Promise.all(blockers);
      await f.reader.idle();
    });
  }

  for (const prefix of ["long header", "malformed preamble", "incomplete preamble"] as const) {
    it(`review regression: advances a ${prefix} without hiding the older row forever`, async () => {
      jest.useFakeTimers();
      spyOn(performance, "now").mockReturnValue(0);
      const f = fixture();
      const body = prefix === "long header"
        ? line({ type: "session", version: 3, id: "large-header", cwd: process.cwd(), ignored: "x".repeat(70 * 1024) })
        : `{"broken":"${"x".repeat(70 * 1024)}${prefix === "malformed preamble" ? '" trailing\n' : "\n"}` + header("large-header");
      writeFileSync(f.file, body + name("Recovered header"));
      utimesSync(f.file, 2, 2);
      const older = join(f.folder, "older.jsonl");
      writeFileSync(older, header("older") + name("Older row"));
      utimesSync(older, 1, 1);
      expect((await f.list()).map((row) => row.id)).toContain("older");
      expect(await f.list()).toMatchObject([{ id: "large-header", title: "Recovered header" }, { id: "older" }]);
    });
  }

  it("review regression: foreign headers cannot evict the eligible scan checkpoint on every open", async () => {
    jest.useFakeTimers();
    let now = 0;
    spyOn(performance, "now").mockImplementation(() => now);
    const positions: number[] = [];
    const f = fixture({ read: (fd, buffer, length, position) => new Promise((done, fail) => {
      read(fd, buffer, 0, length, position, (error, count) => {
        if (length === PI_CHUNK_BYTES) { positions.push(position); now += PI_READ_DEADLINE_MS * 0.6; }
        if (error) fail(error); else done(count);
      });
    }) });
    writeFileSync(f.file, header() + filler(2 * PI_CHUNK_BYTES) + name("Eventually complete"));
    utimesSync(f.file, 1, 1);
    for (let n = 0; n < 260; n++) {
      const path = join(f.folder, `foreign-${n}.jsonl`);
      writeFileSync(path, header(`foreign-${n}`, "/foreign"));
      utimesSync(path, 2 + n, 2 + n);
    }
    expect(await f.list()).toMatchObject([{ id: "fixture", title: null }]);
    expect(await f.list()).toMatchObject([{ id: "fixture", title: "Eventually complete" }]);
    expect(positions.filter((position) => position === 0)).toHaveLength(1);
  });

  it("fills labels on later opens even when the header pass spends the whole listing deadline", async () => {
    jest.useFakeTimers();
    let now = 0;
    spyOn(performance, "now").mockImplementation(() => now);
    // Every chunk read costs a fifth of the listing deadline, so labels need several opens.
    let chunks = 0;
    const f = fixture({ read: (fd, buffer, length, position) => new Promise((done, fail) => {
      read(fd, buffer, 0, length, position, (error, count) => {
        chunks++;
        now += PI_READ_DEADLINE_MS / 5;
        if (error) fail(error); else done(count);
      });
    }) });
    writeFileSync(f.file, header() + filler(3 * PI_CHUNK_BYTES) + name("Eventually named"));
    const original = f.reader.read.bind(f.reader);
    // A slow disk: checking the header alone outlasts the listing deadline on every open.
    spyOn(f.reader, "read").mockImplementation((...args) => {
      if (args[3] === "header") now += PI_READ_DEADLINE_MS + 100;
      return original(...args);
    });
    const titles: Array<string | null> = [];
    const reads: number[] = [];
    for (let open = 0; open < 4; open++) {
      const before = chunks;
      const rows = await f.list();
      expect(rows.map((row) => row.id)).toEqual(["fixture"]);
      titles.push(rows[0]!.title);
      reads.push(chunks - before);
    }
    // Each open makes bounded label progress instead of re-checking the header alone.
    expect(titles).toEqual([null, "Eventually named", "Eventually named", "Eventually named"]);
    // The first open reads past its header chunk; none reads more than the reserve allows.
    expect(reads[0]).toBeGreaterThan(1);
    expect(Math.max(...reads)).toBeLessThanOrEqual(3);
  });

  it("review regression: labelled rows do not spend the reserve ahead of an unfinished one", async () => {
    jest.useFakeTimers();
    let now = 0;
    spyOn(performance, "now").mockImplementation(() => now);
    const f = fixture();
    writeFileSync(f.file, header("unfinished") + filler(2 * PI_CHUNK_BYTES) + name("Eventually named"));
    utimesSync(f.file, 1, 1);
    const named = join(f.folder, "named.jsonl");
    writeFileSync(named, header("named") + name("Already named"));
    utimesSync(named, 2, 2);
    const original = f.reader.read.bind(f.reader);
    // A slow disk: the header pass outlasts the listing deadline, and each label scan's
    // open costs more than half of the reserved quarter.
    spyOn(f.reader, "read").mockImplementation((...args) => {
      now += args[3] === "header" ? PI_READ_DEADLINE_MS : PI_READ_DEADLINE_MS * 0.15;
      return original(...args);
    });
    const titles: Array<Array<string | null>> = [];
    for (let open = 0; open < 3; open++) titles.push((await f.list()).map((row) => row.title));
    expect(titles.at(-1)).toEqual(["Already named", "Eventually named"]);
  });

  it("review regression: Windows header eligibility spends the last identity checks only once", async () => {
    jest.useFakeTimers();
    spyOn(performance, "now").mockReturnValue(0);
    const f = fixture();
    const cwd = "C:\\work\\project";
    const alias = "X:\\alias";
    const folder = join(f.stores.env.PI_CODING_AGENT_SESSION_DIR, piSessionFolder(cwd, "win32"));
    mkdirSync(folder);
    writeFileSync(join(folder, "alias.jsonl"), header("alias", alias) + name("Checked once"));
    let identities = 0;
    const rows = await listSessions("pi", cwd, {
      ...f.stores, platform: "win32", realpath: (path) => path, spent: MAX_STATS - 6,
      stat: (path, bigint) => {
        if (path === cwd || path === alias) {
          identities++;
          return bigint ? statSync(folder, { bigint: true }) : statSync(folder);
        }
        return bigint ? statSync(path, { bigint: true }) : statSync(path);
      },
    });
    expect(rows).toMatchObject([{ id: "alias", title: "Checked once" }]);
    expect(identities).toBe(2);
  });

  for (const failure of ["append", "read error", "delete", "replace"] as const) {
    it(`review regression: preserves established rows after label ${failure}`, async () => {
      jest.useFakeTimers();
      spyOn(performance, "now").mockReturnValue(0);
      let changed = false;
      const f = fixture({ read: async (fd, buffer, length, position) => {
        if (position > 0 && !changed) {
          changed = true;
          if (failure === "append") appendFileSync(f.file, name("Torn name"));
          if (failure === "read error") throw new Error("synthetic EIO");
        }
        return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
      } });
      writeFileSync(f.file, header("newest") + filler(2 * PI_CHUNK_BYTES) + name("Do not publish"));
      utimesSync(f.file, 2, 2);
      const older = join(f.folder, "older.jsonl");
      writeFileSync(older, header("older") + name("Older"));
      utimesSync(older, 1, 1);
      const original = f.reader.read.bind(f.reader);
      spyOn(f.reader, "read").mockImplementation((...args) => {
        if (args[3] !== "header" && !changed && (failure === "delete" || failure === "replace")) {
          changed = true;
          rmSync(f.file);
          if (failure === "replace") writeFileSync(f.file, header("replacement") + name("Wrong identity"));
        }
        return original(...args);
      });
      expect(await f.list()).toMatchObject([{ id: "newest", title: null, firstMessage: null }, { id: "older" }]);
      expect(changed).toBe(true);
    });
  }

  for (const expiry of ["queued", "first chunk", "later chunk"] as const) {
    it(`lists every row when the deadline expires in the ${expiry} and fills labels on reopening`, async () => {
      jest.useFakeTimers();
      let now = 0;
      spyOn(performance, "now").mockImplementation(() => now);
      const entered = Promise.withResolvers<void>();
      const release = ioGate();
      let held = 0;
      let expire = true;
      const f = fixture({ read: async (fd, buffer, length, position) => {
        if (expiry === "queued" && held < PI_READERS) {
          if (++held === PI_READERS) entered.resolve();
          await release.promise;
        }
        return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => {
          if (expiry !== "queued" && expire && position === (expiry === "first chunk" ? 0 : PI_CHUNK_BYTES)) {
            expire = false;
            now += PI_READ_DEADLINE_MS + 1;
          }
          if (error) fail(error); else done(count);
        }));
      } });
      writeFileSync(f.file, header("newest") + filler(2 * PI_CHUNK_BYTES) + name("Finished newest"));
      utimesSync(f.file, 3, 3);
      for (const [id, time] of [["middle", 2], ["oldest", 1]] as const) {
        const path = join(f.folder, `${id}.jsonl`);
        writeFileSync(path, header(id) + prompt(`Prompt ${id}`) + name(`Finished ${id}`));
        utimesSync(path, time, time);
      }
      const active = expiry === "queued" ? Array.from({ length: PI_READERS }, () =>
        f.reader.read(() => openSync(f.file, "r"), 10 * PI_READ_DEADLINE_MS).catch((error: unknown) => error)) : [];
      if (expiry === "queued") await entered.promise;
      const queued = Promise.withResolvers<void>();
      const original = f.reader.read.bind(f.reader);
      spyOn(f.reader, "read").mockImplementation((...args) => {
        const result = original(...args);
        queued.resolve();
        return result;
      });
      const listing = f.list().then((rows) => ({ rows }), (error: unknown) => ({ error }));
      if (expiry === "queued") {
        await queued.promise;
        now = PI_READ_DEADLINE_MS + 1;
        jest.advanceTimersByTime(PI_READ_DEADLINE_MS + 1);
        release.resolve();
        await Promise.all(active);
      }
      const outcome = await listing;
      if ("error" in outcome) throw outcome.error;
      const first = outcome.rows;
      expect(first.map((row) => row.id)).toEqual(["newest", "middle", "oldest"]);
      // An expiry during the header pass still leaves the label scans their reserved quarter.
      expect(first.map((row) => [row.title, row.firstMessage])).toEqual([
        [expiry === "later chunk" ? null : "Finished newest", null], ["Finished middle", "Prompt middle"], ["Finished oldest", "Prompt oldest"],
      ]);
      expect(first.every((row) => row.resume !== null)).toBe(true);
      await f.reader.idle();
      expect((await f.list()).map((row) => row.title)).toEqual(["Finished newest", "Finished middle", "Finished oldest"]);
    });
  }

  it("keeps an older cached row on the first open while the newest scan expires", async () => {
    jest.useFakeTimers();
    let now = 0;
    let slow = false;
    spyOn(performance, "now").mockImplementation(() => now);
    const f = fixture({ read: (fd, buffer, length, position) => new Promise((done, fail) => {
      read(fd, buffer, 0, length, position, (error, count) => {
        if (slow) now += PI_READ_DEADLINE_MS * 0.6;
        if (error) fail(error); else done(count);
      });
    }) });
    writeFileSync(f.file, header("older") + name("Cached older"));
    utimesSync(f.file, 1, 1);
    expect(await f.list()).toMatchObject([{ id: "older", title: "Cached older" }]);
    const newest = join(f.folder, "newest.jsonl");
    writeFileSync(newest, header("newest") + filler(2 * PI_CHUNK_BYTES) + name("New label"));
    utimesSync(newest, 2, 2);
    slow = true;
    expect(await f.list()).toMatchObject([
      { id: "newest", title: null, firstMessage: null },
      { id: "older", title: "Cached older" },
    ]);
  });

  it("returns rows with unfinished labels at the deadline and fills them on a later listing", async () => {
    jest.useFakeTimers();
    let now = 0;
    spyOn(performance, "now").mockImplementation(() => now);
    const positions: number[] = [];
    const f = fixture({ read: (fd, buffer, length, position) => new Promise((done, fail) => {
      positions.push(position);
      read(fd, buffer, 0, length, position, (error, count) => {
        now += PI_READ_DEADLINE_MS * 0.6;
        if (error) fail(error); else done(count);
      });
    }) });
    // Three chunks: the first contains a usable header and labels that must stay private
    // until EOF, since a later session_info can replace or clear the name.
    const body = header() + prompt("first prompt") + name("early name")
      + filler(2 * PI_CHUNK_BYTES) + name("final name");
    writeFileSync(f.file, body);

    const first = await f.list();
    expect(first).toMatchObject([{
      id: "fixture", title: null, firstMessage: null,
      startedAt: "2026-10-01T09:00:00.000Z", resume: { argv: ["pi", "--session", "fixture"] },
    }]);
    expect(positions).toEqual([0, PI_CHUNK_BYTES]);
    expect(f.reader.size()).toEqual({ active: 0, waiting: 0 });

    expect(await f.list()).toMatchObject([{ id: "fixture", title: "final name", firstMessage: "first prompt" }]);
    // No reread of the prefix: even when a whole-file scan exceeds every listing budget,
    // a stable file makes progress, with one bounded parser and no retained descriptor.
    expect(positions).toEqual([0, PI_CHUNK_BYTES, 2 * PI_CHUNK_BYTES]);
    expect(await f.list()).toMatchObject([{ title: "final name" }]);
    expect(positions).toHaveLength(3);
  });

  it("returns a checked header while an expired read is held, then closes and resumes its descriptor", async () => {
    jest.useFakeTimers();
    let now = 0;
    spyOn(performance, "now").mockImplementation(() => now);
    const entered = Promise.withResolvers<number>();
    const release = ioGate();
    const positions: number[] = [];
    const f = fixture({ read: async (fd, buffer, length, position) => {
      positions.push(position);
      if (position === PI_CHUNK_BYTES) { entered.resolve(fd); await release.promise; }
      return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
    } });
    writeFileSync(f.file, header() + prompt("early prompt") + filler(2 * PI_CHUNK_BYTES) + name("finished"));
    const listing = f.list();
    const fd = await entered.promise;
    now = PI_READ_DEADLINE_MS;
    jest.advanceTimersByTime(PI_READ_DEADLINE_MS);
    expect(await listing).toMatchObject([{ id: "fixture", title: null, firstMessage: null }]);
    expect(fstatSync(fd).isFile()).toBe(true);
    expect(f.reader.size()).toEqual({ active: 1, waiting: 0 });
    release.resolve();
    await f.reader.idle();
    expect(() => fstatSync(fd)).toThrow();
    expect(await f.list()).toMatchObject([{ title: "finished", firstMessage: "early prompt" }]);
    expect(positions).toEqual([0, PI_CHUNK_BYTES, 2 * PI_CHUNK_BYTES]);
  });

  it("discards partial progress after stat changes, including a same-size rewrite with restored mtime", async () => {
    jest.useFakeTimers();
    let now = 0;
    spyOn(performance, "now").mockImplementation(() => now);
    for (const change of ["append", "truncate", "rewrite", "replace", "delete"] as const) {
      let slow = true;
      const positions: number[] = [];
      const f = fixture({ read: (fd, buffer, length, position) => new Promise((done, fail) => {
        positions.push(position);
        read(fd, buffer, 0, length, position, (error, count) => {
          if (slow) now += PI_READ_DEADLINE_MS * 0.6;
          if (error) fail(error); else done(count);
        });
      }) });
      const body = header() + prompt("old prompt") + filler(2 * PI_CHUNK_BYTES) + name("old name");
      writeFileSync(f.file, body);
      expect(await f.list()).toMatchObject([{ title: null, firstMessage: null }]);
      const time = statSync(f.file).mtime;
      switch (change) {
        case "append": appendFileSync(f.file, name("new name")); break;
        case "truncate": truncateSync(f.file, Buffer.byteLength(header())); break;
        case "rewrite":
          writeFileSync(f.file, body.replace("old prompt", "new prompt").replace("old name", "new name"));
          utimesSync(f.file, time, time);
          break;
        case "replace":
          renameSync(f.file, `${f.file}.old`);
          writeFileSync(f.file, header("replacement") + prompt("new prompt") + name("new name"));
          break;
        case "delete": rmSync(f.file); break;
      }
      slow = false;
      positions.length = 0;
      const rows = await f.list();
      if (change === "delete") {
        expect(rows).toEqual([]);
        expect(positions).toEqual([]);
        expect(f.reader.cacheSize()).toBe(0);
      } else {
        expect(positions[0]).toBe(0);
        expect(rows).toMatchObject([{
          id: change === "replace" ? "replacement" : "fixture",
          title: change === "truncate" ? null : "new name",
          firstMessage: change === "truncate" ? null : change === "append" ? "old prompt" : "new prompt",
        }]);
      }
    }
  });

  it("never publishes labels from a resumed scan changed while it is read", async () => {
    jest.useFakeTimers();
    let now = 0;
    spyOn(performance, "now").mockImplementation(() => now);
    let mutate = false;
    const f = fixture({ read: (fd, buffer, length, position) => new Promise((done, fail) => {
      read(fd, buffer, 0, length, position, (error, count) => {
        now += PI_READ_DEADLINE_MS * 0.6;
        if (mutate) { mutate = false; appendFileSync(f.file, name("changed during resumed read")); }
        if (error) fail(error); else done(count);
      });
    }) });
    writeFileSync(f.file, header() + name("must not escape") + filler(2 * PI_CHUNK_BYTES));
    expect(await f.list()).toMatchObject([{ title: null, firstMessage: null }]);
    mutate = true;
    expect(await f.list()).toMatchObject([{ id: "fixture", title: null, firstMessage: null }]);
    expect(f.reader.cacheSize()).toBe(0);
    expect(await f.list()).toMatchObject([{ title: null }]);
    expect(await f.list()).toMatchObject([{ title: "changed during resumed read" }]);
  });

  it("reuses unchanged labels without reads and refreshes appended names and clears", async () => {
    const f = fixture();
    const body = header() + filler(128 * 1024) + line({ type: "custom", data: "s".repeat(128 * 1024) }) + prompt("late short prompt")
      + name("  name in the middle  ") + filler(3 * 1024 * 1024);
    writeFileSync(f.file, body);
    const rows = await f.list();
    expect(rows[0]).toMatchObject({ title: "name in the middle", firstMessage: "late short prompt", resume: { argv: ["pi", "--session", "fixture"] } });
    const bytes = Buffer.byteLength(body);
    expect(f.io.bytes).toBe(bytes);
    expect(f.io.max).toBeLessThanOrEqual(PI_CHUNK_BYTES);
    const firstReads = f.io.calls;
    expect(await f.list()).toEqual(rows);
    expect(f.io.bytes).toBe(bytes);
    expect(f.io.calls).toBe(firstReads);
    const suffix = name("renamed");
    appendFileSync(f.file, suffix);
    expect((await f.list())[0]?.title).toBe("renamed");
    expect(f.io.bytes).toBe(2 * bytes + Buffer.byteLength(suffix));
    appendFileSync(f.file, name("  "));
    expect((await f.list())[0]).toMatchObject({ title: null, firstMessage: "late short prompt" });
  });

  it("lists the newest 50 long sessions whole and reads zero bytes on repeat", async () => {
    // what is read and returned is the claim, not how fast this runner reads 200 MiB: busy CI runners
    // took 6.6 s and 9 s and hit the two-second deadline, so the listing's deadline is set past the test's
    // own timeout. The shared two-second deadline is covered with a fake clock below.
    const f = fixture({ deadlineMs: 120_000 });
    // Match the video's store count, not its private transcripts. The newest 50 files hold
    // about 200 MiB together. Deadline behavior is covered by the injected-clock cases.
    const system = filler(1024 * 1024);
    const extension = line({ type: "custom", data: { snapshot: "e".repeat(1024 * 1024) } });
    const output = line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: `${"synthetic output ".repeat(16)}\n\\\"🐑`.repeat(4000) }] } });
    let expectedBytes = 0;
    for (let n = 0; n < 202; n++) {
      const file = join(f.folder, `${n}.jsonl`);
      const body = header(`session-${n}`) + (n < 152 ? prompt("older session")
        : system + prompt(`First prompt ${n}`) + extension + name(`Session ${n}`) + output + system);
      writeFileSync(file, body);
      utimesSync(file, 1_790_000_000 + n, 1_790_000_000 + n);
      if (n >= 152) expectedBytes += Buffer.byteLength(body);
    }
    const rows = await f.list();
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 50 }, (_, n) => `session-${201 - n}`));
    expect(rows.every((row, n) => row.title === `Session ${201 - n}` && row.firstMessage === `First prompt ${201 - n}`)).toBe(true);
    expect(f.io.bytes).toBe(expectedBytes);
    expect(await f.list()).toEqual(rows);
    expect(f.io.bytes).toBe(expectedBytes);
    expect(f.io.max).toBeLessThanOrEqual(PI_CHUNK_BYTES);
    expect(f.reader.size()).toEqual({ active: 0, waiting: 0 });
  }, 30_000);

  it("reads completed partial JSONL and multibyte writes on the next fresh listing", async () => {
    const f = fixture();
    const bytes = Buffer.from(prompt("한글 🐑"));
    const split = bytes.indexOf(Buffer.from("한")) + 1;
    writeFileSync(f.file, header() + name("named"));
    appendFileSync(f.file, bytes.subarray(0, split));
    expect((await f.list())[0]).toMatchObject({ title: "named", firstMessage: null });
    appendFileSync(f.file, bytes.subarray(split));
    expect((await f.list())[0]).toMatchObject({ title: "named", firstMessage: "한글 🐑" });
    appendFileSync(f.file, '{"type":"session_info","name":"');
    expect((await f.list())[0]?.title).toBe("named");
    appendFileSync(f.file, '"}\n' + name("latest"));
    expect((await f.list())[0]?.title).toBe("latest");
  });

  it("accepts a final record without a newline and ignores it if a later write makes it invalid", async () => {
    const f = fixture();
    writeFileSync(f.file, header() + prompt("first") + name("old"));
    appendFileSync(f.file, name("preview").trimEnd());
    expect((await f.list())[0]?.title).toBe("preview");
    appendFileSync(f.file, 'garbage\n');
    expect((await f.list())[0]?.title).toBe("old");
    appendFileSync(f.file, name("after"));
    expect((await f.list())[0]?.title).toBe("after");
  });

  it("reads replacements, truncation, same-size rewrites with restored mtime, changed middles and deletion afresh", async () => {
    const f = fixture();
    const initial = header() + filler(70 * 1024) + name("old") + filler(70 * 1024) + prompt("first");
    writeFileSync(f.file, initial);
    expect((await f.list())[0]?.title).toBe("old");
    const originalTime = statSync(f.file).mtime;
    writeFileSync(f.file, initial.replace('"old"', '"new"'));
    utimesSync(f.file, originalTime, originalTime);
    expect((await f.list())[0]?.title).toBe("new");
    writeFileSync(f.file, initial.replace('"old"', '"mid"') + filler(1000));
    expect((await f.list())[0]?.title).toBe("mid");
    truncateSync(f.file, Buffer.byteLength(header()));
    expect((await f.list())[0]).toMatchObject({ title: null, firstMessage: null });
    renameSync(f.file, `${f.file}.old`);
    writeFileSync(f.file, header("replacement") + prompt("replacement prompt"));
    expect((await f.list())[0]).toMatchObject({ id: "replacement", firstMessage: "replacement prompt" });
    expect(f.reader.cacheSize()).toBe(1);
    rmSync(f.file);
    expect(await f.list()).toEqual([]);
    expect(f.reader.cacheSize()).toBe(0);
  });

  it("keeps same-ID files in different stores and paths independent", async () => {
    const a = fixture(); const b = fixture();
    b.stores.piReader = a.reader;
    writeFileSync(a.file, header() + name("store A"));
    writeFileSync(b.file, header() + name("store B"));
    expect((await a.list())[0]?.title).toBe("store A");
    expect((await b.list())[0]?.title).toBe("store B");
    writeFileSync(join(a.folder, "other.jsonl"), header() + name("other path"));
    expect((await a.list()).map((row) => row.title).sort()).toEqual(["other path", "store A"]);
  });

  it("drops deleted entries without evicting unchanged labels from another listed store", async () => {
    const a = fixture(); const b = fixture();
    b.stores.piReader = a.reader;
    writeFileSync(a.file, header("a") + prompt("first A"));
    writeFileSync(b.file, header("b") + prompt("first B"));
    await a.list();
    const rows = await b.list();
    expect(a.reader.cacheSize()).toBe(2);
    const reads = a.io.calls;
    rmSync(a.file);
    expect(await a.list()).toEqual([]);
    expect(a.reader.cacheSize()).toBe(1);
    expect(await b.list()).toEqual(rows);
    expect(a.io.calls).toBe(reads);
  });

  it("bounds retained labels across stores and clears them when stopped", async () => {
    const shared = fixture();
    for (let store = 0; store < 6; store++) {
      const f = store === 0 ? shared : fixture();
      f.stores.piReader = shared.reader;
      for (let n = 0; n < 50; n++) writeFileSync(join(f.folder, `${n}.jsonl`), header(`s-${store}-${n}`) + prompt("small"));
      expect(await f.list()).toHaveLength(50);
      expect(shared.reader.cacheSize()).toBeLessThanOrEqual(256);
    }
    expect(shared.reader.cacheSize()).toBe(256);
    shared.reader.close();
    expect(shared.reader.cacheSize()).toBe(0);
  });

  it("bounds open readers and waiting tasks, and closes descriptors on stop", async () => {
    const entered = Promise.withResolvers<void>();
    const release = ioGate();
    const descriptors = new Set<number>();
    const f = fixture({ read: async (fd, buffer, length, position) => {
      descriptors.add(fd);
      if (descriptors.size === PI_READERS) entered.resolve();
      await release.promise;
      return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
    } });
    writeFileSync(f.file, header());
    const jobs = Array.from({ length: 40 }, () => f.reader.read(() => openSync(f.file, "r"), performance.now() + 2000).catch((error: unknown) => error));
    try {
      await entered.promise;
      expect(f.reader.size()).toEqual({ active: PI_READERS, waiting: 32 });
      f.reader.close();
      expect(f.reader.size().waiting).toBe(0);
      release.resolve();
      expect((await Promise.all(jobs)).every((error) => error instanceof PiMetadataBusy)).toBe(true);
    } finally {
      f.reader.close();
      release.resolve();
      await Promise.all(jobs);
      await f.reader.idle();
    }
    for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow();
    expect(f.reader.size().active).toBe(0);
  });

  it("keeps independent deadlines for concurrent reads of the same file and closes only after outstanding I/O", async () => {
    jest.useFakeTimers();
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const entered = Promise.withResolvers<void>();
    const release = ioGate();
    const descriptors = new Set<number>();
    const f = fixture({ read: async (fd, buffer, length, position) => {
      descriptors.add(fd);
      if (descriptors.size === 2) entered.resolve();
      await release.promise;
      return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
    } });
    writeFileSync(f.file, header() + prompt("independent"));
    const long = f.reader.read(() => openSync(f.file, "r"), now + 2000);
    const longOutcome = long.catch((error: unknown) => error);
    const short = f.reader.read(() => openSync(f.file, "r"), now + 50);
    const shortOutcome = short.catch((error: unknown) => error);
    try {
      // Filesystem setup cannot consume the short budget before both reads are held.
      await entered.promise;
      expect(short).not.toBe(long);
      now = 51;
      jest.advanceTimersByTime(51);
      expect(await shortOutcome).toBeInstanceOf(PiMetadataBusy);
      for (const fd of descriptors) expect(fstatSync(fd).isFile()).toBe(true);
      expect(f.reader.size().active).toBe(2);
      release.resolve();
      expect(await longOutcome).toMatchObject({ firstMessage: "independent" });
    } finally {
      f.reader.close();
      release.resolve();
      await Promise.all([longOutcome, shortOutcome]);
      await f.reader.idle();
      clock.mockRestore();
      jest.useRealTimers();
    }
    for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow();
    expect(f.reader.size().active).toBe(0);
  });

  it("expires a queued request without opening it and admits surviving waiters in FIFO order", async () => {
    jest.useFakeTimers();
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const entered = Promise.withResolvers<void>();
    const release = ioGate();
    const descriptors = new Set<number>();
    const f = fixture({ read: async (fd, buffer, length, position) => {
      descriptors.add(fd);
      if (descriptors.size === PI_READERS) entered.resolve();
      await release.promise;
      return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
    } });
    writeFileSync(f.file, header());
    const active = Array.from({ length: PI_READERS }, () => f.reader.read(() => openSync(f.file, "r"), now + 2000).catch((error: unknown) => error));
    const outcomes = [...active];
    let expiredOpens = 0;
    try {
      await entered.promise;
      const expired = f.reader.read(() => { expiredOpens++; return openSync(f.file, "r"); }, now + 50).catch((error: unknown) => error);
      outcomes.push(expired);
      expect(f.reader.size()).toEqual({ active: PI_READERS, waiting: 1 });
      now = 51;
      jest.advanceTimersByTime(51);
      expect(await expired).toBeInstanceOf(PiMetadataBusy);
      expect(expiredOpens).toBe(0);
      expect(f.reader.size()).toEqual({ active: PI_READERS, waiting: 0 });
      const order: number[] = [];
      const surviving = [1, 2].map((n) => f.reader.read(() => { order.push(n); return openSync(f.file, "r"); }, now + 2000).catch((error: unknown) => error));
      outcomes.push(...surviving);
      expect(order).toEqual([]);
      release.resolve();
      expect(await Promise.all([...active, ...surviving])).toMatchObject(Array.from({ length: PI_READERS + 2 }, () => ({ header: { id: "fixture" } })));
      expect(order).toEqual([1, 2]);
      expect(expiredOpens).toBe(0);
      expect(f.reader.size()).toEqual({ active: 0, waiting: 0 });
    } finally {
      f.reader.close();
      release.resolve();
      await Promise.all(outcomes);
      await f.reader.idle();
      clock.mockRestore();
      jest.useRealTimers();
    }
    for (const fd of descriptors) expect(() => fstatSync(fd)).toThrow();
  });

  it("shares one label deadline across files while completing every bounded header", async () => {
    jest.useFakeTimers();
    let now = 0;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    let reads = 0;
    const f = fixture({ read: (fd, buffer, length, position) => new Promise((done, fail) => {
      read(fd, buffer, 0, length, position, (error, count) => {
        // Each small file uses less than the budget, but both together exceed it.
        reads++;
        now += PI_READ_DEADLINE_MS * 0.75;
        if (error) fail(error); else done(count);
      });
    }) });
    writeFileSync(f.file, header("newer") + name("first row"));
    utimesSync(f.file, 2, 2);
    const other = join(f.folder, "other.jsonl");
    writeFileSync(other, header("older") + name("second row"));
    utimesSync(other, 1, 1);
    const deadlines: number[] = [];
    const original = f.reader.read.bind(f.reader);
    const requested = spyOn(f.reader, "read").mockImplementation((...args) => { deadlines.push(args[1]); return original(...args); });
    try {
      // Both files fit in a chunk, so their EOF-checked labels need no second scan.
      expect(await f.list()).toMatchObject([{ id: "newer", title: "first row" }, { id: "older", title: "second row" }]);
      expect(reads).toBe(2);
      // Both rows are labelled by their header reads, so no label scan is requested at all.
      expect(deadlines).toEqual([PI_HEADER_DEADLINE_MS, PI_HEADER_DEADLINE_MS]);
      expect(f.reader.size()).toEqual({ active: 0, waiting: 0 });
      expect(await f.list()).toMatchObject([{ id: "newer", title: "first row" }, { id: "older", title: "second row" }]);
      expect(reads).toBe(2);
    } finally {
      f.reader.close();
      await f.reader.idle();
      requested.mockRestore();
      clock.mockRestore();
      jest.useRealTimers();
    }
  });

  for (const reason of ["shutdown", "deadline"] as const) {
    it(`closes an opener returning after ${reason} without starting scan I/O`, async () => {
      jest.useFakeTimers();
      let now = 0;
      spyOn(performance, "now").mockImplementation(() => now);
      const entered = Promise.withResolvers<number>();
      const release = ioGate();
      const f = fixture();
      writeFileSync(f.file, header());
      const stats = spyOn(fs, "fstat");
      const outcome = f.reader.read(async () => {
        const fd = openSync(f.file, "r");
        entered.resolve(fd);
        await release.promise;
        return fd;
      }, now + 2000).catch((error: unknown) => error);
      try {
        const fd = await entered.promise;
        if (reason === "shutdown") f.reader.close();
        else { now = 2000; jest.advanceTimersByTime(2000); }
        expect(await outcome).toBeInstanceOf(PiMetadataBusy);
        expect(fstatSync(fd).isFile()).toBe(true);
        release.resolve();
        await f.reader.idle();
        expect(stats).not.toHaveBeenCalled();
        expect(f.io.bytes).toBe(0);
        expect(() => fstatSync(fd)).toThrow();
        expect(f.reader.size().active).toBe(0);
      } finally {
        f.reader.close();
        release.resolve();
        await outcome;
        await f.reader.idle();
        stats.mockRestore();
      }
    });
  }

  for (const phase of ["open", "identity stat"] as const) {
    for (const reason of ["shutdown", "deadline"] as const) {
      it(`handles the production header opener after ${phase} across ${reason}`, async () => {
        jest.useFakeTimers();
        const entered = Promise.withResolvers<void>();
        const release = ioGate();
        const f = fixture();
        writeFileSync(f.file, header());
        const checked = realpathSync(f.file);
        const actualOpen = fs.open;
        const actualStat = fs.fstat;
        let fd = -1;
        let stats = 0;
        let now = performance.now();
        const clock = spyOn(performance, "now").mockImplementation(() => now);
        const opened = spyOn(fs, "open").mockImplementation(((...args: unknown[]) => {
          if (args[0] !== checked) return Reflect.apply(actualOpen, fs, args);
          const callback = args.at(-1) as (error: NodeJS.ErrnoException | null, fd: number) => void;
          return Reflect.apply(actualOpen, fs, [...args.slice(0, -1), (error: NodeJS.ErrnoException | null, value: number) => {
            if (error) { callback(error, value); return; }
            fd = value;
            if (phase === "open") {
              entered.resolve();
              void release.promise.then(() => callback(null, value));
            } else callback(null, value);
          }]);
        }) as typeof fs.open);
        const stated = spyOn(fs, "fstat").mockImplementation(((...args: unknown[]) => {
          if (args[0] !== fd) return Reflect.apply(actualStat, fs, args);
          stats++;
          if (phase !== "identity stat" || stats !== 1) return Reflect.apply(actualStat, fs, args);
          const callback = args.at(-1) as (error: NodeJS.ErrnoException | null, stat: fs.BigIntStats) => void;
          return Reflect.apply(actualStat, fs, [...args.slice(0, -1), (error: NodeJS.ErrnoException | null, stat: fs.BigIntStats) => {
            entered.resolve();
            void release.promise.then(() => callback(error, stat));
          }]);
        }) as typeof fs.fstat);
        const outcome = f.list().catch((error: unknown) => error);
        try {
          await entered.promise;
          expect(fstatSync(fd).isFile()).toBe(true);
          if (reason === "shutdown") {
            f.reader.close();
            expect(await outcome).toBeInstanceOf(PiMetadataBusy);
          } else {
            // Cross the listing's deadline while the actual production callback is held,
            // without relying on a timer racing setup on a loaded filesystem.
            now += PI_READ_DEADLINE_MS + 1;
          }
          expect(f.reader.size().active).toBe(1);
          release.resolve();
          if (reason === "shutdown") expect(await outcome).toBeInstanceOf(PiMetadataBusy);
          else expect(await outcome).toMatchObject([{ id: "fixture", title: null, firstMessage: null }]);
          await f.reader.idle();
          // Past the listing deadline, the reserved label scan still checks the descriptor (two stats).
          expect(stats).toBe(reason === "deadline" ? 5 : phase === "open" ? 0 : 1);
          expect(f.io.bytes).toBe(reason === "deadline" ? Buffer.byteLength(header()) : 0);
          expect(() => fstatSync(fd)).toThrow();
          expect(f.reader.size()).toEqual({ active: 0, waiting: 0 });
        } finally {
          f.reader.close();
          release.resolve();
          await outcome;
          await f.reader.idle();
          opened.mockRestore();
          stated.mockRestore();
          clock.mockRestore();
        }
      });
    }
  }

  it("reports a production open error arriving after the deadline as busy, not an empty listing", async () => {
    jest.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const release = ioGate();
    const f = fixture();
    writeFileSync(f.file, header());
    const checked = realpathSync(f.file);
    const actualOpen = fs.open;
    let now = performance.now();
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    const opened = spyOn(fs, "open").mockImplementation(((...args: unknown[]) => {
      if (args[0] !== checked) return Reflect.apply(actualOpen, fs, args);
      const callback = args.at(-1) as (error: NodeJS.ErrnoException, fd: number) => void;
      entered.resolve();
      void release.promise.then(() => callback(Object.assign(new Error("synthetic open failure"), { code: "EACCES" }), -1));
    }) as typeof fs.open);
    const stats = spyOn(fs, "fstat");
    const outcome = f.list().catch((error: unknown) => error);
    try {
      await entered.promise;
      now += PI_READ_DEADLINE_MS + 1;
      release.resolve();
      expect(await outcome).toBeInstanceOf(PiMetadataBusy);
      await f.reader.idle();
      expect(stats).not.toHaveBeenCalled();
      expect(f.io.bytes).toBe(0);
      expect(f.reader.size()).toEqual({ active: 0, waiting: 0 });
    } finally {
      f.reader.close();
      release.resolve();
      await outcome;
      await f.reader.idle();
      stats.mockRestore();
      opened.mockRestore();
      clock.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32" || Bun.which("mkfifo") === null)("does not block on or read a FIFO swapped in after the regular-file check", async () => {
    const f = fixture();
    writeFileSync(f.file, header());
    const checked = realpathSync(f.file);
    let swapped = false;
    const rows = await listSessions("pi", process.cwd(), { ...f.stores, stat: (path, bigint) => {
      const stat = bigint ? statSync(path, { bigint: true }) : statSync(path);
      if (path === checked && !swapped) {
        swapped = true;
        rmSync(path);
        expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
      }
      return stat;
    } });
    expect(swapped).toBe(true);
    expect(rows).toEqual([]);
    expect(f.io.bytes).toBe(0);
  });

  it("recovers from a failed read without retaining descriptors or failed metadata", async () => {
    let failing = true;
    const f = fixture({ read: async (fd, buffer, length, position) => {
      if (failing) throw new Error("fixture read error");
      return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
    } });
    writeFileSync(f.file, header() + prompt("recovered"));
    await expect(f.list()).rejects.toBeInstanceOf(PiMetadataBusy);
    await f.reader.idle();
    expect(f.reader.size()).toEqual({ active: 0, waiting: 0 });
    failing = false;
    expect((await f.list())[0]?.firstMessage).toBe("recovered");
  });

  it("checks cwd, version and usable IDs on every listing", async () => {
    const f = fixture();
    writeFileSync(f.file, header() + prompt("valid"));
    expect(await f.list()).toHaveLength(1);
    for (const body of [header("foreign", "/another-folder"), header("future").replace('"version":3', '"version":999'), header("  ")]) {
      writeFileSync(f.file, body + prompt("ineligible"));
      expect(await f.list()).toEqual([]);
    }
  });

  it("does not admit a foreign Windows cwd through a clipped header prefix", async () => {
    const f = fixture();
    const cwd = "C:\\work\\project";
    const folder = join(f.stores.env.PI_CODING_AGENT_SESSION_DIR, piSessionFolder(cwd, "win32"));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "windows.jsonl");
    const list = () => listSessions("pi", cwd, { ...f.stores, platform: "win32", realpath: (path) => path });
    const padded = cwd + "\\".repeat(16384 - cwd.length);
    writeFileSync(file, header("windows", padded));
    expect((await list())[0]?.id).toBe("windows");
    for (const recorded of [padded + "other", padded + "\\"]) {
      const body = header("windows", recorded);
      expect(Buffer.byteLength(body)).toBeLessThan(64 * 1024);
      writeFileSync(file, body);
      expect(await list()).toEqual([]);
    }
  });

  it("discards a file mutated during a scan and refuses expired work before opening a descriptor", async () => {
    let mutate = true;
    const f = fixture({ read: async (fd, buffer, length, position) => {
      if (mutate) { mutate = false; appendFileSync(f.file, name("arrived during scan")); }
      return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => error ? fail(error) : done(count)));
    } });
    writeFileSync(f.file, header());
    await expect(f.list()).rejects.toBeInstanceOf(PiMetadataBusy);
    expect((await f.list())[0]?.title).toBe("arrived during scan");
    let opened = false;
    await expect(f.reader.read(() => { opened = true; return openSync(f.file, "r"); }, 0)).rejects.toBeInstanceOf(PiMetadataBusy);
    expect(opened).toBe(false);
  });

  it("keeps a server responsive during a fresh 20 MiB listing and reuses its label next time", async () => {
    jest.useFakeTimers();
    spyOn(performance, "now").mockReturnValue(0);
    const scanning = Promise.withResolvers<void>();
    const release = ioGate();
    let bytes = 0;
    const f = fixture({ read: async (fd, buffer, length, position) => {
      if (position === 0) { scanning.resolve(); await release.promise; }
      return new Promise((done, fail) => read(fd, buffer, 0, length, position, (error, count) => { bytes += count; if (error) fail(error); else done(count); }));
    } });
    writeFileSync(f.file, header());
    // Synthetic transcript, built in small writes rather than one giant test allocation.
    const block = filler(1024 * 1024);
    for (let n = 0; n < 20; n++) appendFileSync(f.file, block);
    appendFileSync(f.file, prompt("after twenty MiB") + name("large fixture"));
    const snapshot = async () => ({ workspaces: [{ workspace_id: "w" }], tabs: [{ workspace_id: "w", tab_id: "t", number: 1 }], panes: [{ tab_id: "t", cwd: process.cwd() }] }) as unknown as SessionSnapshot;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
      const url = new URL(request.url);
      return url.pathname === "/ping" ? new Response("pong") : handleSessionHistoryRequest(request, url, { readOnly: false, stores: f.stores, snapshot });
    } });
    const origin = `http://127.0.0.1:${server.port}`;
    const url = `${origin}/api/sessions/history?workspace_id=w&agent=pi`;
    const listing = fetch(url);
    const outcome = listing.catch((error: unknown) => error);
    try {
      await scanning.promise;
      expect(f.reader.size().active).toBeGreaterThan(0);
      expect(await (await fetch(`${origin}/ping`)).text()).toBe("pong");
      expect(bytes).toBe(0);
      release.resolve();
      const first = await listing;
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      const rows = ((await first.json()) as SessionHistoryResponse).sessions;
      expect(rows[0]).toMatchObject({ title: "large fixture", firstMessage: "after twenty MiB" });
      const size = statSync(f.file).size;
      expect(bytes).toBe(size);
      const second = await fetch(url);
      expect(second.status).toBe(200);
      expect(((await second.json()) as SessionHistoryResponse).sessions).toEqual(rows);
      expect(bytes).toBe(size);
    } finally {
      f.reader.close();
      release.resolve();
      server.stop(true);
      await outcome;
      await f.reader.idle();
    }
  }, 30_000);
});
