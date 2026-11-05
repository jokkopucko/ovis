import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useMachineApi, useMachineId } from "../lib/machineContext.tsx";
import { markdownImagePreview } from "../lib/markdownImages.ts";
import type { GalleryImage } from "../lib/imageViewer.ts";
import { MarkdownImageContext, MarkdownImageOpenContext, MarkdownImageRetryContext, type ImageSize, type MarkdownImageResolver } from "./Markdown.tsx";

/** The size each image decoded at, per PC, pane and source: a reopened chat holds that box while it stats and loads the image again. */
const sizes = new Map<string, ImageSize>();
const REMEMBERED_SIZES = 500;

/** Resolve on the pane's PC; the viewer stays with ChatView when an image's row scrolls away. */
export function ChatMarkdownImages({ paneId, cwd, connected, onOpen, children }: {
  paneId: string; cwd: string | null; connected: boolean; onOpen: (image: GalleryImage) => void; children: ReactNode;
}) {
  const machineId = useMachineId();
  const { fetchFileInfo, fileUrl } = useMachineApi();
  const previous = useRef({ connected, cwd, paneId, fetchFileInfo });
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const before = previous.current;
    previous.current = { connected, cwd, paneId, fetchFileInfo };
    const sameOwner = before.paneId === paneId && before.fetchFileInfo === fetchFileInfo;
    if (sameOwner && ((connected && !before.connected) || cwd !== before.cwd)) setRefresh((epoch) => epoch + 1);
  }, [connected, cwd, paneId, fetchFileInfo]);
  const resolve = useMemo(() => {
    const key = (src: string) => `${machineId}\0${paneId}\0${src}`;
    // The server prefers foreground_cwd over pane.cwd and returns the canonical byte path.
    const resolver: MarkdownImageResolver = (src) => markdownImagePreview(src, null,
      (path) => fetchFileInfo(path, paneId), (path, download) => fileUrl(path, paneId, download));
    resolver.size = (src) => sizes.get(key(src));
    resolver.remember = (src, size) => {
      sizes.delete(key(src));
      sizes.set(key(src), size);
      if (sizes.size > REMEMBERED_SIZES) sizes.delete(sizes.keys().next().value!);
    };
    return resolver;
  }, [machineId, paneId, fetchFileInfo, fileUrl]);
  return <MarkdownImageContext.Provider value={resolve}>
    <MarkdownImageRetryContext.Provider value={refresh}>
      <MarkdownImageOpenContext.Provider value={onOpen}>{children}</MarkdownImageOpenContext.Provider>
    </MarkdownImageRetryContext.Provider>
  </MarkdownImageContext.Provider>;
}
