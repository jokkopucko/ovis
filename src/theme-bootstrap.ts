/**
 * The page's first script: a classic, blocking one in <head> (scripts/theme-bootstrap-build.ts puts
 * it there), so it runs before the stylesheet or the app can paint. It draws the saved theme's row
 * on the document the way the app will (lib/themeBoot.ts), so a cold launch shows that row from its
 * first frame instead of the stylesheet's default until React applies the settings.
 * Same-origin and external, never inline: the app's policy allows `script-src 'self'` only.
 */
// first: this script runs before main.tsx, so it moves the settings saved under the old key itself
import "./lib/legacyStorage.ts";
import { applyThemeEntry, savedThemeEntry } from "./lib/themeBoot.ts";
import { regionalAppReady, regionalAppUrl } from "../shared/relay-regions.ts";

// a pairing link for a regional relay opens on the app's copy beside it once that copy answers with
// this build, while this host is still sending the bundle; not once the app took the offer off the
// address (src/lib/relay/boot.ts), which means it started pairing here
const regional = regionalAppUrl(window.location, "Capacitor" in window);
if (regional !== null) {
  const offer = window.location.hash;
  void regionalAppReady(new URL(regional).origin).then((ready) => {
    if (ready && window.location.hash === offer) window.location.replace(regional);
  });
}

const root = document.documentElement;
const entry = savedThemeEntry(() => window.localStorage);
applyThemeEntry(root, entry);
root.style.backgroundColor = entry.bg;
