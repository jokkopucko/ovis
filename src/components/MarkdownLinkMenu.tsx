/**
 * A long press on a rendered Markdown link in the Android app. Its WebView draws no link menu of
 * its own (Chrome, Safari and the iOS app's WKWebView do, and keep theirs), so the app offers
 * Copy link, Open link and, where the WebView can share, Share link, in the phone's sheet
 * (RowMenu). Only the press the WebView itself reads as a long press, its `contextmenu`, opens
 * it: a tap still opens the link, a swipe over one still scrolls, and a press on other words still
 * selects them.
 */
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Link2, Share2 } from "lucide-react";

import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { copyText } from "../lib/clipboard.ts";
import { useT } from "../lib/i18n.ts";
import { inAndroidApp } from "../lib/nativeApp.ts";
import { useSettings } from "../lib/settings.ts";
import { isWebLink, openWebLink } from "../lib/terminalFileLinks.ts";

/** The rendered Markdown link a long press landed on; null for a mouse's menu or anything else. */
export function pressedLink(event: MouseEvent): HTMLAnchorElement | null {
  // Android ends a dragged text selection with a contextmenu typed "mouse": that is the selection's, not the link's
  if ((event as Partial<PointerEvent>).pointerType === "mouse") return null;
  return event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(".markdown a[href]") : null;
}

/** The address's host, or "" for one no URL parser takes (an older WebView has no URL.canParse). */
function hostOf(href: string): string {
  try {
    return new URL(href).host;
  } catch {
    return "";
  }
}

export function MarkdownLinkMenu() {
  const t = useT();
  const { settings } = useSettings();
  const [pressed, setPressed] = useState<{ link: HTMLAnchorElement; point: { x: number; y: number } } | null>(null);
  const close = useCallback(() => setPressed(null), []);
  useEffect(() => {
    if (!inAndroidApp()) return;
    const onContextMenu = (event: MouseEvent): void => {
      const link = pressedLink(event);
      if (link === null) return;
      // the WebView would select the link's words instead, which copies them and not the address
      event.preventDefault();
      setPressed({ link, point: { x: event.clientX, y: event.clientY } });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
  if (pressed === null) return null;
  const { link, point } = pressed;
  const href = link.href;
  const text = link.textContent?.trim() ?? "";
  // a bare address would only be cut in the title: its host names it there, and it is whole under
  // it. Markdown links any address it reads, one no URL parser takes (port 99999) included
  const title = text !== "" && text !== href ? text : hostOf(href) || href;
  const items: RowMenuItem[] = [
    { id: "copy", label: t("Copy link"), icon: Link2, run: () => { void copyText(href); } },
    // a tap's own way (the pane's web panel, or the phone's browser); a link the chat has since
    // taken off the page cannot be clicked, so its address opens as a new window would
    { id: "open", label: t("Open link"), icon: ExternalLink, run: () => {
      if (link.isConnected) link.click();
      else if (isWebLink(href)) openWebLink(href, settings.reuseExternalLinkTab);
      else window.open(href, "_blank", "noopener,noreferrer");
    } },
    ...(typeof navigator.share === "function" ? [{ id: "share", label: t("Share link"), icon: Share2, run: () => {
      // the share sheet rejects when the user closes it: nothing to tell them
      navigator.share({ url: href }).catch(() => undefined);
    } }] : []),
  ];
  return <RowMenu anchor={link} point={point} restoreFocusTo={null} title={title} detail={title === href ? undefined : href} items={items} onClose={close} />;
}
