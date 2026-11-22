import { describe, expect, it } from "bun:test";
import { Grid, PaneGrid } from "./grid.ts";
import { nearest256, Painter, type Scene } from "./paint.ts";

/** One pane cell with this foreground, painted by a painter for a host of the given depth. */
function painted(colors: "truecolor" | "256" | undefined, fg: [number, number, number] | number): string {
  const painter = new Painter(colors === undefined ? { sync: false } : { sync: false, colors });
  const grid = new PaneGrid(painter.styles, 1, 1);
  grid.grid = new Grid(1, 1);
  grid.grid.text[0] = "x";
  grid.grid.style[0] = painter.styles.id(fg, null, 0);
  const scene: Scene = { width: 1, height: 1, parts: [], panes: [{ id: "p", rect: { x: 0, y: 0, width: 1, height: 1 }, grid, live: true, hold: false, scrolledBack: false }], overlays: [], focus: null, input: null };
  return new TextDecoder().decode(painter.paint(scene).bytes);
}

describe("colours on a 256-colour host", () => {
  it("maps an RGB colour to the nearest xterm-256 index: cube colours, greys and the corners", () => {
    const table: [[number, number, number], number][] = [
      [[0, 0, 0], 16], [[255, 255, 255], 231], [[255, 0, 0], 196], [[0, 255, 0], 46], [[0, 0, 255], 21],
      [[95, 135, 175], 67], [[100, 130, 170], 67], [[8, 8, 8], 232], [[238, 238, 238], 255], [[128, 128, 128], 244],
      [[18, 18, 18], 233],
    ];
    expect(table.map(([rgb]) => nearest256(rgb))).toEqual(table.map(([, index]) => index));
  });

  it("writes RGB as written for a truecolour host and by default, and as the palette index for a 256-colour host", () => {
    expect(painted(undefined, [95, 135, 175])).toContain("\x1b[0;38;2;95;135;175m");
    expect(painted("truecolor", [95, 135, 175])).toContain("\x1b[0;38;2;95;135;175m");
    const low = painted("256", [95, 135, 175]);
    expect(low).toContain("\x1b[0;38;5;67m");
    expect(low).not.toContain("38;2;");
  });

  it("leaves palette colours as they are on either host", () => {
    expect(painted("256", 200)).toContain("\x1b[0;38;5;200m");
    expect(painted("truecolor", 3)).toContain("\x1b[0;33m");
  });
});
