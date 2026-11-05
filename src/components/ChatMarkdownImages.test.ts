import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement, Profiler } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

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

let renderer: ReactTestRenderer | undefined;
let requests: Array<{ url: URL; finish: (body: unknown, status?: number) => void }>;
let opened: GalleryImage[];
const descriptors = new Map<string, PropertyDescriptor | undefined>();
const onOpen = (image: GalleryImage) => { opened.push(image); };
const info = (path: string, size = 100): FileInfo => ({ path, name: path.split("/").pop()!, size, modified: "2026-10-30T00:00:00Z", mime: "image/png", kind: "image" });

async function draw({ machine = "local", pane = "w1:p1", cwd = "/project", connected = true, text = "![Diagram](./diagram.png)", inline = false, html = false, skills = null }: {
  machine?: string; pane?: string; cwd?: string | null; connected?: boolean; text?: string; inline?: boolean; html?: boolean; skills?: SkillMatcher | null;
} = {}) {
  const children = inline ? createElement(InlineMarkdown, { children: text }) : createElement(Markdown, { children: text, html, skills });
  const tree = createElement(SettingsProvider, { children: createElement(MachineContext.Provider, { value: machine,
    children: createElement(ChatMarkdownImages, { paneId: pane, cwd, connected, onOpen, children }),
  }) });
  await act(async () => { if (renderer) renderer.update(tree); else renderer = create(tree); });
}
const images = () => renderer!.root.findAllByType("img");
const buttons = () => renderer!.root.findAllByType("button");
async function answer(index: number, body: unknown, status = 200) {
  await act(async () => { requests[index]!.finish(body, status); });
}

beforeEach(() => {
  for (const key of ["window", "document", "getComputedStyle", "fetch", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  descriptors.set("languages", Object.getOwnPropertyDescriptor(navigator, "languages"));
  const listeners = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ...listeners, matchMedia: () => ({ matches: false, ...listeners }) } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { ...listeners, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } } });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  requests = [];
  opened = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: (target: string) => new Promise<Response>((resolve) => {
    requests.push({ url: new URL(target, "http://test.local"), finish: (body, status = 200) => resolve(Response.json(body, { status })) });
  }) });
});
afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  setTransport(nativeTransport);
  renderer = undefined;
  for (const [key, descriptor] of descriptors) {
    const target = key === "languages" ? navigator : globalThis;
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else Reflect.deleteProperty(target, key);
  }
  descriptors.clear();
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
  expect(images()[0]!.props.src).toBe("blob:transport-image");
  expect(resources).toHaveLength(1);
  const resource = new URL(resources[0]!, "http://test.local");
  expect(resource.pathname).toBe("/api/machines/other-pc/fs/file");
  expect(resource.searchParams.get("pane_id")).toBe("w2:p4");
  expect(resource.searchParams.get("path")).toBe("/foreground/diagram.png");
});

