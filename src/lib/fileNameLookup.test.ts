import { describe, expect, it, jest } from "bun:test";

import { ApiError } from "./api.ts";
import { createFileNameLookup } from "./fileNameLookup.ts";

const failure = (status: number, code: string | null = status === 404 ? "not_found" : null) => new ApiError("/api/fs/stat", status, "no", code);
let scopes = 0;
function lookup({ stat, folder = () => Promise.reject(failure(400)), remote = false, turn = 1, scope = `test-${++scopes}` }: {
  stat: (name: string) => Promise<unknown>; folder?: (name: string) => Promise<unknown>; remote?: boolean; turn?: number; scope?: string;
}) {
  const asked: string[] = [];
  const listed: string[] = [];
  const names = createFileNameLookup(scope, turn, (name) => { asked.push(name); return stat(name); }, remote ? null : (name) => { listed.push(name); return folder(name); });
  return { names, asked, listed, scope };
}

describe("a bare name in a code span", () => {
  it("is nothing when the PC has no file and no folder of that name", async () => {
    const { names, asked, listed } = lookup({ stat: () => Promise.reject(failure(404)) });
    expect(await names.ask("user-1000.slice")).toBe(false);
    expect(asked).toEqual(["user-1000.slice"]);
    expect(listed).toEqual(["user-1000.slice"]);
  });

  it("is something when the PC has it, several of it, or a folder of that name", async () => {
    expect(await lookup({ stat: () => Promise.resolve({ path: "/p/README.md" }) }).names.ask("README.md")).toBe(true);
    expect(await lookup({ stat: () => Promise.resolve({ candidates: ["/p/a/README.md", "/p/b/README.md"] }) }).names.ask("README.md")).toBe(true);
    expect(await lookup({ stat: () => Promise.reject(failure(404)), folder: () => Promise.resolve({ path: "/p/conf.d" }) }).names.ask("conf.d")).toBe(true);
  });

  it("stays a link on any failure that is not a plain miss", async () => {
    for (const reason of [failure(403), failure(503), new TypeError("offline")]) {
      const { names, listed } = lookup({ stat: () => Promise.reject(reason) });
      expect(await names.ask("foo.service")).toBe(true);
      expect(listed).toEqual([]);
    }
  });

  it("stays a link, kept as found, when the PC could not read the pane's folder", async () => {
    for (const remote of [false, true]) {
      const { names, listed } = lookup({ stat: () => Promise.reject(failure(404, "pane_unknown")), remote });
      expect(await names.ask("README.md")).toBe(true);
      expect(listed).toEqual([]);
    }
  });

  it("stays a link when the folder of that name could not be asked", async () => {
    for (const reason of [failure(401), failure(403), failure(503), new TypeError("offline")]) {
      const { names, listed } = lookup({ stat: () => Promise.reject(failure(404)), folder: () => Promise.reject(reason) });
      expect(await names.ask("config.d")).toBe(true);
      expect(listed).toEqual(["config.d"]);
    }
  });

  it("on another PC, a miss is nothing without listing a folder, as the viewer lists none there", async () => {
    const { names, listed } = lookup({ stat: () => Promise.reject(failure(404)), remote: true });
    expect(await names.ask("foo.service")).toBe(false);
    expect(listed).toEqual([]);
  });

  it("is asked without its line reference", async () => {
    const { names, asked } = lookup({ stat: () => Promise.resolve({}) });
    expect(await names.ask("README.md:12")).toBe(true);
    expect(asked).toEqual(["README.md"]);
    expect(names.known("README.md#L3")).toBe(true);
  });

  it("is asked once while its answer is kept, and known at once to a row drawn again", async () => {
    const { names, asked } = lookup({ stat: () => Promise.reject(failure(404)) });
    expect(names.known("foo.service")).toBeUndefined();
    const first = names.ask("foo.service");
    expect(names.known("foo.service")).toBeUndefined();
    expect(await Promise.all([first, names.ask("foo.service")])).toEqual([false, false]);
    expect(names.known("foo.service")).toBe(false);
    expect(asked).toEqual(["foo.service"]);
  });

  it("is asked again after the agent's turn ends when it was nothing, as the agent may have written it since", async () => {
    let exists = false;
    const stat = () => exists ? Promise.resolve({}) : Promise.reject(failure(404));
    const before = lookup({ stat, turn: 1 });
    expect(await before.names.ask("notes.md")).toBe(false);
    exists = true;
    const same = lookup({ stat, turn: 1, scope: before.scope });
    expect(same.names.known("notes.md")).toBe(false);
    expect(await same.names.ask("notes.md")).toBe(false);
    expect(same.asked).toEqual([]);
    const after = lookup({ stat, turn: 2, scope: before.scope });
    expect(after.names.known("notes.md")).toBeUndefined();
    expect(await after.names.ask("notes.md")).toBe(true);
    expect(after.asked).toEqual(["notes.md"]);
    const next = lookup({ stat, turn: 3, scope: before.scope });
    expect(next.names.known("notes.md")).toBe(true);
    expect(await next.names.ask("notes.md")).toBe(true);
    expect(next.asked).toEqual([]);
  });

  it("is asked again after the agent's turn ends while its answer is still coming", async () => {
    const pending: Array<(found: boolean) => void> = [];
    const stat = () => new Promise((resolve, reject) => { pending.push((found) => found ? resolve({}) : reject(failure(404))); });
    const before = lookup({ stat, turn: 1 });
    const first = before.names.ask("notes.md");
    await Promise.resolve();
    const after = lookup({ stat, turn: 2, scope: before.scope });
    const second = after.names.ask("notes.md");
    await Promise.resolve();
    expect(after.asked).toEqual(["notes.md"]);
    pending.shift()!(false);
    pending.shift()!(true);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(after.names.known("notes.md")).toBe(true);
  });

  it("asks the PC at most four names at once", async () => {
    const pending: Array<() => void> = [];
    const { names, asked } = lookup({ stat: () => new Promise((resolve) => { pending.push(() => resolve({})); }) });
    const answers = Array.from({ length: 6 }, (_, index) => names.ask(`unit-${index}.slice`));
    await Promise.resolve();
    expect(asked).toHaveLength(4);
    pending.shift()!();
    await answers[0];
    await Promise.resolve();
    expect(asked).toHaveLength(5);
    while (pending.length > 0) { pending.shift()!(); await Promise.resolve(); await Promise.resolve(); }
    expect(await Promise.all(answers)).toEqual([true, true, true, true, true, true]);
    expect(asked).toHaveLength(6);
  });

  it("keeps the link of a name the PC does not answer, and never asks more than four at once meanwhile", async () => {
    jest.useFakeTimers();
    try {
      const stuck: Array<() => void> = [];
      const { names, asked } = lookup({ stat: (name) => name.startsWith("stuck") ? new Promise((resolve) => { stuck.push(() => resolve({})); }) : Promise.reject(failure(404)) });
      const waiting = Array.from({ length: 12 }, (_, index) => names.ask(`stuck-${index}.slice`));
      await Promise.resolve();
      for (let step = 0; step < 3; step++) { jest.advanceTimersByTime(10_000); await Promise.resolve(); await Promise.resolve(); }
      expect(await Promise.all(waiting)).toEqual(Array(12).fill(true));
      expect(asked).toHaveLength(4);
      while (stuck.length > 0) { stuck.shift()!(); await Promise.resolve(); await Promise.resolve(); }
      expect(await names.ask("later.slice")).toBe(false);
      expect(asked).toContain("later.slice");
    } finally {
      jest.useRealTimers();
    }
  });
});
