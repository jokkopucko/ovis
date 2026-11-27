import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ALargeSmall, ArrowDownUp, ChevronLeft, ChevronRight, CircleDot, FileText, Filter, Gauge, Inbox, Languages, Layers, ListTree, MessageSquare, MousePointer2, Palette, PanelLeft, Rows3, Search, Shapes, Smartphone, SquareTerminal, SunMoon, Tag, Type } from "lucide-react";

import { CHAT_FONT_MAX, CHAT_FONT_MIN, chatFontSize, DEFAULT_SETTINGS, MARKDOWN_STYLES, TERMINAL_FONT_MAX, TERMINAL_FONT_MIN, phoneInboxOn, useSettings, uiFontSize, type MarkdownStyle } from "../lib/settings.ts";
import { isThemeId, pickTheme, rowFor, THEME_IDS, type Mode, type ThemeId } from "../lib/themes.ts";
import { chosenTheme, customRow, customRowId, type CustomTheme } from "../lib/customThemes.ts";
import { LANGUAGE_NAMES, LANGUAGE_SETTINGS, useT, type Translate } from "../lib/i18n.ts";
import { FileTextSizeRow } from "./FileTextSizeRow.tsx";
import { FoldHelpersRow } from "./FoldHelpersRow.tsx";
import { ThemeFiles, themeLabel } from "./ThemeFiles.tsx";
import { THEME_NAMES, ThemeCard } from "./ThemeCard.tsx";
import { SettingsBare, Segmented, SettingsFold, SettingsGroup, SettingsRow, SettingsSelect, Stepper, Toggle, useSettingsRowSentence } from "./SettingsControls.tsx";
import { FONT_FAMILY_MAX_CHARS, sanitizeFontFamily } from "../lib/fontFamily.ts";
import { UI_FONT_MAX, UI_FONT_MIN, UI_FONT_PRESET_FAMILY, uiFontPreset, type UiFontPreset } from "../lib/typography.ts";
import { canListInstalledFonts, filterFamilies, isMonospaceFamily, queryInstalledFonts } from "../lib/installedFonts.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";

const FONT_LIST_LIMIT = 150;
const FONT_FAMILY_PLACEHOLDER = 'D2Coding, "Cascadia Mono"';
const UI_FONT_PLACEHOLDER = '"Noto Sans JP", "Segoe UI"';

/**
 * A font family list, saved when the field is left, on Enter or when the dialog closes: saving
 * every keystroke would sanitize away the comma or space being typed, and each change of the
 * terminal's font refits the grid and resizes the pane.
 */
