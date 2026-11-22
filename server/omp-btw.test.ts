import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleBtwRequest, ompBtwTopics } from "./omp-btw.ts";

// the records OMP 18.14 saves for a /btw topic (packages/coding-agent/src/session/btw-history.ts; synthetic content)
const exchange = (question: string, answer: string, createdAt: number, status = "complete") => ({ question, answer, status, createdAt, updatedAt: createdAt + 1000 });
const topic = (id: string, createdAt: number, extra: Record<string, unknown> = {}) => ({ ...exchange(`question ${id}`, `answer ${id}`, createdAt), id, leafId: "637ac31c", ...extra });

describe("ompBtwTopics", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "ovis-btw-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const session = (name: string): { transcript: string; history: string } => {
    const transcript = join(root, `${name}.jsonl`);
    writeFileSync(transcript, "");
    const history = join(root, name, "btw-history");
    mkdirSync(history, { recursive: true });
    return { transcript, history };
  };
  const save = (history: string, record: Record<string, unknown>, name = `entry-${String(record["id"])}.json`) => writeFileSync(join(history, name), JSON.stringify(record));

  it("lists the main session's saved topics newest first, with their titles and follow-ups, and no pictures", () => {
    const { transcript, history } = session("listed");
    save(history, topic("aaa", 1_792_642_086_836, { images: [{ type: "image", data: "AAAA", mimeType: "image/png" }], followUps: [exchange("and then?", "then this", 1_792_642_095_925), exchange("still going?", "", 1_792_642_099_000, "running")] }));
    save(history, topic("bbb", 1_792_642_171_669, { status: "error", error: "model refused" }));
    writeFileSync(join(history, "entry-aaa.title"), "Named topic");

    expect(ompBtwTopics(transcript).topics).toEqual([
      { id: "bbb", title: null, question: "question bbb", answer: "answer bbb", status: "error", error: "model refused", at: new Date(1_792_642_171_669).toISOString(), follow_ups: [] },
      {
        id: "aaa", title: "Named topic", question: "question aaa", answer: "answer aaa", status: "complete", error: null, at: new Date(1_792_642_086_836).toISOString(),
        follow_ups: [
          { question: "and then?", answer: "then this", status: "complete", error: null, at: new Date(1_792_642_095_925).toISOString() },
          { question: "still going?", answer: "", status: "running", error: null, at: new Date(1_792_642_099_000).toISOString() },
        ],
      },
    ]);
  });

  it("reads only well-formed topic files of the main session: not a subagent's history, a lock, a link or a record OMP would refuse", () => {
    const { transcript, history } = session("guarded");
    save(history, topic("kept", 1));
    mkdirSync(join(history, "sessions", "sub"), { recursive: true });
    save(join(history, "sessions", "sub"), topic("subagent", 2));
    save(history, topic("other", 3), "entry-renamed.json");
    save(history, { ...topic("bad", 4), status: "thinking" });
    save(history, { ...topic("extra", 5), surprise: true });
    writeFileSync(join(history, "entry-broken.json"), "{");
    writeFileSync(join(history, "entry-locked.json.lock"), "");
    const outside = join(root, "outside.json");
    writeFileSync(outside, JSON.stringify(topic("linked", 6)));
    symlinkSync(outside, join(history, "entry-linked.json"));

    expect(ompBtwTopics(transcript).topics.map((found) => found.id)).toEqual(["kept"]);
  });

  it("reads only the hundred most recently written topics and a short title, and none through a linked history folder", () => {
    const { transcript, history } = session("bounded");
    for (let index = 0; index < 101; index++) {
      save(history, topic(`n${index}`, 1000 + index));
      const written = new Date(Date.UTC(2026, 10, 1) + index * 1000);
      utimesSync(join(history, `entry-n${index}.json`), written, written);
    }
    save(history, topic("n0", 999_999));
    utimesSync(join(history, "entry-n0.json"), new Date(Date.UTC(2026, 9, 1)), new Date(Date.UTC(2026, 9, 1)));
    writeFileSync(join(history, "entry-n100.title"), "t".repeat(5000));
    const read = ompBtwTopics(transcript).topics;
    expect(read).toHaveLength(100);
    expect(read.map((found) => found.id)).not.toContain("n0");
    expect(read[0]).toMatchObject({ id: "n100", title: null });

    const linked = join(root, "linked.jsonl");
    writeFileSync(linked, "");
    mkdirSync(join(root, "linked"));
    symlinkSync(history, join(root, "linked", "btw-history"));
    expect(ompBtwTopics(linked).topics).toEqual([]);
  });

  it("keeps what it answers and remembers to a bounded amount of text, the most recently written first", () => {
    const { transcript, history } = session("wordy");
    for (let index = 0; index < 40; index++) {
      save(history, { ...topic(`w${index}`, 1000 + index), answer: "a".repeat(150 * 1024) });
      const written = new Date(Date.UTC(2026, 10, 1) + index * 1000);
      utimesSync(join(history, `entry-w${index}.json`), written, written);
    }
    for (let poll = 0; poll < 3; poll++) {
      const read = ompBtwTopics(transcript).topics;
      expect(read.length).toBeLessThan(40);
      expect(read.reduce((sum, found) => sum + found.answer.length, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
      expect(read[0]?.id).toBe("w39");
    }
  });

  it("reads a topic again when its file is replaced, even at the same size and time", () => {
    const { transcript, history } = session("replaced");
    const when = new Date(Date.UTC(2026, 10, 1));
    save(history, { ...topic("r1", 1), answer: "first" });
    utimesSync(join(history, "entry-r1.json"), when, when);
    expect(ompBtwTopics(transcript).topics[0]?.answer).toBe("first");
    // a kernel stamping files from a coarse clock (WSL2 ticks at 250 Hz) gives a rewrite within the same
    // tick the old change time too; rewrite until it moves, as it has for any later real rewrite
    const before = statSync(join(history, "entry-r1.json"), { bigint: true }).ctimeNs;
    do {
      save(history, { ...topic("r1", 1), answer: "again" });
      utimesSync(join(history, "entry-r1.json"), when, when);
    } while (statSync(join(history, "entry-r1.json"), { bigint: true }).ctimeNs === before);
    expect(ompBtwTopics(transcript).topics[0]?.answer).toBe("again");
  });

  it("answers none for a session that never used /btw", () => {
    const transcript = join(root, "quiet.jsonl");
    writeFileSync(transcript, "");
    expect(ompBtwTopics(transcript).topics).toEqual([]);
  });
});

