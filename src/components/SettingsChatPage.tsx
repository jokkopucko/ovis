import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, AudioLines, Ban, Brain, ClipboardPaste, CornerDownLeft, ExternalLink as ExternalLinkIcon, FileClock, FilePen, Globe, Languages, Layers, ListCollapse, MessageSquareReply, Mic, MoveHorizontal, PanelRight, Plus, Send, Sparkles, TextCursorInput, WandSparkles, WrapText, X, type LucideIcon } from "lucide-react";

import { WEB_LINK_TARGETS } from "../lib/webPanel.ts";
import { FILE_OPEN_TARGETS } from "../lib/filePresentation.ts";
import { CHAT_WIDTHS, DEFAULT_SETTINGS, QUICK_REPLIES_MAX, QUICK_REPLY_MAX_CHARS, DICTATION_LANGUAGES, VOICE_BUTTONS, VOICE_ENGINES, enterSendsOn, useSettings, forgetPaneViews, type DictationLanguage, type VoiceButton } from "../lib/settings.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { FilesPanelRow } from "./FilesPanelRow.tsx";
import { LinkBrowserRow } from "./LinkBrowserRow.tsx";
import { SettingsBare, Segmented, SettingsFold, SettingsGroup, SettingsRow, SettingsSelect, Toggle } from "./SettingsControls.tsx";
import { fetchVoiceStatus, saveVoiceConfig } from "../lib/api.ts";
import type { VoiceStatus } from "../../shared/voice.ts";
import { dictationLocale, VOICE_CONFIG_EVENT } from "../lib/voice.ts";
import { useMediaQuery } from "../lib/useMediaQuery.ts";
import { FILE_PANEL_DOCK_QUERY } from "../lib/filePanelWidth.ts";
import { canReuseExternalLinkTab } from "../lib/externalLink.ts";
import { hasDesktopBrowser } from "../lib/desktopBrowser.ts";
import { browserBlockedSites } from "../../shared/browser-policy.ts";

function WrapPreview({ wrap }: { wrap: boolean }) {
  return <span className={wrap ? "settings-wrap-preview is-wrapped" : "settings-wrap-preview"}><code>{WRAP_PREVIEW_CODE}</code></span>;
}
const WRAP_PREVIEW_CODE = "const total = items.reduce(sum, 0);";

