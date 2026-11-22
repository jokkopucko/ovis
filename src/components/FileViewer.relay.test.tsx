import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { FileViewer } from "./FileViewer.tsx";
import { TextFileView } from "./TextFileView.tsx";
import type { FileInfo } from "../../shared/files.ts";
import { MAX_INLINE_IMAGE_BYTES } from "../lib/markdownImages.ts";
import { RelayResourceTooLargeError } from "../lib/relay/resources.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { nativeTransport, setTransport, type Transport } from "../lib/transport.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, location: { pathname: "/s/shell/" }, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, activeElement: null, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  setTransport(nativeTransport);
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function relayPc(info: FileInfo, expected: number, body: () => Response = () => new Response("hello\n", { status: 206, headers: { "content-range": "bytes 0-5/6" } }), refusal: () => Error = () => new RelayResourceTooLargeError()): { transport: Transport; refused: Promise<string[]> } {
  const paths: string[] = [];
  let done: (paths: string[]) => void = () => {};
  const refused = new Promise<string[]>((resolve) => { done = resolve; });
  const transport: Transport = {
    ...nativeTransport,
    kind: "relay",
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("/api/fs/stat")) return Response.json(info);
      return body();
    },
    resourceUrl: (path) => {
      paths.push(path);
      if (paths.length >= expected) done(paths);
      return Promise.reject(refusal());
    },
  };
  return { transport, refused };
}

const shown = (): string => JSON.stringify(renderer?.toJSON());

async function open(info: FileInfo, expected: number, body?: () => Response, refusal?: () => Error): Promise<string[]> {
  const pc = relayPc(info, expected, body, refusal);
  setTransport(pc.transport);
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(FileViewer, { path: info.path, paneId: null, onClose() {}, page: true }) }));
  });
  const paths = await pc.refused;
  for (let previous = "", round = 0; previous !== shown() && round < 50; round++) {
    previous = shown();
    await act(async () => { await Promise.resolve(); });
  }
  return paths;
}

test("a refused relay download leaves a loaded text preview in the body", async () => {
  const paths = await open({ path: "/w/a.txt", name: "a.txt", size: 6, modified: "2026-10-31T00:00:00Z", mime: "text/plain", kind: "text" }, 1);
  expect(paths).toEqual([expect.stringContaining("download=1")]);
  expect(renderer?.root.findAllByType(TextFileView)).toHaveLength(1);
  expect(shown()).not.toContain("Too large to open on the phone");
});

test("an image too large to show inline is offered as a download, not fetched for the body", async () => {
  const size = MAX_INLINE_IMAGE_BYTES + 1;
  const paths = await open({ path: "/w/big.png", name: "big.png", size, modified: "2026-10-31T00:00:00Z", mime: "image/png", kind: "image" }, 1);
  expect(paths).toEqual([expect.stringContaining("download=1")]);
  expect(shown()).toContain("download it to view");
  expect(shown()).not.toContain("Too large to open on the phone");
});

test("a text preview whose PC went away after its stat says the PC is unreachable, not that the file is unreadable", async () => {
  const away = () => Response.json({ error: { code: "machine_offline", message: "PC is offline" } }, { status: 502 });
  await open({ path: "/w/a.txt", name: "a.txt", size: 6, modified: "2026-10-31T00:00:00Z", mime: "text/plain", kind: "text" }, 1, away);
  expect(shown()).toContain("That PC is not reachable right now.");
  expect(shown()).not.toContain("The file could not be opened.");
});

test("a video whose relay transfer dropped does not point at a download link that has no address", async () => {
  await open({ path: "/w/clip.mp4", name: "clip.mp4", size: 6, modified: "2026-10-31T00:00:00Z", mime: "video/mp4", kind: "video" }, 1, undefined, () => new Error("relay channel closed"));
  expect(shown()).toContain("The file could not be opened.");
  expect(shown()).not.toContain("Download it or open the raw file.");
});
