import { expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import type { SetupJob, SetupPhase } from "../../shared/machines.ts";
import * as i18n from "../lib/i18n.ts";
import { openPage } from "../lib/page.fixture.ts";
import { getTransport, setTransport } from "../lib/transport.ts";
import { MachineDialog } from "./MachineDialog.tsx";

test("an SSH add shows its stage and bar as the setup moves on, and none once it connected", async () => {
  const page = openPage();
  let poll: (() => void) | undefined;
  for (const [key, value] of Object.entries({
    isSecureContext: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout(callback: () => void) { poll = callback; return 1; }, clearTimeout() {},
  })) Object.defineProperty(page.window, key, { configurable: true, value });
  const translation = spyOn(i18n, "useT").mockImplementation(() => (key, values) => values ? `${key} ${JSON.stringify(values)}` : key);
  const transport = getTransport();
  const job = (phase: SetupPhase, step: string): SetupJob => ({ id: "job", machine_id: "lab", phase, step, challenge: null, installations: [], error: null, ssh_output: null, target: { destination: "lab" } });
  let now = job("connecting", "Connecting with SSH keys and ssh-agent…");
  setTransport({ ...transport, fetch: async (input) => {
    switch (String(input)) {
      case "/api/machines/setup": case "/api/machines/setup/job": return Response.json(now);
      default: return Response.json({ error: "not_found" }, { status: 404 });
    }
  } });
  const bars = () => [...page.container.querySelectorAll('div[role="progressbar"]')]
    .map((node) => [node.getAttribute("aria-label"), Number(node.getAttribute("aria-valuenow")), node.getAttribute("aria-valuetext")]);
  const moveTo = (next: SetupJob) => act(async () => { now = next; poll!(); });
  try {
    await page.render(createElement(MachineDialog, { preset: { destination: "lab" }, onClose() {}, onConnected() {} }));
    const form = page.one("form");
    await act(async () => { form.dispatchEvent(new page.window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
    expect(bars()).toEqual([["Connecting with SSH keys and ssh-agent…", 13, 'Step {n} of {total} {"n":1,"total":4}']]);
    await moveTo(job("checking", "Checking the remote environment…"));
    expect(bars()).toEqual([["Checking the remote environment…", 38, 'Step {n} of {total} {"n":2,"total":4}']]);
    await moveTo(job("installing", "Installing herdr with its own installer…"));
    expect(bars()).toEqual([["Installing herdr with its own installer…", 63, 'Step {n} of {total} {"n":3,"total":4}']]);
    // a bundle on its way keeps the setup's stage: its own steps are the words and the line under the bar, never a bar going back
    await moveTo({ ...job("installing", "Installing verified linux-x64 bundle…"), progress: { stage: "download", done: 60 * 1024 * 1024, total: 120 * 1024 * 1024, rate: null, elapsed_ms: 0 } });
    expect(bars()).toEqual([["Downloading the bridge", 63, 'Step {n} of {total} {"n":3,"total":4}']]);
    expect([...page.container.querySelectorAll('[class="bridge-progress-detail"]')].map((node) => node.textContent)).toEqual(["60 MB of 120 MB"]);
    await moveTo(job("starting", "Starting the remote bridge…"));
    expect(bars()).toEqual([["Starting the remote bridge…", 88, 'Step {n} of {total} {"n":4,"total":4}']]);
    // ssh asks for a password: the question, not a bar
    await moveTo({ ...job("authentication", "SSH authentication required"), challenge: { id: "secret", kind: "secret", prompt: "Password:" } });
    expect(bars()).toEqual([]);
    await moveTo(job("connected", "Connected"));
    expect(bars()).toEqual([]);
  } finally {
    setTransport(transport); translation.mockRestore();
    await page.close();
  }
});
