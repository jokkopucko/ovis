import { expect, it } from "bun:test";
import { act } from "react";
import { openPage } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { AccountSignIn } from "./AccountPcs.tsx";

it("offers connecting first and keeps both choices after a wrong provider account", async () => {
  const page = openPage();
  const choices: string[] = [];
  try {
    await page.render(<SettingsProvider><AccountSignIn error={null} providers={["github", "google"]} onSignIn={() => choices.push("plain")}
      hint={{ provider: "google", existingProvider: "github", noAccount: true }} onHintChoice={(choice) => choices.push(choice)} /></SettingsProvider>);
    const card = page.container.querySelector("[aria-labelledby]");
    expect(card?.textContent).toContain("GitHub");
    expect(card?.querySelector("[role=alert]")?.textContent).toContain("no Ovis account");
    const [connect, create] = card?.querySelectorAll("button") ?? [];
    expect(connect?.classList.contains("btn-primary")).toBe(true);
    expect(create?.classList.contains("btn-primary")).toBe(false);
    await act(async () => { connect?.click(); create?.click(); });
    expect(choices).toEqual(["connect", "create"]);
  } finally { await page.close(); }
});

it.each(["apple", "github"] as const)("offers only account creation for a matched method that cannot connect (%s)", async (provider) => {
  const page = openPage();
  const choices: string[] = [];
  try {
    await page.render(<SettingsProvider><AccountSignIn error={null} providers={["google", "apple"]} onSignIn={() => choices.push("plain")}
      hint={{ provider: "google", existingProvider: provider, noAccount: false }} onHintChoice={(choice) => choices.push(choice)} /></SettingsProvider>);
    const card = page.container.querySelector("[aria-labelledby]");
    expect(card?.textContent).toContain(provider === "apple" ? "Apple" : "GitHub");
    const buttons = card?.querySelectorAll("button");
    expect(buttons).toHaveLength(1);
    await act(async () => { buttons?.[0]?.click(); });
    expect(choices).toEqual(["create"]);
  } finally { await page.close(); }
});
