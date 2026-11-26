import { afterEach, expect, it } from "bun:test";
import { act } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { FoundHerdrChoices, type HerdrChoice } from "./FoundHerdrChoices.tsx";

let page: Page;

afterEach(async () => { await page.close(); });

it("offers each running session and a separate explicit new-start choice", async () => {
  const choices: HerdrChoice[] = [];
  page = openPage();
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
  await page.render(<SettingsProvider><FoundHerdrChoices sessions={[
    { session: "work", label: "work", socket_path: "/desktop/herdr/sessions/work/herdr.sock" },
    { label: "Default session", socket_path: "/desktop/herdr/herdr.sock" },
  ]} ownOvis={[{ socket_path: "/desktop/ovis/hc.sock", runtime: "herdr-core" }]} error="Choose this PC's Ovis server or a running herdr session." busy={false} onChoose={(choice) => choices.push(choice)} /></SettingsProvider>);
  const buttons = [...page.container.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Use Ovis on this PC (herdr-core)", "Use work", "Use Default session", "Start a new herdr here"]);
  expect(buttons.map((button) => button.classList.contains("btn-primary"))).toEqual([true, false, false, false]);
  // beside the PC's Ovis the herdr sessions wait under a closed fold
  const fold = page.one("details");
  expect(fold.hasAttribute("open")).toBe(false);
  expect([...fold.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Use work", "Use Default session", "Start a new herdr here"]);
  expect([...page.one('[role="status"]').classList]).toContain("is-setup");
  await act(async () => { for (const button of buttons) button.click(); });
  expect(choices).toEqual([
    { own_ovis: "/desktop/ovis/hc.sock", herdr_socket: undefined, start_new_herdr: undefined },
    { session: "work", herdr_socket: "/desktop/herdr/sessions/work/herdr.sock", start_new_herdr: undefined },
    { session: undefined, herdr_socket: "/desktop/herdr/herdr.sock", start_new_herdr: undefined },
    { herdr_socket: undefined, start_new_herdr: true },
  ]);
  // choices that would read the same are numbered, never told apart by a path
  await page.render(<SettingsProvider><FoundHerdrChoices sessions={[
    { session: "work", label: "work", socket_path: "/a/herdr/sessions/work/herdr.sock" },
    { session: "work", label: "work", socket_path: "/b/herdr/sessions/work/herdr.sock" },
    { session: "solo", label: "solo", socket_path: "/a/herdr/sessions/solo/herdr.sock" },
  ]} ownOvis={[{ socket_path: "/a/hc.sock", runtime: "herdr-core" }, { socket_path: "/b/hc.sock", runtime: "herdr-core" }]} error={null} busy={false} onChoose={() => {}} /></SettingsProvider>);
  expect([...page.container.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Use Ovis on this PC (herdr-core)", "Use Ovis on this PC (herdr-core) (2)", "Use work", "Use work (2)", "Use solo", "Start a new herdr here"]);
  expect(page.container.innerHTML).not.toContain(".sock");
  for (const reason of ["Start Ovis on that PC, or start a new herdr here", "The Ovis chosen on this PC serves herdr-core from a socket that is not this SSH account's own, so it was not used. Choose again, or start a new herdr here."]) {
    await page.render(<SettingsProvider><FoundHerdrChoices sessions={[]} error={reason} busy onChoose={(choice) => choices.push(choice)} /></SettingsProvider>);
    expect(page.one("strong").textContent).toBe(reason);
    expect(page.one<HTMLButtonElement>("button").disabled).toBe(true);
  }
  const unanswered = "Ovis on this PC is running but not answering right now. Try it again in a moment, or start a new herdr here.";
  const gone = "The herdr session chosen for this PC is no longer running. Start it on that PC and reconnect, or choose again.";
  for (const [reason, ownOvis] of [[unanswered, [{ socket_path: "/desktop/ovis/hc.sock", runtime: "herdr-core" as const }]], [gone, []]] as const) {
    await page.render(<SettingsProvider><FoundHerdrChoices sessions={[{ session: "work", label: "work", socket_path: "/desktop/herdr/sessions/work/herdr.sock" }]} ownOvis={[...ownOvis]} error={reason} busy={false} onChoose={(choice) => choices.push(choice)} /></SettingsProvider>);
    expect(page.container.querySelector("strong")?.textContent).toBe(reason);
    expect(page.container.querySelectorAll("details")).toHaveLength(ownOvis.length);
    expect([...page.one('[role="status"]').classList]).not.toContain("is-setup");
    expect([...page.container.querySelectorAll("button")].some((button) => button.classList.contains("btn-primary"))).toBe(false);
  }
});
