import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { FileViewer } from "./FileViewer.tsx";
import type { FileInfo } from "../../shared/files.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

let page: Page;

beforeEach(() => {
  page = openPage("http://localhost/s/shell/");
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
});

afterEach(async () => {
  await page.close();
  setTransport(nativeTransport);
});

const file = (name: string): FileInfo => ({ path: `/w/${name}`, name, size: 64, modified: "2026-11-11T00:00:00Z", mime: "text/html", kind: "text" });
const HTML = "<!doctype html><body><h1>report</h1><script>document.title = 'ran'</script></body>";

function pc(kind: Transport["kind"]): Transport {
  return {
    ...nativeTransport,
    kind,
    fetch: async (input) => {
      const url = new URL(String(input), "https://ovis.test");
      if (url.pathname.endsWith("/fs/stat")) return Response.json(file(String(url.searchParams.get("path")).split("/").pop()!));
      return new Response(HTML, { headers: { "content-type": "text/html" } });
    },
  };
}

const frames = () => [...page.container.querySelectorAll<HTMLIFrameElement>("iframe")];
const button = (label: string) => [...page.container.querySelectorAll("button")].filter((node) => node.textContent === label);
const press = async (label: string): Promise<void> => {
  const [item] = button(label);
  if (!item) throw new Error(`Missing ${label} button`);
  await act(async () => item.click());
};
const shown = () => page.container.textContent;
async function until(done: () => boolean): Promise<void> {
  await act(async () => {});
  expect(done()).toBe(true);
}
async function view(transport: Transport, path: string): Promise<void> {
  setTransport(transport);
  await page.render(createElement(SettingsProvider, { children: createElement(FileViewer, { path, paneId: null, onClose() {}, page: true }) }));
  await until(() => frames().length === 1);
}

test("an HTML page is framed without its scripts until Run scripts, in a frame of its own for each; the same file keeps them through Source and back", async () => {
  await view(pc("native"), "/w/report.html");
  const still = frames()[0]!;
  expect([still.getAttribute("sandbox"), still.getAttribute("data-page-scripts")]).toEqual(["", "off"]);
  expect(String(still.getAttribute("src"))).toContain("render=1");
  expect(shown()).toContain("Scripts in this page are off.");
  expect(button("Run scripts")).toHaveLength(1);

  await press("Run scripts");
  await until(() => frames()[0]?.getAttribute("data-page-scripts") === "on");
  expect(frames()[0]!.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frames()[0]).not.toBe(still);
  expect(shown()).not.toContain("Scripts in this page are off.");

  await press("Source");
  await until(() => frames().length === 0);
  await press("Page");
  await until(() => frames().length === 1);
  // Then it still runs: the choice is the file's for as long as this viewer is open
  expect(frames()[0]!.getAttribute("sandbox")).toBe("allow-scripts");
});

test("another file, and the same file in a viewer opened anew, start without their scripts", async () => {
  await view(pc("native"), "/w/report.html");
  await press("Run scripts");
  await until(() => frames()[0]?.getAttribute("data-page-scripts") === "on");
  await page.render(null);
  await view(pc("native"), "/w/report.html");
  expect([frames()[0]!.getAttribute("sandbox"), button("Run scripts").length]).toEqual(["", 1]);
  await page.render(null);
  await view(pc("native"), "/w/other.html");
  expect([frames()[0]!.getAttribute("sandbox"), button("Run scripts").length]).toEqual(["", 1]);
});

test("over a relay the render host is told whether the page's scripts were asked for, and gets the page anew when they are", async () => {
  await view(pc("relay"), "/w/report.html");
  const sent = async (frame: HTMLIFrameElement): Promise<unknown[]> => {
    const messages: unknown[] = [];
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: { postMessage: (message: unknown) => { messages.push(message); } } });
    await act(async () => { frame.dispatchEvent(new page.window.Event("load") as unknown as Event); });
    return messages;
  };
  // Then the render host's frame is the relay's (it needs its own few lines to run), and is told to draw the page without scripts
  const still = frames()[0]!;
  expect([still.getAttribute("src"), still.getAttribute("sandbox"), still.getAttribute("data-page-scripts")]).toEqual(["/s/shell/~render", "allow-scripts", "off"]);
  expect(await sent(still)).toEqual([{ type: "ovis-render", html: HTML, scripts: false }]);
  expect(button("Run scripts")).toHaveLength(1);

  await press("Run scripts");
  await until(() => frames()[0]?.getAttribute("data-page-scripts") === "on");
  expect(frames()[0]).not.toBe(still);
  expect(await sent(frames()[0]!)).toEqual([{ type: "ovis-render", html: HTML, scripts: true }]);
  expect(button("Run scripts")).toHaveLength(0);
});
