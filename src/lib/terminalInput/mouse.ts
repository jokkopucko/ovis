// Copyright (c) The xterm.js authors. MIT License.
// Adapted for Ovis.

import { C0 } from "./controls.ts";
import type { TerminalInputHost, TerminalInputModes } from "./input.ts";
import type { InputPlatform } from "./platform.ts";

type Encoding = TerminalInputModes["mouseEncoding"];
type Coords = { readonly col: number; readonly row: number; readonly x: number; readonly y: number };
const Button = { LEFT: 0, MIDDLE: 1, RIGHT: 2, NONE: 3, WHEEL: 4 } as const;
const Action = { UP: 0, DOWN: 1, MOVE: 32 } as const;
type Report = Coords & {
  readonly button: number;
  readonly action: typeof Action[keyof typeof Action];
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
};

function getMouseReportCoords(ev: MouseEvent, host: TerminalInputHost): Coords | undefined {
  const screen = host.screen;
  const { width, height } = host.cell();
  if (!(width > 0 && height > 0)) return;
  const rect = screen.getBoundingClientRect();
  const css = screen.ownerDocument.defaultView?.getComputedStyle(screen);
  const left = parseInt(css?.getPropertyValue("padding-left") ?? "", 10) || 0;
  const top = parseInt(css?.getPropertyValue("padding-top") ?? "", 10) || 0;
  const x = Math.min(Math.max(ev.clientX - rect.left - left, 0), host.cols() * width - 1);
  const y = Math.min(Math.max(ev.clientY - rect.top - top, 0), host.rows() * height - 1);
  return { col: Math.floor(x / width), row: Math.floor(y / height), x: Math.floor(x), y: Math.floor(y) };
}

function eventCode(e: Report, sgr: boolean): number {
  const mods = (e.ctrl ? 16 : 0) | (e.alt ? 8 : 0) | (e.shift ? 4 : 0);
  if (e.button === Button.WHEEL) return mods | 64 | e.action;
  const button = e.action === Action.UP && !sgr ? Button.NONE : e.button;
  return mods | button | (e.action === Action.MOVE ? Action.MOVE : 0);
}

function encode(e: Report, encoding: Encoding): string {
  switch (encoding) {
    case "default": {
      const code = eventCode(e, false) + 32;
      const col = e.col + 32;
      const row = e.row + 32;
      return code > 255 || col > 255 || row > 255 ? "" : "\x1b[M" + String.fromCharCode(code, col, row);
    }
    case "sgr":
    case "sgrPixels": {
      const final = e.action === Action.UP && e.button !== Button.WHEEL ? "m" : "M";
      const position = encoding === "sgr" ? e.col + ";" + e.row : e.x + ";" + e.y;
      return "\x1b[<" + eventCode(e, true) + ";" + position + final;
    }
  }
}

function sameReport(a: Report, b: Report, pixels: boolean): boolean {
  return (pixels ? a.x === b.x && a.y === b.y : a.col === b.col && a.row === b.row)
    && a.button === b.button && a.action === b.action && a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift;
}

export class TerminalMouse {
  private lastReport: Report | undefined;
  private wheelRemainder = 0;
  private dragging = false;
  private mouseUpBound = false;
  private dragMoveBound = false;

  constructor(
    private readonly host: TerminalInputHost,
    private readonly platform: InputPlatform,
    private readonly focus: () => void,
    private readonly cancel: (event: MouseEvent, force?: boolean) => void,
    private readonly send: (data: string) => void,
    private readonly sendBinary: (data: string) => void,
    private readonly customWheel: (event: WheelEvent) => boolean | undefined,
    signal: AbortSignal,
  ) {
    host.element.addEventListener("mousedown", this.mouseDown, { signal });
    host.element.addEventListener("mousemove", this.hover, { signal });
    host.element.addEventListener("wheel", this.wheel, { passive: false, signal });
    this.syncMode();
  }

  private get doc(): Document { return this.host.element.ownerDocument; }

  public syncMode(protocol = this.host.modes().mouseProtocol): void {
    this.host.element.classList.toggle("enable-mouse-events", protocol !== "none");
    if (protocol === "none" || protocol === "x10") this.endDrag();
    if (protocol === "vt200" && this.dragMoveBound) {
      this.doc.removeEventListener("mousemove", this.dragMove);
      this.dragMoveBound = false;
    }
  }

  public dispose(): void {
    this.endDrag();
    this.host.element.classList.remove("enable-mouse-events");
  }

  private endDrag(): void {
    this.dragging = false;
    if (this.mouseUpBound) this.doc.removeEventListener("mouseup", this.mouseUp);
    if (this.dragMoveBound) this.doc.removeEventListener("mousemove", this.dragMove);
    this.mouseUpBound = this.dragMoveBound = false;
  }