describe("GET /api/pane/btw hard caps", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "ovis-btw-caps-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const history = (name: string): { transcript: string; folder: string } => {
    const transcript = join(root, `${name}.jsonl`);
    writeFileSync(transcript, "");
    const folder = join(root, name, "btw-history");
    mkdirSync(folder, { recursive: true });
    return { transcript, folder };
  };
  const answer = async (transcript: string): Promise<{ bytes: number; body: { topics: { id: string; follow_ups: unknown[] }[]; more: boolean } }> => {
    const url = new URL("http://localhost/api/pane/btw?pane_id=w1:p1");
    const text = await (await handleBtwRequest(new Request(url), url, url.pathname, { transcript: async () => transcript }))!.text();
    return { bytes: Buffer.byteLength(text), body: JSON.parse(text) };
  };

  it("answers at most a megabyte, saying there is more, for a topic with 300,000 empty follow-ups", async () => {
    const { transcript, folder } = history("followups");
    const empty = exchange("", "", 1);
    writeFileSync(join(folder, "entry-x.json"), JSON.stringify({ ...topic("x", 1), followUps: Array.from({ length: 300_000 }, () => empty) }));
    const { bytes, body } = await answer(transcript);
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(body.more).toBe(true);
  });

  it("keeps a topic's first 200 follow-ups and says there are more", async () => {
    const { transcript, folder } = history("long-thread");
    writeFileSync(join(folder, "entry-y.json"), JSON.stringify({ ...topic("y", 1), followUps: Array.from({ length: 1000 }, (_, index) => exchange(`q${index}`, "a", index)) }));
    const { body } = await answer(transcript);
    expect(body.topics.map((found) => [found.id, found.follow_ups.length])).toEqual([["y", 200]]);
    expect(body.more).toBe(true);
  });

  it("shows a topic whose question carries a screenshot of several megabytes, without the picture", async () => {
    const { transcript, folder } = history("screenshot");
    writeFileSync(join(folder, "entry-s.json"), JSON.stringify({ ...topic("s", 1), images: [{ type: "image", data: "A".repeat(6 * 1024 * 1024), mimeType: "image/png" }] }));
    const { bytes, body } = await answer(transcript);
    expect(body.topics.map((found) => found.id)).toEqual(["s"]);
    expect(body.more).toBe(false);
    expect(bytes).toBeLessThan(4096);
  });

  it("skips a topic file of too many items to parse cheaply, such as a million discarded pictures, and says so", async () => {
    const { transcript, folder } = history("pictures");
    writeFileSync(join(folder, "entry-p.json"), JSON.stringify({ ...topic("p", 2), images: Array.from({ length: 1_000_000 }, () => ({})) }));
    writeFileSync(join(folder, "entry-q.json"), JSON.stringify(topic("q", 1)));
    const { body } = await answer(transcript);
    expect(body.topics.map((found) => found.id)).toEqual(["q"]);
    expect(body.more).toBe(true);
  });

  it("counts the first item of every container, so nested single-item arrays cannot pass for half their items", async () => {
    const { transcript, folder } = history("nested");
    const chain = JSON.parse(`${"[".repeat(10)}{}${"]".repeat(10)}`);
    writeFileSync(join(folder, "entry-n.json"), JSON.stringify({ ...topic("n", 2), images: Array.from({ length: 1500 }, () => chain) }));
    writeFileSync(join(folder, "entry-q.json"), JSON.stringify(topic("q", 1)));
    const { body } = await answer(transcript);
    expect(body.topics.map((found) => found.id)).toEqual(["q"]);
    expect(body.more).toBe(true);
  });

  it("stops listing a folder of thousands of topic files, and says it stopped", async () => {
    const { transcript, folder } = history("crowded");
    for (let index = 0; index < 5000; index++) writeFileSync(join(folder, `entry-f${index}.json`), JSON.stringify(topic(`f${index}`, index)));
    const { body } = await answer(transcript);
    expect(body.more).toBe(true);
    expect(body.topics.length).toBeLessThanOrEqual(100);
  });
});

