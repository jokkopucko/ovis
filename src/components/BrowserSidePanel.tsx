import { useEffect, useState } from "react";
import { AppWindow, Download, Globe, Image as ImageIcon, X } from "lucide-react";

import "./BrowserSidePanel.css";

import { usePaneArtifacts } from "./Artifacts.tsx";
import { formatBytes } from "../lib/bridgeProgress.ts";
import { formatChatTimestamp } from "../lib/chatTimestamp.ts";
import { browserTabThumbnail, closeBrowserTab, revealBrowserResult, type DesktopBrowser, type DesktopBrowserResult, type DesktopBrowserTab } from "../lib/desktopBrowser.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { agentName } from "../lib/runtimeMove.ts";
import { ExternalLink } from "../lib/externalLink.ts";
import type { AgentStatus } from "../../shared/protocol.ts";

/** how often a card's picture is taken again while the panel shows it */
const CARD_PICTURE_MS = 4000;
/** pictures missed in a row after which a card shows none rather than an old one */
const CARD_PICTURE_MISSES = 3;

export interface BrowserSidePanelPane {
  id: string;
  agent: string | null;
  status: AgentStatus | undefined;
}

/**
 * The right panel of the desktop app's built-in browser (shown only while it is on): what came
 * out of the work (the files the browser kept, an agent's screenshots, the pages the selected
 * Claude Code pane published) and the tabs the agents drive, as small cards. Like the Claude and
 * Codex apps' artifact rail, it lists outputs beside the conversation rather than inside it.
 */
export function BrowserSidePanel({ browser, pane, agentOf, onOpen }: { browser: DesktopBrowser; pane: BrowserSidePanelPane | null; agentOf: (paneId: string) => string | null; onOpen: (tab: number) => void }) {
  const t = useT();
  const locale = useLocale();
  const artifacts = usePaneArtifacts(pane?.agent === "claude" ? pane.id : null, pane?.status, false);
  const agentTabs = browser.tabs.filter((tab) => tab.profile === "agent");
  const results = artifacts.length + browser.results.length;
  const now = Date.now();
  const when = (at: string | null) => formatChatTimestamp(at, now, locale, t);
  return (
    <aside className="browser-side-panel" aria-label={t("Browser panel")}>
      <section className="browser-side-section" aria-labelledby="browser-side-results">
        <h2 className="browser-side-heading" id="browser-side-results"><span>{t("Results")}</span><span className="browser-side-count">{results}</span></h2>
        {results === 0
          ? <p className="browser-side-empty">{t("Files the browser downloads, screenshots and published pages show here.")}</p>
          : <ul className="browser-side-results">
            {browser.results.map((result) => <ResultRow key={result.id} result={result} time={when(new Date(result.at).toISOString())} />)}
            {artifacts.map((artifact) => {
              const time = when(artifact.at);
              return <li key={artifact.url}>
                <ExternalLink kind="link" className="browser-side-result" href={artifact.url} title={[artifact.title ?? artifact.url, t("Published page"), time?.label].filter(Boolean).join(" · ")}>
                  <span className="browser-side-result-tile"><AppWindow aria-hidden="true" /></span>
                  <span className="browser-side-result-name">{artifact.title ?? artifact.url}</span>
                </ExternalLink>
              </li>;
            })}
          </ul>}
      </section>
      <section className="browser-side-section" aria-labelledby="browser-side-tabs">
        <h2 className="browser-side-heading" id="browser-side-tabs"><span>{t("Tabs the agents use")}</span><span className="browser-side-count">{agentTabs.length}</span></h2>
        {agentTabs.length === 0
          ? <p className="browser-side-empty">{t("No agent is using a tab.")}</p>
          : agentTabs.map((tab) => <TabCard key={tab.id} tab={tab} agent={tab.owner === null ? null : agentOf(tab.owner)} onOpen={() => onOpen(tab.id)} />)}
      </section>
    </aside>
  );
}

function ResultRow({ result, time }: { result: DesktopBrowserResult; time: ReturnType<typeof formatChatTimestamp> }) {
  const t = useT();
  const Icon = result.kind === "screenshot" ? ImageIcon : Download;
  const meta = [
    result.kind === "screenshot" ? t("Screenshot") : result.done ? t("Download") : t("Downloading…"),
    result.bytes === null ? null : formatBytes(result.bytes),
    time?.label,
  ].filter(Boolean).join(" · ");
  return <li>
    <button type="button" className="browser-side-result" disabled={!result.done} aria-label={`${result.name}, ${meta}`} title={`${t("Show in folder")}: ${result.name} · ${meta}`} onClick={() => revealBrowserResult(result.id)}>
      <span className="browser-side-result-tile"><Icon aria-hidden="true" /></span>
      <span className="browser-side-result-name">{result.name}</span>
    </button>
  </li>;
}

function TabCard({ tab, agent, onOpen }: { tab: DesktopBrowserTab; agent: string | null; onOpen: () => void }) {
  const t = useT();
  const [picture, setPicture] = useState<string | null>(null);
  // a live picture: taken when the page settles and every few seconds after; main takes it on request and keeps none
  useEffect(() => {
    if (tab.loading) return;
    let alive = true;
    // nothing to look at while the app is hidden or minimised
    // a picture that no longer comes (the app could not draw the tab) is not kept as if it were live
    let missed = 0;
    const take = () => {
      if (document.visibilityState === "hidden") return;
      void browserTabThumbnail(tab.id).then((next) => {
        if (!alive) return;
        missed = next === null ? missed + 1 : 0;
        if (next !== null) setPicture(next);
        else if (missed >= CARD_PICTURE_MISSES) setPicture(null);
      });
    };
    take();
    const timer = setInterval(take, CARD_PICTURE_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [tab.id, tab.loading, tab.address]);
  const name = tab.title || tab.address;
  const who = tab.held ? t("You have control") : agent ? t("{agent} is using it", { agent: agentName(agent) }) : t("An agent is using it");
  return (
    <article className="browser-side-card" aria-label={name}>
      <header className="browser-side-card-head">
        <Globe aria-hidden="true" />
        <span className="browser-side-card-title" title={tab.address}>{name}</span>
        <button type="button" className="icon-button browser-side-card-close" aria-label={t("Close tab")} title={t("Close tab")} onClick={() => closeBrowserTab(tab.id)}><X aria-hidden="true" /></button>
      </header>
      <button type="button" className="browser-side-card-open" aria-label={t("Open {name}", { name })} onClick={onOpen}>
        <span className="browser-side-card-shot">{picture !== null && <img src={picture} alt="" />}</span>
        <span className={`browser-side-card-who${tab.held ? " is-held" : ""}`}>{who}</span>
      </button>
    </article>
  );
}
