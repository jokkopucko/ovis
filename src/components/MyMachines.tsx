/** The hosted dashboard frame around the machine list, its details and the add sheet. */
import "./RelayDashboard.css";
import "./MyMachines.css";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { Plus, Server } from "lucide-react";
import type { MachinesActions, MachinesView } from "../lib/account/machinesView.ts";
import { formatMyMachinesHash, type MyMachinesRoute } from "../lib/account/myMachinesRoute.ts";
import { useT } from "../lib/i18n.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { AddMachineSheet } from "./AddMachineSheet.tsx";
import { MyMachineDetails, NARROW_DETAILS_QUERY } from "./MyMachineDetails.tsx";
import { MyMachinesList } from "./MyMachinesList.tsx";
import { AccountNotices, useInertPage } from "./MyMachinesParts.tsx";

const PHONE_QUERY = "(max-width: 768px)";

export interface MyMachinesProps {
  readonly view: MachinesView;
  readonly actions: MachinesActions;
  readonly route: MyMachinesRoute;
  readonly onRoute: (route: MyMachinesRoute) => void;
  /** the clock the relative times are drawn from; the wall clock when left out */
  readonly now?: number;
}

export function MyMachines({ view, actions, route, onRoute, now = Date.now() }: MyMachinesProps) {
  const t = useT();
  const phone = useMediaQuery(PHONE_QUERY);
  const narrow = useMediaQuery(NARROW_DETAILS_QUERY);
  const page = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  useInertPage(adding, page);

  const mayAdd = view.role === "drive" && view.thisDeviceBehind !== true;
  const selected = view.machines.find((machine) => machine.id === route.machineId) ?? null;
  const selectedId = selected?.id ?? null;
  const select = (machineId: string | null): void => onRoute({ machineId });
  const add = (): void => setAdding(true);
  const closeAdd = (): void => { setAdding(false); actions.inviteFlow?.dropLine(); };

  // Below 1100px the details replace the list: their heading takes the focus, and the row takes it back on Back.
  // From 1100px they open beside the list and the focus stays where the click put it; only a focus left
  // nowhere (Close, a button of the panel that went) goes to the row.
  const shownMachine = useRef(selectedId);
  useEffect(() => {
    const before = shownMachine.current;
    if (before === selectedId) return;
    shownMachine.current = selectedId;
    const rowOf = (machineId: string | null): HTMLElement | null => machineId === null ? null : page.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(machineId)}"] .acct-name-btn`) ?? null;
    if (!narrow) {
      if (document.activeElement === null || document.activeElement === document.body) rowOf(selectedId ?? before)?.focus({ preventScroll: true });
      return;
    }
    if (selectedId !== null) {
      page.current?.querySelector<HTMLElement>(".relay-pc-details-title")?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    } else rowOf(before)?.focus();
  }, [selectedId, narrow]);

  const count = view.machines.filter((machine) => machine.state.kind !== "removed").length;
  const home = formatMyMachinesHash({ machineId: null });
  const goHome = (event: MouseEvent<HTMLAnchorElement>): void => { event.preventDefault(); select(null); };
  const label = t("My machines");
  const addLabel = t("Add a machine");
  const sectionLink = (className: "relay-dash-nav-item" | "relay-dash-tab") => (
    <a className={className} href={home} aria-current="page" onClick={goHome}>
      <Server aria-hidden="true" /><span>{label}</span>
      {className === "relay-dash-nav-item" && count > 0 && <span className="relay-dash-nav-count">{count}</span>}
    </a>
  );

  return (
    <main className="relay-dash-screen">
      <div ref={page} className="relay-dash" data-acct-place="machines">
        <aside className="relay-dash-side" aria-label={t("Navigation|my machines")}>
          <div className="relay-dash-side-box">
            <div className="relay-dash-brand-bar">
              <a className="relay-dash-brand" href={home} onClick={goHome}><img src="/icons/icon-192.png?v=sheep1" alt="" className="relay-dash-brand-mark" />Ovis</a>
              {phone && mayAdd && <button type="button" className="icon-button relay-dash-phone-add" data-action="add-machine" aria-label={addLabel} title={addLabel} onClick={add}><Plus aria-hidden="true" /></button>}
            </div>
            <nav className="relay-dash-nav" aria-label={t("Sections|my machines")}>{sectionLink("relay-dash-nav-item")}</nav>
          </div>
        </aside>
        <div className="relay-dash-main">
          <div className="relay-dash-content">
            <header className="relay-dash-top">
              <div className="relay-dash-top-text"><h1 className="relay-dash-title">{label}</h1></div>
              {!phone && mayAdd && <button type="button" className={view.machines.length === 0 ? "btn" : "btn btn-primary"} data-action="add-machine" onClick={add}><Plus aria-hidden="true" />{addLabel}</button>}
            </header>
            <div className="acct-stack">
              {view.role === "watch" && <p className="acct-quiet" data-watching="">{t("This device only watches. A device that can drive adds and removes machines, devices and invites.")}</p>}
              {view.thisDeviceBehind === true && (
                <p className="acct-notice acct-behind" role="status" data-behind=""><strong>{t("Update Ovis on this device")}</strong> {t("Until then it adds nothing to your account. It can still remove devices and machines.")}</p>
              )}
              <div className={selected ? "acct-split is-selected" : "acct-split"}>
                {!(narrow && selected) && (
                  <div className="acct-stack">
                    {view.notices && actions.dismissNotice && <AccountNotices notices={view.notices} now={now} onWasMe={actions.dismissNotice} />}
                    <MyMachinesList machines={view.machines} selectedId={selectedId} now={now} canAdd={mayAdd} onSelect={select} onOpen={actions.openMachine} onRetry={actions.retryMachine}
                      onAdd={add} onJoin={actions.joinMachine} addsFromTerminal={actions.inviteFlow === undefined} />
                  </div>
                )}
                {selected && (
                  <MyMachineDetails machine={selected} now={now} onJoin={actions.joinMachine} blocked={adding} onClose={() => select(null)} onOpen={actions.openMachine} onRetry={actions.retryMachine} />
                )}
              </div>
            </div>
          </div>
        </div>
        <nav className="relay-dash-tabs" aria-label={t("Sections|my machines")}>{sectionLink("relay-dash-tab")}</nav>
      </div>
      {adding && <AddMachineSheet flow={actions.inviteFlow} now={now} onOpenMachine={(machineId) => { closeAdd(); actions.openMachine(machineId); }} onClose={closeAdd} />}
    </main>
  );
}
