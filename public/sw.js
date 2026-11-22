// Service worker for Ovis. Policy: navigations are network-first (so a
// fresh build always wins when online) falling back to the cached shell when
// offline; static assets (hashed bundles, icons, favicons) are cache-first since
// they are content-addressed or rarely change. The web manifest is not: its URL
// never changes and the browser rereads it to update the installed app, so a
// cached copy would pin every install to its first manifest.
// Nothing is precached. The typefaces are /assets/ files too (src/fonts/fonts.css): Pretendard
// comes as 92 chunks split by unicode-range and the browser asks only for those whose characters
// a page draws, so each is cached as it is first fetched and a phone that has shown Korean once
// draws it offline. Never list them for install: that would download all 3 MB on every device.
// A new cache starts empty for the same reason, so the cache of the name before it is kept
// until this one holds a shell and the files it starts with: the page that brought this worker
// was loaded through the old one, and its shell, bundles and font chunks are all there. Deleted
// at activation, the first reload without a network would find no shell at all.
const CACHE_NAME = "ovis-v4-sheep";
const BUILD = "";
const BUILD_FILES = null;
const CACHE = BUILD ? `${CACHE_NAME}-${BUILD}` : CACHE_NAME;
const FILES = "ovis-files-v1";
const buildFiles = BUILD_FILES ? new Set(BUILD_FILES) : null;

function ofThisBuild(pathname) {
  return !buildFiles || buildFiles.has(pathname);
}

const CACHE_FIRST_PATHS = new Set([
  "/favicon.png",
  "/favicon.ico",
  "/apple-touch-icon.png",
]);

function isCacheFirst(pathname) {
  if (pathname.startsWith("/assets/") || pathname.startsWith("/icons/")) return true;
  return CACHE_FIRST_PATHS.has(pathname);
}

function isLongLived(pathname) {
  if (pathname.startsWith("/icons/") || CACHE_FIRST_PATHS.has(pathname)) return true;
  return pathname.startsWith("/assets/") && /\.(woff2?|ttf)$/.test(pathname);
}

function isPage(response) {
  return (response.headers.get("content-type") || "").startsWith("text/html");
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function shellFiles(html) {
  const files = new Set();
  for (const [, path] of html.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/g)) files.add(path);
  return [...files];
}

async function fileFor(path) {
  const older = await caches.match(path);
  if (older && !isPage(older)) return older;
  try {
    const response = await fetch(path);
    return response.ok && response.type === "basic" && !isPage(response) ? response : null;
  } catch (err) {
    return null;
  }
}

/**
 * The shell just fetched becomes this cache's "/" once the cache holds every file that shell
 * starts with: the worker before may have answered them, and a network that drops before the
 * page asks again must not leave a shell without them.
 */
async function keepShell(response, spare) {
  const html = await response.clone().text();
  const cache = await caches.open(CACHE);
  for (const path of shellFiles(html)) {
    if (await cache.match(path)) continue;
    const file = await fileFor(path);
    if (!file) return;
    await cache.put(path, file);
  }
  await cache.put("/", response);
  const files = await caches.open(FILES);
  const names = (await caches.keys()).filter((name) => name !== CACHE && name !== FILES && name !== spare);
  for (const name of names) {
    const old = await caches.open(name);
    const oldShell = await old.match("/");
    const starts = new Set(oldShell ? shellFiles(await oldShell.text()) : []);
    for (const request of await old.keys()) {
      const path = new URL(request.url).pathname;
      const into = isLongLived(path) ? files
        : starts.has(path) || (buildFiles && buildFiles.has(path)) ? cache : null;
      if (!into || (await into.match(request))) continue;
      const file = await old.match(request);
      if (file && !isPage(file)) await into.put(request, file);
    }
  }
  await Promise.all(names.map((name) => caches.delete(name)));
}

async function cachedShell() {
  return (await keptShell())?.response;
}

const FRESH_SHELL = "/__ovis-fresh-shell";
const KEPT_SHELL_MS = 24 * 60 * 60 * 1000;

async function takeFreshRequest() {
  return (await caches.open(FILES)).delete(`${FRESH_SHELL}/${shellServerId()}`);
}

function keptRecently(response) {
  const at = Date.parse(response.headers.get("date") || "");
  return Number.isFinite(at) && Date.now() - at < KEPT_SHELL_MS;
}

