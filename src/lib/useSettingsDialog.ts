import { useCallback, useEffect, useRef, useState } from "react";
import type { AppLink } from "./deepLink.ts";
import { onSettingsHistory, recordSettings } from "./settingsHistory.ts";

export function useSettingsDialog(initialLink: AppLink | null) {
  const [settingsOpen, setSettingsOpen] = useState(() => initialLink?.settings != null);
  const [settingsLinkPage, setSettingsLinkPage] = useState<string | null>(() => initialLink?.settings ?? null);
  const [settingsLinkSection, setSettingsLinkSection] = useState<string | null>(() => initialLink?.section ?? null);
  const [settingsPage, setSettingsPage] = useState<string | null>(null);
  const [settingsSection, setSettingsSection] = useState<"updates" | null>(null);
  const closeSettings = useCallback(() => { setSettingsOpen(false); setSettingsSection(null); setSettingsLinkPage(null); setSettingsLinkSection(null); setSettingsPage(null); }, []);
  const settingsLinkPageRef = useRef(settingsLinkPage); settingsLinkPageRef.current = settingsLinkPage;
  const onSettingsPage = useCallback((page: string | null) => {
    setSettingsPage(page);
    if (page !== settingsLinkPageRef.current) setSettingsLinkSection(null);
  }, []);
  useEffect(() => onSettingsHistory((entry, own) => {
    if (own) return;
    if (entry === null) closeSettings();
    else setSettingsOpen(true);
  }), [closeSettings]);
  useEffect(() => { if (!settingsOpen) recordSettings([]); }, [settingsOpen]);

  return {
    settingsOpen,
    setSettingsOpen,
    settingsLinkPage,
    setSettingsLinkPage,
    settingsLinkSection,
    setSettingsLinkSection,
    settingsPage,
    setSettingsPage,
    settingsSection,
    setSettingsSection,
    closeSettings,
    onSettingsPage,
  };
}
