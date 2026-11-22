interface FrameScheduler {
  requestAnimationFrame: (callback: () => void) => unknown;
  setTimeout: (callback: () => void) => unknown;
}

const browserScheduler: FrameScheduler = {
  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
  setTimeout: (callback) => window.setTimeout(callback, 0),
};

/**
 * xterm 5.5's reset/viewport sync could queue a frame and a task that read the renderer's dimensions,
 * and disposal removes the renderer, so either callback could throw if it ran afterward; the deferral
 * is kept with xterm 6, where it costs one frame. A frame queued here runs after xterm's pending frame;
 * the task scheduled from it runs after xterm's task. Hidden tabs can delay frames while still running
 * tasks, so there is deliberately no timer fallback.
 */
export function disposeAfterPendingFrame(term: { dispose: () => void }, scheduler: FrameScheduler = browserScheduler): void {
  scheduler.requestAnimationFrame(() => {
    scheduler.setTimeout(() => term.dispose());
  });
}
