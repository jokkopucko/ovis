import { describe, expect, it } from "bun:test";

import { blockedSite, canonicalHost, decide, machineHost, ovisAt, shownAddress, type BrowserDecision, type BrowserPolicy } from "./browser-policy.ts";

const policy: BrowserPolicy = { blocked: ["bank.example", "xn--bcher-kva.example", "10.0.0.7", "[2001:db8::1]"], ovis: [{ host: "127.0.0.1", port: 7317 }, { host: "100.64.0.9", port: 7317 }] };
const reason = (decision: BrowserDecision) => decision.allowed ? "allowed" : decision.reason;

describe("the built-in browser's decision", () => {
  it.each([
    ["https://bank.example/login", "blocked"],
    ["https://www.bank.example/", "blocked"],
    ["https://BANK.Example./", "blocked"],
    ["https://bank.example../", "blocked"],
    ["wss://live.bank.example/socket", "blocked"],
    ["http://bank.example:8080/", "blocked"],
    ["https://notbank.example/", "allowed"],
    ["https://bank.example.org/", "allowed"],
    ["https://bücher.example/", "blocked"],
    ["https://shop.xn--bcher-kva.example/", "blocked"],
    ["http://10.0.0.7/", "blocked"],
    ["http://0x0a.0.0.7/", "blocked"],
    ["http://167772167/", "blocked"],
    ["http://012.0.0.7/", "blocked"],
    ["http://[::ffff:10.0.0.7]/", "blocked"],
    ["http://[2001:0db8:0:0:0:0:0:1]/", "blocked"],
    ["http://10.0.0.8/", "allowed"],
    ["http://b.localhost:5173/", "allowed"],
  ])("decides %s by its canonical host: %s", (address, expected) => {
    expect(reason(decide(address, policy))).toBe(expected);
  });

  it.each([
    ["http://127.0.0.1:7317/api/machines", "ovis"],
    ["http://localhost:7317/", "ovis"],
    ["http://app.localhost:7317/", "ovis"],
    ["http://127.9.8.7:7317/", "ovis"],
    ["http://0x7f000001:7317/", "ovis"],
    ["http://[::1]:7317/", "ovis"],
    ["http://[::ffff:127.0.0.1]:7317/", "ovis"],
    ["http://0.0.0.0:7317/", "ovis"],
    ["ws://localhost:7317/api/terminal", "ovis"],
    ["http://100.64.0.9:7317/", "ovis"],
    ["http://localhost:5173/", "allowed"],
    ["http://100.64.0.9:5173/", "allowed"],
  ])("refuses an Ovis server at its port on any name of its host: %s %s", (address, expected) => {
    expect(reason(decide(address, policy))).toBe(expected);
  });

  it.each([
    ["file:///etc/passwd", "scheme"],
    ["chrome://settings", "scheme"],
    ["devtools://devtools/bundled/inspector.html", "scheme"],
    ["chrome-extension://abc/page.html", "scheme"],
    ["ftp://files.example/", "scheme"],
    ["vscode://file/x", "scheme"],
    ["mailto:a@b.example", "scheme"],
    ["not a url", "invalid"],
    ["https://user:secret@site.example/", "invalid"],
  ])("refuses what reaches no web origin: %s %s", (address, expected) => {
    expect(reason(decide(address, policy))).toBe(expected);
  });

  it("decides a blob: and a filesystem: by the origin inside them, before anything is shown", () => {
    expect(reason(decide("blob:https://bank.example/0b6a3c2e-1111-2222-3333-444455556666", policy))).toBe("blocked");
    expect(reason(decide("blob:https://www.bank.example./0b6a3c2e", policy))).toBe("blocked");
    expect(reason(decide("filesystem:https://bank.example/temporary/a.txt", policy))).toBe("blocked");
    expect(reason(decide("blob:http://localhost:7317/x", policy))).toBe("ovis");
    expect(reason(decide("blob:null/0b6a3c2e", policy))).toBe("invalid");
    expect(reason(decide("blob:file:///x", policy))).toBe("scheme");
    expect(reason(decide("blob:wss://site.example/0b6a3c2e", policy))).toBe("scheme");
    expect(reason(decide(" blob:https://bank.example/0b6a3c2e", policy))).toBe("blocked");
    expect(reason(decide("BLOB:https://site.example/0b6a3c2e", policy))).toBe("allowed");
    expect(reason(decide(" filesystem:https://site.example/temporary/a", policy))).toBe("allowed");
    const allowed = decide("blob:https://site.example/0b6a3c2e", policy);
    expect(allowed).toMatchObject({ allowed: true, origin: "https://site.example" });
  });

  it("decides a data:, about: and javascript: by the frame it runs in, and refuses one without", () => {
    expect(reason(decide("data:text/html,<p>hi", policy))).toBe("opaque");
    expect(reason(decide("about:blank", policy, "null"))).toBe("opaque");
    expect(reason(decide("javascript:alert(1)", policy, "https://bank.example"))).toBe("blocked");
    expect(reason(decide("about:srcdoc", policy, "http://localhost:7317"))).toBe("ovis");
    expect(decide("about:blank", policy, "https://site.example")).toMatchObject({ allowed: true, origin: "https://site.example" });
  });

  it("shows an allowed address without its query or fragment, and a blob: as its origin", () => {
    const shown = (address: string, frame: string | null = null) => {
      const decision = decide(address, policy, frame);
      if (!decision.allowed) throw new Error(`${address} was refused`);
      return shownAddress(decision);
    };
    expect(shown("https://site.example/a/b?token=secret#frag")).toBe("https://site.example/a/b");
    expect(shown("blob:https://site.example/0b6a3c2e")).toBe("https://site.example");
    expect(shown("data:text/html,secret", "https://site.example")).toBe("https://site.example");
  });
});

