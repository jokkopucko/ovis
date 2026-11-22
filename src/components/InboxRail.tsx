import { tally, usageCounters } from "../lib/usageCounters.ts";
import { useState } from "react";
import { Bell, BellOff, CircleHelp, Inbox, Monitor, MonitorOff, Settings } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { OvisMark } from "./OvisMark.tsx";
import { RowMenu } from "./RowMenu.tsx";
import "./InboxRail.css";

export interface InboxRailPcs {
  machines: readonly Machine[];
  selectedId: string;
  connection: HeaderConnection;
  saidByThread: boolean;
  onSelect(machineId: string): void;
}

export interface InboxRailProps {
  onExit(): void;
  onInbox(): void;
  waiting: { count: number; open(): void } | null;
  alerts: { on: boolean; title: string; toggle(): void };
  onSettings(): void;
  pcs: InboxRailPcs;
  shortcutTitle(label: string, id: "settings"): string;
}

type PcState = "connected" | "reconnecting" | "offline";

function pcState(machine: Machine, connection: HeaderConnection): PcState {
  if (connection === "reconnecting" || machine.state === "reconnecting") return "reconnecting";
  return machine.state === "connected" ? "connected" : "offline";
}

function pcWord(state: PcState, t: Translate): string {
  switch (state) {
    case "connected": return t("Connected");
    case "reconnecting": return t("Reconnecting…");
    case "offline": return t("Offline");
  }
}

function pcsLabel({ machines, connection }: InboxRailPcs, t: Translate): string {
  const [first] = machines;
  if (first === undefined) return t("PCs");
  if (machines.length === 1) return `${t("PC {name}", { name: first.name })} · ${pcWord(pcState(first, connection), t)}`;
  if (connection === "reconnecting") return `${t("PCs")} · ${pcWord("reconnecting", t)}`;
  return t("PCs, {n} of {m} connected", { n: machines.filter((machine) => machine.state === "connected").length, m: machines.length });
}

export function InboxRail({ onExit, onInbox, waiting, alerts, onSettings, pcs, shortcutTitle }: InboxRailProps) {
  const t = useT();
  const AlertsGlyph = alerts.on ? Bell : BellOff;
  const [pcMenu, setPcMenu] = useState<HTMLElement | null>(null);
  const { machines, selectedId, connection, saidByThread, onSelect } = pcs;
  const pcLabel = pcsLabel(pcs, t);
  const PcGlyph = machines.length > 0 && machines.every((machine) => pcState(machine, connection) === "offline") ? MonitorOff : Monitor;
  // The same word is announced from a line that is in the document before it (lib/useAnnouncedText.ts):
  // a button's name is not read out when it changes.
  const dot = saidByThread ? null : connection;
  const announced = useAnnouncedText(dot === null ? null : pcWord(dot, t));
  return (
    <nav className="inbox-rail" aria-label={t("Inbox mode")}>
      <div className="inbox-rail-group is-top">
        <button type="button" className="icon-button inbox-rail-item inbox-rail-exit" aria-label={t("Back to Ovis")} title={t("Back to Ovis")} onClick={onExit}>
          <OvisMark width="22" height="22" className="inbox-rail-mark" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-place" aria-label={t("Agent inbox")} title={t("Agent inbox")} aria-current="page" onClick={() => { tally(() => usageCounters.count("inbox_rail_inbox")); onInbox(); }}>
          <Inbox aria-hidden="true" />
        </button>
      </div>
      <div className="inbox-rail-group is-lower">
        {waiting !== null && (
          <button type="button" className="icon-button inbox-rail-item inbox-rail-waiting" aria-label={t("{count} waiting for you", { count: waiting.count })} title={t("Open the next session waiting for you")} onClick={() => { tally(() => usageCounters.count("inbox_rail_waiting")); waiting.open(); }}>
            <CircleHelp aria-hidden="true" />
            <span className="header-more-dot is-waiting" data-count={waiting.count} aria-hidden="true" />
          </button>
        )}
        <button type="button" className="icon-button inbox-rail-item inbox-rail-alerts" aria-label={t("Alerts")} title={alerts.title} aria-pressed={alerts.on} onClick={() => { tally(() => usageCounters.count("inbox_rail_alerts")); alerts.toggle(); }}>
          <AlertsGlyph aria-hidden="true" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-settings" aria-label={t("Settings")} title={shortcutTitle(t("Settings"), "settings")} onClick={() => { tally(() => usageCounters.count("inbox_rail_settings")); tally(() => usageCounters.count("settings_by_button")); onSettings(); }}>
          <Settings aria-hidden="true" />
        </button>
        <button type="button" className="icon-button inbox-rail-item inbox-rail-pcs" aria-label={pcLabel} title={pcLabel} aria-haspopup="menu" aria-expanded={pcMenu !== null}
          disabled={machines.length === 0} onClick={(event) => { if (pcMenu === null) tally(() => usageCounters.count("inbox_rail_pcs")); setPcMenu(pcMenu === null ? event.currentTarget : null); }}>
          <PcGlyph aria-hidden="true" />
          {dot !== null && <span className={`inbox-rail-dot is-${dot}`} aria-hidden="true" />}
        </button>
      </div>
      <p className="visually-hidden" role="status">{announced}</p>
      {pcMenu !== null && <RowMenu anchor={pcMenu} title={t("PCs")} align="start" onClose={() => setPcMenu(null)}
        items={machines.map((machine) => {
          const state = pcState(machine, connection);
          return {
            id: machine.id, label: machine.name, hint: pcWord(state, t), icon: state === "offline" ? MonitorOff : Monitor,
            current: machine.id === selectedId, disabled: machine.state !== "connected",
            run: () => { if (machine.id !== selectedId) onSelect(machine.id); },
          };
        })} />}
    </nav>
  );
}

export function InboxRailBlank() {
  return <div className="inbox-rail" />;
}
