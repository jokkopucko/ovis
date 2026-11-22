import type { Terminal } from "@xterm/xterm";
import type { HerdrSocket } from "../ws.ts";
import type { GhosttyOverlay } from "./overlay.ts";

/** bytes held for libghostty while its module loads: a herdr-core history replay fits many times over */
const HELD_BYTES_MAX = 32 * 1024 * 1024;

export function captureForGhostty(term: Terminal, socket: HerdrSocket, host: HTMLElement): () => void {
  let held: (string | Uint8Array)[] | null = [];
  let heldBytes = 0;
  let overlay: GhosttyOverlay | null = null;
  let stopped = false;
  const write = term.write.bind(term);
  const reset = term.reset.bind(term);
  const unwrap = (): void => {
    if (term.write !== holdingWrite) return;
    term.write = write;
    term.reset = reset;
  };
  const giveUp = (): void => {
    held = null;
    unwrap();
  };
  const holdingWrite = ((data: string | Uint8Array, callback?: () => void) => {
    if (held) {
      held.push(data);
      heldBytes += data.length;
      if (heldBytes > HELD_BYTES_MAX) giveUp();
    }
    write(data, callback);
  }) as Terminal["write"];
  term.write = holdingWrite;
  term.reset = () => {
    if (held) { held.length = 0; heldBytes = 0; }
    reset();
  };

  let decided = false;
  const decide = (): void => {
    if (decided || stopped || !socket.featuresListed()) return;
    decided = true;
    const takeBacklog = (): (string | Uint8Array)[] | null => {
      if (stopped || !held) return null;
      const backlog = held;
      giveUp();
      return backlog;
    };
    void import("./overlay.ts")
      .then(({ attachGhosttyOverlay }) => attachGhosttyOverlay(term, host, takeBacklog))
      .then((attached) => {
        if (!attached) return;
        if (stopped) { attached.dispose(); return; }
        overlay = attached;
      }, (error: unknown) => {
        giveUp();
        console.warn("libghostty could not draw this terminal; xterm draws it", error);
      });
  };
  const off = socket.on((message) => {
    if (message.type === "features" || message.type === "snapshot") decide();
  });
  decide();
  return () => {
    stopped = true;
    off();
    giveUp();
    overlay?.dispose();
  };
}