export function ChatPage() {
  const { settings, update } = useSettings();
  const t = useT();
  const touch = useMediaQuery("(pointer: coarse)");
  const filePanelAvailable = useMediaQuery(FILE_PANEL_DOCK_QUERY);
  const chip = (Icon: LucideIcon, label: string, on: boolean, change: (on: boolean) => void) => <button type="button" className="settings-chip" aria-pressed={on} onClick={() => change(!on)}><Icon aria-hidden="true" />{label}</button>;
  return (
    <SettingsBare.Provider value="rows">
      <SettingsGroup title={t("Conversation")} section="conversation">
        <SettingsRow icon={AppWindow} label={t("Panes open in")} description={t("Whether a pane first shows its chat or its terminal, on this device. A pane you switch yourself stays as you left it; changing this choice puts every pane back on it.")} condition={<span className="settings-condition">{t("Auto: the chat on a touch screen, the terminal elsewhere.")}</span>} wide reset={["defaultView"]} resetAlso={{ changed: false, restore: forgetPaneViews }}>
          <Segmented label={t("Panes open in")} value={settings.defaultView} options={[{ value: "auto", label: t("Auto") }, { value: "chat", label: t("Chat") }, { value: "terminal", label: t("Terminal") }]} onChange={(defaultView) => {
            if (settings.defaultView === defaultView) return;
            forgetPaneViews();
            update({ defaultView });
          }} />
        </SettingsRow>
        {/* showThinking is every browser's, whether reasoning starts open (expandThinking) this device's */}
        <SettingsRow icon={Brain} label={t("Show thinking")} description={t("The agent's reasoning in the chat: left out, folded to one line, or open. Hidden or shown applies on every device; folded or open is this device's own.")} wide reset={["showThinking", "expandThinking"]}>
          <Segmented label={t("Show thinking")} value={!settings.showThinking ? "hidden" : settings.expandThinking ? "expanded" : "folded"} onChange={(shown) => update(shown === "hidden" ? { showThinking: false } : { showThinking: true, expandThinking: shown === "expanded" })} options={[{ value: "hidden", label: t("Hidden") }, { value: "folded", label: t("Folded") }, { value: "expanded", label: t("Expanded") }] as const} />
        </SettingsRow>
        <SettingsRow icon={MoveHorizontal} label={t("Chat width")} description={t("How wide the conversation and the message box may run on a large screen. A pane narrower than that is not affected.")} wide reset={["chatWidth"]}>
          <Segmented label={t("Chat width")} value={settings.chatWidth} onChange={(chatWidth) => update({ chatWidth })} options={CHAT_WIDTHS.map((chatWidth) => ({ value: chatWidth, label: t(chatWidth === "narrow" ? "Narrow" : chatWidth === "wide" ? "Wide" : chatWidth === "full" ? "Full" : "Default") }))} />
        </SettingsRow>
        <SettingsRow icon={ListCollapse} label={t("Collapse work")} description={t("On this device, the work an agent does in a reply (commands, file reads and edits) starts folded to one line, also while it is still running. Work that waits for your answer stays open.")} reset={["foldWork"]}>
          <Toggle label={t("Collapse work")} checked={settings.foldWork} onChange={(foldWork) => update({ foldWork })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Composer")} section="composer">
        <SettingsRow icon={CornerDownLeft} label={touch ? t("Return inserts a new line") : t("Enter sends")} description={touch ? t("On, Return starts a new line on this device and the Send button sends. Off, Return sends the message.") : t("On, Enter sends the message on this device and Shift+Enter starts a new line. Off, Enter starts a new line and Ctrl+Enter (⌘+Enter on a Mac) sends.")} reset={["enterSends"]}>
          <Toggle label={touch ? t("Return inserts a new line") : t("Enter sends")} checked={touch ? !enterSendsOn(settings, touch) : enterSendsOn(settings, touch)} onChange={(checked) => update({ enterSends: touch ? !checked : checked })} />
        </SettingsRow>
        {/* the message box's optional buttons and chips, each off by default; the suggestion chip is drawn on a touch screen only (Composer.tsx) */}
        <SettingsRow icon={TextCursorInput} label={t("Composer buttons")} description={touch
          ? t("Optional buttons for the message box, each off until you turn it on. Paste and send sends the text copied on this device as a message; Artifacts lists the pages a Claude Code session published; Suggestion offers the prompt the agent suggests next.")
          : t("Optional buttons for the message box, each off until you turn it on. Paste and send sends the text copied on this device as a message; Artifacts lists the pages a Claude Code session published.")} wide reset={touch ? ["composerPasteSend", "composerArtifacts", "suggestionChip"] : ["composerPasteSend", "composerArtifacts"]}
          keywords={[t("Paste and send button"), t("A button in the empty message box sends the text copied on this device as a message."), t("Artifacts chip"), t("A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool."), ...(touch ? [t("Suggestion chip"), t("A chip above the message box puts the prompt the agent suggests next (Claude Code, GJC or omp) into the box. With a keyboard, Tab does it.")] : [])].join(" ")}>
          <span className="settings-chips">
            {chip(ClipboardPaste, t("Paste and send"), settings.composerPasteSend, (composerPasteSend) => update({ composerPasteSend }))}
            {chip(Layers, t("Artifacts (Claude Code)"), settings.composerArtifacts, (composerArtifacts) => update({ composerArtifacts }))}
            {touch && chip(Sparkles, t("Suggestion"), settings.suggestionChip, (suggestionChip) => update({ suggestionChip }))}
          </span>
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("Quick replies")} section="quick-replies">
        {/* the row names what it shows (G-097); the palette still finds it by the old words, which the dictionary keeps for it */}
        <SettingsRow icon={MessageSquareReply} label={t("Show above the message box|quick replies switch")} keywords={t("Show above the message box")} description={t("Shows the replies listed here as one-tap buttons above the message box, on every device. A tap sends the reply as if you typed it: it waits its turn while the agent works, and answers a question the agent is asking.")} reset={["showQuickReplies"]}>
          <Toggle label={t("Show above the message box|quick replies switch")} checked={settings.showQuickReplies} onChange={(showQuickReplies) => update({ showQuickReplies })} />
        </SettingsRow>
        {settings.showQuickReplies && <div className="settings-item">
          <ol className="quick-replies-list">
            {settings.quickReplies.map((reply, index) => (
              <li key={index}>
                <input
                  className="input"
                  value={reply}
                  maxLength={QUICK_REPLY_MAX_CHARS}
                  aria-label={t("Quick reply {number}", { number: index + 1 })}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(event) => update({ quickReplies: settings.quickReplies.map((current, at) => at === index ? event.target.value : current) })}
                />
                <button type="button" className="icon-button" aria-label={t("Remove quick reply {number}", { number: index + 1 })} title={t("Remove quick reply {number}", { number: index + 1 })} onClick={() => update({ quickReplies: settings.quickReplies.filter((_, at) => at !== index) })}>
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
          <div className="settings-actions">
            <button type="button" className="btn" disabled={settings.quickReplies.length >= QUICK_REPLIES_MAX} onClick={() => update({ quickReplies: [...settings.quickReplies, ""] })}><Plus aria-hidden="true" />{t("Add reply")}</button>
            <button type="button" className="btn btn-ghost" onClick={() => update({ quickReplies: [...DEFAULT_SETTINGS.quickReplies] })}>{t("Restore defaults")}</button>
          </div>
        </div>}
      </SettingsGroup>

      <SettingsGroup title={t("Files")} section="file-viewer">
        {/* a narrow screen cannot open a file beside the pane: the row says so, so the choice does not look ignored (G-097) */}
        <SettingsRow icon={PanelRight} label={t("Open files")} description={t("Where a file opens when you press its name in the chat, the terminal or Files; the viewer's header button then moves an open file. Beside the pane is for text and code on a wide window: pictures, PDFs and folders always open in a popup.")} condition={filePanelAvailable ? undefined : <span className="settings-condition">{t("Beside the pane needs a wide window; on this screen a file opens in a popup.")}</span>} wide reset={["fileOpen"]}>
          <Segmented label={t("Open files")} value={settings.fileOpen} onChange={(fileOpen) => update({ fileOpen })} options={FILE_OPEN_TARGETS.map((fileOpen) => ({ value: fileOpen, label: fileOpen === "panel" ? t("Beside the pane") : t("In a popup") }))} />
        </SettingsRow>
        <SettingsRow icon={Globe} label={t("Web links")} description={t(filePanelAvailable ? "Where a web address opens when you click it; Shift-click opens it the other way. Only a page this PC serves, such as a dev server on localhost, can open beside the pane: any other site opens in a new tab." : "Where a web address opens when you press it; Shift-click opens it the other way. Only a page this PC serves, such as a dev server on localhost, can open in the app: any other site opens in a new tab.")}
          condition={<span className="settings-condition">{t(filePanelAvailable ? "Only pages this PC serves can open beside the pane." : "Only pages this PC serves can open in the app.")}</span>} wide reset={["webLinks"]}>
          <Segmented label={t("Web links")} value={settings.webLinks} onChange={(webLinks) => update({ webLinks })} options={WEB_LINK_TARGETS.map((webLinks) => ({ value: webLinks, label: webLinks === "panel" ? t(filePanelAvailable ? "Beside the pane" : "In the app") : t("In a new tab") }))} />
        </SettingsRow>
        <LinkBrowserRow />
        {hasDesktopBrowser() && <BuiltInBrowserRows />}
      </SettingsGroup>

      <VoiceMain />

      <SettingsFold kind="more" keys={["autoSendQueued", "wrapCode", "editTextFiles", "reopenFileOnReturn", "filesPanel", "reuseExternalLinkTab", ...(settings.voiceInput === "off" ? [] : ["voiceLanguage", "voiceEngine", "voicePolishChat", "voicePolishTerminal"] as const)]}>
        <SettingsGroup title={t("Composer")} section="composer-more">
          <SettingsRow icon={Send} label={t("Send queued messages automatically")} description={t("On every device, a message sent while the agent is working goes by itself when the agent finishes. When off, it waits until you press Send now.")} reset={["autoSendQueued"]}>
            <Toggle label={t("Send queued messages automatically")} checked={settings.autoSendQueued} onChange={(autoSendQueued) => update({ autoSendQueued })} />
          </SettingsRow>
        </SettingsGroup>
        <SettingsGroup title={t("Files")} section="file-viewer-more">
          <SettingsRow icon={WrapText} label={t("Wrap long lines")} description={t("On this device, a long line in the file viewer and in diffs continues on the next line. When off, it runs past the edge and scrolls sideways.")} reset={["wrapCode"]} preview={<WrapPreview wrap={settings.wrapCode} />}>
            <Toggle label={t("Wrap long lines")} checked={settings.wrapCode} onChange={(wrapCode) => update({ wrapCode })} />
          </SettingsRow>
          <SettingsRow icon={FilePen} label={t("Edit text files")} description={t("Adds Edit to the file viewer for a text file in the pane's folder. Saving asks first, and refuses if the file changed after you opened it.")} reset={["editTextFiles"]}>
            <Toggle label={t("Edit text files")} checked={settings.editTextFiles} onChange={(editTextFiles) => update({ editTextFiles })} />
          </SettingsRow>
          <SettingsRow icon={FileClock} label={t("Reopen files on return")} description={t("A file left open when you switch to another tab shows again when you come back to that tab. When off, the tab comes back without it.")} reset={["reopenFileOnReturn"]}>
            <Toggle label={t("Reopen files on return")} checked={settings.reopenFileOnReturn} onChange={(reopenFileOnReturn) => update({ reopenFileOnReturn })} />
          </SettingsRow>
          <FilesPanelRow />
          {canReuseExternalLinkTab() && <SettingsRow icon={ExternalLinkIcon} label={t("Reuse tab for external links")} description={t("Links that open outside Ovis reuse one browser tab and do not open a new one each time.")} reset={["reuseExternalLinkTab"]}
            condition={<span className="settings-condition">{t("The site in that tab can see and navigate this Ovis tab.")}</span>}>
            <Toggle label={t("Reuse tab for external links")} checked={settings.reuseExternalLinkTab} onChange={(reuseExternalLinkTab) => update({ reuseExternalLinkTab })} />
          </SettingsRow>}
        </SettingsGroup>
        <VoiceMore />
      </SettingsFold>
    </SettingsBare.Provider>
  );
}

/** The desktop app's built-in browser (app/electron/src/browserTabs.ts): only the desktop app offers it. */
function BuiltInBrowserRows() {
  const t = useT();
  const { settings, update } = useSettings();
  // what is typed in the blocked-sites box is kept when it goes away too (Settings closed with Escape before a blur);
  // a box only replaced (the list saved, or reset to its default) has no edit of its own to keep
  const update$ = useRef(update);
  update$.current = update;
  const holdBlockedBox = useCallback((box: HTMLTextAreaElement | null) => {
    if (box === null) return;
    return () => {
      if (box.dataset["edited"] === "true") update$.current({ browserBlockedSites: browserBlockedSites(box.value.split("\n")) });
    };
  }, []);
  return <>
    <SettingsRow icon={AppWindow} label={t("Built-in browser")} description={t("Opens web pages in tabs inside this app: they are listed under Browser in the sidebar and open beside the pane. Its tabs are signed in to nothing you use elsewhere, and an agent's tabs keep cookies of their own.")} reset={["builtInBrowser"]}>
      <Toggle label={t("Built-in browser")} checked={settings.builtInBrowser} onChange={(builtInBrowser) => update({ builtInBrowser })} />
    </SettingsRow>
    {settings.builtInBrowser && <SettingsRow icon={Ban} label={t("Blocked sites")} description={t("The built-in browser never loads these sites or their subdomains, in your tabs or an agent's. One site per line.")} wide reset={["browserBlockedSites"]}>
      <textarea ref={holdBlockedBox} key={settings.browserBlockedSites.join("\n")} className="input settings-blocked-sites" rows={4} aria-label={t("Blocked sites")} placeholder="bank.example" defaultValue={settings.browserBlockedSites.join("\n")}
        autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} onInput={(event) => { event.currentTarget.dataset["edited"] = "true"; }} onBlur={(event) => {
          // what is kept, shown as kept: lines that are not a site are dropped from the box too
          const kept = browserBlockedSites(event.currentTarget.value.split("\n"));
          event.currentTarget.value = kept.join("\n");
          delete event.currentTarget.dataset["edited"];
          update({ browserBlockedSites: kept });
        }} />
    </SettingsRow>}
  </>;
}

function languageName(names: Intl.DisplayNames | null, tag: string): string {
  try { return names?.of(tag) ?? tag; } catch { return tag; }
}

function DictationLanguageSelect() {
  const { settings, resolvedLanguage, update } = useSettings();
  const t = useT();
  const locale = useLocale();
  const names = useMemo(() => { try { return new Intl.DisplayNames([locale], { type: "language" }); } catch { return null; } }, [locale]);
  const auto = languageName(names, dictationLocale("auto", settings.language, resolvedLanguage, navigator.languages));
  const choices = useMemo(() => DICTATION_LANGUAGES.map((tag) => ({ tag, name: languageName(names, tag) })).sort((a, b) => a.name.localeCompare(b.name, locale)), [names, locale]);
  return (
    <SettingsSelect id="settings-voice-language" value={settings.voiceLanguage} onChange={(event) => update({ voiceLanguage: event.target.value as DictationLanguage })}>
      <option value="auto">{t("Auto ({language})", { language: auto })}</option>
      {choices.map(({ tag, name }) => <option key={tag} value={tag}>{name}</option>)}
    </SettingsSelect>
  );
}

function VoiceMain() {
  const { settings, update } = useSettings();
  const t = useT();
  const [micDenied, setMicDenied] = useState(false);
  /**
   * On asks now, so the first dictation does not stop at the browser's permission prompt. Not in an
   * iPhone home-screen app, which this request closed or reloaded (#2343): there the first tap of the mic asks.
   */
  const chooseVoiceInput = async (voiceInput: VoiceButton) => {
    update({ voiceInput });
    setMicDenied(false);
    const homeScreenApp = (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (voiceInput !== "on" || homeScreenApp || !window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return;
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((track) => track.stop()); }
    catch { setMicDenied(true); }
  };
  const micProblem = settings.voiceInput === "off" ? null : !window.isSecureContext ? t("Voice input needs HTTPS") : micDenied ? t("Microphone permission was denied") : null;
  return (
    <SettingsGroup title={t("Voice input")} section="voice">
      {/* Auto's reach is said on the row, where the sentences are not (G-097) */}
      <SettingsRow icon={Mic} label={t("Microphone button")} description={t("The button for dictating a message. Auto shows it in the chat on a desktop, where dictation can work; On also shows it on a phone and in the terminal's input line.")} condition={micProblem !== null ? <span className="voice-error">{micProblem}</span> : <span className="settings-condition">{t("Auto: on a desktop's chat only, where dictation can work.")}</span>} wide>
        <Segmented label={t("Microphone button")} value={settings.voiceInput} onChange={(voiceInput) => void chooseVoiceInput(voiceInput)} options={VOICE_BUTTONS.map((voiceInput) => ({ value: voiceInput, label: t(voiceInput === "auto" ? "Auto" : voiceInput === "on" ? "On" : "Off") }))} />
      </SettingsRow>
    </SettingsGroup>
  );
}

function VoiceMore() {
  const { settings, update } = useSettings();
  const t = useT();
  // the server only says whether it holds a key; the key typed here lives in its field alone, read at
  // Save and cleared once saved, never in state (src/AGENTS.md, G-108).
  const [voice, setVoice] = useState<VoiceStatus | null>(null);
  const voiceKeyRef = useRef<HTMLInputElement>(null);
  const [voiceKeyTyped, setVoiceKeyTyped] = useState(false);
  const voiceKeyField = useCallback((field: HTMLInputElement | null) => {
    voiceKeyRef.current = field;
    return () => { voiceKeyRef.current = null; setVoiceKeyTyped(false); };
  }, []);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  useEffect(() => { fetchVoiceStatus().then(setVoice, () => setVoice(null)); }, []);
  const changeVoiceKey = async (api_key: string | null) => {
    setVoiceBusy(true);
    try {
      const saved = await saveVoiceConfig({ api_key });
      if (voiceKeyRef.current) voiceKeyRef.current.value = "";
      setVoiceKeyTyped(false);
      setVoiceError(null);
      setVoice(saved);
      window.dispatchEvent(new Event(VOICE_CONFIG_EVENT));
    } catch (e) { setVoiceError(e instanceof Error ? e.message : String(e)); }
    finally { setVoiceBusy(false); }
  };
  return (
    <>
      {settings.voiceInput !== "off" && <>
        <SettingsGroup title={t("Voice input")} section="voice-more">
          <SettingsRow icon={Languages} label={t("Dictation language")} description={t("The language the microphone listens for. Auto is the app's language, or the browser's when the app is not translated into it.")} htmlFor="settings-voice-language" wide>
            <DictationLanguageSelect />
          </SettingsRow>
          <SettingsRow icon={AudioLines} label={t("Speech recognition")} description={t("What turns speech into text. Auto uses the OpenAI API key when one is saved and the browser's own recognition when none is; Browser and API key keep to the one chosen.")} condition={settings.voiceEngine === "server" && voice && !voice.configured ? <span className="voice-error">{t("Save an API key to use the mic")}</span> : undefined} wide>
            <Segmented label={t("Speech recognition")} value={settings.voiceEngine} onChange={(voiceEngine) => update({ voiceEngine })} options={VOICE_ENGINES.map((voiceEngine) => ({ value: voiceEngine, label: t(voiceEngine === "auto" ? "Auto" : voiceEngine === "browser" ? "Browser" : "API key") }))} />
          </SettingsRow>
        </SettingsGroup>
        {settings.voiceEngine !== "browser" && (
          <SettingsGroup section="tidy-dictation">
            <SettingsRow icon={WandSparkles} label={t("Tidy dictated text")} description={t("Drops filler words and fixes spacing in what you dictated, in the chat, the terminal's input line or both; code and paths stay as spoken. Where it is off, the text stays exactly as transcribed.")} wide>
              <Segmented label={t("Tidy dictated text")} value={settings.voicePolishChat ? (settings.voicePolishTerminal ? "both" : "chat") : settings.voicePolishTerminal ? "terminal" : "off"} onChange={(where) => update({ voicePolishChat: where === "chat" || where === "both", voicePolishTerminal: where === "terminal" || where === "both" })} options={[{ value: "off", label: t("Off") }, { value: "chat", label: t("Chat") }, { value: "terminal", label: t("Terminal") }, { value: "both", label: t("Both") }] as const} />
            </SettingsRow>
          </SettingsGroup>
        )}
      </>}
      <SettingsGroup title={t("OpenAI API key")} section="openai-key">
        <div className="settings-item">
          {voice && (
            <p className="settings-label voice-status">
              {voice.configured ? t(voice.source === "env" ? "OpenAI key set by OVIS_OPENAI_API_KEY" : "OpenAI key saved on this PC") : t(settings.voiceEngine === "server" ? "No OpenAI key saved" : "No OpenAI key: the browser's speech recognition is used")}
            </p>
          )}
          {voice && voice.source !== "env" && (
            <form className="voice-key" onSubmit={(event) => { event.preventDefault(); const typed = voiceKeyRef.current?.value.trim() ?? ""; if (typed) void changeVoiceKey(typed); }}>
              <input
                ref={voiceKeyField}
                className="input voice-key-input"
                type="password"
                placeholder="sk-..."
                aria-label={t("OpenAI API key")}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(event) => setVoiceKeyTyped(event.target.value.trim() !== "")}
              />
              <button type="submit" className="btn voice-key-save" disabled={voiceBusy || !voiceKeyTyped}>{t("Save key")}</button>
              <button type="button" className="btn btn-ghost voice-key-remove" disabled={voiceBusy || !voice.configured} onClick={() => void changeVoiceKey(null)}>{t("Remove key")}</button>
            </form>
          )}
          {voiceError && <p className="settings-hint voice-error" role="alert">{voiceError}</p>}
          <p className="settings-hint voice-privacy">
            {settings.voiceEngine === "browser" || (voice && !voice.configured && settings.voiceEngine === "auto")
              ? t("Without a key the browser recognizes the speech: Chrome and Edge send the audio to Google or Microsoft. Nothing is recorded until you press the mic.")
              : t("Audio is sent to OpenAI with your key. Nothing is recorded until you press the mic.")}
          </p>
        </div>
      </SettingsGroup>
    </>
  );
}