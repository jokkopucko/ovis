import type { Translate } from "../lib/i18n.ts";
import type { RelayFailure } from "../lib/relay/shellState.ts";

export function relayFailureDetail(detail: string | null | undefined): string | null {
  if (detail == null || detail === "" || /^The relay closed the connection \(\d+\)$/.test(detail)) return null;
  return detail;
}

export type RelayFailureFlow = "new" | "join";

/**
 * The sheet names its flow, since a refusal there has another cause and another fix than a pairing link's:
 * "new" adds a PC by the digits typed from its screen and approved on it, "join" asks a device of the
 * account that is connected to the PC, or the PC itself while its own Add screen waits (it decides the
 * request there, and no account device hears it).
 */
export function relayFailureText(t: Translate, failure: RelayFailure, name: string, detail?: string | null, flow?: RelayFailureFlow): { title: string; copy: string; detail: string | null; retry: boolean } {
  const filtered = relayFailureDetail(detail);
  if (flow === "new") {
    if (failure === "pair-unavailable") return { title: t("{name} is no longer waiting to be added", { name }), copy: t("On {name}, open Settings → Devices and PCs → Add a connection → Ovis relay and keep that screen open (choose Keep waiting or Add this PC to my account if it shows one), then try again here. If it still refuses, wait a few minutes: it pauses after too many tries.", { name }), detail: filtered, retry: true };
    if (failure === "pair-declined") return { title: t("{name} did not approve this device", { name }), copy: t("It was declined on {name}, or not approved within 90 seconds. Try again and press Approve on {name}. If {name} showed no number, ask to join instead.", { name }), detail: filtered, retry: true };
  } else if (flow === "join") {
    if (failure === "pair-unavailable") return { title: t("{name} cannot take this device yet", { name }), copy: t("{name} did not take this request. It may not know this device yet (it learns your account's devices within a few minutes), or it is paused after too many tries. Wait a moment, then try again. If no device of your account uses {name} yet, pair this device with a QR or code from {name} instead.", { name }), detail: filtered, retry: true };
    if (failure === "pair-declined") return { title: t("Nobody approved this device for {name}", { name }), copy: t("Nobody approved it within 90 seconds, or it was denied. Try again, and approve it on a device of your account that is connected to {name} (keep {name} open in Ovis there), or on {name} itself if it shows this request. If it keeps failing, pair this device with a QR or code from {name}.", { name }), detail: filtered, retry: true };
  }
  switch (failure) {
    case "pair-unanswered": return { title: t("No answer from {name}", { name }), copy: t("Ask again, then press [Allow] on {name}.", { name }), detail: filtered, retry: true };
    case "pair-declined": return { title: t("{name} did not approve this device", { name }), copy: t("It was declined on the PC, or not approved within 90 seconds. Open the link again to compare new numbers."), detail: filtered, retry: false };
    case "pair-unavailable": return { title: t("{name} is not taking new devices right now", { name }), copy: t("Its link may have run out (it works for 10 minutes), or it may be paused after too many tries or busy with other devices. Copy a new link on the PC, or wait a few minutes."), detail: filtered, retry: false };
    case "new-devices-refused": return { title: t("{name} cannot add new devices right now", { name }), copy: t("Its Ovis account is past its relay limit, so the relay lets no new device in. Devices already added still connect. Check the account in Settings on the PC, or try again later."), detail: filtered, retry: true };
    case "not-added-yet": return { title: t("{name} has not added this device yet", { name }), copy: t("It adds the devices of your account a few minutes after they join. Try again in a moment."), detail: filtered, retry: true };
    case "pc-offline": return { title: t("Machine offline"), copy: t("{name}'s Ovis relay or power is off, it has no network, or Ovis is not running on it. Turn it on, or wait for it to come back, then try again.", { name }), detail: filtered, retry: true };
    case "pc-unresponsive": return { title: t("Could not reach this machine"), copy: t("{name} answered but did not finish connecting in time. It may be busy or restarting. Try again; if it keeps happening, restart Ovis on {name}.", { name }), detail: filtered, retry: true };
    case "relay-unreachable": return { title: t("Could not reach this machine"), copy: t("This device could not reach the relay. Check this device's network, then try again."), detail: filtered, retry: true };
    case "relay-refused": return { title: t("Could not reach this machine"), copy: t("The relay turned this device away. Wait a minute, then try again."), detail: filtered, retry: true };
    case "needs-update": return { title: t("Update needed"), copy: t("{name} and this app speak different versions of the relay protocol. Update Ovis on the PC, then try again.", { name }), detail: filtered, retry: true };
    case "revoked": return { title: t("This device was removed from {name}", { name }), copy: t("Its pairing was revoked on the PC, so this device's key for it is gone. To pair again, scan a new QR code on the PC."), detail: filtered, retry: false };
    case "identity-changed": return { title: t("{name} has a new identity", { name }), copy: t("The PC's relay key is not the one this device paired with, so the saved pairing cannot be trusted. Forget it, then pair again from a new QR code on the PC."), detail: filtered, retry: false };
    case "code-expired": return { title: t("That pairing code no longer works"), copy: t("The code was wrong, used up or expired. Scan a new QR code on the PC."), detail: filtered, retry: false };
    case "bad-offer": return { title: t("This pairing link is damaged"), copy: t("Part of the link is missing or changed. Scan the QR code on the PC again, or copy its link whole."), detail: filtered, retry: false };
    // a marked code's pairing stopped before it reached the PC: the code was not used, and the same link tries again
    case "sign-in-first": return { title: t("Sign in to add this device to {name}", { name }), copy: t("Sign in on this device, then scan the QR code again."), detail: filtered, retry: false };
    case "account-unlisted": return { title: t("Your account does not list {name}", { name }), copy: t("Nothing was paired: sign in to the same account on {name}, then try again.", { name }), detail: filtered, retry: true };
    case "account-busy": return { title: t("Too many adds just now"), copy: t("Nothing was paired: wait a few minutes, then try again."), detail: filtered, retry: true };
    case "admission-unanswered": return { title: t("Your Ovis account did not answer"), copy: t("Nothing was paired: check this device's connection, then try again."), detail: filtered, retry: true };
    case "admission-failed": return { title: t("Your account could not check this device"), copy: t("Nothing was paired: sign out and back in on this device, then try again."), detail: filtered, retry: true };
    // paired, but the new key was not taken: no link was sent, so only a new scan pairs again
    case "new-key-unvouched": return { title: t("Your account did not take this device's new key"), copy: t("Show a new QR code on {name} and scan it.", { name }), detail: filtered, retry: false };
    // the PC refused the first link: only a new scan pairs again
    case "link-required": return { title: t("{name} no longer takes this QR code", { name }), copy: t("Show a new QR code on {name} and scan it.", { name }), detail: filtered, retry: false };
    case "account-mismatch": return { title: t("{name} is not set up for your account", { name }), copy: t("On {name}, sign in to your account and show a new QR code, then scan it.", { name }), detail: filtered, retry: false };
    case "unverified-device": return { title: t("{name} could not check this device with your account", { name }), copy: t("Wait a few minutes, then show a new QR code on {name} and scan it.", { name }), detail: filtered, retry: false };
    case "list-removed": return { title: t("{name} was removed from your account", { name }), copy: t("It can come back only as a new PC. On {name}, open Settings → Devices and PCs and press Reset relay identity, then add it to your account again.", { name }), detail: filtered, retry: false };
    case "list-time-over": return { title: t("This device's time in your account is over"), copy: t("It was added for a limited time. To go on, add it again from a device of your account."), detail: filtered, retry: false };
    case "account-unreachable": return { title: t("{name} could not reach your Ovis account", { name }), copy: t("{name} lets your account's devices in only after the account service confirms it is still in your account, and the service did not answer. Try again in a moment. A device paired with {name} itself still connects.", { name }), detail: filtered, retry: true };
    case "account-readd": return { title: t("Add {name} to your account again", { name }), copy: t("{name} is no longer in your Ovis account. On {name}, open Settings → Devices and PCs → Add a connection → Ovis relay and add it to your account again, then try again here.", { name }), detail: filtered, retry: true };
    // a join into the account's list through a PC that lets devices in by it: no entry let this device in
    case "list-not-claimed": return { title: t("Sign in again on this device"), copy: t("{name} lets a device in only after it signed in to your account in the last ten minutes. Sign out and in again on this device, then ask to join again.", { name }), detail: filtered, retry: false };
    case "list-not-placed": return { title: t("{name} could not add this device in time", { name }), copy: t("Your account did not take it in time. Ask to join again."), detail: filtered, retry: true };
    // what the PC saw, and no more: the entry may be placed and have reached it too late
    case "list-not-in": return { title: t("{name} did not let this device in", { name }), copy: t("It was approved, and {name} did not see it in your account's list in time. Ask to join again, and approve it on a device of your account or on {name} itself.", { name }), detail: filtered, retry: true };
    case "list-pc-behind": return { title: t("Update Ovis on {name}", { name }), copy: t("{name} runs an older Ovis than your account's other devices, so it cannot add a device by itself. Update Ovis on {name}, or approve this device on another device of your account.", { name }), detail: filtered, retry: true };
    case "list-refused": return { title: t("This device was not added to your account"), copy: t("{name} could not add it. Ask to join again.", { name }), detail: filtered, retry: true };
    case "list-other": return { title: t("{name} belongs to another account's list", { name }), copy: t("{name} follows a list that is not your account's. Sign in to the same account on {name} and on this device, then try again.", { name }), detail: filtered, retry: false };
    case "scan-expired": return { title: t("The QR code ran out while you signed in"), copy: t("Show a new QR code on {name} and scan it.", { name }), detail: filtered, retry: false };
  }
}