it("keeps transport byte failures out of inline viewer controls and retries them after reconnect", async () => {
  // Given inline and standalone failures beside a healthy image, all using transport bytes.
  const files: string[] = [];
  const nestedControls: number[] = [];
  const recordCommit = () => {
    if (!renderer) return;
    nestedControls.push(buttons().flatMap((button) => button.findAll((node) =>
      node !== button && (node.type === "button" || node.type === "a" || node.type === "input"),
    )).length);
  };
  const bytes: Array<{ path: string; resolve: (url: string) => void; reject: (error: Error) => void }> = [];
  setTransport({ ...nativeTransport, kind: "relay", resourceUrl: (path) => new Promise<string>((resolve, reject) => {
    bytes.push({ path, resolve, reject });
  }) });
  const render = async (connected: boolean) => {
    await act(async () => {
      const tree = createElement(Profiler, { id: "image-failures", onRender: recordCommit, children: createElement(SettingsProvider, { children:
        createElement(OpenFileContext.Provider, { value: (path: string) => { files.push(path); }, children:
          createElement(ChatMarkdownImages, { paneId: "w1:p1", cwd: "/project", connected, onOpen,
            children: createElement(Markdown, { children: "Before ![Inline](./inline.png) after\n\n![Slot](./slot.png)\n\n![Good](./good.png)" }),
          }),
        }),
      }) });
      if (renderer) renderer.update(tree); else renderer = create(tree);
    });
  };
  await render(true);
  await answer(0, info("/project/inline.png"));
  await answer(1, info("/project/slot.png"));
  await answer(2, info("/project/good.png"));
  await act(async () => { bytes[2]!.resolve("blob:good"); });
  const good = images()[0]!;
  await act(async () => { good.props.onLoad(); });

  // When transport byte loads fail before an img can receive an error.
  await act(async () => {
    bytes[0]!.reject(new TypeError("relay closed"));
    bytes[1]!.reject(new TypeError("relay closed"));
  });

  // Then the inline fallback is one file action, not nested in an image action.
  expect(nestedControls.length).toBeGreaterThan(0);
  expect(nestedControls.every((count) => count === 0)).toBe(true);
  expect(buttons().filter((node) => node.props.className === "markdown-image-open")).toHaveLength(0);
  const file = buttons().find((node) => node.props.className === "markdown-file")!;
  expect(file.findAll((node) => node !== file && node.type === "button")).toHaveLength(0);
  await act(async () => { file.props.onClick(); });
  expect(files).toEqual(["./inline.png"]);
  expect(opened).toEqual([]);
  expect(images()).toEqual([good]);

  // Reconnect rechecks only failures, single-flight even across another reconnect.
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
  const retry = buttons().find((node) => node.props.className === "btn markdown-image-retry")!;
  await act(async () => { retry.props.onClick(); });
  await answer(6, info("/project/slot.png"));
  expect(bytes).toHaveLength(6);
  await act(async () => { bytes[5]!.resolve("blob:slot"); });
  expect(images()).toHaveLength(3);
  expect(images().find((node) => node.props.alt === "Good")).toBe(good);
  expect(nestedControls.every((count) => count === 0)).toBe(true);
});

it("stats and opens an answer's image on its owning PC and pane, retaining the real filename", async () => {
  await draw({ machine: "other-pc", pane: "w2:p4", cwd: "/project/", text: "![Diagram](./out/chart%20%23%3F.png)" });
  expect(requests[0]!.url.pathname).toBe("/api/machines/other-pc/fs/stat");
  expect(requests[0]!.url.searchParams.get("path")).toBe("./out/chart #?.png");
  expect(requests[0]!.url.searchParams.get("pane_id")).toBe("w2:p4");
  expect(images()).toHaveLength(0);
  await answer(0, info("/foreground/out/chart #?.png"));
  const src = new URL(images()[0]!.props.src, "http://test.local");
  expect(src.pathname).toBe("/api/machines/other-pc/fs/file");
  expect(src.searchParams.get("pane_id")).toBe("w2:p4");
  expect(src.searchParams.get("path")).toBe("/foreground/out/chart #?.png");
  let focused = false;
  expect(buttons()[0]!.props["aria-label"]).toBe("Diagram");
  await act(async () => { buttons()[0]!.props.onClick({ currentTarget: { focus() { focused = true; } } }); });
  expect(focused).toBe(true);
  expect(opened).toEqual([{ src: images()[0]!.props.src, name: "Diagram", file: "chart #?.png" }]);
  await draw({ machine: "other-pc", pane: "w2:p4", cwd: "/project/", text: "![Diagram](./out/chart%20%23%3F.png)" });
  expect(requests).toHaveLength(1);
});

it("discards a late answer from the old PC and hides old bytes while the pane or cwd changes", async () => {
  await draw({ machine: "old" });
  await draw({ machine: "new" });
  await answer(1, info("/project/diagram.png"));
  expect(images()[0]!.props.src).toContain("/api/machines/new/");
  await answer(0, info("/old/diagram.png"));
  expect(images()[0]!.props.src).toContain("/api/machines/new/");
  await draw({ machine: "new", pane: "w2:p2", cwd: "/next" });
  expect(images()).toHaveLength(0);
  expect(requests[2]!.url.searchParams.get("path")).toBe("./diagram.png");
  expect(requests[2]!.url.searchParams.get("pane_id")).toBe("w2:p2");
  await answer(2, info("/next/diagram.png"));
  expect(new URL(images()[0]!.props.src, "http://test.local").searchParams.get("pane_id")).toBe("w2:p2");
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
  const link = renderer!.root.findByType("a");
  const url = new URL(link.props.href, "http://test.local");
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
  expect(renderer!.root.findAllByType("a")).toHaveLength(1);
  expect(buttons()).toHaveLength(0);
  await draw({ text: "![Label](./label.png)", inline: true });
  expect(requests).toHaveLength(1);
  expect(images()).toHaveLength(0);
  expect(buttons()).toHaveLength(0);
});

