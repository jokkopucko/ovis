import { describe, expect, it } from "bun:test";
import { BrowserResults, MAX_RESULTS, type BrowserResult } from "./browserResults.ts";

function download(id: string, profile: BrowserResult["profile"] = "agent"): BrowserResult {
  return { id, kind: "download", name: `${id}.bin`, at: 0, bytes: null, done: false, tab: null, profile };
}

describe("the built-in browser's kept downloads", () => {
  it("keeps every finished one when a download already pushed out of the list fails late", () => {
    const results = new BrowserResults();
    results.add(download("d1-mine", "mine"), "/kept/mine");
    const finished = Array.from({ length: MAX_RESULTS }, (_, n) => `d${n + 1}-agent`);
    for (const id of finished) {
      results.add(download(id), `/kept/${id}`);
      results.finish(id, 1);
    }
    results.drop("d1-mine");
    expect(results.list().map(({ id }) => id)).toEqual([...finished].reverse());
    expect(finished.every((id) => results.path(id) === `/kept/${id}`)).toBe(true);
  });

  it("shows only a finished one in its folder, and forgets a failed one", () => {
    const results = new BrowserResults();
    results.add(download("d1-mine", "mine"), "/kept/a");
    results.add(download("d2-mine", "mine"), "/kept/b");
    expect(results.path("d1-mine")).toBeNull();
    results.finish("d1-mine", 10);
    results.drop("d2-mine");
    expect(results.list()).toEqual([{ ...download("d1-mine", "mine"), done: true, bytes: 10 }]);
    expect(results.path("d1-mine")).toBe("/kept/a");
    expect(results.path("unknown")).toBeNull();
  });
});
