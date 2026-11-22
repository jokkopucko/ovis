import "./ShellPcs.css";

import { useEffect, useRef, useState } from "react";
import { Monitor } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { serverIdOfPath, serverScopePath } from "../lib/shellMode.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { RelayDeviceStore, ShellDeviceStore } from "../lib/relay/device.ts";
import type { createPcSweep as createPcSweepType } from "../lib/relay/pcSweep.ts";
import { StatusDot } from "./StatusDot.tsx";

interface ShellPc { readonly server_id: string; readonly name: string | null }
interface Sweep { readonly status: ReadonlyMap<string, PcStatus>; readonly check: () => Promise<void>; readonly checkOne: (serverId: string) => Promise<void>; readonly stop: () => void }

/** What the sidebar's list reads and checks with: this device's pairings, the front page's sweep and the key's id. */
export interface ShellPcsDeps {
  readonly store: Pick<ShellDeviceStore, "get" | "list"> & RelayDeviceStore;
  readonly createPcSweep: typeof createPcSweepType;
  readonly keyIdOf: (publicKey: string) => string | null;
}

const loadDeps = async (): Promise<ShellPcsDeps> => {
  const [{ indexedDeviceStore }, { createPcSweep }, { keyIdOf }] = await Promise.all([import("../lib/relay/device.ts"), import("../lib/relay/pcSweep.ts"), import("../lib/relay/shellState.ts")]);
  return { store: indexedDeviceStore, createPcSweep, keyIdOf };
};

/**
 * The pairings a row stands for: finished ones whose key is the one their id names (a mismatch is its own page's to
 * say), never the PC of this page and never one the account merely lists (those are not in this device's store).
 */
export function shellPcRows<T extends { readonly server_id: string; readonly device_id: string | null; readonly server_public_key: string }>(devices: readonly T[], here: string | null, keyIdOf: (publicKey: string) => string | null): T[] {
  return devices.filter((device) => device.server_id !== here && device.device_id !== null && keyIdOf(device.server_public_key) === device.server_id);
}

/**
 * The other PCs this device is paired with, for the hosted app's sidebar: each opens on its own page, which connects
 * with the key this device holds for it, as a tap on it in the front page's list did. They are checked by the front
 * page's own sweep (pcSweep.ts: a minute apart across every tab of the app, a few at a time, so the relay never turns a
 * real connection away for them), and only while the list is in sight (`shown`). `on`: only the hosted app on a PC's
 * page has such a list.
 */
export function useShellPcs(on: boolean, shown: boolean, load: () => Promise<ShellPcsDeps> = loadDeps): { readonly pcs: readonly ShellPc[]; readonly status: ReadonlyMap<string, PcStatus>; readonly recheck: (serverId: string) => void } {
  const [pcs, setPcs] = useState<readonly ShellPc[]>([]);
  const [, redraw] = useState(0);
  const sweep = useRef<Sweep | null>(null);
  const visible = useRef(shown);
  visible.current = shown;
  const forget = useRef<(serverId: string) => Promise<boolean>>(async () => false);
  useEffect(() => {
    if (!on) return;
    let gone = false;
    const here = serverIdOfPath(window.location.pathname);
    void load().then(async ({ store, createPcSweep, keyIdOf }) => {
      const others = { ...store, list: async () => shellPcRows(await store.list(), here, keyIdOf) };
      const devices = await others.list();
      if (gone) return;
      setPcs(devices.map((device) => ({ server_id: device.server_id, name: device.name ?? null })));
      sweep.current = createPcSweep(others, { active: () => !gone && visible.current, redraw: () => { if (!gone) redraw((n) => n + 1); } }, { pauseOutOfSight: true });
      // a PC forgotten in another tab since: its row goes instead of being checked
      forget.current = async (serverId) => {
        if ((await store.get(serverId)) !== undefined || gone) return false;
        setPcs((rows) => rows.filter((row) => row.server_id !== serverId));
        return true;
      };
      if (visible.current) void sweep.current.check();
    }).catch((error: unknown) => { console.warn("Ovis: this device's other PCs could not be read", error); });
    return () => { gone = true; sweep.current?.stop(); sweep.current = null; };
  }, [on, load]);
  useEffect(() => { if (shown) void sweep.current?.check(); }, [shown]);
  return {
    pcs, status: sweep.current?.status ?? new Map(),
    recheck: (serverId) => { void forget.current(serverId).then((forgotten) => { if (!forgotten) void sweep.current?.checkOne(serverId); }); },
  };
}

/** What a row says of its PC: a re-check keeps what the last one found, so Check again stays where the focus is. */
function shownOf(status: PcStatus | undefined): PcStatus | undefined {
  return status?.kind === "checking" ? status.previous ?? status : status;
}

/** The rows: each opens its PC; one the relay found with nobody there reads Off, with Check again, and one no check settled offers Check again alone. */
export function ShellPcs({ pcs, status, recheck }: ReturnType<typeof useShellPcs>) {
  const t = useT();
  if (pcs.length === 0) return null;
  return (
    <ul className="shell-pcs" aria-label={t("Other PCs")}>
      {pcs.map((pc) => {
        const now = status.get(pc.server_id), shown = shownOf(now);
        const off = shown?.kind === "offline" && shown.reason === "pc";
        // a check that settled nothing (the relay could not be reached or turned this device away, which the sweep keeps
        // no finding for) or none yet: Check again, without calling the PC off
        const retry = shown === undefined || shown.kind === "offline";
        const name = pc.name ?? t("Unnamed PC");
        return (
          <li key={pc.server_id} className="shell-pc" data-pc-state={shown?.kind === "answered" ? "on" : off ? "off" : shown?.kind === "checking" ? "checking" : "unknown"}>
            <a className="shell-pc-open" href={serverScopePath(pc.server_id)}>
              <Monitor aria-hidden="true" />
              <span className="shell-pc-name">{name}</span>
              {shown?.kind === "answered" && <StatusDot state="ready" size="inline" />}
              {shown?.kind === "checking" && <StatusDot state="checking" size="inline" />}
            </a>
            {retry && (
              <span className="shell-pc-off">
                {off && <><span>{t("Off|pc state")}</span><span aria-hidden="true">·</span></>}
                <button type="button" className="btn shell-pc-check" aria-busy={now?.kind === "checking" || undefined} onClick={() => recheck(pc.server_id)}>{t("Check again")}</button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
