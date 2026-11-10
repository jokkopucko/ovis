import "./RelayPcDetails.css";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, X } from "lucide-react";

import { newPcs, type MyPc } from "../lib/account/myPcs.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { relayHost } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import type { ObservedVersion } from "../lib/relay/updateFlow.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { KeyId } from "./KeyId.tsx";
import { askToJoinReason, formatAbsoluteTime, formatProbeLine, localStateWord, pcDotState, routeNode, type DashboardRow } from "./relayPcState.tsx";
import { StatusDot } from "./StatusDot.tsx";

const NARROW_DETAILS_QUERY = "(max-width: 1099px)";

export interface ObservedVersionDetail extends ObservedVersion {
  readonly observedAt?: string | null;
}

export interface RelayPcDetailsProps {
  readonly pc: DashboardRow;
  readonly observedVersion?: ObservedVersionDetail | null;
  readonly updating?: boolean;
  readonly mode?: "account" | "local";
  readonly now?: number;
  readonly onClose: () => void;
  readonly onOpenPc?: (pc: MyPc) => void;
  readonly onOpenSheet?: (pc: MyPc, mode: "new" | "join") => void;
  readonly onForget?: (serverId: string) => Promise<void> | void;
  /** Check now: this PC alone, never the fleet's rotating sweep */
  readonly onCheckPc?: (serverId: string) => void;
}

function checkCauseText(check: PcStatus | null, t: ReturnType<typeof useT>): string | null {
  if (check === null || check.kind !== "offline") return null;
  return check.reason === "pc"
    ? t("The PC is off, or Ovis is not running on it.")
    : t("The relay did not answer. Check this device's network.");
}

