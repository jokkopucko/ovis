import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { loadSeen, receiveSeen, saveSeen, seenKey, subscribeSeen } from "./seenFinishes.ts";

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let data: Map<string, string>;
let writes: number;

beforeEach(() => {
  for (const key of ["window", "localStorage"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  data = new Map();
  writes = 0;
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { writes++; data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } });
});

afterEach(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const finish = { pc: "local", epoch: "e1", pane: "w1:p1", id: 3, answer: "done" };
const key = seenKey(finish.pc, finish.epoch, finish.pane);

it("stores a finish again that another tab removed while nothing here listened", () => {
  receiveSeen([finish]);
  expect(data.has(key)).toBe(true);
  data.delete(key);
  receiveSeen([finish]);
  expect(JSON.parse(data.get(key) ?? "null")).toMatchObject({ id: 3, answer: "done" });
  expect(loadSeen(finish.pc, finish.epoch)[finish.pane]).toBe(3);
});

it("reads storage for a repeated acknowledgement only while no subscriber hears other tabs", () => {
  const stop = subscribeSeen(() => {});
  try {
    saveSeen(finish.pc, finish.epoch, finish.pane, finish.id, finish.answer);
    let reads = 0;
    const getItem = localStorage.getItem.bind(localStorage);
    localStorage.getItem = (name) => { reads++; return getItem(name); };
    saveSeen(finish.pc, finish.epoch, finish.pane, finish.id, finish.answer);
    expect(reads).toBe(0);
  } finally { stop(); }
});

it("keeps a newer finish it holds when storage lost it, and writes nothing while storage still has it", () => {
  saveSeen(finish.pc, finish.epoch, finish.pane, 5, "later");
  const before = writes;
  saveSeen(finish.pc, finish.epoch, finish.pane, 3, "done");
  expect(writes).toBe(before);
  data.delete(key);
  saveSeen(finish.pc, finish.epoch, finish.pane, 3, "done");
  expect(JSON.parse(data.get(key) ?? "null")).toMatchObject({ id: 5, answer: "later" });
});

it("walks the index once for a PC with no finishes, and sees the first finish written for it", () => {
  for (let index = 0; index < 100; index++) data.set(seenKey("other", "e1", `p${index}`), JSON.stringify({ id: 1, at: index }));
  expect(loadSeen("empty", "e1")).toEqual({});
  const values = spyOn(Map.prototype, "values");
  try {
    expect(loadSeen("empty", "e1")).toEqual({});
    expect(values).not.toHaveBeenCalled();
  } finally { values.mockRestore(); }
  saveSeen("empty", "e1", "a", 2);
  expect(loadSeen("empty", "e1")).toEqual({ a: 2 });
  receiveSeen([{ pc: "empty", epoch: "e1", pane: "b", id: 1 }]);
  expect(loadSeen("empty", "e1")).toEqual({ a: 2, b: 1 });
});
