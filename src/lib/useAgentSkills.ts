import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

import type { SlashCommand } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import type { useT } from "./i18n.ts";
import { userErrorMessage } from "./userError.ts";

export const SKILLS_MS = 300;
export const BUSY_RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000];
const MAX_BUSY_WAIT_MS = 60_000;

export type AgentSkills = { rows: SlashCommand[]; note: string | null } | null;

function skillRows(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter((command) => command.source === "skill" && command.visibility !== "terminal");
}

export function useAgentSkills(open: boolean, agent: string, folder: string | null, fetchAgentCommands: (agent: string, cwd: string | null) => Promise<SlashCommand[]>, t: ReturnType<typeof useT>): [AgentSkills, Dispatch<SetStateAction<AgentSkills>>] {
  const [skills, setSkills] = useState<AgentSkills>(null);
  useEffect(() => {
    if (!open || agent === "") return;
    let cancelled = false;
    let tries = 0;
    const ask = (): void => {
      void fetchAgentCommands(agent, folder)
        .then((commands) => {
          if (!cancelled) setSkills({ rows: skillRows(commands), note: null });
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          if (reason instanceof ApiError && reason.status === 503 && reason.code === "file_busy" && tries < BUSY_RETRY_MS.length) {
            timer = setTimeout(ask, Math.min(Math.max(BUSY_RETRY_MS[tries++]!, reason.retryAfterMs ?? 0), MAX_BUSY_WAIT_MS));
            return;
          }
          const note = reason instanceof ApiError && reason.code === "invalid_cwd" ? t("Skills are listed once the directory exists.")
            : reason instanceof ApiError && reason.status === 404 ? t("This PC's bridge does not list skills yet.")
              : userErrorMessage(reason).message;
          setSkills({ rows: [], note });
        });
    };
    let timer = setTimeout(ask, SKILLS_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, agent, folder]);
  return [skills, setSkills];
}
