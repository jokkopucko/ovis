import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider, useSettings, type Settings } from "../lib/settings.ts";
import { clearNewSessionDrafts, NewSessionDialog, type NewSessionDialogProps } from "./NewSessionDialog.tsx";

// App keeps the dialog mounted and flips `open`: every hook runs whether it is open or not, or React
// refuses the render where it opens ("Rendered more hooks than during the previous render").
describe("NewSessionDialog", () => {
  let page: Page;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  beforeEach(() => {
    page = openPage("https://ovis.example/");
    Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
    Object.defineProperty(page.window, "innerWidth", { configurable: true, value: 1280 });
    for (const [key, value] of Object.entries({ HTMLElement: page.window.HTMLElement, ResizeObserver: page.window.ResizeObserver })) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
  });
  afterEach(async () => {
    clearNewSessionDrafts();
    await page.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const field = (id: string) => page.one<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#${id}`);
  const submit = () => act(async () => {
    page.one("form").dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
  const select = (field: HTMLSelectElement, value: string) => act(async () => {
    field.value = value;
    field.dispatchEvent(new page.window.Event("change", { bubbles: true }) as unknown as Event);
  });
  const pick = async (label: string) => {
    await act(async () => page.one('[role="combobox"][aria-labelledby="new-session-agent"]').click());
    const options = [...page.container.querySelectorAll<HTMLElement>('[role="option"]')];
    const option = options.find((item) => item.querySelector(".menu-item-main")?.textContent === label);
    if (!option) throw new Error(`Missing agent option ${label}`);
    await act(async () => option.click());
  };

  it("opens and closes while it stays mounted", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    const props = (open: boolean): NewSessionDialogProps => ({ open, defaultCwd: "/home/u", onClose: () => undefined, onCreated: () => undefined });
    const view = (open: boolean) => createElement(SettingsProvider, { children: createElement(NewSessionDialog, props(open)) });
    try {
      await page.render(view(false));
      await page.render(view(true));
      expect(page.container.childNodes.length).toBeGreaterThan(0);
      await page.render(view(false));
      expect(page.container.childNodes).toHaveLength(0);
    } finally {
      fetch.mockRestore();
    }
  });

  it("offers the named groups, starts on the folder's last one, and puts the new pane in the group picked (#2431)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("workspace/create") ? { workspace_id: "w9", pane_id: "w9:p1" } : { agents: [] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentNamedGroups: true, agentGroupNames: ["Agents", "Tasks"] }));
    page.window.localStorage.setItem("ovis:agent-group-by-folder", JSON.stringify({ "local\n/home/u": "Tasks" }));
    const created: string[] = [];
    const view = (open: boolean) => createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open, defaultCwd: "/home/u", onClose: () => undefined, onCreated: (paneId) => { created.push(paneId); } }) });
    try {
      await page.render(view(true));
      const group = () => page.one<HTMLSelectElement>("#new-session-group");
      expect(group().value).toBe("Tasks");
      expect([...group().options].map((option) => option.value)).toEqual(["", "Agents", "Tasks"]);
      await select(group(), "Agents");
      await submit();
      expect(created).toEqual(["w9:p1"]);
      expect(JSON.parse(page.window.localStorage.getItem("ovis:settings")!).agentGroupOf).toEqual({ "local:w9:p1": "Agents" });
      expect(JSON.parse(page.window.localStorage.getItem("ovis:agent-group-by-folder")!)).toEqual({ "local\n/home/u": "Agents" });
    } finally {
      fetch.mockRestore();
    }
  });

  it("clears a gone pane's group from a reused id on No group, and prunes the groups of gone panes (#2431)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes("workspace/create") ? { workspace_id: "w9", pane_id: "w9:p1" } : { agents: [] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentNamedGroups: true, agentGroupNames: ["Tasks"], agentGroupOf: { "local:w9:p1": "Tasks", "local:gone": "Tasks", "local:live": "Tasks" } }));
    const groupKept = () => new Set(["local:live"]);
    try {
      await page.render(createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", onClose: () => undefined, onCreated: () => undefined, groupKept }) }));
      expect(field("new-session-group").value).toBe("");
      await submit();
      expect(JSON.parse(page.window.localStorage.getItem("ovis:settings")!).agentGroupOf).toEqual({ "local:live": "Tasks" });
    } finally {
      fetch.mockRestore();
    }
  });

  it("offers no group while Named agent groups is off (#2431)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ agentNamedGroups: false, agentGroupNames: ["Agents"] }));
    try {
      await page.render(createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", onClose: () => undefined, onCreated: () => undefined }) }));
      expect(page.container.querySelectorAll("#new-session-group")).toHaveLength(0);
    } finally {
      fetch.mockRestore();
    }
  });

  it("fills the model and effort Settings > Agents sets for the agent picked, and starts it with them", async () => {
    const bodies: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("workspace/create")) { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ workspace_id: "w9", pane_id: "w9:p1", agent_started: true }), { headers: { "content-type": "application/json" } }); }
      return new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }, { kind: "codex", label: "Codex" }, { kind: "omp", label: "OMP" }] }), { headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ claudeLaunchModel: "opus", claudeLaunchEffort: "high", codexLaunchEffort: "xhigh" }));
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await page.render(view);
      const value = (id: string) => field(id).value;
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["opus", "high"]);
      await pick("Codex");
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["", "xhigh"]);
      await page.type(page.one<HTMLInputElement | HTMLTextAreaElement>("#new-session-model"), "gpt-5-codex");
      await submit();
      expect(bodies).toHaveLength(1);
      expect((bodies[0] as { agent: unknown }).agent).toEqual({ kind: "codex", args: ["--model", "gpt-5-codex", "-c", "model_reasoning_effort=xhigh"] });
    } finally {
      fetch.mockRestore();
    }
  });

  it("starts each agent on its own model and effort while Settings > Agents sets none", async () => {
    const bodies: unknown[] = [];
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("workspace/create")) { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ workspace_id: "w9", pane_id: "w9:p1", agent_started: true }), { headers: { "content-type": "application/json" } }); }
      return new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }, { kind: "codex", label: "Codex" }] }), { headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await page.render(view);
      const effort = () => page.one<HTMLSelectElement>("#new-session-effort");
      expect(field("new-session-model").value).toBe("");
      expect(effort().value).toBe("");
      await pick("Codex");
      await select(effort(), "ultra");
      expect(effort().value).toBe("ultra");
      await pick("Claude Code");
      expect(effort().value).toBe("");
      expect(page.one<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
      await submit();
      expect((bodies[0] as { agent: unknown }).agent).toEqual({ kind: "claude" });
    } finally {
      fetch.mockRestore();
    }
  });

  it("carries a level the reader picked to the next agent, even one equal to the last agent's setting, and never the setting itself", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }, { kind: "codex", label: "Codex" }] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    page.window.localStorage.setItem("ovis:settings", JSON.stringify({ claudeLaunchEffort: "high" }));
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await page.render(view);
      const effort = () => page.one<HTMLSelectElement>("#new-session-effort");
      await pick("Codex");
      expect(effort().value).toBe("");
      expect(page.one<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
      await pick("Claude Code");
      expect(effort().value).toBe("high");
      await select(effort(), "max");
      await select(effort(), "high");
      await pick("Codex");
      expect(effort().value).toBe("high");
    } finally {
      fetch.mockRestore();
    }
  });

  it("fills a model and effort Settings > Agents sets after it opened, and leaves what the reader changed", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    let update: (patch: Partial<Settings>) => void = () => undefined;
    const Grab = () => { update = useSettings().update; return null; };
    const view = createElement(SettingsProvider, { children: [createElement(Grab, { key: "grab" }), createElement(NewSessionDialog, { key: "dialog", open: true, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined })] });
    try {
      await page.render(view);
      const value = (id: string) => field(id).value;
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["", ""]);
      await act(async () => { update({ claudeLaunchModel: "opus", claudeLaunchEffort: "high" }); });
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["opus", "high"]);
      await page.type(page.one<HTMLInputElement | HTMLTextAreaElement>("#new-session-model"), "sonnet");
      await act(async () => { update({ claudeLaunchModel: "haiku", claudeLaunchEffort: "max" }); });
      expect([value("new-session-model"), value("new-session-effort")]).toEqual(["sonnet", "max"]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("restores typed directory, name, and first message after an Escape/dismiss, and clears them on Cancel (G-005)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    const view = (open: boolean) => createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await page.render(view(true));
      await page.type(page.one<HTMLInputElement | HTMLTextAreaElement>("#new-session-cwd"), "/home/u/custom-dir");
      await page.type(page.one<HTMLInputElement>('[placeholder="custom-dir"]'), "AUDIT-UNSAVED-NAME");
      await page.type(page.one<HTMLInputElement | HTMLTextAreaElement>("#new-session-prompt"), "First draft prompt");
      await page.render(view(false));
      await page.render(view(true));
      expect(field("new-session-cwd").value).toBe("/home/u/custom-dir");
      expect(page.one<HTMLInputElement>('[placeholder="custom-dir"]').value).toBe("AUDIT-UNSAVED-NAME");
      expect(field("new-session-prompt").value).toBe("First draft prompt");
      const cancelBtn = [...page.container.querySelectorAll("button")].find((btn) => btn.textContent === "Cancel");
      if (!cancelBtn) throw new Error("Missing Cancel button");
      await act(async () => { cancelBtn.click(); });
      await page.render(view(false));
      await page.render(view(true));
      expect(field("new-session-cwd").value).toBe("/home/u");
      expect(field("new-session-prompt").value).toBe("");
    } finally {
      fetch.mockRestore();
    }
  });

  it("keeps a dismissed draft to the server it was typed for: another server's dialog opens empty", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(JSON.stringify({ agents: [{ kind: "claude", label: "Claude Code" }] }), { headers: { "content-type": "application/json" } }), { preconnect: globalThis.fetch.preconnect }));
    const go = (id: string) => page.window.history.replaceState(null, "", `/s/${id.repeat(32)}/`);
    const view = (open: boolean) => createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open, defaultCwd: "/home/u", prefill: { cwd: null, name: null, agent: "claude" }, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      go("a");
      await page.render(view(true));
      await page.type(page.one<HTMLInputElement | HTMLTextAreaElement>("#new-session-cwd"), "/home/u/server-a-only");
      await page.type(page.one<HTMLInputElement | HTMLTextAreaElement>("#new-session-prompt"), "for server A");
      await page.render(view(false));
      go("b");
      await page.render(view(true));
      expect(field("new-session-cwd").value).toBe("/home/u");
      expect(field("new-session-prompt").value).toBe("");
      await page.render(view(false));
      go("a");
      await page.render(view(true));
      expect(field("new-session-cwd").value).toBe("/home/u/server-a-only");
      expect(field("new-session-prompt").value).toBe("for server A");
    } finally {
      fetch.mockRestore();
    }
  });

  it("says a new tab's folder is gone: tab mode has no directory field, so the dialog's own alert tells it", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes("tab/create")) {
        return new Response(JSON.stringify({ error: { code: "invalid_cwd", message: "no such directory" } }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ agents: [] }), { headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    const tab = { workspaceId: "w1", workspaceLabel: "api", cwd: "/gone/checkout", number: 2 };
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/gone/checkout", tab, onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await page.render(view);
      await submit();
      const alerts = [...page.container.querySelectorAll('p[role="alert"]')];
      expect(alerts.map((node) => [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent).join(""))).toEqual(["Directory not found"]);
    } finally {
      fetch.mockRestore();
    }
  });

  it("tells the shell while its create is in flight, so a phone's Back can leave it open, and once the create has failed", async () => {
    let answer: (response: Response) => void = () => undefined;
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes("workspace/create")) return await new Promise<Response>((resolve) => { answer = resolve; });
      return new Response(JSON.stringify({ agents: [] }), { headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    const reported: boolean[] = [];
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/home/u", onClose: () => undefined, onCreated: () => undefined, onPending: (pending) => { reported.push(pending); } }) });
    try {
      await page.render(view);
      await submit();
      expect(reported.at(-1)).toBe(true);
      await act(async () => { answer(new Response(JSON.stringify({ error: { code: "internal", message: "herdr went away" } }), { status: 500, headers: { "content-type": "application/json" } })); });
      expect(reported.at(-1)).toBe(false);
      expect([...page.container.querySelectorAll('p[role="alert"]')].length).toBe(1);
    } finally {
      fetch.mockRestore();
    }
  });

  it("connects invalid_cwd error directly to the directory input via aria-invalid and aria-describedby (G-122)", async () => {
    const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes("workspace/create")) {
        return new Response(JSON.stringify({ error: { code: "invalid_cwd", message: "no such directory" } }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ agents: [] }), { headers: { "content-type": "application/json" } });
    }, { preconnect: globalThis.fetch.preconnect }));
    const view = createElement(SettingsProvider, { children: createElement(NewSessionDialog, { open: true, defaultCwd: "/missing/folder", onClose: () => undefined, onCreated: () => undefined }) });
    try {
      await page.render(view);
      await submit();
      const cwdInput = page.one("#new-session-cwd");
      const cwdHint = page.one("#new-session-cwd-hint");
      expect(cwdInput.getAttribute("aria-invalid")).toBe("true");
      expect(cwdInput.getAttribute("aria-describedby")).toBe("new-session-cwd-hint");
      expect(cwdHint.getAttribute("role")).toBe("alert");
      expect(cwdHint.textContent).toBe("Directory not found");
    } finally {
      fetch.mockRestore();
    }
  });
});