async function keptShell() {
  for (const name of [CACHE, ...(await caches.keys()).filter((name) => name !== CACHE && name !== FILES)]) {
    const response = await (await caches.open(name)).match("/");
    if (response) return { response, cache: name };
  }
  return null;
}

// Only the shell build stamps this contract. Server-served workers keep their fetch behavior.
const RELAY_RESOURCES = null;

if (RELAY_RESOURCES) self.addEventListener("message", (event) => {
  if (event.data?.type === "ovis-relay-resources-v1") event.ports[0]?.postMessage({ type: "ovis-relay-resources-v1" });
});

/** A page of this PC's app: its scope on this origin, not its render host or a file under `~`. */
function ofThisPcApp(url, scope) {
  try {
    const address = new URL(url);
    return address.origin === self.location.origin && address.pathname.startsWith(scope) && !address.pathname.startsWith(`${scope}~`);
  } catch { return false; }
}

/**
 * Whether this PC's own app asked: what a PC's own server gets from its SameSite=Strict cookie,
 * which another site's link or frame never carries. The Sec-Fetch-* headers are added after the
 * worker, so it cannot read them: a navigation (a tab, a frame, a download) counts by the page it
 * came from, and any other request by the page that made it. No referrer (a typed address, or a
 * page that withheld it) is refused too.
 */
async function askedByThisPc(event, scope) {
  if (event.request.mode === "navigate") return ofThisPcApp(event.request.referrer, scope);
  const client = event.clientId ? await self.clients.get(event.clientId) : undefined;
  return client !== undefined && ofThisPcApp(client.url, scope);
}

/** No caching, including errors. Only controlled windows in this PC's registration are eligible. */
async function relayResourceResponse(event, target) {
  const { request } = event;
  const scope = new URL(self.registration.scope).pathname;
  if (!(await askedByThisPc(event, scope))) {
    return new Response("Open this file from Ovis.", { status: 403, headers: { "cache-control": "no-store" } });
  }
  const windows = await self.clients.matchAll({ type: "window" });
  for (const client of windows) {
    const address = new URL(client.url);
    if (address.origin !== self.location.origin || !address.pathname.startsWith(scope)
      || address.pathname.startsWith(`${scope}~`)) continue;
    request.signal.throwIfAborted();
    const answer = await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const port = channel.port1;
      let reader;
      const finish = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", aborted);
        port.close();
      };
      const aborted = () => {
        port.postMessage({ type: "abort" });
        if (reader) void reader.cancel(request.signal.reason);
        finish();
        reject(request.signal.reason);
      };
      const timer = setTimeout(() => {
        port.postMessage({ type: "abort" });
        finish();
        resolve(null);
      }, 5000);
      request.signal.addEventListener("abort", aborted, { once: true });
      port.onmessage = (event) => {
        clearTimeout(timer);
        const data = event.data;
        if (!data?.available) { finish(); resolve(null); return; }
        if (data.status === undefined) return;
        const headers = new Headers(data.headers.filter(([name]) => RELAY_RESOURCES.headers.includes(name.toLowerCase())));
        // A paired PC is not trusted with the shell origin shared by every other PC.
        // PDF uses Chrome's isolated viewer, which refuses sandboxed documents. nosniff
        // keeps HTML disguised as PDF out of the HTML parser; script-src also forbids
        // shell-origin script. Rendered HTML runs separately at ~render, not this route.
        const pdf = headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/pdf";
        // Only the shell may frame a PC's file, as only the app frames a file of the PC's own server.
        headers.append("content-security-policy", `${pdf ? "" : "sandbox; "}default-src 'none'; script-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'`);
        headers.set("x-frame-options", "SAMEORIGIN");
        headers.set("x-content-type-options", "nosniff");
        reader = data.body?.getReader();
        const body = reader ? new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) { controller.close(); finish(); }
              else controller.enqueue(next.value);
            } catch (error) { controller.error(error); finish(); }
          },
          async cancel(reason) {
            port.postMessage({ type: "abort" });
            await reader.cancel(reason);
            finish();
          },
        }, { highWaterMark: 0 }) : null;
        resolve(new Response(body, { status: data.status, headers }));
        if (!body) finish();
      };
      client.postMessage({
        type: "ovis-relay-resource", id: crypto.randomUUID(), serverId: scope.split("/")[2],
        target, headers: [...request.headers].filter(([name]) => RELAY_RESOURCES.requestHeaders.includes(name)),
      }, [channel.port2]);
    });
    if (answer) return answer;
  }
  return new Response("Open this PC in Ovis to load its files.", { status: 503, headers: { "cache-control": "no-store" } });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/ws") return;

  if (RELAY_RESOURCES) {
    const scope = new URL(self.registration.scope).pathname;
    if (url.pathname === `${scope}~render`) return;
    if (url.pathname.startsWith(`${scope}~`)) {
      const target = url.pathname.slice(scope.length + 1) + url.search;
      if (/^\/s\/[0-9a-f]{32}\/$/.test(scope) && new RegExp(RELAY_RESOURCES.target).test(target)) {
        event.respondWith(relayResourceResponse(event, target));
      }
      return;
    }
  }

  // a sign-in's return carries its code in the address: never answered or kept by this worker
  if (request.mode === "navigate" && url.pathname === "/callback") return;
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        let kept = null;
        try {
          const fresh = RELAY_RESOURCES ? await takeFreshRequest() : false;
          kept = RELAY_RESOURCES && !fresh ? await keptShell() : null;
        } catch (err) { }
        if (kept && keptRecently(kept.response)) {
          event.waitUntil(fetch(request)
            .then((response) => (response.ok ? keepShell(response, kept.cache) : undefined))
            .catch(() => undefined));
          return kept.response;
        }
        let response;
        try {
          response = await fetch(request);
        } catch (err) {
          return (await cachedShell()) || Response.error();
        }
        if (response.ok) {
          // not awaited: the page gets its shell as it comes, and the worker lives until the
          // copy is kept (a put reads the whole body).
          event.waitUntil(keepShell(response.clone()).catch(() => undefined));
        }
        return response;
      })(),
    );
    return;
  }

  if (isCacheFirst(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(isLongLived(url.pathname) ? FILES : CACHE);
        const own = await cache.match(request);
        if (own) return own;
        const older = await caches.match(request);
        if (older && !isPage(older)) {
          // a file only the cache of the name before still holds, asked for while the new shell's
          // copy is being kept: it is kept here too, so keepShell's retirement of that cache does
          // not take the only copy of a file the new shell uses.
          if (ofThisBuild(url.pathname)) event.waitUntil(cache.put(request, older.clone()).catch(() => undefined));
          return older;
        }
        const response = await fetch(request);
        if (response.ok && response.type === "basic" && !isPage(response)) {
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
  }
});

