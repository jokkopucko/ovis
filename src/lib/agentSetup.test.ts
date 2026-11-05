import { describe, expect, it } from "bun:test";

import { AGENT_CATALOG, catalogRow, type AgentInstallState } from "../../shared/agent-catalog.ts";
import { setupProgress, setupStep, type SetupStep } from "./agentSetup.ts";

const tab = { pane_id: "w1:p2", workspace_id: "w1", command: "curl -fsSL https://claude.ai/install.sh | bash", shell: "posix" as const };
const row = (id: string, state: Partial<AgentInstallState>) => catalogRow(AGENT_CATALOG.find((entry) => entry.id === id)!, "linux", { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null, ...state });

describe("agent setup", () => {
  it("goes install, detected, sign in, ready, by detection and not by the install tab", () => {
    let step: SetupStep = setupStep({ kind: "idle" }, { type: "install-started", tab });
    expect(step.kind).toBe("installing");
    // still installing: a read before the binary is there changes nothing
    step = setupStep(step, { type: "detected", row: row("claude", {}) });
    expect(step.kind).toBe("installing");
    step = setupStep(step, { type: "detected", row: row("claude", { installed: true, binary: "claude", on_path: false, version: "2.1.312" }) });
    expect(step).toEqual({ kind: "installed", version: "2.1.312", onPath: false });
    step = setupStep(step, { type: "sign-in-started", tab: { ...tab, pane_id: "w1:p3" } });
    expect(step.kind).toBe("signing-in");
    expect(setupStep(step, { type: "sign-in-done" })).toEqual({ kind: "ready", version: "2.1.312" });
  });

  it("makes an agent that needs no sign-in ready on detection, and lets sign-in be skipped", () => {
    const installing = setupStep({ kind: "idle" }, { type: "install-started", tab });
    const noSignIn = { ...row("claude", { installed: true, binary: "claude", on_path: true, version: "1.0.0" }), sign_in: null };
    expect(setupStep(installing, { type: "detected", row: noSignIn })).toEqual({ kind: "ready", version: "1.0.0" });
    expect(setupStep({ kind: "installed", version: null, onPath: true }, { type: "skip-sign-in" })).toEqual({ kind: "ready", version: null });
  });

  it("never makes an agent ready that is there but does not run, and waits while an install may repair it", () => {
    const broken = row("opencode", { installed: true, binary: "opencode", on_path: true, version: null, version_error: "failed" });
    const hung = row("opencode", { installed: true, binary: "opencode", on_path: true, version: null, version_error: "timeout" });
    const unknownVersion = row("opencode", { installed: true, binary: "opencode", on_path: true, version: null, version_error: "unreadable" });
    expect(setupStep({ kind: "idle" }, { type: "detected", row: broken })).toEqual({ kind: "failed", message: null, after: "install" });
    expect(setupStep({ kind: "idle" }, { type: "detected", row: hung })).toEqual({ kind: "failed", message: null, after: "install" });
    // an install under way may still repair it: the card keeps waiting
    const installing = setupStep({ kind: "idle" }, { type: "install-started", tab });
    expect(setupStep(installing, { type: "detected", row: broken })).toBe(installing);
    // a version it cannot read is no sign it is broken
    expect(setupStep(installing, { type: "detected", row: unknownVersion })).toEqual({ kind: "installed", version: null, onPath: true });
  });

  it("says which step failed, and starts over on cancel", () => {
    expect(setupStep({ kind: "installing", tab }, { type: "failed", message: "x" })).toEqual({ kind: "failed", message: "x", after: "install" });
    expect(setupStep({ kind: "signing-in", tab, version: null }, { type: "failed", message: "y" })).toMatchObject({ after: "sign-in" });
    expect(setupStep({ kind: "installing", tab }, { type: "cancel" })).toEqual({ kind: "idle" });
    expect(setupProgress({ kind: "failed", message: "x", after: "sign-in" })).toEqual({ index: 1, fraction: 0.6 });
    expect(setupProgress({ kind: "ready", version: null }).fraction).toBe(1);
  });
});
