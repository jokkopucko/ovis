/** A browser fixture for the machine list, details and add sheet; all data stays in memory. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/fonts/fonts.css";
import "../src/styles.css";
import { MyMachines } from "../src/components/MyMachines.tsx";
import type { MyMachinesRoute } from "../src/lib/account/myMachinesRoute.ts";
import { FIXTURE_JOINER, FIXTURE_NOW, fixtureNewInvite, fixtureView } from "../src/lib/account/machinesView.fixtures.ts";
import type { FixtureAccount } from "../src/lib/account/machinesView.fixtures.ts";
import type { MachinesActions, MachinesView, NewInvite } from "../src/lib/account/machinesView.ts";
import { SettingsProvider } from "../src/lib/settings.ts";

declare global { interface Window { qa: { join: () => void } } }

const ACCOUNTS: readonly FixtureAccount[] = ["mixed", "empty", "offline", "unreachable", "twenty", "today", "behind", "joining", "needs-update"];
const query = new URLSearchParams(window.location.search);
const account = ACCOUNTS.find((name) => name === query.get("account")) ?? "mixed";
const viewer = query.get("viewer") === "watcher" ? "watcher" : "driver";

function Fixture() {
  const [view, setView] = useState<MachinesView>(() => fixtureView(account, viewer));
  const [route, setRoute] = useState<MyMachinesRoute>({ machineId: null });
  const [invite, setInvite] = useState<NewInvite | null>(null);

  // a join that already came in is not added again
  window.qa = { join: () => {
    setInvite((current) => current === null || current.joined.some((joined) => joined.id === FIXTURE_JOINER.id) ? current
      : { ...current, joined: [...current.joined, { id: FIXTURE_JOINER.id, name: FIXTURE_JOINER.name }] });
    setView((current) => current.machines.some((machine) => machine.id === FIXTURE_JOINER.id) ? current : { ...current, machines: [...current.machines, FIXTURE_JOINER] });
  } };

  const actions: MachinesActions = {
    openMachine: () => {},
    retryMachine: () => {},
    joinMachine: () => {},
    ...(account === "today" ? {} : { inviteFlow: {
      invite,
      makeInvite: async (choice) => setInvite(fixtureNewInvite(choice)),
      dropLine: () => setInvite(null),
    } }),
    dismissNotice: (noticeId) => setView((current) => ({ ...current, notices: current.notices?.filter((notice) => notice.id !== noticeId) ?? [] })),
  };

  return <MyMachines view={view} actions={actions} route={route} onRoute={setRoute} now={FIXTURE_NOW} />;
}

const mount = document.getElementById("root");
if (mount === null) throw new Error("#root is missing from the fixture page");
createRoot(mount).render(<React.StrictMode><SettingsProvider><Fixture /></SettingsProvider></React.StrictMode>);
