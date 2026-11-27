import { afterEach, beforeEach, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { publishBranches } from "../lib/paneBranch.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { SystemReport } from "../../shared/system.ts";
import { translate } from "../lib/i18n.ts";
import { formatPcLoad } from "./MachineStats.tsx";
import { StatusBar, type StatusBarProps } from "./StatusBar.tsx";

let page: Page;

beforeEach(() => { page = openPage("https://pc.example/"); });
afterEach(async () => {
  await page.close();
  publishBranches("pc", null);
});

const base: StatusBarProps = {
  machineId: "pc", workspaceId: "w1", machine: "Laptop", place: "api", path: "/home/me/api", session: null,
  watching: false, waiting: 0, onNextWaiting: null, connection: "live", connectionWord: "Connected",
};
const draw = async (props: Partial<StatusBarProps>) => {
  await page.render(createElement(SettingsProvider, null, createElement(StatusBar, { ...base, ...props })));
};
const text = (node: Element): string => node.textContent ?? "";

it("names the PC, the place, the branch the roster published, and the connection", async () => {
  publishBranches("pc", new Map([["w1", { branch: "feat/x", isDetached: false } as never]]));
  await draw({});
  expect(text(page.one('[class="machine-context-name"]'))).toBe("Laptop");
  expect(text(page.one("footer"))).toContain("feat/x");
  expect(page.one('[data-state="live"]').className).not.toContain("is-lost");
  expect(page.container.querySelectorAll("button")).toHaveLength(0);
});

it("offers the next waiting session as a button, inert when there is none to open", async () => {
  let opened = 0;
  await draw({ waiting: 2, onNextWaiting: () => { opened += 1; } });
  const button = page.one<HTMLButtonElement>("button");
  expect(text(button)).toBe("2 waiting for you");
  await act(async () => button.click());
  expect(opened).toBe(1);
  await page.render(null);
  await draw({ waiting: 1, onNextWaiting: null });
  const inert = page.one<HTMLButtonElement>("button");
  expect(inert.getAttribute("aria-disabled")).toBe("true");
  expect(inert.hasAttribute("disabled")).toBe(false);
  await act(async () => inert.click());
});

it("says View only on a watching device and a lost connection in its own word", async () => {
  await draw({ watching: true, connection: "reconnecting", connectionWord: "Reconnecting…" });
  expect(text(page.one('[class="status-bar-item status-bar-watch"]'))).toBe("View only");
  const conn = page.one('[data-state="reconnecting"]');
  expect(conn.className).toContain("is-lost");
  expect(text(conn)).toBe("Reconnecting…");
});

it("shows the PC load line in the status bar when provided", async () => {
  const report: SystemReport = {
    sampled_at: 1, uptime_s: 3600, cpu_count: 8, cpu_percent: 19.2, platform: "linux",
    memory: { used: 11, total: 32, percent: 35.4 }, load: [0.5, 0.4, 0.3],
    disks: [{ path: "/", used: 44, total: 100, percent: 44.1 }, { path: "/boot", used: 10, total: 100, percent: 10 }],
  };
  const line = formatPcLoad((key, vars) => translate("ko", key, vars), report);
  expect(line).toBe("CPU 19% · 메모리 35% · 디스크 44%");
  await draw({ pcLoad: createElement("span", { className: "status-bar-item status-bar-text status-bar-load" }, line) });
  expect(text(page.one('[class="status-bar-item status-bar-text status-bar-load"]'))).toBe("CPU 19% · 메모리 35% · 디스크 44%");
});
