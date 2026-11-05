import { describe, expect, it } from "bun:test";
import type { ConversationPart } from "../../shared/protocol.ts";
import { cachedImageRef, LINE_IMAGES_SHOWN, lineImages, linePictures, previewPlace, workImages } from "./workImages.ts";
import type { ToolPart } from "./workBlocks.ts";

const tool = (name: string, refs: string[]): ToolPart => ({
  kind: "tool", name, summary: "", input: "{}", output: "",
  ...(refs.length > 0 ? { images: refs.map((ref) => ({ media_type: "image/png", ref })) } : {}),
});

describe("workImages", () => {
  it("lists every tool's pictures in the work's order, numbered among each tool's own", () => {
    const read = tool("Read", ["a:0:0"]);
    const shots = tool("mcp__plugin_playwright_playwright__browser_take_screenshot", ["b:0:0", "b:0:1"]);
    const parts: ConversationPart[] = [read, { kind: "text", text: "looking" }, tool("Bash", []), shots];
    expect(workImages(parts).map((image) => [image.part.name, image.ref, image.ordinal])).toEqual([
      ["Read", "a:0:0", 0],
      ["mcp__plugin_playwright_playwright__browser_take_screenshot", "b:0:0", 0],
      ["mcp__plugin_playwright_playwright__browser_take_screenshot", "b:0:1", 1],
    ]);
    expect(workImages(parts)[1]!.part).toBe(shots);
  });

  it("finds none in work whose tools returned no picture", () => {
    expect(workImages([tool("Bash", []), { kind: "thinking", text: "hm" }])).toEqual([]);
  });
});

describe("cachedImageRef", () => {
  // one ref of each kind server/pane-routes.ts serves, in the shapes their stores make
  const claude = "6f1c2a9e-4b7d-4e2a-9c1f-0a2b3c4d5e6f:3:1";
  const codex = `codex-${"ab".repeat(32)}`;
  const opencode = "opencode:msg_01HZY8K2:0";

  it("keeps Claude's, pi's, Grok's and Copilot's pictures, which are served immutable", () => {
    expect(cachedImageRef(`grok-image:${"cd".repeat(32)}`)).toBe(true);
    expect(cachedImageRef(`copilot:${"cd".repeat(32)}`)).toBe(true);
    expect(cachedImageRef(claude)).toBe(true);
    expect(cachedImageRef("6f1c2a9e-4b7d-4e2a-9c1f-0a2b3c4d5e6f:2")).toBe(true);
    expect(cachedImageRef("pi:call_7:0")).toBe(true);
    expect(cachedImageRef("pi-prompt:entry-12:1")).toBe(true);
  });

  it("leaves Codex's, OpenCode's and any other agent's to their opened row", () => {
    expect(cachedImageRef(codex)).toBe(false);
    expect(cachedImageRef(opencode)).toBe(false);
    expect(cachedImageRef("grok:turn-3:0")).toBe(false);
    expect(cachedImageRef("")).toBe(false);
  });

  it("puts only kept pictures on a line, in the work's order", () => {
    const parts = [tool("Read", [claude]), tool("view_image", [codex]), tool("read", ["pi:call_7:0", opencode])];
    expect(linePictures(parts).map((image) => image.ref)).toEqual([claude, "pi:call_7:0"]);
    expect(linePictures([tool("view_image", [codex, opencode])])).toEqual([]);
  });
});

describe("previewPlace", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 320, height: 200 };
  const thumb = (top: number, left = 500) => ({ top, bottom: top + 24, left, width: 40 });

  it("sits above its thumbnail, centred on it, where that fits", () => {
    expect(previewPlace(thumb(400), size, viewport)).toEqual({ left: 360, top: 192 });
  });

  it("goes under a thumbnail near the top", () => {
    expect(previewPlace(thumb(50), size, viewport)).toEqual({ left: 360, top: 82 });
  });

  it("takes the roomier side and stays in a viewport too short for either", () => {
    const short = { width: 1000, height: 300 };
    // 140px above, 120px below: above wins, cut to the top edge rather than off it
    expect(previewPlace(thumb(156), size, short)).toEqual({ left: 360, top: 8 });
    expect(previewPlace(thumb(110), size, short).top).toBe(92);
  });

  it("keeps clear of the left and right edges", () => {
    expect(previewPlace(thumb(400, 0), size, viewport).left).toBe(8);
    expect(previewPlace(thumb(400, 980), size, viewport).left).toBe(1000 - 320 - 8);
  });
});

describe("lineImages", () => {
  it("draws every picture a line can hold", () => {
    expect(lineImages([1, 2, 3, 4])).toEqual({ hidden: 0, shown: [1, 2, 3, 4] });
    expect(lineImages([])).toEqual({ hidden: 0, shown: [] });
  });

  it("draws the latest ones and counts the ones before them", () => {
    const ten = Array.from({ length: 10 }, (_, index) => index);
    expect(lineImages(ten)).toEqual({ hidden: 10 - LINE_IMAGES_SHOWN, shown: ten.slice(10 - LINE_IMAGES_SHOWN) });
    expect(lineImages([1, 2, 3], 2)).toEqual({ hidden: 1, shown: [2, 3] });
  });
});
