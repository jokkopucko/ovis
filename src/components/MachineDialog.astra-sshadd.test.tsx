import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import type { SetupJob, SetupRequest } from "../../shared/machines.ts";
import { AccountService } from "../lib/account/service.ts";
import * as i18n from "../lib/i18n.ts";
import { getTransport, setTransport } from "../lib/transport.ts";
import { MachineDialog } from "./MachineDialog.tsx";

const PC_META = "ovis-pc-account-service";
const HOSTED_META = "ovis-account-service";
let page: Page;

beforeEach(() => {
  page = openPage("https://app.example/");
  Object.defineProperty(page.window, "isSecureContext", { configurable: true, value: true });
});
afterEach(async () => { await page.close(); });

/** A PC's own page has the PC's account service meta, never the hosted shell's. */
function pcPage(name: string | null) {
  if (name === null) return;
  const meta = page.window.document.createElement("meta");
  meta.name = name;
  meta.content = "https://account.test";
  page.window.document.head.appendChild(meta);
}

const buttons = () => [...page.container.querySelectorAll("button")];
const submit = () => act(async () => {
  const forms = page.window.document.querySelectorAll("form");
  if (forms.length !== 1 || !forms[0]) throw new Error("Expected one setup form");
  forms[0].dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }));
});

async function exercise(action: "install_ovis" | "update_bridge") {
  let poll: (() => void) | undefined;
  pcPage(PC_META);
  Object.defineProperty(page.window, "setTimeout", { configurable: true, value: (callback: () => void) => { poll = callback; return 1; } });
  Object.defineProperty(page.window, "clearTimeout", { configurable: true, value: () => {} });
  const translation = spyOn(i18n, "useT").mockImplementation(() => (key) => key);
  const session = spyOn(AccountService.prototype, "session").mockResolvedValue({ service: "https://account.test", account: "acct_1", provider: "google", access_token: "test", refresh_token: "test", expires_at: Date.now() + 60_000 });
  const transport = getTransport();
  const sent: SetupRequest[] = [];
  const failed: SetupJob = { id: "first", machine_id: "initial", phase: "failed", step: "Failed", action_required: action, error: "Setup needed", challenge: null, installations: [], ssh_output: null, target: { destination: "lab" },
    ...(action === "update_bridge" ? { remote_ovis: { version: "0.5.8", latest_version: "0.5.10", updatable: true, reason: null, address: "lab", url: null } } : {}) };
  const lookup = Promise.withResolvers<Response>();
  let lookedUp = false;
  setTransport({ ...transport, fetch: async (input, init) => {
    switch (String(input)) {
      case "/api/health": return Response.json({ auth: { via: "local" } });
      case "/api/account/status": return Response.json({ account: "acct_1", pc_add_from_account: true });
      case "/api/machines/setup": {
        const request = JSON.parse(String(init?.body)) as SetupRequest;
        sent.push(request);
        // the approved update connects the PC it updated
        return Response.json(request.update_remote ? { ...failed, id: "updated", machine_id: "lab-pc", phase: "connected", action_required: null, error: null } : failed);
      }
      case "/api/machines/install": return Response.json({ id: "install", phase: "installing", step: "Installing", error: null });
      case "/api/machines/install/install": return Response.json({ id: "install", phase: "connected", machine_id: null, connect_job: "connected-setup", error: null });
      case "/api/machines/setup/connected-setup": lookedUp = true; return lookup.promise;
      default: throw new Error(`Unexpected request: ${input}`);
    }
  } });
  try {
    await page.render(createElement(MachineDialog, { preset: { destination: "lab" }, onClose() {}, onConnected() {} }));
    await submit();
    expect(sent[0]).toEqual({ destination: "lab", account_add: true });
    if (action === "update_bridge") {
      expect(buttons().some((button) => button.textContent === "Update this PC's Ovis and connect")).toBe(true);
      await submit();
      expect(sent.filter((request) => request.update_remote && request.account_add)).toEqual([]);
      // then the add, as its own setup, on the PC the update connected
      expect(sent.slice(1)).toEqual([{ destination: "lab", update_remote: true }, { destination: "lab", machine_id: "lab-pc", account_add: true }]);
    } else {
      await act(async () => { buttons().find((button) => button.textContent === "Install Ovis there")!.click(); });
      await act(async () => { poll!(); });
      expect(lookedUp).toBe(true);
      await act(async () => { lookup.resolve(Response.json({ ...failed, phase: "connected", machine_id: "installed", id: "connected-setup" })); });
      expect(sent).toContainEqual({ destination: "lab", machine_id: "installed", account_add: true });
    }
  } finally {
    await page.render(null);
    setTransport(transport); session.mockRestore(); translation.mockRestore();
  }
}

