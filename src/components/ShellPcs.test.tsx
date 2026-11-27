import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "../lib/page.fixture.ts";

import { SettingsProvider } from "../lib/settings.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { Machine } from "../../shared/machines.ts";
import { shellPcRows, ShellPcs, unlistedShellPcs, useShellPcs, type ShellPcsDeps } from "./ShellPcs.tsx";

describe("the hosted app's other PCs in the sidebar", () => {
  let page: Page;
  beforeEach(() => { page = openPage(); });
  afterEach(async () => { await page.close(); });

  const inRow = <K extends keyof HTMLElementTagNameMap>(row: HTMLLIElement, tag: K): HTMLElementTagNameMap[K] => {
    const found = row.querySelectorAll(tag);
    if (found.length !== 1) throw new Error(`Expected one ${tag} in the PC row, found ${found.length}`);
    return found[0]!;
  };

  it("opens each on its own page; one that does not answer reads Off with Check again, which checks that PC alone", async () => {
    const checked: string[] = [];
    const pcs = [{ server_id: "b".repeat(32), name: "Work PC" }, { server_id: "c".repeat(32), name: "HostHatch" }, { server_id: "d".repeat(32), name: null }, { server_id: "e".repeat(32), name: "Laptop" }, { server_id: "f".repeat(32), name: "NAS" }];
    // a re-check of an off PC keeps it off on screen, so Check again stays where the focus is; a relay that turned this device away says nothing of the PC
    const status = new Map<string, PcStatus>([
      ["b".repeat(32), { kind: "answered", route: "relay", rttMs: 40 }],
      ["c".repeat(32), { kind: "checking", previous: { kind: "offline", reason: "pc" } }],
      ["d".repeat(32), { kind: "checking" }],
      ["e".repeat(32), { kind: "offline", reason: "refused" }],
    ]);
    await page.render(createElement(SettingsProvider, { children: createElement(ShellPcs, { pcs, status, recheck: (id: string) => { checked.push(id); } }) }));
    const rows = [...page.container.querySelectorAll("li")];
    expect(rows.map((row) => row.getAttribute("data-pc-state"))).toEqual(["on", "off", "checking", "unknown", "unknown"]);
    expect(rows.map((row) => inRow(row, "a").getAttribute("href"))).toEqual([`/s/${"b".repeat(32)}/`, `/s/${"c".repeat(32)}/`, `/s/${"d".repeat(32)}/`, `/s/${"e".repeat(32)}/`, `/s/${"f".repeat(32)}/`]);
    expect(rows[1]?.textContent).toBe("HostHatchOff·Check again");
    const checkAgain = inRow(rows[1]!, "button");
    expect(checkAgain.getAttribute("aria-busy")).toBe("true");
    expect(rows[2]?.textContent).toBe("Unnamed PC");
    expect(rows[3]?.textContent).toBe("LaptopCheck again");
    expect(rows[2]?.querySelectorAll("button")).toHaveLength(0);
    // a PC no check has settled yet (the sweep keeps no finding after a first relay failure) still offers Check again
    expect(rows[4]?.textContent).toBe("NASCheck again");
    expect(rows[0]?.querySelectorAll("button")).toHaveLength(0);
    await act(async () => { checkAgain.click(); });
    expect(checked).toEqual(["c".repeat(32)]);
  });

  it("draws nothing without another PC", async () => {
    await page.render(createElement(SettingsProvider, { children: createElement(ShellPcs, { pcs: [], status: new Map(), recheck: () => {} }) }));
    expect(page.container.childNodes).toHaveLength(0);
  });
});

describe("which PCs the hosted app's sidebar lists", () => {
  const keyIdOf = (key: string) => key.startsWith("key-") ? key.slice(4) : null;
  const row = (server_id: string, over: Partial<{ device_id: string | null; server_public_key: string }> = {}) => ({ server_id, device_id: "d", server_public_key: `key-${server_id}`, ...over });

  it("lists this device's finished, keyed pairings, never this page's PC, an unfinished pairing or a key that is not its id", () => {
    const devices = [row("here"), row("work"), row("half", { device_id: null }), row("forged", { server_public_key: "key-other" }), row("laptop")];
    expect(shellPcRows(devices, "here", keyIdOf).map((device) => device.server_id)).toEqual(["work", "laptop"]);
  });
});