describe("GET /api/pane/btw", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "ovis-btw-route-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const ask = (path: string, transcript: (paneId: string) => Promise<string | null>, method = "GET") => {
    const url = new URL(`http://localhost${path}`);
    return handleBtwRequest(new Request(url, { method }), url, url.pathname, { transcript });
  };

  it("answers the topics of the pane's own OMP session, none for a pane without one, and refuses a bad request", async () => {
    const transcript = join(root, "pane.jsonl");
    writeFileSync(transcript, "");
    mkdirSync(join(root, "pane", "btw-history"), { recursive: true });
    writeFileSync(join(root, "pane", "btw-history", "entry-t1.json"), JSON.stringify(topic("t1", 10)));
    const panes = async (paneId: string) => paneId === "w1:p1" ? transcript : null;

    const found = await ask("/api/pane/btw?pane_id=w1:p1", panes);
    expect(found?.status).toBe(200);
    expect(((await found?.json()) as { topics: { id: string }[] }).topics.map((entry) => entry.id)).toEqual(["t1"]);
    expect(await (await ask("/api/pane/btw?pane_id=w1:p2", panes))?.json()).toEqual({ topics: [], more: false });
    expect((await ask("/api/pane/btw", panes))?.status).toBe(400);
    expect((await ask("/api/pane/btw?pane_id=w1:p1", panes, "POST"))?.status).toBe(400);
    expect(await ask("/api/pane/plan?pane_id=w1:p1", panes)).toBeNull();
  });
});