// In the hosted shell every PC has a worker of its own, scoped to `/s/<server_id>/`
// (src/lib/shellMode.ts), with its own subscription: only that PC pushes to it, and
// only that PC's windows are this worker's to tell or to open.

function shellServerId() {
  const scope = self.registration && self.registration.scope;
  const match = scope ? /^\/s\/([0-9a-f]{32})\/$/.exec(new URL(scope).pathname) : null;
  return match ? match[1] : null;
}

/** A window of this worker's PC: in the hosted shell the origin's other windows are other PCs'. */
function ofThisPc(url) {
  if (shellServerId() === null) return true;
  try { return new URL(url).pathname.startsWith(`/s/${shellServerId()}/`); } catch { return false; }
}

// The tag replaces the pane's last alert everywhere but iOS, whose webpushd files each one
// under an id of its own (WebKit bugs 258922, 319860): the pane's earlier alerts are closed by
// hand. Their alert_ids are noted before showing, so an alert shown meanwhile (another push for
// the pane) is never closed, and the handles are listed again after showing: where the tag did
// replace, an old handle names the new alert. iOS refuses close() for 30 s after showing, so a
// quicker repeat waits for the next alert. A failed listing closes nothing.
async function earlierAlerts(tag) {
  try {
    return new Set((await self.registration.getNotifications({ tag })).map((alert) => alert.data?.alert_id));
  } catch {
    return new Set();
  }
}

async function closeEarlierAlerts(tag, earlier) {
  if (earlier.size === 0) return;
  try {
    for (const alert of await self.registration.getNotifications({ tag })) {
      if (earlier.has(alert.data?.alert_id)) alert.close();
    }
  } catch {
  }
}

