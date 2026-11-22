import type { AgentGroup } from "./agentRoster.ts";
import type { Translate } from "./i18n.ts";

export function inboxStateWord(group: AgentGroup, t: Translate): string {
  switch (group) {
    case "blocked": return t("Needs you");
    case "working": return t("Working");
    case "done": return t("Done");
    case "idle": return t("Ready");
  }
}

export function inboxAsks(group: AgentGroup): boolean {
  return group === "blocked" || group === "done";
}

export function inboxRowLine(input: { online: boolean; group: AgentGroup; words: string | null; place: string; machine: string | null; failed?: boolean }, t: Translate): string {
  const said = !input.online ? t("Offline")
    : input.words ?? (input.failed ? t("Turn failed") : input.group === "idle" && input.place !== "" ? input.place : inboxStateWord(input.group, t));
  return input.machine === null ? said : `${input.machine} · ${said}`;
}
