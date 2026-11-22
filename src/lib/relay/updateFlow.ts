import { MIN_SERVER_VERSION, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { UpdateStatus } from "../../../shared/update.ts";
import { fetchUpdateStatus, requestUpdate } from "../api.ts";
import { requestFreshShell } from "../shellMode.ts";
import { setTransport } from "../transport.ts";
import { relaySkew, reloadOnce } from "./skew.ts";
import type { ReloadMemory } from "./skew.ts";
import type { Attempt, PcUpdate, RelayShellState } from "./shellState.ts";
import type { RelayTransport } from "./transport.ts";
import { indexedDeviceStore, observedVersionOf, type ObservedVersion, type RelayDeviceStore, type SavedDevice } from "./device.ts";

export type { ObservedVersion } from "./device.ts";

const UPDATE_MS = 15 * 60_000;
const UPDATE_POLL_MS = 1000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export async function reloadPage(serverId: string | null): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    // a worker check that hangs must not keep the stale shell up: the reload goes on without it
    await Promise.race([registration?.update(), wait(5000)]);
  } catch (error) { console.warn("Ovis: the service worker did not check for a newer shell", error); }
  if (serverId !== null) await freshShellNext(serverId);
  window.location.reload();
}

export async function freshShellNext(serverId: string): Promise<void> {
  try { await requestFreshShell(caches, serverId); } catch (error) { console.warn("Ovis: the worker was not asked for a fresh shell", error); }
}

function tabMemory(): ReloadMemory | null {
  try { return window.sessionStorage; } catch { return null; }
}


/** Where older shells kept the observed versions; web storage holds no relay data now (scripts/relay-e2e-regression.ts). */
const LEGACY_VERSION_KEY = "ovis-relay-versions";

let observed: ReadonlyMap<string, ObservedVersion> = new Map();
export function observedVersions(): ReadonlyMap<string, ObservedVersion> { return observed; }

function takeLegacyVersions(): ReadonlyMap<string, ObservedVersion> {
  const entries = new Map<string, ObservedVersion>();
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try {
      const area = storage();
      let value: unknown;
      // the record goes even when it cannot be read: a damaged one would otherwise stay forever
      try { value = JSON.parse(area.getItem(LEGACY_VERSION_KEY) ?? "[]"); } finally { area.removeItem(LEGACY_VERSION_KEY); }
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (Array.isArray(item) && typeof item[0] === "string" && /^[0-9a-f]{32}$/.test(item[0]) && typeof item[1] === "object" && item[1] !== null
          && typeof item[1].version === "string" && typeof item[1].outdated === "boolean") entries.set(item[0], { version: item[1].version, outdated: item[1].outdated });
      }
    } catch {}
  }
  return entries;
}

class UnsavedPcError extends Error {
  constructor(readonly serverId: string) { super(`PC ${serverId} is not saved in this browser`); }
}

async function keepVersion(store: RelayDeviceStore, serverId: string, version: ObservedVersion): Promise<void> {
  try {
    await store.update(serverId, (current) => {
      if (current === undefined) throw new UnsavedPcError(serverId);
      const saved: SavedDevice = { ...current, observed_version: version };
      return saved;
    });
  } catch (error) {
    if (error instanceof UnsavedPcError) return;
    console.warn("Ovis: the PC's version was not saved", error);
  }
}

export async function loadObservedVersions(store: RelayDeviceStore = indexedDeviceStore): Promise<void> {
  const legacy = takeLegacyVersions();
  const devices = await store.list().catch((error: unknown) => {
    console.warn("Ovis: the saved PCs' versions could not be read", error);
    return null;
  });
  if (devices === null) return;
  const next = new Map<string, ObservedVersion>();
  for (const device of devices) {
    const kept = observedVersionOf(device);
    const version = kept ?? legacy.get(device.server_id);
    if (version === undefined) continue;
    next.set(device.server_id, version);
    if (kept === undefined) await keepVersion(store, device.server_id, version);
  }
  observed = next;
}

export async function forgetSavedPc(serverId: string, store: RelayDeviceStore = indexedDeviceStore): Promise<void> {
  await store.remove(serverId);
  const versions = new Map(observed);
  versions.delete(serverId);
  observed = versions;
}

