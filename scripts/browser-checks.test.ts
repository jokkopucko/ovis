import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { BROWSER_SURFACES, extractCouplingTokens, findBrowserChecks, runCli, summarizeSurfaces } from "./browser-checks.ts";
import { serialBrowserScripts } from "./ci-browser-parallel.ts";

const REPO = resolve(import.meta.dir, "..");

describe("browser-checks feature map and matcher", () => {
  it("keeps every surface non-empty against scripts/ci-browser.sh", () => {
    const summaries = summarizeSurfaces(REPO);
    expect(summaries.map((surface) => surface.id)).toEqual(BROWSER_SURFACES.map((surface) => surface.id));
    expect(summaries.filter((surface) => surface.demoCount + surface.herdrCount === 0)).toEqual([]);
  });

  it("ranks component, CSS and 1-hop helper changes to the browser scripts that exercise them", () => {
    const viewer = findBrowserChecks(["src/components/FileViewer.tsx"], { root: REPO, limit: 5 });
    expect(viewer.surfaces).toContain("files");
    expect(viewer.matches.map((match) => match.script)).toContain("scripts/file-viewer-regression.ts");
    expect(viewer.matches.map((match) => match.script)).toContain("scripts/file-viewer-mobile-regression.ts");

    const viewerCss = findBrowserChecks(["src/components/FileViewer.css"], { root: REPO, limit: 5 });
    expect(viewerCss.matches.map((match) => match.script)).toContain("scripts/file-viewer-regression.ts");

    const peek = findBrowserChecks(["src/lib/sidebarPeek.ts"], { root: REPO, limit: 3 });
    expect(peek.matches[0]?.script).toBe("scripts/sidebar-peek-demo-regression.ts");
    expect(peek.matches[0]?.kind).toBe("demo");
    expect(peek.matches[0]?.reasons).toContain("imports src/lib/sidebarPeek.ts");

    const inbox = findBrowserChecks(["src/components/InboxMode.tsx"], { root: REPO, limit: 5 });
    expect(inbox.matches.map((match) => match.script)).toContain("scripts/inbox-mode-demo-regression.ts");

    const machineDialog = findBrowserChecks(["src/components/MachineDialog.tsx"], { root: REPO, limit: 5 });
    expect(machineDialog.matches.map((match) => match.script)).toContain("scripts/machine-dialog-regression.ts");
  });

  it("excludes demo-only scripts when a change touches server/ alone", () => {
    const pending = findBrowserChecks(["server/core/pending.ts"], { root: REPO, limit: 20 });
    expect(pending.surfaces).toContain("pending");
    expect(pending.matches.map((match) => match.script)).toContain("scripts/pending-pane-switch-regression.ts");
    expect(pending.matches.filter((match) => match.kind === "demo")).toEqual([]);
  });

  it("returns only canonical CI browser scripts and accepts explicit script edits and surface queries", () => {
    const allCi = new Set(serialBrowserScripts());
    const surfacePlan = findBrowserChecks(["surface:prompts"], { root: REPO, limit: 0 });
    expect(surfacePlan.matches.length).toBeGreaterThan(0);
    expect(surfacePlan.matches.every((match) => allCi.has(match.script))).toBe(true);

    const directScript = findBrowserChecks(["scripts/prompt-dock-demo-regression.ts"], { root: REPO, limit: 3 });
    expect(directScript.matches[0]?.script).toBe("scripts/prompt-dock-demo-regression.ts");
    expect(directScript.matches[0]?.reasons).toContain("edited script");
  });

  it("extracts specific DOM, route and protocol tokens while ignoring generic layout classes", () => {
    const tokens = extractCouplingTokens(`
      <div className="flex-row text-sm prompt-card-header" data-page-shield="1" />
      fetch("/api/pane/prompt/answer");
      const code = "pending_lease_lost";
    `);
    expect([...tokens].sort()).toEqual([
      "code:pending_lease_lost",
      "dom:data-page-shield",
      "dom:prompt-card-header",
      "route:/api/pane/prompt/answer",
    ]);
  });

  it("rejects paths outside the repository and unknown surfaces or flags", () => {
    expect(() => findBrowserChecks(["../outside.ts"], { root: REPO })).toThrow("inside the repository");
    expect(() => findBrowserChecks(["surface:nonexistent"], { root: REPO })).toThrow("Unknown surface");
    expect(() => runCli(["--unknown-flag"], REPO)).toThrow("Unknown option");
  });
});
