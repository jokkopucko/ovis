import { expect, test } from "bun:test";

import { applyHealthRead, healthFreshness, machineHealth, type HealthBook } from "./healthPresentation.ts";

interface Identity { version: string; terminal_attach?: boolean }
const WINDOWS: Identity = { version: "0.9.5", terminal_attach: false };
const ok = (value: Identity) => ({ ok: true, value }) as const;
const failed = { ok: false } as const;
const empty: HealthBook<Identity> = new Map();

test("one failure after success is unknown not offline", () => {
  let book = applyHealthRead(empty, "local", 1, ok(WINDOWS));
  expect(healthFreshness(machineHealth(book, "local"))).toBe("fresh");
  book = applyHealthRead(book, "local", 2, failed);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unknown");
  expect(machineHealth(book, "local").confirmed).toBe(WINDOWS);
  book = applyHealthRead(book, "local", 3, failed);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unavailable");
});

test("success resets the failure run", () => {
  let book = applyHealthRead(empty, "local", 1, ok(WINDOWS));
  book = applyHealthRead(book, "local", 2, failed);
  book = applyHealthRead(book, "local", 3, ok(WINDOWS));
  expect(machineHealth(book, "local").failures).toBe(0);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("fresh");
  book = applyHealthRead(book, "local", 4, failed);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unknown");
});

test("older failed read cannot replace newer success", () => {
  let book = applyHealthRead(empty, "local", 1, ok(WINDOWS));
  const newer = { version: "0.9.6", terminal_attach: false };
  book = applyHealthRead(book, "local", 3, ok(newer));
  const settled = book;
  book = applyHealthRead(book, "local", 2, failed);
  expect(book).toBe(settled);
  expect(machineHealth(book, "local")).toEqual({ confirmed: newer, failures: 0, answered: 3, failed: [] });
  expect(applyHealthRead(book, "local", 2, ok(WINDOWS))).toBe(settled);
});

test("older success after newer failure still brings capabilities", () => {
  let book = applyHealthRead(empty, "local", 2, failed);
  book = applyHealthRead(book, "local", 1, ok(WINDOWS));
  expect(machineHealth(book, "local").confirmed).toBe(WINDOWS);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unknown");
  book = applyHealthRead(book, "local", 3, failed);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unavailable");
  expect(machineHealth(book, "local").confirmed?.terminal_attach).toBe(false);
});

test("failures that complete in reverse order both count", () => {
  let book = applyHealthRead(empty, "local", 1, ok(WINDOWS));
  book = applyHealthRead(book, "local", 3, failed);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unknown");
  book = applyHealthRead(book, "local", 2, failed);
  expect(machineHealth(book, "local").failures).toBe(2);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unavailable");
  expect(machineHealth(book, "local").confirmed).toBe(WINDOWS);
});

test("a late success keeps only the failures newer than it", () => {
  const later = { version: "0.9.6", terminal_attach: false };
  let book = applyHealthRead(empty, "local", 1, ok(WINDOWS));
  book = applyHealthRead(book, "local", 2, failed);
  book = applyHealthRead(book, "local", 4, failed);
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unavailable");
  book = applyHealthRead(book, "local", 3, ok(later));
  expect(machineHealth(book, "local")).toEqual({ confirmed: later, failures: 1, answered: 3, failed: [4] });
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unknown");
  expect(applyHealthRead(book, "local", 2, failed)).toBe(book);
  let cold = applyHealthRead(empty, "local", 1, failed);
  cold = applyHealthRead(cold, "local", 3, failed);
  cold = applyHealthRead(cold, "local", 2, ok(WINDOWS));
  expect(machineHealth(cold, "local")).toEqual({ confirmed: WINDOWS, failures: 1, answered: 2, failed: [3] });
  expect(healthFreshness(machineHealth(cold, "local"))).toBe("unknown");
});

test("machines never share stale identity", () => {
  let book = applyHealthRead(empty, "local", 1, ok(WINDOWS));
  book = applyHealthRead(book, "local", 2, failed);
  book = applyHealthRead(book, "remote", 1, failed);
  expect(machineHealth(book, "remote")).toEqual({ confirmed: null, failures: 1, answered: 0, failed: [1] });
  expect(healthFreshness(machineHealth(book, "remote"))).toBe("unknown");
  expect(machineHealth(book, "never-read")).toEqual({ confirmed: null, failures: 0, answered: 0, failed: [] });
  expect(healthFreshness(machineHealth(book, "never-read"))).toBe("pending");
  expect(machineHealth(book, "local").confirmed).toBe(WINDOWS);
  expect(machineHealth(book, "local").failures).toBe(1);
});

test("presentation grace cannot change capability evidence", () => {
  let book = applyHealthRead(empty, "local", 1, ok(WINDOWS));
  for (let read = 2; read < 8; read++) {
    book = applyHealthRead(book, "local", read, failed);
    expect(machineHealth(book, "local").confirmed?.terminal_attach).toBe(false);
  }
  expect(healthFreshness(machineHealth(book, "local"))).toBe("unavailable");
  const cold = applyHealthRead(empty, "local", 1, failed);
  expect(machineHealth(cold, "local").confirmed).toBeNull();
  expect(healthFreshness(machineHealth(cold, "local"))).toBe("unknown");
});
