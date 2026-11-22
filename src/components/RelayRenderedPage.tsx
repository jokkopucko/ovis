import { useEffect, useRef, useState, type RefObject } from "react";
import { getTransport } from "../lib/transport.ts";
import { relayResourceBlob, RelayResourceTooLargeError } from "../lib/relay/resources.ts";
import { useT } from "../lib/i18n.ts";

/**
 * The render host has pagePolicy(null), not the shell policy that a srcdoc would inherit.
 * `scripts`: whether the person asked for the page's scripts. Without them the render host draws the page in a
 * frame of its own that runs none (scripts/shell-build.ts); this frame keeps `allow-scripts` for the host's own
 * few lines, which are what takes the page from the message.
 * `frame`: the frame's element, for the viewer's focus guard.
 */
export function RelayRenderedPage({ path, title, scripts, frame }: { path: string; title: string; scripts: boolean; frame?: RefObject<HTMLIFrameElement | null> }) {
  const t = useT();
  const [loaded, setLoaded] = useState<{ path: string; html: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const sent = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    setLoaded(null);
    setError(null);
    sent.current = false;
    void getTransport().fetch(path, { signal: abort.signal })
      .then(relayResourceBlob).then((blob) => blob.text()).then((html) => {
        if (!abort.signal.aborted) setLoaded({ path, html });
      }).catch((error: unknown) => { if (!abort.signal.aborted) setError(error); });
    return () => abort.abort();
  }, [path]);
  if (error) return <p className="file-viewer-note" role="alert">{error instanceof RelayResourceTooLargeError
    ? t("Too large to open on the phone - download on the PC")
    : t("The file could not be opened.")}</p>;
  if (loaded?.path !== path) return null;
  return <iframe key={path} ref={frame} className="file-viewer-page" src={`${window.location.pathname}~render`} sandbox="allow-scripts" title={title}
    data-page-scripts={scripts ? "on" : "off"}
    onLoad={(event) => {
      if (sent.current) return;
      sent.current = true;
      event.currentTarget.contentWindow?.postMessage({ type: "ovis-render", html: loaded.html, scripts }, "*");
    }} />;
}