  private mouseDown = (ev: MouseEvent): void => {
    ev.preventDefault();
    this.focus();
    const modes = this.host.modes();
    this.syncMode(modes.mouseProtocol);
    const forceSelection = this.platform.isMac ? ev.altKey && this.host.macOptionClickForcesSelection === true : ev.shiftKey;
    if (modes.mouseProtocol === "none" || forceSelection) return;
    this.report(ev, ev.button, Action.DOWN, modes);
    if (modes.mouseProtocol !== "x10") {
      this.dragging = true;
      if (!this.mouseUpBound) {
        this.doc.addEventListener("mouseup", this.mouseUp);
        this.mouseUpBound = true;
      }
      if (modes.mouseProtocol !== "vt200" && !this.dragMoveBound) {
        this.doc.addEventListener("mousemove", this.dragMove);
        this.dragMoveBound = true;
      }
    }
    this.cancel(ev);
  };

  private mouseUp = (ev: MouseEvent): void => {
    const modes = this.host.modes();
    this.syncMode(modes.mouseProtocol);
    if (!this.dragging) return;
    this.report(ev, ev.button, Action.UP, modes);
    if (!ev.buttons) this.endDrag();
    this.cancel(ev);
  };

  private dragMove = (ev: MouseEvent): void => {
    const modes = this.host.modes();
    this.syncMode(modes.mouseProtocol);
    if (!this.dragging || !ev.buttons || (modes.mouseProtocol !== "drag" && modes.mouseProtocol !== "any")) return;
    const buttons = ev.buttons;
    const button = buttons & 1 ? Button.LEFT : buttons & 4 ? Button.MIDDLE : buttons & 2 ? Button.RIGHT : Button.NONE;
    this.report(ev, button, Action.MOVE, modes);
  };

  private hover = (ev: MouseEvent): void => {
    const modes = this.host.modes();
    this.syncMode(modes.mouseProtocol);
    if (modes.mouseProtocol === "any" && !ev.buttons) {
      const button = ev.buttons === undefined && ev.button >= 0 && ev.button < 3 ? ev.button : Button.NONE;
      this.report(ev, button, Action.MOVE, modes);
    }
  };

  private wheel = (ev: WheelEvent): void => {
    const modes = this.host.modes();
    const protocol = modes.mouseProtocol;
    this.syncMode(protocol);
    if (protocol !== "none" && protocol !== "x10") {
      const point = getMouseReportCoords(ev, this.host);
      if (point && this.customWheel(ev) !== false && this.consumeWheel(ev)) {
        this.report(ev, Button.WHEEL, ev.deltaY < 0 ? Action.UP : Action.DOWN, this.host.modes(), point);
      }
      this.cancel(ev, true);
      return;
    }
    if (this.customWheel(ev) === false) return;
    const live = this.host.modes();
    if ((live.alternateScreen || this.host.hasScrollback?.() === false) && ev.deltaY !== 0) {
      if (this.consumeWheel(ev)) this.send(C0.ESC + (live.applicationCursorKeys ? "O" : "[") + (ev.deltaY < 0 ? "A" : "B"));
      this.cancel(ev, true);
    }
  };

  private consumeWheel(ev: WheelEvent): number {
    const height = this.host.cell().height;
    if (!ev.deltaY || ev.shiftKey || !(height > 0)) return 0;
    const sensitivity = this.host.scrollSensitivity ?? 1;
    let amount = ev.altKey ? ev.deltaY * (this.host.fastScrollSensitivity ?? 5) * sensitivity : ev.deltaY * sensitivity;
    if (ev.deltaMode === 0) {
      // Ovis counts the whole pixel delta and only Alt increases the speed.
      this.wheelRemainder += amount / height;
      amount = Math.trunc(this.wheelRemainder);
      this.wheelRemainder %= 1;
    } else if (ev.deltaMode === 2) {
      amount *= this.host.rows();
    }
    return amount;
  }

  private report(ev: MouseEvent, button: number, action: Report["action"], modes: TerminalInputModes, coords = getMouseReportCoords(ev, this.host)): void {
    if (!coords || coords.col < 0 || coords.col >= this.host.cols() || coords.row < 0 || coords.row >= this.host.rows()) return;
    if (button < 0 || button > Button.WHEEL || (button >= Button.NONE && action !== Action.MOVE && button !== Button.WHEEL)) return;
    const { mouseProtocol: protocol, mouseEncoding: encoding } = modes;
    if (protocol === "none" || (protocol === "x10" && (button === Button.WHEEL || action !== Action.DOWN))
      || (protocol === "vt200" && action === Action.MOVE)
      || (protocol === "drag" && action === Action.MOVE && button === Button.NONE)) return;
    const e: Report = {
      ...coords, col: coords.col + 1, row: coords.row + 1, button, action,
      ctrl: protocol !== "x10" && ev.ctrlKey, alt: protocol !== "x10" && ev.altKey, shift: protocol !== "x10" && ev.shiftKey,
    };
    if (action === Action.MOVE && this.lastReport && sameReport(this.lastReport, e, encoding === "sgrPixels")) return;
    const bytes = encode(e, encoding);
    if (bytes) {
      if (encoding === "default") this.sendBinary(bytes);
      else this.send(bytes);
    }
    this.lastReport = e;
  }
}