test("install completion resumes the account add after its setup lookup returns", () => exercise("install_ovis"));
test("update-and-connect submits a setup the server accepts", () => exercise("update_bridge"));

/**
 * An update asked with Add it to my account runs the add only once the update connects, from this dialog: while that
 * update runs, the dialog asks to stay open rather than offering to go on in the background (a PC's own Ovis updated
 * from a closed dialog ended a plain SSH PC, never added). `account`: the PC's account, or none (no add offered).
 */
async function whileUpdating(account: string | null): Promise<{ background: boolean; closable: boolean; keepOpen: boolean }> {
  pcPage(PC_META);
  Object.defineProperty(page.window, "setTimeout", { configurable: true, value: () => 1 });
  Object.defineProperty(page.window, "clearTimeout", { configurable: true, value: () => {} });
  const translation = spyOn(i18n, "useT").mockImplementation(() => (key) => key);
  const session = spyOn(AccountService.prototype, "session").mockResolvedValue({ service: "https://account.test", account: "acct_1", provider: "google", access_token: "test", refresh_token: "test", expires_at: Date.now() + 60_000 });
  const transport = getTransport();
  const failed: SetupJob = { id: "first", machine_id: "initial", phase: "failed", step: "Failed", action_required: "update_bridge", error: "Setup needed", challenge: null, installations: [], ssh_output: null, target: { destination: "lab" },
    remote_ovis: { version: "0.5.10", latest_version: "0.5.11", updatable: true, reason: null, address: "lab", url: null } };
  setTransport({ ...transport, fetch: async (input, init) => {
    switch (String(input)) {
      case "/api/health": return Response.json({ auth: { via: "local" } });
      case "/api/account/status": return Response.json({ account, pc_add_from_account: true });
      case "/api/machines/setup": {
        const request = JSON.parse(String(init?.body)) as SetupRequest;
        return Response.json(request.update_remote ? { ...failed, id: "updating", phase: "installing", action_required: null, error: null } : failed);
      }
      default: throw new Error(`Unexpected request: ${input}`);
    }
  } });
  try {
    await page.render(createElement(MachineDialog, { preset: { destination: "lab" }, onClose() {}, onConnected() {} }));
    for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
    await submit();
    await submit();
    const hints = [...page.container.querySelectorAll(".field-hint")].map((node) => node.textContent);
    return {
      background: buttons().some((button) => button.textContent === "Continue in background"),
      closable: hints.includes("You can close this; the install keeps going and the sidebar shows it."),
      keepOpen: hints.includes("Keep this dialog open until the PC connects."),
    };
  } finally {
    await page.render(null);
    setTransport(transport); session.mockRestore(); translation.mockRestore();
  }
}

test("an update that carries Add it to my account asks to keep the dialog open, as the add runs from it once the update connects", async () => {
  expect(await whileUpdating("acct_1")).toEqual({ background: false, closable: false, keepOpen: true });
});

test("an update whose approval answers only after it connected still runs the add", async () => {
  let poll: (() => void) | undefined;
  pcPage(PC_META);
  Object.defineProperty(page.window, "setTimeout", { configurable: true, value: (callback: () => void) => { poll = callback; return 1; } });
  Object.defineProperty(page.window, "clearTimeout", { configurable: true, value: () => {} });
  const translation = spyOn(i18n, "useT").mockImplementation(() => (key) => key);
  const session = spyOn(AccountService.prototype, "session").mockResolvedValue({ service: "https://account.test", account: "acct_1", provider: "google", access_token: "test", refresh_token: "test", expires_at: Date.now() + 60_000 });
  const transport = getTransport();
  const sent: SetupRequest[] = [];
  const failed: SetupJob = { id: "first", machine_id: "initial", phase: "failed", step: "Failed", action_required: "update_bridge", error: "Setup needed", challenge: null, installations: [], ssh_output: null, target: { destination: "lab" },
    remote_ovis: { version: "0.5.10", latest_version: "0.5.11", updatable: true, reason: null, address: "lab", url: null } };
  const connected: SetupJob = { ...failed, id: "updating", machine_id: "lab-pc", phase: "connected", action_required: null, error: null };
  const approved = Promise.withResolvers<Response>();
  setTransport({ ...transport, fetch: async (input, init) => {
    switch (String(input)) {
      case "/api/health": return Response.json({ auth: { via: "local" } });
      case "/api/account/status": return Response.json({ account: "acct_1", pc_add_from_account: true });
      case "/api/machines/setup": {
        const request = JSON.parse(String(init?.body)) as SetupRequest;
        sent.push(request);
        if (request.account_add && request.machine_id) return new Promise<Response>(() => {});
        return Response.json(request.update_remote ? { ...failed, id: "updating", phase: "approval", action_required: null, error: null, installations: ["Ovis 0.5.11"] } : failed);
      }
      // the approval's answer comes late; the poll sees the update connected first
      case "/api/machines/setup/updating": return init?.method === "POST" ? approved.promise : Response.json(connected);
      default: throw new Error(`Unexpected request: ${input}`);
    }
  } });
  try {
    await page.render(createElement(MachineDialog, { preset: { destination: "lab" }, onClose() {}, onConnected() {} }));
    for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
    await submit();
    await submit();
    await act(async () => { buttons().find((button) => button.textContent === "Install and connect")!.click(); });
    await act(async () => { poll!(); });
    await act(async () => { approved.resolve(Response.json(connected)); });
    for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
    expect(sent.slice(1)).toEqual([{ destination: "lab", update_remote: true }, { destination: "lab", machine_id: "lab-pc", account_add: true }]);
  } finally {
    await page.render(null);
    setTransport(transport); session.mockRestore(); translation.mockRestore();
  }
});

