import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement, Profiler } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { FileInfo } from "../../shared/protocol.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { MAX_INLINE_IMAGE_BYTES } from "../lib/markdownImages.ts";
import { nativeTransport, setTransport } from "../lib/transport.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { createSkillMatcher, type SkillMatcher } from "../lib/skillMentions.ts";
import { ChatMarkdownImages } from "./ChatMarkdownImages.tsx";
import { InlineMarkdown, Markdown } from "./Markdown.tsx";

let page: Page;
let requests: Array<{ url: URL; finish: (body: unknown, status?: number) => void }>;
let opened: GalleryImage[];
const saved = new Map<string, PropertyDescriptor | undefined>();
const onOpen = (image: GalleryImage) => { opened.push(image); };
const info = (path: string, size = 100): FileInfo => ({ path, name: path.split("/").pop()!, size, modified: "2026-10-30T00:00:00Z", mime: "image/png", kind: "image" });

async function draw({ machine = "local", pane = "w1:p1", cwd = "/project", connected = true, text = "![Diagram](./diagram.png)", inline = false, html = false, skills = null }: {
  machine?: string; pane?: string; cwd?: string | null; connected?: boolean; text?: string; inline?: boolean; html?: boolean; skills?: SkillMatcher | null;
} = {}) {
  const children = inline ? createElement(InlineMarkdown, { children: text }) : createElement(Markdown, { children: text, html, skills });
  const tree = createElement(SettingsProvider, { children: createElement(MachineContext.Provider, { value: machine,
    children: createElement(ChatMarkdownImages, { paneId: pane, cwd, connected, onOpen, children }),
  }) });
  await page.render(tree);
}
const images = () => [...page.container.querySelectorAll("img")];
const imageEvent = (image: HTMLImageElement, type: "load" | "error") => Reflect.apply(image.dispatchEvent, image, [new page.window.Event(type)]);
const buttons = () => [...page.container.querySelectorAll("button")];
async function answer(index: number, body: unknown, status = 200) {
  await act(async () => { requests[index]!.finish(body, status); });
}

