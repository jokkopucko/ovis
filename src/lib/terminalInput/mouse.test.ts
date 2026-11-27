import { expect, test } from "bun:test";
import type { TerminalInputModes } from "./input.ts";
import { dispatch, fixture, type EventFields } from "./testDom.test.ts";

// Captured from the patched xterm.js 6.0.0 CoreMouseService.
const cases: readonly (readonly [TerminalInputModes["mouseProtocol"], TerminalInputModes["mouseEncoding"], readonly string[]])[] = [
  ["none", "default", []],
  ["none", "sgr", []],
  ["none", "sgrPixels", []],
  ["x10", "default", ["\x1b[M #$"]],
  ["x10", "sgr", ["\x1b[<0;3;4M"]],
  ["x10", "sgrPixels", ["\x1b[<0;22;57M"]],
  ["vt200", "default", ["\x1b[M0#$", "\x1b[M3#$", "\x1b[Mp#$", "\x1b[Mq#$"]],
  ["vt200", "sgr", ["\x1b[<16;3;4M", "\x1b[<16;3;4m", "\x1b[<80;3;4M", "\x1b[<81;3;4M"]],
  ["vt200", "sgrPixels", ["\x1b[<16;22;57M", "\x1b[<16;22;57m", "\x1b[<80;22;57M", "\x1b[<81;22;57M"]],
  ["drag", "default", ["\x1b[M0#$", "\x1b[MP#$", "\x1b[M3#$", "\x1b[Mp#$", "\x1b[Mq#$"]],
  ["drag", "sgr", ["\x1b[<16;3;4M", "\x1b[<48;3;4M", "\x1b[<16;3;4m", "\x1b[<80;3;4M", "\x1b[<81;3;4M"]],
  ["drag", "sgrPixels", ["\x1b[<16;22;57M", "\x1b[<48;22;57M", "\x1b[<16;22;57m", "\x1b[<80;22;57M", "\x1b[<81;22;57M"]],
  ["any", "default", ["\x1b[M0#$", "\x1b[MP#$", "\x1b[M3#$", "\x1b[MS#$", "\x1b[Mp#$", "\x1b[Mq#$"]],
  ["any", "sgr", ["\x1b[<16;3;4M", "\x1b[<48;3;4M", "\x1b[<16;3;4m", "\x1b[<51;3;4M", "\x1b[<80;3;4M", "\x1b[<81;3;4M"]],
  ["any", "sgrPixels", ["\x1b[<16;22;57M", "\x1b[<48;22;57M", "\x1b[<16;22;57m", "\x1b[<51;22;57M", "\x1b[<80;22;57M", "\x1b[<81;22;57M"]],
];

for (const [protocol, encoding, bytes] of cases) {
  test(`${protocol} / ${encoding} reports press, drag, release, hover and wheel`, () => {
    using e = disposableFixture();
    e.modes.mouseProtocol = protocol;
    e.modes.mouseEncoding = encoding;
    const { element } = e.host;
    const bin: string[] = [];
    e.term.onBinary((text) => bin.push(text));
    const user: string[] = [];
    e.term.onUserInput(() => user.push("user"));
    const point = { clientX: 22, clientY: 57, ctrlKey: true };
    dispatch(element, "mousedown", { ...point, buttons: 1 });
    dispatch(e.page, "mousemove", { ...point, buttons: 1 });
    dispatch(e.page, "mouseup", point);
    dispatch(element, "mousemove", point);
    dispatch(element, "wheel", { ...point, deltaMode: 1, deltaY: -1 });
    dispatch(element, "wheel", { ...point, deltaMode: 1, deltaY: 1 });
    expect(bin).toEqual(encoding === "default" ? [...bytes] : []);
    expect(e.sent).toEqual(encoding === "default" ? [] : [...bytes]);
    expect(user).toHaveLength(e.sent.length);
    expect(element.classList.contains("enable-mouse-events")).toBe(protocol !== "none");
  });
}

function disposableFixture() {
  const e = fixture({ cell: { width: 10, height: 16 } });
  return { ...e, [Symbol.dispose]: () => e.term.dispose() };
}

test("no-scrollback wheel accumulates pixels without the trackpad discount or Ctrl multiplier", () => {
  using e = disposableFixture();
  e.modes.alternateScreen = true;
  e.modes.applicationCursorKeys = true;
  const wheel = (fields: EventFields) => dispatch(e.host.element, "wheel", { deltaMode: 0, ...fields });
  wheel({ deltaY: -4, ctrlKey: true });
  expect(e.sent).toEqual([]);
  wheel({ deltaY: -12 });
  wheel({ deltaY: 4, altKey: true });
  wheel({ deltaY: 100, shiftKey: true });
  expect(e.sent).toEqual(["\x1bOA", "\x1bOB"]);
});

test("custom wheel handler vetoes a report but xterm still cancels a reporting wheel", () => {
  using e = disposableFixture();
  e.modes.mouseProtocol = "any";
  e.modes.mouseEncoding = "sgr";
  e.term.attachCustomWheelEventHandler(() => false);
  const ev = dispatch(e.host.element, "wheel", { clientX: 20, clientY: 20, deltaMode: 1, deltaY: 1 });
  expect(e.sent).toEqual([]);
  expect(ev.defaultPrevented).toBe(true);
});

test("mouse modes change live and a disabled protocol releases a document drag", () => {
  using e = disposableFixture();
  const { element } = e.host;
  e.modes.mouseProtocol = "drag";
  e.modes.mouseEncoding = "sgr";
  dispatch(element, "mousedown", { clientX: 22, clientY: 57, buttons: 1 });
  e.modes.mouseProtocol = "none";
  e.term.cursorMoved();
  expect(element.classList.contains("enable-mouse-events")).toBe(false);
  e.modes.mouseProtocol = "any";
  e.modes.mouseEncoding = "sgrPixels";
  dispatch(e.page, "mousemove", { clientX: 32, clientY: 57, buttons: 1 });
  dispatch(element, "mousemove", { clientX: 32, clientY: 57 });
  expect(e.sent).toEqual(["\x1b[<0;3;4M", "\x1b[<35;32;57M"]);
});

test("read-only blocks both binary and SGR reports", () => {
  using e = disposableFixture();
  const { element } = e.host;
  const binary: string[] = [];
  e.term.onBinary((data) => binary.push(data));
  e.modes.mouseProtocol = "vt200";
  e.term.disableStdin = true;
  dispatch(element, "mousedown", { clientX: 22, clientY: 57, buttons: 1 });
  e.modes.mouseEncoding = "sgr";
  dispatch(element, "mousedown", { clientX: 22, clientY: 57, buttons: 1 });
  expect([binary, e.sent]).toEqual([[], []]);
});
