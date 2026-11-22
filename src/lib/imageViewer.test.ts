import { describe, expect, it } from "bun:test";
import { actualSizeFactor, arrowAction, attachmentFileName, mentionFileName, wrapIndex, zoomPercent } from "./imageViewer.ts";

describe("wrapIndex", () => {
  it("wraps a step past either end of the gallery", () => {
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(1, 3)).toBe(1);
  });

  it("wraps offsets beyond a whole cycle, and answers 0 for an empty gallery", () => {
    expect(wrapIndex(7, 3)).toBe(1);
    expect(wrapIndex(-7, 3)).toBe(2);
    expect(wrapIndex(5, 0)).toBe(0);
  });
});

describe("zoomPercent", () => {
  it("says the zoom in the picture's own pixels once its fit is known", () => {
    expect(zoomPercent(1, 0.5)).toBe(50);
    expect(zoomPercent(2, 0.5)).toBe(100);
    expect(zoomPercent(1.25, 1)).toBe(125);
  });

  it("reads as the factor over fit while the fit is unknown", () => {
    expect(zoomPercent(1.5, 0)).toBe(150);
  });
});

describe("actualSizeFactor", () => {
  it("zooms a shrunk picture to its natural pixels, and a small one to twice its size", () => {
    expect(actualSizeFactor(0.25)).toBe(4);
    expect(actualSizeFactor(1)).toBe(2);
    expect(actualSizeFactor(0.8)).toBe(2);
    expect(actualSizeFactor(0)).toBe(2);
  });
});

describe("arrowAction", () => {
  it("steps through the gallery with Left and Right while the picture is at fit", () => {
    expect(arrowAction("ArrowLeft", false, 3, 80)).toEqual({ kind: "step", by: -1 });
    expect(arrowAction("ArrowRight", false, 3, 80)).toEqual({ kind: "step", by: 1 });
    expect(arrowAction("ArrowUp", false, 3, 80)).toBeNull();
  });

  it("has nothing to step to in a gallery of one", () => {
    expect(arrowAction("ArrowRight", false, 1, 80)).toBeNull();
  });

  it("pans a zoomed picture the way its content would scroll", () => {
    expect(arrowAction("ArrowLeft", true, 3, 80)).toEqual({ kind: "pan", dx: 80, dy: 0 });
    expect(arrowAction("ArrowRight", true, 3, 80)).toEqual({ kind: "pan", dx: -80, dy: 0 });
    expect(arrowAction("ArrowUp", true, 3, 80)).toEqual({ kind: "pan", dx: 0, dy: 80 });
    expect(arrowAction("ArrowDown", true, 1, 80)).toEqual({ kind: "pan", dx: 0, dy: -80 });
  });

  it("leaves every other key alone", () => {
    expect(arrowAction("Enter", false, 3, 80)).toBeNull();
    expect(arrowAction("a", true, 3, 80)).toBeNull();
  });
});

describe("attachmentFileName", () => {
  it("names a message's attachments in order, by their media type", () => {
    expect(attachmentFileName("image/png", 0)).toBe("image-1.png");
    expect(attachmentFileName("image/jpeg", 1)).toBe("image-2.jpg");
    expect(attachmentFileName("image/webp", 2)).toBe("image-3.webp");
    expect(attachmentFileName("image/svg+xml", 0)).toBe("image-1.svg");
    expect(attachmentFileName("IMAGE/GIF", 0)).toBe("image-1.gif");
  });

  it("reads a missing or odd media type as PNG", () => {
    expect(attachmentFileName("", 0)).toBe("image-1.png");
    expect(attachmentFileName("application/octet-stream", 0)).toBe("image-1.png");
  });
});

describe("mentionFileName", () => {
  it("takes the last segment of a path, written either way", () => {
    expect(mentionFileName("shots/home.png")).toBe("home.png");
    expect(mentionFileName("/tmp/shot/t0.png")).toBe("t0.png");
    expect(mentionFileName("C:\\shots\\home.png")).toBe("home.png");
    expect(mentionFileName("home.png")).toBe("home.png");
  });

  it("falls back to a plain name for a path that names no file", () => {
    expect(mentionFileName("shots/")).toBe("shots");
    expect(mentionFileName("")).toBe("image");
  });
});
