import { CheckCheck, MessageCircleQuestionMark, OctagonX, ShieldAlert, Timer, type LucideIcon } from "lucide-react";
import { updateAlertFilters, type AlertFilters } from "../lib/alertFilters.ts";
import type { Translate } from "../lib/i18n.ts";
import type { Settings } from "../lib/settings.ts";

export interface AlertChip { label: string; title: string; icon: LucideIcon; on: boolean; onChange: (on: boolean) => void }

export function alertMeWhenChips(t: Translate, settings: Settings, filters: AlertFilters, update: (patch: Partial<Settings>) => void, withError: boolean): AlertChip[] {
  const chips: AlertChip[] = [
    { label: t("Needs input"), title: t("An agent asks you something"), icon: MessageCircleQuestionMark, on: settings.alertInput, onChange: (alertInput) => update({ alertInput }) },
    { label: t("Needs permission"), title: t("An agent asks before it runs a command or changes a file. One that does not say so alerts as Needs input."), icon: ShieldAlert, on: filters.permission ?? settings.alertInput, onChange: (permission) => updateAlertFilters({ permission }) },
    { label: t("Long turn finished"), title: t("Long turns: only work that took a minute or more"), icon: Timer, on: settings.alertDone !== "off", onChange: (on) => update({ alertDone: on ? "long" : "off" }) },
    { label: t("Any turn finished"), title: t("Any turn finished takes in the long ones."), icon: CheckCheck, on: settings.alertDone === "always", onChange: (on) => update({ alertDone: on ? "always" : "long" }) },
  ];
  if (withError) chips.push({ label: t("Stopped on an error"), title: t("A turn that ended on an error, as OmO and GJC report it"), icon: OctagonX, on: filters.error === true, onChange: (error) => updateAlertFilters({ error }) });
  return chips;
}