function FontFamilyInput({ value, label, onCommit, placeholder = FONT_FAMILY_PLACEHOLDER, fixedWidthFor = null }: { value: string; label: string; onCommit: (family: string) => void; placeholder?: string; /** the surface that needs every glyph on one advance: a proportional pick from the list is refused in its name */ fixedWidthFor?: "terminal" | null }) {
  const t = useT();
  const sentence = useSettingsRowSentence();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // typed and not yet saved: only that is saved when the field goes, never a value put back meanwhile (a row's ↺)
  const typed = useRef(false);
  const commit = (): void => {
    typed.current = false;
    const next = sanitizeFontFamily(draft);
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  // closing the dialog with Escape unmounts the field without a blur
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => { if (typed.current) commitRef.current(); }, []);
  const [families, setFamilies] = useState<string[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState("");
  const [refused, setRefused] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  // the click is the gesture the permission prompt needs
  const browse = async (): Promise<void> => {
    if (browsing) {
      setBrowsing(false);
      return;
    }
    setRefused("");
    setQuery("");
    if (families === null) {
      const result = await queryInstalledFonts();
      if (result.status !== "granted") {
        setUnavailable(true);
        return;
      }
      setUnavailable(false);
      setFamilies(result.families);
    }
    setBrowsing(true);
  };
  const matches = useMemo(() => filterFamilies(families ?? [], query), [families, query]);
  const pick = (family: string): void => {
    if (fixedWidthFor !== null && !isMonospaceFamily(family)) {
      setRefused(family);
      return;
    }
    const next = sanitizeFontFamily(family);
    setDraft(next);
    setBrowsing(false);
    if (next !== value) onCommit(next);
  };
  return (
    <div className="settings-font-field">
      <div className="settings-font-line">
        <input
          className="input settings-font-input"
          value={draft}
          placeholder={placeholder}
          maxLength={FONT_FAMILY_MAX_CHARS}
          aria-label={label}
          aria-describedby={sentence}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => { typed.current = true; setDraft(event.target.value); }}
          onBlur={commit}
          onKeyDown={(event) => {
            // an IME keeps its Enter, including the committing one WebKit can send after compositionend as key code 229
            if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            event.preventDefault();
            commit();
          }}
        />
        {canListInstalledFonts() && (
          <button type="button" className="btn settings-font-browse" aria-expanded={browsing} aria-label={t("Browse installed fonts for {label}", { label })} aria-describedby={sentence} onClick={() => void browse()}>
            <Search aria-hidden="true" />
            {t("Browse")}
          </button>
        )}
      </div>
      {unavailable && <p className="settings-font-note" role="status">{t("Installed fonts could not be listed. Type the name instead.")}</p>}
      {browsing && families !== null && (
        <div className="settings-font-picker">
          <input
            className="input settings-font-search"
            type="search"
            value={query}
            placeholder={t("Search fonts")}
            aria-label={t("Search fonts")}
            spellCheck={false}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.stopPropagation();
                setBrowsing(false);
              }
            }}
          />
          {refused !== "" && <p className="settings-font-note" role="status">{t("{font} is not monospace. The terminal needs a fixed-width font, so the current font was kept.", { font: refused })}</p>}
          <ul className="settings-font-list" aria-label={t("Installed fonts")}>
            {matches.slice(0, FONT_LIST_LIMIT).map((family) => (
              <li key={family}>
                <button type="button" className="settings-font-option" style={{ fontFamily: `"${family}", var(--font-ui)` }} onClick={() => pick(family)}>
                  {family}
                </button>
              </li>
            ))}
            {matches.length === 0 && <li className="settings-font-empty">{t("No fonts found")}</li>}
          </ul>
          {matches.length > FONT_LIST_LIMIT && <p className="settings-font-note">{t("Showing the first {count} fonts. Search to narrow the list.", { count: FONT_LIST_LIMIT })}</p>}
        </div>
      )}
    </div>
  );
}

function SidebarRowsPreview({ rows }: { rows: "one" | "two" }) {
  return (
    <span className={rows === "two" ? "sidebar-rows-preview is-two" : "sidebar-rows-preview"}>
      {[0, 1].map((item) => <span key={item} className="sidebar-rows-preview-item"><i />{rows === "two" && <i />}</span>)}
    </span>
  );
}

