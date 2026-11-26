import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Pencil, Trash2, X } from "lucide-react";

import "./DevicesPanel.css";

import { ApiError, blockTailnetNodes, fetchDevices, renameDevice, revokeAllDevices, revokeDevice } from "../lib/api.ts";
import { useTailnetNodes } from "../lib/useTailnetNodes.ts";
import { ownWindowHere } from "../lib/account/addThisPc.ts";
import { methodName } from "../lib/portalAuth.ts";
import { DEVICES_CHANGED_EVENT, PAIRING_CODE_EVENT } from "../lib/useRelay.ts";
import type { HealthAuth, PairedDevice, PairingCode } from "../../shared/protocol.ts";
import type { TailnetNodeView } from "../../shared/tailnet-nodes.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ConnectionLine } from "./ConnectionLine.tsx";
import { SettingsRow } from "./SettingsControls.tsx";
import { currentLocale, useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { pairThisBrowser, UnconfirmedPairing } from "../lib/pairing.ts";

const POLL_MS = 3000;
/** a device seen this recently is not called offline, whatever its sessions: it may be in by its cookie */
const SEEN_LATELY_MS = 2 * 60_000;
const seenLately = (d: PairedDevice): boolean => !d.through_account && d.last_seen_at !== null && Date.now() - Date.parse(d.last_seen_at) < SEEN_LATELY_MS;
/** a row the account let in is last seen by the day (its UTC day, as the PC keeps it), never as a time of day */
const seenWhen = (d: PairedDevice): string => d.through_account && d.last_seen_at !== null
  ? new Date(d.last_seen_at).toLocaleDateString(currentLocale(), { timeZone: "UTC" }) : lastSeen(d.last_seen_at);
const REFRESH_MS = 30_000;
/** a Tailscale device of the owner's login seen this recently is offered in the removal dialog */
const TAILNET_RECENT_MS = 30 * 24 * 60 * 60_000;

export interface DevicesPanelProps {
  onDevicePaired?: () => void;
  auth: HealthAuth | null;
  onPaired?: () => void;
  onRevokedAll?: () => void;
  kindOf?: (label: string) => string | null;
  currentAction?: ReactNode;
  more?: HTMLElement | null;
  checkSlot?: HTMLElement | null;
}

export const VIA: Record<NonNullable<HealthAuth["via"]>, string> = {
  local: "You are on the PC itself.",
  tailscale: "You are in as this PC's Tailscale login.",
  device: "This is a paired device.",
  relay: "This is a paired device, reaching the PC through the Ovis relay.",
  token: "You are in with the access token.",
  portal: "You are in through Portal's sign-in.",
  open: "This browser is in only because nothing is paired yet: from anywhere that can reach this address, so would anyone.",
};

export function DevicesPanel({ onDevicePaired, auth, onPaired, onRevokedAll, kindOf, currentAction = null, more = null, checkSlot = null }: DevicesPanelProps) {
  const t = useT();
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<PairingCode | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [revokedAll, setRevokedAll] = useState(false);
  const [justPaired, setJustPaired] = useState<string | null>(null);
  const [pairingSelf, setPairingSelf] = useState(false);
  // the Tailscale devices a removal keeps out, read and blocked from this PC's own window only (server/tailnet-nodes.ts)
  const [tailnetAgain, setTailnetAgain] = useState(0);
  const tailnet = useTailnetNodes(ownWindowHere(auth) && auth?.role !== "watch", tailnetAgain);
  const [removing, setRemoving] = useState<{ id: string | null; label: string } | null>(null);
  const [alsoBlock, setAlsoBlock] = useState<ReadonlySet<string>>(new Set());
  const offered = (tailnet?.nodes ?? []).filter((node) => !node.blocked && (node.rows.length > 0 || (node.seen_at !== null && Date.now() - Date.parse(node.seen_at) < TAILNET_RECENT_MS)));
  const known = useRef(new Set<string>());
  const loaded = useRef(false);
  const generation = useRef(0);
  const pairingSelfLock = useRef(false);
  const reads = useRef({ started: 0, landed: 0 });
  const inFlight = useRef(0);

  const load = useCallback(async ({ quiet = false, check = false } = {}) => {
    const started = generation.current;
    const read = ++reads.current.started;
    const stale = () => started !== generation.current || read < reads.current.landed;
    inFlight.current++;
    try {
      const list = await fetchDevices(check);
      if (stale()) return;
      reads.current.landed = read;
      setDevices(list);
      if (!quiet) setError(null);
      // a device the account's list let in spent no code here: the PC's own banner tells of it, and a code shown stays
      const fresh = list.filter((d) => !d.through_account && !known.current.has(d.id));
      if (loaded.current && fresh.length > 0) {
        for (const d of fresh) { setJustPaired(d.label); setCode(null); setRevokedAll(false); }
        onDevicePaired?.();
      }
      known.current = new Set(list.map((d) => d.id));
      loaded.current = true;
    } catch (e) {
      if (quiet || stale()) return;
      reads.current.landed = read;
      setDevices([]);
      setError(e instanceof ApiError && e.status === 404 ? t("Devices are managed on a real server.") : e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current--;
    }
  }, [t, onDevicePaired]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // never over a read still on its way: a later quiet read landing first would make a Check now's answer stale
    const timer = setInterval(() => { if (inFlight.current === 0) void load({ quiet: true }); }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  const [checking, setChecking] = useState(false);
  const checkNow = async (): Promise<void> => {
    setChecking(true);
    try { await load({ check: true }); } finally { setChecking(false); }
  };

  useEffect(() => {
    const onChanged = () => void load({ quiet: true });
    window.addEventListener(DEVICES_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DEVICES_CHANGED_EVENT, onChanged);
  }, [load]);

  useEffect(() => {
    const onCode = (event: Event) => {
      setJustPaired(null);
      setRevokedAll(false);
      setCode((event as CustomEvent<PairingCode>).detail);
    };
    window.addEventListener(PAIRING_CODE_EVENT, onCode);
    return () => window.removeEventListener(PAIRING_CODE_EVENT, onCode);
  }, []);

  useEffect(() => {
    if (code === null) return;
    const tick = () => {
      if (Date.parse(code.expires_at) - Date.now() <= 0) setCode(null);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    const poll = window.setInterval(() => void load(), POLL_MS);
    return () => { window.clearInterval(timer); window.clearInterval(poll); };
  }, [code, load]);

  /** an "open" browser pairs itself: a code, used at once, so the gate closes to everyone else */
  const pairSelf = async () => {
    if (pairingSelfLock.current) return;
    pairingSelfLock.current = true;
    setPairingSelf(true);
    setError(null);
    try {
      const list = await pairThisBrowser();
      setDevices(list);
      known.current = new Set(list.map((device) => device.id));
      setJustPaired(list.find((device) => device.current)!.label);
      onPaired?.();
    } catch (e) {
      if (e instanceof UnconfirmedPairing) {
        setError(t("Could not confirm this browser is paired. Check that cookies are enabled, then try again."));
        void fetchDevices().then((list) => { setDevices(list); known.current = new Set(list.map((device) => device.id)); }, () => undefined);
      } else setError(e instanceof Error ? e.message : String(e));
    }
    finally {
      pairingSelfLock.current = false;
      setPairingSelf(false);
    }
  };
  const rename = async () => {
    if (!renaming) return;
    try { await renameDevice(renaming.id, renaming.label); setRenaming(null); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const revoke = async (id: string) => {
    // this PC's own window asks in a dialog that lists the Tailscale devices the removal keeps out
    if (offered.length > 0) { setAlsoBlock(new Set()); setRemoving({ id, label: devices?.find((d) => d.id === id)?.label ?? "" }); return; }
    if (confirming !== id) { setConfirming(id); window.setTimeout(() => setConfirming((c) => (c === id ? null : c)), 4000); return; }
    setConfirming(null);
    setRevokedAll(false);
    try { await revokeDevice(id); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const confirmRemoval = async (): Promise<void> => {
    if (removing === null) return;
    const chosen = [...alsoBlock];
    if (removing.id === null && chosen.length === 0) throw new Error(t("Choose a device to keep out."));
    if (removing.id !== null) await revokeDevice(removing.id);
    if (chosen.length > 0) await blockTailnetNodes(chosen);
    setRemoving(null);
    setRevokedAll(false);
    setTailnetAgain((count) => count + 1);
    await load();
  };
  /**
   * One request ends every pairing, this browser's included (the server clears its device cookie).
   * A failure stays in the dialog; after a success nothing is asked of the server again from here:
   * a browser that was in as a device is out now, and the app finds that out through `onRevokedAll`.
   */
  const revokeAll = async () => {
    try { await revokeAllDevices(); } catch (e) {
      // no answer from the server (the connection dropped, the answer did not parse): the write may have
      // happened, so nothing is promised; the list is read again to show what is still paired
      if (!(e instanceof ApiError)) {
        void load();
        throw new Error(t("The PC did not answer, so it is not known whether the devices were revoked. Check the list, and try again if they are still there."));
      }
      // the dialog shows this: what did not happen, why in words, and what to do next; a server fault
      // carries its log reference (`internal error (<id>)`), never a file name or a stack
      const detail = e.detail;
      const reference = e.status >= 500 ? /\(([^()]+)\)\s*$/.exec(detail)?.[1] : undefined;
      throw new Error(reference !== undefined
        ? t("Nothing was revoked: the PC could not save the change. Try again; if it keeps failing, look up {reference} in the server's log on the PC.", { reference })
        : t("Nothing was revoked ({reason}). Try again.", { reason: detail }));
    }
    generation.current += 1;
    setConfirmingAll(false);
    setDevices([]);
    known.current = new Set();
    setCode(null);
    setJustPaired(null);
    setError(null);
    setRevokedAll(true);
    onRevokedAll?.();
  };
  /** a watching device reads this page and changes nothing on it */
  const watching = auth?.role === "watch";
  /** so does a visitor Portal's own sign-in let in: the server refuses it every change here */
  const guest = auth?.via === "portal";

  const elsewhere = (
    <div className="devices-more">
      {auth?.via !== undefined && auth.via !== "open" && <p className="settings-description">{t(VIA[auth.via])}</p>}
      {auth?.portal !== undefined && <p className="settings-description devices-portal">{t("Signed in as {name} with {method}.", { name: auth.portal.user, method: methodName(auth.portal.method) })}</p>}
      {guest && <p className="settings-hint">{t("A sign-in through Portal can read this list. Pairing and revoking devices are for the access token or a paired device.")}</p>}
      <details className="settings-details">
        <summary>{t("A paired device gets in on its own until you revoke it here.")}<span className="settings-details-toggle">{t("Details")}</span></summary>
        <p className="settings-hint">{t("It gets in from anywhere it can reach this server. A code comes from this screen on the PC or on a device already paired, or from the pair command in the PC's terminal.")}</p>
      </details>
      {revokedAll && <p className="settings-hint" role="status">{t("Every paired device was revoked, and the Tailscale devices this PC has seen are kept out. The access token and this PC get in as before.")}</p>}
      {offered.length > 0 && !guest && !watching && (
        <SettingsRow label={t("Keep a Tailscale device out")} description={t("For a device of yours that gets in by your Tailscale login and has no pairing here to revoke.")}>
          <button type="button" className="btn" onClick={() => { setAlsoBlock(new Set()); setRemoving({ id: null, label: "" }); }}>{t("Choose…")}</button>
        </SettingsRow>
      )}
      {/* the account's own devices alone are no reason for Revoke all: each has its own Revoke */}
      {devices !== null && devices.some((d) => !d.through_account) && !guest && (
        <div className="devices-revoke-all">
          <SettingsRow label={t("Revoke every device")} description={t(watching
            ? "Every paired device, this one included, would lose its pairing access at once. A device that only watches cannot do it: use the PC or a device that can drive."
            : "Every paired device, this one included, loses its pairing access at once, and every Tailscale device this PC has seen is kept out until you allow it here. The access token and this PC are not affected.")}>
            {!watching && <button type="button" className="btn" onClick={() => setConfirmingAll(true)}>{t("Revoke all")}</button>}
          </SettingsRow>
        </div>
      )}
    </div>
  );
  const check = devices !== null && devices.some((d) => d.via_relay) && !watching && !guest
    ? <button type="button" className="btn" onClick={() => void checkNow()} disabled={checking}>{checking ? t("Checking…") : t("Check now")}</button>
    : null;
  return (
    <div className="devices-panel">
      {devices === null ? <p className="settings-hint" role="status">{t("Loading…")}</p> : devices.length === 0 ? (
        <p className="settings-hint">{t("No devices paired yet.")}</p>
      ) : (
        <>
        {check !== null && (checkSlot !== null ? createPortal(check, checkSlot) : <div className="devices-check">{check}</div>)}
        <ul className="devices-list">
          {[...devices].sort((a, b) => Number(b.current) - Number(a.current)).map((d) => (
            <li key={d.id} className={!d.connection && d.via_relay && !watching && !guest && !seenLately(d) ? "devices-row is-away" : "devices-row"}>
              {renaming?.id === d.id ? (
                <form className="devices-rename" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
                  <input className="input" value={renaming.label} maxLength={48} autoFocus aria-label={t("Device name")} onChange={(e) => setRenaming({ id: d.id, label: e.target.value })} />
                  <button type="submit" className="icon-button" aria-label={t("Save name")}><Check /></button>
                  <button type="button" className="icon-button" aria-label={t("Cancel")} onClick={() => setRenaming(null)}><X /></button>
                </form>
              ) : (
                <>
                  <div className="devices-name">
                    <span className="settings-label">{d.label}{kindOf?.(d.label) != null && <span className="devices-kind">{kindOf(d.label)}</span>}{d.through_account && <span className="devices-kind">{t("Through your account")}</span>}{d.current && <span className="devices-current">{t("This device now")}</span>}</span>
                    {d.connection
                      ? <ConnectionLine state={{ kind: "connected", route: d.connection.route, ...(d.connection.relay === undefined ? {} : { relay: d.connection.relay }), rttMs: d.connection.rtt_ms }} />
                      // a device with a relay key connects through an encrypted session, which the PC sees come and go; a browser's cookie does not
                      // a device that watches, or a Portal visitor, is not told how the others are connected: for them no row says offline
                      // nor one seen in the last minutes, which may be reaching this PC another way (its browser cookie)
                      : d.via_relay && !watching && !guest && !seenLately(d)
                        ? <ConnectionLine state={{ kind: "offline", text: t("Offline · last seen {when}", { when: seenWhen(d) }) }} reason={t("The app is closed, or its network is off.")} />
                        : <span className="settings-description">{t("Last seen {when}", { when: seenWhen(d) })}</span>}
                    {d.not_me_waiting && <span className="settings-description" role="status">{t("Not me is waiting. Revoke this device to stop its access now.")}</span>}
                  </div>
                  {/* this device's action rides with Rename and Revoke: on a narrow row the three drop below the name together */}
                  {((d.current && currentAction !== null) || !guest) && (
                    <div className="devices-actions">
                      {d.current && currentAction}
                      {!guest && <>
                        <button type="button" className="icon-button" aria-label={t("Rename {name}", { name: d.label })} onClick={() => setRenaming({ id: d.id, label: d.label })}><Pencil /></button>
                        <button type="button" className={confirming === d.id ? "btn btn-danger" : "icon-button"} aria-label={confirming === d.id ? undefined : t("Revoke {name}", { name: d.label })} onClick={() => void revoke(d.id)}>
                          <Trash2 aria-hidden="true" />{confirming === d.id && t("Revoke?")}
                        </button>
                      </>}
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        </>
      )}
      {justPaired !== null && <p className="settings-hint" role="status">{t("Paired: {name}.", { name: justPaired })}</p>}
      {currentAction !== null && devices !== null && !devices.some((d) => d.current) && (
        <div className="devices-row devices-self">
          <div className="devices-name"><span className="settings-label">{t("This device")}</span></div>
          {currentAction}
        </div>
      )}
      {auth?.via === "open" && <>
        <p className="settings-hint devices-open">{t(VIA.open)}</p>
        <p className="settings-hint">{t("Pairing a device turns on the app's own sign-in, on top of any proxy sign-in: other browsers then need pairing or the access token. If your proxy already signs people in, set OVIS_TOKEN and have the proxy send it instead.")}</p>
        <div className="phone-actions"><button type="button" className="btn btn-primary" onClick={() => void pairSelf()} disabled={pairingSelf}>{t("Pair this device now")}</button></div>
      </>}
      {more !== null ? createPortal(elsewhere, more) : elsewhere}
      {confirmingAll && (
        <ConfirmDialog title={t("Revoke every paired device?")}
          body={t("Every paired device loses its pairing access, this one included, and needs a new code to get back in. Every Tailscale device this PC has seen is kept out too, until you allow it on this PC. The access token and this PC still get in.")}
          confirmLabel={t("Revoke all")} onClose={() => setConfirmingAll(false)} onConfirm={revokeAll} />
      )}
      {removing !== null && (
        <ConfirmDialog title={removing.id === null ? t("Keep Tailscale devices out?") : t("Revoke {name}?", { name: removing.label })}
          body={removing.id === null ? t("The devices you choose get nothing by your Tailscale login until you allow them again on this PC.") : t("It loses its pairing access, and the Tailscale devices it came from are kept out too.")}
          confirmLabel={removing.id === null ? t("Keep out") : t("Revoke")} onClose={() => setRemoving(null)} onConfirm={confirmRemoval}>
          <TailnetChoices nodes={offered} row={removing.id} chosen={alsoBlock}
            onToggle={(id) => setAlsoBlock((chosen) => { const next = new Set(chosen); if (!next.delete(id)) next.add(id); return next; })} />
        </ConfirmDialog>
      )}
      {error !== null && <p className="settings-hint" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The Tailscale devices a removal keeps out: the ones the row's own credential came from, always, and any other device of
 * the owner's login seen lately, when ticked (a phone that only ever came in by the login has no row to remove). A device
 * this PC has never seen still gets in by the login: the tailnet's admin console is where that one is removed.
 */
function TailnetChoices({ nodes, row, chosen, onToggle }: { nodes: readonly TailnetNodeView[]; row: string | null; chosen: ReadonlySet<string>; onToggle: (id: string) => void }) {
  const t = useT();
  const own = row === null ? [] : nodes.filter((node) => node.rows.includes(row));
  const others = nodes.filter((node) => !own.includes(node));
  return (
    <div className="devices-tailnet" data-testid="devices-tailnet">
      {own.length > 0 && <p className="settings-description">{t("Kept out over Tailscale too: {names}", { names: own.map((node) => node.hostname).join(", ") })}</p>}
      {others.length > 0 && (
        <fieldset className="devices-tailnet-others">
          <legend className="settings-description">{t("Also keep out a Tailscale device of yours:")}</legend>
          {others.map((node) => (
            <label key={node.id} className="devices-tailnet-node">
              <input type="checkbox" checked={chosen.has(node.id)} onChange={() => onToggle(node.id)} />
              <span className="settings-label">{node.hostname}</span>
              <span className="settings-description">{[node.login, node.seen_at === null ? null : t("Last seen {when}", { when: lastSeen(node.seen_at) })].filter((part) => part !== null).join(" · ")}</span>
            </label>
          ))}
        </fieldset>
      )}
      <p className="settings-hint">{t("A Tailscale device this PC has not seen yet still gets in by your login. To keep it out of your tailnet too, remove it in Tailscale's admin console.")}</p>
    </div>
  );
}
