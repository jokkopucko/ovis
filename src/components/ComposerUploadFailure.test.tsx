import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { ApiError, uploadPaneImage } from "../lib/api.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

const pane = "upload-failure-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout },
    document: { ...listen, querySelector: () => null },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, composerPasteSend: false }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  composerDrafts.set(draftKey, "");
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const note = () => renderer!.root.findAll((node) => node.props.className === "composer-note-text").map((node) => node.children.filter((child) => typeof child === "string").join(""))[0] ?? null;
const details = () => renderer!.root.findAllByType("code").map((node) => node.children.join(""));

it.each([
  ["the connection's own words", new TypeError("Relay request failed"), "IMG_4242.jpg could not be attached: Relay request failed", []],
  ["the HTTP status of an answer with no words", new ApiError("/api/pane/image", 502, "", null), "IMG_4242.jpg could not be attached: HTTP 502", []],
  ["a known cause, keeping the server's words in Details,", new ApiError("/api/pane/image", 404, "gone", null), "IMG_4242.jpg could not be attached: It no longer exists on the PC", ["gone"]],
  ["a known cause with no advice, keeping the server's words in Details,", new ApiError("/api/pane/image", 400, "ENOSPC: no space left on device", null), "IMG_4242.jpg could not be attached: PC disk is full", ["ENOSPC: no space left on device"]],
  ["a known cause of an answer with no words, leaving its HTTP status out of Details,", new ApiError("/api/pane/image", 404, "", null), "IMG_4242.jpg could not be attached: It no longer exists on the PC", []],
])("puts %s on the line of an upload that failed", async (_name, error, said, detail) => {
  const upload = async (): Promise<string> => { throw error; };
  await act(async () => {
    renderer = create(<Composer paneId={pane} agent="claude" agentStatus="idle" connected autoFocus={false} onSend={() => true} onAbort={() => {}} onUploadImage={upload} />);
  });
  const input = renderer!.root.find((node) => node.type === "input" && node.props.type === "file");
  const photo = new File(["jpeg"], "IMG_4242.jpg", { type: "image/jpeg" });
  await act(async () => { input.props.onChange({ currentTarget: { files: [photo], value: "" } }); });
  expect(note()).toBe(said);
  expect(details()).toEqual(detail);
});

it.each([
  ["Bad Gateway"],
  ["Upstream TLS permission denied"],
])("shows HTTP status and keeps Try again for an empty HTTP/1.1 502 response (%s)", async (statusText) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 502, statusText })) as unknown as typeof fetch;
  try {
    await act(async () => {
      renderer = create(<Composer paneId={pane} agent="claude" agentStatus="idle" connected autoFocus={false} onSend={() => true} onAbort={() => {}} onUploadImage={(file) => uploadPaneImage(pane, file)} />);
    });
    const input = renderer!.root.find((node) => node.type === "input" && node.props.type === "file");
    const photo = new File(["jpeg"], "IMG_4242.jpg", { type: "image/jpeg" });
    await act(async () => { input.props.onChange({ currentTarget: { files: [photo], value: "" } }); });
    expect(note()).toBe("IMG_4242.jpg could not be attached: HTTP 502");
    expect(details()).toEqual([]);
    expect(renderer!.root.findAll((node) => node.type === "button" && node.children.includes("Try again")).length).toBe(1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

it.each([
  ["LF newlines", ["Upload failed", ...Array.from({ length: 60 }, (_, i) => `diagnostic line ${i + 1}`)].join("\n")],
  ["Unicode line separators", `Upload failed${"\u2028".repeat(60)}tail`],
])("caps a diagnostic with %s on the note line and keeps the full message in Details", async (_label, full) => {
  const upload = async (): Promise<string> => { throw new ApiError("/api/pane/image", 502, full, null); };
  await act(async () => {
    renderer = create(<Composer paneId={pane} agent="claude" agentStatus="idle" connected autoFocus={false} onSend={() => true} onAbort={() => {}} onUploadImage={upload} />);
  });
  const input = renderer!.root.find((node) => node.type === "input" && node.props.type === "file");
  const photo = new File(["jpeg"], "IMG_4242.jpg", { type: "image/jpeg" });
  await act(async () => { input.props.onChange({ currentTarget: { files: [photo], value: "" } }); });
  expect(note()).toBe("IMG_4242.jpg could not be attached: Upload failed");
  expect(details()).toEqual([full]);
});
