import { useMemo, useRef } from "react";
import type { AgentStatus } from "../../shared/protocol.ts";
import { alertPrefs, type Settings } from "./settings.ts";
import { useAlertFilters, withAlertFilters } from "./alertFilters.ts";

export function useAlertPrefs({ settings }: { settings: Settings }) {
  const filters = useAlertFilters();
  const alerts = useMemo(() => withAlertFilters(alertPrefs(settings), filters), [settings.alertInput, settings.alertDone, filters]);
  const alertsRef = useRef(alerts);
  alertsRef.current = alerts;
  const alertsOn = settings.alertsOn;
  const alertsOnRef = useRef(alertsOn);
  alertsOnRef.current = alertsOn;
  return { alerts, alertsRef, alertsOn, alertsOnRef };
}

export function useAlertRefs({ settings }: { settings: Settings }) {
  const statusRef = useRef<Map<string, AgentStatus>>(new Map());
  const turnStartRef = useRef<Map<string, number>>(new Map());
  const lastTurnRef = useRef<Map<string, number>>(new Map());
  const alertSoundRef = useRef(settings.alertSound);
  alertSoundRef.current = settings.alertSound;
  return { statusRef, turnStartRef, lastTurnRef, alertSoundRef };
}
