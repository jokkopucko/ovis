import type { ILink, ILinkProvider } from "../terminalSelection/types.ts";
import type { ScreenRows } from "../terminalScreen.ts";

/**
 * The OSC 8 hyperlinks (`ESC ] 8 ; ; uri`) of a row of libghostty's, as xterm's own link provider finds them in its
 * buffer: each run of cells with one target is a link. A target `opens` refuses is no link, as xterm's own
 * provider leaves it (#739): the cells stay the program's to click, and a file link under them stays found.
 */
export function hyperlinkProvider(rows: () => ScreenRows, opens: (uri: string) => boolean, activate: (event: MouseEvent, uri: string) => void): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = rows().getLine(y - 1);
      if (!line?.hyperlink) { callback(undefined); return; }
      const links: ILink[] = [];
      let uri: string | null = null;
      let start = 0;
      for (let x = 0; x <= line.length; x++) {
        const target = x < line.length ? line.hyperlink(x) : null;
        const here = target !== null && opens(target) ? target : null;
        if (here === uri) continue;
        if (uri !== null) {
          const target = uri;
          links.push({ range: { start: { x: start + 1, y }, end: { x, y } }, text: target, activate: (event) => activate(event, target) });
        }
        uri = here;
        start = x;
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
