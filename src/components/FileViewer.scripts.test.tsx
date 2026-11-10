import { afterEach, beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { FileViewer } from "./FileViewer.tsx";
import type { FileInfo } from "../../shared/files.ts";
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

const page = (name: string): FileInfo => ({ path: `/w/${name}`, name, size: 64, modified: "2026-11-11T00:00:00Z", mime: "text/html", kind: "text" });
const HTML = "<!doctype html><body><h1>report</h1><script>document.title = 'ran'</script></body>";

/** A PC that holds every `/w/*.html` asked for; over a relay the rendered page is read as text. */
function pc(kind: Transport["kind"]): Transport {
  return {
    ...nativeTransport,
    kind,
    fetch: async (input) => {
      const url = new URL(String(input), "https://ovis.test");
      if (url.pathname.endsWith("/fs/stat")) return Response.json(page(String(url.searchParams.get("path")).split("/").pop()!));
      return new Response(HTML, { headers: { "content-type": "text/html" } });
    },
  };
}

const frames = (): ReactTestInstance[] => renderer?.root.findAllByType("iframe") ?? [];
const button = (label: string): ReactTestInstance[] => renderer?.root.findAll((node) => node.type === "button" && node.children.includes(label)) ?? [];
const press = async (label: string): Promise<void> => { await act(async () => { (button(label)[0]!.props["onClick"] as () => void)(); }); };
const shown = (): string => JSON.stringify(renderer?.toJSON());
async function until(done: () => boolean): Promise<void> {
  for (let round = 0; round < 500 && !done(); round++) await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
  expect(done()).toBe(true);
}
async function view(transport: Transport, path: string): Promise<void> {
  setTransport(transport);
  await act(async () => { renderer = create(createElement(SettingsProvider, { children: createElement(FileViewer, { path, paneId: null, onClose() {}, page: true }) })); });
  await until(() => frames().length === 1);
}

test("an HTML page is framed without its scripts until Run scripts, in a frame of its own for each; the same file keeps them through Source and back", async () => {
  // Given an HTML file opened in the viewer
  await view(pc("native"), "/w/report.html");
  // Then its frame allows no script, and the line above it says so and offers them
  const still = frames()[0]!;
  expect([still.props["sandbox"], still.props["data-page-scripts"]]).toEqual(["", "off"]);
  expect(String(still.props["src"])).toContain("render=1");
  expect(shown()).toContain("Scripts in this page are off.");
  expect(button("Run scripts")).toHaveLength(1);

  // When the person asks for them
  await press("Run scripts");
  // Then the page is loaded again in a frame that allows them, and the line is gone
  await until(() => frames()[0]?.props["data-page-scripts"] === "on");
  expect(frames()[0]!.props["sandbox"]).toBe("allow-scripts");
  expect(frames()[0]).not.toBe(still);
  expect(shown()).not.toContain("Scripts in this page are off.");

  // When the person looks at its source and comes back
  await press("Source");
  await until(() => frames().length === 0);
  await press("Page");
  await until(() => frames().length === 1);
  // Then it still runs: the choice is the file's for as long as this viewer is open
  expect(frames()[0]!.props["sandbox"]).toBe("allow-scripts");
});

test("another file, and the same file in a viewer opened anew, start without their scripts", async () => {
  await view(pc("native"), "/w/report.html");
  await press("Run scripts");
  await until(() => frames()[0]?.props["data-page-scripts"] === "on");
  // a viewer opened anew on the same file
  await act(async () => renderer?.unmount());
  await view(pc("native"), "/w/report.html");
  expect([frames()[0]!.props["sandbox"], button("Run scripts").length]).toEqual(["", 1]);
  // and one on another file
  await act(async () => renderer?.unmount());
  await view(pc("native"), "/w/other.html");
  expect([frames()[0]!.props["sandbox"], button("Run scripts").length]).toEqual(["", 1]);
});

test("over a relay the render host is told whether the page's scripts were asked for, and gets the page anew when they are", async () => {
  await view(pc("relay"), "/w/report.html");
  // what the render host is sent once its frame has loaded
  const sent = (frame: ReactTestInstance): unknown[] => {
    const messages: unknown[] = [];
    (frame.props["onLoad"] as (event: unknown) => void)({ currentTarget: { contentWindow: { postMessage: (message: unknown) => { messages.push(message); } } } });
    return messages;
  };
  // Then the render host's frame is the relay's (it needs its own few lines to run), and is told to draw the page without scripts
  const still = frames()[0]!;
  expect([still.props["src"], still.props["sandbox"], still.props["data-page-scripts"]]).toEqual(["/s/shell/~render", "allow-scripts", "off"]);
  expect(sent(still)).toEqual([{ type: "ovis-render", html: HTML, scripts: false }]);
  expect(button("Run scripts")).toHaveLength(1);

  // When the person asks for the page's scripts
  await press("Run scripts");
  await until(() => frames()[0]?.props["data-page-scripts"] === "on");
  // Then a render host loaded anew is told to run the page
  expect(frames()[0]).not.toBe(still);
  expect(sent(frames()[0]!)).toEqual([{ type: "ovis-render", html: HTML, scripts: true }]);
  expect(button("Run scripts")).toHaveLength(0);
});
