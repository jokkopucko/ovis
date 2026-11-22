// first: every module below may call a built-in older browsers lack (lib/builtins.ts)
import "./lib/builtins.ts";
// then: every module below may read browser storage as it loads
import "./lib/legacyStorage.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

// the faces the tokens name, then styles.css before any component: it holds the primitives
// (.btn, .input, .menu…) that component stylesheets override, and Vite emits CSS in import order
import "./fonts/fonts.css";
import "./styles.css";
import { App } from "./App.tsx";
import { AppCrash, CrashProbe } from "./components/AppCrash.tsx";
import { FileReader } from "./components/FileReader.tsx";
import { RenderBoundary } from "./components/RenderBoundary.tsx";
import { SignInReturn } from "./components/SignInReturn.tsx";
import { CALLBACK_PATH, takeReturn } from "./lib/account/ownWindow.ts";
import { readerFromSearch, reloadWhenReaderChanges } from "./lib/fileReader.ts";
import { pageSearch } from "./lib/pageQuery.ts";
import { bootRelayShell } from "./lib/relay/boot.ts";
import { SettingsProvider } from "./lib/settings.ts";
import { shellMode } from "./lib/shellMode.ts";
import { isReportableWindowError } from "./lib/uncaughtErrors.ts";
import "./lib/viewport.ts";
import { watchSheetExits } from "./lib/sheets.ts";
import { installSafariLinks } from "./lib/externalLink.ts";

watchSheetExits();
// the iOS home-screen app sends a link to another site to Safari, not to a sheet of its own
installSafariLinks();

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");
const mount: HTMLElement = container;

// the provider's return to a sign-in this PC's own window started (lib/account/ownWindow.ts): read once, then out of the address
const signInReturn = shellMode() !== "relay" && window.location.pathname === CALLBACK_PATH ? takeReturn(window.location, window.history) : null;
const reader = readerFromSearch(pageSearch());
reloadWhenReaderChanges(reader);

window.addEventListener("error", (event) => {
  if (isReportableWindowError(event.error, event.message)) console.error("Ovis: uncaught error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => console.error("Ovis: unhandled rejection", event.reason));

// A render error the parts below do not catch would unmount the whole tree and leave the page
// blank, and an installed web app has no reload button: AppCrash offers one. It sits outside
// SettingsProvider, which may be what threw.
function renderApp(): Root {
  const root = createRoot(mount);
  root.render(
    <StrictMode>
      <RenderBoundary resetKey={null} fallback={(_retry, error) => <AppCrash error={error} />}>
        <CrashProbe region="root" />
        <SettingsProvider>
          {signInReturn !== null ? <SignInReturn params={signInReturn} /> : reader !== null ? <FileReader target={reader} /> : <App />}
        </SettingsProvider>
      </RenderBoundary>
    </StrictMode>,
  );
  return root;
}

// the hosted shell (app.ovis.sh) reaches its PC through the relay: it pairs or picks the PC first,
// sets the transport, and only then mounts the app; the build a PC serves has no such meta and
// mounts the app as before
if (shellMode() === "relay") bootRelayShell(mount, renderApp);
else renderApp();
