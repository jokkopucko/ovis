import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Baselines = { token: string; before: Record<string, string | null> };
type Carry = (storage: Storage, carried: Record<string, string>, shared: boolean, token: string, loaded?: boolean, given?: Record<string, string | null> | null, post?: (baselines: Baselines) => void) => void;
const source = readFileSync(join(import.meta.dir, "..", "app", "mac", "Resources", "carry-drafts.js"), "utf8");
const carry = new Function(`${source}\nreturn ovisCarryDrafts;`)() as Carry;

/** A page's localStorage; `full` keys refuse writes, as a store over its quota does. */
function store(entries: Record<string, string>, full = new Set<string>()): Storage & { entries: Map<string, string> } {
  const map = new Map(Object.entries(entries));
  return {
    entries: map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { if (full.has(key)) throw new DOMException("quota", "QuotaExceededError"); map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
  };
}
const draft = "ovis:composer-draft:w1:p1";
const lease = "ovis:composer-sending:w1:p1";
const landed = (page: { entries: Map<string, string> }) => JSON.parse(page.entries.get("ovis-mac:carried") ?? "null");

describe("Mac app draft carry", () => {
  test("replaces the older copies, ends the new origin's own sends and keeps everything else", () => {
    const page = store({ [draft]: "older visit", "ovis:composer-sending:w9:p9": "{}", "ovis:queue:w2:p2": "its own", "ovis:settings": "{}" });
    carry(page, { [draft]: "typed on the old port", [lease]: "{\"sent\":\"a\"}" }, false, "t1");
    expect(Object.fromEntries(page.entries)).toEqual({
      [draft]: "typed on the old port", [lease]: "{\"sent\":\"a\"}", "ovis:queue:w2:p2": "its own", "ovis:settings": "{}",
      "ovis-mac:carried": JSON.stringify({ token: "t1", done: [draft, lease], before: { [draft]: "older visit", [lease]: null } }),
    });
  });

  test("a write that fails is not marked done, and the next run of the same carry writes it", () => {
    const full = new Set([draft]);
    const page = store({}, full);
    carry(page, { [draft]: "typed on the old port", "ovis:terminal-line:w1:p1": "ls" }, false, "t1");
    expect(page.entries.has(draft)).toBe(false);
    expect(landed(page).done).toEqual(["ovis:terminal-line:w1:p1"]);
    full.clear();
    page.setItem("ovis:terminal-line:w1:p1", "ls -la");
    carry(page, { [draft]: "typed on the old port", "ovis:terminal-line:w1:p1": "ls" }, false, "t1");
    expect(page.entries.get(draft)).toBe("typed on the old port");
    expect(page.entries.get("ovis:terminal-line:w1:p1")).toBe("ls -la");
    expect(landed(page).done).toEqual(["ovis:terminal-line:w1:p1", draft]);
  });

  test("an overwrite that fails once is written by the next run while the key still holds the older copy", () => {
    const full = new Set([draft]);
    const page = store({ [draft]: "older visit" }, full);
    carry(page, { [draft]: "typed on the old port" }, false, "t1");
    expect(page.entries.get(draft)).toBe("older visit");
    expect(landed(page).done).toEqual([]);
    full.clear();
    carry(page, { [draft]: "typed on the old port" }, false, "t1");
    expect(page.entries.get(draft)).toBe("typed on the old port");
    expect(landed(page).done).toEqual([draft]);
  });

  test("a second run of the same carry leaves what the page typed since, even in a key that had not landed", () => {
    const full = new Set([draft]);
    const page = store({}, full);
    carry(page, { [draft]: "typed on the old port" }, false, "t1");
    full.clear();
    page.setItem(draft, "typed on the new port");
    carry(page, { [draft]: "typed on the old port" }, false, "t1");
    expect(page.entries.get(draft)).toBe("typed on the new port");
    expect(landed(page).done).toEqual([draft]);
  });

  function afterFailedMark(between: (page: ReturnType<typeof store>) => void) {
    const full = new Set(["ovis-mac:carried"]);
    const page = store({ [draft]: "older visit" }, full);
    const posted: Baselines[] = [];
    carry(page, { [draft]: "typed on the old port" }, false, "t1", false, null, (baselines) => posted.push(baselines));
    expect(page.entries.get(draft)).toBe("older visit");
    expect(posted).toEqual([{ token: "t1", before: { [draft]: "older visit" } }]);
    full.clear();
    between(page);
    carry(page, { [draft]: "typed on the old port" }, false, "t1", true, posted[0]!.before);
    carry(page, { [draft]: "typed on the old port" }, false, "t1", true, posted[0]!.before);
    return page;
  }

  test("after a first mark that did not fit and the page loading, the retry replaces the unchanged older copy", () => {
    const page = afterFailedMark(() => {});
    expect(page.entries.get(draft)).toBe("typed on the old port");
    expect(landed(page).done).toEqual([draft]);
  });

  test("after a first mark that did not fit and the page loading, a draft discarded meanwhile stays discarded", () => {
    const page = afterFailedMark((page) => page.removeItem(draft));
    expect(page.entries.has(draft)).toBe(false);
    expect(landed(page).done).toEqual([draft]);
  });

  test("once the page has loaded, a carry that never started only fills keys the page holds none of", () => {
    const page = store({ [draft]: "typed after the page loaded", "ovis:composer-sending:w9:p9": "{}" });
    carry(page, { [draft]: "typed on the old port", "ovis:queue:w2:p2": "held" }, false, "t1", true);
    expect(page.entries.get(draft)).toBe("typed after the page loaded");
    expect(page.entries.get("ovis:queue:w2:p2")).toBe("held");
    expect(page.entries.get("ovis:composer-sending:w9:p9")).toBe("{}");
  });

  test("a carry that cannot write its mark writes nothing, so no later run can write over the page", () => {
    const page = store({ [draft]: "older visit", "ovis:composer-sending:w9:p9": "{}" }, new Set(["ovis-mac:carried"]));
    carry(page, { [draft]: "typed on the old port" }, false, "t1");
    expect(Object.fromEntries(page.entries)).toEqual({ [draft]: "older visit", "ovis:composer-sending:w9:p9": "{}" });
  });

  test("with a window of the page still open there, a carried key only fills a gap and no send is ended", () => {
    const page = store({ [draft]: "the open window's", "ovis:composer-sending:w9:p9": "{}" });
    carry(page, { [draft]: "typed on the old port", "ovis:queue:w2:p2": "held" }, true, "t1");
    expect(page.entries.get(draft)).toBe("the open window's");
    expect(page.entries.get("ovis:composer-sending:w9:p9")).toBe("{}");
    expect(page.entries.get("ovis:queue:w2:p2")).toBe("held");
  });
});
