import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, Bell, Bot, NotebookPen, ChevronRight, FlaskConical, Info, Keyboard, MessageSquare, Palette, Search, Smartphone, SquareTerminal, X, type LucideIcon } from "lucide-react";

import "./SettingsDialog.css";

import type { AppActions } from "../lib/actions.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import { focusInOtherModal, useFocusTrap } from "../lib/useFocusTrap.ts";
import { KeyBarSettings } from "./KeyBarSettings.tsx";
import { onSettingsHistory, recordSettings, settingsEntry, settingsLevels, type SettingsLevel } from "../lib/settingsHistory.ts";
import { SettingsQuery, settingsQueryWords } from "./SettingsControls.tsx";
import type { UpdatesModel } from "../lib/updates.ts";
import type { UserError } from "../lib/userError.ts";
import { type HerdrCoreFacts, type HerdrRuntimeFacts, type Machine, type MachineSettings } from "../../shared/machines.ts";
import { fetchMemory, machineRequest } from "../lib/api.ts";
import type { PushActionResult } from "../lib/pushHealth.ts";
import type { HealthAuth } from "../../shared/protocol.ts";
import type { SecurityFacts } from "../lib/useAccess.ts";
import { AgentsSettings } from "./AgentsSettings.tsx";
import { MemorySettings } from "./MemorySettings.tsx";
import { AppearancePage } from "./SettingsAppearancePage.tsx";
import { ChatPage } from "./SettingsChatPage.tsx";
import { TerminalPage } from "./SettingsTerminalPage.tsx";
import { AlertsPage } from "./SettingsAlertsPage.tsx";
import { ExperimentalPage } from "./SettingsExperimentalPage.tsx";
import { ShortcutsPage } from "./SettingsShortcutsPage.tsx";
import { DevicesPage } from "./SettingsDevicesPage.tsx";
import { AboutPage } from "./SettingsAboutPage.tsx";
import type { MemoryView } from "../../shared/memory.ts";
import { waitingNotes } from "../lib/memory.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { CrashProbe, RegionCrash } from "./AppCrash.tsx";
import { RenderBoundary } from "./RenderBoundary.tsx";
import { requestedSettingsPage, requestSettingsPage, type SettingsPageId } from "../lib/paletteSettings.ts";
import { currentSettingsPage } from "../lib/deepLink.ts";
import "./BrowserPanel.css";

export interface SettingsDialogProps {
  open: boolean;
  /** this PC lists account-opens-all/1 now (its step-2 switch is on), from the local socket's features */
  opensAll?: () => boolean;
  /** this PC's last feature list lacked account-opens-all/1 (an explicit withdrawal, S32-1) */
  withdrawn?: () => boolean;
  section?: "updates" | null;
  linkPage?: string | null;
  linkSection?: string | null;
  onPage?: (page: string | null) => void;
  onClose: () => void;
  onUsageLogin: (paneId: string) => void;
  onOpenPane: (machineId: string, paneId: string) => void;
  actions: AppActions;
  updates: UpdatesModel;
  auth: HealthAuth | null;
  herdrVersion: string | null;
  herdrRuntime?: "herdr" | "herdr-core" | null;
  herdrCore?: HerdrCoreFacts | null;
  herdrRuntimeFacts?: HerdrRuntimeFacts | null;
  picturesByDefault?: boolean;
  bootId?: string | null;
  onServerRestarted?: () => void;
  /** what protects this server, from the last bridge health check: never an earlier answer once one fails */
  security: SecurityFacts;
  onEnableNotifications: () => Promise<PushActionResult>;
  saveError: UserError | null;
  savePaused: boolean;
  saveRetrying: boolean;
  onRetrySave: () => void;
  overPreview?: boolean;
  machines?: readonly Machine[];
  /** the selected pane's folder on this PC: Settings → Memory opens on its project */
  projectFolder?: string | null;
}

/**
 * The access facts as the app last heard them: `absent` is a server that answered without them
 * (an older one), `error` one that did not answer. Neither is ever filled in from `auth` or from
 * the missing LAN warning.
 */

