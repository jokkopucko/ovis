export function requestShownFrame(callback: FrameRequestCallback): () => void {
  let frame = 0;
  const run: FrameRequestCallback = (at) => {
    frame = 0;
    if (document.hidden) return;
    document.removeEventListener("visibilitychange", changed);
    callback(at);
  };
  const changed = (): void => {
    if (document.hidden) {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    } else if (frame === 0) {
      frame = requestAnimationFrame(run);
    }
  };
  document.addEventListener("visibilitychange", changed);
  changed();
  return () => {
    document.removeEventListener("visibilitychange", changed);
    if (frame !== 0) cancelAnimationFrame(frame);
  };
}
