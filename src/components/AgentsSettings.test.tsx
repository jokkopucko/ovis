import { expect, spyOn, test } from "bun:test";
import { act } from "react";

import { AGENT_CATALOG, catalogRow } from "../../shared/agent-catalog.ts";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AgentsSettings } from "./AgentsSettings.tsx";

async function withAgentsPage({ installed, pathProblem, recheck }: { installed: boolean | null; pathProblem?: string; recheck?: () => Promise<Response> }, check: (page: Page) => Promise<void> | void) {
  const page = openPage();
  const agents = AGENT_CATALOG.filter(({ id }) => id === "claude" || id === "codex").map((entry) => {
    const present = entry.id === "claude" ? true : installed;
    return catalogRow(entry, "linux", {
      installed: present, binary: present ? entry.detect.binaries[0] ?? null : null, on_path: present,
      version: null, version_error: null, meets_min_version: null,
    });
  });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
    switch (String(input)) {
      case "/api/agent-catalog": return Response.json({ platform: "linux", agents, path_problem: pathProblem });
      case "/api/agent-catalog?recheck=1": return recheck ? recheck() : new Response(null, { status: 503 });
      case "/api/integrations": return Response.json({ integrations: [] });
      case "/api/cliproxy": return Response.json({ configured: false });
      default: throw new Error(`Unexpected request: ${String(input)}`);
    }
  }, { preconnect: globalThis.fetch.preconnect }));
  const resizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: page.window.ResizeObserver });
  try {
    const noop = () => {};
    await page.render(<SettingsProvider>
      <AgentsSettings watching={false} onLocalLogin={noop} onOpenPane={noop} onOpenGuide={noop} />
    </SettingsProvider>);
    await check(page);
  } finally {
    try {
      await page.close();
    } finally {
      fetch.mockRestore();
      if (resizeObserver) Object.defineProperty(globalThis, "ResizeObserver", resizeObserver);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    }
  }
}

test.each([
  { label: "known missing", installed: false, showsNote: true },
  { label: "unknown", installed: null, showsNote: false },
  { label: "PATH unreadable", installed: false, pathProblem: "Could not read PATH", showsNote: false },
  { label: "installed", installed: true, showsNote: false },
] as const)("shows Codex's install status without removing its launch settings ($label)", (scenario) => withAgentsPage(scenario, (page) => {
  const { installed, showsNote } = scenario;
  const installedList = page.one('[data-section="agents-installed"]');
  expect(installedList.querySelector('[data-agent="claude"]')).not.toBeNull();
  expect(installedList.querySelector('[data-agent="codex"]') !== null).toBe(installed === true);
  const group = page.container.querySelector('[data-section="agent-codex"]');
  if (installed === true) {
    expect(group).toBeNull();
  } else {
    expect(group?.querySelector("#settings-codex-launch-model")).toBeInstanceOf(page.window.HTMLInputElement);
    expect(group?.textContent?.includes("Not installed on this PC")).toBe(showsNote);
  }
}));

test("withdraws the previous Codex install status when Check again fails", () => withAgentsPage({ installed: false }, async (page) => {
  const group = page.one('[data-section="agent-codex"]');
  const checkAgain = page.one<HTMLButtonElement>(".agents-check-again");
  expect(group.textContent).toContain("Not installed on this PC");

  await act(async () => { checkAgain.click(); });

  expect(page.one('[data-section="agents-installed"] [role="alert"]').textContent).not.toBe("");
  expect(group.textContent).not.toContain("Not installed on this PC");
  expect(group.querySelector("#settings-codex-launch-model")).toBeInstanceOf(page.window.HTMLInputElement);
}));

test("keeps the withdrawn Codex install status hidden while Check again runs once more", () => {
  const answers = [Promise.resolve(new Response(null, { status: 503 })), Promise.withResolvers<Response>()];
  let asked = 0;
  return withAgentsPage({ installed: false, recheck: () => { const next = answers[asked++]!; return next instanceof Promise ? next : next.promise; } }, async (page) => {
    const group = page.one('[data-section="agent-codex"]');
    const checkAgain = page.one<HTMLButtonElement>(".agents-check-again");
    await act(async () => { checkAgain.click(); });
    expect(group.textContent).not.toContain("Not installed on this PC");

    await act(async () => { checkAgain.click(); });

    expect(asked).toBe(2);
    expect(group.textContent).not.toContain("Not installed on this PC");
    await act(async () => { (answers[1] as ReturnType<typeof Promise.withResolvers<Response>>).resolve(new Response(null, { status: 503 })); });
  });
});
