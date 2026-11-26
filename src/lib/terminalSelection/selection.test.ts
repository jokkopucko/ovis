import { expect, test } from "bun:test";
import { terminal } from "./fixture.test-support.ts";
import { createSelection } from "./index.ts";

test("drag redraws immediately, then publishes the inclusive/exclusive buffer position on release", () => {
  const { host, mouse } = terminal(["old", "alpha beta", "0123456789", "abcdefghij"], { viewport: 1 });
  using selection = disposable(createSelection(host));
  const redraws: (ReturnType<typeof selection.drawnSelection>)[] = [];
  const changes: string[] = [];
  selection.onRedraw(() => redraws.push(selection.drawnSelection()));
  selection.onSelectionChange(() => changes.push(selection.getSelection()));

  mouse("mousedown", [12, 3]);
  mouse("mousemove", [27, 23]);
  expect(redraws.at(-1)).toEqual({ start: [1, 1], end: [3, 2], column: false });
  expect(changes).toEqual([]);
  mouse("mouseup", [27, 23]);

  expect(selection.getSelectionPosition()).toEqual({ start: { x: 1, y: 1 }, end: { x: 3, y: 2 } });
  expect(changes).toEqual(["lpha beta\n012"]);
});

test.each([
  { detail: 2, point: [23, 3], text: "alpha", wrapped: [] },
  { detail: 3, point: [23, 23], text: "alpha beta0123456789", wrapped: [1] },
] satisfies { detail: number; point: [number, number]; text: string; wrapped: number[] }[])(
  "selects $text when click count is $detail", ({ detail, point, text, wrapped }) => {
    const { host, click } = terminal(undefined, { wrapped });
    using selection = disposable(createSelection(host));
    click(point, { detail });
    expect(selection.getSelection()).toBe(text);
  },
);

test("double-click drag keeps the anchor word and expands backwards to whole words", () => {
  const { host, mouse } = terminal();
  using selection = disposable(createSelection(host));
  mouse("mousedown", [72, 3], { detail: 2 });
  mouse("mousemove", [22, 3]);
  mouse("mouseup", [22, 3]);
  expect(selection.getSelection()).toBe("alpha beta");
});

test("shift-click extends from the original anchor", () => {
  const { host, click } = terminal();
  using selection = disposable(createSelection(host));
  click([12, 3]);
  click([47, 3], { shiftKey: true });
  expect(selection.getSelection()).toBe("lpha");
});

test.each([
  { platform: "Linux", metaKey: false, column: true, expected: "pha\n234" },
  { platform: "MacIntel", metaKey: true, column: true, expected: "pha\n234" },
  { platform: "MacIntel", metaKey: false, column: false, expected: " beta\n01" },
])("Alt drag on $platform with Meta=$metaKey yields column=$column", ({ platform, metaKey, column, expected }) => {
  const { host, mouse } = terminal(undefined, { platform });
  using selection = disposable(createSelection(host));
  mouse("mousedown", [47, 3], { altKey: true, metaKey });
  mouse("mousemove", [22, 23], { altKey: true, metaKey });
  mouse("mouseup", [22, 23], { altKey: true, metaKey });
  expect(selection.drawnSelection()?.column).toBe(column);
  expect(selection.getSelection()).toBe(expected);
});

test.each([
  { platform: "Linux", modifier: { shiftKey: true } },
  { platform: "MacIntel", modifier: { altKey: true } },
])("forces ordinary selection with the platform modifier on $platform even while mouse reporting", ({ platform, modifier }) => {
  const { host, mouse, reporting, body } = terminal(undefined, { platform });
  using selection = disposable(createSelection(host));
  reporting.mouse = true;
  let reported = false;
  body.addEventListener("mousedown", () => { reported = true; });
  const down = mouse("mousedown", [2, 3], modifier);
  mouse("mousemove", [47, 3], modifier);
  mouse("mouseup", [47, 3], modifier);
  expect(down.defaultPrevented).toBe(true);
  expect(reported).toBe(false);
  expect(selection.getSelection()).toBe("alpha");
});

