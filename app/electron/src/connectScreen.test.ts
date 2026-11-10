import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "..", "renderer", "connect.js"), "utf8");

interface Element { hidden: boolean; disabled: boolean; textContent: string; dataset: Record<string, string>; addEventListener(type: string, listener: () => void): void }

/** The connection screen's script (renderer/connect.js) on a stand-in page: its elements by id and the app's two bridges. */
function screen() {
  const elements = new Map<string, Element>();
  const element = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, { hidden: id === "update", disabled: false, textContent: "", dataset: {}, addEventListener: () => undefined });
    return elements.get(id)!;
  };
  let answer: (update: unknown) => void = () => undefined;
  const listeners: ((update: unknown) => void)[] = [];
  const window = {
    ovisDesktop: { status: () => new Promise(() => undefined), onStatus: () => undefined, retry: () => undefined, showLogs: () => undefined },
    ovisUpdate: {
      current: () => new Promise((resolve) => { answer = resolve; }),
      onChange: (listener: (update: unknown) => void) => { listeners.push(listener); return () => undefined; },
      install: () => new Promise(() => undefined),
      close: () => undefined,
    },
  };
  const document = { documentElement: { lang: "en" }, querySelectorAll: () => [], getElementById: element };
  new Function("document", "window", "navigator", source)(document, window, { language: "en-US" });
  return {
    answer: (update: unknown) => answer(update),
    tell: (update: unknown) => { for (const listener of listeners) listener(update); },
    line: () => element("update").hidden ? null : `${element("update-text").textContent} / ${element("update-install").textContent}`,
  };
}

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const ready = { version: "0.5.3", closed: false, text: "Ovis 0.5.3 is ready", action: "Restart to Update" };

describe("the connection screen's update line", () => {
  it("shows the update the app answers with, in the app's words, also one whose line was closed", async () => {
    const page = screen();
    expect(page.line()).toBeNull();
    page.answer({ ...ready, closed: true });
    await settled();
    expect(page.line()).toBe("Ovis 0.5.3 is ready / Restart to Update");
  });

  it("follows the app: a download that finishes later, and an offer withdrawn", async () => {
    const page = screen();
    page.answer(null);
    await settled();
    page.tell(ready);
    expect(page.line()).toBe("Ovis 0.5.3 is ready / Restart to Update");
    page.tell(null);
    expect(page.line()).toBeNull();
  });

  it("keeps an update told of before the answer to its asking arrives: that answer was read before it", async () => {
    const page = screen();
    page.tell(ready);
    page.answer(null);
    await settled();
    expect(page.line()).toBe("Ovis 0.5.3 is ready / Restart to Update");
  });
});
