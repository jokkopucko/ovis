import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import type { WorkspaceInfo } from "../../shared/protocol.ts";
import { SettingsProvider } from "../lib/settings.ts";

import { WorktreeRequestDialog } from "./WorktreeDialog.tsx";

const repository = (id: string): WorkspaceInfo => ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false,
  worktree: { repo_key: id, repo_name: id, repo_root: `/${id}`, checkout_path: `/${id}`, is_linked_worktree: false } });

describe("the palette's worktree dialog", () => {
  let page: Page;
  const browserGlobals = ["HTMLElement"] as const;
  const savedBrowserGlobals = new Map(browserGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let creates: ReturnType<typeof Promise.withResolvers<Response>>[];

  beforeEach(() => {
    page = openPage("http://ovis.test/");
    creates = [];
    for (const key of browserGlobals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: page.window[key] });
    Object.defineProperties(page.window, {
      requestAnimationFrame: { configurable: true, value: () => 1 },
      cancelAnimationFrame: { configurable: true, value: () => {} },
    });
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input, "http://ovis.test/");
      if (url.pathname !== "/api/worktree/create" || init?.method !== "POST") return Response.json({ agents: [] });
      const reply = Promise.withResolvers<Response>();
      creates.push(reply);
      return reply.promise;
    }, { preconnect: globalThis.fetch.preconnect }));
  });

  afterEach(async () => {
    await page.close();
    for (const [key, descriptor] of savedBrowserGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
  });

  const dialog = (workspace: WorkspaceInfo, onOpened: () => void = () => undefined) => <SettingsProvider>
    <WorktreeRequestDialog request={{ machineId: "local", workspace, mode: "create" }} onClose={() => undefined} onOpened={onOpened} onOpenPane={() => undefined} />
  </SettingsProvider>;
  const branchField = () => {
    const field = document.querySelector<HTMLInputElement>("input.worktree-code-input");
    if (!field) throw new Error("Branch input did not mount");
    return field;
  };
  const submit = async () => {
    const form = document.querySelector("form");
    if (!form) throw new Error("Worktree form did not mount");
    await act(async () => { form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    expect(creates).toHaveLength(1);
    const [reply] = creates;
    if (!reply) throw new Error("Worktree creation did not start");
    return reply;
  };

  it("focuses the Branch field and selects the suggested branch in create mode (#1222)", async () => {
    const frames: FrameRequestCallback[] = [];
    spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    await page.render(dialog(repository("focus-fixture")));
    for (const frame of frames) frame(0);

    const branch = branchField();
    expect<unknown>(document.activeElement).toBe(branch);
    expect(branch.value).not.toBe("");
    expect([branch.selectionStart, branch.selectionEnd]).toEqual([0, branch.value.length]);
  });

  it("starts another repository from that repository's own draft, never the branch typed for the first", async () => {
    await page.render(dialog(repository("api")));
    await page.type(branchField(), "feat/for-api");
    await page.render(dialog(repository("web")));
    expect(branchField().value).not.toBe("feat/for-api");
    await page.render(dialog(repository("api")));
    expect(branchField().value).toBe("feat/for-api");
  });

  it("keeps a draft typed after a replaced dialog's creation was sent, when that creation answers", async () => {
    await page.render(dialog(repository("api")));
    await page.type(branchField(), "feat/one");
    const reply = await submit();
    await page.render(dialog(repository("web")));
    await page.render(dialog(repository("api")));
    await page.type(branchField(), "feat/two");
    await act(async () => { reply.resolve(Response.json({ workspace_id: "w9", pane_id: "p9", agent_started: true })); });
    await page.render(dialog(repository("web")));
    await page.render(dialog(repository("api")));
    expect(branchField().value).toBe("feat/two");
  });

  it("names the PC it was asked for by its name in the title, not by its id", async () => {
    await page.render(<SettingsProvider>
        <WorktreeRequestDialog request={{ machineId: "4f1c2d9e-0b7a-4c55-9a39-2f6d1e8b7c10", machineName: "Office PC", workspace: repository("api"), mode: "create" }} onClose={() => undefined} onOpened={() => undefined} onOpenPane={() => undefined} />
      </SettingsProvider>);
    expect(document.querySelector("h2")?.textContent).toBe("New worktree · api · Office PC");
  });

  it("ignores the answer of a dialog that another repository's replaced", async () => {
    const opened: string[] = [];
    await page.render(dialog(repository("api"), () => opened.push("api")));
    const reply = await submit();
    await page.render(dialog(repository("web"), () => opened.push("web")));
    await act(async () => { reply.resolve(Response.json({ workspace_id: "w9", pane_id: "p9", agent_started: true })); });
    expect(opened).toEqual([]);
  });
});
