import "./RelayPcTable.css";
import type { MouseEvent, ReactNode } from "react";
import { newPcs, type MyPc } from "../lib/account/myPcs.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import { inDashboardFilter, relayHost, type DashboardFilter, type dashboardModel } from "../lib/relay/dashboard.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { CheckPcsButton } from "./AccountPcs.tsx";
import { askToJoinReason, formatAbsoluteTime, formatProbeLine, localStateWord, pcDotState, routeNode, type DashboardRow } from "./relayPcState.tsx";
import { StatusDot } from "./StatusDot.tsx";

export type DashboardAttention = ReturnType<typeof dashboardModel>["attention"][number];

const PHONE_QUERY = "(max-width: 768px)";
const LARGE_FLEET_FROM = 200;

export interface RelayPcTableProps {
  readonly rows: readonly DashboardRow[];
  readonly attention?: readonly DashboardAttention[];
  readonly filters?: Readonly<Record<DashboardFilter, readonly string[]>>;
  readonly filter?: DashboardFilter;
  readonly onFilter?: (filter: DashboardFilter) => void;
  readonly relayFilter?: string | null;
  readonly onClearRelayFilter?: () => void;
  readonly selectedPcId?: string | null;
  readonly onSelect: (serverId: string) => void;
  readonly onOpenSheet: (pc: MyPc, mode: "new" | "join") => void;
  readonly onOpenPc?: (pc: MyPc) => void;
  readonly pcStatus?: ReadonlyMap<string, PcStatus>;
  readonly onCheckPcs?: () => void;
  readonly checkedByUser?: boolean;
  readonly updatingIds?: ReadonlySet<string>;
  readonly mode?: "account" | "local";
  readonly narrow?: boolean;
  readonly showToolbar?: boolean;
  /** false drops the Last seen column, so the rows keep one line beside an open Details pane (it stays in Details) */
  readonly showLastSeen?: boolean;
  readonly now?: number;
}

function matchesFilter(row: DashboardRow, filter: DashboardFilter, filters?: Readonly<Record<DashboardFilter, readonly string[]>>): boolean {
  if (filters) return filters[filter].includes(row.server_id);
  return inDashboardFilter(row.displayState, filter);
}

