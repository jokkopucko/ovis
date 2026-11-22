import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { lazyChunk } from "../lib/lazyChunk.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { ChunkFailureNotice } from "./UpdateControls.tsx";

describe("the reader tab's reload line", () => {
  it("offers a reload once a part of the app failed to load, without the update model", async () => {
    await expect(lazyChunk(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/katex-old.js")))()).rejects.toThrow("Failed to fetch");
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
    try {
      const html = renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(ChunkFailureNotice) }));
      expect(html).toContain("Part of the app could not load.");
      expect(html).toContain("Reload app");
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });
});
