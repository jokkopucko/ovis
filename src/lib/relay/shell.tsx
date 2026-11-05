/**
 * Drives the hosted shell's screens (components/RelayShell.tsx) from the page's address to a
 * connected PC, then hands the page to the app with the relay as its transport. Loaded only in
 * shell mode and only after the offer has left the address (boot.ts), since it brings the
 * cryptography and the mux with it.
 */
import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { MIN_SERVER_VERSION, MuxProtocolError } from "../../../shared/relay-mux.ts";
import type { RelayOffer } from "../../../shared/relay-offer.ts";
import type { UpdateStatus } from "../../../shared/update.ts";
import { RelayShell } from "../../components/RelayShell.tsx";
import { fetchUpdateStatus, requestUpdate } from "../api.ts";
import { deviceLabel } from "../phone.ts";
import { registerPendingPush } from "../push.ts";
import type { PendingPushStore } from "../push.ts";
import { alertPrefs, loadSettings, SettingsProvider } from "../settings.ts";
import { setTransport } from "../transport.ts";
import { takeEntryUrl } from "./boot.ts";
import { RelayUnreachableError } from "./channel.ts";
import { indexedDeviceStore, indexedPendingPush, ServerIdentityChangedError } from "./device.ts";
import type { RelayDeviceStore } from "./device.ts";
import { failureOf, forgedOffer, forgetsDevice, iosBrowserTab, keyMismatch, offerOf, shellEntry } from "./shellState.ts";
import type { PcUpdate, RelayShellState } from "./shellState.ts";
import { relaySkew, reloadOnce } from "./skew.ts";
import type { ReloadMemory } from "./skew.ts";
import { openRelayTransport } from "./transport.ts";
import type { RelayTransport } from "./transport.ts";

export interface RelayShellMount {
  container: HTMLElement;
  /** the address the page loaded with, offer fragment included (boot.ts took it off the address bar) */
  entryUrl: string;
  /** mounts the app on the container once the transport is set; what it returns is unmounted should the PC turn this phone away later */
  renderApp: () => Root;
  store?: RelayDeviceStore;
  pendingPush?: PendingPushStore;
  open?: typeof openRelayTransport;
  navigate?: (path: string) => void;
  /** who this phone is, for a new pairing; the browser's user agent by default */
  label?: string;
  /** this shell's package.json version; the build's by default */
  shellVersion?: string;
  /** brings in a newer shell: the worker checks for one, then the page reloads */
  reload?: () => Promise<void>;
}

declare const __APP_VERSION__: string;

/** How long a PC's update may take, from the install request to the restarted server: a build on a slow PC included. */
const UPDATE_MS = 15 * 60_000;
/** How often the shell reads the PC's update status while it installs. */
const UPDATE_POLL_MS = 1000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

async function reloadPage(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    // a worker check that hangs must not keep the stale shell up: the reload goes on without it
    await Promise.race([registration?.update(), wait(5000)]);
  } catch (error) { console.warn("Ovis: the service worker did not check for a newer shell", error); }
  window.location.reload();
}

function tabMemory(): ReloadMemory | null {
  try { return window.sessionStorage; } catch { return null; }
}

/** What a connection attempt was, for the screen a failure lands on (shellState.ts failureOf). */
interface Attempt {
  offer: RelayOffer;
  code: boolean;
  paired: boolean;
}

/** Settings' Forget this PC: the phone's key for the PC is gone; the PC lists the device until it is revoked there. */
export async function forgetSavedPc(serverId: string, store: RelayDeviceStore = indexedDeviceStore): Promise<void> {
  await store.remove(serverId);
}

