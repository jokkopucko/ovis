import { describe, expect, it } from "bun:test";

import { typedAddress } from "./desktopBrowser.ts";

describe("an address typed into the built-in browser", () => {
  it.each([
    ["example.com", "https://example.com/"],
    ["  example.com/docs?q=1  ", "https://example.com/docs?q=1"],
    ["http://example.com", "http://example.com/"],
    ["localhost:5173", "http://localhost:5173/"],
    ["app.localhost:3000/x", "http://app.localhost:3000/x"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["example.com:8443", "https://example.com:8443/"],
    ["https://localhost:5173", "https://localhost:5173/"],
    ["localhost:443/path", "https://localhost/path"],
    ["localhost:80", "http://localhost/"],
  ])("opens %j as %j", (text, address) => {
    expect(typedAddress(text)).toBe(address);
  });

  it.each(["", "   ", "two words", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "mailto:a@b.example"])("opens nothing for %j", (text) => {
    expect(typedAddress(text)).toBeNull();
  });
});
