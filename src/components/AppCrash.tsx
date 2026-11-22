import { useEffect, useRef, useState, type Ref } from "react";
import { copyText } from "../lib/clipboard.ts";
import { crashProbe, type CrashRegion } from "../lib/crashProbe.ts";
import { resolveLanguage, t, translate, useT, type Language } from "../lib/i18n.ts";
import { loadSettings } from "../lib/settings.ts";
import "./AppCrash.css";

export function crashDetails(error: unknown): string {
  const head = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : "";
  const trace = stack.startsWith(head) ? stack.slice(head.length).replace(/^\n/, "") : stack;
  return [head, trace, `Path: ${window.location.pathname}`, `User agent: ${navigator.userAgent}`].filter((line) => line !== "").join("\n");
}

/**
 * What the page shows when a render error reached the top of the tree (main.tsx). It sits
 * outside SettingsProvider, which may be what threw, so it reads the module-level `t` (the
 * language last set, English before any) and never a context. An installed web app has no
 * browser reload button, so Reload app is the way back.
 */
export function AppCrash({ error }: { error: unknown }) {
  const details = crashDetails(error);
  const detailsRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <main className="app-crash">
      <div className="app-crash-card error-state" role="alert">
        <h1 className="app-crash-title">{t("Something went wrong")}</h1>
        <p className="error-message">{t("The app hit an error and stopped drawing. Your terminals keep running in herdr.")}</p>
        <div className="app-crash-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>{t("Reload app")}</button>
          <button type="button" className="btn" onClick={() => void copyText(details, detailsRef.current).then(setCopied)}>{copied === true ? t("Copied") : t("Copy details")}</button>
        </div>
        <details className="app-crash-details" open={copied === false || undefined}>
          <summary>{t("Details")}</summary>
          <pre ref={detailsRef}>{details}</pre>
        </details>
      </div>
    </main>
  );
}

/**
 * What the hosted shell shows when its code still did not load after one reload (lib/relay/boot.ts):
 * nothing broke in the app, so no crash details, only the way to try again. It shows before any
 * SettingsProvider set the language, so it reads the saved one itself.
 */
export function AppLoadFailed({ retry }: { retry: () => void }) {
  let language: Language;
  try { language = resolveLanguage(loadSettings().language); } catch { language = resolveLanguage("system"); }
  const t = (key: string): string => translate(language, key);
  return (
    <main className="app-crash">
      <div className="app-crash-card error-state" role="alert">
        <p className="error-message">{t("Ovis could not load. Check your connection, then try again.")}</p>
        <div className="app-crash-actions">
          <button type="button" className="btn btn-primary" onClick={retry}>{t("Try again")}</button>
        </div>
      </div>
    </main>
  );
}

export function RegionCrash({ message, retry, retryLabel, buttonRef, onShown }: {
  message: string; retry: () => void; retryLabel?: string; buttonRef?: Ref<HTMLButtonElement>; onShown?: () => void;
}) {
  const t = useT();
  useEffect(() => { onShown?.(); }, [onShown]);
  return (
    <div className="error-state" role="alert">
      <p className="error-message">{message}</p>
      <button type="button" ref={buttonRef} className="btn" onClick={retry}>{retryLabel ?? t("Try again")}</button>
    </div>
  );
}

export function CrashProbe({ region }: { region: CrashRegion }) {
  crashProbe(region);
  return null;
}