it("keeps a failed image's reserved slot and access to the viewer's download", async () => {
  await draw();
  await answer(0, info("/project/diagram.png"));
  await act(async () => { images()[0]!.props.onError(); });
  expect(images()).toHaveLength(0);
  expect(renderer!.root.findAll((node) => node.props.className === "image-slot is-failed")).toHaveLength(1);
  await act(async () => { buttons()[0]!.props.onClick({ currentTarget: { focus() {} } }); });
  expect(opened[0]!.file).toBe("diagram.png");
});

it("retries only failed stats without multiplying pending or resolved images across reconnects", async () => {
  // Given resolved, failed and pending images in the same answer.
  const text = Array.from({ length: 100 }, (_, index) => `![Image ${index}](./${index}.png)`).join("\n\n");
  await draw({ text, connected: false });
  for (let index = 0; index < 50; index++) await answer(index, info(`/project/${index}.png`));
  await answer(50, { error: { message: "offline" } }, 503);
  const sources = images().map((image) => image.props.src);

  // When the connection flaps while the retry and other stats remain pending.
  for (let reconnect = 0; reconnect < 5; reconnect++) {
    await draw({ text, connected: false });
    await draw({ text, connected: true });
  }

  // Then only the failed stat was retried, and its current answer still applies.
  expect(requests).toHaveLength(101);
  expect(images().map((image) => image.props.src)).toEqual(sources);
  await answer(100, info("/project/50.png"));
  await answer(51, info("/project/51.png"));
  expect(images()).toHaveLength(52);
});

it("renders only the file action when an inline image fails decoding", async () => {
  // Given an inline image with both file and image actions available.
  const files: string[] = [];
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children:
      createElement(OpenFileContext.Provider, { value: (path: string) => { files.push(path); }, children:
        createElement(ChatMarkdownImages, { paneId: "w1:p1", cwd: "/project", connected: true, onOpen,
          children: createElement(Markdown, { children: "Before ![Broken](./broken.png) after" }),
        }),
      }),
    }));
  });
  await answer(0, info("/project/broken.png"));

  // When decoding fails.
  await act(async () => { images()[0]!.props.onError(); });

  // Then the fallback has no viewer control around it and opens only the file.
  expect(buttons()).toHaveLength(1);
  expect(buttons()[0]!.props.className).toBe("markdown-file");
  await act(async () => { buttons()[0]!.props.onClick(); });
  expect(files).toEqual(["./broken.png"]);
  expect(opened).toEqual([]);
});

it("retries failed image bytes only after a fresh stat, without remounting a decoded neighbor", async () => {
  const text = "![Good](./good.png)\n\n![Retry](./retry.png)";
  await draw({ text });
  await answer(0, info("/project/good.png"));
  await answer(1, info("/project/retry.png"));
  const good = images().find((node) => node.props.alt === "Good")!;
  const failed = images().find((node) => node.props.alt === "Retry")!;
  await act(async () => { good.props.onLoad(); failed.props.onError(); });
  expect(images()).toHaveLength(1);
  await draw({ text, connected: false });
  await draw({ text, connected: true });
  // The previous stat is not enough to start new bytes: the file may now be oversized or gone.
  expect(images()).toHaveLength(1);
  expect(requests).toHaveLength(3);
  expect(requests[2]!.url.searchParams.get("path")).toBe("./retry.png");
  await answer(2, info("/project/retry.png"));
  expect(images()).toHaveLength(2);
  expect(images().find((node) => node.props.alt === "Good")).toBe(good);
  await act(async () => { images().find((node) => node.props.alt === "Retry")!.props.onLoad(); });
  expect(renderer!.root.findAll((node) => node.props.className === "image-slot is-failed")).toHaveLength(0);
});

