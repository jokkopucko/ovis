import { describe, expect, it, mock } from "bun:test";

const opened: string[] = [];
void mock.module("electron", () => ({ shell: { openExternal: (url: string) => {
  if (url.includes("refused")) throw new Error("no handler");
  opened.push(url);
  return Promise.resolve();
} } }));
const { openOutside, opensOutside } = await import("./openOutside.ts");

describe("opensOutside", () => {
  it("hands http, https and mailto addresses to the system browser", () => {
    for (const url of ["http://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM", "mailto:team@ovis.sh"]) {
      expect(opensOutside(url)).toBe(true);
    }
  });

  it("keeps every other scheme, and what is no address at all, from the OS", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,<p>x</p>", "file:///etc/passwd", "ovis://open?pane=t3", "ms-settings:privacy", "about:blank", "example.com", ""]) {
      expect(opensOutside(url)).toBe(false);
    }
  });
});

describe("openOutside", () => {
  it("opens only what opensOutside takes", () => {
    for (const url of ["https://example.com/", "file:///etc/passwd", "not an address", "mailto:team@ovis.sh"]) openOutside(url);
    expect(opened).toEqual(["https://example.com/", "mailto:team@ovis.sh"]);
  });

  it("never throws into the window handlers that call it, even when the OS refuses the address", () => {
    expect(() => openOutside("https://refused.example/")).not.toThrow();
  });
});
