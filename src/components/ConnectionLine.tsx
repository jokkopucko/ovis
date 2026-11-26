import "./ConnectionLine.css";

import type { DeviceRoute } from "../../shared/access.ts";
import { SEOUL_RELAY } from "../../shared/relay-regions.ts";
import { useT } from "../lib/i18n.ts";
import { StatusDot, type StatusDotState } from "./StatusDot.tsx";

export const SLOW_MS = 100;

export type LineState =
  | { readonly kind: "connected"; readonly route: DeviceRoute; readonly relay?: string; readonly rttMs: number | null }
  /** a check reached the PC but did not sign in (the phone's list): the PC answers, which is not this device being let in */
  | { readonly kind: "answered"; readonly route: DeviceRoute; readonly relay?: string; readonly rttMs: number | null }
  | { readonly kind: "checking" }
  | { readonly kind: "offline"; readonly text: string };

const GLYPH: Record<LineState["kind"], StatusDotState> = { connected: "ready", answered: "ready", checking: "checking", offline: "offline" };

/**
 * One row's connection: state first, then the way and the round trip, as Tailscale's status reads
 * ("active; direct"). The way is about speed only: every way carries the same end-to-end channel.
 */
export function ConnectionLine({ state, reason = null }: { state: LineState; reason?: string | null }) {
  const t = useT();
  const route = (route: DeviceRoute, relay: string | undefined): string => route === "lan" ? t("Same Wi-Fi, direct")
    : route === "tailscale" ? t("Tailscale, direct") : relay === SEOUL_RELAY ? t("Seoul relay") : t("Through the relay");
  return (
    <span className="connection-line" data-connection={state.kind}>
      <span className="connection-status">
        <StatusDot state={GLYPH[state.kind]} size="inline" />
        {/* one run of text beside the dot, so a narrow row wraps it between words, never inside one */}
        <span className="connection-text">
          {state.kind === "connected" || state.kind === "answered" ? <>
            {state.kind === "connected" ? t("Connected") : t("Answers")} · {route(state.route, state.relay)}
            {state.rttMs !== null && <> · <span className={state.rttMs > SLOW_MS ? "connection-slow" : undefined}>{t("{n} ms", { n: state.rttMs })}</span></>}
          </> : state.kind === "checking" ? t("Connecting…") : state.text}
        </span>
      </span>
      {reason !== null && state.kind === "offline" && <span className="connection-reason">{reason}</span>}
    </span>
  );
}