it("lets the reader recover a 503 without reconnecting or remounting the answer", async () => {
  await draw({ text: "First answer: ![Diagram](./diagram.png)" });
  await answer(0, { error: { message: "busy" } }, 503);
  expect(images()).toHaveLength(0);
  expect(buttons()[0]!.children).toEqual(["Try again"]);
  await draw({ text: "Updated answer: ![Diagram](./diagram.png)" });
  expect(requests).toHaveLength(1);
  await act(async () => { buttons()[0]!.props.onClick(); });
  expect(requests).toHaveLength(2);
  expect(buttons()[0]!.props.disabled).toBe(true);
  await answer(1, info("/foreground/diagram.png"));
  expect(images()).toHaveLength(1);
  expect(images()[0]!.props.src).toContain("%2Fforeground%2Fdiagram.png");
});

it("keeps a decoded canonical image when a browser cwd hint arrives", async () => {
  await draw({ cwd: null });
  await answer(0, info("/foreground/diagram.png"));
  const image = images()[0]!;
  await act(async () => { image.props.onLoad(); });
  await draw({ cwd: "/stale-pane-hint" });
  expect(requests).toHaveLength(1);
  expect(images()[0]).toBe(image);
});

it("keeps a decoded image and the answer's words when the pane's skill names arrive", async () => {
  // the pane's commands load after its transcript: the answer is drawn first without skill names
  const text = "![Diagram](./diagram.png)\n\nRun /review next.";
  await draw({ text });
  await answer(0, info("/project/diagram.png"));
  const image = images()[0]!;
  await act(async () => { image.props.onLoad(); });
  const words = renderer!.root.findAllByType("p").at(-1)!;
  await draw({ text, skills: createSkillMatcher([{ name: "review", description: "", source: "skill" }]) });
  expect(renderer!.root.findAll((node) => node.props.className === "markdown-skill")).toHaveLength(1);
  expect(renderer!.root.findAllByType("p").at(-1)).toBe(words);
  expect(images()[0]).toBe(image);
  expect(requests).toHaveLength(1);
});

it("keeps manual Retry usable after a pending retry fails across reconnects", async () => {
  await draw();
  await answer(0, { error: { message: "busy" } }, 503);
  await act(async () => { buttons()[0]!.props.onClick(); });
  expect(buttons()[0]!.props.disabled).toBe(true);
  await draw({ connected: false });
  await draw({ connected: true });
  expect(requests).toHaveLength(2);
  await answer(1, { error: { message: "still busy" } }, 503);
  expect(buttons()[0]!.props.disabled).toBe(false);
  await act(async () => { buttons()[0]!.props.onClick(); });
  expect(requests).toHaveLength(3);
  await answer(2, info("/foreground/diagram.png"));
  expect(images()).toHaveLength(1);
});

it("holds a reopened image at the size it decoded at, and loads nothing before the new stat", async () => {
  // Given an image a chat on this PC and pane resolved and decoded once, at 240 x 80.
  const decodedImage = { complete: true, naturalWidth: 240, naturalHeight: 80 };
  const mount = async (pane = "w1:p1") => {
    const tree = createElement(SettingsProvider, { children: createElement(MachineContext.Provider, { value: "reopen-pc",
      children: createElement(ChatMarkdownImages, { paneId: pane, cwd: "/project", connected: true, onOpen, children: createElement(Markdown, { children: "![Diagram](./diagram.png)" }) }),
    }) });
    await act(async () => { renderer = create(tree, { createNodeMock: (element) => element.type === "img" ? decodedImage : null }); });
  };
  const slot = () => renderer!.root.findAll((node) => node.type === "span" && String(node.props.className).startsWith("image-slot"))[0]!;
  const reopen = async (pane?: string) => {
    await act(async () => { renderer!.unmount(); });
    await mount(pane);
  };
  await mount();
  await answer(0, info("/project/diagram.png"));
  expect(slot().props.className).toBe("image-slot");

  // When the chat mounts it again, before the new stat answers.
  await reopen();

  // Then its slot is that image's box, not 16:9, and no bytes load until the stat confirms the file.
  expect(slot().props.className).toBe("image-slot is-loading is-sized");
  expect(slot().props.style).toMatchObject({ "--image-width": "240px", "--image-ratio": "240 / 80" });
  expect(images()).toHaveLength(0);
  expect(requests).toHaveLength(2);
  expect(requests[1]!.url.pathname).toBe("/api/machines/reopen-pc/fs/stat");

  // Another pane on the same PC knows nothing of it.
  await reopen("w9:p9");
  expect(slot().props.className).toBe("image-slot is-loading");
});
