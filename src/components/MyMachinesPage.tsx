/**
 * "My machines" mounted in the hosted shell at its own address (lib/account/myMachinesRoute.ts),
 * fed through the one seam (lib/account/machinesSource.ts) from what the shell already keeps.
 */
import type { MyPc } from "../lib/account/myPcs.ts";
import { useMachinesSource } from "../lib/account/machinesSource.ts";
import { formatMyMachinesHash, type MyMachinesRoute } from "../lib/account/myMachinesRoute.ts";
import { useT } from "../lib/i18n.ts";
import type { PcStatus } from "../lib/relay/pcStatus.ts";
import { serverScopePath } from "../lib/shellMode.ts";
import { MyMachines } from "./MyMachines.tsx";

export interface MyMachinesPageProps {
  readonly route: MyMachinesRoute;
  readonly pcs: readonly MyPc[] | null;
  readonly pcStatus: ReadonlyMap<string, PcStatus>;
  readonly onCheckPc: (serverId: string) => void;
  readonly onJoin: (pc: MyPc) => void;
}

export function MyMachinesPage({ route, pcs, pcStatus, onCheckPc, onJoin }: MyMachinesPageProps) {
  const t = useT();
  const { view, actions } = useMachinesSource({ pcs, status: pcStatus }, {
    open: (machineId) => window.location.assign(serverScopePath(machineId)),
    check: onCheckPc,
    join: (machineId) => { const pc = pcs?.find((row) => row.server_id === machineId); if (pc !== undefined) onJoin(pc); },
  });
  if (view === null) {
    return <main className="relay-dash-screen"><p className="relay-shell-detail" role="status" data-my-machines-loading="">{t("Loading…")}</p></main>;
  }
  return <MyMachines view={view} actions={actions} route={route}
    onRoute={(next) => { window.location.hash = formatMyMachinesHash(next); }} />;
}
