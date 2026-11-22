import { describe, expect, it } from "bun:test";
import { argvLinkQuery, linkHold, openLinkQuery, tellsLink } from "./openLink.ts";

describe("openLinkQuery", () => {
  it("passes on a pane's place as the deep link's own query", () => {
    expect(openLinkQuery("ovis://open?ws=3&pane=t3&view=terminal")).toBe("?ws=3&pane=t3&view=terminal");
    expect(openLinkQuery("ovis://open/?pane=t3&view=chat&ws=3-my-app&machine=home%20pc")).toBe("?machine=home+pc&ws=3-my-app&pane=t3&view=chat");
    expect(openLinkQuery("OVIS://OPEN?pane=t3")).toBe("?pane=t3");
  });

  it("keeps only the names of a pane's place", () => {
    expect(openLinkQuery("ovis://open?pane=t3&file=/etc/passwd&settings=access&new=workspace&cwd=/&token=x#frag")).toBe("?pane=t3");
  });

  it("refuses a link that names no pane", () => {
    expect(openLinkQuery("ovis://open?ws=3")).toBeNull();
    expect(openLinkQuery("ovis://open?pane=%20")).toBeNull();
    expect(openLinkQuery("ovis://open")).toBeNull();
  });

  it("refuses anything but ovis://open", () => {
    for (const value of [
      "https://example.com/?pane=t3",
      "http://127.0.0.1:7317/?pane=t3",
      "javascript:alert(1)//?pane=t3",
      "file:///?pane=t3",
      "ovis://evil.example?pane=t3",
      "ovis://open.example.com?pane=t3",
      "ovis://user@open?pane=t3",
      "ovis://open:80?pane=t3",
      "ovis://open/api/pane/close?pane=t3",
      "ovis:open?pane=t3",
      "?pane=t3",
      "not a link",
      "",
    ]) expect(openLinkQuery(value)).toBeNull();
  });

  it("leaves the view to the page, and refuses a control character and an overlong value", () => {
    expect(openLinkQuery("ovis://open?pane=t3&view=files")).toBe("?pane=t3&view=files");
    expect(openLinkQuery("ovis://open?pane=t3%0A")).toBe("?pane=t3");
    expect(openLinkQuery("ovis://open?pane=t%0A3")).toBeNull();
    expect(openLinkQuery(`ovis://open?pane=${"a".repeat(257)}`)).toBeNull();
  });
});

describe("argvLinkQuery", () => {
  it("reads the link a start was handed", () => {
    expect(argvLinkQuery(["C:\\Ovis\\Ovis.exe", "--", "ovis://open?ws=1&pane=p2&view=chat"])).toBe("?ws=1&pane=p2&view=chat");
    expect(argvLinkQuery(["/usr/bin/ovis", "--no-sandbox", "ovis://open/?pane=t3"])).toBe("?pane=t3");
  });

  it("finds nothing in a plain start or a link it refuses", () => {
    expect(argvLinkQuery(["/usr/bin/ovis"])).toBeNull();
    expect(argvLinkQuery(["/usr/bin/ovis", "--open=?pane=t3"])).toBeNull();
    expect(argvLinkQuery(["/usr/bin/ovis", "ovis://elsewhere?pane=t3"])).toBeNull();
  });
});

describe("tellsLink", () => {
  const page = (ours: boolean, loadingMainFrame: boolean) => ({ ours, loadingMainFrame });

  it("tells a waiting link to the server's page once that page itself has loaded", () => {
    expect(tellsLink("?pane=t3", page(true, false), false)).toBe(true);
    // its did-finish-load: told even where isLoadingMainFrame has not caught up yet
    expect(tellsLink("?pane=t3", page(true, true), true)).toBe(true);
  });

  it("keeps it while the page is loading, for the connection screen, with no window or no link", () => {
    expect(tellsLink("?pane=t3", page(true, true), false)).toBe(false);
    expect(tellsLink("?pane=t3", page(false, false), false)).toBe(false);
    expect(tellsLink("?pane=t3", page(false, false), true)).toBe(false);
    expect(tellsLink("?pane=t3", null, true)).toBe(false);
    expect(tellsLink(null, page(true, false), true)).toBe(false);
  });
});

describe("linkHold", () => {
  it("holds the newest link that came before the page listens, and tells it once", () => {
    const hold = linkHold();
    hold.receive("?pane=older");
    hold.receive("?pane=t3");
    const heard: string[] = [];
    hold.onOpen((query) => heard.push(query));
    expect(heard).toEqual(["?pane=t3"]);
    hold.receive("?pane=t4");
    expect(heard).toEqual(["?pane=t3", "?pane=t4"]);
  });

  it("tells a held link to no later listener, and a later listener takes the next", () => {
    const hold = linkHold();
    hold.receive("?pane=t3");
    const first: string[] = [];
    const second: string[] = [];
    hold.onOpen((query) => first.push(query));
    hold.onOpen((query) => second.push(query));
    hold.receive("?pane=t4");
    expect(first).toEqual(["?pane=t3"]);
    expect(second).toEqual(["?pane=t4"]);
  });

  it("drops what is not a query", () => {
    const hold = linkHold();
    hold.receive(42);
    hold.receive(null);
    const heard: string[] = [];
    hold.onOpen((query) => heard.push(query));
    expect(heard).toEqual([]);
  });
});
