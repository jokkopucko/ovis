import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Box, Globe, MessagesSquare, Puzzle, SquareTerminal, Star } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { awaitRestart, restartState, subscribeRestart } from "../lib/runtimeSwitch.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";
import { TerminalCommandRow } from "./TerminalCommandRow.tsx";
import { SettingsBare, Segmented, SettingsGroup, SettingsRow } from "./SettingsControls.tsx";
import type { UpdatesModel } from "../lib/updates.ts";
import { LOCAL_MACHINE, type HerdrCoreFacts, type HerdrRuntimeFacts, type RuntimeName } from "../../shared/machines.ts";
import { switchRuntime, fetchBridgeHealth } from "../lib/api.ts";
import type { PluginActions } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { RuntimeMove } from "./RuntimeMove.tsx";
import { HerdrUpdateControls, PreviewAppUpdate, UpdateControls } from "./UpdateControls.tsx";
import { TelemetryControls } from "./TelemetryControls.tsx";
import { ExternalLink } from "../lib/externalLink.ts";

const RUNTIME_HELP = "https://github.com/devswha/ovis/blob/main/docs/guide.md#herdr-app-terminals";

function PluginsGroup() {
  const t = useT();
  const api = useMachineApi();
  const [plugins, setPlugins] = useState<PluginActions[]>([]);
  useEffect(() => {
    let current = true;
    void api.fetchPluginActions().then((list) => { if (current) setPlugins(list); }, () => { if (current) setPlugins([]); });
    return () => { current = false; };
  }, [api]);
  const bare = useContext(SettingsBare);
  if (plugins.length === 0) return null;
  if (bare) return (
    <SettingsGroup className="settings-plugins">
      <SettingsRow label={t("herdr plugins")} description={t("The herdr plugins on this PC, to read only: a plugin is installed, enabled or removed in herdr.")} icon={Puzzle}>
        <span className="settings-fact">{plugins.map((plugin) => `${plugin.name} ${plugin.version}${plugin.enabled ? "" : ` (${t("Disabled")})`}`).join(", ")}</span>
      </SettingsRow>
    </SettingsGroup>
  );
  return (
    <SettingsGroup title={t("herdr plugins")} note={t("The command palette and its plugin actions are not available in the phone touch UI. Use a wider screen or a keyboard's command palette shortcut.")} className="settings-plugins">
      {plugins.map((plugin) => (
        <SettingsRow key={plugin.plugin_id} label={`${plugin.name} ${plugin.version}`} description={plugin.actions.length > 0 ? plugin.actions.map((action) => action.title).join(" · ") : t("No actions")}>
          <span className="settings-hint">{plugin.enabled ? t("Enabled") : t("Disabled")}</span>
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

function RuntimeFacts({ version, runtime, core, facts: healthFacts, bootId, onServerRestarted, onOpenPane }: { version: string | null; runtime: "herdr" | "herdr-core" | null; core: HerdrCoreFacts | null; facts: HerdrRuntimeFacts | null; bootId: string | null; onServerRestarted?: () => void; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const restarting = useSyncExternalStore(subscribeRestart, restartState);
  const [bridgeFacts, setBridgeFacts] = useState<HerdrRuntimeFacts | null>(null);
  useEffect(() => {
    if (restarting !== null) return;
    let live = true;
    const read = () => fetchBridgeHealth().then((health) => { if (live) setBridgeFacts(health.herdr_runtime ?? null); }, () => {});
    void read();
    const timer = setInterval(() => void read(), 10_000);
    return () => { live = false; clearInterval(timer); };
  }, [restarting, bootId]);
  const facts = bridgeFacts ?? healthFacts;
  const served = facts?.serving ?? runtime;
  const known = served === runtime ? version : null;
  const move = <RuntimeMove key="move" bootId={bootId} hidden={restarting !== null} onServerRestarted={onServerRestarted} onOpenPane={onOpenPane} />;
  if (restarting !== null) {
    return (
      <SettingsGroup title={t("Terminals")} section="runtime">
        <p className="settings-item settings-hint" role="status">{restarting.lost ? t("Ovis has not answered since the restart. Reload this page in a moment; if it stays away, start Ovis again on this PC.")
          : restarting.to === "herdr-core" ? t("Restarting Ovis on the Herdr app…") : t("Restarting Ovis on herdr TUI…")}</p>
        {move}
      </SettingsGroup>
    );
  }
  if (served === null || (known === null && facts === null)) return null;
  const onCore = served === "herdr-core";
  const target = facts?.switch_to ?? null;
  const hint = facts?.fallback === "no_herdr_core" ? t("The Herdr app was chosen here, but no herdr-core answered, so herdr TUI is shown.")
    : facts?.fallback === "no_alt_runtime" ? t("alt-runtime was chosen here, but this Ovis cannot start it, so herdr TUI is shown.")
    : facts?.locked === "env" ? t("OVIS_RUNTIME in Ovis's environment decides which terminals this PC shows; change it there to switch.")
    // where the OS does not serve herdr-core, setting OVIS_RUNTIME=herdr-core would stop Ovis: no how-to
    : target !== null || onCore || !core?.version || facts?.locked === "platform" ? null
    : <span>{t("The Herdr app's core (hc {version}) is on this PC too. Ovis can show its terminals instead of herdr's.", { version: core.version })} <ExternalLink kind="link" className="settings-link" href={RUNTIME_HELP}>{t("How to switch")}</ExternalLink></span>;
  const toCore = target === "herdr-core";
  const coreInstalled = core?.version != null;
  const tuiInstalled = facts?.tui.installed ?? !onCore;
  const name = (runtime: RuntimeName) => runtime;
  const versionOf = (runtime: RuntimeName) => (runtime === served ? known ?? (onCore ? core?.version ?? null : null) : runtime === "herdr-core" ? core?.version ?? null : null);
  const titled = (runtime: RuntimeName) => [name(runtime), versionOf(runtime)].filter(Boolean).join(" ");
  const others = (["herdr", "herdr-core"] as const).filter((runtime) => runtime !== served && runtime !== target && (runtime === "herdr-core" ? coreInstalled : tuiInstalled));
  return (
    <SettingsGroup title={t("Terminals")} section="runtime">
      <SettingsRow label={t("In use")} description={t("Where this PC's terminals come from: herdr's TUI, or herdr-core, the Herdr app's core. With both installed, choosing the other restarts Ovis and shows its terminals; the panes of both keep running.")} icon={SquareTerminal} wide={target !== null}
        condition={!onCore && facts?.tui.running === false ? <span className="settings-hint">{t("herdr's TUI server is not running.")}</span> : undefined}>
        {target !== null
          ? <Segmented label={t("In use")} value={served} onChange={(runtime) => { if (runtime === target) setConfirming(true); }}
            options={[served, target].sort().map((runtime) => ({ value: runtime, label: titled(runtime) }))} />
          : <span className="settings-fact">{titled(served)}</span>}
      </SettingsRow>
      {others.map((runtime) => (
        <SettingsRow key={runtime} label={name(runtime)} description={t("Also installed on this PC. Ovis is not showing its terminals now.")} icon={Box}>
          <span className="settings-fact">{versionOf(runtime) ?? t("Installed")}</span>
        </SettingsRow>
      ))}
      {hint && <p className="settings-item settings-hint">{hint}</p>}
      {move}
      {confirming && target !== null && (
        <ConfirmDialog
          title={toCore ? t("Show the Herdr app's terminals?") : t("Show herdr TUI's terminals?")}
          body={toCore
            ? t("Ovis restarts and shows the Herdr app's terminals instead of herdr TUI's; this page reconnects by itself. herdr's panes keep running.")
            : `${t("Ovis restarts and shows herdr TUI's terminals instead of the Herdr app's; this page reconnects by itself. The app's terminals keep running.")}${facts?.tui.running === false ? ` ${t("herdr's TUI server is not running: start herdr after the switch.")}` : ""}`}
          confirmLabel={t("Switch and restart")}
          onConfirm={async () => {
            const from = await fetchBridgeHealth().then((health) => health.web_ui?.boot_id ?? bootId, () => bootId);
            await switchRuntime(target);
            paneLifetimes.runtimeSwitched(LOCAL_MACHINE);
            setConfirming(false);
            awaitRestart(target, {
              from,
              boot: () => fetchBridgeHealth().then((health) => health.web_ui ? { id: health.web_ui.boot_id, accepted: health.accepted === true } : null),
              onBack: () => { paneLifetimes.runtimeSwitched(LOCAL_MACHINE); onServerRestarted?.(); },
            });
          }}
          onClose={() => setConfirming(false)}
        />
      )}
    </SettingsGroup>
  );
}

export function AboutPage({ updates, herdrVersion, herdrRuntime, herdrCore, herdrRuntimeFacts, bootId, onServerRestarted, onOpenPane, bridgesFollow }: { updates: UpdatesModel; herdrVersion: string | null; herdrRuntime: "herdr" | "herdr-core" | null; herdrCore: HerdrCoreFacts | null; herdrRuntimeFacts: HerdrRuntimeFacts | null; bootId: string | null; onServerRestarted?: () => void; onOpenPane: (machineId: string, paneId: string) => void; bridgesFollow: boolean }) {
  const t = useT();
  return (
    <SettingsBare.Provider value={true}>
      {/* the facts read as one list, as herdr-app's About */}
      <div className="settings-joined">
      <RuntimeFacts version={herdrVersion} runtime={herdrRuntime} core={herdrCore} facts={herdrRuntimeFacts} bootId={bootId} onServerRestarted={onServerRestarted} onOpenPane={onOpenPane} />
      <PreviewAppUpdate />
      <UpdateControls updates={updates} bridgesFollow={bridgesFollow} />
      {/* herdr's own version and update: on herdr-core there is no herdr TUI here, and Terminals names the core */}
      {herdrRuntime !== "herdr-core" && <HerdrUpdateControls enabled herdrVersion={herdrVersion} showVersion={(herdrRuntimeFacts?.serving ?? herdrRuntime) === null} />}
      <PluginsGroup />
      <TerminalCommandRow />
      <TelemetryControls />
      </div>
      <SettingsGroup title={t("About")} className="settings-about" section="about">
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label-line"><Globe className="settings-row-icon" aria-hidden="true" /><ExternalLink kind="link" className="settings-link" href="https://ovis.sh/">ovis.sh</ExternalLink></span>
          </div>
          <ExternalLink kind="link" className="btn" href="https://github.com/devswha/ovis"><Star aria-hidden="true" />{t("Star on GitHub")}</ExternalLink>
        </div>
        <div className="settings-row">
          <div className="settings-row-text">
            <span className="settings-label-line"><MessagesSquare className="settings-row-icon" aria-hidden="true" />{t("Questions and chat")}</span>
          </div>
          <ExternalLink kind="link" className="btn" href="https://ovis.sh/discord">{t("Join Discord")}</ExternalLink>
        </div>
      </SettingsGroup>
    </SettingsBare.Provider>
  );
}