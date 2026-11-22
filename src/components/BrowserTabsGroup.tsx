import { Bot, Globe, Plus, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { closeBrowserTab, type DesktopBrowserTab } from "../lib/desktopBrowser.ts";
import "./BrowserPanel.css";

/** The sidebar's Browser group: the built-in browser's tabs (the agents' marked, each closed by its x) and a new tab of the person's own. */
export function BrowserTabsGroup({ tabs, selected, onSelect }: { tabs: DesktopBrowserTab[]; selected: number | "new" | null; onSelect: (tab: number | "new") => void }) {
  const t = useT();
  return (
    <section className="browser-tabs" aria-label={t("Browser")}>
      <div className="browser-tabs-header">
        <span>{t("Browser")}</span>
        <button type="button" className="icon-button" aria-label={t("New tab")} title={t("New tab")} onClick={() => onSelect("new")}><Plus aria-hidden="true" /></button>
      </div>
      <ul className="browser-tabs-list">
        {tabs.map((tab) => <li key={tab.id} className="browser-tab-row">
          <button type="button" className="browser-tab" aria-current={selected === tab.id ? "true" : undefined} title={tab.address} onClick={() => onSelect(tab.id)}>
            {tab.profile === "agent" ? <Bot aria-label={t("Agent's tab")} /> : <Globe aria-hidden="true" />}
            <span className="browser-tab-name">{tab.title || tab.address}</span>
          </button>
          <button type="button" className="icon-button browser-tab-close" aria-label={t("Close tab")} title={t("Close tab")} onClick={() => closeBrowserTab(tab.id)}><X aria-hidden="true" /></button>
        </li>)}
      </ul>
    </section>
  );
}
