import type { RelayOffer } from "../../../shared/relay-offer.ts";
import { getDevice as getSharedDevice, type RelayDevice, type RelayDeviceStore } from "../../../shared/relay-device.ts";
import type { PendingPush, PendingPushStore } from "../push.ts";

export { base64url, ServerIdentityChangedError, sign } from "../../../shared/relay-device.ts";
export type { RelayDevice, RelayDeviceStore } from "../../../shared/relay-device.ts";

export const indexedDeviceStore: RelayDeviceStore = {
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
  async update(serverId, change) {
    const db = await openDatabase();
    try {
      return await new Promise<RelayDevice>((resolve, reject) => {
        const tx = db.transaction("devices", "readwrite");
        const store = tx.objectStore("devices");
        const request: IDBRequest<RelayDevice | undefined> = store.get(serverId);
        let result: RelayDevice;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
        request.onsuccess = () => {
          try {
            result = change(request.result);
            store.put(result);
          } catch (error) {
            tx.abort();
            reject(error);
          }
        };
      });
    } finally { db.close(); }
  },
};

/** The subscriptions each PC's worker kept for the shell to register (lib/push.ts registerPendingPush). */
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

/**
 * The shell's database. Version 2 added `pending-push`, which the worker writes too: public/sw.js
 * openRelayDatabase opens the same name and version with the same stores.
 */
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