export function createUpdateFlow(shellVersion: string, view: {
  readonly show: (state: RelayShellState) => void;
  readonly accepted: (opened: RelayTransport, attempt: Attempt) => void;
  readonly failed: (error: unknown, attempt: Attempt) => Promise<void>;
  readonly reload: () => Promise<void>;
  /** The attempt goes on in this page even on a newer PC: the newer shell is loaded at a later admission instead. */
  readonly holdsReload?: (attempt: Attempt) => boolean;
}, store: RelayDeviceStore = indexedDeviceStore) {
  let outdated: { opened: RelayTransport; attempt: Attempt; name: string | null; version: string } | null = null;
  let updating = false;
  let generation = 0;
  const { show, failed, reload } = view;
  const admit = async (opened: RelayTransport, attempt: Attempt): Promise<void> => {
    const mine = ++generation;
    const server = opened.server ?? { version: "", relayProtocol: 0 };
    const skew = relaySkew({ server, shellVersion });
    if (skew === "protocol-mismatch") {
      opened.close();
      await failed(new MuxProtocolError("unsupported_version", `The PC speaks relay protocol ${server.relayProtocol}`), attempt);
      return;
    }
    const version = { version: server.version, outdated: skew === "pc-outdated" };
    observed = new Map(observed).set(attempt.offer.server_id, version);
    await keepVersion(store, attempt.offer.server_id, version);
    if (generation !== mine) return;
    const memory = tabMemory();
    if (skew === "server-newer" && memory !== null && view.holdsReload?.(attempt) !== true && reloadOnce(memory, shellVersion, server.version)) { opened.close(); await reload(); return; }
    if (skew !== "pc-outdated") { outdated = null; view.accepted(opened, attempt); return; }
    setTransport(opened);
    outdated = { opened, attempt, name: attempt.offer.name ?? null, version: server.version };
    await offerUpdate(outdated);
  };
  const showUpdate = (on: NonNullable<typeof outdated>, update: PcUpdate): void => {
    if (outdated !== on) return;
    show({ kind: "outdated", name: on.name, serverVersion: on.version, minVersion: MIN_SERVER_VERSION, update });
  };

  const offerUpdate = async (on: NonNullable<typeof outdated>): Promise<void> => {
    showUpdate(on, { phase: "reading" });
    let status: UpdateStatus | null = null;
    try { status = await fetchUpdateStatus(); } catch (error) { console.warn("Ovis: the PC's update status could not be read", error); }
    showUpdate(on, status?.managed === true ? { phase: "offer" } : { phase: "manual" });
  };

  const settled = async (on: NonNullable<typeof outdated>, deadline: number): Promise<UpdateStatus | null> => {
    for (;;) {
      if (outdated !== on) return null;
      const status = await fetchUpdateStatus();
      if (status.phase !== "checking") return status;
      if (Date.now() > deadline) throw new Error("The PC's update check did not finish");
      await wait(UPDATE_POLL_MS);
    }
  };

  const runUpdate = async (on: NonNullable<typeof outdated>): Promise<void> => {
    const deadline = Date.now() + UPDATE_MS;
    showUpdate(on, { phase: "installing", step: null });
    let status = await fetchUpdateStatus();
    if (outdated !== on) return;
    if (!status.available || status.latest_revision === null) {
      await requestUpdate({ command: "check" });
      const checked = await settled(on, deadline);
      if (checked === null) return;
      status = checked;
    }
    if (outdated !== on) return;
    if (!status.available || status.latest_revision === null) throw new Error(status.blocked_reason ?? status.error ?? "No update is on offer");
    await requestUpdate({ command: "install", expected_revision: status.latest_revision });
    for (;;) {
      await wait(UPDATE_POLL_MS);
      if (outdated !== on) return;
      if (Date.now() > deadline) throw new Error("The PC did not come back with the update");
      if (on.opened.server !== undefined && on.opened.server.version !== on.version) break;
      let now: UpdateStatus;
      try { now = await fetchUpdateStatus(); } catch {
        showUpdate(on, { phase: "restarting" });
        continue;
      }
      if (now.phase === "error") throw new Error(now.error ?? "The update failed");
      showUpdate(on, now.phase === "restarting" ? { phase: "restarting" } : { phase: "installing", step: now.step ?? null });
    }
    // the pairing code, if the attempt had one, was spent on the admission before the update
    if (outdated === on) await admit(on.opened, { ...on.attempt, code: false, paired: true });
  };

  const update = (): void => {
    const on = outdated;
    if (on === null || updating) return;
    updating = true;
    void runUpdate(on).catch((error: unknown) => {
      showUpdate(on, { phase: "failed", detail: error instanceof Error ? error.message : null });
    }).finally(() => { updating = false; });
  };


  return { admit, update, cancel: () => { outdated = null; generation++; } };
}