type SettingsPage = SettingsPageId;

function openFolds(group: HTMLElement): void {
  for (let fold = group.closest("details"); fold !== null; fold = fold.parentElement?.closest("details") ?? null) fold.open = true;
}

export const PAGES: readonly { id: SettingsPage; icon: LucideIcon }[] = [
  { id: "appearance", icon: Palette },
  { id: "chat", icon: MessageSquare },
  { id: "terminal", icon: SquareTerminal },
  { id: "alerts", icon: Bell },
  { id: "agents", icon: Bot },
  { id: "memory", icon: NotebookPen },
  { id: "shortcuts", icon: Keyboard },
  { id: "devices", icon: Smartphone },
  { id: "experimental", icon: FlaskConical },
  { id: "about", icon: Info },
];

/** Literal `t()` calls, so the dictionaries' checks find each key. */
function pageNote(t: Translate, page: SettingsPage): string | null {
  switch (page) {
    case "appearance": return t("Theme and language apply on every device; fonts, sizes and density on this device.");
    case "chat": return t("How conversations look and what the message box offers.");
    case "terminal": return t("How terminal panes look and take input.");
    case "alerts": return t("When this device alerts you, and where else alerts go.");
    case "agents": return t("Coding agents on this PC, their accounts and plan limits.");
    case "memory": return t("Notes kept for your agents. Agents do not get them yet; later they get only notes you confirmed.");
    case "shortcuts": return t("Keyboard shortcuts, and herdr's prefix keys.");
    case "experimental": return t("Features still being shaped; they may change.");
    default: return null;
  }
}

const NARROW_QUERY = "(max-width: 640px)";

const useNarrow = (): boolean => useMediaQuery(NARROW_QUERY);

function shownBy(entry: SettingsLevel | null): { page: SettingsPage | null; keyBar: boolean } | null {
  if (entry === null) return null;
  const page = PAGES.find(({ id }) => id === (entry.page === null ? null : currentSettingsPage(entry.page)))?.id ?? null;
  return page === null && entry.page !== null ? null : { page, keyBar: entry.keyBar && page === "terminal" };
}

const MOVED_GROUPS: Readonly<Record<string, string>> = { phone: "devices", remote: "devices", portal: "devices", "chat-more": "conversation" };

export function SettingsDialog(props: SettingsDialogProps) {
  return props.open ? <RenderBoundary resetKey={null} fallback={() => <SettingsCrash onClose={props.onClose} overPreview={props.overPreview ?? false} />}>
    <CrashProbe region="settings" />
    <OpenSettingsDialog {...props} />
  </RenderBoundary> : null;
}

