import "./RelayShell.css";

import { ChevronRight } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import type { KeyMismatch } from "../lib/relay/shellState.ts";
import { KeyId } from "./KeyId.tsx";
import { describeUpdate } from "../lib/updateProgress.ts";
import type { RelayShellState } from "../lib/relay/shellState.ts";
import { serverScopePath } from "../lib/shellMode.ts";

export interface RelayShellProps {
  state: RelayShellState;
  /** on a PC's own page (`/s/<id>/`), where Back leads to the front page; the front page has no Back */
  scoped: boolean;
  /** an iPhone or iPad browser tab, where the pairing may not survive a week unvisited */
  iosTab: boolean;
  onPair: () => void;
  onRetry: () => void;
  onCancel: () => void;
  onBack: () => void;
  onForget: () => void;
  /** a PC below the shell's minimum version with a managed install: install its latest release */
  onUpdate: () => void;
}

/**
 * The id named and the id of the key that is not it, groups that differ marked, each labelled by
 * where it came from. Neither is called the PC's: a link names any id it likes, and only the PC's
 * own screen (Phone & devices) says which id is the PC's.
 */
function KeyIds({ mismatch, named }: { mismatch: KeyMismatch; named: "link" | "paired" }) {
  const t = useT();
  const expected = named === "link" ? t("ID this link names") : t("ID this phone paired with");
  const received = mismatch.from === "link" ? t("ID of the key this link carries") : t("ID of the key this phone saved");
  return (
    <>
    <dl className="relay-shell-keys">
      <dt>{expected}</dt>
      <dd><KeyId id={mismatch.expected} label={expected} /></dd>
      <dt>{received}</dt>
      <dd>
        {mismatch.received === null
          ? <span className="relay-shell-copy">{t("Not a valid key")}</span>
          : <KeyId id={mismatch.received} against={mismatch.expected} label={received} />}
      </dd>
    </dl>
    <p className="relay-shell-detail">{t("Only the PC itself shows its ID, under Settings → Phone & devices. Marked groups differ.")}</p>
    </>
  );
}

/** How a PC whose Ovis does not update itself is brought up to date: the installer, or herdr's plugin. */
export const INSTALLER_COMMAND = "curl -fsSL https://ovis.sh/install.sh | sh";
export const PLUGIN_COMMANDS = "herdr plugin install devswha/ovis\nherdr plugin action invoke devswha.ovis.stop\nherdr plugin action invoke devswha.ovis.start";

/**
 * The hosted shell's screens before the app: the saved PCs to pick from, the question before a
 * new PC is paired, the wait for the connection, and why one did not come up, each named in
 * `data-relay-state` for scripts. One card in the token gate's frame (AccessGate.css), so a phone
 * that pairs through the relay and one that pairs with a code see the same room.
 */