export function RelayPcTable({
  rows, attention = [], filters, filter = "all", onFilter, relayFilter = null, onClearRelayFilter,
  selectedPcId = null, onSelect, onOpenSheet, onOpenPc, pcStatus, onCheckPcs, checkedByUser = false,
  updatingIds, mode = "account", narrow = false, showToolbar = true, showLastSeen = true, now = Date.now(),
}: RelayPcTableProps) {
  const t = useT();
  const compactList = useMediaQuery(PHONE_QUERY) || narrow;
  const freshIds = new Set([...attention.filter((item) => item.expiresAt !== null && item.expiresAt > now).map((item) => item.server_id), ...newPcs(rows, now).map((pc) => pc.server_id)]);
  const filtered = rows.filter((row) => matchesFilter(row, filter, filters) && (relayFilter === null || relayHost(row.origin) === relayHost(relayFilter)));
  const statusMap = pcStatus ?? new Map(rows.flatMap((r) => (r.check ? [[r.server_id, r.check] as const] : [])));
  const announcement = useAnnouncedText(filtered.length === 0 ? t("No PC matches this filter.") : filtered.length === 1 ? t("1 PC shown") : t("{count} PCs shown", { count: filtered.length }));

  const listedRow = (row: DashboardRow): boolean => mode === "account" && row.listed;
  const stateHeadline = (row: DashboardRow, updating: boolean): string => {
    if (updating) return t("Updating");
    switch (row.displayState) {
      case "unchecked": return localStateWord(row.check, t);
      case "needs-approval": return t("Needs approval");
      case "needs-update": return t("Needs update");
      case "offline": return row.last_seen_at === null ? t("Offline") : t("Offline · {when}", { when: lastSeen(row.last_seen_at, now) });
      case "paired":
        if (!listedRow(row)) return localStateWord(row.check ?? statusMap.get(row.server_id) ?? null, t);
        return row.linked || row.enrollment === "failed" ? t("Ready") : t("Ready · not in the account yet");
    }
  };
  const stateSubline = (row: DashboardRow, updating: boolean, phone = false): string | null => {
    const check = row.check ?? statusMap.get(row.server_id) ?? null;
    if (listedRow(row) && checkedByUser && row.paired) return formatProbeLine(check, t) ?? t("Not checked");
    if (updating) return null;
    if (row.state === "needs-update") return t("Update Ovis on it");
    if (listedRow(row) && row.state === "needs-approval") {
      if (freshIds.has(row.server_id) && row.added_at !== null) return t("new · {n} min left", { n: Math.max(1, Math.ceil((Date.parse(row.added_at) + 10 * 60_000 - now) / 60_000)) });
      if (phone) return askToJoinReason(row, t);
    }
    return null;
  };
  /** Account enrollment in progress or failed: its own line under the state, so the PC's state and next action stay. */
  const enrollmentLine = (row: DashboardRow): string | null => {
    if (mode !== "account") return null;
    if (row.enrollment === "pending") return t("Adding it to your account…");
    // Open retries account setup; listing may already have succeeded before a later step failed.
    if (row.enrollment === "failed") return row.displayState === "paired" || row.displayState === "unchecked"
      ? t("Account setup is incomplete. Open it to try again.") : t("Account setup is incomplete.");
    return null;
  };
  /** The state word beside the dot; on a Join row whose 10-minute window closed, the title adds why (the Attention caption and Details say it in full, while the table cell stays one line). */
  const stateWord = (row: DashboardRow, updating: boolean): ReactNode => {
    const word = stateHeadline(row, updating);
    const reason = !updating && row.state === "needs-approval" && !freshIds.has(row.server_id) ? askToJoinReason(row, t) : null;
    const title = reason !== null ? `${word} · ${reason}` : word;
    return <span className="relay-pc-state-word" title={title}>{word}</span>;
  };

  const renderAction = (row: DashboardRow): ReactNode => {
    const stop = (event: MouseEvent) => { event.stopPropagation(); };
    const openLink = (actionKind: "open" | "update", label: string) => (
      <a className="btn relay-pc-action-btn" href={serverScopePath(row.server_id)} data-pc-action={actionKind}
        onClick={(event) => { event.stopPropagation(); if (onOpenPc) { event.preventDefault(); onOpenPc(row); } }}>{label}</a>
    );
    const detailsBtn = <button type="button" className="btn relay-pc-action-btn" data-pc-action="details" onClick={(e) => { stop(e); onSelect(row.server_id); }}>{t("Details")}</button>;
    switch (row.displayState) {
      case "paired": case "unchecked": return openLink("open", t("Open"));
      case "needs-update": return row.paired ? openLink("update", t("Update")) : detailsBtn;
      case "needs-approval":
        if (row.join === undefined) return detailsBtn;
        return freshIds.has(row.server_id)
          ? <button type="button" className="btn relay-pc-action-btn" data-pc-action="add" onClick={(e) => { stop(e); onOpenSheet(row, "new"); }}>{t("Add")}</button>
          : <button type="button" className="btn relay-pc-action-btn" data-pc-action="join" onClick={(e) => { stop(e); onOpenSheet(row, "join"); }}>{t("Join")}</button>;
      case "offline":
        return !row.paired && row.join !== undefined
          ? <button type="button" className="btn relay-pc-action-btn" data-pc-action="join" onClick={(e) => { stop(e); onOpenSheet(row, "join"); }}>{t("Join")}</button>
          : detailsBtn;
    }
  };

  const renderSeen = (row: DashboardRow): ReactNode =>
    !row.listed || row.last_seen_at === null ? "—" : <time dateTime={row.last_seen_at} title={formatAbsoluteTime(row.last_seen_at)}>{lastSeen(row.last_seen_at, now)}</time>;
  /** The Relay cell: how this device reaches a PC it is paired with (its route and round trip, no answer, or Not checked); a PC it cannot check keeps the relay the directory assigns it. */
  const renderRelay = (row: DashboardRow): ReactNode => {
    if (row.paired) return routeNode(row.check ?? statusMap.get(row.server_id) ?? null, t);
    return row.relay !== null ? <code className="relay-pc-relay-chip">{relayHost(row.relay)}</code> : "—";
  };

  return (
    <div className={filtered.length >= LARGE_FLEET_FROM ? "relay-pc-list-region is-large-fleet" : "relay-pc-list-region"}>
      {showToolbar && (onFilter || (onCheckPcs && rows.some((pc) => pc.paired))) && (
        <div className="relay-pc-toolbar">
          {onFilter && mode === "account" && (
            <div className="segmented" role="group" aria-label={t("Filter")}>
              <button type="button" aria-pressed={filter === "all"} onClick={() => onFilter("all")}>{t("All")}</button>
              <button type="button" aria-pressed={filter === "ready"} onClick={() => onFilter("ready")}>{t("Ready")}</button>
              <button type="button" aria-pressed={filter === "needs"} onClick={() => onFilter("needs")}>{t("Needs you")}</button>
              <button type="button" aria-pressed={filter === "offline"} onClick={() => onFilter("offline")}>{t("Offline")}</button>
            </div>
          )}
          {relayFilter !== null && onClearRelayFilter && (
            <button type="button" className="btn btn-ghost" onClick={onClearRelayFilter}>
              <code className="relay-pc-relay-chip">{relayHost(relayFilter)}</code><span>×</span>
            </button>
          )}
          {onCheckPcs && rows.some((pc) => pc.paired) && <CheckPcsButton status={statusMap} onCheck={onCheckPcs} />}
        </div>
      )}
      <p className="visually-hidden" role="status" aria-live="polite">{announcement ?? ""}</p>
      {filtered.length === 0 ? (
        <div className="relay-pc-filter-empty" data-filter-empty="">
          <p className="relay-dash-quiet relay-dash-none">{t("No PC matches this filter.")}</p>
          {onFilter && filter !== "all" && <button type="button" className="btn" onClick={() => onFilter("all")}>{t("Show all PCs")}</button>}
        </div>
      ) : compactList ? (
        <ul className="relay-pc-phone-list" data-pc-list="phone" aria-label={t("PCs")}>
          {filtered.map((row) => {
            const updating = updatingIds?.has(row.server_id) === true;
            const dot = pcDotState(row, updating);
            const selected = selectedPcId === row.server_id;
            const sub = stateSubline(row, updating, true);
            const enrollment = enrollmentLine(row);
            return (
              <li key={row.server_id} className={selected ? "relay-pc-phone-row is-selected" : "relay-pc-phone-row"}
                data-pc-state={updating ? "updating" : row.displayState} data-pc-id={row.server_id} onClick={() => onSelect(row.server_id)}>
                <div className="relay-pc-phone-body">
                  <div className="relay-pc-phone-top">
                    <span className="relay-pc-name">
                      <StatusDot state={dot} />
                      <button type="button" className="relay-pc-name-btn" title={row.name} aria-current={selected ? "true" : undefined}
                        onClick={(event) => { event.stopPropagation(); onSelect(row.server_id); }}>
                        <span className="relay-pc-name-label">{row.name}</span>
                      </button>
                    </span>
                    <span className="relay-dash-act relay-pc-act" onClick={(event) => event.stopPropagation()}>{renderAction(row)}</span>
                  </div>
                  <div className="relay-pc-phone-meta">
                    {stateWord(row, updating)}<span aria-hidden="true">·</span>
                    {renderRelay(row)}<span aria-hidden="true">·</span>
                    <span className="relay-pc-seen">{renderSeen(row)}</span>
                  </div>
                  {enrollment !== null && <p className="relay-pc-probe-line" data-pc-enrollment="">{enrollment}</p>}
                  {sub !== null && <p className="relay-pc-probe-line">{sub}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <table className={showLastSeen ? "relay-dash-table relay-pc-table" : "relay-dash-table relay-pc-table is-without-seen"} data-pc-list="table">
          <caption className="visually-hidden">{t("PCs")}</caption>
          <colgroup><col className="relay-pc-col-name" /><col className="relay-pc-col-state" /><col className="relay-pc-col-relay" />{showLastSeen && <col className="relay-pc-col-seen" />}<col className="relay-pc-col-act" /></colgroup>
          <thead>
            <tr><th scope="col">{t("Name")}</th><th scope="col">{t("State")}</th><th scope="col" className="relay-pc-head-relay">{t("Relay")}</th>{showLastSeen && <th scope="col">{t("Last seen")}</th>}<th scope="col"><span className="visually-hidden">{t("Action")}</span></th></tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const updating = updatingIds?.has(row.server_id) === true;
              const dot = pcDotState(row, updating);
              const selected = selectedPcId === row.server_id;
              const sub = stateSubline(row, updating);
              const enrollment = enrollmentLine(row);
              return (
                <tr key={row.server_id} className={selected ? "relay-pc-row is-selected" : "relay-pc-row"}
                  data-pc-state={updating ? "updating" : row.displayState} data-pc-id={row.server_id} onClick={() => onSelect(row.server_id)}>
                  <td className="relay-pc-cell-name">
                    <div className="relay-pc-row-box">
                      <StatusDot state={dot} />
                      <button type="button" className="relay-pc-name-btn" title={row.name} aria-current={selected ? "true" : undefined}
                        onClick={(event) => { event.stopPropagation(); onSelect(row.server_id); }}>
                        <span className="relay-pc-name-label">{row.name}</span>
                      </button>
                    </div>
                  </td>
                  <td className="relay-dash-state-cell relay-pc-cell-state">
                    <div className="relay-pc-state-stack">
                      {stateWord(row, updating)}
                      {enrollment !== null && <small className="relay-pc-probe-line" data-pc-enrollment="">{enrollment}</small>}
                      {sub !== null && <small className="relay-pc-probe-line">{sub}</small>}
                    </div>
                  </td>
                  <td className="relay-dash-relay relay-pc-cell-relay">{renderRelay(row)}</td>
                  {showLastSeen && <td className="relay-dash-seen relay-pc-cell-seen">{renderSeen(row)}</td>}
                  <td className="relay-dash-act relay-pc-cell-act" onClick={(event) => event.stopPropagation()}>{renderAction(row)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
