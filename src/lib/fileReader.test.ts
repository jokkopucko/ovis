import { describe, expect, it } from "bun:test";
import { readerFromSearch, readerHref, reloadWhenReaderChanges, resolveFromDocument } from "./fileReader.ts";

describe("file reader links", () => {
  it("names the file and its PC, and reads them back", () => {
    const href = readerHref("remote-1", "/home/me/a b/README.md", "/");
    expect(readerFromSearch(href.slice(1))).toEqual({ machine: "remote-1", path: "/home/me/a b/README.md" });
    expect(readerFromSearch("?read=%2Fx.md")).toEqual({ machine: "local", path: "/x.md" });
    expect(readerFromSearch("?file=%2Fx.md")).toBeNull();
    expect(readerFromSearch("?read=")).toBeNull();
  });

  it("loads the page when a fragment-only step turns the app into the reader, the reader into the app, or moves it to another PC", () => {
    const step = (loaded: Parameters<typeof reloadWhenReaderChanges>[0], hash: string, mode: "relay" | null = "relay") => {
      let reloads = 0;
      let changed = (): void => {};
      const page = { addEventListener: (_: "hashchange", listener: () => void) => { changed = listener; }, location: { search: "", hash: "", reload: () => { reloads++; } } };
      reloadWhenReaderChanges(loaded, page, mode);
      page.location.hash = hash;
      changed();
      return reloads;
    };
    const reader = { machine: "local", path: "/a.md" };
    expect(step(null, "#read=%2Fa.md&machine=local")).toBe(1);
    expect(step(reader, "#ws=w1&pane=w1%3Ap1")).toBe(1);
    expect(step(reader, "#read=%2Fa.md&machine=pc2")).toBe(1);
    expect(step(reader, "#read=%2Fb.md&machine=local")).toBe(0);
    expect(step(null, "#ws=w1&pane=w1%3Ap2")).toBe(0);
    expect(step(null, "#read=%2Fa.md", null)).toBe(0);
  });

  it("keeps the file and its PC in the fragment in the hosted shell", () => {
    const scope = `/s/${"ab".repeat(16)}/`;
    const href = readerHref("remote-1", "/home/me/plan.md#L3", scope, "relay");
    const url = new URL(href, "https://app.example");
    expect(url.pathname + url.search).toBe(scope);
    expect(readerFromSearch(`?${url.hash.slice(1)}`)).toEqual({ machine: "remote-1", path: "/home/me/plan.md#L3" });
  });

  it("resolves a document's links from its folder", () => {
    expect(resolveFromDocument("/repo/README.md", "README.ko.md")).toBe("/repo/README.ko.md");
    expect(resolveFromDocument("/repo/README.md", "docs/guide.md")).toBe("/repo/docs/guide.md");
    expect(resolveFromDocument("/repo/docs/guide.md", "../LICENSE")).toBe("/repo/LICENSE");
    expect(resolveFromDocument("/repo/docs/guide.md", "./a/./b.md")).toBe("/repo/docs/a/b.md");
    expect(resolveFromDocument("/repo/README.md", "/etc/x")).toBe("/etc/x");
    expect(resolveFromDocument("/repo/README.md", "~/notes.md")).toBe("~/notes.md");
    expect(resolveFromDocument("/README.md", "../../x.md")).toBe("/x.md");
    // above a home-relative document's home: the PC expands the path, so the step up is kept
    expect(resolveFromDocument("~/README.md", "../shared.md")).toBe("~/../shared.md");
    expect(resolveFromDocument("~/docs/guide.md", "../README.md")).toBe("~/README.md");
    expect(resolveFromDocument("~/README.md", "../../x.md")).toBe("~/../../x.md");
    // a Windows drive or share keeps its root, and a share's server and name are never climbed over
    expect(resolveFromDocument("C:\\repo\\docs\\a.md", "../b.md")).toBe("C:/repo/b.md");
    expect(resolveFromDocument("\\\\server\\share\\docs\\guide.md", "../notes.txt")).toBe("//server/share/notes.txt");
    expect(resolveFromDocument("\\\\server\\share\\guide.md", "../../x.md")).toBe("//server/share/x.md");
    expect(resolveFromDocument("/repo/README.md", "\\\\server\\share\\x.md")).toBe("\\\\server\\share\\x.md");
  });
});
