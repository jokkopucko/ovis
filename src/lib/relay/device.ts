import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { getDevice as getSharedDevice, type RelayDevice, type RelayDeviceStore as SharedRelayDeviceStore } from "../../../shared/relay-device.ts";
import type { PendingPush, PendingPushStore } from "../push.ts";

export { base64url, ServerIdentityChangedError, sign } from "../../../shared/relay-device.ts";
export type { RelayDevice } from "../../../shared/relay-device.ts";

export interface ObservedVersion { readonly version: string; readonly outdated: boolean }
export type EnrollmentState = "pending" | "complete" | "failed";
export type SavedDevice = RelayDevice & { readonly observed_version?: ObservedVersion; readonly account_enrollment?: { readonly account: string; readonly state: EnrollmentState } };

export interface RelayDeviceStore extends SharedRelayDeviceStore {
  /** Reads and checks `source` in the target's write transaction before applying `change`. */
  update(serverId: string, change: (current: RelayDevice | undefined) => RelayDevice, source?: { readonly serverId: string; readonly assert: (current: RelayDevice | undefined) => void }): Promise<RelayDevice>;
}

/** The store the hosted shell keeps its pairings in. */
export interface ShellDeviceStore extends RelayDeviceStore {
  /**
   * Forgets a PC only while its saved record is still the row `deviceId`, read and deleted in one write transaction:
   * a Forget or a newer pairing made since (another tab) stands. True when it forgot it.
   */
  removeRow(serverId: string, deviceId: string): Promise<boolean>;
}

export function enrollmentOf(device: RelayDevice, account?: string): EnrollmentState | undefined {
  if (!("account_enrollment" in device)) return undefined;
  const value: unknown = device.account_enrollment;
  if (typeof value !== "object" || value === null || !("account" in value) || !("state" in value)) return undefined;
  if (typeof value.account !== "string" || (account !== undefined && account !== value.account)) return undefined;
  return value.state === "pending" || value.state === "complete" || value.state === "failed" ? value.state : undefined;
}

export function observedVersionOf(device: RelayDevice): ObservedVersion | undefined {
  if (!("observed_version" in device)) return undefined;
  const value: unknown = device.observed_version;
  if (typeof value !== "object" || value === null || !("version" in value) || !("outdated" in value)) return undefined;
  return typeof value.version === "string" && typeof value.outdated === "boolean" ? { version: value.version, outdated: value.outdated } : undefined;
}

export const indexedDeviceStore: ShellDeviceStore = {
  async get(serverId) {
    const db = await openDatabase();
    try {
      return await new Promise<RelayDevice | undefined>((resolve, reject) => {
        const tx = db.transaction("devices", "readonly");
        const request: IDBRequest<RelayDevice | undefined> = tx.objectStore("devices").get(serverId);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async list() {
    const db = await openDatabase();
    try {
      return await new Promise<RelayDevice[]>((resolve, reject) => {
        const tx = db.transaction("devices", "readonly");
        const request: IDBRequest<RelayDevice[]> = tx.objectStore("devices").getAll();
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async remove(serverId) {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["devices", "pending-push"], "readwrite");
        tx.objectStore("devices").delete(serverId);
        tx.objectStore("pending-push").delete(serverId);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async removeRow(serverId, deviceId) {
    const db = await openDatabase();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(["devices", "pending-push"], "readwrite");
        const devices = tx.objectStore("devices");
        let removed = false;
        const request: IDBRequest<RelayDevice | undefined> = devices.get(serverId);
        request.onsuccess = () => {
          if (request.result?.device_id !== deviceId) return;
          devices.delete(serverId);
          tx.objectStore("pending-push").delete(serverId);
          removed = true;
        };
        tx.oncomplete = () => resolve(removed);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async update(serverId, change, source) {
    const db = await openDatabase();
    try {
      return await new Promise<RelayDevice>((resolve, reject) => {
        const tx = db.transaction("devices", "readwrite");
        const store = tx.objectStore("devices");
        const request: IDBRequest<RelayDevice | undefined> = store.get(serverId);
        const sourceRequest: IDBRequest<RelayDevice | undefined> | undefined = source === undefined ? undefined : store.get(source.serverId);
        let result: RelayDevice;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
        const apply = (): void => {
          try {
            if (source !== undefined && sourceRequest !== undefined) source.assert(sourceRequest.result);
            result = change(request.result);
            store.put(result);
          } catch (error) {
            tx.abort();
            reject(error);
          }
        };
        // Requests execute in order; the final read's callback keeps the transaction active.
        if (sourceRequest === undefined) request.onsuccess = apply;
        else sourceRequest.onsuccess = apply;
      });
    } finally { db.close(); }
  },
};

export const indexedPendingPush: PendingPushStore = {
  async get(serverId) {
    const db = await openDatabase();
    try {
      return await new Promise<PendingPush | undefined>((resolve, reject) => {
        const tx = db.transaction("pending-push", "readonly");
        const request: IDBRequest<PendingPush | undefined> = tx.objectStore("pending-push").get(serverId);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async clear(serverId, endpoint) {
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("pending-push", "readwrite");
        const store = tx.objectStore("pending-push");
        const request: IDBRequest<PendingPush | undefined> = store.get(serverId);
        request.onsuccess = () => { if (request.result?.subscription.endpoint === endpoint) store.delete(serverId); };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ovis-relay", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("devices")) db.createObjectStore("devices", { keyPath: "server_id" });
      if (!db.objectStoreNames.contains("pending-push")) db.createObjectStore("pending-push", { keyPath: "server_id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** The saved key for the offer's PC in this browser (IndexedDB unless another store is given), or a new unsaved one. */
export function getDevice(offer: RelayOffer, store: RelayDeviceStore = indexedDeviceStore, label?: string): Promise<RelayDevice> {
  return getSharedDevice(offer, store, label);
}