export async function mountRelayShell(mount: RelayShellMount): Promise<void> {
  const store = mount.store ?? indexedDeviceStore;
  const open = mount.open ?? openRelayTransport;
  const navigate = mount.navigate ?? ((path: string) => { window.location.assign(path); });
  const label = mount.label ?? deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const shellVersion = mount.shellVersion ?? __APP_VERSION__;
  const reload = mount.reload ?? reloadPage;
  let entry = shellEntry(mount.entryUrl);
  const scoped = entry.serverId !== null;
  const iosTab = iosBrowserTab({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0, standalone: (navigator as Navigator & { standalone?: boolean }).standalone });
  let shell: Root | null = null;
  let app: Root | null = null;
  let transport: RelayTransport | null = null;
  let last: Attempt | null = null;
  let opening: AbortController | null = null;
  /** the PC the update screen is for, while it is up */
  let outdated: { opened: RelayTransport; attempt: Attempt; name: string | null; version: string } | null = null;
  let updating = false;

  // the push subscription this PC's worker kept while no window could hand it over (public/sw.js
  // pushsubscriptionchange): registered with the PC once it is connected, and when the worker says
  // it kept one while this window is in the app
  const pendingPush = mount.pendingPush ?? indexedPendingPush;
  const registerPending = (serverId: string): void => {
    // with this device's alert choices, as the app's own registration sends them, which then skips it
    registerPendingPush(serverId, pendingPush, alertPrefs(loadSettings())).catch((error: unknown) => {
      console.warn("Ovis: the PC did not take this device's new push subscription", error);
    });
  };
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
      if (transport === null || last === null || (event.data as { type?: unknown } | null)?.type !== "push-subscription-change") return;
      registerPending(last.offer.server_id);
    });
  }

  const toFront = (): void => navigate("/");

  const show = (state: RelayShellState): void => {
    shell ??= createRoot(mount.container);
    shell.render(createElement(StrictMode, null, createElement(SettingsProvider, null,
      createElement(RelayShell, { state, scoped, iosTab, onPair: pair, onRetry: retry, onCancel: cancel, onBack: toFront, onForget: forget, onUpdate: update }))));
  };

  const failed = async (error: unknown, attempt: Attempt): Promise<void> => {
    const failure = failureOf(error, { code: attempt.code, paired: attempt.paired });
    if (forgetsDevice(failure)) await store.remove(attempt.offer.server_id).catch(() => undefined);
    // the relay's close code is the one fact the sentence does not carry; a plain refusal adds nothing
    const detail = error instanceof RelayUnreachableError && error.closeCode !== null ? error.message : null;
    const mismatch = error instanceof ServerIdentityChangedError && error.saved !== undefined && error.offered !== undefined
      ? keyMismatch(attempt.offer.server_id, [{ key: error.saved, from: "saved" }, { key: error.offered, from: "link" }]) : null;
    show({ kind: "failed", failure, name: attempt.offer.name ?? null, detail, ...(mismatch ? { mismatch } : {}) });
  };

  const connect = async (attempt: Attempt): Promise<void> => {
    last = attempt;
    opening?.abort();
    const controller = new AbortController();
    opening = controller;
    show({ kind: "connecting", name: attempt.offer.name ?? null });
    let opened: RelayTransport;
    try {
      opened = await open(attempt.offer, {
        store, label, signal: controller.signal,
        // the PC turned this phone away after it was in: the app goes, and the reason takes its place
        onFatal: (error) => {
          if (transport !== opened) return;
          transport = null;
          app?.unmount();
          app = null;
          void failed(error, { offer: attempt.offer, code: false, paired: true });
        },
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      await failed(error, attempt);
      return;
    }
    if (controller.signal.aborted) { opened.close(); return; }
    // the PC admitted this phone: a pairing code is spent, and every later attempt (Try again on
    // the update screen included) signs with the saved device key instead of pairing again
    const { code, ...saved } = attempt.offer;
    const enrolled: Attempt = { offer: saved, code: false, paired: true };
    last = enrolled;
    if (code !== undefined && entry.offer !== null) entry = { ...entry, offer: null };
    await admitted(opened, enrolled);
  };

  const enterApp = (opened: RelayTransport, attempt: Attempt): void => {
    outdated = null;
    transport = opened;
    setTransport(opened);
    shell?.unmount();
    shell = null;
    app = mount.renderApp();
    registerPending(attempt.offer.server_id);
  };

  /** The PC let this phone in: the version policy (skew.ts) decides between the app, the update screen and a newer shell. */
  const admitted = async (opened: RelayTransport, attempt: Attempt): Promise<void> => {
    const server = opened.server ?? { version: "", relayProtocol: 0 };
    const skew = relaySkew({ server, shellVersion });
    if (skew === "protocol-mismatch") {
      opened.close();
      await failed(new MuxProtocolError("unsupported_version", `The PC speaks relay protocol ${server.relayProtocol}`), attempt);
      return;
    }
    const memory = tabMemory();
    if (skew === "server-newer" && memory !== null && reloadOnce(memory, shellVersion, server.version)) {
      opened.close();
      await reload();
      return;
    }
    if (skew !== "pc-outdated") { enterApp(opened, attempt); return; }
    transport = opened;
    setTransport(opened);
    outdated = { opened, attempt, name: attempt.offer.name ?? null, version: server.version };
    await offerUpdate(outdated);
  };

  const showUpdate = (on: NonNullable<typeof outdated>, update: PcUpdate): void => {
    if (outdated !== on || transport !== on.opened) return;
    show({ kind: "outdated", name: on.name, serverVersion: on.version, minVersion: MIN_SERVER_VERSION, update });
  };

  /** The Update button only for an install the PC's supervisor manages (server/update-api.ts); the steps by hand otherwise. */
  const offerUpdate = async (on: NonNullable<typeof outdated>): Promise<void> => {
    showUpdate(on, { phase: "reading" });
    let status: UpdateStatus | null = null;
    try { status = await fetchUpdateStatus(); } catch (error) { console.warn("Ovis: the PC's update status could not be read", error); }
    showUpdate(on, status?.managed === true ? { phase: "offer" } : { phase: "manual" });
  };

  /** The status once a check or install the PC runs has settled, or the deadline passed. */
  const settled = async (deadline: number): Promise<UpdateStatus> => {
    for (;;) {
      const status = await fetchUpdateStatus();
      if (status.phase !== "checking") return status;
      if (Date.now() > deadline) throw new Error("The PC's update check did not finish");
      await wait(UPDATE_POLL_MS);
    }
  };

  /**
   * Installs the release on offer on the PC (POST /api/updates/install, as Settings → Updates does),
   * then follows GET /api/updates until the restarted server answers through the relay: the
   * transport reconnects by itself, and its WELCOME names the new version.
   */
  const runUpdate = async (on: NonNullable<typeof outdated>): Promise<void> => {
    const deadline = Date.now() + UPDATE_MS;
    showUpdate(on, { phase: "installing", step: null });
    let status = await fetchUpdateStatus();
    if (!status.available || status.latest_revision === null) {
      await requestUpdate({ command: "check" });
      status = await settled(deadline);
    }
    if (!status.available || status.latest_revision === null) throw new Error(status.blocked_reason ?? status.error ?? "No update is on offer");
    await requestUpdate({ command: "install", expected_revision: status.latest_revision });
    for (;;) {
      await wait(UPDATE_POLL_MS);
      if (outdated !== on || transport !== on.opened) return;
      if (Date.now() > deadline) throw new Error("The PC did not come back with the update");
      if (on.opened.server !== undefined && on.opened.server.version !== on.version) break;
      let now: UpdateStatus;
      try { now = await fetchUpdateStatus(); } catch {
        // the server is restarting: the relay carrier dropped, and the transport is reconnecting
        showUpdate(on, { phase: "restarting" });
        continue;
      }
      if (now.phase === "error") throw new Error(now.error ?? "The update failed");
      showUpdate(on, now.phase === "restarting" ? { phase: "restarting" } : { phase: "installing", step: now.step ?? null });
    }
    // the pairing code, if the attempt had one, was spent on the admission before the update
    await admitted(on.opened, { ...on.attempt, code: false, paired: true });
  };

  const update = (): void => {
    const on = outdated;
    if (on === null || updating) return;
    updating = true;
    void runUpdate(on).catch((error: unknown) => {
      showUpdate(on, { phase: "failed", detail: error instanceof Error ? error.message : null });
    }).finally(() => { updating = false; });
  };

  const pair = (): void => {
    if (entry.offer === null) return;
    void connect({ offer: entry.offer, code: entry.offer.code !== undefined, paired: false });
  };

  const retry = (): void => {
    if (last === null) return;
    // the update screen holds the PC's connection open: a new attempt replaces it
    outdated = null;
    transport?.close();
    transport = null;
    void connect(last);
  };

  const cancel = (): void => {
    opening?.abort();
    opening = null;
    toFront();
  };

  // Forget only forgets: the link whose key failed the check is never paired with, here or by a
  // later Pair, so pairing again takes a new QR code scanned from the PC itself
  const forget = (): void => {
    const serverId = last?.offer.server_id ?? entry.serverId;
    const name = last?.offer.name ?? null;
    entry = { ...entry, offer: null };
    last = null;
    void (async () => {
      if (serverId !== null) await store.remove(serverId);
      show({ kind: "forgotten", name });
    })();
  };

  const arrived = (): boolean => {
    if (entry.damaged) { show({ kind: "failed", failure: "bad-offer", name: null, detail: null }); return true; }
    // a link that puts another key under this PC's id is never paired with, before or after a
    // Forget: it is no attempt (nothing retries it) and it touches no saved key
    if (entry.offer !== null && forgedOffer(entry.offer)) {
      show({ kind: "forged", name: entry.offer.name ?? null, mismatch: keyMismatch(entry.offer.server_id, [{ key: entry.offer.server_public_key, from: "link" }]) });
      entry = { ...entry, offer: null };
      return true;
    }
    if (entry.offer !== null) { show({ kind: "confirm", offer: entry.offer }); return true; }
    return false;
  };

  // a pairing link pasted into this tab while a screen is up changes only the fragment, which
  // loads nothing: it is taken off the address and asked about like one the page loaded with
  window.addEventListener("hashchange", () => {
    if (app !== null || window.location.hash === "") return;
    const next = shellEntry(takeEntryUrl(window));
    if (next.offer === null && !next.damaged) return;
    opening?.abort();
    opening = null;
    // the update screen's PC connection goes with its screen: nothing on the new one retries it
    outdated = null;
    transport?.close();
    transport = null;
    last = null;
    entry = next;
    arrived();
  });

  if (arrived()) return;
  if (entry.serverId !== null) {
    const saved = await store.get(entry.serverId);
    if (saved === undefined) show({ kind: "empty" });
    // a key saved from a forged link (an earlier build saved before admission): Forget removes it
    else if (forgedOffer(offerOf(saved))) show({ kind: "failed", failure: "identity-changed", name: saved.name ?? null, detail: null, mismatch: keyMismatch(saved.server_id, [{ key: saved.server_public_key, from: "saved" }]) });
    else await connect({ offer: offerOf(saved), code: false, paired: saved.device_id !== null });
    return;
  }
  const devices = await store.list();
  show(devices.length === 0 ? { kind: "empty" } : { kind: "list", devices });
}
