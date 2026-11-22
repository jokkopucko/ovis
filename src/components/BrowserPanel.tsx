import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Bot, Globe, RotateCw, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { goBrowserTab, hideBrowserTab, holdBrowserTab, navigateBrowserTab, openBrowserTab, showBrowserTab, typedAddress, type DesktopBrowserTab } from "../lib/desktopBrowser.ts";
import "./FileViewer.css";
import "./BrowserPanel.css";

export interface BrowserPanelProps {
  /** the tab shown, or null for a new tab of the person's own that has no address yet */
  tab: DesktopBrowserTab | null;
  onOpened: (id: number) => void;
  onClose: () => void;
  panelStart?: ReactNode;
  /** a dialog is over the panel: the tab, drawn by the app above the page, steps aside for it */
  covered?: boolean;
}

/**
 * A tab of the desktop app's built-in browser in the file panel's place. The app draws the page
 * itself over this panel's body (app/electron/src/browserTabs.ts), which reports where it is. An
 * agent's tab is only watched until the person takes control of it; the agent waits meanwhile.
 */
export function BrowserPanel({ tab, onOpened, onClose, panelStart, covered = false }: BrowserPanelProps) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  const [refused, setRefused] = useState(false);
  const id = tab?.id ?? null;
  const steered = tab !== null && (tab.profile === "mine" || tab.held);

  useLayoutEffect(() => {
    const place = body.current;
    if (id === null || covered || place === null) {
      hideBrowserTab();
      return;
    }
    const show = () => {
      const { x, y, width, height } = place.getBoundingClientRect();
      showBrowserTab(id, { x, y, width, height });
    };
    show();
    const resized = new ResizeObserver(show);
    resized.observe(place);
    window.addEventListener("resize", show);
    return () => {
      resized.disconnect();
      window.removeEventListener("resize", show);
      hideBrowserTab();
    };
  }, [id, covered]);

  // which address form an answer from main belongs to: a new tab's form left (closed, or another tab shown) drops its answer
  const form = useRef(0);
  useEffect(() => { form.current += 1; }, [tab?.id]);
  useEffect(() => () => { form.current = -1; }, []);

  const go = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // an agent's tab is only watched until taken: Enter in its read-only address does nothing
    if (tab !== null && !steered) return;
    const address = typedAddress(new FormData(event.currentTarget).get("address")?.toString() ?? "");
    if (address === null) {
      setRefused(true);
      return;
    }
    const asked = form.current;
    const opened = tab === null ? openBrowserTab(address).then((opened) => { if (opened !== null && form.current === asked) onOpened(opened); return opened !== null; }) : navigateBrowserTab(tab.id, address);
    void opened.then((done) => { if (form.current === asked) setRefused(!done); });
  };

  const title = tab === null ? t("New tab") : tab.title || tab.address;
  return (
    <div className="file-panel web-panel browser-panel">
      {panelStart}
      <section className="file-viewer file-viewer-docked" aria-label={title}>
        <header className="file-viewer-header file-viewer-header-docked">
          {tab?.profile === "agent" ? <Bot aria-hidden="true" className="file-viewer-glyph" /> : <Globe aria-hidden="true" className="file-viewer-glyph" />}
          <div className="file-viewer-actions">
            <button type="button" className="icon-button file-viewer-action" aria-label={t("Back")} title={t("Back")} disabled={!steered || !tab.canGoBack} onClick={() => tab && goBrowserTab(tab.id, "back")}><ArrowLeft aria-hidden="true" /></button>
            <button type="button" className="icon-button file-viewer-action" aria-label={t("Forward")} title={t("Forward")} disabled={!steered || !tab.canGoForward} onClick={() => tab && goBrowserTab(tab.id, "forward")}><ArrowRight aria-hidden="true" /></button>
            <button type="button" className="icon-button file-viewer-action" aria-label={t("Reload page")} title={t("Reload page")} disabled={!steered} onClick={() => tab && goBrowserTab(tab.id, "reload")}><RotateCw aria-hidden="true" /></button>
          </div>
          <form className="browser-panel-address" onSubmit={go}>
            <input key={`${id}:${tab?.address ?? ""}`} name="address" className="input" defaultValue={tab?.address ?? ""} readOnly={tab !== null && !steered} aria-label={t("Address")} placeholder={t("Type an address")}
              aria-invalid={refused || undefined} autoFocus={tab === null} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" onChange={() => setRefused(false)} />
          </form>
          {/* back to the panel: the tab stays open (the sidebar's row and the card close it) */}
          <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close")} title={t("Close")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {tab?.profile === "agent" && <div className={`browser-panel-holder${tab.held ? " is-held" : ""}`}>
          <span>{tab.held ? t("You have control · the agent waits") : t("An agent is using this tab")}</span>
          <button type="button" className={`btn btn-sm${tab.held ? " btn-primary" : ""}`} onClick={() => holdBrowserTab(tab.id, !tab.held)}>{tab.held ? t("Stop") : t("Take control")}</button>
        </div>}
        {refused && <p className="browser-panel-refused" role="alert">{t("This address can't be opened in the built-in browser.")}</p>}
        <div ref={body} className="file-viewer-body browser-panel-body">
          {tab === null && <p className="browser-panel-hint">{t("Type an address to open it in a tab of your own. Its cookies stay apart from the agents' tabs.")}</p>}
        </div>
      </section>
    </div>
  );
}