describe("a blocked site as typed", () => {
  it.each([
    ["bank.example", "bank.example"],
    ["  *.Bank.Example.  ", "bank.example"],
    ["https://bank.example/login?x=1", "bank.example"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["localhost", "localhost"],
    ["b.localhost", "b.localhost"],
    ["127.0.0.1", "127.0.0.1"],
    ["0x0a.0.0.7", "10.0.0.7"],
    ["[2001:db8::1]", "[2001:db8::1]"],
    ["", null],
    ["two words", null],
    ["http://", null],
    ["custom://bücher.example/path", null],
    ["file:/tmp/a", null],
    ["mailto:reader@bücher.example", null],
    ["localhost:5173", "localhost"],
    ["bank.example:8443/login", "bank.example"],
    ["wss://bücher.example/", "xn--bcher-kva.example"],
  ])("keeps %j as %j", (entry, expected) => {
    expect(blockedSite(entry)).toBe(expected);
  });

  it("blocks one loopback site without its siblings", () => {
    const sites: BrowserPolicy = { blocked: [blockedSite("a.localhost")!], ovis: [] };
    expect(reason(decide("http://a.localhost:5173/", sites))).toBe("blocked");
    expect(reason(decide("http://b.localhost:5173/", sites))).toBe("allowed");
  });
});

describe("an Ovis server at an address a name resolved to", () => {
  it("is found by the address and the port, loopback in any spelling", () => {
    expect(ovisAt("127.0.0.1", 7317, policy)).toBe(true);
    expect(ovisAt("[::1]", 7317, policy)).toBe(true);
    expect(ovisAt("100.64.0.9", 7317, policy)).toBe(true);
    expect(ovisAt("127.0.0.1", 7318, policy)).toBe(false);
    expect(ovisAt("203.0.113.7", 7317, policy)).toBe(false);
  });
});

describe("the machine a host names", () => {
  it("names every loopback host the same, and only those", () => {
    expect(["localhost", "a.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "[::]", "0.0.0.0", "[::ffff:7f00:1]"].map((host) => machineHost(canonicalHost(host)))).toEqual(Array(8).fill("localhost"));
    expect(["10.0.0.7", "localhost.example", "[::2]"].map(machineHost)).toEqual(["10.0.0.7", "localhost.example", "[::2]"]);
  });
});
