import type { ComposerModelDraw } from "./compose.ts";

export function composerLabelDraw(draw: ComposerModelDraw, measured: { modelClipped: boolean; modelWidth: number; modelFloor: number }): ComposerModelDraw {
  if (draw !== "no-effort") return draw;
  return measured.modelClipped && measured.modelWidth <= measured.modelFloor ? "out" : draw;
}