beforeEach(() => {
  page = openPage("http://test.local/");
  saved.set("fetch", Object.getOwnPropertyDescriptor(globalThis, "fetch"));
  for (const [key, value] of Object.entries({ ResizeObserver: page.window.ResizeObserver })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  requests = [];
  opened = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: (target: string) => new Promise<Response>((resolve) => {
    requests.push({ url: new URL(target, "http://test.local"), finish: (body, status = 200) => resolve(Response.json(body, { status })) });
  }) });
});
afterEach(async () => {
  await page.close();
  setTransport(nativeTransport);
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

it("uses the shared transport for pane stats and resolves inline bytes once", async () => {
  const resources: string[] = [];
  let stats = 0;
  setTransport({ ...nativeTransport, kind: "relay",
    fetch: (input, init) => { stats++; return nativeTransport.fetch(input, init); },
    resourceUrl: (path) => { resources.push(path); return `blob:transport-image`; },
  });
  await draw({ machine: "other-pc", pane: "w2:p4" });
  expect(stats).toBe(1);
  expect(requests[0]!.url.pathname).toBe("/api/machines/other-pc/fs/stat");
  await answer(0, info("/foreground/diagram.png"));
  expect(images()[0]!.getAttribute("src")!).toBe("blob:transport-image");
  expect(resources).toHaveLength(1);
  const resource = new URL(resources[0]!, "http://test.local");
  expect(resource.pathname).toBe("/api/machines/other-pc/fs/file");
  expect(resource.searchParams.get("pane_id")).toBe("w2:p4");
  expect(resource.searchParams.get("path")).toBe("/foreground/diagram.png");
});

it("keeps transport byte failures out of inline viewer controls and retries them after reconnect", async () => {
  const files: string[] = [];
  const nestedControls: number[] = [];
  const recordCommit = () => {
    nestedControls.push(buttons().flatMap((button) => [...button.querySelectorAll("button, a, input")]).length);
  };
  const bytes: Array<{ path: string; resolve: (url: string) => void; reject: (error: Error) => void }> = [];
  setTransport({ ...nativeTransport, kind: "relay", resourceUrl: (path) => new Promise<string>((resolve, reject) => {
    bytes.push({ path, resolve, reject });
  }) });
  const render = async (connected: boolean) => {
    const tree = createElement(Profiler, { id: "image-failures", onRender: recordCommit, children: createElement(SettingsProvider, { children:
      createElement(OpenFileContext.Provider, { value: (path: string) => { files.push(path); }, children:
        createElement(ChatMarkdownImages, { paneId: "w1:p1", cwd: "/project", connected, onOpen,
          children: createElement(Markdown, { children: "Before ![Inline](./inline.png) after\n\n![Slot](./slot.png)\n\n![Good](./good.png)" }),
        }),
      }),
    }) });
    await page.render(tree);
  };
  await render(true);
  await answer(0, info("/project/inline.png"));
  await answer(1, info("/project/slot.png"));
  await answer(2, info("/project/good.png"));
  await act(async () => { bytes[2]!.resolve("blob:good"); });
  const good = images()[0]!;
  await act(async () => { imageEvent(good, "load"); });

  await act(async () => {
    bytes[0]!.reject(new TypeError("relay closed"));
    bytes[1]!.reject(new TypeError("relay closed"));
  });

  expect(nestedControls.length).toBeGreaterThan(0);
  expect(nestedControls.every((count) => count === 0)).toBe(true);
  expect(buttons().filter((node) => node.className === "markdown-image-open")).toHaveLength(0);
  const file = buttons().find((node) => node.className === "markdown-file")!;
  expect(file.querySelectorAll("button")).toHaveLength(0);
  await act(async () => { file.click(); });
  expect(files).toEqual(["./inline.png"]);
  expect(opened).toEqual([]);
  expect(images()).toEqual([good]);

  await render(false);
  await render(true);
  expect(requests).toHaveLength(5);
  expect(bytes).toHaveLength(3);
  await render(false);
  await render(true);
  expect(requests).toHaveLength(5);
  await answer(3, info("/project/inline.png"));
  await answer(4, info("/project/slot.png"));
  expect(bytes).toHaveLength(5);
  expect(bytes.slice(3).map(({ path }) => path)).toEqual(bytes.slice(0, 2).map(({ path }) => path));
  await render(false);
  await render(true);
  expect(requests).toHaveLength(5);
  expect(bytes).toHaveLength(5);
  await act(async () => { bytes[3]!.resolve("blob:inline"); bytes[4]!.reject(new TypeError("still closed")); });
  await render(false);
  await render(true);
  expect(requests).toHaveLength(6);
  await answer(5, { error: { message: "busy" } }, 503);
  const retry = buttons().find((node) => node.className === "btn markdown-image-retry")!;
  await act(async () => { retry.click(); });
  await answer(6, info("/project/slot.png"));
  expect(bytes).toHaveLength(6);
  await act(async () => { bytes[5]!.resolve("blob:slot"); });
  expect(images()).toHaveLength(3);
  expect(images().find((node) => node.alt === "Good")).toBe(good);
  expect(nestedControls.every((count) => count === 0)).toBe(true);
});

it("stats and opens an answer's image on its owning PC and pane, retaining the real filename", async () => {
  await draw({ machine: "other-pc", pane: "w2:p4", cwd: "/project/", text: "![Diagram](./out/chart%20%23%3F.png)" });
  expect(requests[0]!.url.pathname).toBe("/api/machines/other-pc/fs/stat");
  expect(requests[0]!.url.searchParams.get("path")).toBe("./out/chart #?.png");
  expect(requests[0]!.url.searchParams.get("pane_id")).toBe("w2:p4");
  expect(images()).toHaveLength(0);
  await answer(0, info("/foreground/out/chart #?.png"));
  const src = new URL(images()[0]!.getAttribute("src")!, "http://test.local");
  expect(src.pathname).toBe("/api/machines/other-pc/fs/file");
  expect(src.searchParams.get("pane_id")).toBe("w2:p4");
  expect(src.searchParams.get("path")).toBe("/foreground/out/chart #?.png");
  let focused = false;
  expect(buttons()[0]!.getAttribute("aria-label")).toBe("Diagram");
  const button = buttons()[0]!;
  button.addEventListener("focus", () => { focused = true; });
  await act(async () => { button.click(); });
  expect(focused).toBe(true);
  expect(opened).toEqual([{ src: images()[0]!.getAttribute("src")!, name: "Diagram", file: "chart #?.png" }]);
  await draw({ machine: "other-pc", pane: "w2:p4", cwd: "/project/", text: "![Diagram](./out/chart%20%23%3F.png)" });
  expect(requests).toHaveLength(1);
});

it("discards a late answer from the old PC and hides old bytes while the pane or cwd changes", async () => {
  await draw({ machine: "old" });
  await draw({ machine: "new" });
  await answer(1, info("/project/diagram.png"));
  expect(images()[0]!.getAttribute("src")!).toContain("/api/machines/new/");
  await answer(0, info("/old/diagram.png"));
  expect(images()[0]!.getAttribute("src")!).toContain("/api/machines/new/");
  await draw({ machine: "new", pane: "w2:p2", cwd: "/next" });
  expect(images()).toHaveLength(0);
  expect(requests[2]!.url.searchParams.get("path")).toBe("./diagram.png");
  expect(requests[2]!.url.searchParams.get("pane_id")).toBe("w2:p2");
  await answer(2, info("/next/diagram.png"));
  expect(new URL(images()[0]!.getAttribute("src")!, "http://test.local").searchParams.get("pane_id")).toBe("w2:p2");
});

it("lets the server resolve relative images even when the browser has no cwd hint", async () => {
  await draw({ cwd: null });
  expect(requests[0]!.url.searchParams.get("path")).toBe("./diagram.png");
  expect(requests[0]!.url.searchParams.get("pane_id")).toBe("w1:p1");
  await answer(0, info("/foreground/diagram.png"));
  expect(images()).toHaveLength(1);
  await draw({ cwd: null, text: "![Absolute](/tmp/a.png)\n\n![URI](file:///tmp/b%20c.png)" });
  expect(requests.slice(1).map(({ url }) => url.searchParams.get("path"))).toEqual(["/tmp/a.png", "/tmp/b c.png"]);
  await answer(1, info("/tmp/a.png"));
  await answer(2, info("/tmp/b c.png"));
  expect(images()).toHaveLength(2);
});

it("offers an oversized image only as a download on the same PC and pane", async () => {
  await draw({ machine: "other-pc", pane: "w2:p4" });
  await answer(0, info("/project/diagram.png", MAX_INLINE_IMAGE_BYTES + 1));
  expect(images()).toHaveLength(0);
  expect(buttons()).toHaveLength(0);
  const link = page.one<HTMLAnchorElement>("a");
  const url = new URL(link.getAttribute("href")!, "http://test.local");
  expect(url.pathname).toBe("/api/machines/other-pc/fs/file");
  expect(url.searchParams.get("pane_id")).toBe("w2:p4");
  expect(url.searchParams.get("download")).toBe("1");
});

it("offers a retry only for a failed lookup, retaining other fallback links", async () => {
  for (const [index, body, status] of [
    [0, { error: { message: "missing" } }, 404],
    [1, { error: { candidates: ["/one/a.png", "/two/a.png"] } }, 409],
    [2, { ...info("/project/a.png"), kind: "text" }, 200],
    [3, { error: { message: "denied" } }, 403],
  ] as const) {
    await draw({ text: `![Diagram](./${index}.png)` });
    await answer(index, body, status);
    expect(images()).toHaveLength(0);
    expect(buttons()).toHaveLength(status === 404 ? 1 : 0);
  }
  expect(requests.every(({ url }) => url.pathname === "/api/fs/stat")).toBe(true);
});

it("does not nest an image button inside an authored link or a read-only inline label", async () => {
  await draw({ text: '<p><a href="https://example.com"><img src="./badge.png" alt="Badge"></a></p>', html: true });
  await answer(0, info("/project/badge.png"));
  expect(images()).toHaveLength(1);
  expect(page.container.querySelectorAll("a")).toHaveLength(1);
  expect(buttons()).toHaveLength(0);
  await draw({ text: "![Label](./label.png)", inline: true });
  expect(requests).toHaveLength(1);
  expect(images()).toHaveLength(0);
  expect(buttons()).toHaveLength(0);
});

it("keeps a failed image's reserved slot and access to the viewer's download", async () => {
  await draw();
  await answer(0, info("/project/diagram.png"));
  await act(async () => { imageEvent(images()[0]!, "error"); });
  expect(images()).toHaveLength(0);
  expect(page.container.querySelectorAll('[class="image-slot is-failed"]')).toHaveLength(1);
  await act(async () => { buttons()[0]!.click(); });
  expect(opened[0]!.file).toBe("diagram.png");
});

it("retries only failed stats without multiplying pending or resolved images across reconnects", async () => {
  const text = Array.from({ length: 100 }, (_, index) => `![Image ${index}](./${index}.png)`).join("\n\n");
  await draw({ text, connected: false });
  for (let index = 0; index < 50; index++) await answer(index, info(`/project/${index}.png`));
  await answer(50, { error: { message: "offline" } }, 503);
  const sources = images().map((image) => image.getAttribute("src")!);

  for (let reconnect = 0; reconnect < 5; reconnect++) {
    await draw({ text, connected: false });
    await draw({ text, connected: true });
  }

  expect(requests).toHaveLength(101);
  expect(images().map((image) => image.getAttribute("src")!)).toEqual(sources);
  await answer(100, info("/project/50.png"));
  await answer(51, info("/project/51.png"));
  expect(images()).toHaveLength(52);
});

it("renders only the file action when an inline image fails decoding", async () => {
  const files: string[] = [];
  await page.render(createElement(SettingsProvider, { children:
    createElement(OpenFileContext.Provider, { value: (path: string) => { files.push(path); }, children:
      createElement(ChatMarkdownImages, { paneId: "w1:p1", cwd: "/project", connected: true, onOpen,
        children: createElement(Markdown, { children: "Before ![Broken](./broken.png) after" }),
      }),
    }),
  }));
  await answer(0, info("/project/broken.png"));

  await act(async () => { imageEvent(images()[0]!, "error"); });

  expect(buttons()).toHaveLength(1);
  expect(buttons()[0]!.className).toBe("markdown-file");
  await act(async () => { buttons()[0]!.click(); });
  expect(files).toEqual(["./broken.png"]);
  expect(opened).toEqual([]);
});

it("retries failed image bytes only after a fresh stat, without remounting a decoded neighbor", async () => {
  const text = "![Good](./good.png)\n\n![Retry](./retry.png)";
  await draw({ text });
  await answer(0, info("/project/good.png"));
  await answer(1, info("/project/retry.png"));
  const good = images().find((node) => node.alt === "Good")!;
  const failed = images().find((node) => node.alt === "Retry")!;
  await act(async () => { imageEvent(good, "load"); imageEvent(failed, "error"); });
  expect(images()).toHaveLength(1);
  await draw({ text, connected: false });
  await draw({ text, connected: true });
  expect(images()).toHaveLength(1);
  expect(requests).toHaveLength(3);
  expect(requests[2]!.url.searchParams.get("path")).toBe("./retry.png");
  await answer(2, info("/project/retry.png"));
  expect(images()).toHaveLength(2);
  expect(images().find((node) => node.alt === "Good")).toBe(good);
  await act(async () => { imageEvent(images().find((node) => node.alt === "Retry")!, "load"); });
  expect(page.container.querySelectorAll('[class="image-slot is-failed"]')).toHaveLength(0);
});

it("lets the reader recover a 503 without reconnecting or remounting the answer", async () => {
  await draw({ text: "First answer: ![Diagram](./diagram.png)" });
  await answer(0, { error: { message: "busy" } }, 503);
  expect(images()).toHaveLength(0);
  expect(buttons()[0]!.textContent).toBe("Try again");
  await draw({ text: "Updated answer: ![Diagram](./diagram.png)" });
  expect(requests).toHaveLength(1);
  await act(async () => { buttons()[0]!.click(); });
  expect(requests).toHaveLength(2);
  expect(buttons()[0]!.disabled).toBe(true);
  await answer(1, info("/foreground/diagram.png"));
  expect(images()).toHaveLength(1);
  expect(images()[0]!.getAttribute("src")!).toContain("%2Fforeground%2Fdiagram.png");
});

it("keeps a decoded canonical image when a browser cwd hint arrives", async () => {
  await draw({ cwd: null });
  await answer(0, info("/foreground/diagram.png"));
  const image = images()[0]!;
  await act(async () => { imageEvent(image, "load"); });
  await draw({ cwd: "/stale-pane-hint" });
  expect(requests).toHaveLength(1);
  expect(images()[0]).toBe(image);
});

it("keeps a decoded image and the answer's words when the pane's skill names arrive", async () => {
  const text = "![Diagram](./diagram.png)\n\nRun /review next.";
  await draw({ text });
  await answer(0, info("/project/diagram.png"));
  const image = images()[0]!;
  await act(async () => { imageEvent(image, "load"); });
  const words = [...page.container.querySelectorAll("p")].at(-1)!;
  await draw({ text, skills: createSkillMatcher([{ name: "review", description: "", source: "skill" }]) });
  expect(page.container.querySelectorAll('[class="markdown-skill"]')).toHaveLength(1);
  expect([...page.container.querySelectorAll("p")].at(-1)).toBe(words);
  expect(images()[0]).toBe(image);
  expect(requests).toHaveLength(1);
});

it("keeps manual Retry usable after a pending retry fails across reconnects", async () => {
  await draw();
  await answer(0, { error: { message: "busy" } }, 503);
  await act(async () => { buttons()[0]!.click(); });
  expect(buttons()[0]!.disabled).toBe(true);
  await draw({ connected: false });
  await draw({ connected: true });
  expect(requests).toHaveLength(2);
  await answer(1, { error: { message: "still busy" } }, 503);
  expect(buttons()[0]!.disabled).toBe(false);
  await act(async () => { buttons()[0]!.click(); });
  expect(requests).toHaveLength(3);
  await answer(2, info("/foreground/diagram.png"));
  expect(images()).toHaveLength(1);
});

it("holds a reopened image at the size it decoded at, and loads nothing before the new stat", async () => {
  Object.defineProperties(page.window.HTMLImageElement.prototype, {
    complete: { configurable: true, get: () => true },
    naturalWidth: { configurable: true, get: () => 240 },
    naturalHeight: { configurable: true, get: () => 80 },
  });
  const mount = async (pane = "w1:p1") => {
    const tree = createElement(SettingsProvider, { children: createElement(MachineContext.Provider, { value: "reopen-pc",
      children: createElement(ChatMarkdownImages, { paneId: pane, cwd: "/project", connected: true, onOpen, children: createElement(Markdown, { children: "![Diagram](./diagram.png)" }) }),
    }) });
    await page.render(tree);
  };
  const slot = () => page.one<HTMLSpanElement>('span[class^="image-slot"]');
  const reopen = async (pane?: string) => {
    await page.render(null);
    await mount(pane);
  };
  await mount();
  await answer(0, info("/project/diagram.png"));
  expect(slot().className).toBe("image-slot");

  await reopen();

  expect(slot().className).toBe("image-slot is-loading is-sized");
  expect({ "--image-width": slot().style.getPropertyValue("--image-width"), "--image-ratio": slot().style.getPropertyValue("--image-ratio") }).toMatchObject({ "--image-width": "240px", "--image-ratio": "240 / 80" });
  expect(images()).toHaveLength(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url.pathname).toBe("/api/machines/reopen-pc/fs/stat");

  await reopen("w9:p9");
  expect(slot().className).toBe("image-slot is-loading");
});
