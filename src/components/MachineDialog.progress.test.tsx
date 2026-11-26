import { expect, spyOn, test } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import type { SetupJob, SetupPhase } from "../../shared/machines.ts";
import * as i18n from "../lib/i18n.ts";
import { getTransport, setTransport } from "../lib/transport.ts";
import { MachineDialog } from "./MachineDialog.tsx";

test("an SSH add shows its stage and bar as the setup moves on, and none once it connected", async () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const define = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  };
  let poll: (() => void) | undefined;
  define("window", { isSecureContext: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, setTimeout(callback: () => void) { poll = callback; return 1; }, clearTimeout() {} });
  define("document", { querySelector: () => null });
  define("IS_REACT_ACT_ENVIRONMENT", true);
  const translation = spyOn(i18n, "useT").mockImplementation(() => (key, values) => values ? `${key} ${JSON.stringify(values)}` : key);
  const transport = getTransport();
  const job = (phase: SetupPhase, step: string): SetupJob => ({ id: "job", machine_id: "lab", phase, step, challenge: null, installations: [], error: null, ssh_output: null, target: { destination: "lab" } });
  let now = job("connecting", "Connecting with SSH keys and ssh-agent…");
  let view: ReactTestRenderer | undefined;
  setTransport({ ...transport, fetch: async (input) => {
    switch (String(input)) {
      case "/api/machines/setup": case "/api/machines/setup/job": return Response.json(now);
      default: return Response.json({ error: "not_found" }, { status: 404 });
    }
  } });
  const bars = () => view!.root.findAll((node) => node.type === "div" && node.props.role === "progressbar")
    .map((node) => [node.props["aria-label"], node.props["aria-valuenow"], node.props["aria-valuetext"]]);
  const moveTo = (next: SetupJob) => act(async () => { now = next; poll!(); });
  try {
    await act(async () => { view = create(createElement(MachineDialog, { preset: { destination: "lab" }, onClose() {}, onConnected() {} })); });
    await act(async () => { view!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    expect(bars()).toEqual([["Connecting with SSH keys and ssh-agent…", 13, 'Step {n} of {total} {"n":1,"total":4}']]);
    await moveTo(job("checking", "Checking the remote environment…"));
    expect(bars()).toEqual([["Checking the remote environment…", 38, 'Step {n} of {total} {"n":2,"total":4}']]);
    await moveTo(job("installing", "Installing herdr with its own installer…"));
    expect(bars()).toEqual([["Installing herdr with its own installer…", 63, 'Step {n} of {total} {"n":3,"total":4}']]);
    // a bundle on its way keeps the setup's stage: its own steps are the words and the line under the bar, never a bar going back
    await moveTo({ ...job("installing", "Installing verified linux-x64 bundle…"), progress: { stage: "download", done: 60 * 1024 * 1024, total: 120 * 1024 * 1024, rate: null, elapsed_ms: 0 } });
    expect(bars()).toEqual([["Downloading the bridge", 63, 'Step {n} of {total} {"n":3,"total":4}']]);
    expect(view!.root.findAll((node) => node.props.className === "bridge-progress-detail").map((node) => node.children.join(""))).toEqual(["60 MB of 120 MB"]);
    await moveTo(job("starting", "Starting the remote bridge…"));
    expect(bars()).toEqual([["Starting the remote bridge…", 88, 'Step {n} of {total} {"n":4,"total":4}']]);
    // ssh asks for a password: the question, not a bar
    await moveTo({ ...job("authentication", "SSH authentication required"), challenge: { id: "secret", kind: "secret", prompt: "Password:" } });
    expect(bars()).toEqual([]);
    await moveTo(job("connected", "Connected"));
    expect(bars()).toEqual([]);
  } finally {
    await act(async () => view?.unmount()); setTransport(transport); translation.mockRestore();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
