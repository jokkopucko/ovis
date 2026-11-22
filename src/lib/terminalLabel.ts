import type { Translate } from "./i18n.ts";

/**
 * What the terminal's region announces as its name (#633). A pane id is not one: it is
 * something no screen-reader user can act on, and reading it aloud is noise. A pane with
 * nothing to call it therefore falls back to the grid's own kind, the same name the idle
 * grid (no pane at all) carries.
 */
export function terminalLabel(paneId: string | null, title: string | null, t: Translate): string {
  const name = title?.trim() ?? "";
  return paneId !== null && name !== "" && name !== paneId ? t("Terminal for {title}", { title: name }) : t("Terminal");
}
