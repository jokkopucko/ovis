import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { browserStorage as storage, hideSetupRow, SETUP_ROW_KEY, setupRowState } from "../lib/firstHints.ts";
import { useT } from "../lib/i18n.ts";
import { openSetupGuide } from "../lib/setupGuide.ts";
import { setupLeft, type SetupFacts } from "../lib/setupGuideFlow.ts";
import "./SetupProgressRow.css";

export function SetupProgressRow({ facts }: { facts: SetupFacts }) {
  const t = useT();
  const [hidden, setHidden] = useState(() => { const store = storage(); return store === null || setupRowState(store) !== "on"; });
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => { if (event.key === SETUP_ROW_KEY || event.key === null) { const store = storage(); setHidden(store === null || setupRowState(store) !== "on"); } };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const left = setupLeft(facts);
  const at = left.at;
  if (hidden || at === null) return null;
  const count = left.total - left.done;
  const hide = (): void => {
    setHidden(true);
    const store = storage();
    if (store !== null) hideSetupRow(store);
  };
  return (
    <div className="setup-row">
      <button type="button" className="btn btn-ghost sidebar-footer-action sidebar-footer-pc setup-row-open" onClick={() => openSetupGuide(at === "agent" ? undefined : at)}>
        <svg className="setup-row-ring" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="6.5" pathLength={left.total} />
          <circle className="is-done" cx="8" cy="8" r="6.5" pathLength={left.total} strokeDasharray={`${left.done} ${left.total}`} />
        </svg>
        <span className="sidebar-footer-pc-name">{t("Setup: {count} left", { count })}</span>
      </button>
      <button type="button" className="icon-button setup-row-hide" aria-label={t("Hide setup reminder")} title={t("Hide setup reminder")} onClick={hide}><X aria-hidden="true" /></button>
    </div>
  );
}