// Answer buttons (#2916): an alert for a question the server found answerable whole (server/push.ts
// promptActions) carries its options as buttons. A tap answers through POST /api/pane/prompt/answer
// with the prompt's id, so the server's own check decides: a prompt that changed or was answered on
// another device takes nothing, and a new alert says so; its tap opens the pane. Only the worker a
// PC's own server serves shows them: the hosted shell's worker cannot reach its PC (only a window
// holds the relay channel). Where a platform shows no buttons (iOS), the alert is as it was.
function answerButtons(payload) {
  if (shellServerId() !== null || typeof payload.prompt_id !== "string" || !payload.pane_id || (payload.machine_id || "local") !== "local") return null;
  if (!Array.isArray(payload.actions)) return null;
  const answers = payload.actions.slice(0, 2).filter((action) => Number.isInteger(action?.option_index) && typeof action.label === "string" && action.label !== "");
  return answers.length > 0 ? answers : null;
}

async function answerFromAlert(data, index) {
  const answer = data.actions[index];
  if (!answer) return;
  let body;
  try {
    const response = await self.fetch("/api/pane/prompt/answer", {
      method: "POST",
      headers: { "content-type": "application/json", "x-herdr-machine": "1" },
      body: JSON.stringify({ pane_id: data.pane_id, prompt_id: data.prompt_id, option_index: answer.option_index }),
    });
    if (response.ok) return;
    body = response.status === 409 ? "This question changed or was already answered. Tap to open it." : "The answer may not have gone through. Tap to open the question.";
  } catch {
    body = "The answer may not have gone through. Tap to open the question.";
  }
  try {
    if ((await self.registration.getNotifications({ tag: data.tag })).length > 0) return;
  } catch {
  }
  const latest = latestAlerts.get(data.tag);
  if (latest !== undefined && latest !== data.alert_id) return;
  await self.registration.showNotification(data.title, {
    body,
    tag: data.tag,
    data: { pane_id: data.pane_id, machine_id: data.machine_id, workspace_id: data.workspace_id, alert_id: crypto.randomUUID() },
    icon: "/icons/icon-192.png?v=sheep1",
    badge: "/icons/badge-96.png?v=sheep1",
  });
}

const latestAlerts = new Map();

// Every push shows a notification: Safari revokes a subscription whose pushes stay silent.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (err) {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const tag = payload.tag || "herdr";
  const alertId = crypto.randomUUID();
  latestAlerts.set(tag, alertId);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watching = windows.some((client) => client.visibilityState === "visible" && ofThisPc(client.url));
      const earlier = await earlierAlerts(tag);
      const answers = answerButtons(payload);
      await self.registration.showNotification(payload.title || "Ovis", {
        body: payload.body || "",
        tag,
        renotify: !watching,
        silent: watching,
        ...(answers ? { actions: answers.map((answer, index) => ({ action: `answer-${index}`, title: answer.label })) } : {}),
        data: {
          pane_id: payload.pane_id || null, machine_id: payload.machine_id || "local", workspace_id: payload.workspace_id || null, alert_id: alertId,
          ...(answers ? { prompt_id: payload.prompt_id, actions: answers, title: payload.title || "Ovis", tag } : {}),
        },
        icon: "/icons/icon-192.png?v=sheep1",
        // Android's status bar and small icon: white on transparent, or Chrome's bell
        badge: "/icons/badge-96.png?v=sheep1",
      });
      await closeEarlierAlerts(tag, earlier);
    })(),
  );
});

function isAppWindow(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const path = parsed.pathname;
  if (path.startsWith("/api/") || path === "/ws") return false;
  const last = path.slice(path.lastIndexOf("/") + 1);
  if (last.includes(".") && last !== "index.html") return false;
  const query = shellServerId() !== null && parsed.search.length <= 1 && parsed.hash.length > 1 ? new URLSearchParams(parsed.hash.slice(1)) : parsed.searchParams;
  return (query.get("read") ?? "").trim() === "";
}

