import type { ReactNode } from "react";
import { currentLocale, type Translate } from "../lib/i18n.ts";
import { relayHost, type dashboardModel } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { StatusDotState } from "./StatusDot.tsx";

export type DashboardRow = ReturnType<typeof dashboardModel>["rows"][number];
type MapNode = ReturnType<typeof dashboardModel>["map"]["hubs"][number]["nodes"][number];

/** The model's state, with the answering route when known. Needs you stays the group's name. */
export function mapStateWord(node: MapNode, t: Translate): string {
  if (node.check?.kind === "checking") return t("Checking…");
  switch (node.state) {
    case "unchecked": return localStateWord(node.check, t);
    case "needs-approval": return t("Needs approval");
    case "needs-update": return t("Needs update");
    case "offline": return t("Offline");
    case "paired":
      if (node.check?.kind === "answered") return routeText(node.check, t);
      return node.seen === "lately" ? t("Seen lately") : t("Ready");
  }
}

/** The tooltip's detail: the state word with what to do and the measured answering route. */
export function mapStateDetail(node: MapNode, t: Translate): string {
  const route = node.check?.kind === "answered" ? ` · ${routeText(node.check, t)}` : "";
  switch (node.state) {
    case "needs-approval": return t("Needs approval") + route;
    case "needs-update": return `${t("Needs update")} · ${t("Update Ovis on it")}${route}`;
    case "offline": case "paired": case "unchecked": return mapStateWord(node, t);
  }
}

/** The glyph uses the model's state, with transient work shown while it runs. */
export function pcDotState(row: DashboardRow, updating = false): StatusDotState {
  if (updating) return "updating";
  if (row.check?.kind === "checking") return "checking";
  switch (row.displayState) {
    case "needs-approval": case "needs-update": return "needs-you";
    case "offline": case "unchecked": return "offline";
    case "paired": return "ready";
  }
}

/** The state word of a paired PC the account does not list: what this device's own check found, since no directory speaks for it; the Relay cell carries the way and the round trip. */
export function localStateWord(check: PcStatus | null, t: Translate): string {
  if (check === null) return t("Paired · not checked");
  if (check.kind === "checking") return t("Checking…");
  return check.kind === "answered" ? t("Answers") : t("No answer");
}

/**
 * What a listed PC past its 10-minute Add window asks of this device, in the same words wherever it is drawn,
 * or null when it has no such line: a PC the account never listed, or one whose directory row gives no route
 * to join by, so no Join button stands beside it. It names the button it sits next to.
 */
export function askToJoinReason(pc: { readonly added_at: string | null; readonly join?: unknown }, t: Translate): string | null {
  if (pc.added_at === null || pc.join === undefined) return null;
  return t("Join · a device of your account connected to it approves");
}

export function formatAbsoluteTime(iso: string): string {
  try { return new Date(iso).toLocaleString(currentLocale()); } catch { return iso; }
}

export function formatProbeLine(check: PcStatus | null, t: Translate): string | null {
  if (check === null) return null;
  if (check.kind === "checking") return t("Checking…");
  if (check.kind === "answered") return t("This device: answered · {n} ms", { n: check.rttMs });
  return t("This device: no answer");
}

/** One short label for how this device reaches a PC right now, as GOAT lists each environment's routes: the way (the same network, Tailscale, or the host of the relay that answered) with its round trip, or why there is none. */
export function routeText(check: PcStatus | null, t: Translate): string {
  if (check === null) return t("Not checked");
  if (check.kind === "checking") return t("Checking…");
  if (check.kind === "offline") return t("No answer");
  const way = check.route === "lan" ? t("Same network") : check.route === "tailscale" ? "Tailscale" : check.relay === undefined ? t("Relay") : relayHost(check.relay);
  return `${way} · ${t("{n} ms", { n: check.rttMs })}`;
}

/** routeText as a one-line cell: the answering relay's host as its chip, the round trip in tabular figures, the state colour left to the dot. */
export function routeNode(check: PcStatus | null, t: Translate): ReactNode {
  const text = routeText(check, t);
  const relayed = check?.kind === "answered" && check.route === "relay" && check.relay !== undefined ? { host: relayHost(check.relay), ms: check.rttMs } : null;
  return <span className="relay-pc-route" data-route={check === null ? "unchecked" : check.kind === "answered" ? check.route : check.kind} title={text}>
    {relayed === null ? <span>{text}</span> : <><code className="relay-pc-relay-chip">{relayed.host}</code><span>{` · ${t("{n} ms", { n: relayed.ms })}`}</span></>}
  </span>;
}
