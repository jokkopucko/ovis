import type { ReactNode } from "react";
import { currentLocale, type Translate } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { relayHost, type DashboardState, type dashboardModel } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { StatusDotState } from "./StatusDot.tsx";

export type DashboardRow = ReturnType<typeof dashboardModel>["rows"][number];
type MapNode = ReturnType<typeof dashboardModel>["map"]["hubs"][number]["nodes"][number];

export type OutOfReach = Extract<DashboardState, "offline" | "unreachable">;

export function outOfReachWord(state: OutOfReach, t: Translate): string {
  switch (state) {
    case "offline": return t("Machine offline");
    case "unreachable": return t("Could not reach this machine");
  }
}

export function outOfReachReason(pc: { readonly displayState: DashboardState; readonly last_seen_at: string | null; readonly check?: PcStatus | null }, t: Translate, now?: number): string | null {
  switch (pc.displayState) {
    case "offline": {
      const cause = t("It is off, has no network, or Ovis is not running on it.");
      return pc.last_seen_at === null ? cause : `${t("Last seen {when}.", { when: lastSeen(pc.last_seen_at, now) })} ${cause}`;
    }
    case "unreachable": {
      const found = pc.check?.kind === "checking" ? pc.check.previous : pc.check;
      return found?.kind === "offline" && found.reason === "refused" ? t("The relay turned this device away. Wait a minute, then check again.")
        : t("This device could not reach the relay. Check this device's network.");
    }
    case "paired": case "unchecked": case "needs-approval": case "needs-update": return null;
  }
}

export function mapStateWord(node: MapNode, t: Translate): string {
  if (node.check?.kind === "checking") return t("Checking…");
  switch (node.state) {
    case "unchecked": return localStateWord(node.check, t);
    case "needs-approval": return t("Needs approval");
    case "needs-update": return t("Needs update");
    case "offline": case "unreachable": return outOfReachWord(node.state, t);
    case "paired":
      if (node.check?.kind === "answered") return routeText(node.check, t);
      return node.seen === "lately" ? t("Seen lately") : t("Ready");
  }
}

export function mapStateDetail(node: MapNode, t: Translate): string {
  const route = node.check?.kind === "answered" ? ` · ${routeText(node.check, t)}` : "";
  switch (node.state) {
    case "needs-approval": return t("Needs approval") + route;
    case "needs-update": return `${t("Needs update")} · ${t("Update Ovis on it")}${route}`;
    case "offline": case "unreachable": case "paired": case "unchecked": return mapStateWord(node, t);
  }
}

export function pcDotState(row: DashboardRow, updating = false): StatusDotState {
  if (updating) return "updating";
  if (row.check?.kind === "checking") return "checking";
  switch (row.displayState) {
    case "needs-approval": case "needs-update": return "needs-you";
    case "offline": case "unchecked": return "offline";
    case "unreachable": return "failed";
    case "paired": return "ready";
  }
}

export function localStateWord(check: PcStatus | null, t: Translate): string {
  if (check === null) return t("Paired · not checked");
  if (check.kind === "checking") return t("Checking…");
  return check.kind === "answered" ? t("Answers") : t("No answer");
}

/**
 * It names the button it sits next to and the only two ways in: a connected device of the account approves, or
 * someone types the number the PC's own screen shows. The directory cannot say whether such a device exists now
 * (Revoke all keeps the row seen), so neither is claimed.
 */
export function askToJoinReason(pc: { readonly added_at: string | null; readonly join?: unknown }, t: Translate): string | null {
  if (pc.added_at === null || pc.join === undefined) return null;
  return t("Join · approve on a connected device of your account, or type the number the PC shows");
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

export function routeText(check: PcStatus | null, t: Translate): string {
  if (check === null) return t("Not checked");
  if (check.kind === "checking") return t("Checking…");
  if (check.kind === "offline") return t("No answer");
  const way = check.route === "lan" ? t("Same network") : check.route === "tailscale" ? "Tailscale" : check.relay === undefined ? t("Relay") : relayHost(check.relay);
  return `${way} · ${t("{n} ms", { n: check.rttMs })}`;
}

export function routeNode(check: PcStatus | null, t: Translate): ReactNode {
  const text = routeText(check, t);
  const relayed = check?.kind === "answered" && check.route === "relay" && check.relay !== undefined ? { host: relayHost(check.relay), ms: check.rttMs } : null;
  return <span className="relay-pc-route" data-route={check === null ? "unchecked" : check.kind === "answered" ? check.route : check.kind} title={text}>
    {relayed === null ? <span>{text}</span> : <><code className="relay-pc-relay-chip">{relayed.host}</code><span>{` · ${t("{n} ms", { n: relayed.ms })}`}</span></>}
  </span>;
}