describe("the sidebar's list as the page uses it", () => {
  let page: Page;
  beforeEach(() => { page = openPage(`http://localhost/s/${"a".repeat(32)}/`); });
  afterEach(async () => { await page.close(); });

  const fixture = () => {
    const rows = ["a", "b", "c"].map((letter) => ({ server_id: letter.repeat(32), device_id: "d", server_public_key: `key-${letter.repeat(32)}`, name: letter.toUpperCase() }));
    const saved = new Map(rows.map((device) => [device.server_id, device]));
    const calls: string[] = [];
    const deps: ShellPcsDeps = {
      store: { list: async () => [...saved.values()], get: async (id: string) => saved.get(id), remove: async () => {}, update: async () => { throw new Error("not here"); } } as unknown as ShellPcsDeps["store"],
      keyIdOf: (key) => key.slice(4),
      createPcSweep: ((_store: unknown, _view: unknown, options: { pauseOutOfSight?: boolean }) => {
        calls.push(`sweep pause=${options.pauseOutOfSight}`);
        return { status: new Map(), check: async () => { calls.push("check"); }, checkOne: async (id: string) => { calls.push(`checkOne ${id[0]}`); }, stop: () => { calls.push("stop"); } };
      }) as unknown as ShellPcsDeps["createPcSweep"],
    };
    return { saved, calls, load: async () => deps };
  };
  let seen: ReturnType<typeof useShellPcs> | undefined;
  function Probe({ shown, load }: { readonly shown: boolean; readonly load: () => Promise<ShellPcsDeps> }) {
    seen = useShellPcs(true, shown, load);
    return null;
  }
  const settle = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };

  it("lists the other PCs, checks them only while in sight, and stops its sweep when the sidebar goes", async () => {
    const { calls, load } = fixture();
    await page.render(createElement(Probe, { shown: false, load })); await settle();
    expect(seen!.pcs.map((pc) => pc.name)).toEqual(["B", "C"]);
    expect(calls).toEqual(["sweep pause=true"]);
    await page.render(createElement(Probe, { shown: true, load }));
    await act(settle);
    expect(calls).toEqual(["sweep pause=true", "check"]);
    await page.render(null);
    expect(calls.at(-1)).toBe("stop");
  });

  it("drops a PC forgotten in another tab on Check again, and checks one still saved", async () => {
    const { saved, calls, load } = fixture();
    await page.render(createElement(Probe, { shown: true, load }));
    await act(settle);
    saved.delete("b".repeat(32));
    await act(async () => { seen!.recheck("b".repeat(32)); await settle(); });
    expect(seen!.pcs.map((pc) => pc.name)).toEqual(["C"]);
    await act(async () => { seen!.recheck("c".repeat(32)); await settle(); });
    expect(calls.filter((call) => call.startsWith("checkOne"))).toEqual(["checkOne c"]);
  });
});

describe("the hosted app's other PCs beside the PCs its PC lists", () => {
  it("leaves out a PC the page's PC already lists, by its relay ID or its own, or lists as an account row, so no PC shows twice", () => {
    const work = { server_id: "b".repeat(32), name: "Work PC" }, nas = { server_id: "c".repeat(32), name: "NAS" }, lab = { server_id: "d".repeat(32), name: "Lab" };
    const listed: Pick<Machine, "server_id" | "relay">[] = [{ server_id: "a".repeat(32) }, { relay: { server_id: work.server_id, relay: "wss://relay.ovis.sh" } }, { server_id: lab.server_id }];
    expect(unlistedShellPcs([work, nas, lab], listed)).toEqual([nas]);
    const none = [nas];
    expect(unlistedShellPcs(none, listed)).toBe(none);
    // one of the account's PCs the sidebar is adding (or that is off) is that row, not a link too
    expect(unlistedShellPcs([work, nas, lab], listed, [nas.server_id])).toEqual([]);
    // a PC the page's PC only watches (a vouched join, view_only): this device keeps its own link, where it drives
    const watched: Pick<Machine, "server_id" | "relay" | "view_only">[] = [{ relay: { server_id: work.server_id, relay: "wss://relay.ovis.sh" }, view_only: true }];
    expect(unlistedShellPcs([work, nas], watched)).toEqual([work, nas]);
  });
});
