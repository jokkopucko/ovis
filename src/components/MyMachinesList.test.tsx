import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { fixtureView } from "../lib/account/machinesView.fixtures.ts";
import type { Machine } from "../lib/account/machinesView.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { MyMachinesList } from "./MyMachinesList.tsx";
import { opensFromHere } from "./myMachinesWords.ts";

const NOW = Date.parse("2026-11-14T04:20:00Z");
const none = (): void => {};

function render(element: ReactElement): string {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, null, element));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
}

const list = (machines: readonly Machine[]): string => render(createElement(MyMachinesList, { machines, selectedId: null, now: NOW, canAdd: true, onSelect: none, onOpen: none, onRetry: none, onAdd: none }));
/** The row action each machine offers, by its row id. */
const rowActions = (html: string): Map<string, string> => new Map([...html.matchAll(/data-row-id="([^"]+)" data-row-state="[^"]+".*?data-row-action="([^"]+)"/g)].map((match) => [match[1]!, match[2]!]));

// Contract 1 v3, F3.5: a machine behind is "Needs an update", a state of its own; it lets no new
// device in, and the devices it knows still open it.
describe("a machine that needs an update", () => {
  const behind = fixtureView("mixed", "driver").machines.find((machine) => machine.state.kind === "needs-update")!;

  it("is a row state of its own that offers Open to a device it knows", () => {
    const html = list([behind]);
    expect(html).toContain('data-row-state="needs-update"');
    expect(rowActions(html).get(behind.id)).toBe("open");
  });

  it("offers only Details to a device it does not know", () => {
    const stranger: Machine = { ...behind, state: { kind: "needs-update", knowsThisDevice: false } };
    expect(rowActions(list([stranger])).get(behind.id)).toBe("details");
  });
});

describe("opensFromHere", () => {
  it("offers Open for a machine this device's check could not reach: opening waits longer than a check", () => {
    expect(opensFromHere({ kind: "unreachable", reason: "no-answer", triedAt: "2026-11-14T04:19:00Z" })).toBe(true);
    expect(opensFromHere({ kind: "unreachable", reason: "relay-unreachable", triedAt: "2026-11-14T04:19:00Z" })).toBe(true);
    expect(opensFromHere({ kind: "offline", reason: "not-connected", lastSeenAt: null })).toBe(false);
  });
});