test("leaves a normal reporting press and drag untouched", () => {
  const { host, mouse, reporting, body } = terminal();
  using selection = disposable(createSelection(host));
  reporting.mouse = true;
  let presses = 0;
  body.addEventListener("mousedown", () => { presses++; });
  const down = mouse("mousedown", [2, 3]);
  mouse("mousemove", [47, 3]);
  mouse("mouseup", [47, 3]);
  expect([down.defaultPrevented, presses, selection.hasSelection()]).toEqual([false, 1, false]);
});

test.each(["input", "alternate"] as const)("clears selection on %s", (cause) => {
  const { host, input, reporting } = terminal();
  using selection = disposable(createSelection(host));
  selection.select(0, 0, 5);
  if (cause === "input") input();
  else { reporting.alternate = true; selection.refresh(); }
  expect(selection.getSelectionPosition()).toBeUndefined();
});

test("select and clear notify listeners, and unsubscribe stops notifications", () => {
  const { host } = terminal();
  using selection = disposable(createSelection(host));
  const changes: string[] = [];
  const unsubscribe = selection.onSelectionChange(() => changes.push(selection.getSelection()));
  selection.select(6, 0, 4);
  selection.clearSelection();
  unsubscribe();
  selection.select(0, 0, 5);
  expect(changes).toEqual(["beta", ""]);
});

test("line and all selection use CRLF on Windows and include the last cell without an extra newline", () => {
  const { host } = terminal(["old", "alpha beta", "0123456789", "abcdefghij"], { viewport: 1, platform: "Win32" });
  using selection = disposable(createSelection(host));
  selection.selectLines(1, 2);
  expect(selection.getSelection()).toBe("alpha beta\r\n0123456789");
  selection.selectAll();
  expect(selection.getSelection()).toBe("old\r\nalpha beta\r\n0123456789\r\nabcdefghij");
});

test("updates the Linux primary selection on a mouse drag before release", () => {
  const { host, mouse } = terminal(undefined, { platform: "Linux x86_64" });
  using selection = disposable(createSelection(host));
  const primary: string[] = [];
  selection.onLinuxMouseSelection((text) => primary.push(text));
  mouse("mousedown", [2, 3]);
  mouse("mousemove", [27, 3]);
  expect(primary).toEqual(["alp"]);
});

test("edge dragging scrolls on a timer and stops on release", () => {
  const { host, mouse, scrolls, page, tick } = terminal(["old", "alpha beta", "0123456789", "abcdefghij"], { viewport: 1 });
  using selection = disposable(createSelection(host));
  mouse("mousedown", [12, 3]);
  mouse("mousemove", [12, -1], {}, page);
  tick();
  mouse("mouseup", [12, -1], {}, page);
  tick();
  expect(scrolls).toEqual([-1]);
  expect(selection.getSelectionPosition()).toEqual({ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } });
});

test("viewport scroll keeps buffer endpoints while a reported trim moves them", () => {
  const { host, trim } = terminal(["old", "alpha beta", "0123456789", "abcdefghij"], { viewport: 1 });
  using selection = disposable(createSelection(host));
  selection.select(6, 1, 4);
  host.scrollLines(-1);
  selection.refresh();
  expect(selection.getSelectionPosition()).toEqual({ start: { x: 6, y: 1 }, end: { x: 10, y: 1 } });
  trim(1);
  selection.refresh(1);
  expect(selection.getSelectionPosition()).toEqual({ start: { x: 6, y: 0 }, end: { x: 10, y: 0 } });
  expect(selection.getSelection()).toBe("beta");
});

function disposable<T extends { dispose(): void }>(value: T): T & Disposable {
  return Object.assign(value, { [Symbol.dispose]: () => value.dispose() });
}
