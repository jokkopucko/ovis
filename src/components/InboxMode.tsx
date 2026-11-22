import { useMemo, type CSSProperties, type ReactNode } from "react";
import { Inbox } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { inboxStatus } from "../lib/agentInbox.ts";
import { agentGroup, agentRoster } from "../lib/agentRoster.ts";
import type { HeaderConnection } from "../lib/headerConnection.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { inboxStateWord } from "../lib/inboxRow.ts";
import { agentName } from "../lib/runtimeMove.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";
import { paneMark } from "../lib/sidebarAgents.ts";
import { useAnnouncedText } from "../lib/useAnnouncedText.ts";
import { agentRowTitle } from "./AgentSidebar.tsx";
import { InboxAvatar } from "./InboxList.tsx";
import { InboxRailBlank } from "./InboxRail.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import "./InboxMode.css";

export interface ThreadProps {
  machines: readonly Machine[];
  activity: SidebarActivity;
  machineId: string;
  pane: HerdrPane;
  connection: HeaderConnection;
  watching: boolean;
  severalPcs: boolean;
}

function threadFacts({ machines, activity, machineId, pane, connection, watching, severalPcs }: ThreadProps, t: Translate) {
  const machine = machines.find((candidate) => candidate.id === machineId);
  const row = agentRoster(machines, { byActivity: false, seqs: activity.seqs, pinned: [] }).rest
    .find((candidate) => candidate.machine.id === machineId && candidate.entry.pane.pane_id === pane.pane_id);
  const state = machine !== undefined && machine.state !== "connected" ? t("Offline")
    : row ? inboxStateWord(agentGroup(inboxStatus(row, activity)), t) : t("Terminal");
  const said = connection !== null ? t(connection === "connected" ? "Connected" : "Reconnecting…")
    : [watching ? t("View only") : null, severalPcs && machine ? machine.name : null, state].filter((part) => part !== null).join(" · ");
  return {
    name: row ? agentRowTitle(row, false).title : displayPaneTitle(pane),
    kind: row?.entry.canonicalAgent ?? null,
    mark: row ? paneMark(row.entry) ?? "" : null,
    said,
  };
}

export function ThreadTitle(props: ThreadProps) {
  const t = useT();
  const { machines, activity, machineId, pane, connection, watching, severalPcs } = props;
  const { name, kind, mark, said } = useMemo(() => threadFacts({ machines, activity, machineId, pane, connection, watching, severalPcs }, t), [machines, activity, machineId, pane, connection, watching, severalPcs, t]);
  return (
    <div className="thread-title" title={name}>
      <InboxAvatar mark={mark} />
      <div className="thread-title-words">
        <span className="thread-name">{kind && <span className="visually-hidden">{agentName(kind)}: </span>}{name}</span>
        <span className={`thread-state${connection === null ? "" : ` is-${connection}`}`}>{said}</span>
      </div>
    </div>
  );
}

function ThreadChip(props: ThreadProps) {
  const t = useT();
  const { machines, activity, machineId, pane, connection, watching, severalPcs } = props;
  const { name, kind, mark, said } = useMemo(() => threadFacts({ machines, activity, machineId, pane, connection, watching, severalPcs }, t), [machines, activity, machineId, pane, connection, watching, severalPcs, t]);
  return (
    <div className="thread-chip" title={name}>
      <InboxAvatar mark={mark} />
      <span className="thread-chip-name">{kind && <span className="visually-hidden">{agentName(kind)}: </span>}{name}</span>
      <span className={`thread-chip-state${connection === null ? "" : ` is-${connection}`}`}>{said}</span>
    </div>
  );
}

export function ThreadTop({ thread, note, controls }: { thread: ThreadProps | null; note: ReactNode; controls: ReactNode }) {
  return (
    <div className={`thread-top${thread === null && controls === null ? " is-empty" : ""}`}>
      <div className="thread-top-middle">
        {note}
        {thread !== null && <ThreadChip {...thread} />}
      </div>
      {controls !== null && <div className="thread-top-controls">{controls}</div>}
    </div>
  );
}

export function InboxConnecting({ wide, sidebarWidth = null }: { wide: boolean; sidebarWidth?: number | null }) {
  const t = useT();
  const shown = useAnnouncedText(t("Connecting to Ovis…"));
  const list = (
    <section className={`mode-inbox${wide ? " is-wide" : ""}`} aria-label={t("Agent inbox")}>
      <div className="inbox-top" />
      <div className="inbox-scroll"><p className={shown === null ? "visually-hidden" : "inbox-empty"} role="status">{shown}</p></div>
      {!wide && <div className="inbox-foot" />}
    </section>
  );
  return (
    <div className={`app${wide ? "" : " sidebar-collapsed"} is-inbox ${wide ? "is-inbox-wide" : "is-inbox-list"}`}
      style={wide && sidebarWidth !== null ? { "--sidebar-user-w": `${sidebarWidth}px` } as CSSProperties : undefined}>
      <div className="app-body">
        {wide && <aside className="sidebar inbox-column"><InboxRailBlank />{list}</aside>}
        <div className="pane-column"><div className="pane-split">{!wide && list}</div></div>
      </div>
    </div>
  );
}

export function InboxUnchosen() {
  const t = useT();
  return <p className="inbox-unchosen" role="status">{t("Choose one from the list to open its chat here.")}</p>;
}

export function InboxFootEntry({ onOpen }: { onOpen(): void }) {
  const t = useT();
  return (
    <button type="button" className="btn btn-ghost sidebar-footer-action sidebar-footer-pc inbox-foot-entry" onClick={onOpen}>
      <Inbox aria-hidden="true" />
      <span className="sidebar-footer-pc-name">{t("Open agent inbox")}</span>
    </button>
  );
}
