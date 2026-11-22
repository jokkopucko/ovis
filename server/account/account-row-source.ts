import { AccountDeviceStore } from "./account-devices.ts";
import type { AccountRow, AccountRowPorts, AccountRowSource } from "./account-device-state.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import { expiresAt } from "./row-expiry.ts";

/**
 * The account rows of whichever relay identity this PC has now: the store is opened for that identity's server id on
 * first use and opened again when the identity changes, so rows written for another identity are never rows here.
 */
export function accountRowsFor(stateDir: string, serverId: () => string | null, ports: AccountRowPorts & { setTimeout?: MuxClock["setTimeout"] }) {
  let open: { serverId: string; store: AccountDeviceStore } | null = null;
  let cancel: (() => void) | undefined;
  let stopped = false;
  const schedule = (rows: readonly AccountRow[], retryMs = 0): void => {
    cancel?.();
    cancel = undefined;
    const due = Math.min(...rows.map(expiresAt));
    if (stopped || !ports.setTimeout || due === Infinity) return;
    // Sixty days exceeds the native timer range. Recheck the PC wall clock on each wake.
    cancel = ports.setTimeout(() => {
      const current = store();
      if (!current || current.error !== null) return;
      try { current.expire(); }
      catch (error) {
        console.error("[account] could not persist row expiry:", error);
        schedule(current.rows(), 60_000);
        return;
      }
      schedule(current.rows());
    }, Math.min(2_147_483_647, Math.max(retryMs, due - ports.now())));
  };
  const store = (): AccountDeviceStore | null => {
    const id = serverId();
    if (id === null) return null;
    if (open?.serverId !== id) {
      // the rows of the identity this PC had end here: their sessions close, and the file is the new identity's (T44)
      if (open !== null) {
        open.store.clear("identity_reset");
      }
      open = { serverId: id, store: new AccountDeviceStore(stateDir, id, ports, schedule) };
      schedule(open.store.rows());
    }
    return open.store;
  };
  return {
    store,
    stop: () => { stopped = true; cancel?.(); },
    blocked: () => store()?.blocked() ?? null,
    missing: () => store()?.missing() ?? true,
    rows: () => store()?.rows() ?? [],
    row: (id) => store()?.row(id) ?? null,
    rename: (id, label) => store()?.rename(id, label) ?? null,
    rowsByKey: (key) => store()?.rowsByKey(key) ?? [],
    access: (id) => store()?.access(id) ?? { refused: "not_listed" },
    pruneDenied: (evidence, legacyRevoke) => { store()?.pruneDenied(evidence, legacyRevoke); },
    removeRows: (ids, reason, close) => { store()?.removeRows(ids, reason, close); },
    itsMe: (id, sayer) => store()?.itsMe(id, sayer) ?? false,
    seen: (id) => { store()?.seen(id); },
    readmission: (id) => store()?.readmission(id),
  } satisfies AccountRowSource & { store(): AccountDeviceStore | null; stop(): void };
}
