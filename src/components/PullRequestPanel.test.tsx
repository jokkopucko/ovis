import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { PullRequestPanel } from "./PullRequestPanel.tsx";
import { paneStorageId } from "../../shared/machines.ts";
import type { PullRequestCheckLog, PullRequestView } from "../../shared/pull-request.ts";
import { composerDraftKey, composerDrafts } from "../lib/composerDraft.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { SettingsProvider } from "../lib/settings.ts";

const globals = ["IS_REACT_ACT_ENVIRONMENT", "window", "document", "getComputedStyle", "navigator"];
const saved = new Map(globals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const draftKey = composerDraftKey(paneStorageId("local", "fixture"));
let renderer: ReactTestRenderer | undefined;

const VIEW: PullRequestView = {
  number: 12, title: "Fix the thing", url: "https://github.com/acme/widgets/pull/12", state: "open", draft: false,
  head_ref: "fix/thing", base_ref: "main", head_oid: "f".repeat(40), merge_state: "blocked", merge_queue: false, mergeable: false, merge_method: "squash",
  checks: [
    { name: "test", workflow: "CI", state: "fail", url: "https://github.com/acme/widgets/actions/runs/1/job/103", job_id: "103" },
    { name: "lint", workflow: "CI", state: "pass", url: "https://github.com/acme/widgets/actions/runs/1/job/101", job_id: "101" },
  ],
  threads: [],
  threads_truncated: false,
};
const LOG: PullRequestCheckLog = { job_id: "103", text: "expected 2, got 3\nerror: 1 test failed", truncated: true };

beforeEach(() => {
  const listen = { addEventListener() {}, removeEventListener() {} };
  const style = { setProperty() {}, removeProperty() {}, getPropertyValue: () => "", backgroundColor: "" };
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: { ...listen, localStorage: { getItem: () => null, setItem() {} }, matchMedia: () => ({ ...listen, matches: false }) },
    document: { ...listen, documentElement: { lang: "", dataset: {}, style }, querySelector: () => null },
    getComputedStyle: () => style,
    navigator: { languages: ["en"] },
  });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  composerDrafts.set(draftKey, "");
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  jest.restoreAllMocks();
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

/** The HTTP boundary: the view and the log answer as the server would; every request is recorded. */
function serve(view: PullRequestView): { method: string; url: string }[] {
  const requests: { method: string; url: string }[] = [];
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url });
    return Response.json(url.includes("/workspace/pr/log") ? LOG : view);
  }, globalThis.fetch));
  return requests;
}

const panel = () => createElement(SettingsProvider, { children: createElement(PullRequestPanel, { paneId: "fixture", directory: "/repo" }) });
const buttonNamed = (name: string): ReactTestInstance[] => renderer!.root.findAll((node) => node.type === "button" && node.children.join("") === name);
const textOf = (node: ReactTestInstance | string): string => typeof node === "string" ? node : node.children.map(textOf).join("");

test("puts a failing check's name and the end of its log into the pane's draft, and sends nothing", async () => {
  const requests = serve(VIEW);
  composerDrafts.set(draftKey, "my own words");
  await act(async () => { renderer = create(panel()); });
  const send = buttonNamed("Send to agent");
  // only the failing check offers it
  expect(send).toHaveLength(1);
  await act(async () => { send[0]!.props.onClick(); });
  const draft = composerDrafts.read(draftKey).text;
  expect(draft.startsWith("my own words\n\n")).toBe(true);
  expect(draft).toContain("The check \"CI / test\" failed on pull request #12 (https://github.com/acme/widgets/actions/runs/1/job/103).");
  expect(draft).toContain("```\nexpected 2, got 3\nerror: 1 test failed\n```");
  expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
  expect(requests[1]!.url).toContain("/workspace/pr/log?pane_id=fixture&directory=%2Frepo&job_id=103&host=github.com");
});

test("keeps Merge off, with GitHub's reason, until GitHub would merge", async () => {
  serve(VIEW);
  await act(async () => { renderer = create(panel()); });
  expect(buttonNamed("Squash and merge")).toHaveLength(0);
  const merge = renderer!.root.findAll((node) => node.type === "button" && textOf(node) === "Squash and merge");
  expect(merge).toHaveLength(1);
  expect(merge[0]!.props.disabled).toBe(true);
  expect(textOf(renderer!.root)).toContain("Required checks or reviews have not passed yet.");
  await act(async () => renderer?.unmount());

  serve({ ...VIEW, merge_state: "clean", mergeable: true });
  await act(async () => { renderer = create(panel()); });
  expect(renderer!.root.findAll((node) => node.type === "button" && textOf(node) === "Squash and merge")[0]!.props.disabled).toBe(false);
});

test("shows the directory in the bar instead of repeating the tab title on error, and prefixes remote PC errors with the PC id", async () => {
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    return Response.json({ error: { code: "gh_signed_out", message: "not signed in" } }, { status: 409 });
  }, globalThis.fetch));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, {
      children: createElement(MachineContext.Provider, {
        value: "workstation",
        children: createElement(PullRequestPanel, { paneId: "fixture", directory: "/repo" }),
      }),
    }));
  });
  const heading = renderer!.root.findByProps({ className: "pull-request-heading" });
  expect(textOf(heading)).toBe("workstation · /repo");
  const alert = renderer!.root.findByProps({ role: "alert" });
  expect(textOf(alert)).toContain("[workstation] GitHub CLI (gh) on this PC is not signed in.");
});

test("names a remote PC by its name, not its id, and prefixes the PC's own gh words with it", async () => {
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    return Response.json({ error: { code: "gh_failed", message: "HTTP 502: bad gateway" } }, { status: 502 });
  }, globalThis.fetch));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, {
      children: createElement(MachineContext.Provider, {
        value: "3f1c2b9a-6d0e-4c1a-9b7e-2f4d8a0c5e11",
        children: createElement(PullRequestPanel, { paneId: "fixture", directory: "/repo", machineName: "Build box" }),
      }),
    }));
  });
  expect(textOf(renderer!.root.findByProps({ className: "pull-request-heading" }))).toBe("Build box · /repo");
  expect(textOf(renderer!.root.findByProps({ role: "alert" }))).toBe("[Build box] HTTP 502: bad gateway");
});

test("names the PC by its name, not its id, where one is given", async () => {
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => {
    return Response.json({ error: { code: "gh_signed_out", message: "not signed in" } }, { status: 409 });
  }, globalThis.fetch));
  await act(async () => {
    renderer = create(createElement(SettingsProvider, {
      children: createElement(MachineContext.Provider, {
        value: "4f1c2d9e-0b7a-4c55-9a39-2f6d1e8b7c10",
        children: createElement(PullRequestPanel, { paneId: "fixture", directory: "/repo", machineName: "Office PC" }),
      }),
    }));
  });
  expect(textOf(renderer!.root.findByProps({ className: "pull-request-heading" }))).toBe("Office PC · /repo");
  expect(textOf(renderer!.root.findByProps({ role: "alert" }))).toContain("[Office PC] GitHub CLI (gh) on this PC is not signed in.");
});
