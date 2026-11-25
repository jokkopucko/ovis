import { useState } from "react";
import { X } from "lucide-react";

import type { SlashCommand } from "../../shared/protocol.ts";
import { closeTabMessage } from "../lib/closeTabSkill.ts";
import { useT } from "../lib/i18n.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

interface Props {
  /** the pane's command for the close-tab skill the settings name (lib/closeTabSkill.ts) */
  command: SlashCommand;
  disabled: boolean;
  /** puts the message into the empty box and sends it as a typed one; false when the box was no longer empty */
  onSend: (message: string) => boolean;
}

/**
 * The composer's Close tab button: after a yes, it asks the agent to run its close-tab skill, so the
 * agent finishes or records what is left before it closes its own tab. It never closes the tab
 * itself: the pane menu's Close tab does that, with no check.
 */
export function CloseTabButton({ command, disabled, onSend }: Props) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  return <>
    <button
      type="button"
      className="icon-button composer-close-tab"
      aria-label={t("Close tab")}
      title={t("Close tab")}
      disabled={disabled}
      onClick={() => setAsking(true)}
    >
      <X aria-hidden="true" />
    </button>
    {asking && <ConfirmDialog title={t("Close tab?")}
      body={t("The agent first checks for open work and questions. It closes the tab only when nothing is left.")}
      confirmLabel={t("Close tab")} onClose={() => setAsking(false)}
      onConfirm={async () => {
        if (!onSend(closeTabMessage(command))) throw new Error(t("Nothing was sent: the message box is not empty."));
        setAsking(false);
      }} />}
  </>;
}
