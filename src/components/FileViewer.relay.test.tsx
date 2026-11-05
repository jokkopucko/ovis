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

/**
 * A relay PC holding `info`, whose stat and ranged text reads answer, and whose full-file resource
 * URLs (the download link's, or an image's) fail as a file past the 64 MiB blob cap does.
 * `refused` settles once every expected full-file request has been refused.
 */
function relayPc(info: FileInfo, expected: number): { transport: Transport; refused: Promise<string[]> } {
  const paths: string[] = [];
  let done: (paths: string[]) => void = () => {};
  const refused = new Promise<string[]>((resolve) => { done = resolve; });
  const transport: Transport = {
    ...nativeTransport,
    kind: "relay",
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("/api/fs/stat")) return Response.json(info);
      return new Response("hello\n", { status: 206, headers: { "content-range": "bytes 0-5/6" } });
    },
    resourceUrl: (path) => {
      paths.push(path);
      if (paths.length >= expected) done(paths);
      return Promise.reject(new RelayResourceTooLargeError());
    },
  };
  return { transport, refused };
}

const shown = (): string => JSON.stringify(renderer?.toJSON());

async function open(info: FileInfo, expected: number): Promise<string[]> {
  const pc = relayPc(info, expected);
  setTransport(pc.transport);
  await act(async () => {
    renderer = create(createElement(SettingsProvider, { children: createElement(FileViewer, { path: info.path, paneId: null, onClose() {}, page: true }) }));
  });
  const paths = await pc.refused;
  // the refusals and the text read land in state over the following commits: settle until neither changes the tree
  for (let previous = "", round = 0; previous !== shown() && round < 50; round++) {
    previous = shown();
    await act(async () => { await Promise.resolve(); });
  }
  return paths;
}

test("a refused relay download leaves a loaded text preview in the body", async () => {
  // Given a text file whose ranged preview loads but whose full download is refused as too large
  const paths = await open({ path: "/w/a.txt", name: "a.txt", size: 6, modified: "2026-10-31T00:00:00Z", mime: "text/plain", kind: "text" }, 1);
  expect(paths).toEqual([expect.stringContaining("download=1")]);
  // Then the preview shows, and the download's failure does not replace it
  expect(renderer?.root.findAllByType(TextFileView)).toHaveLength(1);
  expect(shown()).not.toContain("Too large to open on the phone");
});

test("an image too large to show inline is offered as a download, not fetched for the body", async () => {
  // Given an image past the inline limit, on a PC whose full-file URLs are refused
  const size = MAX_INLINE_IMAGE_BYTES + 1;
  const paths = await open({ path: "/w/big.png", name: "big.png", size, modified: "2026-10-31T00:00:00Z", mime: "image/png", kind: "image" }, 1);
  // Then only the download link asked for the file, and the body says to download it
  expect(paths).toEqual([expect.stringContaining("download=1")]);
  expect(shown()).toContain("download it to view");
  expect(shown()).not.toContain("Too large to open on the phone");
});