export function RelayPcDetails({
  pc,
  observedVersion = null,
  updating = false,
  mode = "account",
  now = Date.now(),
  onClose,
  onOpenPc,
  onOpenSheet,
  onForget,
  onCheckPc,
}: RelayPcDetailsProps) {
  const t = useT();
  const fullView = useMediaQuery(NARROW_DETAILS_QUERY);
  const [confirmForget, setConfirmForget] = useState(false);
  const panel = useRef<HTMLElement>(null);

  // The confirmation is portalled to <body>, so its trap alone leaves the dashboard behind it reachable: the dashboard
  // goes inert while it is up, as RelayShell's sheets make it. Cancel's focus hand-back waits for this to lift.
  useLayoutEffect(() => {
    const behind = confirmForget ? panel.current?.closest<HTMLElement>(".relay-dash") ?? panel.current : null;
    if (!behind) return;
    behind.inert = true;
    return () => { behind.inert = false; };
  }, [confirmForget]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || confirmForget) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, confirmForget]);

  const dot = pcDotState(pc, updating);
  const fresh = newPcs([pc], now).length > 0;
  const stateLabel = ((): string => {
    if (updating) return t("Updating");
    switch (pc.displayState) {
      case "unchecked": return localStateWord(pc.check, t);
      case "needs-approval": return t("Needs approval");
      case "needs-update": return t("Needs update");
      case "offline": return t("Offline");
      case "paired":
        if (mode === "local" || !pc.listed) return localStateWord(pc.check, t);
        return pc.linked || pc.enrollment === "failed" ? t("Ready") : t("Ready · not in the account yet");
    }
  })();

  const stateReason = updating
    ? null
    : pc.state === "needs-update"
      ? t("Update Ovis on it")
      : pc.state === "needs-approval"
        ? fresh
          ? t("{name} is new in your account. Type the number it shows on its own screen to add it.", { name: pc.name })
          : askToJoinReason(pc, t) ?? t("{name} has not approved this device yet.", { name: pc.name })
        : null;

  const probeLine = formatProbeLine(pc.check, t) ?? t("Not checked");
  const probeCause = checkCauseText(pc.check, t);

  const lastSeenFull = pc.last_seen_at !== null
    ? formatAbsoluteTime(pc.last_seen_at) + " (" + lastSeen(pc.last_seen_at, now) + ")"
    : null;

  return (
    <aside
      ref={panel}
      className={fullView ? "relay-pc-details is-full-view" : "relay-pc-details"}
      data-pc-details={pc.server_id}
      aria-label={pc.name}
    >
      <header className="relay-pc-details-bar">
        {fullView && (
          <button type="button" className="btn btn-ghost relay-pc-details-back" onClick={onClose}>
            <ArrowLeft aria-hidden="true" />
            <span>{t("Back")}</span>
          </button>
        )}
        <div className="relay-pc-details-location">
          <StatusDot state={dot} />
          <h2 className="relay-pc-details-title">{pc.name}</h2>
        </div>
        {!fullView && (
          <button type="button" className="icon-button" aria-label={t("Close")} onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="relay-pc-details-body">
        <dl className="relay-pc-details-fields">
          <div className="relay-pc-details-row">
            <dt>{t("State")}</dt>
            <dd>
              <span className="relay-pc-details-value">{stateLabel}</span>
              {pc.enrollment === "failed" && <small className="relay-pc-details-sub">{t("Account setup is incomplete.")}</small>}
              {stateReason !== null && <small className="relay-pc-details-sub">{stateReason}</small>}
            </dd>
          </div>

          <div className="relay-pc-details-row">
            <dt>{t("Route")}</dt>
            <dd className="relay-pc-details-tabular" data-pc-route="">
              {pc.paired ? routeNode(pc.check, t) : "—"}
            </dd>
          </div>

          <div className="relay-pc-details-row">
            <dt>{t("Relay")}</dt>
            <dd>
              {pc.relay !== null ? <code className="relay-pc-relay-chip">{relayHost(pc.relay)}</code> : "—"}
            </dd>
          </div>

          <div className="relay-pc-details-row">
            <dt>{t("Last seen")}</dt>
            <dd className="relay-pc-details-tabular">
              {pc.last_seen_at !== null && lastSeenFull !== null ? (
                <time dateTime={pc.last_seen_at} title={formatAbsoluteTime(pc.last_seen_at)}>
                  {lastSeenFull}
                </time>
              ) : "—"}
            </dd>
          </div>

          <div className="relay-pc-details-row">
            <dt>{t("This device")}</dt>
            <dd className="relay-pc-details-tabular">
              <span className="relay-pc-details-value">{probeLine}</span>
              {probeCause !== null && <small className="relay-pc-details-sub">{probeCause}</small>}
            </dd>
          </div>

          <div className="relay-pc-details-row">
            <dt>{t("Key ID")}</dt>
            <dd className="relay-pc-details-key">
              <KeyId id={pc.server_id} label={t("Key ID")} />
            </dd>
          </div>

          <div className="relay-pc-details-row">
            <dt>{t("Version")}</dt>
            <dd className="relay-pc-details-tabular">
              {observedVersion !== null && observedVersion.version !== "" ? (
                <>
                  <span className="relay-pc-details-value">{observedVersion.version}</span>
                  <small className="relay-pc-details-sub">
                    {observedVersion.observedAt ? (
                      <time dateTime={observedVersion.observedAt} title={formatAbsoluteTime(observedVersion.observedAt)}>
                        {formatAbsoluteTime(observedVersion.observedAt)}
                      </time>
                    ) : t("Not checked")}
                  </small>
                </>
              ) : (
                <span className="relay-pc-details-dim">{t("Not checked")}</span>
              )}
            </dd>
          </div>
        </dl>

        <div className="relay-pc-details-actions">
          {pc.paired && (
            <a
              className="btn"
              href={serverScopePath(pc.server_id)}
              onClick={(event) => {
                if (onOpenPc) {
                  event.preventDefault();
                  onOpenPc(pc);
                }
              }}
            >
              {pc.state === "needs-update" ? t("Update") : t("Open")}
            </a>
          )}
          {!pc.paired && pc.join !== undefined && onOpenSheet && (
            <button
              type="button"
              className="btn"
              onClick={() => onOpenSheet(pc, fresh ? "new" : "join")}
            >
              {fresh ? t("Add") : t("Join")}
            </button>
          )}
          {pc.paired && onCheckPc && (
            <button type="button" className="btn" data-action="check-pc" onClick={() => onCheckPc(pc.server_id)}>
              {pc.check?.kind === "checking" ? t("Checking…") : t("Check now")}
            </button>
          )}
          {pc.paired && onForget && (
            <button type="button" className="btn btn-danger" onClick={() => setConfirmForget(true)}>
              {t("Forget this PC")}
            </button>
          )}
        </div>
      </div>

      {confirmForget && onForget && (
        <ConfirmDialog
          title={t("Forget this PC?")}
          body={t("This phone's key for it is deleted here, and the PC keeps listing this phone until it is revoked there. Pairing again takes a new QR code from the PC.")}
          confirmLabel={t("Forget")}
          onClose={() => setConfirmForget(false)}
          onConfirm={async () => {
            await onForget(pc.server_id);
            setConfirmForget(false);
            onClose();
          }}
        />
      )}
    </aside>
  );
}