function ThemePicker() {
  const { settings, update } = useSettings();
  const t = useT();
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const drawn: Mode = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  const [picked, setPicked] = useState<Mode | null>(null);
  const side = picked ?? drawn;
  const strip = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ start: true, end: true });
  const custom = settings.customThemes;
  const imported = chosenTheme(custom, side);
  const current = imported ? customRowId(imported.id) : side === "dark" ? settings.darkTheme : settings.lightTheme;
  const other: Mode = side === "dark" ? "light" : "dark";
  const own = THEME_IDS.filter((id) => rowFor(id, side).mode === side);
  const others = THEME_IDS.filter((id) => rowFor(id, side).mode === other);
  const label = t(side === "dark" ? "Dark theme" : "Light theme");
  const measure = useCallback(() => {
    const el = strip.current;
    if (el) setEnds({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
  }, []);
  useLayoutEffect(() => {
    const el = strip.current;
    const card = el?.querySelector<HTMLElement>(`[data-theme-card="${current}"]`);
    const shown = el && card && card.offsetLeft >= el.scrollLeft && card.offsetLeft + card.offsetWidth <= el.scrollLeft + el.clientWidth;
    if (el && card && !shown) el.scrollLeft = card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2;
    measure();
  }, [side, current, measure]);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const pick = (id: ThemeId): void => update((latest) => ({ ...pickTheme(latest, side, id), customThemes: { ...latest.customThemes, [side]: null } }));
  const pickImported = (id: string): void => update((latest) => latest.customThemes.themes.some((entry) => entry.id === id) ? { customThemes: { ...latest.customThemes, [side]: id } } : {});
  const card = (id: ThemeId) => <ThemeCard key={id} card={id} name={t(THEME_NAMES[id])} row={rowFor(id, side)} side={side} checked={current === id} onPick={() => pick(id)} />;
  const importedCard = (theme: CustomTheme) => <ThemeCard key={theme.id} card={customRowId(theme.id)} name={themeLabel(t, theme, custom.themes)} row={customRow(theme, side)} side={side} checked={current === customRowId(theme.id)} onPick={() => pickImported(theme.id)} />;
  const step = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const cards = [...(strip.current?.querySelectorAll<HTMLElement>("[data-theme-card]") ?? [])];
    const at = cards.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + cards.length) % cards.length;
    event.preventDefault();
    const id = cards[next]?.dataset["themeCard"];
    const theme = custom.themes.find((entry) => customRowId(entry.id) === id);
    if (theme) pickImported(theme.id);
    else if (id && isThemeId(id)) pick(id);
    cards[next]?.focus();
    cards[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const scroll = (direction: 1 | -1): void => strip.current?.scrollBy({ left: direction * strip.current.clientWidth * 0.8, behavior: "smooth" });
  return (
    <>
      <SettingsRow icon={Palette} label={label} description={t("The colors used in dark mode and in light mode, one theme for each. Dark and Light on this row only switch which themes you are choosing from; Theme, above, sets the mode.")}
        condition={<span className="settings-condition">{t("Dark and Light here only switch which themes you choose from.")}</span>} keywords={`${t("Dark theme")} ${t("Light theme")} ${t("Shown in dark mode")} ${t("Shown in light mode")}`} reset={[side === "dark" ? "darkTheme" : "lightTheme"]}
        resetAlso={{ changed: custom[side] !== null, restore: () => update((latest) => ({ customThemes: { ...latest.customThemes, [side]: null } })) }}>
        <Segmented label={`${t("Dark theme")} · ${t("Light theme")}`} value={side} onChange={setPicked} options={[{ value: "dark", label: t("Dark"), name: t("Show dark themes") }, { value: "light", label: t("Light"), name: t("Show light themes") }]} />
      </SettingsRow>
      <div className="settings-item theme-strip">
        <div className="theme-strip-frame">
          <div ref={strip} className="theme-cards" role="radiogroup" aria-label={label} onScroll={measure} onKeyDown={step}>
            {custom.themes.map(importedCard)}
            {custom.themes.length > 0 && <span className="theme-cards-rule" aria-hidden="true" />}
            {own.map(card)}
            {others.length > 0 && <span className="theme-cards-rule" aria-hidden="true" />}
            {others.map(card)}
          </div>
          {!ends.start && <button type="button" className="icon-button theme-strip-arrow is-start" aria-label={t("Earlier themes")} title={t("Earlier themes")} tabIndex={-1} onClick={() => scroll(-1)}><ChevronLeft aria-hidden="true" /></button>}
          {!ends.end && <button type="button" className="icon-button theme-strip-arrow is-end" aria-label={t("Later themes")} title={t("Later themes")} tabIndex={-1} onClick={() => scroll(1)}><ChevronRight aria-hidden="true" /></button>}
        </div>
      </div>
      {/* the side drawn now when the theme has it, so the change shows; its only side otherwise */}
      <ThemeFiles onImported={(sides) => setPicked(sides.includes(drawn) ? drawn : sides[0]!)} />
    </>
  );
}

function InterfaceFontRows() {
  const { settings, update } = useSettings();
  const t = useT();
  const preset = uiFontPreset(settings.uiFontFamily);
  const [customOpen, setCustomOpen] = useState(preset === "custom");
  useEffect(() => { if (settings.uiFontFamily === DEFAULT_SETTINGS.uiFontFamily) setCustomOpen(false); }, [settings.uiFontFamily]);
  const custom = customOpen || preset === "custom";
  const interfaceFontDescription = t("The font of menus, lists, dialogs and the sidebar; chat text follows it until Chat font names one. System is this device's own interface font, and the terminal and code keep theirs.");
  const choose = (next: UiFontPreset | "custom"): void => {
    setCustomOpen(next === "custom");
    if (next !== "custom") update({ uiFontFamily: UI_FONT_PRESET_FAMILY[next] });
  };
  return (
    <>
      <SettingsRow icon={Type} label={t("Interface font")} description={interfaceFontDescription} htmlFor="settings-ui-font" reset={["uiFontFamily"]}>
        <SettingsSelect id="settings-ui-font" value={custom ? "custom" : preset} onChange={(event) => choose(event.target.value as UiFontPreset | "custom")}>
          <option value="default">{t("Default")}</option>
          <option value="system">{t("System")}</option>
          <option value="noto">Noto Sans</option>
          <option value="custom">{t("Custom")}</option>
        </SettingsSelect>
      </SettingsRow>
      {custom && (
        <SettingsRow icon={Type} label={t("Custom interface font")} description={t("Font names separated by commas: the first one this device has is used. If it has none of them, the default font is used.")} keywords={`${t("Interface font")} ${interfaceFontDescription}`} wide>
          <FontFamilyInput value={settings.uiFontFamily} label={t("Custom interface font")} placeholder={UI_FONT_PLACEHOLDER} onCommit={(uiFontFamily) => update({ uiFontFamily })} />
        </SettingsRow>
      )}
    </>
  );
}

function markdownStyleName(t: Translate, style: MarkdownStyle): string {
  switch (style) {
    case "editorial": return t("Editorial");
    case "tinted": return t("Tinted");
    case "colorful": return t("Colorful");
    case "plain": return t("Plain");
  }
}

function MarkdownStylePicker() {
  const { settings, update } = useSettings();
  const t = useT();
  const strip = useRef<HTMLDivElement>(null);
  const current = settings.markdownStyle;
  const pick = (markdownStyle: MarkdownStyle): void => update({ markdownStyle });
  const step = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    const cards = [...(strip.current?.querySelectorAll<HTMLElement>("[data-markdown-style-card]") ?? [])];
    const at = cards.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + cards.length) % cards.length;
    event.preventDefault();
    const id = cards[next]?.dataset["markdownStyleCard"] as MarkdownStyle | undefined;
    if (id && MARKDOWN_STYLES.includes(id)) pick(id);
    cards[next]?.focus();
    cards[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  return (
    <>
      <SettingsRow icon={FileText} label={t("Chat Markdown")} description={t("How assistant Markdown replies are styled in Chat, using the active theme's colors. The choice applies on every device.")}
        keywords={t("markdown style prose headings inline code colors editorial tinted colorful plain")} reset={["markdownStyle"]}>
        <span className="settings-condition">{markdownStyleName(t, current)}</span>
      </SettingsRow>
      <div className="settings-item theme-strip">
        <div className="theme-strip-frame">
          <div ref={strip} className="theme-cards" role="radiogroup" aria-label={t("Chat Markdown")} onKeyDown={step}>
            {MARKDOWN_STYLES.map((style) => {
              const name = markdownStyleName(t, style);
              const checked = current === style;
              return (
                <button key={style} type="button" role="radio" aria-checked={checked} title={name} tabIndex={checked ? 0 : -1}
                  className="theme-card" data-markdown-style-card={style} onClick={() => pick(style)}>
                  <span className={`markdown-style-art is-${style}`} aria-hidden="true">
                    <span className="markdown-style-art-head">
                      <span className="markdown-style-art-h" />
                      <span className="markdown-style-art-rule" />
                    </span>
                    <span className="markdown-style-art-line">
                      <span className="markdown-style-art-text" />
                      <span className="markdown-style-art-em" />
                      <span className="markdown-style-art-code" />
                    </span>
                    <span className="markdown-style-art-quote">
                      <span className="markdown-style-art-dot" />
                      <span className="markdown-style-art-text" />
                    </span>
                  </span>
                  <span className="theme-card-name">{name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

export function AppearancePage() {
  const { settings, update } = useSettings();
  const t = useT();
  return (
    <SettingsBare.Provider value={true}>
    <SettingsGroup>
      <SettingsRow icon={SunMoon} label={t("Theme")} description={t("Dark and Light keep one look; System follows each device's own dark or light mode. The choice applies on every device.")} wide reset={["theme"]}>
        <Segmented label={t("Theme")} value={settings.theme} onChange={(theme) => update({ theme })} options={[{ value: "dark", label: t("Dark") }, { value: "light", label: t("Light") }, { value: "system", label: t("System") }]} />
      </SettingsRow>
      <ThemePicker />
      <MarkdownStylePicker />
    </SettingsGroup>

    <SettingsGroup title={t("Typography")} section="typography">
      <SettingsRow icon={ALargeSmall} label={t("Interface font size")} description={t("The text size of menus, lists, dialogs and the sidebar. The chat follows it until Chat font is given a size of its own, and the terminal keeps its own.")} reset={["uiFontSize"]}>
        <Stepper label={t("Interface font size")} value={uiFontSize(settings)} text={`${uiFontSize(settings)}px`} min={UI_FONT_MIN} max={UI_FONT_MAX} decreaseLabel={t("Decrease interface font size")} increaseLabel={t("Increase interface font size")} onChange={(size) => update({ uiFontSize: size })} />
      </SettingsRow>
      <InterfaceFontRows />
      <SettingsRow icon={SquareTerminal} label={t("Terminal font")} description={t("The font and text size of every terminal pane. Type fixed-width (monospace) font names separated by commas: the first one this device has is used.")} keywords={`${t("Terminal font size")} ${t("Applied to every terminal pane")}`} wide reset={["terminalFontFamily", "terminalFontSize"]}>
        <span className="settings-font-size">
          <FontFamilyInput value={settings.terminalFontFamily} label={t("Terminal font")} fixedWidthFor="terminal" onCommit={(terminalFontFamily) => update({ terminalFontFamily })} />
          <Stepper label={t("Terminal font size")} value={settings.terminalFontSize} text={`${settings.terminalFontSize}px`} min={TERMINAL_FONT_MIN} max={TERMINAL_FONT_MAX} decreaseLabel={t("Decrease terminal font size")} increaseLabel={t("Increase terminal font size")} onChange={(terminalFontSize) => update({ terminalFontSize })} unit="px" range={t("Enter {min}–{max}px", { min: TERMINAL_FONT_MIN, max: TERMINAL_FONT_MAX })} />
        </span>
      </SettingsRow>
      <SettingsRow icon={MessageSquare} label={t("Chat font")} description={t("The font and text size of chat messages and the message box; code keeps its monospace font. Names are separated by commas and the first one this device has is used.")} keywords={`${t("Chat font size")} ${t("Messages, code, prompt cards and the message box in the chat view")}`} wide reset={["chatFontFamily", "chatFontSize"]}>
        <span className="settings-font-size">
          <FontFamilyInput value={settings.chatFontFamily} label={t("Chat font")} onCommit={(chatFontFamily) => update({ chatFontFamily })} />
          <Stepper label={t("Chat font size")} value={chatFontSize(settings)} text={`${chatFontSize(settings)}px`} min={CHAT_FONT_MIN} max={CHAT_FONT_MAX} decreaseLabel={t("Decrease chat font size")} increaseLabel={t("Increase chat font size")} onChange={(size) => update({ chatFontSize: size })} unit="px" range={t("Enter {min}–{max}px", { min: CHAT_FONT_MIN, max: CHAT_FONT_MAX })} />
        </span>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup>
      <SettingsRow icon={Rows3} label={t("Density")} description={t("On this device, Compact makes text one step smaller and rows shorter, so more fits on the screen. Comfortable is the roomier default.")} wide reset={["density"]}>
        <Segmented label={t("Density")} value={settings.density} onChange={(density) => update({ density })} options={[{ value: "comfortable", label: t("Comfortable") }, { value: "compact", label: t("Compact") }]} />
      </SettingsRow>
      <SettingsRow icon={Smartphone} label={t("Tabs on a phone")} description={t("On this device, where a phone shows the open workspace's tabs. Under the header: a row of their own shows two or three tabs at once and takes a little height from the pane. In the header: the tabs take the title's place, so the pane keeps its height, but about one tab shows at a time; swipe the row, or tap the arrow beside it to list them all.")} keywords={t("tab row tab bar tabs header phone mobile")} wide reset={["phoneTabs"]}>
        <Segmented label={t("Tabs on a phone")} value={settings.phoneTabs} onChange={(phoneTabs) => update({ phoneTabs })} options={[{ value: "row", label: t("Under the header") }, { value: "header", label: t("In the header") }]} />
      </SettingsRow>
      <SettingsRow icon={Languages} label={t("Language")} description={t("The language of the app. System follows each browser's language; a language chosen here applies on every device.")} htmlFor="settings-language" reset={["language"]}>
        <SettingsSelect id="settings-language" value={settings.language} onChange={(event) => update({ language: event.target.value as typeof settings.language })}>
          {LANGUAGE_SETTINGS.map((language) => <option key={language} value={language}>{language === "system" ? t("System") : LANGUAGE_NAMES[language]}</option>)}
        </SettingsSelect>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title={t("Sidebar")} section="sidebar">
      <SettingsRow icon={PanelLeft} preview={<SidebarRowsPreview rows={settings.sidebarRows} />} label={t("Sidebar rows")} description={t("One line gives each workspace and each agent in the sidebar a single line with its name; Two lines add a second line: under a workspace's name, what its pane is on, and in the Agents list, under an agent's task, its workspace. The choice applies on every device.")} wide reset={["sidebarRows"]}>
        <Segmented label={t("Sidebar rows")} value={settings.sidebarRows} onChange={(sidebarRows) => update({ sidebarRows })} options={[{ value: "one", label: t("One line") }, { value: "two", label: t("Two lines") }]} />
      </SettingsRow>
      {/* the scope differs within the one control: said on the row, where the sentences are not (G-097) */}
      <SettingsRow icon={ArrowDownUp} label={t("Agents order")} description={t("The order of the Agents list. Waiting first puts the agents that need you on top and folds the resting ones; Workspaces keeps the workspaces' order; Activity puts an agent that needs you first, then the one that changed last; By state groups the agents by what they are doing.")} condition={<span className="settings-condition">{t("By state applies to this device; the other orders to every browser.")}</span>} wide reset={["agentOrder", "agentGroups"]}>
        {/* By state is this device's grouping (agentGroups); Workspaces and Activity are every browser's order (agentOrder), the grouping off */}
        <Segmented label={t("Agents order")} value={settings.agentGroups ? "state" : settings.agentOrder} onChange={(order) => update(order === "state" ? { agentGroups: true } : { agentOrder: order, agentGroups: false })} options={[{ value: "waiting", label: t("Waiting first") }, { value: "workspace", label: t("Workspaces") }, { value: "activity", label: t("Activity") }, { value: "state", label: t("By state") }] as const} />
      </SettingsRow>
      {settings.agentGroups && <SettingsRow icon={ArrowDownUp} label={t("Within a state")} description={t("The order inside each state's group: the longest wait first, the latest change first, or by name.")} wide>
        <Segmented label={t("Within a state")} value={settings.agentGroupSort} onChange={(agentGroupSort) => update({ agentGroupSort })} options={[{ value: "wait", label: t("Longest wait") }, { value: "recent", label: t("Recent") }, { value: "name", label: t("Name") }]} />
      </SettingsRow>}
    </SettingsGroup>

    <SettingsFold kind="more" keys={["autoTabNames", "sidebarFilter", "sidebarPeek", "phoneInbox", "sidebarBackgroundWorkspaces", "sidebarContext", "sidebarAgentTree", "foldHelpers", "agentMarks", "statusIndicators", "fileFontSize"]}>
      <SettingsGroup title={t("Sidebar")} section="sidebar-more">
        <SettingsRow icon={Tag} label={t("Name tabs from the first message")} description={t("On every device, a tab that has only a number shows the first few words of the first message sent in it. A name you gave a tab is never replaced.")}
          condition={<span className="settings-condition">{t("Only those words are kept, on this server, until the tab closes; turning this off deletes them.")}</span>} reset={["autoTabNames"]}>
          <Toggle label={t("Name tabs from the first message")} checked={settings.autoTabNames} onChange={(autoTabNames) => update({ autoTabNames })} />
        </SettingsRow>
        <SettingsRow icon={Filter} label={t("Sidebar filter")} description={t("Keeps a Filter field above the sidebar's lists on this device, to narrow the workspaces and agents by name. When off, Filter workspaces and agents in the command palette still opens it while you use it.")}>
          <Toggle label={t("Sidebar filter")} checked={settings.sidebarFilter} onChange={(sidebarFilter) => update({ sidebarFilter })} />
        </SettingsRow>
        <SettingsRow icon={MousePointer2} label={t("Show the sidebar on hover")} description={t("On this device, while the sidebar is hidden, resting the mouse on its button shows it over the pane until the mouse leaves. A click on the button keeps it open.")}>
          <Toggle label={t("Show the sidebar on hover")} checked={settings.sidebarPeek} onChange={(sidebarPeek) => update({ sidebarPeek })} />
        </SettingsRow>
        <SettingsRow icon={Inbox} label={t("Start in the agent inbox on a phone")} description={t("On this device, a phone-width window starts in the agent inbox: the list of agents, or the chat of the pane its address names. More has Back to Ovis.")} keywords="inbox phone mobile first screen agents list start">
          <Toggle label={t("Start in the agent inbox on a phone")} checked={phoneInboxOn(settings)} onChange={(phoneInbox) => update({ phoneInbox })} />
        </SettingsRow>
        <SettingsRow icon={Layers} label={t("Background workspaces apart")} description={t("On this device, workspaces a tool marked as background (role=background in herdr) move below the others, under a folded heading. The one you have open and any whose agent is asking you something stay in sight.")}>
          <Toggle label={t("Background workspaces apart")} checked={settings.sidebarBackgroundWorkspaces} onChange={(sidebarBackgroundWorkspaces) => update({ sidebarBackgroundWorkspaces })} />
        </SettingsRow>
        <SettingsRow icon={Gauge} label={t("Context left on agent rows")} description={t("On this device, each agent's row shows how much of its context is left, as the ring in the message box does. It turns red at 20% or less, and shows only for agents whose context size is known.")}>
          <Toggle label={t("Context left on agent rows")} checked={settings.sidebarContext} onChange={(sidebarContext) => update({ sidebarContext })} />
        </SettingsRow>
        <SettingsRow icon={ListTree} label={t("Agents under workspaces")} description={t("On this device, the PCs list shows each workspace's agents under it. The Agents list stays as it is.")}>
          <Toggle label={t("Agents under workspaces")} checked={settings.sidebarAgentTree} onChange={(sidebarAgentTree) => update({ sidebarAgentTree })} />
        </SettingsRow>
        <FoldHelpersRow />
        <SettingsRow icon={Shapes} label={t("Agent logos")} description={t("Color draws each agent's logo in its brand colors; Mono draws them without color. The choice applies on every device.")} wide>
          <Segmented label={t("Agent logos")} value={settings.agentMarks} onChange={(agentMarks) => update({ agentMarks })} options={[{ value: "color", label: t("Color") }, { value: "mono", label: t("Mono") }]} />
        </SettingsRow>
        <SettingsRow icon={CircleDot} label={t("Status indicators")} description={t("How an agent's state is marked in the sidebar and on tabs, on this device. In the sidebar, Classic leaves a ready agent unmarked, while Dots and Symbols mark every state, as herdr's own terminal app does.")} wide>
          <Segmented label={t("Status indicators")} value={settings.statusIndicators} onChange={(statusIndicators) => update({ statusIndicators })} options={[{ value: "classic", label: t("Classic") }, { value: "dots", label: t("Dots") }, { value: "symbols", label: t("Symbols") }]} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("Typography")} section="typography-more">
        <FileTextSizeRow />
      </SettingsGroup>
    </SettingsFold>
    </SettingsBare.Provider>
  );
}