import type { Terminal } from "@xterm/xterm";

interface UserInputSource {
  onUserInput?: (listener: () => void) => { dispose(): void };
}

/**
 * Tells xterm's own replies from input someone made, at their source: xterm fires its core's
 * `onUserInput` right before `onData` for a key, a paste, IME text or a mouse report, and not for
 * an answer to the program's query (DA, a cursor or mode report, a colour). The public API has no
 * such signal, so this reads xterm's core. A build without it counts everything as typed, which is
 * what Ovis did before it could tell.
 */
export function userInputTracker(term: Terminal): { wasUserInput: () => boolean; dispose: () => void } {
  const service = (term as unknown as { _core?: { coreService?: UserInputSource } })._core?.coreService;
  if (typeof service?.onUserInput !== "function") return { wasUserInput: () => true, dispose: () => {} };
  let user = false;
  const subscription = service.onUserInput(() => { user = true; });
  return {
    // asked once per onData: the answer is for that data only
    wasUserInput: () => {
      const was = user;
      user = false;
      return was;
    },
    dispose: () => subscription.dispose(),
  };
}
