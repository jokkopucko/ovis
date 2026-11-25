import type { Terminal } from "@xterm/xterm";
import type { HerdrSocket } from "../ws.ts";
import { controlScanner, currentQuestions, fallbackOutput, type DeferredQuestions } from "./controls.ts";
import type { GhosttyOverlay } from "./overlay.ts";

/** bytes held for libghostty while its module loads: a herdr-core history replay fits many times over */
const HELD_BYTES_MAX = 32 * 1024 * 1024;
/** "on" or "off": whether libghostty alone parses this browser's terminals (overlay `only`), over the device's default */
export const GHOSTTY_ONLY_KEY = "ovis:ghostty-only";

/**
 * Whether libghostty alone parses a terminal: by default every attached pane, on any device and either server. A
 * mirrored pane (a Windows PC's, repainted from `pane.read`) keeps xterm's parse: its folded view stands the IME's
 * preedit on xterm's rows. It is decided before the first byte; a pane not yet known to be mirrored counts as
 * attached. "on" or "off" under GHOSTTY_ONLY_KEY decides instead.
 */
export function ghosttyOnly(mirrored: boolean): boolean {
  // a browser that refuses storage leaves the default
  let choice: string | null | undefined = null;
  try { choice = globalThis.localStorage?.getItem(GHOSTTY_ONLY_KEY); } catch { /* the default */ }
  if (choice === "on" || choice === "off") return choice === "on";
  return !mirrored;
}

export function captureForGhostty(
  term: Terminal, socket: HerdrSocket, host: HTMLElement, mirrored: () => boolean,
  questionOwner: () => (() => boolean) = () => () => true,
): () => void {
  const only = ghosttyOnly(mirrored());
  let held: (string | Uint8Array)[] | null = [];
  const questions: DeferredQuestions[] = [];
  let scan = controlScanner();
  let decoder = new TextDecoder();
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
  const parseWhole = (chunks: readonly (string | Uint8Array)[], crossing?: { data: string | Uint8Array; callback?: () => void }): void => {
    const frames = chunks.map((data) => ({ data, sent: data.length }));
    if (crossing) frames.push({ data: crossing.data, sent: 0 });
    write("\x18\x1bc" + fallbackOutput(frames, currentQuestions(questions)), crossing?.callback);
    questions.length = 0;
  };
  const holdingWrite: Terminal["write"] = (data, callback) => {
    if (held) {
      heldBytes += data.length;
      if (heldBytes > HELD_BYTES_MAX) {
        const chunks = held;
        held = null;
        unwrap();
        if (only) { parseWhole(chunks, { data, callback }); return; }
      } else {
        held.push(data);
        if (only) {
          const pieces = scan(typeof data === "string" ? data : decoder.decode(data, { stream: true }));
          const pending = pieces.map(({ question }) => question ?? "").join("");
          if (pending) questions.push({ data: pending, isCurrent: questionOwner() });
          write(pieces.map(({ controls }) => controls).join(""), callback);
          return;
        }
      }
    }
    write(data, callback);
  };
  term.write = holdingWrite;
  term.reset = () => {
    if (held) {
      held.length = 0;
      heldBytes = 0;
      questions.length = 0;
      scan = controlScanner();
      decoder = new TextDecoder();
    }
    reset();
  };

  let decided = false;
  const decide = (): void => {
    if (decided || stopped || !socket.featuresListed()) return;
    decided = true;
    let taken: (string | Uint8Array)[] | null = null;
    const takeBacklog = (): (string | Uint8Array)[] | null => {
      if (stopped || !held) return null;
      taken = held;
      held = null;
      unwrap();
      return taken;
    };
    const handBack = (): void => {
      const chunks = taken ?? held;
      held = null;
      unwrap();
      if (only && !stopped && chunks) parseWhole(chunks);
    };
    void import("./overlay.ts")
      .then(({ attachGhosttyOverlay }) => held ? attachGhosttyOverlay(term, host, takeBacklog, only ? { questions } : undefined) : null)
      .then((attached) => {
        if (!attached) { handBack(); return; }
        questions.length = 0;
        if (stopped) { attached.dispose(false); return; }
        overlay = attached;
      }, (error: unknown) => {
        handBack();
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
    held = null;
    unwrap();
    overlay?.dispose(false);
  };
}
