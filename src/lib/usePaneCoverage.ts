import { useEffect, useState } from "react";
import { paneCovered, paneContentPresented } from "./panePresentation.ts";

/** Tracks dialog coverage and whether the pane content is presented. */
export function usePaneCoverage({ contentKey }: { contentKey: string | undefined }) {
  // App-owned coverage, plus dialogs/menus mounted by descendants (rename, worktree, lightbox,
  // confirmations). A desktop popup counts as covered too; docked file/web panels do not.
  const [dialogCover, setDialogCover] = useState(false);
  const [webDialogCover, setWebDialogCover] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    const update = () => {
      setDialogCover(paneCovered());
      // The web popup must not count itself, but other visible dialogs own the focus above it.
      setWebDialogCover(paneCovered(".web-panel-popup", '[role="dialog"],[role="alertdialog"],dialog[open]'));
      setContentReady(paneContentPresented(contentKey));
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "role", "aria-modal", "data-pane-content", "hidden", "inert", "aria-hidden", "class"] });
    update();
    return () => observer.disconnect();
  }, [contentKey]);
  return { dialogCover, webDialogCover, contentReady };
}