export function RelayShell({ state, scoped, iosTab, onPair, onRetry, onCancel, onBack, onForget, onUpdate }: RelayShellProps) {
  const t = useT();
  const name = state.kind === "confirm" ? state.offer.name ?? null : state.kind === "list" || state.kind === "empty" ? null : state.name;
  const pc = name ?? t("this PC");
  // a forged link is the identity-changed warning in its own words: there is no key of its to forget
  const stateName = state.kind === "failed" ? state.failure : state.kind === "outdated" ? "pc-outdated" : state.kind === "forged" ? "identity-changed" : state.kind;
  const back = scoped ? <button type="button" className="btn" onClick={onBack}>{t("Back")}</button> : null;
  const progress = state.kind === "outdated" && state.update.phase === "installing" ? describeUpdate({ phase: "building", step: state.update.step }) : null;
  const retry = <button type="button" className="btn btn-primary" onClick={onRetry}>{t("Try again")}</button>;
  return (
    <main className="relay-shell-screen" data-relay-state={stateName}>
      <div className="relay-shell">
        <img src="/icons/icon-192.png?v=sheep1" alt="" width="44" height="44" className="relay-shell-mark" />
        {state.kind === "list" && (
          <>
            <h1 className="relay-shell-title">{t("Your PCs")}</h1>
            <ul className="relay-shell-pcs">
              {state.devices.map((device) => (
                <li key={device.server_id}>
                  <a className="relay-shell-pc" href={serverScopePath(device.server_id)}>
                    <span className="relay-shell-pc-name">{device.name ?? t("Unnamed PC")}</span>
                    <ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
            <p className="relay-shell-copy">{t("To add another PC, scan the QR code it shows under Phone & devices.")}</p>
          </>
        )}
        {state.kind === "empty" && (
          <>
            <h1 className="relay-shell-title">{t("Scan the QR code on your PC")}</h1>
            <p className="relay-shell-copy">{t("On the PC, open Settings → Phone & devices and turn on remote access through the Ovis relay. The QR code there opens this app paired with that PC.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "confirm" && (
          <>
            <h1 className="relay-shell-title">{t("Pair with {name}?", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("This phone gets a key of its own for {name}. The PC lists it under Phone & devices, where it can be removed.", { name: pc })}</p>
            <div className="relay-shell-actions">
              <button type="button" className="btn btn-primary" onClick={onPair}>{t("Pair")}</button>
              <button type="button" className="btn" onClick={onCancel}>{t("Not now")}</button>
            </div>
          </>
        )}
        {state.kind === "connecting" && (
          <>
            <h1 className="relay-shell-title">{t("Connecting to {name}…", { name: pc })}</h1>
            <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Connecting to {name}…", { name: pc })}</span></div>
            <div className="relay-shell-actions"><button type="button" className="btn" onClick={onCancel}>{t("Cancel")}</button></div>
          </>
        )}
        {state.kind === "failed" && state.failure === "pc-offline" && (
          <>
            <h1 className="relay-shell-title">{t("{name} is offline", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("Its Ovis is not connected to the relay right now. Start Ovis on the PC, or check its connection, then try again.")}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "failed" && state.failure === "pc-unresponsive" && (
          <>
            <h1 className="relay-shell-title">{t("{name} did not finish connecting", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The PC answered through the relay but did not complete the connection. Try again; if it keeps happening, restart Ovis on the PC.")}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "failed" && state.failure === "relay-unreachable" && (
          <>
            <h1 className="relay-shell-title">{t("The relay could not be reached")}</h1>
            <p className="relay-shell-copy">{t("Check this phone's connection, then try again.")}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "failed" && state.failure === "needs-update" && (
          <>
            <h1 className="relay-shell-title">{t("Update needed")}</h1>
            <p className="relay-shell-copy">{t("{name} and this app speak different versions of the relay protocol. Update Ovis on the PC, then try again.", { name: pc })}</p>
            <div className="relay-shell-actions">{retry}{back}</div>
          </>
        )}
        {state.kind === "outdated" && (
          <>
            <h1 className="relay-shell-title">{t("Update Ovis on {name}", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("{name} runs Ovis {version}; this app needs {min} or newer.", { name: pc, version: state.serverVersion, min: state.minVersion })}</p>
            {state.update.phase === "reading" && <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /></div>}
            {state.update.phase === "offer" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("Update it from here: the PC installs the latest release and restarts Ovis, then this app reconnects.")}</p>
                <div className="relay-shell-actions">
                  <button type="button" className="btn btn-primary" onClick={onUpdate}>{t("Update now")}</button>
                  {back}
                </div>
              </>
            )}
            {state.update.phase === "manual" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("Its Ovis does not update itself. On the PC, run the installer:")}</p>
                <pre className="relay-shell-command"><code>{INSTALLER_COMMAND}</code></pre>
                <p className="relay-shell-copy relay-shell-more">{t("Or, for the herdr plugin, reinstall it and restart Ovis:")}</p>
                <pre className="relay-shell-command"><code>{PLUGIN_COMMANDS}</code></pre>
                <div className="relay-shell-actions">{retry}{back}</div>
              </>
            )}
            {state.update.phase === "installing" && (
              <div className="relay-shell-wait" role="status">
                <div className="boot-spinner" aria-hidden="true" />
                <p className="relay-shell-detail">{progress ? `${progress.step}: ${t(progress.label)}` : t("Asking the PC to update…")}</p>
              </div>
            )}
            {state.update.phase === "restarting" && (
              <div className="relay-shell-wait" role="status">
                <div className="boot-spinner" aria-hidden="true" />
                <p className="relay-shell-detail">{t("Waiting for {name} to restart…", { name: pc })}</p>
              </div>
            )}
            {state.update.phase === "failed" && (
              <>
                <p className="relay-shell-copy relay-shell-more">{t("The update did not finish.")}</p>
                {state.update.detail !== null && <p className="relay-shell-detail"><code>{state.update.detail}</code></p>}
                <div className="relay-shell-actions">
                  <button type="button" className="btn btn-primary" onClick={onUpdate}>{t("Update now")}</button>
                  {back}
                </div>
              </>
            )}
          </>
        )}
        {state.kind === "failed" && state.failure === "revoked" && (
          <>
            <h1 className="relay-shell-title">{t("This phone was removed from {name}", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("Its pairing was revoked on the PC, so this phone's key for it is gone. To pair again, scan a new QR code on the PC.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.failure === "identity-changed" && (
          <>
            <h1 className="relay-shell-title">{t("{name} has a new identity", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The PC's relay key is not the one this phone paired with, so the saved pairing cannot be trusted. Forget it, then pair again from a new QR code on the PC.")}</p>
            {state.mismatch && <KeyIds mismatch={state.mismatch} named="paired" />}
            <div className="relay-shell-actions">
              <button type="button" className="btn btn-danger" onClick={onForget}>{t("Forget this PC")}</button>
              {back}
            </div>
          </>
        )}
        {state.kind === "forged" && (
          <>
            <h1 className="relay-shell-title">{t("This link is not {name}'s", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("It carries a key that is not this PC's, so this phone will not pair with it. To pair, scan a new QR code on the PC itself.")}</p>
            {state.mismatch && <KeyIds mismatch={state.mismatch} named="link" />}
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "forgotten" && (
          <>
            <h1 className="relay-shell-title">{t("This phone forgot {name}", { name: pc })}</h1>
            <p className="relay-shell-copy">{t("The link you opened carried a different key, so it is not used to pair again. To pair, scan a new QR code on the PC itself.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.failure === "code-expired" && (
          <>
            <h1 className="relay-shell-title">{t("That pairing code no longer works")}</h1>
            <p className="relay-shell-copy">{t("The code was wrong, used up or expired. Scan a new QR code on the PC.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.failure === "bad-offer" && (
          <>
            <h1 className="relay-shell-title">{t("This pairing link is damaged")}</h1>
            <p className="relay-shell-copy">{t("Part of the link is missing or changed. Scan the QR code on the PC again, or copy its link whole.")}</p>
            {back && <div className="relay-shell-actions">{back}</div>}
          </>
        )}
        {state.kind === "failed" && state.detail !== null && <p className="relay-shell-detail"><code>{state.detail}</code></p>}
        {iosTab && scoped && <p className="relay-shell-hint">{t("Add to Home Screen to stay paired: Safari may clear this page's storage after a week without a visit.")}</p>}
      </div>
    </main>
  );
}
