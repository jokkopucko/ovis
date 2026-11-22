import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppLoadFailed } from "../../components/AppCrash.tsx";
import { reloadAddress, reloadAfterFailedLoad, reloadAt, shellLoaded, type TabMemory } from "./boot.ts";

function tab(): TabMemory {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => { items.set(key, value); },
    removeItem: (key) => { items.delete(key); },
  };
}

describe("a shell whose code failed to load", () => {
  it("reloads once, then leaves the page to the notice until a load succeeds", () => {
    const memory = tab();
    expect(reloadAfterFailedLoad(memory)).toBe(true);
    expect(reloadAfterFailedLoad(memory)).toBe(false);
    expect(reloadAfterFailedLoad(memory)).toBe(false);
    shellLoaded(memory);
    expect(reloadAfterFailedLoad(memory)).toBe(true);
  });

  it("reloads at the entry's address with its offer or sign-in's return, never sending its query again, unless the tab navigated", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(reloadAddress(`https://app.ovis.sh/s/${id}/#offer=abc`, false)).toBe(`/s/${id}/#offer=abc`);
    expect(reloadAddress("https://app.ovis.sh/#code=c&state=s", false)).toBe("/#code=c&state=s");
    expect(reloadAddress("https://app.ovis.sh/?file=%2Fhome%2Fnotes.md", false)).toBe("/#file=%2Fhome%2Fnotes.md");
    expect(reloadAddress("https://app.ovis.sh/?sign-in=github", false)).toBe("/");
    expect(reloadAddress(`https://app.ovis.sh/s/${id}/?pane=p1&view=terminal#offer=abc`, false)).toBe(`/s/${id}/#offer=abc`);
    expect(reloadAddress("https://app.ovis.sh/#pcs", true)).toBeNull();
  });

  it("puts the address back before the reload, and leaves where the tab went alone", () => {
    const steps: string[] = [];
    const page = { history: { replaceState: (_data: unknown, _unused: string, url: string) => { steps.push(`at ${url}`); } }, location: { reload: () => { steps.push("reload"); } } };
    reloadAt(page, "/s/x/#offer=abc");
    reloadAt(page, null);
    expect(steps).toEqual(["at /s/x/#offer=abc", "reload", "reload"]);
  });

  it("says it could not load in the device's language, though no settings provider set one yet", () => {
    const languages = Object.getOwnPropertyDescriptor(navigator, "languages");
    Object.defineProperty(navigator, "languages", { configurable: true, value: ["ko-KR"] });
    try {
      const html = renderToStaticMarkup(createElement(AppLoadFailed, { retry: () => {} }));
      expect(html).toContain("Ovis를 불러오지 못했습니다");
      expect(html).toContain("다시 시도");
    } finally {
      if (languages) Object.defineProperty(navigator, "languages", languages);
      else Reflect.deleteProperty(navigator, "languages");
    }
  });

  it("does not reload where the tab keeps nothing, so a failing host cannot loop it", () => {
    const refusing: TabMemory = {
      getItem: () => null,
      setItem: () => { throw new DOMException("full", "QuotaExceededError"); },
      removeItem: () => {},
    };
    expect(reloadAfterFailedLoad(refusing)).toBe(false);
    expect(reloadAfterFailedLoad({ ...tab(), setItem: () => {} })).toBe(false);
    expect(reloadAfterFailedLoad(null)).toBe(false);
  });
});