function SettingsCrash({ onClose, overPreview }: { onClose: () => void; overPreview: boolean }) {
  const t = useT();
  useEffect(() => { recordSettings([{ page: null, keyBar: false }]); }, []);
  const closeRef = useRef<HTMLButtonElement>(null);
  const surface = useFocusTrap<HTMLDivElement>(true, { initialFocus: closeRef });
  useSheetSwipe(surface, onClose);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return (
    <div className={overPreview ? "modal-scrim settings-over-preview" : "modal-scrim"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={surface} className="modal" role="dialog" aria-modal="true" aria-label={t("Settings")} tabIndex={-1}>
        <RegionCrash message={t("Settings can't be shown.")} retry={onClose} retryLabel={t("Close")} buttonRef={closeRef} />
      </div>
    </div>
  );
}

function SaveFailure({ error, paused, retrying, onRetry }: { error: UserError; paused: boolean; retrying: boolean; onRetry: () => void }) {
  const t = useT();
  return <div className="settings-save-error" role="alert" data-paused={paused || undefined}>
    {error.detail === null ? <p>{error.message}</p> : <details className="settings-details">
      <summary>{error.message}<span className="settings-details-toggle">{t("Details")}</span></summary>
      <code>{error.detail}</code>
    </details>}
    <div className="settings-save-local">
      <p>{retrying ? t("Sending the change to the server…") : t("Not saved on the server yet; reloading or closing this page can undo the change.")}</p>
      <button type="button" className="btn" disabled={retrying} aria-busy={retrying} onClick={onRetry}>{t("Retry")}</button>
    </div>
  </div>;
}

function matchedGroups(result: Element | null, words: readonly string[]): string[] {
  if (!result) return [];
  const groups = [...result.querySelectorAll<HTMLElement>("[data-section]")].filter((group) => group.querySelector(".settings-row, .settings-item") !== null);
  const holdsAll = (group: HTMLElement) => { const text = (group.textContent ?? "").toLowerCase(); return words.every((word) => text.includes(word.toLowerCase())); };
  return [...groups.filter(holdsAll), ...groups.filter((group) => !holdsAll(group))].map((group) => group.dataset["section"]).filter((name): name is string => name !== undefined);
}

function OpenSettingsDialog({ section = null, linkPage = null, linkSection = null, onPage, onClose, onUsageLogin, onOpenPane, actions, updates, auth, herdrVersion, herdrRuntime = null, herdrCore = null, herdrRuntimeFacts = null, picturesByDefault = false, bootId = null, onServerRestarted, security, onEnableNotifications, saveError, savePaused, saveRetrying, onRetrySave, overPreview = false, machines = [], opensAll, withdrawn, projectFolder = null }: SettingsDialogProps) {
  const t = useT();
  const narrow = useNarrow();
  const [restored] = useState(() => shownBy(settingsEntry(window.history.state)));
  const linked = PAGES.find((candidate) => candidate.id === currentSettingsPage(linkPage))?.id ?? null;
  // the request is read, not taken, so a remount in development finds it again
  const [asked] = useState(requestedSettingsPage);
  useEffect(() => requestSettingsPage(null), []);
  const [chosen, setChosen] = useState<SettingsPage | null>(section === "updates" ? "about" : asked?.page ?? (restored ? restored.page : linked));
  const page = chosen ?? (narrow ? null : PAGES[0]!.id);
  const [keyBarOpen, setKeyBarOpen] = useState(section === "updates" ? false : restored?.keyBar ?? false);
  useEffect(() => { recordSettings(settingsLevels(narrow, page, keyBarOpen)); }, [narrow, page, keyBarOpen]);
  useEffect(() => { onPage?.(page); }, [onPage, page]);
  useEffect(() => onSettingsHistory((entry, own) => {
    const view = own ? null : shownBy(entry);
    if (view === null) return;
    setChosen(view.page);
    setKeyBarOpen(view.keyBar);
  }), []);
  const keyBarButtonRef = useRef<HTMLButtonElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const settingsScrollRef = useRef(0);
  const surface = useFocusTrap<HTMLElement>(true, { initialFocus: backRef });
  useSheetSwipe(surface, onClose);
  const shown = useRef<{ page: SettingsPage | null; keyBar: boolean } | null>(null);
  const following = useRef<{ group: HTMLElement; page: SettingsPage | null } | null>(null);
  const awaited = useRef<{ named: string; page: SettingsPage | null } | null>(null);
  const label = (id: SettingsPage): string => t(id === "appearance" ? "Appearance" : id === "chat" ? "Chat" : id === "terminal" ? "Terminal" : id === "alerts" ? "Alerts" : id === "agents" ? "Agents" : id === "memory" ? "Memory|notes" : id === "shortcuts" ? "Shortcuts" : id === "devices" ? "Devices and PCs" : id === "experimental" ? "Experimental" : "About");
  const openPage = (id: SettingsPage): void => { setKeyBarOpen(false); setChosen(id); };
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const words = useMemo(() => settingsQueryWords(query), [query]);
  const searching = words.length > 0 && !keyBarOpen && (!narrow || page === null);
  const landing = useRef<{ page: SettingsPage; sections: string[] } | null>(null);
  const openFromSearch = (id: SettingsPage, groups: string[] = []): void => {
    if (id === page && !searching && !keyBarOpen) return;
    landing.current = { page: id, sections: groups }; setQuery(""); openPage(id);
  };
  const openKeyBar = (): void => {
    settingsScrollRef.current = settingsBodyRef.current?.scrollTop ?? 0;
    if (query !== "") {
      setQuery("");
      setChosen("terminal");
      settingsScrollRef.current = 0;
    }
    setKeyBarOpen(true);
  };
  const goBack = (): void => {
    if (keyBarOpen) setKeyBarOpen(false);
    else setChosen(null);
  };
  const tab = (id: SettingsPage | null): HTMLElement | null => tabsRef.current?.querySelector<HTMLElement>(id === null ? '[role="tab"]' : `[data-settings-page="${id}"]`) ?? null;
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = { page, keyBar: keyBarOpen };
    const landed = landing.current;
    if (keyBarOpen) backRef.current?.focus();
    else if (!searching && landed !== null && landed.page === page) {
      landing.current = null;
      const groups = landed.sections.map((name) => settingsBodyRef.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(name)}"]`) ?? null).filter((group): group is HTMLElement => group !== null);
      for (const group of groups) openFolds(group);
      const first = groups[0];
      if (first) {
        first.focus({ preventScroll: true });
        first.scrollIntoView({ block: "start" });
        following.current = { group: first, page };
      } else {
        if (narrow) backRef.current?.focus();
        else tab(page)?.focus();
        const named = landed.sections[0];
        if (named !== undefined) awaited.current = { named, page };
      }
    } else if (before?.keyBar && before.page === page) {
      if (settingsBodyRef.current) settingsBodyRef.current.scrollTop = settingsScrollRef.current;
      keyBarButtonRef.current?.focus({ preventScroll: true });
    } else if (before === null) {
      const asName = section === "updates" ? "updates" : asked?.section ?? (linked && linkSection ? linkSection : null);
      const named = asName === null ? null : MOVED_GROUPS[asName] ?? asName;
      const pointed = named ? settingsBodyRef.current?.querySelector<HTMLElement>(`[data-section="${CSS.escape(named)}"]`) : null;
      if (pointed) {
        openFolds(pointed);
        pointed.focus({ preventScroll: true });
        pointed.scrollIntoView();
        following.current = { group: pointed, page };
      } else {
        tab(page)?.focus();
        if (named) awaited.current = { named, page };
      }
    } else if (before.page !== page && narrow) {
      if (page !== null) backRef.current?.focus();
      else tab(before.page)?.focus();
    }
    // The subscription is made again whenever this runs, so development's replay of the effect
    // keeps following
    const body = settingsBodyRef.current;
    const wait = awaited.current;
    if (wait !== null && (wait.page !== page || keyBarOpen)) awaited.current = null;
    else if (wait !== null && body) {
      const moves = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
      const unsubscribe = (): void => {
        observer.disconnect();
        for (const move of moves) body.removeEventListener(move, stop);
      };
      const stop = (): void => { awaited.current = null; unsubscribe(); };
      const observer = new MutationObserver(() => {
        const group = body.querySelector<HTMLElement>(`[data-section="${CSS.escape(wait.named)}"]`);
        if (!group) return;
        stop();
        openFolds(group);
        group.focus({ preventScroll: true });
        group.scrollIntoView();
      });
      observer.observe(body, { childList: true, subtree: true });
      for (const move of moves) body.addEventListener(move, stop, { passive: true });
      return unsubscribe;
    }
    const follow = following.current;
    if (follow === null || follow.page !== page || keyBarOpen) { following.current = null; return; }
    const observer = new ResizeObserver(() => follow.group.scrollIntoView());
    const moves = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const unsubscribe = (): void => {
      observer.disconnect();
      for (const move of moves) body?.removeEventListener(move, stop);
    };
    const stop = (): void => { following.current = null; unsubscribe(); };
    observer.observe(follow.group);
    for (const move of moves) body?.addEventListener(move, stop, { passive: true });
    return unsubscribe;
  }, [page, keyBarOpen, narrow, section, searching]);
  const [memory, setMemory] = useState<{ view: MemoryView | null; error: string | null }>({ view: null, error: null });
  const memoryReads = useRef(0);
  const loadMemory = useCallback(async () => {
    // an answer to an older read that comes in after a newer one is dropped
    const read = ++memoryReads.current;
    try { const view = await fetchMemory(projectFolder); if (read === memoryReads.current) setMemory({ view, error: null }); }
    catch (error) { if (read === memoryReads.current) setMemory((now) => ({ view: now.view, error: error instanceof Error ? error.message : String(error) })); }
  }, [projectFolder]);
  useEffect(() => { void loadMemory(); }, [loadMemory]);
  const memoryWaiting = waitingNotes(memory.view).length;
  const [pcSettings, setPcSettings] = useState<MachineSettings | null>(null);
  const [pcSettingsError, setPcSettingsError] = useState<string | null>(null);
  useEffect(() => {
    if (page !== "devices" && page !== "about" && !searching) return;
    let live = true;
    machineRequest<MachineSettings>("/settings").then((settings) => { if (live) setPcSettings(settings); }, () => { if (live) setPcSettings(null); });
    return () => { live = false; };
  }, [page, searching]);
  const updatePcSettings = async (patch: Partial<MachineSettings>) => {
    try { setPcSettings(await machineRequest<MachineSettings>("/settings", "PATCH", patch)); setPcSettingsError(null); }
    catch (e) { setPcSettingsError(e instanceof Error ? e.message : String(e)); }
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      // an Escape that cancels an IME composition (the editor's Character field) is the IME's, and one that
      // closed Files drawn over Settings (focused by a click) is spent: one Escape closes one dialog
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (!overPreview && focusInOtherModal(surface.current)) return;
      event.preventDefault();
      if (keyBarOpen) setKeyBarOpen(false);
      else if (query !== "") {
        setQuery("");
        searchRef.current?.focus();
      } else onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, keyBarOpen, overPreview, query]);

  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void => {
    const to = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? PAGES.length - 1 : null;
    if (to === null) return;
    event.preventDefault();
    const next = PAGES[(to + PAGES.length) % PAGES.length]!.id;
    tab(next)?.focus();
    if (!narrow) openFromSearch(next);
  };

  const body = (page: SettingsPage): ReactNode => {
    switch (page) {
      case "appearance": return <AppearancePage />;
      case "chat": return <ChatPage />;
      case "terminal": return <TerminalPage keyBarButtonRef={keyBarButtonRef} onEditKeyBar={openKeyBar} picturesByDefault={picturesByDefault} />;
      case "alerts": return <AlertsPage onEnableNotifications={onEnableNotifications} machines={machines} />;
      case "agents": return <AgentsSettings watching={auth?.role === "watch"} agentCalls={herdrRuntime === "herdr-core"} onLocalLogin={onUsageLogin} onOpenPane={onOpenPane} onOpenGuide={onClose} />;
      case "memory": return <MemorySettings view={memory.view} loadError={memory.error} reload={loadMemory} watching={auth?.role === "watch"} />;
      case "shortcuts": return <ShortcutsPage />;
      // after every device went, its own pairing included, a browser asks the server where it stands: the roster answers, or the gate does
      case "devices": return <DevicesPage opensAll={opensAll} withdrawn={withdrawn} auth={auth} security={security} onSignOut={actions.lock} onRevokedAll={actions.refresh} openAddPc={actions.openAddPc} connectPc={actions.connectPc} onHome={onClose}
        machines={machines} pcSettings={pcSettings} pcSettingsError={pcSettingsError} onPcSettings={(patch) => void updatePcSettings(patch)} />;
      case "experimental": return <ExperimentalPage />;
      case "about": return <AboutPage updates={updates} herdrVersion={herdrVersion} herdrRuntime={herdrRuntime} herdrCore={herdrCore} herdrRuntimeFacts={herdrRuntimeFacts} bootId={bootId} onServerRestarted={onServerRestarted} onOpenPane={onOpenPane} bridgesFollow={pcSettings?.auto_update_bridges === true} />;
      default: return null;
    }
  };
  const listShown = !narrow || (page === null && !keyBarOpen);
  const focusable = page ?? PAGES[0]!.id;

  return (
    <div className={overPreview ? "modal-scrim settings-over-preview" : "modal-scrim"} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {/* named Settings on every page: the page's own name is the visible title */}
      <section ref={surface} className={searching ? "modal settings-dialog is-searching" : "modal settings-dialog"} role="dialog" aria-modal="true" aria-label={keyBarOpen ? t("Key bar") : t("Settings")} tabIndex={-1}>
        <header className="modal-header settings-header">
          {(keyBarOpen || (narrow && page !== null)) && <button type="button" ref={backRef} className="icon-button" aria-label={t("Back to settings")} title={t("Back to settings")} onClick={goBack}><ArrowLeft aria-hidden="true" /></button>}
          <h2 className="modal-title">{keyBarOpen ? t("Key bar") : searching && !narrow ? t("Search results") : page === null ? t("Settings") : label(page)}</h2>
          <button type="button" className="icon-button" aria-label={t("Close settings")} title={t("Close settings")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        {listShown && (
          <nav className="settings-nav" aria-label={t("Settings")}>
            <p className="settings-nav-title" aria-hidden="true">{t("Settings")}</p>
            <div className="settings-search">
              <Search aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                className="input settings-search-input"
                value={query}
                placeholder={t("Search settings")}
                aria-label={t("Search settings")}
                aria-controls={searching ? "settings-search-results" : undefined}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div ref={tabsRef} className="settings-tabs" role="tablist" aria-orientation="vertical" hidden={searching && narrow}>
              {PAGES.map(({ id, icon: Icon }, index) => (
                <button key={id} type="button" role="tab" className="settings-tab" data-settings-page={id} aria-selected={!searching && page === id} aria-controls={!searching && page === id ? "settings-panel" : undefined} tabIndex={focusable === id ? 0 : -1} onClick={() => openFromSearch(id)} onKeyDown={(event) => onTabKey(event, index)}>
                  <Icon aria-hidden="true" />
                  <span>{label(id)}</span>
                  {id === "memory" && memoryWaiting > 0 && <span className="settings-tab-count" aria-label={t("{count} waiting for you", { count: memoryWaiting })}>{memoryWaiting}</span>}
                  <ChevronRight className="settings-tab-chevron" aria-hidden="true" />
                </button>
              ))}
            </div>
          </nav>
        )}
        {searching ? (
          <div id="settings-search-results" className="modal-body settings-body settings-search-results" role="region" aria-label={t("Search results")}>
            {saveError !== null && <SaveFailure error={saveError} paused={savePaused} retrying={saveRetrying} onRetry={onRetrySave} />}
            <p className="settings-search-empty" role="status">{t("No settings match.")}</p>
            <SettingsQuery.Provider value={words}>
              {PAGES.map(({ id }) => (
                <section key={id} className="settings-search-page" aria-label={label(id)}>
                  <button type="button" className="settings-search-page-title" aria-label={t("Open {page}", { page: label(id) })} title={t("Open {page}", { page: label(id) })}
                  onClick={(event) => openFromSearch(id, matchedGroups(event.currentTarget.closest(".settings-search-page"), words))}>
                    <span>{label(id)}</span>
                    <ChevronRight aria-hidden="true" />
                  </button>
                  {body(id)}
                </section>
              ))}
            </SettingsQuery.Provider>
          </div>
        ) : page !== null && <div key={page} ref={settingsBodyRef} id="settings-panel" className="modal-body settings-body" role="tabpanel" aria-label={label(page)} hidden={keyBarOpen}>{saveError !== null && <SaveFailure error={saveError} paused={savePaused} retrying={saveRetrying} onRetry={onRetrySave} />}{pageNote(t, page) !== null && <p className="settings-page-note">{pageNote(t, page)}</p>}{body(page)}</div>}
        {keyBarOpen && <div className="modal-body settings-key-bar-body"><KeyBarSettings /></div>}
      </section>
    </div>
  );
}
