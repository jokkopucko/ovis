import { contextBridge, ipcRenderer } from "electron";
import { linkHold } from "./openLink.ts";

// the update the app has downloaded (main.ts UpdateLine, or null), for the connection screen and the
// server's pages alike: main answers only those
contextBridge.exposeInMainWorld("ovisUpdate", {
  current: (): Promise<unknown> => ipcRenderer.invoke("ovis:update"),
  onChange: (listener: (update: unknown) => void): (() => void) => {
    const heard = (_event: unknown, update: unknown) => listener(update);
    ipcRenderer.on("ovis:update", heard);
    return () => { ipcRenderer.removeListener("ovis:update", heard); };
  },
  /** Restart to Update; settles only when Ovis keeps running after it (a .deb's password prompt cancelled) */
  install: (): Promise<void> => ipcRenderer.invoke("ovis:update-install"),
  close: (version: string): void => ipcRenderer.send("ovis:update-close", version),
});

// only the app's own connection screen gets the bridge, never a page the server serves
const isConnectionScreen = location.protocol === "file:";
if (isConnectionScreen) {
  contextBridge.exposeInMainWorld("ovisDesktop", {
    status: () => ipcRenderer.invoke("ovis:status"),
    onStatus: (listener: (status: unknown) => void) => {
      ipcRenderer.on("ovis:status", (_event, status: unknown) => listener(status));
    },
    retry: () => ipcRenderer.send("ovis:retry"),
    showLogs: () => ipcRenderer.send("ovis:logs"),
  });
} else {
  // the pane an ovis:// link names (main.ts openLink, openLink.ts), as a query of the deep link's
  // names: main tells only its own server's page, as soon as it has loaded, so the one link that
  // came before the page listens is held for it (openLink.ts linkHold)
  const links = linkHold();
  ipcRenderer.on("ovis:open-link", (_event, query: unknown) => links.receive(query));
  contextBridge.exposeInMainWorld("ovisLink", {
    onOpen: (listener: (query: string) => void): void => links.onOpen(listener),
  });
  // Settings → Browser for links (src/lib/externalLink.ts): a page names a browser main found by its id, never a program
  contextBridge.exposeInMainWorld("ovisBrowsers", {
    list: (): Promise<unknown> => ipcRenderer.invoke("ovis:browsers"),
    choose: (id: string | null): Promise<void> => ipcRenderer.invoke("ovis:browser-choose", id),
    open: (url: string): void => ipcRenderer.send("ovis:browser-open", url),
  });
  // the built-in browser's tabs (main.ts, browserTabs.ts): main answers only its own server's page, and
  // null while the setting is off. The page keeps the place a tab is drawn in and steers its own tabs
  contextBridge.exposeInMainWorld("ovisBrowser", {
    current: (): Promise<unknown> => ipcRenderer.invoke("ovis:tabs"),
    onChange: (listener: (browser: unknown) => void): (() => void) => {
      const heard = (_event: unknown, browser: unknown) => listener(browser);
      ipcRenderer.on("ovis:tabs", heard);
      return () => { ipcRenderer.removeListener("ovis:tabs", heard); };
    },
    open: (url: string): Promise<number | null> => ipcRenderer.invoke("ovis:tabs-open", url),
    show: (id: number, bounds: { x: number; y: number; width: number; height: number }): void => ipcRenderer.send("ovis:tabs-show", id, bounds),
    hide: (): void => ipcRenderer.send("ovis:tabs-hide"),
    thumbnail: (id: number): Promise<string | null> => ipcRenderer.invoke("ovis:tabs-thumbnail", id),
    reveal: (id: string): void => ipcRenderer.send("ovis:tabs-reveal", id),
    close: (id: number): void => ipcRenderer.send("ovis:tabs-close", id),
    navigate: (id: number, url: string): Promise<boolean> => ipcRenderer.invoke("ovis:tabs-navigate", id, url),
    go: (id: number, step: "back" | "forward" | "reload" | "stop"): void => ipcRenderer.send("ovis:tabs-go", id, step),
    hold: (id: number, held: boolean): void => ipcRenderer.send("ovis:tabs-hold", id, held),
  });
  // the server's pages sign in to the account through the system browser (src/accountSignIn.ts);
  // main answers only its own server's pages, and only while an account service is named
  const named = ipcRenderer.sendSync("ovis:account-service") as { service?: unknown; providers?: unknown } | null;
  if (typeof named?.service === "string") {
    contextBridge.exposeInMainWorld("ovisAccount", {
      service: named.service,
      providers: Array.isArray(named.providers) ? named.providers.filter((name): name is string => typeof name === "string") : [],
      start: (): Promise<string> => ipcRenderer.invoke("ovis:account-start"),
      open: (url: string): Promise<string> => ipcRenderer.invoke("ovis:account-open", url),
    });
  }
}