let latestNotificationClick = 0;
let latestNotificationSelection = null;
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const button = /^answer-(\d)$/.exec(event.action || "");
  if (button && event.notification.data?.prompt_id) {
    event.waitUntil(answerFromAlert(event.notification.data, Number(button[1])));
    return;
  }
  const click = ++latestNotificationClick;
  const paneId = event.notification.data ? event.notification.data.pane_id : null;
  const machineId = event.notification.data?.machine_id || "local";
  const workspaceId = event.notification.data?.workspace_id || null;
  const selection = paneId ? { type: "select-pane", pane_id: paneId, machine_id: machineId, view: "chat", ...(workspaceId ? { workspace_id: workspaceId } : {}) } : null;
  latestNotificationSelection = selection;
  // a tapped pane alert, for the daily anonymous usage counts (server/telemetry.ts): posted only when
  // the server says the counts are on and their notice was shown, so nothing tells it of a tap while
  // they are off; a refusal (signed out, an older server) changes nothing
  if (paneId && typeof self.fetch === "function") {
    event.waitUntil((async () => {
      const status = await self.fetch("/api/telemetry", { cache: "no-store" });
      if (!status.ok) return;
      const counts = await status.json();
      if (counts?.enabled !== true || counts.blocked_by_env !== false || counts.notice_seen !== true) return;
      await self.fetch("/api/telemetry", {
        method: "POST",
        headers: { "content-type": "application/json", "x-herdr-update": "1" },
        body: JSON.stringify({ alert_opened: true }),
      });
    })().catch(() => {}));
  }
  event.waitUntil(
    (async () => {
      // only an app window handles the selection: focusing a reader tab would swallow the tap
      const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
        .filter((client) => isAppWindow(client.url) && ofThisPc(client.url));
      if (click !== latestNotificationClick) return;
      // the app's own path: the PC's scope in the hosted shell, whose host never hears which pane:
      // there the pane rides in the fragment (src/lib/pageQuery.ts)
      const home = shellServerId() === null ? "/" : `/s/${shellServerId()}/`;
      const url = paneId ? `${home}${shellServerId() === null ? "?" : "#"}machine=${encodeURIComponent(machineId)}${workspaceId ? `&ws=${encodeURIComponent(workspaceId)}` : ""}&pane=${encodeURIComponent(paneId)}&view=chat` : home;
      const selectLatest = (client) => { if (client && latestNotificationSelection) client.postMessage(latestNotificationSelection); };
      const open = async () => {
        selectLatest(await self.clients.openWindow(url));
      };
      const target = windows.find((client) => client.focused) || windows[0];
      if (target) {
        const select = () => { if (selection) target.postMessage(selection); };
        // Name the pane before focus(): a focus() that iOS refuses or resolves late must not
        // swallow it. A page frozen in the background may need the selection again
        // once its focus completes.
        select();
        try {
          await target.focus();
        } catch (err) {
          if (click === latestNotificationClick) await open();
          return;
        }
        selectLatest(target);
        return;
      }
      await open();
    })(),
  );
});

function openRelayDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ovis-relay", 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("devices")) db.createObjectStore("devices", { keyPath: "server_id" });
      if (!db.objectStoreNames.contains("pending-push")) db.createObjectStore("pending-push", { keyPath: "server_id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function keepPendingPush(serverId, subscription, oldEndpoint) {
  const db = await openRelayDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction("pending-push", "readwrite");
      const store = tx.objectStore("pending-push");
      const request = store.get(serverId);
      request.onsuccess = () => {
        const held = request.result;
        const old = held && held.subscription.endpoint === oldEndpoint ? held.old_endpoint : oldEndpoint;
        store.put({ server_id: serverId, subscription, old_endpoint: old });
      };
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// The browser rotated the subscription (Firefox does; Chrome rarely): hand the server
// the new endpoint and drop the old one, or pushes stop until the app is next opened.
self.addEventListener("pushsubscriptionchange", (event) => {
  const serverId = shellServerId();
  if (serverId !== null) {
    event.waitUntil(
      (async () => {
        const previous = event.oldSubscription;
        let fresh = event.newSubscription;
        if (!fresh && previous && previous.options.applicationServerKey) {
          fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: previous.options.applicationServerKey });
        }
        if (!fresh) return;
        await keepPendingPush(serverId, fresh.toJSON(), previous ? previous.endpoint : null);
        const windows = (await self.clients.matchAll({ type: "window", includeUncontrolled: true }))
          .filter((client) => isAppWindow(client.url) && ofThisPc(client.url));
        for (const client of windows) client.postMessage({ type: "push-subscription-change" });
      })(),
    );
    return;
  }
  const post = (method, body) =>
    fetch("/api/push/subscribe", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  event.waitUntil(
    (async () => {
      const previous = event.oldSubscription;
      let fresh = event.newSubscription;
      if (!fresh) {
        const key = previous && previous.options.applicationServerKey
          ? previous.options.applicationServerKey
          : (await (await fetch("/api/push")).json()).public_key;
        fresh = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await post("POST", { subscription: fresh.toJSON() });
      if (previous) await post("DELETE", { endpoint: previous.endpoint });
    })(),
  );
});
