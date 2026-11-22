import { useEffect, useState } from "react";
import { paneCovered, paneContentPresented } from "./panePresentation.ts";

export function usePaneCoverage({ contentKey }: { contentKey: string | undefined }) {
  const [dialogCover, setDialogCover] = useState(false);
  const [webDialogCover, setWebDialogCover] = useState(false);
  const [contentReady, setContentReady] = useState(false);
  useEffect(() => {
    const update = () => {
      setDialogCover(paneCovered());
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