test("a Windows PC that connected opens: only an add still due holds Open PC", async () => {
  Object.defineProperty(page.window, "setTimeout", { configurable: true, value: () => 1 });
  Object.defineProperty(page.window, "clearTimeout", { configurable: true, value: () => {} });
  const translation = spyOn(i18n, "useT").mockImplementation(() => (key) => key);
  const transport = getTransport();
  setTransport({ ...transport, fetch: async (input) => {
    switch (String(input)) {
      case "/api/health": return Response.json({ auth: { via: "local" } });
      case "/api/account/status": return Response.json({ account: null, pc_add_from_account: false });
      case "/api/machines/setup": return Response.json({ id: "win", machine_id: "win-pc", phase: "connected", step: "Connected", action_required: null, error: null, challenge: null, installations: [], ssh_output: null, target: { destination: "win" }, windows_startup: true } satisfies SetupJob);
      default: throw new Error(`Unexpected request: ${input}`);
    }
  } });
  try {
    await page.render(createElement(MachineDialog, { preset: { destination: "win" }, onClose() {}, onConnected() {} }));
    await submit();
    expect(buttons().find((button) => button.textContent === "Open PC")?.disabled).toBe(false);
  } finally {
    await page.render(null);
    setTransport(transport); translation.mockRestore();
  }
});

test("an update with no add still goes on in the background", async () => {
  expect(await whileUpdating(null)).toEqual({ background: true, closable: true, keepOpen: false });
});

/** Add on a row of the relay tab's list opens this dialog for that host; what it offers, on a page with `meta` alone */
async function offered(meta: string | null): Promise<{ label: boolean; ticked: boolean | null; sent: SetupRequest[] }> {
  page.window.document.head.querySelectorAll("meta").forEach((node) => node.remove());
  pcPage(meta);
  const translation = spyOn(i18n, "useT").mockImplementation(() => (key) => key);
  const session = spyOn(AccountService.prototype, "session").mockResolvedValue({ service: "https://account.test", account: "acct_1", provider: "google", access_token: "test", refresh_token: "test", expires_at: Date.now() + 60_000 });
  const transport = getTransport();
  const sent: SetupRequest[] = [];
  setTransport({ ...transport, fetch: async (input, init) => {
    switch (String(input)) {
      case "/api/health": return Response.json({ auth: { via: "local" }, own_window: true });
      case "/api/account/status": return Response.json({ account: "acct_1", pc_add_from_account: true });
      case "/api/machines/setup": sent.push(JSON.parse(String(init?.body)) as SetupRequest); return new Promise<Response>(() => {});
      default: throw new Error(`Unexpected request: ${input}`);
    }
  } });
  try {
    await page.render(createElement(MachineDialog, { preset: { destination: "p23pcb", name: "p23pcb" }, onClose() {}, onConnected() {} }));
    for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
    const label = [...page.container.querySelectorAll('label[class="machine-check"]')].filter((node) => node.textContent === "Add it to my account");
    const ticked = label.length === 0 ? null : label[0]?.querySelector("input")?.checked ?? null;
    await submit();
    return { label: label.length === 1, ticked, sent };
  } finally {
    await page.render(null);
    setTransport(transport); session.mockRestore(); translation.mockRestore();
  }
}

test("a PC's own page, signed in to this PC's account, offers Add it to my account ticked, read from the PC's own meta", async () => {
  expect(await offered(PC_META)).toEqual({ label: true, ticked: true, sent: [{ destination: "p23pcb", account_add: true }] });
});

test("a page with no account service of a PC's own offers the plain SSH add alone: the hosted shell's meta is not this PC's", async () => {
  for (const meta of [HOSTED_META, null]) expect(await offered(meta)).toEqual({ label: false, ticked: null, sent: [{ destination: "p23pcb" }] });
});
