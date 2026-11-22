import { describe, expect, it } from "bun:test";
import { userGalleryImages } from "./chatImages.ts";
import { imageMention } from "./compose.ts";
import { setPasteFolder } from "./pasteFolders.ts";

const t = (text: string) => text;
const images = (text: string) => userGalleryImages("fixture pc", "w1:p1", [], text, t);

describe("mentioned chat images", () => {
  it("shows a composer attachment under an iCloud folder containing spaces", () => {
    const path = "/Users/test/Library/Mobile Documents/iCloud~md~obsidian/Documents/notes/.ovis/paste-20261103-065352-8f69b25b.png";
    const gallery = images(`${imageMention(path)}왜 이렇게 나와?`);
    expect(gallery).toHaveLength(1);
    expect(gallery[0]!.name).toBe(path);
    expect(gallery[0]!.file).toBe("paste-20261103-065352-8f69b25b.png");
    const url = new URL(gallery[0]!.src, "http://fixture");
    expect(url.pathname).toBe("/api/machines/fixture%20pc/fs/file");
    expect(url.searchParams.get("pane_id")).toBe("w1:p1");
    expect(url.searchParams.get("path")).toBe(path);
  });

  it("keeps multiple spaced paths separate, in order, without the following prose", () => {
    const paths = ["/My Images/.ovis/paste-20261103-065352-8f69b25b.png", "/Other Folder/.ovis/two-20261103-065400-0123abcd.JPEG"];
    expect(images(`${paths.map(imageMention).join("")}compare these images`).map((image) => image.name)).toEqual(paths);
    expect(images(`${imageMention(paths[0]!)}설명에 다른 image.png도 있음`).map((image) => image.name)).toEqual([paths[0]!]);
  });

  it("supports Windows absolute paths with spaces", () => {
    const path = "C:\\Users\\Test User\\My Images\\.ovis\\paste-20261103-065352-8f69b25b.webp";
    expect(images(imageMention(path)).map((image) => image.name)).toEqual([path]);
  });

  it("preserves relative and no-space mentions and deduplicates each path", () => {
    expect(images("@shots/one.gif @/tmp/two.png @shots/one.gif").map((image) => image.name)).toEqual(["shots/one.gif", "/tmp/two.png"]);
    expect(images("@shots/me@home.png @/Users/test@example/My Images/.ovis/paste-20261103-065352-8f69b25b.png").map((image) => image.name)).toEqual(["shots/me@home.png", "/Users/test@example/My Images/.ovis/paste-20261103-065352-8f69b25b.png"]);
  });

  it("does not join paths across lines, tabs or another mention", () => {
    for (const text of ["@/My Folder\nnot-an-attachment.png", "@/My Folder\rnot-an-attachment.png", "@/My Folder\tnot-an-attachment.png", "@/My Folder @other prose.png"]) {
      expect(images(text)).toEqual([]);
    }
    expect(images("@/My Folder @/Other Folder/.ovis/paste-20261103-065352-8f69b25b.png").map((image) => image.name)).toEqual(["/Other Folder/.ovis/paste-20261103-065352-8f69b25b.png"]);
  });

  it("leaves addresses, unsupported types and extension prefixes alone", () => {
    for (const text of ["person@example.png", "@/My Folder/notes.txt", "@/My Folder/one.png.backup", "@/My Folder/one.pngsuffix"]) expect(images(text)).toEqual([]);
  });

  it("reads no prose as a spaced path, only what an upload names", () => {
    for (const text of ["see @/docs for the guide, then open logo.png", "import from @/components then check screenshot.png", "@/tmp/example please refer to diagram.png in prose"]) expect(images(text)).toEqual([]);
    expect(images("@/tmp/My Folder/report.png backup/.ovis/paste-20261103-065352-8f69b25b.png").map((image) => image.name)).toEqual(["/tmp/My Folder/report.png backup/.ovis/paste-20261103-065352-8f69b25b.png"]);
    expect(images("@/tmp/report.png backup/.ovis/paste-20261103-065352-8f69b25b.png").map((image) => image.name)).toEqual(["/tmp/report.png backup/.ovis/paste-20261103-065352-8f69b25b.png"]);
    expect(images("@/tmp/not-image\u00a0@/A B/.ovis/paste-20261103-065352-8f69b25b.png").map((image) => image.name)).toEqual(["/A B/.ovis/paste-20261103-065352-8f69b25b.png"]);
    expect(images("@/a b c\u00a0".repeat(10_000))).toEqual([]);
    for (const words of ["Please review docs/", "check @other docs/.ovis/", "check @~/My Folder/.ovis/", "Please review /x/.ovis/"]) {
      expect(images(`@/tmp/a.png ${words}paste-20261103-065352-8f69b25b.png now`).map((image) => image.name)).toEqual(["/tmp/a.png"]);
    }
    for (const path of ["/My Uploads/paste-20261103-065352-8f69b25b.png", "/Users/me/John.Doe Files/paste-20261103-065352-8f69b25b.png", "C:\\v1.2 build\\paste-20261103-065352-8f69b25b.png"]) {
      expect(images(`@${path} Fix footer`).map((image) => image.name)).toEqual([path]);
    }
    expect(images("@/Users/me/Company @ Work/.ovis/paste-20261103-065352-8f69b25b.png Fix footer").map((image) => image.name)).toEqual(["/Users/me/Company @ Work/.ovis/paste-20261103-065352-8f69b25b.png"]);
  });

  it("reads an upload whole through its PC's OVIS_PASTE_DIR named like an image file (#2771)", () => {
    const path = "/tmp/shots.png backup/paste-20261104-101500-0a1b2c3d.png";
    const windows = "C:\\Shots\\v2.webp old\\paste-20261104-101500-0a1b2c3d.png";
    expect(images(`@${path} Fix footer`).map((image) => image.name)).toEqual(["/tmp/shots.png"]);
    setPasteFolder("fixture pc", "/tmp/shots.png backup");
    try {
      expect(images(`@${path} Fix footer`).map((image) => image.name)).toEqual([path]);
      expect(images("@/tmp/a.png Please review docs/paste-20261103-065352-8f69b25b.png now").map((image) => image.name)).toEqual(["/tmp/a.png"]);
      expect(images(`@${path.replace("shots", "Shots")} Fix footer`).map((image) => image.name)).toEqual(["/tmp/Shots.png"]);
      expect(images(`@/a/one.png @${path} @/b/two.gif`).map((image) => image.name)).toEqual(["/a/one.png", path, "/b/two.gif"]);
      expect(userGalleryImages("other pc", "w1:p1", [], `@${path} Fix footer`, t).map((image) => image.name)).toEqual(["/tmp/shots.png"]);
      setPasteFolder("fixture pc", "C:\\Shots\\v2.webp old");
      expect(images(`@${windows} Fix footer`).map((image) => image.name)).toEqual([windows]);
    } finally {
      setPasteFolder("fixture pc", undefined);
    }
  });

  it("keeps native attachments before mentioned files", () => {
    const gallery = userGalleryImages("local", "p:1", [{ kind: "image", ref: "codex-example", media_type: "image/jpeg" }], "@/My Images/.ovis/one-20261103-065352-8f69b25b.png", t);
    expect(gallery.map((image) => image.file)).toEqual(["image-1.jpg", "one-20261103-065352-8f69b25b.png"]);
    expect(new URL(gallery[0]!.src, "http://fixture").searchParams.get("ref")).toBe("codex-example");
  });
});
