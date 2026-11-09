import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { WorkspaceInfo } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";

await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { WorktreeRequestDialog } = await import("./WorktreeDialog.tsx");

const repository = (id: string): WorkspaceInfo => ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false,
  worktree: { repo_key: id, repo_name: id, repo_root: `/${id}`, checkout_path: `/${id}`, is_linked_worktree: false } });

describe("the palette's worktree dialog", () => {
  let renderer: ReactTestRenderer | undefined;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let answerCreate: (body: unknown) => void = () => undefined;

  beforeEach(() => {
    for (const key of ["window", "document", "navigator", "getComputedStyle", "matchMedia", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    define("IS_REACT_ACT_ENVIRONMENT", true);
    define("HTMLElement", class HTMLElement {});
    define("navigator", { languages: ["en"], userAgent: "Test browser", maxTouchPoints: 0 });
    define("matchMedia", matchMedia);
    define("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    define("window", { location: { href: "http://ovis.test/" }, history: { state: null, pushState() {}, replaceState() {}, back() {} }, matchMedia, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout, clearTimeout });
    define("document", { documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), body: {} });
    // the PC's agents answer at once; a worktree's creation waits until the test answers it
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => String(input).includes("worktree/create")
      ? new Promise<Response>((resolve) => { answerCreate = (body) => resolve(Response.json(body)); })
      : Response.json({ agents: [] }), { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    mock.restore();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const dialog = (workspace: WorkspaceInfo, onOpened: () => void = () => undefined) => <SettingsProvider>
    <WorktreeRequestDialog request={{ machineId: "local", workspace, mode: "create" }} onClose={() => undefined} onOpened={onOpened} onOpenPane={() => undefined} />
  </SettingsProvider>;
  const branchField = (): ReactTestInstance => renderer!.root.findAll((node) => node.type === "input" && String(node.props.className).includes("worktree-code-input"))[0]!;

  it("starts another repository from that repository's own draft, never the branch typed for the first", async () => {
    await act(async () => { renderer = create(dialog(repository("api"))); });
    await act(async () => { branchField().props.onChange({ target: { value: "feat/for-api" } }); });
    await act(async () => { renderer!.update(dialog(repository("web"))); });
    expect(branchField().props.value).not.toBe("feat/for-api");
    // and the first repository's draft is still its own
    await act(async () => { renderer!.update(dialog(repository("api"))); });
    expect(branchField().props.value).toBe("feat/for-api");
  });

  it("keeps a draft typed after a replaced dialog's creation was sent, when that creation answers", async () => {
    await act(async () => { renderer = create(dialog(repository("api"))); });
    await act(async () => { branchField().props.onChange({ target: { value: "feat/one" } }); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await act(async () => { renderer!.update(dialog(repository("web"))); });
    await act(async () => { renderer!.update(dialog(repository("api"))); });
    await act(async () => { branchField().props.onChange({ target: { value: "feat/two" } }); });
    await act(async () => { answerCreate({ workspace_id: "w9", pane_id: "p9", agent_started: true }); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { renderer!.update(dialog(repository("web"))); });
    await act(async () => { renderer!.update(dialog(repository("api"))); });
    expect(branchField().props.value).toBe("feat/two");
  });

  it("names the PC it was asked for by its name in the title, not by its id", async () => {
    await act(async () => {
      renderer = create(<SettingsProvider>
        <WorktreeRequestDialog request={{ machineId: "4f1c2d9e-0b7a-4c55-9a39-2f6d1e8b7c10", machineName: "Office PC", workspace: repository("api"), mode: "create" }} onClose={() => undefined} onOpened={() => undefined} onOpenPane={() => undefined} />
      </SettingsProvider>);
    });
    expect(renderer!.root.findByType("h2").props.children).toBe("New worktree · api · Office PC");
  });

  it("ignores the answer of a dialog that another repository's replaced", async () => {
    const opened: string[] = [];
    await act(async () => { renderer = create(dialog(repository("api"), () => opened.push("api"))); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await act(async () => { renderer!.update(dialog(repository("web"), () => opened.push("web"))); });
    await act(async () => { answerCreate({ workspace_id: "w9", pane_id: "p9", agent_started: true }); await Promise.resolve(); await Promise.resolve(); });
    expect(opened).toEqual([]);
  });
});
